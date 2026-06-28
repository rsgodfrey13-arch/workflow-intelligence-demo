"use strict";

const express = require("express");
const path = require("path");
const router = express.Router();

// IMPORTANT: correct relative path from src/routes/public -> src/middleware
const { requirePageAuth } = require("../../middleware/requirePageAuth");

// Protect ONLY the account page routes (not everything in this router file)
router.get("/account", requirePageAuth, (req, res) => {
  res.sendFile(path.join(__dirname, "../../../static", "account.html"));
});

// (Recommended) Allow deep links like /account/support, /account/api, etc.
router.get("/account/*", requirePageAuth, (req, res) => {
  res.sendFile(path.join(__dirname, "../../../static", "account.html"));
});

module.exports = router;
