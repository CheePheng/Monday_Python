# Phone Country Fix + Backfill — Design

**Date:** 2026-07-24
**Status:** approved for implementation

## Problem

The worker formats every contact phone with a hardcoded country: `mapping.ts:24`
`case "phone": return { phone: v.replace(/[^\d+]/g, ""), countryShortName: "SG" };`

A local Malaysian number like `012-345 6789` is stored as `{ phone: "0123456789", countryShortName: "SG" }`.
monday then renders a 10-digit number as an 8-digit Singapore number and mangles the display (the user's
`56789`). Verified live: the stored digits are intact — only the forced `SG` country breaks the rendering.

**Scope (measured):** 409 of 713 contacts have a phone. **111** are local numbers wrongly stamped `SG`
(visibly broken). **295** start with `+` and display fine (monday reads the country from the `+` code and
ignores the bogus `SG`). Phone is written **only at card creation** (it is deliberately non-diffable, since
HubSpot/monday phone formats differ), so existing cards will not self-heal — a one-time backfill is needed.

## Verified monday behaviour (tested live on the card)

| Sent | Stored `text` | Result |
|---|---|---|
| `0123456789` + `SG` | `0123456789` | UI mangles it as a SG number |
| `+60123456789`, no country | `+60123456789` | ✓ UI reads 🇲🇾 from `+60` |
| `0123456789`, no country | `0123456789` | ✓ plain digits, no wrong flag |
| `012-345 6789` (with dash/space) | — | **rejected**: "invalid value" |

So monday needs **digit-only** (or `+`-digit) input, and it derives the country from a leading `+`.

## Fix

**A — `worker/src/mapping.ts`**, rewrite the `phone` case:
```ts
case "phone": {
  const digits = v.replace(/[^\d]/g, "");
  if (!digits) return null;
  // International (leading +): keep the + so monday reads the country from the code.
  // Local (no +): store the raw digits with NO country, so monday shows the number as-is
  // instead of mangling it against a wrong default. (Per the "no default country" decision.)
  return v.trim().startsWith("+") ? { phone: "+" + digits } : { phone: digits };
}
```

`formatValue` is pure; covered by unit tests in `worker/test/mapping.test.ts`:
- `+60 12-345 6789` → `{ phone: "+60123456789" }`
- `012-345 6789` → `{ phone: "0123456789" }`
- `+1 (555) 123-4567` → `{ phone: "+15551234567" }`
- (empty is already handled by `formatValue`'s guard — returns `null` before the switch)

**Why no country detection (decided):** the affected contacts are multi-country and mostly **Chinese**,
not Malaysian — e.g. `0755-86960562` (Shenzhen), `13138615332` (China Mobile), `022-50548203` (Tianjin),
plus junk like a date typed into the phone field. HubSpot's own `hs_calculated_phone_number_country_code`
mis-detects Chinese mobiles as `US`/`CA`, so trusting any auto-detected country would stamp a *different*
wrong flag. Reliable detection would need libphonenumber-grade parsing + per-country national-prefix
stripping — out of scope. Raw digits with **no country** is correct across Chinese, Malaysian, and garbage
data alike, and is the confirmed choice.

**B — one-time backfill** (`scratchpad/fix-phones.cjs`, not committed to the worker): for every contact
card with a phone, read the HubSpot `phone`, compute the corrected monday value with the **same** logic as
the fix, and re-write the column **only when it differs**. Idempotent and resumable (same pattern as the
created-date fill). Backfills **all 409** (the 111 broken ones get fixed; the 295 international ones get
their misleading `SG` field dropped — display-neutral but consistent). Dry-run first to confirm the count.

## Testing

| Change | Test |
|---|---|
| `mapping.ts` phone case | ✅ unit tests in `mapping.test.ts` (pure) |
| backfill script | dry-run count → live run → dry-run shows 0 remaining |

Worker `tsc` + `vitest` stay green. No app change. No schema/board change.

## Non-goals

- Not making phone diffable (that's why it's create-only; out of scope).
- No change to company/deal boards (only contacts have a phone field).
- No country **detection from HubSpot address fields** — the rule is `+` → country code, else raw digits.
