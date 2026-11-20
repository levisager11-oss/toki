-- Toki 2.0: levels, Toki Tokens, cosmetics, the shop and trades.
--
-- * XP and levels: players earn XP across all games, from playtime (1 XP a minute, at most 120 a
--   day), unlocking achievements (25), beating their own best score (10, at most 50 a day) and
--   playing Today's game (30). At most 600 XP a day in all, so a game that hands out achievements
--   or scores too easily can't be farmed. Level n needs 25·(n−1)·(n+2) XP in all (level 2: 100,
--   level 10: 2700); src/lib/progress.ts draws the bar with the same formula.
-- * Toki Tokens: 20 for every new level, 5 for each achievement (at most 50 a day), and for Today's
--   game 5 plus 1 for every day of the streak after the first (at most 15). Tokens are only
--   earned; nothing here takes money. Each player's balance is one row that is overwritten, with
--   the last 50 changes kept for the shop's "where they came from".
-- * Cosmetics: Toki's own (avatar frames, name colors, titles, profile themes, chat stickers) are
--   bought with tokens in the shop. Developers can make a few for their game (a frame, a name
--   color, a title or a theme), which players get with one of the game's achievements. How each
--   looks is a small "style" (a pattern and colors) that the app draws: no pictures are stored.
-- * Trades: friends swap tokens and Toki's cosmetics; both have to agree. Trading opens on
--   5 December 2026, when the terms that cover it apply (src/lib/terms.ts).
--
-- Free plan: one progress row per player, one row per cosmetic a player owns, the token history
-- capped at 50 rows per player, trades deleted 30 days after they end.

-- ---------- levels ----------

-- The XP a player needs in all for a level.
create function public.xp_for_level(p_level integer) returns bigint
language sql immutable set search_path = '' as $$
  select 25::bigint * (greatest(p_level, 1) - 1) * (greatest(p_level, 1) + 2)
$$;

-- The level for an amount of XP.
create function public.level_for_xp(p_xp bigint) returns integer
language plpgsql immutable set search_path = '' as $$
declare
  v integer := greatest(1, floor((sqrt(9 + 4 * greatest(p_xp, 0) / 25.0) - 1) / 2)::integer);
begin
  -- Rounding can be one off either way.
  while public.xp_for_level(v + 1) <= p_xp loop v := v + 1; end loop;
  while v > 1 and public.xp_for_level(v) > p_xp loop v := v - 1; end loop;
  return v;
end $$;

create table public.player_progress (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  xp bigint not null default 0 check (xp >= 0),
  level integer not null default 1 check (level >= 1),
  tokens integer not null default 0 check (tokens >= 0),
  -- What today (UTC) brought, for the daily caps. Reset by the first award of a new day.
  day date not null default (now() at time zone 'utc')::date,
  xp_today integer not null default 0,
  play_seconds_today integer not null default 0,
  play_xp_today integer not null default 0,
  score_xp_today integer not null default 0,
  achievement_tokens_today integer not null default 0,
  updated_at timestamptz not null default now()
);
create index player_progress_xp_idx on public.player_progress(xp desc);

create table public.token_log (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.profiles(id) on delete cascade,
  amount integer not null,
  reason text not null check (reason in ('level', 'achievement', 'daily', 'buy', 'trade', 'admin', 'start')),
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index token_log_user_idx on public.token_log(user_id, id desc);

alter table public.player_progress enable row level security;
alter table public.token_log enable row level security;
-- Only through the functions below: a player sees their own balance, everyone sees levels.
revoke all on public.player_progress, public.token_log from anon, authenticated;

-- Notes a change of a player's tokens, keeping their last 50.
create function public.log_tokens(p_user uuid, p_amount integer, p_reason text, p_data jsonb default '{}'::jsonb) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if coalesce(p_amount, 0) = 0 then
    return;
  end if;
  insert into public.token_log (user_id, amount, reason, data) values (p_user, p_amount, p_reason, coalesce(p_data, '{}'::jsonb));
  delete from public.token_log where user_id = p_user and id <= (
    select id from public.token_log where user_id = p_user order by id desc offset 50 limit 1);
end $$;

-- Gives a player XP and tokens for something they did, within the daily caps:
-- * 'play': p_amount is seconds of playtime (1 XP a full minute, at most 120 XP a day)
-- * 'score': a new personal best (p_amount XP, at most 50 a day)
-- * 'achievement': p_amount XP and p_tokens tokens (at most 50 tokens a day)
-- * 'daily': Today's game (p_amount XP, p_tokens tokens)
-- Every new level adds 20 tokens and a notification. At most 600 XP a day in all.
create function public.award(p_user uuid, p_source text, p_amount integer, p_tokens integer default 0, p_data jsonb default '{}'::jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare
  p public.player_progress;
  v_today date := public.utc_today();
  v_xp integer := 0;
  v_tokens integer := greatest(coalesce(p_tokens, 0), 0);
  v_play integer;
  v_level integer;
  v_level_tokens integer;
begin
  if p_user is null or not exists (select 1 from public.profiles where id = p_user) then
    return;
  end if;
  insert into public.player_progress (user_id, day) values (p_user, v_today) on conflict do nothing;
  select * into p from public.player_progress where user_id = p_user for update;
  if p.day <> v_today then
    p.day := v_today;
    p.xp_today := 0;
    p.play_seconds_today := 0;
    p.play_xp_today := 0;
    p.score_xp_today := 0;
    p.achievement_tokens_today := 0;
  end if;

  if p_source = 'play' then
    p.play_seconds_today := least(p.play_seconds_today + greatest(coalesce(p_amount, 0), 0), 86400);
    v_play := least(120, p.play_seconds_today / 60);
    v_xp := greatest(v_play - p.play_xp_today, 0);
    p.play_xp_today := v_play;
    v_tokens := 0;
  elsif p_source = 'score' then
    v_xp := greatest(least(coalesce(p_amount, 0), 50 - p.score_xp_today), 0);
    p.score_xp_today := p.score_xp_today + v_xp;
    v_tokens := 0;
  elsif p_source = 'achievement' then
    v_xp := greatest(coalesce(p_amount, 0), 0);
    v_tokens := greatest(least(v_tokens, 50 - p.achievement_tokens_today), 0);
    p.achievement_tokens_today := p.achievement_tokens_today + v_tokens;
  elsif p_source = 'daily' then
    v_xp := greatest(coalesce(p_amount, 0), 0);
  else
    raise exception 'bad_source' using errcode = 'P0001';
  end if;
  v_xp := greatest(least(v_xp, 600 - p.xp_today), 0);
  p.xp_today := p.xp_today + v_xp;

  v_level := public.level_for_xp(p.xp + v_xp);
  v_level_tokens := 20 * greatest(v_level - p.level, 0);
  update public.player_progress set
    xp = p.xp + v_xp, level = greatest(v_level, p.level), tokens = p.tokens + v_tokens + v_level_tokens,
    day = p.day, xp_today = p.xp_today, play_seconds_today = p.play_seconds_today, play_xp_today = p.play_xp_today,
    score_xp_today = p.score_xp_today, achievement_tokens_today = p.achievement_tokens_today, updated_at = now()
  where user_id = p_user;
  perform public.log_tokens(p_user, v_tokens, p_source, p_data);
  if v_level > p.level then
    perform public.log_tokens(p_user, v_level_tokens, 'level', jsonb_build_object('level', v_level));
    perform public.notify(p_user, 'level_up', null, jsonb_build_object('level', v_level, 'tokens', v_level_tokens));
  end if;
end $$;
revoke execute on function public.award(uuid, text, integer, integer, jsonb) from public, anon, authenticated;
revoke execute on function public.log_tokens(uuid, integer, text, jsonb) from public, anon, authenticated;

-- ---------- where XP and tokens come from ----------

create function public.award_playtime() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform public.award(new.user_id, 'play',
    (new.seconds - case when tg_op = 'UPDATE' then old.seconds else 0 end)::integer);
  return null;
end $$;

create function public.award_achievement() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform public.award(new.user_id, 'achievement', 25, 5, jsonb_build_object('game', new.game_id, 'id', new.achievement));
  -- The game's cosmetics for this achievement.
  insert into public.player_cosmetics (user_id, cosmetic_id, how)
    select new.user_id, c.id, 'achievement' from public.cosmetics c
    where c.game_id = new.game_id and c.achievement = new.achievement and c.active
    on conflict do nothing;
  return null;
end $$;

create function public.award_score() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' or new.score is distinct from old.score then
    perform public.award(new.user_id, 'score', 10);
  end if;
  return null;
end $$;

create function public.award_daily() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' or new.last_day is distinct from old.last_day then
    perform public.award(new.user_id, 'daily', 30, 5 + least(greatest(new.streak - 1, 0), 10), jsonb_build_object('streak', new.streak));
  end if;
  return null;
end $$;
revoke execute on function public.award_playtime(), public.award_achievement(), public.award_score(), public.award_daily()
  from public, anon, authenticated;

-- ---------- cosmetics ----------

-- Whether a cosmetic's look is one the app can draw: colors are "#rrggbb", the rest is from a
-- short list.
create function public.cosmetic_style_ok(p_kind text, p_style jsonb) returns boolean
language plpgsql immutable set search_path = '' as $$
declare
  v_key text;
  v_allowed text[];
begin
  if p_style is null or jsonb_typeof(p_style) <> 'object' then
    return false;
  end if;
  v_allowed := case p_kind
    when 'frame' then array['style', 'a', 'b']
    when 'color' then array['a', 'b']
    when 'title' then array['a']
    when 'theme' then array['a', 'b', 'pattern']
    when 'stickers' then array['pack']
  end;
  for v_key in select jsonb_object_keys(p_style) loop
    if not v_key = any(v_allowed) then
      return false;
    end if;
    if v_key in ('a', 'b') and coalesce(p_style->>v_key, '') !~ '^#[0-9a-fA-F]{6}$' then
      return false;
    end if;
  end loop;
  return case p_kind
    when 'frame' then p_style->>'style' in ('ring', 'double', 'dashed', 'pixel', 'glow', 'spin', 'rainbow') and (p_style ? 'a' or p_style->>'style' = 'rainbow')
    when 'color' then p_style ? 'a'
    when 'title' then true
    when 'theme' then p_style ? 'a' and p_style ? 'b' and coalesce(p_style->>'pattern', 'plain') in ('plain', 'dots', 'grid', 'stripes', 'stars', 'waves')
    when 'stickers' then coalesce(p_style->>'pack', '') ~ '^[a-z0-9-]{1,20}$'
    else false
  end;
end $$;

create table public.cosmetics (
  id text primary key check (id ~ '^[a-z0-9][a-z0-9_.-]{1,47}$'),
  kind text not null check (kind in ('frame', 'color', 'title', 'theme', 'stickers')),
  name text not null check (char_length(btrim(name)) between 1 and 30),
  name_de text check (name_de is null or char_length(btrim(name_de)) between 1 and 30),
  -- tokens in the shop; null: not sold (a game's cosmetics, or one Toki stopped selling)
  price integer check (price is null or price between 1 and 100000),
  -- the level a player needs before they can buy it
  min_level integer not null default 1 check (min_level between 1 and 1000),
  style jsonb not null default '{}'::jsonb,
  -- A game's own cosmetic, which players get with one of its achievements.
  game_id uuid references public.games(id) on delete cascade,
  achievement text check (achievement is null or achievement ~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,31}$'),
  position smallint not null default 0,
  -- false: no longer handed out or sold; players who have it keep it
  active boolean not null default true,
  created_at timestamptz not null default now(),
  check (public.cosmetic_style_ok(kind, style)),
  check ((game_id is null) = (achievement is null)),
  check (game_id is null or (price is null and kind in ('frame', 'color', 'title', 'theme')))
);
create index cosmetics_game_idx on public.cosmetics(game_id, achievement);

create table public.player_cosmetics (
  user_id uuid not null references public.profiles(id) on delete cascade,
  cosmetic_id text not null references public.cosmetics(id) on delete cascade,
  got_at timestamptz not null default now(),
  how text not null check (how in ('shop', 'trade', 'achievement', 'admin')),
  primary key (user_id, cosmetic_id)
);
create index player_cosmetics_cosmetic_idx on public.player_cosmetics(cosmetic_id);

alter table public.cosmetics enable row level security;
alter table public.player_cosmetics enable row level security;
create policy "cosmetics are public" on public.cosmetics for select using (true);
-- What a player has is public, like the badges: friends see what they could trade for.
create policy "collections are public" on public.player_cosmetics for select using (true);
revoke all on public.cosmetics, public.player_cosmetics from anon, authenticated;
grant select on public.cosmetics, public.player_cosmetics to anon, authenticated;

-- What a player wears, shown with their name and avatar everywhere.
alter table public.profiles
  add column frame text references public.cosmetics(id) on delete set null,
  add column name_color text references public.cosmetics(id) on delete set null,
  add column title text references public.cosmetics(id) on delete set null,
  add column theme text references public.cosmetics(id) on delete set null;
grant select (frame, name_color, title, theme) on public.profiles to anon, authenticated;

-- A cosmetic that leaves a player (a trade, an admin) comes off their profile too.
create function public.cosmetic_left() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'DELETE' or new.user_id is distinct from old.user_id then
    update public.profiles set
      frame = nullif(frame, old.cosmetic_id), name_color = nullif(name_color, old.cosmetic_id),
      title = nullif(title, old.cosmetic_id), theme = nullif(theme, old.cosmetic_id)
    where id = old.user_id and old.cosmetic_id in (frame, name_color, title, theme);
  end if;
  return null;
end $$;
revoke execute on function public.cosmetic_left() from public, anon, authenticated;
create trigger player_cosmetics_left after update or delete on public.player_cosmetics
  for each row execute function public.cosmetic_left();

-- Toki's own cosmetics. Admins can change prices or stop selling one on the shop page.
insert into public.cosmetics (id, kind, name, name_de, price, min_level, style, position) values
  ('frame.mint',        'frame', 'Mint ring',     'Minzring',        40,  1, '{"style":"ring","a":"#1fbf7a"}', 10),
  ('frame.dash',        'frame', 'Dashed',        'Gestrichelt',     60,  1, '{"style":"dashed","a":"#8a8f98"}', 11),
  ('frame.sunset',      'frame', 'Sunset',        'Abendrot',        80,  1, '{"style":"ring","a":"#ff7a59","b":"#ffc531"}', 12),
  ('frame.ocean',       'frame', 'Deep sea',      'Tiefsee',         100, 2, '{"style":"double","a":"#3aa0ff","b":"#0b4f9c"}', 13),
  ('frame.pixel-gold',  'frame', 'Pixel gold',    'Pixelgold',       150, 3, '{"style":"pixel","a":"#ffc531","b":"#b8860b"}', 14),
  ('frame.neon',        'frame', 'Neon',          'Neon',            200, 5, '{"style":"glow","a":"#ff4fd8","b":"#7a5cff"}', 15),
  ('frame.spin',        'frame', 'Spinner',       'Kreisel',         300, 8, '{"style":"spin","a":"#00c2e0","b":"#ff3ea5"}', 16),
  ('frame.rainbow',     'frame', 'Rainbow',       'Regenbogen',      500, 12, '{"style":"rainbow"}', 17),
  ('color.mint',        'color', 'Mint',          'Minze',           60,  1, '{"a":"#17a868"}', 20),
  ('color.sky',         'color', 'Sky',           'Himmel',          60,  1, '{"a":"#2e8fe6"}', 21),
  ('color.rose',        'color', 'Rose',          'Rose',            60,  1, '{"a":"#e8487d"}', 22),
  ('color.gold',        'color', 'Gold',          'Gold',            120, 3, '{"a":"#d99a00"}', 23),
  ('color.sunset',      'color', 'Sunset',        'Abendrot',        200, 5, '{"a":"#f2613f","b":"#e0a100"}', 24),
  ('color.aurora',      'color', 'Aurora',        'Polarlicht',      250, 8, '{"a":"#00a9c7","b":"#9a4dff"}', 25),
  ('title.rookie',      'title', 'Rookie',        'Neuling',         20,  1, '{}', 30),
  ('title.chill',       'title', 'Just chilling', 'Einfach chillen', 60,  1, '{}', 31),
  ('title.speedrunner', 'title', 'Speedrunner',   'Speedrunner',     80,  2, '{}', 32),
  ('title.collector',   'title', 'Collector',     'Sammler',         80,  2, '{}', 33),
  ('title.night-owl',   'title', 'Night owl',     'Nachteule',       100, 3, '{}', 34),
  ('title.pixel-artist','title', 'Pixel artist',  'Pixelkünstler',   100, 3, '{}', 35),
  ('title.pro',         'title', 'Pro gamer',     'Profi',           150, 6, '{}', 36),
  ('title.legend',      'title', 'Legend',        'Legende',         400, 15, '{}', 37),
  ('theme.forest',      'theme', 'Forest',        'Wald',            120, 2, '{"a":"#1f6f4a","b":"#8fd694","pattern":"dots"}', 40),
  ('theme.ocean',       'theme', 'Ocean',         'Ozean',           120, 2, '{"a":"#0b4f9c","b":"#4fb3ff","pattern":"waves"}', 41),
  ('theme.candy',       'theme', 'Candy',         'Zuckerwatte',     150, 3, '{"a":"#e8487d","b":"#ffc2dc","pattern":"grid"}', 42),
  ('theme.sunset',      'theme', 'Sunset',        'Abendrot',        150, 4, '{"a":"#f2613f","b":"#ffc531","pattern":"stripes"}', 43),
  ('theme.space',       'theme', 'Outer space',   'Weltall',         200, 6, '{"a":"#1a1446","b":"#7a5cff","pattern":"stars"}', 44),
  ('stickers.pals',     'stickers', 'Pixel pals', 'Pixel-Freunde',   100, 1, '{"pack":"pals"}', 50),
  ('stickers.gg',       'stickers', 'Game on',    'Los geht''s',     150, 3, '{"pack":"gg"}', 51);

-- ---------- the shop ----------

-- Buys one of Toki's cosmetics. Returns the tokens left. Raises not_found (not sold), level
-- (needs a higher level), owned, or not_enough_tokens.
create function public.buy_cosmetic(p_id text) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_me uuid := auth.uid();
  c public.cosmetics;
  p public.player_progress;
begin
  if v_me is null then
    raise exception 'login_required' using errcode = 'P0001';
  end if;
  select * into c from public.cosmetics where id = p_id and game_id is null and price is not null and active;
  if c.id is null then
    raise exception 'not_found' using errcode = 'P0001';
  end if;
  insert into public.player_progress (user_id) values (v_me) on conflict do nothing;
  select * into p from public.player_progress where user_id = v_me for update;
  if p.level < c.min_level then
    raise exception 'level' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.player_cosmetics where user_id = v_me and cosmetic_id = c.id) then
    raise exception 'owned' using errcode = 'P0001';
  end if;
  if p.tokens < c.price then
    raise exception 'not_enough_tokens' using errcode = 'P0001';
  end if;
  update public.player_progress set tokens = tokens - c.price, updated_at = now() where user_id = v_me;
  insert into public.player_cosmetics (user_id, cosmetic_id, how) values (v_me, c.id, 'shop');
  perform public.log_tokens(v_me, -c.price, 'buy', jsonb_build_object('cosmetic', c.id));
  return p.tokens - c.price;
end $$;

-- Puts on a cosmetic the player has (p_id null: takes off what they wear of that kind).
create function public.equip_cosmetic(p_kind text, p_id text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_me uuid := auth.uid();
begin
  if v_me is null then
    raise exception 'login_required' using errcode = 'P0001';
  end if;
  if p_kind not in ('frame', 'color', 'title', 'theme') then
    raise exception 'bad_kind' using errcode = 'P0001';
  end if;
  if p_id is not null and not exists (
    select 1 from public.player_cosmetics o join public.cosmetics c on c.id = o.cosmetic_id
    where o.user_id = v_me and o.cosmetic_id = p_id and c.kind = p_kind) then
    raise exception 'not_owned' using errcode = 'P0001';
  end if;
  update public.profiles set
    frame = case when p_kind = 'frame' then p_id else frame end,
    name_color = case when p_kind = 'color' then p_id else name_color end,
    title = case when p_kind = 'title' then p_id else title end,
    theme = case when p_kind = 'theme' then p_id else theme end
  where id = v_me;
end $$;

-- The logged-in player's level, XP, tokens and where their tokens came from lately.
create function public.my_progress() returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'xp', coalesce(p.xp, 0), 'level', coalesce(p.level, 1), 'tokens', coalesce(p.tokens, 0),
    'xp_today', case when p.day = public.utc_today() then p.xp_today else 0 end,
    'log', coalesce((select jsonb_agg(jsonb_build_object('amount', l.amount, 'reason', l.reason, 'data', l.data, 'at', l.created_at) order by l.id desc)
      from (select * from public.token_log where user_id = auth.uid() order by id desc limit 20) l), '[]'::jsonb))
  from (select auth.uid() as id) me
  left join public.player_progress p on p.user_id = me.id
  where me.id is not null
$$;

-- Levels and what players wear, for names and avatars anywhere in the app (at most 200 at once).
create function public.player_looks(p_ids uuid[]) returns table (
  id uuid, level integer, xp bigint, frame text, name_color text, title text, theme text
)
language sql stable security definer set search_path = '' as $$
  select pr.id, coalesce(p.level, 1), coalesce(p.xp, 0), pr.frame, pr.name_color, pr.title, pr.theme
  from public.profiles pr
  left join public.player_progress p on p.user_id = pr.id
  where pr.id = any(p_ids[1:200])
$$;

-- The players with the most XP: everyone, or the logged-in player and their friends.
create function public.top_players(p_friends boolean default false, p_limit integer default 50) returns table (
  rank bigint, user_id uuid, username text, avatar_url text, avatar_seed text, level integer, xp bigint
)
language sql stable security definer set search_path = '' as $$
  with ranked as (
    select rank() over (order by coalesce(p.xp, 0) desc) as rank, pr.id as user_id, pr.username, pr.avatar_url, pr.avatar_seed,
      coalesce(p.level, 1) as level, coalesce(p.xp, 0) as xp, pr.created_at
    from public.profiles pr
    left join public.player_progress p on p.user_id = pr.id
    where (not coalesce(p_friends, false) and coalesce(p.xp, 0) > 0)
       or (coalesce(p_friends, false) and (pr.id = auth.uid() or exists (
         select 1 from public.friends f where f.user_id = auth.uid() and f.friend_id = pr.id)))
  )
  select rank, user_id, username, avatar_url, avatar_seed, level, xp from ranked
  where rank <= least(greatest(coalesce(p_limit, 50), 1), 100) or user_id = auth.uid()
  order by rank, created_at
$$;

-- ---------- a game's own cosmetics ----------

-- Sets a game's cosmetics: p_list is a JSON array (at most 5) of {id (to keep one it has), kind
-- ('frame', 'color', 'title' or 'theme'), name, name_de, style, achievement}. Ones left out are
-- deleted, and players lose them. Players who already have the achievement get new ones right
-- away. For the game's developer and admins. Returns the game's cosmetics afterwards.
create function public.set_game_cosmetics(p_game uuid, p_list jsonb) returns setof public.cosmetics
language plpgsql security definer set search_path = '' as $$
declare
  v_item jsonb;
  v_id text;
  v_keep text[] := '{}';
  v_n integer := 0;
begin
  if not public.feedback_manager(p_game) then
    raise exception 'not_allowed' using errcode = 'P0001';
  end if;
  if p_list is null or jsonb_typeof(p_list) <> 'array' then
    raise exception 'bad_cosmetics' using errcode = 'P0001';
  end if;
  if jsonb_array_length(p_list) > 5 then
    raise exception 'too_many_cosmetics' using errcode = 'P0001';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('cosmetics:' || p_game, 0));
  for v_item in select e from jsonb_array_elements(p_list) e loop
    if jsonb_typeof(v_item) <> 'object' or coalesce(v_item->>'kind', '') not in ('frame', 'color', 'title', 'theme')
       or not exists (select 1 from public.game_achievements where game_id = p_game and id = v_item->>'achievement') then
      raise exception 'bad_cosmetics' using errcode = 'P0001';
    end if;
    v_n := v_n + 1;
    v_id := v_item->>'id';
    if v_id is not null and exists (select 1 from public.cosmetics where id = v_id and game_id = p_game) then
      update public.cosmetics set kind = v_item->>'kind', name = btrim(v_item->>'name'),
        name_de = nullif(btrim(coalesce(v_item->>'name_de', '')), ''), style = coalesce(v_item->'style', '{}'::jsonb),
        achievement = v_item->>'achievement', position = v_n
      where id = v_id;
    else
      v_id := 'g' || substr(md5(gen_random_uuid()::text), 1, 15);
      insert into public.cosmetics (id, kind, name, name_de, style, game_id, achievement, position)
        values (v_id, v_item->>'kind', btrim(v_item->>'name'), nullif(btrim(coalesce(v_item->>'name_de', '')), ''),
          coalesce(v_item->'style', '{}'::jsonb), p_game, v_item->>'achievement', v_n);
    end if;
    v_keep := v_keep || v_id;
    insert into public.player_cosmetics (user_id, cosmetic_id, how)
      select u.user_id, v_id, 'achievement' from public.achievement_unlocks u
      where u.game_id = p_game and u.achievement = v_item->>'achievement'
      on conflict do nothing;
  end loop;
  delete from public.cosmetics where game_id = p_game and not (id = any(v_keep));
  return query select * from public.cosmetics where game_id = p_game order by position;
end $$;

-- ---------- trades ----------

-- When trading opens: the day the terms about tokens apply (src/lib/terms.ts).
create function public.trading_opens() returns timestamptz
language sql stable set search_path = '' as $$
  select '2026-12-05 00:00:00+01'::timestamptz
$$;

create table public.trades (
  id uuid primary key default gen_random_uuid(),
  from_id uuid not null references public.profiles(id) on delete cascade,
  to_id uuid not null references public.profiles(id) on delete cascade,
  give_tokens integer not null default 0 check (give_tokens between 0 and 100000),
  give_items text[] not null default '{}' check (cardinality(give_items) <= 10),
  want_tokens integer not null default 0 check (want_tokens between 0 and 100000),
  want_items text[] not null default '{}' check (cardinality(want_items) <= 10),
  -- expired: nobody answered in 7 days. failed: accepted, but one side no longer had what it offered.
  status text not null default 'open' check (status in ('open', 'done', 'declined', 'cancelled', 'expired', 'failed')),
  created_at timestamptz not null default now(),
  answered_at timestamptz,
  check (from_id <> to_id),
  check (give_tokens > 0 or cardinality(give_items) > 0),
  check (want_tokens > 0 or cardinality(want_items) > 0)
);
create index trades_from_idx on public.trades(from_id, created_at desc);
create index trades_to_idx on public.trades(to_id, created_at desc);

alter table public.trades enable row level security;
create policy "trades: own" on public.trades for select to authenticated
  using (from_id = (select auth.uid()) or to_id = (select auth.uid()));
revoke all on public.trades from anon, authenticated;
grant select on public.trades to authenticated;

-- Whether a player has all these cosmetics, and each of them can be traded (Toki's own).
create function public.has_tradable(p_user uuid, p_items text[]) returns boolean
language sql stable security definer set search_path = '' as $$
  select (select count(distinct o.cosmetic_id) from public.player_cosmetics o join public.cosmetics c on c.id = o.cosmetic_id
          where o.user_id = p_user and o.cosmetic_id = any(p_items) and c.game_id is null) = cardinality(array(select distinct unnest(p_items)))
$$;

-- Offers a friend a trade. Raises not_yet (before trading opens), not_friends, banned,
-- not_owned (one side doesn't have an item, or it can't be traded), already_owned (the other
-- side has it already), not_enough_tokens, too_many_open, rate_limited:trades_day.
create function public.offer_trade(p_to uuid, p_give_tokens integer, p_give_items text[], p_want_tokens integer, p_want_items text[]) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_me uuid := auth.uid();
  v_id uuid;
  v_give text[] := array(select distinct unnest(coalesce(p_give_items, '{}')));
  v_want text[] := array(select distinct unnest(coalesce(p_want_items, '{}')));
begin
  perform public.limit_lock(v_me);
  if v_me is null then
    raise exception 'login_required' using errcode = 'P0001';
  end if;
  if now() < public.trading_opens() then
    raise exception 'not_yet' using errcode = 'P0001';
  end if;
  if not public.not_banned() then
    raise exception 'banned' using errcode = 'P0001';
  end if;
  if not public.is_friend(p_to) or public.is_blocked(v_me, p_to) then
    raise exception 'not_friends' using errcode = 'P0001';
  end if;
  if not public.has_tradable(v_me, v_give) or not public.has_tradable(p_to, v_want) then
    raise exception 'not_owned' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.player_cosmetics where user_id = p_to and cosmetic_id = any(v_give))
     or exists (select 1 from public.player_cosmetics where user_id = v_me and cosmetic_id = any(v_want)) then
    raise exception 'already_owned' using errcode = 'P0001';
  end if;
  if coalesce(p_give_tokens, 0) > coalesce((select tokens from public.player_progress where user_id = v_me), 0) then
    raise exception 'not_enough_tokens' using errcode = 'P0001';
  end if;
  if (select count(*) from public.trades where from_id = v_me and status = 'open' and created_at > now() - interval '7 days') >= 10 then
    raise exception 'too_many_open' using errcode = 'P0001';
  end if;
  perform public.check_limit(v_me, 'trades_day',
    (select count(*) from public.trades where from_id = v_me and created_at > now() - interval '1 day'));
  insert into public.trades (from_id, to_id, give_tokens, give_items, want_tokens, want_items)
    values (v_me, p_to, greatest(coalesce(p_give_tokens, 0), 0), v_give, greatest(coalesce(p_want_tokens, 0), 0), v_want)
    returning id into v_id;
  perform public.notify(p_to, 'trade', v_me, jsonb_build_object('event', 'offer', 'trade', v_id));
  return v_id;
end $$;

-- The friend accepts (p_accept) or declines a trade. Returns the trade's status afterwards:
-- 'done', 'declined', or 'failed' when one side no longer has what it offered.
create function public.answer_trade(p_id uuid, p_accept boolean) returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_me uuid := auth.uid();
  t public.trades;
  v_ok boolean;
begin
  select * into t from public.trades where id = p_id and to_id = v_me for update;
  if t.id is null then
    raise exception 'not_found' using errcode = 'P0001';
  end if;
  if t.status <> 'open' or t.created_at < now() - interval '7 days' then
    raise exception 'closed' using errcode = 'P0001';
  end if;
  if not coalesce(p_accept, false) then
    update public.trades set status = 'declined', answered_at = now() where id = p_id;
    perform public.notify(t.from_id, 'trade', v_me, jsonb_build_object('event', 'declined', 'trade', p_id));
    return 'declined';
  end if;
  if now() < public.trading_opens() then
    raise exception 'not_yet' using errcode = 'P0001';
  end if;
  -- Both balances, always in the same order so two trades at once can't wait for each other.
  insert into public.player_progress (user_id) values (t.from_id), (t.to_id) on conflict do nothing;
  perform 1 from public.player_progress where user_id in (t.from_id, t.to_id) order by user_id for update;
  v_ok := public.is_friend(t.from_id) and not public.is_blocked(t.from_id, t.to_id)
    and public.has_tradable(t.from_id, t.give_items) and public.has_tradable(t.to_id, t.want_items)
    and not exists (select 1 from public.player_cosmetics where user_id = t.to_id and cosmetic_id = any(t.give_items))
    and not exists (select 1 from public.player_cosmetics where user_id = t.from_id and cosmetic_id = any(t.want_items))
    and (select tokens from public.player_progress where user_id = t.from_id) >= t.give_tokens
    and (select tokens from public.player_progress where user_id = t.to_id) >= t.want_tokens;
  if not v_ok then
    update public.trades set status = 'failed', answered_at = now() where id = p_id;
    perform public.notify(t.from_id, 'trade', v_me, jsonb_build_object('event', 'failed', 'trade', p_id));
    return 'failed';
  end if;
  update public.player_progress set tokens = tokens - t.give_tokens + t.want_tokens, updated_at = now() where user_id = t.from_id;
  update public.player_progress set tokens = tokens + t.give_tokens - t.want_tokens, updated_at = now() where user_id = t.to_id;
  update public.player_cosmetics set user_id = t.to_id, got_at = now(), how = 'trade'
    where user_id = t.from_id and cosmetic_id = any(t.give_items);
  update public.player_cosmetics set user_id = t.from_id, got_at = now(), how = 'trade'
    where user_id = t.to_id and cosmetic_id = any(t.want_items);
  perform public.log_tokens(t.from_id, t.want_tokens - t.give_tokens, 'trade', jsonb_build_object('trade', p_id, 'with', t.to_id));
  perform public.log_tokens(t.to_id, t.give_tokens - t.want_tokens, 'trade', jsonb_build_object('trade', p_id, 'with', t.from_id));
  update public.trades set status = 'done', answered_at = now() where id = p_id;
  perform public.notify(t.from_id, 'trade', v_me, jsonb_build_object('event', 'done', 'trade', p_id));
  return 'done';
end $$;

-- Takes back an open trade one offered.
create function public.cancel_trade(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  update public.trades set status = 'cancelled', answered_at = now()
    where id = p_id and from_id = auth.uid() and status = 'open';
  if not found then
    raise exception 'not_found' using errcode = 'P0001';
  end if;
  delete from public.notifications where kind = 'trade' and data->>'trade' = p_id::text and data->>'event' = 'offer';
end $$;

-- The logged-in player's trades of the last 30 days, newest first, with the other player.
create function public.my_trades() returns table (
  id uuid, mine boolean, other_id uuid, other_username text, other_avatar_url text, other_avatar_seed text,
  give_tokens integer, give_items text[], want_tokens integer, want_items text[], status text, created_at timestamptz, answered_at timestamptz
)
language sql stable security definer set search_path = '' as $$
  select t.id, t.from_id = auth.uid(), o.id, o.username, o.avatar_url, o.avatar_seed,
    t.give_tokens, t.give_items, t.want_tokens, t.want_items,
    case when t.status = 'open' and t.created_at < now() - interval '7 days' then 'expired' else t.status end,
    t.created_at, t.answered_at
  from public.trades t
  join public.profiles o on o.id = case when t.from_id = auth.uid() then t.to_id else t.from_id end
  where (t.from_id = auth.uid() or t.to_id = auth.uid()) and t.created_at > now() - interval '30 days'
  order by (t.status = 'open') desc, t.created_at desc
  limit 100
$$;

-- ---------- admins ----------

-- Gives (or, with a negative amount, takes) tokens: for mistakes and for tokens won by cheating.
create function public.admin_adjust_tokens(p_user uuid, p_amount integer) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_left integer;
  v_before integer;
begin
  if public.my_role() is distinct from 'admin' then
    raise exception 'not_allowed' using errcode = 'P0001';
  end if;
  insert into public.player_progress (user_id) values (p_user) on conflict do nothing;
  select tokens into v_before from public.player_progress where user_id = p_user for update;
  update public.player_progress set tokens = greatest(tokens + coalesce(p_amount, 0), 0), updated_at = now()
    where user_id = p_user returning tokens into v_left;
  perform public.log_tokens(p_user, v_left - v_before, 'admin');
  return v_left;
end $$;

-- Takes a cosmetic away from a player (won by cheating, or a game's cosmetic gone wrong).
create function public.admin_take_cosmetic(p_user uuid, p_id text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if public.my_role() is distinct from 'admin' then
    raise exception 'not_allowed' using errcode = 'P0001';
  end if;
  delete from public.player_cosmetics where user_id = p_user and cosmetic_id = p_id;
end $$;

-- Changes the price of one of Toki's cosmetics, or stops (or starts again) selling it.
create function public.admin_set_cosmetic(p_id text, p_price integer, p_active boolean) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if public.my_role() is distinct from 'admin' then
    raise exception 'not_allowed' using errcode = 'P0001';
  end if;
  update public.cosmetics set price = p_price, active = coalesce(p_active, active) where id = p_id and game_id is null;
  if not found then
    raise exception 'not_found' using errcode = 'P0001';
  end if;
end $$;

-- A player's tokens and recent changes, for admins looking into cheating.
create function public.admin_progress(p_user uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select case when public.my_role() = 'admin' then jsonb_build_object(
    'tokens', coalesce((select tokens from public.player_progress where user_id = p_user), 0),
    'log', coalesce((select jsonb_agg(jsonb_build_object('amount', l.amount, 'reason', l.reason, 'data', l.data, 'at', l.created_at) order by l.id desc)
      from public.token_log l where l.user_id = p_user), '[]'::jsonb)) end
$$;

-- ---------- chat stickers ----------
-- A message "[sticker:<pack>/<name>]" shows as a sticker. Only players who have the pack send
-- one; the app knows which stickers each pack holds.
create function public.messages_stickers() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_pack text := substring(new.body from '^\[sticker:([a-z0-9-]{1,20})/[a-z0-9-]{1,20}\]$');
begin
  if v_pack is not null and auth.uid() is not null and not exists (
    select 1 from public.player_cosmetics o join public.cosmetics c on c.id = o.cosmetic_id
    where o.user_id = auth.uid() and c.kind = 'stickers' and c.style->>'pack' = v_pack) then
    raise exception 'not_owned' using errcode = 'P0001';
  end if;
  return new;
end $$;
revoke execute on function public.messages_stickers() from public, anon, authenticated;
create trigger messages_stickers before insert on public.messages
  for each row execute function public.messages_stickers();

-- ---------- notifications, limits, deletion ----------

alter table public.notifications drop constraint notifications_kind_check;
-- level_up: a new level and its tokens. trade: a friend's offer, or what became of yours.
alter table public.notifications add constraint notifications_kind_check check (kind in (
  'fb_reply', 'fb_status', 'friend_request', 'friend_accept', 'group_add', 'score_beaten', 'game_invite', 'dev_news',
  'game_idea', 'moderation', 'report_done', 'application', 'level_up', 'trade'));

insert into public.limits (key, who, player, creator, min_value, max_value, sort) values
  ('trades_day', 'both', 20, 20, 0, 1000, 43);
insert into public.keep_times (key, value, unit, min_value, max_value, sort) values
  ('trades', 30, 'days', 1, 180, 70);

select cron.schedule('delete-old-trades', '47 4 * * *', $$
  update public.trades set status = 'expired', answered_at = now() where status = 'open' and created_at < now() - interval '7 days';
  delete from public.trades where status <> 'open' and coalesce(answered_at, created_at) < now() - make_interval(days => public.keep_value('trades'));
$$);

-- ---------- a start for everyone who played before 2.0 ----------
-- XP for what players did before: 25 per achievement, 10 per best score, a minute of playtime
-- 1 XP (at most 2000), 30 per day of their best streak of Today's game. Tokens for the levels
-- this reaches and 5 per achievement, all in one "start" line.
with done as (
  select pr.id,
    25 * (select count(*) from public.achievement_unlocks u where u.user_id = pr.id)
    + 10 * (select count(*) from public.game_scores s where s.user_id = pr.id)
    + least(2000, coalesce((select sum(seconds) from public.playtime t where t.user_id = pr.id), 0) / 60)
    + 30 * coalesce((select best_streak from public.daily_streaks d where d.user_id = pr.id), 0) as xp,
    5 * (select count(*) from public.achievement_unlocks u where u.user_id = pr.id) as ach_tokens
  from public.profiles pr
), start as (
  insert into public.player_progress (user_id, xp, level, tokens)
  select id, xp, public.level_for_xp(xp), ach_tokens + 20 * (public.level_for_xp(xp) - 1) from done where xp > 0
  returning user_id, tokens
)
insert into public.token_log (user_id, amount, reason) select user_id, tokens, 'start' from start where tokens > 0;

create trigger playtime_award after insert or update of seconds on public.playtime
  for each row execute function public.award_playtime();
create trigger achievement_unlocks_award after insert on public.achievement_unlocks
  for each row execute function public.award_achievement();
create trigger game_scores_award after insert or update of score on public.game_scores
  for each row execute function public.award_score();
create trigger daily_streaks_award after insert or update of last_day on public.daily_streaks
  for each row execute function public.award_daily();

revoke execute on function public.buy_cosmetic(text), public.equip_cosmetic(text, text), public.my_progress(),
  public.set_game_cosmetics(uuid, jsonb), public.offer_trade(uuid, integer, text[], integer, text[]),
  public.answer_trade(uuid, boolean), public.cancel_trade(uuid), public.my_trades(),
  public.admin_adjust_tokens(uuid, integer), public.admin_take_cosmetic(uuid, text),
  public.admin_set_cosmetic(text, integer, boolean), public.admin_progress(uuid), public.has_tradable(uuid, text[])
  from public, anon;
grant execute on function public.buy_cosmetic(text), public.equip_cosmetic(text, text), public.my_progress(),
  public.set_game_cosmetics(uuid, jsonb), public.offer_trade(uuid, integer, text[], integer, text[]),
  public.answer_trade(uuid, boolean), public.cancel_trade(uuid), public.my_trades(),
  public.admin_adjust_tokens(uuid, integer), public.admin_take_cosmetic(uuid, text),
  public.admin_set_cosmetic(text, integer, boolean), public.admin_progress(uuid)
  to authenticated;
grant execute on function public.player_looks(uuid[]), public.top_players(boolean, integer),
  public.xp_for_level(integer), public.level_for_xp(bigint), public.trading_opens() to anon, authenticated;
