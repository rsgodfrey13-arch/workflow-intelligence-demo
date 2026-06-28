// src/workers/carrierRefreshWorker.js

const THROTTLE_MS = 700;
const IDLE_SLEEP_MS = 500;
const LOOP_ERROR_SLEEP_MS = 2000;
const RATE_LIMIT_SLEEP_MS = 10000;

let refreshCarrierFnCached = null;

async function getRefreshCarrierFn() {
  if (refreshCarrierFnCached) return refreshCarrierFnCached;

  // Dynamic import so CommonJS can load an ESM module (even if it uses top-level await).
  const mod = await import("../services/carrierRefreshService.js");

  // Support a few export styles:
  // 1) export function refreshCarrier() {}
  // 2) export default function refreshCarrier() {}
  // 3) export default { refreshCarrier: fn }
  const fn =
    mod.refreshCarrier ||
    mod.default?.refreshCarrier ||
    mod.default;

  if (typeof fn !== "function") {
    throw new Error(
      "carrierRefreshService.js must export a function (refreshCarrier)."
    );
  }

  refreshCarrierFnCached = fn;
  return refreshCarrierFnCached;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Claim exactly 1 PENDING row (SKIP LOCKED) and mark it RUNNING.
 * Returns the claimed row or null if none available.
 */
async function claimNextRow(db) {
  const result = await db.query(`
    WITH next AS (
      SELECT id
      FROM carrier_refresh_queue
      WHERE status = 'PENDING'
      ORDER BY priority DESC, created_at ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    UPDATE carrier_refresh_queue q
    SET status = 'RUNNING',
        updated_at = NOW()
    FROM next
    WHERE q.id = next.id
    RETURNING q.*;
  `);

  return result.rows[0] || null;
}

async function markQueueComplete(db, rowId) {
  await db.query(
    `
    UPDATE carrier_refresh_queue
    SET status = 'COMPLETE',
        updated_at = NOW()
    WHERE id = $1
    `,
    [rowId]
  );
}

async function markQueueFailedOrRetry(db, rowId, errMsg) {
  await db.query(
    `
    UPDATE carrier_refresh_queue
    SET
      attempts = attempts + 1,
      last_error = $2,
      status = CASE
        WHEN attempts + 1 >= 5 THEN 'FAILED'
        ELSE 'PENDING'
      END,
      updated_at = NOW()
    WHERE id = $1
    `,
    [rowId, errMsg]
  );
}

async function incrementJobCompleted(db, jobId) {
  await db.query(
    `
    UPDATE carrier_verification_jobs
    SET completed = completed + 1
    WHERE id = $1
    `,
    [jobId]
  );
}

async function maybeCompleteJob(db, jobId) {
  await db.query(
    `
    UPDATE carrier_verification_jobs
    SET status = 'COMPLETE',
        completed_at = NOW()
    WHERE id = $1
      AND completed >= total
    `,
    [jobId]
  );
}

async function processRow(db, row) {
  try {
    const refreshCarrier = await getRefreshCarrierFn();
    await refreshCarrier(row.dotnumber);

    await markQueueComplete(db, row.id);

    if (row.job_id) {
      await incrementJobCompleted(db, row.job_id);
      await maybeCompleteJob(db, row.job_id);
    }
  } catch (err) {
    const msg =
      (err && (err.message || err.toString && err.toString())) ||
      "Unknown error";

    await markQueueFailedOrRetry(db, row.id, msg);

    // If your service sets err.status for rate limits, back off.
    if (err && err.status === 429) {
      await sleep(RATE_LIMIT_SLEEP_MS);
    }
  }
}

async function startRefreshWorker(db) {
  console.log("Carrier refresh worker started");

  // Small boot delay to avoid racing DB init
  await sleep(1000);

  // Infinite worker loop
  while (true) {
    try {
      const row = await claimNextRow(db);

      if (!row) {
        await sleep(IDLE_SLEEP_MS);
        continue;
      }

      await processRow(db, row);

      // throttle between rows to control API usage
      await sleep(THROTTLE_MS);
    } catch (err) {
      console.error("Worker loop error:", err);
      await sleep(LOOP_ERROR_SLEEP_MS);
    }
  }
}

module.exports = { startRefreshWorker };
