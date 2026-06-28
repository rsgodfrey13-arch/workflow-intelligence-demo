"use strict";

const express = require("express");
const { pool } = require("../../db/pool");
const { spaces } = require("../../clients/spacesS3v2");
const crypto = require("crypto");
const router = express.Router();
const {
  sendContractOtpEmail,
  sendCarrierContractAcceptedEmail,
  sendBrokerContractAcceptedEmail,
} = require("../../clients/mailgun");


const OTP_EXPIRES_MIN = 5;
const MFA_VALID_MIN = 10;
const MAX_ATTEMPTS = 6;
const LOCK_MIN = 15;

function escapeHtmlServer(v) {
  return String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}


function generateOtp6() {
  const n = crypto.randomInt(0, 1000000);
  return String(n).padStart(6, "0");
}

function hashOtp({ otp, contractId }) {
  const secret = process.env.OTP_SECRET;
  if (!secret) throw new Error("Missing OTP_SECRET");
  return crypto.createHmac("sha256", secret).update(`${otp}|${contractId}`).digest("hex");
}

function maskEmail(email) {
  const [u, d] = String(email || "").split("@");
  if (!d) return "****";
  const um = u.length <= 2 ? `${u[0] || "*"}*` : `${u[0]}***${u[u.length - 1]}`;
  const d0 = d.split(".")[0] || "";
  const dm = d0.length <= 2 ? `${d0[0] || "*"}*` : `${d0[0]}***${d0[d0.length - 1]}`;
  return `${um}@${dm}.*`;
}

function normalizeRequiredFlag(v, defaultValue) {
  if (v === null || v === undefined) return defaultValue;
  return Boolean(v);
}

async function loadContractByToken(token) {
  const { rows } = await pool.query(
    `
    SELECT
      contract_id,
      company_id,
      dotnumber,
      token_expires_at,
      insurance_required,
      w9_required,
      ach_required
    FROM public.contracts
    WHERE token = $1
    LIMIT 1
    `,
    [token]
  );

  return rows[0] || null;
}

function validateUploadFile(file, { allowedMimes, maxSizeBytes }) {
  if (!file) return "Missing file";

  const mimeType = String(file.mimetype || "").toLowerCase().trim();
  if (!allowedMimes.includes(mimeType)) {
    return "Only PDF, PNG, JPG, JPEG, and WEBP files are allowed";
  }

  if (Number(file.size || 0) > maxSizeBytes) {
    return "File too large (10MB max)";
  }

  return null;
}

async function uploadFileToSpaces({ file, key, mimeType }) {
  await spaces
    .putObject({
      Bucket: process.env.SPACES_BUCKET,
      Key: key,
      Body: file.data,
      ContentType: mimeType,
      ACL: "private",
    })
    .promise();
}

function inferMimeType({ mimeType, storageKey }) {
  let resolved = String(mimeType || "").toLowerCase().trim();
  if (resolved) return resolved;

  const lowerKey = String(storageKey || "").toLowerCase();
  if (lowerKey.endsWith(".pdf")) return "application/pdf";
  if (lowerKey.endsWith(".png")) return "image/png";
  if (lowerKey.endsWith(".jpg") || lowerKey.endsWith(".jpeg")) return "image/jpeg";
  if (lowerKey.endsWith(".webp")) return "image/webp";
  return "application/octet-stream";
}

function sanitizeInlineFilename(name, fallback) {
  const filename = String(name || "").trim() || String(fallback || "").trim() || "document";
  return filename.replace(/"/g, "");
}

async function streamContractDocumentByToken({
  req,
  res,
  query,
  queryParams,
  notFoundMessage,
  missingStorageMessage,
  logLabel,
  fallbackFilename,
}) {
  const token = String(req.params.token || "").trim();
  if (!token) return res.status(400).send("Missing token");

  try {
    const { rows } = await pool.query(query, queryParams);
    if (rows.length === 0) return res.status(404).send(notFoundMessage);

    const row = rows[0];
    if (row.token_expires_at && new Date(row.token_expires_at) < new Date()) {
      return res.status(410).send("This link has expired");
    }

    if (!row.storage_key) return res.status(500).send(missingStorageMessage);

    const Bucket = process.env.SPACES_BUCKET;
    const Key = row.storage_key;
    const filename = sanitizeInlineFilename(row.original_filename, fallbackFilename || Key.split("/").pop());
    const mime = inferMimeType({ mimeType: row.mime_type, storageKey: Key });

    const obj = spaces.getObject({ Bucket, Key }).createReadStream();
    obj.on("error", (err) => {
      console.error(`SPACES getObject ${logLabel} error:`, err?.code, err?.message, err);
      if (err?.code === "NoSuchKey") {
        if (!res.headersSent) res.status(404).send(notFoundMessage);
        return;
      }
      if (!res.headersSent) res.status(500).send(`Failed to load ${logLabel} document`);
    });

    res.setHeader("Content-Type", mime);
    res.setHeader("Content-Disposition", `inline; filename="${filename}"`);
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    obj.pipe(res);
  } catch (err) {
    console.error(`GET /contract/:token/${logLabel} error:`, err?.message, err);
    return res.status(500).send("Server error");
  }
}

async function loadContractAcceptanceEmailLinks({ contractId, token }) {
  const baseUrl = process.env.APP_BASE_URL || "https://carriershark.com";
  const encodedToken = encodeURIComponent(String(token || "").trim());

  const [w9Res, insuranceRes, achRes, otherRes] = await Promise.all([
    pool.query(
      `
      SELECT id
      FROM public.contract_w9_documents
      WHERE contract_id::text = $1::text
      ORDER BY created_at DESC
      LIMIT 1
      `,
      [contractId]
    ),
    pool.query(
      `
      SELECT id
      FROM public.contract_insurance_documents
      WHERE contract_id::text = $1::text
      ORDER BY created_at DESC
      LIMIT 1
      `,
      [contractId]
    ),
    pool.query(
      `
      SELECT id
      FROM public.contract_ach_documents
      WHERE contract_id::text = $1::text
      ORDER BY created_at DESC
      LIMIT 1
      `,
      [contractId]
    ),
    pool.query(
      `
      SELECT id
      FROM public.contract_other_documents
      WHERE contract_id::text = $1::text
      ORDER BY created_at DESC
      LIMIT 1
      `,
      [contractId]
    ),
  ]);

  return {
    pdf_link: `${baseUrl}/contract/${encodedToken}/pdf`,
    cert_link: `${baseUrl}/contract/${encodedToken}/certificate`,
    w9_link: w9Res.rows[0] ? `${baseUrl}/contract/${encodedToken}/w9` : "",
    insurance_link: insuranceRes.rows[0] ? `${baseUrl}/contract/${encodedToken}/insurance` : "",
    ach_link: achRes.rows[0] ? `${baseUrl}/contract/${encodedToken}/ach` : "",
    has_other_documents: Boolean(otherRes.rows[0]),
  };
}

async function sendContractAcceptedEmails({
  token,
  contract_id,
  meta,
  accepted_name,
  accepted_title,
  accepted_email,
}) {
  const links = await loadContractAcceptanceEmailLinks({ contractId: contract_id, token });

  const toCarrier = [meta.email_to, accepted_email].filter(Boolean);
  const uniqueCarrier = [...new Set(toCarrier.map((x) => String(x).trim().toLowerCase()))];

  if (uniqueCarrier.length) {
    await sendCarrierContractAcceptedEmail({
      to: uniqueCarrier,
      broker_name: meta.broker_name || "Carrier Shark Customer",
      carrier_name: meta.carrier_name || "",
      dotnumber: meta.dotnumber ? String(meta.dotnumber) : "",
      agreement_type: meta.agreement_type || "Carrier Agreement",
      pdf_link: links.pdf_link,
      cert_link: links.cert_link,
    });
  }

  if (meta.broker_email) {
    await sendBrokerContractAcceptedEmail({
      to: String(meta.broker_email).trim().toLowerCase(),
      broker_name: meta.broker_name || "Carrier Shark Customer",
      carrier_name: meta.carrier_name || "",
      dotnumber: meta.dotnumber ? String(meta.dotnumber) : "",
      agreement_type: meta.agreement_type || "Carrier Agreement",
      accepted_name: accepted_name || "",
      accepted_title: accepted_title || "",
      accepted_email: accepted_email ? String(accepted_email).trim().toLowerCase() : "",
      pdf_link: links.pdf_link,
      cert_link: links.cert_link,
      w9_link: links.w9_link,
      insurance_link: links.insurance_link,
      ach_link: links.ach_link,
      has_other_documents: links.has_other_documents,
    });
  }
}



/** ---------- CONTRACT PDF (token-gated) ---------- **/
router.get("/contract/:token/pdf", async (req, res) => {
  const token = String(req.params.token || "").trim();
  if (!token) return res.status(400).send("Missing token");

  try {
    const sql = `
      SELECT
        c.contract_id,
        c.status,
        c.token_expires_at,
        uc.storage_provider,
        uc.storage_key,
        uc.name AS contract_name
      FROM public.contracts c
      JOIN public.user_contracts uc
        ON uc.id = c.user_contract_id
      WHERE c.token = $1
      LIMIT 1;
    `;

    const { rows } = await pool.query(sql, [token]);
    if (rows.length === 0) return res.status(404).send("Invalid link");

    const row = rows[0];

    if (row.token_expires_at && new Date(row.token_expires_at) < new Date()) {
      return res.status(410).send("This link has expired");
    }

    if (row.storage_provider !== "DO_SPACES") {
      return res.status(500).send("Storage provider not configured");
    }
    if (!row.storage_key) {
      return res.status(500).send("Missing storage key");
    }

    const Bucket = process.env.SPACES_BUCKET;
    const Key = row.storage_key;

    const obj = spaces.getObject({ Bucket, Key }).createReadStream();

    obj.on("error", (err) => {
      console.error("SPACES getObject error:", err?.code, err?.message, err);
      if (err?.code === "NoSuchKey") return res.status(404).send("PDF not found");
      return res.status(500).send("Failed to load PDF");
    });

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", "inline; filename=\"contract.pdf\"");
    res.setHeader("Cache-Control", "no-store");

    obj.pipe(res);
  } catch (err) {
    console.error("GET /contract/:token/pdf error:", err?.message, err);
    return res.status(500).send("Server error");
  }
});

router.get("/contract/:token/certificate", async (req, res) => {
  const token = String(req.params.token || "").trim();
  if (!token) return res.status(400).send("Missing token");

  try {
    const { rows } = await pool.query(
      `
      SELECT
        c.contract_id,
        c.status,
        c.dotnumber,
        c.email_to,
        c.sent_at,
        c.signed_at,
        c.token_expires_at,
        uc.name AS agreement_type,
        uc.display_name AS broker_name,
        ca.accepted_at,
        ca.accepted_name,
        ca.accepted_title,
        ca.accepted_email,
        ca.accepted_ip,
        ca.accepted_user_agent,
        ca.document_hash_sha256,
        ca.document_storage_key
      FROM public.contracts c
      JOIN public.user_contracts uc ON uc.id = c.user_contract_id
      LEFT JOIN public.contract_acceptances ca ON ca.contract_id = c.contract_id
      WHERE c.token = $1
      LIMIT 1;
      `,
      [token]
    );

    if (!rows.length) return res.status(404).send("Invalid link");

    const r = rows[0];
    if (r.token_expires_at && new Date(r.token_expires_at) < new Date()) {
      return res.status(410).send("This link has expired");
    }

    const accepted = (r.status === "SIGNED" || r.status === "ACKNOWLEDGED");
    const acceptedAt = r.accepted_at ? new Date(r.accepted_at).toISOString() : "";
    const signedAt = r.signed_at ? new Date(r.signed_at).toISOString() : "";

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");

    return res.send(`<!doctype html>
<html>
<head>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>Signature Certificate</title>
  <style>
    body{
      font-family: Inter, "Segoe UI", Arial, sans-serif;
      margin:0;
      padding:24px;
      color:#E5E7EB;
      background: radial-gradient(circle at 12% 0%, rgba(0,183,255,.18), transparent 42%), #020617;
    }
    .wrap{ max-width:900px; margin:0 auto; }
    .h{ font-size:24px; font-weight:800; margin-bottom:10px; letter-spacing:.01em; color:#F1F5F9; }
    .sub{ color:#cbd5e1; margin-bottom:18px; line-height:1.45; }
    .box{ border:1px solid rgba(56,189,248,.25); border-radius:14px; padding:16px; margin:12px 0; background:rgba(11,17,32,.82); box-shadow:0 12px 30px rgba(2,6,23,.35); }
    .row{ display:flex; gap:14px; flex-wrap:wrap; }
    .col{ flex:1; min-width:260px; }
    .k{ font-size:11px; text-transform:uppercase; letter-spacing:.1em; color:#94a3b8; }
    .v{ font-size:15px; margin-top:4px; word-break:break-word; color:#F1F5F9; }
    .badge{ display:inline-block; padding:6px 10px; border-radius:999px; background:rgba(11,120,207,.25); border:1px solid rgba(56,189,248,.45); color:#e0f2fe; font-weight:700; }
    .muted{ color:#94a3b8; font-size:13px; line-height:1.45; }
    .btn{ display:inline-block; margin-top:10px; padding:10px 12px; border-radius:10px; border:1px solid rgba(56,189,248,.45); text-decoration:none; color:#e0f2fe; font-weight:700; background:rgba(11,17,32,.88); }
    .btn:hover{ background:linear-gradient(135deg,#0B78CF,#00B7FF); color:#fff; border-color:transparent; }
    @media print { .noPrint{ display:none; } body{ margin:0.5in; background:#fff; color:#111; } .box{ border:1px solid #ddd; box-shadow:none; background:#fff; } }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="h">Signature Certificate</div>
    <div class="sub">
      This certificate records the electronic acceptance of an agreement delivered via Carrier Shark.
      ${accepted ? `<span class="badge">Accepted</span>` : `<span class="badge">Not yet accepted</span>`}
    </div>

    <div class="box">
      <div class="row">
        <div class="col">
          <div class="k">Agreement Type</div>
          <div class="v">${escapeHtmlServer(r.agreement_type || "Carrier Agreement")}</div>
        </div>
        <div class="col">
          <div class="k">Broker / Sender</div>
          <div class="v">${escapeHtmlServer(r.broker_name || "")}</div>
        </div>
      </div>
      <div class="row" style="margin-top:10px;">
        <div class="col">
          <div class="k">Carrier DOT</div>
          <div class="v">${escapeHtmlServer(String(r.dotnumber || ""))}</div>
        </div>
        <div class="col">
          <div class="k">Original Recipient Email</div>
          <div class="v">${escapeHtmlServer(String(r.email_to || ""))}</div>
        </div>
      </div>
    </div>

    <div class="box">
      <div class="row">
        <div class="col">
          <div class="k">Accepted Name</div>
          <div class="v">${escapeHtmlServer(r.accepted_name || "")}</div>
        </div>
        <div class="col">
          <div class="k">Accepted Title</div>
          <div class="v">${escapeHtmlServer(r.accepted_title || "")}</div>
        </div>
      </div>
      <div class="row" style="margin-top:10px;">
        <div class="col">
          <div class="k">Accepted Email</div>
          <div class="v">${escapeHtmlServer(r.accepted_email || "")}</div>
        </div>
        <div class="col">
          <div class="k">Accepted At (UTC)</div>
          <div class="v">${escapeHtmlServer(acceptedAt)}</div>
        </div>
      </div>
      <div class="row" style="margin-top:10px;">
        <div class="col">
          <div class="k">IP Address</div>
          <div class="v">${escapeHtmlServer(r.accepted_ip || "")}</div>
        </div>
        <div class="col">
          <div class="k">User Agent</div>
          <div class="v">${escapeHtmlServer(r.accepted_user_agent || "")}</div>
        </div>
      </div>
    </div>

    <div class="box">
      <div class="k">Document Hash (SHA-256)</div>
      <div class="v">${escapeHtmlServer(r.document_hash_sha256 || "")}</div>
      <div class="muted" style="margin-top:8px;">
        This hash identifies the exact PDF content that was accepted.
      </div>
    </div>

    <div class="box">
      <div class="muted">
        Carrier Shark provides technology for delivery and electronic acceptance and is not a party to the agreement.
        Parties are responsible for verifying identity and authority.
      </div>
    </div>

    <div class="noPrint">
      <a class="btn" href="/contract/${encodeURIComponent(token)}/pdf" target="_blank" rel="noopener">Open Contract PDF</a>
      <a class="btn" href="#" onclick="window.print(); return false;">Print / Save as PDF</a>
    </div>
  </div>

  <script>
    function escapeHtmlServer(str){
      return String(str||"")
        .replaceAll("&","&amp;")
        .replaceAll("<","&lt;")
        .replaceAll(">","&gt;")
        .replaceAll('"',"&quot;")
        .replaceAll("'","&#039;");
    }
  </script>
</body>
</html>`);
  } catch (err) {
    console.error("GET /contract/:token/certificate error:", err?.message, err);
    return res.status(500).send("Server error");
  }
});




/** ---------- CONTRACT LANDING PAGE (token + acceptance UI) ---------- **/
router.get("/contract/:token", async (req, res) => {
  const token = String(req.params.token || "").trim();
  if (!token) return res.status(400).send("Missing token");

  try {
    const { rows } = await pool.query(
      `
      SELECT
        contract_id,
        token_expires_at,
        status,
        insurance_required,
        w9_required,
        ach_required
      FROM public.contracts
      WHERE token = $1
      LIMIT 1;
      `,
      [token]
    );

    if (rows.length === 0) return res.status(404).send("Invalid link");

    const contract = rows[0];
    if (contract.token_expires_at && new Date(contract.token_expires_at) < new Date()) {
      return res.status(410).send("This link has expired");
    }

    await pool.query(
      `
      UPDATE public.contracts
      SET status = 'VIEWED', updated_at = NOW()
      WHERE token = $1 AND status NOT IN ('VIEWED','ACKNOWLEDGED','SIGNED');
      `,
      [token]
    );

    const pdfUrl = `/contract/${encodeURIComponent(token)}/pdf`;
    const alreadyAccepted = (contract.status === "SIGNED" || contract.status === "ACKNOWLEDGED");
    const requirements = {
      w9: normalizeRequiredFlag(contract.w9_required, true),
      insurance: normalizeRequiredFlag(contract.insurance_required, false),
      ach: normalizeRequiredFlag(contract.ach_required, false),
    };

    const [achDocRes, insDocRes, w9DocRes, otherDocRes] = await Promise.all([
      pool.query(
        `
        SELECT original_filename
        FROM public.contract_ach_documents
        WHERE contract_id::text = $1::text
        ORDER BY created_at DESC
        LIMIT 1
        `,
        [contract.contract_id]
      ),
      pool.query(
        `
        SELECT original_filename
        FROM public.contract_insurance_documents
        WHERE contract_id::text = $1::text
        ORDER BY created_at DESC
        LIMIT 1
        `,
        [contract.contract_id]
      ),
      pool.query(
        `
        SELECT original_filename
        FROM public.contract_w9_documents
        WHERE contract_id::text = $1::text
        ORDER BY created_at DESC
        LIMIT 1
        `,
        [contract.contract_id]
      ),
      pool.query(
        `
        SELECT original_filename
        FROM public.contract_other_documents
        WHERE contract_id::text = $1::text
        ORDER BY created_at DESC
        LIMIT 1
        `,
        [contract.contract_id]
      ),
    ]);

    const uploadState = {
      ach: { uploaded: Boolean(achDocRes.rows[0]), filename: achDocRes.rows[0]?.original_filename || null },
      insurance: { uploaded: Boolean(insDocRes.rows[0]), filename: insDocRes.rows[0]?.original_filename || null },
      w9: { uploaded: Boolean(w9DocRes.rows[0]), filename: w9DocRes.rows[0]?.original_filename || null },
      other: { uploaded: Boolean(otherDocRes.rows[0]), filename: otherDocRes.rows[0]?.original_filename || null },
    };

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.send(`<!doctype html>
<html>
<head>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Carrier Agreement</title>
  <style>
    body {
      margin:0;
      font-family: Inter, "Segoe UI", Arial, sans-serif;
      background:
        radial-gradient(circle at 0% 0%, rgba(0,183,255,.14), transparent 35%),
        radial-gradient(circle at 100% 12%, rgba(56,189,248,.08), transparent 32%),
        #020617;
      color:#e5e7eb;
    }
    .wrap { max-width: 980px; margin: 0 auto; padding: 20px; }
    .top { display:flex; align-items:center; justify-content:space-between; gap:12px; margin-bottom:12px; }
    .brand { font-weight:800; letter-spacing:0.2px; color:#f1f5f9; }
    .btn { display:inline-block; padding:10px 14px; border-radius:10px; background:linear-gradient(135deg,#0B78CF,#00B7FF); color:#fff; text-decoration:none; font-weight:700; border:0; box-shadow:0 10px 24px rgba(11,120,207,.35); }
    .card { background: rgba(11,17,32,0.82); border: 1px solid rgba(56,189,248,0.24); border-radius: 16px; padding: 12px; box-shadow:0 12px 30px rgba(2,6,23,.45); }
    iframe { width:100%; height: 70vh; border:0; border-radius: 12px; background:#fff; }
    .muted { opacity:0.95; color:#94a3b8; font-size: 13px; margin-top:10px; }
    .form { margin-top: 14px; display:grid; gap:10px; }
    .row { display:grid; grid-template-columns: 1fr 1fr; gap:10px; }
    .row > div { display:flex; flex-direction:column; gap:6px; }
    label { font-size: 13px; opacity:0.9; }
    input[type="text"], input[type="email"] {
      padding:10px 12px; border-radius:10px; border:1px solid rgba(56,189,248,.28);
      background: rgba(2,6,23,0.6); color:#f1f5f9; outline:none;
    }
    input[type="checkbox"] { transform: scale(1.2); }
    .checkline { display:flex; gap:10px; align-items:flex-start; }
    .submitline { display:flex; gap:10px; align-items:center; justify-content:space-between; flex-wrap:wrap; }
    .btn2 { padding:12px 16px; border-radius:10px; background:linear-gradient(135deg,#0B78CF,#00B7FF); color:#fff; border:0; font-weight:800; cursor:pointer; box-shadow:0 12px 26px rgba(11,120,207,.35); }
    .btn2[disabled] { opacity:0.6; cursor:not-allowed; }
    .msg { font-size: 14px; }
    .ok { color: #7dd3fc; }
    .err { color: #fca5a5; }

    .docsCard { margin-top:14px; }
    .docsTitle { font-weight:800; margin-bottom:8px; }
    .docsSub { opacity:0.8; font-size:13px; margin-bottom:10px; }
    .docRow {
      display:grid;
      grid-template-columns: minmax(130px, 1fr) auto minmax(170px, 1.2fr) minmax(150px, 1fr);
      gap:8px;
      align-items:center;
      padding:8px 0;
      border-top:1px solid rgba(56,189,248,0.18);
    }
    .docRow:first-of-type { border-top:0; }
    .docReq { font-size:12px; font-weight:700; padding:4px 8px; border-radius:999px; display:inline-block; }
    .docReq.required { background:rgba(11,120,207,.2); color:#dbeafe; border:1px solid rgba(56,189,248,.45); }
    .docReq.optional { background:rgba(15,23,42,.7); color:#cbd5e1; border:1px solid rgba(148,163,184,.35); }
    .docStatus { font-size:13px; }
    .docStatus.ok { color:#7dd3fc; }
    .docStatus.err { color:#fca5a5; }

    @media (max-width: 720px) {
      .docRow { grid-template-columns: 1fr; gap:6px; }
    }

/* modal (same vibe as account modal) */
.modal-backdrop{
  position: fixed; inset: 0;
  background: rgba(2,6,23,0.72);
  display:none;
  align-items:center;
  justify-content:center;
  padding: 18px;
  z-index: 9999;
}
.modal-backdrop.is-open{ display:flex; }
.modal{
  width: min(520px, 100%);
  background: rgba(11,17,32,0.98);
  border: 1px solid rgba(56,189,248,.28);
  border-radius: 16px;
  box-shadow: 0 24px 60px rgba(0,0,0,0.45);
  overflow:hidden;
}
.modal-head{
  display:flex; align-items:center; justify-content:space-between;
  padding: 14px 16px;
  border-bottom: 1px solid rgba(255,255,255,0.10);
}
.modal-head h3{ margin:0; font-size: 16px; }
.icon-btn{
  background: transparent;
  border: 0;
  color: #e5e7eb;
  font-size: 18px;
  cursor:pointer;
}
.modal-body{ padding: 14px 16px; }
.field-label{ font-size: 13px; opacity: 0.9; display:block; margin-bottom:6px; }
.field-input{
  width:100%;
  padding: 12px 12px;
  border-radius: 10px;
  border: 1px solid rgba(56,189,248,.3);
  background: rgba(2,6,23,.6);
  color:#e5e7eb;
  outline:none;
}
.modal-actions{
  display:flex; gap:10px; justify-content:flex-end;
  padding: 14px 16px;
  border-top: 1px solid rgba(255,255,255,0.10);
}
.btn-primary{
  padding: 12px 16px;
  border-radius: 10px;
  background: linear-gradient(135deg,#0B78CF,#00B7FF);
  color:#fff;
  border:0;
  font-weight: 800;
  cursor:pointer;
}
.btn-ghost{
  padding: 12px 16px;
  border-radius: 10px;
  background: rgba(15,23,42,.85);
  color:#e5e7eb;
  border: 1px solid rgba(148,163,184,.28);
  cursor:pointer;
}
.form-error{
  margin-top:10px;
  color:#fca5a5;
}

/* success overlay */
.success-screen{
  position: fixed; inset: 0;
  display:flex;
  align-items:center;
  justify-content:center;
  background: #020617;
  z-index: 9000;
}
.success-card{
  width: min(640px, 92vw);
  background: rgba(11,17,32,.9);
  border: 1px solid rgba(56,189,248,.24);
  border-radius: 18px;
  padding: 22px;
  text-align:center;
}
.success-title{ font-size: 22px; font-weight: 900; }
.success-sub{ margin-top: 8px; opacity: 0.92; }


/* PDF: desktop vs mobile */
.pdfMobileCard { display:none; }

@media (max-width: 720px) {
  .wrap { padding: 14px; }
  iframe { height: 56vh; } /* still fine on some phones, but we’ll hide it */
  .pdfWrap { display:none !important; }

  .pdfMobileCard{
    display:block;
    padding:14px;
    border-radius:16px;
    border:1px solid rgba(56,189,248,.24);
    background:rgba(11,17,32,.88);
    margin-bottom:14px;
  }
  .pdfMobileTitle{ font-weight:900; font-size:18px; }
  .pdfMobileSub{ opacity:.85; margin-top:6px; font-size:14px; line-height:1.35; }
  .pdfMobileBtn{
    display:inline-block;
    margin-top:10px;
    padding:12px 14px;
    border-radius:12px;
    background:linear-gradient(135deg,#0B78CF,#00B7FF);
    color:#fff;
    font-weight:800;
    text-decoration:none;
  }
}

@media (max-width: 720px) {
  .top { flex-direction: row; }
  .brand { font-size: 18px; }
  .row { grid-template-columns: 1fr; } /* stack Name/Title */
}
    
  </style>
</head>
<body>
  <div class="wrap">
    <div class="top">
      <div class="brand">Carrier Shark — Carrier Agreement</div>
      <a class="btn" href="${pdfUrl}" target="_blank" rel="noopener">Open PDF</a>
    </div>

    <div class="card">
      <div class="pdfWrap">
        <iframe src="${pdfUrl}"></iframe>
        <div class="muted">If the PDF doesn’t display on your device, tap “Open PDF”.</div>
      </div>
      
      <div class="pdfMobileCard">
        <div class="pdfMobileTitle">Carrier Agreement</div>
        <div class="pdfMobileSub">
          Tap below to review the agreement in a clean PDF viewer.
        </div>
        <a class="pdfMobileBtn" href="${pdfUrl}" target="_blank" rel="noopener">Open PDF</a>
      </div>

      <div class="form" id="ackWrap">
        ${
          alreadyAccepted
            ? `<div class="msg ok"><strong>Signed.</strong> This agreement has already been signed.</div>`
            : `
<div class="card" style="margin-top:14px; background: rgba(255,255,255,0.04);">
  <div style="font-size:13px; line-height:1.5;">
    <strong>Platform Notice:</strong><br/>
    Carrier Shark provides technology for document delivery and electronic acceptance.
    Carrier Shark is <strong>not a party</strong> to this agreement and assumes no obligations under it.
    Carrier Shark does not verify identity, authority, insurance coverage, or regulatory status of any party.
    Users are responsible for independent verification.
  </div>
</div>

<div class="checkline" style="margin-top:14px;">
  <input id="ack" type="checkbox" />
  <div>
    <div style="font-weight:700;">
      I accept and electronically sign this agreement.
    </div>
    <div class="muted">
      By submitting, you represent that you are authorized to accept on behalf of the carrier.
    </div>
  </div>
</div>


        <div class="row">
          <div>
            <label for="name">Name</label>
            <input id="name" type="text" placeholder="Full name" />
          </div>
          <div>
            <label for="title">Title</label>
            <input id="title" type="text" placeholder="Owner / Dispatcher / Safety" />
          </div>
        </div>

        <div>
          <label for="email">Email (optional)</label>
          <input id="email" type="email" placeholder="name@company.com" />
        </div>

<div class="card docsCard">
  <div class="docsTitle">Supporting Documents</div>
  <div class="docsSub">Select a file to upload immediately. You can replace an uploaded file at any time.</div>

  <div class="docRow">
    <div>W-9</div>
    <div id="w9Required" class="docReq">—</div>
    <input type="file" id="w9Upload" accept=".pdf,.png,.jpg,.jpeg,.webp" />
    <div id="w9Msg" class="docStatus">Not uploaded</div>
  </div>

  <div class="docRow">
    <div>Insurance / COI</div>
    <div id="insRequired" class="docReq">—</div>
    <input type="file" id="insUpload" accept=".pdf,.png,.jpg,.jpeg,.webp" />
    <div id="insMsg" class="docStatus">Not uploaded</div>
  </div>

  <div class="docRow">
    <div>ACH / Payment Info</div>
    <div id="achRequired" class="docReq">—</div>
    <input type="file" id="achUpload" accept=".pdf,.png,.jpg,.jpeg,.webp" />
    <div id="achMsg" class="docStatus">Not uploaded</div>
  </div>

  <div class="docRow">
    <div>Other Documents</div>
    <div id="otherRequired" class="docReq">—</div>
    <input type="file" id="otherUpload" accept=".pdf,.png,.jpg,.jpeg,.webp" />
    <div id="otherMsg" class="docStatus">Not uploaded</div>
  </div>
</div>

        <div class="submitline">
          <button id="submitBtn" class="btn2">Accept Agreement</button>
          <div id="msg" class="msg"></div>
        </div>
`
        }
      </div>
    </div>
  </div>

  <script>

  function openOtpModal(deliveryTarget) {
  const m = document.getElementById("otp-modal");
  const sub = document.getElementById("otp-sub");
  const input = document.getElementById("otp-code");
  const err = document.getElementById("otp-error");

  if (sub) sub.textContent = "Enter the 6-digit code sent to " + (deliveryTarget || "your email") + ".";
  if (err) { err.style.display = "none"; err.textContent = ""; }
  if (input) input.value = "";

  m.classList.add("is-open");
  m.setAttribute("aria-hidden", "false");
  setTimeout(() => input?.focus(), 0);
}

function closeOtpModal() {
  const m = document.getElementById("otp-modal");
  if (!m) return;
  m.classList.remove("is-open");
  m.setAttribute("aria-hidden", "true");
}

function otpError(msg) {
  const err = document.getElementById("otp-error");
  if (!err) return;
  err.textContent = msg || "Invalid code.";
  err.style.display = "block";
}

function waitForOtp() {
  return new Promise((resolve, reject) => {
    const input = document.getElementById("otp-code");
    const verifyBtn = document.getElementById("otp-verify");
    const cancelBtn = document.getElementById("otp-cancel");
    const closeBtn  = document.getElementById("otp-close");
    const modal     = document.getElementById("otp-modal");

    function cleanup() {
      verifyBtn?.removeEventListener("click", onVerify);
      cancelBtn?.removeEventListener("click", onCancel);
      closeBtn?.removeEventListener("click", onCancel);
      modal?.removeEventListener("click", onBackdrop);
      document.removeEventListener("keydown", onKey);
      input?.removeEventListener("keydown", onEnter);
    }

    function onCancel() {
      cleanup();
      closeOtpModal();
      reject(new Error("Authentication cancelled."));
    }

    function onBackdrop(e) {
      if (e.target === modal) onCancel();
    }

    function onKey(e) {
      if (e.key === "Escape") onCancel();
    }

    function onEnter(e) {
      if (e.key === "Enter") onVerify();
    }

    function onVerify() {
      const raw = (input?.value || "").trim();
      const digits = raw.replace(/\D/g, ""); // keep only 0-9
    
      if (digits.length !== 6) return otpError("Enter a valid 6-digit code.");
    
      cleanup();
      closeOtpModal();
      resolve(digits);
    }

    verifyBtn?.addEventListener("click", onVerify);
    cancelBtn?.addEventListener("click", onCancel);
    closeBtn?.addEventListener("click", onCancel);
    modal?.addEventListener("click", onBackdrop);
    document.addEventListener("keydown", onKey);
    input?.addEventListener("keydown", onEnter);
  });
}
    (function () {
      const alreadyAccepted = ${alreadyAccepted ? "true" : "false"};
      if (alreadyAccepted) return;

      const token = ${JSON.stringify(token)};
      const requiredDocs = ${JSON.stringify(requirements)};
      const uploadState = ${JSON.stringify(uploadState)};
      const ackEl = document.getElementById("ack");
      const nameEl = document.getElementById("name");
      const titleEl = document.getElementById("title");
      const emailEl = document.getElementById("email");
      const btn = document.getElementById("submitBtn");
      const msg = document.getElementById("msg");

      const docConfig = {
        w9: {
          endpoint: "/w9-upload",
          inputEl: document.getElementById("w9Upload"),
          statusEl: document.getElementById("w9Msg"),
          reqEl: document.getElementById("w9Required"),
          label: "W-9",
        },
        insurance: {
          endpoint: "/insurance-upload",
          inputEl: document.getElementById("insUpload"),
          statusEl: document.getElementById("insMsg"),
          reqEl: document.getElementById("insRequired"),
          label: "Insurance / COI",
        },
        ach: {
          endpoint: "/ach-upload",
          inputEl: document.getElementById("achUpload"),
          statusEl: document.getElementById("achMsg"),
          reqEl: document.getElementById("achRequired"),
          label: "ACH / Payment Info",
        },
        other: {
          endpoint: "/other-upload",
          inputEl: document.getElementById("otherUpload"),
          statusEl: document.getElementById("otherMsg"),
          reqEl: document.getElementById("otherRequired"),
          label: "Other Documents",
        },
      };

      function markRequirement(el, required) {
        if (!el) return;
        el.textContent = required ? "Required" : "Optional";
        el.className = "docReq " + (required ? "required" : "optional");
      }

      function setDocStatus(el, text, cls) {
        if (!el) return;
        el.className = "docStatus " + (cls || "");
        el.textContent = text || "";
      }

      async function uploadDoc(docType, file) {
        if (!file) return;
        const cfg = docConfig[docType];
        if (!cfg) return;

        setDocStatus(cfg.statusEl, "Uploading...", "");

        const formData = new FormData();
        formData.append("file", file);

        try {
          const resp = await fetch("/contract/" + encodeURIComponent(token) + cfg.endpoint, {
            method: "POST",
            body: formData,
          });
          const data = await resp.json().catch(() => ({}));
          if (!resp.ok) throw new Error(data.error || "Upload failed.");

          uploadState[docType] = { uploaded: true, filename: data.original_filename || file.name || null };
          setDocStatus(cfg.statusEl, "Uploaded: " + (uploadState[docType].filename || "file"), "ok");
        } catch (err) {
          setDocStatus(cfg.statusEl, err.message || "Upload failed.", "err");
        }

        updateAcceptButtonState();
      }

      function missingRequiredDocs() {
        return Object.keys(requiredDocs).filter((key) => requiredDocs[key] && !uploadState[key]?.uploaded);
      }

      function updateAcceptButtonState() {
        const name = (nameEl?.value || "").trim();
        const title = (titleEl?.value || "").trim();
        const ready = Boolean(ackEl?.checked) && Boolean(name) && Boolean(title) && missingRequiredDocs().length === 0;
        btn.disabled = !ready;
      }

      Object.keys(docConfig).forEach((key) => {
        const cfg = docConfig[key];
        markRequirement(cfg.reqEl, Boolean(requiredDocs[key]));
        if (uploadState[key]?.uploaded) {
          setDocStatus(cfg.statusEl, "Uploaded: " + (uploadState[key].filename || "file"), "ok");
        } else {
          setDocStatus(cfg.statusEl, "Not uploaded", "");
        }

        cfg.inputEl?.addEventListener("change", () => {
          const file = cfg.inputEl.files && cfg.inputEl.files[0];
          uploadDoc(key, file);
        });
      });

      function setMsg(text, cls) {
        msg.className = "msg " + (cls || "");
        msg.textContent = text || "";
      }

      ackEl?.addEventListener("change", updateAcceptButtonState);
      nameEl?.addEventListener("input", updateAcceptButtonState);
      titleEl?.addEventListener("input", updateAcceptButtonState);
      updateAcceptButtonState();

      btn.addEventListener("click", async () => {
        setMsg("");
      
        const ack = ackEl.checked;
        const name = (nameEl.value || "").trim();
        const title = (titleEl.value || "").trim();
        const email = (emailEl.value || "").trim();
      
        if (!ack) return setMsg("Please confirm acceptance of the agreement.", "err");
        if (!name) return setMsg("Name is required.", "err");
        if (!title) return setMsg("Title is required.", "err");
        const missingDocs = missingRequiredDocs();
        if (missingDocs.length) {
          return setMsg("Please upload all required supporting documents before accepting.", "err");
        }
      
        btn.disabled = true;
        btn.textContent = "Verifying...";
      
        try {
          // 1️⃣ Start MFA
          const startResp = await fetch("/contract/" + encodeURIComponent(token) + "/mfa/start", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({})
          });
      
          const startData = await startResp.json().catch(() => ({}));
          if (!startResp.ok) {
            throw new Error(startData.error || "Failed to send authentication code.");
          }
      
// 2️⃣ If not already validated, prompt for OTP
if (startData.status !== "MFA_ALREADY_VALID") {
  const deliveryTarget = startData.deliveryTarget || "your email";

  openOtpModal(deliveryTarget);
  const code = await waitForOtp();

  const verifyResp = await fetch(
    "/contract/" + encodeURIComponent(token) + "/mfa/verify",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mfa_event_id: startData.mfa_event_id,
        otp: code
      })
    }
  );

  const verifyData = await verifyResp.json().catch(() => ({}));
  if (!verifyResp.ok) {
    throw new Error(verifyData.error || "Invalid authentication code.");
  }
}
      
          // 3️⃣ Now submit acceptance
          btn.textContent = "Submitting...";
      
          const resp = await fetch("/contract/" + encodeURIComponent(token) + "/ack", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ack: true, name, title, email: email || null })
          });
      
          const data = await resp.json().catch(() => ({}));
      
          if (!resp.ok) {
            setMsg(data.error || "Failed to submit.", "err");
            btn.disabled = false;
            btn.textContent = "Accept Agreement";
          } else {
            document.getElementById("accepted-screen").style.display = "flex";
            document.querySelector(".wrap").style.display = "none";
          }
        } catch (e) {
          setMsg(e.message || "Network error. Please try again.", "err");
          btn.disabled = false;
          btn.textContent = "Accept Agreement";
        }
      });

    })();

    
  </script>

<!-- OTP Modal -->
<div class="modal-backdrop" id="otp-modal" aria-hidden="true">
  <div class="modal" role="dialog" aria-modal="true" aria-labelledby="otp-title">
    <div class="modal-head">
      <h3 id="otp-title">Confirm acceptance</h3>
      <button class="icon-btn" type="button" id="otp-close" aria-label="Close">✕</button>
    </div>

    <div class="modal-body">
      <div class="muted" id="otp-sub">Enter the 6-digit code we sent.</div>

      <div class="field" style="margin-top:12px;">
        <label class="field-label" for="otp-code">6-digit code</label>
        <input class="field-input" id="otp-code" type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="6" pattern="[0-9]{6}" placeholder="123456" class="form-input" />
      </div>

      <div class="form-error" id="otp-error" style="display:none;"></div>
    </div>

    <div class="modal-actions">
      <button class="btn-ghost" type="button" id="otp-cancel">Cancel</button>
      <button class="btn-primary" type="button" id="otp-verify">Verify</button>
    </div>
  </div>
</div>

<!-- Success Screen (swap-in) -->
<div class="success-screen" id="accepted-screen" style="display:none;">
  <div class="success-card">
    <div class="success-title">Thank you.</div>

    <div class="success-sub">
      This agreement has been accepted successfully.
    </div>

    <div class="success-sub muted" style="margin-top:10px;">
      You can download a copy of the agreement below.
    </div>

    <div style="margin-top:20px; display:flex; gap:12px; flex-wrap:wrap; justify-content:center;">

      <a
        class="pdfMobileBtn"
        href="/contract/${token}/pdf"
        target="_blank"
        rel="noopener"
      >
        Open Contract PDF
      </a>

      <a
        class="pdfMobileBtn"
        href="/contract/${token}/certificate"
        target="_blank"
        rel="noopener"
      >
        Signature Certificate
      </a>

    </div>

  </div>
</div>

</body>
</html>`);
  } catch (err) {
    console.error("GET /contract/:token error:", err?.message, err);
    return res.status(500).send("Server error");
  }
});


async function handleContractDocumentUpload(req, res, config) {
  const token = String(req.params.token || "").trim();

  try {
    const contract = await loadContractByToken(token);
    if (!contract) return res.status(404).json({ error: "Invalid contract" });
    if (contract.token_expires_at && new Date(contract.token_expires_at) < new Date()) {
      return res.status(410).json({ error: "This link has expired" });
    }

    const file = req.files?.file;
    const fileErr = validateUploadFile(file, {
      allowedMimes: ["application/pdf", "image/png", "image/jpeg", "image/webp"],
      maxSizeBytes: 10 * 1024 * 1024,
    });
    if (fileErr) return res.status(400).json({ error: fileErr });

    const originalFilename = String(file.name || "upload").trim();
    const safeName = originalFilename.replace(/[^\w.\-]/g, "_");
    const mimeType = String(file.mimetype || "").toLowerCase().trim();
    const key = `${config.storagePrefix}/${contract.contract_id}/${Date.now()}_${safeName}`;

    await uploadFileToSpaces({ file, key, mimeType });

    await pool.query(
      `
      INSERT INTO ${config.table}
        (contract_id, storage_key, mime_type, original_filename)
      VALUES
        ($1, $2, $3, $4)
      `,
      [contract.contract_id, key, mimeType, originalFilename]
    );

    return res.json({
      ok: true,
      document_type: config.documentType,
      storage_key: key,
      mime_type: mimeType,
      original_filename: originalFilename,
      contract_id: contract.contract_id,
    });
  } catch (err) {
    console.error(`POST /contract/:token/${config.documentType}-upload error:`, err?.message, err);
    return res.status(500).json({ error: "Upload failed" });
  }
}

router.post("/contract/:token/ach-upload", async (req, res) => {
  return handleContractDocumentUpload(req, res, {
    table: "public.contract_ach_documents",
    storagePrefix: "ach",
    documentType: "ach",
  });
});

router.post("/contract/:token/insurance-upload", async (req, res) => {
  const token = String(req.params.token || "").trim();
  const client = await pool.connect();

  try {
    const contract = await loadContractByToken(token);
    if (!contract) return res.status(404).json({ error: "Invalid contract" });

    if (contract.token_expires_at && new Date(contract.token_expires_at) < new Date()) {
      return res.status(410).json({ error: "This link has expired" });
    }

    const file = req.files?.file;
    if (!file) return res.status(400).json({ error: "Missing file" });

    const mimeType = String(file.mimetype || "").toLowerCase().trim();
    const allowedMimes = ["application/pdf", "image/png", "image/jpeg"];
    if (!allowedMimes.includes(mimeType)) {
      return res.status(400).json({ error: "Only PDF, JPG, or PNG allowed." });
    }

    const originalFilename = String(file.name || "upload").trim();
    const safeBase = originalFilename
      .replace(/\.[^/.]+$/, "")
      .replace(/[^\w.\-]+/g, "_")
      .slice(0, 80);

    const ext =
      mimeType === "application/pdf" ? "pdf" :
      mimeType === "image/png" ? "png" :
      mimeType === "image/jpeg" ? "jpg" :
      "bin";

    const dot = String(contract.dotnumber || "").replace(/\D/g, "");
    const companyId = contract.company_id;
    const contractId = contract.contract_id;

    if (!companyId) {
      return res.status(400).json({ error: "Contract is missing company_id" });
    }

    const key = `insurance/${companyId}/${dot || "unknown_dot"}/${contractId}/${Date.now()}_${safeBase}.${ext}`;

    await uploadFileToSpaces({ file, key, mimeType });

    await client.query("BEGIN");

    await client.query(
      `
      INSERT INTO public.contract_insurance_documents
        (contract_id, storage_key, mime_type, original_filename)
      VALUES
        ($1, $2, $3, $4)
      `,
      [contractId, key, mimeType, originalFilename]
    );

    const fileUrl = `s3://${process.env.SPACES_BUCKET}/${key}`;

    const ins = await client.query(
      `
      INSERT INTO public.insurance_documents
        (
          company_id,
          dot_number,
          uploaded_by,
          file_url,
          file_type,
          document_type,
          status,
          uploaded_at,
          spaces_key,
          ocr_provider
        )
      VALUES
        (
          $1,
          $2,
          'CARRIER',
          $3,
          $4,
          'COI',
          'ON_FILE',
          NOW(),
          $5,
          'DOCUPIPE'
        )
      RETURNING id
      `,
      [
        companyId,
        dot || "0",
        fileUrl,
        "PDF", // keep this if your downstream expects PDF for both PDFs and images
        key,
      ]
    );

    const documentId = ins.rows[0].id;

    await client.query(
      `
      INSERT INTO public.insurance_ocr_jobs
        (document_id, provider, status, attempt, dot_number)
      VALUES
        ($1, 'DOCUPIPE', 'PENDING', 0, $2)
      `,
      [documentId, dot || null]
    );

    await client.query("COMMIT");

    return res.json({
      ok: true,
      document_type: "insurance",
      contract_id: contractId,
      document_id: documentId,
      storage_key: key,
      mime_type: mimeType,
      original_filename: originalFilename,
    });
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch {}
    console.error("POST /contract/:token/insurance-upload error:", err?.message, err);
    return res.status(500).json({ error: "Upload failed" });
  } finally {
    client.release();
  }
});

router.post("/contract/:token/w9-upload", async (req, res) => {
  return handleContractDocumentUpload(req, res, {
    table: "public.contract_w9_documents",
    storagePrefix: "w9",
    documentType: "w9",
  });
});

router.post("/contract/:token/other-upload", async (req, res) => {
  return handleContractDocumentUpload(req, res, {
    table: "public.contract_other_documents",
    storagePrefix: "other",
    documentType: "other",
  });
});

router.post("/contract/:token/mfa/start", async (req, res) => {
  const token = String(req.params.token || "").trim();
  if (!token) return res.status(400).json({ error: "Missing token" });

  const accepted_ip =
    (req.headers["x-forwarded-for"]
      ? String(req.headers["x-forwarded-for"]).split(",")[0].trim()
      : null) ||
    req.ip ||
    null;

  const accepted_user_agent = req.get("user-agent") || null;

  const client = await pool.connect();
  try {
    // 1) Load contract + email_to
    const { rows } = await client.query(
      `
      SELECT contract_id, token_expires_at, email_to
      FROM public.contracts
      WHERE token = $1
      LIMIT 1;
      `,
      [token]
    );

    if (!rows.length) return res.status(404).json({ error: "Invalid link" });

    const { contract_id, token_expires_at, email_to } = rows[0];

    if (token_expires_at && new Date(token_expires_at) < new Date()) {
      return res.status(410).json({ error: "This link has expired" });
    }

    if (!email_to) {
      // You can choose to allow OTP to "email (optional)" instead,
      // but enterprise posture is better if OTP goes to the known recipient.
      return res.status(400).json({ error: "Missing recipient email for this contract" });
    }

    // 2) If already verified recently, no need to resend
    const already = await client.query(
      `
      SELECT id, otp_verified_at
      FROM public.contract_mfa_events
      WHERE contract_id::text = $1::text
        AND otp_verified_at IS NOT NULL
        AND otp_verified_at > now() - interval '${MFA_VALID_MIN} minutes'
      ORDER BY otp_verified_at DESC
      LIMIT 1;
      `,
      [contract_id]
    );

    if (already.rows.length) {
      return res.json({
        status: "MFA_ALREADY_VALID",
        validForSeconds: MFA_VALID_MIN * 60,
      });
    }

    // 3) Basic resend cooldown: if last OTP created < 30s ago, block
    const recent = await client.query(
      `
      SELECT otp_created_at
      FROM public.contract_mfa_events
      WHERE contract_id::text = $1::text
        AND otp_verified_at IS NULL
        AND expires_at > now()
      ORDER BY otp_created_at DESC
      LIMIT 1;
      `,
      [contract_id]
    );

    if (recent.rows.length) {
      const createdAt = new Date(recent.rows[0].otp_created_at).getTime();
      if (Date.now() - createdAt < 30_000) {
        return res.status(429).json({ error: "OTP_RECENTLY_SENT" });
      }
    }

    // 4) Invalidate old unverified OTP events (optional but clean)
    await client.query(
      `
      UPDATE public.contract_mfa_events
      SET expires_at = now()
      WHERE contract_id::text = $1::text
        AND otp_verified_at IS NULL
        AND expires_at > now();
      `,
      [contract_id]
    );

    const otp = generateOtp6();
    const otp_hash = hashOtp({ otp, contractId: contract_id });
    const expires_at = new Date(Date.now() + OTP_EXPIRES_MIN * 60 * 1000);
    const delivery_target = maskEmail(email_to);

    // 5) Insert MFA event
    const ins = await client.query(
      `
      INSERT INTO public.contract_mfa_events
        (contract_id, user_id, delivery_channel, delivery_target, otp_hash, expires_at, otp_ip, otp_user_agent, metadata)
      VALUES
        ($1, NULL, 'email', $2, $3, $4, $5, $6, jsonb_build_object('token', $7::text))
      RETURNING id;
      `,
      [contract_id, delivery_target, otp_hash, expires_at, accepted_ip, accepted_user_agent, token]
    );

    const mfa_event_id = ins.rows[0].id;

    // 6) Send email OTP
    await sendContractOtpEmail({ to: email_to, otp });

    await client.query(
      `UPDATE public.contract_mfa_events
       SET delivered_at = now()
       WHERE id = $1`,
      [mfa_event_id]
    );

    return res.json({
      status: "OTP_SENT",
      mfa_event_id,
      deliveryTarget: delivery_target,
      expiresInSeconds: OTP_EXPIRES_MIN * 60,
    });
  } catch (err) {
    console.error("POST /contract/:token/mfa/start error:", err?.message, err);
    return res.status(500).json({ error: "Failed to start MFA" });
  } finally {
    client.release();
  }
});


router.post("/contract/:token/mfa/verify", async (req, res) => {
  const token = String(req.params.token || "").trim();
  if (!token) return res.status(400).json({ error: "Missing token" });

  const { mfa_event_id, otp } = req.body || {};
  if (!mfa_event_id || !otp) return res.status(400).json({ error: "mfa_event_id and otp are required" });

  const accepted_ip =
    (req.headers["x-forwarded-for"]
      ? String(req.headers["x-forwarded-for"]).split(",")[0].trim()
      : null) ||
    req.ip ||
    null;

  const accepted_user_agent = req.get("user-agent") || null;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Load contract
    const contractRes = await client.query(
      `
      SELECT contract_id, token_expires_at
      FROM public.contracts
      WHERE token = $1
      LIMIT 1;
      `,
      [token]
    );

    if (!contractRes.rows.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Invalid link" });
    }

    const { contract_id, token_expires_at } = contractRes.rows[0];

    if (token_expires_at && new Date(token_expires_at) < new Date()) {
      await client.query("ROLLBACK");
      return res.status(410).json({ error: "This link has expired" });
    }

    // Lock MFA event row
    const evRes = await client.query(
      `
      SELECT *
      FROM public.contract_mfa_events
      WHERE id = $1 AND contract_id = $2
      FOR UPDATE;
      `,
      [mfa_event_id, contract_id]
    );

    if (!evRes.rows.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "MFA event not found" });
    }

    const ev = evRes.rows[0];

    if (ev.otp_verified_at) {
      await client.query("COMMIT");
      return res.json({ status: "ALREADY_VERIFIED", validForSeconds: MFA_VALID_MIN * 60 });
    }

    if (ev.locked_until && new Date(ev.locked_until) > new Date()) {
      await client.query("ROLLBACK");
      return res.status(429).json({ error: "LOCKED", lockedUntil: ev.locked_until });
    }

    if (new Date(ev.expires_at) < new Date()) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "EXPIRED" });
    }

    const candidate = hashOtp({ otp: String(otp).trim(), contractId: contract_id });

    let ok = false;
    try {
      ok = crypto.timingSafeEqual(Buffer.from(candidate, "hex"), Buffer.from(ev.otp_hash, "hex"));
    } catch {
      ok = false;
    }

    if (!ok) {
      const nextAttempts = (ev.attempt_count || 0) + 1;
      let lockedUntil = null;

      if (nextAttempts >= MAX_ATTEMPTS) {
        lockedUntil = new Date(Date.now() + LOCK_MIN * 60 * 1000);
      }

      await client.query(
        `
        UPDATE public.contract_mfa_events
        SET attempt_count = $2,
            locked_until = COALESCE($3, locked_until)
        WHERE id = $1;
        `,
        [mfa_event_id, nextAttempts, lockedUntil]
      );

      await client.query("COMMIT");
      return res.status(400).json({
        error: "INVALID_OTP",
        attemptsRemaining: Math.max(0, MAX_ATTEMPTS - nextAttempts),
        lockedUntil,
      });
    }

    await client.query(
      `
      UPDATE public.contract_mfa_events
      SET otp_verified_at = now(),
          otp_ip = $2,
          otp_user_agent = $3
      WHERE id = $1;
      `,
      [mfa_event_id, accepted_ip, accepted_user_agent]
    );

    await client.query("COMMIT");
    return res.json({ status: "VERIFIED", validForSeconds: MFA_VALID_MIN * 60 });
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch {}
    console.error("POST /contract/:token/mfa/verify error:", err?.message, err);
    return res.status(500).json({ error: "Failed to verify OTP" });
  } finally {
    client.release();
  }
});

router.get("/contract/:token/ach", async (req, res) => {
  const token = String(req.params.token || "").trim();
  return streamContractDocumentByToken({
    req,
    res,
    query: `
      SELECT
        c.token_expires_at,
        cad.storage_key,
        cad.mime_type,
        cad.original_filename
      FROM public.contracts c
      JOIN public.contract_ach_documents cad
        ON cad.contract_id::text = c.contract_id::text
      WHERE c.token = $1
      ORDER BY cad.created_at DESC
      LIMIT 1
    `,
    queryParams: [token],
    notFoundMessage: "ACH document not found",
    missingStorageMessage: "Missing ACH storage key",
    logLabel: "ach",
    fallbackFilename: "ach_document",
  });
});

router.get("/contract/:token/w9", async (req, res) => {
  const token = String(req.params.token || "").trim();
  return streamContractDocumentByToken({
    req,
    res,
    query: `
      SELECT
        c.token_expires_at,
        cwd.storage_key,
        cwd.mime_type,
        cwd.original_filename
      FROM public.contracts c
      JOIN public.contract_w9_documents cwd
        ON cwd.contract_id::text = c.contract_id::text
      WHERE c.token = $1
      ORDER BY cwd.created_at DESC
      LIMIT 1
    `,
    queryParams: [token],
    notFoundMessage: "W9 document not found",
    missingStorageMessage: "Missing W9 storage key",
    logLabel: "w9",
    fallbackFilename: "w9_document",
  });
});

router.get("/contract/:token/insurance", async (req, res) => {
  const token = String(req.params.token || "").trim();
  return streamContractDocumentByToken({
    req,
    res,
    query: `
      SELECT
        c.token_expires_at,
        cid.storage_key,
        cid.mime_type,
        cid.original_filename
      FROM public.contracts c
      JOIN public.contract_insurance_documents cid
        ON cid.contract_id::text = c.contract_id::text
      WHERE c.token = $1
      ORDER BY cid.created_at DESC
      LIMIT 1
    `,
    queryParams: [token],
    notFoundMessage: "Insurance document not found",
    missingStorageMessage: "Missing insurance storage key",
    logLabel: "insurance",
    fallbackFilename: "insurance_document",
  });
});

router.get("/contract/:token/other/:id", async (req, res) => {
  const token = String(req.params.token || "").trim();
  const documentId = String(req.params.id || "").trim();
  if (!documentId) return res.status(400).send("Missing other document id");

  return streamContractDocumentByToken({
    req,
    res,
    query: `
      SELECT
        c.token_expires_at,
        cod.storage_key,
        cod.mime_type,
        cod.original_filename
      FROM public.contracts c
      JOIN public.contract_other_documents cod
        ON cod.contract_id::text = c.contract_id::text
      WHERE c.token = $1
        AND cod.id = $2
      LIMIT 1
    `,
    queryParams: [token, documentId],
    notFoundMessage: "Other document not found",
    missingStorageMessage: "Missing other document storage key",
    logLabel: "other",
    fallbackFilename: "other_document",
  });
});





router.post("/contract/:token/ack", async (req, res) => {
  const token = String(req.params.token || "").trim();
  if (!token) return res.status(400).json({ error: "Missing token" });

  const accepted_name = String(req.body?.name || "").trim();
  const accepted_title = String(req.body?.title || "").trim();
  const accepted_email = req.body?.email ? String(req.body.email).trim() : null;

  if (!accepted_name) return res.status(400).json({ error: "Name is required" });
  if (!accepted_title) return res.status(400).json({ error: "Title is required" });

  const accepted_ip =
    (req.headers["x-forwarded-for"]
      ? String(req.headers["x-forwarded-for"]).split(",")[0].trim()
      : null) ||
    req.ip ||
    null;

  const accepted_user_agent = req.get("user-agent") || null;

  const client = await pool.connect();

  try {
    // ============================================================
    // 1) Read-only lookups (NO transaction yet)
    // ============================================================

    // Load contract by token + expiry check
    const contractRes = await client.query(
      `
      SELECT contract_id, token_expires_at, user_contract_id, status, insurance_required, w9_required, ach_required
      FROM public.contracts
      WHERE token = $1
      LIMIT 1;
      `,
      [token]
    );

    if (!contractRes.rows.length) {
      return res.status(404).json({ error: "Invalid link" });
    }

    const {
      contract_id,
      token_expires_at,
      status,
      insurance_required,
      w9_required,
      ach_required,
    } = contractRes.rows[0];

    if (token_expires_at && new Date(token_expires_at) < new Date()) {
      return res.status(410).json({ error: "This link has expired" });
    }

    const requiredDocs = {
      w9: normalizeRequiredFlag(w9_required, true),
      insurance: normalizeRequiredFlag(insurance_required, false),
      ach: normalizeRequiredFlag(ach_required, false),
    };

    const [achDocRes, insDocRes, w9DocRes] = await Promise.all([
      pool.query(
        `SELECT id FROM public.contract_ach_documents WHERE contract_id::text = $1::text ORDER BY created_at DESC LIMIT 1`,
        [contract_id]
      ),
      pool.query(
        `SELECT id FROM public.contract_insurance_documents WHERE contract_id::text = $1::text ORDER BY created_at DESC LIMIT 1`,
        [contract_id]
      ),
      pool.query(
        `SELECT id FROM public.contract_w9_documents WHERE contract_id::text = $1::text ORDER BY created_at DESC LIMIT 1`,
        [contract_id]
      ),
    ]);

    const uploadedDocs = {
      ach: Boolean(achDocRes.rows[0]),
      insurance: Boolean(insDocRes.rows[0]),
      w9: Boolean(w9DocRes.rows[0]),
    };

    const missingRequired = Object.keys(requiredDocs).filter(
      (key) => requiredDocs[key] && !uploadedDocs[key]
    );

    if (missingRequired.length) {
      return res.status(400).json({ error: "Missing required supporting documents" });
    }

    // Optional: if you want idempotent “already accepted”
    if (status === "SIGNED" || status === "ACKNOWLEDGED") {
      return res.json({ ok: true, status });
    }

    // Load PDF storage metadata (same relationship you use in /pdf)
    const pdfMetaRes = await client.query(
      `
      SELECT uc.storage_provider, uc.storage_key
      FROM public.contracts c
      JOIN public.user_contracts uc
        ON uc.id = c.user_contract_id
      WHERE c.contract_id = $1
      LIMIT 1;
      `,
      [contract_id]
    );

    if (!pdfMetaRes.rows.length) {
      return res.status(500).json({ error: "Missing contract storage metadata" });
    }

    const { storage_provider, storage_key } = pdfMetaRes.rows[0];

    if (storage_provider !== "DO_SPACES" || !storage_key) {
      return res.status(500).json({ error: "Storage provider not configured" });
    }

    // Fetch PDF bytes from Spaces and compute hash (NO transaction yet)
    let document_hash_sha256;
    try {
      const obj = await spaces
        .getObject({ Bucket: process.env.SPACES_BUCKET, Key: storage_key })
        .promise();

      const pdfBuffer = obj.Body; // Buffer
      document_hash_sha256 = crypto
        .createHash("sha256")
        .update(pdfBuffer)
        .digest("hex");
    } catch (err) {
      console.error("Failed to load PDF for hashing:", err?.code, err?.message, err);
      return res.status(500).json({ error: "Failed to compute document hash" });
    }

    // ============================================================
    // 2) Transaction begins ONLY when we need to write
    // ============================================================

    const metaRes = await client.query(
      `
      SELECT
        c.dotnumber,
        c.email_to,
        c.user_id,
        uc.name        AS agreement_type,
        uc.display_name AS broker_name,
        u.email        AS broker_email,
        COALESCE(pc.dbaname,pc.legalname) AS carrier_name
      FROM public.contracts c
      JOIN public.user_contracts uc ON uc.id = c.user_contract_id
      JOIN public.users u ON u.id = c.user_id
      LEFT JOIN public.carriers pc on c.dotnumber = pc.dotnumber
      WHERE c.contract_id = $1
      LIMIT 1;
      `,
      [contract_id]
    );
    
    const meta = metaRes.rows[0] || {};
    
    await client.query("BEGIN");

    // (Optional but clean) Re-check token is still valid inside transaction
    const contractRes2 = await client.query(
      `
      SELECT contract_id, token_expires_at, status
      FROM public.contracts
      WHERE contract_id::text = $1::text
      LIMIT 1;
      `,
      [contract_id]
    );

    if (!contractRes2.rows.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Contract not found" });
    }

    const { token_expires_at: token_expires_at2, status: status2 } = contractRes2.rows[0];

    if (token_expires_at2 && new Date(token_expires_at2) < new Date()) {
      await client.query("ROLLBACK");
      return res.status(410).json({ error: "This link has expired" });
    }

    // If another request signed it between our first check and now:
    if (status2 === "SIGNED" || status2 === "ACKNOWLEDGED") {
      
    await client.query("COMMIT");

// send emails AFTER commit (so acceptance isn't lost if mailgun hiccups)
try {
  await sendContractAcceptedEmails({
    token,
    contract_id,
    meta,
    accepted_name,
    accepted_title,
    accepted_email,
  });
} catch (e) {
  console.error("Contract acceptance email failed:", e?.message, e);
}
    
    return res.json({ ok: true });
    }

    // ============================================================
    // 3) MFA gate (must be inside transaction for correctness)
    // ============================================================

    const mfaOk = await client.query(
      `
      SELECT id
      FROM public.contract_mfa_events
      WHERE contract_id::text = $1::text
        AND otp_verified_at IS NOT NULL
        AND otp_verified_at > now() - interval '10 minutes'
      ORDER BY otp_verified_at DESC
      LIMIT 1;
      `,
      [contract_id]
    );

    if (!mfaOk.rows.length) {
      await client.query("ROLLBACK");
      return res.status(403).json({ error: "MFA_REQUIRED" });
    }

    const mfa_event_id = mfaOk.rows[0].id;

    // ============================================================
    // 4) Insert acceptance (store hash + storage_key, never overwrite)
    // ============================================================

    await client.query(
      `
      INSERT INTO public.contract_acceptances
        (contract_id, method, accepted_name, accepted_title, accepted_email,
         accepted_ip, accepted_user_agent, mfa_event_id,
         document_hash_sha256, document_storage_key)
      VALUES
        ($1, 'SIGNED', $2, $3, $4, $5, $6, $7, $8, $9)
      ON CONFLICT (contract_id) DO UPDATE
        SET method = EXCLUDED.method,
            accepted_name = EXCLUDED.accepted_name,
            accepted_title = EXCLUDED.accepted_title,
            accepted_email = EXCLUDED.accepted_email,
            accepted_at = NOW(),
            accepted_ip = EXCLUDED.accepted_ip,
            accepted_user_agent = EXCLUDED.accepted_user_agent,
            mfa_event_id = EXCLUDED.mfa_event_id,

            -- prevent accidental future changes
            document_hash_sha256 = COALESCE(contract_acceptances.document_hash_sha256, EXCLUDED.document_hash_sha256),
            document_storage_key  = COALESCE(contract_acceptances.document_storage_key,  EXCLUDED.document_storage_key);
      `,
      [
        contract_id,
        accepted_name,
        accepted_title,
        accepted_email,
        accepted_ip,
        accepted_user_agent,
        mfa_event_id,
        document_hash_sha256,
        storage_key,
      ]
    );

    // ============================================================
    // 5) Update contract status/timestamps
    // ============================================================

    await client.query(
      `
      UPDATE public.contracts
      SET status = 'SIGNED',
          signed_at = COALESCE(signed_at, now())
      WHERE contract_id::text = $1::text;
      `,
      [contract_id]
    );

await client.query("COMMIT");

// send emails AFTER commit (so acceptance isn't lost if mailgun hiccups)
try {
  await sendContractAcceptedEmails({
    token,
    contract_id,
    meta,
    accepted_name,
    accepted_title,
    accepted_email,
  });
} catch (e) {
  console.error("Contract acceptance email failed:", e?.message, e);
}

return res.json({ ok: true });
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch {}
    console.error("POST /contract/:token/ack error:", err?.message, err);
    return res.status(500).json({ error: "Failed to accept contract" });
  } finally {
    client.release();
  }
});




module.exports = router;
