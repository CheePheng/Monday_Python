import { describe, it, expect } from "vitest";
import { parseLineItemBody, parseAssociationBody } from "../src/app-routes";

describe("parseLineItemBody", () => {
  it("update: requires lineItemId + non-empty properties", () =>
    expect(parseLineItemBody("PATCH", { lineItemId: "42", properties: { price: "10" } }))
      .toEqual({ ok: true, lineItemId: "42", properties: { price: "10" } }));
  it("update: rejects empty properties", () =>
    expect(parseLineItemBody("PATCH", { lineItemId: "42", properties: {} }).ok).toBe(false));
  it("delete: requires only lineItemId", () =>
    expect(parseLineItemBody("DELETE", { lineItemId: "42" }))
      .toEqual({ ok: true, lineItemId: "42", properties: undefined }));
  it("rejects a missing/numeric-only-invalid id", () => {
    expect(parseLineItemBody("DELETE", {}).ok).toBe(false);
    expect(parseLineItemBody("DELETE", { lineItemId: "abc" }).ok).toBe(false);
  });
});

describe("parseAssociationBody", () => {
  const good = { fromObject: "deals", fromId: "1", toObject: "contacts", toId: "2" };
  it("accepts a valid deals->contacts/companies body", () =>
    expect(parseAssociationBody(good)).toEqual({ ok: true, ...good }));
  it("rejects an unknown object type", () =>
    expect(parseAssociationBody({ ...good, toObject: "tickets" }).ok).toBe(false));
  it("rejects a non-numeric id", () =>
    expect(parseAssociationBody({ ...good, toId: "x" }).ok).toBe(false));
});
