import { describe, it, expect, vi, beforeEach } from "vitest";
import { CRM_CONTACTS, CRM_ACCOUNTS, CRM_SPECS } from "../src/config/crm";
import { ALL_SPECS, DEALS, CONTACTS_MYLA, COMPANIES_MYLA, specByObject } from "../src/config";
import { adoptionKey, isPublicEmailDomain } from "../src/adopt";
import type { HsRecord, MondayItem, ObjectSpec, RunOpts } from "../src/types";

/**
 * CONTACT <-> COMPANY ASSOCIATIONS — HubSpot -> monday ONLY, enforced in code.
 *
 * The reverse direction is blocked by an ownership gate inside reverseAssociations rather than by not
 * declaring associations, because "remember not to declare it" is not a safety property. This matters
 * specifically because reverseAssociations is NOT deals-only: sync.ts:567 is in syncMondayItem's generic
 * "already linked" branch and /app/sync-contact routes contacts through it.
 */

const crmEnv = { ENABLE_CRM: "true" } as { ENABLE_CRM?: string };
const prod = {} as { ENABLE_CRM?: string };

describe("the CRM specs declare exactly the native Contact<->Company relations", () => {
  it("Contacts -> companies via the native contact_account column", () => {
    expect(CRM_CONTACTS.associations).toEqual([
      { toObject: "companies", nameProps: ["name"], relationCol: "contact_account" },
    ]);
  });

  it("Accounts -> contacts via the native account_contact column", () => {
    expect(CRM_ACCOUNTS.associations).toEqual([
      { toObject: "contacts", nameProps: ["firstname", "lastname"], relationCol: "account_contact" },
    ]);
  });

  it("no text name column is used — only the real relation", () => {
    for (const s of CRM_SPECS) for (const a of s.associations!) expect(a.col).toBeUndefined();
  });

  it("no subitems anywhere in CRM", () => {
    for (const s of CRM_SPECS) for (const a of s.associations!) expect(a.subitems).toBeUndefined();
  });

  // NO DEALS. contact_deal points at board 5028000494; account_deal is a monday mirror.
  /**
   * Deals joined the CRM scope on 2026-09-14, so "no association targets deals" is no longer the
   * rule. Two things it was really protecting DO survive and are asserted instead:
   *   - `account_deal` and `deal_account` are monday MIRROR columns, resolved through another
   *     relation. Writing one directly is meaningless and would fail; they must never be a relationCol.
   *   - every association relation column must be a real board_relation this config owns.
   */
  it("no association is wired to a MIRROR column", () => {
    for (const s of CRM_SPECS)
      for (const a of s.associations ?? []) {
        expect(a.relationCol).not.toBe("account_deal");
        expect(a.relationCol).not.toBe("deal_account");
        expect(a.relationCol).not.toBe("mirror2");
      }
  });

  it("the relation columns point at each other's board, resolved per deployment", () => {
    expect(specByObject(crmEnv, "companies")).toBe(CRM_ACCOUNTS);
    expect(specByObject(crmEnv, "contacts")).toBe(CRM_CONTACTS);
    // The global map would have resolved these to the WM boards — a cross-deployment write.
    expect(specByObject(prod, "companies")).toBe(COMPANIES_MYLA);
    expect(specByObject(crmEnv, "companies")).not.toBe(COMPANIES_MYLA);
  });
});

// ------------------------------------------------------------- the reverse gate

const hs = vi.hoisted(() => ({
  putAssociation: vi.fn(), getAssociatedIds: vi.fn(), getRecordsByIds: vi.fn(),
  getRecord: vi.fn(), patchLineItem: vi.fn(), createLineItem: vi.fn(), propertiesForSpec: vi.fn(() => []),
}));
const monday = vi.hoisted(() => ({
  getLinkedItemIds: vi.fn(), getItemsColumnText: vi.fn(), findItemIdsByColumn: vi.fn(),
  createItem: vi.fn(), createSubitem: vi.fn(), deleteItem: vi.fn(), getItem: vi.fn(),
  getParentItemId: vi.fn(), getSubitems: vi.fn(), setColumns: vi.fn(), updateItem: vi.fn(),
}));

vi.mock("../src/hubspot", () => hs);
vi.mock("../src/monday", () => monday);

const { reverseAssociations } = await import("../src/associations");

const item: MondayItem = {
  id: "i1", name: "Acme", created_at: "", updated_at: "", group: { id: "topics" },
  column_values: [{ id: "contact_account", text: "linked" }] as never,
};
const rec: HsRecord = { id: "9001", properties: {} };
const live: RunOpts = { dryRun: false, writeHubspot: true, maxWrites: 30 };

beforeEach(() => {
  vi.clearAllMocks();
  // Wired so that IF the gate let anything through, a putAssociation would definitely happen.
  monday.getLinkedItemIds.mockResolvedValue(["c1"]);
  monday.getItemsColumnText.mockResolvedValue({ c1: "5555" });
  hs.getAssociatedIds.mockResolvedValue([]);        // nothing associated yet -> would add
  hs.putAssociation.mockResolvedValue(undefined);
});

describe("editing a monday CRM relation produces ZERO HubSpot association mutations", () => {
  it.each(CRM_SPECS.map(s => [s.object, s] as const))(
    "%s: reverseAssociations makes no putAssociation call", async (_o, spec) => {
      await reverseAssociations({} as never, spec, rec, item, live, { left: 30 });
      expect(hs.putAssociation).not.toHaveBeenCalled();
    });

  // CHANGED 2026-09-08 (P2-1 retired). The blanket "return before any work" refusal is gone:
  // putAssociation is now ownership-guarded per call, so the pass READS the relation and then refuses
  // at the ownership check. Reading is free and side-effect-free; the guard is what matters.
  it("READS the relation but refuses at the ownership check, writing nothing", async () => {
    await reverseAssociations({} as never, CRM_CONTACTS, rec, item, live, { left: 30 });
    expect(monday.getLinkedItemIds).toHaveBeenCalled();
    expect(hs.getAssociatedIds).toHaveBeenCalled();
    expect(hs.putAssociation).not.toHaveBeenCalled();
  });

  it("spends no budget, so a refusal cannot starve the rest of the tick", async () => {
    const budget = { left: 30 };
    await reverseAssociations({} as never, CRM_ACCOUNTS, rec, item, live, budget);
    expect(budget.left).toBe(30);
  });

  // The gate keys on `ownership`, not on the spec identity, so it holds for ANY ownership spec.
  it("the gate is keyed on ownership, so it covers any spec that declares it", async () => {
    const anyOwned: ObjectSpec = {
      ...DEALS, ownership: { prop: "sync_owner", createdProp: "createdate", owner: "crm", cutoverAtMs: 0 },
    };
    await reverseAssociations({} as never, anyOwned, rec, item, live, { left: 30 });
    expect(hs.putAssociation).not.toHaveBeenCalled();
  });

  // THE BUG THIS TEST FOUND, kept as a regression. DEALS declares TWO associations. The auth is resolved
  // once so a second relation column cannot trigger a second claim — but the allow-check must be
  // RE-EVALUATED per association. Caching both together let a refusal on the first association fall
  // through to a write on the second, because `!auth` was false by then. assertMayWrite inside
  // putAssociation would have thrown in production, but the logic was still wrong.
  it("a refusal on the FIRST association does not leak a write on the second", async () => {
    const twoAssoc: ObjectSpec = {
      ...DEALS, ownership: { prop: "sync_owner", createdProp: "createdate", owner: "crm", cutoverAtMs: 0 },
    };
    expect((twoAssoc.associations ?? []).filter(a => a.relationCol).length).toBeGreaterThan(1);
    await reverseAssociations({} as never, twoAssoc, rec, item, live, { left: 30 });
    expect(hs.putAssociation).not.toHaveBeenCalled();
  });

  // And the positive case: a CRM record the ownership rules DO permit gets its association written,
  // with the initiating spec + auth handed to putAssociation so assertMayWrite can enforce it.
  it("a crm-OWNED record DOES get its association written, guarded", async () => {
    const owned: HsRecord = { id: "9001", properties: { sync_owner: "crm", createdate: "2026-09-05T00:00:00Z" } };
    await reverseAssociations({} as never, CRM_CONTACTS, owned, item, live, { left: 30 });
    expect(hs.putAssociation).toHaveBeenCalledWith(
      {}, "contacts", "9001", "companies", "5555", live, CRM_CONTACTS,
      expect.objectContaining({ allowed: true }));
  });

  it("and is skipped without a write when HubSpot already has the association", async () => {
    hs.getAssociatedIds.mockResolvedValue(["5555"]);
    const owned: HsRecord = { id: "9001", properties: { sync_owner: "crm", createdate: "2026-09-05T00:00:00Z" } };
    await reverseAssociations({} as never, CRM_CONTACTS, owned, item, live, { left: 30 });
    expect(hs.putAssociation).not.toHaveBeenCalled();
  });

  // ...and REMOVING a relation is equally safe: reverseAssociations never deleted associations anyway,
  // and now it does not run at all for these specs.
  it("removing every linked card still writes nothing", async () => {
    monday.getLinkedItemIds.mockResolvedValue([]);
    await reverseAssociations({} as never, CRM_CONTACTS, rec, item, live, { left: 30 });
    expect(hs.putAssociation).not.toHaveBeenCalled();
  });
});

describe("WM REGRESSION: the reverse pass still works for specs without ownership", () => {
  it("a WM spec with associations DOES reach putAssociation", async () => {
    await reverseAssociations({} as never, DEALS, rec, item, live, { left: 30 });
    expect(hs.putAssociation).toHaveBeenCalled();
  });

  it("no WM spec declares ownership, so none of them is gated", () => {
    for (const s of ALL_SPECS) expect(s.ownership).toBeUndefined();
  });

  it("WM contacts keep their own two relation columns, untouched", () => {
    expect(CONTACTS_MYLA.associations?.map(a => a.toObject).sort()).toEqual(["companies", "deals"]);
  });
});

// ------------------------------------------------------------------ PA-1 provider domains

describe("PA-1: public email providers can never be a company adoption key", () => {
  const item = (text: string): MondayItem =>
    ({ id: "i1", name: "Some Co", created_at: "", updated_at: "", group: { id: "g" },
       column_values: [{ id: "company_domain", text }] as never });

  // Each of these has a REAL colliding company in this portal (verified 2026-09-07), so without the
  // guard a card carrying this domain would adopt an unrelated company.
  it.each([
    ["gmail.com", "上海胜意十方传媒技术有限公司"],
    ["qq.com", "QQ Music"],
    ["163.com", "a Zhuhai consultancy"],
    ["vip.163.com", "NETEASE"],
    ["yahoo.com", "JOYY Inc."],
  ])("%s is refused (would otherwise adopt %s)", (d) =>
    expect(adoptionKey(item(d), CRM_ACCOUNTS)).toBe(""));

  it.each([
    "hotmail.com", "outlook.com", "icloud.com", "126.com", "foxmail.com", "sina.com",
    "139.com", "aliyun.com", "protonmail.com", "googlemail.com",
  ])("%s is refused as forward protection even with no current collision", (d) =>
    expect(adoptionKey(item(d), CRM_ACCOUNTS)).toBe(""));

  it("a URL form of a provider domain is also refused", () => {
    expect(adoptionKey(item("https://www.gmail.com/x"), CRM_ACCOUNTS)).toBe("");
    expect(adoptionKey(item("HTTPS://QQ.COM"), CRM_ACCOUNTS)).toBe("");
  });

  it("subdomains of providers are refused — vip.163.com is a live case", () => {
    for (const d of ["vip.163.com", "vip.qq.com", "mail.sina.com", "a.b.gmail.com"])
      expect(isPublicEmailDomain(d)).toBe(true);
  });

  it("real company domains are UNAFFECTED", () => {
    for (const d of ["acme.com", "asiadt.com", "sz-gkts.com", "beyondedge.co", "notgmail.com",
                     "gmail.com.my", "my163.com"])
      expect(isPublicEmailDomain(d)).toBe(false);
  });

  it.each(["acme.com", "sub.acme.co.uk", "beyondedge.co"])(
    "%s still produces a usable adoption key", (d) =>
      expect(adoptionKey(item(d), CRM_ACCOUNTS)).toBe(d));

  // SCOPE. This guard is about COMPANY DOMAIN matching only. A contact whose email is at a provider is a
  // perfectly valid contact and syncs normally — contact email is never a company matching key, and the
  // CRM Contacts spec maps email forward-only with no adoptBy at all.
  it("says nothing about Contacts: their email is never an adoption key", () => {
    expect(CRM_CONTACTS.adoptBy).toBeUndefined();
    const emailField = CRM_CONTACTS.fields.find(f => f.hs === "email")!;
    expect(emailField.reverse).toBeUndefined();
    expect(isPublicEmailDomain("gmail.com")).toBe(true);   // blocked as a COMPANY domain...
    expect(emailField.col).toBe("contact_email");          // ...while the contact field is untouched
  });

  it("the WM company path does not use adoptionKey, so it is unchanged by this guard", () =>
    expect(COMPANIES_MYLA.adoptBy).toBeUndefined());
});
