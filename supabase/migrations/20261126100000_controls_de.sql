-- Controls in German, shown on a game's page when Toki is in German (like description_de).
alter table public.games add column if not exists controls_de text
  check (controls_de is null or char_length(controls_de) <= 500);
