/**
 * Create the monday columns for every HubSpot SIDEBAR field that had no home.
 *
 * The rule the portal owner set: if a field is pinned to the record's "About this contact" /
 * "About this company" sidebar, the team wants it on the board — with a column type that MATCHES the
 * HubSpot field, so a picklist becomes a picker rather than a string.
 *
 * Additive only: never deletes, never retypes. Idempotent by TITLE, so re-running adds nothing.
 *
 *   MONDAY_API_TOKEN=… HUBSPOT_ACCESS_TOKEN=… node scripts/add-sidebar-columns.mjs --plan
 *   MONDAY_API_TOKEN=… HUBSPOT_ACCESS_TOKEN=… node scripts/add-sidebar-columns.mjs --apply
 *
 * TYPE RULES, measured on this account rather than assumed:
 *   - status holds at most ~19 labels (16 OK; 20/24/26/27 all fail with a bare HTTP 500), so every
 *     picklist above that must be a dropdown.
 *   - dropdown is verified to 88 labels (Vendors). Beyond roughly 120 options a picker stops helping a
 *     rep at all, so those become text as a DELIBERATE exception with the count as the justification.
 *   - monday cannot retype or reorder a column. A wrong type here is only fixable by create+delete,
 *     which changes the column id and destroys the data — so err toward the wider type.
 *
 * EVERY field added here is FORWARD-ONLY (HubSpot -> monday) in the spec, and that is load-bearing for
 * the four big enums. reconcile.ts's reverse path ends in `return rev[text] ?? text`, so a TEXT column
 * would push whatever a rep typed straight into a HubSpot enumeration — "USA" against a property whose
 * only legal value is "United States of America". Only the dropdown branch validates.
 *
 * No label dictionaries are needed: verified live that department_3__c, countries, lead_source_sub__c
 * and city_1__c all have value === label for every option, so the raw HubSpot value already displays
 * correctly. (Contrast sales_user and lifecyclestage, where they differ and a dict is load-bearing.)
 */
const API = "https://api.monday.com/v2";

export const PLANNED = [
  // ---------------------------------------------------------------- Contacts 5028000495
  {
    board: "5028000495", title: "Mobile Phone Number", type: "phone", hs: "mobilephone",
    why: "string/phone-shaped -> monday phone. NOT covered by contact_phone, which maps the separate `phone` property; both are on the sidebar",
  },
  {
    board: "5028000495", title: "Department#", type: "dropdown", hs: "department_3__c",
    labelsFrom: { object: "contacts", prop: "department_3__c" },
    why: "enumeration, 29 single-select options -> dropdown. A 29-label status column would fail outright with a 500",
  },
  {
    board: "5028000495", title: "Industry", type: "text", hs: "industry",
    why: "the CONTACT-level `industry` is hsType string with an EMPTY options array — free text, not the ~246-option COMPANY picklist of the same name",
  },
  {
    board: "5028000495", title: "城市#", type: "text", hs: "city_1__c",
    why: "enumeration with 673 options — ~7.6x the verified 88-label dropdown ceiling and far past any usable picker, so text as a documented exception",
  },
  {
    board: "5028000495", title: "省份", type: "text", hs: "hs_state_code",
    why: "a RELABELLED standard property: hs_state_code carries the label 省份 in this portal. hsType string -> text. Distinct from province_1__c, whose label is 省份# (with hash) and which is a clean 34-option enum — the sidebar shows the hash-less one",
  },
  {
    board: "5028000495", title: "Countries", type: "text", hs: "countries",
    why: "enumeration with 198 options (12 pinned APAC + 185 alphabetical + a hand-added 'Dubai UAE'), 2.25x the dropdown ceiling -> text as a documented exception",
  },
  {
    board: "5028000495", title: "Requirement-具体需求", type: "long_text", hs: "concrete_demand",
    why: "free-text 'Specific Requirement' from the dkmeco.com web form — long_text because a requirement is prose",
  },
  {
    board: "5028000495", title: "term", type: "text", hs: "utm_term",
    why: "utm_term, a short campaign keyword string",
  },
  {
    board: "5028000495", title: "官网注册来源页面", type: "long_text", hs: "registration_page__c",
    why: "LONG_TEXT, not text. 19,504 values, of which only 1,008 are URLs and 18,496 are Chinese page TITLES; the longest live URL measures 365 chars. monday's text column cannot be widened and cannot be retyped, so a truncation here would be unrecoverable",
  },
  {
    board: "5028000495", title: "Lead Source Sub", type: "text", hs: "lead_source_sub__c",
    why: "enumeration with 558 options — 6.3x the dropdown ceiling and hopeless as a picker, so text as a documented exception",
  },
  // ---------------------------------------------------------------- Accounts 5028000496
  {
    board: "5028000496", title: "Record source", type: "text", hs: "hs_object_source_label",
    why: "TEXT, not dropdown, despite being an enumeration. The property returns options: [] from the API "
      + "(dynamic/external options, same as sales_user), so a dropdown CANNOT be seeded — and an unseeded "
      + "one would grow unbounded past the 88-label ceiling via create_labels_if_missing, because HubSpot "
      + "adds new record sources on its own schedule. Read-only system metadata, so forward-only anyway",
  },
];

const BOARD_NAMES = { "5028000495": "Contacts", "5028000496": "Accounts" };

async function gql(token, query, variables = {}) {
  const res = await fetch(API, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: token, "API-Version": "2026-07" },
    body: JSON.stringify({ query, variables }),
  });
  const body = await res.json();
  if (body.errors) throw new Error(`monday: ${JSON.stringify(body.errors).slice(0, 300)}`);
  return body.data;
}

/** Labels straight from HubSpot at run time, so a transcription cannot drift or be mistyped. */
async function hubspotLabels(token, object, prop) {
  const res = await fetch(`https://api.hubapi.com/crm/v3/properties/${object}/${prop}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`hubspot ${res.status} for ${object}.${prop}: ${(await res.text()).slice(0, 200)}`);
  const labels = ((await res.json()).options ?? []).map(o => String(o.label)).filter(Boolean);
  return [...new Set(labels)];   // monday requires unique labels
}

async function main() {
  const apply = process.argv.includes("--apply");
  const mTok = process.env.MONDAY_API_TOKEN;
  const hTok = process.env.HUBSPOT_ACCESS_TOKEN;
  if (!mTok) { console.error("MONDAY_API_TOKEN is required"); process.exit(1); }
  if (!hTok && PLANNED.some(p => p.labelsFrom)) { console.error("HUBSPOT_ACCESS_TOKEN is required to seed dropdown labels"); process.exit(1); }

  const live = {};
  for (const b of Object.keys(BOARD_NAMES)) {
    const cols = (await gql(mTok, "query ($b: [ID!]) { boards(ids: $b) { columns { id title type } } }",
      { b: [b] })).boards[0].columns;
    live[b] = cols;
    console.log(`${BOARD_NAMES[b]} ${b}: ${cols.length} existing columns`);
  }
  console.log("");

  const created = [];
  for (const p of PLANNED) {
    const existing = live[p.board].find(c => c.title === p.title);
    const tag = `${BOARD_NAMES[p.board]}/${p.title}`;
    if (existing) {
      const match = existing.type === p.type ? "type matches" : `TYPE MISMATCH: live=${existing.type} wanted=${p.type}`;
      console.log(`  skip     ${tag} — already exists as ${existing.id} (${match})`);
      created.push({ ...p, id: existing.id, preexisting: true });
      continue;
    }

    let labels = null;
    if (p.labelsFrom) {
      labels = await hubspotLabels(hTok, p.labelsFrom.object, p.labelsFrom.prop);
      if (!labels.length) { console.error(`  ABORT    ${tag} — HubSpot returned no options for ${p.labelsFrom.prop}`); process.exit(1); }
      if (labels.length > 88) { console.error(`  ABORT    ${tag} — ${labels.length} labels exceeds the 88 verified on this account`); process.exit(1); }
    }

    if (!apply) {
      console.log(`  WOULD create  ${p.type.padEnd(10)} ${tag}${labels ? `  [${labels.length} labels]` : ""}  <- hs \`${p.hs}\``);
      console.log(`                 ${p.why}`);
      continue;
    }

    let col;
    if (p.type === "dropdown") {
      col = (await gql(mTok,
        "mutation ($b: ID!, $t: String!, $d: CreateDropdownColumnSettingsInput!) "
        + "{ create_dropdown_column(board_id: $b, title: $t, defaults: $d) { id title type } }",
        { b: p.board, t: p.title, d: { labels: labels.map(l => ({ label: l })), limit_select: true } }))
        .create_dropdown_column;
    } else {
      col = (await gql(mTok,
        "mutation ($b: ID!, $t: String!, $ct: ColumnType!) "
        + "{ create_column(board_id: $b, title: $t, column_type: $ct) { id title type } }",
        { b: p.board, t: p.title, ct: p.type })).create_column;
    }
    console.log(`  created  ${col.id.padEnd(26)} ${col.type.padEnd(10)} ${tag}${labels ? `  [${labels.length} labels]` : ""}`);
    created.push({ ...p, id: col.id });
  }

  if (!apply) { console.log("\n--plan only. Nothing created. Re-run with --apply."); return; }

  console.log("\n=== SPEC MAPPINGS to add to worker/src/config/crm.ts (all FORWARD-ONLY) ===");
  for (const c of created)
    console.log(`  ${BOARD_NAMES[c.board].padEnd(9)} { hs: "${c.hs}", col: "${c.id}", type: "${c.type}" },`);
  console.log("\nREMINDER: a mapping alone is not enough — each property also needs an");
  console.log("`object.propertyChange` subscription in hubspot-crm-webhook-sync/webhooks-hsmeta.json,");
  console.log("or HubSpot edits to it will never reach the Worker.");
}

const invokedDirectly = process.argv[1] && process.argv[1].endsWith("add-sidebar-columns.mjs");
if (invokedDirectly) main().catch(e => { console.error(String(e)); process.exit(1); });
