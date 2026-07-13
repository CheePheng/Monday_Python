import { describe, it, expect } from "vitest";
import { validateBoardSchema } from "./schema";

// monday `columns { id type }` shape. Board-relation type in monday is "board_relation".
const OK_COLS = [
  { id: "numeric_mm4nz332", type: "numeric" }, { id: "color_mm4ws6k", type: "status" },
  { id: "color_mm53fh1r", type: "status" }, { id: "dropdown_mm4n4f7r", type: "dropdown" },
  { id: "numeric_mm531t6e", type: "numeric" }, { id: "color_mm53vk99", type: "status" },
  { id: "date_mm53ecz3", type: "date" }, { id: "multiple_person_mm532m82", type: "multiple-person" },
  { id: "person", type: "multiple-person" }, { id: "color_mm53cky8", type: "status" },
  { id: "color_mm532rej", type: "status" }, { id: "board_relation_mm54rrj3", type: "board_relation" },
  { id: "board_relation_mm5417sy", type: "board_relation" },
];
const OK_GROUPS = [{ id: "group_mm53yk6d", title: "Unassigned Deals" }, { id: "group_mm4nf6fw", title: "Appointment Scheduled" }];

describe("validateBoardSchema", () => {
  it("passes when all deal columns + unassigned group are present with correct types", () =>
    expect(validateBoardSchema(OK_COLS, OK_GROUPS)).toEqual({ ok: true, errors: [] }));
  it("flags a missing column", () => {
    const r = validateBoardSchema(OK_COLS.filter(c => c.id !== "numeric_mm531t6e"), OK_GROUPS);
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toContain("numeric_mm531t6e");
  });
  it("flags a wrong column type", () => {
    const bad = OK_COLS.map(c => c.id === "color_mm53fh1r" ? { ...c, type: "text" } : c);
    const r = validateBoardSchema(bad, OK_GROUPS);
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/color_mm53fh1r.*expected status.*got text/);
  });
  it("flags a missing Unassigned group", () => {
    const r = validateBoardSchema(OK_COLS, [{ id: "group_mm4nf6fw", title: "Appointment Scheduled" }]);
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toContain("Unassigned");
  });
});
