import { describe, it, expect } from "vitest";
import {
  ALL_SPECS, SPEC_BY_BOARD, specsFor, specByBoard, specByObject, ALL_KNOWN_SPECS,
  DEALS, CONTACTS_MYLA, COMPANIES_MYLA,
} from "../src/config";
import { CRM_CONTACTS, CRM_ACCOUNTS, CRM_SPECS } from "../src/config/crm";

const prod = {} as { ENABLE_CRM?: string };                 // production Worker: ENABLE_CRM unset
const crmEnv = { ENABLE_CRM: "true" } as { ENABLE_CRM?: string };

const WM_BOARDS = [DEALS.boardId, CONTACTS_MYLA.boardId, COMPANIES_MYLA.boardId];
const CRM_BOARDS = [CRM_CONTACTS.boardId, CRM_ACCOUNTS.boardId];

describe("CRM specs are invisible to a production deploy", () => {
  it("ALL_SPECS and SPEC_BY_BOARD still contain ONLY the WM specs", () => {
    expect(ALL_SPECS.every(s => !s.ownership)).toBe(true);
    for (const b of CRM_BOARDS) expect(SPEC_BY_BOARD[b]).toBeUndefined();
  });

  it("the WM deployment resolves ONLY WM specs", () => {
    expect(specsFor(prod)).toEqual(ALL_SPECS);
    expect(specsFor(prod).some(s => s.ownership)).toBe(false);
  });

  // EXCLUSIVE, not a union. A union would make the CRM Worker a second processor for the WM boards,
  // writing the same monday records twice. Ownership guards HubSpot writes only — it would not help.
  it("the CRM deployment resolves ONLY the two CRM specs", () => {
    expect(specsFor(crmEnv)).toEqual(CRM_SPECS);
    expect(specsFor(crmEnv)).toHaveLength(2);
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
      expect(specByBoard(prod, b)?.ownership).toBeUndefined();
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

  it("CRM resolves DEALS to nothing — a stray deal webhook is a no-op there", () =>
    expect(specByObject(crmEnv, "deals")).toBeUndefined());

  it("WM resolves all three of its own objects", () => {
    expect(specByObject(prod, "deals")).toBe(DEALS);
    expect(specByObject(prod, "contacts")).toBe(CONTACTS_MYLA);
    expect(specByObject(prod, "companies")).toBe(COMPANIES_MYLA);
  });

  it("no CRM spec is a deals spec, and none carries deal associations", () => {
    for (const s of CRM_SPECS) {
      expect(s.object).not.toBe("deals");
      expect(s.associations).toBeUndefined();
    }
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

  it("targets exactly the two CRM boards and no WM board", async () => {
    const { CRM_BOARDS: boards } = await import("../scripts/register-crm-webhooks.mjs");
    expect(Object.keys(boards).sort()).toEqual([...CRM_BOARDS].sort());
    for (const b of WM_BOARDS) expect(boards[b]).toBeUndefined();
  });

  // Idempotence: re-running must not create duplicate hooks.
  it("missingEvents returns nothing when every event is already registered", async () => {
    const { missingEvents, CRM_WEBHOOK_EVENTS } = await import("../scripts/register-crm-webhooks.mjs");
    const hooks = CRM_WEBHOOK_EVENTS.map((e: string) => ({ id: "1", event: e, config: "" }));
    expect(missingEvents(hooks, "")).toEqual([]);
  });

  it("missingEvents returns only what is absent", async () => {
    const { missingEvents } = await import("../scripts/register-crm-webhooks.mjs");
    expect(missingEvents([{ id: "1", event: "change_name", config: "" }], ""))
      .toEqual(["create_item", "change_column_value", "item_deleted"]);
  });

  it("missingEvents returns everything for a board with no hooks", async () => {
    const { missingEvents, CRM_WEBHOOK_EVENTS } = await import("../scripts/register-crm-webhooks.mjs");
    expect(missingEvents([], "")).toEqual(CRM_WEBHOOK_EVENTS);
  });
});
