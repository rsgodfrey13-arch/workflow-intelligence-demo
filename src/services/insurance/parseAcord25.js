"use strict";

// ---------------- helpers ----------------

function parseMoney(s) {
  if (!s) return null;
  const cleaned = String(s).replace(/[^0-9.]/g, "");
  if (!cleaned) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function normalizeSpaces(s) {
  return String(s || "").replace(/\s+/g, " ").trim();
}

function isLikelyAcord25(text) {
  const t = (text || "").toUpperCase();
  const signals = [
    "CERTIFICATE OF LIABILITY INSURANCE",
    "ACORD",
    "PRODUCER",
    "INSURED",
    "COVERAGES",
    "THIS CERTIFICATE IS ISSUED AS A MATTER OF INFORMATION ONLY"
  ];
  const hits = signals.reduce((acc, s) => acc + (t.includes(s) ? 1 : 0), 0);
  return hits >= 3;
}

function findDates(text) {
  const matches = (text || "").match(/\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g);
  return matches ? [...new Set(matches)] : [];
}

// Try to isolate the “COVERAGES” block so we only search limits where they actually appear.
function sliceCoveragesBlock(text) {
  const t = text || "";
  const upper = t.toUpperCase();

  const startIdx = upper.indexOf("COVERAGES");
  if (startIdx === -1) return t;

  const endAnchors = [
    "DESCRIPTION OF OPERATIONS",
    "CERTIFICATE HOLDER",
    "CANCELLATION",
    "SHOULD ANY OF THE ABOVE DESCRIBED POLICIES"
  ];

  let endIdx = t.length;
  for (const a of endAnchors) {
    const i = upper.indexOf(a, startIdx + 50);
    if (i !== -1 && i < endIdx) endIdx = i;
  }

  return t.slice(startIdx, endIdx);
}

function extractMaxMoney(str) {
  const moneyMatches = String(str || "").match(/\$?\s?\d{1,3}(?:,\d{3})+(?:\.\d{2})?/g);
  if (!moneyMatches || moneyMatches.length === 0) return null;

  const nums = moneyMatches.map(parseMoney).filter(Boolean);
  if (!nums.length) return null;
  return Math.max(...nums);
}

function extractLimitNearAny(blockText, keywords, { windowBefore = 120, windowAfter = 1200 } = {}) {
  const t = blockText || "";
  const upper = t.toUpperCase();
  let best = null;

  for (const kw of keywords) {
    const idx = upper.indexOf(String(kw).toUpperCase());
    if (idx === -1) continue;

    const window = t.slice(Math.max(0, idx - windowBefore), Math.min(t.length, idx + windowAfter));
    const money = extractMaxMoney(window);
    if (money && (!best || money > best)) best = money;
  }

  return best;
}

function detectCoverageTypes(text) {
  const t = (text || "").toUpperCase();
  const types = [];

  if (t.includes("GENERAL LIABILITY")) types.push("GL");
  if (t.includes("AUTOMOBILE LIABILITY") || t.includes("AUTO LIABILITY")) types.push("AUTO");
  if (t.includes("MOTOR TRUCK CARGO") || (t.includes("CARGO") && t.includes("TRUCK"))) types.push("CARGO");
  if (t.includes("WORKERS COMPENSATION") || t.includes("WORKERS COMP")) types.push("WC");
  if (t.includes("UMBRELLA LIAB") || t.includes("EXCESS LIAB")) types.push("UMBRELLA");
  if (t.includes("PROFESSIONAL LIABILITY") || t.includes("ERRORS AND OMISSIONS") || t.includes("E&O")) types.push("E&O");
  if (t.includes("POLLUTION")) types.push("POLLUTION");
  if (t.includes("CYBER")) types.push("CYBER");

  return [...new Set(types)];
}

function computeConfidence({ acordLikely, auto, cargo, gl, datesCount }) {
  let score = 0;
  if (acordLikely) score += 40;
  if (auto) score += 25;
  if (cargo) score += 25;
  if (gl) score += 10;
  if (datesCount >= 2) score += 10;
  return Math.min(100, score);
}

/**
 * Given OCR text, return parseResult (your existing shape).
 */
function parseAcord25FromText(text, { ocrProvider = null, ocrMeta = {} } = {}) {
  const acordLikely = isLikelyAcord25(text);
  const dates = findDates(text);

  const cleanedText = normalizeSpaces(text);
  const coveragesBlock = sliceCoveragesBlock(cleanedText);
  const coverageTypes = detectCoverageTypes(cleanedText);

  const hasAUTO = coverageTypes.includes("AUTO");
  const hasCARGO = coverageTypes.includes("CARGO");
  const hasGL = coverageTypes.includes("GL");

  const autoLimit = hasAUTO
    ? extractLimitNearAny(coveragesBlock, ["AUTOMOBILE LIABILITY", "AUTO LIABILITY", "AUTO LIAB"])
    : null;

  const cargoLimit = hasCARGO
    ? extractLimitNearAny(
        coveragesBlock,
        ["MOTOR TRUCK CARGO", "TRUCK CARGO", "CARGO"],
        { windowBefore: 80, windowAfter: 900 }
      )
    : null;

  const glLimit = hasGL
    ? extractLimitNearAny(coveragesBlock, ["GENERAL LIABILITY", "COMMERCIAL GENERAL LIABILITY", "GEN'L LIABILITY"])
    : null;

  const confidence = computeConfidence({
    acordLikely,
    auto: autoLimit,
    cargo: cargoLimit,
    gl: glLimit,
    datesCount: dates.length
  });

  const parseResult = {
    acordLikely,
    confidence,
    extracted: {
      auto_liability_limit: autoLimit,
      cargo_limit: cargoLimit,
      general_liability_limit: glLimit,
      detected_dates: dates,
      detected_coverage_types: coverageTypes
    },
    ocr: {
      provider: ocrProvider,
      meta: ocrMeta
    }
  };

  return { parseResult, confidence, coverageTypes, autoLimit, cargoLimit, glLimit };
}

module.exports = { parseAcord25FromText };
