import { describe, it, expect } from "vitest";
import {
  parseLineItemBody, parseAssociationBody, parseDealBody, parseSyncDealBody, parseClearDealBody,
  parseCreateLineItemBody, parseContactBody, parseCompanyBody,
} from "../src/app-routes";

describe("parseClearDealBody", () => {
  it("accepts the allowlisted properties", () =>
    expect(parseClearDealBody({ hubspotDealId: "9001", fields: ["amount", "closedate", "sales_user"] }))
      .toEqual({ ok: true, hubspotDealId: "9001", fields: ["amount", "closedate", "sales_user"] }));

  // The allowlist is the safety boundary: this route is the ONE thing allowed to blank HubSpot, so it
  // must never be talked into clearing anything else.
  it("refuses a property that isn't clearable", () => {
    expect(parseClearDealBody({ hubspotDealId: "9001", fields: ["dealname"] }).ok).toBe(false);
    expect(parseClearDealBody({ hubspotDealId: "9001", fields: ["amount", "dealstage"] }).ok).toBe(false);
    expect(parseClearDealBody({ hubspotDealId: "9001", fields: ["hubspot_owner_id"] }).ok).toBe(false);
  });
  it("rejects a non-string field", () =>
    expect(parseClearDealBody({ hubspotDealId: "9001", fields: [{ x: 1 }] }).ok).toBe(false));
  it("rejects an empty or missing field list", () => {
    expect(parseClearDealBody({ hubspotDealId: "9001", fields: [] }).ok).toBe(false);
    expect(parseClearDealBody({ hubspotDealId: "9001" }).ok).toBe(false);
  });
  it("rejects missing / non-numeric hubspotDealId", () => {
    expect(parseClearDealBody({ fields: ["amount"] }).ok).toBe(false);
    expect(parseClearDealBody({ hubspotDealId: "abc", fields: ["amount"] }).ok).toBe(false);
  });
  it("dedupes", () =>
    expect(parseClearDealBody({ hubspotDealId: "1", fields: ["amount", "amount"] }).fields).toEqual(["amount"]));
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

describe("parseCreateLineItemBody", () => {
  it("requires numeric itemId + subitemId and strips props to the allowlist", () =>
    expect(parseCreateLineItemBody({ itemId: "1", subitemId: "2", saveToLibrary: true,
      properties: { name: "X", price: "10", amount: "999" } }))
      .toEqual({ ok: true, itemId: "1", subitemId: "2", saveToLibrary: true, properties: { name: "X", price: "10" } }));
  it("rejects a non-numeric itemId/subitemId", () => {
    expect(parseCreateLineItemBody({ itemId: "x", subitemId: "2", properties: { name: "X" } }).ok).toBe(false);
    expect(parseCreateLineItemBody({ itemId: "1", subitemId: "x", properties: { name: "X" } }).ok).toBe(false);
  });
  it("requires a name (or hs_product_id) after allowlisting", () =>
    expect(parseCreateLineItemBody({ itemId: "1", subitemId: "2", properties: { amount: "999" } }).ok).toBe(false));
});

const KEY = "123e4567-e89b-42d3-a456-426614174000"; // a valid UUID, like crypto.randomUUID()

describe("parseContactBody", () => {
  it("requires a UUID key + a name and strips props to the contact allowlist", () =>
    expect(parseContactBody({ idempotencyKey: KEY, properties: { firstname: "Ada", email: "a@x.com", bogus: "1" } }))
      .toEqual({ ok: true, idempotencyKey: KEY, properties: { firstname: "Ada", email: "a@x.com" }, associateCompanyHubspotId: undefined }));
  it("accepts an optional numeric associateCompanyHubspotId", () =>
    expect(parseContactBody({ idempotencyKey: KEY, properties: { firstname: "Ada" }, associateCompanyHubspotId: "77" }).associateCompanyHubspotId)
      .toBe("77"));
  it("rejects a missing key and a malformed (non-UUID) key", () => {
    expect(parseContactBody({ properties: { firstname: "Ada" } }).ok).toBe(false);
    expect(parseContactBody({ idempotencyKey: "k1", properties: { firstname: "Ada" } }).ok).toBe(false);
  });
  it("rejects when no name survives the allowlist", () =>
    expect(parseContactBody({ idempotencyKey: KEY, properties: { email: "a@x.com" } }).ok).toBe(false));
  it("rejects a non-numeric associateCompanyHubspotId", () =>
    expect(parseContactBody({ idempotencyKey: KEY, properties: { firstname: "Ada" }, associateCompanyHubspotId: "x" }).ok).toBe(false));
});

describe("parseCompanyBody", () => {
  it("requires a UUID key + name-or-domain and strips props to the company allowlist", () =>
    expect(parseCompanyBody({ idempotencyKey: KEY, properties: { name: "Acme", industry: "TECH", bogus: "1" } }))
      .toEqual({ ok: true, idempotencyKey: KEY, properties: { name: "Acme", industry: "TECH" }, associateContactHubspotIds: [] }));
  it("accepts optional numeric associateContactHubspotIds", () =>
    expect(parseCompanyBody({ idempotencyKey: KEY, properties: { domain: "acme.com" }, associateContactHubspotIds: ["1", "2"] }).associateContactHubspotIds)
      .toEqual(["1", "2"]));
  it("rejects a malformed (non-UUID) key", () =>
    expect(parseCompanyBody({ idempotencyKey: "k1", properties: { name: "Acme" } }).ok).toBe(false));
  it("rejects when neither name nor domain survives", () =>
    expect(parseCompanyBody({ idempotencyKey: KEY, properties: { city: "SG" } }).ok).toBe(false));
  it("rejects a non-numeric id in associateContactHubspotIds", () =>
    expect(parseCompanyBody({ idempotencyKey: KEY, properties: { name: "Acme" }, associateContactHubspotIds: ["1", "x"] }).ok).toBe(false));
});
