"use strict";

const os = require("os");
const {
  claimScreeningQueueBatch,
  processDotForWatchingCompanies,
  markQueueRowComplete,
  markQueueRowErrored
} = require("../services/carrierScreeningService");

const DEFAULT_BATCH_SIZE = Number(process.env.CARRIER_SCREENING_BATCH_SIZE || 25);
const DEFAULT_POLL_MS = Number(process.env.CARRIER_SCREENING_POLL_MS || 1500);
const DEFAULT_LOOP_ERROR_MS = Number(process.env.CARRIER_SCREENING_LOOP_ERROR_MS || 3000);
const DEFAULT_STALE_LOCK_MINUTES = Number(process.env.CARRIER_SCREENING_STALE_LOCK_MINUTES || 10);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function processQueueRow({ db, row }) {
  const queueIdentifier = row.queue_identifier;
  const queueIdentifierColumn = row.queue_identifier_column;
  const dotNumber = String(row.dotnumber || "").replace(/\D/g, "");
  if (!dotNumber) {
    const markClient = await db.connect();
    try {
      await markQueueRowErrored({
        queueIdentifier,
        queueIdentifierColumn,
        errorMessage: "Queue row missing valid dotnumber",
        client: markClient
      });
    } finally {
      markClient.release();
    }
    return;
  }

  const client = await db.connect();
  try {
    const processed = await processDotForWatchingCompanies({ dotNumber, client });
    const failed = processed.results.filter((result) => !result.ok);

    if (failed.length) {
      const messages = failed.map((item) => `company ${item.companyId}: ${item.error}`).join("; ");
      throw new Error(`Failed for ${failed.length} watching companies: ${messages}`);
    }

    await markQueueRowComplete({ queueIdentifier, queueIdentifierColumn, client });
  } catch (err) {
    console.error(`[carrier-screening-worker] dot ${dotNumber} failed:`, err);
    await markQueueRowErrored({
      queueIdentifier,
      queueIdentifierColumn,
      errorMessage: err.message || String(err),
      client
    });
  } finally {
    client.release();
  }
}

async function startCarrierScreeningWorker(pool) {
  const workerId = `${os.hostname()}:${process.pid}`;
  console.log(`[carrier-screening-worker] started as ${workerId}`);

  while (true) {
    try {
      let rows = [];
      const claimClient = await pool.connect();
      try {
        await claimClient.query("BEGIN");
        rows = await claimScreeningQueueBatch({
          client: claimClient,
          lockOwner: workerId,
          batchSize: DEFAULT_BATCH_SIZE,
          staleLockMinutes: DEFAULT_STALE_LOCK_MINUTES
        });
        await claimClient.query("COMMIT");
      } catch (err) {
        await claimClient.query("ROLLBACK");
        throw err;
      } finally {
        claimClient.release();
      }

      if (!rows.length) {
        await sleep(DEFAULT_POLL_MS);
        continue;
      }

      for (const row of rows) {
        await processQueueRow({ db: pool, row });
      }
    } catch (err) {
      console.error("[carrier-screening-worker] loop error:", err);
      await sleep(DEFAULT_LOOP_ERROR_MS);
    }
  }
}

module.exports = { startCarrierScreeningWorker };
