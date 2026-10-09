import { describe, it, expect, vi, beforeEach } from "vitest";
import { CRM_CONTACTS } from "../src/config/crm";
import type { Env, MondayItem, RunOpts } from "../src/types";

/**
 * A CONTACT CREATED FROM THE MONDAY FORM tells its owner too (OWNER_NOTICE): the old #01 email fired on every
 * new item with an owner, and a rep adding a contact for a colleague is exactly the case it was for.
 *
 * Driven through the real syncMondayItem -> createFromMonday. The notice is asked for only once the HubSpot
 * record exists -- with its id, so the owner is read back from HubSpot and the owner-change webhook for the
 * same birth finds it already told -- and never for a create that did not happen.
 */

const hs = vi.hoisted(() => ({
  putAssociation: vi.fn(), putAssociationTypes: vi.fn(), deleteAssociation: vi.fn(),
  getAssociatedIds: vi.fn(), getAssociatedPage: vi.fn(), getAllAssociatedIds: vi.fn(async () => ({ ids: [], truncated: false })),
  getAssociatedVia: vi.fn(), getRecord: vi.fn(), getRecordsByIds: vi.fn(async () => []), propertiesForSpec: vi.fn(() => []),
  patchLineItem: vi.fn(), createLineItem: vi.fn(), claimOwnership: vi.fn(),
  createRecord: vi.fn(), getCrmStageDicts: vi.fn(), getDealStageLabels: vi.fn(), getOwners: vi.fn(),
  getPropertyOptions: vi.fn(), patchRecord: vi.fn(), searchCompanyByDomain: vi.fn(), searchAll: vi.fn(),
  searchContactByEmail: vi.fn(), searchModifiedIds: vi.fn(),
}));
const monday = vi.hoisted(() => ({
  getLinkedItemIds: vi.fn(async () => []), getItemsColumnText: vi.fn(async () => ({})), findItemIdsByColumn: vi.fn(),
  getItemStates: vi.fn(async () => ({})), setColumns: vi.fn(), createItem: vi.fn(), createSubitem: vi.fn(),
  deleteItem: vi.fn(), getItem: vi.fn(), getParentItemId: vi.fn(), getSubitems: vi.fn(), updateItem: vi.fn(),
  findItemByColumn: vi.fn(), getBoardItems: vi.fn(), getUsersByEmail: vi.fn(), moveItem: vi.fn(),
}));
const registry = vi.hoisted(() => ({
  lookupCard: vi.fn(async () => null), finishCard: vi.fn(), claimHubspotForItem: vi.fn(),
  finishHubspotForItem: vi.fn(), forgetHubspotForItem: vi.fn(), lookupCardOwner: vi.fn(async () => null),
}));
vi.mock("../src/hubspot", () => ({ ...hs, OwnershipError: class extends Error {} }));
vi.mock("../src/monday", () => monday);
vi.mock("../src/card-registry", () => registry);
vi.mock("../src/ensure-card", () => ({ ensureCardForRecord: vi.fn(async () => ({ status: "refused" })), cardIdOf: vi.fn(() => null) }));
vi.mock("../src/owner-notice", async (orig) => ({
  ...(await orig<typeof import("../src/owner-notice")>()), queueOwnerNotices: vi.fn(async () => undefined),
}));

const { syncMondayItem, resetCtxCache } = await import("../src/sync");
const { queueOwnerNotices } = await import("../src/owner-notice");

const env = { ENABLE_CRM: "true", CRM_CREATE_CUTOFF_AT: "2026-09-01T00:00:00Z", CRM_CUTOVER_AT: "2026-09-25T00:00:00Z",
  OWNER_NOTICE: "true" } as unknown as Env;
const live: RunOpts = { dryRun: false, writeHubspot: true, maxWrites: 30 };
const NEW_ID = "99";

const contactCard = (): MondayItem => ({
  id: "k-1", name: "Jo Smith", created_at: "2026-10-09T09:00:00Z", updated_at: "", group: { id: "topics" },
  column_values: Object.entries({ [CRM_CONTACTS.idCol]: "", contact_email: "jo@acme.com", text_mm6sab4c: "Jo",
    text_mm6snp6r: "Smith" }).map(([id, text]) => ({ id, text })) as never,
});

beforeEach(() => {
  vi.clearAllMocks();
  resetCtxCache();
  hs.getOwners.mockResolvedValue({});
  hs.getPropertyOptions.mockResolvedValue({});
  hs.getDealStageLabels.mockResolvedValue({});
  hs.getCrmStageDicts.mockResolvedValue({ pipelines: {}, stages: {}, pipelineByStage: {}, coarse: {} });
  hs.searchContactByEmail.mockResolvedValue(null);
  hs.createRecord.mockImplementation(async (_e: unknown, _s: unknown, _p: unknown, o: RunOpts) =>
    o.dryRun || !o.writeHubspot ? null : { id: NEW_ID, modified: "2026-10-09T09:00:01Z" });
  monday.getUsersByEmail.mockResolvedValue({});
  monday.setColumns.mockResolvedValue(undefined);
  monday.getItem.mockResolvedValue(contactCard());
  registry.claimHubspotForItem.mockResolvedValue({ status: "proceed" });
});

describe("a contact born in monday", () => {
  it("queues the notice once the HubSpot record exists, for the new record's id", async () => {
    await syncMondayItem(env, CRM_CONTACTS.boardId, "k-1", live, { left: 30 });
    expect(hs.createRecord).toHaveBeenCalledTimes(1);
    expect(queueOwnerNotices).toHaveBeenCalledWith(env, [NEW_ID], "created in monday");
    // ...after the id was written back, so the card is a paired card by the time the queue looks for it.
    expect(monday.setColumns.mock.invocationCallOrder[0]).toBeLessThan((queueOwnerNotices as any).mock.invocationCallOrder[0]);
  });

  it("a create that did not happen (dry run) queues nothing", async () => {
    await syncMondayItem(env, CRM_CONTACTS.boardId, "k-1", { ...live, dryRun: true }, { left: 30 });
    expect(queueOwnerNotices).not.toHaveBeenCalled();
  });

  it("switch off: queues nothing", async () => {
    await syncMondayItem({ ...env, OWNER_NOTICE: "false" } as Env, CRM_CONTACTS.boardId, "k-1", live, { left: 30 });
    expect(hs.createRecord).toHaveBeenCalledTimes(1);
    expect(queueOwnerNotices).not.toHaveBeenCalled();
  });
});
