"use strict";

const express = require("express");
const crypto = require("crypto");
const bcrypt = require("bcrypt");
const { pool } = require("../../db/pool");
const { requireAuth } = require("../../middleware/requireAuth");
const { loadCompanyContext } = require("../../middleware/companyContext");
const { sendTeamInviteEmail } = require("../../clients/mailgun");

const router = express.Router();

const INVITE_EXPIRES_HOURS = 72;

function requireCompanyAdmin(req, res) {
  const role = req.companyContext?.role;
  if (role !== "OWNER" && role !== "ADMIN") {
    res.status(403).json({ error: "Insufficient permissions" });
    return false;
  }
  return true;
}

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function makeToken() {
  // URL-safe token
  return crypto.randomBytes(24).toString("hex");
}

function baseUrl(req) {
  // Prefer explicit env in prod; fallback to request host
  return (
    process.env.APP_BASE_URL ||
    `${req.protocol}://${req.get("host")}`
  );
}

function inviteUrl(req, token) {
  return `${baseUrl(req)}/accept-invite/${token}`;
}

/**
 * GET /api/team
 * returns { members, invites }
 */
router.get("/team", requireAuth, loadCompanyContext, async (req, res) => {
  const companyId = req.companyContext?.companyId;
  if (!companyId) return res.status(400).json({ error: "No company context" });

  try {
    const membersQ = pool.query(
      `
      SELECT
        cm.id,
        cm.company_id,
        cm.user_id,
        cm.role,
        cm.status,
        cm.created_at,
        u.email,
        u.name
      FROM public.company_members cm
      JOIN public.users u
        ON u.id = cm.user_id
      WHERE cm.company_id = $1
      ORDER BY
        (cm.role = 'OWNER') DESC,
        (cm.role = 'ADMIN') DESC,
        cm.created_at ASC
      `,
      [companyId]
    );

    const invitesQ = pool.query(
      `
      SELECT
        id,
        company_id,
        invited_email,
        role,
        status,
        expires_at,
        created_at,
        accepted_at
      FROM public.company_invites
      WHERE company_id = $1
        AND status = 'PENDING'
      ORDER BY created_at DESC
      `,
      [companyId]
    );

    const [membersR, invitesR] = await Promise.all([membersQ, invitesQ]);

    return res.json({
      members: membersR.rows || [],
      invites: invitesR.rows || [],
    });
  } catch (err) {
    console.error("GET /api/team error:", err);
    return res.status(500).json({ error: "Failed to load team" });
  }
});

/**
 * POST /api/team/invites
 * body: { email, role }
 * creates invite token + sends email
 */
router.post("/team/invites", requireAuth, loadCompanyContext, async (req, res) => {
  const companyId = req.companyContext?.companyId;
  if (!companyId) return res.status(400).json({ error: "No company context" });
  if (!requireCompanyAdmin(req, res)) return;

  const invitedEmail = normalizeEmail(req.body?.email);
  const role = String(req.body?.role || "MEMBER").toUpperCase();

  if (!invitedEmail || !invitedEmail.includes("@")) {
    return res.status(400).json({ error: "Invalid email" });
  }
  if (role !== "ADMIN" && role !== "MEMBER") {
    return res.status(400).json({ error: "Invalid role" });
  }

  const token = makeToken();

  try {
    // Basic guard: don't invite someone already an ACTIVE member
    const exists = await pool.query(
      `
      SELECT 1
      FROM public.company_members cm
      JOIN public.users u ON u.id = cm.user_id
      WHERE cm.company_id = $1
        AND cm.status = 'ACTIVE'
        AND lower(u.email) = $2
      LIMIT 1
      `,
      [companyId, invitedEmail]
    );

    if (exists.rows.length) {
      return res.status(409).json({ error: "That user is already a teammate." });
    }

    const expiresAt = new Date(Date.now() + INVITE_EXPIRES_HOURS * 60 * 60 * 1000);

    // Pull inviter + company name for email
    const meta = await pool.query(
      `
      SELECT
        u.name AS inviter_name,
        u.email AS inviter_email,
        c.name AS company_name
      FROM public.users u
      JOIN public.companies c ON c.id = $1
      WHERE u.id = $2
      LIMIT 1
      `,
      [companyId, req.session.userId]
    );

    const inviterName = meta.rows?.[0]?.inviter_name || meta.rows?.[0]?.inviter_email || "A teammate";
    const companyName = meta.rows?.[0]?.company_name || "Carrier Shark";

    const ins = await pool.query(
      `
      INSERT INTO public.company_invites (
        company_id,
        invited_email,
        role,
        invited_by_user_id,
        token,
        status,
        expires_at
      )
      VALUES ($1, $2, $3, $4, $5, 'PENDING', $6)
      RETURNING id, token, invited_email, role, status, expires_at, created_at
      `,
      [companyId, invitedEmail, role, req.session.userId, token, expiresAt]
    );

    const url = inviteUrl(req, token);

    // Send email (Mailgun)
    await sendTeamInviteEmail({
      to: invitedEmail,
      inviter_name: inviterName,
      company_name: companyName,
      invite_url: url,
      expires_hours: INVITE_EXPIRES_HOURS,
    });

    return res.json({ ok: true, invite: ins.rows[0] });
  } catch (err) {
    console.error("POST /api/team/invites error:", err);
    return res.status(500).json({ error: "Failed to create invite" });
  }
});

/**
 * POST /api/team/invites/resend
 * body: { invite_id }
 */
router.post("/team/invites/resend", requireAuth, loadCompanyContext, async (req, res) => {
  const companyId = req.companyContext?.companyId;
  if (!companyId) return res.status(400).json({ error: "No company context" });
  if (!requireCompanyAdmin(req, res)) return;

  const inviteId = req.body?.invite_id;
  if (!inviteId) return res.status(400).json({ error: "Missing invite_id" });

  try {
    const { rows } = await pool.query(
      `
      SELECT
        i.id,
        i.company_id,
        i.invited_email,
        i.role,
        i.status,
        i.token,
        i.expires_at,
        c.name AS company_name,
        u.name AS inviter_name,
        u.email AS inviter_email
      FROM public.company_invites i
      JOIN public.companies c ON c.id = i.company_id
      JOIN public.users u ON u.id = i.invited_by_user_id
      WHERE i.id = $1
        AND i.company_id = $2
      LIMIT 1
      `,
      [inviteId, companyId]
    );

    if (!rows.length) return res.status(404).json({ error: "Invite not found" });

    const inv = rows[0];
    if (inv.status !== "PENDING") {
      return res.status(409).json({ error: "Invite is not pending" });
    }

    // If expired, rotate token + bump expiry
    const now = new Date();
    let token = inv.token;
    let expiresAt = inv.expires_at ? new Date(inv.expires_at) : null;

    if (!expiresAt || expiresAt <= now) {
      token = makeToken();
      expiresAt = new Date(Date.now() + INVITE_EXPIRES_HOURS * 60 * 60 * 1000);

      await pool.query(
        `
        UPDATE public.company_invites
        SET token = $1, expires_at = $2
        WHERE id = $3
        `,
        [token, expiresAt, inviteId]
      );
    }

    const inviterName = inv.inviter_name || inv.inviter_email || "A teammate";
    const companyName = inv.company_name || "Carrier Shark";

    await sendTeamInviteEmail({
      to: inv.invited_email,
      inviter_name: inviterName,
      company_name: companyName,
      invite_url: inviteUrl(req, token),
      expires_hours: INVITE_EXPIRES_HOURS,
    });

    return res.json({ ok: true });
  } catch (err) {
    console.error("POST /api/team/invites/resend error:", err);
    return res.status(500).json({ error: "Failed to resend invite" });
  }
});

/**
 * POST /api/team/invites/revoke
 * body: { invite_id }
 */
router.post("/team/invites/revoke", requireAuth, loadCompanyContext, async (req, res) => {
  const companyId = req.companyContext?.companyId;
  if (!companyId) return res.status(400).json({ error: "No company context" });
  if (!requireCompanyAdmin(req, res)) return;

  const inviteId = req.body?.invite_id;
  if (!inviteId) return res.status(400).json({ error: "Missing invite_id" });

  try {
    const result = await pool.query(
      `
      UPDATE public.company_invites
      SET status = 'REVOKED'
      WHERE id = $1
        AND company_id = $2
        AND status = 'PENDING'
      RETURNING id
      `,
      [inviteId, companyId]
    );

    if (!result.rows.length) {
      return res.status(404).json({ error: "Invite not found (or not pending)" });
    }

    return res.json({ ok: true });
  } catch (err) {
    console.error("POST /api/team/invites/revoke error:", err);
    return res.status(500).json({ error: "Failed to revoke invite" });
  }
});

/**
 * POST /api/team/members/disable
 * body: { member_id }
 * sets company_members.status = 'DISABLED'
 */
router.post("/team/members/disable", requireAuth, loadCompanyContext, async (req, res) => {
  const companyId = req.companyContext?.companyId;
  if (!companyId) return res.status(400).json({ error: "No company context" });
  if (!requireCompanyAdmin(req, res)) return;

  const memberId = req.body?.member_id;
  if (!memberId) return res.status(400).json({ error: "Missing member_id" });

  try {
    // Load member first to enforce rules
    const m = await pool.query(
      `
      SELECT id, user_id, role, status
      FROM public.company_members
      WHERE id = $1
        AND company_id = $2
      LIMIT 1
      `,
      [memberId, companyId]
    );

    if (!m.rows.length) return res.status(404).json({ error: "Member not found" });

    const member = m.rows[0];

    if (member.role === "OWNER") {
      return res.status(409).json({ error: "You cannot disable the OWNER." });
    }

    if (Number(member.user_id) === Number(req.session.userId)) {
      return res.status(409).json({ error: "You cannot disable yourself." });
    }

    await pool.query(
      `
      UPDATE public.company_members
      SET status = 'DISABLED'
      WHERE id = $1
        AND company_id = $2
      `,
      [memberId, companyId]
    );

    return res.json({ ok: true });
  } catch (err) {
    console.error("POST /api/team/members/disable error:", err);
    return res.status(500).json({ error: "Failed to disable member" });
  }
});

router.post("/team/invites/accept", requireAuth, async (req, res) => {
  const token = String(req.body?.token || "").trim();
  if (!token) return res.status(400).json({ error: "Missing token" });

  const userId = req.session.userId;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const invRes = await client.query(
      `
      SELECT
        i.id,
        i.company_id,
        i.role,
        i.status,
        i.expires_at,
        c.name AS company_name
      FROM public.company_invites i
      JOIN public.companies c ON c.id = i.company_id
      WHERE i.token = $1
      LIMIT 1
      FOR UPDATE
      `,
      [token]
    );

    if (invRes.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Invite not found" });
    }

    const inv = invRes.rows[0];

    if (inv.status !== "PENDING") {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "Invite is no longer pending" });
    }

    if (inv.expires_at && new Date(inv.expires_at) < new Date()) {
      await client.query("ROLLBACK");
      return res.status(410).json({ error: "Invite expired" });
    }

    // Create membership (idempotent)
    await client.query(
      `
      INSERT INTO public.company_members (company_id, user_id, role, status)
      VALUES ($1, $2, $3, 'ACTIVE')
      ON CONFLICT (company_id, user_id)
      DO UPDATE SET
        role = EXCLUDED.role,
        status = 'ACTIVE'
      `,
      [inv.company_id, userId, inv.role]
    );

    // Mark invite accepted
    await client.query(
      `
      UPDATE public.company_invites
      SET status = 'ACCEPTED', accepted_at = NOW()
      WHERE id = $1
      `,
      [inv.id]
    );

    // If user doesn't have a default company yet, set it
    await client.query(
      `
      UPDATE public.users
      SET default_company_id = COALESCE(default_company_id, $1)
      WHERE id = $2
      `,
      [inv.company_id, userId]
    );

    await client.query("COMMIT");

    return res.json({
      ok: true,
      company_id: inv.company_id,
      company_name: inv.company_name,
    });
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch {}
    console.error("POST /api/team/invites/accept error:", err);
    return res.status(500).json({ error: "Failed to accept invite" });
  } finally {
    client.release();
  }
});



router.post("/team/invites/accept-and-signup", async (req, res) => {
  const token = String(req.body?.token || "").trim();
  const name = String(req.body?.name || "").trim();
  const password = String(req.body?.password || "");
  const confirm = String(req.body?.confirm_password || "");

  if (!token) return res.status(400).json({ error: "Missing token" });

  // If user is not logged in, require signup fields
  const isLoggedIn = !!req.session?.userId;

  if (!isLoggedIn) {
    if (!name) return res.status(400).json({ error: "Name is required" });
    if (password.length < 8) return res.status(400).json({ error: "Password must be at least 8 characters" });
    if (password !== confirm) return res.status(400).json({ error: "Passwords do not match" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // lock invite row
    const invRes = await client.query(
      `
      SELECT
        i.id,
        i.company_id,
        i.invited_email,
        i.role,
        i.status,
        i.expires_at,
        c.name AS company_name
      FROM public.company_invites i
      JOIN public.companies c ON c.id = i.company_id
      WHERE i.token = $1
      LIMIT 1
      FOR UPDATE
      `,
      [token]
    );

    if (invRes.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Invite not found" });
    }

    const inv = invRes.rows[0];

    if (inv.status !== "PENDING") {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "Invite is no longer pending" });
    }

    if (inv.expires_at && new Date(inv.expires_at) < new Date()) {
      await client.query("ROLLBACK");
      return res.status(410).json({ error: "Invite expired" });
    }

    const invitedEmail = String(inv.invited_email || "").toLowerCase();

    let userId = req.session?.userId || null;

    // If not logged in, create/find user by invited email
    if (!userId) {
      const existing = await client.query(
        `SELECT id FROM public.users WHERE lower(email) = $1 LIMIT 1`,
        [invitedEmail]
      );

      if (existing.rowCount > 0) {
        // If they already have an account, we DON'T reset password here.
        // They should log in normally if they forgot it.
        await client.query("ROLLBACK");
        return res.status(409).json({
          error: "An account with this email already exists. Please log in to accept the invite."
        });
      }

      const passwordHash = await bcrypt.hash(password, 10);

      const created = await client.query(
        `
        INSERT INTO public.users (email, password_hash, name, email_verified_at)
        VALUES ($1, $2, $3, NOW())
        RETURNING id
        `,
        [invitedEmail, passwordHash, name]
      );

      userId = created.rows[0].id;
    } else {
      // logged in: optional safety check:
      // force that logged-in user matches invited email
      const me = await client.query(
        `SELECT email FROM public.users WHERE id = $1 LIMIT 1`,
        [userId]
      );
      const myEmail = String(me.rows?.[0]?.email || "").toLowerCase();
      if (myEmail && myEmail !== invitedEmail) {
        await client.query("ROLLBACK");
        return res.status(403).json({
          error: "This invite was sent to a different email. Log in with the invited email to accept."
        });
      }
    }

    // membership upsert
    await client.query(
      `
      INSERT INTO public.company_members (company_id, user_id, role, status)
      VALUES ($1, $2, $3, 'ACTIVE')
      ON CONFLICT (company_id, user_id)
      DO UPDATE SET
        role = EXCLUDED.role,
        status = 'ACTIVE'
      `,
      [inv.company_id, userId, inv.role]
    );

    // set default company if missing
    await client.query(
      `
      UPDATE public.users
      SET default_company_id = COALESCE(default_company_id, $1)
      WHERE id = $2
      `,
      [inv.company_id, userId]
    );

    // accept invite
    await client.query(
      `
      UPDATE public.company_invites
      SET status = 'ACCEPTED', accepted_at = NOW()
      WHERE id = $1
      `,
      [inv.id]
    );

    await client.query("COMMIT");

    // log them in if we created them
    req.session.userId = userId;

    return res.json({
      ok: true,
      company_name: inv.company_name,
      redirect: "/account?tab=team"
    });

  } catch (err) {
    try { await client.query("ROLLBACK"); } catch {}
    console.error("POST /api/team/invites/accept-and-signup error:", err);
    return res.status(500).json({ error: "Failed to accept invite" });
  } finally {
    client.release();
  }
});


// Public: used by /accept-invite/:token page to lock email + show company name
router.get("/team/invites/:token", async (req, res) => {
  const token = String(req.params.token || "").trim();
  if (!token) return res.status(400).json({ error: "Missing token" });

  try {
    const { rows } = await pool.query(
      `
      SELECT
        i.invited_email,
        i.role,
        i.status,
        i.expires_at,
        c.name AS company_name
      FROM public.company_invites i
      JOIN public.companies c ON c.id = i.company_id
      WHERE i.token = $1
      LIMIT 1
      `,
      [token]
    );

    if (!rows.length) return res.status(404).json({ error: "Invite not found" });

    const inv = rows[0];
    if (inv.status !== "PENDING") return res.status(409).json({ error: "Invite not pending" });
    if (inv.expires_at && new Date(inv.expires_at) < new Date()) {
      return res.status(410).json({ error: "Invite expired" });
    }

    return res.json({
      invited_email: inv.invited_email,
      company_name: inv.company_name,
      role: inv.role,
    });
  } catch (err) {
    console.error("GET /api/team/invites/:token error:", err);
    return res.status(500).json({ error: "Failed to load invite" });
  }
});

module.exports = router;
