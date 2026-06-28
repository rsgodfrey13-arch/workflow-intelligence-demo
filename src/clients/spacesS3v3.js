"use strict";

const { S3Client } = require("@aws-sdk/client-s3");

const s3 = new S3Client({
  region: process.env.SPACES_REGION,
  endpoint: `https://${process.env.SPACES_REGION}.digitaloceanspaces.com`,
  credentials: {
    accessKeyId: process.env.SPACES_KEY,
    secretAccessKey: process.env.SPACES_SECRET
  }
});

module.exports = { s3 };
