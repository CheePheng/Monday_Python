import { describe, it, expect } from "vitest";
import {
  ALL_SPECS, SPEC_BY_BOARD, specsFor, specByBoard, specByObject, ALL_KNOWN_SPECS,
  DEALS, CONTACTS_MYLA, COMPANIES_MYLA,
} from "../src/config";
import { CRM_CONTACTS, CRM_ACCOUNTS, CRM_SPECS } from "../src/config/crm";

const prod = {} as { ENABLE_CRM?: string };                 // production Worker: ENABLE_CRM unset
const crmEnv = { ENABLE_CRM: "true" } as { ENABLE_CRM?: string };

const WM_BOARDS = [DEALS.boardId, CONTACTS_MYLA.boardId, COMPANIES_MYLA.boardId];
// Derived from the specs, not hand-listed: this used to name only Contacts and Accounts, which is how
// Deals (5028000494) and Products & Services (5028000489) came to have ZERO monday webhooks while the
// guard below still read as green.
const CRM_BOARDS = CRM_SPECS.map(s => s.boardId);

describe("CRM specs are invisible to a production deploy", () => {
  it("ALL_SPECS and SPEC_BY_BOARD still contain ONLY the WM specs", () => {
    // The point of this assertion is that no CRM spec leaked into ALL_SPECS, which is now expressed
    // by OWNER rather than by the absence of an ownership spec.
    expect(ALL_SPECS.every(s => s.ownership?.owner === "wm")).toBe(true);
    for (const b of CRM_BOARDS) expect(SPEC_BY_BOARD[b]).toBeUndefined();
  });

  it("the WM deployment resolves ONLY WM specs", () => {
    expect(specsFor(prod)).toEqual(ALL_SPECS);
    // WM declares ownership since 2026-09-22; what must hold is that none of it is CRM-owned.
    expect(specsFor(prod).some(s => s.ownership?.owner === "crm")).toBe(false);
  });

  // EXCLUSIVE, not a union. A union would make the CRM Worker a second processor for the WM boards,
  // writing the same monday records twice. Ownership guards HubSpot writes only — it would not help.
  // FOUR since 2026-09-14: Deals and Line Items joined the CRM scope by decision. The assertion that
  // matters is unchanged — CRM resolves the CRM specs EXCLUSIVELY and every one is crm-owned. The
  // count stays pinned so adding a spec is a deliberate edit here rather than silent drift.
  it("the CRM deployment resolves ONLY the CRM specs", () => {
    expect(specsFor(crmEnv)).toEqual(CRM_SPECS);
    expect(specsFor(crmEnv)).toHaveLength(4);
    expect(specsFor(crmEnv).every(s => s.ownership?.owner === "crm")).toBe(true);
  });

  it("the two spec sets are disjoint — no board is claimed by both", () => {
    const crm = new Set(CRM_BOARDS);
    expect(ALL_SPECS.map(s => s.boardId).filter(b => crm.has(b))).toEqual([]);
  });
});

describe("board resolution is one-way in each deployment", () => {
  it("WM environment: every CRM board resolves to NO spec", () => {
    for (const b of CRM_BOARDS) expect(specByBoard(prod, b)).toBeUndefined();
  });

  it("CRM environment: every WM board resolves to NO spec", () => {
    for (const b of WM_BOARDS) expect(specByBoard(crmEnv, b)).toBeUndefined();
  });

  it("a CRM board webhook resolves EXACTLY ONE spec, the CRM one", () => {
    expect(specByBoard(crmEnv, CRM_CONTACTS.boardId)).toBe(CRM_CONTACTS);
    expect(specByBoard(crmEnv, CRM_ACCOUNTS.boardId)).toBe(CRM_ACCOUNTS);
    for (const b of CRM_BOARDS)
      expect(specsFor(crmEnv).filter(s => s.boardId === b)).toHaveLength(1);
  });

  it("a WM board webhook never resolves a CRM spec, in either environment", () => {
    for (const b of WM_BOARDS) {
      expect(specByBoard(prod, b)?.ownership?.owner).toBe("wm");
      expect(specByBoard(crmEnv, b)).toBeUndefined();
    }
  });

  it("an unknown board resolves to nothing in both", () => {
    expect(specByBoard(prod, "999")).toBeUndefined();
    expect(specByBoard(crmEnv, "999")).toBeUndefined();
  });
});

describe("object resolution keeps Deals out of CRM", () => {
  it("CRM resolves contacts and companies to the CRM specs", () => {
    expect(specByObject(crmEnv, "contacts")).toBe(CRM_CONTACTS);
    expect(specByObject(crmEnv, "companies")).toBe(CRM_ACCOUNTS);
  });

  /**
   * CRM now OWNS deals — but on its own board. The isolation property was never "CRM has no deals";
   * it was "the two deployments never claim the same board", which is what this asserts. WM keeps
   * board 5029480547; CRM uses the monday CRM template's 5028000494.
   */
  it("CRM resolves deals to the CRM Deals board, never to the WM one", () => {
    const s = specByObject(crmEnv, "deals");
    expect(s?.boardId).toBe("5028000494");
    expect(s?.boardId).not.toBe(DEALS.boardId);
    expect(s?.ownership?.owner).toBe("crm");
  });

  it("WM resolves all three of its own objects", () => {
    expect(specByObject(prod, "deals")).toBe(DEALS);
    expect(specByObject(prod, "contacts")).toBe(CONTACTS_MYLA);
    expect(specByObject(prod, "companies")).toBe(COMPANIES_MYLA);
  });

  /** Every CRM spec stays on a CRM board. This is the check that would catch a spec accidentally
   *  pointed at a live Work-Management board — the failure that actually matters. */
  it("no CRM spec touches a WM board", () => {
    const wm = new Set(ALL_SPECS.map(s => s.boardId));
    for (const s of CRM_SPECS) expect(wm.has(s.boardId)).toBe(false);
  });
});

describe("ALL_KNOWN_SPECS is diagnostics-only", () => {
  it("is the union", () => expect(ALL_KNOWN_SPECS).toHaveLength(ALL_SPECS.length + CRM_SPECS.length));

  it("is NEVER what routing returns, in either environment", () => {
    expect(specsFor(prod)).not.toEqual(ALL_KNOWN_SPECS);
    expect(specsFor(crmEnv)).not.toEqual(ALL_KNOWN_SPECS);
    expect(specsFor(prod).length).toBeLessThan(ALL_KNOWN_SPECS.length);
    expect(specsFor(crmEnv).length).toBeLessThan(ALL_KNOWN_SPECS.length);
  });
});

describe("the gate is strict about its value", () => {
  // Anything other than the exact string "true" must mean WM, so a typo can never half-enable CRM.
  it.each(["", "false", "TRUE", "1", "yes", undefined])("ENABLE_CRM=%j resolves WM", (v) =>
    expect(specsFor({ ENABLE_CRM: v as string | undefined })).toEqual(ALL_SPECS));

  it("only the exact string \"true\" selects CRM", () =>
    expect(specsFor({ ENABLE_CRM: "true" })).toEqual(CRM_SPECS));
});

describe("CRM specs never join the full sweep", () => {
  it("both are skipFullReconcile, so runAll processes nothing on the CRM deployment", () => {
    expect(CRM_SPECS.every(s => s.skipFullReconcile)).toBe(true);
    expect(specsFor(crmEnv).filter(s => !s.skipFullReconcile)).toEqual([]);
  });
});

describe("monday webhook registration events", () => {
  it("registers create_item — NOT the delivered payload name create_pulse", async () => {
    const { CRM_WEBHOOK_EVENTS } = await import("../scripts/register-crm-webhooks.mjs");
    expect(CRM_WEBHOOK_EVENTS).toContain("create_item");
    expect(CRM_WEBHOOK_EVENTS).not.toContain("create_pulse");
    for (const e of ["change_column_value", "change_name", "item_deleted"])
      expect(CRM_WEBHOOK_EVENTS).toContain(e);
  });

  it("documents create_pulse as the DELIVERED alias, so the handler branches correctly", async () => {
    const { DELIVERED_EVENT_ALIASES } = await import("../scripts/register-crm-webhooks.mjs");
    expect(DELIVERED_EVENT_ALIASES.create_item).toContain("create_pulse");
  });

  it("targets EVERY CRM board and no WM board", async () => {
    const { CRM_BOARDS: boards } = await import("../scripts/register-crm-webhooks.mjs");
    // Every board the CRM deployment owns must be registered. A board with no webhook is silently
    // one-directional: its 创建/Create form produces cards the Worker never hears about.
    expect(Object.keys(boards).sort()).toEqual([...CRM_BOARDS].sort());
    for (const b of WM_BOARDS) expect(boards[b]).toBeUndefined();
  });

  it("covers Deals and Products & Services, the two boards that had none", async () => {
    const { CRM_BOARDS: boards } = await import("../scripts/register-crm-webhooks.mjs");
    expect(boards["5028000494"], "Deals board unregistered").toBeDefined();
    expect(boards["5028000489"], "Products & Services board unregistered").toBeDefined();
  });

  // IDEMPOTENCE. These use config: "{}" because that is what monday ACTUALLY returns — verified live
  // 2026-09-08. The previous version of this test used config: "" and passed against a filter that was
  // broken for real data: `config.includes(url) || !config` matched nothing when config was "{}", so
  // every event looked missing and a second --apply would have DOUBLED every hook. The fake data hid
  // the bug. monday's webhooks query exposes no target URL, so matching is on event name alone.
  const live = (events: string[]) =>
    events.map(e => ({ id: "1", event: e, board_id: "5028000495", config: "{}" }));

  it("missingEvents returns nothing when every event is already registered", async () => {
    const { missingEvents, CRM_WEBHOOK_EVENTS } = await import("../scripts/register-crm-webhooks.mjs");
    expect(missingEvents(live(CRM_WEBHOOK_EVENTS))).toEqual([]);
  });

  it("is idempotent across repeated runs — the duplicate-delivery guard", async () => {
    const { missingEvents, CRM_WEBHOOK_EVENTS } = await import("../scripts/register-crm-webhooks.mjs");
    const hooks = live(CRM_WEBHOOK_EVENTS);
    for (let i = 0; i < 3; i++) expect(missingEvents(hooks)).toEqual([]);
  });

  // Derived from CRM_WEBHOOK_EVENTS, not hardcoded: this asserts the BEHAVIOUR ("return exactly the
  // absent ones, in registration order"), so adding an event does not require editing the expectation.
  // A frozen literal here broke when item_archived and create_update were added, which is noise, not
  // a real regression signal.
  it("missingEvents returns only what is absent", async () => {
    const { missingEvents, CRM_WEBHOOK_EVENTS } = await import("../scripts/register-crm-webhooks.mjs");
    expect(missingEvents(live(["change_name"])))
      .toEqual(CRM_WEBHOOK_EVENTS.filter((e: string) => e !== "change_name"));
  });

  it("missingEvents returns everything for a board with no hooks", async () => {
    const { missingEvents, CRM_WEBHOOK_EVENTS } = await import("../scripts/register-crm-webhooks.mjs");
    expect(missingEvents([])).toEqual(CRM_WEBHOOK_EVENTS);
  });

  // A hook whose config is null/absent must also count as present.
  it("tolerates a missing config field", async () => {
    const { missingEvents, CRM_WEBHOOK_EVENTS } = await import("../scripts/register-crm-webhooks.mjs");
    expect(missingEvents([{ id: "1", event: "create_item" }] as never))
      .toEqual(CRM_WEBHOOK_EVENTS.filter((e: string) => e !== "create_item"));
  });
});
