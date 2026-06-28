"use strict";

const express = require("express");
const path = require("path");

const router = express.Router();

// Pretty URL: /reset-password/<token>
router.get("/reset-password/:token", (req, res) => {
  res.sendFile(path.join(__dirname, "../../../static", "reset-password.html"));
});

module.exports = router;
