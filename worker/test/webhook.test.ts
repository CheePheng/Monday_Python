import { describe, it, expect } from "vitest";
import { specForDeal } from "../src/sync";
import { extractDealIds, extractLineItemIds, extractObjectEvents, extractUpdate, ignoredColumns } from "../src/webhooks";
import { DEALS, CONTACTS_MYLA, COMPANIES_MYLA } from "../src/config";

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

  it("routes an object.associationChange to a re-sync of the FROM object (fromObjectTypeId + fromObjectId)", () => {
    // real 2026.03 payload shape: subscriptionType object.associationChange, from*/to* fields, fires per side
    expect(extractObjectEvents({ subscriptionType: "object.associationChange", fromObjectTypeId: "0-3", fromObjectId: 9001, toObjectTypeId: "0-1", toObjectId: 5, associationType: "DEAL_TO_CONTACT" }))
      .toEqual([{ type: "deal", id: "9001" }]);
    expect(extractObjectEvents({ subscriptionType: "object.associationChange", fromObjectTypeId: "0-1", fromObjectId: 7, toObjectTypeId: "0-3", toObjectId: 9001, associationType: "CONTACT_TO_DEAL" }))
      .toEqual([{ type: "contact", id: "7" }]);
  });

  it("an association-change is NOT treated as a deletion", () =>
    expect(extractObjectEvents({ subscriptionType: "object.associationChange", fromObjectTypeId: "0-2", fromObjectId: 80010, toObjectTypeId: "0-1", toObjectId: 3 }))
      .toEqual([{ type: "company", id: "80010" }]));
});

describe("extractUpdate (monday Update -> HubSpot note)", () => {
  it("parses a create_update event", () =>
    expect(extractUpdate({ type: "create_update", pulseId: 100, userId: 42, textBody: "hi there" }))
      .toEqual({ itemId: "100", userId: "42", text: "hi there" }));
  it("falls back to body when textBody is absent", () =>
    expect(extractUpdate({ type: "create_update", pulseId: 7, body: "note body" }))
      .toEqual({ itemId: "7", userId: "", text: "note body" }));
  it("ignores non-update events and empty text", () => {
    expect(extractUpdate({ type: "change_column_value", pulseId: 1 })).toBeNull();
    expect(extractUpdate({ type: "create_update", pulseId: 1, textBody: "   " })).toBeNull();
    expect(extractUpdate({ type: "create_update", textBody: "x" })).toBeNull(); // no item id
  });
});

describe("extractLineItemIds (line-item edits -> parent deal)", () => {
  it("pulls line-item ids (objectTypeId 0-8)", () =>
    expect(extractLineItemIds([{ subscriptionType: "object.propertyChange", objectTypeId: "0-8", objectId: 31395364724, propertyName: "price" }]))
      .toEqual(["31395364724"]));
  it("pulls line-item ids (subscriptionType line_item.*) and dedups", () =>
    expect(extractLineItemIds([
      { subscriptionType: "line_item.propertyChange", objectId: 55 },
      { subscriptionType: "line_item.propertyChange", objectId: 55 },
    ])).toEqual(["55"]));
  it("ignores non-line-item events", () =>
    expect(extractLineItemIds([{ subscriptionType: "object.propertyChange", objectTypeId: "0-3", objectId: 9 }]))
      .toEqual([]));

  it("keeps a deletion and an update for the same object as separate events", () =>
    expect(extractObjectEvents([
      { subscriptionType: "object.propertyChange", objectTypeId: "0-3", objectId: 5 },
      { subscriptionType: "object.deletion", objectTypeId: "0-3", objectId: 5 },
    ])).toEqual([{ type: "deal", id: "5" }, { type: "deal", id: "5", deleted: true }]));
});

describe("ignoredColumns", () => {
  it("ignores our own bookkeeping columns", () => {
    const s = ignoredColumns(DEALS);
    expect(s.has(DEALS.syncStateCol)).toBe(true);
    expect(s.has(DEALS.idCol)).toBe(true);
  });

  // Writing Created date across ~1,300 cards fires ~1,300 change_column_value webhooks. A one-way
  // HubSpot->monday column has nothing to push back, so reconciling on it is pure waste.
  it("ignores the one-way createdate column on every board", () => {
    for (const spec of [DEALS, CONTACTS_MYLA, COMPANIES_MYLA]) {
      const f = spec.fields.find(x => x.hs === "createdate")!;
      expect(f, `${spec.object} must map createdate`).toBeTruthy();
      expect(f.oneWay, `${spec.object} createdate must be marked one-way`).toBe(true);
      expect(ignoredColumns(spec).has(f.col)).toBe(true);
    }
  });

  it("does NOT ignore reversible fields - those must still reach HubSpot", () => {
    const s = ignoredColumns(DEALS);
    for (const f of DEALS.fields.filter(x => x.reverse)) expect(s.has(f.col)).toBe(false);
  });
});
