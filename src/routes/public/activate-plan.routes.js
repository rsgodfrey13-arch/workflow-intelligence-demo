"use strict";

const express = require("express");
const path = require("path");

const router = express.Router();

router.get("/activate-plan", (req, res) => {
  res.sendFile(path.join(__dirname, "../../../static", "activate-plan.html"));
});

module.exports = router;
