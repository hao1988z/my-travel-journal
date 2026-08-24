-- Additive migration for a persistent album cover.
-- Existing trips and photos are preserved. Before this migration, the app
-- continues to use the first available photo as the fallback cover.

alter table public.trips
  add column if not exists cover_path text;
