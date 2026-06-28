"use strict";

const express = require("express");
const path = require("path");

const router = express.Router();

router.get("/help/managing-carriers", (req, res) => {
  res.sendFile(path.join(__dirname, "../../../../static/help", "managing-carriers.html"));
});

module.exports = router;
