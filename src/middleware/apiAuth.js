"use strict";

const { pool } = require("../db/pool");

async function apiAuth(req, res, next) {
  try {
    const auth = req.header("Authorization") || "";
    const token = auth.replace("Bearer ", "").trim();

    if (!token) {
      return res.status(401).json({ error: "Missing API token" });
    }

    // External API auth is company API-key based. We resolve the company once
    // here and attach a normalized auth context for downstream v1 handlers.
    const result = await pool.query(
      `
      SELECT c.id, c.plan
      FROM public.companies c
      WHERE c.api_key = $1
      LIMIT 1;
      `,
      [token]
    );

    if (result.rowCount === 0) {
      return res.status(401).json({ error: "Invalid API token" });
    }

    const company = result.rows[0];

    req.auth = {
      companyId: company.id,
      apiKeyType: "company",
      plan: company.plan || "FREE",
    };
    req.company = { id: company.id };

    next();
  } catch (err) {
    console.error("Error in apiAuth middleware:", err);
    res.status(500).json({ error: "Auth error" });
  }
}

module.exports = { apiAuth };
