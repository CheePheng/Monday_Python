/**
 * Convert Contacts "Vendors-厂商来源" from a TEXT column to a MULTI-SELECT DROPDOWN.
 *
 * WHY. HubSpot `manufacturer__c` is genuinely multi-value — a live record holds
 * "49HubSpot;55Aircall" — across 89 options. As text, monday showed that raw semicolon string:
 * readable, but not filterable, not groupable, and not safely reversible. Three things change:
 *
 *   1. formatValue's `dropdown` branch SPLITS on ";" so each vendor becomes a real tag.
 *   2. reverseFieldValue's dropdown branch VALIDATES every label against the inverted dictionary and
 *      STOPS on an unknown one, where the text/status branch passes junk straight to HubSpot. That is
 *      the prerequisite for ever making this field two-way.
 *   3. A `status` column is impossible here: monday rejects 20+ labels with a bare 500 (verified —
 *      16 works, 20/24/26/27 fail), and this needs 89.
 *
 * NOT limit_select: multi-value is the whole point.
 *
 * Labels are fetched from HubSpot at run time rather than transcribed, so they cannot drift or be
 * mistyped — and the dictionary the sync uses comes from the same API call.
 *
 *   HUBSPOT_ACCESS_TOKEN=… MONDAY_API_TOKEN=… node scripts/convert-vendors-dropdown.mjs --plan
 *   HUBSPOT_ACCESS_TOKEN=… MONDAY_API_TOKEN=… node scripts/convert-vendors-dropdown.mjs --apply
 */
const MONDAY = "https://api.monday.com/v2";
const CONTACTS = "5028000495";
const OLD_TEXT_COL = "text_mm6s40ew";      // the existing TEXT column
const TITLE = "Vendors-厂商来源";

async function monday(token, query, variables = {}) {
  const res = await fetch(MONDAY, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: token, "API-Version": "2026-07" },
    body: JSON.stringify({ query, variables }),
  });
  const body = await res.json();
  if (body.errors) throw new Error(`monday: ${JSON.stringify(body.errors).slice(0, 300)}`);
  return body.data;
}

async function hubspotLabels(token) {
  const res = await fetch("https://api.hubapi.com/crm/v3/properties/contacts/manufacturer__c", {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`hubspot ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const p = await res.json();
  return (p.options ?? []).map(o => String(o.label)).filter(Boolean);
}

async function main() {
  const apply = process.argv.includes("--apply");
  const mTok = process.env.MONDAY_API_TOKEN;
  const hTok = process.env.HUBSPOT_ACCESS_TOKEN;
  if (!mTok || !hTok) { console.error("MONDAY_API_TOKEN and HUBSPOT_ACCESS_TOKEN are required"); process.exit(1); }

  const labels = await hubspotLabels(hTok);
  console.log(`HubSpot manufacturer__c: ${labels.length} option labels`);
  if (!labels.length) { console.error("no options returned — aborting"); process.exit(1); }

  const cols = (await monday(mTok, "query ($b: [ID!]) { boards(ids: $b) { columns { id title type } } }",
    { b: [CONTACTS] })).boards[0].columns;
  const existingDropdown = cols.find(c => c.title === TITLE && c.type === "dropdown");
  const oldText = cols.find(c => c.id === OLD_TEXT_COL);

  if (existingDropdown) { console.log(`already converted -> ${existingDropdown.id}`); return; }
  if (!oldText) { console.log(`old text column ${OLD_TEXT_COL} not found; will create the dropdown fresh`); }

  if (!apply) {
    console.log(`WOULD create dropdown "${TITLE}" with ${labels.length} labels (multi-select)`);
    console.log(`WOULD then delete the old TEXT column ${OLD_TEXT_COL}`);
    console.log(`  sample labels: ${labels.slice(0, 6).join(" | ")} …`);
    console.log("\n--plan only. Re-run with --apply.");
    return;
  }

  // Create first, delete second: if the create fails we still have the text column and its data.
  const created = (await monday(mTok,
    "mutation ($b: ID!, $t: String!, $a: ID!, $d: CreateDropdownColumnSettingsInput!) "
    + "{ create_dropdown_column(board_id: $b, title: $t, after_column_id: $a, defaults: $d) { id title type } }",
    { b: CONTACTS, t: TITLE + " (new)", a: OLD_TEXT_COL,
      d: { labels: labels.map(l => ({ label: l })) } })).create_dropdown_column;
  console.log(`created ${created.id} (${created.type}) with ${labels.length} labels`);

  if (oldText) {
    await monday(mTok, "mutation ($b: ID!, $i: String!) { delete_column(board_id: $b, column_id: $i) { id } }",
      { b: CONTACTS, i: OLD_TEXT_COL });
    console.log(`deleted old text column ${OLD_TEXT_COL}`);
  }
  await monday(mTok,
    "mutation ($b: ID!, $i: String!, $t: String!) { change_column_title(board_id: $b, column_id: $i, title: $t) { id title } }",
    { b: CONTACTS, i: created.id, t: TITLE });
  console.log(`renamed ${created.id} -> "${TITLE}"`);
  console.log(`\nNOW UPDATE THE SPEC: manufacturer__c must map to ${created.id} as type "dropdown".`);
}

const invokedDirectly = process.argv[1] && process.argv[1].endsWith("convert-vendors-dropdown.mjs");
if (invokedDirectly) main().catch(e => { console.error(String(e)); process.exit(1); });
