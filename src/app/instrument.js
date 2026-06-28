"use strict";

const Sentry = require("@sentry/node");

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  environment: process.env.SENTRY_ENVIRONMENT || "production",
  release: process.env.SENTRY_RELEASE,
  sendDefaultPii: false,

  // ✅ Traces (start low)
  tracesSampleRate: 0.1, // 10%

  // OPTIONAL: if you add profiling later, you’ll set profilesSampleRate too.
  // profilesSampleRate: 0.1,
});
