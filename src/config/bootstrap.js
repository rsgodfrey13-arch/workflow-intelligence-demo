"use strict";

const fs = require("fs");

if (process.env.GCP_SA_KEY_B64) {
  const keyPath =
    process.env.GOOGLE_APPLICATION_CREDENTIALS || "/tmp/gcp-key.json";

  fs.writeFileSync(keyPath, Buffer.from(process.env.GCP_SA_KEY_B64, "base64"));
  process.env.GOOGLE_APPLICATION_CREDENTIALS = keyPath;
}
