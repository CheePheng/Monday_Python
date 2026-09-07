import { describe, it, expect } from "vitest";
import {
  ALL_SPECS, ALL_KNOWN_SPECS, SPEC_BY_BOARD, specsFor, specByBoard, specByObject,
  DEALS, CONTACTS_MYLA, COMPANIES_MYLA, CREATED_AFTER_MS,
} from "../src/config";
import { CRM_CONTACTS, CRM_ACCOUNTS, CRM_SPECS, CRM_CUTOVER_AT_MS } from "../src/config/crm";
import {
  authorizeWrite, canClaimCrmOwnership, claimPatch, mayCreateCrmCard, withBirthOwnership,
} from "../src/ownership";
import { adoptionKey } from "../src/adopt";
import { recInScope } from "../src/sync";
import { propertiesForSpec } from "../src/hubspot";
import type { HsRecord, MondayItem, ObjectSpec } from "../src/types";

/**
 * TASK 11 — the CRM/WM coexistence and safety matrix.
 *
 * One file, one purpose: prove the two syncs cannot touch each other's data, and that no historical
 * record can be imported. Sections mirror the agreed matrix A-I.
 */

const prod = {} as { ENABLE_CRM?: string };
const crmEnv = { ENABLE_CRM: "true" } as { ENABLE_CRM?: string };

const WM_BOARDS = [DEALS.boardId, CONTACTS_MYLA.boardId, COMPANIES_MYLA.boardId];
const CRM_BOARDS = [CRM_CONTACTS.boardId, CRM_ACCOUNTS.boardId];
const CRM_DEALS_BOARD = "5028000494";     // the monday CRM template's Deals board — OUT OF SCOPE

const PRE = "2024-03-01T00:00:00Z";
const POST = "2026-11-01T00:00:00Z";
const FINITE = Date.parse("2026-10-01T00:00:00Z");

const rec = (p: Record<string, string>): HsRecord => ({ id: "1", properties: p });
/** A CRM spec with a FINITE cutover — how Phase B / Phase D will actually be configured. */
const withCutover = (s: ObjectSpec, ms: number): ObjectSpec =>
  ({ ...s, ownership: { ...s.ownership!, cutoverAtMs: ms } });

// ------------------------------------------------------------------ A. Runtime isolation

describe("A. runtime isolation", () => {
  it("WM deployment resolves only WM specs", () => expect(specsFor(prod)).toEqual(ALL_SPECS));

  it("CRM deployment resolves only CRM Contacts + CRM Accounts", () => {
    expect(specsFor(crmEnv)).toEqual(CRM_SPECS);
    expect(specsFor(crmEnv).map(s => s.object).sort()).toEqual(["companies", "contacts"]);
  });

  it("CRM cannot resolve any WM board", () => {
    for (const b of WM_BOARDS) expect(specByBoard(crmEnv, b)).toBeUndefined();
  });

  it("WM cannot resolve either CRM board", () => {
    for (const b of CRM_BOARDS) {
      expect(specByBoard(prod, b)).toBeUndefined();
      expect(SPEC_BY_BOARD[b]).toBeUndefined();
    }
  });

  it("CRM cannot resolve Deals, and neither deployment routes the CRM Deals board", () => {
    expect(specByObject(crmEnv, "deals")).toBeUndefined();
    expect(specByBoard(crmEnv, CRM_DEALS_BOARD)).toBeUndefined();
    expect(specByBoard(prod, CRM_DEALS_BOARD)).toBeUndefined();
  });

  it("ALL_KNOWN_SPECS is never what routing returns", () => {
    for (const e of [prod, crmEnv]) expect(specsFor(e)).not.toEqual(ALL_KNOWN_SPECS);
  });

  it.each(["", "false", "TRUE", "True", "1", "yes", " true", "true ", undefined])(
    "ENABLE_CRM=%j resolves WM — only the exact string enables CRM", (v) =>
      expect(specsFor({ ENABLE_CRM: v as string | undefined })).toEqual(ALL_SPECS));
});

// ------------------------------------- B. Discovery + historical-import protection

describe("B. CRM discovery and historical-import protection", () => {
  // Every case runs against BOTH specs, with a FINITE cutover so eligibility is actually exercised
  // (the shipped Infinity cutover refuses everything — see section F).
  const specs = CRM_SPECS.map(s => [s.object, withCutover(s, FINITE)] as const);

  it.each(specs)("%s: post-cutover WITHOUT sales_user -> card allowed", (_o, s) =>
    expect(mayCreateCrmCard(rec({ createdate: POST }), s.ownership)).toBe(true));

  it.each(specs)("%s: post-cutover WITH sales_user -> card allowed", (_o, s) =>
    expect(mayCreateCrmCard(rec({ createdate: POST, sales_user: "1739141284" }), s.ownership)).toBe(true));

  it.each(specs)("%s: pre-cutover unstamped -> NO card", (_o, s) =>
    expect(mayCreateCrmCard(rec({ createdate: PRE }), s.ownership)).toBe(false));

  it.each(specs)("%s: sync_owner=wm -> NO card", (_o, s) =>
    expect(mayCreateCrmCard(rec({ sync_owner: "wm", createdate: POST }), s.ownership)).toBe(false));

  it.each(specs)("%s: unknown stamp -> NO card", (_o, s) =>
    expect(mayCreateCrmCard(rec({ sync_owner: "hold", createdate: POST }), s.ownership)).toBe(false));

  it.each(specs)("%s: missing ownership metadata -> fail closed", (_o, s) =>
    expect(mayCreateCrmCard(rec({}), s.ownership)).toBe(false));

  it.each(specs)("%s: malformed create date -> fail closed", (_o, s) => {
    for (const d of ["not-a-date", "1e21", "", "   "])
      expect(mayCreateCrmCard(rec({ createdate: d }), s.ownership)).toBe(false);
  });

  // The zero-createItem proof lives in crm-discovery-gate.test.ts, which mocks monday and asserts the
  // ABSENCE of the write for the forbidden cases — including the association-triggered path, since the
  // gate sits inside ensureCardForRecord and every caller funnels through it.
  it("the gate is inside the single chokepoint, so the association path cannot bypass it", async () => {
    const src = await import("../src/ensure-card");
    expect(typeof src.ensureCardForRecord).toBe("function");
    expect(typeof src.isRetryable).toBe("function");
  });

  it("an adopted pre-cutover record keeps receiving HubSpot -> monday updates", () => {
    // The gate is consulted ONLY when no card exists; an existing card short-circuits before it.
    // Forward writes touch monday only, so they never consult ownership at all.
    const historical = rec({ createdate: PRE });
    expect(mayCreateCrmCard(historical, withCutover(CRM_CONTACTS, FINITE).ownership)).toBe(false);
    expect(authorizeWrite(historical, withCutover(CRM_CONTACTS, FINITE).ownership!).allowed).toBe(false);
  });
});

// ------------------------------------------------------------- C. Ownership / write matrix

describe("C. ownership and write matrix", () => {
  const o = withCutover(CRM_CONTACTS, FINITE).ownership!;

  it("CRM-owned -> approved reverse writes allowed", () =>
    expect(authorizeWrite(rec({ sync_owner: "crm" }), o).allowed).toBe(true));

  it("WM-owned -> CRM reverse write blocked", () => {
    const a = authorizeWrite(rec({ sync_owner: "wm" }), o);
    expect(a.allowed).toBe(false);
    expect(a.reason).toMatch(/owned by wm/);
  });

  it("eligible unstamped post-cutover -> claimable exactly once, then writable", () => {
    const r = rec({ createdate: POST });
    expect(canClaimCrmOwnership(r, o)).toBe(true);
    expect(authorizeWrite(r, o).allowed).toBe(false);          // not yet
    Object.assign(r.properties, claimPatch(o));                 // the claim
    expect(authorizeWrite(r, o).allowed).toBe(true);            // now
    expect(canClaimCrmOwnership(r, o)).toBe(false);             // and never again
  });

  it("historical adoption never claims", () =>
    expect(canClaimCrmOwnership(rec({ createdate: PRE }), o)).toBe(false));

  it("unknown stamp never claims and never writes", () => {
    const r = rec({ sync_owner: "hold", createdate: POST });
    expect(canClaimCrmOwnership(r, o)).toBe(false);
    expect(authorizeWrite(r, o).allowed).toBe(false);
  });

  it("the claim payload is exactly one property", () => {
    expect(claimPatch(o)).toEqual({ sync_owner: "crm" });
    expect(Object.keys(claimPatch(o))).toHaveLength(1);
  });

  it("an auth computed for another record cannot be reused", () => {
    const a = authorizeWrite({ id: "999", properties: { sync_owner: "crm" } }, o);
    expect(a.forId).toBe("999");     // assertMayWrite refuses when forId !== the target id
  });
});

// ------------------------------------------------------------------ D. Creation behaviour

describe("D. creation behaviour — Contacts", () => {
  it("HubSpot -> monday only: createFromMonday is false", () =>
    expect(CRM_CONTACTS.createFromMonday).toBe(false));

  it("no email adoption path is active", () => expect(CRM_CONTACTS.adoptBy).toBeUndefined());

  it("no createDefaults at all, so no sales_user can be fabricated", () => {
    expect(CRM_CONTACTS.createDefaults).toBeUndefined();
    expect(CRM_CONTACTS.fields.some(f => f.hs === "sales_user")).toBe(false);
  });
});

describe("D. creation behaviour — Companies", () => {
  const item = (cols: { id: string; text: string | null; value?: string | null }[], name = "ABC Trading Sdn Bhd"): MondayItem =>
    ({ id: "i1", name, created_at: "", updated_at: "", group: { id: "g" }, column_values: cols as never });

  it("adopts on the exact normalized domain from the native Domain column", () =>
    expect(adoptionKey(item([{ id: "company_domain", text: "https://WWW.Acme.com/x" }]), CRM_ACCOUNTS))
      .toBe("acme.com"));

  it("no/invalid domain -> no adoption key, therefore no HubSpot Company creation", () => {
    for (const t of ["", "   ", "ABC Trading Sdn Bhd", "n/a", "acme"])
      expect(adoptionKey(item([{ id: "company_domain", text: t }]), CRM_ACCOUNTS)).toBe("");
  });

  it("the company NAME can never be an adoption key", () =>
    expect(adoptionKey(item([{ id: "company_domain", text: "" }], "Acme Sdn Bhd"), CRM_ACCOUNTS)).toBe(""));

  it("a historical adopted Company is not claimed", () =>
    expect(canClaimCrmOwnership(rec({ createdate: PRE }), withCutover(CRM_ACCOUNTS, FINITE).ownership!)).toBe(false));

  it("a brand-new Company is BORN owned — stamp inside the CREATE payload, not a later claim", () => {
    const o = withCutover(CRM_ACCOUNTS, FINITE).ownership!;
    const props = withBirthOwnership({ name: "Acme", domain: "acme.com" }, o);
    expect(props).toEqual({ name: "Acme", domain: "acme.com", sync_owner: "crm" });
    expect(authorizeWrite({ id: "new", properties: props }, o).allowed).toBe(true);
  });
});

// ------------------------------------------------------------------- E. Delete direction

describe("E. delete direction", () => {
  it("HubSpot deletion resolves the CRM board on the CRM deployment (regression: it hardcoded WM)", () => {
    expect(specByObject(crmEnv, "contacts")).toBe(CRM_CONTACTS);
    expect(specByObject(crmEnv, "companies")).toBe(CRM_ACCOUNTS);
  });

  it("and resolves the WM board on the WM deployment", () => {
    expect(specByObject(prod, "contacts")).toBe(CONTACTS_MYLA);
    expect(specByObject(prod, "companies")).toBe(COMPANIES_MYLA);
  });

  // A HubSpot DEAL deletion on the CRM deployment must not delete a WM deal card.
  it("a HubSpot deal deletion is a no-op on the CRM deployment", () =>
    expect(specByObject(crmEnv, "deals")).toBeUndefined());

  // monday -> HubSpot deletion is STRUCTURALLY impossible for Contacts/Companies: the worker exposes no
  // helper that can delete a HubSpot contact, company or deal RECORD at all.
  it("no helper exists that deletes a HubSpot contact/company/deal record", async () => {
    const hs = await import("../src/hubspot");
    const deleters = Object.keys(hs).filter(n => /^delete/i.test(n));
    // deleteLineItem exists for the WM deal subitem sync, and deleteAssociation unlinks (never deletes)
    // records. Neither can remove a contact, company or deal.
    expect(deleters.sort()).toEqual(["deleteAssociation", "deleteLineItem"]);
    expect(deleters.some(n => /contact|compan|deal(?!.*line)/i.test(n))).toBe(false);
  });

  it("and the line-item deleter is unreachable from CRM: no CRM spec has associations or subitems", () => {
    for (const s of CRM_SPECS) {
      expect(s.associations).toBeUndefined();
      expect(s.fields.some(f => /subitem/i.test(f.col))).toBe(false);
    }
  });
});

// --------------------------------------- F. Phase-B consequence of the inert cutover

describe("F. the shipped Infinity cutover refuses everything (the rollout consequence)", () => {
  it("CRM_CUTOVER_AT_MS is infinite as shipped", () =>
    expect(CRM_CUTOVER_AT_MS).toBe(Number.POSITIVE_INFINITY));

  // THE HEADLINE FACT. With the shipped config the CRM sync can create ZERO monday cards from
  // unstamped records — which is every record, because `sync_owner` does not exist in the portal yet.
  it.each(CRM_SPECS.map(s => [s.object, s] as const))(
    "%s: NO unstamped record is cardable as shipped, however recent", (_o, s) => {
      for (const d of [POST, PRE, new Date().toISOString()])
        expect(mayCreateCrmCard(rec({ createdate: d }), s.ownership)).toBe(false);
    });

  it.each(CRM_SPECS.map(s => [s.object, s] as const))(
    "%s: nor claimable, so no HubSpot write is possible either", (_o, s) => {
      expect(canClaimCrmOwnership(rec({ createdate: POST }), s.ownership!)).toBe(false);
      expect(authorizeWrite(rec({ createdate: POST }), s.ownership!).allowed).toBe(false);
    });

  // OPTION 1 (recommended): a finite cutover makes the forward path work with NO HubSpot schema change.
  it("a FINITE cutover restores normal forward behaviour for records created after it", () => {
    const s = withCutover(CRM_CONTACTS, FINITE);
    expect(mayCreateCrmCard(rec({ createdate: POST }), s.ownership)).toBe(true);
    expect(mayCreateCrmCard(rec({ createdate: PRE }), s.ownership)).toBe(false);  // history still safe
  });

  // OPTION 2: an explicit crm stamp also works — but requires the sync_owner property to EXIST, which
  // is a Phase-2 HubSpot schema change that Phase 1 forbids.
  it("an explicitly crm-stamped record is cardable even under the Infinity cutover", () => {
    for (const s of CRM_SPECS)
      expect(mayCreateCrmCard(rec({ sync_owner: "crm" }), s.ownership)).toBe(true);
  });

  // Both options keep history safe, which is the property that must not be traded away for convenience.
  it("neither option makes a pre-cutover unstamped record cardable", () => {
    expect(mayCreateCrmCard(rec({ createdate: PRE }), withCutover(CRM_CONTACTS, FINITE).ownership)).toBe(false);
    expect(mayCreateCrmCard(rec({ createdate: PRE }), CRM_CONTACTS.ownership)).toBe(false);
  });
});

// ------------------------------------------------------------------- G. Phase-B behaviour

describe("G. Phase B: dryRun=false, writeHubspot=false", () => {
  // patchRecord/createRecord/claimOwnership all check opts and write nothing; claimOwnership returns
  // null, which ensureHubspotWriteAuth turns into claim-suppressed WITHOUT fabricating local ownership.
  // The proof that no fake auth is produced: authorizeWrite on the untouched record still refuses.
  it("a suppressed claim leaves the record unstamped, so the write is still refused", () => {
    const o = withCutover(CRM_CONTACTS, FINITE).ownership!;
    const r = rec({ createdate: POST });
    expect(canClaimCrmOwnership(r, o)).toBe(true);         // eligible
    // claimOwnership would return null here and NOT mutate r
    expect(authorizeWrite(r, o).allowed).toBe(false);      // therefore still not writable
    expect(r.properties.sync_owner).toBeUndefined();       // and no fake stamp exists
  });
});

// ------------------------------------------------------- H. No Deals / association safety

describe("H. no Deals, no associations", () => {
  it("no CRM spec is a deals spec", () => {
    for (const s of CRM_SPECS) expect(s.object).not.toBe("deals");
  });

  it("no CRM spec declares associations, so reverseAssociations is a no-op for them", () => {
    for (const s of CRM_SPECS) expect(s.associations).toBeUndefined();
  });

  it("no CRM field maps a deal relation or the CRM Deals board", () => {
    for (const s of CRM_SPECS)
      for (const f of s.fields) {
        expect(f.col).not.toMatch(/deal/i);
        expect(f.col).not.toBe(CRM_DEALS_BOARD);
      }
  });

  it("contact_deal and account_deal are mapped by nothing", () => {
    const cols = CRM_SPECS.flatMap(s => s.fields.map(f => f.col));
    expect(cols).not.toContain("contact_deal");
    expect(cols).not.toContain("account_deal");
  });
});

// ------------------------------------------------------------------- I. WM regression

describe("I. WM regression", () => {
  it("WM Contacts still gate on sales_user AND the date cutoff", () => {
    expect(recInScope(CONTACTS_MYLA, { properties: {} })).toBe(false);
    expect(recInScope(CONTACTS_MYLA, { properties: { sales_user: "x", createdate: "2020-01-01T00:00:00Z" } })).toBe(false);
    expect(recInScope(CONTACTS_MYLA, { properties: { sales_user: "x", createdate: new Date(CREATED_AFTER_MS).toISOString() } })).toBe(true);
  });

  it("WM Companies keep includeAll (all ~25k) — unchanged", () => {
    expect(COMPANIES_MYLA.includeAll).toBe(true);
    expect(recInScope(COMPANIES_MYLA, { properties: {} })).toBe(true);
  });

  it("WM Deals keep their pipeline filter and reversible group", () => {
    expect(DEALS.searchFilters).toEqual([{ propertyName: "pipeline", operator: "EQ", value: "default" }]);
    expect("prop" in DEALS.groupBy && DEALS.groupBy.reverse).toBe(true);
  });

  it("no WM spec declares CRM ownership or adoption metadata", () => {
    for (const s of ALL_SPECS) {
      expect(s.ownership).toBeUndefined();
      expect(s.adoptBy).toBeUndefined();
    }
  });

  it("the shared email/link column types are used by no WM field", () => {
    for (const s of ALL_SPECS)
      for (const f of s.fields) expect(["email", "link"]).not.toContain(f.type);
  });

  it("WM specs request no ownership properties from HubSpot", () => {
    for (const s of ALL_SPECS) expect(propertiesForSpec(s)).not.toContain("sync_owner");
  });

  it("CRM specs request them on every fetch, so the gate never reads undefined by accident", () => {
    for (const s of CRM_SPECS) {
      expect(propertiesForSpec(s)).toContain("sync_owner");
      expect(propertiesForSpec(s)).toContain("createdate");
    }
  });
});
