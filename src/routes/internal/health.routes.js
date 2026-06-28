"use strict";

const express = require("express");
const axios = require("axios");
const https = require("https");

const httpsAgent = new https.Agent({ rejectUnauthorized: false });

function healthRoutes({ pool }) {
  const router = express.Router();

  router.get("/health", async (req, res) => {
    const started = Date.now();
    const out = { status: "ok", checks: {}, ms: {} };

    try {
      // Public
      {
        const t = Date.now();
        await axios.get("https://carriershark.com/healthz", { timeout: 2000 });
        out.checks.public = true;
        out.ms.public = Date.now() - t;
      }

      // Internal router alive
      {
        const t = Date.now();
        await axios.get("https://carriershark.com/api/health-internal", { timeout: 2000 });
        out.checks.internal = true;
        out.ms.internal = Date.now() - t;
      }

      // External v1 router alive (no auth)
      {
        const t = Date.now();
        await axios.get("https://carriershark.com/api/v1/health-external", { timeout: 2000 });
        out.checks.external_v1 = true;
        out.ms.external_v1 = Date.now() - t;
      }

      // Postgres
      {
        const t = Date.now();
        await pool.query("SELECT 1");
        out.checks.postgres = true;
        out.ms.postgres = Date.now() - t;
      }

// 5) NiFi (authenticated)
{
  const t = Date.now();

  const baseUrl = process.env.NIFI_BASE_URL || "https://129.212.189.13:8443";
  const username = process.env.NIFI_USERNAME;
  const password = process.env.NIFI_PASSWORD;

  if (!username || !password) {
    throw new Error("NiFi creds missing: set NIFI_USERNAME and NIFI_PASSWORD");
  }

  // NiFi: create access token
  const tokenResp = await axios.post(
    `${baseUrl}/nifi-api/access/token`,
    new URLSearchParams({ username, password }).toString(),
    {
      timeout: 2000,
      httpsAgent,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    }
  );

  const token = tokenResp.data;

  // Use token to hit diagnostics
  await axios.get(`${baseUrl}/nifi-api/system-diagnostics`, {
    timeout: 2000,
    httpsAgent,
    headers: { Authorization: `Bearer ${token}` },
  });

  out.checks.nifi = true;
  out.ms.nifi = Date.now() - t;
}


      out.ms.total = Date.now() - started;
      return res.status(200).json(out);
    } catch (err) {
      out.status = "error";
      out.error = err.message;
      out.ms.total = Date.now() - started;
      return res.status(500).json(out);
    }
  });

  return router;
}

module.exports = { healthRoutes };
