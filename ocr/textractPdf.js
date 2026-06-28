// ocr/textractPdf.js
"use strict";

const crypto = require("crypto");
const { S3Client, PutObjectCommand, DeleteObjectCommand } = require("@aws-sdk/client-s3");
const {
  TextractClient,
  StartDocumentAnalysisCommand,
  GetDocumentAnalysisCommand
} = require("@aws-sdk/client-textract");

/**
 * Minimal sleep helper
 */
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Retry wrapper for throttling/transient AWS errors
 */
async function withRetries(fn, { retries = 6, baseDelayMs = 400 } = {}) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const code = err?.name || err?.Code || err?.code;

      // Throttling + transient-ish
      const retryable =
        code === "ThrottlingException" ||
        code === "ProvisionedThroughputExceededException" ||
        code === "TooManyRequestsException" ||
        code === "InternalServerError" ||
        code === "ServiceUnavailableException" ||
        err?.$retryable;

      if (!retryable || i === retries) throw err;

      const backoff = Math.min(8000, baseDelayMs * Math.pow(2, i));
      await sleep(backoff + Math.floor(Math.random() * 200));
    }
  }
  throw lastErr;
}

/**
 * Build a fast lookup: Id -> Block
 */
function indexBlocks(blocks) {
  const map = new Map();
  for (const b of blocks || []) {
    if (b?.Id) map.set(b.Id, b);
  }
  return map;
}

/**
 * Concatenate text from a Block by walking CHILD relationships to WORD blocks.
 */
function getTextFromBlock(block, blockMap) {
  if (!block?.Relationships) return "";
  const childRel = block.Relationships.find((r) => r.Type === "CHILD");
  if (!childRel?.Ids?.length) return "";

  const words = [];
  for (const id of childRel.Ids) {
    const child = blockMap.get(id);
    if (!child) continue;

    if (child.BlockType === "WORD" && child.Text) words.push(child.Text);
    // Selection elements (checkboxes) are SELECTION_ELEMENT blocks
    if (child.BlockType === "SELECTION_ELEMENT") {
      if (child.SelectionStatus === "SELECTED") words.push("[X]");
      else words.push("[ ]");
    }
  }
  return words.join(" ").trim();
}

/**
 * Extract KEY_VALUE_SET pairs (FORMS)
 */
function extractKeyValuePairs(blocks) {
  const blockMap = indexBlocks(blocks);

  const keyBlocks = (blocks || []).filter(
    (b) => b.BlockType === "KEY_VALUE_SET" && b.EntityTypes?.includes("KEY")
  );

  const pairs = [];
  for (const keyBlock of keyBlocks) {
    const keyText = getTextFromBlock(keyBlock, blockMap);
    if (!keyText) continue;

    // VALUE relationship points to VALUE blocks
    const valueRel = keyBlock.Relationships?.find((r) => r.Type === "VALUE");
    const valueIds = valueRel?.Ids || [];

    let valueText = "";
    for (const vid of valueIds) {
      const valueBlock = blockMap.get(vid);
      if (!valueBlock) continue;
      valueText = getTextFromBlock(valueBlock, blockMap) || valueText;
    }

    pairs.push({
      key: keyText,
      value: valueText || null,
      confidence: keyBlock.Confidence ?? null
    });
  }

  // convenience: also return as normalized object (keys can repeat → keep best confidence)
  const byKey = {};
  for (const p of pairs) {
    const k = String(p.key || "").trim();
    if (!k) continue;
    const prev = byKey[k];
    if (!prev || (p.confidence ?? 0) > (prev.confidence ?? 0)) {
      byKey[k] = { value: p.value, confidence: p.confidence };
    }
  }

  return { pairs, byKey };
}

/**
 * Extract tables as row/col text grid
 */
function extractTables(blocks) {
  const blockMap = indexBlocks(blocks);

  const tableBlocks = (blocks || []).filter((b) => b.BlockType === "TABLE");
  const tables = [];

  for (const t of tableBlocks) {
    const childRel = t.Relationships?.find((r) => r.Type === "CHILD");
    const cellIds = childRel?.Ids || [];

    const cells = [];
    for (const cid of cellIds) {
      const cell = blockMap.get(cid);
      if (!cell || cell.BlockType !== "CELL") continue;
      cells.push({
        row: cell.RowIndex,
        col: cell.ColumnIndex,
        rowSpan: cell.RowSpan || 1,
        colSpan: cell.ColumnSpan || 1,
        text: getTextFromBlock(cell, blockMap),
        confidence: cell.Confidence ?? null
      });
    }

    const maxRow = Math.max(0, ...cells.map((c) => c.row || 0));
    const maxCol = Math.max(0, ...cells.map((c) => c.col || 0));

    const grid = Array.from({ length: maxRow }, () => Array.from({ length: maxCol }, () => ""));
    for (const c of cells) {
      if (!c.row || !c.col) continue;
      grid[c.row - 1][c.col - 1] = c.text || "";
    }

    tables.push({
      id: t.Id,
      confidence: t.Confidence ?? null,
      cells,
      grid
    });
  }

  return tables;
}

/**
 * Build fullText from LINE blocks (best for "extracted_text")
 */
function buildFullText(blocks) {
  const lines = (blocks || [])
    .filter((b) => b.BlockType === "LINE" && b.Text)
    .map((b) => b.Text);
  return lines.join("\n");
}

/**
 * Confidence summary (simple + useful)
 */
function summarizeConfidence(blocks) {
  const lines = (blocks || []).filter((b) => b.BlockType === "LINE" && typeof b.Confidence === "number");
  if (!lines.length) return { avgLineConfidence: null, lineCount: 0 };

  const sum = lines.reduce((a, b) => a + (b.Confidence || 0), 0);
  return {
    avgLineConfidence: Math.round((sum / lines.length) * 100) / 100,
    lineCount: lines.length
  };
}

/**
 * Main entry: upload PDF to AWS S3, run StartDocumentAnalysis (FORMS+TABLES),
 * poll until completion, paginate GetDocumentAnalysis results, then normalize.
 *
 * Note: StartDocumentAnalysis is the correct async API for multipage PDFs in S3. :contentReference[oaicite:1]{index=1}
 */
async function ocrPdfBufferWithTextract({
  pdfBuffer,
  s3Bucket = process.env.TEXTRACT_S3_BUCKET,
  s3Prefix = process.env.TEXTRACT_S3_PREFIX || "insurance-ocr",
  region = process.env.AWS_TEXTRACT_REGION,
  awsAccessKeyId = process.env.AWS_TEXTRACT_ACCESS_KEY_ID,
  awsSecretAccessKey = process.env.AWS_TEXTRACT_SECRET_ACCESS_KEY,
  objectKeyHint = null,
  maxWaitMs = 2 * 60 * 1000 + 30 * 1000 // ~2.5 minutes
}) {
  if (!pdfBuffer || !Buffer.isBuffer(pdfBuffer)) throw new Error("pdfBuffer is required (Buffer).");
  if (!s3Bucket) throw new Error("TEXTRACT_S3_BUCKET is required.");
  if (!region) throw new Error("AWS_TEXTRACT_REGION is required.");
  if (!awsAccessKeyId || !awsSecretAccessKey) throw new Error("AWS Textract AWS credentials are required.");

  const credentials = { accessKeyId: awsAccessKeyId, secretAccessKey: awsSecretAccessKey };

  const awsS3 = new S3Client({ region, credentials });
  const textract = new TextractClient({ region, credentials });

  const rand = crypto.randomBytes(8).toString("hex");
  const key = objectKeyHint
    ? `${s3Prefix}/${objectKeyHint}-${Date.now()}-${rand}.pdf`
    : `${s3Prefix}/${Date.now()}-${rand}.pdf`;

  // 1) Upload PDF to AWS S3 (Textract reads from S3)
  await withRetries(() =>
    awsS3.send(
      new PutObjectCommand({
        Bucket: s3Bucket,
        Key: key,
        Body: pdfBuffer,
        ContentType: "application/pdf"
      })
    )
  );

  const inputS3Uri = `s3://${s3Bucket}/${key}`;

  // 2) Start async analysis (FORMS + TABLES)
  // FeatureTypes drives key-value pairs + tables. :contentReference[oaicite:2]{index=2}
  const startResp = await withRetries(() =>
    textract.send(
      new StartDocumentAnalysisCommand({
        DocumentLocation: { S3Object: { Bucket: s3Bucket, Name: key } },
        FeatureTypes: ["FORMS", "TABLES"]
        // Optional later: NotificationChannel (SNS) if you want webhook-style completion.
      })
    )
  );

  const jobId = startResp?.JobId;
  if (!jobId) throw new Error("Textract did not return a JobId.");

  // 3) Poll for completion
  const startedAt = Date.now();
  let status = "IN_PROGRESS";
  let lastMeta = null;

  // progressive backoff: 1s → 2s → 3s → 5s (caps)
  const delays = [1000, 2000, 3000, 5000];

  let attempt = 0;
  while (Date.now() - startedAt < maxWaitMs) {
    const delay = delays[Math.min(attempt, delays.length - 1)];
    await sleep(delay);

    const resp = await withRetries(() =>
      textract.send(new GetDocumentAnalysisCommand({ JobId: jobId, MaxResults: 1000 }))
    );

    status = resp?.JobStatus || "UNKNOWN";
    lastMeta = resp;

    if (status === "SUCCEEDED" || status === "PARTIAL_SUCCESS") break; // PARTIAL_SUCCESS still returns blocks
    if (status === "FAILED") {
      const msg = resp?.StatusMessage ? ` (${resp.StatusMessage})` : "";
      throw new Error(`Textract job FAILED${msg}`);
    }

    attempt += 1;
  }

  if (status !== "SUCCEEDED" && status !== "PARTIAL_SUCCESS") {
    throw new Error(`Textract timed out after ${Math.round(maxWaitMs / 1000)}s (last status: ${status})`);
  }

  // 4) Retrieve ALL blocks w/ pagination (NextToken)
  // Textract paginates GetDocumentAnalysis using NextToken. :contentReference[oaicite:3]{index=3}
  const allBlocks = [];
  let nextToken = null;
  let pageCount = 0;

  do {
    const resp = await withRetries(() =>
      textract.send(
        new GetDocumentAnalysisCommand({
          JobId: jobId,
          MaxResults: 1000,
          NextToken: nextToken || undefined
        })
      )
    );

    const blocks = resp?.Blocks || [];
    allBlocks.push(...blocks);

    nextToken = resp?.NextToken || null;
    pageCount += 1;

    // safety: avoid infinite loops
    if (pageCount > 1000) throw new Error("Textract pagination exceeded safety limit.");
  } while (nextToken);

  // 5) Normalize
  const fullText = buildFullText(allBlocks);
  const kvp = extractKeyValuePairs(allBlocks);
  const tables = extractTables(allBlocks);
  const conf = summarizeConfidence(allBlocks);

  const normalized = {
    provider: "AWS_TEXTRACT",
    jobId,
    jobStatus: status,
    inputS3Uri,
    fullText,
    // blocks are huge; keep optional. If you store raw JSON elsewhere, you can omit.
    blocks: allBlocks,
    keyValuePairs: kvp, // { pairs: [...], byKey: {...} }
    tables,
    confidence: conf,
    meta: {
      warnings: lastMeta?.Warnings || null,
      documentMetadata: lastMeta?.DocumentMetadata || null
    }
  };

  // Optional cleanup: delete the uploaded PDF to keep the bucket “temporary”
  // Comment out if you want to keep a full audit trail.
  // await awsS3.send(new DeleteObjectCommand({ Bucket: s3Bucket, Key: key }));

  return normalized;
}

module.exports = { ocrPdfBufferWithTextract };
