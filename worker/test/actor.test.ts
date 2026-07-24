import { describe, it, expect } from "vitest";
import { resolveActor, OWNER_UNASSIGNED_MESSAGE } from "../src/actor";
import type { Ctx } from "../src/types";

const ctx = { ownerIdByEmail: { "rep@dkm.com": "555" } } as unknown as Ctx;

describe("resolveActor", () => {
  it("maps a known rep email to their HubSpot owner id", () =>
    expect(resolveActor(ctx, "Rep@DKM.com")).toEqual({ hubspotOwnerId: "555" }));
  it("returns unassigned for an unknown email", () =>
    expect(resolveActor(ctx, "stranger@x.com")).toEqual({ unassigned: true }));
  it("returns unassigned for a missing email", () => {
    expect(resolveActor(ctx, "")).toEqual({ unassigned: true });
    expect(resolveActor(ctx, undefined)).toEqual({ unassigned: true });
  });
  it("exposes the exact Unassigned message, including the sync consequence", () =>
    expect(OWNER_UNASSIGNED_MESSAGE).toBe("No HubSpot owner mapping was found. Record created as Unassigned — assign a Sales User to turn on two-way sync for it."));
});
