-- Phase 3 preparation: one trip can contain many days and many stops per day.
-- This migration is additive. It does not rewrite or remove existing trip data.

create table if not exists public.trip_days (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references public.trips(id) on delete cascade,
  day_number integer not null check (day_number > 0),
  date date,
  title text,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (trip_id, day_number)
);

create table if not exists public.trip_stops (
  id uuid primary key default gen_random_uuid(),
  day_id uuid not null references public.trip_days(id) on delete cascade,
  name text not null,
  address text,
  lat double precision,
  lng double precision,
  arrival_time time,
  departure_time time,
  note text,
  mood text,
  category text,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (lat is null or lat between -90 and 90),
  check (lng is null or lng between -180 and 180)
);

-- Modern photo rows can optionally point at a stop. Existing photos remain valid.
do $$
begin
  if to_regclass('public.trip_photos') is not null then
    alter table public.trip_photos
      add column if not exists trip_stop_id uuid;

    if not exists (
      select 1
      from pg_constraint
      where conname = 'trip_photos_trip_stop_id_fkey'
        and conrelid = 'public.trip_photos'::regclass
    ) then
      alter table public.trip_photos
        add constraint trip_photos_trip_stop_id_fkey
        foreign key (trip_stop_id)
        references public.trip_stops(id)
        on delete set null;
    end if;
  end if;
end $$;

create index if not exists trip_days_trip_id_sort_idx
  on public.trip_days (trip_id, sort_order, day_number);

create index if not exists trip_stops_day_id_sort_idx
  on public.trip_stops (day_id, sort_order, arrival_time);

do $$
begin
  if to_regclass('public.trip_photos') is not null then
    create index if not exists trip_photos_trip_stop_id_idx
      on public.trip_photos (trip_stop_id);
  end if;
end $$;

alter table public.trip_days enable row level security;
alter table public.trip_stops enable row level security;

drop policy if exists "trip days follow trip access" on public.trip_days;
create policy "trip days follow trip access"
  on public.trip_days
  for all
  using (trip_id in (select id from public.trips))
  with check (trip_id in (select id from public.trips));

drop policy if exists "trip stops follow trip access" on public.trip_stops;
create policy "trip stops follow trip access"
  on public.trip_stops
  for all
  using (day_id in (select id from public.trip_days))
  with check (day_id in (select id from public.trip_days));

-- No automatic Day 1 or stop is generated for old trips because a city field
-- cannot reliably tell us the user's actual route.
