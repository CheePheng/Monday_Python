import { describe, it, expect } from "vitest";
import {
  dealFormToColumnValues, lineItemToSubitemColumns, lineItemHubspotProperties, boardRelationValue, peopleValue,
} from "./columns";

describe("dealFormToColumnValues — clearing", () => {
  it("clears Sales Users when emptied (null clears every monday column type)", () =>
    expect(dealFormToColumnValues({ salesUserIds: [] }))
      .toEqual({ multiple_person_mm532m82: null }));

  it("omits Sales Users entirely when the form doesn't manage it", () =>
    expect(dealFormToColumnValues({})).toEqual({}));

  // Only Sales Users is clearable; everything else keeps the never-blank-an-untouched-column rule,
  // because the Worker refuses to clear HubSpot from an empty monday value.
  it("does not blank the other fields when they're emptied", () => {
    const cv = dealFormToColumnValues({ amount: "", closeDate: "", priority: "", dealType: "", vendors: [] });
    expect(cv).toEqual({});
  });
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
