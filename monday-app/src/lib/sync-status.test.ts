import { describe, it, expect } from "vitest";
import { confirmSynced } from "./sync-status";

describe("confirmSynced", () => {
  it("is 'synced' only when the Worker reported ok AND a HubSpot Deal ID exists", () =>
    expect(confirmSynced(true, "9001")).toBe("synced"));
  it("is 'error' when ok but no HubSpot Deal ID yet (never a false Synced)", () =>
    expect(confirmSynced(true, undefined)).toBe("error"));
  it("is 'error' when the Worker did not report ok", () => {
    expect(confirmSynced(false, "9001")).toBe("error");
    expect(confirmSynced(false, undefined)).toBe("error");
  });
  it("treats an empty-string id as no id", () =>
    expect(confirmSynced(true, "")).toBe("error"));
});
