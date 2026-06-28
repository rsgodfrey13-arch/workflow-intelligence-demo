"use strict";

const express = require("express");
const router = express.Router();

// account snapshot data for Account page
router.get("/account/overview", async (req, res) => {
  if (!req.session?.userId) {
    return res.status(401).json({ error: "Not authenticated" });
  }

  const userId = req.session.userId;

  try {
    const { rows } = await req.db.query(
      `
      SELECT
        u.name,
        u.email,
        u.company,

        -- feature flags / entitlements (keep as-is if you still store on users)
        u.email_alerts,
        u.rest_alerts,
        u.webhook_alerts,

        -- ✅ chosen company context (what UI needs for tab access)
        chosen.company_id,
        chosen.company_role,

        -- billing/plan should be company-scoped in the new architecture.
        -- if you haven't moved these yet, this will still work once you do.
        c.plan,
        c.subscription_status,
        c.current_period_end,
        c.cancel_at_period_end,

        -- credits: company-scoped
        COALESCE(uc.credits_used, 0)::text AS credits_used,
        COALESCE(c.carrier_limit, u.carrier_limit)::text AS credits_limit

      FROM public.users u

      -- choose company safely:
      -- 1) default_company_id if it points to an ACTIVE membership
      -- 2) else first ACTIVE membership (prefer OWNER)
      LEFT JOIN LATERAL (
        SELECT
          COALESCE(
            (
              SELECT cm0.company_id
              FROM public.company_members cm0
              WHERE cm0.user_id = u.id
                AND cm0.status = 'ACTIVE'
                AND cm0.company_id = u.default_company_id
              LIMIT 1
            ),
            (
              SELECT cm1.company_id
              FROM public.company_members cm1
              WHERE cm1.user_id = u.id
                AND cm1.status = 'ACTIVE'
              ORDER BY (cm1.role = 'OWNER') DESC, cm1.created_at ASC
              LIMIT 1
            )
          ) AS company_id,
          (
            SELECT cm2.role
            FROM public.company_members cm2
            WHERE cm2.user_id = u.id
              AND cm2.status = 'ACTIVE'
              AND cm2.company_id = COALESCE(
                (
                  SELECT cm0.company_id
                  FROM public.company_members cm0
                  WHERE cm0.user_id = u.id
                    AND cm0.status = 'ACTIVE'
                    AND cm0.company_id = u.default_company_id
                  LIMIT 1
                ),
                (
                  SELECT cm1.company_id
                  FROM public.company_members cm1
                  WHERE cm1.user_id = u.id
                    AND cm1.status = 'ACTIVE'
                  ORDER BY (cm1.role = 'OWNER') DESC, cm1.created_at ASC
                  LIMIT 1
                )
              )
            LIMIT 1
          ) AS company_role
      ) chosen ON TRUE

      LEFT JOIN public.companies c
        ON c.id = chosen.company_id

      LEFT JOIN LATERAL (
        SELECT COUNT(DISTINCT carrier_dot)::bigint AS credits_used
        FROM public.user_carriers x
        WHERE chosen.company_id IS NOT NULL
          AND x.company_id = chosen.company_id
      ) uc ON TRUE

      WHERE u.id = $1
      LIMIT 1
      `,
      [userId]
    );

    if (!rows.length) return res.status(404).json({ error: "User not found" });

    return res.json(rows[0]);
  } catch (err) {
    console.error("GET /api/account/overview failed:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// Get Email Alert Fields
router.get("/account/email-alert-fields", async (req, res) => {
  if (!req.session?.userId) return res.status(401).json({ error: "unauthorized" });

  const userId = req.session.userId;

  const { rows } = await req.db.query(
    `
    SELECT
      u.field_key,
      u.enabled,
      COALESCE(u.label, af.label, u.field_key) AS label,
      COALESCE(u.category, af.category, 'Other') AS category
    FROM public.user_email_alert_fields u
    LEFT JOIN public.alert_fields af
      ON af.field_key = u.field_key
    WHERE u.user_id = $1
    ORDER BY af.sort_order
    `,
    [userId]
  );

  res.json({ fields: rows });
});

// Save Email Alert Fields
router.post("/account/email-alert-fields", async (req, res) => {
  if (!req.session?.userId) return res.status(401).json({ error: "unauthorized" });

  const userId = req.session.userId;
  const updates = Array.isArray(req.body?.updates) ? req.body.updates : [];

  for (const u of updates) {
    if (!u || typeof u.field_key !== "string" || typeof u.enabled !== "boolean") {
      return res.status(400).json({ error: "invalid payload" });
    }
  }

  if (!updates.length) return res.json({ ok: true, updated: 0 });

  const client = await req.db.connect();
  try {
    await client.query("BEGIN");

    for (const u of updates) {
      await client.query(
        `
        UPDATE public.user_email_alert_fields
        SET enabled = $3,
            updated_at = now()
        WHERE user_id = $1
          AND field_key = $2
        `,
        [userId, u.field_key, u.enabled]
      );
    }

    await client.query("COMMIT");
    res.json({ ok: true, updated: updates.length });
  } catch (e) {
    await client.query("ROLLBACK");
    console.error(e);
    res.status(500).json({ error: "server error" });
  } finally {
    client.release();
  }
});

// Get Email Alerts master switch (enabled/disabled)
router.get("/account/email-alerts-enabled", async (req, res) => {
  if (!req.session?.userId) {
    return res.status(401).json({ error: "Not authenticated" });
  }

  const userId = req.session.userId;

  try {
    const { rows } = await req.db.query(
      `SELECT COALESCE(email_alerts_enabled, true) AS email_alerts_enabled
       FROM users
       WHERE id = $1`,
      [userId]
    );

    if (!rows.length) return res.status(404).json({ error: "User not found" });

    return res.json({ email_alerts_enabled: rows[0].email_alerts_enabled });
  } catch (e) {
    console.error("email-alerts-enabled GET error", e);
    return res.status(500).json({ error: "Failed to load setting" });
  }
});

// Update Email Alerts master switch (enabled/disabled)
router.post("/account/email-alerts-enabled", async (req, res) => {
  if (!req.session?.userId) {
    return res.status(401).json({ error: "Not authenticated" });
  }

  const userId = req.session.userId;
  const enabled = !!req.body?.email_alerts_enabled;

  try {
    const { rows } = await req.db.query(
      `UPDATE users
       SET email_alerts_enabled = $1
       WHERE id = $2
       RETURNING COALESCE(email_alerts_enabled, true) AS email_alerts_enabled`,
      [enabled, userId]
    );

    if (!rows.length) return res.status(404).json({ error: "User not found" });

    return res.json({ email_alerts_enabled: rows[0].email_alerts_enabled });
  } catch (e) {
    console.error("email-alerts-enabled POST error", e);
    return res.status(500).json({ error: "Failed to update setting" });
  }
});


module.exports = router;
