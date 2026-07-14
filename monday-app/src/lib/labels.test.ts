import { describe, it, expect } from "vitest";
import { columnLabels } from "./labels";

describe("columnLabels", () => {
  it("extracts status labels (object form)", () =>
    expect(columnLabels(JSON.stringify({ labels: { "0": "Appointment Scheduled", "5": "Closed Won" } })))
      .toEqual(["Appointment Scheduled", "Closed Won"]));
  it("extracts dropdown labels (array form)", () =>
    expect(columnLabels(JSON.stringify({ labels: [{ id: 1, name: "Vendor A" }, { id: 2, name: "Vendor B" }] })))
      .toEqual(["Vendor A", "Vendor B"]));
  it("drops empty names", () =>
    expect(columnLabels(JSON.stringify({ labels: { "0": "USD", "1": "" } }))).toEqual(["USD"]));
  it("safe on null / bad json / no labels", () => {
    expect(columnLabels(null)).toEqual([]);
    expect(columnLabels("not json")).toEqual([]);
    expect(columnLabels(JSON.stringify({}))).toEqual([]);
  });
});
