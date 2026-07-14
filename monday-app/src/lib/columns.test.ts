import { describe, it, expect } from "vitest";
import { dealFormToColumnValues, lineItemToSubitemColumns, boardRelationValue, peopleValue } from "./columns";

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
  it("omits keys entirely when their value is empty/absent", () => {
    const cv = dealFormToColumnValues({ amount: "", salesUserIds: [] });
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
});
