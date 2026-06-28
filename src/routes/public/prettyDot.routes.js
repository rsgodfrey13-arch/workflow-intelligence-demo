"use strict";

const express = require("express");
const path = require("path");

const router = express.Router();

router.get("/:dot(\\d+)", (req, res) => {
  res.sendFile(path.join(__dirname, "../../../static", "carrier.html"));
});

module.exports = router;
