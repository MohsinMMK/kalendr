// Creates Kalendr's paid plans at a payment provider and prints the ids to put in the environment.
//
//   RAZORPAY_KEY_ID=rzp_test_... RAZORPAY_KEY_SECRET=... node scripts/billing-sync-plans.mjs razorpay
//   STRIPE_SECRET_KEY=sk_test_... node scripts/billing-sync-plans.mjs stripe
//
// Run by the owner, with their own keys. It refuses live keys unless you add --live, so a first run cannot charge
// anyone. It creates new plans every time it runs (providers do not let plans be edited), so run it once per
// provider and keep the printed lines. It prints ids only; no key or secret.
import Razorpay from "razorpay";
import Stripe from "stripe";

// Keep in step with src/lib/entitlements.ts (planDefinitions). Prices are per month, in the smallest unit.
const plans = [
  { key: "starter", name: "Starter", inr: 49_900, usd: 900 },
  { key: "growth", name: "Growth", inr: 149_900, usd: 2_900 },
  { key: "scale", name: "Scale", inr: 399_900, usd: 7_900 },
];

const provider = process.argv[2];
const live = process.argv.includes("--live");

if (provider === "razorpay") {
  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;
  if (!keyId || !keySecret) throw new Error("Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET.");
  if (keyId.startsWith("rzp_live_") && !live) throw new Error("These are live keys. Add --live if you really mean it.");
  const client = new Razorpay({ key_id: keyId, key_secret: keySecret });
  for (const plan of plans) {
    // Razorpay charges the plan amount as the full price, so it already contains 18% GST (see docs/subscription-billing.md).
    const created = await client.plans.create({ period: "monthly", interval: 1, item: { name: `Kalendr ${plan.name}`, amount: plan.inr, currency: "INR", description: `Kalendr ${plan.name} plan, monthly` } });
    console.log(`RAZORPAY_PLAN_ID_${plan.key.toUpperCase()}=${created.id}`);
  }
} else if (provider === "stripe") {
  const secret = process.env.STRIPE_SECRET_KEY;
  if (!secret) throw new Error("Set STRIPE_SECRET_KEY.");
  if (secret.startsWith("sk_live_") && !live) throw new Error("This is a live key. Add --live if you really mean it.");
  const client = new Stripe(secret);
  for (const plan of plans) {
    const product = await client.products.create({ name: `Kalendr ${plan.name}`, metadata: { planKey: plan.key } });
    const price = await client.prices.create({ product: product.id, currency: "usd", unit_amount: plan.usd, recurring: { interval: "month" }, metadata: { planKey: plan.key } });
    console.log(`STRIPE_PRICE_ID_${plan.key.toUpperCase()}=${price.id}`);
  }
} else {
  throw new Error("Usage: node scripts/billing-sync-plans.mjs razorpay|stripe [--live]");
}
