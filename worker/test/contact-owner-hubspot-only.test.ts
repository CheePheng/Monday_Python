import { describe, it, expect, vi, beforeEach } from "vitest";
import { CRM_ACCOUNTS, CRM_CONTACTS, CRM_DEALS } from "../src/config/crm";
import { specByObject, specsFor } from "../src/config";
import { buildCreateProperties, columnEditPatch } from "../src/reconcile";
import { uiLookupColumns } from "../src/ui-actor";
import { expectedText, itemName } from "../src/mapping";
import { readCode } from "../scripts/read-source.mjs";
import type { Ctx, Env, FieldSpec, HsRecord, MondayItem, ObjectSpec, RunOpts } from "../src/types";

/**
 * CONTACT OWNER IS CHANGED IN HUBSPOT ONLY (2026-10-09 meeting; CONTACT_OWNER_HUBSPOT_ONLY).
 *
 * Assignment and reassignment happen in HubSpot; the monday CRM follows. So with the switch on, a person
 * changing Contact owner on the board is refused and the cell is put back to HubSpot's owner at once --
 * while a contact created from the monday form is still born with the owner it was given. The Accounts and
 * Deals owners, and the live Work-Management specs, do not change at all.
 */

const MYLA = { owner: "1739141284", monday: "102443183", email: "mylamestiola@dkmeco.com" };
const ALDRIN = { owner: "81301483", monday: "102444898", email: "aldrinbautista@dkmeco.com" };
const OWNER_COL = "multiple_person_mm6zap53";
const MOD = "2026-10-09T02:00:00Z";
const PRE = "2026-09-10T06:42:36Z";
const live: RunOpts = { dryRun: false, writeHubspot: true, maxWrites: 30 };

const monday = vi.hoisted(() => ({
  createItem: vi.fn(), deleteItem: vi.fn(), findItemByColumn: vi.fn(), getBoardItems: vi.fn(),
  getItem: vi.fn(), getUsersByEmail: vi.fn(), moveItem: vi.fn(), setColumns: vi.fn(),
  updateItem: vi.fn(), getItemsColumnText: vi.fn(), getLinkedItemIds: vi.fn(), gql: vi.fn(),
}));
const hubspot = vi.hoisted(() => ({
  claimOwnership: vi.fn(), createRecord: vi.fn(), getDealStageLabels: vi.fn(), getCrmStageDicts: vi.fn(),
  getOwners: vi.fn(), getPropertyOptions: vi.fn(), getRecord: vi.fn(), patchRecord: vi.fn(),
  searchCompanyByDomain: vi.fn(), propertiesForSpec: vi.fn(), searchAll: vi.fn(),
  searchContactByEmail: vi.fn(), searchModifiedIds: vi.fn(),
}));
vi.mock("../src/monday", () => monday);
vi.mock("../src/hubspot", () => ({ ...hubspot, OwnershipError: class extends Error {} }));
vi.mock("../src/associations", () => ({ reverseAssociations: vi.fn(async () => undefined), reverseLineItems: vi.fn(), syncAssociations: vi.fn() }));
vi.mock("../src/card-registry", () => ({
  lookupCard: vi.fn(async () => null), finishCard: vi.fn(), claimHubspotForItem: vi.fn(),
  finishHubspotForItem: vi.fn(), forgetHubspotForItem: vi.fn(),
}));
vi.mock("../src/ensure-card", () => ({ ensureCardForRecord: vi.fn() }));

const { syncMondayItem, resetCtxCache } = await import("../src/sync");

const crm = { ENABLE_CRM: "true", CRM_CUTOVER_AT: "2026-09-25T00:00:00Z" };
const on = { ...crm, CONTACT_OWNER_HUBSPOT_ONLY: "true" } as unknown as Env;
const off = crm as unknown as Env;

beforeEach(() => {
  vi.clearAllMocks();
  resetCtxCache();
  monday.getUsersByEmail.mockResolvedValue({ [MYLA.email]: MYLA.monday, [ALDRIN.email]: ALDRIN.monday });
  monday.setColumns.mockResolvedValue(undefined);
  monday.updateItem.mockResolvedValue(undefined);
  hubspot.getOwners.mockResolvedValue({
    [MYLA.owner]: { email: MYLA.email, name: "Myla Mestiola" }, [ALDRIN.owner]: { email: ALDRIN.email, name: "John Aldrin Bautista" },
  });
  hubspot.getDealStageLabels.mockResolvedValue({});
  hubspot.getCrmStageDicts.mockResolvedValue({ pipelines: {}, stages: {}, pipelineByStage: {} });
  hubspot.propertiesForSpec.mockReturnValue([]);
  hubspot.getPropertyOptions.mockResolvedValue({});
  hubspot.patchRecord.mockResolvedValue("2026-10-09T03:00:00Z");
  hubspot.claimOwnership.mockResolvedValue("2026-10-09T03:00:00Z");
});

const ownerField = (spec: ObjectSpec | undefined): FieldSpec => spec!.fields.find(f => f.hs === "hubspot_owner_id")!;

// ===================================================================================================
describe("the switch reshapes exactly one field of exactly one spec", () => {
  it("off: the CRM Contacts spec is the original object (callers compare by reference)", () => {
    expect(specByObject({ ENABLE_CRM: "true" }, "contacts")).toBe(CRM_CONTACTS);
    expect(ownerField(specByObject({ ENABLE_CRM: "true" }, "contacts"))).toMatchObject({ appReverse: true });
  });

  it("on: Contact owner is hubspotOnly + writeOnCreate, and no longer app-save two-way", () => {
    const f = ownerField(specByObject({ ENABLE_CRM: "true", CONTACT_OWNER_HUBSPOT_ONLY: "true" }, "contacts"));
    expect(f).toEqual({ hs: "hubspot_owner_id", col: OWNER_COL, type: "people", writeOnCreate: true, hubspotOnly: true });
  });

  it("on: every other Contacts field is the very same object", () => {
    const s = specByObject({ ENABLE_CRM: "true", CONTACT_OWNER_HUBSPOT_ONLY: "true" }, "contacts")!;
    s.fields.forEach((f, i) => { if (f.hs !== "hubspot_owner_id") expect(f).toBe(CRM_CONTACTS.fields[i]); });
    expect(s.fields).toHaveLength(CRM_CONTACTS.fields.length);
  });

  it("on: the Accounts and Deals owners are untouched", () => {
    const e = { ENABLE_CRM: "true", CONTACT_OWNER_HUBSPOT_ONLY: "true" };
    expect(specByObject(e, "companies")).toBe(CRM_ACCOUNTS);
    expect(specByObject(e, "deals")).toBe(CRM_DEALS);
  });

  it("the Work-Management deployment cannot be reached by it", () => {
    const wm = specsFor({ CONTACT_OWNER_HUBSPOT_ONLY: "true" });
    expect(wm).toEqual(specsFor({}));
    for (const s of wm) for (const f of s.fields) expect(f.hubspotOnly).toBeUndefined();
  });

  it.each(["TRUE", "1", "", " true"])("a --var of %j changes nothing", (v) => {
    expect(specByObject({ ENABLE_CRM: "true", CONTACT_OWNER_HUBSPOT_ONLY: v }, "contacts")).toBe(CRM_CONTACTS);
  });
});

// ===================================================================================================
describe("a person's monday edit of Contact owner", () => {
  const spec = specByObject({ ENABLE_CRM: "true", CONTACT_OWNER_HUBSPOT_ONLY: "true" }, "contacts")!;
  const rec: HsRecord = { id: "394787683005", properties: { firstname: "Omar", lastname: "Ruth",
    hubspot_owner_id: MYLA.owner, createdate: PRE, lastmodifieddate: MOD } };
  const ctx = { labels: {}, ownersById: {}, mondayUsersByEmail: {}, mondayEmailByUserId: { [ALDRIN.monday]: ALDRIN.email },
    ownerIdByEmail: { [ALDRIN.email]: ALDRIN.owner }, portalId: 1 } as unknown as Ctx;

  function card(people: string[]): MondayItem {
    const cv: MondayItem["column_values"] = [{ id: spec.idCol, text: rec.id }, { id: spec.syncStateCol, text: MOD }];
    for (const f of spec.fields) {
      if (f.type === "people") continue;
      const t = expectedText(f, rec.properties[f.hs], ctx);
      if (t !== null) cv.push({ id: f.col, text: t });
    }
    cv.push({ id: OWNER_COL, text: people.length ? "x" : "", persons_and_teams: people.map(id => ({ id, kind: "person" })) });
    return { id: "CARD", name: itemName(rec, spec), created_at: PRE, updated_at: MOD, group: { id: "topics" }, column_values: cv };
  }

  it("is refused and healed -- nothing for HubSpot, the cell goes back", () => {
    const r = columnEditPatch(rec, card([ALDRIN.monday]), spec, ctx, { cols: [OWNER_COL] });
    expect(r.patch).toEqual({});
    expect(r.heal.map(f => f.col)).toEqual([OWNER_COL]);
    expect(r.refusals.join()).toContain("changed in HubSpot only");
  });

  it("emptying the cell is refused the same way: HubSpot keeps its owner", () => {
    const r = columnEditPatch(rec, card([]), spec, ctx, { cols: [OWNER_COL] });
    expect(r.patch).toEqual({});
    expect(r.heal.map(f => f.col)).toEqual([OWNER_COL]);
  });

  it("an edit by someone logged in as our token user is looked up like a two-way column's, so it is caught too", () => {
    expect(uiLookupColumns(on, spec).has(OWNER_COL)).toBe(true);
  });

  it("a contact created from the monday form is still BORN with its owner", () => {
    const props = buildCreateProperties(card([ALDRIN.monday]), spec, ctx);
    expect(props.hubspot_owner_id).toBe(ALDRIN.owner);
  });

  /** The app's clear route resolves the CRM spec on this Worker: it must not be a way round the rule. */
  it("/app/clear-record-fields refuses a HubSpot-only field before it writes anything", () => {
    const route = readCode("index.ts").split('"/app/clear-record-fields"')[1]?.split('"/app/sync-deal"')[0] ?? "";
    const guard = route.indexOf("hubspotOnly");
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(route.indexOf("patchRecord("));
  });
});

// ===================================================================================================
describe("end to end: the edit is put back within the same pass", () => {
  const rec = (): HsRecord => ({ id: "394787683005", properties: { firstname: "Omar", lastname: "Ruth",
    hubspot_owner_id: MYLA.owner, createdate: PRE, lastmodifieddate: MOD } });
  const card = (r: HsRecord, people: string[]): MondayItem => ({
    id: "CARD", name: itemName(r, CRM_CONTACTS), created_at: PRE, updated_at: MOD, group: { id: "topics" },
    column_values: [{ id: CRM_CONTACTS.idCol, text: r.id }, { id: CRM_CONTACTS.syncStateCol, text: MOD },
      { id: OWNER_COL, text: "x", persons_and_teams: people.map(id => ({ id, kind: "person" })) }],
  });
  const edit = async (env: Env, people: string[]) => {
    const r = rec();
    monday.getItem.mockResolvedValue(card(r, people));
    hubspot.getRecord.mockResolvedValue(r);
    return syncMondayItem(env, CRM_CONTACTS.boardId, "CARD", live, { left: 30 }, false, false, { cols: [OWNER_COL] });
  };
  const ownerWrites = () => [...monday.setColumns.mock.calls.map(c => c[3]), ...monday.updateItem.mock.calls.map(c => c[4])]
    .filter((cv: any) => cv && OWNER_COL in cv).map((cv: any) => cv[OWNER_COL]);

  it("on: no HubSpot write, and the cell is written back to HubSpot's owner (Myla)", async () => {
    await edit(on, [ALDRIN.monday]);
    expect(hubspot.patchRecord).not.toHaveBeenCalled();
    expect(hubspot.claimOwnership).not.toHaveBeenCalled();
    expect(ownerWrites()).toEqual([{ personsAndTeams: [{ id: Number(MYLA.monday), kind: "person" }] }]);
  });

  it("off: today's behaviour -- the edit is sent to HubSpot", async () => {
    await edit(off, [ALDRIN.monday]);
    expect(hubspot.patchRecord.mock.calls[0][3]).toEqual({ hubspot_owner_id: ALDRIN.owner });
  });
});
