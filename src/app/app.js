"use strict";

const Sentry = require("@sentry/node");

const express = require("express");
const path = require("path");
const session = require("express-session");
const fileUpload = require("express-fileupload");
const { internalRoutes } = require("../routes/internal");
const { publicRoutes } = require("../routes/public");
const { externalV1Routes } = require("../routes/external/v1.routes");
const { logApiFailures } = require("../middleware/logApiFailures");
const { pool } = require("../db/pool");
const { errorHandler } = require("../middleware/errorHandler");
const { RedisStore } = require("connect-redis");

function createApp({ redisClient } = {}) {
  const app = express();

  // ✅ Sentry middleware (only if supported by your installed SDK)
  if (Sentry && Sentry.Handlers && typeof Sentry.Handlers.requestHandler === "function") {
    app.use(Sentry.Handlers.requestHandler());
  }
  if (Sentry && Sentry.Handlers && typeof Sentry.Handlers.tracingHandler === "function") {
    app.use(Sentry.Handlers.tracingHandler());
  }

  // Behind Cloudflare / DO App Platform / any proxy
  app.set("trust proxy", 1);

  const staticDir = path.join(__dirname, "../../static");

  // Serve static at root so "/" loads index.html
  app.use(express.static(staticDir));

  // Also serve the same static files under /static/*
  app.use("/static", express.static(staticDir));




// Stripe webhook MUST use raw body (before express.json)
app.post(
  "/api/v1/stripe/webhook",
  express.raw({ type: "application/json" }),
  require("../routes/external/stripeWebhook.handler")
);



  
  // Parse incoming request bodies BEFORE routes
app.use(express.json({
  limit: "10mb",
  verify: (req, res, buf) => {
    req.rawBody = buf; // ✅ required for Stripe webhook signature verification
  }
}));
  app.use(express.urlencoded({ extended: false, limit: "10mb" }));

app.use(fileUpload({
  limits: { fileSize: 20 * 1024 * 1024 },
  abortOnLimit: true,
  createParentPath: true,
  safeFileNames: true,
  preserveExtension: true
}));
  

  // Sessions (used for internal routes)
  app.use(
    session({
      name: "cs.sid",
      secret: process.env.SESSION_SECRET || "dev-secret-change-me",
      resave: false,
      saveUninitialized: false,

      // Redis session store (optional if REDIS_URL not set)
      store: redisClient ? new RedisStore({ client: redisClient, prefix: "cs:sess:" }) : undefined,

      rolling: true,
      cookie: {
        httpOnly: true,
        sameSite: "lax",
        secure: process.env.NODE_ENV === "production",
        maxAge: 1000 * 60 * 60 * 24 * 14, // 14 days
      },
    })
  );

  // Attach DB for any route that needs req.db
  app.use((req, res, next) => {
    req.db = pool;
    next();
  });

  // Log failures (400+ etc) into Postgres
  app.use(logApiFailures);

  // Public site routes at root.
  app.use(publicRoutes());

  // Internal session-based APIs
  app.use("/api", internalRoutes({ pool }));

  // External v1 APIs (webhooks + apiAuth protected routes)
  app.use("/api/v1", externalV1Routes());

  app.get("/debug-sentry", (req, res) => {
    throw new Error("Sentry test error");
  });

  // ✅ Sentry error handler (only if supported by your SDK)
  if (Sentry && typeof Sentry.setupExpressErrorHandler === "function") {
    Sentry.setupExpressErrorHandler(app);
  }

  // Your app’s error handler last
  app.use(errorHandler);

  return app;
}

module.exports = { createApp };
