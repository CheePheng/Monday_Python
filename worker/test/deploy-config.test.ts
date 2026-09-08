import { describe, it, expect } from "vitest";
import { readWranglerConfig } from "../scripts/read-wrangler.mjs";
import { writeModeFor, maxWritesFor } from "../src/run-opts";
import { labelDictsFor } from "../src/sync";
import { specsFor, specByBoard, specByObject, ALL_SPECS } from "../src/config";
import { CRM_SPECS } from "../src/config/crm";
import { cutoverFromEnv } from "../src/ownership";

/**
 * DEPLOYMENT CONFIG REGRESSION.
 *
 * This file exists because of a specific near-miss: every routing test asserted that
 * `specsFor({ENABLE_CRM:"true"})` returns the CRM specs, and they all passed — while the actual
 * deployable `wrangler.jsonc` never set ENABLE_CRM at all. Deploying it would have produced a Worker
 * resolving the WORK MANAGEMENT specs: a second processor for the live WM boards, holding a token that
 * can write HubSpot. The code was right and the config was wrong, so no code test could see it.
 *
 * These tests read the real file.
 */

const cfg = readWranglerConfig();
const vars = (cfg.vars ?? {}) as Record<string, string>;

describe("the deployable CRM Wrangler config", () => {
  it("targets the CRM Worker, NOT the live WM Worker", () => {
    expect(cfg.name).toBe("hubspot-monday-crm-sync");
    expect(cfg.name).not.toBe("hubspot-monday-sync");
  });

  it("pins the COMPANY Cloudflare account", () =>
    expect(cfg.account_id).toBe("5f4d31a75fd669df8527210deb973591"));

  // THE ONE THAT WAS MISSING.
  it("sets ENABLE_CRM=\"true\" — without it the Worker resolves the WM specs", () =>
    expect(vars.ENABLE_CRM).toBe("true"));

  it("ships with DRY_RUN=\"true\" as the checked-in default", () =>
    expect(vars.DRY_RUN).toBe("true"));

  it("ships with WRITE_HUBSPOT=\"false\" so no HubSpot mutation is possible", () =>
    expect(vars.WRITE_HUBSPOT).toBe("false"));

  it("declares NO cron triggers — no unattended sweeps on day one", () => {
    expect(cfg.triggers).toBeUndefined();
    expect(JSON.stringify(cfg)).not.toContain("crons");
  });

  it("does NOT commit a temporary test cutover", () => {
    expect(vars.CRM_CUTOVER_AT).toBeUndefined();
    // ...and an absent value is fail-closed.
    expect(cutoverFromEnv(vars.CRM_CUTOVER_AT)).toBe(Number.POSITIVE_INFINITY);
  });

  it("has its own Durable Object namespace, so CRM state cannot collide with production's", () => {
    expect(JSON.stringify(cfg.durable_objects)).toContain("CREATE_IDEMPOTENCY");
    expect(JSON.stringify(cfg.migrations)).toContain("CreateIdempotency");
  });

  // The config's own vars must produce the intended Phase-A behaviour end to end.
  it("the shipped vars yield NO writes of any kind", () => {
    const opts = writeModeFor(vars, maxWritesFor(vars));
    expect(opts.dryRun).toBe(true);
    expect(opts.writeHubspot).toBe(false);
  });

  it("and resolve to exactly the two CRM boards", () => {
    expect(specsFor(vars).map(s => s.boardId).sort()).toEqual(["5028000495", "5028000496"]);
  });
});

describe("write mode — every combination", () => {
  const mode = (DRY_RUN?: string, WRITE_HUBSPOT?: string) => writeModeFor({ DRY_RUN, WRITE_HUBSPOT }, 25);

  it("WM PRODUCTION (DRY_RUN=false, no WRITE_HUBSPOT) is UNCHANGED — HubSpot writes stay on", () =>
    expect(mode("false", undefined)).toMatchObject({ dryRun: false, writeHubspot: true }));

  it("CRM Phase A (DRY_RUN=true, WRITE_HUBSPOT=false): nothing writes", () =>
    expect(mode("true", "false")).toMatchObject({ dryRun: true, writeHubspot: false }));

  it("CRM Phase B (DRY_RUN=false, WRITE_HUBSPOT=false): real monday writes, ZERO HubSpot", () =>
    expect(mode("false", "false")).toMatchObject({ dryRun: false, writeHubspot: false }));

  it("dry-run ALWAYS suppresses HubSpot writes, whatever WRITE_HUBSPOT says", () => {
    for (const w of ["true", "false", undefined, "yes"])
      expect(mode("true", w).writeHubspot).toBe(false);
  });

  // Opt-OUT: only the exact string "false" disables. Anything else must leave production alone.
  it.each(["true", "TRUE", "", "1", "no", undefined])(
    "WRITE_HUBSPOT=%j with DRY_RUN=false keeps HubSpot writes ENABLED", (w) =>
      expect(mode("false", w).writeHubspot).toBe(true));

  it("an unset DRY_RUN is dry — a missing var never turns writes on", () =>
    expect(mode(undefined, undefined)).toMatchObject({ dryRun: true, writeHubspot: false }));

  it("maxWrites falls back safely on junk input", () => {
    expect(maxWritesFor({ MAX_WRITES: "50" })).toBe(50);
    for (const v of ["0", "-1", "abc", "", undefined]) expect(maxWritesFor({ MAX_WRITES: v })).toBe(25);
  });
});

describe("spec-driven metadata: the CRM app needs NO Deals scope", () => {
  const prod = {} as { ENABLE_CRM?: string };
  const crmEnv = { ENABLE_CRM: "true" };

  it("CRM loads no deal-backed label dictionary", () => {
    const dicts = labelDictsFor(crmEnv);
    for (const dealDict of ["stage", "dealtype", "priority", "vendor"])
      expect(dicts).not.toContain(dealDict);
  });

  it("CRM loads exactly the contact + company dictionaries its fields reference", () =>
    expect(labelDictsFor(crmEnv).sort())
      .toEqual(["companyType", "contactPriority", "contactSource", "contactVendor",
                "industry", "leadStatus", "lifecycleStage", "partnerWith", "salesUser"]));

  // WM REGRESSION: it must still load everything it loaded before the refactor.
  it("WM still loads every dictionary it used to fetch unconditionally", () => {
    const dicts = labelDictsFor(prod);
    for (const d of ["stage", "dealtype", "priority", "vendor", "leadStatus", "contactSource",
                     "contactVendor", "industry", "companyType", "partnerWith"])
      expect(dicts).toContain(d);
  });

  it("every dictionary a spec references is one buildCtx knows how to load", () => {
    for (const env of [prod, crmEnv])
      for (const spec of specsFor(env))
        for (const f of spec.fields)
          if (f.labels) expect(labelDictsFor(env)).toContain(f.labels);
  });
});

describe("CRM_CUTOVER_AT is deployment config, and fails closed", () => {
  const crm = (CRM_CUTOVER_AT?: string) => specsFor({ ENABLE_CRM: "true", CRM_CUTOVER_AT });
  const cutoverOf = (CRM_CUTOVER_AT?: string) => crm(CRM_CUTOVER_AT)[0].ownership!.cutoverAtMs;

  it("unset leaves the inert shipped cutover, and returns the ORIGINAL spec objects", () => {
    expect(cutoverOf(undefined)).toBe(Number.POSITIVE_INFINITY);
    expect(crm(undefined)).toBe(CRM_SPECS);          // identity preserved for the default path
  });

  it("a real ISO timestamp is applied to BOTH specs", () => {
    const want = Date.parse("2026-09-07T11:00:00Z");
    for (const s of crm("2026-09-07T11:00:00Z")) expect(s.ownership!.cutoverAtMs).toBe(want);
  });

  it("epoch milliseconds work too", () =>
    expect(cutoverOf(String(Date.parse("2026-10-01T00:00:00Z"))))
      .toBe(Date.parse("2026-10-01T00:00:00Z")));

  // FAIL CLOSED. Each of these is a plausible operator slip, and every one must leave the CRM path
  // unable to claim or card anything rather than silently choosing a cutover in the distant past.
  it.each(["", "   ", "0", "1", "2026", "20261001", "not-a-date", "1e21", "1970-01-01T00:00:00Z",
           "2199-01-01T00:00:00Z", "3000-01-01T00:00:00Z"])(
    "CRM_CUTOVER_AT=%j fails closed to Infinity", (v) =>
      expect(cutoverOf(v)).toBe(Number.POSITIVE_INFINITY));

  it("applying a cutover changes ONLY the cutover — board, columns and owner are untouched", () => {
    const [acc, con] = crm("2026-09-07T11:00:00Z");
    expect(acc.boardId).toBe(CRM_SPECS[0].boardId);
    expect(con.boardId).toBe(CRM_SPECS[1].boardId);
    expect(con.ownership!.owner).toBe("crm");
    expect(con.ownership!.prop).toBe("sync_owner");
    expect(con.fields).toBe(CRM_SPECS[1].fields);     // same field array, not a rebuilt one
  });

  it("the WM deployment ignores CRM_CUTOVER_AT entirely", () => {
    expect(specsFor({ CRM_CUTOVER_AT: "2026-09-07T11:00:00Z" })).toBe(ALL_SPECS);
    for (const s of specsFor({ CRM_CUTOVER_AT: "2026-09-07T11:00:00Z" }))
      expect(s.ownership).toBeUndefined();
  });

  it("board/object resolution still works with a cutover set", () => {
    const env = { ENABLE_CRM: "true", CRM_CUTOVER_AT: "2026-09-07T11:00:00Z" };
    expect(specByBoard(env, "5028000495")?.object).toBe("contacts");
    expect(specByObject(env, "companies")?.boardId).toBe("5028000496");
    expect(specByObject(env, "deals")).toBeUndefined();
  });
});
