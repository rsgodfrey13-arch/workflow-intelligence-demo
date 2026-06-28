"use strict";

const express = require("express");
const { apiAuth } = require("../../middleware/apiAuth");
const { pool } = require("../../db/pool");
const mailgunRoutes = require("./mailgun.routes");
const createApiV1 = require("./v1.router");
const healthExternalRoutes = require("./healthExternal.routes");

// IMPORT YOUR DOCUPIPE ROUTES
const docupipeRoutes = require("./docupipe.routes");


function externalV1Routes() {
  const router = express.Router();

  // Webhook FIRST (no apiAuth)
  router.use(docupipeRoutes);
router.use(mailgunRoutes);
  router.use(healthExternalRoutes);

  // Everything else protected
  router.use(apiAuth);
  router.use(createApiV1(pool));

  return router;
}

module.exports = { externalV1Routes };
