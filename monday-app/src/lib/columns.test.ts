import { describe, it, expect } from "vitest";
import {
  dealFormToColumnValues, deliberateClears, lineItemToSubitemColumns, lineItemHubspotProperties,
  boardRelationValue, peopleValue,
} from "./columns";

describe("deliberateClears", () => {
  const loaded = { amount: "5000", closeDate: "2026-07-01", salesUserIds: ["111"] };

  it("reports a field the rep emptied", () =>
    expect(deliberateClears(loaded, { amount: "", closeDate: "", salesUserIds: [] }))
      .toEqual({ amount: true, closeDate: true, salesUsers: true }));

  it("reports nothing when the values are untouched", () =>
    expect(deliberateClears(loaded, loaded)).toEqual({ amount: false, closeDate: false, salesUsers: false }));

  // The important one: monday can be empty simply because the sync hasn't filled it yet. Treating that
  // as a clear would let an unrelated save wipe a real HubSpot value.
  it("is NOT a clear when the field was already empty on load", () =>
    expect(deliberateClears({ amount: "", closeDate: "", salesUserIds: [] }, { amount: "", closeDate: "", salesUserIds: [] }))
      .toEqual({ amount: false, closeDate: false, salesUsers: false }));

  it("treats whitespace-only as emptied", () =>
    expect(deliberateClears(loaded, { ...loaded, amount: "   " }).amount).toBe(true));

  it("is not a clear when the value merely changed", () =>
    expect(deliberateClears(loaded, { ...loaded, amount: "6000" }).amount).toBe(false));
});

describe("dealFormToColumnValues — sales user", () => {
  // HubSpot's deals.sales_user is a single-select, so the form emits a 0-or-1 array. Clearing and
  // omission are covered below; this locks the positive case the single-select actually produces.
  it("writes a single sales user to the people column", () =>
    expect(dealFormToColumnValues({ salesUserIds: ["111"] }))
      .toEqual({ multiple_person_mm532m82: peopleValue(["111"]) }));
});

describe("dealFormToColumnValues — clearing", () => {
  it("clears only what the rep deliberately emptied (null clears every monday column type)", () =>
    expect(dealFormToColumnValues({}, { amount: true, closeDate: true, salesUsers: true }))
      .toEqual({ numeric_mm531t6e: null, date_mm53ecz3: null, multiple_person_mm532m82: null }));

  // Without a clear flag an empty field is still omitted, so an edit can't blank an untouched column —
  // and a form that never loaded (no clears computed) can't blank anything at all.
  it("omits empty fields when nothing was deliberately cleared", () =>
    expect(dealFormToColumnValues({ amount: "", closeDate: "", salesUserIds: [], vendors: [] })).toEqual({}));

  it("never clears a field outside the allowlist", () => {
    const cv = dealFormToColumnValues({ priority: "", dealType: "", currency: "", vendors: [] },
      { amount: true, closeDate: true, salesUsers: true });
    expect(cv).not.toHaveProperty("color_mm532rej");
    expect(cv).not.toHaveProperty("color_mm53cky8");
    expect(cv).not.toHaveProperty("color_mm53vk99");
    expect(cv).not.toHaveProperty("dropdown_mm4n4f7r");
  });

  it("a value still present wins over a stale clear flag", () =>
    expect(dealFormToColumnValues({ amount: "5000" }, { amount: true }))
      .toEqual({ numeric_mm531t6e: "5000" }));
});

describe("lineItemHubspotProperties", () => {
  it("sends the percent discount and blanks the amount one", () =>
    expect(lineItemHubspotProperties({ unitPrice: "100", quantity: "2", discountMode: "percent", discountPct: "10" }))
      .toEqual({ price: "100", quantity: "2", hs_discount_percentage: "10", discount: "" }));

  it("sends the amount discount and blanks the percent one", () =>
    expect(lineItemHubspotProperties({ unitPrice: "100", quantity: "2", discountMode: "amount", discount: "5" }))
      .toEqual({ price: "100", quantity: "2", discount: "5", hs_discount_percentage: "" }));

  // Regression: a line item loaded from a subitem and saved untouched must keep its discount. This
  // wiped every synced line item's discount in HubSpot when hydration didn't load the discount fields.
  it("preserves a hydrated percent discount when nothing was edited", () => {
    const hydrated = { unitPrice: "100", quantity: "1", discountMode: "percent" as const, discountPct: "15" };
    expect(lineItemHubspotProperties(hydrated).hs_discount_percentage).toBe("15");
  });

  it("never sends a blank price or quantity (an empty box must not clear HubSpot)", () => {
    const p = lineItemHubspotProperties({ unitPrice: "", quantity: "", discountMode: "amount" });
    expect(p).not.toHaveProperty("price");
    expect(p).not.toHaveProperty("quantity");
  });

  it("omits optional fields that aren't set, so they can't be blanked", () => {
    const p = lineItemHubspotProperties({ unitPrice: "10", quantity: "1", discountMode: "amount" });
    expect(p).not.toHaveProperty("description");
    expect(p).not.toHaveProperty("hs_line_item_currency_code");
    expect(p).not.toHaveProperty("service_date");
  });
});

describe("dealFormToColumnValues", () => {
  it("encodes each column type and skips empty fields", () => {
    const cv = dealFormToColumnValues({
      amount: "5000", currency: "USD", closeDate: "2026-07-01",
      stage: "Appointment Scheduled", dealType: "", priority: "High",
      vendors: ["Acme"], salesUserIds: ["111", "222"],
    });
    expect(cv).toEqual({
      numeric_mm531t6e: "5000",
      color_mm53vk99: { label: "USD" },
      date_mm53ecz3: { date: "2026-07-01" },
      color_mm53fh1r: { label: "Appointment Scheduled" },
      color_mm532rej: { label: "High" },
      dropdown_mm4n4f7r: { labels: ["Acme"] },
      multiple_person_mm532m82: { personsAndTeams: [{ id: 111, kind: "person" }, { id: 222, kind: "person" }] },
    });
  });
  // Sales Users is the deliberate exception — see "clearing" below.
  it("omits keys entirely when their value is empty/absent", () => {
    const cv = dealFormToColumnValues({ amount: "", closeDate: "", currency: "" });
    expect(cv).toEqual({});
  });
});

describe("peopleValue", () => {
  it("maps string ids to numeric person entries", () =>
    expect(peopleValue(["7", "8"])).toEqual({ personsAndTeams: [{ id: 7, kind: "person" }, { id: 8, kind: "person" }] }));
});

describe("boardRelationValue", () => {
  it("wraps numeric item ids", () =>
    expect(boardRelationValue(["101", "102"])).toEqual({ item_ids: [101, 102] }));
});

describe("lineItemToSubitemColumns", () => {
  it("maps price/qty/product id/currency and skips blanks", () =>
    expect(lineItemToSubitemColumns({ unitPrice: "100", quantity: "2", productId: "9", currency: "USD", description: "" }))
      .toEqual({ numeric_mm53rsfd: "100", numeric_mm531345: "2", text_mm54hbvj: "9", text_mm538b8k: "USD" }));
  it("maps discount + service date", () =>
    expect(lineItemToSubitemColumns({ discount: "5", serviceDate: "2026-08-01" }))
      .toEqual({ numeric_mm53pkyf: "5", date_mm53chbv: { date: "2026-08-01" } }));
  it("amount mode writes the discount column only", () =>
    expect(lineItemToSubitemColumns({ discount: "5", discountMode: "amount" }))
      .toEqual({ numeric_mm53pkyf: "5" }));
  it("percent mode writes the discount% column only (not the amount column)", () =>
    expect(lineItemToSubitemColumns({ discount: "5", discountPct: "10", discountMode: "percent" }))
      .toEqual({ numeric_mm5ax22v: "10" }));
});
