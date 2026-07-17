import { describe, it, expect } from "vitest";
import { apiErrorDetail, apiErrorMessage } from "./api-error";

describe("apiErrorDetail", () => {
  it("pulls messages out of a GraphQL errors array", () =>
    expect(apiErrorDetail({ errors: [{ message: "Field 'create_item' doesn't exist on type 'Mutation'" }] }))
      .toBe("Field 'create_item' doesn't exist on type 'Mutation'"));
  it("joins multiple errors", () =>
    expect(apiErrorDetail({ errors: [{ message: "a" }, { message: "b" }] })).toBe("a; b"));
  it("handles an errors array of plain strings", () =>
    expect(apiErrorDetail({ errors: ["boom"] })).toBe("boom"));
  it("falls back to error_message", () =>
    expect(apiErrorDetail({ error_message: "Not Authorized" })).toBe("Not Authorized"));
  it("returns empty for nothing usable", () => {
    expect(apiErrorDetail(undefined)).toBe("");
    expect(apiErrorDetail({})).toBe("");
  });
});

describe("apiErrorMessage", () => {
  it("appends the real cause to the host's summary", () => {
    const err = Object.assign(new Error("Graphql validation errors"), {
      data: { errors: [{ message: "Field 'create_item' doesn't exist on type 'Mutation'" }] },
    });
    expect(apiErrorMessage(err))
      .toBe("Graphql validation errors — Field 'create_item' doesn't exist on type 'Mutation'");
  });
  it("keeps the summary alone when there is no detail", () =>
    expect(apiErrorMessage(new Error("Network error"))).toBe("Network error"));
  it("does not duplicate a cause already in the summary", () => {
    const err = Object.assign(new Error("Not Authorized"), { data: { error_message: "Not Authorized" } });
    expect(apiErrorMessage(err)).toBe("Not Authorized");
  });
});
