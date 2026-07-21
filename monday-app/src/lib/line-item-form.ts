export type LiFieldType = "text" | "textarea" | "number" | "date" | "enum" | "bool";
export interface LiField { prop: string; label: string; type: LiFieldType; group: "detail" | "billing" | "adjust" | "price"; required?: boolean; enum?: boolean }

export const LI_FIELDS: LiField[] = [
  { prop: "name", label: "Name", type: "text", group: "detail", required: true },
  { prop: "hs_sku", label: "SKU", type: "text", group: "detail" },
  { prop: "description", label: "Description", type: "textarea", group: "detail" },
  { prop: "brand_isv", label: "Brand ISV", type: "enum", group: "detail", enum: true },
  { prop: "family", label: "Family", type: "enum", group: "detail", enum: true },
  { prop: "product_subcategory", label: "Product Subcategory", type: "enum", group: "detail", enum: true },
  { prop: "is_active", label: "Is Active", type: "enum", group: "detail", enum: true },
  { prop: "note", label: "Note", type: "textarea", group: "detail" },
  { prop: "service_date", label: "Service Date", type: "date", group: "detail" },
  { prop: "recurringbillingfrequency", label: "Billing frequency", type: "enum", group: "billing", enum: true },
  { prop: "hs_recurring_billing_start_date", label: "Billing start date", type: "date", group: "billing" },
  { prop: "hs_tax_rate_group_id", label: "Tax rate", type: "enum", group: "adjust", enum: true },
  { prop: "hs_pricing_model", label: "Pricing model", type: "enum", group: "price", required: true, enum: true },
  { prop: "price", label: "Unit price", type: "number", group: "price", required: true },
  { prop: "quantity", label: "Quantity", type: "number", group: "price" },
  { prop: "hs_cost_of_goods_sold", label: "Unit cost", type: "number", group: "price" },
  { prop: "deposit", label: "Deposit", type: "number", group: "price" },
];

export interface LineItemFormValues extends Record<string, string | undefined> {
  discountMode?: "amount" | "percent"; discount?: string; hs_discount_percentage?: string;
}

const num = (v?: string) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const isNumeric = (v?: string) => !v || /^\d+(\.\d+)?$/.test(v.trim());

export function validateLineItemForm(f: LineItemFormValues): { ok: boolean; errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  if (!f.name?.trim()) errors.name = "Name is required";
  if (!f.price?.trim()) errors.price = "Unit price is required";
  if (!f.hs_pricing_model) errors.hs_pricing_model = "Pricing model is required";
  if (!isNumeric(f.price)) errors.price = "Must be a number";
  if (!isNumeric(f.quantity)) errors.quantity = "Must be a number";
  return { ok: Object.keys(errors).length === 0, errors };
}

export function computeTotals(f: LineItemFormValues): { subtotal: number; discountAmt: number; net: number; margin: number } {
  const qty = num(f.quantity) || 1, price = num(f.price);
  const subtotal = qty * price;
  const discountAmt = f.discountMode === "percent" ? subtotal * (num(f.hs_discount_percentage) / 100) : num(f.discount) * qty;
  const net = Math.max(0, subtotal - discountAmt);
  const margin = (price - num(f.hs_cost_of_goods_sold)) * qty;
  return { subtotal, discountAmt, net, margin };
}
