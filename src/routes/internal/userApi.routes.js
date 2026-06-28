"use strict";

const express = require("express");
const crypto = require("crypto");
const { pool } = require("../../db/pool");

const router = express.Router();

function requireLogin(req, res) {
  if (!req.session?.userId) {
    res.status(401).json({ error: "Not logged in" });
    return false;
  }
  return true;
}

function maskKey(key) {
  if (!key) return "—";
  const s = String(key);
  if (s.length <= 8) return "••••••••";
  return `${s.slice(0, 4)}••••••••••••${s.slice(-4)}`;
}

function generateApiKey() {
  return crypto.randomBytes(24).toString("hex");
}

// helper: get company id from logged in user
async function getCompanyId(userId) {
  const { rows } = await pool.query(
    `
    SELECT default_company_id
    FROM public.users
    WHERE id = $1
    `,
    [userId]
  );

  return rows?.[0]?.default_company_id || null;
}


/* =========================================================
   API KEY
========================================================= */

// GET /api/user/api
router.get("/user/api", async (req, res) => {
  if (!requireLogin(req, res)) return;

  try {
    const userId = req.session.userId;
    const companyId = await getCompanyId(userId);

    if (!companyId) {
      return res.json({ has_key: false, masked_key: null });
    }

    const result = await pool.query(
      `
      SELECT api_key
      FROM public.companies
      WHERE id = $1
      `,
      [companyId]
    );

    const apiKey = result.rows?.[0]?.api_key || null;

    return res.json({
      has_key: !!apiKey,
      masked_key: maskKey(apiKey),
    });

  } catch (err) {
    console.error("Error in GET /api/user/api:", err);
    return res.status(500).json({ error: "Server error" });
  }
});


// POST /api/user/api/rotate
router.post("/user/api/rotate", async (req, res) => {
  if (!requireLogin(req, res)) return;

  try {
    const userId = req.session.userId;
    const companyId = await getCompanyId(userId);

    if (!companyId) {
      return res.status(400).json({ error: "No company found" });
    }

    const newKey = generateApiKey();

    const result = await pool.query(
      `
      UPDATE public.companies
      SET api_key = $1
      WHERE id = $2
      RETURNING api_key
      `,
      [newKey, companyId]
    );

    const saved = result.rows?.[0]?.api_key || null;

    return res.json({
      masked_key: maskKey(saved),
      full_key: saved, // return once so UI can copy
    });

  } catch (err) {
    console.error("Error in POST /api/user/api/rotate:", err);
    return res.status(500).json({ error: "Server error" });
  }
});


/* =========================================================
   WEBHOOK
========================================================= */

// GET /api/user/webhook
router.get("/user/webhook", async (req, res) => {
  if (!requireLogin(req, res)) return;

  try {
    const companyId = await getCompanyId(req.session.userId);

    if (!companyId) {
      return res.json({ webhook_url: "" });
    }

    const { rows } = await pool.query(
      `
      SELECT webhook_url
      FROM public.companies
      WHERE id = $1
      `,
      [companyId]
    );

    res.json({ webhook_url: rows[0]?.webhook_url || "" });

  } catch (err) {
    console.error("Error in GET /api/user/webhook:", err);
    return res.status(500).json({ error: "Server error" });
  }
});


// POST /api/user/webhook
router.post("/user/webhook", async (req, res) => {
  if (!requireLogin(req, res)) return;

  try {
    const companyId = await getCompanyId(req.session.userId);

    if (!companyId) {
      return res.status(400).json({ error: "No company found" });
    }

    let url = String(req.body?.webhook_url || "").trim();

    // allow clearing
    if (!url) {
      await pool.query(
        `
        UPDATE public.companies
        SET webhook_url = NULL
        WHERE id = $1
        `,
        [companyId]
      );

      return res.json({ ok: true });
    }

    // normalize
    if (!/^https?:\/\//i.test(url)) {
      url = "https://" + url;
    }

    await pool.query(
      `
      UPDATE public.companies
      SET webhook_url = $1
      WHERE id = $2
      `,
      [url, companyId]
    );

    res.json({ ok: true, webhook_url: url });

  } catch (err) {
    console.error("Error in POST /api/user/webhook:", err);
    return res.status(500).json({ error: "Server error" });
  }
});


module.exports = router;
