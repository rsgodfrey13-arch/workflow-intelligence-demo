"use strict";

const { pool } = require("../db/pool");

const TRUE_SET = new Set(["Y", "YES", "TRUE", "T", "1", "ACTIVE", "AUTHORIZED"]);
const FALSE_SET = new Set(["N", "NO", "FALSE", "F", "0", "INACTIVE", "NOT AUTHORIZED"]);

const SUPPORTED_OPERATORS = new Set([
  "EQUALS",
  "NOT_EQUALS",
  "LESS_THAN",
  "LESS_THAN_OR_EQUAL",
  "GREATER_THAN",
  "GREATER_THAN_OR_EQUAL",
  "IN",
  "NOT_IN",
  "IS_TRUE",
  "IS_FALSE"
]);

const SAFETY_RATING_ENUM_FIELDS = new Set(["safetyrating"]);
const AUTHORITY_STATUS_ENUM_FIELDS = new Set([
  "commonauthoritystatus",
  "contractauthoritystatus",
  "brokerauthoritystatus"
]);

const SAFETY_RATING_CANONICAL_MAP = new Map([
  ["S", "Satisfactory"],
  ["SATISFACTORY", "Satisfactory"],
  ["C", "Conditional"],
  ["CONDITIONAL", "Conditional"],
  ["U", "Unsatisfactory"],
  ["UNSATISFACTORY", "Unsatisfactory"],
  ["N", "Not Rated"],
  ["NONE", "Not Rated"],
  ["NOT RATED", "Not Rated"]
]);

const AUTHORITY_STATUS_CANONICAL_MAP = new Map([
  ["A", "Active"],
  ["ACTIVE", "Active"],
  ["I", "Inactive"],
  ["INACTIVE", "Inactive"],
  ["N", "None"],
  ["NONE", "None"]
]);

function normalizeDot(dotNumber) {
  return String(dotNumber || "").replace(/\D/g, "");
}

function normalizeText(value) {
  if (value === null || value === undefined) return null;
  const trimmed = String(value).trim();
  return trimmed ? trimmed : null;
}

function normalizeBoolean(value) {
  if (value === true || value === false) return value;
  const text = normalizeText(value);
  if (!text) return null;
  const token = text.toUpperCase();
  if (TRUE_SET.has(token)) return true;
  if (FALSE_SET.has(token)) return false;
  return null;
}

function normalizeNumber(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const text = normalizeText(value);
  if (!text) return null;
  const cleaned = text.replace(/[%,$\s]/g, "").replace(/,/g, "");
  if (!cleaned) return null;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseCoverageExpirationDate(value) {
  const text = normalizeText(value);
  if (!text) return null;
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) return null;
  return {
    date: parsed,
    isoDate: parsed.toISOString().slice(0, 10)
  };
}

function isCoverageExpired(value) {
  const parsed = parseCoverageExpirationDate(value);
  if (!parsed) return null;
  const today = new Date();
  const todayUtc = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  const expiryUtc = Date.UTC(parsed.date.getUTCFullYear(), parsed.date.getUTCMonth(), parsed.date.getUTCDate());
  return {
    expired: expiryUtc < todayUtc,
    isoDate: parsed.isoDate
  };
}

function getInsuranceExpirationField(carrierField) {
  const field = normalizeText(carrierField);
  if (!field || !field.endsWith("_limit")) return null;
  return field.replace(/_limit$/, "_expiration_date");
}

function parseCsvSet(valueText) {
  const normalized = normalizeText(valueText);
  if (!normalized) return [];
  return normalized
    .split(",")
    .map((item) => normalizeText(item))
    .filter(Boolean)
    .map((item) => item.toUpperCase());
}

function normalizeEnumCarrierValue({ criterion, rawValue }) {
  const field = String(criterion?.carrier_field || "").trim().toLowerCase();

  if (SAFETY_RATING_ENUM_FIELDS.has(field)) {
    const text = normalizeText(rawValue);
    if (!text) return "Not Rated";
    const token = text.toUpperCase();
    return SAFETY_RATING_CANONICAL_MAP.get(token) || null;
  }

  const text = normalizeText(rawValue);
  if (!text) return null;
  const token = text.toUpperCase();

  if (AUTHORITY_STATUS_ENUM_FIELDS.has(field)) {
    return AUTHORITY_STATUS_CANONICAL_MAP.get(token) || null;
  }

  return text;
}

async function getDefaultActiveProfile({ companyId, client }) {
  const { rows } = await client.query(
    `
    SELECT id, company_id, profile_name
    FROM public.company_screening_profiles
    WHERE company_id = $1
      AND is_default = true
      AND is_active = true
    ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST
    LIMIT 1
    `,
    [companyId]
  );
  return rows[0] || null;
}

async function getActiveProfilesForCompany({ companyId, client }) {
  const { rows } = await client.query(
    `
    SELECT id, company_id, profile_name, is_default
    FROM public.company_screening_profiles
    WHERE company_id = $1
      AND is_active = true
    ORDER BY is_default DESC, updated_at DESC NULLS LAST, created_at DESC NULLS LAST, id ASC
    `,
    [companyId]
  );
  return rows;
}

async function getEnabledCriteriaForProfile({ profileId, client }) {
  const { rows } = await client.query(
    `
    SELECT
      cspc.id AS profile_criteria_id,
      sc.id AS screening_criteria_id,
      sc.criteria_key,
      sc.label,
      sc.description,
      sc.value_type,
      sc.carrier_field,
      sc.category,
      sc.display_order,
      cspc.value_bool,
      cspc.value_number,
      cspc.value_date,
      cspc.value_text,
      COALESCE(cspc.comparison_operator, 'EQUALS') AS comparison_operator
    FROM public.company_screening_profile_criteria cspc
    JOIN public.screening_criteria sc
      ON sc.id = cspc.screening_criteria_id
    WHERE cspc.profile_id = $1
      AND cspc.is_enabled = true
      AND sc.is_active = true
    ORDER BY sc.display_order ASC, sc.id ASC
    `,
    [profileId]
  );
  return rows;
}

async function getActiveGroupsForProfile({ profileId, client }) {
  const { rows } = await client.query(
    `
    SELECT id, group_name, match_type, display_order
    FROM public.company_screening_profile_groups
    WHERE profile_id = $1
      AND is_active = true
    ORDER BY display_order ASC, created_at ASC, id ASC
    `,
    [profileId]
  );
  return rows;
}

async function getGroupMembershipForProfile({ profileId, client }) {
  const { rows } = await client.query(
    `
    SELECT
      g.id AS group_id,
      gc.profile_criteria_id
    FROM public.company_screening_profile_groups g
    JOIN public.company_screening_profile_group_criteria gc
      ON gc.group_id = g.id
    WHERE g.profile_id = $1
      AND g.is_active = true
    `,
    [profileId]
  );
  return rows;
}

async function getCarrierByDot({ dotNumber, client }) {
  const { rows } = await client.query(
    `
    SELECT *
    FROM public.carriers
    WHERE dotnumber::text = $1
    LIMIT 1
    `,
    [dotNumber]
  );
  return rows[0] || null;
}

async function getCarrierInsuranceSummary({ dotNumber, client }) {
  const { rows } = await client.query(
    `
    SELECT *
    FROM public.carrier_insurance_summary
    WHERE dot_number::text = $1
    LIMIT 1
    `,
    [dotNumber]
  );
  return rows[0] || null;
}

async function getActiveCriterionOverridesForProfile({ companyId, dotNumber, profileId, client }) {
  const { rows } = await client.query(
    `
    SELECT profile_criteria_id, expires_at, note
    FROM public.company_carrier_screening_overrides
    WHERE company_id = $1
      AND carrier_dot = $2
      AND profile_id = $3
      AND is_active = true
      AND (expires_at IS NULL OR expires_at > NOW())
    `,
    [companyId, dotNumber, profileId]
  );

  const overrideByProfileCriteriaId = new Map();
  for (const row of rows) {
    overrideByProfileCriteriaId.set(String(row.profile_criteria_id), {
      expires_at: row.expires_at || null,
      note: normalizeText(row.note)
    });
  }
  return overrideByProfileCriteriaId;
}

async function getExistingResult({ companyId, profileId, dotNumber, client }) {
  const { rows } = await client.query(
    `
    SELECT *
    FROM public.company_carrier_screening_results
    WHERE company_id = $1
      AND profile_id = $2
      AND carrier_dot = $3
    LIMIT 1
    `,
    [companyId, profileId, dotNumber]
  );
  return rows[0] || null;
}

function buildOverrideReason(override) {
  const expiresAt = override?.expires_at ? new Date(override.expires_at) : null;
  if (!expiresAt || Number.isNaN(expiresAt.getTime())) return "Rule overridden";
  return `Rule overridden until ${expiresAt.toISOString().slice(0, 10)}`;
}

function applyCriterionOverride({ criterionResult, override }) {
  if (!criterionResult || !override) return criterionResult;
  if (criterionResult.status === "PASS") return criterionResult;

  return {
    ...criterionResult,
    status: "PASS",
    matched: true,
    is_overridden: true,
    override_expires_at: override.expires_at || null,
    override_note: override.note || null,
    reason: buildOverrideReason(override)
  };
}

function evaluateBooleanCriterion({ criterion, rawValue }) {
  const actual = normalizeBoolean(rawValue);
  const op = String(criterion.comparison_operator || "EQUALS").toUpperCase();

  if (actual === null) {
    return { status: "FAIL", matched: false, reason: "Carrier value is missing or unrecognized", actualNormalized: null };
  }

  if (op === "IS_TRUE") {
    return { status: actual ? "PASS" : "FAIL", matched: actual, reason: actual ? "Value is true" : "Value is not true", actualNormalized: actual };
  }
  if (op === "IS_FALSE") {
    return { status: !actual ? "PASS" : "FAIL", matched: !actual, reason: !actual ? "Value is false" : "Value is not false", actualNormalized: actual };
  }

  if (op === "EQUALS") {
    const expected = criterion.value_bool;
    if (expected === null || expected === undefined) {
      return { status: "FAIL", matched: false, reason: "Expected boolean is not configured", actualNormalized: actual };
    }
    const matched = actual === expected;
    return { status: matched ? "PASS" : "FAIL", matched, reason: matched ? "Boolean matched expected value" : "Boolean did not match expected value", actualNormalized: actual };
  }

  return { status: "FAIL", matched: false, reason: `Unsupported BOOLEAN operator: ${op}`, actualNormalized: actual };
}

function evaluateNumberCriterion({ criterion, rawValue, carrierRow }) {
  const isInsuranceCriterion = String(criterion.category || "").toUpperCase() === "INSURANCE";
  const expirationField = isInsuranceCriterion ? getInsuranceExpirationField(criterion.carrier_field) : null;
  if (expirationField) {
    const expirationCheck = isCoverageExpired(carrierRow?.[expirationField]);
    if (expirationCheck?.expired) {
      return {
        status: "FAIL",
        matched: false,
        reason: `Coverage expired on ${expirationCheck.isoDate}`,
        actualNormalized: "Expired"
      };
    }
  }

  const actual = normalizeNumber(rawValue);
  const op = String(criterion.comparison_operator || "EQUALS").toUpperCase();
  const expected = normalizeNumber(criterion.value_number);

  if (actual === null) {
    return { status: "FAIL", matched: false, reason: "Carrier value is missing or not numeric", actualNormalized: null };
  }
  if (expected === null) {
    return { status: "FAIL", matched: false, reason: "Expected numeric value is not configured", actualNormalized: actual };
  }

  let matched = null;
  if (op === "EQUALS") matched = actual === expected;
  else if (op === "NOT_EQUALS") matched = actual !== expected;
  else if (op === "LESS_THAN") matched = actual < expected;
  else if (op === "LESS_THAN_OR_EQUAL") matched = actual <= expected;
  else if (op === "GREATER_THAN") matched = actual > expected;
  else if (op === "GREATER_THAN_OR_EQUAL") matched = actual >= expected;

  if (matched === null) {
    return { status: "FAIL", matched: false, reason: `Unsupported NUMBER operator: ${op}`, actualNormalized: actual };
  }

  return { status: matched ? "PASS" : "FAIL", matched, reason: matched ? "Numeric value matched rule" : "Numeric value did not match rule", actualNormalized: actual };
}

function evaluateEnumCriterion({ criterion, rawValue }) {
  const actual = normalizeEnumCarrierValue({ criterion, rawValue });
  const op = String(criterion.comparison_operator || "EQUALS").toUpperCase();
  const expectedText = normalizeText(criterion.value_text);

  if (!actual) {
    return { status: "FAIL", matched: false, reason: "Carrier value is missing", actualNormalized: null };
  }

  const actualUpper = actual.toUpperCase();
  if (op === "EQUALS") {
    if (!expectedText) return { status: "FAIL", matched: false, reason: "Expected text value is not configured", actualNormalized: actual };
    const matched = actualUpper === expectedText.toUpperCase();
    return { status: matched ? "PASS" : "FAIL", matched, reason: matched ? "Text matched expected value" : "Text did not match expected value", actualNormalized: actual };
  }

  if (op === "NOT_EQUALS") {
    if (!expectedText) return { status: "FAIL", matched: false, reason: "Expected text value is not configured", actualNormalized: actual };
    const matched = actualUpper !== expectedText.toUpperCase();
    return { status: matched ? "PASS" : "FAIL", matched, reason: matched ? "Text differs as expected" : "Text equals excluded value", actualNormalized: actual };
  }

  if (op === "IN" || op === "NOT_IN") {
    const expectedSet = parseCsvSet(criterion.value_text);
    if (!expectedSet.length) {
      return { status: "FAIL", matched: false, reason: "Expected IN list is not configured", actualNormalized: actual };
    }
    const inSet = expectedSet.includes(actualUpper);
    const matched = op === "IN" ? inSet : !inSet;
    return { status: matched ? "PASS" : "FAIL", matched, reason: matched ? "Text matched list rule" : "Text did not match list rule", actualNormalized: actual };
  }

  return { status: "FAIL", matched: false, reason: `Unsupported ENUM operator: ${op}`, actualNormalized: actual };
}

function evaluateCriterion({ criterion, carrierRow }) {
  const valueType = String(criterion.value_type || "").toUpperCase();
  const field = String(criterion.carrier_field || "");
  const rawValue = field ? carrierRow[field] : null;
  const operator = String(criterion.comparison_operator || "EQUALS").toUpperCase();

  if (!SUPPORTED_OPERATORS.has(operator)) {
    return {
      criteria_key: criterion.criteria_key,
      label: criterion.label,
      category: criterion.category,
      carrier_field: field,
      comparison_operator: operator,
      expected_value: {
        value_bool: criterion.value_bool,
        value_number: criterion.value_number,
        value_date: criterion.value_date,
        value_text: criterion.value_text
      },
      actual_value_raw: rawValue,
      actual_value_normalized: null,
      status: "FAIL",
      matched: false,
      reason: `Unsupported operator: ${operator}`
    };
  }

  let evaluation;
  if (valueType === "BOOLEAN") evaluation = evaluateBooleanCriterion({ criterion, rawValue });
  else if (valueType === "NUMBER") evaluation = evaluateNumberCriterion({ criterion, rawValue, carrierRow });
  else if (valueType === "ENUM") evaluation = evaluateEnumCriterion({ criterion, rawValue });
  else if (valueType === "DATE") {
    evaluation = { status: "FAIL", matched: false, reason: "DATE evaluation not supported yet", actualNormalized: normalizeText(rawValue) };
  } else {
    evaluation = { status: "FAIL", matched: false, reason: `Unsupported criteria value_type: ${valueType || "unknown"}`, actualNormalized: null };
  }

  return {
    criteria_key: criterion.criteria_key,
    label: criterion.label,
    category: criterion.category,
    carrier_field: field,
    comparison_operator: operator,
    expected_value: {
      value_bool: criterion.value_bool,
      value_number: criterion.value_number,
      value_date: criterion.value_date,
      value_text: criterion.value_text
    },
    actual_value_raw: rawValue,
    actual_value_normalized: evaluation.actualNormalized,
    status: evaluation.status,
    matched: evaluation.matched,
    reason: evaluation.reason
  };
}

function aggregateResults(criteriaResults) {
  let failed = 0;
  let matched = 0;

  for (const result of criteriaResults) {
    if (result.status === "FAIL") failed += 1;
    else if (result.status === "PASS") matched += 1;
  }

  const screeningStatus = failed > 0 ? "FAIL" : "PASS";
  return { screeningStatus, matchedCount: matched, failedCount: failed, reviewCount: 0 };
}

function evaluateGroup({ group, criteriaResults }) {
  const matchType = String(group?.match_type || "ALL").toUpperCase() === "ANY" ? "ANY" : "ALL";
  if (!Array.isArray(criteriaResults) || criteriaResults.length === 0) {
    return {
      group_id: group.id,
      group_name: group.group_name,
      match_type: matchType,
      status: "FAIL",
      reason: "Group has no criteria assigned",
      criteria: []
    };
  }

  const hasFail = criteriaResults.some((result) => result.status === "FAIL");
  const hasPass = criteriaResults.some((result) => result.status === "PASS");

  let status = "PASS";
  if (matchType === "ALL") {
    status = hasFail ? "FAIL" : "PASS";
  } else {
    status = hasPass ? "PASS" : "FAIL";
  }

  return {
    group_id: group.id,
    group_name: group.group_name,
    match_type: matchType,
    status,
    criteria: criteriaResults
  };
}

async function upsertScreeningResult({ companyId, profileId, dotNumber, aggregate, summary, client }) {
  const { rows } = await client.query(
    `
    INSERT INTO public.company_carrier_screening_results (
      company_id,
      profile_id,
      carrier_dot,
      screening_status,
      matched_count,
      failed_count,
      review_count,
      result_summary,
      evaluated_at,
      updated_at
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, NOW(), NOW())
    ON CONFLICT (company_id, profile_id, carrier_dot)
    DO UPDATE SET
      screening_status = EXCLUDED.screening_status,
      matched_count = EXCLUDED.matched_count,
      failed_count = EXCLUDED.failed_count,
      review_count = EXCLUDED.review_count,
      result_summary = EXCLUDED.result_summary,
      evaluated_at = NOW(),
      updated_at = NOW()
    RETURNING *
    `,
    [
      companyId,
      profileId,
      dotNumber,
      aggregate.screeningStatus,
      aggregate.matchedCount,
      aggregate.failedCount,
      aggregate.reviewCount,
      JSON.stringify(summary)
    ]
  );
  return rows[0];
}

async function updateUserCarrierScreeningCache({ companyId, profileId, dotNumber, screeningStatus, client }) {
  await client.query(
    `
    UPDATE public.user_carriers
    SET screening_profile_id = $3,
        screening_status = $4,
        screening_evaluated_at = NOW()
    WHERE company_id = $1
      AND carrier_dot = $2
    `,
    [companyId, dotNumber, profileId, screeningStatus]
  );
}

function isResultFresh(result, maxAgeMinutes) {
  const minutes = Number(maxAgeMinutes);
  if (!Number.isFinite(minutes) || minutes < 0) return false;
  const evalAt = result?.evaluated_at ? new Date(result.evaluated_at).getTime() : NaN;
  if (!Number.isFinite(evalAt)) return false;
  const maxAgeMs = minutes * 60 * 1000;
  return Date.now() - evalAt <= maxAgeMs;
}

async function screenCarrierForCompany({ companyId, dotNumber, client }) {
  const normalizedDot = normalizeDot(dotNumber);
  if (!companyId) throw new Error("companyId is required");
  if (!normalizedDot) throw new Error("dotNumber is required");

  const profile = await getDefaultActiveProfile({ companyId, client });
  if (!profile) {
    return {
      hasDefaultProfile: false,
      profile: null,
      result: null,
      status: "NO_PROFILE"
    };
  }

  return screenCarrierForProfile({
    companyId,
    dotNumber: normalizedDot,
    profile,
    client,
    updateUserCarrierCache: true
  });
}

async function screenCarrierForProfile({ companyId, dotNumber, profile, client, updateUserCarrierCache = false }) {
  const normalizedDot = normalizeDot(dotNumber);
  if (!profile?.id) throw new Error("profile is required");

  const carrier = await getCarrierByDot({ dotNumber: normalizedDot, client });
  if (!carrier) {
    throw new Error(`Carrier not found for DOT ${normalizedDot}`);
  }
  const insuranceSummary = await getCarrierInsuranceSummary({ dotNumber: normalizedDot, client });
  const screeningCarrierRow = {
    ...carrier,
    ...(insuranceSummary || {})
  };

  const criteria = await getEnabledCriteriaForProfile({ profileId: profile.id, client });
  const activeGroups = await getActiveGroupsForProfile({ profileId: profile.id, client });
  const memberships = await getGroupMembershipForProfile({ profileId: profile.id, client });
  const activeOverridesByProfileCriteriaId = await getActiveCriterionOverridesForProfile({
    companyId,
    dotNumber: normalizedDot,
    profileId: profile.id,
    client
  });

  const groupIdByProfileCriteriaId = new Map();
  for (const membership of memberships) {
    groupIdByProfileCriteriaId.set(String(membership.profile_criteria_id), membership.group_id);
  }

  const criteriaResults = criteria.map((criterion) => {
    const result = evaluateCriterion({ criterion, carrierRow: screeningCarrierRow });
    const override = activeOverridesByProfileCriteriaId.get(String(criterion.profile_criteria_id)) || null;
    const overriddenResult = applyCriterionOverride({ criterionResult: result, override });
    return {
      ...overriddenResult,
      profile_criteria_id: criterion.profile_criteria_id,
      group_id: groupIdByProfileCriteriaId.get(String(criterion.profile_criteria_id)) || null
    };
  });

  const standaloneCriteriaResults = criteriaResults.filter((result) => !result.group_id);
  const groupResults = activeGroups.map((group) => {
    const groupedCriteria = criteriaResults.filter((result) => String(result.group_id) === String(group.id));
    return evaluateGroup({ group, criteriaResults: groupedCriteria });
  });

  const aggregateInputs = [
    ...standaloneCriteriaResults,
    ...groupResults.map((group) => ({ status: group.status }))
  ];
  const aggregate = aggregateResults(aggregateInputs);

  const summary = {
    generated_at: new Date().toISOString(),
    standalone_criteria: standaloneCriteriaResults,
    groups: groupResults,
    criteria: criteriaResults
  };

  const saved = await upsertScreeningResult({
    companyId,
    profileId: profile.id,
    dotNumber: normalizedDot,
    aggregate,
    summary,
    client
  });

  if (updateUserCarrierCache) {
    await updateUserCarrierScreeningCache({
      companyId,
      profileId: profile.id,
      dotNumber: normalizedDot,
      screeningStatus: aggregate.screeningStatus,
      client
    });
  }

  return {
    hasDefaultProfile: true,
    profile,
    result: saved,
    status: "SCREENED"
  };
}

async function getOrCreateAllActiveProfileResultsForCompany({ companyId, dotNumber, client, maxAgeMinutes = 60 }) {
  const normalizedDot = normalizeDot(dotNumber);
  if (!companyId) throw new Error("companyId is required");
  if (!normalizedDot) throw new Error("dotNumber is required");

  const profiles = await getActiveProfilesForCompany({ companyId, client });
  const defaultProfile = profiles.find((profile) => profile.is_default) || null;

  if (!profiles.length) {
    return {
      hasDefaultProfile: false,
      defaultProfileId: null,
      profiles: []
    };
  }

  const profileResults = [];
  for (const profile of profiles) {
    const existing = await getExistingResult({
      companyId,
      profileId: profile.id,
      dotNumber: normalizedDot,
      client
    });

    if (existing && isResultFresh(existing, maxAgeMinutes)) {
      profileResults.push({
        profile_id: profile.id,
        profile_name: profile.profile_name,
        is_default: !!profile.is_default,
        result: existing,
        source: "CACHE_FRESH"
      });
      continue;
    }

    const screened = await screenCarrierForProfile({
      companyId,
      dotNumber: normalizedDot,
      profile,
      client,
      updateUserCarrierCache: false
    });

    profileResults.push({
      profile_id: profile.id,
      profile_name: profile.profile_name,
      is_default: !!profile.is_default,
      result: screened.result,
      source: existing ? "CACHE_STALE_RESCREENED" : "CACHE_MISS_SCREENED"
    });
  }

  return {
    hasDefaultProfile: !!defaultProfile,
    defaultProfileId: defaultProfile?.id || null,
    profiles: profileResults
  };
}

async function getOrCreateScreeningResultForCompany({ companyId, dotNumber, client, maxAgeMinutes = 60 }) {
  const normalizedDot = normalizeDot(dotNumber);
  if (!companyId) throw new Error("companyId is required");
  if (!normalizedDot) throw new Error("dotNumber is required");

  const profile = await getDefaultActiveProfile({ companyId, client });
  if (!profile) {
    return {
      hasDefaultProfile: false,
      profile: null,
      result: null,
      source: "NO_PROFILE"
    };
  }

  const existing = await getExistingResult({
    companyId,
    profileId: profile.id,
    dotNumber: normalizedDot,
    client
  });

  if (existing && isResultFresh(existing, maxAgeMinutes)) {
    return {
      hasDefaultProfile: true,
      profile,
      result: existing,
      source: "CACHE_FRESH"
    };
  }

  const screened = await screenCarrierForCompany({ companyId, dotNumber: normalizedDot, client });
  return { ...screened, source: existing ? "CACHE_STALE_RESCREENED" : "CACHE_MISS_SCREENED" };
}

async function getWatchingCompanyIdsForDot({ dotNumber, client }) {
  const { rows } = await client.query(
    `
    SELECT DISTINCT company_id
    FROM public.user_carriers
    WHERE carrier_dot = $1
    `,
    [dotNumber]
  );
  return rows.map((row) => row.company_id);
}

async function rescreenTrackedCarriersForCompany({ companyId, client }) {
  const { rows } = await client.query(
    `
    SELECT DISTINCT carrier_dot
    FROM public.user_carriers
    WHERE company_id = $1
    `,
    [companyId]
  );

  const outcomes = [];
  for (const row of rows) {
    const dotNumber = normalizeDot(row.carrier_dot);
    if (!dotNumber) continue;
    const outcome = await screenCarrierForCompany({ companyId, dotNumber, client });
    outcomes.push({ dotNumber, screeningStatus: outcome?.result?.screening_status || null, status: outcome.status });
  }
  return outcomes;
}

async function processDotForWatchingCompanies({ dotNumber, client }) {
  const normalizedDot = normalizeDot(dotNumber);
  const companyIds = await getWatchingCompanyIdsForDot({ dotNumber: normalizedDot, client });
  const results = [];

  for (const companyId of companyIds) {
    try {
      const screened = await screenCarrierForCompany({ companyId, dotNumber: normalizedDot, client });
      results.push({ companyId, ok: true, status: screened?.result?.screening_status || null });
    } catch (err) {
      results.push({ companyId, ok: false, error: err.message || String(err) });
    }
  }

  return { dotNumber: normalizedDot, companyIds, results };
}

let queueIdentifierColumnCache = null;

async function getQueueIdentifierColumn(client) {
  if (queueIdentifierColumnCache) return queueIdentifierColumnCache;

  const { rows } = await client.query(
    `
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'carrier_screening_queue'
      AND column_name IN ('id', 'dotnumber')
    `
  );

  const available = new Set(rows.map((row) => row.column_name));
  if (available.has("id")) {
    queueIdentifierColumnCache = "id";
    return queueIdentifierColumnCache;
  }
  if (available.has("dotnumber")) {
    queueIdentifierColumnCache = "dotnumber";
    return queueIdentifierColumnCache;
  }

  throw new Error("carrier_screening_queue must have either id or dotnumber column");
}

async function claimScreeningQueueBatch({ client, lockOwner, batchSize = 25, staleLockMinutes = 10 }) {
  const idColumn = await getQueueIdentifierColumn(client);
  const { rows } = await client.query(
    `
    WITH next_rows AS (
      SELECT ${idColumn} AS queue_identifier
      FROM public.carrier_screening_queue
      WHERE completed_at IS NULL
        AND (
          locked_at IS NULL
          OR locked_at < NOW() - ($3::int * INTERVAL '1 minute')
        )
      ORDER BY ${idColumn} ASC
      FOR UPDATE SKIP LOCKED
      LIMIT $2
    )
    UPDATE public.carrier_screening_queue q
    SET locked_at = NOW(),
        lock_owner = $1,
        attempts = COALESCE(q.attempts, 0) + 1,
        updated_at = NOW()
    FROM next_rows
    WHERE q.${idColumn} = next_rows.queue_identifier
    RETURNING q.*, q.${idColumn} AS queue_identifier, '${idColumn}'::text AS queue_identifier_column
    `,
    [lockOwner, batchSize, staleLockMinutes]
  );
  return rows;
}

async function markQueueRowComplete({ queueIdentifier, queueIdentifierColumn, client }) {
  const idColumn = queueIdentifierColumn || (await getQueueIdentifierColumn(client));
  await client.query(
    `
    UPDATE public.carrier_screening_queue
    SET completed_at = NOW(),
        locked_at = NULL,
        lock_owner = NULL,
        last_error = NULL,
        updated_at = NOW()
    WHERE ${idColumn} = $1
    `,
    [queueIdentifier]
  );
}

async function markQueueRowErrored({ queueIdentifier, queueIdentifierColumn, errorMessage, client }) {
  const idColumn = queueIdentifierColumn || (await getQueueIdentifierColumn(client));
  const truncated = String(errorMessage || "Unknown queue error").slice(0, 1000);
  await client.query(
    `
    UPDATE public.carrier_screening_queue
    SET locked_at = NULL,
        lock_owner = NULL,
        last_error = $2,
        updated_at = NOW()
    WHERE ${idColumn} = $1
    `,
    [queueIdentifier, truncated]
  );
}

async function withClient(fn) {
  const client = await pool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

module.exports = {
  normalizeText,
  normalizeBoolean,
  normalizeNumber,
  screenCarrierForCompany: (args) => (args.client ? screenCarrierForCompany(args) : withClient((client) => screenCarrierForCompany({ ...args, client }))),
  getOrCreateScreeningResultForCompany: (args) => (args.client ? getOrCreateScreeningResultForCompany(args) : withClient((client) => getOrCreateScreeningResultForCompany({ ...args, client }))),
  getOrCreateAllActiveProfileResultsForCompany: (args) => (args.client ? getOrCreateAllActiveProfileResultsForCompany(args) : withClient((client) => getOrCreateAllActiveProfileResultsForCompany({ ...args, client }))),
  rescreenTrackedCarriersForCompany: (args) => (args.client ? rescreenTrackedCarriersForCompany(args) : withClient((client) => rescreenTrackedCarriersForCompany({ ...args, client }))),
  processDotForWatchingCompanies,
  getWatchingCompanyIdsForDot,
  claimScreeningQueueBatch,
  markQueueRowComplete,
  markQueueRowErrored
};
