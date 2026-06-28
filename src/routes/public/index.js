"use strict";

const express = require("express");

const contractPublicRoutes = require("./contractPublic.routes");
const prettyDotRoutes = require("./prettyDot.routes");
const accountRoutes = require("./account.routes");
const healthzRoutes = require("./healthz.routes");
const loginRoutes = require("./login.routes");
const verifyRoutes = require("./verify-email.routes");
const invitesRoutes = require("./invites.routes");
const trackRoutes = require("./track");
const resetPasswordRoutes = require("./resetPassword.routes");

function publicRoutes() {
  const router = express.Router();

  router.use(contractPublicRoutes);
  router.use(healthzRoutes);
  router.use(trackRoutes);
  router.use(accountRoutes);
  router.use(resetPasswordRoutes);
  router.use(loginRoutes);
  router.use(invitesRoutes);
  router.use(verifyRoutes);
  router.use(prettyDotRoutes); // wildcard-ish routes last

  return router;
}

module.exports = { publicRoutes };
