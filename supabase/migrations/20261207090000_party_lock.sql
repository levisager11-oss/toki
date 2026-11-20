-- One player's party requests run one after the other.
--
-- Inviting several friends at once (everyone picked before the room was open gets their invite
-- the moment it opens), together with the link to share, sent two or three requests from the
-- same player at the same time. Each saw "no party yet" and made one; the second insert into
-- party_members failed on its primary key, so that friend's invite was lost with an error.
-- The same could happen to a friend who accepted an invite twice at once.

-- Held until the request's transaction ends. Only ever taken for the player themselves, so two
-- players can't wait on each other.
create function public.party_lock(p_user uuid) returns void
language sql security definer set search_path = '' as $$
  select pg_advisory_xact_lock(hashtextextended('party:' || p_user::text, 0))
$$;
revoke execute on function public.party_lock(uuid) from public, anon, authenticated;

create or replace function public.party_ensure(p_me uuid, p_game uuid, p_code text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_party uuid;
  v_chat uuid;
begin
  perform public.party_lock(p_me);
  select party_id into v_party from public.party_members where user_id = p_me;
  if v_party is not null then
    update public.parties set updated_at = now() where id = v_party;
    perform public.party_set_room(v_party, p_me, p_game, p_code);
    return v_party;
  end if;
  insert into public.chats (kind) values ('party') returning id into v_chat;
  insert into public.parties (leader_id, chat_id, game_id, code, open, seq)
    values (p_me, v_chat, p_game, p_code, true, 1) returning id into v_party;
  insert into public.party_members (user_id, party_id) values (p_me, v_party);
  return v_party;
end $$;

create or replace function public.join_party(p_party uuid, p_code text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_me uuid := auth.uid();
  p public.parties;
begin
  if v_me is null then
    raise exception 'login_required' using errcode = 'P0001';
  end if;
  if not public.not_banned() then
    raise exception 'banned' using errcode = 'P0001';
  end if;
  perform public.party_lock(v_me);
  select * into p from public.parties where id = p_party;
  if p.id is null then
    raise exception 'not_found' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.party_members where party_id = p_party and user_id = v_me) then
    return public.party_state(p_party);
  end if;
  if not exists (
    select 1 from public.notifications n
    join public.party_members m on m.user_id = n.actor_id and m.party_id = p_party
    where n.user_id = v_me and n.kind = 'game_invite' and n.created_at > now() - interval '30 minutes'
      and n.data->>'party' = p_party::text
  ) and not (
    p_code is not null and p.open and p.code = p_code and exists (
      select 1 from public.party_members m
      join public.friends f on f.user_id = v_me and f.friend_id = m.user_id
      where m.party_id = p_party)
  ) then
    raise exception 'not_invited' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.party_members m where m.party_id = p_party and public.is_blocked(v_me, m.user_id)) then
    raise exception 'blocked' using errcode = 'P0001';
  end if;
  if (select count(*) from public.party_members where party_id = p_party) >= public.limit_of(v_me, 'party_size') then
    raise exception 'party_full' using errcode = 'P0001';
  end if;
  perform public.party_drop(v_me);
  insert into public.party_members (user_id, party_id) values (v_me, p_party);
  update public.parties set updated_at = now() where id = p_party;
  return public.party_state(p_party);
end $$;
