import { describe, it, expect } from "vitest";
import { readScript } from "../scripts/read-source.mjs";
import { sourceDrift, MARKER_RE, MARKETING_MARKER_RE, OUR_TYPE } from "../scripts/restore-timeline-entries.mjs";
import { MARKETING_OBJECT_NAMES, markerFor, eventKey } from "../src/marketing-emails";

/**
 * THE REPAIR SCRIPTS AND THE NEW MARKERS.
 *
 * Marketing entries carry [hubspot:marketing_email*:<id>_<created>] -- not all digits. Every script that
 * read markers as \d+ would have counted them as NATIVE monday entries (classify-twin-accounts) or as
 * marker-less (dedupe, backfill). And two of those scripts delete or rebuild entries: neither may touch
 * a marketing entry, because nothing can rebuild one from a CRM object.
 */

const sample = MARKETING_OBJECT_NAMES.map(o => markerFor(o, eventKey("aB-9", 1759040820000)));

describe("restore-timeline-entries.mjs", () => {
  it("still agrees with the Worker source it copies (the drift check passes)", () =>
    expect(sourceDrift()).toEqual([]));

  it("refuses every marketing marker as something it could restore", () => {
    for (const m of sample) {
      expect(MARKER_RE.test(m)).toBe(false);
      expect(MARKETING_MARKER_RE.test(m)).toBe(true);
    }
    expect(MARKER_RE.test("[hubspot:emails:123]")).toBe(true);
  });

  it("does not list the marketing type among the types it rebuilds", () => {
    for (const o of MARKETING_OBJECT_NAMES) expect(OUR_TYPE[o]).toBeUndefined();
  });
});

describe("dedupe-timeline.mjs", () => {
  const code = readScript("dedupe-timeline.mjs");

  it("reads widened markers, so a marketing entry is never mistaken for a marker-less one", () =>
    expect(code).toContain("const MARKER = /\\[hubspot:([a-z_]+):([A-Za-z0-9_-]+)\\]/g;"));

  it("excludes all four marketing objects -- it must never delete what nothing can restore", () => {
    for (const o of MARKETING_OBJECT_NAMES) expect(code).toContain(`"${o}"`);
    expect(code).toContain("if (NOT_RESTORABLE.has(object)) continue;");
    // ...and before the type test, so no --types value can let one through.
    expect(code.indexOf("if (NOT_RESTORABLE.has(object)) continue;"))
      .toBeLessThan(code.indexOf("if (!TYPES.includes(object)) continue;"));
  });

  it("the widened marker pattern matches what the poller writes", () => {
    for (const m of sample) expect(m).toMatch(/\[hubspot:([a-z_]+):([A-Za-z0-9_-]+)\]/);
  });
});

describe("the read-only scripts", () => {
  it("backfill-activities.mjs reads widened markers", () =>
    expect(readScript("backfill-activities.mjs")).toContain("/\\[hubspot:([a-z_]+):([A-Za-z0-9_-]+)\\]/"));

  it("classify-twin-accounts.mjs no longer counts our marketing entries as native", () =>
    expect(readScript("classify-twin-accounts.mjs")).toContain("/\\[hubspot:\\w+:[A-Za-z0-9_-]+\\]/"));
});

describe("the two new scripts", () => {
  it("the probe is read-only: GETs, plus the one contacts batch READ", () => {
    const code = readScript("probe-marketing-events.mjs");
    expect(code).not.toMatch(/method:\s*"(PATCH|PUT|DELETE)"/);
    expect(code.match(/method:\s*"POST"/g)).toHaveLength(1);
    const post = code.indexOf('method: "POST"');
    expect(code.slice(post - 200, post)).toContain("/crm/v3/objects/contacts/batch/read");
    expect(code).toContain("/email/public/v1/events");
    expect(code).not.toMatch(/console\.log\([^)]*TOKEN/);
  });

  it("the activity-type creator is dry unless --apply", () => {
    const code = readScript("create-marketing-activity-type.mjs");
    expect(code).toContain('process.argv.includes("--apply")');
    expect(code).toContain("create_custom_activity");
    expect(code.indexOf("if (!APPLY)")).toBeLessThan(code.indexOf("create_custom_activity(name"));
  });
});

describe("restore-timeline-entries.mjs keeps its CRM ids numeric", () => {
  /** It WRITES: a non-numeric id is a malformed input to report, never an id to fetch and rebuild from. */
  it("rejects a non-numeric CRM id, as it did before the marketing markers existed", () => {
    expect(MARKER_RE.test("[hubspot:emails:abc]")).toBe(false);
    expect(MARKER_RE.test("[hubspot:calls:12_3]")).toBe(false);
    expect(MARKER_RE.test("[hubspot:notes:400369925881]")).toBe(true);
  });
});
