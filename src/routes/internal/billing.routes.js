"use strict";

const express = require("express");
const router = express.Router();
const Stripe = require("stripe");
const { loadCompanyContext, requireCompanyOwner } = require("../../middleware/companyContext");
const { sendStarterWelcomeEmail } = require("../../clients/mailgun");

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: "2024-06-20",
});

// Map your Stripe Price IDs here (from Dashboard)
const PRICE_BY_PLAN = {
  core: process.env.STRIPE_PRICE_CORE,
  pro: process.env.STRIPE_PRICE_PRO,
  enterprise: process.env.STRIPE_PRICE_ENT,
};

// Helpers
function requireSession(req, res) {
  if (!req.session?.userId) {
    res.status(401).json({ error: "Not authenticated" });
    return false;
  }
  return true;
}

async function getOrCreateStripeCustomer(req) {
  const companyId = req.companyContext.companyId;
  const ownerUserId = req.companyContext.ownerUserId;

  const { rows } = await req.db.query(
    `
    SELECT c.id, c.stripe_customer_id, u.email
    FROM companies c
    LEFT JOIN users u ON u.id = $2
    WHERE c.id = $1
    `,
    [companyId, ownerUserId]
  );
  if (!rows.length) throw new Error("Company not found");

  const company = rows[0];

  if (company.stripe_customer_id) {
    return { customerId: company.stripe_customer_id, email: company.email };
  }

  const customer = await stripe.customers.create({
    email: company.email,
    metadata: { companyId: String(companyId), ownerUserId: String(ownerUserId || "") },
  });

  await req.db.query(
    `UPDATE companies SET stripe_customer_id = $1 WHERE id = $2`,
    [customer.id, companyId]
  );

  return { customerId: customer.id, email: company.email };
}

async function applyPlanToCompany(req, planCode, extra = {}) {
  const companyId = req.companyContext.companyId;
  const normalizedPlan = String(planCode || "").trim().toUpperCase();
  if (!normalizedPlan) throw new Error("Missing plan code");

  const {
    subscriptionStatus = null,
    stripeSubscriptionId = null,
    currentPeriodEnd = null,
    cancelAtPeriodEnd = null,
  } = extra;

  await req.db.query(
    `
    UPDATE companies c
    SET
      plan = p.plan_code,
      carrier_limit = p.carrier_limit,
      subscription_status = COALESCE($3, c.subscription_status),
      stripe_subscription_id = $4,
      current_period_end = $5::timestamp,
      cancel_at_period_end = COALESCE($6, c.cancel_at_period_end)
    FROM plans p
    WHERE c.id = $1
      AND p.plan_code = $2
      AND p.is_active = true
    `,
    [
      companyId,
      normalizedPlan,
      subscriptionStatus,
      stripeSubscriptionId,
      currentPeriodEnd,
      cancelAtPeriodEnd,
    ]
  );
}

async function syncPlanToCompanyMembers(req, planCode, extra = {}) {
  const companyId = req.companyContext.companyId;
  const normalizedPlan = String(planCode || "").trim().toUpperCase();
  if (!normalizedPlan) throw new Error("Missing plan code");

  const {
    subscriptionStatus = null,
    currentPeriodEnd = null,
    cancelAtPeriodEnd = null,
  } = extra;

  await req.db.query(
    `
    UPDATE users u
    SET
      plan = p.plan_code,
      carrier_limit = p.carrier_limit,
      email_alerts = p.email_alerts,
      rest_alerts = p.rest_alerts,
      webhook_alerts = p.webhook_alerts,
      view_insurance = p.view_insurance,
      send_contracts = p.send_contracts,
      email_alerts_enabled = p.email_alerts,
      subscription_status = COALESCE($3, u.subscription_status),
      current_period_end = COALESCE($4::timestamp, u.current_period_end),
      cancel_at_period_end = COALESCE($5, u.cancel_at_period_end)
    FROM plans p, company_members cm
    WHERE u.id = cm.user_id
      AND cm.company_id = $1
      AND cm.status = 'ACTIVE'
      AND p.plan_code = $2
      AND p.is_active = true
    `,
    [companyId, normalizedPlan, subscriptionStatus, currentPeriodEnd, cancelAtPeriodEnd]
  );
}




/**
 * POST /billing/continue
 * Body: { plan: "core" | "pro" | "enterprise", context?: "upgrade" | "new" }
 * Returns: { url, mode }
 */
router.post("/billing/continue", loadCompanyContext, requireCompanyOwner, async (req, res) => {
  if (!requireSession(req, res)) return;

  try {
    const companyId = req.companyContext.companyId;
    const plan = String(req.body?.plan || "core").toLowerCase().trim();
    const context = String(req.body?.context || "").toLowerCase().trim(); // optional

    // Pull subscription state from your users table
    const { rows } = await req.db.query(
      `
      SELECT stripe_customer_id, stripe_subscription_id, subscription_status
      FROM companies
      WHERE id = $1
      `,
      [companyId]
    );

    if (!rows.length) return res.status(404).json({ error: "Company not found" });

    const u = rows[0];
    const status = String(u.subscription_status || "").toLowerCase();

    const hasActiveishSub =
      !!u.stripe_subscription_id &&
      ["active", "trialing", "past_due"].includes(status);

    const baseUrl =
      process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get("host")}`;

    // Make sure we have a Stripe customer for either path
    const { customerId } = await getOrCreateStripeCustomer(req);

    // EXISTING CUSTOMER: use Customer Portal
    // (This is the key behavior change.)
    if (hasActiveishSub || context === "upgrade") {
      // allow only internal return paths (copying your portal safety pattern)
      const returnPath = "/account?tab=plan";
      const portal = await stripe.billingPortal.sessions.create({
        customer: customerId,
        return_url: `${baseUrl}${returnPath}`,
      });

      return res.json({ url: portal.url, mode: "portal" });
    }

    // NEW CUSTOMER: go to Checkout as you already do
    const priceId = PRICE_BY_PLAN[plan];
    if (!priceId) {
      return res.status(400).json({ error: "Invalid plan." });
    }

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: customerId,
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${baseUrl}/account?tab=plan&checkout=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${baseUrl}/account?tab=plan&checkout=canceled`,
      allow_promotion_codes: true,
      metadata: {
        userId: String(req.session.userId),
        companyId: String(companyId),
        plan,
      },
    });

    return res.json({ url: session.url, mode: "checkout" });
  } catch (e) {
    console.error("POST /billing/continue error:", e);
    return res.status(500).json({ error: e.message || "Server error" });
  }
});

/**
 * POST /billing/activate-starter
 * Activates Starter without creating a Stripe checkout session.
 */
router.post("/billing/activate-starter", loadCompanyContext, requireCompanyOwner, async (req, res) => {
  if (!requireSession(req, res)) return;

  try {
    const companyId = req.companyContext.companyId;
    const currentBilling = await req.db.query(
      `
      SELECT plan, subscription_status
      FROM companies
      WHERE id = $1
      LIMIT 1
      `,
      [companyId]
    );
    const previousPlan = String(currentBilling.rows[0]?.plan || "").toUpperCase();
    const previousStatus = String(currentBilling.rows[0]?.subscription_status || "").toLowerCase();
    const shouldSendStarterWelcome =
      previousPlan !== "STARTER" ||
      !["active", "trialing"].includes(previousStatus);

    const exists = await req.db.query(
      `
      SELECT 1
      FROM plans
      WHERE plan_code = 'STARTER'
        AND is_active = true
      LIMIT 1
      `
    );
    if (!exists.rows.length) {
      return res.status(400).json({ error: "Starter plan is unavailable." });
    }

    await req.db.query("BEGIN");
    await applyPlanToCompany(req, "STARTER", {
      subscriptionStatus: "active",
      stripeSubscriptionId: null,
      currentPeriodEnd: null,
      cancelAtPeriodEnd: false,
    });
    await syncPlanToCompanyMembers(req, "STARTER", {
      subscriptionStatus: "active",
      currentPeriodEnd: null,
      cancelAtPeriodEnd: false,
    });
    await req.db.query("COMMIT");

    const baseUrl =
      process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get("host")}`;
    const loginUrl = `${baseUrl}/account`;

    try {
      const { rows } = await req.db.query(
        `
        SELECT
          u.email,
          u.name AS user_name,
          c.name AS company_name
        FROM users u
        LEFT JOIN companies c
          ON c.id = $1
        WHERE u.id = $2
        LIMIT 1
        `,
        [companyId, req.companyContext.ownerUserId]
      );
      const owner = rows[0];
      if (owner?.email && shouldSendStarterWelcome) {
        await sendStarterWelcomeEmail({
          to: owner.email,
          first_name: (owner.user_name || "").split(" ")[0] || "",
          company_name: owner.company_name || "",
          login_url: loginUrl,
        });
      }
    } catch (mailErr) {
      console.error("sendStarterWelcomeEmail failed:", mailErr?.message || mailErr);
    }

    return res.json({ ok: true, companyId, url: "/account" });
  } catch (e) {
    await req.db.query("ROLLBACK").catch(() => {});
    console.error("POST /billing/activate-starter error:", e);
    return res.status(500).json({ error: e.message || "Server error" });
  }
});







/**
 * POST /billing/checkout
 * Body: { plan: "core" | "pro" | "enterprise" }
 * Returns: { url }
 */
router.post("/billing/checkout", loadCompanyContext, requireCompanyOwner, async (req, res) => {
  if (!requireSession(req, res)) return;

  try {
    const companyId = req.companyContext.companyId;
    const plan = String(req.body?.plan || "core").toLowerCase().trim();
    const priceId = PRICE_BY_PLAN[plan];

    if (!priceId) {
      return res.status(400).json({ error: "Invalid plan." });
    }

    const { customerId } = await getOrCreateStripeCustomer(req);

    const baseUrl =
      process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get("host")}`;

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: customerId,
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${baseUrl}/account?tab=plan&checkout=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${baseUrl}/account?tab=plan&checkout=canceled`,
      allow_promotion_codes: true,
      metadata: {
        userId: String(req.session.userId),
        companyId: String(companyId),
        plan,
      },
    });

    return res.json({ url: session.url });
  } catch (e) {
    console.error("POST /billing/checkout error:", e);
    return res.status(500).json({ error: e.message || "Server error" });
  }
});

//Billing Portal
router.post("/billing/portal", loadCompanyContext, requireCompanyOwner, async (req, res) => {
  if (!requireSession(req, res)) return;

  try {
    const { customerId } = await getOrCreateStripeCustomer(req);

    const baseUrl =
      process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get("host")}`;

    // allow only internal return paths
    const returnPath = String(req.body?.returnPath || "/account?tab=billing");
    const safeReturnPath =
      returnPath.startsWith("/") ? returnPath : "/account?tab=billing";

    const portal = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: `${baseUrl}${safeReturnPath}`,
    });

    return res.json({ url: portal.url });
  } catch (e) {
    console.error("POST /billing/portal error:", e);
    return res.status(500).json({ error: "Server error" });
  }
});

/**
 * GET /billing/session?session_id=cs_...
 * Returns: { ok, plan, price, email, subscriptionId, subscriptionStatus }
 */
router.get("/billing/session", loadCompanyContext, requireCompanyOwner, async (req, res) => {
  if (!requireSession(req, res)) return;

  try {
    const sessionId = String(req.query.session_id || "");
    if (!sessionId.startsWith("cs_")) {
      return res.status(400).json({ error: "Invalid session_id" });
    }

    // 1) Session (metadata + customer_details + subscription)
    const session = await stripe.checkout.sessions.retrieve(sessionId, {
      expand: ["subscription"],
    });

    // 2) Line items (reliable way to get the price)
    const lineItems = await stripe.checkout.sessions.listLineItems(sessionId, {
      limit: 1,
      expand: ["data.price"],
    });

    const plan = session?.metadata?.plan || null;

    const sub = session.subscription;
    const subscriptionId = typeof sub === "string" ? sub : sub?.id || null;
    const subscriptionStatus =
      typeof sub === "object" ? sub?.status : null;

    const email =
      session.customer_details?.email ||
      session.customer_email ||
      null;

    const line = lineItems.data?.[0];
    const price = line?.price;

    let priceText = null;
    if (price?.unit_amount != null) {
      const amount = (price.unit_amount / 100).toFixed(0);
      const interval = price.recurring?.interval || "mo";
      priceText = `$${amount}/${interval}`;
    }

    return res.json({
      ok: true,
      plan,
      price: priceText,
      email,
      subscriptionId,
      subscriptionStatus,
    });
  } catch (e) {
    console.error("GET /billing/session error:", e);
    return res.status(500).json({ error: "Failed to retrieve session" });
  }
});

module.exports = router;
