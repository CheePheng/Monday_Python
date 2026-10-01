import { describe, it, expect, vi, beforeEach } from "vitest";
import { CRM_ACCOUNTS, CRM_CONTACTS } from "../src/config/crm";
import { authorizeWrite } from "../src/ownership";
import { buildReversePatch, columnEditPatch, fieldDiffs, reverseFieldValue } from "../src/reconcile";
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

  // THE REVIEW THIS TEST FORCED (2026-09-23): Accounts now declares nameReverse, so a renamed card is a
  // real edit. What must still hold is that editing ONE column never drags the title along. On a CRM
  // board the push is built by columnEditPatch from the edited column alone, and a rename is its own
  // monday event -- so a stale or renamed title cannot ride along on a City edit.
  it.each(ROWS)("$object $hs — a renamed card adds nothing to a COLUMN edit's patch", (row) => {
    const rec = recFor(row);
    const col = fieldOf(row.spec, row.hs).col;
    const card = cardFor(row.spec, rec, { [col]: row.md });
    card.name = "Renamed By A Rep";
    expect(Object.keys(columnEditPatch(rec, card, row.spec, ctx, { cols: [col] }).patch)).toEqual([row.hs]);
  });

  it("the rename itself is its own edit: Accounts sends the name, Contacts heals it", () => {
    const acct = companyRec();
    const aCard = cardFor(CRM_ACCOUNTS, acct); aCard.name = "Acme Holdings";
    expect(columnEditPatch(acct, aCard, CRM_ACCOUNTS, ctx, { cols: [], name: true }).patch).toEqual({ name: "Acme Holdings" });
    const con = contactRec();
    const cCard = cardFor(CRM_CONTACTS, con); cCard.name = "Janet Smith";
    const r = columnEditPatch(con, cCard, CRM_CONTACTS, ctx, { cols: [], name: true });
    expect(r.patch).toEqual({});        // a contact's title is first + last name: edit those columns instead
    expect(r.healName).toBe(true);
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

  // A HubSpot rename of a company leaves only a NAME diff. With nameReverse on Accounts the record-level
  // builder would now send the stale title back -- which is exactly why CRM boards never use it: a sync
  // that no person's edit started is forward-only, and an edit that names no column pushes nothing.
  it("a HubSpot company rename is a pure name diff, and no non-edit sync can push it back", () => {
    const rec = companyRec({ name: "Acme Manufacturing Sdn Bhd" });
    const card = cardFor(CRM_ACCOUNTS, companyRec(),
      { [fieldOf(CRM_ACCOUNTS, "name").col]: "Acme Manufacturing Sdn Bhd" });
    const diffs = fieldDiffs(rec, card, CRM_ACCOUNTS, ctx);
    expect(diffs.filter(d => d.kind === "field")).toEqual([]);
    expect(diffs.map(d => d.kind)).toEqual(["name"]);
    expect(CRM_ACCOUNTS.columnLevelReverse).toBe(true);
    expect(columnEditPatch(rec, card, CRM_ACCOUNTS, ctx, { cols: [] }).patch).toEqual({});
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

  // REVERSED ON 2026-09-09. This used to assert a passthrough, on the reasoning that a status field
  // with no dictionary has value === label by construction so the raw text is already legal. That
  // conflates TRANSLATION with MEMBERSHIP: value === label only means no mapping step is needed, and
  // says nothing about whether the text is an option at all. monday lets a user rename or add a status
  // label and every write we make sets create_labels_if_missing:true, so "Anything At All" really can
  // reach the cell — and a HubSpot enumeration 400s on it, which throws before Sync State is stamped
  // and freezes the whole card. Two live CRM fields (sales_person, department_3__c) shipped in that
  // state for a few hours; both now carry dictionaries.
  it("REFUSES raw text for a status field with no dictionary", () => {
    const noDict: FieldSpec = { ...lead, labels: undefined };
    expect(reverseFieldValue(noDict, "Anything At All", ctx)).toBe("");
  });

  // The one escape hatch, and it exists only to keep the LIVE Work-Management deal_currency_code
  // behaving exactly as it did — the flag preserves a behaviour, it does not grant a new one.
  it("unless the field explicitly opts out with unvalidatedEnum", () => {
    const optedOut: FieldSpec = { ...lead, labels: undefined, unvalidatedEnum: true };
    expect(reverseFieldValue(optedOut, "Anything At All", ctx)).toBe("Anything At All");
  });

  // The prototype-key hole in the membership check itself: `dict[text] !== undefined` is truthy for
  // keys inherited from Object.prototype, so a cell reading "constructor" validated and put
  // Object.prototype.constructor — a Function — into the PATCH body. Now checked with Object.hasOwn.
  it.each(["constructor", "toString", "valueOf", "hasOwnProperty", "__proto__"])(
    "refuses the inherited Object key %s instead of returning a Function", (key) => {
      expect(reverseFieldValue(lead, key, ctx)).toBe("");
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

  // The rule is ASYMMETRIC on purpose, and the other half CHANGED on 2026-09-08. A blank monday cell
  // still never clears HubSpot (above). But a monday VALUE now DOES fill a blank HubSpot field, because
  // reps work in monday: a salesperson typing Annual Revenue into an empty field watched it silently
  // revert, which is not two-way sync. Opt-in via `spec.fillEmptyFromMonday`, never via the object-name
  // allowlists, which the live WM specs share.
  it("no CRM field needs `backfill` — the spec-level flag carries it instead", () => {
    for (const spec of [CRM_CONTACTS, CRM_ACCOUNTS]) {
      expect(spec.fields.filter(f => f.backfill)).toEqual([]);
      expect(spec.fillEmptyFromMonday).toBe(true);
    }
  });

  it.each(ROWS)("$object $hs — a monday value DOES fill an empty HubSpot value", (row) => {
    const rec = recFor(row, { [row.hs]: "" });
    const card = cardFor(row.spec, recFor(row), { [fieldOf(row.spec, row.hs).col]: row.md });
    const diffs = fieldDiffsOnly(rec, card, row.spec, false);
    expect(diffs).toHaveLength(1);
    expect(diffs[0]).toMatchObject({ hsText: "", mdText: row.md, backfill: true });
    // And it reaches the patch, so the fill is real rather than a diff that goes nowhere.
    expect(buildReversePatch(fieldDiffs(rec, card, row.spec, ctx), card, row.spec, ctx))
      .toHaveProperty(row.hs);
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
  claimOwnership: vi.fn(), createRecord: vi.fn(), getDealStageLabels: vi.fn(), getCrmStageDicts: vi.fn(), getOwners: vi.fn(),
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
  // buildCtx fetches this only when a spec declares crmStage/crmPipeline, which the CRM Deals spec does.
  hubspot.getCrmStageDicts.mockResolvedValue({ pipelines: {}, stages: {}, pipelineByStage: {} });
  hubspot.propertiesForSpec.mockReturnValue([]);
  hubspot.patchRecord.mockResolvedValue(NEW_MOD);
  hubspot.claimOwnership.mockResolvedValue(NEW_MOD);
  hubspot.getPropertyOptions.mockImplementation(async (_e: unknown, object: string, prop: string) =>
    object === "contacts" && prop === "hs_lead_status" ? LEAD_STATUS
      : object === "companies" && prop === "type" ? COMPANY_TYPE
      : {});
  assoc.reverseAssociations.mockResolvedValue(undefined);
});

/**
 * Drive one monday webhook for `row` with the card edited and the record in the given ownership state.
 *
 * The webhook names the column it is about, exactly as monday's does (`event.columnId`), so the engine
 * receives the same `edit` it gets in production. The CRM specs are column-level, and an engine call
 * that names no column is, correctly, a forward-only sync that writes nothing to HubSpot.
 */
async function drive(row: Row, over: Record<string, string>, recOver: Record<string, string> = {},
    syncState = MOD) {
  const rec = recFor(row, recOver);
  const card = cardFor(row.spec, recFor(row, recOver), over, syncState);
  monday.getItem.mockResolvedValue(card);
  hubspot.getRecord.mockResolvedValue(rec);
  const out = await syncMondayItem(env, row.spec.boardId, card.id, live, { left: 30 }, false, false,
    { cols: Object.keys(over) });
  return { out, rec, card };
}

// ---------------------------------------------------------------------------------------------------
// 2. OWNERSHIP decides, per field, at the engine.
// ---------------------------------------------------------------------------------------------------

/**
 * `allowed` is the PREDICATE (authorizeWrite, before any claim). `engine` is what a person's edit
 * actually does, and the two differ in exactly one row: an unstamped record.
 *
 * That row is the reported bug. It used to be REFUSED -- the claim rule only accepted records created
 * after CRM_CUTOVER_AT, ~96% of the portal predates it, so every edit on an older card snapped back
 * (Lifecycle Stage "1.NEW -> anything -> 1.NEW"). A person's edit on a CRM board is now itself the
 * claim basis ("human-edit"), so the record is claimed and then written. Explicit stamps are still
 * never overridden: wm and hold stay refused.
 */
interface State { label: string; stamp?: string; created: string; allowed: boolean;
  engine: "patched" | "claimed" | "refused" }
const STATES: State[] = [
  { label: "crm-stamped", stamp: "crm", created: PRE, allowed: true, engine: "patched" },
  { label: "unstamped", created: PRE, allowed: false, engine: "claimed" },
  { label: "wm-stamped", stamp: "wm", created: POST, allowed: false, engine: "refused" },
  { label: "parked (hold)", stamp: "hold", created: POST, allowed: false, engine: "refused" },
];

const stateProps = (s: State): Record<string, string> =>
  s.stamp ? { sync_owner: s.stamp, createdate: s.created } : { createdate: s.created };

/** Fields that the ITEM NAME is built from. Pushing one of them must also refresh the card's title. */
const feedsName = (row: Row) => row.spec.nameProps.includes(row.hs)
  || (row.spec.nameFallbackProps ?? []).includes(row.hs);

describe("ownership gates the reverse write, field by field", () => {
  for (const s of STATES) {
    describe(s.label, () => {
      it.each(ROWS)(`$object $hs -> ${s.engine.toUpperCase()}`, async (row) => {
        const col = fieldOf(row.spec, row.hs).col;
        const { out } = await drive(row, { [col]: row.md }, stateProps(s));
        if (s.engine !== "refused") {
          expect(hubspot.claimOwnership).toHaveBeenCalledTimes(s.engine === "claimed" ? 1 : 0);
          // A human-edit claim, never a cutover one: this record predates the cutover.
          if (s.engine === "claimed")
            expect(hubspot.claimOwnership).toHaveBeenCalledWith(env, expect.anything(),
              expect.objectContaining({ id: row.object === "contacts" ? "301" : "501" }), live, "human-edit");
          // EXACTLY the edited property, nothing else from the card.
          expect(hubspot.patchRecord).toHaveBeenCalledTimes(1);
          expect(hubspot.patchRecord).toHaveBeenCalledWith(env, expect.anything(),
            row.object === "contacts" ? "301" : "501", { [row.hs]: row.patch }, live,
            expect.objectContaining({ allowed: true }));
          // The edited cell is never rewritten on the way back. A title built from it is refreshed.
          if (feedsName(row)) {
            expect(monday.updateItem).toHaveBeenCalledTimes(1);
            expect(monday.updateItem.mock.calls[0][4]).not.toHaveProperty(col);
          } else {
            expect(monday.updateItem).not.toHaveBeenCalled();
          }
          expect(out).toContain("updated-hubspot");
        } else {
          expect(hubspot.patchRecord).not.toHaveBeenCalled();
          expect(hubspot.claimOwnership).not.toHaveBeenCalled();   // an explicit stamp is never overridden
          // REFUSED HEALS THE EDITED CELL, and only that cell -- the person sees it did not take, and
          // no other column on the card is touched.
          expect(monday.setColumns).toHaveBeenCalledTimes(1);
          const cv = monday.setColumns.mock.calls[0][3] as Record<string, unknown>;
          expect(cv).toMatchObject({ [col]: row.snapBack });
          expect(Object.keys(cv).filter(k => k !== col)).toEqual([]);
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
    const col = fieldOf(row.spec, row.hs).col;
    const { out } = await drive(row, { [col]: row.md }, { createdate: POST });
    expect(hubspot.patchRecord).not.toHaveBeenCalled();
    // The edited cell is healed back; nothing pretends the edit was saved.
    expect(monday.setColumns).toHaveBeenCalledWith(env, row.spec.boardId, "CARD1",
      { [col]: row.snapBack }, live);
    expect(out).toContain("updated-monday");
  });

  /**
   * A refusal must not freeze the rest of the card. The old engine froze it: one refused Job Title typo
   * kept every later webhook choosing "toHubspot", starving 11 forward-only sidebar columns. Here the
   * push is refused (wm owns the record) while HubSpot has NEWER changes on other columns -- those
   * must still arrive in the same pass, and the edited cell must heal.
   */
  it("a refused push still delivers HubSpot's newer changes on the other columns", async () => {
    const row = ROWS[0];
    const job = fieldOf(CRM_CONTACTS, "jobtitle").col;
    const life = fieldOf(CRM_CONTACTS, "lifecyclestage").col;
    const rec = recFor(row, { ...stateProps(STATES[2]), lastmodifieddate: NEW_MOD });
    // Card last synced at MOD; HubSpot has since moved on (NEW_MOD), so its lifecycle value is newer.
    const card = cardFor(row.spec, recFor(row, stateProps(STATES[2])), { [job]: row.md, [life]: "STALE" }, MOD);
    monday.getItem.mockResolvedValue(card);
    hubspot.getRecord.mockResolvedValue(rec);
    await syncMondayItem(env, row.spec.boardId, card.id, live, { left: 30 }, false, false, { cols: [job] });

    expect(hubspot.patchRecord).not.toHaveBeenCalled();
    const cv = monday.setColumns.mock.calls[0][3] as Record<string, unknown>;
    expect(cv[job]).toBe("Sales Manager");                 // healed: the push was refused
    expect(cv[life]).toEqual({ label: "lead" });           // HubSpot's newer value delivered
    expect(cv[row.spec.syncStateCol]).toBe(NEW_MOD);       // and the baseline moved with it
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
    // Sync State is re-baselined to the timestamp the PATCH returned. A field that feeds the item name
    // re-baselines through the same write that refreshes the title; any other field, alone.
    if (feedsName(row))
      expect(monday.updateItem.mock.calls[0][4]).toMatchObject({ [row.spec.syncStateCol]: NEW_MOD });
    else
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
   * THE STALE-TITLE RESIDUE IS GONE. The record-level engine returned straight after its reverse patch,
   * so pushing firstname/lastname left the card's ITEM NAME (built from them) stale until some later
   * webhook -- and on a column-level spec that webhook would never help, because the push's own echo
   * finds HubSpot no newer than the new Sync State. The push now refreshes the title in the same pass.
   */
  it.each(["firstname", "lastname"])(
    "pushing %s refreshes the item name in the same pass, with one HubSpot write", async (hs) => {
      const row = ROWS.find(r => r.hs === hs)!;
      const col = fieldOf(CRM_CONTACTS, hs).col;
      const { out } = await drive(row, { [col]: row.md }, { sync_owner: "crm", createdate: PRE });
      const after = contactRec({ sync_owner: "crm", createdate: PRE, [hs]: row.patch });

      expect(hubspot.patchRecord).toHaveBeenCalledTimes(1);
      expect(monday.updateItem).toHaveBeenCalledTimes(1);
      expect(monday.updateItem.mock.calls[0][3]).toBe(itemName(after, CRM_CONTACTS));
      expect(out).toContain("updated-hubspot");
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

/**
 * A CLEAR IS A REAL EDIT. The record-level engine could not tell "never set" from "just emptied", so it
 * refused to send any empty monday value and the card snapped back -- a rep could not remove a wrong
 * Job Title at all. Column-level knows the person edited exactly this cell, so emptying it clears
 * HubSpot. This also retires finding D2 (a blank riding with a real edit was left blank on the card):
 * both columns are now edits in their own right and both reach HubSpot.
 */
describe("blanking a monday column clears it in HubSpot", () => {
  it.each(ROWS)("$object $hs", async (row) => {
    const col = fieldOf(row.spec, row.hs).col;
    const { out } = await drive(row, { [col]: "" }, { sync_owner: "crm", createdate: PRE });
    expect(hubspot.patchRecord).toHaveBeenCalledWith(env, expect.anything(),
      row.object === "contacts" ? "301" : "501", { [row.hs]: "" }, live,
      expect.objectContaining({ allowed: true }));
    expect(out).toContain("updated-hubspot");
  });

  it("two columns edited together both reach HubSpot, the blank as a clear (D2 retired)", async () => {
    const jobtitle = fieldOf(CRM_CONTACTS, "jobtitle").col;
    const phone = fieldOf(CRM_CONTACTS, "phone").col;
    await drive(ROWS[0], { [jobtitle]: "", [phone]: "+1 (234) 567-8900" },
      { sync_owner: "crm", createdate: PRE });
    expect(hubspot.patchRecord).toHaveBeenCalledWith(env, expect.anything(), "301",
      { jobtitle: "", phone: "+12345678900" }, live, expect.objectContaining({ allowed: true }));
  });

  /** Only a cell that HOLDS a value in HubSpot is cleared; an empty-on-both cell sends nothing. */
  it("an empty cell over an empty HubSpot value sends nothing", async () => {
    const col = fieldOf(CRM_CONTACTS, "jobtitle").col;
    await drive(ROWS[0], { [col]: "" }, { sync_owner: "crm", createdate: PRE, jobtitle: "" });
    expect(hubspot.patchRecord).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------------------------------
// The unknown-status-label failure mode, at the engine.
// ---------------------------------------------------------------------------------------------------

describe("an unknown status label reaches HubSpot and the webhook fails", () => {
  // FIXED (D5), at the engine. The unknown label is refused before any HubSpot call, so there is no
  // 400 to escape and no wedged card: patchRecord is never reached, and the engine falls through to a
  // FORWARD write that overwrites the invalid cell with HubSpot's value. Self-healing, not frozen.
  it("an unknown status label never reaches HubSpot, and the edited cell heals", async () => {
    hubspot.patchRecord.mockRejectedValue(new Error("patchRecord must not be called"));
    const col = fieldOf(CRM_CONTACTS, "hs_lead_status").col;
    const rec = contactRec({ sync_owner: "crm", createdate: PRE });
    const card = cardFor(CRM_CONTACTS, contactRec(), { [col]: "Totally New Label" });
    monday.getItem.mockResolvedValue(card);
    hubspot.getRecord.mockResolvedValue(rec);

    await expect(syncMondayItem(env, CRM_CONTACTS.boardId, "CARD1", live, { left: 30 }, false, false,
      { cols: [col] })).resolves.toBeDefined();
    expect(hubspot.patchRecord).not.toHaveBeenCalled();
    // The heal writes HubSpot's value back into that one cell, and no Sync State is stamped: nothing
    // changed in HubSpot, so the baseline must not move.
    expect(monday.setColumns).toHaveBeenCalledWith(env, CRM_CONTACTS.boardId, "CARD1",
      { [col]: { label: "New" } }, live);
  });
});

// ---------------------------------------------------------------------------------------------------
// Cross-deployment safety: the reverse path must be unreachable for the live WM boards.
// ---------------------------------------------------------------------------------------------------

describe("the WM deployment is untouched by any of this", () => {
  /**
   * 5028000494 USED TO BE IN THIS LIST AND WAS NEVER A WM BOARD. It is the monday CRM template's
   * Deals board, listed here only because Phase 1 kept Deals out of CRM scope; the WM deal board is
   * 5029480547. Since 2026-09-14 CRM owns 5028000494, so asserting it is unroutable would now be
   * asserting the opposite of the design. The three boards below are the genuine WM ones and the
   * isolation guarantee for them is unchanged.
   */
  it.each(["5029639630", "5029639440", "5029480547"])(
    "WM board %s is not routable on the CRM deployment", async (boardId) => {
      const out = await syncMondayItem(env, boardId, "CARD1", live, { left: 30 });
      expect(out).toContain("not configured");
      expect(hubspot.patchRecord).not.toHaveBeenCalled();
      expect(monday.getItem).not.toHaveBeenCalled();
    });

  it("the CRM Deals board IS routable on the CRM deployment", async () => {
    const out = await syncMondayItem(env, "5028000494", "CARD1", live, { left: 30 });
    expect(out).not.toContain("not configured");
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
