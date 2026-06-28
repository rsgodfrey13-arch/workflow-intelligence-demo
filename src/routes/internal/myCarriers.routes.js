"use strict";

const express = require("express");
const { pool } = require("../../db/pool");
const { requireAuth } = require("../../middleware/requireAuth");
const { loadCompanyContext } = require("../../middleware/companyContext");
const { screenCarrierForCompany } = require("../../services/carrierScreeningService");

const router = express.Router();

/** ---------- MY CARRIERS ROUTES ---------- **/

// Get list of carriers saved by this user (paginated + sortable)
router.get("/my-carriers", requireAuth, loadCompanyContext, async (req, res) => {
  try {
    const companyId = req.companyContext.companyId;

    const page = parseInt(req.query.page, 10) || 1;
    const pageSize = parseInt(req.query.pageSize, 10) || 25;
    const offset = (page - 1) * pageSize;

    const sortBy = req.query.sortBy || null;
    const sortDir =
      (req.query.sortDir || "asc").toLowerCase() === "desc" ? "DESC" : "ASC";

    const sortMap = {
      dot: "c.dotnumber",
      mc: "c.primary_mc_number",
      carrier: "COALESCE(c.legalname, c.dbaname)",
      location: "COALESCE(c.phycity,'') || ', ' || COALESCE(c.phystate,'')",
      operating: "c.allowedtooperate",
      common: "c.commonauthoritystatus",
      contract: "c.contractauthoritystatus",
      broker: "c.brokerauthoritystatus",
      safety: "c.safetyrating"
    };

    const orderColumn = sortMap[sortBy] || "uc.added_at";

    const dataSql = `
      SELECT
        c.dotnumber AS dot,
        c.*,
        COALESCE(c.primary_mc_number, NULLIF(c.mc_number::text,'')) AS mc_number
      FROM user_carriers uc
      JOIN carriers c
        ON c.dotnumber = uc.carrier_dot
      WHERE uc.company_id = $1
      ORDER BY ${orderColumn} ${sortDir}
      LIMIT $2 OFFSET $3;
    `;

    const countSql = `
      SELECT COUNT(*)::int AS count
      FROM user_carriers
      WHERE company_id = $1;
    `;

    const [dataResult, countResult] = await Promise.all([
      pool.query(dataSql, [companyId, pageSize, offset]),
      pool.query(countSql, [companyId])
    ]);

    res.json({
      rows: dataResult.rows,
      total: countResult.rows[0].count,
      page,
      pageSize
    });
  } catch (err) {
    console.error("Error in GET /api/my-carriers:", err);
    res.status(500).json({ error: "Failed to load user carriers" });
  }
});

// Save a new carrier for this user (enforces carrier_limit)
router.post("/my-carriers", requireAuth, loadCompanyContext, async (req, res) => {
  const userId = req.session.userId;
  const companyId = req.companyContext.companyId;
  const dotRaw = req.body?.dot;

  const dot = String(dotRaw || "").replace(/\D/g, "");
  if (!dot) {
    return res.status(400).json({ ok: false, error: "Carrier DOT required" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // 1) Lock the company row so limit checks are race-safe
    const u = await client.query(
      `SELECT carrier_limit
       FROM companies
       WHERE id = $1
       FOR UPDATE`,
      [companyId]
    );

    if (!u.rows.length) {
      await client.query("ROLLBACK");
      return res.status(401).json({ ok: false, error: "Unauthorized" });
    }

    const limit = Number(u.rows[0].carrier_limit || 0);

    // 2) Current count (FOR UPDATE here is optional; user row lock is enough)
    const c = await client.query(
      `SELECT COUNT(*)::int AS carrier_count
       FROM user_carriers
       WHERE company_id = $1`,
      [companyId]
    );

    const count = c.rows[0].carrier_count;

    // Treat NULL limit as "unlimited" (you can change this behavior)

    // 3) If already added, return success (do not count against limit)
    const exists = await client.query(
      `SELECT 1
       FROM user_carriers
       WHERE company_id = $1 AND carrier_dot = $2
       LIMIT 1`,
      [companyId, dot]
    );

    if (exists.rows.length) {
      await client.query("COMMIT");
      return res.json({ ok: true, already: true, carrier_count: count, carrier_limit: limit });
    }

    // 4) Enforce limit BEFORE insert
    if (count >= limit) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        ok: false,
        code: "CARRIER_LIMIT",
        carrier_limit: Number(limit),
        carrier_count: count
      });
    }

    // 5) Insert
    await client.query(
      `INSERT INTO user_carriers (company_id, user_id, carrier_dot)
       VALUES ($1, $2, $3)`,
      [companyId, userId, dot]
    );

    await client.query("COMMIT");
    try {
      await screenCarrierForCompany({ companyId, dotNumber: dot });
    } catch (screenErr) {
      console.error("Post-save screening failed:", screenErr);
    }
    return res.json({
      ok: true,
      added: true,
      carrier_count: count + 1,
      carrier_limit: limit
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Error in POST /api/my-carriers:", err);
    return res.status(500).json({ ok: false, error: "Failed to add carrier" });
  } finally {
    client.release();
  }
});


// Get ALL saved DOTs for this user (no join, no pagination) - used by UI to mark "My Carrier"
router.get("/my-carriers/dots", requireAuth, loadCompanyContext, async (req, res) => {
  try {
    const companyId = req.companyContext.companyId;

    const result = await pool.query(
      `SELECT carrier_dot
       FROM user_carriers
       WHERE company_id = $1;`,
      [companyId]
    );

    // return array of strings
    res.json(result.rows.map(r => String(r.carrier_dot)));
  } catch (err) {
    console.error("Error in GET /api/my-carriers/dots:", err);
    res.status(500).json({ error: "Failed to load carrier dots" });
  }
});


router.post("/my-carriers/bulk", requireAuth, loadCompanyContext, async (req, res) => {
  const userId = req.session.userId;
  const companyId = req.companyContext.companyId;
  const client = await pool.connect();

  try {
    let { dots } = req.body || {};

    if (!Array.isArray(dots) || dots.length === 0) {
      return res.status(400).json({ ok: false, error: "dots array required" });
    }

    const uniqueDots = [...new Set(
      dots
        .map((d) => String(d).trim())
        .filter((d) => d && /^\d+$/.test(d))
    )];

    if (uniqueDots.length === 0) {
      return res.status(400).json({ ok: false, error: "No valid DOT numbers found" });
    }

    await client.query("BEGIN");

    // 1) Lock user row + get limit (NULL => 0)
    const u = await client.query(
      `SELECT COALESCE(carrier_limit, 0)::int AS carrier_limit
       FROM companies
       WHERE id = $1
       FOR UPDATE`,
      [companyId]
    );

    if (!u.rows.length) {
      await client.query("ROLLBACK");
      return res.status(401).json({ ok: false, error: "Unauthorized" });
    }

    const carrierLimit = Number(u.rows[0].carrier_limit || 0);

    // 2) Current count
    const c = await client.query(
      `SELECT COUNT(*)::int AS carrier_count
       FROM user_carriers
       WHERE company_id = $1`,
      [companyId]
    );

    const carrierCount = Number(c.rows[0].carrier_count || 0);

    const remaining = carrierLimit - carrierCount;

    // If they cannot add any more, return limit response (for your modal)
    if (remaining <= 0) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        ok: false,
        code: "CARRIER_LIMIT",
        carrier_limit: carrierLimit,
        carrier_count: carrierCount
      });
    }

    // 3) Insert up to remaining slots
    const sql = `
  WITH input(dot) AS (
    SELECT UNNEST($3::text[])
  ),
  valid AS (
    SELECT i.dot
    FROM input i
    JOIN carriers c ON c.dotnumber::text = i.dot
  ),
  already AS (
    SELECT v.dot
    FROM valid v
    JOIN user_carriers uc
      ON uc.company_id = $1 AND uc.carrier_dot = v.dot
  ),
  new_valid AS (
    SELECT v.dot
    FROM valid v
    LEFT JOIN already a ON a.dot = v.dot
    WHERE a.dot IS NULL
  ),
  slots AS (
    SELECT nv.dot
    FROM new_valid nv
    LIMIT $4
  ),
  ins AS (
    INSERT INTO user_carriers (company_id, user_id, carrier_dot, added_at)
    SELECT $1, $2, s.dot, NOW()
    FROM slots s
    ON CONFLICT (company_id, carrier_dot) DO NOTHING
    RETURNING carrier_dot
  )
  SELECT
    (SELECT COUNT(*) FROM input) AS submitted,
    (SELECT COUNT(*) FROM valid) AS valid,
    (SELECT COUNT(*) FROM already) AS duplicates,
    (SELECT COUNT(*) FROM ins) AS inserted,
    (SELECT COUNT(*) FROM input) - (SELECT COUNT(*) FROM valid) AS invalid,
    GREATEST((SELECT COUNT(*) FROM new_valid) - $4, 0) AS skipped_limit,
    (SELECT COALESCE(ARRAY_AGG(carrier_dot), ARRAY[]::text[]) FROM ins) AS inserted_dots;
`;

    const result = await client.query(sql, [companyId, userId, uniqueDots, remaining]);
    const s = result.rows[0];

    const insertedDots = s.inserted_dots || [];

    // 4) Refresh queue only for dots we actually inserted (and only if stale)
    if (insertedDots.length > 0) {
      await client.query(
        `
        INSERT INTO carrier_refresh_queue (
          dotnumber,
          requested_by,
          source,
          priority,
          status,
          created_at
        )
        SELECT
          c.dotnumber::text,
          $2,
          'IMPORT',
          80,
          'PENDING',
          NOW()
        FROM carriers c
        JOIN UNNEST($1::text[]) d(dot)
          ON c.dotnumber::text = d.dot
        WHERE c.updated_at IS NULL
           OR c.updated_at < NOW() - INTERVAL '72 hours'
        ON CONFLICT DO NOTHING;
        `,
        [insertedDots, userId]
      );
    }

    // 5) New count after insert (safe and simple)
    const newCount = carrierCount + Number(s.inserted || 0);
    const skipped = Number(s.skipped_limit || 0);
const note =
  skipped > 0
    ? `Added ${Number(s.inserted)}. Skipped ${skipped} due to your plan limit.`
    : `Added ${Number(s.inserted)} carriers.`;

    await client.query("COMMIT");

    for (const dot of insertedDots) {
      try {
        await screenCarrierForCompany({ companyId, dotNumber: dot });
      } catch (screenErr) {
        console.error(`Bulk post-save screening failed for DOT ${dot}:`, screenErr);
      }
    }

    return res.json({
      ok: true,
      carrier_limit: carrierLimit,
      carrier_count: newCount,
     inserted_dots: insertedDots,
     note, 
    summary: {
        totalSubmitted: Number(s.submitted),
        valid: Number(s.valid),
        inserted: Number(s.inserted),
        duplicates: Number(s.duplicates),
        invalid: Number(s.invalid),
        skipped_limit: Number(s.skipped_limit)
      }
    });

  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Error in POST /api/my-carriers/bulk:", err);
    return res.status(500).json({ ok: false, error: "Failed to bulk add carriers" });
  } finally {
    client.release();
  }
});


// Preview bulk import (no DB writes)
router.post("/my-carriers/bulk/preview", requireAuth, loadCompanyContext, async (req, res) => {
  try {
    const companyId = req.companyContext.companyId;
    let { dots } = req.body || {};

    if (!Array.isArray(dots) || dots.length === 0) {
      return res.status(400).json({ error: "dots array required" });
    }

    dots = dots
      .map((d) => String(d).trim())
      .filter((d) => d && /^\d+$/.test(d));

    const uniqueDots = [...new Set(dots)];

    if (uniqueDots.length === 0) {
      return res.status(400).json({ error: "No valid DOT numbers found" });
    }

    const carriersRes = await pool.query(
      `
      SELECT dotnumber,
             COALESCE(legalname, dbaname) AS name,
             phycity,
             phystate
      FROM carriers
      WHERE dotnumber = ANY($1::text[]);
      `,
      [uniqueDots]
    );

    const carriersMap = new Map();
    carriersRes.rows.forEach((r) => {
      carriersMap.set(r.dotnumber, {
        dot: r.dotnumber,
        name: r.name,
        city: r.phycity,
        state: r.phystate
      });
    });

    const userRes = await pool.query(
      `
      SELECT carrier_dot
      FROM user_carriers
      WHERE company_id = $1
        AND carrier_dot = ANY($2::text[]);
      `,
      [companyId, uniqueDots]
    );

    const userSet = new Set(userRes.rows.map((r) => r.carrier_dot));

    const newList = [];
    const duplicates = [];
    const invalid = [];

    for (const dot of uniqueDots) {
      const carrier = carriersMap.get(dot);

      if (!carrier) {
        invalid.push({
          dot,
          status: "invalid",
          name: null,
          city: null,
          state: null
        });
      } else if (userSet.has(dot)) {
        duplicates.push({
          ...carrier,
          status: "duplicate"
        });
      } else {
        newList.push({
          ...carrier,
          status: "new"
        });
      }
    }

    res.json({
      summary: {
        totalSubmitted: uniqueDots.length,
        new: newList.length,
        duplicates: duplicates.length,
        invalid: invalid.length
      },
      new: newList,
      duplicates,
      invalid
    });
  } catch (err) {
    console.error("Error in POST /api/my-carriers/bulk/preview:", err);
    res.status(500).json({ error: "Failed to preview bulk import" });
  }
});

// Check if THIS dot is already saved for this user

router.get("/my-carriers/:dot", requireAuth, loadCompanyContext, async (req, res) => {
  const companyId = req.companyContext.companyId;
  const { dot } = req.params;

  try {
    const result = await pool.query(
      "SELECT 1 FROM user_carriers WHERE company_id = $1 AND carrier_dot = $2",
      [companyId, dot]
    );

    if (result.rowCount > 0) {
      return res.json({ saved: true });
    } else {
      return res.status(404).json({ saved: false });
    }
  } catch (err) {
    console.error("Error in GET /api/my-carriers/:dot:", err);
    return res.status(500).json({ error: "Failed to check carrier" });
  }
});



// Get email alert settings for THIS carrier
router.get("/my-carriers/:dot/alerts/email", requireAuth, loadCompanyContext, async (req, res) => {
  const companyId = req.companyContext.companyId;
  const { dot } = req.params;

  try {
    // 1) Ensure carrier is saved (optional but cleaner UX)
    const uc = await pool.query(
      `
      SELECT email_alerts
      FROM user_carriers
      WHERE company_id = $1 AND carrier_dot = $2
      `,
      [companyId, dot]
    );

    if (uc.rowCount === 0) {
      return res.status(404).json({ error: "Carrier not saved" });
    }

    const enabled = String(uc.rows[0].email_alerts || "N").toUpperCase() === "Y";

    // 2) Default email (for now: user email)
    const userRes = await pool.query(
      `SELECT email FROM users WHERE id = $1`,
      [req.session.userId]
    );

    const defaultEmail = userRes.rows[0]?.email || null;

    // 3) Extra recipients for this carrier
    const recips = await pool.query(
      `
      SELECT email
      FROM user_carrier_alert_recipients
      WHERE company_id = $1 AND carrier_dot = $2
      ORDER BY email
      `,
      [companyId, dot]
    );

    return res.json({
      enabled,
      defaultEmail,
      recipients: recips.rows.map(r => r.email)
    });
  } catch (err) {
    console.error("Error in GET /api/my-carriers/:dot/alerts/email:", err);
    return res.status(500).json({ error: "Failed to load email alert settings" });
  }
});


// Save email alert settings for THIS carrier (toggle + recipients list)
router.put("/my-carriers/:dot/alerts/email", requireAuth, loadCompanyContext, async (req, res) => {
  const companyId = req.companyContext.companyId;
  const { dot } = req.params;

  try {
    const enabled = !!req.body?.enabled;
    let recipients = Array.isArray(req.body?.recipients) ? req.body.recipients : [];

    // normalize + validate emails
    recipients = [...new Set(
      recipients
        .map(e => String(e || "").trim().toLowerCase())
        .filter(Boolean)
    )];

    // basic email sanity check (keep simple)
    const bad = recipients.find(e => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e));
    if (bad) {
      return res.status(400).json({ error: `Invalid email: ${bad}` });
    }

    // must exist in user_carriers
    const exists = await pool.query(
      `SELECT 1 FROM user_carriers WHERE company_id = $1 AND carrier_dot = $2`,
      [companyId, dot]
    );

    if (exists.rowCount === 0) {
      return res.status(404).json({ error: "Carrier not saved" });
    }

    // transaction: update toggle + replace recipients
    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      await client.query(
        `
        UPDATE user_carriers
        SET email_alerts = $3
        WHERE company_id = $1 AND carrier_dot = $2
        `,
        [companyId, dot, enabled ? "Y" : "N"]
      );

      await client.query(
        `
        DELETE FROM user_carrier_alert_recipients
        WHERE company_id = $1 AND carrier_dot = $2
        `,
        [companyId, dot]
      );

      if (recipients.length > 0) {
        await client.query(
          `
          INSERT INTO user_carrier_alert_recipients (company_id, carrier_dot, email)
          SELECT $1, $2, UNNEST($3::text[])
          `,
          [companyId, dot, recipients]
        );
      }

      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }

    return res.json({ ok: true });
  } catch (err) {
    console.error("Error in PUT /api/my-carriers/:dot/alerts/email:", err);
    return res.status(500).json({ error: "Failed to save email alert settings" });
  }
});


/* ---------------- reffresh queue route ---------------- */

// src/routes/api/refreshQueue.routes.js (example)


router.get("/refresh-queue/status", requireAuth, async (req, res) => {
  const userId = req.session.userId;

  const { rows } = await pool.query(
    `
    SELECT dotnumber, status
    FROM carrier_refresh_queue
    WHERE requested_by = $1
      AND status IN ('PENDING','RUNNING')
    `,
    [userId]
  );

  const pending = [];
  const running = [];
  for (const r of rows) {
    const dot = String(r.dotnumber || "").replace(/\D/g, "");
    if (!dot) continue;
    if (r.status === "PENDING") pending.push(dot);
    else if (r.status === "RUNNING") running.push(dot);
  }

  res.json({
    pending,
    running,
    counts: { pending: pending.length, running: running.length }
  });
});




// Remove a carrier from this user's list
router.delete("/my-carriers/:dot", requireAuth, loadCompanyContext, async (req, res) => {
  const companyId = req.companyContext.companyId;
  const dot = String(req.params.dot || "").replace(/\D/g, "");

  try {
    const result = await pool.query(
      "DELETE FROM user_carriers WHERE company_id = $1 AND carrier_dot = $2",
      [companyId, dot]
    );

    res.json({ ok: true, deleted: result.rowCount });
  } catch (err) {
    console.error("Error in DELETE /api/my-carriers/:dot:", err);
    res.status(500).json({ error: "Failed to remove carrier" });
  }
});

module.exports = router;
