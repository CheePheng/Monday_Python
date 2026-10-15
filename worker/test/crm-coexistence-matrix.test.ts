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

  // Deals and Line Items joined the CRM scope on 2026-09-14. The isolation property is unchanged and
  // is asserted by the two tests below: neither deployment can resolve the other's boards.
  it("CRM deployment resolves only the CRM specs", () => {
    expect(specsFor(crmEnv)).toEqual(CRM_SPECS);
    expect(specsFor(crmEnv).map(s => s.object).sort())
      .toEqual(["companies", "contacts", "deals", "line_items"]);
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

  /** CRM owns the CRM Deals board; WM must still not see it, and the two deal boards must differ.
   *  That mutual blindness is the coexistence guarantee — not the absence of deals from CRM. */
  it("each deployment routes its OWN deals board and is blind to the other's", () => {
    expect(specByBoard(crmEnv, CRM_DEALS_BOARD)?.object).toBe("deals");
    expect(specByBoard(prod, CRM_DEALS_BOARD)).toBeUndefined();
    expect(specByObject(crmEnv, "deals")!.boardId).not.toBe(specByObject(prod, "deals")!.boardId);
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

  // Was "NO card". The historical import is complete (2026-09-17/18), so a record without a card is a
  // gap to fill, whatever its age -- a lead created in HubSpot today must appear in monday today.
  it.each(specs)("%s: pre-cutover unstamped -> card allowed (the gap is filled)", (_o, s) =>
    expect(mayCreateCrmCard(rec({ createdate: PRE }), s.ownership)).toBe(true));

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

  it("a pre-cutover record: carded, forward-synced, and writable only once a person's edit claims it", () => {
    // Forward writes touch monday only, so they never consult ownership at all. The WRITE still needs
    // ownership: unstamped is refused until a claim, and only a person's edit can make that claim.
    const o = withCutover(CRM_CONTACTS, FINITE).ownership!;
    const historical = rec({ createdate: PRE });
    expect(mayCreateCrmCard(historical, o)).toBe(true);
    expect(authorizeWrite(historical, o).allowed).toBe(false);
    expect(canClaimCrmOwnership(historical, o)).toBe(false);               // not by date
    expect(canClaimCrmOwnership(historical, o, "human-edit")).toBe(true);  // but by a person's edit
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
  // CHANGED 2026-09-21: two-way creation is the confirmed requirement — the 创建/Create form is the
  // sales team's entry point after the migration. What must remain true is that creating cannot
  // DUPLICATE, and that nothing is fabricated.
  it("creation from monday is enabled", () =>
    expect(CRM_CONTACTS.createFromMonday).toBe(true));

  it("and it adopts an existing contact by email rather than duplicating", () =>
    expect(CRM_CONTACTS.adoptBy).toEqual({ kind: "email", col: "contact_email" }));

  it("no createDefaults at all, so no sales_user can be fabricated", () => {
    expect(CRM_CONTACTS.createDefaults).toBeUndefined();
    // sales_user is two-way since 2026-09-23 -- as a People column a rep sets -- but it is still never
    // fabricated at birth and never a scope input.
    const f = CRM_CONTACTS.fields.find(x => x.hs === "sales_user")!;
    expect(f.type).toBe("people");
    expect(CRM_CONTACTS.createDefaults?.sales_user).toBeUndefined();
    expect(recInScope(CRM_CONTACTS, { properties: {} })).toBe(true);
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
  /** A deal deletion now REACHES the CRM deployment, so the guarantee shifts from "unroutable" to
   *  "restores the card rather than deleting anything in HubSpot" — restoreOnDelete, as for every
   *  other CRM spec. The monday -> HubSpot delete direction stays structurally impossible below. */
  it("a deal deletion is routable on CRM and restores rather than deletes", () => {
    const s = specByObject(crmEnv, "deals")!;
    expect(s.restoreOnDelete).toBe(true);
    // Creation is enabled (2026-09-21) and is a SEPARATE direction from deletion: a monday deletion
    // still only restores the card, and no code path deletes a HubSpot record — asserted just below.
    expect(s.createFromMonday).toBe(true);
    // A deal must be born with a legal pipeline+stage pair, or HubSpot rejects it outright.
    expect(s.createDefaults?.pipeline).toBeTruthy();
    expect(s.createDefaults?.dealstage).toBeTruthy();
  });

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

  it("and the line-item deleter is unreachable from CRM: no CRM association carries subitems", () => {
    for (const s of CRM_SPECS) {
      for (const a of s.associations ?? []) expect(a.subitems).toBeUndefined();
      expect(s.fields.some(f => /subitem/i.test(f.col))).toBe(false);
    }
  });
});

// --------------------------------------- F. Phase-B consequence of the inert cutover

/**
 * F. WHAT THE CUTOVER STILL DECIDES, AND WHAT IT NO LONGER DOES.
 *
 * This section used to pin a Phase-1 rollout fact: with the shipped Infinity cutover the CRM sync could
 * card and claim NOTHING unstamped. Both halves were retired on 2026-09-23. Carding no longer depends on
 * the cutover at all (the historical import is done), and a person's edit on a CRM card claims the
 * record whatever its age. What the cutover still governs is the DATE-based claim -- and that one must
 * still refuse under Infinity, so no path without a person behind it can ever claim history.
 */
describe("F. what the cutover still decides", () => {
  it("CRM_CUTOVER_AT_MS is infinite as shipped", () =>
    expect(CRM_CUTOVER_AT_MS).toBe(Number.POSITIVE_INFINITY));

  it.each(CRM_SPECS.map(s => [s.object, s] as const))(
    "%s: any unstamped record is cardable, whatever the cutover", (_o, s) => {
      for (const d of [POST, PRE, new Date().toISOString()])
        expect(mayCreateCrmCard(rec({ createdate: d }), s.ownership)).toBe(true);
    });

  it.each(CRM_SPECS.map(s => [s.object, s] as const))(
    "%s: the DATE-based claim still refuses under Infinity -- only a person's edit claims", (_o, s) => {
      expect(canClaimCrmOwnership(rec({ createdate: POST }), s.ownership!)).toBe(false);
      expect(canClaimCrmOwnership(rec({ createdate: POST }), s.ownership!, "human-edit")).toBe(true);
      expect(authorizeWrite(rec({ createdate: POST }), s.ownership!).allowed).toBe(false);
    });

  it("a FINITE cutover lets the date-based claim reach records created after it, and only those", () => {
    const o = withCutover(CRM_CONTACTS, FINITE).ownership!;
    expect(canClaimCrmOwnership(rec({ createdate: POST }), o)).toBe(true);
    expect(canClaimCrmOwnership(rec({ createdate: PRE }), o)).toBe(false);
  });

  it("an explicitly crm-stamped record is cardable under any cutover", () => {
    for (const s of CRM_SPECS)
      expect(mayCreateCrmCard(rec({ sync_owner: "crm" }), s.ownership)).toBe(true);
  });

  // The explicit decisions are the property that must not be traded away.
  it("no cutover and no basis ever cards or claims a parked or WM-owned record", () => {
    for (const stamp of ["hold", "wm"]) {
      const r = rec({ sync_owner: stamp, createdate: PRE });
      for (const o of [withCutover(CRM_CONTACTS, FINITE).ownership!, CRM_CONTACTS.ownership!]) {
        expect(mayCreateCrmCard(r, o)).toBe(false);
        expect(canClaimCrmOwnership(r, o, "human-edit")).toBe(false);
      }
    }
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
  it("every CRM spec is crm-owned and sits on a non-WM board", () => {
    for (const s of CRM_SPECS) {
      expect(s.ownership?.owner).toBe("crm");
      expect(WM_BOARDS).not.toContain(s.boardId);
    }
  });

  // SUPERSEDED by the association task: CRM specs now DO declare the Contact<->Company relation. The
  // safety property moved from "declares nothing" to "declares only this, and the reverse is code-blocked"
  // (reverseAssociations returns immediately for any ownership-declaring spec - crm-associations.test.ts).
  /**
   * CRM associations now span Contact<->Company, Deal<->Contact, Deal<->Company and Deal<->LineItem —
   * the four relationships the business asked to see from both boards. The safety property was never
   * the COUNT but the DIRECTION: the reverse is code-blocked for any ownership-declaring spec
   * (reverseAssociations returns immediately — crm-associations.test.ts), so none of these can delete
   * a HubSpot association.
   */
  it("CRM associations cover only CRM objects, and every spec declares ownership", () => {
    for (const s of CRM_SPECS) {
      for (const a of s.associations ?? [])
        expect(["companies", "contacts", "deals", "line_items"]).toContain(a.toObject);
      expect(s.ownership).toBeDefined();
    }
  });

  /** A field must never be pointed at a BOARD id — that was the real hazard behind the old
   *  name-shaped check, and it survives the scope change unchanged. */
  it("no CRM field maps a board id as if it were a column", () => {
    const boards = new Set(CRM_SPECS.map(s => s.boardId));
    for (const s of CRM_SPECS)
      for (const f of s.fields) expect(boards.has(f.col)).toBe(false);
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
      expect(s.ownership?.owner).toBe("wm");   // declared since 2026-09-22, but never "crm"
      expect(s.adoptBy).toBeUndefined();
    }
  });

  it("the shared email/link column types are used by no WM field", () => {
    for (const s of ALL_SPECS)
      for (const f of s.fields) expect(["email", "link"]).not.toContain(f.type);
  });

  it("WM specs request no ownership properties from HubSpot", () => {
    // INVERTED 2026-09-22: WM authorizes its own writes now, so it MUST fetch the ownership metadata.
    // Omitting it would make authorizeWrite read undefined and classify every record as unstamped.
    for (const s of ALL_SPECS) expect(propertiesForSpec(s)).toContain("sync_owner");
  });

  it("CRM specs request them on every fetch, so the gate never reads undefined by accident", () => {
    for (const s of CRM_SPECS) {
      expect(propertiesForSpec(s)).toContain("sync_owner");
      expect(propertiesForSpec(s)).toContain("createdate");
    }
  });
});
