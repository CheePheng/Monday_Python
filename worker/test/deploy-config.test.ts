import { describe, it, expect } from "vitest";
import { readWranglerConfig } from "../scripts/read-wrangler.mjs";
import { scanWriteMode } from "../scripts/scan-write-mode.mjs";
import { writeModeFor, maxWritesFor, webhookOpts } from "../src/run-opts";
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

  // Four boards since 2026-09-14 (Deals 5028000494 and Line Items 5028000489 joined). Pinned so a new
  // board is a deliberate edit here, and so a WM board appearing in this list fails loudly.
  it("and resolve to exactly the four CRM boards", () => {
    expect(specsFor(vars).map(s => s.boardId).sort())
      .toEqual(["5028000489", "5028000494", "5028000495", "5028000496"]);
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

  // REGRESSION, found 2026-09-08. run-opts.ts calls itself "THE SINGLE PLACE that decides whether
  // writes actually happen" and it was not: webhooks.ts computed its own `{ writeHubspot: live }` and
  // never read WRITE_HUBSPOT. That is the ONLY live path on the CRM deployment — no crons, and both
  // CRM specs set skipFullReconcile — so Phase B's HubSpot kill switch was inert exactly where it
  // mattered, and the sole thing refusing reverse writes was the ownership gate.
  it("the WEBHOOK path honours WRITE_HUBSPOT — it is the only live path on the CRM worker", () => {
    expect(webhookOpts({ DRY_RUN: "false", WRITE_HUBSPOT: "false" }))
      .toMatchObject({ dryRun: false, writeHubspot: false });
    expect(webhookOpts({ DRY_RUN: "false" }))
      .toMatchObject({ dryRun: false, writeHubspot: true });   // WM production, unchanged
    expect(webhookOpts({ DRY_RUN: "true", WRITE_HUBSPOT: "false" }))
      .toMatchObject({ dryRun: true, writeHubspot: false });
  });

  it("a webhook gets a per-event write budget, not a cron-sized one", () =>
    expect(webhookOpts({ DRY_RUN: "false" }).maxWrites).toBe(30));

  // Belt and braces: no module may re-derive writeHubspot for itself again. A duplicate is invisible
  // to every behavioural test — each copy is individually correct — so only a source scan finds it.
  it("no source file computes writeHubspot outside run-opts.ts", () =>
    expect(scanWriteMode()).toEqual([]));

  it("maxWrites falls back safely on junk input", () => {
    expect(maxWritesFor({ MAX_WRITES: "50" })).toBe(50);
    for (const v of ["0", "-1", "abc", "", undefined]) expect(maxWritesFor({ MAX_WRITES: v })).toBe(25);
  });
});

/**
 * The point of this block was never "CRM avoids Deals" — it is that a deployment fetches ONLY the
 * metadata its own specs reference, so neither app needs a scope it has no business holding. That
 * property is unchanged; what changed on 2026-09-14 is which specs CRM owns. The four Deals and Line
 * Items scopes were granted for exactly this, and verified live the same day.
 */
describe("spec-driven metadata: each deployment fetches only what its specs reference", () => {
  const prod = {} as { ENABLE_CRM?: string };
  const crmEnv = { ENABLE_CRM: "true" };

  it("CRM now loads the deal + line-item dictionaries, because it owns those objects", () => {
    const dicts = labelDictsFor(crmEnv);
    for (const d of ["crmStage", "crmPipeline", "dealtype", "priority", "vendor", "liBrand"])
      expect(dicts).toContain(d);
  });

  /**
   * `crmStage` is NOT interchangeable with `stage`, and this is the assertion that keeps them apart:
   * `stage` covers the default pipeline only, while this portal has 42 stages across 5 pipelines with
   * DUPLICATE labels (赢单 is three distinct ids). CRM must carry the pipeline-qualified dictionary or
   * a reverse write can move a deal into the wrong pipeline.
   */
  it("CRM carries the pipeline-qualified stage dictionary, not just the default-pipeline one", () => {
    expect(labelDictsFor(crmEnv)).toContain("crmStage");
  });

  it("CRM loads exactly the dictionaries its fields reference", () =>
    expect(labelDictsFor(crmEnv).sort())
      // Pinned so an accidental addition shows up as a deliberate change to this list — each entry
      // costs one HubSpot schema fetch per run. `industry` is absent because company industry is
      // unmapped and the contact-level one is free text with no dictionary.
      .toEqual(["companyType", "contactCity", "contactCountries", "contactDepartment",
                "contactLeadSourceSub", "contactPriority", "contactSalesPerson", "contactSource",
                "contactStatus", "contactVendor", "crmPipeline", "crmStage", "dealtype", "leadStatus",
                "liBillingFreq", "liBrand", "liCurrency", "liFamily", "liIsActive", "liPricingModel",
                "liSubcategory", "liTaxRate", "lifecycleStage", "partnerWith", "pipeline", "priority",
                "salesUser", "stage", "vendor"]));

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
    // Deals resolve on CRM since 2026-09-14 — to the CRM board, never the WM one.
    expect(specByObject(env, "deals")?.boardId).toBe("5028000494");
  });
});
