// src/routes/internal/publicCarriers.routes.js
"use strict";

const express = require("express");
const { pool } = require("../../db/pool");

const router = express.Router();

const DEFAULT_USER_ID = Number(process.env.DEFAULT_USER_ID); // system/demo user

router.get("/public-carriers", async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page || "1", 10));
  const pageSize = Math.min(250, Math.max(1, parseInt(req.query.pageSize || "25", 10)));
  const offset = (page - 1) * pageSize;

  const sortBy = (req.query.sortBy || "carrier").toLowerCase();
  const sortDir = (req.query.sortDir || "asc").toLowerCase() === "desc" ? "desc" : "asc";

  const SORT_MAP = {
    dot: "c.dotnumber",
    carrier: "coalesce(nullif(c.legalname,''), nullif(c.dbaname,''))",
    state: "c.phystate",
    city: "c.phycity",
    safety: "c.safetyrating",
    operating: "c.allowedtooperate",
  };

  const sortExpr = SORT_MAP[sortBy] || SORT_MAP.carrier;

  const totalResult = await pool.query(
    `select count(*)::int as total from user_carriers where user_id = $1`,
    [DEFAULT_USER_ID]
  );

  const listResult = await pool.query(
    `
    select
      c.dotnumber AS dot,
      c.primary_mc_number,
      c.mc_numbers,
      c.mc_count,
      COALESCE(c.primary_mc_number, NULLIF(c.mc_number::text,'')) AS mc_number,
      c.legalname,
      c.dbaname,
      c.phycity,
      c.phystate,
      c.allowedtooperate,
      c.commonauthoritystatus,
      c.contractauthoritystatus,
      c.brokerauthoritystatus,
      c.safetyrating
    from user_carriers uc
    join carriers c on c.dotnumber = uc.carrier_dot
    where uc.user_id = $1
    order by ${sortExpr} ${sortDir}
    limit $2 offset $3
    `,
    [DEFAULT_USER_ID, pageSize, offset]
  );

  return res.json({ rows: listResult.rows, total: totalResult.rows[0]?.total ?? 0 });
});

module.exports = router;
