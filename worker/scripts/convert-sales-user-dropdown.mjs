/**
 * Convert "Sales User" from a TEXT column to a SINGLE-SELECT DROPDOWN, on BOTH CRM boards.
 *
 * WHY. HubSpot `sales_user` is an enumeration of 42 options whose VALUES are owner ids and whose
 * LABELS are person names ("164317533" -> "Rick Antonio"). As text, monday showed the resolved name
 * but could not filter, group, or validate it.
 *
 * WHY DROPDOWN AND NOT STATUS. A status column cannot hold 42 labels: monday rejects roughly 20+ with
 * a bare HTTP 500 (verified on this account — 16 OK, 20/24/26/27 all fail). Dropdown scales (88 labels
 * verified on Vendors).
 *
 * WHY IT IS STILL SINGLE-SELECT. `limit_select: true` forces a single choice, so this behaves like a
 * picker and not like a multi-tag field — a contact has ONE sales user. The Accounts board's
 * "Partner with" column already uses exactly this setting, so the behaviour is proven here.
 *
 * DUPLICATE LABELS. sales_user contains "Rick Antonio" TWICE, under owner ids 164317533 and
 * 165857270. monday dropdown labels must be unique, so labels are de-duplicated before creation and
 * the collision is reported. This is safe because the mapping is FORWARD-ONLY: formatValue resolves
 * value -> label, and both ids resolve to the same displayed name. It would NOT be safe two-way,
 * where "Rick Antonio" could not be resolved back to a single owner id — see the note in crm.ts.
 *
 * Data is carried across: after creating the dropdown, each card's existing text value is written into
 * it, so nothing goes blank while waiting for the next HubSpot edit to re-sync the card.
 *
 *   MONDAY_API_TOKEN=… HUBSPOT_ACCESS_TOKEN=… node scripts/convert-sales-user-dropdown.mjs --plan
 *   MONDAY_API_TOKEN=… HUBSPOT_ACCESS_TOKEN=… node scripts/convert-sales-user-dropdown.mjs --apply
 *   …                                                                          … --apply --delete-old
 *
 * --apply creates the dropdown and copies the data but LEAVES the old text column in place, because
 * deleting a monday column is irreversible. Pass --delete-old only once the new column looks right
 * and the spec has been pointed at it.
 *
 * Labels are fetched from HubSpot at run time rather than transcribed, so they cannot drift.
 */
const MONDAY = "https://api.monday.com/v2";

export const BOARDS = [
  { id: "5028000495", label: "Contacts", oldCol: "text_mm6sakj3" },
  { id: "5028000496", label: "Accounts", oldCol: "text_mm6twxwe" },
];
const TITLE = "Sales User";

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

async function hubspotOptions(token, object) {
  const res = await fetch(`https://api.hubapi.com/crm/v3/properties/${object}/sales_user`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`hubspot ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return ((await res.json()).options ?? []).map(o => ({ value: String(o.value), label: String(o.label) }));
}

/** monday dropdown labels must be unique. Keep first occurrence; report every collision. */
export function dedupeLabels(options) {
  const seen = new Map();
  const collisions = [];
  for (const o of options) {
    if (!o.label) continue;
    if (seen.has(o.label)) { collisions.push({ label: o.label, values: [seen.get(o.label), o.value] }); continue; }
    seen.set(o.label, o.value);
  }
  return { labels: [...seen.keys()], collisions };
}

async function main() {
  const apply = process.argv.includes("--apply");
  const deleteOld = process.argv.includes("--delete-old");
  const mTok = process.env.MONDAY_API_TOKEN;
  const hTok = process.env.HUBSPOT_ACCESS_TOKEN;
  if (!mTok || !hTok) { console.error("MONDAY_API_TOKEN and HUBSPOT_ACCESS_TOKEN are required"); process.exit(1); }

  for (const b of BOARDS) {
    const object = b.label === "Contacts" ? "contacts" : "companies";
    const options = await hubspotOptions(hTok, object);
    const { labels, collisions } = dedupeLabels(options);
    console.log(`\n=== ${b.label} (${b.id}) — HubSpot ${object}.sales_user: ${options.length} options, ${labels.length} unique labels ===`);
    for (const c of collisions) console.log(`  duplicate label "${c.label}" under owner ids ${c.values.join(" and ")} — keeping the first`);
    if (!labels.length) { console.error("  no options returned — skipping this board"); continue; }
    if (labels.length > 100) { console.error(`  ${labels.length} labels is beyond what has been verified (88) — aborting`); process.exit(1); }

    const board = (await monday(mTok,
      "query ($b: [ID!]) { boards(ids: $b) { columns { id title type } "
      + "items_page(limit: 500) { items { id column_values { id text } } } } }",
      { b: [b.id] })).boards[0];
    const already = board.columns.find(c => c.title === TITLE && c.type === "dropdown");
    const old = board.columns.find(c => c.id === b.oldCol);
    const filled = board.items_page.items
      .map(it => ({ id: it.id, text: (it.column_values.find(c => c.id === b.oldCol) || {}).text }))
      .filter(x => x.text);

    if (already) { console.log(`  already converted -> ${already.id}`); continue; }
    if (!old) { console.log(`  old text column ${b.oldCol} not found; creating the dropdown fresh`); }
    console.log(`  ${board.items_page.items.length} cards, ${filled.length} with a Sales User value to carry over`);

    if (!apply) {
      console.log(`  WOULD create dropdown "${TITLE}" with ${labels.length} labels, limit_select: true (single-select)`);
      console.log(`  WOULD copy ${filled.length} value(s) into it`);
      console.log(`  ${deleteOld ? "WOULD" : "would NOT"} delete the old text column ${b.oldCol}`);
      console.log(`    sample labels: ${labels.slice(0, 6).join(" | ")} …`);
      continue;
    }

    // Create first: if this fails the text column and its data are untouched.
    const created = (await monday(mTok,
      "mutation ($b: ID!, $t: String!, $a: ID!, $d: CreateDropdownColumnSettingsInput!) "
      + "{ create_dropdown_column(board_id: $b, title: $t, after_column_id: $a, defaults: $d) { id title type } }",
      { b: b.id, t: `${TITLE} (new)`, a: b.oldCol,
        d: { labels: labels.map(l => ({ label: l })), limit_select: true } })).create_dropdown_column;
    console.log(`  created ${created.id} (${created.type}) with ${labels.length} labels, single-select`);

    let copied = 0, skipped = [];
    for (const item of filled) {
      if (!labels.includes(item.text)) { skipped.push(item.text); continue; }
      await monday(mTok,
        "mutation ($b: ID!, $i: ID!, $c: String!, $v: JSON!) "
        + "{ change_column_value(board_id: $b, item_id: $i, column_id: $c, value: $v) { id } }",
        { b: b.id, i: item.id, c: created.id, v: JSON.stringify({ labels: [item.text] }) });
      copied++;
    }
    console.log(`  copied ${copied} value(s)${skipped.length ? `; ${skipped.length} not a valid option and left blank: ${[...new Set(skipped)].join(", ")}` : ""}`);

    if (deleteOld && old) {
      await monday(mTok, "mutation ($b: ID!, $i: String!) { delete_column(board_id: $b, column_id: $i) { id } }",
        { b: b.id, i: b.oldCol });
      console.log(`  deleted old text column ${b.oldCol}`);
    } else if (old) {
      console.log(`  old text column ${b.oldCol} LEFT IN PLACE — re-run with --delete-old once the spec points at ${created.id}`);
    }
    await monday(mTok,
      "mutation ($b: ID!, $i: String!, $t: String!) { change_column_title(board_id: $b, column_id: $i, title: $t) { id title } }",
      { b: b.id, i: created.id, t: deleteOld ? TITLE : `${TITLE} (dropdown)` });
    console.log(`  NOW UPDATE THE SPEC: ${b.label} sales_user -> col "${created.id}", type "dropdown", labels "salesUser"`);
  }
  if (!apply) console.log("\n--plan only. Nothing created. Re-run with --apply.");
}

const invokedDirectly = process.argv[1] && process.argv[1].endsWith("convert-sales-user-dropdown.mjs");
if (invokedDirectly) main().catch(e => { console.error(String(e)); process.exit(1); });
