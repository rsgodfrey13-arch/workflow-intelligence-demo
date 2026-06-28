"use strict";

const express = require("express");
const path = require("path");

const router = express.Router();

router.get("/help/alerts", (req, res) => {
  res.sendFile(path.join(__dirname, "../../../../static/help", "alerts.html"));
});

module.exports = router;
