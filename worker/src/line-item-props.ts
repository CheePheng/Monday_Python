/** Writable HubSpot line_item properties the app may send (verified against the live schema).
 * Calculated/read-only props (amount, hs_pre_discount_amount, hs_margin, hs_post_tax_amount) are NOT here. */
export const LINE_ITEM_WRITE_PROPS = new Set<string>([
  "name", "hs_sku", "description", "brand_isv", "family", "is_active", "note", "product_subcategory",
  "service_date", "recurringbillingfrequency", "hs_recurring_billing_start_date",
  "hs_billing_start_delay_days", "hs_billing_start_delay_months",
  "discount", "hs_discount_percentage", "hs_tax_rate_group_id", "hs_pricing_model",
  "price", "quantity", "hs_cost_of_goods_sold", "deposit", "hs_product_id", "hs_line_item_currency_code",
]);

/** Enum props whose options the form fetches live from HubSpot (so new options appear without a redeploy). */
export const LINE_ITEM_ENUM_PROPS = [
  "brand_isv", "family", "product_subcategory", "is_active",
  "recurringbillingfrequency", "hs_pricing_model", "hs_tax_rate_group_id",
];

/** Props copied line-item -> new product when "Save to product library" is checked (product has no
 * per-line currency or product-id of its own). */
export const PRODUCT_COPY_PROPS = new Set<string>([
  "name", "hs_sku", "description", "brand_isv", "family", "is_active", "note", "product_subcategory",
  "recurringbillingfrequency", "hs_pricing_model", "price", "hs_cost_of_goods_sold", "deposit",
]);

/** Keep only allowlisted, non-empty string props. */
export function pickWritableLineItemProps(props: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(props ?? {}))
    if (LINE_ITEM_WRITE_PROPS.has(k) && v != null && String(v) !== "") out[k] = String(v);
  return out;
}
