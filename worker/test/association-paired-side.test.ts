import { describe, it, expect, vi, beforeEach } from "vitest";
import { CRM_ACCOUNTS, CRM_CONTACTS, CRM_DEALS, CRM_LINE_ITEMS } from "../src/config/crm";
import type { Env, HsRecord, MondayEdit, MondayItem, ObjectSpec, RunOpts } from "../src/types";

/**
 * ONE CLICK ON A PAIRED CELL IS ONE DECISION (2026-09-28).
 *
 * board_relation columns are paired: linking Account A on Contact C's `contact_account` also links C in
 * A's `account_contact`. If monday reports that click on BOTH cards (the G4 deletion sequence already
 * relies on it reporting the paired side), each side used to be judged on its own record:
 *   - a click refused on a Contact CRM does not own was authorised AGAIN on the Company, which CRM may
 *     own -- the refusal bypassed, and the Company claimed with a person's basis for an edit its card
 *     never had;
 *   - an unlink allowed on one side and refused on the other: the refused side snapped its cell back,
 *     the pairing re-linked the allowed side's card, and depending on timing either the allowed unlink
 *     was silently dropped ("re-linked in the meantime") or HubSpot lost the link while both cells
 *     kept showing it.
 * Now the first report of a pair to arrive owns it, and the webhook drops the card from the paired
 * report's diff: the other side neither writes, nor claims, nor snaps back. These tests drive both
 * reports through the real webhook, then each captured edit through the real reverse pass.
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
const captured = vi.hoisted(() => ({ edits: [] as { board: string; itemId: string; edit: MondayEdit }[] }));
vi.mock("../src/hubspot", () => ({ ...hs, OwnershipError: class extends Error {} }));
vi.mock("../src/monday", () => monday);
vi.mock("../src/ensure-card", () => ({
  ensureCardForRecord: vi.fn(async () => ({ status: "refused" })), cardIdOf: vi.fn(() => null),
}));
vi.mock("../src/sync", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/sync")>()),
  syncMondayItem: vi.fn(async (_e: any, board: string, itemId: string, _o: any, _b: any, _a: any, _s: any, edit: any) => {
    captured.edits.push({ board, itemId, edit }); return "ok";
  }),
}));
vi.mock("../src/actor-label", () => ({
  actorLabel: async () => "user=test", isIntegrationActor: async (_e: unknown, u: string) => u === "104118038",
  isAutomationActor: (u: string) => /^-\d+$/.test(String(u)),
}));

const { reverseAssociations } = await import("../src/associations");
const { handleMonday } = await import("../src/webhooks");
const { resetPairedEchoes, drainRelationEvents, relationEditKey } = await import("../src/relation-edit");

const env = { ENABLE_CRM: "true", CRM_CUTOVER_AT: "2026-09-25T00:00:00Z" } as unknown as Env;
const live: RunOpts = { dryRun: false, writeHubspot: true, maxWrites: 30 };
const OLD = "2026-01-22T06:46:54Z";
const PERSON = 102444897, OTHER = 102444898;
const waits: Promise<unknown>[] = [];
const ectx = { waitUntil: (p: Promise<unknown>) => { waits.push(p); } } as unknown as ExecutionContext;
const L = (...ids: number[]) => ({ linkedPulseIds: ids.map(linkedPulseId => ({ linkedPulseId })) });

// The two cards of the Contacts <-> Accounts pair, and the HubSpot record behind each.
const C = "5001", A = "7002";
const CONTACT = "394787683005", COMPANY = "40000000002";
const HS_OF: Record<string, string> = { [C]: CONTACT, [A]: COMPANY, "6001": "58512345678", "8001": "9956357489" };
/** What each card's relation cell holds right now (monday's pairing keeps the two sides in step). */
let cell: Record<string, string[]> = {};
/** HubSpot's associations, as unordered pairs of record ids. */
let hsPairs: Set<string>;
const pairOf = (x: string, y: string) => [x, y].sort().join("|");
let owner: Record<string, string | undefined> = {};

beforeEach(() => {
  vi.clearAllMocks();
  captured.edits = []; waits.length = 0;
  resetPairedEchoes();
  for (const id of [C, A, "6001", "8001"]) for (const col of ["contact_account", "account_contact",
    "board_relation_mm76btmt", "board_relation_mm76w9y5"]) drainRelationEvents(relationEditKey(id, col, "person"));
  cell = {}; hsPairs = new Set(); owner = {};
  monday.getItemsColumnText.mockImplementation(async (_e: unknown, ids: string[]) =>
    Object.fromEntries(ids.map(id => [id, HS_OF[id] ?? ""])));
  monday.getItemStates.mockImplementation(async (_e: unknown, ids: string[]) =>
    Object.fromEntries(ids.map(id => [id, "active"])));
  monday.getLinkedItemIds.mockImplementation(async (_e: unknown, id: string) => cell[id] ?? []);
  monday.findItemIdsByColumn.mockResolvedValue({});
  monday.setColumns.mockImplementation(async (_e: unknown, _b: string, id: string, cv: any) => {
    cell[id] = (Object.values(cv)[0] as any).item_ids.map(String);
  });
  hs.getAllAssociatedIds.mockImplementation(async (_e: unknown, _f: string, id: string) =>
    ({ ids: [...hsPairs].filter(p => p.split("|").includes(id)).map(p => p.split("|").find(x => x !== id)!), truncated: false }));
  hs.putAssociation.mockImplementation(async (_e: unknown, _f: string, from: string, _t: string, to: string) => { hsPairs.add(pairOf(from, to)); });
  hs.deleteAssociation.mockImplementation(async (_e: unknown, _f: string, from: string, _t: string, to: string) => { hsPairs.delete(pairOf(from, to)); return true; });
  hs.claimOwnership.mockResolvedValue("2026-09-28T09:00:00Z");
});

const post = (spec: ObjectSpec, itemId: string, col: string, before: number[], after: number[], userId = PERSON) =>
  handleMonday(new Request("https://w/webhooks/monday", { method: "POST", body: JSON.stringify({ event: {
    boardId: spec.boardId, pulseId: Number(itemId), type: "update_column_value", columnId: col, userId,
    previousValue: L(...before), value: L(...after) } }) }), env, ectx);

const rec = (id: string): HsRecord => ({ id, properties: { createdate: OLD, ...(owner[id] ? { sync_owner: owner[id]! } : {}) } });
const itemOf = (id: string): MondayItem =>
  ({ id, name: "x", created_at: OLD, updated_at: "", group: { id: "topics" }, column_values: [] as never });
/** Run one captured edit through the real reverse pass, as syncMondayItem does. */
const run = (spec: ObjectSpec, itemId: string, e: MondayEdit) =>
  reverseAssociations(env, spec, rec(HS_OF[itemId]), itemOf(itemId), live, { left: 30 },
    { onlyCols: new Set(e.cols), basis: "human-edit", unlinked: e.unlinked, linked: e.linked,
      largestEvent: e.largestEvent, actor: e.actor });
const editOn = (itemId: string) => captured.edits.find(x => x.itemId === itemId)!.edit;

describe("an ADD reported on both cards", () => {
  it("the Contact is refused (wm) and reported first -> the Company side must not write or claim", async () => {
    owner[CONTACT] = "wm";
    cell = { [C]: [A], [A]: [C] };                                    // what the click left on screen
    await post(CRM_CONTACTS, C, "contact_account", [], [7002]);
    await post(CRM_ACCOUNTS, A, "account_contact", [], [5001]);
    await Promise.all(waits);
    expect(editOn(A).linked).toEqual({ account_contact: [] });        // the paired echo carries nothing
    await run(CRM_CONTACTS, C, editOn(C));
    await run(CRM_ACCOUNTS, A, editOn(A));
    expect(hs.putAssociation).not.toHaveBeenCalled();
    expect(hs.claimOwnership).not.toHaveBeenCalled();                 // the Company is never claimed
    expect(monday.setColumns.mock.calls.map(c => c[1])).toEqual([CRM_CONTACTS.boardId]);   // only the owner heals
    expect(hsPairs.size).toBe(0);
  });

  it("the Company side reported first owns it instead: one decision, never two", async () => {
    cell = { [C]: [A], [A]: [C] };
    await post(CRM_ACCOUNTS, A, "account_contact", [], [5001]);
    await post(CRM_CONTACTS, C, "contact_account", [], [7002]);
    await Promise.all(waits);
    expect(editOn(C).linked).toEqual({ contact_account: [] });
    await run(CRM_ACCOUNTS, A, editOn(A));
    await run(CRM_CONTACTS, C, editOn(C));
    expect(hs.putAssociation).toHaveBeenCalledTimes(1);
    expect(hs.putAssociation.mock.calls[0][1]).toBe("companies");
    expect(hs.claimOwnership).toHaveBeenCalledTimes(1);
  });
});

describe("an UNLINK allowed on one side and refused on the other, in both orders", () => {
  beforeEach(() => {
    owner[COMPANY] = "wm";                                            // the Account is not CRM's
    hsPairs.add(pairOf(CONTACT, COMPANY));
    cell = { [C]: [], [A]: [] };                                      // the click removed it on both cards
  });

  it("the allowed Contact side first -> HubSpot unlinked once, nothing snapped back, both cells agree", async () => {
    await post(CRM_CONTACTS, C, "contact_account", [7002], []);
    await post(CRM_ACCOUNTS, A, "account_contact", [5001], []);
    await Promise.all(waits);
    expect(editOn(A).unlinked).toEqual({ account_contact: [] });
    await run(CRM_CONTACTS, C, editOn(C));
    await run(CRM_ACCOUNTS, A, editOn(A));
    expect(hs.deleteAssociation).toHaveBeenCalledTimes(1);
    expect(monday.setColumns).not.toHaveBeenCalled();
    expect(hsPairs.size).toBe(0);
    expect(cell).toEqual({ [C]: [], [A]: [] });
  });

  it("the refused Account side first -> nothing unlinked, the owner puts it back, both agree with HubSpot", async () => {
    await post(CRM_ACCOUNTS, A, "account_contact", [5001], []);
    await post(CRM_CONTACTS, C, "contact_account", [7002], []);
    await Promise.all(waits);
    expect(editOn(C).unlinked).toEqual({ contact_account: [] });
    await run(CRM_ACCOUNTS, A, editOn(A));
    cell[C] = [A];                                                    // monday's pairing mirrors the snap-back
    await run(CRM_CONTACTS, C, editOn(C));
    expect(hs.deleteAssociation).not.toHaveBeenCalled();
    expect(monday.setColumns.mock.calls.map(c => [c[1], c[3]])).toEqual([
      [CRM_ACCOUNTS.boardId, { account_contact: { item_ids: [5001] } }]]);
    expect(hsPairs.has(pairOf(CONTACT, COMPANY))).toBe(true);
  });
});

describe("what is NOT a paired echo", () => {
  it("the echo is consumed: the next genuine click on the other card is carried", async () => {
    await post(CRM_CONTACTS, C, "contact_account", [], [7002]);
    await post(CRM_ACCOUNTS, A, "account_contact", [], [5001]);      // echo, dropped
    await post(CRM_ACCOUNTS, A, "account_contact", [5001], []);      // a genuine unlink on the Account
    await Promise.all(waits);
    const onA = captured.edits.filter(x => x.itemId === A).map(x => x.edit.unlinked?.account_contact);
    expect(onA.flat()).toContain(C);
  });

  it("another person's click on the paired card is their own decision", async () => {
    await post(CRM_CONTACTS, C, "contact_account", [], [7002]);
    await post(CRM_ACCOUNTS, A, "account_contact", [], [5001], OTHER);
    await Promise.all(waits);
    expect(editOn(A).linked).toEqual({ account_contact: [C] });
  });

  it("our own token's reports are never treated as a pair owner", async () => {
    await post(CRM_CONTACTS, C, "contact_account", [], [7002], 104118038);   // a forward write's echo
    await post(CRM_ACCOUNTS, A, "account_contact", [], [5001]);             // ...then a person
    await Promise.all(waits);
    expect(editOn(A).linked).toEqual({ account_contact: [C] });
  });
});

describe("the Deals <-> Line Items pair (an unlink changes the deal amount)", () => {
  it("a Line Item unlinked from its Deal is decided once, on the first report", async () => {
    hsPairs.add(pairOf("58512345678", "9956357489"));
    await post(CRM_DEALS, "6001", "board_relation_mm76btmt", [8001], []);
    await post(CRM_LINE_ITEMS, "8001", "board_relation_mm76w9y5", [6001], []);
    await Promise.all(waits);
    expect(editOn("8001").unlinked).toEqual({ board_relation_mm76w9y5: [] });
    await run(CRM_DEALS, "6001", editOn("6001"));
    await run(CRM_LINE_ITEMS, "8001", editOn("8001"));
    expect(hs.deleteAssociation).toHaveBeenCalledTimes(1);
    expect(hs.deleteAssociation.mock.calls[0][1]).toBe("deals");
  });
});
