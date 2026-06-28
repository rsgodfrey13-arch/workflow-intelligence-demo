"use strict";

const express = require("express");
const path = require("path");
const crypto = require("crypto");
const { pool } = require("../../db/pool");

const router = express.Router();

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

// PAGE: /verify-email  (shows “check your inbox / resend”)
router.get("/verify-email", (req, res) => {
  return res.sendFile(path.join(__dirname, "../../../static", "verify-email.html"));
});

// CLICKED LINK: /verify-email/:token  (verifies, then redirects)
router.get("/verify-email/:token", async (req, res) => {
  const token = String(req.params.token || "").trim();
  if (!token) return res.redirect(302, "/verify-email");

  const tokenHash = hashToken(token);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { rows } = await client.query(
      `
      SELECT id, user_id
      FROM public.email_verification_tokens
      WHERE token_hash = $1
        AND used_at IS NULL
        AND expires_at > now()
      LIMIT 1
      FOR UPDATE
      `,
      [tokenHash]
    );

    if (!rows.length) {
      await client.query("ROLLBACK");
      return res.redirect(302, "/verify-email?status=invalid");
    }

    const { id: token_id, user_id } = rows[0];

    await client.query(
      `UPDATE public.users SET email_verified_at = now() WHERE id = $1`,
      [user_id]
    );

    await client.query(
      `UPDATE public.email_verification_tokens SET used_at = now() WHERE id = $1`,
      [token_id]
    );

    await client.query("COMMIT");

    // optional: log them in after verifying
    req.session.userId = user_id;

    // send them to your plan page (adjust if yours is different)
    return res.redirect(302, "/verify-email?status=verified");
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch {}
    console.error("GET /verify-email/:token failed:", err?.message || err);
    return res.redirect(302, "/verify-email?status=error");
  } finally {
    client.release();
  }
});


module.exports = router;
