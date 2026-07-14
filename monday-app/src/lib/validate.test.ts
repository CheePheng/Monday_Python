import { describe, it, expect } from "vitest";
import { validateDealForm } from "./validate";
describe("validateDealForm", () => {
  it("ok with name + stage + numeric amount", () =>
    expect(validateDealForm("Acme", { stage: "Contract Sent", amount: "1500" }).ok).toBe(true));
  it("requires name and stage", () => {
    const r = validateDealForm("", { stage: "" });
    expect(r.ok).toBe(false); expect(r.errors.name).toBeTruthy(); expect(r.errors.stage).toBeTruthy();
  });
  it("rejects a non-numeric amount, allows empty", () => {
    expect(validateDealForm("A", { stage: "s", amount: "abc" }).errors.amount).toBeTruthy();
    expect(validateDealForm("A", { stage: "s", amount: "" }).ok).toBe(true);
  });
});
