import { describe, it, expect } from "vitest";
import { colText } from "../src/dedup";
import { columnEditPatch, fieldDiffs } from "../src/reconcile";
import { CRM_ACCOUNTS } from "../src/config/crm";
import type { Ctx, HsRecord, MondayItem } from "../src/types";

/**
 * THE PHANTOM "OTHER".
 *
 * monday renders an UNSET status cell with the label at index 5. On the Accounts "Type" column that label
 * is "Other", so 25,656 empty cells read `text: "Other"` with `index: null` -- verified on the live board,
 * 2026-09-23 (`{"index":2,...}` for a real value, `null` for an unset one). Trusting the text:
 *   - wrote type=OTHER into 2,424 HubSpot companies that had no type (the record-level backfill);
 *   - would have made a rep CLEARING the cell push OTHER instead of a clear;
 *   - would make every monday-created Account be born "Other".
 */

const TYPE = CRM_ACCOUNTS.fields.find(f => f.hs === "type")!;
const COMPANY_TYPE = {
  PROSPECT: "Prospect", PARTNER: "Partner", RESELLER: "Reseller", VENDOR: "Vendor", OTHER: "Other",
};
const ctx = { labels: { companyType: COMPANY_TYPE }, ownersById: {}, mondayUsersByEmail: {},
  mondayEmailByUserId: {}, ownerIdByEmail: {} } as unknown as Ctx;

const cardWith = (cell: MondayItem["column_values"][number]): MondayItem => ({
  id: "2855572071", name: "Acme", created_at: "", updated_at: "", group: { id: "topics" },
  column_values: [{ id: CRM_ACCOUNTS.idCol, text: "31125660999" }, cell],
});
const unset = { id: TYPE.col, text: "Other", status_index: null };        // what the board returns, unset
const chosenOther = { id: TYPE.col, text: "Other", status_index: 5 };     // a rep really picked Other
const prospect = { id: TYPE.col, text: "Prospect", status_index: 2 };

describe("colText", () => {
  it("an unset status reads as empty, whatever label it displays", () =>
    expect(colText(cardWith(unset), TYPE.col)).toBe(""));

  it("a status someone genuinely chose as Other still reads Other", () =>
    expect(colText(cardWith(chosenOther), TYPE.col)).toBe("Other"));

  it("a set status reads its label", () => expect(colText(cardWith(prospect), TYPE.col)).toBe("Prospect"));

  it("non-status cells are unaffected (no status_index key)", () =>
    expect(colText(cardWith({ id: TYPE.col, text: "  plain  " }), TYPE.col)).toBe("plain"));
});

describe("the three ways the phantom used to reach HubSpot", () => {
  const rec = (type: string): HsRecord => ({ id: "31125660999", properties: { type, hs_lastmodifieddate: "x" } });

  it("an unset cell over an empty HubSpot type raises no diff at all", () => {
    const d = fieldDiffs(rec(""), cardWith(unset), CRM_ACCOUNTS, ctx).filter(x => x.f?.hs === "type");
    expect(d).toEqual([]);
  });

  it("a rep clearing the cell sends a CLEAR, never OTHER", () => {
    const r = columnEditPatch(rec("PROSPECT"), cardWith(unset), CRM_ACCOUNTS, ctx, { cols: [TYPE.col] });
    expect(r.patch).toEqual({ type: "" });
  });

  it("a rep choosing Other on purpose sends OTHER", () => {
    const r = columnEditPatch(rec("PROSPECT"), cardWith(chosenOther), CRM_ACCOUNTS, ctx, { cols: [TYPE.col] });
    expect(r.patch).toEqual({ type: "OTHER" });
  });

  it("an unset cell over a real HubSpot type is healed FORWARD, not pushed", () => {
    const d = fieldDiffs(rec("PARTNER"), cardWith(unset), CRM_ACCOUNTS, ctx).filter(x => x.f?.hs === "type");
    expect(d).toHaveLength(1);
    expect(d[0].backfill).toBeFalsy();
  });
});
