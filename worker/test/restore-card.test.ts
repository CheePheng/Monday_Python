import { describe, it, expect } from "vitest";
import { DELETION_EVENTS, OBJECT_FOR, hubspotIdFromPayload, isDeletionEvent, payloadShape } from "../src/restore-card";
import { CRM_CONTACTS, CRM_ACCOUNTS } from "../src/config/crm";
import { CONTACTS_MYLA, COMPANIES_MYLA, DEALS } from "../src/config";
import type { ObjectSpec } from "../src/types";
import { readCode } from "../scripts/read-source.mjs";

/**
 * THE DELETE RULE.
 *
 *   HubSpot deleted  -> the monday card is deleted.        (deleteHubspotObject, already covered)
 *   monday deleted   -> HubSpot is UNTOUCHED and the card COMES BACK.   <- this file
 *
 * Before this, a monday deletion fell through to syncMondayItem, whose getItem returns null for a
 * deleted item, so it logged `reason="item not found (deleted)"` and the card stayed gone forever.
 * HubSpot was correctly never touched — but only as a side effect of that null check.
 */

describe("which monday events mean 'the card is gone'", () => {
  it("treats delete AND archive as the same intent", () => {
    for (const t of ["item_deleted", "item_archived", "delete_pulse", "archive_pulse"])
      expect(isDeletionEvent(t)).toBe(true);
  });

  // item_archived was previously unsubscribed AND unhandled: a rep who archived rather than deleted got
  // silence. The two are indistinguishable to a rep and must behave identically.
  it("includes item_archived — archiving hides the card just as effectively as deleting it", () =>
    expect(DELETION_EVENTS.has("item_archived")).toBe(true));

  it("does not swallow the events that must keep their own handling", () => {
    for (const t of ["create_item", "change_column_value", "change_name", "create_update",
                     "item_restored", "item_moved_to_any_group"])
      expect(isDeletionEvent(t)).toBe(false);
  });

  it("is not fooled by a substring or by casing", () => {
    for (const t of ["", "deleted", "ITEM_DELETED", "item_deleted_x", "subitem_deleted"])
      expect(isDeletionEvent(t)).toBe(false);
  });
});

describe("recovering the HubSpot id from an undocumented payload", () => {
  const spec = CRM_CONTACTS;              // idCol text_mm6t71dj

  it("reads a bare string cell", () =>
    expect(hubspotIdFromPayload({ columnValues: { [spec.idCol]: "548464300792" } }, spec))
      .toBe("548464300792"));

  it("reads monday's {value} and {text} wrappers, and a snake_case container", () => {
    expect(hubspotIdFromPayload({ columnValues: { [spec.idCol]: { value: "123" } } }, spec)).toBe("123");
    expect(hubspotIdFromPayload({ columnValues: { [spec.idCol]: { text: "456" } } }, spec)).toBe("456");
    expect(hubspotIdFromPayload({ column_values: { [spec.idCol]: "789" } }, spec)).toBe("789");
  });

  it("trims whitespace monday sometimes pads text cells with", () =>
    expect(hubspotIdFromPayload({ columnValues: { [spec.idCol]: "  548464300792 " } }, spec))
      .toBe("548464300792"));

  // The whole point of returning null: an unattributable deletion must NOT restore a guessed record.
  it("returns null rather than guessing", () => {
    const cases: any[] = [
      undefined, null, {}, { columnValues: null }, { columnValues: "nope" },
      { columnValues: {} },                                        // no id column at all
      { columnValues: { [spec.idCol]: "" } },                      // present but empty
      { columnValues: { [spec.idCol]: "   " } },
      { columnValues: { [spec.idCol]: "not-a-number" } },          // never treat junk as an id
      { columnValues: { [spec.idCol]: "12a34" } },
      { columnValues: { [spec.idCol]: { value: null } } },
      { columnValues: { other_col: "548464300792" } },             // right value, WRONG column
    ];
    for (const ev of cases) expect(hubspotIdFromPayload(ev, spec)).toBeNull();
  });

  it("uses each spec's OWN id column — the two boards must not cross", () => {
    expect(CRM_CONTACTS.idCol).not.toBe(CRM_ACCOUNTS.idCol);
    const ev = { columnValues: { [CRM_ACCOUNTS.idCol]: "999" } };
    expect(hubspotIdFromPayload(ev, CRM_ACCOUNTS)).toBe("999");
    expect(hubspotIdFromPayload(ev, CRM_CONTACTS)).toBeNull();
  });

  it("survives a spec whose idCol is missing from a hostile payload", () => {
    const odd = { ...CRM_CONTACTS, idCol: "constructor" } as ObjectSpec;
    expect(hubspotIdFromPayload({ columnValues: {} }, odd)).toBeNull();
  });
});

describe("payloadShape logs the shape without leaking the contents", () => {
  // This string goes to the log so the first real deletion teaches us monday's payload. It must carry
  // key NAMES only — a payload can hold a customer's name, email and phone.
  it("emits sorted key names and no values", () => {
    const s = payloadShape({ pulseName: "Jane Customer", userId: 42, boardId: "5028000495" });
    expect(s).toBe("boardId,pulseName,userId");
    expect(s).not.toContain("Jane");
    expect(s).not.toContain("42");
    expect(s).not.toContain("5028000495");
  });

  it("does not throw on non-objects", () => {
    for (const v of [null, undefined, 7, "x"]) expect(() => payloadShape(v)).not.toThrow();
  });
});

// SUBSCRIBED vs HANDLED, the trap that keeps recurring here: a monday event needs BOTH a registration
// in register-crm-webhooks.mjs AND a branch in handleMonday. item_deleted had the registration and no
// branch (so deletions were silently swallowed); create_update had the branch and no registration (so
// the activity channel never fired). Either half alone is a no-op that looks implemented.
describe("every deletion event is both registered and handled", () => {
  it("registers item_deleted AND item_archived on the CRM boards", async () => {
    const { CRM_WEBHOOK_EVENTS } = await import("../scripts/register-crm-webhooks.mjs");
    expect(CRM_WEBHOOK_EVENTS).toContain("item_deleted");
    expect(CRM_WEBHOOK_EVENTS).toContain("item_archived");
  });

  it("handles every DELIVERED alias of both, since monday's delivered names differ from registration", async () => {
    const { DELIVERED_EVENT_ALIASES } = await import("../scripts/register-crm-webhooks.mjs");
    for (const reg of ["item_deleted", "item_archived"])
      for (const delivered of DELIVERED_EVENT_ALIASES[reg])
        expect(isDeletionEvent(delivered)).toBe(true);
  });

  it("registers create_update — the branch existed but nothing was subscribed to it", async () => {
    const { CRM_WEBHOOK_EVENTS } = await import("../scripts/register-crm-webhooks.mjs");
    expect(CRM_WEBHOOK_EVENTS).toContain("create_update");
  });
});

// THE WM REGRESSION THIS ALMOST SHIPPED. handleMonday's deletion branch sits AFTER specByBoard, so it
// runs on the LIVE Work-Management deployment too — same code, ENABLE_CRM unset. WM specs declare no
// `ownership`, and mayCreateCrmCard opens `if (!o) return true`, so the no-import gate is a pass-through
// there: a rep's deliberate deletion on a live follow-up board would have silently reappeared. It was
// not firing only because no WM board has a deletion subscription — an external fact no code asserts.
describe("restore-on-delete is opt-in per spec", () => {
  it("both CRM specs opt in", () => {
    expect(CRM_CONTACTS.restoreOnDelete).toBe(true);
    expect(CRM_ACCOUNTS.restoreOnDelete).toBe(true);
  });

  it("NO Work-Management spec opts in", () => {
    for (const s of [CONTACTS_MYLA, COMPANIES_MYLA, DEALS])
      expect(s.restoreOnDelete).toBeUndefined();
  });

  // The flag is deliberately NOT `ownership`. Conflating two meanings in one signal is how the
  // WRITE_HUBSPOT defect happened, so assert they are genuinely independent knobs.
  it("is a separate flag from ownership, not a synonym for it", () => {
    const code = readCode("webhooks.ts");
    expect(code).toContain("spec.restoreOnDelete");
    expect(code).not.toContain("spec.ownership");
  });

  it("every spec that opts in also declares ownership, so the no-import gate actually applies", () => {
    for (const s of [CRM_CONTACTS, CRM_ACCOUNTS])
      if (s.restoreOnDelete) expect(s.ownership).toBeDefined();
  });
});

describe("restore refuses objects it is not defined for", () => {
  // `spec.object === "contacts" ? "contact" : "company"` mapped EVERYTHING else — notably "deals" —
  // onto "company", which would have handed a DEAL id to the companies sync and searched the wrong
  // board for it. An unrecognised object must stop, not pick a default.
  it("maps only the two CRM objects", () => {
    expect(OBJECT_FOR.contacts).toBe("contact");
    expect(OBJECT_FOR.companies).toBe("company");
  });

  it("yields undefined for deals and anything else, rather than defaulting to company", () => {
    for (const o of ["deals", "line_items", "tickets", "", "company", "contact"])
      expect(OBJECT_FOR[o]).toBeUndefined();
  });
});

describe("the no-import guarantee is structural", () => {
  // Restoration calls syncHubspotObject, the ORDINARY path, so ensureCardForRecord ->
  // mayCreateCrmCard still decides. If restore-card ever grew its own createItem call, or imported
  // mayCreateCrmCard to pre-empt it, that guarantee would be gone.
  // Comments SHOULD discuss the cutover — that is where the reasoning lives. Only executable code may
  // not re-implement the gate, hence readCode rather than readSource.
  it("restore-card creates nothing itself — it delegates to the gated sync path", () => {
    const code = readCode("restore-card.ts");
    expect(code).toContain("syncHubspotObject");
    for (const forbidden of ["createItem", "mayCreateCrmCard", "cutover", "CUTOVER", "createdate"])
      expect(code).not.toContain(forbidden);
  });
});
