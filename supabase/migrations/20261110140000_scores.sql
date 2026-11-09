-- High scores: games send a score through toki-save.js (toki.score(1234)). Each logged-in
-- player keeps only their best score per game (one small row), so this stays tiny.
-- The game's developer picks whether a higher or a lower score is better (e.g. a time), and
-- can remove scores that look like cheating.

alter table public.games
  add column score_order text not null default 'high' check (score_order in ('high', 'low')),
  -- how scores are shown: a number of points, or a time in milliseconds
  add column score_format text not null default 'points' check (score_format in ('points', 'time'));

create table public.game_scores (
  game_id uuid not null references public.games(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  score bigint not null check (score between -1000000000000 and 1000000000000),
  achieved_at timestamptz not null default now(),
  primary key (game_id, user_id)
);
create index game_scores_board_idx on public.game_scores(game_id, score desc);
create index game_scores_user_idx on public.game_scores(user_id);

alter table public.game_scores enable row level security;
create policy "scores are public" on public.game_scores for select using (true);
create policy "developers remove scores" on public.game_scores for delete to authenticated
  using (user_id = (select auth.uid()) or public.feedback_manager(game_id));
revoke all on public.game_scores from anon, authenticated;
grant select on public.game_scores to anon, authenticated;
grant delete on public.game_scores to authenticated;

-- Saves the score when it beats the player's best. Returns {"best": <best score>, "new": true/false}.
-- The player whose top-3 place was taken gets a notification.
create function public.submit_score(p_game uuid, p_score bigint) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_me uuid := auth.uid();
  v_order text;
  v_old bigint;
  v_rank_before uuid[];
  v_rank_after uuid[];
  v_title text;
  v_lost uuid;
begin
  if v_me is null then
    raise exception 'login_required' using errcode = 'P0001';
  end if;
  select score_order, title into v_order, v_title from public.games where id = p_game;
  if v_order is null then
    raise exception 'not_found' using errcode = 'P0001';
  end if;
  if p_score is null or p_score not between -1000000000000 and 1000000000000 then
    raise exception 'bad_score' using errcode = 'P0001';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('score:' || p_game, 0));
  select score into v_old from public.game_scores where game_id = p_game and user_id = v_me;
  if v_old is not null and (case when v_order = 'high' then p_score <= v_old else p_score >= v_old end) then
    return jsonb_build_object('best', v_old, 'new', false);
  end if;

  v_rank_before := array(select user_id from public.game_scores where game_id = p_game
    order by case when v_order = 'high' then -score else score end, achieved_at limit 3);
  insert into public.game_scores (game_id, user_id, score) values (p_game, v_me, p_score)
    on conflict (game_id, user_id) do update set score = excluded.score, achieved_at = now();
  v_rank_after := array(select user_id from public.game_scores where game_id = p_game
    order by case when v_order = 'high' then -score else score end, achieved_at limit 3);
  -- Whoever dropped out of the top 3 because of this score hears about it.
  for v_lost in select x from unnest(v_rank_before) x where x <> v_me and not (x = any(v_rank_after)) loop
    perform public.notify(v_lost, 'score_beaten', v_me, jsonb_build_object('game', p_game, 'title', v_title));
  end loop;
  return jsonb_build_object('best', p_score, 'new', true);
end $$;

-- The top 10 of a game, and the logged-in player's own place.
create function public.leaderboard(p_game uuid, p_limit integer default 10) returns table (
  rank bigint, user_id uuid, username text, avatar_url text, avatar_seed text, score bigint, achieved_at timestamptz
)
language sql stable security definer set search_path = '' as $$
  with g as (select score_order from public.games where id = p_game),
  ranked as (
    select rank() over (order by case when (select score_order from g) = 'high' then -s.score else s.score end) as rank,
      s.user_id, p.username, p.avatar_url, p.avatar_seed, s.score, s.achieved_at
    from public.game_scores s join public.profiles p on p.id = s.user_id
    where s.game_id = p_game
  )
  select * from ranked where rank <= least(greatest(p_limit, 1), 50) or user_id = auth.uid()
  order by rank, achieved_at
$$;

-- A player's best scores with their place, for the profile page.
create function public.player_scores(p_user uuid) returns table (game_id uuid, score bigint, rank bigint, players bigint)
language sql stable security definer set search_path = '' as $$
  select s.game_id, s.score,
    (select count(*) + 1 from public.game_scores o where o.game_id = s.game_id
      and case when g.score_order = 'high' then o.score > s.score else o.score < s.score end),
    (select count(*) from public.game_scores o where o.game_id = s.game_id)
  from public.game_scores s join public.games g on g.id = s.game_id
  where s.user_id = p_user
  order by s.achieved_at desc
  limit 24
$$;

revoke execute on function public.submit_score(uuid, bigint) from public, anon;
grant execute on function public.submit_score(uuid, bigint) to authenticated;
grant execute on function public.leaderboard(uuid, integer) to anon, authenticated;
grant execute on function public.player_scores(uuid) to anon, authenticated;
