"use strict";

const express = require("express");
const path = require("path");

const router = express.Router();

router.get("/help", (req, res) => {
  res.sendFile(path.join(__dirname, "../../../static", "help.html"));
});

module.exports = router;
