-- An optional wide picture (2:1) for the home page's featured banner.
-- Games without one show their cover picture there, in its own shape.
alter table public.games add column banner_url text
  check (banner_url is null or (banner_url ~ '^https://' and char_length(banner_url) <= 500));
