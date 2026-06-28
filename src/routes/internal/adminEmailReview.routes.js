"use strict";

const express = require("express");
const { requireAuth } = require("../../middleware/requireAuth");
const { loadCompanyContext, requireCompanyAdmin } = require("../../middleware/companyContext");
const { pool } = require("../../db/pool");

const router = express.Router();
const INBOX_ALLOWED_STATUSES = new Set([
  "NEW_EMAIL",
  "NEEDS_TYPE",
  "REVIEW",
  "ALLOWED",
  "OUTBOX_QUEUED",
  "CLOSED",
  "SENT",
  "FAILED",
  "NO_REPLY",
]);
const INBOX_FILTER_STATUSES = new Set(["OPEN_QUEUE", "ALL", ...INBOX_ALLOWED_STATUSES]);
const INBOX_ALLOWED_ACTIONS = new Set(["APPROVE", "CLOSE", "REPLY_AND_APPROVE", "REPLY_AND_CLOSE"]);

const OUTBOX_ALLOWED_STATUSES = new Set(["REVIEW", "READY_TO_SEND", "SENDING", "SENT", "CLOSED", "FAILED"]);
const OUTBOX_FILTER_STATUSES = new Set(["REVIEW_QUEUE", "ALL", ...OUTBOX_ALLOWED_STATUSES]);
const OUTBOX_ALLOWED_ACTIONS = new Set(["APPROVE", "CLOSE"]);

router.get("/admin/email-review", requireAuth, loadCompanyContext, requireCompanyAdmin, async (req, res) => {
  try {
    const requested = String(req.query.status || "OPEN_QUEUE").trim().toUpperCase();
    if (!INBOX_FILTER_STATUSES.has(requested)) return res.status(400).json({ ok: false, error: "Invalid status filter." });

    let where = "1=1";
    let params = [];
    if (requested === "OPEN_QUEUE") {
      where = "status IN ('NEW_EMAIL', 'NEEDS_TYPE', 'REVIEW')";
    } else if (requested === "CLOSED") {
      where = "status IN ('CLOSED', 'NO_REPLY')";
    } else if (requested !== "ALL") {
      where = "status = $1";
      params = [requested];
    }

    const { rows } = await pool.query(
      `SELECT id, message_id, recipient_email, sender_email, sender_domain, subject, in_reply_to, email_references,
              body_plain, body_html, stripped_text, stripped_html, attachment_count, status,
              email_type, suggested_reply, replacement_text, notes, created_at, updated_at
         FROM public.mailgun_inbox
        WHERE ${where}
        ORDER BY created_at DESC
        LIMIT 250`,
      params
    );

    return res.json({ ok: true, rows });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message || "Failed to load email review rows." });
  }
});

router.post("/admin/email-review/:id/update", requireAuth, loadCompanyContext, requireCompanyAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ ok: false, error: "Invalid id." });

    const updates = [];
    const values = [];
    const allowedFields = ["email_type", "suggested_reply", "replacement_text", "notes"];

    for (const field of allowedFields) {
      if (Object.prototype.hasOwnProperty.call(req.body || {}, field)) {
        updates.push(`${field} = $${values.length + 1}`);
        values.push(req.body[field] === "" ? null : req.body[field]);
      }
    }

    if (!updates.length) return res.status(400).json({ ok: false, error: "No updatable fields provided." });

    values.push(id);
    const result = await pool.query(
      `UPDATE public.mailgun_inbox
          SET ${updates.join(", ")}, updated_at = NOW()
        WHERE id = $${values.length}`,
      values
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ ok: false, error: "Email review row not found." });
    }

    return res.json({ ok: true });
  } catch (error) {
    return res.status(400).json({ ok: false, error: error.message || "Failed to update row." });
  }
});

router.post("/admin/email-review/:id/action", requireAuth, loadCompanyContext, requireCompanyAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ ok: false, error: "Invalid id." });

    const action = String(req.body?.action || "").trim().toUpperCase();
    if (!INBOX_ALLOWED_ACTIONS.has(action)) return res.status(400).json({ ok: false, error: "Invalid action." });

    const suggestedReply = req.body?.suggested_reply;
    const replacementText = req.body?.replacement_text;
    if (action === "REPLY_AND_APPROVE" || action === "REPLY_AND_CLOSE") {
      const replyText = String((replacementText || suggestedReply || "")).trim();
      if (!replyText) return res.status(400).json({ ok: false, error: "Reply text is required." });
    }

    const { rows } = await pool.query(
      `SELECT *
         FROM public.handle_mailgun_inbox_admin_action(
            p_mailgun_inbox_id := $1,
            p_action := $2,
            p_email_type := $3,
            p_suggested_reply := $4,
            p_replacement_text := $5,
            p_notes := $6
         )`,
      [id, action, req.body?.email_type || null, suggestedReply || null, replacementText || null, req.body?.notes || null]
    );

    return res.json({ ok: true, result: rows[0] || null });
  } catch (error) {
    return res.status(400).json({ ok: false, error: error.message || "Failed to apply action." });
  }
});

router.get("/admin/email-review/outbox", requireAuth, loadCompanyContext, requireCompanyAdmin, async (req, res) => {
  try {
    const requested = String(req.query.status || "REVIEW_QUEUE").trim().toUpperCase();
    if (!OUTBOX_FILTER_STATUSES.has(requested)) return res.status(400).json({ ok: false, error: "Invalid status filter." });

    let where = "1=1";
    let params = [];
    if (requested === "REVIEW_QUEUE") {
      where = "status = 'REVIEW'";
    } else if (requested !== "ALL") {
      where = "status = $1";
      params = [requested];
    }

    const { rows } = await pool.query(
      `SELECT id, source_type, source_id, mailgun_inbox_id, conversation_state_id,
              from_email, from_name, to_email, reply_to_email, subject,
              body_text, body_html, in_reply_to, email_references, status,
              post_send_action, outbound_mailgun_message_id, error_message,
              created_at, updated_at, sent_at
         FROM public.email_outbox
        WHERE ${where}
        ORDER BY created_at DESC
        LIMIT 250`,
      params
    );

    return res.json({ ok: true, rows });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message || "Failed to load outbox review rows." });
  }
});

router.post("/admin/email-review/outbox/:id/update", requireAuth, loadCompanyContext, requireCompanyAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ ok: false, error: "Invalid id." });

    const bodyTextProvided = Object.prototype.hasOwnProperty.call(req.body || {}, "body_text");
    const bodyHtmlProvided = Object.prototype.hasOwnProperty.call(req.body || {}, "body_html");
    if (!bodyTextProvided && !bodyHtmlProvided) {
      return res.status(400).json({ ok: false, error: "No updatable fields provided." });
    }

    const result = await pool.query(
      `UPDATE public.email_outbox
          SET body_text = COALESCE($1, body_text),
              body_html = COALESCE($2, body_html),
              updated_at = NOW()
        WHERE id = $3`,
      [bodyTextProvided ? req.body.body_text : null, bodyHtmlProvided ? req.body.body_html : null, id]
    );

    if (result.rowCount === 0) return res.status(404).json({ ok: false, error: "Outbox review row not found." });
    return res.json({ ok: true });
  } catch (error) {
    return res.status(400).json({ ok: false, error: error.message || "Failed to update outbox row." });
  }
});

router.post("/admin/email-review/outbox/:id/action", requireAuth, loadCompanyContext, requireCompanyAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ ok: false, error: "Invalid id." });

    const action = String(req.body?.action || "").trim().toUpperCase();
    if (!OUTBOX_ALLOWED_ACTIONS.has(action)) return res.status(400).json({ ok: false, error: "Invalid action." });

    const bodyTextProvided = Object.prototype.hasOwnProperty.call(req.body || {}, "body_text");
    const bodyHtmlProvided = Object.prototype.hasOwnProperty.call(req.body || {}, "body_html");
    const bodyText = bodyTextProvided ? req.body.body_text : null;
    const bodyHtml = bodyHtmlProvided ? req.body.body_html : null;

    const { rows: existingRows } = await pool.query("SELECT body_text FROM public.email_outbox WHERE id = $1", [id]);
    if (!existingRows.length) return res.status(404).json({ ok: false, error: "Outbox review row not found." });

    const effectiveBodyText = bodyTextProvided ? bodyText : existingRows[0].body_text;
    if (action === "APPROVE" && !String(effectiveBodyText || "").trim()) {
      return res.status(400).json({ ok: false, error: "Body text is required." });
    }

    const nextStatus = action === "APPROVE" ? "READY_TO_SEND" : "CLOSED";
    const clearErrorSql = action === "APPROVE" ? ", error_message = NULL" : "";

    const result = await pool.query(
      `UPDATE public.email_outbox
          SET body_text = CASE WHEN $1::boolean THEN $2 ELSE body_text END,
              body_html = CASE WHEN $3::boolean THEN $4 ELSE body_html END,
              status = $5,
              updated_at = NOW()
              ${clearErrorSql}
        WHERE id = $6`,
      [bodyTextProvided, bodyText, bodyHtmlProvided, bodyHtml, nextStatus, id]
    );

    if (result.rowCount === 0) return res.status(404).json({ ok: false, error: "Outbox review row not found." });
    return res.json({ ok: true });
  } catch (error) {
    return res.status(400).json({ ok: false, error: error.message || "Failed to apply outbox action." });
  }
});

module.exports = router;
