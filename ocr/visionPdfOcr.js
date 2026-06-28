// doo doo
"use strict";

const crypto = require("crypto");
const { Storage } = require("@google-cloud/storage");
const vision = require("@google-cloud/vision").v1;

function safeId() {
  return crypto.randomBytes(16).toString("hex");
}

function avg(nums) {
  const a = (nums || []).filter(n => Number.isFinite(n));
  if (!a.length) return null;
  return a.reduce((x, y) => x + y, 0) / a.length;
}

// Lazy singletons (created on first call AFTER env is set)
let storageClient = null;
let visionClient = null;

function getStorage() {
  if (!storageClient) storageClient = new Storage();
  return storageClient;
}

function getVision() {
  if (!visionClient) visionClient = new vision.ImageAnnotatorClient();
  return visionClient;
}

async function ocrPdfBufferWithVision({ pdfBuffer, gcsBucket, gcsPrefix }) {
  if (!pdfBuffer || !Buffer.isBuffer(pdfBuffer)) {
    throw new Error("ocrPdfBufferWithVision: pdfBuffer (Buffer) is required");
  }
  if (!gcsBucket) throw new Error("ocrPdfBufferWithVision: gcsBucket is required");
  if (!gcsPrefix) throw new Error("ocrPdfBufferWithVision: gcsPrefix is required");

  const jobId = safeId();
  const inputKey = `${gcsPrefix}/input/${jobId}.pdf`;
  const outputPrefix = `${gcsPrefix}/output/${jobId}/`;

  const storage = getStorage();
  const visionClient = getVision();

  // 1) Upload PDF to GCS
  const bucket = storage.bucket(gcsBucket);
  await bucket.file(inputKey).save(pdfBuffer, {
    contentType: "application/pdf",
    resumable: false,
    metadata: { cacheControl: "no-store" }
  });

  const gcsSourceUri = `gs://${gcsBucket}/${inputKey}`;
  const gcsDestinationUri = `gs://${gcsBucket}/${outputPrefix}`;

  // 2) Async OCR
  const request = {
    requests: [
      {
        inputConfig: {
          gcsSource: { uri: gcsSourceUri },
          mimeType: "application/pdf",
        },
        features: [{ type: "DOCUMENT_TEXT_DETECTION" }],
        outputConfig: {
          gcsDestination: { uri: gcsDestinationUri },
          batchSize: 20,
        },
      },
    ],
  };

  const [operation] = await visionClient.asyncBatchAnnotateFiles(request);
  await operation.promise();

  // 3) Read output JSONs from GCS and aggregate text
  const [files] = await bucket.getFiles({ prefix: outputPrefix });

  const texts = [];
  const confs = [];
  let pageCount = 0;

  for (const f of files) {
    if (!f.name.endsWith(".json")) continue;

    const [content] = await f.download();
    const parsed = JSON.parse(content.toString("utf8"));

    const responses = parsed?.responses || [];
    for (const r of responses) {
      const t = r?.fullTextAnnotation?.text;
      if (t) texts.push(t);

      const pages = r?.fullTextAnnotation?.pages || [];
      pageCount += pages.length;

      for (const p of pages) {
        for (const b of (p.blocks || [])) {
          for (const par of (b.paragraphs || [])) {
            for (const w of (par.words || [])) {
              if (Number.isFinite(w.confidence)) confs.push(w.confidence);
            }
          }
        }
      }
    }
  }

  const fullText = texts.join("\n");
  const avgConfidence = avg(confs);

  return {
    jobId,
    gcs: {
      inputUri: gcsSourceUri,
      outputUri: gcsDestinationUri,
      outputPrefix,
    },
    text: fullText,
    avgConfidence,
    pageCount,
  };
}

module.exports = { ocrPdfBufferWithVision };
