import { describe, it, expect } from "vitest";
import { upsertRow } from "./rows";
import type { DealRow } from "./filter";

const R = (id: string, name = ""): DealRow => ({ id, name, stage: "", salesUserIds: [] });

describe("upsertRow", () => {
  it("replaces the row with the same id, keeping position", () => {
    const rows = [R("1", "a"), R("2", "b"), R("3", "c")];
    const out = upsertRow(rows, R("2", "B!"));
    expect(out.map(r => r.id)).toEqual(["1", "2", "3"]);
    expect(out[1].name).toBe("B!");
  });
  it("appends a new id", () => {
    const out = upsertRow([R("1"), R("2")], R("9", "new"));
    expect(out.map(r => r.id)).toEqual(["1", "2", "9"]);
  });
  it("does not mutate the input array", () => {
    const rows = [R("1"), R("2")];
    const copy = [...rows];
    upsertRow(rows, R("2", "x"));
    expect(rows).toEqual(copy);
  });
});
