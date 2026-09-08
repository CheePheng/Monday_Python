import { describe, it, expect, vi, beforeEach } from "vitest";
import { CRM_ACCOUNTS, CRM_CONTACTS } from "../src/config/crm";
import { authorizeWrite } from "../src/ownership";
import { buildReversePatch, fieldDiffs, reverseFieldValue } from "../src/reconcile";
import { expectedText, itemName } from "../src/mapping";
import type { Ctx, Env, FieldSpec, HsRecord, MondayItem, ObjectSpec, RunOpts } from "../src/types";

/**
 * LANE D — BEHAVIOURAL coverage for REVERSE (monday -> HubSpot) sync, ahead of WRITE_HUBSPOT=true.
 *
 * Reverse sync is inert today (`run-opts.ts:31` makes writeHubspot false when WRITE_HUBSPOT="false", and
 * `hubspot.ts:533` turns every patchRecord into a DRY log). Everything below therefore drives the engine
 * with `writeHubspot: true` so the write that WILL happen is observable now.
 *
 * The four things each field must prove, in the order the live rollout will enable them:
 *   1. EXACT PATCH — `buildReversePatch` (reconcile.ts:150) emits exactly the one HubSpot property that
 *      changed. A patch carrying a second property is how an unrelated field gets clobbered.
 *   2. OWNERSHIP — `ownership.ts:59 authorizeWrite` is asymmetric and fail-closed: crm-stamped allowed,
 *      unstamped / wm-stamped / parked refused. Proven at the ENGINE, not just on the predicate.
 *   3. CONVERGENCE (the anti-loop assertion) — once HubSpot holds the reversed value, `fieldDiffs`
 *      (reconcile.ts:37) must raise NO field diff. A permanent diff means `decideDirection` keeps
 *      returning "toHubspot" and the card is rewritten on every webhook forever. Asserted per TYPE:
 *      text, phone (digits-only), numbers (Number() normalisation), status (label vs internal value).
 *   4. EMPTY MONDAY VALUE — must not clear HubSpot. See "an empty monday value" below: it does not, but
 *      the mechanism is `if (v) patch[...] = v` (reconcile.ts:162) dropping the falsy "", NOT an explicit
 *      guard, and the same drop is what leaves the card visibly stale (finding D2).
 */

// ---------------------------------------------------------------------------------------------------
// Live option data, in the exact { internal value -> label } shape getPropertyOptions returns
// (hubspot.ts:658). Verified against the portal on 2026-09-07 — same source as crm-enum-reverse-map.
// ---------------------------------------------------------------------------------------------------

const LEAD_STATUS = {
  NEW: "New", OPEN: "Open", IN_PROGRESS: "In Progress", OPEN_DEAL: "Open Deal",
  UNQUALIFIED: "Unqualified", ATTEMPTED_TO_CONTACT: "Attempted to Contact",
  CONNECTED: "Connected", BAD_TIMING: "Bad Timing",
};

const COMPANY_TYPE = {
  PROSPECT: "Prospect", PARTNER: "Partner", RESELLER: "Reseller", VENDOR: "Vendor", OTHER: "Other",
  Customer: "Customer", Integrator: "Integrator",
};

const ctx: Ctx = {
  labels: { leadStatus: LEAD_STATUS, companyType: COMPANY_TYPE },
  ownersById: {}, mondayUsersByEmail: {}, mondayEmailByUserId: {}, ownerIdByEmail: {}, portalId: 1,
};

const MOD = "2026-09-08T02:00:00Z";        // the record's lastmodifieddate
const NEW_MOD = "2026-09-08T02:05:00Z";    // what a PATCH returns
const PRE = "2024-03-01T00:00:00Z";        // historical: pre-cutover
const POST = "2026-09-05T00:00:00Z";       // post-cutover, so a claim is eligible
const CUTOVER = "2026-09-01T00:00:00Z";

const live: RunOpts = { dryRun: false, writeHubspot: true, maxWrites: 30 };

// ---------------------------------------------------------------------------------------------------
// Records, and a card built FROM the record so it is diff-free by construction.
//
// Building the card with the engine's own expectedText() is deliberate: it means "no diff" is the
// baseline, so a single overridden column is the ONLY thing a patch can possibly contain. Hand-listing
// 30+ CRM columns would leave silent mismatches that mask an over-broad patch.
// ---------------------------------------------------------------------------------------------------

const contactRec = (over: Record<string, string> = {}): HsRecord => ({
  id: "301",
  properties: {
    firstname: "Jane", lastname: "Smith", email: "jane@acme.example",
    jobtitle: "Sales Manager", phone: "+60123456789", company: "Acme Sdn Bhd",
    hs_lead_status: "NEW", lifecyclestage: "lead", city_1__c: "Penang", countries: "Malaysia",
    concrete_demand: "Needs 40 seats before Q4.",
    lastmodifieddate: MOD, createdate: POST,
    ...over,
  },
});

const companyRec = (over: Record<string, string> = {}): HsRecord => ({
  id: "501",
  properties: {
    name: "Acme Sdn Bhd", domain: "acme.example", city: "Penang", state: "Penang", zip: "11900",
    type: "PROSPECT", annualrevenue: "900000", description: "A manufacturer.",
    numberofemployees: "250", timezone: "Asia/Kuala_Lumpur",
    hs_lastmodifieddate: MOD, createdate: POST,
    ...over,
  },
});

/** The monday card this record would produce, optionally with columns overridden by a rep's edit. */
function cardFor(spec: ObjectSpec, rec: HsRecord, over: Record<string, string> = {},
    syncState = MOD): MondayItem {
  const cv: { id: string; text: string | null }[] = [
    { id: spec.idCol, text: rec.id },
    { id: spec.syncStateCol, text: syncState },
  ];
  for (const f of spec.fields) {
    const t = expectedText(f, rec.properties[f.hs], ctx);
    if (t !== null) cv.push({ id: f.col, text: t });   // null = people, not text-diffable
  }
  for (const [col, text] of Object.entries(over)) {
    const hit = cv.find(c => c.id === col);
    if (hit) hit.text = text; else cv.push({ id: col, text });
  }
  return {
    id: "CARD1", name: itemName(rec, spec), created_at: POST, updated_at: MOD,
    group: { id: "topics" }, column_values: cv,
  };
}

const fieldOf = (spec: ObjectSpec, hs: string): FieldSpec => {
  const f = spec.fields.find(x => x.hs === hs);
  if (!f) throw new Error(`no field ${hs} on ${spec.object}`);
  return f;
};

const fieldDiffsOnly = (rec: HsRecord, item: MondayItem, spec: ObjectSpec, fill = false) =>
  fieldDiffs(rec, item, spec, ctx, fill).filter(d => d.kind === "field");

/**
 * The rollout order, exactly as the plan enables it: CONTACT jobtitle -> phone -> firstname/lastname ->
 * hs_lead_status, then COMPANY city -> name -> annualrevenue -> type.
 *
 * `patch` is the value that must reach HubSpot; `snapBack` is the monday column value the FORWARD
 * fallback writes when the reverse write is refused (buildUpdatePayload -> formatValue).
 */
interface Row {
  object: "contacts" | "companies";
  spec: ObjectSpec;
  hs: string;
  md: string;          // what the rep typed on the card
  patch: string;       // the HubSpot value that edit must produce
  snapBack: unknown;   // the monday value the forward fallback restores
}

const ROWS: Row[] = [
  { object: "contacts", spec: CRM_CONTACTS, hs: "jobtitle", md: "VP of Revenue Operations",
    patch: "VP of Revenue Operations", snapBack: "Sales Manager" },
  { object: "contacts", spec: CRM_CONTACTS, hs: "phone", md: "+1 (234) 567-8900",
    patch: "+12345678900", snapBack: { phone: "+60123456789" } },
  { object: "contacts", spec: CRM_CONTACTS, hs: "firstname", md: "Janet",
    patch: "Janet", snapBack: "Jane" },
  { object: "contacts", spec: CRM_CONTACTS, hs: "lastname", md: "Smithson",
    patch: "Smithson", snapBack: "Smith" },
  { object: "contacts", spec: CRM_CONTACTS, hs: "hs_lead_status", md: "In Progress",
    patch: "IN_PROGRESS", snapBack: { label: "New" } },
  { object: "companies", spec: CRM_ACCOUNTS, hs: "city", md: "Kuala Lumpur",
    patch: "Kuala Lumpur", snapBack: "Penang" },
  { object: "companies", spec: CRM_ACCOUNTS, hs: "name", md: "Acme Manufacturing Sdn Bhd",
    patch: "Acme Manufacturing Sdn Bhd", snapBack: "Acme Sdn Bhd" },
  { object: "companies", spec: CRM_ACCOUNTS, hs: "annualrevenue", md: "1500000",
    patch: "1500000", snapBack: "900000" },
  { object: "companies", spec: CRM_ACCOUNTS, hs: "type", md: "Reseller",
    patch: "RESELLER", snapBack: { label: "Prospect" } },
];

const recFor = (row: Row, over: Record<string, string> = {}) =>
  row.object === "contacts" ? contactRec(over) : companyRec(over);

// ---------------------------------------------------------------------------------------------------
// 0. The baseline the whole file rests on.
// ---------------------------------------------------------------------------------------------------

describe("baseline: a card built from its record has no diffs at all", () => {
  it("CRM contacts", () =>
    expect(fieldDiffs(contactRec(), cardFor(CRM_CONTACTS, contactRec()), CRM_CONTACTS, ctx)).toEqual([]));

  it("CRM accounts", () =>
    expect(fieldDiffs(companyRec(), cardFor(CRM_ACCOUNTS, companyRec()), CRM_ACCOUNTS, ctx)).toEqual([]));

  // Every field under test must actually be declared reversible, or the patch assertions below would
  // pass vacuously for the wrong reason.
  it.each(ROWS)("$object $hs is declared reverse:true", (row) =>
    expect(fieldOf(row.spec, row.hs).reverse).toBe(true));
});

// ---------------------------------------------------------------------------------------------------
// 1. EXACT PATCH — one changed column produces one HubSpot property.
// ---------------------------------------------------------------------------------------------------

describe("a monday edit produces a patch with EXACTLY that HubSpot property", () => {
  it.each(ROWS)("$object $hs", (row) => {
    const rec = recFor(row);
    const card = cardFor(row.spec, rec, { [fieldOf(row.spec, row.hs).col]: row.md });
    const diffs = fieldDiffs(rec, card, row.spec, ctx);
    const patch = buildReversePatch(diffs, card, row.spec, ctx);
    expect(Object.keys(patch)).toEqual([row.hs]);
    expect(patch[row.hs]).toBe(row.patch);
  });

  // Neither CRM spec declares nameReverse (crm.ts:53, crm.ts:233), so a renamed CARD must contribute
  // NOTHING to the patch. If nameReverse were ever added, this fails and the review is forced.
  it.each(ROWS)("$object $hs — renaming the card adds no property to the patch", (row) => {
    const rec = recFor(row);
    const card = cardFor(row.spec, rec, { [fieldOf(row.spec, row.hs).col]: row.md });
    card.name = "Renamed By A Rep";
    const diffs = fieldDiffs(rec, card, row.spec, ctx);
    expect(diffs.some(d => d.kind === "name")).toBe(true);       // the diff IS raised
    expect(Object.keys(buildReversePatch(diffs, card, row.spec, ctx))).toEqual([row.hs]);
  });

  // Two edits at once must produce two properties and no third — the multi-field version of the same
  // clobbering guard.
  it("two edited contact columns -> exactly those two properties", () => {
    const rec = contactRec();
    const card = cardFor(CRM_CONTACTS, rec, {
      [fieldOf(CRM_CONTACTS, "jobtitle").col]: "CRO",
      [fieldOf(CRM_CONTACTS, "hs_lead_status").col]: "Connected",
    });
    const patch = buildReversePatch(fieldDiffs(rec, card, CRM_CONTACTS, ctx), card, CRM_CONTACTS, ctx);
    expect(patch).toEqual({ jobtitle: "CRO", hs_lead_status: "CONNECTED" });
  });

  // A FORWARD-ONLY column a rep edited must never enter the patch. lifecyclestage drives HubSpot
  // workflows (crm.ts:158) and is the highest-consequence forward-only field on the board.
  it("an edit to a forward-only column contributes nothing to the patch", () => {
    const rec = contactRec();
    const card = cardFor(CRM_CONTACTS, rec, {
      [fieldOf(CRM_CONTACTS, "lifecyclestage").col]: "customer",
      [fieldOf(CRM_CONTACTS, "jobtitle").col]: "CRO",
    });
    const diffs = fieldDiffs(rec, card, CRM_CONTACTS, ctx);
    expect(diffs.filter(d => d.kind === "field")).toHaveLength(2);   // both diffs exist
    expect(buildReversePatch(diffs, card, CRM_CONTACTS, ctx)).toEqual({ jobtitle: "CRO" });
  });
});

// ---------------------------------------------------------------------------------------------------
// 3. CONVERGENCE — the anti-loop assertion. (Ownership, item 2, is driven through the engine below.)
// ---------------------------------------------------------------------------------------------------

describe("the round trip CONVERGES: once HubSpot holds the reversed value, no field diff remains", () => {
  it.each(ROWS)("$object $hs", (row) => {
    const col = fieldOf(row.spec, row.hs).col;
    // HubSpot now holds exactly what the reverse patch sent; the card still shows the rep's raw text.
    const rec = recFor(row, { [row.hs]: row.patch });
    const card = cardFor(row.spec, recFor(row), { [col]: row.md });
    expect(fieldDiffsOnly(rec, card, row.spec)).toEqual([]);
  });

  // firstname/lastname feed nameProps (crm.ts:52, crm.ts:232), so the FIELD converges but the card's
  // ITEM NAME is then stale. That residual diff is kind "name", carries no reversible property, and is
  // resolved by the forward rename — never by another HubSpot write. Pinned so the distinction is
  // explicit rather than discovered in production. See finding D2.
  it.each(["firstname", "lastname"])(
    "%s converges as a FIELD but leaves a name diff that only a forward rename clears", (hs) => {
      const row = ROWS.find(r => r.hs === hs)!;
      const rec = contactRec({ [hs]: row.patch });
      const card = cardFor(CRM_CONTACTS, contactRec(), { [fieldOf(CRM_CONTACTS, hs).col]: row.md });
      const diffs = fieldDiffs(rec, card, CRM_CONTACTS, ctx);
      expect(diffs.filter(d => d.kind === "field")).toEqual([]);
      expect(diffs.map(d => d.kind)).toEqual(["name"]);
      expect(buildReversePatch(diffs, card, CRM_CONTACTS, ctx)).toEqual({});   // no HubSpot write
    });

  it("company name behaves the same way (nameProps: [\"name\"], no nameReverse)", () => {
    const rec = companyRec({ name: "Acme Manufacturing Sdn Bhd" });
    const card = cardFor(CRM_ACCOUNTS, companyRec(),
      { [fieldOf(CRM_ACCOUNTS, "name").col]: "Acme Manufacturing Sdn Bhd" });
    const diffs = fieldDiffs(rec, card, CRM_ACCOUNTS, ctx);
    expect(diffs.filter(d => d.kind === "field")).toEqual([]);
    expect(diffs.map(d => d.kind)).toEqual(["name"]);
    expect(buildReversePatch(diffs, card, CRM_ACCOUNTS, ctx)).toEqual({});
  });

  // Re-running the reverse mapping over its own output must be a FIXED POINT. If it were not, a second
  // pass would send a DIFFERENT value than the first and the two sides would oscillate.
  it.each(ROWS)("$object $hs — reverseFieldValue is a fixed point on its own output", (row) => {
    const f = fieldOf(row.spec, row.hs);
    const once = reverseFieldValue(f, row.md, ctx);
    expect(once).toBe(row.patch);
    expect(reverseFieldValue(f, once, ctx)).toBe(once);
  });
});

describe("phone: DIGITS-ONLY comparison is what stops a phantom permanent diff", () => {
  const f = fieldOf(CRM_CONTACTS, "phone");
  const withPhone = (hs: string, md: string) =>
    fieldDiffsOnly(contactRec({ phone: hs }), cardFor(CRM_CONTACTS, contactRec(), { [f.col]: md }),
      CRM_CONTACTS);

  // monday re-renders a phone column by country ("<number> <countryShortName>"), so these are all the
  // SAME number as far as the sync is concerned.
  it.each([
    ["+12345678900", "+1 (234) 567-8900"],
    ["+12345678900", "+1 234-567-8900"],
    ["+12345678900", "+12345678900 US"],
    ["12345678900", "+1 234 567 8900"],   // the leading + is NOT reconciled: digits are all that count
  ])("HubSpot %j vs monday %j -> no diff", (hs, md) => expect(withPhone(hs, md)).toEqual([]));

  it("a genuinely different number DOES diff, and carries the RAW monday text", () => {
    const d = withPhone("+60123456789", "+1 (234) 567-8900");
    expect(d).toHaveLength(1);
    expect(d[0].mdText).toBe("+1 (234) 567-8900");   // raw, so the reverse write keeps the user's "+"
  });

  // reverseFieldValue must CANONICALISE, never store monday's rendered text: "12345678900 US" in a
  // HubSpot phone property would poison dialer integrations AND never self-repair (digits still match,
  // so no further diff is ever raised). reconcile.ts:118-127.
  it.each([
    ["+1 (234) 567-8900", "+12345678900"],
    ["+12345678900 US", "+12345678900"],
    ["012-345 6789", "0123456789"],       // no leading + -> bare digits, no country invented
    ["N/A", ""],                           // digitless -> nothing written
    ["ask reception", ""],
  ])("monday %j reverses to %j", (md, want) => expect(reverseFieldValue(f, md, ctx)).toBe(want));

  // A digitless monday value canonicalises to "", so raising the diff would churn forever with no
  // progress. reconcile.ts:70-73 is the guard, and it only covers the empty-HubSpot backfill branch —
  // when HubSpot HAS a value, "N/A" on the card still diffs and is then dropped from the patch.
  it("a digitless monday value never reaches HubSpot", () => {
    const rec = contactRec({ phone: "+60123456789" });
    const card = cardFor(CRM_CONTACTS, contactRec(), { [f.col]: "N/A" });
    const diffs = fieldDiffs(rec, card, CRM_CONTACTS, ctx);
    expect(diffs.filter(d => d.kind === "field")).toHaveLength(1);
    expect(buildReversePatch(diffs, card, CRM_CONTACTS, ctx)).toEqual({});
  });
});

describe("numbers: Number() normalisation, and the one-sided gap in it", () => {
  const f = fieldOf(CRM_ACCOUNTS, "annualrevenue");
  const withRevenue = (hs: string, md: string) =>
    fieldDiffsOnly(companyRec({ annualrevenue: hs }),
      cardFor(CRM_ACCOUNTS, companyRec(), { [f.col]: md }), CRM_ACCOUNTS);

  it.each([
    ["1500000", "1500000"],
    ["1500000.50", "1500000.5"],   // expectedText -> String(Number(v)) drops the trailing zero
    ["1500000.0", "1500000"],
    ["0", "0"],
  ])("HubSpot %j vs monday %j -> no diff", (hs, md) => expect(withRevenue(hs, md)).toEqual([]));

  /**
   * FINDING D3, pinned as-is. Only the HUBSPOT side is normalised (mapping.ts:112); the monday side is
   * compared raw (reconcile.ts:83 `hsText === mdText`). So a monday cell whose text is not already
   * Number()-canonical is a PERMANENT diff: every webhook re-raises it, decideDirection returns
   * "toHubspot", and the patch re-sends a value HubSpot normalises straight back.
   *
   * This asserts the CURRENT behaviour, not the desired one.
   */
  // FIXED (D3): numbers are canonicalised on BOTH sides via numText, exactly as phone is via
  // phoneDigits, so a non-canonical monday rendering no longer diffs forever.
  it("a non-canonical monday number no longer diffs — 1500000.50 == 1500000.5", () => {
    expect(withRevenue("1500000.5", "1500000.50")).toEqual([]);
    expect(withRevenue("1500000", "1,500,000")).toEqual([]);
    expect(withRevenue("1500000", "1500000.00")).toEqual([]);
  });

  it("but a genuinely different number still diffs", () => {
    const d = withRevenue("1500000", "2000000");
    expect(d).toHaveLength(1);
    expect(d[0].mdText).toBe("2000000");
  });

  // FIXED (D4): the numbers branch canonicalises what it can and REFUSES the rest, rather than
  // shipping free text into a HubSpot NUMBER property and earning a 400 that wedges the card.
  it.each([["1,500,000", "1500000"], ["1500000.50", "1500000.5"], ["  42  ", "42"], ["-3.5", "-3.5"]])(
    "canonicalises monday %j to %j before writing", (md, want) =>
      expect(reverseFieldValue(f, md, ctx)).toBe(want));

  it.each(["approx 500", "1.5M", "500-1000", "N/A", "unknown"])(
    "REFUSES non-numeric monday value %j instead of 400ing on a HubSpot number field", (md) =>
      expect(reverseFieldValue(f, md, ctx)).toBe(""));

  // A refusal must not wedge the card: buildReversePatch omits the field, the patch is empty, and the
  // engine falls through to a FORWARD write, so HubSpot's value overwrites the invalid cell.
  it("a refused number leaves the patch empty, so the card reconciles forward instead of freezing", () => {
    const rec = companyRec({ annualrevenue: "1500000" });
    const card = cardFor(CRM_ACCOUNTS, companyRec(), { [f.col]: "approx 500" });
    expect(buildReversePatch(fieldDiffs(rec, card, CRM_ACCOUNTS, ctx), card, CRM_ACCOUNTS, ctx))
      .toEqual({});
  });
});

describe("status: label <-> internal value, in both directions", () => {
  const lead = fieldOf(CRM_CONTACTS, "hs_lead_status");
  const type = fieldOf(CRM_ACCOUNTS, "type");

  it("a matching status produces no diff (the label/value mapping is applied on the forward side)", () => {
    for (const [value, label] of Object.entries(LEAD_STATUS))
      expect(fieldDiffsOnly(contactRec({ hs_lead_status: value }),
        cardFor(CRM_CONTACTS, contactRec(), { [lead.col]: label }), CRM_CONTACTS)).toEqual([]);
  });

  it("every lead-status label reverses to its INTERNAL value, never the label", () => {
    for (const [value, label] of Object.entries(LEAD_STATUS)) {
      expect(reverseFieldValue(lead, label, ctx)).toBe(value);
      if (value !== label) expect(reverseFieldValue(lead, label, ctx)).not.toBe(label);
    }
  });

  it("every company-type label reverses to its INTERNAL value", () => {
    for (const [value, label] of Object.entries(COMPANY_TYPE))
      expect(reverseFieldValue(type, label, ctx)).toBe(value);
  });

  // If the reverse ever sent the LABEL, HubSpot would 400 on the enum. Prove the patch is the value.
  it("the patch carries the internal value for both status fields", () => {
    const cRec = contactRec();
    const cCard = cardFor(CRM_CONTACTS, cRec, { [lead.col]: "Attempted to Contact" });
    expect(buildReversePatch(fieldDiffs(cRec, cCard, CRM_CONTACTS, ctx), cCard, CRM_CONTACTS, ctx))
      .toEqual({ hs_lead_status: "ATTEMPTED_TO_CONTACT" });

    const kRec = companyRec();
    const kCard = cardFor(CRM_ACCOUNTS, kRec, { [type.col]: "Vendor" });
    expect(buildReversePatch(fieldDiffs(kRec, kCard, CRM_ACCOUNTS, ctx), kCard, CRM_ACCOUNTS, ctx))
      .toEqual({ type: "VENDOR" });
  });

  /**
   * FINDING D5, pinned as-is. reverseFieldValue validates against the label dictionary ONLY on the
   * DROPDOWN branch (reconcile.ts:129-145). status falls through to `rev[text] ?? text`, so a label
   * that is not in the HubSpot enumeration is sent RAW. That is reachable in production: every monday
   * write sets create_labels_if_missing:true (monday.ts), and a rep can add a label in the board UI —
   * so a status column CAN hold a label HubSpot has never heard of.
   */
  // FIXED (D5): status now resolves the label, accepts a raw INTERNAL VALUE, and refuses anything else.
  it.each(["Totally New Label", "in progress", "New Businessss"])(
    "REFUSES unknown status label %j instead of sending it raw to the HubSpot enum", (md) =>
      expect(reverseFieldValue(lead, md, ctx)).toBe(""));

  // An internal value must still pass: every monday write sets create_labels_if_missing, so a value the
  // dictionary could not resolve at write time became a label spelled as that raw value. Refusing it
  // would block exactly the records that most need repairing, and it keeps the function a fixed point
  // on its own output.
  it("ACCEPTS a monday cell that already holds a valid HubSpot internal value", () => {
    for (const value of Object.keys(LEAD_STATUS))
      expect(reverseFieldValue(lead, value, ctx)).toBe(value);
  });

  it("still maps a known label to its internal value", () => {
    for (const [value, label] of Object.entries(LEAD_STATUS))
      expect(reverseFieldValue(lead, label, ctx)).toBe(value);
  });

  // A status field with NO label dictionary means value === label by construction (deal_currency_code
  // "USD", sales_person "Emily You"), so the raw text is already legal and must pass unchanged.
  it("passes raw text through for a status field with no dictionary", () => {
    const noDict: FieldSpec = { ...lead, labels: undefined };
    expect(reverseFieldValue(noDict, "Anything At All", ctx)).toBe("Anything At All");
  });

  // Contrast — the dropdown branch DROPS an unknown label. This is why the two-way enum plan should be
  // dropdown-shaped, and it is asserted here so the asymmetry is visible next to the status tests.
  it("a dropdown field would have dropped it instead", () => {
    const asDropdown: FieldSpec = { ...lead, type: "dropdown" };
    expect(reverseFieldValue(asDropdown, "Totally New Label", ctx)).toBe("");
    expect(reverseFieldValue(asDropdown, "In Progress", ctx)).toBe("IN_PROGRESS");
  });
});

// ---------------------------------------------------------------------------------------------------
// 4. AN EMPTY MONDAY VALUE MUST NOT CLEAR HUBSPOT.
//
// GOOD NEWS, with a caveat. It does NOT clear: reverseFieldValue returns "" for blank input
// (reconcile.ts:115-116) and buildReversePatch's `if (v) patch[d.f.hs] = v` (reconcile.ts:162) drops
// the falsy "". So the property is simply absent from the PATCH body — HubSpot keeps its value.
//
// The caveat is that this is a side effect of a falsiness check, not a declared deliberate-clear
// policy: there is no approved clear path anywhere in reconcile.ts, and any future change that made
// buildReversePatch write empty strings would start clearing HubSpot with no test failing except this
// one. That is exactly why these assertions exist.
// ---------------------------------------------------------------------------------------------------

describe("an empty monday value never clears HubSpot", () => {
  it.each(ROWS)("$object $hs — blanked column is dropped from the patch", (row) => {
    const rec = recFor(row);
    const card = cardFor(row.spec, rec, { [fieldOf(row.spec, row.hs).col]: "" });
    const diffs = fieldDiffs(rec, card, row.spec, ctx);
    // The diff IS raised (HubSpot has a value, monday does not) ...
    expect(diffs.some(d => d.kind === "field" && d.f?.hs === row.hs)).toBe(true);
    // ... but it carries no property into the patch, so nothing is cleared.
    expect(buildReversePatch(diffs, card, row.spec, ctx)).toEqual({});
  });

  it.each(ROWS)("$object $hs — reverseFieldValue itself refuses blank input", (row) => {
    const f = fieldOf(row.spec, row.hs);
    for (const blank of ["", "   ", "\t"]) expect(reverseFieldValue(f, blank, ctx)).toBe("");
  });

  // A blank column alongside a REAL edit must not smuggle a clear into the same patch.
  it("a blanked column riding with a real edit still clears nothing", () => {
    const rec = contactRec();
    const card = cardFor(CRM_CONTACTS, rec, {
      [fieldOf(CRM_CONTACTS, "jobtitle").col]: "",
      [fieldOf(CRM_CONTACTS, "phone").col]: "+1 (234) 567-8900",
    });
    const patch = buildReversePatch(fieldDiffs(rec, card, CRM_CONTACTS, ctx), card, CRM_CONTACTS, ctx);
    expect(patch).toEqual({ phone: "+12345678900" });
    expect("jobtitle" in patch).toBe(false);
  });

  // The other half of "never clears": an EMPTY HubSpot value is not filled from monday on a passive
  // reconcile unless the field is on the `backfill` allowlist AND the object is (reconcile.ts:27,67).
  // No CRM field carries `backfill`, so the passive path fills nothing at all.
  it("no CRM field is on the backfill allowlist", () => {
    for (const spec of [CRM_CONTACTS, CRM_ACCOUNTS])
      expect(spec.fields.filter(f => f.backfill)).toEqual([]);
  });

  it.each(ROWS)("$object $hs — an empty HubSpot value is NOT filled on a passive reconcile", (row) => {
    const rec = recFor(row, { [row.hs]: "" });
    const card = cardFor(row.spec, recFor(row), { [fieldOf(row.spec, row.hs).col]: row.md });
    expect(fieldDiffsOnly(rec, card, row.spec, false)).toEqual([]);
  });

  /**
   * ... but an APP SAVE does fill it, for BOTH objects. `fillEmpty` short-circuits the whole allowlist
   * including the object gate: `fillEmpty || (f.backfill && BACKFILL_OBJECTS.has(spec.object))`
   * (reconcile.ts:67). The comment three lines above it says "never for companies" (reconcile.ts:61),
   * which is true only of the passive path — see finding D6. Behaviour pinned; comment is stale.
   */
  it.each(ROWS)("$object $hs — an APP SAVE (fillEmpty) DOES fill an empty HubSpot value", (row) => {
    const rec = recFor(row, { [row.hs]: "" });
    const card = cardFor(row.spec, recFor(row), { [fieldOf(row.spec, row.hs).col]: row.md });
    const diffs = fieldDiffs(rec, card, row.spec, ctx, true);
    const mine = diffs.filter(d => d.kind === "field" && d.f?.hs === row.hs);
    expect(mine).toHaveLength(1);
    expect(mine[0].backfill).toBe(true);
    expect(buildReversePatch(diffs, card, row.spec, ctx)).toEqual({ [row.hs]: row.patch });
  });

  // The fill is id-matched: a card whose HubSpot ID column does not match the record is never a source.
  it("an app-save fill is refused when the card's HubSpot ID does not match the record", () => {
    const rec = contactRec({ jobtitle: "" });
    const card = cardFor(CRM_CONTACTS, contactRec(),
      { [CRM_CONTACTS.idCol]: "999999", [fieldOf(CRM_CONTACTS, "jobtitle").col]: "CRO" });
    expect(fieldDiffsOnly(rec, card, CRM_CONTACTS, true).some(d => d.f?.hs === "jobtitle")).toBe(false);
  });

  // Even an app save must not fill from a value that canonicalises to nothing (reconcile.ts:70-73):
  // raising it would re-diff every pass with no progress.
  it("an app-save fill is refused for a monday value that reverses to nothing", () => {
    const rec = contactRec({ phone: "" });
    const card = cardFor(CRM_CONTACTS, contactRec(), { [fieldOf(CRM_CONTACTS, "phone").col]: "N/A" });
    expect(fieldDiffsOnly(rec, card, CRM_CONTACTS, true)).toEqual([]);
  });
});

// ===================================================================================================
// THE ENGINE. Everything above is reconcile.ts in isolation; below drives sync.ts's real
// syncMondayItem -> reconcileRecord so ownership, the refusal fallthrough and the write ordering are
// proven by the PRESENCE or ABSENCE of the actual patchRecord / updateItem call.
// ===================================================================================================

const monday = vi.hoisted(() => ({
  createItem: vi.fn(), deleteItem: vi.fn(), findItemByColumn: vi.fn(), getBoardItems: vi.fn(),
  getItem: vi.fn(), getUsersByEmail: vi.fn(), moveItem: vi.fn(), setColumns: vi.fn(),
  updateItem: vi.fn(),
}));
const hubspot = vi.hoisted(() => ({
  claimOwnership: vi.fn(), createRecord: vi.fn(), getDealStageLabels: vi.fn(), getOwners: vi.fn(),
  getPropertyOptions: vi.fn(), getRecord: vi.fn(), patchRecord: vi.fn(),
  searchCompanyByDomain: vi.fn(), propertiesForSpec: vi.fn(), searchAll: vi.fn(),
  searchContactByEmail: vi.fn(), searchModifiedIds: vi.fn(),
}));
const assoc = vi.hoisted(() => ({
  reverseAssociations: vi.fn(), reverseLineItems: vi.fn(), syncAssociations: vi.fn(),
}));
const registry = vi.hoisted(() => ({
  lookupCard: vi.fn(), finishCard: vi.fn(), claimHubspotForItem: vi.fn(),
  finishHubspotForItem: vi.fn(), forgetHubspotForItem: vi.fn(),
}));
const ensure = vi.hoisted(() => ({ ensureCardForRecord: vi.fn() }));

vi.mock("../src/monday", () => monday);
vi.mock("../src/hubspot", () => ({ ...hubspot, OwnershipError: class extends Error {} }));
vi.mock("../src/associations", () => assoc);
vi.mock("../src/card-registry", () => registry);
vi.mock("../src/ensure-card", () => ensure);

const { syncMondayItem } = await import("../src/sync");

/** ENABLE_CRM selects the CRM specs EXCLUSIVELY; a real CRM_CUTOVER_AT makes claiming reachable. */
const env = { ENABLE_CRM: "true", CRM_CUTOVER_AT: CUTOVER } as unknown as Env;

beforeEach(() => {
  vi.clearAllMocks();
  monday.getUsersByEmail.mockResolvedValue({});
  monday.setColumns.mockResolvedValue(undefined);
  monday.updateItem.mockResolvedValue(undefined);
  monday.moveItem.mockResolvedValue(undefined);
  hubspot.getOwners.mockResolvedValue({});
  hubspot.getDealStageLabels.mockResolvedValue({});
  hubspot.propertiesForSpec.mockReturnValue([]);
  hubspot.patchRecord.mockResolvedValue(NEW_MOD);
  hubspot.claimOwnership.mockResolvedValue(NEW_MOD);
  hubspot.getPropertyOptions.mockImplementation(async (_e: unknown, object: string, prop: string) =>
    object === "contacts" && prop === "hs_lead_status" ? LEAD_STATUS
      : object === "companies" && prop === "type" ? COMPANY_TYPE
      : {});
  assoc.reverseAssociations.mockResolvedValue(undefined);
});

/** Drive one monday webhook for `row` with the card edited and the record in the given ownership state. */
async function drive(row: Row, over: Record<string, string>, recOver: Record<string, string> = {},
    syncState = MOD) {
  const rec = recFor(row, recOver);
  const card = cardFor(row.spec, recFor(row, recOver), over, syncState);
  monday.getItem.mockResolvedValue(card);
  hubspot.getRecord.mockResolvedValue(rec);
  const out = await syncMondayItem(env, row.spec.boardId, card.id, live, { left: 30 });
  return { out, rec, card };
}

// ---------------------------------------------------------------------------------------------------
// 2. OWNERSHIP decides, per field, at the engine.
// ---------------------------------------------------------------------------------------------------

interface State { label: string; stamp?: string; created: string; allowed: boolean }
const STATES: State[] = [
  { label: "crm-stamped", stamp: "crm", created: PRE, allowed: true },
  { label: "unstamped", created: PRE, allowed: false },
  { label: "wm-stamped", stamp: "wm", created: POST, allowed: false },
  { label: "parked (hold)", stamp: "hold", created: POST, allowed: false },
];

const stateProps = (s: State): Record<string, string> =>
  s.stamp ? { sync_owner: s.stamp, createdate: s.created } : { createdate: s.created };

describe("ownership gates the reverse write, field by field", () => {
  for (const s of STATES) {
    describe(s.label, () => {
      it.each(ROWS)(`$object $hs -> ${s.allowed ? "PATCHED" : "REFUSED"}`, async (row) => {
        const col = fieldOf(row.spec, row.hs).col;
        const { out } = await drive(row, { [col]: row.md }, stateProps(s));
        if (s.allowed) {
          expect(hubspot.patchRecord).toHaveBeenCalledTimes(1);
          expect(hubspot.patchRecord).toHaveBeenCalledWith(env, expect.anything(),
            row.object === "contacts" ? "301" : "501", { [row.hs]: row.patch }, live,
            expect.objectContaining({ allowed: true }));
          expect(monday.updateItem).not.toHaveBeenCalled();   // reverse wins; no forward write
          expect(out).toContain("updated-hubspot");
        } else {
          expect(hubspot.patchRecord).not.toHaveBeenCalled();
          // REFUSED FALLS THROUGH TO A FORWARD WRITE rather than freezing the card (sync.ts:217-237).
          expect(monday.updateItem).toHaveBeenCalledTimes(1);
          expect(monday.updateItem.mock.calls[0][4]).toMatchObject({ [col]: row.snapBack });
          expect(out).toContain("updated-monday");
        }
      });
    });
  }

  // The predicate itself, so the reason strings are pinned alongside the behaviour.
  it.each(STATES)("authorizeWrite($label) agrees with the engine", (s) => {
    const o = { ...CRM_CONTACTS.ownership!, cutoverAtMs: Date.parse(CUTOVER) };
    const auth = authorizeWrite({ id: "301", properties: stateProps(s) }, o);
    expect(auth.allowed).toBe(s.allowed);
    expect(auth.forId).toBe("301");
    if (!s.allowed) expect(auth.reason).toMatch(/unstamped|owned by wm|hands off/);
  });

  // The claim-then-write path: an UNSTAMPED POST-cutover record is claimed first, then written.
  it("an unstamped POST-cutover record is CLAIMED, then patched", async () => {
    const row = ROWS[0];
    const { out } = await drive(row, { [fieldOf(row.spec, row.hs).col]: row.md },
      { createdate: POST });
    expect(hubspot.claimOwnership).toHaveBeenCalledTimes(1);
    expect(hubspot.patchRecord).toHaveBeenCalledWith(env, expect.anything(), "301",
      { jobtitle: row.patch }, live, expect.objectContaining({ allowed: true }));
    expect(out).toContain("updated-hubspot");
  });

  // A claim that could not be written (WRITE_HUBSPOT=false today) must NOT manufacture an allow.
  it("a suppressed claim leaves the record unstamped and the write refused", async () => {
    hubspot.claimOwnership.mockResolvedValue(null);   // dry-run / writes disabled
    const row = ROWS[0];
    const { out } = await drive(row, { [fieldOf(row.spec, row.hs).col]: row.md },
      { createdate: POST });
    expect(hubspot.patchRecord).not.toHaveBeenCalled();
    expect(monday.updateItem).toHaveBeenCalledTimes(1);
    expect(out).toContain("updated-monday");
  });

  // The refusal must not freeze FORWARD-ONLY fields on the same card — the exact regression sync.ts's
  // fallthrough comment describes (11 sidebar columns starved by one Job Title typo).
  it("a refused reverse still delivers the forward-only fields on that card", async () => {
    const row = ROWS[0];
    await drive(row, { [fieldOf(row.spec, row.hs).col]: row.md,
      [fieldOf(CRM_CONTACTS, "lifecyclestage").col]: "STALE" }, stateProps(STATES[1]));
    const cv = monday.updateItem.mock.calls[0][4] as Record<string, unknown>;
    expect(cv[fieldOf(CRM_CONTACTS, "jobtitle").col]).toBe("Sales Manager");
    expect(cv[fieldOf(CRM_CONTACTS, "lifecyclestage").col]).toEqual({ label: "lead" });
  });
});

// ---------------------------------------------------------------------------------------------------
// 3 (engine). Two passes: the write happens, then the very next webhook is a no-op.
// ---------------------------------------------------------------------------------------------------

describe("the next webhook after a reverse write is a NO-OP (no rewrite loop)", () => {
  it.each(ROWS)("$object $hs", async (row) => {
    const col = fieldOf(row.spec, row.hs).col;
    const stamped = { sync_owner: "crm", createdate: PRE };

    // PASS 1 — the rep's edit reaches HubSpot.
    await drive(row, { [col]: row.md }, stamped);
    expect(hubspot.patchRecord).toHaveBeenCalledTimes(1);
    // Sync State is re-baselined to the timestamp the PATCH returned, or monday-edit wins forever.
    expect(monday.setColumns).toHaveBeenCalledWith(env, row.spec.boardId, "CARD1",
      { [row.spec.syncStateCol]: NEW_MOD }, live);

    // PASS 2 — HubSpot now holds the reversed value; the card still shows the rep's raw text.
    vi.clearAllMocks();
    monday.setColumns.mockResolvedValue(undefined);
    monday.updateItem.mockResolvedValue(undefined);
    hubspot.propertiesForSpec.mockReturnValue([]);
    hubspot.patchRecord.mockResolvedValue(NEW_MOD);
    const { out } = await drive(row, { [col]: row.md },
      { ...stamped, [row.hs]: row.patch, ...(row.object === "contacts"
        ? { lastmodifieddate: NEW_MOD } : { hs_lastmodifieddate: NEW_MOD }) }, NEW_MOD);

    expect(hubspot.patchRecord).not.toHaveBeenCalled();
    expect(monday.updateItem).not.toHaveBeenCalled();
    expect(out).toContain("skipped-in-sync");
  });

  /**
   * The one residue a reverse write leaves behind. firstname/lastname/name feed nameProps, and the
   * reverse patch returns before the forward write (sync.ts:244-246), so the card's ITEM NAME is stale
   * until the next webhook. That next pass raises a `name` diff only, which carries no reversible
   * property (neither CRM spec declares nameReverse) — so it resolves as a FORWARD RENAME with no
   * second HubSpot write. Two passes, not a loop. See finding D2 for why "the next pass" matters.
   */
  it.each(["firstname", "lastname"])(
    "a stale item name after reversing %s resolves as a forward rename, not a HubSpot write", async (hs) => {
      const row = ROWS.find(r => r.hs === hs)!;
      const rec = contactRec({ sync_owner: "crm", createdate: PRE, [hs]: row.patch,
        lastmodifieddate: NEW_MOD });
      const card = cardFor(CRM_CONTACTS, rec, {}, NEW_MOD);
      card.name = itemName(contactRec(), CRM_CONTACTS);   // still the PRE-edit name
      monday.getItem.mockResolvedValue(card);
      hubspot.getRecord.mockResolvedValue(rec);

      const out = await syncMondayItem(env, CRM_CONTACTS.boardId, "CARD1", live, { left: 30 });
      expect(hubspot.patchRecord).not.toHaveBeenCalled();
      expect(monday.updateItem).toHaveBeenCalledTimes(1);
      expect(monday.updateItem.mock.calls[0][3]).toBe(itemName(rec, CRM_CONTACTS));
      expect(out).toContain("updated-monday");
    });

  // Repeating the SAME webhook many times must stay a single write, not accumulate them.
  it("re-delivering the same in-sync webhook writes nothing, every time", async () => {
    const stamped = { sync_owner: "crm", createdate: PRE };
    for (let i = 0; i < 5; i++) {
      vi.clearAllMocks();
      monday.setColumns.mockResolvedValue(undefined);
      hubspot.propertiesForSpec.mockReturnValue([]);
      const { out } = await drive(ROWS[0], {}, stamped);
      expect(hubspot.patchRecord).not.toHaveBeenCalled();
      expect(monday.updateItem).not.toHaveBeenCalled();
      expect(out).toContain("skipped-in-sync");
    }
  });
});

// ---------------------------------------------------------------------------------------------------
// 4 (engine). The blank-column path end to end, plus the staleness it leaves behind.
// ---------------------------------------------------------------------------------------------------

describe("blanking a monday column: HubSpot keeps its value and the card snaps back", () => {
  it.each(ROWS)("$object $hs", async (row) => {
    const col = fieldOf(row.spec, row.hs).col;
    const { out } = await drive(row, { [col]: "" }, { sync_owner: "crm", createdate: PRE });
    expect(hubspot.patchRecord).not.toHaveBeenCalled();                  // nothing cleared
    expect(monday.updateItem).toHaveBeenCalledTimes(1);                  // card refilled from HubSpot
    expect(monday.updateItem.mock.calls[0][4]).toMatchObject({ [col]: row.snapBack });
    expect(out).toContain("updated-monday");
  });

  /**
   * FINDING D2, pinned as-is. reconcileRecord RETURNS after a successful reverse patch
   * (sync.ts:244-246), so anything in the same pass that the patch could not carry — a blanked column,
   * a stale item name, a forward-only field — is NOT written to monday on that pass. It heals on the
   * NEXT webhook, and CRM contacts are `skipFullReconcile: true` on a Worker with no cron triggers, so
   * "the next webhook" may never arrive. The blank stays on the card while HubSpot holds the value.
   */
  it("PINS A DEFECT: a blank riding with a real edit is left blank on the card (D2)", async () => {
    const jobtitle = fieldOf(CRM_CONTACTS, "jobtitle").col;
    const phone = fieldOf(CRM_CONTACTS, "phone").col;
    await drive(ROWS[0], { [jobtitle]: "", [phone]: "+1 (234) 567-8900" },
      { sync_owner: "crm", createdate: PRE });
    // The real edit went to HubSpot, and jobtitle was correctly NOT cleared ...
    expect(hubspot.patchRecord).toHaveBeenCalledWith(env, expect.anything(), "301",
      { phone: "+12345678900" }, live, expect.objectContaining({ allowed: true }));
    // ... but no forward write ran, so the card keeps showing an empty Job Title.
    expect(monday.updateItem).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------------------------------
// The unknown-status-label failure mode, at the engine.
// ---------------------------------------------------------------------------------------------------

describe("an unknown status label reaches HubSpot and the webhook fails", () => {
  // FIXED (D5), at the engine. The unknown label is refused before any HubSpot call, so there is no
  // 400 to escape and no wedged card: patchRecord is never reached, and the engine falls through to a
  // FORWARD write that overwrites the invalid cell with HubSpot's value. Self-healing, not frozen.
  it("an unknown status label never reaches HubSpot, and the card reconciles forward", async () => {
    hubspot.patchRecord.mockRejectedValue(new Error("patchRecord must not be called"));
    const rec = contactRec({ sync_owner: "crm", createdate: PRE });
    const card = cardFor(CRM_CONTACTS, contactRec(),
      { [fieldOf(CRM_CONTACTS, "hs_lead_status").col]: "Totally New Label" });
    monday.getItem.mockResolvedValue(card);
    hubspot.getRecord.mockResolvedValue(rec);

    await expect(syncMondayItem(env, CRM_CONTACTS.boardId, "CARD1", live, { left: 30 }))
      .resolves.toBeDefined();
    expect(hubspot.patchRecord).not.toHaveBeenCalled();
    // The forward write is what repairs the cell.
    expect(monday.updateItem).toHaveBeenCalled();
    // And no Sync State baseline was stamped, so the card re-enters "toHubspot" on every later webhook.
    expect(monday.setColumns).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------------------------------
// Cross-deployment safety: the reverse path must be unreachable for the live WM boards.
// ---------------------------------------------------------------------------------------------------

describe("the WM deployment is untouched by any of this", () => {
  it.each(["5029639630", "5029639440", "5029480547", "5028000494"])(
    "WM board %s is not routable on the CRM deployment", async (boardId) => {
      const out = await syncMondayItem(env, boardId, "CARD1", live, { left: 30 });
      expect(out).toContain("not configured");
      expect(hubspot.patchRecord).not.toHaveBeenCalled();
      expect(monday.getItem).not.toHaveBeenCalled();
    });

  // And with ENABLE_CRM unset, the CRM boards are not routable either — exclusive both ways.
  it.each([CRM_CONTACTS.boardId, CRM_ACCOUNTS.boardId])(
    "CRM board %s is not routable on the WM deployment", async (boardId) => {
      const wmEnv = {} as unknown as Env;
      const out = await syncMondayItem(wmEnv, boardId, "CARD1", live, { left: 30 });
      expect(out).toContain("not configured");
      expect(hubspot.patchRecord).not.toHaveBeenCalled();
    });
});
