"use strict";

const express = require("express");
const router = express.Router();

router.get("/health-internal", (req, res) => {
  res.status(200).json({ status: "ok", layer: "internal" });
});

module.exports = router;
