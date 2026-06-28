"use strict";

const { pool } = require("../db/pool");

const UPSERT = `
INSERT INTO api_request_failure_metrics (
  bucket_start, route, method, status_code, count, last_seen_at
)
VALUES (
  date_trunc('hour', now()),
  $1, $2, $3,
  1, now()
)
ON CONFLICT (bucket_start, route, method, status_code)
DO UPDATE SET
  count = api_request_failure_metrics.count + 1,
  last_seen_at = now();
`;

function stripQuery(url) {
  return (url || "unknown").split("?")[0];
}

// If you want ALL failures, keep >= 400.
// If you want less noise, change to: status >= 500 || status === 429
function shouldTrack(status) {
return status >= 500 || status === 429;

}

function logApiFailures(req, res, next) {
  res.on("finish", () => {
    const status = res.statusCode;
    if (!shouldTrack(status)) return;

    const route = stripQuery(req.originalUrl);
    const method = req.method;

    // best-effort: never block the request lifecycle
    pool.query(UPSERT, [route, method, status]).catch((e) => {
      console.error("[api_request_failure_metrics] write_failed:", e.message);
    });
  });

  next();
}

module.exports = { logApiFailures };
