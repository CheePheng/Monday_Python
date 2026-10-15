import { describe, it, expect } from "vitest";
import { CRM_CONTACTS, CRM_ACCOUNTS, CRM_SPECS, CRM_CUTOVER_AT_MS, CRM_CREATE_CUTOFF_MS } from "../src/config/crm";
import { ALL_SPECS, CONTACTS_MYLA, COMPANIES_MYLA, DEALS } from "../src/config";
import { propertiesForSpec } from "../src/hubspot";
import { recInScope } from "../src/sync";
import { mayCreateCrmCard } from "../src/ownership";

// Every id asserted here was captured from the live boards after Task 5 and is authoritative. The
// pre-Task-5 stubs were DELETED (monday cannot retype a column), so referencing one is a real bug.
const DEAD_STUBS = [
  "text_mm6t8x04", "text_mm6sdc3b", "text_mm6tqwyw", "text_mm6t4jp", "text_mm6tghg4",
  "text_mm6t6w6n", "text_mm6t8r57", "text_mm6t7rpd", "text_mm6t1n5g",
  "numeric_mm6swz9c", "12849070_last_name", "text_mm6t40d7", "text_mm6s7db3",
  "text_mm6s40ew", "text_mm6t68sz", "text_mm6tyx9z", "text_mm6thg86", "text_mm6t638", "text_mm6tvb8q", "text_mm6t5nqt",
  // Deleted from the Contacts board on 2026-09-08 by someone working directly in monday, while the spec
  // still mapped `company` to it. monday rejects an entire change_multiple_column_values mutation that
  // names an unknown column, so that one dead reference would have stopped every Contact card updating.
  "text_mm6sdvkq",
];

const colsOf = (s: typeof CRM_CONTACTS) =>
  [s.idCol, s.syncStateCol, s.linkCol ?? "", ...s.fields.map(f => f.col)].filter(Boolean);

describe("no deleted stub id survives anywhere in the CRM specs", () => {
  it.each(CRM_SPECS.map(s => [s.object, s] as const))("%s references only live columns", (_o, spec) => {
    for (const c of colsOf(spec)) expect(DEAD_STUBS).not.toContain(c);
  });
});

describe("CRM_CONTACTS", () => {
  it("targets the right board, columns and group", () => {
    expect(CRM_CONTACTS.boardId).toBe("5028000495");
    expect(CRM_CONTACTS.idCol).toBe("text_mm6t71dj");
    expect(CRM_CONTACTS.syncStateCol).toBe("text_mm6twy4w");
    expect(CRM_CONTACTS.linkCol).toBe("link_mm6z7mj");
    // placeOnly: new cards land in "topics"; the Worker never moves a card (the boss's directive).
    expect(CRM_CONTACTS.groupBy).toEqual({ singleGroup: "topics", placeOnly: true });
  });

  it("uses `lastmodifieddate`, not the deal/company property", () =>
    expect(CRM_CONTACTS.modifiedProp).toBe("lastmodifieddate"));

  // THE 2026-09-07 MEETING DECISION.
  /**
   * CHANGED 2026-09-21. Creation from monday is now REQUIRED — the 创建/Create form is how the sales
   * team adds contacts after the migration — so the assertion moves from "creation is impossible" to
   * "creation cannot duplicate". `createDefaults` stays absent deliberately: a Contact needs no
   * manufactured property to be valid, and `sales_user` in particular must never be fabricated.
   */
  it("creation is enabled, adopts by email, and still manufactures nothing", () => {
    expect(CRM_CONTACTS.createFromMonday).toBe(true);
    expect(CRM_CONTACTS.adoptBy).toEqual({ kind: "email", col: "contact_email" });
    expect(CRM_CONTACTS.createDefaults).toBeUndefined();
  });

  /** The adoption key must reach the birth payload, or createFromMonday refuses the create outright. */
  // Two-way from 2026-09-23 so a rep can fix a typo'd address. Email is the adoption key only at CREATE;
  // a card that already has a HubSpot ID is linked by that id, so editing the email cannot re-point it.
  it("email is written at birth AND is two-way afterwards", () => {
    const email = CRM_CONTACTS.fields.find(f => f.hs === "email")!;
    expect(email.col).toBe("contact_email");
    expect(email.writeOnCreate).toBe(true);
    expect(email.reverse).toBe(true);
    expect(CRM_CONTACTS.columnLevelReverse).toBe(true);   // pushed only when someone edits that cell
  });

  // Two-way since 2026-09-23 (see the field's note in crm.ts). What still must hold: sales_user is never
  // FABRICATED, it never decides scope, and it reaches HubSpot only as a monday PERSON a rep chose.
  it("never manufactures sales_user; two-way only as a People column, on a column-level spec", () => {
    expect(CRM_CONTACTS.createDefaults).toBeUndefined();
    expect(CRM_CONTACTS.createDefaults?.sales_user).toBeUndefined();
    expect(CRM_CONTACTS.columnLevelReverse).toBe(true);
    const f = CRM_CONTACTS.fields.find(x => x.hs === "sales_user")!;
    // A PEOPLE COLUMN since 2026-09-15, replacing the single-select dropdown. monday's assignment
    // permission can only be configured against a People column, and Sales User is now the one
    // assignment field the team uses — so the dropdown could not stay.
    //
    // It also retires the dropdown's own objection to ever going two-way: a label could not resolve
    // back to one owner, because "Rick Antonio" names two owner ids. A People column resolves through
    // monday user -> email -> owner id (an email shared by two owners resolves to nothing). The WM-scope
    // coupling that kept it forward-only until 2026-09-23 is an accepted side effect now; see crm.ts.
    expect(f).toMatchObject({ col: "multiple_person_mm76ygkp", type: "people" });
    expect(f.reverse).toBe(true);
    expect(f.appReverse).toBeUndefined();
    expect(f.backfill).toBeUndefined();
  });

  it("and sales_user still plays NO part in CRM scope", () => {
    expect(recInScope(CRM_CONTACTS, { properties: {} })).toBe(true);
    expect(recInScope(CRM_CONTACTS, { properties: { sales_user: "" } })).toBe(true);
  });

  it("declares crm ownership with the inert Phase-1 cutover", () => {
    expect(CRM_CONTACTS.ownership).toEqual({
      prop: "sync_owner", createdProp: "createdate", owner: "crm", cutoverAtMs: Number.POSITIVE_INFINITY,
    });
    expect(CRM_CUTOVER_AT_MS).toBe(Number.POSITIVE_INFINITY);
    expect(CRM_CREATE_CUTOFF_MS).toBe(Number.POSITIVE_INFINITY);
  });

  it("email is the native email column, two-way, never a backfill", () => {
    const f = CRM_CONTACTS.fields.find(x => x.hs === "email")!;
    expect(f).toMatchObject({ col: "contact_email", type: "email", reverse: true });
    expect(f.backfill).toBeUndefined();
  });

  it("phone uses the native phone column", () =>
    expect(CRM_CONTACTS.fields.find(f => f.hs === "phone")).toMatchObject({ col: "contact_phone", type: "phone" }));

  it("owner is appReverse, never a plain reverse (the 2026-08-28 reassignment incident)", () => {
    const f = CRM_CONTACTS.fields.find(x => x.hs === "hubspot_owner_id")!;
    expect(f).toMatchObject({ col: "multiple_person_mm6zap53", type: "people", appReverse: true });
    expect(f.reverse).toBeUndefined();
  });

  it("hs_lead_status is two-way on the seeded status column", () =>
    expect(CRM_CONTACTS.fields.find(f => f.hs === "hs_lead_status"))
      .toMatchObject({ col: "color_mm6zb4tc", type: "status", labels: "leadStatus", reverse: true }));

  // All THREE status ladders stay mapped: each is pinned to the HubSpot contact sidebar, which is the
  // portal owner's statement of intent. Fill rate alone is not grounds for dropping one.
  it("keeps all three status ladders — hs_lead_status, lifecyclestage (EN), leadstatus/状态 (ZH)", () => {
    expect(CRM_CONTACTS.fields.find(f => f.hs === "lifecyclestage"))
      .toMatchObject({ col: "color_mm70k2wk", type: "status", labels: "lifecycleStage" });
    expect(CRM_CONTACTS.fields.find(f => f.hs === "leadstatus"))
      .toMatchObject({ col: "color_mm70v2cd", type: "status", labels: "contactStatus" });
  });

  // Two-way from 2026-09-09. The 210 legacy options were never an argument against reversing it, only
  // against putting them in a monday dropdown — the column stays TEXT and the validated-text branch
  // checks membership on the way back. It is also the one field of the four text-enums where the
  // dictionary genuinely TRANSLATES rather than only validating ("Others" -> "其他").
  it("leadsource is two-way, validated against its 210-option dictionary", () => {
    const f = CRM_CONTACTS.fields.find(x => x.hs === "leadsource")!;
    expect(f).toMatchObject({ col: "text_mm6sc26t", type: "text", labels: "contactSource", reverse: true });
    expect(f.unvalidatedEnum).toBeUndefined();
  });

  it("createdate is one-way and never reversible", () => {
    const f = CRM_CONTACTS.fields.find(x => x.hs === "createdate")!;
    expect(f).toMatchObject({ col: "date_mm6z33nk", type: "date", oneWay: true });
    expect(f.reverse).toBeUndefined();
    expect(f.backfill).toBeUndefined();
  });

  it("a renamed card cannot rewrite the HubSpot name", () => {
    expect(CRM_CONTACTS.nameProps).toEqual(["firstname", "lastname"]);
    expect(CRM_CONTACTS.nameReverse).toBeUndefined();
  });

  // Vendors is TWO-WAY as of 2026-09-09. The hazard was never "showing it" — it was an unvalidated
  // monday edit reaching an 89-option MULTI-VALUE HubSpot enum (a live record holds
  // "49HubSpot;55Aircall"), so a typo would have entered the enumeration. The stated prerequisite was
  // a seeded multi-select dropdown, and that is exactly what this now is: a `dropdown` carrying the
  // `contactVendor` dictionary, which makes the reverse path VALIDATE — each comma-separated label is
  // looked up and an unknown one is DROPPED rather than sent. `labels` is therefore not cosmetic here;
  // it is the safety mechanism, so the assertion keeps it pinned alongside `reverse`.
  it("maps manufacturer__c TWO-WAY, and only because the dropdown dictionary validates the write", () => {
    const f = CRM_CONTACTS.fields.find(x => x.hs === "manufacturer__c")!;
    expect(f).toMatchObject({
      col: "dropdown_mm70zvnw", type: "dropdown", labels: "contactVendor", reverse: true,
    });
    expect(f.backfill).toBeUndefined();
  });

  // Approved 2026-09-07 from the mapping sheet; two-way from 2026-09-09. HubSpot `event_name` is
  // verified FREE TEXT with no enumeration to corrupt, so there is nothing for a reverse write to
  // violate — a rep correcting an event name is exactly the intent of "monday is the working system".
  it("event_name is mapped TWO-WAY onto the existing Event Name column — free text, no enum", () => {
    const f = CRM_CONTACTS.fields.find(x => x.hs === "event_name")!;
    expect(f).toMatchObject({ col: "text_mm6t8bxb", type: "text", reverse: true });
    expect(f.appReverse).toBeUndefined();
    expect(f.backfill).toBeUndefined();
  });

  // DECISIONS HELD FROM THE 2026-09-07 REQUIREMENTS REVIEW. Each of these must stay unmapped; the
  // mapping sheet lists some of them and they must not be wired up on name similarity alone.
  // priority__c now has its OWN column. The property that mattered is unchanged and is the real
  // guard: HubSpot's SLA (P1_2小时内 …) must never be written into monday's NATIVE Priority column,
  // which holds High/Medium/Low — same name, different concept, zero label overlap.
  it("priority__c goes to its OWN status column, never monday's native Priority", () => {
    expect(CRM_CONTACTS.fields.find(x => x.hs === "priority__c"))
      .toMatchObject({ col: "color_mm70ahh7", type: "status", labels: "contactPriority" });
    expect(CRM_CONTACTS.fields.some(f => f.col === "status5")).toBe(false);
  });

  // Now mapped into a real DATE column created for it. The old TEXT column stays unmapped: a datetime
  // in a text column renders a raw ISO string, which is what deferred this in the first place.
  it("notes_last_updated maps to a DATE column, one-way, not the old text column", () => {
    const f = CRM_CONTACTS.fields.find(x => x.hs === "notes_last_updated")!;
    expect(f).toMatchObject({ col: "date_mm7054jz", type: "date", oneWay: true });
    expect(f.reverse).toBeUndefined();      // HubSpot sets it automatically from real activity
    expect(CRM_CONTACTS.fields.some(x => x.col === "text_mm6tmzgq")).toBe(false);
  });

  // The trigger field for the future 24-hour reminder. HubSpot resets it on reassignment.
  it("hubspot_owner_assigneddate maps to a DATE column, one-way", () => {
    const f = CRM_CONTACTS.fields.find(x => x.hs === "hubspot_owner_assigneddate")!;
    expect(f).toMatchObject({ col: "date_mm70pa4c", type: "date", oneWay: true });
    expect(f.reverse).toBeUndefined();
  });

  it("num_notes / activity COUNTS stay unmapped — a number cannot represent an activity timeline", () => {
    for (const hs of ["num_notes", "num_contacted_notes", "num_associated_deals",
                      "hs_last_sales_activity_timestamp"])
      expect(CRM_CONTACTS.fields.some(f => f.hs === hs)).toBe(false);
  });

  it("monday's native Activities timeline and Comments stay native and unmapped", () => {
    for (const col of ["custom_mkrm9y8c", "long_text4", "mirror2", "title5"])
      expect(CRM_CONTACTS.fields.some(f => f.col === col)).toBe(false);
  });

  // `company` is NOT mapped as of 2026-09-08 (meeting decision). The free-text company name sat next
  // to a Connect Boards relation carrying the real, clickable Account link — two columns answering
  // "which company", one of them unlinkable. The relation is now the single answer, renamed
  // "Company name". HubSpot's `company` property is untouched; only the monday mirror is gone.
  it("does NOT map HubSpot `company` — the Connect Boards relation is the single answer", () => {
    expect(CRM_CONTACTS.fields.some(f => f.hs === "company")).toBe(false);
    // Neither the retired text column nor the earlier deleted one may be referenced: monday rejects an
    // entire column-values mutation naming an unknown column, which freezes every card on the board.
    for (const dead of ["text_mm70apjj", "text_mm6sdvkq"])
      expect(CRM_CONTACTS.fields.some(f => f.col === dead)).toBe(false);
  });

  it("carries the company link ONLY as the relation, never as text", () => {
    expect(CRM_CONTACTS.associations)
      .toEqual([{ toObject: "companies", nameProps: ["name"], relationCol: "contact_account" }]);
  });

  it("associates ONLY to companies, via the native relation, and maps no deal column", () => {
    expect(CRM_CONTACTS.associations).toEqual([
      { toObject: "companies", nameProps: ["name"], relationCol: "contact_account" },
    ]);
    for (const f of CRM_CONTACTS.fields) expect(f.col).not.toMatch(/deal/i);
  });
});

describe("CRM_ACCOUNTS", () => {
  it("targets the right board, columns and group", () => {
    expect(CRM_ACCOUNTS.boardId).toBe("5028000496");
    expect(CRM_ACCOUNTS.idCol).toBe("text_mm6tsnwx");
    expect(CRM_ACCOUNTS.syncStateCol).toBe("text_mm6tccd0");
    expect(CRM_ACCOUNTS.linkCol).toBe("link_mm6zyad8");
    expect(CRM_ACCOUNTS.groupBy).toEqual({ singleGroup: "topics", placeOnly: true });
    expect(CRM_ACCOUNTS.modifiedProp).toBe("hs_lastmodifieddate");
  });

  // DOMAIN MUST BE WRITTEN, not just read. adoptBy READS this column to match an existing HubSpot
  // company; for a while nothing WROTE it, so every HubSpot-originated Account landed in monday with an
  // empty Domain - the single field the whole matching design depends on.
  // TWO-WAY from 2026-09-09, and `canonicalDomain` is the condition that made it safe. Forward-only was
  // justified as "it is the dedup key", but that protected the wrong thing: a rep CORRECTING a wrong
  // domain is the edit we want, and the card can never be re-pointed at another company anyway (a
  // linked card returns before the adoption branch is reachable). What actually needed protecting is
  // the SPELLING — companies enforce no unique domain, so HubSpot stores any string verbatim and a URL
  // would break searchCompanyByDomain's EQ match with no error anywhere.
  it("WRITES domain both ways, canonicalised because it doubles as the search key", () => {
    const f = CRM_ACCOUNTS.fields.find(x => x.hs === "domain")!;
    expect(f).toMatchObject({ col: "company_domain", type: "link", reverse: true, canonicalDomain: true });
    expect(f.backfill).toBeUndefined();
  });

  // Being reversible is ALSO what stops a monday-originated Account creating a domainless company:
  // buildCreateProperties emits only `reverse` fields, so a forward-only key is omitted from the
  // create payload entirely. Asserted here because the two facts have to move together.
  it("the adoption key is reversible, so a create can actually carry it", () => {
    const key = CRM_ACCOUNTS.fields.find(f => f.col === CRM_ACCOUNTS.adoptBy!.col)!;
    expect(key.reverse).toBe(true);
  });

  it("the adoption key and the written column are the SAME column", () => {
    expect(CRM_ACCOUNTS.adoptBy!.col)
      .toBe(CRM_ACCOUNTS.fields.find(f => f.hs === "domain")!.col);
  });

  it("adopts by DOMAIN on the native link column, never by company name", () => {
    expect(CRM_ACCOUNTS.adoptBy).toEqual({ kind: "domain", col: "company_domain" });
    expect(CRM_ACCOUNTS.adoptBy!.col).not.toBe("text_mm6t1q4h");
    expect(CRM_ACCOUNTS.createFromMonday).toBe(true);
  });

  // THE INDUSTRY REGRESSION GUARD.
  // COMPANY industry is UNMAPPED as of 2026-09-08. Its text column (text_mm6tafj5) was deleted from the
  // board, and a spec field naming a column monday does not have makes monday reject the ENTIRE
  // change_multiple_column_values mutation — it froze every Accounts card until this changed.
  it("company industry is unmapped, and the NATIVE dropdown stays unmapped too", () => {
    expect(CRM_ACCOUNTS.fields.some(x => x.hs === "industry")).toBe(false);
    // The deleted stub must never be referenced again, and the native column stays monday-owned:
    // HubSpot's ~250-option enum against monday's 47 would contaminate it via create_labels_if_missing.
    expect(CRM_ACCOUNTS.fields.some(x => x.col === "text_mm6tafj5")).toBe(false);
    expect(CRM_ACCOUNTS.fields.some(x => x.col === "industry")).toBe(false);
  });

  // Two-way from 2026-09-23: with neither reverse nor oneWay, a rep edit fired a reconcile that wrote
  // HubSpot's value straight back. It has a validated dictionary, so an unknown label is refused.
  it("partner_with is a DROPDOWN (status cannot hold its 27 labels) and two-way", () => {
    const f = CRM_ACCOUNTS.fields.find(x => x.hs === "partner_with")!;
    expect(f).toMatchObject({ col: "dropdown_mm6zd1ge", type: "dropdown", labels: "partnerWith", reverse: true });
  });

  it("type is two-way on the seeded status column", () =>
    expect(CRM_ACCOUNTS.fields.find(f => f.hs === "type"))
      .toMatchObject({ col: "color_mm6zwhwt", type: "status", labels: "companyType", reverse: true }));

  // THE EMPLOYEE-COUNT DECISION.
  // Two-way since 2026-09-23 through reverseAs "integer" (a range like "100-500" is refused, never sent).
  it("numberofemployees reuses the NATIVE column, two-way only as a whole number, with no second employee column", () => {
    const f = CRM_ACCOUNTS.fields.find(x => x.hs === "numberofemployees")!;
    expect(f).toMatchObject({ col: "employee_count", type: "text", reverse: true, reverseAs: "integer" });
    expect(f.backfill).toBeUndefined();
    expect(CRM_ACCOUNTS.fields.filter(x => /employee/i.test(x.hs))).toHaveLength(1);
  });

  it("owner is appReverse", () =>
    expect(CRM_ACCOUNTS.fields.find(f => f.hs === "hubspot_owner_id"))
      .toMatchObject({ col: "multiple_person_mm6z8mwy", type: "people", appReverse: true }));

  // sales_user is now DISPLAYED here too (it is on the Create Company form), forward-only and never
  // a scope input - the same split as on Contacts.
  it("shows sales_user display-only, and associates ONLY to contacts", () => {
    // ONE surface since 2026-09-23: the People column. The legacy dropdown was unmapped once the
    // business decided an owner with no monday seat shows an EMPTY Sales User (its only reason to exist).
    expect(CRM_ACCOUNTS.fields.filter(f => f.hs === "sales_user").map(f => f.col)).toEqual(["multiple_person_mm7d2qk6"]);
    expect(CRM_ACCOUNTS.fields.some(f => f.col === "dropdown_mm704kf4")).toBe(false);
    expect(recInScope(CRM_ACCOUNTS, { properties: {} })).toBe(true);
    expect(CRM_ACCOUNTS.associations).toEqual([
      { toObject: "contacts", nameProps: ["firstname", "lastname"], relationCol: "account_contact" },
    ]);
  });

  /**
   * The People column is what a rep sees and what Lark reads. It USED to be forward-only because nine
   * HubSpot owner ids share one email here, so the inverse could not tell 华南销售 from 华北主管. That
   * objection is now answered in the engine: buildCtx drops an email claimed by more than one owner, so
   * such a person is REFUSED and healed rather than guessed (column-level-reverse.test.ts pins it), and
   * a column-level spec pushes this cell only when someone edits it.
   */
  it.each([
    ["Accounts", "multiple_person_mm7d2qk6"],
    ["Deals", "multiple_person_mm7df31a"],
  ])("%s Sales User People column is two-way, on a column-level spec", async (board, col) => {
    const { CRM_DEALS } = await import("../src/config/crm");
    const spec = board === "Accounts" ? CRM_ACCOUNTS : CRM_DEALS;
    const p = spec.fields.find(f => f.col === col)!;
    expect(p, `${board} has no Sales User People field`).toBeDefined();
    expect(p.hs).toBe("sales_user");
    expect(p.type).toBe("people");
    expect(p.reverse).toBe(true);
    expect(spec.columnLevelReverse).toBe(true);
  });

  it("matches the Contacts precedent — same property, same column type, same direction", () => {
    const contacts = CRM_CONTACTS.fields.find(f => f.col === "multiple_person_mm76ygkp")!;
    expect(contacts.hs).toBe("sales_user");
    expect(contacts.type).toBe("people");
    expect(contacts.reverse).toBe(true);
  });
});

describe("scope: includeAll is paired with the Task 3B gate, and searchFilters are inert", () => {
  it.each(CRM_SPECS.map(s => [s.object, s] as const))("%s sets includeAll + skipFullReconcile", (_o, spec) => {
    expect(spec.includeAll).toBe(true);
    expect(spec.skipFullReconcile).toBe(true);
    expect(spec.searchFilters).toEqual([]);        // dead by construction, asserted so it stays that way
  });

  // The 771-record case: in scope with no sales_user and no createdate at all.
  it.each(CRM_SPECS.map(s => [s.object, s] as const))("%s: a record with NO sales_user is in scope", (_o, spec) => {
    expect(recInScope(spec, { properties: {} })).toBe(true);
    expect(recInScope(spec, { properties: { sales_user: "", createdate: "2019-01-01T00:00:00Z" } })).toBe(true);
  });

  // Being in scope now DOES mean a missing card is created, whatever the record's age: the historical
  // import has run (2026-09-17/18), so a record with no card is a gap. Before, a lead created in HubSpot
  // on 2026-09-23 got no card at all because it predated a 2026-09-25 cutover. Metadata must still have
  // been fetched -- an unreadable createdate refuses, so a `hold` stamp can never read as blank.
  it.each(CRM_SPECS.map(s => [s.object, s] as const))("%s: a missing card is created for any unstamped record", (_o, spec) => {
    expect(mayCreateCrmCard({ id: "1", properties: { createdate: "2024-03-01T00:00:00Z" } }, spec.ownership)).toBe(true);
    expect(mayCreateCrmCard({ id: "1", properties: {} }, spec.ownership)).toBe(false);
  });

  // ...but an explicit decision is still honoured.
  it.each(CRM_SPECS.map(s => [s.object, s] as const))("%s: a parked or WM-owned record still gets no card", (_o, spec) => {
    expect(mayCreateCrmCard({ id: "1", properties: { sync_owner: "hold", createdate: "2024-03-01T00:00:00Z" } }, spec.ownership)).toBe(false);
    expect(mayCreateCrmCard({ id: "1", properties: { sync_owner: "wm", createdate: "2024-03-01T00:00:00Z" } }, spec.ownership)).toBe(false);
  });

  it("ownership metadata is always fetched, so the gate can never read undefined", () => {
    for (const spec of CRM_SPECS) {
      const p = propertiesForSpec(spec);
      expect(p).toContain("sync_owner");
      expect(p).toContain("createdate");
    }
  });
});

describe("PRODUCTION WM specs are untouched", () => {
  it("every WM spec is owner \"wm\" and still declares no adoptBy", () => {
    for (const s of ALL_SPECS) {
      expect(s.ownership?.owner).toBe("wm");
      expect(s.adoptBy).toBeUndefined();
    }
  });

  it("WM contacts/companies still gate on sales_user — the 771 must NOT reach the WM boards", () => {
    expect(recInScope(CONTACTS_MYLA, { properties: {} })).toBe(false);
    expect(recInScope(CONTACTS_MYLA, { properties: { createdate: "2026-09-01T00:00:00Z" } })).toBe(false);
    expect(recInScope(DEALS, { properties: {} })).toBe(false);
  });

  it("no WM spec uses the new `email` column type, so the mapper change is inert for production", () => {
    for (const s of ALL_SPECS) expect(s.fields.some(f => f.type === "email")).toBe(false);
  });

  it("CRM specs and WM specs share no board and no HubSpot-id column", () => {
    const wmBoards = new Set(ALL_SPECS.map(s => s.boardId));
    for (const s of CRM_SPECS) expect(wmBoards.has(s.boardId)).toBe(false);
    expect(CRM_CONTACTS.boardId).not.toBe(CONTACTS_MYLA.boardId);
    expect(CRM_ACCOUNTS.boardId).not.toBe(COMPANIES_MYLA.boardId);
  });

  // Four objects since 2026-09-14. Each declares ownership and at least one association; the reverse
  // direction stays code-blocked for every ownership-declaring spec, which is the safety property.
  it("CRM_SPECS covers the four CRM objects, all crm-owned, each with associations", () => {
    expect(CRM_SPECS.map(s => s.object).sort())
      .toEqual(["companies", "contacts", "deals", "line_items"]);
    for (const s of CRM_SPECS) {
      expect(s.ownership?.owner).toBe("crm");
      expect((s.associations ?? []).length).toBeGreaterThan(0);
    }
  });
});
