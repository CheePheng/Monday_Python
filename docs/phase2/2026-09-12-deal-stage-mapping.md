# Deal stage mapping — the decision that gates the Deals spec

**2026-09-12 · a decision document, not an audit.** Everything here is derived from measured HubSpot
schema (`docs/phase2/2026-09-11-deals-lineitems-activities-audit.md` §2.4). Nothing has been built.

`dealstage` has **42** values across 5 pipelines. The monday `deal_stage` status column has 6 usable
labels. Neither number can change: monday status columns were measured in this project to start
returning 500s above roughly 19 labels, and the pipelines belong to the business.

An earlier note in the audit said 45 values. Counting the option list returned by `get_properties`
gives 42 — 27 Salesforce (3 pipelines × 9), 8 Sales Pipeline, 7 Shared Selling. Corrected there too.

---

## The shape of the problem, restated in one line

**Stage is not one field. It is a (pipeline, stage) pair, and 89% of the deals live in pipelines whose
stage labels are duplicated across them.** `赢单` exists three times with three different internal
ids. Any mapping keyed on the label alone is ambiguous in the reverse direction, and a wrong reverse
write does not merely fail — it moves a deal into another pipeline's stage.

## What gets built

| column | type | direction | why |
|---|---|---|---|
| `deal_stage` (existing) | status, 7 labels | **HubSpot → monday only** | a coarse, readable summary. Many HubSpot stages map to one label, and a many-to-one map has no inverse. |
| `Pipeline` (new) | dropdown, 5 | two-way | a stage without its pipeline is ambiguous by construction |
| `HubSpot Stage` (new) | dropdown, 42, pipeline-qualified | **two-way** | qualifying the label restores uniqueness, which makes the inverse dictionary well-defined |

The business-editable field stays editable two-way — through `HubSpot Stage`. What goes one-way is a
display summary, which is not a field anyone edits to mean something.

`deal_stage` needs **one new label: `Paused`**, for `暂停`. Seven labels total, far under the ~19
ceiling. Without it, 暂停 deals would have to land on an existing label and would read as active.

---

## 1. `deal_stage` — the coarse map (HubSpot → monday only)

### Salesforce pipelines (×3: Sales, Maintenance, 赋能培训) — 4,360 + 3,358 + ~227 deals

| HubSpot stage | → `deal_stage` |
|---|---|
| `1 共同利益 MI` | New |
| `2 探索 Discover` | Discovery |
| `3 验证 Validate` | Discovery |
| `4 选择 Select` | Proposal |
| `5 决定 Decide` | Negotiation |
| `6 承诺 Commit` | Negotiation |
| `暂停` | **Paused** *(new label)* |
| `赢单` | Won |
| `输单` | Lost |

### Sales Pipeline (`default`) — 694 deals

| HubSpot stage | → `deal_stage` |
|---|---|
| Appointment Scheduled | New |
| Qualified To Buy | Discovery |
| Presentation Scheduled | Proposal |
| Decision Maker Bought-In | Negotiation |
| Contract Sent | Negotiation |
| Closed Won | Won |
| Closed Lost | Lost |
| `Trustpilot邀约评价（已成交）` | Won |

`Trustpilot邀约评价（已成交）` means "Trustpilot review invitation (closed)" — a post-sale follow-up
step, not an open stage, so it maps to Won. Worth a human confirming, since it is the one mapping
here inferred from a label rather than from pipeline position.

### HubSpot Shared Selling Pipeline — part of the 227

| HubSpot stage | → `deal_stage` |
|---|---|
| Discovery | Discovery |
| Solution Demo | Proposal |
| Business Considerations | Negotiation |
| Pricing and Terms | Negotiation |
| Out for Signature | Negotiation |
| Closed Won | Won |
| Closed Lost | Lost |

**Collisions this creates, and why they are acceptable:** `Negotiation` absorbs 3 stages in the
Salesforce pipelines and 3 in Shared Selling; `Discovery` absorbs 2. That is exactly why the column is
one-way. The exact stage is never lost — it is in `HubSpot Stage` beside it.

---

## 2. `HubSpot Stage` — the exact map (two-way)

Labels are `<pipeline> / <stage>`. The prefix is what restores uniqueness:

```
Sales / Appointment Scheduled          SF-Sales / 1 共同利益 MI
Sales / Qualified To Buy               SF-Sales / 2 探索 Discover
Sales / Presentation Scheduled         SF-Sales / 3 验证 Validate
Sales / Decision Maker Bought-In       SF-Sales / 4 选择 Select
Sales / Contract Sent                  SF-Sales / 5 决定 Decide
Sales / Closed Won                     SF-Sales / 6 承诺 Commit
Sales / Closed Lost                    SF-Sales / 暂停
Sales / Trustpilot邀约评价（已成交）      SF-Sales / 赢单
                                       SF-Sales / 输单
Shared / Discovery
Shared / Solution Demo                 SF-Maint / …  (same 9)
Shared / Business Considerations        SF-Train / …  (same 9)
Shared / Pricing and Terms
Shared / Out for Signature
Shared / Closed Won
Shared / Closed Lost
```

42 labels against a dropdown ceiling verified at 88 in this project. Every label is distinct, so the
label→value inverse is a function and the reverse write is safe.

**The reverse write must set `pipeline` and `dealstage` together in one PATCH.** HubSpot rejects a
`dealstage` that does not belong to the record's current `pipeline`, so writing the stage alone while
the pipeline still holds the old value fails — and writing them in two PATCHes leaves a window where
the pair is invalid. Both properties, one call.

---

## 3. What this costs if we get it wrong

Worth stating plainly, because it is the reason for the qualified dropdown rather than the obvious
single column:

- **Label-keyed inverse on the raw `dealstage`:** a rep edits Stage on a Maintenance deal, the
  dictionary resolves `赢单` to the *Sales* pipeline's id, and the deal silently changes pipeline.
  Reporting, forecasting and the Won automations all key off pipeline.
- **Two-way on the coarse column:** `Negotiation` has no single inverse, so any reverse write must
  pick one of three stages arbitrarily. This is the `sales_person` enum failure again — the one that
  froze Contact cards — except it writes a plausible wrong value instead of failing.

---

## 4. Open for the advisor

1. **Approve the three-column shape** (coarse one-way + Pipeline + qualified exact two-way), or say
   if you want `deal_stage` left strictly display-only with no sync at all.
2. **Confirm `Trustpilot邀约评价（已成交）` → Won.** The only mapping inferred from a label.
3. **Confirm the `Paused` label addition** to `deal_stage` for `暂停`.
4. **Pipeline prefixes** — `Sales` / `SF-Sales` / `SF-Maint` / `SF-Train` / `Shared`. These appear in
   the UI, so the sales team should recognise them.

Nothing is built until 1–4 are settled, and nothing is deployed until Contacts + Companies signs off.
