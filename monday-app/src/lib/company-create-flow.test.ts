// Integration-level: walks the whole company-create path the way the UI does — form values through
// validation, through the submit gate, to the exact payload the Worker receives. Unit tests cover each
// function alone; this covers the seam between them, where the "no website" flag could leak to HubSpot
// or the gate could be bypassed on one of the three creation surfaces.
import { describe, it, expect } from "vitest";
import { validateRecordForm, recordFormToProperties, NO_WEBSITE, type RecordFormValues } from "./record-form";
import { buildCreateAssoc } from "./assoc";

/** Both RecordDrawer.submit and AssociationSection's Add button refuse to run unless validation passes
 * (`if (savingRef.current || !v.ok) return;` / `disabled={!v.ok}`). This models that shared gate. */
function attemptCreate(values: RecordFormValues): { sent: false } | { sent: true; properties: Record<string, string> } {
  const v = validateRecordForm("company", values);
  if (!v.ok) return { sent: false };
  return { sent: true, properties: recordFormToProperties("company", values) };
}

describe("company create flow", () => {
  it("blocks the create when no domain was entered", () => {
    expect(attemptCreate({ name: "Acme" }).sent).toBe(false);
  });

  it("blocks the create when the domain is only whitespace", () => {
    expect(attemptCreate({ name: "Acme", domain: "  \t " }).sent).toBe(false);
  });

  it("sends a normal company with its domain", () => {
    expect(attemptCreate({ name: "Acme", domain: " acme.com " }))
      .toEqual({ sent: true, properties: { name: "Acme", domain: "acme.com" } });
  });

  it("allows a domain-less company once 'no website' is ticked, without leaking the flag", () => {
    const r = attemptCreate({ name: "Acme", [NO_WEBSITE]: "1" });
    expect(r.sent).toBe(true);
    expect(r).toEqual({ sent: true, properties: { name: "Acme" } });
    expect(Object.keys((r as { properties: object }).properties)).not.toContain(NO_WEBSITE);
  });

  it("re-blocks after the box is unticked (the flag resets, it does not stick)", () => {
    const ticked: RecordFormValues = { name: "Acme", [NO_WEBSITE]: "1" };
    expect(attemptCreate(ticked).sent).toBe(true);
    // RecordForm writes "" when unchecked, not undefined — the gate must treat that as unticked.
    expect(attemptCreate({ ...ticked, [NO_WEBSITE]: "" }).sent).toBe(false);
  });

  it("keeps the flag out of the nested-association payload too", () => {
    const a = buildCreateAssoc("company", { name: "Acme", [NO_WEBSITE]: "1" }, "key-1");
    expect(a.create?.properties).toEqual({ name: "Acme" });
    expect(a.label).toBe("Acme");
  });
});
