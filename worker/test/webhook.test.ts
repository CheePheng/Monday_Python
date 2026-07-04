import { describe, it, expect } from "vitest";
import { specForDeal } from "../src/sync";

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
