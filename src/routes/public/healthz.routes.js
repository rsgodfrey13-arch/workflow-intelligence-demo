"use strict";
const express = require("express");

const router = express.Router();

router.get("/healthz", (req, res) => {
  res.status(200).json({ status: "ok", layer: "public" });
});

module.exports = router;
