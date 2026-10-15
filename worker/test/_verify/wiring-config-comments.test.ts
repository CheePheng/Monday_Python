import { describe, it, expect } from "vitest";
// @ts-ignore -- node:fs in a test (the worker tsconfig has no Node types; vitest runs on Node)
import { readFileSync } from "node:fs";
// @ts-ignore -- a .mjs helper with a .d.mts beside it
import { readWranglerConfig } from "../../scripts/read-wrangler.mjs";

/**
 * WIRING LENS -- the deployable config must describe the dispatch it ships with. The rewrite moved the reminder to
 * "*\/5" and made index.ts run the REMINDER (never the task poller) on it on the CRM Worker; it edited the cron
 * comment's second half but left the first half (wrangler.jsonc:15-20), which still says this config has ONE cron
 * and that "*\/5" is deliberately absent because it "would start the Task poller" -- four lines above a crons array
 * that holds "*\/5". True at HEAD (445405b: the reminder had its own minute list), false in the working tree.
 */

const raw: string = readFileSync(new URL("../../wrangler.jsonc", import.meta.url), "utf8");
/** The comment block directly above "triggers". */
const cronComment = (() => {
  const lines = raw.split(/\r?\n/);
  const at = lines.findIndex(l => l.includes('"triggers"'));
  let i = at - 1;
  while (i >= 0 && lines[i].trim().startsWith("//")) i--;
  return lines.slice(i + 1, at).join("\n");
})();

describe("wrangler.jsonc's cron comment matches the crons and index.ts", () => {
  it("CONTROL: the crons are */15 and */5", () =>
    expect(readWranglerConfig().triggers?.crons).toEqual(["*/15 * * * *", "*/5 * * * *"]));

  it("does not claim */5 is absent / would start the Task poller (on this Worker */5 is the reminder)", () => {
    expect(cronComment, "stale: '*/5 would start the Task poller'").not.toMatch(/\*\/5 would start the\s*(\/\/\s*)?Task poller/);
    expect(cronComment, "stale: 'ONE CRON, and only this one'").not.toMatch(/ONE CRON, and only this one/);
  });
});
