"use strict";

const express = require("express");
const { pool } = require("../../db/pool");
const { searchLimiter } = require("../../middleware/rateLimit");

const router = express.Router();

// GET /api/carrier-search?q=...
router.get("/carrier-search", searchLimiter, async (req, res) => {
  const qRaw = String(req.query.q || "").trim();
  if (qRaw.length < 2) return res.json([]);

  const qNorm = qRaw.toLowerCase();
  const qDigits = qRaw.replace(/\D/g, "");
  const isNumericish = qDigits.length >= 2 && /^[\d\s\-().]+$/.test(qRaw);

  try {
    // Numeric-ish: DOT/MC prefix using text matching
    if (isNumericish) {
      const prefix = `${qDigits}%`;
      const exact = qDigits;

      const result = await pool.query(
        `
        SELECT
          dotnumber AS dot,
          primary_mc_number,
          mc_numbers,
          mc_count,
          COALESCE(primary_mc_number, NULLIF(mc_number::text,'')) AS mc_number,
          legalname,
          dbaname,
          phycity,
          phystate
        FROM public.carriers
        WHERE dotnumber LIKE $1
           OR primary_mc_number LIKE $1
           OR mc_number LIKE $1
        ORDER BY
          CASE
            WHEN dotnumber = $2 THEN 0
            WHEN primary_mc_number = $2 THEN 1
            WHEN mc_number = $2 THEN 2
            ELSE 3
          END,
          dotnumber
        LIMIT 10;
        `,
        [prefix, exact]
      );

      return res.json(result.rows);
    }

    // Name: prefix hits first, then contains/fuzzy fallback (trigram index)
    const prefix = qNorm + "%";
    const contains = "%" + qNorm + "%";

    const result = await pool.query(
      `
      SELECT
        dotnumber AS dot,
        primary_mc_number,
        mc_numbers,
        mc_count,
        COALESCE(primary_mc_number, NULLIF(mc_number::text,'')) AS mc_number,
        legalname,
        dbaname,
        phycity,
        phystate
      FROM public.carriers
      WHERE carrier_name_norm LIKE $1
         OR carrier_name_norm LIKE $2
      ORDER BY
        CASE
          WHEN carrier_name_norm LIKE $1 THEN 0
          ELSE 1
        END,
        carrier_name_norm
      LIMIT 10;
      `,
      [prefix, contains]
    );

    return res.json(result.rows);
  } catch (err) {
    console.error("carrier-search error", err);
    return res.status(500).json({ error: "Search failed" });
  }
});

module.exports = router;
