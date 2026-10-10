/**
 * THE WORLD FOR STALE_FORWARD_GATE ENGINE TESTS -- shared by stale-forward-gate*.test.ts and stale-forward-marks.test.ts.
 *
 * One monday card and one HubSpot record, as small STATEFUL fakes that every pass of the REAL engine reads and writes:
 *   - HubSpot keeps every property's history, each version with sourceType and sourceId -- our PATCHes as INTEGRATION
 *     with our app's sourceId (OWN), a third app's with another id, a HubSpot user's as CRM_UI;
 *   - monday keeps the card, each TYPED cell's changed_at (the cell types in `w.typed`), the item's updated_at, and an
 *     activity log of every change (a person's UI change carries an action_record_uuid, an API write none);
 *   - the card's watch is the REAL CreateIdempotency Durable Object (in-memory storage, a real critical section), so
 *     the card-watch.ts reducers run as deployed; its alarm is recorded, and a test fires it (fireWatch) when the clock
 *     says so;
 *   - DEFERRED_SYNC is a recording fake: what the watch spills (converge, retry) and the webhook overflows is run on
 *     demand (drain), through the real settleCardWatch / retryMarkedEdits / syncHubspotObject.
 * Every pass runs with an env that names it (`as("NOTE")`), so a test can hold a named pass at a named step (hold),
 * e.g. the Note's pass between its card read and its monday write, while another pass runs.
 *
 * The test file must vi.mock "cloudflare:workers" (the DO base class), "../src/monday" (with `mondayFns()`),
 * "../src/hubspot" (the real module with `hubspotFns()` over it) and, unless it wants the real one,
 * "../src/associations".
 */
import { vi, expect } from "vitest";
import { colText } from "../../src/dedup";
import { expectedText, itemName } from "../../src/mapping";
import { withOptionOrder } from "../../src/reconcile";
import { OWN_HS_SOURCE_ID, type CardWatch } from "../../src/card-watch";
import { deferKey, type DeferredItem } from "../../src/deferred-sync";
import { CreateIdempotency } from "../../src/create-idempotency-do";
import {
  resetCtxCache, retryMarkedEdits, settleCardWatch, syncHubspotObject, syncHubspotRecord, syncMondayItem,
} from "../../src/sync";
import { handleMonday } from "../../src/webhooks";
import { resetUiActorCache } from "../../src/ui-actor";
import type { Ctx, Env, MondayItem, ObjectSpec, PassScope, RunOpts } from "../../src/types";

export const OWN = OWN_HS_SOURCE_ID;
export const ASK_ADA = "104118038";
export const REP = "104239547";
export const OTHER_APP = "99999";
export const live: RunOpts = { dryRun: false, writeHubspot: true, maxWrites: 30 };

export const LIFECYCLE: Record<string, string> = {
  lead: "1.NEW", marketingqualifiedlead: "2.Information error or incomplete/Send email for promotion",
  "1028988526": "3.Competitors", "1029059094": "4.Wrong contact", "1029060900": "5.No intention",
  "1029059095": "6.Not in contact/Pending further contact", opportunity: "7.Intention to purchase",
  customer: "8.The customer generating the transaction",
};
export const LIFECYCLE_ORDER: Record<string, number> = {
  lead: 0, marketingqualifiedlead: 1, "1028988526": 2, "1029059094": 3, "1029060900": 4, "1029059095": 5,
  opportunity: 6, customer: 7,
};
export const LEAD_STATUS_BASE: Record<string, string> = { NEW: "New", OPEN: "Open", IN_PROGRESS: "In Progress", UNQUALIFIED: "Unqualified" };

/** The env every pass runs with; tests flip switches on it (STALE_FORWARD_RETRY, ...) before they start. */
export const BASE_ENV: Record<string, string> = {
  ENABLE_CRM: "true", CRM_CUTOVER_AT: "2026-09-25T00:00:00Z", CRM_CREATE_CUTOFF_AT: "2026-09-01T00:00:00Z",
  NO_ACTIVITY_RELEASE: "true", STALE_FORWARD_GATE: "true", STALE_FORWARD_HOLD_S: "180",
  DRY_RUN: "false", WRITE_HUBSPOT: "true",
};
export const W = 180_000;
export let ENV: Record<string, string> = { ...BASE_ENV };
export function setEnv(patch: Record<string, string | undefined>): void {
  ENV = { ...ENV };
  for (const [k, v] of Object.entries(patch)) if (v === undefined) delete ENV[k]; else ENV[k] = v;
}

// ------------------------------------------------------------------------------------------ the world

export interface Version { value: string; timestamp: string; sourceType: string; sourceId?: string }
export type Op = "hs" | "card" | "fresh" | "history" | "patch" | "write" | "text" | "log";
export interface LogRow { col: string; at: number; userId: string; uuid: boolean; value: unknown; prev: unknown }

export interface World {
  spec: ObjectSpec;
  card: MondayItem;
  /** monday serves the HubSpot id in a column search (an adoption's card does not, until linked). */
  changedAt: Record<string, number>;
  hs: { id: string; properties: Record<string, string | null>; history: Record<string, Version[]> };
  /** Modified times our PATCHes get, in order. */
  mods: string[];
  /** Every Sync State value written, in order. */
  stamps: string[];
  trail: string[];
  gates: Map<string, { reached: () => void; wait: Promise<void> }>;
  historyFails: boolean;
  logFails: boolean;
  failGetRecord?: string;
  /** A pass whose next gated write monday refuses for its rate limit. */
  rateLimitWrite?: string;
  log: LogRow[];
  /** Column types monday stamps with changed_at. */
  typed: Set<string>;
  /** A people column's person ids, by column (persons_and_teams). */
  ctxOwners: Record<string, { name: string; email: string | null }>;
  mondayUsers: Record<string, string>;
  labelIndex: Map<string, number>;
  /** HubSpot's own reaction to one of our PATCHes (e.g. a stage's entered time). */
  onPatch?: (patch: Record<string, string>, mod: string) => void;
  /** The card's relation cells: linked item ids, and when the cell last changed. */
  links: Record<string, { ids: string[]; changedAt: number | null }>;
  /** Other monday cards the card links to: item id -> column -> text (their HubSpot id). */
  otherCards: Record<string, Record<string, string>>;
  /** HubSpot's associations of the record, by object. */
  assoc: Record<string, string[]>;
}

export let w: World;
export let lines: string[] = [];
export const logged = (re: RegExp) => lines.some(l => re.test(l));
export const clone = <T>(x: T): T => (x === undefined ? x : JSON.parse(JSON.stringify(x)) as T);
export const PASS = (env: unknown) => String((env as { __pass?: string } | undefined)?.__pass ?? "?");
export const clock = (iso: string) => vi.setSystemTime(new Date(iso));
export const now = () => new Date(Date.now()).toISOString();
export const t = (iso: string) => Date.parse(iso);

export const TYPED_ALL = ["status", "date", "people", "dropdown", "email", "phone", "link", "long_text"];
export const TYPED_LIVE = ["status", "date", "people"];

export function makeWorld(spec: ObjectSpec, o: { hsId: string; itemId: string; created: string; synced: string;
    props: Record<string, string>; typed?: string[]; group?: string; labels?: Record<string, Record<string, string>> }): World {
  const props: Record<string, string | null> = { ...o.props, createdate: o.created, sync_owner: "crm", [spec.modifiedProp]: o.synced };
  const history: Record<string, Version[]> = {};
  for (const [p, v] of Object.entries(props))
    if (v && p !== spec.modifiedProp) history[p] = [{ value: v, timestamp: o.created, sourceType: "FORM" }];
  const ctx = { labels: { lifecycleStage: LIFECYCLE, leadStatus: LEAD_STATUS_BASE, ...(o.labels ?? {}) }, ownersById: {},
    mondayUsersByEmail: {} } as unknown as Ctx;
  const cv: MondayItem["column_values"] = [{ id: spec.idCol, text: o.hsId }, { id: spec.syncStateCol, text: o.synced }];
  const typed = new Set(o.typed ?? TYPED_ALL);
  const changedAt: Record<string, number> = {};
  for (const f of spec.fields) {
    if (cv.some(c => c.id === f.col)) continue;
    if (f.type === "people") { cv.push({ id: f.col, text: "", persons_and_teams: [] }); continue; }
    const text = expectedText(f, props[f.hs], ctx) ?? "";
    cv.push({ id: f.col, text, ...(f.type === "status" ? { status_index: text ? 1 : null } : {}) });
    if (text && typed.has(f.type)) changedAt[f.col] = Date.parse(o.synced);
  }
  return {
    spec, changedAt, typed,
    card: { id: o.itemId, name: itemName({ id: o.hsId, properties: props }, spec), created_at: o.created,
      updated_at: o.synced, group: { id: o.group ?? "group_mm7cj2yx" }, column_values: cv },
    hs: { id: o.hsId, properties: props, history }, mods: [], stamps: [], trail: [], gates: new Map(),
    historyFails: false, logFails: false, log: [], ctxOwners: {}, mondayUsers: {}, labelIndex: new Map(),
    links: {}, otherCards: {}, assoc: {},
  };
}
export function setWorld(x: World): World { w = x; return w; }

const typeOf = (col: string) => w.spec.fields.find(f => f.col === col)?.type ?? "text";
export const typedCol = (col: string) => w.typed.has(typeOf(col));
export const cell = (col: string) => colText(w.card, col);
export const syncState = () => cell(w.spec.syncStateCol);
export const people = (col: string) => (w.card.column_values.find(c => c.id === col)?.persons_and_teams ?? []).map(p => String(p.id));

function idx(label: string): number {
  if (!w.labelIndex.has(label)) w.labelIndex.set(label, w.labelIndex.size + 1);
  return w.labelIndex.get(label)!;
}

/** What monday's activity log (and a webhook) shows as a column's value. */
export function eventValue(col: string): unknown {
  if (w.links[col]) return { linkedPulseIds: w.links[col].ids.map(id => ({ linkedPulseId: Number(id) })) };
  const c = w.card.column_values.find(x => x.id === col);
  const text = colText(w.card, col);
  switch (typeOf(col)) {
    case "status": return text ? { label: { index: idx(text), text } } : {};
    case "people": return { personsAndTeams: (c?.persons_and_teams ?? []).map(p => ({ id: Number(p.id), kind: p.kind })) };
    case "dropdown": return text ? { chosenValues: text.split(", ").map(l => ({ id: idx(l), name: l })) } : {};
    case "date": return text ? { date: text } : {};
    case "email": return text ? { email: text, text } : {};
    case "phone": return text ? { phone: text } : {};
    case "link": return text ? { url: text, text } : {};
    case "long_text": return text ? { text } : {};
    default: return text ? { value: text } : {};
  }
}

/** What items { column_values { value } } returns for a column (monday's own spellings). */
function rawValue(col: string): string | null {
  const c = w.card.column_values.find(x => x.id === col);
  const text = colText(w.card, col);
  const at = w.changedAt[col] !== undefined && typedCol(col) ? { changed_at: new Date(w.changedAt[col]).toISOString() } : {};
  switch (typeOf(col)) {
    case "status": return text ? JSON.stringify({ index: idx(text), ...at }) : null;
    case "people": return JSON.stringify({ personsAndTeams: (c?.persons_and_teams ?? []).map(p => ({ id: Number(p.id), kind: p.kind })), ...at });
    case "dropdown": return text ? JSON.stringify({ ids: text.split(", ").map(idx), ...at }) : null;
    case "date": return text ? JSON.stringify({ date: text, ...at }) : null;
    case "email": return text ? JSON.stringify({ email: text, text, ...at }) : null;
    case "phone": return text ? JSON.stringify({ phone: text, ...at }) : null;
    case "link": return text ? JSON.stringify({ url: text, text, ...at }) : null;
    case "long_text": return text ? JSON.stringify({ text, ...at }) : null;
    default: return text ? JSON.stringify(text) : null;
  }
}

function touch(col: string, by: { userId: string; uuid: boolean }, prev: unknown): void {
  if (typedCol(col)) w.changedAt[col] = Date.now();
  w.card.updated_at = now();
  w.log.push({ col, at: Date.now(), userId: by.userId, uuid: by.uuid, value: eventValue(col), prev });
}

/** A person changes a cell in the monday UI, now (as REP, or as `who`; ask ada's UI edits carry a uuid too). */
export function rep(col: string, text: string, who: { userId?: string; uuid?: boolean } = {}): void {
  const c = w.card.column_values.find(x => x.id === col)!;
  const prev = eventValue(col);
  w.trail.push(`${now().slice(11, 23)} ${(who.userId ?? "REP").padEnd(10)} ${col}: ${JSON.stringify(c.text)} -> ${JSON.stringify(text)}`);
  c.text = text;
  if ("status_index" in c) c.status_index = text ? 1 : null;
  touch(col, { userId: who.userId ?? REP, uuid: who.uuid ?? true }, prev);
}
/** A person changes a People cell to these monday user ids. */
export function repPeople(col: string, ids: string[], who: { userId?: string } = {}): void {
  const c = w.card.column_values.find(x => x.id === col)!;
  const prev = eventValue(col);
  c.persons_and_teams = ids.map(id => ({ id, kind: "person" }));
  c.text = ids.join(",");
  touch(col, { userId: who.userId ?? REP, uuid: true }, prev);
}
/** A person changes a relation cell to these linked item ids; returns the cell's value before (the event's previousValue). */
export function repLinks(col: string, ids: string[]): unknown {
  const prev = eventValue(col);
  w.trail.push(`${now().slice(11, 23)} REP        ${col}: [${w.links[col]?.ids.join(",") ?? ""}] -> [${ids.join(",")}]`);
  w.links[col] = { ids: [...ids], changedAt: Date.now() };
  w.card.updated_at = now();
  return prev;
}
export function repRename(name: string): void {
  w.trail.push(`${now().slice(11, 23)} REP        name: ${JSON.stringify(w.card.name)} -> ${JSON.stringify(name)}`);
  w.card.name = name;
  w.card.updated_at = now();
}

export function hubspotSets(prop: string, value: string, at: string, source = "CRM_UI", sourceId?: string): void {
  w.hs.properties[prop] = value;
  (w.hs.history[prop] ??= []).push({ value, timestamp: at, sourceType: source, ...(sourceId ? { sourceId } : {}) });
  w.hs.properties[w.spec.modifiedProp] = at;
  w.trail.push(`HUBSPOT    ${prop} := ${JSON.stringify(value)} at ${at} (${source}${sourceId ? ` ${sourceId}` : ""})`);
}
export const note = (notesAt: string, modifiedAt: string) => hubspotSets("notes_last_updated", notesAt, modifiedAt, "CALCULATED");
export function hubspotBumps(at: string): void {
  w.hs.properties[w.spec.modifiedProp] = at;
  w.trail.push(`HUBSPOT    ${w.spec.modifiedProp} := ${at} (recalculation)`);
}

function textOf(v: unknown): string {
  if (typeof v === "string") return v;
  const o = v as Record<string, unknown> | null;
  if (o && typeof o === "object") {
    if ("label" in o) return String(o.label ?? "");
    if ("date" in o) return String(o.date ?? "");
    if ("text" in o) return String(o.text ?? "");
    if ("email" in o) return String(o.email ?? "");
    if ("phone" in o) return String(o.phone ?? "");
    if ("url" in o) return String(o.url ?? "");
    if ("labels" in o) return (o.labels as string[]).join(", ");
    if ("personsAndTeams" in o) return (o.personsAndTeams as { id: number }[]).map(p => String(p.id)).join(",");
    if ("item_ids" in o) return (o.item_ids as number[]).join(",");
  }
  return JSON.stringify(v);
}

/** A Worker write lands on the card: every changed cell is changed by OUR TOKEN (an API write, no uuid). */
function apply(env: unknown, cv: Record<string, unknown>, how: string): void {
  for (const [col, v] of Object.entries(cv)) {
    if (col === "name") continue;
    if (v && typeof v === "object" && "item_ids" in (v as object)) {
      const ids = ((v as { item_ids: number[] }).item_ids).map(String);
      w.trail.push(`${now().slice(11, 23)} ${PASS(env).padEnd(10)} ${how} ${col}: [${w.links[col]?.ids.join(",") ?? ""}] -> [${ids.join(",")}]`);
      w.links[col] = { ids, changedAt: Date.now() };
      w.card.updated_at = now();
      continue;
    }
    const text = textOf(v);
    let c = w.card.column_values.find(x => x.id === col);
    if (!c) { c = { id: col, text: "" }; w.card.column_values.push(c); }
    if (col === w.spec.syncStateCol) w.stamps.push(text);
    const prev = eventValue(col);
    let changed = c.text !== text;
    if (v && typeof v === "object" && "personsAndTeams" in (v as object)) {
      const ids = ((v as { personsAndTeams: { id: number; kind?: string }[] }).personsAndTeams).map(p => ({ id: String(p.id), kind: p.kind ?? "person" }));
      changed = JSON.stringify(ids) !== JSON.stringify(c.persons_and_teams ?? []);
      c.persons_and_teams = ids as never;
    }
    if (changed) {
      w.trail.push(`${now().slice(11, 23)} ${PASS(env).padEnd(10)} ${how} ${col}: ${JSON.stringify(c.text)} -> ${JSON.stringify(text)}`);
      c.text = text;
      if ("status_index" in c) c.status_index = text ? 1 : null;
      if (col !== w.spec.syncStateCol) touch(col, { userId: ASK_ADA, uuid: false }, prev);
      else w.card.updated_at = now();
    }
  }
}

// ------------------------------------------------------------------------------------------ holding a pass

export function hold(pass: string, op: Op): { reached: Promise<void>; release: () => void } {
  let reached!: () => void; let release!: () => void;
  const r = new Promise<void>(res => { reached = res; });
  const wait = new Promise<void>(res => { release = res; });
  w.gates.set(`${pass}:${op}`, { reached, wait });
  return { reached: r, release };
}
async function at(env: unknown, op: Op): Promise<void> {
  const k = `${PASS(env)}:${op}`;
  const g = w.gates.get(k);
  if (!g) return;
  w.gates.delete(k); g.reached(); await g.wait;
}
export async function reach(g: { reached: Promise<void> }, run: Promise<unknown>, what: string): Promise<void> {
  await Promise.race([g.reached, run.then(() => { throw new Error(`${what} was never reached`); })]);
}

// ------------------------------------------------------------------------------------------ the watch and the queue

/** Storage for one Durable Object, with blockConcurrencyWhile as a real critical section. Its alarm is recorded. */
function doCtx() {
  const map = new Map<string, unknown>();
  let alarm: number | null = null;
  let chain: Promise<unknown> = Promise.resolve();
  return {
    storage: {
      get: async (k: string) => clone(map.get(k)),
      put: async (k: string, v: unknown) => { map.set(k, clone(v)); },
      delete: async (k: string) => { map.delete(k); },
      deleteAll: async () => { map.clear(); },
      setAlarm: async (ts: number) => { alarm = ts; }, deleteAlarm: async () => { alarm = null; },
      getAlarm: async () => alarm,
    },
    blockConcurrencyWhile: <T>(fn: () => Promise<T>): Promise<T> => {
      const run = chain.then(fn);
      chain = run.catch(() => undefined);
      return run;
    },
    alarmAt: () => alarm,
    clearAlarm: () => { alarm = null; },
    map,
  };
}
export const doObjects = new Map<string, any>();
/** The env a Durable Object sees: always the current test's. */
const doEnv = new Proxy({}, { get: (_t, k) => (as("ALARM") as unknown as Record<string | symbol, unknown>)[k] }) as Env;
export const namespace = {
  idFromName: (n: string) => n,
  get: (id: string) => {
    let o = doObjects.get(id);
    if (!o) { o = new (CreateIdempotency as any)(doCtx(), doEnv); doObjects.set(id, o); }
    return o;
  },
};

/** What the watch and the webhook spilled, waiting to be run (drain). */
export const spilled: DeferredItem[] = [];
export let deferredUnbound = false;
export function setDeferredUnbound(v: boolean): void { deferredUnbound = v; }
const deferredNs = {
  idFromName: (n: string) => n,
  get: () => ({
    enqueue: async (items: DeferredItem[]) => {
      let queued = 0, duplicate = 0;
      for (const it of items) {
        if (spilled.some(s => deferKey(s) === deferKey(it))) { duplicate++; continue; }
        spilled.push(clone(it)); queued++;
      }
      return { queued, duplicate, dropped: 0, depth: spilled.length, droppedKeys: [] };
    },
  }),
};

export const as = (pass: string) => ({ ...ENV, CREATE_IDEMPOTENCY: namespace,
  ...(deferredUnbound ? {} : { DEFERRED_SYNC: deferredNs }), __pass: pass }) as unknown as Env;

export const watchKey = () => `held:${w.spec.boardId}:${w.card.id}`;
/** The card's watch as stored now (undefined: none). */
export async function watchState(): Promise<CardWatch | undefined> {
  const o = doObjects.get(watchKey());
  return o ? (o.ctx.map.get("held") as CardWatch | undefined) : undefined;
}
export function watchAlarmAt(): number | null {
  return doObjects.get(watchKey())?.ctx.alarmAt() ?? null;
}
/** Fire the card watch's alarm if it is due (or `force`). */
export async function fireWatch(force = false): Promise<boolean> {
  const o = doObjects.get(watchKey());
  if (!o) return false;
  const a = o.ctx.alarmAt();
  if (a === null || (!force && a > Date.now())) return false;
  o.ctx.clearAlarm();
  await o.alarm();
  return true;
}
/** Run what was spilled, in order, through the real passes. */
export async function drain(pass = "QUEUE"): Promise<number> {
  let n = 0;
  while (spilled.length) {
    const it = spilled.shift()!;
    n++;
    const env = as(pass);
    try {
      if (it.watch?.kind === "converge") await settleCardWatch(env, it.watch.boardId, it.id, live, { left: 30 });
      else if (it.watch?.kind === "retry") await retryMarkedEdits(env, it.watch.boardId, it.id, live, { left: 30 });
      else await syncHubspotObject(env, it.type, it.id, it.scope ? { ...live, scope: it.scope } : live, { left: 30 });
    } catch (e) { w.trail.push(`${pass} threw: ${String(e).slice(0, 120)}`); }
  }
  return n;
}
/** Let time pass to `iso`: fire the watch whenever due, and run what it spills, until nothing more happens. */
export async function advance(iso: string): Promise<void> {
  clock(iso);
  for (let i = 0; i < 20; i++) {
    const fired = await fireWatch();
    const ran = await drain();
    if (!fired && !ran) return;
  }
}

// ------------------------------------------------------------------------------------------ the passes

export type Named = Record<string, [string, boolean | null]>;
/** A PassScope: each property named by an event at `at`, our own or not (null: cannot tell). */
export function scopeOf(named: Named): PassScope {
  return { props: Object.fromEntries(Object.entries(named).map(([p, [iso, own]]) => [p, { at: Date.parse(iso), own }])) };
}
/** A HubSpot webhook's forward pass. `scope` absent = unscoped (a creation event, a sweep). */
export const hubspotPass = (pass: string, named?: Named, spec = w.spec) =>
  syncHubspotRecord(as(pass), spec, w.hs.id, named ? { ...live, scope: scopeOf(named) } : live, { left: 30 });
/** A person's edit pass, run directly (no webhook, so no mark). */
export const mondayEdit = (pass: string, cols: string[], o: { byAutomation?: boolean; name?: boolean; selfOrigin?: boolean; actor?: string } = {}) =>
  syncMondayItem(as(pass), w.spec.boardId, w.card.id, live, { left: 30 }, false, !!o.selfOrigin,
    { cols, ...(o.name ? { name: true } : {}), ...(o.byAutomation ? { byAutomation: true } : {}) },
    { id: o.byAutomation ? "-4" : o.actor ?? REP, byAutomation: !!o.byAutomation });

/** A monday webhook for the cell `col`, as it is on the card now (value) and was before (prev), by `userId`. */
export async function mondayWebhook(pass: string, col: string, prev: unknown, userId = REP,
    o: { changedAt?: number; type?: string } = {}): Promise<Promise<unknown>[]> {
  const env = as(pass);
  const waits: Promise<unknown>[] = [];
  const ectx = { waitUntil: (p: Promise<unknown>) => { waits.push(p); } } as unknown as ExecutionContext;
  const ev: Record<string, unknown> = { boardId: Number(w.spec.boardId), pulseId: Number(w.card.id),
    type: o.type ?? "update_column_value", ...(col ? { columnId: col } : {}), userId: Number(userId),
    changedAt: (o.changedAt ?? Date.now()) / 1000, value: col ? eventValue(col) : undefined, previousValue: prev };
  await handleMonday(new Request("https://w/webhooks/monday", { method: "POST", body: JSON.stringify({ event: ev }) }), env, ectx);
  return waits;
}
export async function settleAll(waits: Promise<unknown>[]): Promise<void> {
  while (waits.length) await Promise.allSettled(waits.splice(0));
}

export function expectSyncStateNeverBackwards(initial: string): void {
  const seq = [initial, ...w.stamps];
  for (let i = 1; i < seq.length; i++)
    expect(Date.parse(seq[i]), `Sync State moved backwards: ${seq.join(" -> ")}\n${w.trail.join("\n")}`)
      .toBeGreaterThanOrEqual(Date.parse(seq[i - 1]));
}

// ------------------------------------------------------------------------------------------ the fakes

export function mondayFns() {
  return {
    createItem: vi.fn(), createSubitem: vi.fn(), deleteItem: vi.fn(), findItemByColumn: vi.fn(), findItemIdsByColumn: vi.fn(),
    getBoardItems: vi.fn(), getItem: vi.fn(), getItemFresh: vi.fn(), getItemStates: vi.fn(), getItemsColumnText: vi.fn(),
    getLinkedCell: vi.fn(), getLinkedItemIds: vi.fn(), getParentItemId: vi.fn(), getSubitems: vi.fn(), getUserById: vi.fn(),
    getUsersByEmail: vi.fn(), gql: vi.fn(), moveItem: vi.fn(), setColumns: vi.fn(), updateColumns: vi.fn(), updateItem: vi.fn(),
    whoAmI: vi.fn(),
  };
}
export function hubspotFns() {
  return {
    claimOwnership: vi.fn(), createRecord: vi.fn(), getDealStageLabels: vi.fn(), getCrmStageDicts: vi.fn(),
    getOwners: vi.fn(), getPropertyOptions: vi.fn(), getRecord: vi.fn(), getRecordWithHistory: vi.fn(),
    getPropertyHistory: vi.fn(), patchRecord: vi.fn(), searchCompanyByDomain: vi.fn(), searchAll: vi.fn(),
    searchContactByEmail: vi.fn(), searchModifiedIds: vi.fn(), createNote: vi.fn(), getAssociatedIds: vi.fn(),
    getAssociatedPage: vi.fn(), getAllAssociatedIds: vi.fn(), getAssociatedVia: vi.fn(), putAssociation: vi.fn(),
    deleteAssociation: vi.fn(), getRecordsByIds: vi.fn(),
  };
}

type Fns = Record<string, ReturnType<typeof vi.fn>>;
export let leadStatus: Record<string, string> = { ...LEAD_STATUS_BASE };
export function setLeadStatus(d: Record<string, string>): void { leadStatus = d; }

/** Wire every fake to the world; call in beforeEach after vi.clearAllMocks. */
export function installWorld(monday: Fns, hubspot: Fns): void {
  doObjects.clear();
  spilled.length = 0;
  deferredUnbound = false;
  ENV = { ...BASE_ENV };
  leadStatus = { ...LEAD_STATUS_BASE };
  lines = [];
  resetCtxCache();
  resetUiActorCache();
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { lines.push(a.map(String).join(" ")); });
  monday.whoAmI.mockResolvedValue(ASK_ADA);
  monday.getUserById.mockResolvedValue({ name: "someone", email: "someone@example.com" });
  monday.getUsersByEmail.mockImplementation(async () => ({ ...w.mondayUsers }));
  monday.getItem.mockImplementation(async (env: unknown, id: string) => {
    await at(env, "card");
    return id === w.card.id ? clone(w.card) : null;
  });
  monday.getItemFresh.mockImplementation(async (env: unknown, id: string, cols: string[]) => {
    await at(env, "fresh");
    if (id !== w.card.id) return null;
    return { item: clone(w.card),
      stamps: Object.fromEntries(cols.map(c => [c, typedCol(c) ? (w.changedAt[c] ?? null) : null])),
      values: Object.fromEntries(cols.map(c => [c, rawValue(c)])) };
  });
  monday.findItemByColumn.mockImplementation(async (env: unknown, _b: string, col: string, v: string) => {
    await at(env, "card");
    return v && colText(w.card, col) === v ? [clone(w.card)] : [];
  });
  monday.getItemsColumnText.mockImplementation(async (env: unknown, ids: string[], col: string) => {
    await at(env, "text");
    return Object.fromEntries(ids.flatMap(i => i === w.card.id ? [[i, colText(w.card, col)]]
      : w.otherCards[i] ? [[i, w.otherCards[i][col] ?? ""]] : []));
  });
  monday.getLinkedCell.mockImplementation(async (_env: unknown, id: string, col: string) =>
    id === w.card.id ? { ids: [...(w.links[col]?.ids ?? [])], changedAt: w.links[col]?.changedAt ?? null } : { ids: [], changedAt: null });
  monday.getLinkedItemIds.mockImplementation(async (_env: unknown, id: string, col: string) =>
    id === w.card.id ? [...(w.links[col]?.ids ?? [])] : []);
  monday.findItemIdsByColumn.mockImplementation(async (_env: unknown, _b: string, col: string, values: string[]) =>
    Object.fromEntries(values.flatMap(v => {
      const card = Object.entries(w.otherCards).find(([, cols]) => cols[col] === v)?.[0];
      return card ? [[v, card]] : [];
    })));
  monday.getItemStates.mockImplementation(async (_env: unknown, ids: string[]) => Object.fromEntries(ids.map(i => [i, "active"])));
  hubspot.getAssociatedPage.mockImplementation(async (_e: unknown, _f: string, _id: string, to: string) =>
    ({ ids: [...(w.assoc[to] ?? [])], truncated: false }));
  hubspot.getAllAssociatedIds.mockImplementation(async (_e: unknown, _f: string, _id: string, to: string) =>
    ({ ids: [...(w.assoc[to] ?? [])], truncated: false }));
  hubspot.getAssociatedIds.mockImplementation(async (_e: unknown, _f: string, _id: string, to: string) => [...(w.assoc[to] ?? [])]);
  hubspot.putAssociation.mockImplementation(async (env: unknown, _f: string, _id: string, to: string, toId: string) => {
    w.assoc[to] = [...new Set([...(w.assoc[to] ?? []), toId])];
    w.trail.push(`${PASS(env).padEnd(10)} HubSpot ASSOCIATE ${to} ${toId}`);
  });
  hubspot.deleteAssociation.mockImplementation(async (env: unknown, _f: string, _id: string, to: string, toId: string) => {
    w.assoc[to] = (w.assoc[to] ?? []).filter(x => x !== toId);
    w.trail.push(`${PASS(env).padEnd(10)} HubSpot UNLINK ${to} ${toId}`);
  });
  hubspot.getRecordsByIds.mockResolvedValue([]);
  const write = (how: string) => async (env: unknown, _b: string, _i: string, ...rest: unknown[]) => {
    await at(env, "write");
    const [name, cv, o, waits] = how === "updateItem" ? rest as [string, Record<string, unknown>, RunOpts | undefined, number | undefined]
      : [undefined, rest[0] as Record<string, unknown>, rest[1] as RunOpts | undefined, rest[2] as number | undefined];
    // monday.ts's own rule: a dry run's write is logged, never sent.
    if (o?.dryRun) { w.trail.push(`${now().slice(11, 23)} ${PASS(env).padEnd(10)} ${how} DRY (not applied)`); return; }
    if (w.rateLimitWrite && PASS(env) === w.rateLimitWrite) {
      w.rateLimitWrite = undefined;
      const e = new Error(`monday 429: rate-limited after ${waits ?? 6} waits`); e.name = "MondayRateLimitedError";
      w.trail.push(`${PASS(env).padEnd(10)} ${how} REFUSED (rate limit)`);
      throw e;
    }
    if (name !== undefined && name !== w.card.name) {
      w.trail.push(`${now().slice(11, 23)} ${PASS(env).padEnd(10)} rename ${JSON.stringify(w.card.name)} -> ${JSON.stringify(name)}`);
      w.card.name = name; w.card.updated_at = now();
    }
    apply(env, cv, how);
  };
  monday.updateItem.mockImplementation(write("updateItem"));
  monday.updateColumns.mockImplementation(write("updateColumns"));
  monday.setColumns.mockImplementation(write("setColumns"));
  monday.moveItem.mockImplementation(async (env: unknown, _b: string, _i: string, g: string, o?: RunOpts) => {
    if (o?.dryRun) { w.trail.push(`${PASS(env).padEnd(10)} MOVE DRY (not applied)`); return; }
    w.trail.push(`${PASS(env).padEnd(10)} MOVE ${w.card.group.id} -> ${g}`);
    w.card.group.id = g;
  });
  monday.gql.mockImplementation(async (env: unknown, query: string, vars: Record<string, any>) => {
    if (query.includes("activity_logs")) {
      await at(env, "log");
      if (w.logFails) throw new Error("monday 500: activity log unavailable");
      const from = Date.parse(vars.f), to = Date.parse(vars.t);
      const cols = new Set<string>(vars.c ?? []);
      const rows = w.log.filter(r => cols.has(r.col) && r.at >= from && r.at <= to).sort((a, b) => b.at - a.at).slice(0, 50)
        .map(r => ({ event: "update_column_value", user_id: r.userId, created_at: String(Math.round(r.at * 1e4)),
          data: JSON.stringify({ pulse_id: Number(w.card.id), column_id: r.col, value: r.value, previous_value: r.prev,
            ...(r.uuid ? { action_record_uuid: "ui-uuid" } : {}) }) }));
      return { boards: [{ activity_logs: rows }] };
    }
    if (query.includes("group { id }")) return { items: [{ group: { id: w.card.group.id } }] };
    throw new Error(`unexpected gql: ${query.slice(0, 80)}`);
  });
  hubspot.getOwners.mockImplementation(async () => clone(w.ctxOwners));
  hubspot.getDealStageLabels.mockResolvedValue({});
  hubspot.getCrmStageDicts.mockResolvedValue({ pipelines: {}, stages: {}, pipelineByStage: {}, coarse: {} });
  hubspot.getPropertyOptions.mockImplementation(async (_e: unknown, o: string, p: string) =>
    o === "contacts" && p === "lifecyclestage" ? withOptionOrder({ ...LIFECYCLE }, LIFECYCLE_ORDER)
      : o === "contacts" && p === "hs_lead_status" ? { ...leadStatus } : {});
  hubspot.getRecord.mockImplementation(async (env: unknown, _o: string, id: string) => {
    await at(env, "hs");
    if (w.failGetRecord && PASS(env) === w.failGetRecord) throw new Error("hubspot GET: 503 unavailable");
    return id === w.hs.id ? clone({ id: w.hs.id, properties: w.hs.properties }) : null;
  });
  hubspot.getRecordWithHistory.mockImplementation(async (env: unknown, _o: string, id: string, _props: string[], withHistory: string[]) => {
    await at(env, "history");
    if (w.historyFails) throw new Error("hubspot GET: 503 unavailable");
    if (id !== w.hs.id) return null;
    w.trail.push(`${now().slice(11, 23)} ${PASS(env).padEnd(10)} reads HubSpot (history of ${withHistory.join(",") || "-"})`);
    return clone({ properties: w.hs.properties,
      history: Object.fromEntries(withHistory.map(p => [p, [...(w.hs.history[p] ?? [])].reverse()])) });
  });
  hubspot.getPropertyHistory.mockImplementation(async (_e: unknown, _o: string, _id: string, p: string) =>
    clone([...(w.hs.history[p] ?? [])].reverse()));
  hubspot.patchRecord.mockImplementation(async (env: unknown, _s: unknown, _id: string, patch: Record<string, string>) => {
    await at(env, "patch");
    const mod = w.mods.shift();
    if (!mod) throw new Error(`the test did not script the modified time of PATCH ${JSON.stringify(patch)}`);
    for (const [p, v] of Object.entries(patch)) {
      w.hs.properties[p] = v;
      (w.hs.history[p] ??= []).push({ value: v, timestamp: mod, sourceType: "INTEGRATION", sourceId: OWN });
    }
    w.hs.properties[w.spec.modifiedProp] = mod;
    w.onPatch?.(patch, mod);
    w.trail.push(`${now().slice(11, 23)} ${PASS(env).padEnd(10)} HubSpot PATCH ${JSON.stringify(patch)} -> ${mod}`);
    return mod;
  });
  hubspot.claimOwnership.mockImplementation(async () => { throw new Error("no claim expected"); });
  hubspot.createNote.mockResolvedValue("note-1");
}

/** SFW_DEBUG=1: print each test's trail and its gate log lines (call from afterEach). */
export function debugDump(name: string): void {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
  if (!env?.SFW_DEBUG || !w) return;
  console.error(`\n===== ${name}\n${w.trail.join("\n")}\n----- lines\n`
    + `${lines.filter(l => /\[(forward|reverse|watch|converge|sync-state)\]|action=(converged|rescued|edit-retr)/.test(l)).join("\n")}\n`);
}

export const pushes = (hubspot: Fns) => hubspot.patchRecord.mock.calls.map(c => c[3] as Record<string, string>);
export const historyReads = (hubspot: Fns) => hubspot.getRecordWithHistory.mock.calls.length;
/** Nothing left for the watch to do (at most the loop breaker's or a given-up mark's memory). */
export async function watchIdle(): Promise<boolean> {
  const s = await watchState();
  return !s || (!Object.keys(s.cells).length && !Object.keys(s.marks).length && s.allAt === undefined);
}
