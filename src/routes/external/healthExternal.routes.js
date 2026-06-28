"use strict";

const express = require("express");

const router = express.Router();

router.get("/health-external", (req, res) => {
  res.status(200).json({ status: "ok", layer: "external_v1" });
});

module.exports = router;
