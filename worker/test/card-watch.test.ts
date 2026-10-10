import { describe, it, expect } from "vitest";
import {
  ALARM_MARGIN_MS, CONVERGE_RECHECK_MS, HOLD_DEFAULT_S, LOG_RETRY_MS, MARK_LEASE_MS, MARK_TTL_MS, OWN_HS_SOURCE_ID,
  RETRY_BACKOFF_MS, STAMP_NOTE_WINDOW_MS, STUCK_MS, TIE_MS, WATCH_RETENTION_MS, applyVeto, cellFp, composeRel, diffProps,
  eventOwnness, eventTypeOfObject, fpOfField, fpOfName, freshScope, gatedCols, gatedProps, gaveUpMatches, holdWindowMs,
  isCoarseGated, isGatedCol, isMarkLive, isOwnVersion, judgeCell, mergeScopes, mergedVersions, nameFeedProps,
  needHistoryBefore, newestNamed, newestNonOwnAt, nextAlarmAt, reduceAlarm, reduceBeginConverge, reduceBeginRetry,
  reduceClearMarks, reduceFinishConverge, reduceMarkEdits, reduceSupersede, reduceWatchCells, retryDueAt, scopeMaxAgeMs,
  stampSuspicious, staleForwardGateOn, staleForwardRetryOn, updatedAtMs, watchRetryOn,
  type CardWatch, type CellFacts, type EditMark, type TaggedVersion, type WatchBase,
} from "../src/card-watch";
import { CRM_ACCOUNTS, CRM_CONTACTS, CRM_DEALS } from "../src/config/crm";
import { CONTACTS_MYLA } from "../src/config";
import type { Ctx, HsRecord, MondayItem } from "../src/types";
import type { Diff } from "../src/reconcile";

/**
 * STALE_FORWARD_GATE, THE PURE HALF (card-watch.ts): the switches, who wrote a version, which cells are gated, the
 * per-cell verdict (every T and U rule), the watch's veto, and the card watch's state machine -- each rule by itself,
 * with no engine around it. The engine tests (stale-forward-gate*.test.ts) prove them together.
 */

const T = (iso: string) => Date.parse(iso);
const W = 180_000;
const base: WatchBase = { boardId: "b", itemId: "i", object: "contacts" };
const field = (spec: typeof CRM_CONTACTS, hs: string) => spec.fields.find(f => f.hs === hs)!;
const LIFE = field(CRM_CONTACTS, "lifecyclestage");
const JOB = field(CRM_CONTACTS, "jobtitle");
const LAD = field(CRM_CONTACTS, "notes_last_updated");

describe("the switches", () => {
  it("STALE_FORWARD_GATE: only the literal \"true\", only with ENABLE_CRM \"true\", only on a column-level spec", () => {
    expect(staleForwardGateOn({ ENABLE_CRM: "true", STALE_FORWARD_GATE: "true" }, CRM_CONTACTS)).toBe(true);
    for (const v of [undefined, "", "false", "TRUE", "1", "yes", " true"])
      expect(staleForwardGateOn({ ENABLE_CRM: "true", STALE_FORWARD_GATE: v }, CRM_CONTACTS)).toBe(false);
    expect(staleForwardGateOn({ STALE_FORWARD_GATE: "true" }, CRM_CONTACTS), "not without ENABLE_CRM").toBe(false);
    expect(staleForwardGateOn({ ENABLE_CRM: "true", STALE_FORWARD_GATE: "true" }, CONTACTS_MYLA), "never on a WM spec").toBe(false);
  });

  it("STALE_FORWARD_RETRY needs the gate too, and its own literal \"true\"", () => {
    const on = { ENABLE_CRM: "true", STALE_FORWARD_GATE: "true", STALE_FORWARD_RETRY: "true" };
    expect(staleForwardRetryOn(on, CRM_CONTACTS)).toBe(true);
    expect(watchRetryOn(on)).toBe(true);
    expect(staleForwardRetryOn({ ...on, STALE_FORWARD_GATE: "false" }, CRM_CONTACTS)).toBe(false);
    expect(watchRetryOn({ ...on, STALE_FORWARD_GATE: "false" })).toBe(false);
    for (const v of [undefined, "false", "True", "1"]) expect(staleForwardRetryOn({ ...on, STALE_FORWARD_RETRY: v }, CRM_CONTACTS)).toBe(false);
  });

  it("W: STALE_FORWARD_HOLD_S seconds, clamped to 60..900; junk gives the default (180)", () => {
    expect(holdWindowMs({})).toBe(HOLD_DEFAULT_S * 1000);
    expect(holdWindowMs({ STALE_FORWARD_HOLD_S: "240" })).toBe(240_000);
    expect(holdWindowMs({ STALE_FORWARD_HOLD_S: "10" })).toBe(60_000);
    expect(holdWindowMs({ STALE_FORWARD_HOLD_S: "5000" })).toBe(900_000);
    for (const v of ["abc", "", "-5", "0", "1e3", "3m", "NaN"]) expect(holdWindowMs({ STALE_FORWARD_HOLD_S: v }), v).toBe(180_000);
  });
});

describe("our own versions, exactly", () => {
  it("the CRM app's sourceId is pinned (the runbook's 10-05 record, the phantom-status JSON)", () => {
    expect(OWN_HS_SOURCE_ID).toBe("52247773");
  });

  it("isOwnVersion: an INTEGRATION write carrying our sourceId, and nothing else", () => {
    expect(isOwnVersion({ value: "x", timestamp: "", sourceType: "INTEGRATION", sourceId: "52247773" })).toBe(true);
    expect(isOwnVersion({ value: "x", timestamp: "", sourceType: "INTEGRATION", sourceId: "99999" })).toBe(false);
    expect(isOwnVersion({ value: "x", timestamp: "", sourceType: "INTEGRATION" })).toBe(false);
    expect(isOwnVersion({ value: "x", timestamp: "", sourceType: "CRM_UI", sourceId: "52247773" })).toBe(false);
  });

  it("a webhook event's own-ness: no source -> unknown; not INTEGRATION -> false; ours -> true; another app -> unknown", () => {
    expect(eventOwnness(undefined, undefined)).toBe(null);
    expect(eventOwnness("", "52247773")).toBe(null);
    expect(eventOwnness("CRM_UI", "userId:1")).toBe(false);
    expect(eventOwnness("CALCULATED", undefined)).toBe(false);
    expect(eventOwnness("INTEGRATION", "52247773")).toBe(true);
    expect(eventOwnness("INTEGRATION", 52247773)).toBe(true);
    expect(eventOwnness("INTEGRATION", "99999")).toBe(null);
    expect(eventOwnness("INTEGRATION", undefined)).toBe(null);
  });
});

describe("which cells are gated", () => {
  const rec = (p: Record<string, string>): HsRecord => ({ id: "1", properties: p });
  const fieldDiff = (f: typeof LIFE, o: Partial<Diff> = {}): Diff => ({ kind: "field", f, hsText: "a", mdText: "b", ...o });

  it("a two-way field is gated on its property; a one-way, hubspotOnly, backfill or truncated view is not", () => {
    const env = {};
    expect(gatedProps(env, CRM_CONTACTS, fieldDiff(LIFE), rec({}))).toEqual(["lifecyclestage"]);
    expect(gatedProps(env, CRM_CONTACTS, fieldDiff(LAD), rec({}))).toBeUndefined();
    expect(gatedProps(env, CRM_CONTACTS, fieldDiff(LIFE, { backfill: true }), rec({}))).toBeUndefined();
    expect(gatedProps(env, CRM_CONTACTS, fieldDiff(LIFE, { viewTruncated: true }), rec({}))).toBeUndefined();
    const hubspotOnly = { ...field(CRM_CONTACTS, "hubspot_owner_id"), appReverse: undefined, hubspotOnly: true };
    expect(isGatedCol(env, { ...CRM_CONTACTS, fields: [hubspotOnly] }, hubspotOnly.col)).toBe(false);
    expect(gatedCols(env, CRM_CONTACTS)).toContain(LIFE.col);
    expect(gatedCols(env, CRM_CONTACTS)).not.toContain(LAD.col);
  });

  it("a field flagged one-way is never gated, whatever reverse flag it also carries; a group never is", () => {
    const both = { ...LIFE, oneWay: true };                                 // reverse AND one-way: one-way wins
    expect(gatedProps({}, CRM_CONTACTS, fieldDiff(both), rec({}))).toBeUndefined();
    expect(isGatedCol({}, { ...CRM_CONTACTS, fields: [both] }, both.col)).toBe(false);
    const group: Diff = { kind: "group", hsText: "g2", mdText: "g1" };
    const byProp = { ...CRM_CONTACTS, groupBy: { prop: "hs_lead_status", map: { OPEN: "g2" }, reverse: false } };
    expect(gatedProps({}, byProp, group, rec({}))).toBeUndefined();
    expect(diffProps(byProp, group, rec({})), "what puts a group difference in play: its groupBy property").toEqual(["hs_lead_status"]);
    expect(diffProps(CRM_CONTACTS, group, rec({})), "a single group has no property").toEqual([]);
  });

  it("the Deals coarse Stage is gated only while STAGE_COARSE_REVERSE is \"true\"", () => {
    const coarse = CRM_DEALS.fields.find(f => f.col === "deal_stage")!;
    expect(isCoarseGated({ STAGE_COARSE_REVERSE: "true" }, CRM_DEALS, coarse)).toBe(true);
    expect(isCoarseGated({}, CRM_DEALS, coarse)).toBe(false);
    expect(gatedProps({ STAGE_COARSE_REVERSE: "true" }, CRM_DEALS, fieldDiff(coarse), rec({}))).toEqual(["dealstage"]);
    expect(gatedProps({}, CRM_DEALS, fieldDiff(coarse), rec({}))).toBeUndefined();
  });

  it("the name: gated on a spec that pushes it, on what feeds it -- a named company's domain is not name news", () => {
    const name: Diff = { kind: "name", hsText: "a", mdText: "b" };
    expect(gatedProps({}, CRM_CONTACTS, name, rec({ firstname: "Pat" })), "Contacts never push a name").toBeUndefined();
    expect(gatedProps({}, CRM_ACCOUNTS, name, rec({ name: "Acme", domain: "acme.com" }))).toEqual(["name"]);
    expect(gatedProps({}, CRM_ACCOUNTS, name, rec({ name: "", domain: "acme.com" }))).toEqual(["name", "domain"]);
    expect(nameFeedProps(CRM_ACCOUNTS, rec({}))).toEqual([]);
    expect(diffProps(CRM_CONTACTS, name, rec({ firstname: "", lastname: "", email: "a@b.c" }))).toEqual(["email"]);
  });

  it("fingerprints: the cell as cellKey reads it, a HubSpot value as the cell would show it", () => {
    const ctx = { labels: { lifecycleStage: { lead: "1.NEW" } }, ownersById: { "7": { name: "J", email: "j@x.com" } },
      mondayUsersByEmail: { "j@x.com": "99" } } as unknown as Ctx;
    const card = { id: "1", name: " Acme ", created_at: "", updated_at: "", group: { id: "g" },
      column_values: [{ id: LIFE.col, text: "1.NEW", status_index: 1 }] } as MondayItem;
    expect(cellFp({ kind: "field", f: LIFE, hsText: "", mdText: "" }, card)).toBe("1.NEW");
    expect(cellFp({ kind: "name", hsText: "", mdText: "" }, card)).toBe("Acme");
    expect(fpOfField(LIFE, "lead", ctx)).toBe("1.NEW");
    expect(fpOfField(field(CRM_CONTACTS, "sales_user"), "7", ctx)).toBe("99");
    expect(fpOfName(CRM_ACCOUNTS, ctx, "domain", "www.newco.com")).toBe("newco");
    expect(fpOfName(CRM_ACCOUNTS, ctx, "name", " Acme ")).toBe("Acme");
  });
});

describe("the pass's events (scopes)", () => {
  it("merge: unscoped wins; otherwise the union, the newest event per property; a tie of sources is unknown", () => {
    expect(mergeScopes(undefined, undefined)).toBe("unscoped");
    expect(mergeScopes({ props: { a: { at: 1, own: false } } }, "unscoped")).toBe("unscoped");
    expect(mergeScopes("unscoped", { props: {} })).toBe("unscoped");
    expect(mergeScopes({ props: { a: { at: 1, own: false } } }, { props: { a: { at: 2, own: true }, b: { at: 1, own: false } } }))
      .toEqual({ props: { a: { at: 2, own: true }, b: { at: 1, own: false } } });
    expect(mergeScopes({ props: { a: { at: 2, own: false } } }, { props: { a: { at: 1, own: true } } }))
      .toEqual({ props: { a: { at: 2, own: false } } });
    expect(mergeScopes({ props: { a: { at: 2, own: false } } }, { props: { a: { at: 2, own: true } } }))
      .toEqual({ props: { a: { at: 2, own: null } } });
  });

  it("newestNamed: the newest event among a cell's properties", () => {
    const s = { props: { name: { at: 5, own: false }, domain: { at: 9, own: true } } };
    expect(newestNamed(s, ["name", "domain"])).toEqual({ at: 9, own: true });
    expect(newestNamed(s, ["jobtitle"])).toBeUndefined();
    expect(newestNamed(undefined, ["name"])).toBeUndefined();
    expect(newestNamed({ props: { name: { at: 9, own: false }, domain: { at: 9, own: true } } }, ["name", "domain"]),
      "two events at one instant from different sources: the source cannot be told").toEqual({ at: 9, own: null });
  });

  it("needHistoryBefore: always unscoped; scoped only for an uncertain source, or an untyped cell changed at or after", () => {
    expect(needHistoryBefore({ scoped: false, possiblyUntyped: false, u: 0 })).toBe(true);
    expect(needHistoryBefore({ scoped: true, possiblyUntyped: true, u: 9 })).toBe(false);
    expect(needHistoryBefore({ scoped: true, named: { at: 5, own: null }, possiblyUntyped: false, u: 0 })).toBe(true);
    expect(needHistoryBefore({ scoped: true, named: { at: 5, own: false }, possiblyUntyped: false, u: 9 })).toBe(false);
    expect(needHistoryBefore({ scoped: true, named: { at: 5, own: false }, possiblyUntyped: true, u: 4 })).toBe(false);
    expect(needHistoryBefore({ scoped: true, named: { at: 5, own: false }, possiblyUntyped: true, u: 5 })).toBe(true);
  });
});

// ===================================================================================================================
describe("judgeCell: every rule", () => {
  const LABEL: Record<string, string> = { lead: "1.NEW", "1029060900": "5.No intention", opportunity: "7.Intention", customer: "8.Customer" };
  const V = (value: string, iso: string, sourceType = "CRM_UI", sourceId?: string, prop = "p"): TaggedVersion =>
    ({ value, timestamp: iso, sourceType, prop, ...(sourceId ? { sourceId } : {}) });
  const x = (o: Partial<CellFacts>): CellFacts => ({ c: null, u: NaN, S: NaN, md: "", fp: "", fpOf: v => LABEL[v.value] ?? v.value,
    now: T("2026-10-09T09:00:10.000Z"), W, ...o });
  const now = T("2026-10-09T09:00:10.000Z");
  const recent = T("2026-10-09T09:00:00.000Z"), old = T("2026-10-09T08:00:00.000Z");

  describe("typed", () => {
    it("T1: no history, no event -> monday-later: held while c is recent (anchor c), a candidate after", () => {
      expect(judgeCell(x({ c: recent }))).toMatchObject({ v: "hold", typed: true, anchor: recent });
      expect(judgeCell(x({ c: old }))).toMatchObject({ v: "candidate", typed: true });
    });
    it("T2: our own event -> monday-later; an event after c -> forward; within the tie -> the history; before -> later", () => {
      expect(judgeCell(x({ c: recent, named: { at: recent + 5000, own: true } })).v).toBe("hold");
      expect(judgeCell(x({ c: recent, named: { at: recent + 1, own: false } })).v).toBe("forward");
      expect(judgeCell(x({ c: recent, named: { at: recent - TIE_MS + 1, own: false } })).v).toBe("need-history");
      expect(judgeCell(x({ c: recent, named: { at: recent - TIE_MS, own: false } })).v).toBe("hold");
      expect(judgeCell(x({ c: old, named: { at: old - TIE_MS - 1, own: false } })).v).toBe("candidate");
    });
    it("T2: an event whose source cannot be told forces the history (and, unreadable, falls back to monday-later)", () => {
      expect(judgeCell(x({ c: recent, named: { at: recent + 9000, own: null } })).v).toBe("need-history");
      expect(judgeCell(x({ c: recent, named: { at: recent + 9000, own: null }, historyFailed: true })).v).toBe("hold");
      expect(judgeCell(x({ c: recent, named: { at: recent - 1000, own: false }, historyFailed: true })).v).toBe("hold");
    });
    it("T3: our own newest -> monday-later; HubSpot's after c -> forward; before -> monday-later; none -> monday-later", () => {
      expect(judgeCell(x({ c: recent, versions: [V("lead", "2026-10-09T09:00:05.000Z", "INTEGRATION", OWN_HS_SOURCE_ID)] })).v).toBe("hold");
      expect(judgeCell(x({ c: recent, versions: [V("lead", "2026-10-09T09:00:05.000Z", "INTEGRATION", "777")] })).v).toBe("forward");
      expect(judgeCell(x({ c: recent, versions: [V("lead", "2026-10-09T08:59:00.000Z")] })).v).toBe("hold");
      expect(judgeCell(x({ c: recent, versions: [] })).v).toBe("hold");
    });
    it("T3 tie-break: within TIE_MS, the cell showing HubSpot's PREVIOUS value -> forward; a person's value -> held", () => {
      const vs = [V("customer", "2026-10-09T08:59:59.500Z", "AUTOMATION_PLATFORM"), V("opportunity", "2026-10-09T08:59:58.000Z")];
      expect(judgeCell(x({ c: recent, versions: vs, fp: "7.Intention" })).v).toBe("forward");
      expect(judgeCell(x({ c: recent, versions: vs, fp: "5.No intention" })).v).toBe("hold");
      const far = [V("customer", "2026-10-09T08:59:50.000Z"), V("opportunity", "2026-10-09T08:59:40.000Z")];
      expect(judgeCell(x({ c: recent, versions: far, fp: "7.Intention" })).v, "outside the tie: monday's is later").toBe("hold");
    });
  });

  describe("untyped", () => {
    it("U1: our own event -> monday-later; not ours and the card unchanged since -> forward; changed since -> history", () => {
      expect(judgeCell(x({ u: recent, named: { at: recent + 1, own: true } })).v).toBe("hold");
      expect(judgeCell(x({ u: recent, named: { at: recent + 1, own: false } })).v).toBe("forward");
      expect(judgeCell(x({ u: recent, named: { at: recent, own: false } })).v).toBe("need-history");
      expect(judgeCell(x({ u: recent, named: { at: recent - 1, own: false }, historyFailed: true })).v).toBe("hold");
      expect(judgeCell(x({ u: recent, named: { at: recent, own: null } })).v).toBe("need-history");
    });
    it("U2: our own newest -> later; a value HubSpot never held -> later; news since S, or named -> forward; else later", () => {
      const S = T("2026-10-09T08:30:00.000Z");
      const own = [V("Director", "2026-10-09T08:59:00.000Z", "INTEGRATION", OWN_HS_SOURCE_ID), V("Engineer", "2026-09-01T00:00:00.000Z")];
      expect(judgeCell(x({ u: recent, S, versions: own, md: "Engineer", fp: "Engineer" })).v).toBe("hold");
      const theirs = [V("Manager", "2026-10-09T08:59:00.000Z"), V("Engineer", "2026-09-01T00:00:00.000Z")];
      expect(judgeCell(x({ u: recent, S, versions: theirs, md: "Director", fp: "Director" })).v, "never held").toBe("hold");
      expect(judgeCell(x({ u: recent, S, versions: theirs, md: "Engineer", fp: "Engineer" })).v, "news since S").toBe("forward");
      expect(judgeCell(x({ u: recent, S: T("2026-10-09T09:00:00.000Z"), versions: theirs, md: "Engineer", fp: "Engineer" })).v,
        "not news").toBe("hold");
      expect(judgeCell(x({ u: recent, S: T("2026-10-09T09:00:00.000Z"), versions: theirs, md: "Engineer", fp: "Engineer",
        named: { at: T("2026-10-09T08:59:00.000Z"), own: false } })).v, "named").toBe("forward");
      expect(judgeCell(x({ u: recent, S, versions: theirs, md: "", fp: "" })).v, "an emptied cell is not 'never held'").toBe("forward");
      expect(judgeCell(x({ u: old, S: T("2026-10-09T09:00:00.000Z"), versions: theirs, md: "Engineer", fp: "Engineer" })).v)
        .toBe("candidate");
    });
    it("U3: no history -> monday-later, held while the card changed less than W ago (anchor u)", () => {
      expect(judgeCell(x({ u: recent }))).toMatchObject({ v: "hold", typed: false, anchor: recent });
      expect(judgeCell(x({ u: old }))).toMatchObject({ v: "candidate", typed: false });
      expect(judgeCell(x({ u: NaN }))).toMatchObject({ v: "candidate" });
    });
  });

  it("mergedVersions: newest first across a cell's properties; undefined when any was not read", () => {
    const h = { name: [{ value: "A", timestamp: "2026-10-09T09:00:00.000Z", sourceType: "CRM_UI" }],
      domain: [{ value: "a.com", timestamp: "2026-10-09T09:00:05.000Z", sourceType: "CRM_UI" }] };
    expect(mergedVersions(h, ["name", "domain"])!.map(v => v.prop)).toEqual(["domain", "name"]);
    expect(mergedVersions(h, ["name", "jobtitle"])).toBeUndefined();
    expect(newestNonOwnAt(mergedVersions(h, ["name", "domain"]))).toBe(T("2026-10-09T09:00:05.000Z"));
    expect(newestNonOwnAt([{ ...h.name[0], prop: "name", sourceType: "INTEGRATION", sourceId: OWN_HS_SOURCE_ID }])).toBeUndefined();
    void now;
  });

  it("updated_at without fractions of a second is read as the end of its second", () => {
    expect(updatedAtMs("2026-10-09T09:00:00Z")).toBe(T("2026-10-09T09:00:00.999Z"));
    expect(updatedAtMs("2026-10-09T09:00:00.250Z")).toBe(T("2026-10-09T09:00:00.250Z"));
    expect(updatedAtMs("")).toBeNaN();
  });
});

// ===================================================================================================================
describe("the watch's veto", () => {
  const reply = (o: Partial<{ since: number; expired: boolean; mark: { at: number }; stuck: boolean }> = {}) =>
    ({ since: 0, expired: false, stuck: false, ...o });
  const hold = (typed: boolean) => ({ v: "hold" as const, typed, anchor: 1, why: "h" });
  const cand = { v: "candidate" as const, typed: true, why: "c" };
  const fwd = { v: "forward" as const, why: "f" };

  it("V1: a typed hold stands (judged by its own c)", () => {
    expect(applyVeto(hold(true), reply({ expired: true }), { typed: true }).final).toBe("hold");
  });
  it("V2: an untyped hold ends once this value has been held for the window", () => {
    expect(applyVeto(hold(false), reply({ expired: false }), { typed: false }).final).toBe("hold");
    expect(applyVeto(hold(false), reply({ expired: true }), { typed: false }).final).toBe("candidate");
  });
  it("V3: a live mark holds a hold or a candidate; an untyped forward newer-marked; a typed forward never", () => {
    expect(applyVeto(hold(false), reply({ expired: true, mark: { at: 5 } }), { typed: false }).final).toBe("hold");
    expect(applyVeto(cand, reply({ mark: { at: 5 } }), { typed: true }).final).toBe("hold");
    expect(applyVeto(fwd, reply({ mark: { at: 10 } }), { typed: false, newestNonOwn: 5 }).final).toBe("hold");
    expect(applyVeto(fwd, reply({ mark: { at: 10 } }), { typed: false }).final, "time unknown").toBe("hold");
    expect(applyVeto(fwd, reply({ mark: { at: 3 } }), { typed: false, newestNonOwn: 5 }).final, "HubSpot's is later").toBe("forward");
    expect(applyVeto(fwd, reply({ mark: { at: 10 } }), { typed: true, newestNonOwn: 5 }).final).toBe("forward");
  });
  it("V4: a candidate without a mark stays a candidate; V5: stuck is left", () => {
    expect(applyVeto(cand, reply(), { typed: true }).final).toBe("candidate");
    expect(applyVeto(cand, reply({ stuck: true }), { typed: true }).final).toBe("left");
    expect(applyVeto(hold(false), reply({ stuck: true }), { typed: false }).final).toBe("left");
  });
  it("the watch unreachable: holds stand, candidates are left, forwards proceed", () => {
    expect(applyVeto(hold(false), null, { typed: false, unreachable: true }).final).toBe("hold");
    expect(applyVeto(cand, null, { typed: true, unreachable: true }).final).toBe("left");
    expect(applyVeto(fwd, null, { typed: false, unreachable: true }).final).toBe("forward");
  });
  it("a verdict that still wanted the history (a pass never hands one over unanswered) holds", () => {
    const need = { v: "need-history" as const, why: "n" };
    expect(applyVeto(need, reply({ expired: true }), { typed: false }).final).toBe("hold");
    expect(applyVeto(need, null, { typed: true, unreachable: true }).final).toBe("hold");
  });
});

// ===================================================================================================================
describe("the card watch: cells", () => {
  const now = T("2026-10-09T09:00:00.000Z");

  it("a typed hold is re-anchored at its changed_at on every request", () => {
    let r = reduceWatchCells(undefined, base, [{ key: "c", fp: "A", typed: true, anchor: now - 1000, kind: "hold" }], {}, now, W, false);
    expect(r.replies.c).toMatchObject({ since: now - 1000, expired: false });
    r = reduceWatchCells(r.watch, base, [{ key: "c", fp: "A", typed: true, anchor: now - W, kind: "hold" }], {}, now, W, false);
    expect(r.replies.c).toMatchObject({ since: now - W, expired: true });
  });

  it("an untyped hold keeps its since for the same value, restarts for a new one (min(now, u)), and expires", () => {
    let r = reduceWatchCells(undefined, base, [{ key: "c", fp: "A", typed: false, anchor: now - 10_000, kind: "hold" }], {}, now, W, false);
    expect(r.replies.c.since).toBe(now - 10_000);
    r = reduceWatchCells(r.watch, base, [{ key: "c", fp: "A", typed: false, anchor: now + 50_000, kind: "hold" }], {}, now + 60_000, W, false);
    expect(r.replies.c.since, "same value: kept").toBe(now - 10_000);
    r = reduceWatchCells(r.watch, base, [{ key: "c", fp: "B", typed: false, anchor: now + 70_000, kind: "hold" }], {}, now + 60_000, W, false);
    expect(r.replies.c.since, "a new value: min(now, u)").toBe(now + 60_000);
    r = reduceWatchCells(r.watch, base, [{ key: "c", fp: "B", typed: false, anchor: 0, kind: "hold" }], {}, now + 60_000 + W, W, false);
    expect(r.replies.c.expired).toBe(true);
  });

  it("a candidate is due at once; a probe registers nothing; resolved cells go; `all` arms a converge within W", () => {
    let r = reduceWatchCells(undefined, base, [{ key: "c", fp: "A", typed: true, anchor: 0, kind: "candidate" },
      { key: "p", fp: "x", typed: false, anchor: 0, kind: "probe" }], { all: true }, now, W, false);
    expect(r.watch!.cells.c.due).toBe(now);
    expect(r.watch!.cells.p).toBeUndefined();
    expect(r.watch!.allAt).toBe(now + W);
    r = reduceWatchCells(r.watch, base, [], { resolved: ["c"], all: true }, now + 1000, W, false);
    expect(r.watch!.cells.c).toBeUndefined();
    expect(r.watch!.allAt, "the earlier converge-all stands").toBe(now + W);
  });

  it("the reply carries a live mark (with its relation diff) and the loop breaker's word", () => {
    let w = reduceMarkEdits(undefined, base, [{ key: "rel:x", at: now, rx: now, rel: { added: ["2"], removed: [] } }], now)!;
    const r = reduceWatchCells(w, base, [{ key: "rel:x", fp: "", typed: true, anchor: 0, kind: "probe" }], {}, now + 1000, W, false);
    expect(r.replies["rel:x"].mark).toEqual({ at: now, rel: { added: ["2"], removed: [], known: true, largestAdd: 1, largestRemove: 0 } });
    w = { ...w, cells: { c: { fp: "A", since: 0, typed: true, windowMs: W, stuckUntil: now + 5000 } } };
    expect(reduceWatchCells(w, base, [{ key: "c", fp: "A", typed: true, anchor: 0, kind: "hold" }], {}, now, W, false).replies.c.stuck).toBe(true);
    expect(reduceWatchCells(w, base, [{ key: "c", fp: "B", typed: true, anchor: 0, kind: "hold" }], {}, now, W, false).replies.c.stuck,
      "a new value is not stuck").toBe(false);
  });

  it("the same value registered again keeps what the watch decided about it: due at once, or stuck", () => {
    let r = reduceWatchCells(undefined, base, [{ key: "c", fp: "A", typed: false, anchor: now, kind: "candidate" }], {}, now, W, false);
    r = reduceWatchCells(r.watch, base, [{ key: "c", fp: "A", typed: false, anchor: now, kind: "hold" }], {}, now + 1000, W, false);
    expect(r.watch!.cells.c.due, "still due at once").toBe(now);
    r = reduceWatchCells(r.watch, base, [{ key: "c", fp: "B", typed: false, anchor: now, kind: "hold" }], {}, now + 2000, W, false);
    expect(r.watch!.cells.c.due, "a new value starts over").toBeUndefined();
    const stuck: CardWatch = { ...base, cells: { c: { fp: "A", since: 0, typed: true, windowMs: W, stuckUntil: now + 5000 } }, marks: {} };
    const s = reduceWatchCells(stuck, base, [{ key: "c", fp: "A", typed: true, anchor: now, kind: "hold" }], {}, now, W, false);
    expect(s.watch!.cells.c.stuckUntil).toBe(now + 5000);
  });
});

describe("the card watch: marks", () => {
  const now = T("2026-10-09T09:00:00.000Z");

  it("composed: the latest event's time, the first and latest receipt, the latest actor and class", () => {
    let w = reduceMarkEdits(undefined, base, [{ key: "c", at: now, rx: now + 100, actor: "1" }], now)!;
    w = reduceMarkEdits(w, base, [{ key: "c", at: now + 5000, rx: now + 5100, actor: "-4", byAutomation: true }], now)!;
    expect(w.marks.c).toMatchObject({ at: now + 5000, firstRx: now + 100, lastRx: now + 5100, actor: "-4", byAutomation: true, attempts: 0 });
    w = reduceMarkEdits(w, base, [{ key: "c", at: now + 1000, rx: now + 6000 }], now)!;          // an older event, delivered late
    expect(w.marks.c.at, "the latest event's time stands").toBe(now + 5000);
    expect(w.marks.c.lastRx).toBe(now + 6000);
  });

  it("relation diffs compose in arrival order: add-then-remove cancels; an unreadable diff is 'unknown'", () => {
    let rel = composeRel(undefined, { added: ["1"], removed: [] });
    rel = composeRel(rel, { added: [], removed: ["1"] });
    expect(rel).toMatchObject({ added: [], removed: [], known: true });
    rel = composeRel(rel, { added: [], removed: ["2"] });
    rel = composeRel(rel, { added: ["2"], removed: [] });
    expect(rel).toMatchObject({ added: [], removed: [] });
    expect(composeRel(rel, null).known).toBe(false);
  });

  it("cleared by a run started at t0: marks with no event after t0, and holds since before it", () => {
    let w = reduceMarkEdits(undefined, base, [{ key: "a", at: now, rx: now }, { key: "b", at: now, rx: now + 5000 }], now)!;
    w = reduceWatchCells(w, base, [{ key: "a", fp: "x", typed: true, anchor: now, kind: "hold" },
      { key: "b", fp: "y", typed: true, anchor: now + 6000, kind: "hold" }], {}, now + 6000, W, false).watch!;
    w = reduceClearMarks(w, ["a", "b"], now + 1000, now + 7000)!;
    expect(Object.keys(w.marks)).toEqual(["b"]);                            // edit #2 arrived after the run started
    expect(Object.keys(w.cells)).toEqual(["b"]);
  });

  it("liveness: the lease with the retry off; until cleared (or the TTL) with it on", () => {
    const m: EditMark = { at: now, firstRx: now, lastRx: now, attempts: 0 };
    expect(isMarkLive(m, now + MARK_LEASE_MS - 1, false)).toBe(true);
    expect(isMarkLive(m, now + MARK_LEASE_MS, false)).toBe(false);
    expect(isMarkLive(m, now + MARK_TTL_MS - 1, true)).toBe(true);
    expect(isMarkLive(m, now + MARK_TTL_MS, true)).toBe(false);
  });

  it("the retry schedule: the lease, then the backoffs; a rescued mark at once", () => {
    const m: EditMark = { at: now, firstRx: now, lastRx: now, attempts: 0 };
    expect(retryDueAt(m)).toBe(now + MARK_LEASE_MS);
    expect(retryDueAt({ ...m, rescued: true })).toBe(now);
    expect(retryDueAt({ ...m, retryQueuedAt: now + 60_000, attempts: 1 })).toBe(now + 60_000 + RETRY_BACKOFF_MS[0]);
    expect(retryDueAt({ ...m, retryQueuedAt: now + 60_000, attempts: 3 })).toBe(now + 60_000 + RETRY_BACKOFF_MS[2]);
    expect(retryDueAt({ ...m, retryQueuedAt: now + 60_000, attempts: 9 })).toBe(now + 60_000 + RETRY_BACKOFF_MS[2]);
  });

  it("beginRetry: only marks past their lease (a rescued one at once), each counted; spent or old ones given up", () => {
    let w = reduceMarkEdits(undefined, base, [{ key: "old", at: now, rx: now }, { key: "new", at: now + 50_000, rx: now + 50_000 },
      { key: "res", at: now, rx: now + 50_000, rescued: true }], now)!;
    w = { ...w, cells: { old: { fp: "A", since: now, typed: true, windowMs: W } } };
    let r = reduceBeginRetry(w, now + 61_000, W, true);
    expect(Object.keys(r.live).sort()).toEqual(["old", "res"]);
    expect(r.live.old.attempts).toBe(1);
    expect(reduceBeginRetry(w, now + 61_000, W, false).live, "retry off: nothing").toEqual({});
    let cur = r.watch!;
    for (let i = 0; i < RETRY_BACKOFF_MS.length; i++) cur = reduceBeginRetry(cur, now + 62_000 + i, W, true).watch!;
    r = reduceBeginRetry(cur, now + 70_000, W, true);
    expect(r.abandoned).toContain("old");
    expect(r.watch!.cells.old.due).toBe(now + 70_000);
    expect(r.watch!.gaveUp!.old).toEqual({ fp: "A", at: now + 70_000 });
    expect(gaveUpMatches(r.watch!.gaveUp!.old, "A", now + 70_001)).toBe(true);
    expect(gaveUpMatches(r.watch!.gaveUp!.old, "B", now + 70_001)).toBe(false);
    expect(gaveUpMatches({ fp: "", at: now }, "anything", now + 1)).toBe(true);
    expect(gaveUpMatches(r.watch!.gaveUp!.old, "A", now + 70_000 + WATCH_RETENTION_MS)).toBe(false);
    const ttl = reduceBeginRetry(reduceMarkEdits(undefined, base, [{ key: "t", at: now, rx: now }], now), now + MARK_TTL_MS, W, true);
    expect(ttl.abandoned).toEqual(["t"]);
  });
});

describe("the card watch: its alarm", () => {
  const now = T("2026-10-09T09:00:00.000Z");
  const watch = (o: Partial<CardWatch> = {}): CardWatch => ({ ...base, cells: {}, marks: {}, ...o });

  it("a converge is due when a cell's hold ended, a candidate is due, or the converge-all time came", () => {
    expect(reduceAlarm(watch({ cells: { c: { fp: "", since: now - W, typed: true, windowMs: W } } }), now, W, false).converge).toBe(true);
    expect(reduceAlarm(watch({ cells: { c: { fp: "", since: now, typed: true, windowMs: W } } }), now, W, false).converge).toBe(false);
    expect(reduceAlarm(watch({ cells: { c: { fp: "", since: now, typed: true, windowMs: W, due: now } } }), now, W, false).converge).toBe(true);
    expect(reduceAlarm(watch({ allAt: now }), now, W, false).converge).toBe(true);
    expect(reduceAlarm(watch({ allAt: now + 1 }), now, W, false).converge).toBe(false);
  });

  it("...but not under a live mark, not stuck, and not again before CONVERGE_RECHECK_MS while one is queued", () => {
    const cells = { c: { fp: "", since: now - W, typed: true, windowMs: W } };
    expect(reduceAlarm(watch({ cells, marks: { c: { at: now, firstRx: now, lastRx: now, attempts: 0 } } }), now, W, false).converge).toBe(false);
    expect(reduceAlarm(watch({ cells: { c: { ...cells.c, stuckUntil: now + 1 } } }), now, W, false).converge).toBe(false);
    const q = reduceAlarm(watch({ cells, convergeQueuedAt: now - 1000 }), now, W, false);
    expect(q.converge).toBe(false);
    expect(reduceAlarm(watch({ cells, convergeQueuedAt: now - CONVERGE_RECHECK_MS }), now, W, false).converge).toBe(true);
    const r = reduceAlarm(watch({ cells }), now, W, false);
    expect(r.watch!.convergeQueuedAt).toBe(now);
  });

  it("marks, retry on: past the lease a retry is queued; on its backoff again; spent or past the TTL it is given up", () => {
    const m: EditMark = { at: now, firstRx: now, lastRx: now, attempts: 0 };
    let r = reduceAlarm(watch({ marks: { c: m } }), now + MARK_LEASE_MS, W, true);
    expect(r.retry).toBe(true);
    expect(r.watch!.marks.c.retryQueuedAt).toBe(now + MARK_LEASE_MS);
    r = reduceAlarm(r.watch, now + MARK_LEASE_MS + 1000, W, true);
    expect(r.retry, "not again before its backoff").toBe(false);
    r = reduceAlarm(r.watch, now + MARK_LEASE_MS + RETRY_BACKOFF_MS[0], W, true);
    expect(r.retry).toBe(true);
    const spent = reduceAlarm(watch({ marks: { c: { ...m, attempts: RETRY_BACKOFF_MS.length + 1 } } }), now + 1, W, true);
    expect(spent.abandoned).toEqual(["c"]);
    expect(spent.watch!.cells.c.due).toBe(now + 1);
    const old = reduceAlarm(watch({ marks: { c: m } }), now + MARK_TTL_MS, W, true);
    expect(old.abandoned).toEqual(["c"]);
  });

  it("a mark given up on a cell the loop breaker had left makes it due at once: the breaker does not outlast an edit", () => {
    const w = watch({ cells: { c: { fp: "A", since: now - W, typed: true, windowMs: W, stuckUntil: now + STUCK_MS } },
      marks: { c: { at: now - MARK_TTL_MS, firstRx: now - MARK_TTL_MS, lastRx: now - MARK_TTL_MS, attempts: 1 } } });
    const r = reduceAlarm(w, now, W, true);
    expect(r.abandoned).toEqual(["c"]);
    expect(r.watch!.cells.c.stuckUntil).toBeUndefined();
    expect(r.converge).toBe(true);
  });

  it("marks, retry off: the lease ends the mark, and the cell falls back on its own hold clock (the edit's time)", () => {
    const r = reduceAlarm(watch({ marks: { c: { at: now - 5000, firstRx: now, lastRx: now, attempts: 0 } } }), now + MARK_LEASE_MS, W, false);
    expect(r.expired).toEqual(["c"]);
    expect(r.watch!.marks.c).toBeUndefined();
    expect(r.watch!.cells.c).toEqual({ fp: "", since: now - 5000, typed: false, windowMs: W });
    expect(r.converge).toBe(false);
    expect(nextAlarmAt(r.watch, now + MARK_LEASE_MS, false)).toBe(now - 5000 + W);
  });

  it("the next alarm: the earliest due time, never sooner than the margin; nothing due -> none", () => {
    expect(nextAlarmAt(watch({ cells: { c: { fp: "", since: now, typed: true, windowMs: W } } }), now, false)).toBe(now + W);
    expect(nextAlarmAt(watch({ cells: { c: { fp: "", since: now - W, typed: true, windowMs: W } } }), now, false)).toBe(now + ALARM_MARGIN_MS);
    expect(nextAlarmAt(watch({ marks: { c: { at: now, firstRx: now, lastRx: now, attempts: 0 } } }), now, true)).toBe(now + MARK_LEASE_MS);
    expect(nextAlarmAt(watch({ marks: { c: { at: now, firstRx: now, lastRx: now, attempts: 0 } } }), now, false)).toBe(now + MARK_LEASE_MS);
    expect(nextAlarmAt(watch({ fwd: { c: { hs: "x", at: now } } }), now, false), "memory: its expiry").toBe(now + WATCH_RETENTION_MS);
    expect(nextAlarmAt(watch(), now, false)).toBe(null);
    expect(nextAlarmAt(undefined, now, false)).toBe(null);
    const queued = watch({ cells: { c: { fp: "", since: now - W, typed: true, windowMs: W } }, convergeQueuedAt: now - 1000 });
    expect(nextAlarmAt(queued, now, false), "a queued converge is re-checked, not re-spun").toBe(now - 1000 + CONVERGE_RECHECK_MS);
    const stuckOnly = watch({ cells: { c: { fp: "", since: now - W, typed: true, windowMs: W, stuckUntil: now + STUCK_MS } } });
    expect(nextAlarmAt(stuckOnly, now, false), "a stuck cell: when its day is over").toBe(now + STUCK_MS);
  });

  it("cleaned up: nothing left but expired memory is no watch; a stuck cell whose day is over is converged, never forgotten", () => {
    const r = reduceAlarm(watch({ fwd: { c: { hs: "x", at: now - WATCH_RETENTION_MS } } }), now, W, false);
    expect(r.watch).toBeUndefined();
    const stuck = reduceAlarm(watch({ cells: { c: { fp: "A", since: now - STUCK_MS, typed: true, windowMs: W, stuckUntil: now } } }), now, W, false);
    expect(stuck.watch!.cells.c, "still watched: a value that still differs is judged again").toMatchObject({ fp: "A", due: now });
    expect(stuck.watch!.cells.c.stuckUntil).toBeUndefined();
    expect(stuck.converge).toBe(true);
  });
});

describe("the card watch: a converge's outcome", () => {
  const now = T("2026-10-09T09:00:00.000Z");
  const w0 = (): CardWatch => ({ ...base, cells: {
    a: { fp: "A", since: now - W, typed: true, windowMs: W, due: now - W },
    b: { fp: "B", since: now - 10_000, typed: false, windowMs: W },
    c: { fp: "C", since: now - W, typed: true, windowMs: W },
    d: { fp: "D", since: now - W, typed: true, windowMs: W, due: now },
    e: { fp: "E", since: now - W, typed: true, windowMs: W, due: now },
  }, marks: {}, allAt: now - 1, convergeQueuedAt: now - 5000 });

  it("forwarded cells go; one whose write did not take is remembered as it now shows (the loop breaker); held keep their clock; stuck wait a day", () => {
    const w = reduceFinishConverge({ ...w0(), fwd: { b: { hs: "old", at: now - 1000, fp: "OLD" } } }, { resolved: ["e"],
      forwarded: [{ key: "a", fp: "A", hs: "x", post: "X!" }, { key: "b", fp: "B", hs: "y" }],
      held: [], stuck: ["c"], rescued: ["d"] }, now, W)!;
    expect(w.cells.a).toBeUndefined();
    expect(w.cells.e).toBeUndefined();
    expect(w.fwd!.a, "monday shows X! where HubSpot's x was written").toEqual({ hs: "x", at: now, fp: "X!" });
    expect(w.fwd!.b, "a write that took leaves no memory (and clears an older one)").toBeUndefined();
    const h = reduceFinishConverge(w0(), { resolved: [], forwarded: [],
      held: [{ key: "b", fp: "B", typed: false, anchor: now, kind: "hold" }], stuck: ["c"], rescued: ["d"] }, now, W)!;
    expect(h.fwd).toBeUndefined();
    expect(h.cells.b.since, "the same value keeps its since").toBe(now - 10_000);
    expect(w.cells.c.stuckUntil).toBe(now + STUCK_MS);
    expect(w.cells.d.due, "a rescued cell waits on its mark").toBeUndefined();
    expect(w.allAt).toBeUndefined();
    expect(w.convergeQueuedAt).toBeUndefined();
  });

  it("a held cell the watch did not have (a converge-all, a difference no pass had seen) is registered", () => {
    const w = reduceFinishConverge({ ...base, cells: {}, marks: {}, allAt: now - 1 },
      { resolved: [], forwarded: [], held: [{ key: "n", fp: "N", typed: true, anchor: now - 1000, kind: "hold" },
        { key: "u", fp: "U", typed: false, anchor: now + 9999, kind: "hold" }], stuck: [], rescued: [] }, now, W)!;
    expect(w.cells.n).toEqual({ fp: "N", since: now - 1000, typed: true, windowMs: W });
    expect(w.cells.u.since, "untyped: min(now, its anchor)").toBe(now);
  });

  it("an unreadable activity log puts the cell off a few minutes, and counts the converge", () => {
    const w = reduceFinishConverge(w0(), { resolved: [], forwarded: [], held: [], stuck: [], rescued: [], logUnreadable: ["d"] }, now, W)!;
    expect(w.cells.d.due).toBe(now + LOG_RETRY_MS);
    expect(w.convergeAttempts).toBe(1);
    const d = { ...w, cells: { d: w.cells.d } };
    expect(nextAlarmAt(d, now, false), "not before LOG_RETRY_MS, though its hold ended long ago").toBe(now + LOG_RETRY_MS);
    expect(reduceAlarm(d, now + 1000, W, false).converge).toBe(false);
    const again = reduceFinishConverge(w, { resolved: ["a", "b", "c", "e"], forwarded: [], held: [], stuck: [], rescued: [] }, now, W)!;
    expect(again.convergeAttempts).toBeUndefined();
  });

  it("done: the watch is dropped; begin takes a snapshot and marks it queued", () => {
    expect(reduceFinishConverge(w0(), { done: true, resolved: [], forwarded: [], held: [], stuck: [], rescued: [] }, now, W)).toBeUndefined();
    const b = reduceBeginConverge(w0(), now);
    expect(b.snapshot!.convergeQueuedAt).toBe(now - 5000);
    expect(b.watch!.convergeQueuedAt).toBe(now);
    expect(reduceBeginConverge(undefined, now)).toEqual({ watch: undefined });
  });
});

// ===================================================================================================================
describe("the review's fixes, rule by rule", () => {
  const now = T("2026-10-09T09:00:00.000Z");
  const watch = (o: Partial<CardWatch> = {}): CardWatch => ({ ...base, cells: {}, marks: {}, ...o });

  it("[F1] the link time: recorded with an adoption's / a create's converge-all (the latest wins), kept only beside other state", () => {
    let r = reduceWatchCells(undefined, base, [], { all: true, linkedAt: now - 5000 }, now, W, true);
    expect(r.watch!.linkedAt).toBe(now - 5000);
    r = reduceWatchCells(r.watch, base, [], { linkedAt: now - 9000 }, now, W, true);
    expect(r.watch!.linkedAt, "never moved back").toBe(now - 5000);
    expect(reduceWatchCells(undefined, base, [], { linkedAt: now }, now, W, true).watch, "alone it keeps no watch").toBeUndefined();
  });

  it("[F1] a mark made before the link is given up when it would be re-sent (beginRetry, the alarm) -- never retried", () => {
    const pre: EditMark = { at: now - 10_000, firstRx: now - 10_000, lastRx: now - 10_000, attempts: 0 };
    const post: EditMark = { at: now + 1_000, firstRx: now + 1_000, lastRx: now + 1_000, attempts: 0 };
    const w = watch({ linkedAt: now, marks: { pre, post } });
    const b = reduceBeginRetry(w, now + MARK_LEASE_MS + 2_000, W, true);
    expect(b.abandoned).toEqual(["pre"]);
    expect(Object.keys(b.live)).toEqual(["post"]);
    expect(b.watch!.cells.pre.due, "its cell converges instead").toBe(now + MARK_LEASE_MS + 2_000);
    const early = reduceAlarm(w, now + 1_000, W, true);
    expect(early.abandoned, "not before its lease: its run may still be alive").toEqual([]);
    const a = reduceAlarm(w, now - 10_000 + MARK_LEASE_MS, W, true);
    expect(a.abandoned).toEqual(["pre"]);
    expect(a.retry, "nothing re-sent").toBe(false);
  });

  it("[F2] a People mark composes what its events removed: a union; unknown once any event could not tell", () => {
    let w = reduceMarkEdits(undefined, base, [{ key: "p", at: now, rx: now, people: ["1"] }], now)!;
    w = reduceMarkEdits(w, base, [{ key: "p", at: now + 1, rx: now + 1, people: ["2", "1"] }], now)!;
    expect(w.marks.p.people).toEqual({ ids: ["1", "2"], known: true });
    w = reduceMarkEdits(w, base, [{ key: "p", at: now + 2, rx: now + 2, people: null }], now)!;
    expect(w.marks.p.people).toEqual({ ids: ["1", "2"], known: false });
    w = reduceMarkEdits(w, base, [{ key: "p", at: now + 3, rx: now + 3 }], now)!;
    expect(w.marks.p.people, "an event that says nothing about people keeps what is known").toEqual({ ids: ["1", "2"], known: false });
  });

  it("[F3] the loop breaker's word is only for the HubSpot value it wrote: a new HubSpot value is not stuck", () => {
    const w = watch({ cells: { c: { fp: "ENGINEER", since: now - W, typed: false, windowMs: W, stuckUntil: now + 5000 } },
      fwd: { c: { hs: "Engineer", at: now - 1000, fp: "ENGINEER" } } });
    const ask = (hs: string) => reduceWatchCells(w, base, [{ key: "c", fp: "ENGINEER", typed: false, anchor: now, kind: "hold", hs }],
      {}, now, W, false).replies.c.stuck;
    expect(ask("Engineer")).toBe(true);
    expect(ask("Head of IT"), "HubSpot changed since our write: judged again").toBe(false);
  });

  it("[F5] a converge's watched cell it neither settled nor re-held is put off, never re-converged at once", () => {
    const w = watch({ cells: { c: { fp: "A", since: now - W, typed: true, windowMs: W }, d: { fp: "D", since: now - W, typed: true, windowMs: W } } });
    const f = reduceFinishConverge(w, { resolved: ["d"], forwarded: [], held: [], stuck: [], rescued: [], considered: ["c", "d"] }, now, W)!;
    expect(f.cells.c.due).toBe(now + CONVERGE_RECHECK_MS);
    expect(reduceAlarm(f, now + 10_000, W, false).converge).toBe(false);
    expect(nextAlarmAt(f, now, false)).toBe(now + CONVERGE_RECHECK_MS);
  });

  it("[F6] an untyped forward: resolved unless a live mark newer than HubSpot's news vetoes it -- then held, still watched", () => {
    const marked = reduceMarkEdits(watch({ cells: { c: { fp: "old", since: now - 1, typed: false, windowMs: W } } }), base,
      [{ key: "c", at: now, rx: now }], now)!;
    const fwd = (newsAt?: number) => reduceWatchCells(marked, base, [{ key: "c", fp: "Engineer", typed: false, anchor: now, kind: "forward",
      ...(newsAt !== undefined ? { newsAt } : {}) }], {}, now + 1000, W, false);
    const older = fwd(now + 500);                                        // HubSpot changed after the edit: it wins
    expect(older.watch!.cells.c).toBeUndefined();
    expect(older.replies.c.mark).toBeUndefined();
    const newer = fwd(now - 500);                                        // the edit is newer: held, registered
    expect(newer.watch!.cells.c).toMatchObject({ fp: "Engineer", typed: false });
    expect(newer.replies.c.mark).toEqual({ at: now });
    expect(fwd().watch!.cells.c, "news time unknown: the mark holds it").toBeDefined();
    expect(reduceWatchCells(watch({ cells: { c: { fp: "x", since: 0, typed: false, windowMs: W } } }), base,
      [{ key: "c", fp: "y", typed: false, anchor: now, kind: "forward" }], {}, now, W, false).watch, "no mark: resolved").toBeUndefined();
    expect(applyVeto({ v: "forward", why: "f" }, { since: 0, expired: false, stuck: false, mark: { at: now } }, { typed: false, newestNonOwn: now + 1 }).final,
      "the pass's own rule agrees").toBe("forward");
  });

  it("[F6] a superseded retry: the marks go (not one an event reached after it began), the cells are due at once, never rescued", () => {
    const w = reduceMarkEdits(undefined, base, [{ key: "a", at: now, rx: now }, { key: "b", at: now, rx: now + 5000 }], now)!;
    const s = reduceSupersede(w, base, { a: "Buyer", b: "X" }, now + 1000, now + 6000, W)!;
    expect(s.marks.a).toBeUndefined();
    expect(s.cells.a).toEqual({ fp: "Buyer", since: now + 6000, typed: false, windowMs: W, due: now + 6000 });
    expect(gaveUpMatches(s.gaveUp!.a, "Buyer", now + 7000)).toBe(true);
    expect(s.marks.b, "a newer edit's mark stays: its own run settles the cell").toBeDefined();
    expect(s.cells.b).toBeUndefined();
  });

  it("[F8] a scope with an event older than the bound, or one that cannot be placed, is no scope (unscoped)", () => {
    const sc = (at: number) => ({ props: { jobtitle: { at, own: false as const } } });
    expect(freshScope(sc(now - 1000), now, 360_000)).toEqual(sc(now - 1000));
    expect(freshScope(sc(now - 360_001), now, 360_000)).toBeUndefined();
    expect(freshScope(sc(0), now, 360_000)).toBeUndefined();
    expect(freshScope(undefined, now, 360_000)).toBeUndefined();
    expect(freshScope({ props: {} }, now, 360_000), "an association change names nothing, and stays so").toEqual({ props: {} });
    expect(scopeMaxAgeMs({}), "2 x W").toBe(2 * HOLD_DEFAULT_S * 1000);
  });

  it("[F9] the register keeps every stamp longer than any write can take (six 65 s rate-limit waits, and retries)", () => {
    expect(STAMP_NOTE_WINDOW_MS).toBeGreaterThan(6 * 65_000 + 10_000);
  });

  it("[F11] the coarse Stage's 'seen while HubSpot was newer' is kept for the same value, dropped for a new one", () => {
    let r = reduceWatchCells(undefined, base, [{ key: "deal_stage", fp: "New", typed: true, anchor: now, kind: "hold", newer: true }], {}, now, W, false);
    expect(r.watch!.cells.deal_stage.newer).toBe(true);
    r = reduceWatchCells(r.watch, base, [{ key: "deal_stage", fp: "New", typed: true, anchor: now, kind: "hold" }], {}, now + 1, W, false);
    expect(r.watch!.cells.deal_stage.newer, "the same value: kept").toBe(true);
    r = reduceWatchCells(r.watch, base, [{ key: "deal_stage", fp: "Won", typed: true, anchor: now + 2, kind: "hold" }], {}, now + 2, W, false);
    expect(r.watch!.cells.deal_stage.newer, "a new value: judged afresh").toBeUndefined();
    const f = reduceFinishConverge(watch({ cells: { s: { fp: "New", since: now, typed: true, windowMs: W, newer: true } } }),
      { resolved: [], forwarded: [], held: [{ key: "s", fp: "New", typed: true, anchor: now, kind: "hold" }], stuck: [], rescued: [] }, now, W)!;
    expect(f.cells.s.newer, "re-held by a converge: kept").toBe(true);
  });
});

describe("the Sync State register", () => {
  const n = (t: number, s: number, e: number) => ({ t, ts: String(t), s, e, at: 0 });
  it("suspicious: an older stamp after a newer one; an older one whose write overlapped this one's; never otherwise", () => {
    expect(stampSuspicious([n(10, 0, 1)], { t: 5, s: 2 }), "older after newer").toBe(true);
    expect(stampSuspicious([n(5, 0, 3)], { t: 10, s: 2 }), "the older write was still in flight").toBe(true);
    expect(stampSuspicious([n(5, 0, 1)], { t: 10, s: 2 }), "in order, no overlap").toBe(false);
    expect(stampSuspicious([n(10, 0, 1)], { t: 10, s: 2 }), "the same stamp").toBe(false);
    expect(stampSuspicious([], { t: 10, s: 2 })).toBe(false);
  });
});

it("the deferred type of each object", () => {
  expect(["contacts", "companies", "deals", "line_items", "x"].map(eventTypeOfObject))
    .toEqual(["contact", "company", "deal", "line_item", undefined]);
});
