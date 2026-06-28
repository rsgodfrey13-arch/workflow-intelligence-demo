"use strict";

const express = require("express");
const router = express.Router();

router.post("/webhooks/docupipe", async (req, res) => {
  try {
    const expected = process.env.DOCUPIPE_WEBHOOK_SECRET;
    if (expected) {
      const incoming = req.get("x-docupipe-secret");
      console.log("incoming x-docupipe-secret:", incoming);
      console.log("expected:", expected);
      if (!incoming || incoming !== expected) {
        return res.status(401).send("unauthorized");
      }
    }

    const event = {
      source: "docupipe",
      received_at: new Date().toISOString(),
      headers: req.headers,
      body: req.body,
    };

    const nifiUrl = process.env.NIFI_WEBHOOK_URL;
    const nifiSecret = process.env.NIFI_SHARED_SECRET;

    if (nifiUrl) {
      fetch(nifiUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-nifi-shared-secret": nifiSecret || "",
        },
        body: JSON.stringify(event),
      }).catch(console.error);
    }

    return res.status(200).send("ok");
  } catch (err) {
    console.error(err);
    return res.status(200).send("ok");
  }
});

module.exports = router;
