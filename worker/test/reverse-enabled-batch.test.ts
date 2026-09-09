import { describe, it, expect } from "vitest";
import { reverseFieldValue, buildReversePatch, buildCreateProperties, fieldDiffs } from "../src/reconcile";
import { CRM_CONTACTS, CRM_ACCOUNTS } from "../src/config/crm";
import type { Ctx, FieldSpec, HsRecord, MondayItem, ObjectSpec } from "../src/types";

/**
 * THE 2026-09-09 REVERSE BATCH. monday CRM is the salespeople's working system, so the normal editable
 * business fields must push back to HubSpot. Before this, 5 of 29 Contact fields were two-way and an
 * edit to any of the other 24 was not ignored but REVERTED — the reconcile found nothing reversible and
 * the forward write restored HubSpot's value over the top. That is what "monday -> HubSpot doesn't work"
 * actually was.
 *
 * Two of the fields nominated for this batch would have shipped a defect, and both are covered below:
 *
 *   department_3__c — a DROPDOWN with no label dictionary. The dropdown reverse branch built its
 *     candidate list from the (empty) inverted dict, matched nothing, and returned "" — silently
 *     refusing every edit. Fixed by passing through raw when there is no dictionary, which is correct
 *     because value === label for every option on that property.
 *
 *   numberofemployees — HELD BACK. It is `type: "text"` on a HubSpot NUMBER property, so the reverse
 *     path passes the cell through raw and "approx 500" would 400. It needs the numeric guard first,
 *     the same way the four text-enum fields need a dictionary guard.
 */

// Dictionaries are HubSpot INTERNAL VALUE -> monday DISPLAY LABEL, matching getPropertyOptions.
const LEAD_STATUS = { NEW: "New", IN_PROGRESS: "In Progress" };
const CONTACT_PRIORITY = { "P1_2小时内": "P1_2小时内", "P2_1周内": "P2_1周内" };
const CONTACT_STATUS = { "1New": "1新增", "7购买有意向": "7购买有意向" };
const CONTACT_VENDOR = { HubSpot: "HubSpot", Tableau: "Tableau", Aircall: "Aircall" };
// The real 4 options, verified live 2026-09-09. Ada and Heifer are deliberately NOT here — they are
// real reps who are not options on this property, which is the whole point of the refusal test.
const SALES_PERSON = {
  "Elaine Rivera": "Elaine Rivera", "Emily You": "Emily You",
  "Myla Mestiola": "Myla Mestiola", "Rick Avery Antonio": "Rick Avery Antonio",
};
// A representative slice of the live 29; value === label for every one of them.
const DEPARTMENT = { Finance: "Finance", IT: "IT", "Engineering/R&D": "Engineering/R&D" };
// A slice of leadsource's 210. "Others" -> "其他" is the ONE option where label != value, so it is the
// only case where the dictionary does real translation work rather than membership checking.
const CONTACT_SOURCE = { Others: "其他", "Web Form": "Web Form", "Trade Show": "Trade Show" };
const CONTACT_CITY = { Shanghai: "Shanghai", "Kuala Lumpur": "Kuala Lumpur" };

const ctx = {
  labels: {
    leadStatus: LEAD_STATUS, contactPriority: CONTACT_PRIORITY,
    contactStatus: CONTACT_STATUS, contactVendor: CONTACT_VENDOR,
    contactSalesPerson: SALES_PERSON, contactDepartment: DEPARTMENT,
    contactSource: CONTACT_SOURCE, contactCity: CONTACT_CITY,
  },
  ownersById: {}, mondayUsersByEmail: {}, mondayEmailByUserId: {}, ownerIdByEmail: {}, portalId: "1",
} as unknown as Ctx;

const f = (spec: ObjectSpec, hs: string): FieldSpec => {
  const found = spec.fields.find(x => x.hs === hs);
  if (!found) throw new Error(`no field ${hs} on ${spec.object}`);
  return found;
};

const ENABLED_CONTACTS = [
  "priority__c", "sales_person", "leadstatus", "manufacturer__c", "department_3__c",
  "concrete_demand", "utm_term", "registration_page__c", "industry", "hs_state_code",
  "mobilephone", "event_name",
];

describe("the batch is enabled, and only the batch", () => {
  it.each(ENABLED_CONTACTS)("contacts.%s is now reverse:true", (hs) =>
    expect(f(CRM_CONTACTS, hs).reverse).toBe(true));

  it("accounts.timezone is now reverse:true", () =>
    expect(f(CRM_ACCOUNTS, "timezone").reverse).toBe(true));

  // HELD BACK, with the reason asserted so it cannot be quietly enabled later without a guard.
  it("numberofemployees stays FORWARD-ONLY: a text column on a HubSpot NUMBER property", () => {
    const noe = f(CRM_ACCOUNTS, "numberofemployees");
    expect(noe.reverse).toBeUndefined();
    expect(noe.type).toBe("text");   // not "numbers", so numText never runs on it
  });

  // Identity, system and computed fields must stay one-way regardless of the "monday is the system"
  // goal — a monday edit to any of these breaks record matching or fights HubSpot's own computation.
  it.each(["email", "createdate", "registration_date", "hubspot_owner_assigneddate", "notes_last_updated"])(
    "contacts.%s stays one-way", (hs) => expect(f(CRM_CONTACTS, hs).reverse).toBeUndefined());

  it.each(["createdate", "hs_object_source_label"])(
    "accounts.%s stays one-way", (hs) => expect(f(CRM_ACCOUNTS, hs).reverse).toBeUndefined());

  // accounts.domain LEFT this set on 2026-09-09 — see the canonicalDomain note in crm.ts. Its reverse
  // value must be a BARE domain, not the URL linkReverse would otherwise hand back, because the same
  // string is what searchCompanyByDomain filters on.
  it("accounts.domain is two-way and reverses to a bare, searchable domain", () => {
    const d = f(CRM_ACCOUNTS, "domain");
    expect(d).toMatchObject({ type: "link", reverse: true, canonicalDomain: true });
    // monday's link rendering, a bare host, and a full URL must all reduce to the same key.
    for (const cell of ["acme.com - https://www.acme.com/", "acme.com", "https://www.acme.com/path"])
      expect(reverseFieldValue(d, cell, ctx)).toBe("acme.com");
    // Nothing usable -> "" -> omitted from the patch and healed forward, never stored as junk.
    // A COMPANY NAME is the case that matters and the one a first attempt got wrong: normalizeDomain
    // only canonicalises, so "ABC Trading Sdn Bhd" became "abc trading sdn bhd" and would have been
    // written over a real company's dedup key. The reverse path now shares adoptionKey's own
    // hostname/provider validation (companyDomainKey), so matching and storing cannot disagree.
    for (const junk of ["   ", "ABC Trading Sdn Bhd", "no-tld", "gmail.com"])
      expect(reverseFieldValue(d, junk, ctx)).toBe("");
  });

  // Deliberate holds, each for its own stated reason.
  it("lifecyclestage stays one-way — it fires HubSpot workflows, so it is a business decision", () =>
    expect(f(CRM_CONTACTS, "lifecyclestage").reverse).toBeUndefined());

  it("sales_user stays one-way — two owner ids share the name \"Rick Antonio\"", () =>
    expect(f(CRM_CONTACTS, "sales_user").reverse).toBeUndefined());

  it("hubspot_owner_id stays on the app-save path, never a plain reverse", () => {
    expect(f(CRM_CONTACTS, "hubspot_owner_id").appReverse).toBe(true);
    expect(f(CRM_CONTACTS, "hubspot_owner_id").reverse).toBeUndefined();
  });

  // THE FOUR TEXT-ENUMS ARE NOW TWO-WAY (2026-09-09), which is what "pending text-enum validation"
  // was waiting for. Each is a monday TEXT column standing in for a large HubSpot enumeration
  // (leadsource 210 options, countries 198, lead_source_sub__c 558, city_1__c 673), and each now
  // carries a dictionary so the validated-text branch can check membership. The dictionary is the
  // enabling condition, so it is asserted together with `reverse` rather than separately.
  it.each([
    ["countries", "contactCountries"],
    ["lead_source_sub__c", "contactLeadSourceSub"],
    ["city_1__c", "contactCity"],
    ["leadsource", "contactSource"],
  ])("%s is two-way, validated against %s", (hs, dict) => {
    const spec = f(CRM_CONTACTS, hs);
    expect(spec).toMatchObject({ type: "text", labels: dict, reverse: true });
    expect(spec.unvalidatedEnum).toBeUndefined();
  });

  // The invariant that makes this class of field safe, stated once over BOTH specs: a reversible
  // status/dropdown/validated-text field must be able to check what it sends. Anything reversible on
  // one of those types either has a dictionary or has explicitly opted out — and nothing on the CRM
  // boards is allowed to opt out, because opting out is what wedged sales_person and department_3__c.
  it("no CRM field reverses into an enum-shaped column without a dictionary", () => {
    for (const spec of [CRM_CONTACTS, CRM_ACCOUNTS])
      for (const fs of spec.fields) {
        if (!fs.reverse) continue;
        if (fs.type !== "status" && fs.type !== "dropdown") continue;
        expect(fs.labels, `${spec.object}.${fs.hs} reverses with no dictionary`).toBeTruthy();
        expect(fs.unvalidatedEnum, `${spec.object}.${fs.hs} opts out of validation`).toBeUndefined();
      }
  });
});

describe("each newly-enabled type reverses correctly", () => {
  it("status WITH a dictionary maps label -> internal value, and refuses junk", () => {
    const pri = f(CRM_CONTACTS, "priority__c");
    expect(reverseFieldValue(pri, "P2_1周内", ctx)).toBe("P2_1周内");
    expect(reverseFieldValue(pri, "Not A Priority", ctx)).toBe("");
    const st = f(CRM_CONTACTS, "leadstatus");
    expect(reverseFieldValue(st, "1新增", ctx)).toBe("1New");        // label -> value
    expect(reverseFieldValue(st, "1New", ctx)).toBe("1New");         // value passes too
    expect(reverseFieldValue(st, "made up", ctx)).toBe("");
  });

  // CORRECTED 2026-09-09, and this is the assertion that was actively wrong rather than merely stale.
  // It asserted a PASSTHROUGH and justified it with "sales_person has value === label" — which is
  // true and irrelevant. sales_person is a 4-option HubSpot ENUMERATION (Elaine Rivera, Emily You,
  // Myla Mestiola, Rick Avery Antonio), so value === label removes the need to translate a label but
  // does nothing to check the text is an option. The requirements meeting is entirely about
  // reassigning leads between reps named Ada and Heifer; either of those in this cell would have gone
  // straight to HubSpot, 400'd, thrown before Sync State was stamped, and — with skipFullReconcile
  // and no CRM cron — frozen every one of that card's 29 fields until someone edited it in HubSpot.
  it("status maps a real option, and REFUSES a rep who is not one", () => {
    const sp = f(CRM_CONTACTS, "sales_person");
    expect(sp.labels).toBe("contactSalesPerson");
    expect(reverseFieldValue(sp, "Emily You", ctx)).toBe("Emily You");
    expect(reverseFieldValue(sp, "Ada", ctx)).toBe("");
    expect(reverseFieldValue(sp, "Heifer", ctx)).toBe("");
  });

  it("dropdown WITH a dictionary validates and drops the unknown part", () => {
    const v = f(CRM_CONTACTS, "manufacturer__c");
    expect(reverseFieldValue(v, "HubSpot, Aircall", ctx)).toBe("HubSpot;Aircall");
    expect(reverseFieldValue(v, "HubSpot, Nonsense", ctx)).toBe("HubSpot");
    expect(reverseFieldValue(v, "Nonsense", ctx)).toBe("");
  });

  // THE OTHER HALF OF THE SAME MISTAKE. The original problem was real — with no dictionary the
  // dropdown branch returned "" for every value, so department_3__c looked enabled and synced
  // nothing — but the fix chosen was a raw passthrough, which traded a silent no-op for a card-
  // freezing 400. The actual fix is a dictionary: multi-select still joins with ";" and an unknown
  // label is still DROPPED rather than sent, so a rep who adds a monday label loses that one label
  // instead of losing the whole card.
  it("dropdown maps real options, joins multi-select, and drops an unknown label", () => {
    const d = f(CRM_CONTACTS, "department_3__c");
    expect(d.labels).toBe("contactDepartment");
    expect(reverseFieldValue(d, "Engineering/R&D", ctx)).toBe("Engineering/R&D");
    expect(reverseFieldValue(d, "Finance, IT", ctx)).toBe("Finance;IT");
    expect(reverseFieldValue(d, "Finance, Invented Dept", ctx)).toBe("Finance");
    expect(reverseFieldValue(d, "Invented Dept", ctx)).toBe("");
    expect(reverseFieldValue(d, "", ctx)).toBe("");
  });

  // The validated-text branch, on the shape that motivated it: monday shows the LABEL, and a cell that
  // already holds the internal VALUE must also be accepted, or records written before the dictionary
  // resolved could never be repaired. Unknown text is refused so the forward write heals the cell.
  it("validated text accepts a label, accepts an internal value, refuses anything else", () => {
    const ls = f(CRM_CONTACTS, "leadsource");
    expect(reverseFieldValue(ls, "其他", ctx)).toBe("Others");        // label -> value (the one that differs)
    expect(reverseFieldValue(ls, "Others", ctx)).toBe("Others");      // already the internal value
    expect(reverseFieldValue(ls, "Web Form", ctx)).toBe("Web Form");  // label === value, the common case
    expect(reverseFieldValue(ls, "Typed By Hand", ctx)).toBe("");     // refused, not sent
  });

  // An unvalidatable field must behave as though it were still one-way, never as a passthrough: if a
  // dictionary fetch fails, ctx.labels is empty and every edit is refused. Being wrong about an option
  // set therefore costs a rejected edit, never a wedged card.
  it("an empty dictionary refuses everything rather than sending it raw", () => {
    const emptyCtx = { ...ctx, labels: {} } as unknown as Ctx;
    for (const hs of ["leadsource", "sales_person", "department_3__c", "city_1__c"])
      expect(reverseFieldValue(f(CRM_CONTACTS, hs), "Anything", emptyCtx)).toBe("");
  });

  it("phone canonicalises, keeping a leading +", () => {
    const m = f(CRM_CONTACTS, "mobilephone");
    expect(reverseFieldValue(m, "+60 12-345 6789", ctx)).toBe("+60123456789");
    expect(reverseFieldValue(m, "012 345 6789", ctx)).toBe("0123456789");
    expect(reverseFieldValue(m, "no digits here", ctx)).toBe("");
  });

  it("long_text is clamped to monday's 2000, so the round trip converges", () => {
    const cd = f(CRM_CONTACTS, "concrete_demand");
    expect(reverseFieldValue(cd, "需要 40 个席位", ctx)).toBe("需要 40 个席位");
    expect(reverseFieldValue(cd, "x".repeat(2500), ctx).length).toBe(2500);  // reverse sends what the rep typed
  });

  it("plain text passes through", () => {
    expect(reverseFieldValue(f(CRM_CONTACTS, "utm_term"), "hubspot crm", ctx)).toBe("hubspot crm");
    expect(reverseFieldValue(f(CRM_CONTACTS, "hs_state_code"), "广东省", ctx)).toBe("广东省");
    expect(reverseFieldValue(f(CRM_ACCOUNTS, "timezone"), "Asia/Kuala_Lumpur", ctx)).toBe("Asia/Kuala_Lumpur");
  });
});

describe("the patch carries exactly the edited field", () => {
  const rec = (props: Record<string, string>): HsRecord =>
    ({ id: "301", properties: { firstname: "Jane", lastname: "Smith", ...props } }) as unknown as HsRecord;
  const card = (cells: Record<string, string>): MondayItem => ({
    id: "CARD1", name: "Jane Smith", group: { id: "topics" },
    column_values: [
      { id: CRM_CONTACTS.idCol, text: "301", value: null },
      ...Object.entries(cells).map(([id, text]) => ({ id, text, value: null })),
    ],
  } as unknown as MondayItem);

  /**
   * THE CREATE PAYLOAD, which is where the domain fix actually bites.
   *
   * Four live Accounts cards on 2026-09-09 held real domains that matched no HubSpot company, so the
   * next webhook would have CREATED one. buildCreateProperties emits only `reverse` fields, and
   * `domain` was forward-only — so each create would have minted a company with no domain at all,
   * leaving the dedup key empty, the next lookup missing, and a duplicate waiting to be made. Nothing
   * would have errored. Creating in HubSpot is also not undoable from monday, since a monday deletion
   * deliberately never deletes a HubSpot record.
   */
  it("an Accounts create now CARRIES the domain, canonicalised", () => {
    const item = {
      id: "CARD9", name: "UK Market Report", group: { id: "topics" },
      column_values: [
        { id: CRM_ACCOUNTS.idCol, text: "", value: null },
        { id: "text_mm6t1q4h", text: "UK Market Report", value: null },   // Company name
        { id: "company_domain", text: "ukmarketreport.com - https://ukmarketreport.com", value: null },
      ],
    } as unknown as MondayItem;
    const props = buildCreateProperties(item, CRM_ACCOUNTS, ctx);
    expect(props.domain).toBe("ukmarketreport.com");
    expect(props.name).toBe("UK Market Report");
  });

  it("and a card with no usable domain contributes none, so the create guard can refuse it", () => {
    const item = {
      id: "CARD9", name: "Some Prospect", group: { id: "topics" },
      column_values: [
        { id: CRM_ACCOUNTS.idCol, text: "", value: null },
        { id: "text_mm6t1q4h", text: "Some Prospect", value: null },
        { id: "company_domain", text: "ABC Trading Sdn Bhd", value: null },
      ],
    } as unknown as MondayItem;
    expect(buildCreateProperties(item, CRM_ACCOUNTS, ctx).domain).toBeUndefined();
  });

  it("a 优先级 edit sends priority__c and nothing else", () => {
    const pri = f(CRM_CONTACTS, "priority__c");
    const item = card({ [pri.col]: "P2_1周内" });
    const patch = buildReversePatch(
      fieldDiffs(rec({ priority__c: "P1_2小时内" }), item, CRM_CONTACTS, ctx), item, CRM_CONTACTS, ctx);
    expect(patch).toEqual({ priority__c: "P2_1周内" });
  });

  it("an invalid 优先级 sends nothing, so the card reconciles forward instead of wedging", () => {
    const pri = f(CRM_CONTACTS, "priority__c");
    const item = card({ [pri.col]: "P9_whenever" });
    const patch = buildReversePatch(
      fieldDiffs(rec({ priority__c: "P1_2小时内" }), item, CRM_CONTACTS, ctx), item, CRM_CONTACTS, ctx);
    expect(patch).toEqual({});
  });

  it("and converges once HubSpot holds the reversed value", () => {
    const pri = f(CRM_CONTACTS, "priority__c");
    const item = card({ [pri.col]: "P2_1周内" });
    expect(fieldDiffs(rec({ priority__c: "P2_1周内" }), item, CRM_CONTACTS, ctx)
      .filter(d => d.f?.hs === "priority__c")).toEqual([]);
  });
});
