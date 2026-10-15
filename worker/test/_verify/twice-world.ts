/**
 * LENS "twice" harness (not a test file). A small world the REAL follow-up-reminder.ts and the REAL monday.ts gql run
 * against: fetch is a fake monday API whose 跟进提醒 cell runs workflow #07 -- one email on every change INTO a
 * trigger label, then 已提醒 (optionally after a delay); writing the value a cell already holds fires nothing; a clear
 * mails nobody. Every monday status value carries changed_at (verified live). HubSpot (hs), the card registry and the
 * CreateIdempotency DO (notes + the run lock, with claimLock/renewLock/releaseLock semantics on Date.now()) are
 * in-memory. Only fake timers move time.
 */
import { vi } from "vitest";
import { CRM_CONTACTS } from "../../src/config/crm";

export const MIN = 60_000;
export const T0 = Date.parse("2026-10-12T02:00:00.000Z");        // the assignment
export const STATUS = "color_mm82ccsb";
export const OWNER_COL = "multiple_person_mm6zap53";
export const BOARD = CRM_CONTACTS.boardId;
export const INDEX: Record<string, number> = { "30分钟未跟进": 0, "已提醒": 1, "60分钟未跟进": 2 };
export const TRIGGERS = new Set(["30分钟未跟进", "60分钟未跟进"]);
export const iso = (t: number) => new Date(t).toISOString();
export const ms = (raw: string) => { const s = String(raw ?? "").trim(); return /^\d+$/.test(s) ? Number(s) : Date.parse(s); };

export type Lead = { id: string; owner: string; assigned: string; created: string; term: string; lifecycle: string;
  lastActivity: string };
export const lead = (o: Partial<Lead> = {}): Lead => ({ id: "9001", owner: "77", assigned: iso(T0),
  created: iso(T0 - 5 * MIN), term: "docusign", lifecycle: "lead", lastActivity: "", ...o });
const propsOf = (c: Lead) => ({ hubspot_owner_id: c.owner, hubspot_owner_assigneddate: c.assigned, createdate: c.created,
  utm_term: c.term, lifecyclestage: c.lifecycle, notes_last_updated: c.lastActivity || null });

/** How one monday mutation request fares. `latencyMs`: when the answer comes; `commitAtMs`: when monday applies it
 *  (default: just before answering). */
export type Fault = "ok" | "429" | "503" | "524" | "commit-504" | "commit-lost" | "lost" | "commit-data-errors";
export type Step = { fault: Fault; latencyMs?: number; commitAtMs?: number };

export interface Card { contact: string; status: { label: string; changedAt: number } | null; owner: string[] }

/** A fault on one operation (the fault sweep): "throw" -- fails, never applied; "throw-after" -- applied, then its
 *  answer is lost; "hang-after" -- applied, then nothing more (the invocation died on it). */
export type Mode = "throw" | "throw-after" | "hang-after";

const sleep = (t: number) => (t > 0 ? new Promise<void>(r => setTimeout(r, t)) : Promise.resolve());
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

export function makeWorld() {
  const w = {
    // HubSpot
    index: [lead()] as Lead[],                              // what the search returns (and the record, unless `record`)
    record: {} as Record<string, Partial<Lead>>,
    owners: { "77": "owner77@example.test" } as Record<string, string>,
    searches: [] as any[],
    // monday
    users: { "owner77@example.test": "501" } as Record<string, string>,
    cards: new Map<string, Card>([["5551", { contact: "9001", status: null, owner: ["501"] }]]),
    registry: new Map<string, string>([["9001", "5551"]]),
    workflow: { on: true, delayMs: 0 },
    latencyMs: 0,                                           // every query answers after this
    queryLatency: null as null | ((query: string, n: number) => number | undefined),
    queries: 0,
    rateRetrySec: 64,                                       // a 429's retry_in_seconds -> gql waits 65 s
    plan: [] as Step[],                                     // consumed one per mutation request
    emails: [] as { item: string; label: string; to: string; at: number }[],
    sent: [] as { item: string; cv: any; at: number; fault: Fault }[],   // every mutation request monday received
    // the DO
    notes: new Map<string, string>(),
    noteLog: [] as [string, string, number][],
    noteFault: null as null | ((name: string, value: string) => boolean),
    locks: new Map<string, { at: number; owner: string }>(),
    // the fault sweep: every operation is numbered; `fault(i, op)` may fail it
    ops: [] as string[],
    fault: null as null | ((i: number, op: string) => Mode | undefined),
  };

  /** Number the operation, and fail it as `fault` says. */
  async function gate<T>(op: string, applyIt: () => T | Promise<T>): Promise<T> {
    const i = w.ops.length;
    w.ops.push(op);
    const mode = w.fault?.(i, op);
    if (mode === "throw") throw new TypeError(`${op}: failed (not applied)`);
    const out = await applyIt();
    if (mode === "throw-after") throw new TypeError(`${op}: answer lost (applied)`);
    if (mode === "hang-after") return new Promise<T>(() => undefined);
    return out;
  }

  function apply(item: string, cv: Record<string, any>) {
    if (!(STATUS in cv)) return;
    const card = w.cards.get(item);
    if (!card) return;
    const v = cv[STATUS];
    if (v === null) { card.status = null; return; }               // a clear: no change_at, mails nobody
    const label = String(v.label);
    if (card.status?.label === label) return;                      // the value it already holds: no change, no #07
    card.status = { label, changedAt: Date.now() };
    if (TRIGGERS.has(label) && w.workflow.on) {
      w.emails.push({ item, label, to: card.owner.join(",") || "nobody", at: Date.now() });
      const done = () => { card.status = { label: "已提醒", changedAt: Date.now() }; };
      if (w.workflow.delayMs > 0) setTimeout(done, w.workflow.delayMs); else done();
    }
  }

  async function fetchMonday(url: unknown, init: any): Promise<Response> {
    const { query, variables } = JSON.parse(String(init?.body));
    if (!w.fault) return fetchMonday0(query, variables);
    const op = /change_multiple_column_values/.test(query)
      ? (JSON.parse(variables.c)[STATUS] === null ? "monday:clear" : "monday:label")
      : /users\s*\(\s*limit/.test(query) ? "monday:users"
      : /items_page_by_column_values/.test(query) ? "monday:find" : "monday:cells";
    return gate(op, () => fetchMonday0(query, variables));
  }

  async function fetchMonday0(query: string, variables: any): Promise<Response> {
    if (/change_multiple_column_values/.test(query)) {
      const step = w.plan.shift() ?? { fault: "ok" as Fault };
      const cv = JSON.parse(variables.c);
      const item = String(variables.i);
      w.sent.push({ item, cv, at: Date.now(), fault: step.fault });
      const lat = step.latencyMs ?? 0;
      if (step.fault === "429") {
        await sleep(lat);
        return json(429, { data: null, errors: [{ message: "Complexity budget exhausted",
          extensions: { code: "COMPLEXITY_BUDGET_EXHAUSTED", retry_in_seconds: w.rateRetrySec } }] });
      }
      if (step.fault === "lost") { await sleep(lat); throw new TypeError("Network connection lost."); }
      if (step.fault === "503") { await sleep(lat); return new Response("Service Unavailable", { status: 503 }); }
      if (step.fault === "524") { await sleep(lat); return new Response("error code: 524", { status: 524 }); }
      const commitAt = step.commitAtMs ?? lat;
      if (commitAt <= lat) { await sleep(commitAt); apply(item, cv); await sleep(lat - commitAt); }
      else { setTimeout(() => apply(item, cv), commitAt); await sleep(lat); }
      if (step.fault === "commit-504") return new Response("<html>504 Gateway Time-out</html>", { status: 504 });
      if (step.fault === "commit-lost") throw new TypeError("Network connection lost.");
      if (step.fault === "commit-data-errors")
        return json(200, { data: { change_multiple_column_values: { id: item } }, errors: [{ message: "partial" }] });
      return json(200, { data: { change_multiple_column_values: { id: item } } });
    }
    const n = w.queries++;
    await sleep(w.queryLatency?.(query, n) ?? w.latencyMs);
    if (/users\s*\(\s*limit/.test(query))
      return json(200, { data: { users: Object.entries(w.users).map(([email, id]) => ({ id, email })) } });
    if (/items_page_by_column_values/.test(query)) {
      const v = String(variables.v?.[0]);
      const items = [...w.cards.entries()].filter(([, c]) => c.contact === v).map(([id]) => ({ id, name: "x" }));
      return json(200, { data: { items_page_by_column_values: { items } } });
    }
    if (/items\s*\(\s*ids/.test(query)) {
      const card = w.cards.get(String(variables.i?.[0]));
      if (!card) return json(200, { data: { items: [] } });
      const s = card.status;
      return json(200, { data: { items: [{ column_values: [
        { id: STATUS, text: s?.label ?? "", index: s ? INDEX[s.label] : null,
          value: s ? JSON.stringify({ index: INDEX[s.label], changed_at: iso(s.changedAt) }) : null },
        { id: OWNER_COL, text: "", value: null, persons_and_teams: card.owner.map(id => ({ id, kind: "person" })) },
      ] }] } });
    }
    throw new Error(`unexpected monday query: ${String(query).slice(0, 80)}`);
  }

  async function hs(env: unknown, method: string, path: string, body?: any) {
    if (!w.fault) return hs0(env, method, path, body);
    const op = method === "POST" ? "hubspot:search" : /\/owners\//.test(path) ? "hubspot:owner" : "hubspot:contact";
    return gate(op, () => hs0(env, method, path, body));
  }

  async function hs0(_env: unknown, method: string, path: string, body?: any) {
    if (method === "POST" && path === "/crm/v3/objects/contacts/search") {
      w.searches.push(body);
      const f = body.filterGroups[0].filters;
      const gte = Number(f.find((x: any) => x.propertyName === "hubspot_owner_assigneddate" && x.operator === "GTE")?.value);
      const lte = Number(f.find((x: any) => x.propertyName === "hubspot_owner_assigneddate" && x.operator === "LTE")?.value);
      const rows = w.index.filter(c => { const a = ms(c.assigned); return a >= gte && a <= lte; })
        .sort((a, b) => ms(a.assigned) - ms(b.assigned));
      const from = Number(body.after ?? 0);
      const page = rows.slice(from, from + body.limit);
      return { total: rows.length, results: page.map(c => ({ id: c.id, properties: propsOf(c) })),
        ...(from + body.limit < rows.length ? { paging: { next: { after: String(from + body.limit) } } } : {}) };
    }
    const contact = /^\/crm\/v3\/objects\/contacts\/(\w+)\?/.exec(path);
    if (method === "GET" && contact) {
      const base = w.index.find(c => c.id === contact[1]);
      if (!base) throw new Error(`hubspot GET ${path}: 404 Not Found`);
      return { id: base.id, properties: propsOf({ ...base, ...w.record[base.id] }) };
    }
    const owner = /^\/crm\/v3\/owners\/(\w+)/.exec(path);
    if (method === "GET" && owner) {
      if (!(owner[1] in w.owners)) throw new Error(`hubspot GET ${path}: 404 Not Found`);
      return { id: owner[1], email: w.owners[owner[1]] };
    }
    throw new Error(`unexpected hubspot ${method} ${path}`);
  }

  // The DO, behind activity-registry's own wrappers: getWatermark / setWatermark FAIL LOUD (throw); acquireLock and
  // renewLock FAIL CLOSED (false); releaseLock and card-registry's lookupCard FAIL SOFT.
  const g = <T>(op: string, f: () => T | Promise<T>): Promise<T> => (w.fault ? gate(op, f) : (async () => f())());
  const reg = {
    getWatermark: (_e: unknown, name: string) =>
      g("do:getWatermark", () => (w.notes.has(name) ? w.notes.get(name)! : null)),
    setWatermark: (_e: unknown, name: string, value: string) =>
      g(`do:setWatermark:${value.split(":")[0] || "release"}`, () => {
        if (w.noteFault?.(name, value))
          throw new Error(`watermark ${name} not saved: Durable Object reset because its code was updated`);
        w.notes.set(name, value);
        w.noteLog.push([name, value, Date.now()]);
      }),
    acquireLock: (_e: unknown, name: string, holdMs: number, owner: string) =>
      g("do:acquireLock", () => {
        const now = Date.now();
        const rec = w.locks.get(name);
        if (rec && rec.owner !== owner && now - rec.at < holdMs) return false;
        w.locks.set(name, { at: now, owner });
        return true;
      }).catch(() => false),
    renewLock: (_e: unknown, name: string, owner: string) =>
      g("do:renewLock", () => {
        const rec = w.locks.get(name);
        if (!rec || rec.owner !== owner) return false;
        w.locks.set(name, { at: Date.now(), owner });
        return true;
      }).catch(() => false),
    releaseLock: (_e: unknown, name: string, owner: string) =>
      g("do:releaseLock", () => { if (w.locks.get(name)?.owner === owner) w.locks.delete(name); })
        .catch(() => undefined),
  };
  const lookupCard = (_e: unknown, _board: string, contactId: string) =>
    g("do:lookupCard", () => w.registry.get(contactId) ?? null).catch(() => null);

  return { w, fetchMonday, hs, reg, lookupCard };
}

export type World = ReturnType<typeof makeWorld>;

/** Advance fake time until `p` settles (1 s steps), and return its value. */
export async function drive<T>(p: Promise<T>, maxMs = 30 * MIN, stepMs = 1000): Promise<T> {
  let done = false; let val: T | undefined; let err: unknown;
  p.then(v => { done = true; val = v; }, e => { done = true; err = e; });
  for (let i = 0; i < 5 && !done; i++) await vi.advanceTimersByTimeAsync(0);
  for (let t = 0; t < maxMs && !done; t += stepMs) await vi.advanceTimersByTimeAsync(stepMs);
  if (!done) throw new Error("did not settle");
  if (err) throw err;
  return val as T;
}

/** Move fake time forward to `at` (firing whatever falls due on the way). */
export async function tickTo(at: number) {
  const d = at - Date.now();
  if (d > 0) await vi.advanceTimersByTimeAsync(d);
}
