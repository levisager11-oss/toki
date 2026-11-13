-- Questions and answers on a developer application: while it's open, an admin can ask something
-- ("Which of these games did you make?") and the applicant answers on /apply. Both see the whole
-- conversation; the other side gets a notification ("application": event 'question' or 'answer').
-- The notes live in the application's row (at most 20, 1000 characters each) and go with it.

alter table public.developer_applications
  add column notes jsonb not null default '[]'::jsonb check (jsonb_typeof(notes) = 'array' and jsonb_array_length(notes) <= 20);

alter table public.notifications drop constraint notifications_kind_check;
alter table public.notifications add constraint notifications_kind_check check (kind in (
  'fb_reply', 'fb_status', 'friend_request', 'friend_accept', 'group_add', 'score_beaten', 'game_invite', 'dev_news',
  'game_idea', 'moderation', 'report_done', 'application'));

-- Adds a note to an open application: an admin's question, or the applicant's answer. Returns
-- the notes afterwards. Raises not_found, not_allowed, closed (no longer open), bad_text or full.
create function public.application_note(p_id uuid, p_text text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  a public.developer_applications;
  v_admin boolean := public.my_role() = 'admin';
  v_text text := btrim(coalesce(p_text, ''));
  v_notes jsonb;
  r record;
begin
  select * into a from public.developer_applications where id = p_id for update;
  if not found then
    raise exception 'not_found' using errcode = 'P0001';
  end if;
  if not v_admin and a.user_id is distinct from auth.uid() then
    raise exception 'not_allowed' using errcode = 'P0001';
  end if;
  if a.status <> 'pending' then
    raise exception 'closed' using errcode = 'P0001';
  end if;
  if char_length(v_text) not between 1 and 1000 then
    raise exception 'bad_text' using errcode = 'P0001';
  end if;
  if jsonb_array_length(a.notes) >= 20 then
    raise exception 'full' using errcode = 'P0001';
  end if;
  v_notes := a.notes || jsonb_build_array(jsonb_build_object(
    'by', case when a.user_id = auth.uid() then 'applicant' else 'admin' end, 'text', v_text, 'at', now()));
  update public.developer_applications set notes = v_notes where id = p_id;
  if a.user_id = auth.uid() then
    -- The applicant answered: every admin hears about it.
    for r in select id from public.profiles where role = 'admin' loop
      perform public.notify(r.id, 'application', auth.uid(), jsonb_build_object('event', 'answer', 'application', p_id));
    end loop;
  else
    perform public.notify(a.user_id, 'application', null, jsonb_build_object('event', 'question', 'application', p_id));
  end if;
  return v_notes;
end $$;
revoke execute on function public.application_note(uuid, text) from public, anon;
grant execute on function public.application_note(uuid, text) to authenticated;
