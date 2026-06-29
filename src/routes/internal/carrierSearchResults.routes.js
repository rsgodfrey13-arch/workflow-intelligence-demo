"use strict";

const express = require("express");
const { pool } = require("../../db/pool");
const { searchLimiter } = require("../../middleware/rateLimit");

const router = express.Router();

// GET /api/search-carriers?q=...&page=1&pageSize=25&sortBy=carrier&sortDir=asc
router.get("/search-carriers", searchLimiter, async (req, res) => {
  const qRaw = String(req.query.q || "").trim();
  if (qRaw.length < 2) return res.json({ rows: [], total: 0 });

  const qNorm = qRaw.toLowerCase();
  const qDigits = qRaw.replace(/\D/g, "");
  const isNumericish = qDigits.length >= 2 && /^[\d\s\-().]+$/.test(qRaw);

  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const pageSize = Math.min(200, Math.max(1, parseInt(req.query.pageSize, 10) || 25));
  const offset = (page - 1) * pageSize;

  // whitelist sorting (never trust user input)
  const sortByRaw = String(req.query.sortBy || "carrier");
  const sortDirRaw = String(req.query.sortDir || "asc").toLowerCase() === "desc" ? "DESC" : "ASC";

  const SORTS = {
    dot: "dotnumber",
    mc: "primary_mc_number",
    carrier: "carrier_name_norm",
    location: "phycity, phystate",
    operating: "allowedtooperate",
    common: "commonauthoritystatus",
    contract: "contractauthoritystatus",
    broker: "brokerauthoritystatus",
    safety: "safetyrating",
  };

  const orderExpr = SORTS[sortByRaw] || SORTS.carrier;

  try {
    let whereSql = "";
    let params = [];

    if (isNumericish) {
  const prefix = `${qDigits}%`;

  whereSql = `WHERE dotnumber LIKE $1 OR primary_mc_number LIKE $1 OR mc_number LIKE $1`;
  params = [prefix];
} else {
      // name search: prefix first, then contains (carrier_name_norm already lower)
      const prefix = qNorm + "%";
      const contains = "%" + qNorm + "%";
      whereSql = `WHERE carrier_name_norm LIKE $1 OR carrier_name_norm LIKE $2`;
      params = [prefix, contains];
    }

    // total count
    const countResult = await pool.query(
      `
      SELECT COUNT(*)::int AS total
      FROM public.carriers
      ${whereSql};
      `,
      params
    );

    const total = countResult.rows?.[0]?.total ?? 0;
    if (total === 0) return res.json({ rows: [], total: 0 });

    // rows
    // NOTE: we keep a "rank" so results feel good for name searches (prefix first).
    let rowsResult;
    
    if (isNumericish) {
  const exact = qDigits;

  rowsResult = await pool.query(
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
      phystate,
      allowedtooperate,
      commonauthoritystatus,
      contractauthoritystatus,
      brokerauthoritystatus,
      safetyrating,
      carrier_name_norm,
      CASE
        WHEN dotnumber = $2 THEN 0
        WHEN primary_mc_number = $2 THEN 1
        WHEN mc_number = $2 THEN 2
        ELSE 3
      END AS rank
    FROM public.carriers
    WHERE dotnumber LIKE $1
       OR primary_mc_number LIKE $1
       OR mc_number LIKE $1
    ORDER BY rank ASC, ${orderExpr} ${sortDirRaw}
    LIMIT $3
    OFFSET $4;
    `,
    [params[0], exact, pageSize, offset]
  );
}
    else {
      rowsResult = await pool.query(
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
          phystate,
          allowedtooperate,
          commonauthoritystatus,
          contractauthoritystatus,
          brokerauthoritystatus,
          safetyrating,
          carrier_name_norm,
          CASE
            WHEN carrier_name_norm LIKE $1 THEN 0
            ELSE 1
          END AS rank
        FROM public.carriers
        WHERE carrier_name_norm LIKE $1
           OR carrier_name_norm LIKE $2
        ORDER BY rank ASC, ${orderExpr} ${sortDirRaw}
        LIMIT $3
        OFFSET $4;
        `,
        [params[0], params[1], pageSize, offset]
      );
    }


    return res.json({ rows: rowsResult.rows, total });
  } catch (err) {
    console.error("search-carriers error", err);
    return res.status(500).json({ error: "Search failed" });
  }
});

module.exports = router;
