-- Payments (PhonePe / PayPal). Written by the server with the service role only. NOT yet executed against a live database.

create table public.payments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users (id) on delete set null,            -- financial record: retained, unlinked from the person on account deletion
  booking_id uuid not null references public.bookings (id),
  gateway text not null check (gateway in ('phonepe','paypal')),
  amount_paise bigint not null check (amount_paise > 0),                 -- what the traveller owes (INR)
  charged_minor bigint not null check (charged_minor > 0),               -- what the gateway charges, minor units
  charged_currency text not null check (char_length(charged_currency) = 3),
  status text not null check (status in ('CREATED','PENDING','COMPLETED','FAILED','REFUND_REQUIRED','REVIEW_REQUIRED')),
  gateway_order_id text,
  gateway_txn_id text,
  redirect_url text check (redirect_url is null or redirect_url like 'https://%'),
  note text check (char_length(note) <= 200),                            -- never PII
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (booking_id),                                                   -- one payment attempt per booking (a retry creates a new booking/quote)
  unique (gateway, gateway_order_id)
);
create index payments_user_idx on public.payments (user_id, created_at desc);

-- A COMPLETED payment must carry the gateway's transaction id.
alter table public.payments add constraint completed_has_txn check (status <> 'COMPLETED' or gateway_txn_id is not null);

-- Passenger details held ONLY between checkout and the purchase call. Encrypt the column with pgsodium/Vault or
-- application-level encryption before production, and run the purge job below.
create table public.booking_passengers_tmp (
  booking_id uuid primary key references public.bookings (id) on delete cascade,
  payload_encrypted bytea not null,
  expires_at timestamptz not null default (now() + interval '2 hours')
);

alter table public.payments enable row level security;
alter table public.booking_passengers_tmp enable row level security;

-- Travellers may read their own payments; they can never write them. The temp table has no policies: service role only.
create policy payments_read on public.payments for select to authenticated using (user_id = (select auth.uid()));
revoke all on public.payments from anon;                                   -- the public key gets no access at all (0001 ran its blanket revoke before this table existed)
revoke insert, update, delete on public.payments from authenticated;
revoke all on public.booking_passengers_tmp from anon, authenticated;

-- Purge job (schedule with pg_cron or a Vercel cron route): delete expired passenger rows every few minutes.
--   delete from public.booking_passengers_tmp where expires_at < now();
