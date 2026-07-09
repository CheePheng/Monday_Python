import { describe, it, expect } from "vitest";
import { specForDeal } from "../src/sync";
import { extractDealIds, extractObjectEvents } from "../src/webhooks";

const deal = (p: Record<string, string>) => ({ properties: p });
const RECENT = "2026-08-01T00:00:00Z"; // after CREATED_AFTER_MS (2026-07-01)
const OLD = "2026-06-01T00:00:00Z";    // before the cutoff

describe("specForDeal (HubSpot deal -> shared board routing)", () => {
  it("a default-pipeline deal (any sales_user) -> shared Deals board", () =>
    expect(specForDeal(deal({ pipeline: "default", sales_user: "1739141284", createdate: RECENT }))?.boardId)
      .toBe("5029480547"));

  it("a default-pipeline deal with NO sales_user -> shared Deals board (lands in Unassigned group)", () =>
    expect(specForDeal(deal({ pipeline: "default", sales_user: "", createdate: RECENT }))?.boardId)
      .toBe("5029480547"));

  it("a different (non-Myla) sales_user -> shared Deals board too", () =>
    expect(specForDeal(deal({ pipeline: "default", sales_user: "999", createdate: RECENT }))?.boardId)
      .toBe("5029480547"));

  it("an OLD deal still routes (all dates on the shared board)", () =>
    expect(specForDeal(deal({ pipeline: "default", sales_user: "1739141284", createdate: OLD }))?.boardId)
      .toBe("5029480547"));

  it("a non-default pipeline -> null", () =>
    expect(specForDeal(deal({ pipeline: "someothersalespipeline", sales_user: "1739141284", createdate: RECENT })))
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

describe("extractObjectEvents (multi-object routing)", () => {
  it("routes a mixed batch of deal + contact + company by objectTypeId", () =>
    expect(extractObjectEvents([
      { subscriptionType: "object.propertyChange", objectTypeId: "0-3", objectId: 1 }, // deal
      { subscriptionType: "object.creation", objectTypeId: "0-1", objectId: 2 },       // contact
      { subscriptionType: "object.propertyChange", objectTypeId: "0-2", objectId: 3 }, // company
    ])).toEqual([{ type: "deal", id: "1" }, { type: "contact", id: "2" }, { type: "company", id: "3" }]));

  it("legacy contact.* / company.* subscription prefixes route correctly", () => {
    expect(extractObjectEvents([{ subscriptionType: "contact.creation", objectId: 5 }]))
      .toEqual([{ type: "contact", id: "5" }]);
    expect(extractObjectEvents([{ subscriptionType: "company.propertyChange", objectId: 6 }]))
      .toEqual([{ type: "company", id: "6" }]);
  });

  it("dedups repeated events for the same object (type+id)", () =>
    expect(extractObjectEvents([
      { subscriptionType: "object.propertyChange", objectTypeId: "0-1", objectId: 9, propertyName: "firstname" },
      { subscriptionType: "object.propertyChange", objectTypeId: "0-1", objectId: 9, propertyName: "lastname" },
    ])).toEqual([{ type: "contact", id: "9" }]));

  it("a deal and a contact sharing the same numeric id are kept separate", () =>
    expect(extractObjectEvents([
      { subscriptionType: "object.propertyChange", objectTypeId: "0-3", objectId: 42 },
      { subscriptionType: "object.propertyChange", objectTypeId: "0-1", objectId: 42 },
    ])).toEqual([{ type: "deal", id: "42" }, { type: "contact", id: "42" }]));

  it("marks object.deletion / <obj>.deletion events as deleted", () => {
    expect(extractObjectEvents([{ subscriptionType: "object.deletion", objectTypeId: "0-1", objectId: 7 }]))
      .toEqual([{ type: "contact", id: "7", deleted: true }]);
    expect(extractObjectEvents([{ subscriptionType: "company.deletion", objectId: 8 }]))
      .toEqual([{ type: "company", id: "8", deleted: true }]);
  });

  it("keeps a deletion and an update for the same object as separate events", () =>
    expect(extractObjectEvents([
      { subscriptionType: "object.propertyChange", objectTypeId: "0-3", objectId: 5 },
      { subscriptionType: "object.deletion", objectTypeId: "0-3", objectId: 5 },
    ])).toEqual([{ type: "deal", id: "5" }, { type: "deal", id: "5", deleted: true }]));
});
