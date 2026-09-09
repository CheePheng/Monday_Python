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
    expect(CRM_CONTACTS.groupBy).toEqual({ singleGroup: "topics" });
  });

  it("uses `lastmodifieddate`, not the deal/company property", () =>
    expect(CRM_CONTACTS.modifiedProp).toBe("lastmodifieddate"));

  // THE 2026-09-07 MEETING DECISION.
  it("creation is HubSpot-only: no createFromMonday, no adoptBy, no createDefaults", () => {
    expect(CRM_CONTACTS.createFromMonday).toBe(false);
    expect(CRM_CONTACTS.adoptBy).toBeUndefined();
    expect(CRM_CONTACTS.createDefaults).toBeUndefined();
  });

  // sales_user is now DISPLAYED (mapping sheet, 2026-09-08) but the two properties that actually
  // mattered are unchanged: it is never FABRICATED, and it never decides scope.
  it("never manufactures sales_user, and shows it display-only", () => {
    expect(CRM_CONTACTS.createDefaults).toBeUndefined();
    expect(CRM_CONTACTS.createDefaults?.sales_user).toBeUndefined();
    const f = CRM_CONTACTS.fields.find(x => x.hs === "sales_user")!;
    // A SINGLE-SELECT DROPDOWN since 2026-09-08 (was a text column). Dropdown because there are 42
    // owners and status dies above ~19 labels; forward-only for two reasons now — a monday edit must
    // never reassign, AND "Rick Antonio" is two owner ids, so a label cannot resolve back to one owner.
    expect(f).toMatchObject({ col: "dropdown_mm70mxfy", type: "dropdown", labels: "salesUser" });
    expect(f.reverse).toBeUndefined();      // a monday edit must never reassign it
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

  it("email is the native email column and is FORWARD-ONLY (it is the dedup key)", () => {
    const f = CRM_CONTACTS.fields.find(x => x.hs === "email")!;
    expect(f).toMatchObject({ col: "contact_email", type: "email" });
    expect(f.reverse).toBeUndefined();
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

  it("leadsource is forward-only (~200 legacy options)", () => {
    const f = CRM_CONTACTS.fields.find(x => x.hs === "leadsource")!;
    expect(f).toMatchObject({ col: "text_mm6sc26t", type: "text" });
    expect(f.reverse).toBeUndefined();
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
    expect(CRM_ACCOUNTS.groupBy).toEqual({ singleGroup: "topics" });
    expect(CRM_ACCOUNTS.modifiedProp).toBe("hs_lastmodifieddate");
  });

  // DOMAIN MUST BE WRITTEN, not just read. adoptBy READS this column to match an existing HubSpot
  // company; for a while nothing WROTE it, so every HubSpot-originated Account landed in monday with an
  // empty Domain - the single field the whole matching design depends on.
  it("WRITES domain into the native Domain column, forward-only", () => {
    const f = CRM_ACCOUNTS.fields.find(x => x.hs === "domain")!;
    expect(f).toMatchObject({ col: "company_domain", type: "link" });
    expect(f.reverse).toBeUndefined();      // the dedup key, like email on contacts
    expect(f.backfill).toBeUndefined();
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

  it("partner_with is a DROPDOWN (status cannot hold its 27 labels) and forward-only", () => {
    const f = CRM_ACCOUNTS.fields.find(x => x.hs === "partner_with")!;
    expect(f).toMatchObject({ col: "dropdown_mm6zd1ge", type: "dropdown", labels: "partnerWith" });
    expect(f.reverse).toBeUndefined();
  });

  it("type is two-way on the seeded status column", () =>
    expect(CRM_ACCOUNTS.fields.find(f => f.hs === "type"))
      .toMatchObject({ col: "color_mm6zwhwt", type: "status", labels: "companyType", reverse: true }));

  // THE EMPLOYEE-COUNT DECISION.
  it("numberofemployees reuses the NATIVE column, ONE-WAY, with no second employee column", () => {
    const f = CRM_ACCOUNTS.fields.find(x => x.hs === "numberofemployees")!;
    expect(f).toMatchObject({ col: "employee_count", type: "text" });
    expect(f.reverse).toBeUndefined();
    expect(f.backfill).toBeUndefined();
    expect(CRM_ACCOUNTS.fields.filter(x => /employee/i.test(x.hs))).toHaveLength(1);
  });

  it("owner is appReverse", () =>
    expect(CRM_ACCOUNTS.fields.find(f => f.hs === "hubspot_owner_id"))
      .toMatchObject({ col: "multiple_person_mm6z8mwy", type: "people", appReverse: true }));

  // sales_user is now DISPLAYED here too (it is on the Create Company form), forward-only and never
  // a scope input - the same split as on Contacts.
  it("shows sales_user display-only, and associates ONLY to contacts", () => {
    const su = CRM_ACCOUNTS.fields.find(f => f.hs === "sales_user")!;
    expect(su).toMatchObject({ col: "dropdown_mm704kf4", type: "dropdown", labels: "salesUser" });
    expect(su.reverse).toBeUndefined();
    expect(recInScope(CRM_ACCOUNTS, { properties: {} })).toBe(true);
    expect(CRM_ACCOUNTS.associations).toEqual([
      { toObject: "contacts", nameProps: ["firstname", "lastname"], relationCol: "account_contact" },
    ]);
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

  // ...and being in scope must NOT mean a historical record gets a card.
  it.each(CRM_SPECS.map(s => [s.object, s] as const))("%s: in-scope history still cannot be carded", (_o, spec) => {
    expect(mayCreateCrmCard({ id: "1", properties: { createdate: "2024-03-01T00:00:00Z" } }, spec.ownership)).toBe(false);
    expect(mayCreateCrmCard({ id: "1", properties: {} }, spec.ownership)).toBe(false);
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
  it("no WM spec declares ownership or adoptBy", () => {
    for (const s of ALL_SPECS) {
      expect(s.ownership).toBeUndefined();
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

  it("CRM_SPECS covers exactly companies + contacts, all crm-owned, none with associations", () => {
    expect(CRM_SPECS.map(s => s.object).sort()).toEqual(["companies", "contacts"]);
    for (const s of CRM_SPECS) {
      expect(s.ownership?.owner).toBe("crm");
      expect(s.associations).toHaveLength(1);          // Contact<->Company only; reverse is code-blocked
    }
  });
});
