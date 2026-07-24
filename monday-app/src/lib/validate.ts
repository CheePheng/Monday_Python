export interface DealErrors { name?: string; stage?: string; amount?: string }
export function validateDealForm(name: string, form: { stage?: string; amount?: string }): { ok: boolean; errors: DealErrors } {
  const errors: DealErrors = {};
  if (!name.trim()) errors.name = "Deal name is required";
  if (!form.stage) errors.stage = "Stage is required";
  if (form.amount && !/^\d+(\.\d+)?$/.test(form.amount.trim())) errors.amount = "Amount must be a number";
  return { ok: Object.keys(errors).length === 0, errors };
}
