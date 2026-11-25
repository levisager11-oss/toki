-- Gifts and counter-offers for trades between friends.
-- A gift is an offer that wants nothing back; the friend still accepts or declines it.
-- A counter-offer is a new offer that, when sent, declines the one it answers.
-- Tokens a player may receive through trades and gifts are capped per day (limit trade_tokens_day).

-- An offer may want nothing (but must still give something: the give check stays).
do $$
declare c record;
begin
  for c in select conname from pg_constraint
    where conrelid = 'public.trades'::regclass and contype = 'c'
      and pg_get_constraintdef(oid) like '%want_tokens > 0%' and pg_get_constraintdef(oid) not like '%give_tokens%'
  loop
    execute format('alter table public.trades drop constraint %I', c.conname);
  end loop;
end $$;

insert into public.limits (key, who, player, creator, min_value, max_value, sort) values
  ('trade_tokens_day', 'both', 200, 200, 0, 100000, 44);

drop function public.offer_trade(uuid, integer, text[], integer, text[]);

-- Offers a friend a trade, or a gift when nothing is wanted. p_reply_to: an open offer one got
-- from this friend, which sending this one declines (a counter-offer). Raises not_yet (before
-- trading opens), not_friends, banned, not_found (p_reply_to isn't an open offer from this
-- friend), not_owned (one side doesn't have an item, or it can't be traded), already_owned (the
-- other side has it already), not_enough_tokens, too_many_open, rate_limited:trades_day.
create function public.offer_trade(p_to uuid, p_give_tokens integer, p_give_items text[], p_want_tokens integer, p_want_items text[], p_reply_to uuid default null) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_me uuid := auth.uid();
  v_id uuid;
  v_give text[] := array(select distinct unnest(coalesce(p_give_items, '{}')));
  v_want text[] := array(select distinct unnest(coalesce(p_want_items, '{}')));
  v_gift boolean;
  v_old public.trades;
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
  if p_reply_to is not null then
    select * into v_old from public.trades
      where id = p_reply_to and to_id = v_me and from_id = p_to and status = 'open'
        and created_at > now() - interval '7 days' for update;
    if v_old.id is null then
      raise exception 'not_found' using errcode = 'P0001';
    end if;
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
  v_gift := greatest(coalesce(p_want_tokens, 0), 0) = 0 and cardinality(v_want) = 0;
  insert into public.trades (from_id, to_id, give_tokens, give_items, want_tokens, want_items)
    values (v_me, p_to, greatest(coalesce(p_give_tokens, 0), 0), v_give, greatest(coalesce(p_want_tokens, 0), 0), v_want)
    returning id into v_id;
  if v_old.id is not null then
    update public.trades set status = 'declined', answered_at = now() where id = v_old.id;
  end if;
  perform public.notify(p_to, 'trade', v_me, jsonb_build_object('event', 'offer', 'trade', v_id)
    || case when v_gift then '{"gift": true}'::jsonb else '{}'::jsonb end
    || case when v_old.id is not null then '{"counter": true}'::jsonb else '{}'::jsonb end);
  return v_id;
end $$;

-- From 20261214090000_review_and_trade_fixes.sql, plus a daily cap on the tokens a player
-- receives through trades and gifts (trade_tokens_day): over it, accepting raises
-- rate_limited:trade_tokens_day and the offer stays open.
create or replace function public.answer_trade(p_id uuid, p_accept boolean) returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_me uuid := auth.uid();
  t public.trades;
  v_ok boolean;
  v_in_me integer;
  v_in_from integer;
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
  -- What each side ends up with on top (after what it gives), plus what it got in the last day.
  -- check_limit raises once its count reaches the limit, so the count is one less than the total.
  v_in_me := greatest(t.give_tokens - t.want_tokens, 0);
  v_in_from := greatest(t.want_tokens - t.give_tokens, 0);
  if v_in_me > 0 then
    perform public.check_limit(v_me, 'trade_tokens_day', v_in_me - 1 + (
      select coalesce(sum(amount), 0) from public.token_log
      where user_id = v_me and reason = 'trade' and amount > 0 and created_at > now() - interval '1 day'));
  end if;
  if v_in_from > 0 then
    perform public.check_limit(t.from_id, 'trade_tokens_day', v_in_from - 1 + (
      select coalesce(sum(amount), 0) from public.token_log
      where user_id = t.from_id and reason = 'trade' and amount > 0 and created_at > now() - interval '1 day'));
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

revoke execute on function public.offer_trade(uuid, integer, text[], integer, text[], uuid) from public, anon;
grant execute on function public.offer_trade(uuid, integer, text[], integer, text[], uuid) to authenticated;
