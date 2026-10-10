import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";

import { fileURLToPath } from "node:url";
// Run:  npm i --no-save @electric-sql/pglite   then   node supabase/tests/pglite-check.mjs
const P = fileURLToPath(new URL("..", import.meta.url)).replace(/\\/g, "/").replace(/\/$/, "");
const db = new PGlite();
const results = [];
const T = (name, ok, detail = "") => results.push({ name, ok: !!ok, detail });
const run = async (label, sql) => { try { const r = await db.exec(sql); return { ok: true, r }; } catch (e) { return { ok: false, err: e.message }; } };

// ---- Supabase stand-ins (roles, auth schema, default grants) that exist on a real project
const stub = await run("stub", `
  create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
  create schema auth;
  create table auth.users (id uuid primary key, instance_id uuid, aud text, role text, email text);
  create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claims', true)::jsonb ->> 'sub','')::uuid $$;
  grant usage on schema public, auth to anon, authenticated, service_role;
  alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
  alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
  alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
`);
T("Supabase stand-ins created", stub.ok, stub.err);

let m1 = readFileSync(`${P}/migrations/0001_init.sql`, "utf8");
const m2 = readFileSync(`${P}/migrations/0002_payments.sql`, "utf8");
// pgcrypto is a Postgres extension that Supabase provides; the in-process engine may not ship it (gen_random_uuid is built in).
let r = await run("0001", m1);
if (!r.ok && /pgcrypto|extension/i.test(r.err)) { m1 = m1.replace("create extension if not exists pgcrypto;", "-- pgcrypto skipped in test engine"); r = await run("0001 (without pgcrypto)", m1); T("note: pgcrypto extension unavailable in the test engine (Supabase has it)", true); }
T("migration 0001_init.sql applies cleanly", r.ok, r.err);
r = await run("0002", m2);
T("migration 0002_payments.sql applies cleanly", r.ok, r.err);

// ---- the RLS negative test shipped in the repo
const rls = await run("rls", readFileSync(`${P}/tests/rls_negative.sql`, "utf8"));
const lastRows = rls.ok ? JSON.stringify(rls.r.at(-1)?.rows ?? []) : "";
T("supabase/tests/rls_negative.sql passes (user B cannot see/modify user A; users cannot write money tables)", rls.ok && lastRows.includes("RLS negative tests passed"), rls.err ?? lastRows);

// ---- extra checks
const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
await run("users", `insert into auth.users (id, instance_id, aud, role, email) values ('${A}','00000000-0000-0000-0000-000000000000','authenticated','authenticated','a@t.test'),('${B}','00000000-0000-0000-0000-000000000000','authenticated','authenticated','b@t.test') on conflict do nothing;`);
const prof = await db.query(`select count(*)::int c from public.profiles`);
T("a profile row is created automatically for each new user (trigger)", prof.rows[0].c >= 2, `profiles=${prof.rows[0].c}`);

await run("seed", `
  insert into public.quotes (id,user_id,provider_id,segment_ids,passengers,total_group_paise,hash,issued_at,expires_at,capability,snapshot)
  values ('22222222-2222-4222-8222-222222222222','${A}','p','{s1}',1,1000,repeat('a',64),now(),now()+interval '10 min','DEMO_ONLY','{}');`);

const bad = async (name, sql, match) => { const x = await run(name, sql); T(name, !x.ok && (!match || new RegExp(match, "i").test(x.err)), x.ok ? "was ACCEPTED (bad)" : x.err.slice(0, 90)); };
await bad("CONFIRMED booking without a provider reference is rejected by the database",
  `insert into public.bookings (user_id,quote_id,provider_id,status,idempotency_key,total_group_paise,passenger_count) values ('${A}','22222222-2222-4222-8222-222222222222','p','CONFIRMED',repeat('k',20),1000,1);`, "confirmed_has_reference");
const ok1 = await run("valid booking", `insert into public.bookings (id,user_id,quote_id,provider_id,status,idempotency_key,external_ref,total_group_paise,passenger_count,segment_ids) values ('33333333-3333-4333-8333-333333333333','${A}','22222222-2222-4222-8222-222222222222','p','CONFIRMED',repeat('k',20),'PNR1',1000,1,'{s1,s2}');`);
T("a valid confirmed booking (with reference and segment ids) is accepted", ok1.ok, ok1.err);
await bad("duplicate (user, idempotency key) is rejected (double-submit protection)",
  `insert into public.bookings (user_id,quote_id,provider_id,status,idempotency_key,total_group_paise,passenger_count) values ('${A}','22222222-2222-4222-8222-222222222222','p','PENDING_USER_CONFIRMATION',repeat('k',20),1000,1);`, "duplicate|unique");
await bad("unknown booking status is rejected", `update public.bookings set status='MAYBE' where id='33333333-3333-4333-8333-333333333333';`, "check");
await run("audit", `insert into public.booking_audit_events (booking_id,type,note) values ('33333333-3333-4333-8333-333333333333','created','x');`);
await bad("audit log is append-only (update blocked)", `update public.booking_audit_events set note='tampered';`, "append-only");
await bad("audit log is append-only (delete blocked)", `delete from public.booking_audit_events;`, "append-only");
await bad("COMPLETED payment without a gateway transaction id is rejected",
  `insert into public.payments (user_id,booking_id,gateway,amount_paise,charged_minor,charged_currency,status) values ('${A}','33333333-3333-4333-8333-333333333333','phonepe',1000,1000,'INR','COMPLETED');`, "completed_has_txn");
const okPay = await run("pay", `insert into public.payments (id,user_id,booking_id,gateway,amount_paise,charged_minor,charged_currency,status,gateway_order_id,redirect_url) values ('44444444-4444-4444-8444-444444444444','${A}','33333333-3333-4333-8333-333333333333','phonepe',1000,1000,'INR','PENDING','OM1','https://pay.example.test/x');`);
T("a valid pending payment is accepted", okPay.ok, okPay.err);
await bad("payment redirect must be https", `update public.payments set redirect_url='http://insecure.test' where id='44444444-4444-4444-8444-444444444444';`, "check");
await bad("a second payment for the same booking is rejected", `insert into public.payments (user_id,booking_id,gateway,amount_paise,charged_minor,charged_currency,status) values ('${A}','33333333-3333-4333-8333-333333333333','paypal',1000,12,'USD','PENDING');`, "duplicate|unique");

// ---- RLS from the browser's point of view
const asUser = async (uid, sql) => { await db.exec(`set role authenticated; select set_config('request.jwt.claims','{"sub":"${uid}","role":"authenticated"}',false);`); try { return await db.query(sql); } finally { await db.exec(`reset role;`); } };
const seeA = await asUser(A, `select count(*)::int c from public.bookings`); const seeB = await asUser(B, `select count(*)::int c from public.bookings`);
T("owner sees own booking; another user sees none", seeA.rows[0].c === 1 && seeB.rows[0].c === 0, `A sees ${seeA.rows[0].c}, B sees ${seeB.rows[0].c}`);
const payB = await asUser(B, `select count(*)::int c from public.payments`);
T("another user cannot read payments", payB.rows[0].c === 0);
let writeBlocked = false; try { await asUser(A, `update public.bookings set status='CANCELLED'`); } catch { writeBlocked = true; }
T("a signed-in user cannot change their own booking directly", writeBlocked);
let tmpBlocked = false; try { await asUser(A, `select * from public.booking_passengers_tmp`); } catch { tmpBlocked = true; }
T("passenger holding table is unreachable for signed-in users", tmpBlocked);
let evBlocked = false; try { await asUser(A, `select * from public.provider_events`); } catch { evBlocked = true; }
T("webhook event table is unreachable for signed-in users", evBlocked);
await asUser(A, `insert into public.trips (user_id,title,constraints) values ('${A}','mine','{}')`);
let spoof = false; try { await asUser(B, `insert into public.trips (user_id,title,constraints) values ('${A}','spoof','{}')`); } catch { spoof = true; }
T("a user cannot create a trip owned by someone else", spoof);

// ---- account deletion keeps financial records, unlinked from the person
await run("delete user", `delete from auth.users where id='${A}';`);
const after = await db.query(`select (select count(*)::int from public.bookings) b, (select count(*)::int from public.bookings where user_id is null) bn, (select count(*)::int from public.payments where user_id is null) pn, (select count(*)::int from public.trips) t, (select count(*)::int from public.profiles where id='${A}') p`);
const x = after.rows[0];
T("deleting the account removes trips and profile but KEEPS booking and payment records, unlinked", x.b === 1 && x.bn === 1 && x.pn === 1 && x.t === 0 && x.p === 0, JSON.stringify(x));

console.log(JSON.stringify(results));
