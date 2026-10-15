import { describe, it, expect } from "vitest";
// @ts-ignore -- node:fs in a test (the worker tsconfig has no Node types; vitest runs on Node)
import { readFileSync } from "node:fs";
import { CRM_CONTACTS } from "../../src/config/crm";
// @ts-ignore -- read-only pre-deploy scripts; importing them runs nothing (each main() runs only when invoked directly)
import { specColumnRefs } from "../../scripts/verify-spec-columns-exist.mjs";
// @ts-ignore
import { columnRefs } from "../../scripts/verify-crm-columns.mjs";

/**
 * WIRING LENS -- "did adding ObjectSpec.followUpCol change anything else?" The codebase's SPEC-KEY ENUMERATIONS are
 * the two pre-deploy checks that prove "every column a CRM spec names exists on its board" (the 2026-09-08 incident:
 * monday rejects a whole change_multiple_column_values naming an unknown column). Each lists the spec's bookkeeping
 * keys BY NAME, and neither knows the new key: 跟进提醒 (color_mm82ccsb) -- the one column the reminder writes, in a
 * mutation naming nothing else -- is never checked. Deleted or recreated on the board (a new id), every label write
 * fails, every run logs "unresolved", and no email goes out, while both checks still print OK.
 *
 * (The owner notice's two columns, ObjectSpec.ownerNotice, are missing the same way: a pre-existing gap.)
 */

const crmSrc: string = readFileSync(new URL("../../src/config/crm.ts", import.meta.url), "utf8");
/** verify-crm-columns.mjs's own slicing of a spec block out of crm.ts (specBlock, not exported). */
const specBlock = (name: string) => {
  const i = crmSrc.indexOf(`export const ${name}`);
  return crmSrc.slice(i, crmSrc.indexOf("\n};", i));
};

describe("the pre-deploy column checks cover the reminder's column", () => {
  it("CONTROL: both checks see the Contacts bookkeeping columns they list by name", () => {
    const a = specColumnRefs(CRM_CONTACTS).map((r: { col: string }) => r.col);
    const b = [...columnRefs(specBlock("CRM_CONTACTS")).keys()];
    for (const col of [CRM_CONTACTS.idCol, CRM_CONTACTS.syncStateCol, CRM_CONTACTS.linkCol!]) {
      expect(a).toContain(col);
      expect(b).toContain(col);
    }
  });

  it("verify-spec-columns-exist.mjs (specColumnRefs) checks ObjectSpec.followUpCol -- 跟进提醒 must exist", () => {
    expect(CRM_CONTACTS.followUpCol).toBe("color_mm82ccsb");
    expect(specColumnRefs(CRM_CONTACTS).map((r: { col: string }) => r.col),
      "specColumnRefs must include ObjectSpec.followUpCol (color_mm82ccsb)").toContain("color_mm82ccsb");
  });

  it("verify-crm-columns.mjs (columnRefs) checks ObjectSpec.followUpCol -- and does not list it as 'nothing maps to'", () => {
    expect([...columnRefs(specBlock("CRM_CONTACTS")).keys()],
      "columnRefs must include followUpCol (color_mm82ccsb)").toContain("color_mm82ccsb");
  });
});
