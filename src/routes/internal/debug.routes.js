"use strict";

const express = require("express");
const { spaces } = require("../../clients/spacesS3v2");

const router = express.Router();

router.get("/_debug/spaces", async (req, res) => {
  try {
    const result = await spaces.listObjectsV2({
      Bucket: process.env.SPACES_BUCKET,
      MaxKeys: 5
    }).promise();

    res.json({ ok: true, objects: result.Contents || [] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
