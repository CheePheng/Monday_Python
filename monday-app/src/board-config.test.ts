import { describe, it, expect } from "vitest";
import { hubspotRecordUrl } from "./board-config";

describe("hubspotRecordUrl", () => {
  it("uses the 0-1 object path for contacts", () =>
    expect(hubspotRecordUrl("contacts", "123")).toBe("https://app.hubspot.com/contacts/39939588/record/0-1/123"));
  it("uses the 0-2 object path for companies", () =>
    expect(hubspotRecordUrl("companies", "456")).toBe("https://app.hubspot.com/contacts/39939588/record/0-2/456"));
});
