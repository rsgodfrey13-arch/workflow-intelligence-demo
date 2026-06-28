"use strict";

const { pool } = require("../db/pool");

async function loadCompanyContext(req, res, next) {
  try {
    const userId = req.session?.userId;
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    const { rows } = await pool.query(
      `
      WITH picked AS (
        SELECT
          cm.company_id,
          cm.role,
          u.default_company_id,
          ROW_NUMBER() OVER (
            ORDER BY CASE WHEN cm.company_id = u.default_company_id THEN 0 ELSE 1 END,
                     cm.created_at ASC
          ) AS rn
        FROM users u
        JOIN company_members cm
          ON cm.user_id = u.id
         AND cm.status = 'ACTIVE'
        WHERE u.id = $1
      )
      SELECT p.company_id, p.role,
             owner.user_id AS owner_user_id
      FROM picked p
      LEFT JOIN company_members owner
        ON owner.company_id = p.company_id
       AND owner.role = 'OWNER'
       AND owner.status = 'ACTIVE'
      WHERE p.rn = 1
      LIMIT 1
      `,
      [userId]
    );

    if (!rows.length) {
      return res.status(403).json({ error: "No active company membership" });
    }

    req.companyContext = {
      companyId: rows[0].company_id,
      role: rows[0].role,
      ownerUserId: rows[0].owner_user_id,
    };

    return next();
  } catch (err) {
    console.error("loadCompanyContext error:", err);
    return res.status(500).json({ error: "Failed to load company context" });
  }
}

function requireCompanyOwner(req, res, next) {
  const role = req.companyContext?.role;
  if (role !== "OWNER") {
    return res.status(403).json({ error: "Owner access required" });
  }
  return next();
}

function requireCompanyAdmin(req, res, next) {
  const role = req.companyContext?.role;
  if (role !== "OWNER" && role !== "ADMIN") {
    return res.status(403).json({ error: "Insufficient permissions" });
  }
  return next();
}

module.exports = {
  loadCompanyContext,
  requireCompanyOwner,
  requireCompanyAdmin,
};
