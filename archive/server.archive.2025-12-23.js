const express = require('express');
const session = require('express-session');
const bcrypt = require('bcrypt');
const { Pool } = require('pg');
const path = require('path');

const { ocrPdfBufferWithTextract } = require("./ocr/textractPdf");

const app = express();
const port = process.env.PORT || 3000;
const crypto = require("crypto");

const AWS = require("aws-sdk");

const spaces = new AWS.S3({
  endpoint: `https://${process.env.SPACES_REGION}.digitaloceanspaces.com`,
  accessKeyId: process.env.SPACES_KEY,
  secretAccessKey: process.env.SPACES_SECRET,
  s3ForcePathStyle: true,
  signatureVersion: "v4"
});

const { 
  S3Client, 
  PutObjectCommand, 
  GetObjectCommand 
} = require("@aws-sdk/client-s3");

const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

const s3 = new S3Client({
  region: process.env.SPACES_REGION,
  endpoint: `https://${process.env.SPACES_REGION}.digitaloceanspaces.com`,
  credentials: {
    accessKeyId: process.env.SPACES_KEY,
    secretAccessKey: process.env.SPACES_SECRET
  }
});

const pool = new Pool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 5432),
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  ssl: { rejectUnauthorized: false }
});



const fs = require("fs");

if (process.env.GCP_SA_KEY_B64) {
  const keyPath = process.env.GOOGLE_APPLICATION_CREDENTIALS || "/tmp/gcp-key.json";
  fs.writeFileSync(keyPath, Buffer.from(process.env.GCP_SA_KEY_B64, "base64"));
  process.env.GOOGLE_APPLICATION_CREDENTIALS = keyPath;
}

// put it HERE (after the env/key exists)
const { ocrPdfBufferWithVision } = require("./ocr/visionPdfOcr");


//try 2

const pdfParseLib = require("pdf-parse");

// pick the actual callable parser function regardless of export shape
const pdfParse =
  (typeof pdfParseLib === "function" && pdfParseLib) ||
  (typeof pdfParseLib?.default === "function" && pdfParseLib.default) ||
  (typeof pdfParseLib?.PDFParse === "function" && pdfParseLib.PDFParse);

if (!pdfParse) {
  throw new Error("pdf-parse: could not find a callable parser function");
}

console.log("pdf-parse typeof:", typeof pdfParse);
//console.log("DEBUG pdf-parse keys:", Object.keys(pdfParseModule || {}));
// ---------------- helpers ----------------




function parseMoney(s) {
  if (!s) return null;
  const cleaned = String(s).replace(/[^0-9.]/g, "");
  if (!cleaned) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function isLikelyAcord25(text) {
  const t = (text || "").toUpperCase();
  const signals = [
    "CERTIFICATE OF LIABILITY INSURANCE",
    "ACORD",
    "PRODUCER",
    "INSURED",
    "COVERAGES",
    "THIS CERTIFICATE IS ISSUED AS A MATTER OF INFORMATION ONLY"
  ];
  const hits = signals.reduce((acc, s) => acc + (t.includes(s) ? 1 : 0), 0);
  return hits >= 3;
}

function findDates(text) {
  const matches = (text || "").match(/\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g);
  return matches ? [...new Set(matches)] : [];
}

// pull biggest money near a keyword window
function extractLimitNear(text, keyword) {
  const t = text || "";
  const idx = t.toUpperCase().indexOf(keyword.toUpperCase());
  if (idx === -1) return null;

  const window = t.slice(Math.max(0, idx - 200), Math.min(t.length, idx + 1400));
  const moneyMatches = window.match(/\$?\s?\d{1,3}(?:,\d{3})+(?:\.\d{2})?/g);
  if (!moneyMatches || moneyMatches.length === 0) return null;

  const nums = moneyMatches.map(parseMoney).filter(Boolean);
  if (nums.length === 0) return null;
  return Math.max(...nums);
}

// detect which coverage types are present (even if we can’t parse perfect limits yet)
function detectCoverageTypes(text) {
  const t = (text || "").toUpperCase();
  const types = [];

  // ACORD-ish names
  if (t.includes("GENERAL LIABILITY")) types.push("GL");
  if (t.includes("AUTOMOBILE LIABILITY") || t.includes("AUTO LIABILITY")) types.push("AUTO");
  if (t.includes("MOTOR TRUCK CARGO") || (t.includes("CARGO") && t.includes("TRUCK"))) types.push("CARGO");
  if (t.includes("WORKERS COMPENSATION") || t.includes("WORKERS COMP")) types.push("WC");
  if (t.includes("UMBRELLA LIAB") || t.includes("EXCESS LIAB")) types.push("UMBRELLA");
  if (t.includes("PROFESSIONAL LIABILITY") || t.includes("ERRORS AND OMISSIONS") || t.includes("E&O")) types.push("E&O");
  if (t.includes("POLLUTION")) types.push("POLLUTION");
  if (t.includes("CYBER")) types.push("CYBER");

  // dedupe
  return [...new Set(types)];
}

function computeConfidence({ acordLikely, auto, cargo, gl, datesCount }) {
  let score = 0;
  if (acordLikely) score += 40;
  if (auto) score += 25;
  if (cargo) score += 25;
  if (gl) score += 10;
  if (datesCount >= 2) score += 10;
  return Math.min(100, score);
}



// Ideal Route - Get Latest DOT

app.get("/api/insurance/latest", async (req, res) => {
  try {
    const dot = String(req.query.dot || "").replace(/\D/g, "");
    if (!dot) throw new Error("dot query param is required (numbers only).");

    const r = await pool.query(
      `
      SELECT id, dot_number, uploaded_by, document_type, status, uploaded_at, spaces_key
      FROM insurance_documents
      WHERE dot_number = $1
      ORDER BY uploaded_at DESC
      LIMIT 1
      `,
      [dot]
    );

    if (r.rowCount === 0) {
      return res.json({ ok: true, dot_number: dot, document: null });
    }

    const doc = r.rows[0];
    if (!doc.spaces_key) throw new Error("spaces_key is missing for this document.");

    const command = new GetObjectCommand({
      Bucket: process.env.SPACES_BUCKET,
      Key: doc.spaces_key,
      ResponseContentType: "application/pdf",
      // inline display in browser:
      ResponseContentDisposition: `inline; filename="COI-${doc.dot_number}.pdf"`
    });

    const signedUrl = await getSignedUrl(s3, command, { expiresIn: 60 * 10 }); // 10 min

    return res.json({
      ok: true,
      dot_number: dot,
      document: doc,
      signedUrl
    });
  } catch (err) {
    return res.status(400).json({ ok: false, error: err.message });
  }
});

// Document PDF Broker/Carrier

const multer = require("multer");

// ---- Multer: store in memory, validate PDF ----
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 12 * 1024 * 1024 }, // 12MB
  fileFilter: (req, file, cb) => {
    // Accept PDF by mime or extension fallback
    const okMime = file.mimetype === "application/pdf";
    const okExt = (file.originalname || "").toLowerCase().endsWith(".pdf");
    if (!okMime && !okExt) return cb(new Error("Only PDF files are allowed."));
    cb(null, true);
  },
});


// helper: sanitize DOT
function normalizeDot(dot) {
  const cleaned = String(dot || "").replace(/\D/g, "");
  if (!cleaned) throw new Error("dot_number is required.");
  if (cleaned.length > 10) throw new Error("dot_number too long.");
  return cleaned;
}

function normalizeUploadedBy(v) {
  const x = String(v || "").toUpperCase().trim();
  // Your table check is ('CARRIER','AGENT','CUSTOMER') right now
  // You said "broker" — map BROKER => CUSTOMER (or change your CHECK to include BROKER)
  if (x === "BROKER") return "CUSTOMER";
  if (x === "CARRIER") return "CARRIER";
  if (x === "AGENT") return "AGENT";
  if (x === "CUSTOMER") return "CUSTOMER";
  throw new Error("uploaded_by must be CARRIER, BROKER, AGENT, or CUSTOMER.");
}

function normalizeDocType(v) {
  const x = String(v || "COI").toUpperCase().trim();
  if (x === "COI" || x === "OTHER") return x;
  throw new Error("document_type must be COI or OTHER.");
}

// ---- ROUTE: Upload insurance document ----
app.post(
  "/api/insurance/documents",
  upload.single("document"),
  async (req, res) => {
    try {
      if (!req.file) throw new Error("document (PDF) is required.");

      const dot_number = normalizeDot(req.body.dot_number);
      const uploaded_by = normalizeUploadedBy(req.body.uploaded_by);
      const document_type = normalizeDocType(req.body.document_type);

      // Create deterministic-ish storage key
      const rand = crypto.randomBytes(10).toString("hex");
      const key = `insurance/${dot_number}/${Date.now()}-${rand}.pdf`;

      // Upload to Spaces
      await s3.send(
        new PutObjectCommand({
          Bucket: process.env.SPACES_BUCKET,
          Key: key,
          Body: req.file.buffer,
          ContentType: "application/pdf",
          ACL: "private", // keep private; serve via signed URL if needed
          Metadata: {
            dot_number,
            uploaded_by,
            document_type,
          },
        })
      );

      // File URL you store can be the s3 URI or https URL; if private, URL alone won't be usable
      // Store a stable reference:
      const file_url = `s3://${process.env.SPACES_BUCKET}/${key}`;

// Insert into Postgres
const result = await pool.query(
  `
  INSERT INTO insurance_documents
    (dot_number, uploaded_by, file_url, spaces_key, file_type, document_type, status)
  VALUES
    ($1, $2, $3, $4, 'PDF', $5, 'ON_FILE')
  RETURNING id, dot_number, uploaded_by, file_url, spaces_key, file_type, document_type, status, uploaded_at
  `,
  [dot_number, uploaded_by, file_url, key, document_type]
);


      return res.status(201).json({
        ok: true,
        document: result.rows[0],
      });
    } catch (err) {
      return res.status(400).json({
        ok: false,
        error: err.message || "Upload failed",
      });
    }
  }
);


// Get insurance docs

app.get("/api/insurance/documents", async (req, res) => {
  try {
    const dot = String(req.query.dot || "").replace(/\D/g, "");
    if (!dot) throw new Error("dot query param is required (numbers only).");

    const r = await pool.query(
      `
      SELECT id, dot_number, uploaded_by, document_type, status, uploaded_at
           , file_url, spaces_key
      FROM insurance_documents
      WHERE dot_number = $1
      ORDER BY uploaded_at DESC
      LIMIT 50
      `,
      [dot]
    );

    res.json({ ok: true, documents: r.rows });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});


// GET a signed URL to view/download the PDF

app.get("/api/insurance/documents/:id/signed-url", async (req, res) => {
  try {
    const { id } = req.params;

    const r = await pool.query(
      `
      SELECT id, dot_number, spaces_key, file_url
      FROM insurance_documents
      WHERE id = $1
      `,
      [id]
    );

    if (r.rowCount === 0) throw new Error("Document not found.");

    const doc = r.rows[0];

    // If you didn't add spaces_key, you'd need to parse it out of file_url here.
    if (!doc.spaces_key) throw new Error("spaces_key is missing for this document.");

    const command = new GetObjectCommand({
      Bucket: process.env.SPACES_BUCKET,
      Key: doc.spaces_key,
      ResponseContentType: "application/pdf",
      // optional: force download instead of inline viewing
      // ResponseContentDisposition: `attachment; filename="COI-${doc.dot_number}.pdf"`
    });

    const signedUrl = await getSignedUrl(s3, command, { expiresIn: 60 * 10 }); // 10 minutes

    res.json({
      ok: true,
      id: doc.id,
      dot_number: doc.dot_number,
      signedUrl
    });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});


// Mailgun Stuff
const { sendContractEmail } = require("./mailgun");
function makeToken() {
  return crypto.randomBytes(24).toString("hex");
}


// If you're behind a proxy (DigitalOcean App Platform), this helps cookies work correctly
app.set('trust proxy', 1);

// Serve static files (index.html, carrier.html, style1.css, etc.)
app.use(express.static(path.join(__dirname, "static")));

// Parse JSON bodies for POST/PUT
app.use(express.json());

// Session middleware
app.use(session({
  secret: process.env.SESSION_SECRET || 'dev-secret-change-me', // set real one in env later
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production'  // true on DO with https, false locally
  }
}));


/**
 * HARD-CODED Postgres connection (same idea as your OLD version).
 * Put back the exact values you used when it was working.
 */


/** ---------- AUTH HELPERS & ROUTES ---------- **/


function normalizeSpaces(s) {
  return String(s || "").replace(/\s+/g, " ").trim();
}

// Try to isolate the “COVERAGES” block so we only search limits where they actually appear.
function sliceCoveragesBlock(text) {
  const t = text || "";
  const upper = t.toUpperCase();

  const startIdx = upper.indexOf("COVERAGES");
  if (startIdx === -1) return t; // fallback to full doc

  // End anchors that often appear after the coverages section on ACORD 25
  const endAnchors = [
    "DESCRIPTION OF OPERATIONS",
    "CERTIFICATE HOLDER",
    "CANCELLATION",
    "SHOULD ANY OF THE ABOVE DESCRIBED POLICIES"
  ];

  let endIdx = t.length;
  for (const a of endAnchors) {
    const i = upper.indexOf(a, startIdx + 50);
    if (i !== -1 && i < endIdx) endIdx = i;
  }

  return t.slice(startIdx, endIdx);
}

function extractMaxMoney(str) {
  const moneyMatches = String(str || "").match(/\$?\s?\d{1,3}(?:,\d{3})+(?:\.\d{2})?/g);
  if (!moneyMatches || moneyMatches.length === 0) return null;

  const nums = moneyMatches.map(parseMoney).filter(Boolean);
  if (!nums.length) return null;
  return Math.max(...nums);
}

// Find the best limit near one of several keywords, inside a chosen block of text.
function extractLimitNearAny(blockText, keywords, { windowBefore = 120, windowAfter = 1200 } = {}) {
  const t = blockText || "";
  const upper = t.toUpperCase();

  let best = null;

  for (const kw of keywords) {
    const idx = upper.indexOf(String(kw).toUpperCase());
    if (idx === -1) continue;

    const window = t.slice(Math.max(0, idx - windowBefore), Math.min(t.length, idx + windowAfter));
    const money = extractMaxMoney(window);
    if (money && (!best || money > best)) best = money;
  }

  return best;
}



// helper: require that user is logged in
function requireAuth(req, res, next) {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ error: 'Not logged in' });
  }
  next();
}



// login: expects { "email": "x", "password": "y" }
app.post('/api/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ error: 'email and password required' });
  }

  try {
    const result = await pool.query(
      'SELECT id, password_hash FROM users WHERE email = $1',
      [email]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const user = result.rows[0];
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // success → set session
    req.session.userId = user.id;
    res.json({ ok: true });
  } catch (err) {
    console.error('Error in POST /api/login:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// logout
app.post('/api/logout', (req, res) => {
  req.session.destroy(() => {
    res.json({ ok: true });
  });
});

/** ---------- CONTRACT PDF (token-gated) ---------- **/
app.get("/contract/:token/pdf", async (req, res) => {
  const token = String(req.params.token || "").trim();
  if (!token) return res.status(400).send("Missing token");

  try {
    // 1) Lookup contract + template key
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

    // 2) Expiration check
    if (row.token_expires_at && new Date(row.token_expires_at) < new Date()) {
      return res.status(410).send("This link has expired");
    }

    // 3) Validate storage fields
    if (row.storage_provider !== "DO_SPACES") {
      return res.status(500).send("Storage provider not configured");
    }
    if (!row.storage_key) {
      return res.status(500).send("Missing storage key");
    }

    // 4) Stream PDF from Spaces
const Bucket = process.env.SPACES_BUCKET;
    const Key = row.storage_key;

    const obj = spaces.getObject({ Bucket, Key }).createReadStream();

    // If the stream errors (missing key, perms), return 404/500
    obj.on("error", (err) => {
      console.error("SPACES getObject error:", err?.code, err?.message, err);
      if (err?.code === "NoSuchKey") return res.status(404).send("PDF not found");
      return res.status(500).send("Failed to load PDF");
    });

    // 5) Headers for inline display
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", "inline; filename=\"contract.pdf\"");
    res.setHeader("Cache-Control", "no-store");

    // 6) Pipe it
    obj.pipe(res);
  } catch (err) {
    console.error("GET /contract/:token/pdf error:", err?.message, err);
    return res.status(500).send("Server error");
  }
});

/** ---------- CONTRACT LANDING PAGE (token + ACK UI) ---------- **/
app.get("/contract/:token", async (req, res) => {
  const token = String(req.params.token || "").trim();
  if (!token) return res.status(400).send("Missing token");

  try {
    // Validate token + not expired + pull status
    const { rows } = await pool.query(
      `
      SELECT contract_id, token_expires_at, status
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

    // Flip to VIEWED (only if not already)
    await pool.query(
      `
      UPDATE public.contracts
      SET status = 'VIEWED', updated_at = NOW()
      WHERE token = $1 AND status NOT IN ('VIEWED','ACKNOWLEDGED','SIGNED');
      `,
      [token]
    );

    const pdfUrl = `/contract/${encodeURIComponent(token)}/pdf`;
    const alreadyAccepted = (contract.status === "ACKNOWLEDGED" || contract.status === "SIGNED");

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.send(`<!doctype html>
<html>
<head>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Carrier Agreement</title>
  <style>
    body { margin:0; font-family: Arial, sans-serif; background:#0b1220; color:#e6eefc; }
    .wrap { max-width: 980px; margin: 0 auto; padding: 20px; }
    .top { display:flex; align-items:center; justify-content:space-between; gap:12px; margin-bottom:12px; }
    .brand { font-weight:800; letter-spacing:0.2px; }
    .btn { display:inline-block; padding:10px 14px; border-radius:10px; background:#2b6cff; color:#fff; text-decoration:none; font-weight:700; }
    .card { background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.12); border-radius: 16px; padding: 12px; }
    iframe { width:100%; height: 70vh; border:0; border-radius: 12px; background:#fff; }
    .muted { opacity:0.85; font-size: 13px; margin-top:10px; }
    .form { margin-top: 14px; display:grid; gap:10px; }
    .row { display:grid; grid-template-columns: 1fr 1fr; gap:10px; }
    .row > div { display:flex; flex-direction:column; gap:6px; }
    label { font-size: 13px; opacity:0.9; }
    input[type="text"], input[type="email"] {
      padding:10px 12px; border-radius:10px; border:1px solid rgba(255,255,255,0.18);
      background: rgba(255,255,255,0.06); color:#e6eefc; outline:none;
    }
    input[type="checkbox"] { transform: scale(1.2); }
    .checkline { display:flex; gap:10px; align-items:flex-start; }
    .submitline { display:flex; gap:10px; align-items:center; justify-content:space-between; flex-wrap:wrap; }
    .btn2 { padding:12px 16px; border-radius:10px; background:#22c55e; color:#06220f; border:0; font-weight:800; cursor:pointer; }
    .btn2[disabled] { opacity:0.6; cursor:not-allowed; }
    .msg { font-size: 14px; }
    .ok { color: #86efac; }
    .err { color: #fca5a5; }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="top">
      <div class="brand">Carrier Shark — Carrier Agreement</div>
      <a class="btn" href="${pdfUrl}" target="_blank" rel="noopener">Open PDF</a>
    </div>

    <div class="card">
      <iframe src="${pdfUrl}"></iframe>
      <div class="muted">If the PDF doesn’t display on your device, tap “Open PDF”.</div>

      <div class="form" id="ackWrap">
        ${
          alreadyAccepted
            ? `<div class="msg ok"><strong>Accepted.</strong> This agreement has already been acknowledged.</div>`
            : `
        <div class="checkline">
          <input id="ack" type="checkbox" />
          <div>
            <div style="font-weight:700;">I acknowledge and accept this agreement.</div>
            <div class="muted">By submitting, you confirm you are authorized to accept on behalf of the carrier.</div>
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
    (function () {
      const alreadyAccepted = ${alreadyAccepted ? "true" : "false"};
      if (alreadyAccepted) return;

      const token = ${JSON.stringify(token)};
      const ackEl = document.getElementById("ack");
      const nameEl = document.getElementById("name");
      const titleEl = document.getElementById("title");
      const emailEl = document.getElementById("email");
      const btn = document.getElementById("submitBtn");
      const msg = document.getElementById("msg");

      function setMsg(text, cls) {
        msg.className = "msg " + (cls || "");
        msg.textContent = text || "";
      }

      btn.addEventListener("click", async () => {
        setMsg("");

        const ack = ackEl.checked;
        const name = (nameEl.value || "").trim();
        const title = (titleEl.value || "").trim();
        const email = (emailEl.value || "").trim();

        if (!ack) return setMsg("Please check the acknowledgment box.", "err");
        if (!name) return setMsg("Name is required.", "err");
        if (!title) return setMsg("Title is required.", "err");

        btn.disabled = true;
        btn.textContent = "Submitting...";

        try {
          const resp = await fetch("/contract/" + encodeURIComponent(token) + "/ack", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ack: true, name, title, email: email || null })
          });

          const data = await resp.json().catch(() => ({}));

          if (!resp.ok) {
            setMsg(data.error || "Failed to submit.", "err");
          } else {
            setMsg("Accepted. You may close this page.", "ok");
            btn.textContent = "Accepted";
            btn.disabled = true;
          }
        } catch (e) {
          setMsg("Network error. Please try again.", "err");
          btn.disabled = false;
          btn.textContent = "Accept Agreement";
        }
      });
    })();
  </script>
</body>
</html>`);
  } catch (err) {
    console.error("GET /contract/:token error:", err?.message, err);
    return res.status(500).send("Server error");
  }
});




/** ---------- CONTRACT SEND ROUTE ---------- **/
app.post("/api/contracts/send/:dot", requireAuth, async (req, res) => {
  const dotnumber = req.params.dot;
  const { user_contract_id, email_to } = req.body || {};
  const user_id = req.session.userId;

  if (!user_id) {
    return res.status(401).json({ error: "Not authenticated" });
  }

  if (!user_contract_id || !email_to) {
    return res.status(400).json({
      error: "user_contract_id and email_to are required"
    });
  }

  const token = makeToken();
  const token_expires_at = new Date(Date.now() + 72 * 60 * 60 * 1000);
  const link = `https://carriershark.com/contract/${token}`;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // ✅ Verify the contract template belongs to this user AND is usable
    const templateCheck = await client.query(
      `
      SELECT 1
      FROM public.user_contracts
      WHERE id = $1
        AND user_id = $2
        AND storage_provider = 'DO_SPACES'
        AND storage_key IS NOT NULL
      `,
      [user_contract_id, user_id]
    );

    if (templateCheck.rowCount === 0) {
      throw Object.assign(
        new Error("Invalid or unauthorized contract template"),
        { statusCode: 400 }
      );
    }

    // ✅ Insert contract record
    const insertSql = `
      INSERT INTO public.contracts
        (
          user_id,
          dotnumber,
          status,
          channel,
          provider,
          payload,
          sent_at,
          token,
          token_expires_at,
          email_to,
          user_contract_id
        )
      VALUES
        (
          $1,
          $2,
          'SENT',
          'EMAIL',
          'MAILGUN',
          '{}'::jsonb,
          NOW(),
          $3,
          $4,
          $5,
          $6
        )
      RETURNING contract_id;
    `;

    const { rows } = await client.query(insertSql, [
      user_id,
      dotnumber,
      token,
      token_expires_at.toISOString(),
      email_to,
      user_contract_id
    ]);

    const contract_id = rows[0]?.contract_id;
    if (!contract_id) {
      throw new Error("Failed to create contract");
    }

    // ✅ Send email
    await sendContractEmail({
      to: email_to,
      dotnumber,
      link
    });

    await client.query("COMMIT");

    return res.json({
      ok: true,
      contract_id,
      status: "SENT",
      link
    });

  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {}

    console.error("SEND CONTRACT ERROR:", err);

    return res.status(err.statusCode || 500).json({
      error: err.message || "Failed to send contract"
    });

  } finally {
    client.release();
  }
});




/** ---------- CONTRACT ACK (token-gated) ---------- **/
app.post("/contract/:token/ack", async (req, res) => {
  const token = String(req.params.token || "").trim();
  if (!token) return res.status(400).json({ error: "Missing token" });

  const { ack, name, title, email } = req.body || {};

  // basic validation
  if (ack !== true) {
    return res.status(400).json({ error: "ack must be true" });
  }
  if (!name || !String(name).trim()) {
    return res.status(400).json({ error: "name is required" });
  }
  if (!title || !String(title).trim()) {
    return res.status(400).json({ error: "title is required" });
  }

  const accepted_name = String(name).trim();
  const accepted_title = String(title).trim();
  const accepted_email = email ? String(email).trim() : null;

  // capture audit info
  const accepted_ip =
    (req.headers["x-forwarded-for"] ? String(req.headers["x-forwarded-for"]).split(",")[0].trim() : null)
    || req.ip
    || null;

  const accepted_user_agent = req.get("user-agent") || null;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // 1) validate token + not expired, get contract_id
    const contractRes = await client.query(
      `
      SELECT contract_id, token_expires_at
      FROM public.contracts
      WHERE token = $1
      LIMIT 1;
      `,
      [token]
    );

    if (contractRes.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Invalid link" });
    }

    const contract_id = contractRes.rows[0].contract_id;
    const token_expires_at = contractRes.rows[0].token_expires_at;

    if (token_expires_at && new Date(token_expires_at) < new Date()) {
      await client.query("ROLLBACK");
      return res.status(410).json({ error: "This link has expired" });
    }

    // 2) insert acceptance (idempotent per contract_id)
    await client.query(
      `
      INSERT INTO public.contract_acceptances
        (contract_id, method, accepted_name, accepted_title, accepted_email, accepted_ip, accepted_user_agent)
      VALUES
        ($1, 'ACK', $2, $3, $4, $5, $6)
      ON CONFLICT (contract_id) DO UPDATE
        SET method = EXCLUDED.method,
            accepted_name = EXCLUDED.accepted_name,
            accepted_title = EXCLUDED.accepted_title,
            accepted_email = EXCLUDED.accepted_email,
            accepted_at = NOW(),
            accepted_ip = EXCLUDED.accepted_ip,
            accepted_user_agent = EXCLUDED.accepted_user_agent;
      `,
      [contract_id, accepted_name, accepted_title, accepted_email, accepted_ip, accepted_user_agent]
    );

    // 3) update contract status
    await client.query(
      `
      UPDATE public.contracts
      SET status = 'ACKNOWLEDGED',
          signed_at = NOW(),
          updated_at = NOW()
      WHERE contract_id = $1;
      `,
      [contract_id]
    );

    await client.query("COMMIT");
    return res.json({ ok: true, contract_id, status: "ACKNOWLEDGED" });
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch {}
    console.error("POST /contract/:token/ack error:", err?.message, err);
    return res.status(500).json({ error: "Failed to acknowledge contract" });
  } finally {
    client.release();
  }
});


/** ---------- CONTRACT TEMPLATES (broker-side) ---------- **/
app.get("/api/user-contracts", requireAuth, async (req, res) => {
  const userId = req.session.userId;

  try {
    const { rows } = await pool.query(
      `
      SELECT
        id,
        name,
        version,
        storage_provider,
        storage_key,
        created_at
      FROM public.user_contracts
      WHERE user_id = $1
      ORDER BY created_at DESC;
      `,
      [userId]
    );

    res.json({ rows });
  } catch (err) {
    console.error("GET /api/user-contracts error:", err);
    res.status(500).json({ error: "Failed to load contract templates" });
  }
});






/** ---------- LATEST CONTRACT FOR DOT (broker-side) ---------- **/
app.get("/api/contracts/latest/:dot", requireAuth, async (req, res) => {
  const userId = req.session.userId;
  const dotnumber = String(req.params.dot || "").trim();

  if (!dotnumber) return res.status(400).json({ error: "dot is required" });

  try {
    const { rows } = await pool.query(
      `
      SELECT
        c.contract_id,
        c.user_id,
        c.dotnumber,
        c.status,
        c.channel,
        c.provider,
        c.email_to,
        c.sent_at,
        c.signed_at,
        c.created_at,
        c.updated_at,
        c.user_contract_id,
        uc.name AS contract_name,
        uc.version AS contract_version,
        ca.method AS acceptance_method,
        ca.accepted_at,
        ca.accepted_name,
        ca.accepted_title,
        ca.accepted_email,
        ca.accepted_ip
      FROM public.contracts c
      LEFT JOIN public.user_contracts uc
        ON uc.id = c.user_contract_id
      LEFT JOIN public.contract_acceptances ca
        ON ca.contract_id = c.contract_id
      WHERE c.user_id = $1
        AND c.dotnumber = $2
      ORDER BY c.created_at DESC
      LIMIT 1;
      `,
      [userId, dotnumber]
    );

    if (rows.length === 0) return res.json({ row: null });

    res.json({ row: rows[0] });
  } catch (err) {
    console.error("GET /api/contracts/latest/:dot error:", err);
    res.status(500).json({ error: "Failed to load latest contract" });
  }
});






app.get("/api/contracts/:dot", requireAuth, async (req, res) => {
  const userId = req.session.userId;
  const dotnumber = String(req.params.dot || "").trim();

  try {
    const { rows } = await pool.query(
      `
      SELECT
        contract_id, status, email_to, sent_at, created_at, updated_at, user_contract_id
      FROM public.contracts
      WHERE user_id = $1 AND dotnumber = $2
      ORDER BY created_at DESC
      LIMIT 50;
      `,
      [userId, dotnumber]
    );

    res.json({ rows });
  } catch (err) {
    console.error("GET /api/contracts/:dot error:", err);
    res.status(500).json({ error: "Failed to load contract history" });
  }
});




// API key auth for /api/v1
async function apiAuth(req, res, next) {
  try {
    const auth = req.header('Authorization') || '';
    const token = auth.replace('Bearer ', '').trim();

    if (!token) {
      return res.status(401).json({ error: 'Missing API token' });
    }

    const result = await pool.query(
      'SELECT id FROM users WHERE api_key = $1 LIMIT 1;',
      [token]
    );

    if (result.rowCount === 0) {
      return res.status(401).json({ error: 'Invalid API token' });
    }

    req.user = { id: result.rows[0].id };
    next();
  } catch (err) {
    console.error('Error in apiAuth middleware:', err);
    res.status(500).json({ error: 'Auth error' });
  }
}



/** ---------- API v1 Router ---------- **/
const createApiV1 = require('./api-v1');
const apiV1 = createApiV1(pool);        // only pass pool now

// protect all /api/v1 routes with API key auth
app.use('/api/v1', apiAuth, apiV1);



// GET /api/carrier-search?q=...
// Returns top 10 matches for DOT / MC / name
app.get('/api/carrier-search', async (req, res) => {
  const q = (req.query.q || '').trim();

  // Require at least 2 chars, like the front-end
  if (q.length < 2) {
    return res.json([]);
  }

  const isNumeric  = /^\d+$/.test(q);
  const likePrefix = q + '%';
  const nameLike   = '%' + q.toLowerCase() + '%';

  try {
    const result = await pool.query(
      `
      SELECT
        dotnumber AS dot,
        mc_number,
        legalname,
        dbaname,
        phycity,
        phystate
      FROM public.carriers
      WHERE
        (
          $1::boolean
          AND (
            dotnumber::text ILIKE $2
            OR mc_number::text ILIKE $2
          )
        )
        OR
        (
          NOT $1::boolean
          AND (
            lower(legalname) LIKE $3
            OR lower(dbaname)  LIKE $3
          )
        )
      ORDER BY legalname
      LIMIT 10;
      `,
      [
        isNumeric,   // $1
        likePrefix,  // $2
        nameLike     // $3
      ]
    );

    res.json(result.rows);
  } catch (err) {
    console.error('carrier-search error', err);
    res.status(500).json({ error: 'Search failed' });
  }
});



/** ---------- MY CARRIERS ROUTES ---------- **/

// Get list of carriers saved by this user (paginated + sortable)
app.get('/api/my-carriers', requireAuth, async (req, res) => {
  try {
    const userId = req.session.userId;

    const page     = parseInt(req.query.page, 10)     || 1;
    const pageSize = parseInt(req.query.pageSize, 10) || 25;
    const offset   = (page - 1) * pageSize;

    // ----- NEW: read sort params -----
    const sortBy = req.query.sortBy || null;
    const sortDir = (req.query.sortDir || 'asc').toLowerCase() === 'desc'
      ? 'DESC'
      : 'ASC';

    // ----- NEW: map UI columns → real database columns safely -----
    const sortMap = {
      dot:      'c.dotnumber',
      mc:       'c.mc_number',
      carrier:  "COALESCE(c.legalname, c.dbaname)", 
      location: "COALESCE(c.phycity,'') || ', ' || COALESCE(c.phystate,'')",
      operating: "c.allowedtooperate",
      common:    "c.commonauthoritystatus",
      contract:  "c.contractauthoritystatus",
      broker:    "c.brokerauthoritystatus",
      safety:    "c.safetyrating"
    };

    // fallback if missing or invalid
    const orderColumn = sortMap[sortBy] || 'uc.added_at';

    // ----- FINAL SQL (paginated + sorted) -----
    const dataSql = `
      SELECT
        c.dotnumber AS dot,
        c.*
      FROM user_carriers uc
      JOIN carriers c
        ON c.dotnumber = uc.carrier_dot
      WHERE uc.user_id = $1
      ORDER BY ${orderColumn} ${sortDir}
      LIMIT $2 OFFSET $3;
    `;

    const countSql = `
      SELECT COUNT(*)::int AS count
      FROM user_carriers
      WHERE user_id = $1;
    `;

    const [dataResult, countResult] = await Promise.all([
      pool.query(dataSql, [userId, pageSize, offset]),
      pool.query(countSql, [userId])
    ]);

    res.json({
      rows: dataResult.rows,
      total: countResult.rows[0].count,
      page,
      pageSize
    });

  } catch (err) {
    console.error('Error in GET /api/my-carriers:', err);
    res.status(500).json({ error: 'Failed to load user carriers' });
  }
});



// Save a new carrier for this user
app.post('/api/my-carriers', requireAuth, async (req, res) => {
  try {
    const userId = req.session.userId;
    const { dot } = req.body;

    if (!dot) {
      return res.status(400).json({ error: 'Carrier DOT required' });
    }

    const sql = `
      INSERT INTO user_carriers (user_id, carrier_dot)
      VALUES ($1, $2)
      ON CONFLICT (user_id, carrier_dot) DO NOTHING;
    `;

    await pool.query(sql, [userId, dot]);
    res.json({ ok: true });
  } catch (err) {
    console.error('Error in POST /api/my-carriers:', err);
    res.status(500).json({ error: 'Failed to add carrier' });
  }
});


// Bulk add carriers for this user
app.post('/api/my-carriers/bulk', requireAuth, async (req, res) => {
  try {
    const userId = req.session.userId;
    let { dots } = req.body || {};

    if (!Array.isArray(dots) || dots.length === 0) {
      return res.status(400).json({ error: 'dots array required' });
    }

    // clean + dedupe (numeric only)
    const uniqueDots = [...new Set(
      dots
        .map(d => String(d).trim())
        .filter(d => d && /^\d+$/.test(d))
    )];

    if (uniqueDots.length === 0) {
      return res.status(400).json({ error: 'No valid DOT numbers found' });
    }

    const sql = `
      WITH input(dot) AS (
        SELECT UNNEST($2::text[])
      ),
      valid AS (
        SELECT i.dot
        FROM input i
        JOIN carriers c ON c.dotnumber = i.dot
      ),
      ins AS (
        INSERT INTO user_carriers (user_id, carrier_dot, added_at)
        SELECT $1, v.dot, NOW()
        FROM valid v
        ON CONFLICT (user_id, carrier_dot) DO NOTHING
        RETURNING carrier_dot
      )
      SELECT
        (SELECT COUNT(*) FROM input)                    AS submitted,
        (SELECT COUNT(*) FROM valid)                    AS valid,
        (SELECT COUNT(*) FROM ins)                      AS inserted,
        (SELECT COUNT(*) FROM valid) - (SELECT COUNT(*) FROM ins) AS duplicates,
        (SELECT COUNT(*) FROM input) - (SELECT COUNT(*) FROM valid) AS invalid;
    `;

    const result = await pool.query(sql, [userId, uniqueDots]);
    const s = result.rows[0];

    return res.json({
      summary: {
        totalSubmitted: Number(s.submitted),
        inserted: Number(s.inserted),
        duplicates: Number(s.duplicates),
        invalid: Number(s.invalid)
      }
    });
  } catch (err) {
    console.error('Error in POST /api/my-carriers/bulk:', err);
    return res.status(500).json({ error: 'Failed to bulk add carriers' });
  }
});

// Preview bulk import (no DB writes)
app.post('/api/my-carriers/bulk/preview', requireAuth, async (req, res) => {
  try {
    const userId = req.session.userId;
    let { dots } = req.body || {};

    if (!Array.isArray(dots) || dots.length === 0) {
      return res.status(400).json({ error: 'dots array required' });
    }

    // clean + dedupe
    dots = dots
      .map(d => String(d).trim())
      .filter(d => d && /^\d+$/.test(d));

    const uniqueDots = [...new Set(dots)];

    if (uniqueDots.length === 0) {
      return res.status(400).json({ error: 'No valid DOT numbers found' });
    }

    // Get which dots exist in carriers
    const carriersRes = await pool.query(
      `
      SELECT dotnumber,
             COALESCE(legalname, dbaname) AS name,
             phycity,
             phystate
      FROM carriers
      WHERE dotnumber = ANY($1::text[]);
      `,
      [uniqueDots]
    );

    const carriersMap = new Map();
    carriersRes.rows.forEach(r => {
      carriersMap.set(r.dotnumber, {
        dot: r.dotnumber,
        name: r.name,
        city: r.phycity,
        state: r.phystate
      });
    });

    // Get which of those dots user already has
    const userRes = await pool.query(
      `
      SELECT carrier_dot
      FROM user_carriers
      WHERE user_id = $1
        AND carrier_dot = ANY($2::text[]);
      `,
      [userId, uniqueDots]
    );

    const userSet = new Set(userRes.rows.map(r => r.carrier_dot));

    const newList = [];
    const duplicates = [];
    const invalid = [];

    for (const dot of uniqueDots) {
      const carrier = carriersMap.get(dot);

      if (!carrier) {
        invalid.push({
          dot,
          status: 'invalid',
          name: null,
          city: null,
          state: null
        });
      } else if (userSet.has(dot)) {
        duplicates.push({
          ...carrier,
          status: 'duplicate'
        });
      } else {
        newList.push({
          ...carrier,
          status: 'new'
        });
      }
    }

    res.json({
      summary: {
        totalSubmitted: uniqueDots.length,
        new: newList.length,
        duplicates: duplicates.length,
        invalid: invalid.length
      },
      new: newList,
      duplicates,
      invalid
    });
  } catch (err) {
    console.error('Error in POST /api/my-carriers/bulk/preview:', err);
    res.status(500).json({ error: 'Failed to preview bulk import' });
  }
});




// Check if THIS dot is already saved for this user
app.get('/api/my-carriers/:dot', requireAuth, async (req, res) => {
  const userId = req.session.userId;
  const { dot } = req.params;

  try {
    const result = await pool.query(
      'SELECT 1 FROM user_carriers WHERE user_id = $1 AND carrier_dot = $2',
      [userId, dot]
    );

    if (result.rowCount > 0) {
      return res.json({ saved: true });
    } else {
      // 404 lets the frontend treat it as "not saved"
      return res.status(404).json({ saved: false });
    }
  } catch (err) {
    console.error('Error in GET /api/my-carriers/:dot:', err);
    res.status(500).json({ error: 'Failed to check carrier' });
  }
});

// Remove a carrier from this user's list
app.delete('/api/my-carriers/:dot', requireAuth, async (req, res) => {
  const userId = req.session.userId;
  const { dot } = req.params;

  try {
    const result = await pool.query(
      'DELETE FROM user_carriers WHERE user_id = $1 AND carrier_dot = $2',
      [userId, dot]
    );

    res.json({ ok: true, deleted: result.rowCount });
  } catch (err) {
    console.error('Error in DELETE /api/my-carriers/:dot:', err);
    res.status(500).json({ error: 'Failed to remove carrier' });
  }
});


/** ---------- CARRIER ROUTES ---------- **/

app.get('/api/carriers', async (req, res) => {
  try {
    const page     = parseInt(req.query.page, 10)     || 1;
    const pageSize = parseInt(req.query.pageSize, 10) || 25;
    const offset   = (page - 1) * pageSize;

    // ----- NEW: sorting -----
    const sortBy = req.query.sortBy || null;
    const sortDir = (req.query.sortDir || 'asc').toLowerCase() === 'desc'
      ? 'DESC'
      : 'ASC';

    // match UI → DB columns
    const sortMap = {
      dot:      'dotnumber',
      mc:       'mc_number',
      carrier:  "COALESCE(legalname, dbaname)",
      location: "COALESCE(phycity,'') || ', ' || COALESCE(phystate,'')",
      operating: "allowedtooperate",
      common:    "commonauthoritystatus",
      contract:  "contractauthoritystatus",
      broker:    "brokerauthoritystatus",
      safety:    "safetyrating"
    };

    const orderColumn = sortMap[sortBy] || 'dotnumber';

    const dataQuery = `
      SELECT
        dotnumber        AS dot,
        phystreet        AS address1,
        NULL             AS address2,
        phycity          AS city,
        phystate         AS state,
        phyzipcode       AS zip,
        TO_CHAR(retrieval_date::timestamp, 'Mon DD, YYYY HH12:MI AM EST') AS retrieval_date_formatted,
        *
      FROM public.carriers
      ORDER BY ${orderColumn} ${sortDir}
      LIMIT $1 OFFSET $2
    `;

    const countQuery = `SELECT COUNT(*)::int AS count FROM public.carriers`;

    const [dataResult, countResult] = await Promise.all([
      pool.query(dataQuery, [pageSize, offset]),
      pool.query(countQuery)
    ]);

    res.json({
      rows: dataResult.rows,
      total: countResult.rows[0].count,
      page,
      pageSize
    });
  } catch (err) {
    console.error('Error in GET /api/carriers:', err);
    res.status(500).json({ error: 'Database query failed' });
  }
});



/**
 * SINGLE CARRIER – used by /12345 page (carrier.html)
 */
app.get('/api/carriers/:dot', async (req, res) => {
  try {
    const dot = req.params.dot;
    console.log('Looking up carrier dot:', dot);

    // 1) Get base carrier row
    const carrierResult = await pool.query(`
      SELECT
        dotnumber        AS dot,
        phystreet as address1,
        null as address2,
        phycity as city,
        phystate as state,
        phyzipcode as zip,
        TO_CHAR(retrieval_date::timestamp, 'Mon DD, YYYY HH12:MI AM EST') AS retrieval_date_formatted,
        *
      FROM public.carriers
      WHERE dotnumber = $1;
    `, [dot]);

    if (carrierResult.rows.length === 0) {
      return res.status(404).json({ error: 'Carrier not found' });
    }

    const carrier = carrierResult.rows[0];

    // 2) Get cargo carried rows
    const cargoResult = await pool.query(
      `SELECT cargo_desc, cargo_class
       FROM public.cargo
       WHERE dot_number = $1
       ORDER BY cargo_desc;`,
      [dot]
    );

    // Convert row list → array of strings
    const cargoList = cargoResult.rows.map(r => r.cargo_desc);

    // 3) Attach it to the carrier object
    carrier.cargo_carried = cargoList;

    // 4) Return combined carrier object
    res.json(carrier);

  } catch (err) {
    console.error('Error in GET /api/carriers/:dot:', err);
    res.status(500).json({ error: 'Database query failed' });
  }
});

// ---------------- route ----------------

app.post("/api/insurance/documents/:id/parse", async (req, res) => {
  const client = await pool.connect();

  // Optional: allow forcing provider during testing
  // /parse?provider=VISION

  // Only Use Textract

const forcedProvider = "TEXTRACT";

  
  // Either or (saved for later
  //const forcedProvider = String(req.query.provider || "").toUpperCase().trim(); // "VISION" | "TEXTRACT" | ""

  try {
    const { id } = req.params;

    // ---------- 0) Lock + idempotency ----------
    await client.query("BEGIN");

    const r = await client.query(
      `
      SELECT id, dot_number, spaces_key, ocr_status, ocr_provider, parse_result
      FROM insurance_documents
      WHERE id = $1
      FOR UPDATE
      `,
      [id]
    );

    if (r.rowCount === 0) throw new Error("Document not found.");

    const doc = r.rows[0];
    if (!doc.spaces_key) throw new Error("spaces_key missing for this document.");

    // If already processing, block double-run
    if (doc.ocr_status === "PROCESSING") {
      await client.query("ROLLBACK");
      return res.status(409).json({ ok: false, error: "OCR already PROCESSING for this document." });
    }

    // If already done, return existing parse_result (idempotent)
    if (doc.ocr_status === "DONE" && doc.parse_result) {
      await client.query("ROLLBACK");
      return res.json({
        ok: true,
        document_id: id,
        dot_number: doc.dot_number,
        parseResult: doc.parse_result,
        reused: true
      });
    }

    // Mark processing (we'll update provider later once we choose)
    await client.query(
      `
      UPDATE insurance_documents
      SET ocr_status='PROCESSING',
          ocr_started_at=NOW(),
          ocr_attempts = COALESCE(ocr_attempts,0) + 1
      WHERE id=$1
      `,
      [id]
    );

    await client.query("COMMIT");

    // ---------- 1) Download PDF from Spaces ----------
    const obj = await s3.send(
      new GetObjectCommand({
        Bucket: process.env.SPACES_BUCKET,
        Key: doc.spaces_key
      })
    );

    const chunks = [];
    for await (const chunk of obj.Body) chunks.push(chunk);
    const pdfBuffer = Buffer.concat(chunks);

    // ---------- 2) OCR (Textract primary, Vision fallback) ----------
    let providerUsed = null;
    let text = "";
    let ocrMeta = {}; // keep provider-specific metadata
    let rawOcrForDb = null; // optional raw blob (keep small)

    const tryTextract = forcedProvider ? forcedProvider === "TEXTRACT" : true;
    const tryVision = forcedProvider ? forcedProvider === "VISION" : true;

    let textract = null;
    let vision = null;

    // --- Textract first ---
    if (tryTextract) {
      try {
        providerUsed = "AWS_TEXTRACT";
        await pool.query(
          `UPDATE insurance_documents SET ocr_provider='AWS_TEXTRACT' WHERE id=$1`,
          [id]
        );

        textract = await ocrPdfBufferWithTextract({
          pdfBuffer,
          objectKeyHint: `${doc.dot_number}/${id}`
        });

        text = textract.fullText || "";

//  HARD FAIL if Textract didn't produce usable text
if (!text || !text.trim()) {
  throw new Error("Textract OCR failed — Google fallback disabled");
}
        
        // Keep only small meta in parse_result; blocks are huge
        ocrMeta = {
          jobId: textract.jobId,
          inputS3Uri: textract.inputS3Uri,
          avgLineConfidence: textract.confidence?.avgLineConfidence ?? null,
          lineCount: textract.confidence?.lineCount ?? null,
          tableCount: textract.tables?.length ?? 0,
          keyCount: textract.keyValuePairs?.pairs?.length ?? 0
        };

        // Optional: store a compact raw snippet for debugging
        rawOcrForDb = {
          provider: "AWS_TEXTRACT",
          jobId: textract.jobId,
          inputS3Uri: textract.inputS3Uri,
          confidence: textract.confidence,
          // DO NOT store full blocks unless you add a jsonb column and accept size bloat
          // blocks: textract.blocks
        };
      } catch (e) {
        console.error("Textract failed, will fallback to Vision if enabled:", e?.message || e);
        textract = null;
        providerUsed = null;
      }
    }
/**
    // --- Vision fallback  commented out---
    if (!text && tryVision) {
      providerUsed = "GOOGLE_VISION";
      await pool.query(
        `UPDATE insurance_documents SET ocr_provider='GOOGLE_VISION' WHERE id=$1`,
        [id]
      );

      vision = await ocrPdfBufferWithVision({
        pdfBuffer,
        gcsBucket: process.env.GCS_OCR_BUCKET,
        gcsPrefix: `insurance-ocr/${doc.dot_number}/${id}`
      });

      text = vision.text || "";

      ocrMeta = {
        jobId: vision.jobId,
        avgConfidence: vision.avgConfidence,
        pageCount: vision.pageCount,
        inputUri: vision.gcs?.inputUri,
        outputUri: vision.gcs?.outputUri
      };

      rawOcrForDb = {
        provider: "GOOGLE_VISION",
        jobId: vision.jobId,
        avgConfidence: vision.avgConfidence,
        pageCount: vision.pageCount,
        gcs: vision.gcs
      };
    }
*/

    if (!text) {
      throw new Error("OCR failed (Textract + Vision).");
    }

    // ---------- 3) Your existing parsing logic (unchanged) ----------
    const acordLikely = isLikelyAcord25(text);
    const dates = findDates(text);

    const cleanedText = normalizeSpaces(text);
    const coveragesBlock = sliceCoveragesBlock(cleanedText);
    const coverageTypes = detectCoverageTypes(cleanedText);

    const hasAUTO = coverageTypes.includes("AUTO");
    const hasCARGO = coverageTypes.includes("CARGO");
    const hasGL = coverageTypes.includes("GL");

    const autoLimit = hasAUTO
      ? extractLimitNearAny(coveragesBlock, ["AUTOMOBILE LIABILITY", "AUTO LIABILITY", "AUTO LIAB"])
      : null;

    const cargoLimit = hasCARGO
      ? extractLimitNearAny(
          coveragesBlock,
          ["MOTOR TRUCK CARGO", "TRUCK CARGO", "CARGO"],
          { windowBefore: 80, windowAfter: 900 }
        )
      : null;

    const glLimit = hasGL
      ? extractLimitNearAny(coveragesBlock, ["GENERAL LIABILITY", "COMMERCIAL GENERAL LIABILITY", "GEN'L LIABILITY"])
      : null;

    const confidence = computeConfidence({
      acordLikely,
      auto: autoLimit,
      cargo: cargoLimit,
      gl: glLimit,
      datesCount: dates.length
    });

    const parseResult = {
      acordLikely,
      confidence,
      extracted: {
        auto_liability_limit: autoLimit,
        cargo_limit: cargoLimit,
        general_liability_limit: glLimit,
        detected_dates: dates,
        detected_coverage_types: coverageTypes
      },
      ocr: {
        provider: providerUsed,
        meta: ocrMeta
      }
    };

    // ---------- 4) Save document OCR + parse artifacts ----------
    // NOTE: you currently have many ocr_* columns oriented around Vision/GCS.
    // We'll fill what we can safely without breaking your schema.
    if (providerUsed === "AWS_TEXTRACT") {
      await pool.query(
        `
        UPDATE insurance_documents
        SET extracted_text = $1,
            ocr_provider = 'AWS_TEXTRACT',
            ocr_status = 'DONE',
            ocr_job_id = $2,
            ocr_avg_confidence = $3,
            ocr_input_uri = $4,
            ocr_output_uri = NULL,
            ocr_completed_at = NOW(),
            parse_result = $5::jsonb,
            parse_confidence = $6::numeric,
            parsed_at = NOW(),
            status = CASE WHEN $6::numeric >= 70 THEN status ELSE 'NEEDS_REVIEW' END
        WHERE id = $7
        `,
        [
          text,
          textract?.jobId || null,
          textract?.confidence?.avgLineConfidence ?? null,
          textract?.inputS3Uri || null,
          JSON.stringify(parseResult),
          confidence,
          id
        ]
      );
    } 
    /**

 else {
      // GOOGLE_VISION
      await pool.query(
        `
        UPDATE insurance_documents
        SET extracted_text = $1,
            ocr_provider = 'GOOGLE_VISION',
            ocr_status = 'DONE',
            ocr_job_id = $2,
            ocr_avg_confidence = $3,
            ocr_page_count = $4,
            ocr_input_uri = $5,
            ocr_output_uri = $6,
            ocr_completed_at = NOW(),
            parse_result = $7::jsonb,
            parse_confidence = $8::numeric,
            parsed_at = NOW(),
            status = CASE WHEN $8::numeric >= 70 THEN status ELSE 'NEEDS_REVIEW' END
        WHERE id = $9
        `,
        [
          text,
          vision?.jobId || null,
          vision?.avgConfidence ?? null,
          vision?.pageCount ?? null,
          vision?.gcs?.inputUri || null,
          vision?.gcs?.outputUri || null,
          JSON.stringify(parseResult),
          confidence,
          id
        ]
      );
    }
*/
    // ---------- 5) Promote to snapshots (your existing logic) ----------
    let newSnapshotVersion = null;

    if (confidence >= 70) {
      const upsert = await pool.query(
        `
        INSERT INTO insurance_snapshots
          (dot_number, auto_liability_limit, cargo_limit, general_liability_limit,
           source, vendor, last_checked_at, snapshot_version, raw_payload_json)
        VALUES
          ($1, $2, $3, $4,
           'PARSED', 'INTERNAL', NOW(), 1, $5)
        ON CONFLICT (dot_number)
        DO UPDATE SET
          auto_liability_limit = EXCLUDED.auto_liability_limit,
          cargo_limit = EXCLUDED.cargo_limit,
          general_liability_limit = EXCLUDED.general_liability_limit,
          source = EXCLUDED.source,
          vendor = EXCLUDED.vendor,
          last_checked_at = NOW(),
          snapshot_version = insurance_snapshots.snapshot_version + 1,
          raw_payload_json = EXCLUDED.raw_payload_json
        RETURNING snapshot_version
        `,
        [doc.dot_number, autoLimit, cargoLimit, glLimit, parseResult]
      );

      newSnapshotVersion = upsert.rows[0]?.snapshot_version ?? 1;

      await pool.query(
        `DELETE FROM insurance_coverages WHERE dot_number = $1 AND snapshot_version = $2`,
        [doc.dot_number, newSnapshotVersion]
      );

      for (const ct of coverageTypes) {
        let limits = {};
        if (ct === "AUTO" && autoLimit) limits = { combined_single_limit: autoLimit };
        if (ct === "CARGO" && cargoLimit) limits = { cargo: cargoLimit };
        if (ct === "GL" && glLimit) limits = { each_occurrence: glLimit };

        await pool.query(
          `
          INSERT INTO insurance_coverages
            (dot_number, snapshot_version, coverage_type, limits_json)
          VALUES
            ($1, $2, $3, $4)
          `,
          [doc.dot_number, newSnapshotVersion, ct, limits]
        );
      }
    }

    return res.json({
      ok: true,
      document_id: id,
      dot_number: doc.dot_number,
      ocr_provider: providerUsed,
      parseResult,
      promoted_to_snapshot: confidence >= 70,
      snapshot_version: newSnapshotVersion
    });

  } catch (err) {
    // Mark FAILED (best effort)
    try {
      await pool.query(
        `
        UPDATE insurance_documents
        SET ocr_status = 'FAILED',
            ocr_error = $2,
            ocr_completed_at = NOW()
        WHERE id = $1
        `,
        [req.params.id, String(err?.message || err)]
      );
    } catch {}

    // Important: rollback only if we still have a txn open
    try { await client.query("ROLLBACK"); } catch {}

    return res.status(400).json({ ok: false, error: err.message });
  } finally {
    client.release();
  }
});



app.get("/api/_debug/spaces", async (req, res) => {
  try {
    const AWS = require("aws-sdk");

    const s3 = new AWS.S3({
      endpoint: `https://${process.env.SPACES_REGION}.digitaloceanspaces.com`,
      accessKeyId: process.env.SPACES_KEY,
      secretAccessKey: process.env.SPACES_SECRET,
      s3ForcePathStyle: true,
      signatureVersion: "v4"
    });

    const result = await s3.listObjectsV2({
      Bucket: process.env.SPACES_BUCKET,
      MaxKeys: 5
    }).promise();

    res.json({ ok: true, objects: result.Contents || [] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});







/**
 * PRETTY URL: /12345 → serve carrier.html
 * This must be AFTER /api/* routes.
 */





app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});



