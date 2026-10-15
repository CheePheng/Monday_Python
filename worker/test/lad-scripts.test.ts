import { describe, it, expect } from "vitest";
import { readScript, readCode, readSource, readScriptSource } from "../scripts/read-source.mjs";
import { STALE_OBJECTS, LAD_PROP, localDay, cardDay, classifyStale } from "../scripts/find-stale-lad.mjs";
import {
  eligibleNative, nativeSince, itemIdsFromLogs, batches, WAKE_COLS, INTEGRATION_USER_ID, CONTACTS_BOARD, DEFAULT_SINCE,
  TIMELINE_PAGE, TIMELINE_MAX_PAGES,
} from "../scripts/wake-timelines.mjs";
import { TIMELINE_PAGE as WORKER_TIMELINE_PAGE, TIMELINE_MAX_PAGES as WORKER_TIMELINE_MAX_PAGES } from "../src/activity-sync";
import { CRM_SPECS, CRM_CONTACTS } from "../src/config/crm";
import { dateCell } from "../src/mapping";
import { eligibleForHubspot } from "../src/activities";
import { ACTIVITY_WAKE_COLS } from "../src/webhooks";

/**
 * THE REPAIR SCRIPTS FOR THE 2026-09-30 LAST ACTIVITY GAP: their pure halves, and their shape.
 * They are top-level programs with live credentials, so what can be pinned without them is pinned here:
 * that they name the same boards and columns as the Worker, apply the same rules, and never write.
 */

describe("scripts/find-stale-lad.mjs", () => {
  it.each(Object.entries(STALE_OBJECTS))("%s names the same board and columns as the Worker's spec", (object, o) => {
    const spec = CRM_SPECS.find(s => s.object === object)!;
    expect(spec).toBeTruthy();
    expect(o.board).toBe(spec.boardId);
    expect(o.idCol).toBe(spec.idCol);
    expect(o.syncStateCol).toBe(spec.syncStateCol);
    expect(o.modifiedProp).toBe(spec.modifiedProp);
    const f = spec.fields.find(x => x.hs === LAD_PROP)!;
    expect(o.ladCol).toBe(f.col);
    expect(f.localDate).toBe(true);
  });

  it("reads the day exactly as the Worker writes it (mapping.ts dateCell, Asia/Shanghai)", () => {
    const f = CRM_CONTACTS.fields.find(x => x.hs === LAD_PROP)!;
    for (const v of ["2026-09-30T15:59:59.999Z", "2026-09-30T16:00:00Z", "2026-01-01T00:00:00Z", "2026-09-30"])
      expect(localDay(v)).toBe(dateCell(f, v));
    expect(localDay(null)).toBe("");
    expect(localDay("")).toBe("");
  });

  it("reads a monday date cell from its value, else its text", () => {
    expect(cardDay({ value: JSON.stringify({ date: "2026-09-30" }), text: "x" })).toBe("2026-09-30");
    expect(cardDay({ value: null, text: "2026-09-29" })).toBe("2026-09-29");
    expect(cardDay(null)).toBe("");
  });

  it("lists a card only when it differs AND HubSpot is newer than Sync State -- what a non-forced sync fixes", () => {
    const base = { cardLad: "2026-09-29", hsLad: "2026-09-30T02:00:00Z", hsModified: "2026-09-30T02:00:05Z", syncState: "2026-09-30T01:00:00Z" };
    expect(classifyStale(base)).toBe("stale");
    expect(classifyStale({ ...base, syncState: "2026-09-30T02:00:05Z" })).toBe("differs-not-newer");
    expect(classifyStale({ ...base, cardLad: "2026-09-30" })).toBe("in-line");
    // 16:00Z is the NEXT Shanghai day: a card showing the UTC day is stale, not in line.
    expect(classifyStale({ ...base, hsLad: "2026-09-30T16:30:00Z", cardLad: "2026-09-30" })).toBe("stale");
    // A card never synced ("not synced -- needs ...", or empty) reads as older than anything.
    expect(classifyStale({ ...base, syncState: "not synced — needs email" })).toBe("stale");
    // Both empty is in line.
    expect(classifyStale({ ...base, cardLad: "", hsLad: null })).toBe("in-line");
  });

  it("HubSpot EMPTY with a date on the card is its own bucket: no sync can clear it, so it is in neither file", () => {
    const base = { cardLad: "2026-09-29", hsModified: "2026-09-30T02:00:05Z", syncState: "2026-09-30T01:00:00Z" };
    expect(classifyStale({ ...base, hsLad: null })).toBe("hubspot-empty");
    expect(classifyStale({ ...base, hsLad: "" })).toBe("hubspot-empty");
    expect(classifyStale({ ...base, hsLad: null, syncState: "2026-10-01T00:00:00Z" })).toBe("hubspot-empty");
    const code = readScript("find-stale-lad.mjs");
    expect(code).toMatch(/if \(k === "stale"\)/);
    expect(code).toMatch(/if \(k === "differs-not-newer"\) needsForce\.push/);
    expect(code).not.toMatch(/hubspot-empty"\) (stale|needsForce)\.push/);
  });

  it("never overwrites an earlier run's files: one -HHMMSS suffix for the whole run when any name exists", () => {
    const code = readScript("find-stale-lad.mjs");
    expect(code).toMatch(/const suffix = base\.some\(f => existsSync\(join\(OUT, f\)\)\)/);
    for (const f of ["idsFile", "forceFile", "sumFile"]) expect(code).toMatch(new RegExp(`const ${f} = named\\(`));
  });

  it("is read-only: monday queries and HubSpot batch/read only", () => {
    const code = readScript("find-stale-lad.mjs");
    expect(code).not.toMatch(/\bmutation\b/);
    expect(code).not.toMatch(/method: "(PATCH|PUT|DELETE)"/);
    const posts = code.match(/https:\/\/api\.hubapi\.com[^`"]*/g) ?? [];
    expect(posts.every(p => p.includes("/batch/read"))).toBe(true);
  });
});

describe("scripts/wake-timelines.mjs", () => {
  it("names the Worker's wake-up columns, board and integration user", () => {
    expect([...WAKE_COLS].sort()).toEqual([...ACTIVITY_WAKE_COLS].sort());
    expect(CONTACTS_BOARD).toBe(CRM_CONTACTS.boardId);
    expect(readScript("lib/repair-preflight.mjs")).toContain(`INTEGRATION_USER_ID = "${INTEGRATION_USER_ID}"`);
    expect(DEFAULT_SINCE).toBe("2026-09-30T09:00:00Z");
  });

  it("counts an entry exactly when the Worker would push it (eligibleForHubspot)", () => {
    const cases = [
      { type: "note", custom_activity_id: null, content: "spoke" },
      { type: "activity", custom_activity_id: null, content: "call" },
      { type: "custom", custom_activity_id: "abc", content: "ours" },
      { type: "note", custom_activity_id: null, content: "x [hubspot:marketing_email_open:k:1]" },
      { type: "email", custom_activity_id: null, content: "e" },
      { type: "note", custom_activity_id: "abc", content: "ours, typed note" },
    ];
    for (const c of cases) expect(eligibleNative(c)).toBe(eligibleForHubspot(c));
  });

  it("keeps only native entries since --since", () => {
    const since = Date.parse("2026-09-30T09:00:00Z");
    const got = nativeSince([
      { id: "a", type: "note", custom_activity_id: null, created_at: "2026-09-30T09:22:16.670Z" },
      { id: "b", type: "note", custom_activity_id: null, created_at: "2026-09-30T08:59:59Z" },
      { id: "c", type: "custom", custom_activity_id: "x", created_at: "2026-09-30T10:00:00Z" },
    ], since);
    expect(got.map(e => e.id)).toEqual(["a"]);
  });

  it("takes item ids from activity logs, by column, leaving out our own token's stamps", () => {
    const logs = [
      { user_id: -4, data: JSON.stringify({ pulse_id: 11, column_id: "date_mm7054jz" }) },
      { user_id: 104231431, data: JSON.stringify({ pulse_id: 12, column_id: "date_mm7pw446" }) },
      { user_id: 104118038, data: JSON.stringify({ pulse_id: 13, column_id: "date_mm7054jz" }) },   // our forward sync
      { user_id: 104231431, data: JSON.stringify({ pulse_id: 14, column_id: "text_x" }) },
      { user_id: 1, data: "not json" },
    ];
    expect([...itemIdsFromLogs(logs, { columns: WAKE_COLS, excludeUser: INTEGRATION_USER_ID })].sort()).toEqual(["11", "12"]);
    expect(itemIdsFromLogs(logs).size).toBe(4);
  });

  it("reads a timeline exactly as the Worker does: same page size, same page bound, paged by cursor", () => {
    expect(TIMELINE_PAGE).toBe(WORKER_TIMELINE_PAGE);
    expect(TIMELINE_MAX_PAGES).toBe(WORKER_TIMELINE_MAX_PAGES);
    const code = readScript("wake-timelines.mjs");
    expect(code).toContain("timeline_items_page(limit: $l, cursor: $c)");
    expect(code).toContain("{ i: it, l: TIMELINE_PAGE, c: cursor }");
    expect(readCode("activity-sync.ts")).toContain("{ i: itemId, l: TIMELINE_PAGE, c: cursor }");
  });

  it("board-log leaves out the integration user; --items and recent-activity are read first", () => {
    const code = readScript("wake-timelines.mjs");
    expect(code).toContain('add("board-log", itemIdsFromLogs(recent.rows, { excludeUser: INTEGRATION_USER_ID }))');
    const at = (k: string) => code.indexOf(`add("${k}"`);
    expect(at("items")).toBeLessThan(at("recent-activity"));
    expect(at("recent-activity")).toBeLessThan(at("board-log"));
    // activity_logs are newest first: a stopped walk dropped the OLDEST events.
    expect(code).not.toMatch(/the newest events beyond that are not read/);
  });

  it("marks cards it listed that the Worker answered nothing-to-sync for", () =>
    expect(readScript("wake-timelines.mjs")).toContain("report.workerFoundNothing = cards.filter("));

  it("sends at most 20 cards a request -- the route's limit", () => {
    const b = batches(Array.from({ length: 45 }, (_, i) => String(i)));
    expect(b.map(x => x.length)).toEqual([20, 20, 5]);
  });

  it("is a dry run unless --apply, reads monday only, and its one call is the Worker's /wake-timeline", () => {
    const code = readScript("wake-timelines.mjs");
    expect(code).toContain('const APPLY = argv.includes("--apply")');
    expect(code).toMatch(/if \(APPLY && cards\.length\)/);
    expect(code).toContain("refusing a mutation");
    expect(code).not.toMatch(/\bmutation\s*[({]/);
    expect(code.match(/fetch\(`\$\{WORKER\}\/[a-z-]+`/g)).toEqual(["fetch(`${WORKER}/wake-timeline`"]);
  });
});

describe("the docs say what --no-force and /wake-timeline really do", () => {
  it("--no-force does not promise that a pending edit is never reverted", () => {
    const doc = readScriptSource("refresh-forward.mjs");
    expect(doc).not.toMatch(/pending monday edit is never reverted/);
    expect(doc).toMatch(/UNLESS HubSpot has itself changed/);
  });
  it("/wake-timeline and --apply say they write HubSpot even under DRY_RUN", () => {
    expect(readSource("index.ts")).toMatch(/IT WRITES HUBSPOT WHATEVER DRY_RUN OR WRITE_HUBSPOT SAY/);
    expect(readScriptSource("wake-timelines.mjs")).toMatch(/WRITES HUBSPOT \(notes and calls\) even when the Worker's DRY_RUN/);
  });
});

describe("scripts/refresh-forward.mjs --no-force", () => {
  it("sends forceForward:false when asked, and forceForward:true otherwise, and records which", () => {
    const code = readScript("refresh-forward.mjs");
    expect(code).toContain('const FORCE = !argv.includes("--no-force")');
    expect(code).toContain("forceForward: FORCE, dryRun: !APPLY");
    expect(code).not.toContain("forceForward: true");
    expect(code).toMatch(/force: FORCE/);
    // --skip-done must never resume a forced run as a non-forced one, or the other way round.
    expect(code).toMatch(/\(prev\.force \?\? true\) !== FORCE/);
  });
});

describe("scripts/cleanup-extra-cards.mjs and the bell", () => {
  it("counts the bell workflow's stamp (as 104231431) as an automation's, never a person's edit", () => {
    const code = readScript("cleanup-extra-cards.mjs");
    expect(code).toContain('import { BELL_COL } from "./check-activity-doorbell.mjs";');
    expect(code).toMatch(/const LAD_COLS = new Set\(\[[^\]]*BELL_COL\]\)/);
    expect(code).toMatch(/r\.user === WORKFLOW_USER && LAD_COLS\.has\(r\.col\)/);
  });
});
