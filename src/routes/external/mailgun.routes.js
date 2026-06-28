"use strict";

const express = require("express");
const router = express.Router();

router.post("/webhooks/mailgun", async (req, res) => {
  try {
    const event = {
      source: "mailgun",
      received_at: new Date().toISOString(),
      headers: req.headers,
      body: req.body,
    };

    const nifiUrl = process.env.NIFI_MAILGUN_WEBHOOK_URL || process.env.NIFI_WEBHOOK_URL;
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
