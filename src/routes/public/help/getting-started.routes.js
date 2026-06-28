"use strict";

const express = require("express");
const path = require("path");

const router = express.Router();

router.get("/help/getting-started", (req, res) => {
  res.sendFile(path.join(__dirname, "../../../../static/help", "getting-started.html"));
});

module.exports = router;
