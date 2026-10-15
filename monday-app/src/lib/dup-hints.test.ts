import { describe, it, expect, vi } from "vitest";
import { hintQuery, loadDuplicateHints } from "./dup-hints";

const hit = (name: string, secondary = "") => ({ id: "1", name, secondary });

describe("hintQuery", () => {
  it("joins a contact's names", () => expect(hintQuery("contact", { firstname: "Ada", lastname: "Lovelace" })).toBe("Ada Lovelace"));
  it("uses a company's name", () => expect(hintQuery("company", { name: "Acme" })).toBe("Acme"));
  it("gives up on too-short input rather than matching everything", () => {
    expect(hintQuery("contact", { firstname: "A" })).toBe("");
    expect(hintQuery("company", {})).toBe("");
  });
});

describe("loadDuplicateHints", () => {
  it("does not search when there is nothing worth searching", async () => {
    const search = vi.fn();
    expect(await loadDuplicateHints("tok", "contact", { firstname: "A" }, search)).toEqual([]);
    expect(search).not.toHaveBeenCalled();
  });

  it("formats matches with their secondary line", async () => {
    const search = vi.fn().mockResolvedValue({ items: [hit("Ada Lovelace", "ada@x.com"), hit("Ada L")] });
    expect(await loadDuplicateHints("tok", "contact", { firstname: "Ada", lastname: "Lovelace" }, search))
      .toEqual(["Ada Lovelace — ada@x.com", "Ada L"]);
    expect(search).toHaveBeenCalledWith("tok", "contacts", "Ada Lovelace");
  });

  it("caps the list so the dialog stays readable", async () => {
    const search = vi.fn().mockResolvedValue({ items: Array.from({ length: 12 }, (_, i) => hit("A" + i)) });
    expect((await loadDuplicateHints("tok", "company", { name: "Acme" }, search))).toHaveLength(5);
  });

  it("returns [] when the search fails — a lookup error must never block the decision", async () => {
    const search = vi.fn().mockRejectedValue(new Error("search-scope"));
    expect(await loadDuplicateHints("tok", "contact", { firstname: "Ada", lastname: "L" }, search)).toEqual([]);
  });
});
