import { describe, it, expect } from "vitest";
import {
  parseLineItemBody, parseAssociationBody, parseDealBody, parseSyncDealBody, parseUnassignDealBody,
} from "../src/app-routes";

describe("parseUnassignDealBody", () => {
  it("accepts a numeric hubspotDealId", () =>
    expect(parseUnassignDealBody({ hubspotDealId: "9001" })).toEqual({ ok: true, hubspotDealId: "9001" }));
  it("rejects missing / non-numeric", () => {
    expect(parseUnassignDealBody({}).ok).toBe(false);
    expect(parseUnassignDealBody({ hubspotDealId: "abc" }).ok).toBe(false);
  });
});

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

describe("parseDealBody", () => {
  it("accepts a numeric hubspotDealId", () =>
    expect(parseDealBody({ hubspotDealId: "9001" })).toEqual({ ok: true, hubspotDealId: "9001" }));
  it("rejects missing / non-numeric", () => {
    expect(parseDealBody({}).ok).toBe(false);
    expect(parseDealBody({ hubspotDealId: "abc" }).ok).toBe(false);
  });
});

describe("parseSyncDealBody", () => {
  it("accepts a numeric itemId", () =>
    expect(parseSyncDealBody({ itemId: "12345" })).toEqual({ ok: true, itemId: "12345" }));
  it("rejects missing / non-numeric", () => {
    expect(parseSyncDealBody({}).ok).toBe(false);
    expect(parseSyncDealBody({ itemId: "abc" }).ok).toBe(false);
  });
});
