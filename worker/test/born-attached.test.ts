import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { CRM_ACCOUNTS, CRM_CONTACTS, CRM_DEALS, CRM_LINE_ITEMS } from "../src/config/crm";
import { DEALS, specByBoard } from "../src/config";
import type { Budget, Env, MondayEdit, MondayItem, ObjectSpec, RunOpts } from "../src/types";

/**
 * BORN ATTACHED: a HubSpot record created from a monday card gets the links the card was created with.
 *
 * The report: "when we create using the form it is connected". Before this, a Deal made through the
 * monday Create form (or "+ Add") with a Contact and an Account filled in became a HubSpot Deal with NO
 * associations. createFromMonday created the record and returned; the reverse association pass only runs
 * for a card that already has a HubSpot id, and only for a person's relation edit. And a relation edit
 * made while the create was still in flight hit the per-item claim as "creating" and was dropped.
 *
 * Driven through the real syncMondayItem -> createFromMonday -> pushBirthAssociations, with HubSpot and
 * monday faked, so every claim below is proven by the presence or absence of an actual API call.
 */

const hs = vi.hoisted(() => ({
  putAssociation: vi.fn(), putAssociationTypes: vi.fn(), deleteAssociation: vi.fn(),
  getAssociatedIds: vi.fn(), getAssociatedPage: vi.fn(), getAllAssociatedIds: vi.fn(), getAssociatedVia: vi.fn(),
  getRecord: vi.fn(), getRecordsByIds: vi.fn(async () => []), propertiesForSpec: vi.fn(() => []),
  patchLineItem: vi.fn(), createLineItem: vi.fn(), claimOwnership: vi.fn(),
  createRecord: vi.fn(), getCrmStageDicts: vi.fn(), getDealStageLabels: vi.fn(), getOwners: vi.fn(),
  getPropertyOptions: vi.fn(), patchRecord: vi.fn(), searchCompanyByDomain: vi.fn(), searchAll: vi.fn(),
  searchContactByEmail: vi.fn(), searchModifiedIds: vi.fn(),
}));
const monday = vi.hoisted(() => ({
  getLinkedItemIds: vi.fn(), getItemsColumnText: vi.fn(), findItemIdsByColumn: vi.fn(), getItemStates: vi.fn(),
  setColumns: vi.fn(), createItem: vi.fn(), createSubitem: vi.fn(), deleteItem: vi.fn(), getItem: vi.fn(),
  getParentItemId: vi.fn(), getSubitems: vi.fn(), updateItem: vi.fn(), findItemByColumn: vi.fn(),
  getBoardItems: vi.fn(), getUsersByEmail: vi.fn(), moveItem: vi.fn(),
}));
const registry = vi.hoisted(() => ({
  lookupCard: vi.fn(async () => null), finishCard: vi.fn(), claimHubspotForItem: vi.fn(),
  finishHubspotForItem: vi.fn(), forgetHubspotForItem: vi.fn(),
  lookupCardOwner: vi.fn(async (): Promise<string | null> => null),
}));
vi.mock("../src/hubspot", () => ({ ...hs, OwnershipError: class extends Error {} }));
vi.mock("../src/monday", () => monday);
vi.mock("../src/card-registry", () => registry);
vi.mock("../src/ensure-card", () => ({
  ensureCardForRecord: vi.fn(async () => ({ status: "refused" })), cardIdOf: vi.fn(() => null),
}));

const { syncMondayItem, syncSpec, buildCtx, resetCtxCache, birthLinksOn } = await import("../src/sync");
const { pushBirthAssociations, birthColumns, MAX_LINKS_PER_EDIT } = await import("../src/associations");
const { drainRelationEvents, recordRelationEvent, relationEditKey } = await import("../src/relation-edit");

// A go-live cutoff is required for anything to create at all (CRM_CREATE_CUTOFF_MS ships as Infinity).
// Both kill switches ON, as the deploy passes them; the switch itself is proven at the end of the file.
const env = { ENABLE_CRM: "true", CRM_CREATE_CUTOFF_AT: "2026-09-01T00:00:00Z",
  CRM_CUTOVER_AT: "2026-09-25T00:00:00Z", BORN_ATTACHED_LINKS: "true", CREATE_WINDOW_REPLAY: "true" } as unknown as Env;
const live: RunOpts = { dryRun: false, writeHubspot: true, maxWrites: 30 };
const budget = (left = 30): Budget => ({ left });

const NEW_ID = "99";                              // what HubSpot returns for the create
const DEAL_CONTACT = "deal_contact";              // Deals -> Contacts
const DEAL_COMPANY = "board_relation_mm76wp4e";   // Deals -> Accounts
const DEAL_LINES = "board_relation_mm76btmt";     // Deals -> Products & Services (never a birth link)

// Linked cards on the far boards -> the HubSpot id their own "HubSpot ID" column holds. Card ids are
// numeric, as monday's are: a snap-back writes them back as numbers.
const C1 = "3001", C2 = "3002", C3 = "3003", C4 = "3004", C5 = "3005", C6 = "3006";
const C_UNSYNCED = "3009", C1_DUPLICATE = "3011";
const A1 = "4001", A2 = "4002", L1 = "5001", PARENT_DEAL = "6009";
const HS_OF: Record<string, string> = {
  [C1]: "501", [C2]: "502", [C3]: "503", [C4]: "504", [C5]: "505", [C6]: "506",
  [C_UNSYNCED]: "",                               // a Contact card that has not synced yet
  [C1_DUPLICATE]: "501",                          // a second card for the same HubSpot contact
  [A1]: "601", [A2]: "602", [L1]: "701", [PARENT_DEAL]: "334777970383",
};

/** A brand-new card: no HubSpot id, created after the go-live cutoff. */
const card = (id: string, cols: Record<string, string> = {}, name = "New Row"): MondayItem => ({
  id, name, created_at: "2026-10-01T09:00:00Z", updated_at: "", group: { id: "topics" },
  column_values: Object.entries(cols).map(([c, text]) => ({ id: c, text })) as never,
});

/** What each relation cell on the card being created holds, as monday would serve it right now. */
let cells: Record<string, string[]> = {};
/** HubSpot's association store, as the fake PUTs build it: `${from}/${id}/${to}` -> ids. */
let assocs: Map<string, Set<string>>;
let logs: string[];

const store = (from: string, id: string, to: string, toId: string) => {
  const k = `${from}/${id}/${to}`;
  assocs.set(k, new Set([...(assocs.get(k) ?? []), toId]));
};

beforeEach(() => {
  vi.clearAllMocks();
  resetCtxCache();
  cells = {};
  assocs = new Map();
  logs = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(" ")); });

  hs.getOwners.mockResolvedValue({});
  hs.getPropertyOptions.mockResolvedValue({});
  hs.getDealStageLabels.mockResolvedValue({});
  hs.getCrmStageDicts.mockResolvedValue({ pipelines: {}, stages: {}, pipelineByStage: {}, coarse: {} });
  hs.searchContactByEmail.mockResolvedValue(null);
  hs.searchCompanyByDomain.mockResolvedValue(null);
  // The real createRecord writes nothing (and returns null) on a dry run; the fake keeps that contract.
  hs.createRecord.mockImplementation(async (_e: unknown, _s: unknown, _p: unknown, o: RunOpts) =>
    o.dryRun || !o.writeHubspot ? null : { id: NEW_ID, modified: "2026-10-01T09:00:01Z" });
  hs.putAssociation.mockImplementation(async (_e: unknown, from: string, id: string, to: string, toId: string) =>
    store(from, id, to, toId));
  hs.putAssociationTypes.mockImplementation(async (_e: unknown, from: string, id: string, to: string, toId: string) =>
    store(from, id, to, toId));
  hs.getAllAssociatedIds.mockImplementation(async (_e: unknown, from: string, id: string, to: string) =>
    ({ ids: [...(assocs.get(`${from}/${id}/${to}`) ?? [])], truncated: false }));

  monday.getUsersByEmail.mockResolvedValue({});
  monday.setColumns.mockResolvedValue(undefined);
  monday.getLinkedItemIds.mockImplementation(async (_e: unknown, _item: string, col: string) => [...(cells[col] ?? [])]);
  monday.getItemsColumnText.mockImplementation(async (_e: unknown, ids: string[]) =>
    Object.fromEntries(ids.map(id => [id, HS_OF[id] ?? ""])));
  monday.getItemStates.mockImplementation(async (_e: unknown, ids: string[]) =>
    Object.fromEntries(ids.map(id => [id, "active"])));
  registry.claimHubspotForItem.mockResolvedValue({ status: "proceed" });
  registry.lookupCardOwner.mockResolvedValue(null);   // a genuinely new card: nothing pairs it yet
  runEnv = env;
});

afterEach(() => { vi.restoreAllMocks(); });

const dealCard = () => card("d-1", { [CRM_DEALS.idCol]: "" }, "Acme renewal");
const contactCard = () => card("k-1", { [CRM_CONTACTS.idCol]: "", contact_email: "jo@acme.com",
  text_mm6sab4c: "Jo", text_mm6snp6r: "Smith" }, "Jo Smith");
const accountCard = () => card("x-1", { [CRM_ACCOUNTS.idCol]: "", company_domain: "acme.com",
  text_mm6t1q4h: "Acme" }, "Acme");

/** The env every create below runs under; reset to `env` before each test. */
let runEnv: Env = env;
const create = (boardId: string, itemId: string, b = budget(), selfOrigin = false, edit?: MondayEdit, opts = live,
    actor?: { id: string; byAutomation: boolean }) =>
  syncMondayItem(runEnv, boardId, itemId, opts, b, false, selfOrigin, edit, actor);

const puts = () => (hs.putAssociation.mock.calls as unknown[][]).map(c => `${c[1]}/${c[2]}->${c[3]}/${c[4]}`);
const labelledPuts = () => (hs.putAssociationTypes.mock.calls as unknown[][]).map(c => `${c[1]}/${c[2]}->${c[3]}/${c[4]}`);
const logLine = (re: RegExp) => logs.find(l => re.test(l));
const relationWrites = (col: string) =>
  (monday.setColumns.mock.calls as unknown[][]).filter(c => col in (c[3] as object)).map(c => (c[3] as any)[col]);

// ------------------------------------------------------------------------------------------ Deals
describe("a Deal created from the form with a Contact and an Account", () => {
  beforeEach(() => {
    monday.getItem.mockResolvedValue(dealCard());
    cells = { [DEAL_CONTACT]: [C1], [DEAL_COMPANY]: [A1] };
  });

  it("creates ONE HubSpot deal, with nothing riding in the create payload", async () => {
    await create(CRM_DEALS.boardId, "d-1");
    expect(hs.createRecord).toHaveBeenCalledTimes(1);
    expect((hs.createRecord.mock.calls[0] as unknown[])[5]).toBeUndefined();
  });

  it("then associates it to BOTH the contact and the company", async () => {
    await create(CRM_DEALS.boardId, "d-1");
    expect(puts()).toEqual([`deals/${NEW_ID}->contacts/501`]);
    expect(labelledPuts()).toEqual([`deals/${NEW_ID}->companies/601`]);
  });

  it("a deal's single company is linked as HubSpot's Primary (typeId 5), as its own UI does", async () => {
    await create(CRM_DEALS.boardId, "d-1");
    expect((hs.putAssociationTypes.mock.calls[0] as unknown[])[5])
      .toEqual([{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 5 }]);
  });

  it("with TWO companies none is picked as Primary: both go unlabelled", async () => {
    cells[DEAL_COMPANY] = [A1, A2];
    await create(CRM_DEALS.boardId, "d-1");
    expect(hs.putAssociationTypes).not.toHaveBeenCalled();
    expect(puts()).toEqual([`deals/${NEW_ID}->contacts/501`,
      `deals/${NEW_ID}->companies/601`, `deals/${NEW_ID}->companies/602`]);
  });

  it("writes on the NEW record's own birth stamp: allowed, bound to its id, no claim", async () => {
    await create(CRM_DEALS.boardId, "d-1");
    const auth = (hs.putAssociation.mock.calls[0] as unknown[])[7];
    expect(auth).toEqual({ allowed: true, reason: "stamped crm", forId: NEW_ID });
    expect((hs.putAssociation.mock.calls[0] as unknown[])[6]).toMatchObject({ object: "deals" });
    expect(hs.claimOwnership).not.toHaveBeenCalled();
  });

  it("reads the cells AFTER the id write-back, never before it", async () => {
    await create(CRM_DEALS.boardId, "d-1");
    const writeBack = (monday.setColumns.mock.calls as unknown[][]).findIndex(c => (c[3] as any)[CRM_DEALS.idCol] === NEW_ID);
    expect(writeBack, "the card was never stamped").toBeGreaterThanOrEqual(0);
    const stampedAt = monday.setColumns.mock.invocationCallOrder[writeBack];
    expect(monday.getLinkedItemIds).toHaveBeenCalled();
    expect(hs.putAssociation).toHaveBeenCalled();
    expect(Math.min(...monday.getLinkedItemIds.mock.invocationCallOrder)).toBeGreaterThan(stampedAt);
    expect(Math.min(...hs.putAssociation.mock.invocationCallOrder)).toBeGreaterThan(stampedAt);
    expect(Math.min(...registry.finishCard.mock.invocationCallOrder),
      "the card must be registered before HubSpot's association webhooks can look for it")
      .toBeLessThan(Math.min(...hs.putAssociation.mock.invocationCallOrder));
  });

  it("never reads or links the Products & Services column: a line item belongs to one deal", async () => {
    cells[DEAL_LINES] = [L1];
    await create(CRM_DEALS.boardId, "d-1");
    expect((monday.getLinkedItemIds.mock.calls as unknown[][]).map(c => c[2])).not.toContain(DEAL_LINES);
    expect([...puts(), ...labelledPuts()].join(" ")).not.toMatch(/line_items/);
  });

  it("logs ONE summary line for the created record", async () => {
    await create(CRM_DEALS.boardId, "d-1");
    const lines = logs.filter(l => /action=born-attached /.test(l));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(new RegExp(`card d-1 hubspot_id=${NEW_ID} action=born-attached links=2 skipped=0 refused=0`));
  });

  it("the create still reports as a create", async () => {
    expect(await create(CRM_DEALS.boardId, "d-1")).toMatch(/action=created-hubspot/);
  });

  it("a card with nothing linked still logs its line, and writes nothing", async () => {
    cells = {};
    await create(CRM_DEALS.boardId, "d-1");
    expect(hs.putAssociation).not.toHaveBeenCalled();
    expect(hs.putAssociationTypes).not.toHaveBeenCalled();
    expect(logLine(/action=born-attached links=0 skipped=0 refused=0/)).toBeDefined();
  });
});

// ------------------------------------------------------------------------------------------ Contacts
describe("a Contact created from the form with an Account", () => {
  beforeEach(() => {
    monday.getItem.mockResolvedValue(contactCard());
    cells = { contact_account: [A1] };
  });

  it("creates the contact, then associates it to the company", async () => {
    await create(CRM_CONTACTS.boardId, "k-1");
    expect(hs.createRecord).toHaveBeenCalledTimes(1);
    expect(puts()).toEqual([`contacts/${NEW_ID}->companies/601`]);
    expect(hs.putAssociationTypes).not.toHaveBeenCalled();   // Primary is a deal -> company label only
    expect(logLine(/action=born-attached links=1 skipped=0 refused=0/)).toBeDefined();
  });

  it("and the mirror image: an Account created with a Contact links company -> contact", async () => {
    monday.getItem.mockResolvedValue(accountCard());
    cells = { account_contact: [C1] };
    await create(CRM_ACCOUNTS.boardId, "x-1");
    expect(puts()).toEqual([`companies/${NEW_ID}->contacts/501`]);
  });
});

// ------------------------------------------------------------------------------------------ adoption
describe("an ADOPTED record is linked, not born, and gets no birth links", () => {
  it("a Contact whose email HubSpot already knows: no create, no association, logged", async () => {
    monday.getItem.mockResolvedValue(contactCard());
    cells = { contact_account: [A1] };
    hs.searchContactByEmail.mockResolvedValue({ id: "777", modified: "2026-01-01T00:00:00Z" });
    await create(CRM_CONTACTS.boardId, "k-1");
    expect(hs.createRecord).not.toHaveBeenCalled();
    expect(hs.putAssociation).not.toHaveBeenCalled();
    expect(hs.putAssociationTypes).not.toHaveBeenCalled();
    expect(monday.getLinkedItemIds).not.toHaveBeenCalled();
    expect(logLine(/hubspot_id=777 action=birth-links-skipped reason=adopted/)).toBeDefined();
    expect(logLine(/action=born-attached /)).toBeUndefined();
  });

  it("an Account whose domain HubSpot already knows: the same", async () => {
    monday.getItem.mockResolvedValue(accountCard());
    cells = { account_contact: [C1] };
    hs.searchCompanyByDomain.mockResolvedValue({ id: "888", modified: "2026-01-01T00:00:00Z" });
    await create(CRM_ACCOUNTS.boardId, "x-1");
    expect(hs.createRecord).not.toHaveBeenCalled();
    expect(hs.putAssociation).not.toHaveBeenCalled();
    expect(logLine(/hubspot_id=888 action=birth-links-skipped reason=adopted/)).toBeDefined();
  });
});

// ------------------------------------------------------------------------------------------ unsynced cards
describe("a linked card with no HubSpot id yet", () => {
  beforeEach(() => { monday.getItem.mockResolvedValue(dealCard()); });

  it("is skipped and logged; the synced card beside it is still linked", async () => {
    cells = { [DEAL_CONTACT]: [C1, C_UNSYNCED] };
    await create(CRM_DEALS.boardId, "d-1");
    expect(puts()).toEqual([`deals/${NEW_ID}->contacts/501`]);
    expect(logLine(new RegExp(`reverse=contacts basis=birth cards=${C_UNSYNCED}`
      + ` action=birth-assoc-skipped reason="linked card has no HubSpot id yet"`))).toBeDefined();
    expect(logLine(/action=born-attached links=1 skipped=1 refused=0/)).toBeDefined();
  });

  it("is NOT a refusal: the card keeps it (no snap-back)", async () => {
    cells = { [DEAL_CONTACT]: [C_UNSYNCED] };
    await create(CRM_DEALS.boardId, "d-1");
    expect(hs.putAssociation).not.toHaveBeenCalled();
    expect(relationWrites(DEAL_CONTACT)).toEqual([]);
    expect(logLine(/action=born-attached links=0 skipped=1 refused=0/)).toBeDefined();
  });
});

// ------------------------------------------------------------------------------------------ in flight
describe("a relation edit made while the create is still in flight", () => {
  it("is skipped at the claim as 'creating', and the birth pass sends it anyway", async () => {
    monday.getItem.mockResolvedValue(dealCard());
    cells = { [DEAL_CONTACT]: [] };                   // the form saved no contact...
    registry.claimHubspotForItem
      .mockResolvedValueOnce({ status: "proceed" })   // the create event
      .mockResolvedValueOnce({ status: "creating" }); // the rep's relation edit, a moment later
    let release!: (v: { id: string; modified: string }) => void;
    let entered!: () => void;
    const inCreate = new Promise<void>(r => { entered = r; });
    hs.createRecord.mockImplementationOnce(() => { entered(); return new Promise(r => { release = r; }); });

    const creating = create(CRM_DEALS.boardId, "d-1");
    await inCreate;                                   // HubSpot is creating the deal right now

    cells[DEAL_CONTACT] = [C1];                       // ...then the rep links a contact
    const edit: MondayEdit = { cols: [DEAL_CONTACT], linked: { [DEAL_CONTACT]: [C1] },
      unlinked: { [DEAL_CONTACT]: [] }, largestEvent: { [DEAL_CONTACT]: { added: 1, removed: 0 } }, actor: "102443183" };
    await create(CRM_DEALS.boardId, "d-1", budget(), false, edit);
    expect(logLine(/create already in flight — skipping/)).toBeDefined();
    expect(hs.putAssociation, "the skipped edit must not push on its own").not.toHaveBeenCalled();

    release({ id: NEW_ID, modified: "2026-10-01T09:00:01Z" });
    await creating;
    expect(hs.createRecord).toHaveBeenCalledTimes(1);   // still one record
    expect(puts()).toEqual([`deals/${NEW_ID}->contacts/501`]);
    expect(logLine(/action=born-attached links=1 skipped=0 refused=0/)).toBeDefined();
  });
});

describe("a removal that lands while the birth pass is reading (G3)", () => {
  it("the removed card is not sent; the one still wanted is", async () => {
    monday.getItem.mockResolvedValue(dealCard());
    cells = { [DEAL_CONTACT]: [C1, C2] };
    // The rep took C2 back out; that event is queued behind this run and not yet drained.
    const key = relationEditKey("d-1", DEAL_CONTACT, "person");
    recordRelationEvent(key, { added: [], removed: [C2] });
    try {
      await create(CRM_DEALS.boardId, "d-1");
    } finally {
      drainRelationEvents(key);
    }
    expect(puts()).toEqual([`deals/${NEW_ID}->contacts/501`]);
    expect(logLine(/to=502 basis=birth action=birth-assoc-superseded/)).toBeDefined();
    expect(relationWrites(DEAL_CONTACT), "a superseded link is not a refusal").toEqual([]);
  });
});

// ------------------------------------------------------------------------------------------ self-origin
describe("an event caused by our own token", () => {
  it("creates nothing and links nothing", async () => {
    monday.getItem.mockResolvedValue(dealCard());
    cells = { [DEAL_CONTACT]: [C1], [DEAL_COMPANY]: [A1] };
    const out = await create(CRM_DEALS.boardId, "d-1", budget(), true);
    expect(out).toMatch(/refusing to create/);
    expect(hs.createRecord).not.toHaveBeenCalled();
    expect(hs.putAssociation).not.toHaveBeenCalled();
    expect(hs.putAssociationTypes).not.toHaveBeenCalled();
    expect(monday.getLinkedItemIds).not.toHaveBeenCalled();
  });
});

// ------------------------------------------------------------------------------------------ provenance
/**
 * THE fake.com SHAPE, BOTH HALVES (review of 2026-10-01).
 *
 * HubSpot creates a deal. ensureCardForRecord makes its card with the id already stamped, and the forward
 * association pass fills deal_contact and the companies column FROM HUBSPOT. A board automation on
 * item-created then writes a two-way column. Its webhook reads the card inside the id-read lag, so the id
 * comes back empty; the actor is -4, not our token, so selfOrigin is false; and the per-item create claim
 * says "proceed", because ensureCardForRecord never writes that key. Then:
 *   1. createRecord made a DUPLICATE deal (older than the birth pass), and
 *   2. the birth pass copied the real deal's contacts and Primary company onto the duplicate.
 * (1) is closed by the card-owner index, (2) by the create's provenance. Each is tested alone.
 */
const AUTOMATION = { id: "-4", byAutomation: true };
const PERSON = { id: "102443183", byAutomation: false };
const REAL_DEAL = "334777970383";
/** The probe's event: an automation writing a two-way status column (Priority) on the Deals board. */
const automationEdit: MondayEdit = { cols: ["color_mm76tdww"], byAutomation: true };

describe("a card this Worker already made for a HubSpot record is never given a second record", () => {
  beforeEach(() => {
    monday.getItem.mockResolvedValue(dealCard());              // the id read lagged: it comes back empty
    cells = { [DEAL_CONTACT]: [C1, C2], [DEAL_COMPANY]: [A1] }; // what the forward pass wrote from HubSpot
    registry.lookupCardOwner.mockResolvedValue(REAL_DEAL);     // ensureCardForRecord's finishCard wrote it
  });

  it("the automation's event on a HubSpot-born card: no create, no link, the card re-stamped", async () => {
    const out = await create(CRM_DEALS.boardId, "d-1", budget(), false, automationEdit, live, AUTOMATION);
    expect(hs.createRecord).not.toHaveBeenCalled();
    expect(hs.putAssociation).not.toHaveBeenCalled();
    expect(hs.putAssociationTypes).not.toHaveBeenCalled();
    expect(monday.getLinkedItemIds, "nothing reads the forward-filled cells").not.toHaveBeenCalled();
    expect(registry.lookupCardOwner).toHaveBeenCalledWith(env, CRM_DEALS.boardId, "d-1");
    // Re-stamped with the record it already stands for, and the create claim settled on that record, so
    // the next event for this row reads "have" instead of reaching this check again.
    expect((monday.setColumns.mock.calls as unknown[][]).map(c => (c[3] as any)[CRM_DEALS.idCol])).toEqual([REAL_DEAL]);
    // (Settled as a LINK with CREATE_WINDOW_REPLAY on, as here: whatever queued behind this claim is handed
    // back and applied with it. The plain finish with the switch off is pinned in the kill-switch block.)
    expect(registry.finishHubspotForItem).toHaveBeenCalledWith(env, CRM_DEALS.boardId, "d-1", REAL_DEAL, "link");
    expect(registry.forgetHubspotForItem).not.toHaveBeenCalled();
    expect(logLine(new RegExp(`card d-1 hubspot_id=${REAL_DEAL} action=re-stamped reason="the card-owner index`)))
      .toBeDefined();
    expect(out).toMatch(/action=adopted-hubspot/);
  });

  it("a person's event on the same card is refused the duplicate just the same", async () => {
    await create(CRM_DEALS.boardId, "d-1", budget(), false, undefined, live, PERSON);
    expect(hs.createRecord).not.toHaveBeenCalled();
    expect(hs.putAssociation).not.toHaveBeenCalled();
    expect(hs.putAssociationTypes).not.toHaveBeenCalled();
  });

  it("is checked before adoption's own search, so an adoptable card is not re-paired either", async () => {
    monday.getItem.mockResolvedValue(contactCard());
    cells = { contact_account: [A1] };
    await create(CRM_CONTACTS.boardId, "k-1", budget(), false, undefined, live, PERSON);
    expect(hs.searchContactByEmail).not.toHaveBeenCalled();
    expect(hs.createRecord).not.toHaveBeenCalled();
    expect(hs.putAssociation).not.toHaveBeenCalled();
  });

  it("a 'have' claim is still answered first, without reading the index", async () => {
    registry.claimHubspotForItem.mockResolvedValue({ status: "have", itemId: NEW_ID });
    await create(CRM_DEALS.boardId, "d-1");
    expect(registry.lookupCardOwner).not.toHaveBeenCalled();
    expect(hs.createRecord).not.toHaveBeenCalled();
  });

  it("an empty index (a card nothing paired) creates exactly as before", async () => {
    registry.lookupCardOwner.mockResolvedValue(null);
    await create(CRM_DEALS.boardId, "d-1", budget(), false, undefined, live, PERSON);
    expect(hs.createRecord).toHaveBeenCalledTimes(1);
    expect(logLine(/action=born-attached links=3 skipped=0 refused=0/)).toBeDefined();
  });

  it("a Work-Management board does not consult it: that create path is unchanged", async () => {
    const wmEnv = {} as unknown as Env;
    monday.getItem.mockResolvedValue(card("w-1", { [DEALS.idCol]: "" }, "WM row"));
    await syncMondayItem(wmEnv, DEALS.boardId, "w-1", live, budget(), false, false, undefined, PERSON);
    expect(registry.lookupCardOwner).not.toHaveBeenCalled();
    expect(hs.createRecord).toHaveBeenCalledTimes(1);
  });
});

describe("an automation's event never sends a new record's links", () => {
  beforeEach(() => {
    monday.getItem.mockResolvedValue(dealCard());
    cells = { [DEAL_CONTACT]: [C1, C2], [DEAL_COMPANY]: [A1] };
  });

  it("an automation's column edit on a genuinely new card: created as before, and nothing linked (probe A)", async () => {
    await create(CRM_DEALS.boardId, "d-1", budget(), false, automationEdit);   // the edit alone carries it
    expect(hs.createRecord).toHaveBeenCalledTimes(1);
    expect(hs.putAssociation).not.toHaveBeenCalled();
    expect(hs.putAssociationTypes).not.toHaveBeenCalled();
    expect(monday.getLinkedItemIds).not.toHaveBeenCalled();
    expect(logLine(new RegExp(`source=monday object=deals id=${NEW_ID} item=d-1 action=birth-assoc-suppressed`
      + ` reason="the create was triggered by a monday automation, not a person"`))).toBeDefined();
    expect(logLine(/action=born-attached /)).toBeUndefined();
  });

  it("an automation's item-created event names no column, so carries no edit: the actor catches it", async () => {
    await create(CRM_DEALS.boardId, "d-1", budget(), false, undefined, live, AUTOMATION);
    expect(hs.createRecord).toHaveBeenCalledTimes(1);
    expect(hs.putAssociation).not.toHaveBeenCalled();
    expect(hs.putAssociationTypes).not.toHaveBeenCalled();
    expect(logLine(/item=d-1 actor=-4 action=birth-assoc-suppressed/)).toBeDefined();
  });

  it("a link only an automation added is not pushed on an automation-started create (probe B)", async () => {
    cells = { [DEAL_CONTACT]: [C1] };
    const key = relationEditKey("d-1", DEAL_CONTACT, "automation");
    recordRelationEvent(key, { added: [C1], removed: [] });
    try {
      await create(CRM_DEALS.boardId, "d-1", budget(), false, undefined, live, AUTOMATION);
    } finally {
      drainRelationEvents(key);
    }
    expect(hs.putAssociation).not.toHaveBeenCalled();
    expect(hs.putAssociationTypes).not.toHaveBeenCalled();
  });

  it("is not a refusal: the cells are left alone, as a suppressed relation edit's are", async () => {
    await create(CRM_DEALS.boardId, "d-1", budget(), false, automationEdit);
    expect(relationWrites(DEAL_CONTACT)).toEqual([]);
    expect(relationWrites(DEAL_COMPANY)).toEqual([]);
  });

  it("a person's event (the form, '+ Add') still links: the actor is what decides", async () => {
    await create(CRM_DEALS.boardId, "d-1", budget(), false, undefined, live, PERSON);
    expect(puts()).toEqual([`deals/${NEW_ID}->contacts/501`, `deals/${NEW_ID}->contacts/502`]);
    expect(labelledPuts()).toEqual([`deals/${NEW_ID}->companies/601`]);
  });

  it("a person's column edit is a person's too, even when the actor is not passed", async () => {
    await create(CRM_DEALS.boardId, "d-1", budget(), false, { cols: ["color_mm76tdww"] });
    expect(logLine(/action=born-attached links=3 skipped=0 refused=0/)).toBeDefined();
  });

  it("KNOWN, AND LOGGED: an automation that wins the create race also drops a person's mid-create link", async () => {
    cells = { [DEAL_CONTACT]: [] };
    registry.claimHubspotForItem
      .mockResolvedValueOnce({ status: "proceed" })    // the automation's event takes the create
      .mockResolvedValueOnce({ status: "creating" });  // the rep's relation edit, a moment later
    let release!: (v: { id: string; modified: string }) => void;
    let entered!: () => void;
    const inCreate = new Promise<void>(r => { entered = r; });
    hs.createRecord.mockImplementationOnce(() => { entered(); return new Promise(r => { release = r; }); });

    const creating = create(CRM_DEALS.boardId, "d-1", budget(), false, automationEdit, live, AUTOMATION);
    await inCreate;
    cells[DEAL_CONTACT] = [C1];
    await create(CRM_DEALS.boardId, "d-1", budget(), false, { cols: [DEAL_CONTACT],
      linked: { [DEAL_CONTACT]: [C1] }, unlinked: { [DEAL_CONTACT]: [] } }, live, PERSON);
    expect(logLine(/create already in flight — skipping .*unless an automation's event started it/)).toBeDefined();

    release({ id: NEW_ID, modified: "2026-10-01T09:00:01Z" });
    await creating;
    expect(hs.createRecord).toHaveBeenCalledTimes(1);
    expect(hs.putAssociation).not.toHaveBeenCalled();
    expect(logLine(/action=birth-assoc-suppressed/)).toBeDefined();
  });
});

describe("the nightly sweep (CRM boards skip it) would not link either", () => {
  it("no event, so no person behind the create: suppressed, fail closed", async () => {
    hs.searchAll.mockResolvedValue([]);
    monday.getBoardItems.mockResolvedValue([dealCard()]);
    cells = { [DEAL_CONTACT]: [C1] };
    const ctx = await buildCtx(env);
    await syncSpec(env, specByBoard(env, CRM_DEALS.boardId)!, ctx, live, budget());
    expect(hs.createRecord).toHaveBeenCalledTimes(1);
    expect(hs.putAssociation).not.toHaveBeenCalled();
    expect(logLine(/action=birth-assoc-suppressed reason="no person's event is behind this create/)).toBeDefined();
  });
});

// ------------------------------------------------------------------------------------------ refused creates
describe("no birth pass when nothing was born", () => {
  it("a dry run (createRecord writes nothing and returns null)", async () => {
    monday.getItem.mockResolvedValue(dealCard());
    cells = { [DEAL_CONTACT]: [C1] };
    await create(CRM_DEALS.boardId, "d-1", budget(), false, undefined, { ...live, writeHubspot: false });
    expect(monday.getLinkedItemIds).not.toHaveBeenCalled();
    expect(hs.putAssociation).not.toHaveBeenCalled();
    expect(logLine(/action=born-attached /)).toBeUndefined();
  });

  it("a Contact refused for having no usable email", async () => {
    monday.getItem.mockResolvedValue(card("k-2", { [CRM_CONTACTS.idCol]: "", contact_email: "" }, "Nobody"));
    cells = { contact_account: [A1] };
    await create(CRM_CONTACTS.boardId, "k-2");
    expect(hs.createRecord).not.toHaveBeenCalled();
    expect(hs.putAssociation).not.toHaveBeenCalled();
  });

  it("a HubSpot create error: nothing is linked and the claim is released", async () => {
    monday.getItem.mockResolvedValue(dealCard());
    cells = { [DEAL_CONTACT]: [C1] };
    hs.createRecord.mockRejectedValueOnce(new Error("hubspot POST /crm/v3/objects/deals: 400 bad"));
    await create(CRM_DEALS.boardId, "d-1");
    expect(hs.putAssociation).not.toHaveBeenCalled();
    expect(registry.forgetHubspotForItem).toHaveBeenCalled();
  });

  it("a failed id write-back: no birth pass (the card has no id to be found by)", async () => {
    monday.getItem.mockResolvedValue(dealCard());
    cells = { [DEAL_CONTACT]: [C1] };
    monday.setColumns.mockRejectedValueOnce(new Error("monday 500"));
    const out = await create(CRM_DEALS.boardId, "d-1");
    expect(out).toMatch(/WRITEBACK_FAILED/);
    expect(hs.putAssociation).not.toHaveBeenCalled();
  });
});

// ------------------------------------------------------------------------------------------ idempotency
describe("a retried or duplicated create event", () => {
  beforeEach(() => {
    monday.getItem.mockResolvedValue(dealCard());
    cells = { [DEAL_CONTACT]: [C1], [DEAL_COMPANY]: [A1] };
  });

  it("a redelivery after the create ('have') re-stamps: no second record, no second link", async () => {
    await create(CRM_DEALS.boardId, "d-1");
    registry.claimHubspotForItem.mockResolvedValue({ status: "have", itemId: NEW_ID });
    await create(CRM_DEALS.boardId, "d-1");
    expect(hs.createRecord).toHaveBeenCalledTimes(1);
    expect(hs.putAssociation).toHaveBeenCalledTimes(1);
    expect(hs.putAssociationTypes).toHaveBeenCalledTimes(1);
  });

  it("a concurrent duplicate ('creating') neither creates nor links", async () => {
    registry.claimHubspotForItem.mockResolvedValue({ status: "creating" });
    await create(CRM_DEALS.boardId, "d-1");
    expect(hs.createRecord).not.toHaveBeenCalled();
    expect(hs.putAssociation).not.toHaveBeenCalled();
  });

  it("each linked record is sent once even when two cards point at it", async () => {
    cells[DEAL_CONTACT] = [C1, C1_DUPLICATE];
    await create(CRM_DEALS.boardId, "d-1");
    expect(puts()).toEqual([`deals/${NEW_ID}->contacts/501`]);
  });
});

// ------------------------------------------------------------------------------------------ caps
describe("the same caps as a person's relation edit", () => {
  beforeEach(() => { monday.getItem.mockResolvedValue(dealCard()); });

  it(`exactly MAX_LINKS_PER_EDIT (${MAX_LINKS_PER_EDIT}) contacts are all sent`, async () => {
    cells = { [DEAL_CONTACT]: [C1, C2, C3, C4, C5] };
    await create(CRM_DEALS.boardId, "d-1");
    expect(hs.putAssociation).toHaveBeenCalledTimes(5);
  });

  it("one more refuses the WHOLE column (never a partial set) and snaps the cell back", async () => {
    cells = { [DEAL_CONTACT]: [C1, C2, C3, C4, C5, C6], [DEAL_COMPANY]: [A1] };
    await create(CRM_DEALS.boardId, "d-1");
    expect(puts().filter(p => p.includes("->contacts/"))).toEqual([]);
    expect(logLine(/reverse=contacts basis=birth action=birth-assoc-refused reason="6 links on a new card \(max 5\)/))
      .toBeDefined();
    expect(relationWrites(DEAL_CONTACT)).toEqual([{ item_ids: [] }]);
    // The other column is judged on its own.
    expect(labelledPuts()).toEqual([`deals/${NEW_ID}->companies/601`]);
    expect(logLine(/action=born-attached links=1 skipped=0 refused=1/)).toBeDefined();
  });

  it("the write budget stops it, and only what was NOT sent is taken back out", async () => {
    cells = { [DEAL_CONTACT]: [C1, C2] };
    await create(CRM_DEALS.boardId, "d-1", budget(2));   // the create spends one, one link is left
    expect(puts()).toEqual([`deals/${NEW_ID}->contacts/501`]);
    expect(logLine(/action=birth-assoc-refused reason="write budget exhausted after 1 of 2 links"/)).toBeDefined();
    // C1 is in HubSpot now and stays; C2 is not and comes out.
    expect(relationWrites(DEAL_CONTACT)).toEqual([{ item_ids: [Number(C1)] }]);
  });

  it("a HubSpot rejection is a refusal too: the create still stands and is reported", async () => {
    cells = { [DEAL_CONTACT]: [C1] };
    hs.putAssociation.mockRejectedValueOnce(new Error("hubspot PUT: 400 bad association"));
    const out = await create(CRM_DEALS.boardId, "d-1");
    expect(out).toMatch(/action=created-hubspot/);
    expect(logLine(/action=birth-assoc-refused reason="the link could not be sent: Error: hubspot PUT: 400/)).toBeDefined();
    expect(relationWrites(DEAL_CONTACT)).toEqual([{ item_ids: [] }]);
  });

  it("never deletes an association", async () => {
    cells = { [DEAL_CONTACT]: [C1, C2, C3, C4, C5, C6], [DEAL_COMPANY]: [A1] };
    await create(CRM_DEALS.boardId, "d-1");
    expect(hs.deleteAssociation).not.toHaveBeenCalled();
  });
});

// ------------------------------------------------------------------------------------------ scope
describe("which columns a birth may send", () => {
  const cols = (s: ObjectSpec) => birthColumns(s).map(a => a.relationCol);

  it("Deals: the Contact and Account columns, never Products & Services", () =>
    expect(cols(CRM_DEALS)).toEqual([DEAL_CONTACT, DEAL_COMPANY]));
  it("Contacts: the Account column", () => expect(cols(CRM_CONTACTS)).toEqual(["contact_account"]));
  it("Accounts: the Contacts column", () => expect(cols(CRM_ACCOUNTS)).toEqual(["account_contact"]));
  it("Products & Services: none -- its deal rides in the create payload, its Account is derived", () =>
    expect(cols(CRM_LINE_ITEMS)).toEqual([]));

  it("a P&S line item is still born on its deal, and nothing else is linked", async () => {
    monday.getItem.mockResolvedValue(card("ps-1", { [CRM_LINE_ITEMS.idCol]: "" }, "Intercom"));
    cells = { board_relation_mm76w9y5: [PARENT_DEAL], board_relation_mm7cz3v8: [A1] };
    await create(CRM_LINE_ITEMS.boardId, "ps-1");
    expect((hs.createRecord.mock.calls[0] as unknown[])[5]).toEqual([{ toId: "334777970383", associationTypeId: 20 }]);
    expect(hs.putAssociation).not.toHaveBeenCalled();
    expect(hs.putAssociationTypes).not.toHaveBeenCalled();
    expect(logLine(/action=born-attached links=0 skipped=0 refused=0/)).toBeDefined();
  });

  it("a Work-Management spec (record-level) is untouched: no birth pass at all", async () => {
    const r = await pushBirthAssociations(env, DEALS, NEW_ID, {}, dealCard(), live, budget());
    expect(r).toBeNull();
    expect(monday.getLinkedItemIds).not.toHaveBeenCalled();
    expect(hs.putAssociation).not.toHaveBeenCalled();
  });
});

// ------------------------------------------------------------------------------------------ the kill switch
/**
 * BORN_ATTACHED_LINKS. Only the literal "true" runs the birth pass. Off, a monday-born record gets no
 * association write at all -- the create path as it was before the pass existed -- and one line per create
 * says so. The card-owner re-stamp is a duplicate-record guard, not part of the pass, and stays on.
 */
describe("the BORN_ATTACHED_LINKS kill switch", () => {
  const links = (v: string | undefined, window = "true") =>
    ({ ...env, BORN_ATTACHED_LINKS: v, CREATE_WINDOW_REPLAY: window }) as unknown as Env;
  const noAssociationWrites = () => {
    expect(hs.putAssociation).not.toHaveBeenCalled();
    expect(hs.putAssociationTypes).not.toHaveBeenCalled();
    expect(hs.deleteAssociation).not.toHaveBeenCalled();
    expect(monday.getLinkedItemIds, "the pass does not even read the cells").not.toHaveBeenCalled();
  };

  beforeEach(() => {
    monday.getItem.mockResolvedValue(dealCard());
    cells = { [DEAL_CONTACT]: [C1], [DEAL_COMPANY]: [A1] };
  });

  it.each([["\"false\"", "false"], ["absent", undefined], ["\"TRUE\"", "TRUE"], ["\"1\"", "1"], ["empty", ""]])(
    "OFF (%s): a person's form-created Deal is created, with NO association write, and one line says so",
    async (_label, value) => {
      runEnv = links(value);
      const out = await create(CRM_DEALS.boardId, "d-1", budget(), false, undefined, live, PERSON);
      expect(out).toMatch(/action=created-hubspot/);
      expect(hs.createRecord).toHaveBeenCalledTimes(1);
      noAssociationWrites();
      const lines = logs.filter(l => /action=birth-links-disabled/.test(l));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatch(new RegExp(`deals card d-1 hubspot_id=${NEW_ID} action=birth-links-disabled`));
      expect(logLine(/action=born-attached|birth-assoc-/)).toBeUndefined();
      expect(relationWrites(DEAL_CONTACT), "and no snap-back either").toEqual([]);
    });

  it("OFF: a Contact and an Account are created unlinked too", async () => {
    runEnv = links("false");
    monday.getItem.mockResolvedValue(contactCard());
    cells = { contact_account: [A1] };
    await create(CRM_CONTACTS.boardId, "k-1");
    monday.getItem.mockResolvedValue(accountCard());
    cells = { account_contact: [C1] };
    await create(CRM_ACCOUNTS.boardId, "x-1");
    expect(hs.createRecord).toHaveBeenCalledTimes(2);
    noAssociationWrites();
    expect(logs.filter(l => /action=birth-links-disabled/.test(l))).toHaveLength(2);
  });

  it("OFF: an automation-started create is not 'suppressed' -- the pass is simply not run", async () => {
    runEnv = links("false");
    await create(CRM_DEALS.boardId, "d-1", budget(), false, automationEdit, live, AUTOMATION);
    expect(hs.createRecord).toHaveBeenCalledTimes(1);
    noAssociationWrites();
    expect(logLine(/action=birth-links-disabled/)).toBeDefined();
    expect(logLine(/birth-assoc-suppressed/)).toBeUndefined();
  });

  it("OFF: the in-flight skip no longer claims a birth pass will read the links", async () => {
    runEnv = links("false");
    registry.claimHubspotForItem.mockResolvedValue({ status: "creating" });
    await create(CRM_DEALS.boardId, "d-1", budget(), false, { cols: [DEAL_CONTACT] }, live, PERSON);
    expect(logLine(/create already in flight — skipping \(would duplicate\)$/)).toBeDefined();
    expect(logLine(/birth pass/)).toBeUndefined();
  });

  it("pushBirthAssociations refuses on its own while the switch is off (no caller can get past it)", async () => {
    expect(await pushBirthAssociations(links("false"), CRM_DEALS, NEW_ID, {}, dealCard(), live, budget())).toBeNull();
    noAssociationWrites();
    expect(await pushBirthAssociations(env, CRM_DEALS, NEW_ID, {}, dealCard(), live, budget())).not.toBeNull();
  });

  it("BOTH switches off (a bare deploy): the card-owner re-stamp still refuses the duplicate record", async () => {
    runEnv = links("false", "false");
    registry.lookupCardOwner.mockResolvedValue(REAL_DEAL);
    const out = await create(CRM_DEALS.boardId, "d-1", budget(), false, { cols: ["color_mm76tdww"] }, live, PERSON);
    expect(hs.createRecord, "no duplicate").not.toHaveBeenCalled();
    noAssociationWrites();
    expect((monday.setColumns.mock.calls as unknown[][]).map(c => (c[3] as any)[CRM_DEALS.idCol])).toEqual([REAL_DEAL]);
    expect(registry.finishHubspotForItem).toHaveBeenCalledWith(runEnv, CRM_DEALS.boardId, "d-1", REAL_DEAL);
    expect(logLine(new RegExp(`card d-1 hubspot_id=${REAL_DEAL} action=re-stamped`))).toBeDefined();
    expect(logLine(/action=replay-as-edit/), "the replay is CREATE_WINDOW_REPLAY's, and it is off").toBeUndefined();
    expect(out).toMatch(/action=adopted-hubspot/);
  });

  it("(the same re-stamp with CREATE_WINDOW_REPLAY on replays the person's edit onto the record)", async () => {
    runEnv = links("false", "true");
    registry.lookupCardOwner.mockResolvedValue(REAL_DEAL);
    await create(CRM_DEALS.boardId, "d-1", budget(), false, { cols: ["color_mm76tdww"] }, live, PERSON);
    expect(hs.createRecord).not.toHaveBeenCalled();
    expect(logLine(new RegExp(`hubspot_id=${REAL_DEAL} cols=color_mm76tdww action=replay-as-edit`))).toBeDefined();
  });

  it("is independent of CREATE_WINDOW_REPLAY: links ON with the window off are still sent, with no settle", async () => {
    runEnv = links("true", "false");
    await create(CRM_DEALS.boardId, "d-1", budget(), false, undefined, live, PERSON);
    expect(puts()).toEqual([`deals/${NEW_ID}->contacts/501`]);
    expect(labelledPuts()).toEqual([`deals/${NEW_ID}->companies/601`]);
    expect(logLine(/action=born-attached links=2 skipped=0 refused=0/)).toBeDefined();
    expect((registry.finishHubspotForItem.mock.calls as unknown[][]).filter(c => c[4] !== undefined),
      "the plain finish only: no hold, renew or release").toEqual([]);
  });

  it("only the literal \"true\" arms it", () => {
    expect(birthLinksOn({ BORN_ATTACHED_LINKS: "true" })).toBe(true);
    for (const v of [undefined, "", "false", "TRUE", "True", " true", "1", "yes"])
      expect(birthLinksOn({ BORN_ATTACHED_LINKS: v })).toBe(false);
  });
});
