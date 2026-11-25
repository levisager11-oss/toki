-- How many reviews a game has per star value (hidden reviews don't count). Anyone may ask.
-- Returns one row per star value 5..1, also when there are none.
create function public.review_breakdown(p_game uuid) returns table (stars int, n int)
language sql stable security definer set search_path = '' as $$
  select s.stars, count(r.id)::int
  from generate_series(5, 1, -1) as s(stars)
  left join public.game_reviews r on r.game_id = p_game and r.stars = s.stars and not r.hidden
  group by s.stars
  order by s.stars desc
$$;
revoke execute on function public.review_breakdown(uuid) from public;
grant execute on function public.review_breakdown(uuid) to anon, authenticated;
