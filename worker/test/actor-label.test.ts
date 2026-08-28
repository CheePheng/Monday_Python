import { describe, it, expect } from "vitest";
import { formatActor } from "../src/actor-label";

// The integration runs on a NAMED admin's API token (ask ada), so monday attributes every sync write to
// that person — indistinguishable from their real edits. Flagging our own id is what makes a human edit
// identifiable, which is what the 2026-08-28 owner-reassignment question needed.
describe("formatActor", () => {
  const SELF = "104118038";
  it("our own token user is labelled as the integration, never as a person", () =>
    expect(formatActor(SELF, { name: "ask ada", email: "askada@dkmeco.com.sg" }, SELF))
      .toBe("actor=integration user=104118038"));
  it("a real person is named with their monday account", () =>
    expect(formatActor("500", { name: "Wendy Wang", email: "wendy@dkm.com" }, SELF))
      .toBe('actor=person user=500 who="Wendy Wang wendy@dkm.com"'));
  it("an unresolvable id still records that a PERSON did it", () =>
    expect(formatActor("777", null, SELF)).toBe("actor=person user=777"));
  it("a missing user id is explicit, not silently blank", () =>
    expect(formatActor("", null, SELF)).toBe("actor=unknown"));
  it("works when the self id is unknown (never mislabels a person as the integration)", () =>
    expect(formatActor("500", { name: "W", email: "" }, "")).toBe('actor=person user=500 who="W"'));
});
