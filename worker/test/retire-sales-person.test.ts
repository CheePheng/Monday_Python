import { describe, it, expect } from "vitest";
import { assigneeColumnsFromLogs, countFilled, TARGETS } from "../scripts/retire-sales-person-columns.mjs";

/**
 * The one piece of genuinely dangerous logic in the Sales Person retirement: the guard that decides
 * whether a column being deleted still grants people edit access.
 *
 * Board 5028000495 is `permissions: "assignee"` on a `board_kind: "public"` board, which monday's own
 * dialog describes as "Choose the contacts that members can edit" — EDIT-scoped, not visibility. The
 * assignee column list is UI-only state: the Board type exposes `permissions` as the bare string
 * "assignee" and nothing more. The board's activity log is therefore the ONLY machine-readable source
 * for which columns those are, and every way of misreading it fails silently in the dangerous
 * direction — reading `previous_value` instead of `value`, or an older event instead of the newest,
 * would report a permission state that has not been true for hours and wave the deletion through.
 */

/** The real payload monday wrote on 2026-09-15T04:42:21Z, when assignment moved to Sales User. */
const REAL_EVENT = {
  event: "update_board_permissions",
  created_at: "17879504410720000",
  data: JSON.stringify({
    board_name: "Contacts", board_id: 5028000495, view_type: "permission",
    previous_value: { assignee_column_titles: ["multiple_person_mm6zap53"], permission: "assignee" },
    value: { assignee_column_titles: ["multiple_person_mm6zap53", "multiple_person_mm76ygkp"], permission: "assignee" },
  }),
};

const noise = (n: number) => ({
  event: "update_column_value", created_at: String(17879504410720000 - n),
  data: JSON.stringify({ column_id: "text_mm6twy4w", column_title: "Sync State" }),
});

describe("the assignee-column guard", () => {
  it("reads the NEW value, never the previous one", () => {
    const got = assigneeColumnsFromLogs([REAL_EVENT]);
    expect(got?.columns).toEqual(["multiple_person_mm6zap53", "multiple_person_mm76ygkp"]);
    // The failure that matters: previous_value held ONLY Contact owner. Reading it would describe a
    // board where Sales User grants nothing — and the next permission change would be judged against
    // a state that stopped being true the moment this event was written.
    expect(got?.columns).toContain("multiple_person_mm76ygkp");
  });

  // activity_logs comes back newest-first, so the first match wins. If that ordering assumption were
  // wrong the guard would evaluate a superseded permission, which is the whole failure mode.
  it("takes the newest permission event when several are present", () => {
    const older = {
      ...REAL_EVENT, created_at: "17879504410000000",
      data: JSON.stringify({ value: { assignee_column_titles: ["multiple_person_mm76qtz7"], permission: "assignee" } }),
    };
    expect(assigneeColumnsFromLogs([REAL_EVENT, older])?.columns)
      .toEqual(["multiple_person_mm6zap53", "multiple_person_mm76ygkp"]);
  });

  // "No answer" and "an answer of none" must not look alike: the caller REFUSES on null and would
  // proceed on []. A log window that simply does not reach back far enough is the common case.
  it("returns null — not an empty list — when no permission event is in range", () => {
    expect(assigneeColumnsFromLogs([noise(1), noise(2), noise(3)])).toBeNull();
  });

  it("steps over a malformed entry instead of throwing", () => {
    const broken = { event: "update_board_permissions", created_at: "1", data: "{not json" };
    expect(assigneeColumnsFromLogs([broken, REAL_EVENT])?.columns)
      .toEqual(["multiple_person_mm6zap53", "multiple_person_mm76ygkp"]);
  });

  // The guard's actual verdict on the live board, stated as an assertion rather than as a claim in a
  // commit message: not one of the three doomed columns grants edit access.
  it("none of the three retired columns is an assignee column on the live board", () => {
    const live = assigneeColumnsFromLogs([REAL_EVENT])!.columns;
    for (const t of TARGETS)
      expect(live, `${t.id} still grants edit access`).not.toContain(t.id);
  });
});

describe("what is being deleted is what the script says", () => {
  // Each target is pinned to a title AND a type. monday column ids are opaque, so an id typo that
  // happened to hit another column would otherwise delete the wrong one silently.
  it("names all three columns with both an expected title and type", () => {
    expect(TARGETS.map((t: { id: string }) => t.id)).toEqual([
      "multiple_person_mm76qtz7", "color_mm701ff2", "dropdown_mm70mxfy",
    ]);
    for (const t of TARGETS) {
      expect(t.expectTitle, `${t.id} has no expected title`).toBeTruthy();
      expect(t.expectType, `${t.id} has no expected type`).toBeTruthy();
      expect(t.why, `${t.id} has no stated reason`).toBeTruthy();
    }
  });

  it("does not target Sales User or Contact owner", () => {
    const ids = TARGETS.map((t: { id: string }) => t.id);
    expect(ids).not.toContain("multiple_person_mm76ygkp");   // Sales User — the survivor
    expect(ids).not.toContain("multiple_person_mm6zap53");   // Contact owner
  });

  it("counts a filled cell but not an empty, null or missing one", () => {
    const items = [
      { id: "1", column_values: [{ id: "color_mm701ff2", value: "{\"index\":1}" }] },
      { id: "2", column_values: [{ id: "color_mm701ff2", value: null }] },
      { id: "3", column_values: [{ id: "color_mm701ff2", value: "" }] },
      { id: "4", column_values: [{ id: "other", value: "x" }] },
    ];
    expect(countFilled(items, "color_mm701ff2")).toBe(1);
  });
});
