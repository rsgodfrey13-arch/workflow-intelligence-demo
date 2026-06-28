"use strict";

const AWS = require("aws-sdk");

const spaces = new AWS.S3({
  endpoint: `https://${process.env.SPACES_REGION}.digitaloceanspaces.com`,
  accessKeyId: process.env.SPACES_KEY,
  secretAccessKey: process.env.SPACES_SECRET,
  s3ForcePathStyle: true,
  signatureVersion: "v4"
});

module.exports = { spaces };
