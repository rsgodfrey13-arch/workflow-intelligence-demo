// src/services/carrierRefreshService.js

const axios = require("axios");
const { pool } = require("../db/pool");

const FMCSA_BASE = "https://mobile.fmcsa.dot.gov/qc/services/carriers";
const FRESHNESS_MINUTES = 5; // skip refresh if already fresh

function mapFmcsaToCarrier(raw) {
  return {
    legalname: raw?.legalName || null,
    dbaname: raw?.dbaName || null,
    statuscode: raw?.statusCode || null,
    allowedtooperate: raw?.allowedToOperate || null,
    safetyrating: raw?.safetyRating || null,
  };
}

async function fetchFromFmcsa(dot) {
  const apiKey = process.env.fmcsa_web_key;
  if (!apiKey) throw new Error("fmcsa_web_key missing");

  const url = `${FMCSA_BASE}/${encodeURIComponent(dot)}?webKey=${apiKey}`;

  try {
    const response = await axios.get(url, { timeout: 10000 });
    const carrier = response?.data?.content?.carrier;

    if (!carrier) {
      throw new Error("Carrier not found in FMCSA response");
    }

    return carrier;
  } catch (err) {
    if (err?.response?.status === 429) {
      const e = new Error("Rate limited");
      e.status = 429;
      throw e;
    }
    throw err;
  }
}

async function refreshCarrier(dot) {
  if (!dot) throw new Error("Missing DOT");

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // 1) Check freshness first
    const existing = await client.query(
      `
      SELECT retrieval_date
      FROM carriers
      WHERE dotnumber = $1
      `,
      [dot]
    );

    if (existing.rows.length) {
      const last = existing.rows[0].retrieval_date;

      if (last) {
        const diffMinutes = (Date.now() - new Date(last).getTime()) / 60000;
        if (diffMinutes < FRESHNESS_MINUTES) {
          await client.query("COMMIT");
          return { skipped: true };
        }
      }
    }

    // 2) Fetch FMCSA
    const fmcsaData = await fetchFromFmcsa(dot);

    // 3) Map to schema
    const mapped = mapFmcsaToCarrier(fmcsaData);

    // 4) Upsert
    await client.query(
      `
      INSERT INTO carriers (
        dotnumber,
        legalname,
        dbaname,
        statuscode,
        allowedtooperate,
        safetyrating,
        retrieval_date,
        updated_at
      )
      VALUES ($1,$2,$3,$4,$5,$6,NOW(),NOW())
      ON CONFLICT (dotnumber)
      DO UPDATE SET
        legalname = EXCLUDED.legalname,
        dbaname = EXCLUDED.dbaname,
        statuscode = EXCLUDED.statuscode,
        allowedtooperate = EXCLUDED.allowedtooperate,
        safetyrating = EXCLUDED.safetyrating,
        retrieval_date = NOW(),
        updated_at = NOW()
      `,
      [
        dot,
        mapped.legalname,
        mapped.dbaname,
        mapped.statuscode,
        mapped.allowedtooperate,
        mapped.safetyrating,
      ]
    );

    await client.query("COMMIT");
    return { ok: true };
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch (_) {}

    // let worker handle backoff
    if (err && err.status === 429) throw err;

    console.error("refreshCarrier error:", err);
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { refreshCarrier };
