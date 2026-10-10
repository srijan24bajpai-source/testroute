-- Negative RLS tests: User A's rows must be invisible/immutable to User B.
-- Run on a STAGING project after applying migrations (SQL editor or `psql`). NOT YET EXECUTED in the build session.
-- Everything runs in a transaction and is rolled back.
begin;

-- Two synthetic users (inserting into auth.users requires the postgres/service role).
insert into auth.users (id, instance_id, aud, role, email) values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'rls-a@example.test'),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'rls-b@example.test');

insert into public.trips (id, user_id, title, constraints)
values ('11111111-1111-4111-8111-111111111111', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'A trip', '{}');
insert into public.quotes (id, user_id, provider_id, segment_ids, passengers, total_group_paise, hash, issued_at, expires_at, capability, snapshot)
values ('22222222-2222-4222-8222-222222222222', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'p', '{s1}', 1, 1000, repeat('a', 64), now(), now() + interval '10 min', 'DEMO_ONLY', '{}');
insert into public.bookings (id, user_id, quote_id, provider_id, status, idempotency_key, external_ref, total_group_paise, passenger_count)
values ('33333333-3333-4333-8333-333333333333', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '22222222-2222-4222-8222-222222222222', 'p', 'CONFIRMED', repeat('k', 20), 'REF1', 1000, 1);

-- Act as user B.
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb","role":"authenticated"}', true);

do $$
declare n int;
begin
  select count(*) into n from public.trips;    if n <> 0 then raise exception 'FAIL: B can read A trips'; end if;
  select count(*) into n from public.quotes;   if n <> 0 then raise exception 'FAIL: B can read A quotes'; end if;
  select count(*) into n from public.bookings; if n <> 0 then raise exception 'FAIL: B can read A bookings'; end if;

  update public.trips set title = 'hacked' where id = '11111111-1111-4111-8111-111111111111';
  get diagnostics n = row_count;               if n <> 0 then raise exception 'FAIL: B updated A trip'; end if;
  delete from public.trips where id = '11111111-1111-4111-8111-111111111111';
  get diagnostics n = row_count;               if n <> 0 then raise exception 'FAIL: B deleted A trip'; end if;

  begin
    insert into public.trips (user_id, title, constraints) values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'spoof', '{}');
    raise exception 'FAIL: B inserted a row owned by A';
  exception when others then
    if sqlerrm like 'FAIL%' then raise; end if;  -- expected RLS violation otherwise
  end;

  begin
    update public.bookings set status = 'CANCELLED' where id = '33333333-3333-4333-8333-333333333333';
    raise exception 'FAIL: end user can write bookings';
  exception when others then
    if sqlerrm like 'FAIL%' then raise; end if;  -- permission denied expected
  end;
end $$;

-- Act as user A: can read own rows but still cannot write the money tables.
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated"}', true);
do $$
declare n int;
begin
  select count(*) into n from public.bookings; if n <> 1 then raise exception 'FAIL: A cannot read own booking'; end if;
  begin
    update public.bookings set status = 'CANCELLED';
    raise exception 'FAIL: A can write bookings directly';
  exception when others then
    if sqlerrm like 'FAIL%' then raise; end if;
  end;
end $$;

rollback;
select 'RLS negative tests passed' as result;
