import { describe, it, expect } from "vitest";
import { specForDeal } from "../src/sync";
import { extractDealIds } from "../src/webhooks";

const deal = (p: Record<string, string>) => ({ properties: p });
const RECENT = "2026-08-01T00:00:00Z"; // after CREATED_AFTER_MS (2026-07-01)
const OLD = "2026-06-01T00:00:00Z";    // before the cutoff

describe("specForDeal (HubSpot deal -> board routing)", () => {
  it("Myla's sales_user in the default pipeline -> Myla Deals board", () =>
    expect(specForDeal(deal({ pipeline: "default", sales_user: "1739141284", createdate: RECENT }))?.boardId)
      .toBe("5029480547"));

  it("no sales_user -> Unassigned board", () =>
    expect(specForDeal(deal({ pipeline: "default", sales_user: "", createdate: RECENT }))?.boardId)
      .toBe("5029479220"));

  it("a different (un-onboarded) salesperson -> null", () =>
    expect(specForDeal(deal({ pipeline: "default", sales_user: "999", createdate: RECENT })))
      .toBeNull());

  it("a non-default pipeline -> null", () =>
    expect(specForDeal(deal({ pipeline: "someothersalespipeline", sales_user: "1739141284", createdate: RECENT })))
      .toBeNull());

  it("created before the cutoff (old history) -> null", () =>
    expect(specForDeal(deal({ pipeline: "default", sales_user: "1739141284", createdate: OLD })))
      .toBeNull());
});

describe("extractDealIds (HubSpot webhook payload parsing)", () => {
  it("2026 projects-app object.propertyChange (objectTypeId 0-3) -> id", () =>
    // exact shape captured live from the installed app on 2026-07-05
    expect(extractDealIds([{
      eventId: 2382693416, subscriptionId: 6969872, portalId: 39939588, appId: 44796352,
      occurredAt: 1783182645780, subscriptionType: "object.propertyChange", attemptNumber: 0,
      objectId: 333511736013, objectTypeId: "0-3", propertyName: "dealname",
    }])).toEqual(["333511736013"]));

  it("2026 object.creation for a deal -> id", () =>
    expect(extractDealIds([{ subscriptionType: "object.creation", objectTypeId: "0-3", objectId: 42 }]))
      .toEqual(["42"]));

  it("object.* event for a NON-deal object (contact, 0-1) -> excluded", () =>
    expect(extractDealIds([{ subscriptionType: "object.propertyChange", objectTypeId: "0-1", objectId: 7 }]))
      .toEqual([]));

  it("legacy deal.propertyChange -> id", () =>
    expect(extractDealIds([{ subscriptionType: "deal.propertyChange", objectId: 9001 }]))
      .toEqual(["9001"]));

  it("legacy contact.propertyChange -> excluded", () =>
    expect(extractDealIds([{ subscriptionType: "contact.propertyChange", objectId: 5 }]))
      .toEqual([]));

  it("Workflow 'send webhook' deal object (hs_object_id) -> id", () =>
    expect(extractDealIds({ properties: { hs_object_id: "123" }, hs_object_id: "123" }))
      .toEqual(["123"]));

  it("dedups multiple events for the same deal", () =>
    expect(extractDealIds([
      { subscriptionType: "object.propertyChange", objectTypeId: "0-3", objectId: 100, propertyName: "dealstage" },
      { subscriptionType: "object.propertyChange", objectTypeId: "0-3", objectId: 100, propertyName: "pipeline" },
    ])).toEqual(["100"]));
});
