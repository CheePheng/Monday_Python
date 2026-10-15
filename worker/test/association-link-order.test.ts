import { describe, it, expect, vi, beforeEach } from "vitest";
import { CRM_CONTACTS } from "../src/config/crm";
import type { Env, HsRecord, MondayItem, RunOpts } from "../src/types";

/**
 * THE RACE BETWEEN A PERSON'S CLICK AND THE FORWARD PASS (G3, 2026-09-28).
 *
 * A HubSpot event for the same record can run the forward pass between the moment a person links a card
 * and the moment the reverse pass pushes it. The forward pass rewrites the relation cell from HubSpot's
 * set, which does not have the new link yet, so the card leaves the cell again. The old reverse pass
 * READ THE CELL to decide what to push -- and found nothing: the person's link was silently lost.
 *
 * The chosen fix (see relation-edit.ts for why this one and not a pending-add window in the forward pass):
 *   - the add is taken from the webhook's own before/after, never from re-reading the cell;
 *   - relation edits are serialised per item + column + actor CLASS (every person shares one queue; our
 *     own token and automations each have their own), and each run drains every edit that
 *     arrived since the previous one, composed in order -- add-then-remove is nothing, not an add;
 *   - immediately before each PUT, the pass re-checks whether that person has since removed the card.
 * So a late add can never re-create a link the person removed, and our own token's writes (which run
 * under their own key) can never cancel a person's add.
 */

vi.mock("cloudflare:workers", () => ({
  DurableObject: class { ctx: any; env: any; constructor(ctx: any, env: any) { this.ctx = ctx; this.env = env; } },
}));

const hs = vi.hoisted(() => ({
  putAssociation: vi.fn(), putAssociationTypes: vi.fn(), deleteAssociation: vi.fn(),
  getAssociatedIds: vi.fn(), getAssociatedPage: vi.fn(), getAllAssociatedIds: vi.fn(), getAssociatedVia: vi.fn(),
  getRecord: vi.fn(), getRecordsByIds: vi.fn(async () => []), propertiesForSpec: vi.fn(() => []),
  patchLineItem: vi.fn(), createLineItem: vi.fn(), claimOwnership: vi.fn(),
}));
const monday = vi.hoisted(() => ({
  getLinkedItemIds: vi.fn(), getItemsColumnText: vi.fn(), findItemIdsByColumn: vi.fn(), getItemStates: vi.fn(),
  setColumns: vi.fn(), createItem: vi.fn(), createSubitem: vi.fn(), deleteItem: vi.fn(), getItem: vi.fn(),
  getParentItemId: vi.fn(), getSubitems: vi.fn(), updateItem: vi.fn(),
}));
const SELF = "104118038";                                  // the integration's own monday user
const captured = vi.hoisted(() => ({ runs: [] as any[], gate: null as null | Promise<void> }));
vi.mock("../src/hubspot", () => ({ ...hs, OwnershipError: class extends Error {} }));
vi.mock("../src/monday", () => monday);
vi.mock("../src/ensure-card", () => ({
  ensureCardForRecord: vi.fn(async () => ({ status: "refused" })), cardIdOf: vi.fn(() => null),
}));
vi.mock("../src/sync", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/sync")>()),
  syncMondayItem: vi.fn(async (_e: any, _b: any, itemId: string, _o: any, _bu: any, _a: any, selfOrigin: boolean, edit: any) => {
    captured.runs.push({ itemId, selfOrigin, edit, phase: "start" });
    if (captured.gate) await captured.gate;
    captured.runs.push({ itemId, phase: "end" });
    return "ok";
  }),
}));
vi.mock("../src/actor-label", () => ({
  actorLabel: async () => "user=test", isIntegrationActor: async (_e: unknown, u: string) => u === "104118038",
  isAutomationActor: (u: string) => /^-\d+$/.test(String(u)),
}));

const { handleMonday } = await import("../src/webhooks");
const { reverseAssociations } = await import("../src/associations");
const { recordRelationEvent, drainRelationEvents, relationEditKey, resetPairedEchoes } = await import("../src/relation-edit");

const env = { ENABLE_CRM: "true", CRM_CUTOVER_AT: "2026-09-25T00:00:00Z" } as unknown as Env;
const live: RunOpts = { dryRun: false, writeHubspot: true, maxWrites: 30 };
const COL = "contact_account";
const PERSON = "102444897";
const X = "7002";
const waits: Promise<unknown>[] = [];
const ectx = { waitUntil: (p: Promise<unknown>) => { waits.push(p); } } as unknown as ExecutionContext;
const L = (...ids: number[]) => ({ linkedPulseIds: ids.map(linkedPulseId => ({ linkedPulseId })) });
const fire = (userId: string, previousValue: unknown, value: unknown, extra: Record<string, unknown> = {}) =>
  handleMonday(new Request("https://w/webhooks/monday", { method: "POST", body: JSON.stringify({ event: {
    boardId: CRM_CONTACTS.boardId, pulseId: 5001, type: "update_column_value", columnId: COL,
    userId: Number(userId), ...(previousValue === undefined ? {} : { previousValue }), value, ...extra } }) }), env, ectx);
const tick = () => new Promise(r => setTimeout(r, 0));
const starts = () => captured.runs.filter(r => r.phase === "start");

beforeEach(() => {
  vi.clearAllMocks();
  captured.runs = []; captured.gate = null; waits.length = 0;
  for (const c of ["person", "integration", "automation"] as const) drainRelationEvents(relationEditKey("5001", COL, c));
  resetPairedEchoes();
  monday.getItemsColumnText.mockImplementation(async (_e: unknown, ids: string[]) =>
    Object.fromEntries(ids.map(id => [id, id === X ? "40000000002" : id === "7001" ? "31125660999" : ""])));
  monday.getItemStates.mockImplementation(async (_e: unknown, ids: string[]) =>
    Object.fromEntries(ids.map(id => [id, "active"])));
  monday.findItemIdsByColumn.mockResolvedValue({});
  monday.setColumns.mockResolvedValue(undefined);
  hs.getAllAssociatedIds.mockResolvedValue({ ids: [], truncated: false });
  hs.putAssociation.mockResolvedValue(undefined);
  hs.deleteAssociation.mockResolvedValue(true);
  hs.claimOwnership.mockResolvedValue("2026-09-28T09:00:00Z");
});

// ------------------------------------------------------------------------------ webhook ordering
describe("serialised per item + column + actor class, drained in order", () => {
  it("add X, then remove X mid-run -> the add runs first, the removal after it (never the reverse)", async () => {
    let release!: () => void;
    captured.gate = new Promise<void>(r => { release = r; });
    await fire(PERSON, L(7001), L(7001, 7002));                        // add X
    await tick();
    await fire(PERSON, L(7001, 7002), L(7001));                        // remove X while the add is in flight
    await tick();
    expect(starts()).toHaveLength(1);                                  // the removal WAITS behind the add
    captured.gate = null; release();
    await Promise.all(waits);
    expect(captured.runs.map(r => r.phase)).toEqual(["start", "end", "start", "end"]);
    expect(starts().map(r => [r.edit.linked[COL], r.edit.unlinked[COL]])).toEqual([[[X], []], [[], [X]]]);
  });

  it("add X and remove X both queued behind an earlier run -> composed to NOTHING, not to an add", async () => {
    let release!: () => void;
    captured.gate = new Promise<void>(r => { release = r; });
    await fire(PERSON, L(), L(7001));                                  // an earlier, unrelated add
    await tick();
    await fire(PERSON, L(7001), L(7001, 7002));                        // add X
    await fire(PERSON, L(7001, 7002), L(7001));                        // ...and take it straight back
    captured.gate = null; release();
    await Promise.all(waits);
    expect(starts()).toHaveLength(2);
    expect(starts()[1].edit.linked).toEqual({ [COL]: [] });
    expect(starts()[1].edit.unlinked).toEqual({ [COL]: [] });
  });

  it("our own token's forward write removing X does not cancel the person's add of X", async () => {
    let release!: () => void;
    captured.gate = new Promise<void>(r => { release = r; });
    await fire(PERSON, L(7001), L(7001, 7002));                        // the person adds X
    await tick();
    await fire(SELF, L(7001, 7002), L(7001));                          // a forward pass drops it again
    await tick();
    captured.gate = null; release();
    await Promise.all(waits);
    const person = starts().find(r => !r.selfOrigin)!;
    const self = starts().find(r => r.selfOrigin)!;
    expect(person.edit.linked).toEqual({ [COL]: [X] });
    expect(self.edit.unlinked).toEqual({ [COL]: [X] });                // pushed nowhere: selfOrigin
  });

  it("an event without previousValue carries no `linked` at all (-> refused and snapped back)", async () => {
    await fire(PERSON, undefined, L(7001, 7002));
    await Promise.all(waits);
    expect(starts()[0].edit.linked).toBeUndefined();
    expect(starts()[0].edit.unlinked).toEqual({ [COL]: [] });
  });

  /** One queue per cell for EVERY person: a late add by one rep must not overtake another rep's removal. */
  it("rep A adds X, rep B removes X mid-run -> B's removal queues behind A's add on the same cell", async () => {
    const OTHER = "102444898";
    let release!: () => void;
    captured.gate = new Promise<void>(r => { release = r; });
    await fire(PERSON, L(7001), L(7001, 7002));
    await tick();
    await fire(OTHER, L(7001, 7002), L(7001));
    await tick();
    expect(starts()).toHaveLength(1);                                  // B waits behind A
    captured.gate = null; release();
    await Promise.all(waits);
    expect(starts().map(r => [r.edit.linked[COL], r.edit.unlinked[COL]])).toEqual([[[X], []], [[], [X]]]);
  });

  it("six one-card clicks queued behind a run are six clicks, not one bulk edit (largestEvent = 1)", async () => {
    let release!: () => void;
    captured.gate = new Promise<void>(r => { release = r; });
    await fire(PERSON, L(), L(7001));
    await tick();
    const cards = [8101, 8102, 8103, 8104, 8105, 8106];
    for (let i = 0; i < cards.length; i++) await fire(PERSON, L(7001, ...cards.slice(0, i)), L(7001, ...cards.slice(0, i + 1)));
    captured.gate = null; release();
    await Promise.all(waits);
    const trailing = starts()[1].edit;
    expect(trailing.linked[COL]).toHaveLength(6);
    expect(trailing.largestEvent).toEqual({ [COL]: { added: 1, removed: 0 } });
  });

  it("one event adding six at once is one click of six (largestEvent = 6)", async () => {
    await fire(PERSON, L(), L(8101, 8102, 8103, 8104, 8105, 8106));
    await Promise.all(waits);
    expect(starts()[0].edit.largestEvent).toEqual({ [COL]: { added: 6, removed: 0 } });
  });
});

// ------------------------------------------------------------------------------ inside the pass
const item: MondayItem = { id: "5001", name: "Omar", created_at: "2026-01-22T06:46:54Z", updated_at: "",
  group: { id: "topics" }, column_values: [] as never };
const rec = (): HsRecord => ({ id: "394787683005", properties: { createdate: "2026-01-22T06:46:54Z" } });
const push = (actor = PERSON) => reverseAssociations(env, CRM_CONTACTS, rec(), item, live, { left: 30 },
  { onlyCols: new Set([COL]), basis: "human-edit", linked: { [COL]: [X] }, unlinked: { [COL]: [] }, actor });

describe("the add is taken from the diff and re-checked right before the PUT", () => {
  it("the forward pass already took X back out of the cell -> X is STILL pushed", async () => {
    monday.getLinkedItemIds.mockResolvedValue(["7001"]);               // X is gone from the cell
    await push();
    expect(hs.putAssociation).toHaveBeenCalledTimes(1);
    expect(hs.putAssociation.mock.calls[0][4]).toBe("40000000002");
  });

  it("the person removed X while the pass was reading HubSpot -> no PUT (a late add never re-creates it)", async () => {
    monday.getLinkedItemIds.mockResolvedValue(["7001"]);
    hs.getAllAssociatedIds.mockImplementation(async () => {
      recordRelationEvent(relationEditKey("5001", COL, "person"), { added: [], removed: [X] });
      return { ids: [], truncated: false };
    });
    await push();
    expect(hs.putAssociation).not.toHaveBeenCalled();
  });

  it("a removal recorded under OUR token's key is not the person's and does not block the PUT", async () => {
    monday.getLinkedItemIds.mockResolvedValue(["7001"]);
    hs.getAllAssociatedIds.mockImplementation(async () => {
      recordRelationEvent(relationEditKey("5001", COL, "integration"), { added: [], removed: [X] });
      return { ids: [], truncated: false };
    });
    await push();
    expect(hs.putAssociation).toHaveBeenCalledTimes(1);
  });

  /** The re-check keys on the PERSON class, not on a user id a caller might forget to pass. */
  it("a scope with no actor still re-checks: a removal on the person queue blocks the PUT", async () => {
    monday.getLinkedItemIds.mockResolvedValue(["7001"]);
    hs.getAllAssociatedIds.mockImplementation(async () => {
      recordRelationEvent(relationEditKey("5001", COL, "person"), { added: [], removed: [X] });
      return { ids: [], truncated: false };
    });
    await reverseAssociations(env, CRM_CONTACTS, rec(), item, live, { left: 30 },
      { onlyCols: new Set([COL]), basis: "human-edit", linked: { [COL]: [X] }, unlinked: { [COL]: [] } });
    expect(hs.putAssociation).not.toHaveBeenCalled();
  });
});

describe("the add cap judges one click, not the composed run", () => {
  const SIX = ["8101", "8102", "8103", "8104", "8105", "8106"];
  const pushSix = (largest?: number) => reverseAssociations(env, CRM_CONTACTS, rec(), item, live, { left: 30 },
    { onlyCols: new Set([COL]), basis: "human-edit", linked: { [COL]: SIX }, unlinked: { [COL]: [] },
      ...(largest ? { largestEvent: { [COL]: { added: largest, removed: 0 } } } : {}) });
  beforeEach(() => {
    monday.getItemsColumnText.mockImplementation(async (_e: unknown, ids: string[]) =>
      Object.fromEntries(ids.map(id => [id, `6000000${id}`])));
    monday.getLinkedItemIds.mockResolvedValue(SIX);
  });

  it("six one-card clicks composed into one run -> all six pushed", async () => {
    await pushSix(1);
    expect(hs.putAssociation).toHaveBeenCalledTimes(6);
  });

  it("the same six in ONE click -> refused, nothing pushed", async () => {
    await pushSix(6);
    expect(hs.putAssociation).not.toHaveBeenCalled();
  });
});
