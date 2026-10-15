/**
 * IS THE ACTIVITY BELL RINGING -- and has nothing gone back to writing Last Activity Date? READ-ONLY.
 *
 * WHY THIS EXISTS. monday has no webhook for a timeline entry, so a rep's native Note or Call reaches
 * HubSpot only when a wake-up column on the Contacts card changes (webhooks.ts ACTIVITY_WAKE_COLS).
 * Until 2026-09-30 two legacy automations stamped Last Activity Date (date_mm7054jz) for every new
 * timeline entry:
 *   #09 38839624  "When {Activity} is created in Emails & Activities -> set Last Activity Date to today"
 *   #10 38841239  "When an activity/email is created in Emails & Activities -> set Last Activity Date"
 * They fired for the Worker's OWN entries too, so each marketing email entry (and a backfill's thousands)
 * would have stamped Last Activity Date and silenced the reminder workflows #03/#04/#05.
 *
 * THE MODEL SINCE 2026-09-30. #09 and #10 are both OFF (and still configured on Last Activity Date).
 * The bell is WORKFLOW 1940472437, "When an activity is created in Emails & Activities -> Set date:
 * Activity bell (sync)" (date_mm7pw446) -- a pure trigger nothing reads -- and Last Activity Date is
 * HubSpot-owned (notes_last_updated, written forward by the Worker only). So:
 *   PASS          an ACTIVE automation stamps the bell when an entry is created in Emails & Activities,
 *                 for Notes AND Call summaries, AND no active automation writes Last Activity Date. exit 0
 *   LAD-WRITER    an active automation WRITES Last Activity Date (or mentions it in a way this cannot
 *                 resolve). FAIL: ENABLE_MARKETING_EMAIL_SYNC and MARKETING_BACKFILL_FROM must stay
 *                 off -- every marketing entry would move the date and silence the reminders.     exit 3
 *   INCOMPLETE    more automations than the pages read. FAIL: a Last Activity Date writer could be
 *                 among the unread ones, so marketing stays off exactly as for LAD-WRITER.         exit 4
 *   NO-BELL       nothing active stamps the bell. FAIL: reps' monday notes and calls reach HubSpot only
 *                 when they also touch the card (webhooks.ts ringOnPersonEdit).                  exit 2
 *   BELL-PARTIAL  a bell exists but its activity-type filter misses Note or Call summary. FAIL: those
 *                 entries do not ring (a Call summary is the HubSpot call).                     exit 5
 * LAD-WRITER outranks INCOMPLETE outranks NO-BELL outranks BELL-PARTIAL.
 *
 * READS ARE NOT WRITES. A workflow's blocks are resolved structurally: each block's column fields
 * (dateColumnId, statusColumnId, columnId) are looked up in workflow_variables, and the block's ROLE
 * decides what that use is. The trigger (the block nothing points to) and the conditions ("If column
 * is empty", "If status is something": a binaryConditionMapping) READ a column; everything else is an
 * action and WRITES it. The earlier text search failed both ways on the live board: reminders #03/#04/#05
 * (which only test Last Activity Date for empty) and #08 (which only triggers on it) read as writers,
 * and the live bell -- a workflow, not a legacy recipe -- was never counted. A mention it cannot place
 * in any block still FAILS (fail closed: a false alarm costs a look, a miss costs the reminders).
 * Legacy recipes are searched in every config block except the trigger block "1".
 *
 *   node scripts/check-activity-doorbell.mjs          # prints the verdict
 *
 * Needs MONDAY_API_TOKEN in worker/.dev.vars. Prints no secrets. Sends queries only, never a mutation.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const CONTACTS_BOARD = "5028000495";
/** Last Activity Date -- HubSpot-owned now; no automation may write it. */
export const LAD_COL = "date_mm7054jz";
/** "Activity bell (sync)" -- the doorbell. Must match webhooks.ts ACTIVITY_BELL_COL. */
export const BELL_COL = "date_mm7pw446";
/** The column that is the doorbell today. */
export const DOORBELL_COL = BELL_COL;
/** The two app recipes behind #09 (activity type chosen) and #10 (every activity/email). */
export const RECIPE_TYPED = 30508869;
export const RECIPE_ANY = 30508868;
/** The live bell (2026-09-30). Informational: any workflow of the right shape counts. */
export const BELL_WORKFLOW_ID = "1940472437";
/** board_automations pages read before the answer is INCOMPLETE. */
export const MAX_PAGES = 20;

/**
 * Does an activity-type filter cover what the Worker pushes? Native Notes (HubSpot notes) and Call
 * summaries (HubSpot calls). "Any activity" covers both; an unstated filter is NOT assumed to.
 */
export function filterCovers(filter) {
  const f = String(filter ?? "").trim();
  if (!f) return { ok: false, missing: ["Note", "Call summary"], filter: "(not stated)" };
  if (/\bany\b/i.test(f)) return { ok: true, missing: [], filter: f };
  const missing = [...(/note/i.test(f) ? [] : ["Note"]), ...(/call/i.test(f) ? [] : ["Call summary"])];
  return { ok: missing.length === 0, missing, filter: f };
}

/** Every node id a block's next-config points to (direct and condition mappings alike). */
function pointedTo(blocks) {
  const out = new Set();
  const walk = v => {
    if (!v || typeof v !== "object") return;
    if (v.workflowNodeId !== undefined) out.add(String(v.workflowNodeId));
    for (const x of Object.values(v)) walk(x);
  };
  for (const b of blocks) walk(b?.nextWorkflowBlocksConfig);
  return out;
}

/**
 * How one workflow USES columns: [{ node, block, title, role, field, col }]. role is "trigger",
 * "condition" or "action"; only an action writes. A block of unknown shape is an action (fail closed).
 */
export function workflowColumnUses(w) {
  const vars = new Map((w?.workflow_variables ?? []).map(v => [String(v?.workflowVariableKey), v]));
  const blocks = w?.workflow_blocks ?? [];
  const targets = pointedTo(blocks);
  const uses = [];
  for (const b of blocks) {
    const title = String(b?.title ?? "");
    const role = !targets.has(String(b?.workflowNodeId)) && (/^when\b/i.test(title) || String(b?.workflowNodeId) === "1")
      ? "trigger"
      : b?.nextWorkflowBlocksConfig?.type === "binaryConditionMapping" || /^if\b/i.test(title) ? "condition" : "action";
    for (const [field, ref] of Object.entries(b?.inboundFieldsSourceConfig ?? {})) {
      if (!/columnid$/i.test(field)) continue;
      let val = vars.get(String(ref?.workflowVariableKey))?.config?.value;
      if (val && typeof val === "object" && typeof val.id === "string") val = val.id;   // "When date arrives": {id, kind}
      if (typeof val === "string" && val) uses.push({ node: b.workflowNodeId, block: b.blockReferenceId, title, role, field, col: val });
    }
  }
  return uses;
}

/** A workflow's trigger, in words: is it an Emails & Activities creation, and which activity types? */
export function workflowTrigger(w) {
  const desc = String(w?.description ?? w?.title ?? "");
  const ea = /activity is created in Emails\s*&\s*Activities/i.test(desc);
  const m = /Activity type:\s*([^\n]+)/i.exec(desc);
  return { emailsAndActivities: ea, filter: m ? m[1].trim() : "" };
}

const QUOTA_NOTE = "rings for EVERY Emails & Activities entry, the Worker's own custom entries included:"
  + " one automation action (and one webhook + timeline read) per marketing entry -- check the plan's"
  + " automation-action quota before MARKETING_BACKFILL_FROM or ENABLE_MARKETING_EMAIL_SYNC";

/**
 * THE VERDICT, pure. `legacy` is board_automations.legacy_automations.automations; `workflows` is
 * board_automations.items. `complete: false` when the pages ran out before the cursor did.
 */
export function classifyDoorbell(legacy = [], workflows = [], { complete = true } = {}) {
  const rows = [];
  const warnings = [];
  for (const a of legacy) {
    const cfg = a?.config ?? {};
    // Every block but the trigger's: a multi-action recipe can write in block 3 or later.
    const act = JSON.stringify(Object.entries(cfg).filter(([k]) => k !== "1").map(([, v]) => v));
    const writesLad = act.includes(LAD_COL), writesBell = act.includes(BELL_COL);
    if (!writesLad && !writesBell) continue;
    const label = String(a.description ?? `recipe ${a.recipeId}`).slice(0, 60);
    // Listed so the operator sees #09/#10 exist and are switched off; never counted in the verdict.
    if (!a.active) { rows.push({ id: a.id, kind: "off", why: `${label} (writes ${writesBell ? BELL_COL : LAD_COL})` }); continue; }
    if (writesLad) rows.push({ id: a.id, kind: "lad-writer", why: `writes Last Activity Date ${LAD_COL}: ${label}` });
    if (writesBell) {
      if (a.recipeId === RECIPE_ANY) {
        rows.push({ id: a.id, kind: "bell", covers: true, filter: "every activity/email",
          why: "every activity/email created in Emails & Activities (#10 recipe)" });
        warnings.push(`legacy ${a.id} ${QUOTA_NOTE}`);
        continue;
      }
      if (a.recipeId === RECIPE_TYPED) {
        const t = cfg["1"]?.activityType;
        const c = filterCovers(t?.title ?? t?.value?.name ?? (t?.value?.type === "any" ? "Any activity" : ""));
        rows.push({ id: a.id, kind: "bell", covers: c.ok, filter: c.filter,
          why: `activity type ${JSON.stringify(c.filter)} (#09 recipe)${c.ok ? "" : ` -- does NOT ring for ${c.missing.join(" or ")}`}` });
        if (/\bany\b/i.test(c.filter)) warnings.push(`legacy ${a.id} ${QUOTA_NOTE}`);
        continue;
      }
      // Some other trigger writes the bell: not an Emails & Activities creation, so not proof of a doorbell.
      rows.push({ id: a.id, kind: "review", why: `recipe ${a.recipeId} writes the bell ${BELL_COL}: ${label}` });
    }
  }
  for (const w of workflows) {
    if (!w?.active) continue;
    const name = String(w.description ?? w.title ?? "").split("\n").find(l => l.trim() && !/^trigger:?$/i.test(l.trim()))
      ?.trim().slice(0, 70) ?? "";
    const uses = workflowColumnUses(w);
    const text = JSON.stringify([w.workflow_blocks, w.workflow_variables]);
    const ladUses = uses.filter(u => u.col === LAD_COL), bellUses = uses.filter(u => u.col === BELL_COL);
    const ladWrites = ladUses.filter(u => u.role === "action");
    if (ladWrites.length)
      rows.push({ id: w.id, kind: "lad-writer", why: `workflow "${name}": "${ladWrites[0].title}" writes Last Activity Date ${LAD_COL}` });
    else if (ladUses.length)
      rows.push({ id: w.id, kind: "lad-reader", why: `workflow "${name}" only READS ${LAD_COL} (${[...new Set(ladUses.map(u => `${u.role} "${u.title}"`))].join(", ")})` });
    else if (text.includes(LAD_COL))
      rows.push({ id: w.id, kind: "lad-writer", why: `workflow "${name}" mentions ${LAD_COL} in no block this can resolve -- read it (fail closed)` });

    const bellWrites = bellUses.filter(u => u.role === "action");
    const trig = workflowTrigger(w);
    if (bellWrites.length && trig.emailsAndActivities) {
      const c = filterCovers(trig.filter);
      rows.push({ id: w.id, kind: "bell", covers: c.ok, filter: c.filter,
        why: `workflow "${name}": Emails & Activities creation, activity type ${JSON.stringify(c.filter)}`
          + ` -> "${bellWrites[0].title}" ${BELL_COL}${c.ok ? "" : ` -- does NOT ring for ${c.missing.join(" or ")}`}` });
      if (/\bany\b/i.test(c.filter)) warnings.push(`workflow ${w.id} ${QUOTA_NOTE}`);
      // Proven only for the legacy recipes: monday emitted '2026-09-30' -> '2026-09-30' change events for
      // them, so the 2nd and 3rd note of a day still rang. A workflow's "Set date" is unverified.
      warnings.push(`workflow ${w.id}: a same-day repeat ring is UNVERIFIED for a workflow's "Set date" --`
        + " canary: two Notes and one Call summary on one card on one day must give three bell webhooks"
        + " and three HubSpot pushes");
    } else if (bellWrites.length) {
      rows.push({ id: w.id, kind: "review", why: `workflow "${name}" writes the bell but its trigger is not an Emails & Activities creation` });
    } else if (text.includes(BELL_COL)) {
      rows.push({ id: w.id, kind: "review", why: `workflow "${name}" mentions the bell ${BELL_COL} without writing it (not counted)` });
    }
  }
  const ladWriter = rows.some(r => r.kind === "lad-writer");
  const bells = rows.filter(r => r.kind === "bell");
  const full = bells.some(r => r.covers);
  const verdict = ladWriter ? "LAD-WRITER" : !complete ? "INCOMPLETE" : !bells.length ? "NO-BELL" : !full ? "BELL-PARTIAL" : "OK";
  const exitCode = { "LAD-WRITER": 3, INCOMPLETE: 4, "NO-BELL": 2, "BELL-PARTIAL": 5, OK: 0 }[verdict];
  return { rows, warnings, verdict, exitCode };
}

// board_automations exists only from API version 2026-10 (verified 2026-09-30: 2025-10..2026-07 reject it).
async function main() {
  const env = Object.fromEntries(readFileSync(new URL("../.dev.vars", import.meta.url), "utf8")
    .split(/\r?\n/).map(l => /^\s*([A-Z0-9_]+)\s*=\s*"?(.*?)"?\s*$/.exec(l)).filter(Boolean).map(m => [m[1], m[2]]));
  const TOKEN = env.MONDAY_API_TOKEN;
  if (!TOKEN) { console.error("MONDAY_API_TOKEN is missing from worker/.dev.vars"); process.exit(1); }
  // PAGED: one page of 100 used to be the whole answer, so a writer past it was never seen.
  const legacyById = new Map();
  const workflows = [];
  let cursor = null, pages = 0;
  do {
    const r = await fetch("https://api.monday.com/v2", {
      method: "POST",
      headers: { Authorization: TOKEN, "Content-Type": "application/json", "API-Version": "2026-10" },
      body: JSON.stringify({ query: `query ($b: [ID!], $c: String) { board_automations(board_ids: $b, limit: 100, cursor: $c) {
        cursor legacy_automations items { id active title description workflow_blocks workflow_variables } } }`,
        variables: { b: [CONTACTS_BOARD], c: cursor } }),
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok || body.errors || body.error_message) {
      console.error(`monday ${r.status}: ${JSON.stringify(body.errors ?? body.error_message ?? body).slice(0, 300)}`);
      process.exit(1);
    }
    const page = body.data?.board_automations ?? {};
    for (const a of page.legacy_automations?.automations ?? []) legacyById.set(String(a.id), a);
    workflows.push(...(page.items ?? []));
    cursor = page.cursor || null;
    pages++;
  } while (cursor && pages < MAX_PAGES);
  const v = classifyDoorbell([...legacyById.values()], workflows, { complete: !cursor });
  for (const row of v.rows) console.log(`  ${row.kind.padEnd(12)} ${row.id}  ${row.why}`);
  for (const w of v.warnings) console.log(`  NOTE ${w}`);
  console.log(`\nverdict: ${v.verdict === "OK" ? "PASS" : `FAIL (${v.verdict})`}`);
  if (v.verdict === "LAD-WRITER" || v.verdict === "INCOMPLETE")
    console.log(`  ${v.verdict === "LAD-WRITER" ? `An active automation writes Last Activity Date (${LAD_COL})`
      : `More than ${MAX_PAGES} pages of automations: a Last Activity Date writer may be unread`}. Every entry\n`
      + "  the Worker writes -- each marketing email -- would move it and silence reminders #03/#04/#05.\n"
      + "  ENABLE_MARKETING_EMAIL_SYNC and MARKETING_BACKFILL_FROM must stay off until it no longer does.");
  if (v.verdict === "NO-BELL")
    console.log(`  Nothing active stamps the Activity bell (${BELL_COL}) on a new Emails & Activities entry. A native\n`
      + "  Note or Call logged with no other edit will NOT reach HubSpot. Switch the bell workflow on\n"
      + `  ("When an activity is created in Emails & Activities -> Set date: Activity bell (sync)").`);
  if (v.verdict === "BELL-PARTIAL")
    console.log("  The bell's activity-type filter misses Note or Call summary: those entries reach HubSpot only\n"
      + "  when the rep also edits, renames or posts an update on the card. Widen the bell's filter to\n"
      + "  Note AND Call summary (or Any activity -- see the quota note).");
  process.exit(v.exitCode);
}

const invoked = process.argv[1] ? resolve(process.argv[1]) : "";
if (invoked === fileURLToPath(import.meta.url)) main().catch(e => { console.error(String(e).slice(0, 300)); process.exit(1); });
