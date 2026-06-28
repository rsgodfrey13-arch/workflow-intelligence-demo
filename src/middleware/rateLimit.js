"use strict";

const rateLimit = require("express-rate-limit");

const RATE_LIMIT_RESPONSE = {
  error: "Too many requests, please try again later.",
};

function isAuthenticatedInternalRequest(req) {
  return Boolean(req.session?.userId || req.user);
}

function isHealthRoute(req) {
  return req.path === "/health" || req.path === "/health-internal";
}

function searchRateLimitKey(req) {
  if (req.session?.userId) {
    return `session:${req.session.userId}`;
  }

  if (req.user?.id) {
    return `api:${req.user.id}`;
  }

  return req.ip;
}

function jsonRateLimitHandler(req, res, next, options) {
  res.status(options.statusCode).json(RATE_LIMIT_RESPONSE);
}

function createLimiter({ windowMs, max, skip, keyGenerator } = {}) {
  return rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    skip,
    keyGenerator,
    handler: jsonRateLimitHandler,
  });
}

// Light protection for public API traffic. Authenticated internal/admin requests
// are skipped so normal in-app usage is not throttled by the shared public limit.
const globalApiLimiter = createLimiter({
  windowMs: 60 * 1000,
  max: 300,
  skip: (req) => isHealthRoute(req) || isAuthenticatedInternalRequest(req),
});

// Carrier search endpoints hit the carriers dataset directly, so throttle them
// for everyone. When a user identity is available, scope the limit per user;
// otherwise fall back to the caller IP for public traffic.
const searchLimiter = createLimiter({
  windowMs: 60 * 1000,
  max: 60,
  keyGenerator: searchRateLimitKey,
});

// Login and recovery flows are intentionally stricter to reduce credential
// stuffing and reset abuse.
const authLimiter = createLimiter({
  windowMs: 15 * 60 * 1000,
  max: 10,
});

module.exports = {
  authLimiter,
  globalApiLimiter,
  searchLimiter,
};
