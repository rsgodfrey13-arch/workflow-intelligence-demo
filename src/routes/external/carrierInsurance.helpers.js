"use strict";

const COVERAGE_TYPES = {
  AUTO_LIABILITY: "AUTO LIABILITY",
  CARGO: "CARGO",
  GENERAL_LIABILITY: "GENERAL LIABILITY",
  WORKERS_COMP: "WORKERS COMP",
  OTHER: "OTHER",
};

function normalizeCoverageType(rawType) {
  const value = String(rawType || "").trim().toUpperCase();
  if (!value) return COVERAGE_TYPES.OTHER;

  if (value === "AUTO_LIABILITY") return COVERAGE_TYPES.AUTO_LIABILITY;
  if (value === "MOTOR_TRUCK_CARGO") return COVERAGE_TYPES.CARGO;
  if (value === "GENERAL_LIABILITY") return COVERAGE_TYPES.GENERAL_LIABILITY;
  if (value === "WORKERS_COMP") return COVERAGE_TYPES.WORKERS_COMP;

  if (
    value.includes("AUTO") ||
    value.includes("AUTOMOBILE") ||
    value === "BIPD"
  ) {
    return COVERAGE_TYPES.AUTO_LIABILITY;
  }

  if (value.includes("CARGO")) return COVERAGE_TYPES.CARGO;

  if (
    value === "GL" ||
    value.includes("GENERAL LIABILITY") ||
    value.includes("COMMERCIAL GENERAL")
  ) {
    return COVERAGE_TYPES.GENERAL_LIABILITY;
  }

  if (value.includes("WORKERS")) return COVERAGE_TYPES.WORKERS_COMP;

  return COVERAGE_TYPES.OTHER;
}

function toNumberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(String(value).replace(/[^\d.-]/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function getCoverageLimitAmount(coverage) {
  const direct = toNumberOrNull(coverage?.limit_amount);
  if (direct !== null) return direct;

  const limitsJson = coverage?.limits_json;
  if (!limitsJson || typeof limitsJson !== "object") return null;

  let max = null;
  for (const value of Object.values(limitsJson)) {
    const num = toNumberOrNull(value);
    if (num === null) continue;
    if (max === null || num > max) max = num;
  }
  return max;
}

function toIsoDateOrNull(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

function isExpiredByDate(value, todayIso) {
  if (!value) return false;
  const isoDate = toIsoDateOrNull(value);
  if (!isoDate) return false;
  return isoDate < todayIso;
}

function toCoverageResponse(coverage, todayIso) {
  const normalizedType = normalizeCoverageType(
    coverage?.coverage_type || coverage?.coverage_type_raw
  );
  const expired = isExpiredByDate(coverage?.expiration_date, todayIso);

  return {
    id: coverage?.id ?? null,
    document_id: coverage?.document_id ?? null,
    coverage_type: normalizedType,
    insurer_name: coverage?.insurer_name ?? null,
    policy_number: coverage?.policy_number ?? null,
    effective_date: toIsoDateOrNull(coverage?.effective_date),
    expiration_date: toIsoDateOrNull(coverage?.expiration_date),
    limit_amount: getCoverageLimitAmount(coverage),
    status: expired ? "EXPIRED" : "ACTIVE",
    is_expired: expired,
  };
}

function buildEmptyInsuranceSummary() {
  return {
    has_on_file: false,
    has_structured_coverages: false,
    is_expired: true,
    next_expiration_date: null,
    auto_liability_limit: null,
    cargo_limit: null,
    general_liability_limit: null,
    coverage_count: 0,
  };
}

function buildInsuranceSummary(coverages, todayIso) {
  const summary = buildEmptyInsuranceSummary();
  if (!Array.isArray(coverages) || coverages.length === 0) return summary;

  summary.has_on_file = true;
  summary.has_structured_coverages = true;
  summary.coverage_count = coverages.length;

  let nearestFutureExpiration = null;
  let hasActiveCoverage = false;

  for (const coverage of coverages) {
    if (!coverage.is_expired) {
      hasActiveCoverage = true;
    }

    if (coverage.expiration_date && coverage.expiration_date >= todayIso) {
      if (!nearestFutureExpiration || coverage.expiration_date < nearestFutureExpiration) {
        nearestFutureExpiration = coverage.expiration_date;
      }
    }

    if (coverage.limit_amount !== null) {
      if (coverage.coverage_type === COVERAGE_TYPES.AUTO_LIABILITY) {
        summary.auto_liability_limit = summary.auto_liability_limit === null
          ? coverage.limit_amount
          : Math.max(summary.auto_liability_limit, coverage.limit_amount);
      } else if (coverage.coverage_type === COVERAGE_TYPES.CARGO) {
        summary.cargo_limit = summary.cargo_limit === null
          ? coverage.limit_amount
          : Math.max(summary.cargo_limit, coverage.limit_amount);
      } else if (coverage.coverage_type === COVERAGE_TYPES.GENERAL_LIABILITY) {
        summary.general_liability_limit = summary.general_liability_limit === null
          ? coverage.limit_amount
          : Math.max(summary.general_liability_limit, coverage.limit_amount);
      }
    }
  }

  summary.is_expired = !hasActiveCoverage;
  summary.next_expiration_date = nearestFutureExpiration;
  return summary;
}

function buildInsuranceDataFromCoverageRows(rows) {
  const todayIso = new Date().toISOString().slice(0, 10);
  const coverages = (rows || []).map((row) => toCoverageResponse(row, todayIso));
  // NOTE: insurance_summary is intentionally assembled from normalized coverage
  // rows so all v1 carrier responses stay consistent with status/type logic.
  const insurance_summary = buildInsuranceSummary(coverages, todayIso);
  return { insurance_summary, insurance_coverages: coverages };
}

function buildInsuranceSummariesByDot(rows) {
  const grouped = new Map();
  for (const row of rows || []) {
    const dot = row?.dot_number ? String(row.dot_number) : null;
    if (!dot) continue;
    if (!grouped.has(dot)) grouped.set(dot, []);
    grouped.get(dot).push(row);
  }

  const summaries = new Map();
  for (const [dot, coverageRows] of grouped.entries()) {
    const { insurance_summary } = buildInsuranceDataFromCoverageRows(coverageRows);
    // NOTE: list endpoints only include insurance_summary to keep payloads light.
    summaries.set(dot, insurance_summary);
  }

  return summaries;
}

function mergeDocumentOnlyDotsIntoSummaries(summariesByDot, dotsWithDocuments) {
  const merged = new Map(summariesByDot || []);
  for (const dot of dotsWithDocuments || []) {
    const key = String(dot || "");
    if (!key) continue;

    if (merged.has(key)) continue;
    const summary = buildEmptyInsuranceSummary();
    summary.has_on_file = true;
    summary.has_structured_coverages = false;
    summary.is_expired = false;
    merged.set(key, summary);
  }
  return merged;
}

module.exports = {
  buildEmptyInsuranceSummary,
  buildInsuranceDataFromCoverageRows,
  buildInsuranceSummariesByDot,
  mergeDocumentOnlyDotsIntoSummaries,
};
