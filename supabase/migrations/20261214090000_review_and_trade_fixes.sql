-- Fixes from a review of Toki 2.0 (20261212090000_toki_tokens.sql, 20261213090000_reviews_and_feed.sql).

-- ---------- a game with reviews can be deleted again ----------

-- Deleting a game deletes its stats row and then its reviews; for each review this trigger put a
-- new stats row in for the game that was going away, and the whole delete failed (and with it
-- deleting the developer's account, or a game removed after a report).
create or replace function public.game_reviews_count() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_game uuid := coalesce(new.game_id, old.game_id);
begin
  if not exists (select 1 from public.games where id = v_game) then
    return null;
  end if;
  insert into public.game_stats (game_id) values (v_game) on conflict do nothing;
  update public.game_stats s set
    reviews = (select count(*) from public.game_reviews r where r.game_id = v_game and not r.hidden),
    stars = coalesce((select sum(r.stars) from public.game_reviews r where r.game_id = v_game and not r.hidden), 0)
  where s.game_id = v_game;
  return null;
end $$;

-- ---------- a review an admin removed stays removed ----------

-- Deletes the logged-in player's review of a game. One an admin removed after a report keeps its
-- row, without its text, so writing it again doesn't bring it back.
create or replace function public.delete_review(p_game uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  update public.game_reviews set body = '', reply = null, reply_by = null, reply_at = null
    where game_id = p_game and user_id = auth.uid() and hidden;
  delete from public.game_reviews where game_id = p_game and user_id = auth.uid() and not hidden;
end $$;

-- Whether p_user already got a notification of this kind from p_actor about this game (they are
-- kept 30 days), so deleting and writing a review again, or an answer, doesn't notify again.
create function public.notified(p_user uuid, p_kind text, p_actor uuid, p_game uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.notifications
    where user_id = p_user and kind = p_kind and actor_id is not distinct from p_actor and data->>'game' = p_game::text)
$$;
revoke execute on function public.notified(uuid, text, uuid, uuid) from public, anon, authenticated;

-- from 20261213090000_reviews_and_feed.sql; the developer hears of a player's review once, and a
-- deleted review still counts towards the day's limit while it is written again the same day.
create or replace function public.save_review(p_game uuid, p_stars integer, p_body text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_me uuid := auth.uid();
  v_owner uuid;
  v_title text;
  v_id uuid;
  v_body text := btrim(coalesce(p_body, ''));
begin
  perform public.limit_lock(v_me);
  if v_me is null then
    raise exception 'login_required' using errcode = 'P0001';
  end if;
  select created_by, title into v_owner, v_title from public.games where id = p_game;
  if v_title is null then
    raise exception 'not_found' using errcode = 'P0001';
  end if;
  if v_owner = v_me then
    raise exception 'own_game' using errcode = 'P0001';
  end if;
  if not public.not_banned() then
    raise exception 'banned' using errcode = 'P0001';
  end if;
  if coalesce((select seconds from public.playtime where user_id = v_me and game_id = p_game), 0) < 600 then
    raise exception 'play_more' using errcode = 'P0001';
  end if;
  if p_stars is null or p_stars not between 1 and 5 or char_length(v_body) > 1000 then
    raise exception 'bad_review' using errcode = 'P0001';
  end if;
  select id into v_id from public.game_reviews where game_id = p_game and user_id = v_me for update;
  if v_id is not null then
    update public.game_reviews set stars = p_stars, body = v_body, edited_at = now() where id = v_id;
    return v_id;
  end if;
  -- Reviews written today, and the ones the developer heard of today (written, then deleted).
  perform public.check_limit(v_me, 'reviews_day', greatest(
    (select count(*) from public.game_reviews where user_id = v_me and created_at > now() - interval '1 day'),
    (select count(*) from public.notifications where actor_id = v_me and kind = 'review' and created_at > now() - interval '1 day')));
  insert into public.game_reviews (game_id, user_id, stars, body) values (p_game, v_me, p_stars, v_body) returning id into v_id;
  if not public.notified(v_owner, 'review', v_me, p_game) then
    perform public.notify(v_owner, 'review', v_me, jsonb_build_object('game', p_game, 'title', v_title, 'stars', p_stars, 'review', v_id));
  end if;
  return v_id;
end $$;

-- from 20261213090000_reviews_and_feed.sql; the player hears of the developer's answer once,
-- not each time it is taken away and written again.
create or replace function public.reply_review(p_id uuid, p_text text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  r public.game_reviews;
  v_text text := nullif(btrim(coalesce(p_text, '')), '');
begin
  select * into r from public.game_reviews where id = p_id for update;
  if r.id is null or not public.feedback_manager(r.game_id) then
    raise exception 'not_allowed' using errcode = 'P0001';
  end if;
  if char_length(v_text) > 1000 then
    raise exception 'bad_review' using errcode = 'P0001';
  end if;
  update public.game_reviews set reply = v_text, reply_by = case when v_text is null then null else auth.uid() end,
    reply_at = case when v_text is null then null else now() end
    where id = p_id;
  if v_text is not null and r.reply is null and not public.notified(r.user_id, 'review_reply', auth.uid(), r.game_id) then
    perform public.notify(r.user_id, 'review_reply', auth.uid(), jsonb_build_object(
      'game', r.game_id, 'title', (select title from public.games where id = r.game_id)));
  end if;
end $$;

-- ---------- trades: a banned player can't accept ----------

-- from 20261212090000_toki_tokens.sql; accepting now raises banned for a player banned from
-- chatting and posting (declining still works).
create or replace function public.answer_trade(p_id uuid, p_accept boolean) returns text
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
  if not public.not_banned() then
    raise exception 'banned' using errcode = 'P0001';
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

-- ---------- the shop: a price left out stays ----------

create or replace function public.admin_set_cosmetic(p_id text, p_price integer, p_active boolean) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if public.my_role() is distinct from 'admin' then
    raise exception 'not_allowed' using errcode = 'P0001';
  end if;
  update public.cosmetics set price = coalesce(p_price, price), active = coalesce(p_active, active) where id = p_id and game_id is null;
  if not found then
    raise exception 'not_found' using errcode = 'P0001';
  end if;
end $$;

-- ---------- the feed: the day's newest achievements are the ones kept ----------

create or replace function public.add_activity(p_user uuid, p_kind text, p_key text, p_game uuid, p_data jsonb, p_merge text default null) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not coalesce((select share_activity from public.profiles where id = p_user), false) then
    return;
  end if;
  insert into public.activity as a (user_id, kind, key, game_id, data)
    values (p_user, p_kind, p_key, p_game, p_data)
    on conflict (user_id, key) do update set created_at = now(), data = case
      when p_merge is null then excluded.data
      else excluded.data || jsonb_build_object(p_merge, (
        -- the last 10 different ones, oldest first
        select coalesce(jsonb_agg(x order by pos), '[]'::jsonb) from (
          select x, max(pos) as pos
          from jsonb_array_elements(coalesce(a.data->p_merge, '[]'::jsonb) || coalesce(excluded.data->p_merge, '[]'::jsonb))
            with ordinality as e(x, pos)
          group by x order by max(pos) desc limit 10) y))
    end;
  delete from public.activity where user_id = p_user and id in (
    select id from public.activity where user_id = p_user order by created_at desc offset 100);
end $$;
revoke execute on function public.add_activity(uuid, text, text, uuid, jsonb, text) from public, anon, authenticated;
