import { describe, it, expect } from "vitest";
import { recInScope } from "../src/sync";
import { COMPANIES_MYLA, CONTACTS_MYLA } from "../src/config";

const rec = (p: Record<string, string>) => ({ properties: p });
const OLD = "2026-06-01T00:00:00Z";     // before CREATED_AFTER_MS (2026-07-01)
const NEW = "2026-07-15T00:00:00Z";

describe("recInScope", () => {
  it("companies (includeAll): in scope even with no sales_user and an old createdate", () =>
    expect(recInScope(COMPANIES_MYLA, rec({ createdate: OLD }))).toBe(true));
  it("contacts: still gated — no sales_user is out of scope", () =>
    expect(recInScope(CONTACTS_MYLA, rec({ createdate: NEW }))).toBe(false));
  it("contacts: sales_user + recent is in scope", () =>
    expect(recInScope(CONTACTS_MYLA, rec({ sales_user: "1", createdate: NEW }))).toBe(true));
  it("contacts: sales_user but created before the cutoff is out of scope", () =>
    expect(recInScope(CONTACTS_MYLA, rec({ sales_user: "1", createdate: OLD }))).toBe(false));
});
