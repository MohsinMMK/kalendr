-- Services whose price text is one exact amount ("₹800", "Rs. 1,200") get that amount as their price.
-- Text like "From ₹1,500" stays without a price. Matches priceFromLabel in src/lib/money.ts.
UPDATE "services"
SET "price_minor" = round(
  replace(replace(replace(regexp_replace(trim("price_label"), '^(₹|rs\.?|inr)\s*', '', 'i'), ',', ''), '/-', ''), ' ', '')::numeric * 100
)::integer
WHERE "price_minor" IS NULL
  AND "price_label" ~* '^\s*(₹|rs\.?|inr)?\s*([0-9]{1,3}(,[0-9]{2,3})*|[0-9]+)(\.[0-9]{1,2})?\s*(/-)?\s*$';
--> statement-breakpoint
-- Visits from today on cost what their service costs now. Earlier visits stay without a price,
-- so nothing already finished suddenly shows money due.
UPDATE "appointments" AS appointment
SET "price_minor" = service."price_minor"
FROM "services" AS service
WHERE appointment."price_minor" IS NULL
  AND service."tenant_id" = appointment."tenant_id"
  AND service."id" = appointment."service_id"
  AND service."price_minor" IS NOT NULL
  AND appointment."starts_at" >= date_trunc('day', now());
