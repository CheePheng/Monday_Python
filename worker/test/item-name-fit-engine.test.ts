import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { CRM_CONTACTS, CRM_DEALS } from "../src/config/crm";
import { MONDAY_ITEM_NAME_MAX, expectedText, fitItemName } from "../src/mapping";
import type { Ctx, Env, HsRecord, MondayItem, ObjectSpec, RunOpts } from "../src/types";

/**
 * ITEM_NAME_FIT THROUGH THE ENGINE: buildCtx carries the limit, the forward pass compares the fitted name,
 * and a person's rename of a card whose HubSpot name is past the limit never reaches HubSpot. Ported from
 * the parked wip/reliability-queue branch, re-gated from RECORD_SYNC_QUEUE onto ITEM_NAME_FIT.
 *
 * Driven through the real buildCtx / syncHubspotRecord / syncMondayItem -> reconcileRecord with monday and
 * HubSpot mocked, so every claim is the presence or absence of an actual API call. monday.ts is mocked
 * here, so updateItem receives the name as the engine builds it -- the FULL name; that monday.ts then sends
 * it fitted is proven against a monday-like stub in item-name-fit.test.ts.
 */

const monday = vi.hoisted(() => ({
  createItem: vi.fn(), deleteItem: vi.fn(), findItemByColumn: vi.fn(), getBoardItems: vi.fn(),
  getItem: vi.fn(), getUsersByEmail: vi.fn(), moveItem: vi.fn(), setColumns: vi.fn(),
  updateItem: vi.fn(), getItemsColumnText: vi.fn(), getLinkedItemIds: vi.fn(),
}));
const hubspot = vi.hoisted(() => ({
  claimOwnership: vi.fn(), createRecord: vi.fn(), getDealStageLabels: vi.fn(), getCrmStageDicts: vi.fn(),
  getOwners: vi.fn(), getPropertyHistory: vi.fn(), getPropertyOptions: vi.fn(), getRecord: vi.fn(),
  patchRecord: vi.fn(), searchCompanyByDomain: vi.fn(), propertiesForSpec: vi.fn(), searchAll: vi.fn(),
  searchContactByEmail: vi.fn(), searchModifiedIds: vi.fn(),
}));
const assoc = vi.hoisted(() => ({
  pushBirthAssociations: vi.fn(), reverseAssociations: vi.fn(), reverseLineItems: vi.fn(), syncAssociations: vi.fn(),
}));
const registry = vi.hoisted(() => ({
  lookupCard: vi.fn(), lookupCardOwner: vi.fn(), finishCard: vi.fn(), claimHubspotForItem: vi.fn(),
  finishHubspotForItem: vi.fn(), forgetHubspotForItem: vi.fn(), createWindowOf: vi.fn(), noteCreateWindowEdit: vi.fn(),
}));
const ensure = vi.hoisted(() => ({ ensureCardForRecord: vi.fn() }));

vi.mock("../src/monday", () => monday);
vi.mock("../src/hubspot", () => ({ ...hubspot, OwnershipError: class extends Error {} }));
vi.mock("../src/associations", () => assoc);
vi.mock("../src/card-registry", () => registry);
vi.mock("../src/ensure-card", () => ensure);

const { buildCtx, resetCtxCache, syncHubspotRecord, syncMondayItem } = await import("../src/sync");

const ON = { ENABLE_CRM: "true", ITEM_NAME_FIT: "true", CRM_CUTOVER_AT: "2026-09-25T00:00:00Z" } as unknown as Env;
const OFF = { ENABLE_CRM: "true", CRM_CUTOVER_AT: "2026-09-25T00:00:00Z" } as unknown as Env;
const live: RunOpts = { dryRun: false, writeHubspot: true, maxWrites: 30 };

const MOD = "2026-10-02T08:07:46Z";      // what the card was last synced to
const NEWER = "2026-10-05T01:14:21Z";    // a HubSpot change the card has not seen
const PUSHED = "2026-10-05T02:00:00Z";   // what a PATCH returns

let logs: string[];

beforeEach(() => {
  vi.clearAllMocks();
  resetCtxCache();   // the ctx is cached per isolate for 60 s; each test picks its own switch
  logs = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(" ")); });
  monday.getUsersByEmail.mockResolvedValue({});
  monday.setColumns.mockResolvedValue(undefined);
  monday.updateItem.mockResolvedValue(undefined);
  monday.findItemByColumn.mockResolvedValue([]);
  hubspot.getOwners.mockResolvedValue({});
  hubspot.getDealStageLabels.mockResolvedValue({});
  hubspot.getCrmStageDicts.mockResolvedValue({ pipelines: {}, stages: {}, pipelineByStage: {} });
  hubspot.getPropertyOptions.mockResolvedValue({});
  hubspot.propertiesForSpec.mockReturnValue([]);
  hubspot.patchRecord.mockResolvedValue(PUSHED);
  hubspot.claimOwnership.mockResolvedValue(PUSHED);
  assoc.syncAssociations.mockResolvedValue(undefined);
  assoc.reverseAssociations.mockResolvedValue(undefined);
  registry.lookupCard.mockResolvedValue(null);
});

afterEach(() => { vi.restoreAllMocks(); });

/** A card holding exactly what the engine would have written from `rec`, named `name`, stamped `stamp`. */
function cardFor(spec: ObjectSpec, rec: HsRecord, name: string, stamp: string): MondayItem {
  const ctx = { labels: {}, ownersById: {}, mondayUsersByEmail: {} } as unknown as Ctx;
  const cv: MondayItem["column_values"] = [{ id: spec.idCol, text: rec.id }, { id: spec.syncStateCol, text: stamp }];
  for (const f of spec.fields) {
    const t = expectedText(f, rec.properties[f.hs], ctx);
    if (t) cv.push({ id: f.col, text: t });
  }
  return { id: "CARD", name, created_at: "2026-09-29T10:17:30Z", updated_at: stamp, group: { id: "topics" }, column_values: cv };
}

// ------------------------------------------------------------------------------------------ buildCtx

describe("buildCtx carries the limit only while ITEM_NAME_FIT is on", () => {
  const BEFORE = ["labels", "ownersById", "mondayUsersByEmail", "mondayEmailByUserId", "ownerIdByEmail",
    "ownerIdByName", "pipelineByStage", "portalId"];

  it("on: itemNameMax is monday's limit", async () =>
    expect((await buildCtx(ON)).itemNameMax).toBe(MONDAY_ITEM_NAME_MAX));

  it("off: the Ctx it always returned -- the same keys, no itemNameMax", async () =>
    expect(Object.keys(await buildCtx(OFF))).toEqual(BEFORE));

  it("the WM Worker (no ENABLE_CRM) has none even with the var leaked onto it", async () =>
    expect("itemNameMax" in await buildCtx({ ITEM_NAME_FIT: "true" } as unknown as Env)).toBe(false));

  it("HS_RATE_LIMIT_RETRY alone does not arm it", async () =>
    expect("itemNameMax" in await buildCtx({ ...OFF, HS_RATE_LIMIT_RETRY: "true" } as unknown as Env)).toBe(false));
});

// --------------------------------------------------------------- the forward pass (HubSpot -> monday)

const FIRST = "F".repeat(148);
const LAST = "L".repeat(148);
const FULL = `${FIRST} ${LAST}`;
const contact = (): HsRecord => ({
  id: "563860620999",
  properties: { firstname: FIRST, lastname: LAST, createdate: "2026-09-29T10:17:21Z", lastmodifieddate: NEWER },
});

async function forward(env: Env, card: MondayItem) {
  hubspot.getRecord.mockResolvedValue(contact());
  monday.findItemByColumn.mockResolvedValue([card]);
  return syncHubspotRecord(env, CRM_CONTACTS, "563860620999", live, { left: 30 });
}

describe("a HubSpot change to a contact whose name is past the limit", () => {
  const S = CRM_CONTACTS.syncStateCol;

  it("switch on: a card already showing the fitted name is in line -- no rename, only the baseline", async () => {
    const out = await forward(ON, cardFor(CRM_CONTACTS, contact(), fitItemName(FULL), MOD));
    expect(monday.updateItem).not.toHaveBeenCalled();
    expect(monday.setColumns).toHaveBeenCalledWith(ON, CRM_CONTACTS.boardId, "CARD", { [S]: NEWER }, live);
    expect(out).toContain("skipped-in-sync");
  });

  it("switch on: a card behind it is renamed ONCE (monday.ts fits the name), then stays in line", async () => {
    await forward(ON, cardFor(CRM_CONTACTS, contact(), "Old Name", MOD));
    expect(monday.updateItem).toHaveBeenCalledTimes(1);
    expect(monday.updateItem).toHaveBeenCalledWith(ON, CRM_CONTACTS.boardId, "CARD", FULL, { [S]: NEWER }, live);

    // The next HubSpot-side pass over the record finds the fitted name: nothing to do.
    vi.clearAllMocks();
    const out = await forward(ON, cardFor(CRM_CONTACTS, contact(), fitItemName(FULL), NEWER));
    expect(monday.updateItem).not.toHaveBeenCalled();
    expect(monday.setColumns).not.toHaveBeenCalled();
    expect(out).toContain("skipped-in-sync");
  });

  it("switch on: the echo of that rename (our own token's name event) finds nothing to do -- no loop", async () => {
    monday.getItem.mockResolvedValue(cardFor(CRM_CONTACTS, contact(), fitItemName(FULL), NEWER));
    hubspot.getRecord.mockResolvedValue(contact());
    const out = await syncMondayItem(ON, CRM_CONTACTS.boardId, "CARD", live, { left: 30 }, false, true,
      { cols: [], name: true });
    expect(monday.updateItem).not.toHaveBeenCalled();
    expect(monday.setColumns).not.toHaveBeenCalled();
    expect(hubspot.patchRecord).not.toHaveBeenCalled();
    expect(out).toContain("skipped-in-sync");
  });

  it("switch off: today's behaviour exactly -- the full name differs from the card, so every pass renames", async () => {
    await forward(OFF, cardFor(CRM_CONTACTS, contact(), fitItemName(FULL), MOD));
    expect(monday.updateItem).toHaveBeenCalledWith(OFF, CRM_CONTACTS.boardId, "CARD", FULL, { [S]: NEWER }, live);
  });
});

// ---------------------------------------------------------------- a person's rename (monday -> HubSpot)

const LONG_DEAL = "DKM ERP rollout - " + "第二阶段".repeat(80);    // 338 units
const deal = (dealname: string): HsRecord => ({
  id: "D1", properties: { dealname, hs_lastmodifieddate: MOD, createdate: "2026-09-29T00:00:00Z", sync_owner: "crm" },
});

/** The spec as the deployment resolves it (CRM_CUTOVER_AT applied to its ownership), not the constant. */
const DEALS_SPEC = expect.objectContaining({ object: "deals", boardId: CRM_DEALS.boardId });

async function rename(env: Env, rec: HsRecord, cardName: string) {
  const card = { ...cardFor(CRM_DEALS, rec, cardName, MOD), id: "DCARD" };
  monday.getItem.mockResolvedValue(card);
  hubspot.getRecord.mockResolvedValue(rec);
  return syncMondayItem(env, CRM_DEALS.boardId, "DCARD", live, { left: 30 }, false, false, { cols: [], name: true });
}

describe("a person renames a Deals card whose HubSpot name is past the limit", () => {
  it("switch on: refused, nothing reaches HubSpot, and the card is healed to HubSpot's (fitted) name", async () => {
    await rename(ON, deal(LONG_DEAL), "Shorter name");
    expect(hubspot.patchRecord).not.toHaveBeenCalled();
    expect(hubspot.claimOwnership).not.toHaveBeenCalled();
    expect(monday.updateItem).toHaveBeenCalledWith(ON, CRM_DEALS.boardId, "DCARD", LONG_DEAL, {}, live);
    expect(logs.some(l => l.includes("hubspot_id=D1 monday_item=DCARD action=refused")
      && l.includes("HubSpot's name is longer than monday can show; rename it in HubSpot"))).toBe(true);
  });

  it("switch on: an event on a card that already shows the fitted name sends and writes nothing", async () => {
    const out = await rename(ON, deal(LONG_DEAL), fitItemName(LONG_DEAL));
    expect(hubspot.patchRecord).not.toHaveBeenCalled();
    expect(monday.updateItem).not.toHaveBeenCalled();
    expect(monday.setColumns).not.toHaveBeenCalled();
    expect(out).toContain("skipped-in-sync");
  });

  it("switch on: a name within the limit is renamed in HubSpot exactly as before", async () => {
    await rename(ON, deal("Short deal"), "Shorter name");
    expect(hubspot.patchRecord).toHaveBeenCalledWith(ON, DEALS_SPEC, "D1", { dealname: "Shorter name" }, live,
      expect.objectContaining({ allowed: true }));
  });

  it("switch off: today's behaviour exactly -- the rename is sent", async () => {
    await rename(OFF, deal(LONG_DEAL), "Shorter name");
    expect(hubspot.patchRecord).toHaveBeenCalledWith(OFF, DEALS_SPEC, "D1", { dealname: "Shorter name" }, live,
      expect.objectContaining({ allowed: true }));
    expect(monday.updateItem).not.toHaveBeenCalled();
    expect(monday.setColumns).toHaveBeenCalledWith(OFF, CRM_DEALS.boardId, "DCARD", { [CRM_DEALS.syncStateCol]: PUSHED }, live);
  });

  it("switch off: even the fitted copy is pushed over HubSpot's longer name -- the hazard the switch closes", async () => {
    await rename(OFF, deal(LONG_DEAL), fitItemName(LONG_DEAL));
    expect(hubspot.patchRecord).toHaveBeenCalledWith(OFF, DEALS_SPEC, "D1", { dealname: fitItemName(LONG_DEAL) }, live,
      expect.objectContaining({ allowed: true }));
  });
});

// ------------------------------------------------------------ the drawer save (record-level engine)

describe("a drawer save (appSave: the record-level engine) on such a card", () => {
  async function save(env: Env, cardName: string) {
    const rec = deal(LONG_DEAL);
    monday.getItem.mockResolvedValue({ ...cardFor(CRM_DEALS, rec, cardName, MOD), id: "DCARD" });
    hubspot.getRecord.mockResolvedValue(rec);
    return syncMondayItem(env, CRM_DEALS.boardId, "DCARD", live, { left: 30 }, true);
  }

  it("switch on: the renamed card's name is not written back; the card is brought back to HubSpot's fitted name", async () => {
    await save(ON, "Shorter name");
    expect(hubspot.patchRecord).not.toHaveBeenCalled();
    expect(monday.updateItem).toHaveBeenCalledWith(ON, CRM_DEALS.boardId, "DCARD", LONG_DEAL,
      expect.objectContaining({ [CRM_DEALS.syncStateCol]: MOD }), live);
    expect(logs.some(l => l.includes("field=dealname type=name action=refused"))).toBe(true);
  });

  it("switch off: today's behaviour -- the card's name goes to HubSpot", async () => {
    await save(OFF, "Shorter name");
    expect(hubspot.patchRecord).toHaveBeenCalledWith(OFF, DEALS_SPEC, "D1", { dealname: "Shorter name" }, live,
      expect.objectContaining({ allowed: true }));
  });
});
