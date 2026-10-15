/**
 * Dump every live column on both CRM boards, mapped or not, as JSON on stdout.
 *
 * Read-only. This is the inventory side of the sidebar-parity work: `audit-crm-column-types.mjs`
 * only walks columns the spec already references, so an UNMAPPED column (or a missing one) is
 * invisible there. This prints the whole board.
 *
 *   MONDAY_API_TOKEN=<token> node scripts/dump-crm-columns.mjs
 */
const API = "https://api.monday.com/v2";
const BOARDS = [
  { id: "5028000495", label: "Contacts" },
  { id: "5028000496", label: "Accounts" },
];

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

/** status/dropdown settings arrive as a JSON *string*; surface the label list for type decisions. */
export function labelsOf(col) {
  if (col.type !== "status" && col.type !== "dropdown") return undefined;
  try {
    const s = JSON.parse(col.settings_str || "{}");
    const raw = s.labels ?? {};
    const list = Array.isArray(raw)
      ? raw.map(l => (typeof l === "string" ? l : l?.name)).filter(Boolean)
      : Object.values(raw).map(v => (typeof v === "string" ? v : v?.name)).filter(Boolean);
    return { count: list.length, labels: list, limitSelect: s.limit_select ?? null };
  } catch { return { count: 0, labels: [], limitSelect: null }; }
}

async function main() {
  const token = process.env.MONDAY_API_TOKEN;
  if (!token) { console.error("MONDAY_API_TOKEN is required"); process.exit(1); }
  const out = {};
  for (const b of BOARDS) {
    const board = (await gql(token,
      "query ($b: [ID!]) { boards(ids: $b) { name columns { id title type settings_str } } }",
      { b: [b.id] })).boards[0];
    out[b.label] = {
      boardId: b.id, name: board.name, columnCount: board.columns.length,
      columns: board.columns.map(c => ({ id: c.id, title: c.title, type: c.type, ...(labelsOf(c) ? { enum: labelsOf(c) } : {}) })),
    };
  }
  console.log(JSON.stringify(out, null, 2));
}

const invokedDirectly = process.argv[1] && process.argv[1].endsWith("dump-crm-columns.mjs");
if (invokedDirectly) main().catch(e => { console.error(String(e)); process.exit(1); });
