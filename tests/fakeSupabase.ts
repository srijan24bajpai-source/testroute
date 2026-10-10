import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * A tiny in-memory emulator of the PostgREST query-builder subset that SupabaseStore uses:
 * insert / upsert / select / update / delete with eq / in filters, order, maybeSingle, and unique constraints
 * (SQLSTATE 23505). It exists so the store logic can be tested without a database. It is NOT Postgres.
 */
type Row = Record<string, unknown>;
type Result = { data: unknown; error: { message: string; code?: string } | null };

const UNIQUE: Record<string, string[][]> = {
  quotes: [["id"]],
  bookings: [["id"], ["user_id", "idempotency_key"]],
  payments: [["id"], ["booking_id"]],
  provider_events: [["provider_id", "event_id"]],
  booking_passengers_tmp: [["booking_id"]],
  trips: [["id"]],
  saved_searches: [["id"]],
  booking_audit_events: [],
};

export class FakeDb {
  tables = new Map<string, Row[]>();
  private ids = new Map<string, number>();
  rows(t: string): Row[] {
    if (!this.tables.has(t)) this.tables.set(t, []);
    return this.tables.get(t)!;
  }
  nextId(t: string) {
    const n = (this.ids.get(t) ?? 0) + 1;
    this.ids.set(t, n);
    return n;
  }
  violates(t: string, row: Row, ignore?: Row): boolean {
    return (UNIQUE[t] ?? []).some((cols) => this.rows(t).some((r) => r !== ignore && cols.every((c) => r[c] !== undefined && r[c] === row[c])));
  }
}

class Builder implements PromiseLike<Result> {
  private op: "select" | "insert" | "upsert" | "update" | "delete" = "select";
  private payload: Row | Row[] = {};
  private filters: ((r: Row) => boolean)[] = [];
  private returning = false;
  private orderBy: { col: string; asc: boolean } | null = null;
  private single = false;

  constructor(private db: FakeDb, private table: string) {}

  select(_cols?: string) {
    this.returning = true;
    return this;
  }
  insert(p: Row | Row[]) { this.op = "insert"; this.payload = p; return this; }
  upsert(p: Row | Row[]) { this.op = "upsert"; this.payload = p; return this; }
  update(p: Row) { this.op = "update"; this.payload = p; return this; }
  delete() { this.op = "delete"; return this; }
  eq(col: string, val: unknown) { this.filters.push((r) => r[col] === val); return this; }
  in(col: string, vals: unknown[]) { this.filters.push((r) => vals.includes(r[col])); return this; }
  order(col: string, o?: { ascending?: boolean }) { this.orderBy = { col, asc: o?.ascending !== false }; return this; }
  maybeSingle() { this.single = true; return this; }

  private run(): Result {
    const t = this.table;
    const matching = () => this.db.rows(t).filter((r) => this.filters.every((f) => f(r)));
    const out = (rows: Row[]): Result => {
      let r = rows.map((x) => ({ ...x }));
      if (this.orderBy) {
        const { col, asc } = this.orderBy;
        r = r.sort((a, b) => (a[col]! < b[col]! ? -1 : a[col]! > b[col]! ? 1 : 0) * (asc ? 1 : -1));
      }
      if (this.single) {
        if (r.length > 1) return { data: null, error: { message: "multiple rows returned" } };
        return { data: r[0] ?? null, error: null };
      }
      return { data: r, error: null };
    };

    switch (this.op) {
      case "select":
        return out(matching());
      case "insert": {
        const list = Array.isArray(this.payload) ? this.payload : [this.payload];
        const created: Row[] = [];
        for (const raw of list) {
          const row = { ...raw };
          if (t === "booking_audit_events") row.id = this.db.nextId(t);
          if (this.db.violates(t, row)) return { data: null, error: { message: `duplicate key value violates unique constraint on ${t}`, code: "23505" } };
          this.db.rows(t).push(row);
          created.push(row);
        }
        return this.returning ? out(created) : { data: null, error: null };
      }
      case "upsert": {
        const row = { ...(this.payload as Row) };
        const pk = (UNIQUE[t]?.[0] ?? ["id"])[0];
        const existing = this.db.rows(t).find((r) => r[pk] === row[pk]);
        if (existing) Object.assign(existing, row);
        else this.db.rows(t).push(row);
        return { data: null, error: null };
      }
      case "update": {
        const rows = matching();
        for (const r of rows) Object.assign(r, this.payload);
        return this.returning ? out(rows) : { data: null, error: null };
      }
      case "delete": {
        const rows = matching();
        this.db.tables.set(t, this.db.rows(t).filter((r) => !rows.includes(r)));
        return this.returning ? out(rows) : { data: null, error: null };
      }
    }
  }

  then<R1 = Result, R2 = never>(ok?: ((v: Result) => R1 | PromiseLike<R1>) | null, fail?: ((e: unknown) => R2 | PromiseLike<R2>) | null): PromiseLike<R1 | R2> {
    // Resolve on a microtask, like a real network call would, so races between callers are realistic.
    return Promise.resolve().then(() => this.run()).then(ok, fail);
  }
}

export function fakeSupabase(db = new FakeDb()): { client: SupabaseClient; db: FakeDb } {
  const client = { from: (t: string) => new Builder(db, t) } as unknown as SupabaseClient;
  return { client, db };
}
