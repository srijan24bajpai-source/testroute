-- RoutePilot AI: initial schema with row-level security.
-- Apply with the Supabase CLI (`supabase db push`) or the SQL editor on a NON-production project first.
-- NOT YET EXECUTED against a live Postgres in this repo's build session: see docs/BUILD_STATUS.md.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------- profiles
create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text check (char_length(display_name) <= 80),
  marketing_consent boolean not null default false,
  analytics_consent boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Auto-create a profile for each new auth user.
create function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id) values (new.id) on conflict do nothing;
  return new;
end $$;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------- saved searches / trips
create table public.saved_searches (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  constraints jsonb not null check (pg_column_size(constraints) < 4096),
  created_at timestamptz not null default now()
);
create index saved_searches_user_idx on public.saved_searches (user_id, created_at desc);

create table public.trips (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  title text not null check (char_length(title) between 1 and 100),
  constraints jsonb not null check (pg_column_size(constraints) < 4096),
  created_at timestamptz not null default now()
);
create index trips_user_idx on public.trips (user_id, created_at desc);

-- ---------------------------------------------------------------- itineraries
create table public.itineraries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  trip_id uuid references public.trips (id) on delete cascade,
  external_key text not null,            -- joined segment ids
  source text not null check (source in ('live','demo','mixed')),
  depart_at timestamptz not null,
  arrive_at timestamptz not null,
  total_group_paise bigint not null check (total_group_paise >= 0),
  created_at timestamptz not null default now()
);
create index itineraries_user_idx on public.itineraries (user_id);

create table public.itinerary_segments (
  id uuid primary key default gen_random_uuid(),
  itinerary_id uuid not null references public.itineraries (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  position int not null check (position >= 0),
  mode text not null check (mode in ('flight','train','bus','ground')),
  provider text not null,
  service_id text not null,
  from_code text not null,
  to_code text not null,
  depart_at timestamptz not null,
  arrive_at timestamptz not null,
  fare_paise bigint check (fare_paise >= 0),
  fare_kind text not null check (fare_kind in ('quoted','estimated')),
  unique (itinerary_id, position)
);

-- ---------------------------------------------------------------- quotes
create table public.quotes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users (id) on delete set null,   -- quotes referenced by bookings outlive the account (no PII inside)
  provider_id text not null,
  segment_ids text[] not null,
  passengers int not null check (passengers between 1 and 9),
  total_group_paise bigint not null check (total_group_paise >= 0),
  currency text not null default 'INR' check (currency = 'INR'),
  hash text not null check (char_length(hash) = 64),
  issued_at timestamptz not null,
  expires_at timestamptz not null,
  capability text not null check (capability in ('SEARCH_ONLY','QUOTE_AND_BOOK','CANCEL_SUPPORTED','DEMO_ONLY')),
  snapshot jsonb not null
);
create index quotes_user_idx on public.quotes (user_id, issued_at desc);

-- ---------------------------------------------------------------- bookings (ledger)
create table public.bookings (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users (id) on delete set null,          -- financial records are kept, unlinked from the person, when the account is deleted
  quote_id uuid not null references public.quotes (id),
  provider_id text not null,
  status text not null check (status in (
    'DRAFT','QUOTE_REFRESH_REQUIRED','PENDING_USER_CONFIRMATION','BOOKING_IN_PROGRESS','PAYMENT_PENDING',
    'RECONCILIATION_REQUIRED','CONFIRMED','FAILED','CANCEL_REQUESTED','CANCELLED','REFUND_PENDING')),
  idempotency_key text not null check (char_length(idempotency_key) between 16 and 80),
  external_ref text,
  payment_url text,
  total_group_paise bigint not null check (total_group_paise >= 0),
  currency text not null default 'INR' check (currency = 'INR'),
  passenger_count int not null check (passenger_count between 1 and 9),
  segment_ids text[] not null default '{}',
  failure_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, idempotency_key),                      -- duplicate-submit protection
  -- A booking may only be CONFIRMED with a provider-issued reference.
  constraint confirmed_has_reference check (status <> 'CONFIRMED' or (external_ref is not null and external_ref <> ''))
);
create unique index bookings_provider_ref_idx on public.bookings (provider_id, external_ref) where external_ref is not null;
create index bookings_user_idx on public.bookings (user_id, created_at desc);

create table public.booking_segments (
  booking_id uuid not null references public.bookings (id) on delete cascade,
  position int not null,
  segment_id text not null,
  primary key (booking_id, position)
);

-- Passenger names are NOT stored in this schema: they are passed through to the provider only.

-- ---------------------------------------------------------------- events / audit (append-only)
create table public.provider_events (
  provider_id text not null,
  event_id text not null,
  received_at timestamptz not null default now(),
  primary key (provider_id, event_id)                    -- webhook replay protection
);

create table public.booking_audit_events (
  id bigint generated always as identity primary key,
  booking_id uuid not null references public.bookings (id) on delete cascade,
  at timestamptz not null default now(),
  type text not null,
  from_status text,
  to_status text,
  note text check (char_length(note) <= 200)             -- never PII or secrets
);
create index booking_audit_booking_idx on public.booking_audit_events (booking_id, at);

create function public.forbid_mutation() returns trigger language plpgsql as $$
begin raise exception 'append-only table'; end $$;
create trigger audit_immutable before update or delete on public.booking_audit_events
  for each row execute function public.forbid_mutation();

create table public.support_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  booking_id uuid references public.bookings (id),
  subject text not null check (char_length(subject) <= 120),
  body text not null check (char_length(body) <= 2000),
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- row level security
alter table public.profiles enable row level security;
alter table public.saved_searches enable row level security;
alter table public.trips enable row level security;
alter table public.itineraries enable row level security;
alter table public.itinerary_segments enable row level security;
alter table public.quotes enable row level security;
alter table public.bookings enable row level security;
alter table public.booking_segments enable row level security;
alter table public.provider_events enable row level security;
alter table public.booking_audit_events enable row level security;
alter table public.support_requests enable row level security;

-- Owner-only policies. `(select auth.uid())` is evaluated once per statement.
create policy profiles_self on public.profiles for all to authenticated
  using (id = (select auth.uid())) with check (id = (select auth.uid()));

create policy saved_searches_owner on public.saved_searches for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy trips_owner on public.trips for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy itineraries_owner on public.itineraries for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy itinerary_segments_owner on public.itinerary_segments for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy support_owner on public.support_requests for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

-- Money-moving tables are READ-ONLY for end users; only the server (service role) writes them.
create policy quotes_read on public.quotes for select to authenticated using (user_id = (select auth.uid()));
create policy bookings_read on public.bookings for select to authenticated using (user_id = (select auth.uid()));
create policy booking_segments_read on public.booking_segments for select to authenticated
  using (exists (select 1 from public.bookings b where b.id = booking_id and b.user_id = (select auth.uid())));
create policy audit_read on public.booking_audit_events for select to authenticated
  using (exists (select 1 from public.bookings b where b.id = booking_id and b.user_id = (select auth.uid())));
-- provider_events: no policies → no access for anon/authenticated (service role bypasses RLS).

revoke all on public.provider_events from anon, authenticated;
revoke insert, update, delete on public.quotes, public.bookings, public.booking_segments, public.booking_audit_events from anon, authenticated;
revoke all on all tables in schema public from anon;

-- Account deletion: bookings, quotes and payments use ON DELETE SET NULL, so deleting an auth user unlinks the person from
-- retained transaction records instead of failing or destroying them. Set your own retention period and purge job.
