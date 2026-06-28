"use strict";

const express = require("express");
const router = express.Router();

function genPublicId() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no I/O/0/1
  let s = "CS-";
  for (let i = 0; i < 8; i++) s += alphabet[Math.floor(Math.random() * alphabet.length)];
  return s;
}


// GET tickets for the logged-in user
router.get("/support/tickets", async (req, res) => {
  if (!req.session?.userId) {
    return res.status(401).json({ error: "Not authenticated" });
  }

  const userId = req.session.userId;

  try {
    const { rows } = await req.db.query(
      `
      SELECT id, public_id, subject, created_at, status
      FROM support_tickets
      WHERE user_id = $1
      ORDER BY created_at DESC
      LIMIT 25
      `,
      [userId]
    );

    res.json({ tickets: rows });
  } catch (e) {
    console.error("GET /support/tickets error:", e);
    res.status(500).json({ error: "Server error" });
  }
});

// POST create ticket (send email later / optional)
router.post("/support/tickets", async (req, res) => {
  if (!req.session?.userId) {
    return res.status(401).json({ error: "Not authenticated" });
  }

  const userId = req.session.userId;

  const contact_email = String(req.body?.contact_email || "").trim();
  const contact_phone = String(req.body?.contact_phone || "").trim();
  const subject = String(req.body?.subject || "").trim();
  const message = String(req.body?.message || "").trim();
  const { sendSupportTicketEmail } = require("../../clients/mailgun"); 
// adjust path if needed


  // validation...

  // NEW: generate a public id (retry if collision)
  let publicId = genPublicId();

  try {
    // Retry loop in case of UNIQUE collision (rare, but real)
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const { rows } = await req.db.query(
          `
          INSERT INTO support_tickets (user_id, public_id, contact_email, contact_phone, subject, message)
          VALUES ($1, $2, $3, $4, $5, $6)
          RETURNING id, public_id
          `,
          [userId, publicId, contact_email, contact_phone || null, subject, message]
        );


        await sendSupportTicketEmail({
          to: process.env.SUPPORT_INBOX,  // <— this is now centralized
          ticketId: rows[0].public_id,
          contactEmail: contact_email,
          contactPhone: contact_phone,
          subject,
          message,
          userEmail: req.session?.userEmail || null
        });
        
        return res.json({
          ticket_id: rows[0].id,
          public_id: rows[0].public_id,
        });


        
      } catch (e) {
        // unique violation
        if (e.code === "23505") {
          publicId = genPublicId();
          continue;
        }
        throw e;
      }
    }

    // If we somehow collide 5 times
    return res.status(500).json({ error: "Could not generate ticket reference." });
  } catch (e) {
    console.error("POST /support/tickets error:", e);
    return res.status(500).json({ error: "Server error" });
  }
});

// POST public contact (no auth required)
router.post("/public/contact", async (req, res) => {
  try {
    const name = String(req.body?.name || "").trim();
    const email = String(req.body?.email || "").trim();
    const company = String(req.body?.company || "").trim();
    const topic = String(req.body?.topic || "").trim();
    const subject = String(req.body?.subject || "").trim();
    const message = String(req.body?.message || "").trim();
    const phone = String(req.body?.phone || "").trim();

    // basic validation (keep it similar vibe to account)
    if (!email || !email.includes("@") || email.length < 6) {
      return res.status(400).json({ error: "Valid email required." });
    }
    if (!subject || subject.length < 3) {
      return res.status(400).json({ error: "Subject is required." });
    }
    if (!message || message.length < 10) {
      return res.status(400).json({ error: "Message is too short." });
    }

    const { sendPublicContactEmail } = require("../../clients/mailgun"); // same pattern as tickets :contentReference[oaicite:5]{index=5}

    const refId = genPublicId();

    await sendPublicContactEmail({
      to: process.env.SUPPORT_INBOX,
      refId,
      name,
      email,
      company: company || null,
      topic: topic || null,
      subject,
      message,
      phone: phone || null
    });

    return res.json({ ok: true, ref_id: refId });
  } catch (e) {
    console.error("POST /public/contact error:", e);
    return res.status(500).json({ error: "Server error" });
  }
});

module.exports = router;
