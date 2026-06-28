"use strict";

const Stripe = require("stripe");
const {
  sendPaidActivationEmail,
  sendPlanUpdatedEmail,
} = require("../../clients/mailgun");
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: "2024-06-20",
});

function normalizeStatus(s) {
  return String(s || "").toLowerCase();
}

function pickPriceIdFromSubscription(sub) {
  // Prefer first item’s price id (common case)
  const first = sub?.items?.data?.[0];
  const priceId =
    first?.price?.id ||
    first?.plan?.id || // older shapes
    null;

  return typeof priceId === "string" && priceId.length ? priceId : null;
}

function toPlanDisplayName(planCode) {
  const code = String(planCode || "").trim().toUpperCase();
  if (!code) return "";
  return code.charAt(0) + code.slice(1).toLowerCase();
}

function isPaidPlan(planCode) {
  const code = String(planCode || "").trim().toUpperCase();
  return !!code && code !== "STARTER";
}

function isActiveishStatus(status) {
  return status === "active" || status === "trialing";
}

async function getPlanCodeByPriceId(pool, priceId) {
  if (!priceId) return null;
  const { rows } = await pool.query(
    `
      SELECT plan_code
      FROM plans
      WHERE stripe_price_id = $1
        AND is_active = true
      LIMIT 1
    `,
    [priceId]
  );
  return rows[0]?.plan_code || null;
}

async function applyPlanToUserById(pool, userId, planCode, extra = {}) {
  // Pull canonical settings from plans, apply to users.
  // NOTE: we set BOTH legacy booleans and any “enabled” booleans you have.
  const {
    subscription_status = null,
    stripe_customer_id = null,
    stripe_subscription_id = null,
    current_period_end = null,
    cancel_at_period_end = null,
  } = extra;

  await pool.query(
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

      -- if you want "enabled" to follow plan as well:
      email_alerts_enabled = p.email_alerts,

      -- subscription fields (only update when values provided)
      subscription_status = COALESCE($3, u.subscription_status),
      stripe_customer_id = COALESCE($4, u.stripe_customer_id),
      stripe_subscription_id = COALESCE($5, u.stripe_subscription_id),
      current_period_end = COALESCE($6::timestamp, u.current_period_end),
      cancel_at_period_end = COALESCE($7, u.cancel_at_period_end)

    FROM plans p
    WHERE u.id = $1
      AND p.plan_code = $2
    `,
    [
      userId,
      planCode,
      subscription_status,
      stripe_customer_id,
      stripe_subscription_id,
      current_period_end,
      cancel_at_period_end,
    ]
  );
}

async function applyPlanToUserByCustomerId(pool, stripeCustomerId, planCode, extra = {}) {
  const {
    subscription_status = null,
    stripe_subscription_id = null,
    current_period_end = null,
    cancel_at_period_end = null,
  } = extra;

  await pool.query(
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
      stripe_subscription_id = COALESCE($4, u.stripe_subscription_id),
      current_period_end = COALESCE($5::timestamp, u.current_period_end),
      cancel_at_period_end = COALESCE($6, u.cancel_at_period_end)

    FROM plans p
    WHERE u.stripe_customer_id = $1
      AND p.plan_code = $2
    `,
    [
      stripeCustomerId,
      planCode,
      subscription_status,
      stripe_subscription_id,
      current_period_end,
      cancel_at_period_end,
    ]
  );
}

async function getWelcomeEmailContextByCustomerId(pool, stripeCustomerId, planCode) {
  const { rows } = await pool.query(
    `
    SELECT
      u.email,
      u.name AS user_name,
      c.name AS company_name,
      p.plan_code
    FROM users u
    LEFT JOIN companies c
      ON c.id = u.default_company_id
    LEFT JOIN plans p
      ON p.plan_code = $2
    WHERE u.stripe_customer_id = $1
    LIMIT 1
    `,
    [stripeCustomerId, planCode]
  );

  return rows[0] || null;
}

async function getWelcomeEmailContextByUserId(pool, userId, planCode) {
  const { rows } = await pool.query(
    `
    SELECT
      u.email,
      u.name AS user_name,
      c.name AS company_name,
      p.plan_code
    FROM users u
    LEFT JOIN companies c
      ON c.id = u.default_company_id
    LEFT JOIN plans p
      ON p.plan_code = $2
    WHERE u.id = $1
    LIMIT 1
    `,
    [userId, planCode]
  );

  return rows[0] || null;
}

function resolveBillingEmailTransition({
  previousPlan,
  previousStatus,
  nextPlan,
  nextStatus,
}) {
  const prevPlanCode = String(previousPlan || "").toUpperCase();
  const nextPlanCode = String(nextPlan || "").toUpperCase();
  const prevStatusNorm = normalizeStatus(previousStatus);
  const nextStatusNorm = normalizeStatus(nextStatus);

  const wasActive = isActiveishStatus(prevStatusNorm);
  const isActive = isActiveishStatus(nextStatusNorm);
  const wasPaid = isPaidPlan(prevPlanCode) && wasActive;
  const isPaid = isPaidPlan(nextPlanCode) && isActive;

  if (!isPaid) return { type: "none" };

  if (!wasPaid) {
    return { type: "paid_activation" };
  }

  if (prevPlanCode !== nextPlanCode) {
    return {
      type: "paid_plan_changed",
      previousPlanCode: prevPlanCode,
      nextPlanCode,
    };
  }

  return { type: "none" };
}

async function getCurrentUserBillingStateByCustomerId(pool, stripeCustomerId) {
  const { rows } = await pool.query(
    `
    SELECT plan, subscription_status
    FROM users
    WHERE stripe_customer_id = $1
    LIMIT 1
    `,
    [stripeCustomerId]
  );

  return rows[0] || null;
}

async function getCurrentUserBillingStateByUserId(pool, userId) {
  const { rows } = await pool.query(
    `
    SELECT plan, subscription_status
    FROM users
    WHERE id = $1
    LIMIT 1
    `,
    [userId]
  );

  return rows[0] || null;
}

async function maybeSendPaidActivationEmail(payload) {
  const { status } = payload || {};
  const isActive = isActiveishStatus(status);
  if (!isActive) return;

  try {
    console.log("[billing-email-debug] maybeSendPaidActivationEmail before Mailgun", {
      to: payload?.to,
      plan_name: payload?.plan_name,
      status: payload?.status,
    });
    await sendPaidActivationEmail(payload);
    console.log("[billing-email-debug] maybeSendPaidActivationEmail Mailgun send succeeded", {
      to: payload?.to,
      plan_name: payload?.plan_name,
    });
  } catch (e) {
    console.error(
      "[billing-email-debug] maybeSendPaidActivationEmail Mailgun send failed:",
      e?.message || e
    );
  }
}

async function maybeSendPlanUpdatedEmail(payload) {
  const { status } = payload || {};
  if (!isActiveishStatus(status)) return;

  try {
    console.log("[billing-email-debug] maybeSendPlanUpdatedEmail before Mailgun", {
      to: payload?.to,
      plan_name: payload?.plan_name,
      previous_plan_name: payload?.previous_plan_name,
      status: payload?.status,
    });
    await sendPlanUpdatedEmail(payload);
    console.log("[billing-email-debug] maybeSendPlanUpdatedEmail Mailgun send succeeded", {
      to: payload?.to,
      plan_name: payload?.plan_name,
      previous_plan_name: payload?.previous_plan_name,
    });
  } catch (e) {
    console.error(
      "[billing-email-debug] maybeSendPlanUpdatedEmail Mailgun send failed:",
      e?.message || e
    );
  }
}

module.exports = async function stripeWebhookHandler(req, res) {
  let event;

  try {
    const sig = req.headers["stripe-signature"];
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error("Stripe webhook signature verify failed:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    const { pool } = require("../../db/pool");

    // ===== CHECKOUT COMPLETED =====
    if (event.type === "checkout.session.completed") {
      const session = event.data.object;

      const userId = session.metadata?.userId;
      const planFromMeta = session.metadata?.plan; // optional fallback if you keep it
      if (!userId) {
        console.error("Missing userId in metadata");
        return res.json({ received: true });
      }

      const stripeCustomerId = session.customer;
      const stripeSubscriptionId = session.subscription;
      const beforeState = await getCurrentUserBillingStateByUserId(pool, userId);

      // Fetch subscription to get real status + period end + price id
      const subscription = await stripe.subscriptions.retrieve(stripeSubscriptionId);

      const status = normalizeStatus(subscription.status);
      const currentPeriodEnd = subscription.current_period_end
        ? new Date(subscription.current_period_end * 1000)
        : null;
      const cancelAtPeriodEnd = !!subscription.cancel_at_period_end;

      const priceId = pickPriceIdFromSubscription(subscription);
      const planByPrice = await getPlanCodeByPriceId(pool, priceId);

      // Prefer DB mapping; fall back to metadata; final fallback to STARTER
      const planCode = planByPrice || planFromMeta || "STARTER";

      await applyPlanToUserById(pool, userId, planCode, {
        subscription_status: status,
        stripe_customer_id: stripeCustomerId,
        stripe_subscription_id: stripeSubscriptionId,
        current_period_end: currentPeriodEnd,
        cancel_at_period_end: cancelAtPeriodEnd,
      });

      const transition = resolveBillingEmailTransition({
        previousPlan: beforeState?.plan,
        previousStatus: beforeState?.subscription_status,
        nextPlan: planCode,
        nextStatus: status,
      });

      console.log("[billing-email-debug] checkout.session.completed computed", {
        eventType: event.type,
        userId,
        stripeCustomerId,
        stripeSubscriptionId,
        planFromMeta,
        priceId,
        planCode,
        status,
        beforeState,
        transition,
      });

      if (transition.type === "paid_activation") {
        const user = await getWelcomeEmailContextByUserId(pool, userId, planCode);
        const baseUrl = process.env.PUBLIC_BASE_URL || process.env.APP_BASE_URL || "";
        console.log("[billing-email-debug] paid activation email branch entered", {
          email: user?.email || null,
          first_name: (user?.user_name || "").split(" ")[0] || "",
          company_name: user?.company_name || "",
          plan_name: toPlanDisplayName(user?.plan_code || planCode || ""),
          login_url: `${baseUrl}/account`,
        });
        if (user?.email) {
          await maybeSendPaidActivationEmail({
            to: user.email,
            bcc: "robert@carriershark.com",
            first_name: (user.user_name || "").split(" ")[0] || "",
            company_name: user.company_name || "",
            plan_name: toPlanDisplayName(user.plan_code || planCode || ""),
            login_url: `${baseUrl}/account`,
            status,
          });
        } else {
          console.log(
            "[billing-email-debug] paid activation email skipped because user email context was missing",
            { userContext: user }
          );
        }
      } else {
        console.log("[billing-email-debug] paid activation email skipped", {
          transition,
          previousPlan: beforeState?.plan || null,
          previousStatus: beforeState?.subscription_status || null,
          nextPlan: planCode,
          nextStatus: status,
        });
      }

      console.log("Checkout completed → applied plan:", { userId, planCode, status });
    }

    // ===== SUBSCRIPTION UPDATED =====
    if (event.type === "customer.subscription.updated") {
      const sub = event.data.object;

      const stripeCustomerId =
        typeof sub.customer === "string" ? sub.customer : sub.customer?.id;

      const status = normalizeStatus(sub.status);
      const cancelAtPeriodEnd = !!sub.cancel_at_period_end;

      const periodEndUnix =
        (typeof sub.current_period_end === "number" && sub.current_period_end) ||
        (Array.isArray(sub.items?.data)
          ? Math.max(
              ...sub.items.data
                .map((it) => it?.current_period_end)
                .filter((v) => typeof v === "number")
            )
          : null) ||
        null;

      const currentPeriodEnd = periodEndUnix ? new Date(periodEndUnix * 1000) : null;
      const beforeState = await getCurrentUserBillingStateByCustomerId(pool, stripeCustomerId);

      // If price changed (upgrade/downgrade), re-apply plan from DB mapping:
      const priceId = pickPriceIdFromSubscription(sub);
      const planByPrice = await getPlanCodeByPriceId(pool, priceId);
      const transition = resolveBillingEmailTransition({
        previousPlan: beforeState?.plan,
        previousStatus: beforeState?.subscription_status,
        nextPlan: planByPrice,
        nextStatus: status,
      });

      console.log("[billing-email-debug] customer.subscription.updated computed", {
        beforeState,
        planByPrice,
        status,
        transition,
      });

      // If we can resolve a plan, apply it (also updates status/period end).
      // If we cannot, just update subscription fields as you did before.
      if (planByPrice) {
        await applyPlanToUserByCustomerId(pool, stripeCustomerId, planByPrice, {
          subscription_status: status,
          stripe_subscription_id: sub.id,
          current_period_end: currentPeriodEnd,
          cancel_at_period_end: cancelAtPeriodEnd,
        });

        console.log("Subscription updated → applied plan:", {
          stripeCustomerId,
          planByPrice,
          status,
          cancelAtPeriodEnd,
          currentPeriodEnd,
        });

        console.log("[billing-email-debug] plan-updated email branch check", {
          entered: transition.type === "paid_plan_changed",
          transition,
        });
        if (transition.type === "paid_plan_changed") {
          const user = await getWelcomeEmailContextByCustomerId(
            pool,
            stripeCustomerId,
            planByPrice
          );
          const baseUrl = process.env.PUBLIC_BASE_URL || process.env.APP_BASE_URL || "";
          if (user?.email) {
            await maybeSendPlanUpdatedEmail({
              to: user.email,
              bcc: "robert@carriershark.com",
              first_name: (user.user_name || "").split(" ")[0] || "",
              company_name: user.company_name || "",
              plan_name: toPlanDisplayName(user.plan_code || planByPrice || ""),
              previous_plan_name: toPlanDisplayName(transition.previousPlanCode),
              login_url: `${baseUrl}/account`,
              status,
            });
          }
        }
      } else {
        // fallback: keep your existing update-only behavior
        await pool.query(
          `
          UPDATE users
          SET
            subscription_status = $1,
            current_period_end = $2::timestamp,
            cancel_at_period_end = $3,
            stripe_subscription_id = COALESCE(stripe_subscription_id, $4)
          WHERE stripe_customer_id = $5
          `,
          [status, currentPeriodEnd, cancelAtPeriodEnd, sub.id, stripeCustomerId]
        );

        console.log("Subscription updated (no plan mapping found):", {
          stripeCustomerId,
          status,
          cancelAtPeriodEnd,
          currentPeriodEnd,
        });
      }
    }

    // ===== SUBSCRIPTION CANCELED/DELETED =====
    if (event.type === "customer.subscription.deleted") {
      const subscription = event.data.object;
      const stripeCustomerId =
        typeof subscription.customer === "string"
          ? subscription.customer
          : subscription.customer?.id;

      // Revert to STARTER plan capabilities/limits via plans table,
      // and clear subscription fields.
      await applyPlanToUserByCustomerId(pool, stripeCustomerId, "STARTER", {
        subscription_status: "canceled",
        stripe_subscription_id: null,
        current_period_end: null,
        cancel_at_period_end: false,
      });

      // Also explicitly null subscription id (COALESCE would keep old otherwise)
      await pool.query(
        `
        UPDATE users
        SET
          stripe_subscription_id = NULL,
          current_period_end = NULL,
          cancel_at_period_end = false
        WHERE stripe_customer_id = $1
        `,
        [stripeCustomerId]
      );

      console.log("Subscription deleted → reverted to STARTER:", stripeCustomerId);
    }

    // ===== PAYMENT FAILED =====
    if (event.type === "invoice.payment_failed") {
      const invoice = event.data.object;
      const stripeCustomerId = invoice.customer;

      await pool.query(
        `
        UPDATE users
        SET subscription_status = 'past_due'
        WHERE stripe_customer_id = $1
        `,
        [stripeCustomerId]
      );

      console.log("Payment failed:", stripeCustomerId);
    }

    // ===== PAYMENT SUCCEEDED =====
    if (event.type === "invoice.payment_succeeded") {
      const invoice = event.data.object;
      const stripeCustomerId = invoice.customer;

      // safest: retrieve subscription and apply correct plan + status
      const subId =
        typeof invoice.subscription === "string"
          ? invoice.subscription
          : invoice.subscription?.id;

      if (subId) {
        const sub = await stripe.subscriptions.retrieve(subId);
        const status = normalizeStatus(sub.status);
        const currentPeriodEnd = sub.current_period_end
          ? new Date(sub.current_period_end * 1000)
          : null;
        const cancelAtPeriodEnd = !!sub.cancel_at_period_end;

        const priceId = pickPriceIdFromSubscription(sub);
        const planByPrice = await getPlanCodeByPriceId(pool, priceId);
        const planCode = planByPrice || "STARTER";

        await applyPlanToUserByCustomerId(pool, stripeCustomerId, planCode, {
          subscription_status: status,
          stripe_subscription_id: sub.id,
          current_period_end: currentPeriodEnd,
          cancel_at_period_end: cancelAtPeriodEnd,
        });

        console.log("Payment succeeded → applied plan/status:", {
          stripeCustomerId,
          planCode,
          status,
        });
      } else {
        // fallback to your prior behavior
        await pool.query(
          `
          UPDATE users
          SET subscription_status = 'active'
          WHERE stripe_customer_id = $1
          `,
          [stripeCustomerId]
        );
        console.log("Payment succeeded (no subscription id on invoice):", stripeCustomerId);
      }
    }

    return res.json({ received: true });
  } catch (err) {
    console.error("Stripe webhook handler error:", err);
    return res.status(500).send("Webhook handler failed");
  }
};
