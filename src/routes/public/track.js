// src/routes/public/track.js
"use strict";

const express = require("express");
const crypto = require("crypto");
const { pool } = require("../../db/pool");

const router = express.Router();

function hashIp(ip) {
  if (!ip) return null;
  return crypto.createHash("sha256").update(ip).digest("hex");
}

function getClientIp(req) {
  return (
    req.headers["cf-connecting-ip"] ||
    req.headers["x-forwarded-for"] ||
    req.socket?.remoteAddress ||
    ""
  )
    .toString()
    .split(",")[0]
    .trim();
}

async function insertPageview(req, path) {
  const user = req.user || req.session?.user || null;
  const userId = user?.id ?? null;

  const ip = getClientIp(req);
  const ua = (req.headers["user-agent"] || "").toString().slice(0, 300);
  const ipHash = hashIp(ip);
  const sessionId = req.sessionID || null;

  const dedupeMinutes = 10;

  await pool.query(
    `
    INSERT INTO public.page_view_events (user_id, path, session_id, ip_hash, user_agent)
    SELECT
      $1::int4,
      $2::text,
      $3::text,
      $4::text,
      $5::text
    WHERE NOT EXISTS (
      SELECT 1
      FROM public.page_view_events
      WHERE path = $2::text
        AND occurred_at > now() - ($6::text || ' minutes')::interval
        AND (
          ($1::int4 IS NOT NULL AND user_id = $1::int4)
          OR
          ($1::int4 IS NULL AND $3::text IS NOT NULL AND session_id = $3::text)
          OR
          ($1::int4 IS NULL AND $3::text IS NULL AND ip_hash = $4::text AND user_agent = $5::text)
        )
    )
    `,
    [userId, path, sessionId, ipHash, ua, dedupeMinutes]
  );
} // ✅ YOU WERE MISSING THIS

router.post("/pageview", async (req, res) => {
  try {
    const path = (req.body?.path || "/").toString().slice(0, 200);
    await insertPageview(req, path);
    res.json({ ok: true });
  } catch (e) {
    console.error("track pageview POST error:", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
