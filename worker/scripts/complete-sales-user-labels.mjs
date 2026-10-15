/**
 * Make the "Sales User" dropdowns hold EVERY sales user, then retire the old text columns.
 *
 * SPENT — DO NOT RE-RUN AGAINST CONTACTS (2026-09-15). The Contacts entry below targets
 * `dropdown_mm70mxfy`, the legacy Sales User dropdown, which was DELETED when Sales User became a
 * People column (multiple_person_mm76ygkp). Re-running would fail on that board. Kept because the
 * Accounts/Deals entries and the archived-owner reasoning below are still the live record of why the
 * dropdowns hold archived owners at all.
 *
 * THE GAP THIS CLOSES. The dropdowns were seeded from `/crm/v3/owners`, which returns only ACTIVE
 * owners — 42 of them. The portal also has 50 ARCHIVED owners, 27 with names, and 481 contacts plus
 * 32 companies still carry a `sales_user` pointing at one of those departed reps (measured live
 * 2026-09-08). For those records the label dictionary cannot resolve the id, so formatValue's
 * `dict[v] ?? v` falls back to the RAW OWNER ID, and because every monday write sets
 * `create_labels_if_missing:true`, monday would then create labels literally named "275262201".
 * That is how a picker fills up with numbers.
 *
 * So the complete label set is ACTIVE + ARCHIVED named owners. The matching source-side fix — teaching
 * getOwners about archived owners so the dictionary can resolve them to names at all — is in
 * hubspot.ts; seeding alone would not have been enough, because the id->name lookup happens there.
 *
 * LABEL IDS ARE PRESERVED. `update_dropdown_column` replaces the label list, and a monday dropdown CELL
 * stores label IDS, not text. Re-sending existing labels WITHOUT their ids would renumber them and
 * orphan every populated cell. Each existing label is therefore resent as { id, label } exactly as it
 * is, and only genuinely new names are appended without an id for monday to number.
 *
 *   MONDAY_API_TOKEN=… HUBSPOT_ACCESS_TOKEN=… node scripts/complete-sales-user-labels.mjs --plan
 *   MONDAY_API_TOKEN=… HUBSPOT_ACCESS_TOKEN=… node scripts/complete-sales-user-labels.mjs --apply
 *   …                                                                       … --apply --delete-old
 *
 * --delete-old additionally removes the superseded TEXT columns (Contacts text_mm6sakj3,
 * Accounts text_mm6twxwe). Kept behind its own flag because deleting a monday column is irreversible;
 * it refuses if the dropdown does not already hold at least as many filled cells as the text column.
 */
const MONDAY = "https://api.monday.com/v2";

export const BOARDS = [
  { id: "5028000495", label: "Contacts", dropdown: "dropdown_mm70mxfy", oldText: "text_mm6sakj3", object: "contacts" },
  { id: "5028000496", label: "Accounts", dropdown: "dropdown_mm704kf4", oldText: "text_mm6twxwe", object: "companies" },
];
const TITLE = "Sales User";

async function monday(token, query, variables = {}) {
  const res = await fetch(MONDAY, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: token, "API-Version": "2026-07" },
    body: JSON.stringify({ query, variables }),
  });
  const body = await res.json();
  if (body.errors) throw new Error(`monday: ${JSON.stringify(body.errors).slice(0, 400)}`);
  return body.data;
}

async function hubspotOwners(token, archived) {
  const out = [];
  let after;
  do {
    const url = `https://api.hubapi.com/crm/v3/owners/?limit=100${archived ? "&archived=true" : ""}${after ? `&after=${after}` : ""}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`hubspot owners ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const body = await res.json();
    for (const o of body.results ?? []) {
      const name = `${o.firstName ?? ""} ${o.lastName ?? ""}`.trim();
      if (name) out.push({ id: String(o.id), name, archived: !!archived });
    }
    after = body.paging?.next?.after;
  } while (after);
  return out;
}

/** Complete label set: every named owner, active first so an active name wins a collision. */
export function completeLabelSet(active, archived) {
  const names = [];
  const seen = new Set();
  for (const o of [...active, ...archived]) {
    if (seen.has(o.name)) continue;
    seen.add(o.name);
    names.push(o.name);
  }
  return names;
}

/** Existing labels keep their ids (cells store ids); new names are appended id-less. */
export function mergeLabels(existing, wanted) {
  const have = new Map(existing.map(l => [l.name, l.id]));
  const merged = existing.map(l => ({ id: l.id, label: l.name }));
  const added = [];
  for (const name of wanted) {
    if (have.has(name)) continue;
    merged.push({ label: name });
    added.push(name);
  }
  return { merged, added };
}

function readLabels(settingsStr) {
  const s = JSON.parse(settingsStr || "{}");
  const raw = s.labels ?? [];
  const list = Array.isArray(raw)
    ? raw.map(l => ({ id: l.id, name: l.name })).filter(l => l.name)
    : Object.entries(raw).map(([id, v]) => ({ id: Number(id), name: typeof v === "string" ? v : v?.name })).filter(l => l.name);
  return { list, limitSelect: s.limit_select ?? null };
}

async function main() {
  const apply = process.argv.includes("--apply");
  const deleteOld = process.argv.includes("--delete-old");
  const mTok = process.env.MONDAY_API_TOKEN;
  const hTok = process.env.HUBSPOT_ACCESS_TOKEN;
  if (!mTok || !hTok) { console.error("MONDAY_API_TOKEN and HUBSPOT_ACCESS_TOKEN are required"); process.exit(1); }

  const active = await hubspotOwners(hTok, false);
  const archived = await hubspotOwners(hTok, true);
  const wanted = completeLabelSet(active, archived);
  console.log(`HubSpot owners with names: ${active.length} active + ${archived.length} archived`);
  console.log(`complete label set (deduped by name): ${wanted.length}`);
  if (wanted.length > 88) { console.error(`ABORT: ${wanted.length} labels exceeds the 88 verified on this account`); process.exit(1); }

  for (const b of BOARDS) {
    const board = (await monday(mTok,
      "query ($b: [ID!]) { boards(ids: $b) { columns { id title type settings_str revision } "
      + "items_page(limit: 500) { items { id column_values { id text } } } } }",
      { b: [b.id] })).boards[0];
    const dd = board.columns.find(c => c.id === b.dropdown);
    const old = board.columns.find(c => c.id === b.oldText);
    if (!dd) { console.error(`\n${b.label}: dropdown ${b.dropdown} not found — aborting`); process.exit(1); }

    const { list, limitSelect } = readLabels(dd.settings_str);
    const { merged, added } = mergeLabels(list, wanted);
    const filledDropdown = board.items_page.items.filter(it => (it.column_values.find(c => c.id === b.dropdown) || {}).text).length;
    const filledText = old ? board.items_page.items.filter(it => (it.column_values.find(c => c.id === b.oldText) || {}).text).length : 0;

    console.log(`\n=== ${b.label} (${b.id}) ===`);
    console.log(`  dropdown "${dd.title}"  ${list.length} labels, limit_select=${limitSelect}, ${filledDropdown} cells filled`);
    console.log(`  old text column ${old ? `${b.oldText} present, ${filledText} cells filled` : "already gone"}`);
    console.log(`  labels to ADD: ${added.length}${added.length ? `  ${JSON.stringify(added.slice(0, 30))}` : ""}`);

    if (!apply) {
      if (added.length) console.log(`  WOULD update_dropdown_column -> ${merged.length} labels (existing ids preserved)`);
      if (dd.title !== TITLE) console.log(`  WOULD rename "${dd.title}" -> "${TITLE}"`);
      console.log(`  ${deleteOld && old ? "WOULD delete" : "would NOT delete"} the old text column`);
      continue;
    }

    if (added.length) {
      // `revision` is monday's optimistic-concurrency token: the mutation is rejected outright without
      // it, and rejected again if anyone edited the column since we read it. That is the behaviour we
      // want — a concurrent label edit must not be silently overwritten.
      await monday(mTok,
        "mutation ($b: ID!, $i: String!, $r: String!, $s: UpdateDropdownColumnSettingsInput!) "
        + "{ update_dropdown_column(board_id: $b, id: $i, revision: $r, settings: $s) { id } }",
        { b: b.id, i: b.dropdown, r: dd.revision, s: { labels: merged, limit_select: true } });
      console.log(`  updated -> ${merged.length} labels (${added.length} added, ${list.length} ids preserved)`);
    } else {
      console.log(`  already complete — nothing to add`);
    }

    if (dd.title !== TITLE) {
      await monday(mTok,
        "mutation ($b: ID!, $i: String!, $t: String!) { change_column_title(board_id: $b, column_id: $i, title: $t) { id title } }",
        { b: b.id, i: b.dropdown, t: TITLE });
      console.log(`  renamed "${dd.title}" -> "${TITLE}"`);
    }

    if (deleteOld && old) {
      // The dropdown must already carry at least as much data as the text column, or deleting the text
      // column loses values that were never migrated.
      if (filledDropdown < filledText) {
        console.log(`  REFUSED to delete ${b.oldText}: dropdown has ${filledDropdown} filled vs text ${filledText}`);
      } else {
        await monday(mTok, "mutation ($b: ID!, $i: String!) { delete_column(board_id: $b, column_id: $i) { id } }",
          { b: b.id, i: b.oldText });
        console.log(`  deleted old text column ${b.oldText}`);
      }
    }
  }
  if (!apply) console.log("\n--plan only. Nothing changed. Re-run with --apply.");
}

const invokedDirectly = process.argv[1] && process.argv[1].endsWith("complete-sales-user-labels.mjs");
if (invokedDirectly) main().catch(e => { console.error(String(e)); process.exit(1); });
