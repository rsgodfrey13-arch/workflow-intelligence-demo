"use strict";

const express = require("express");
const { pool: globalPool } = require("../../db/pool");
const { requireAuth } = require("../../middleware/requireAuth");
const { loadCompanyContext, requireCompanyAdmin } = require("../../middleware/companyContext");
const {
  getOrCreateScreeningResultForCompany,
  getOrCreateAllActiveProfileResultsForCompany,
  rescreenTrackedCarriersForCompany
} = require("../../services/carrierScreeningService");

const ALLOWED_COMPARISON_OPERATORS = new Set([
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


function normalizeEnumOptions(raw) {
  if (!raw) return [];

  const normalizeOne = (option) => {
    if (option && typeof option === "object" && !Array.isArray(option)) {
      const value = option.value === null || option.value === undefined
        ? ""
        : String(option.value).trim();

      const label = option.label === null || option.label === undefined || String(option.label).trim() === ""
        ? value
        : String(option.label).trim();

      return value ? { value, label } : null;
    }

    const value = option === null || option === undefined ? "" : String(option).trim();
    return value ? { value, label: value } : null;
  };

  if (Array.isArray(raw)) {
    return raw.map(normalizeOne).filter(Boolean);
  }

  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed.map(normalizeOne).filter(Boolean);
      }
    } catch {
      return raw
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean)
        .map((value) => ({ value, label: value }));
    }
  }

  return [];
}

function parseBool(value) {
  if (value === true || value === false) return value;
  return null;
}

function parseNumberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return parsed;
}

function normalizeDateOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const raw = String(value).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  return raw;
}

function normalizeIsoDateTimeOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
}

function normalizeGroupMatchType(value) {
  const token = String(value || "").trim().toUpperCase();
  if (token === "ALL" || token === "ANY") return token;
  return null;
}

function parseOverrideMode(value) {
  const mode = String(value || "").trim().toUpperCase();
  if (mode === "INDEFINITE" || mode === "DAYS_30" || mode === "UNTIL_DATE") return mode;
  return null;
}

async function invalidateCachedScreeningResultsForCarrier({ companyId, dot, client }) {
  await client.query(
    `
    DELETE FROM public.company_carrier_screening_results
    WHERE company_id = $1
      AND carrier_dot = $2
    `,
    [companyId, dot]
  );
}

function queueTrackedCarrierRescreen(companyId, reason) {
  setImmediate(async () => {
    try {
      await rescreenTrackedCarriersForCompany({ companyId });
    } catch (rescreenErr) {
      console.error(`Deferred ${reason} rescreen failed:`, rescreenErr);
    }
  });
}

function screeningRoutes({ pool } = {}) {
  const db = pool || globalPool;
  const router = express.Router();

router.get("/screening/profiles", requireAuth, loadCompanyContext, async (req, res) => {
  try {
    const { companyId } = req.companyContext;
    const { rows } = await db.query(
      `
      SELECT id, profile_name, is_default, is_active, created_at, updated_at
      FROM public.company_screening_profiles
      WHERE company_id = $1
      ORDER BY is_default DESC, created_at ASC
      `,
      [companyId]
    );

    return res.json({ profiles: rows });
  } catch (err) {
    console.error("GET /api/screening/profiles failed:", err);
    return res.status(500).json({ error: "Failed to load screening profiles" });
  }
});

router.post("/screening/profiles", requireAuth, loadCompanyContext, requireCompanyAdmin, async (req, res) => {
  try {
    const { companyId } = req.companyContext;
    const profileName = String(req.body?.profile_name || "").trim();
    if (!profileName) {
      return res.status(400).json({ error: "profile_name is required" });
    }

    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const countRes = await client.query(
        `SELECT COUNT(*)::int AS count FROM public.company_screening_profiles WHERE company_id = $1`,
        [companyId]
      );
      const isDefault = Number(countRes.rows[0]?.count || 0) === 0;

      const insertRes = await client.query(
        `
        INSERT INTO public.company_screening_profiles (company_id, profile_name, is_default, is_active)
        VALUES ($1, $2, $3, true)
        RETURNING id, profile_name, is_default, is_active, created_at, updated_at
        `,
        [companyId, profileName, isDefault]
      );

      await client.query("COMMIT");
      return res.json({ ok: true, profile: insertRes.rows[0] });
    } catch (innerErr) {
      await client.query("ROLLBACK");
      throw innerErr;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error("POST /api/screening/profiles failed:", err);
    return res.status(500).json({ error: "Failed to create screening profile" });
  }
});

router.patch("/screening/profiles/:profileId", requireAuth, loadCompanyContext, requireCompanyAdmin, async (req, res) => {
  try {
    const { companyId } = req.companyContext;
    const { profileId } = req.params;

    const updates = [];
    const values = [companyId, profileId];

    if (Object.prototype.hasOwnProperty.call(req.body || {}, "profile_name")) {
      const profileName = String(req.body.profile_name || "").trim();
      if (!profileName) {
        return res.status(400).json({ error: "profile_name cannot be empty" });
      }
      values.push(profileName);
      updates.push(`profile_name = $${values.length}`);
    }

    if (Object.prototype.hasOwnProperty.call(req.body || {}, "is_active")) {
      const isActive = parseBool(req.body.is_active);
      if (isActive === null) {
        return res.status(400).json({ error: "is_active must be a boolean" });
      }
      values.push(isActive);
      updates.push(`is_active = $${values.length}`);
    }

    if (!updates.length) {
      return res.status(400).json({ error: "No valid fields to update" });
    }

    values.push(new Date().toISOString());
    updates.push(`updated_at = $${values.length}`);

    const { rows } = await db.query(
      `
      UPDATE public.company_screening_profiles
      SET ${updates.join(", ")}
      WHERE company_id = $1
        AND id = $2
      RETURNING id, profile_name, is_default, is_active, created_at, updated_at
      `,
      values
    );

    if (!rows.length) return res.status(404).json({ error: "Profile not found" });
    return res.json({ ok: true, profile: rows[0] });
  } catch (err) {
    console.error("PATCH /api/screening/profiles/:profileId failed:", err);
    return res.status(500).json({ error: "Failed to update screening profile" });
  }
});

router.post("/screening/profiles/:profileId/set-default", requireAuth, loadCompanyContext, requireCompanyAdmin, async (req, res) => {
  const client = await db.connect();
  try {
    const { companyId } = req.companyContext;
    const { profileId } = req.params;

    await client.query("BEGIN");

    const check = await client.query(
      `
      SELECT id
      FROM public.company_screening_profiles
      WHERE company_id = $1
        AND id = $2
      LIMIT 1
      `,
      [companyId, profileId]
    );

    if (!check.rows.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Profile not found" });
    }

    await client.query(
      `
      UPDATE public.company_screening_profiles
      SET is_default = false,
          updated_at = now()
      WHERE company_id = $1
      `,
      [companyId]
    );

    await client.query(
      `
      UPDATE public.company_screening_profiles
      SET is_default = true,
          is_active = true,
          updated_at = now()
      WHERE company_id = $1
        AND id = $2
      `,
      [companyId, profileId]
    );

    await client.query("COMMIT");
    try {
      await rescreenTrackedCarriersForCompany({ companyId });
    } catch (rescreenErr) {
      console.error("Post default-profile rescreen failed:", rescreenErr);
    }
    return res.json({ ok: true });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("POST /api/screening/profiles/:profileId/set-default failed:", err);
    return res.status(500).json({ error: "Failed to set default screening profile" });
  } finally {
    client.release();
  }
});

router.delete("/screening/profiles/:profileId", requireAuth, loadCompanyContext, requireCompanyAdmin, async (req, res) => {
  try {
    const { companyId } = req.companyContext;
    const { profileId } = req.params;

    const profileRes = await db.query(
      `
      SELECT id, is_default
      FROM public.company_screening_profiles
      WHERE company_id = $1
        AND id = $2
      LIMIT 1
      `,
      [companyId, profileId]
    );

    const profile = profileRes.rows[0];
    if (!profile) return res.status(404).json({ error: "Profile not found" });
    if (profile.is_default) {
      return res.status(409).json({ error: "Default profile cannot be deleted" });
    }

    await db.query(
      `
      DELETE FROM public.company_screening_profiles
      WHERE company_id = $1
        AND id = $2
      `,
      [companyId, profileId]
    );

    return res.json({ ok: true });
  } catch (err) {
    console.error("DELETE /api/screening/profiles/:profileId failed:", err);
    return res.status(500).json({ error: "Failed to delete screening profile" });
  }
});

router.get("/screening/profiles/:profileId/criteria", requireAuth, loadCompanyContext, async (req, res) => {
  try {
    const { companyId } = req.companyContext;
    const { profileId } = req.params;

    const profileRes = await db.query(
      `
      SELECT id, profile_name, is_default, is_active
      FROM public.company_screening_profiles
      WHERE company_id = $1
        AND id = $2
      LIMIT 1
      `,
      [companyId, profileId]
    );

    if (!profileRes.rows.length) return res.status(404).json({ error: "Profile not found" });

    const criteriaRes = await db.query(
      `
      SELECT
        sc.id AS screening_criteria_id,
        sc.criteria_key,
        sc.label,
        sc.description,
        sc.value_type,
        sc.carrier_field,
        sc.category,
        sc.display_order,
        sc.enum_options,
        cspc.id AS profile_criteria_id,
        COALESCE(cspc.is_enabled, false) AS is_enabled,
        cspc.comparison_operator,
        cspc.value_bool,
        cspc.value_number,
        cspc.value_date,
        cspc.value_text,
        gc.group_id
      FROM public.screening_criteria sc
      LEFT JOIN public.company_screening_profile_criteria cspc
        ON cspc.profile_id = $1
       AND cspc.screening_criteria_id = sc.id
      LEFT JOIN public.company_screening_profile_group_criteria gc
        ON gc.profile_criteria_id = cspc.id
      WHERE sc.is_active = true
      ORDER BY sc.display_order ASC, sc.id ASC
      `,
      [profileId]
    );

    const criteria = criteriaRes.rows.map((row) => ({
      ...row,
      enum_options: normalizeEnumOptions(row.enum_options),
    }));

    return res.json({
      profile: profileRes.rows[0],
      criteria,
    });
  } catch (err) {
    console.error("GET /api/screening/profiles/:profileId/criteria failed:", err);
    return res.status(500).json({ error: "Failed to load screening criteria" });
  }
});

router.post("/screening/profiles/:profileId/criteria", requireAuth, loadCompanyContext, requireCompanyAdmin, async (req, res) => {
  const client = await db.connect();
  try {
    const { companyId } = req.companyContext;
    const { profileId } = req.params;
    const payload = Array.isArray(req.body?.criteria) ? req.body.criteria : null;

    if (!payload) {
      return res.status(400).json({ error: "criteria array is required" });
    }

    const profileRes = await client.query(
      `
      SELECT id
      FROM public.company_screening_profiles
      WHERE company_id = $1
        AND id = $2
      LIMIT 1
      `,
      [companyId, profileId]
    );
    if (!profileRes.rows.length) return res.status(404).json({ error: "Profile not found" });

    const criteriaDefs = await client.query(
      `
      SELECT id, value_type, enum_options
      FROM public.screening_criteria
      WHERE is_active = true
      `
    );

    const defsById = new Map(criteriaDefs.rows.map((r) => [String(r.id), r]));

    await client.query("BEGIN");

    for (const item of payload) {
      const criteriaId = String(item?.screening_criteria_id || "").trim();
      const def = defsById.get(criteriaId);
      if (!def) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: `Unknown screening_criteria_id: ${criteriaId || "missing"}` });
      }

      const valueType = String(def.value_type || "").toUpperCase();
      const isEnabled = parseBool(item?.is_enabled) || false;
      const comparisonOperatorRaw = item?.comparison_operator;
      const comparisonOperator = comparisonOperatorRaw === null || comparisonOperatorRaw === undefined || String(comparisonOperatorRaw).trim() === ""
        ? null
        : String(comparisonOperatorRaw).trim().toUpperCase();
      if (comparisonOperator && !ALLOWED_COMPARISON_OPERATORS.has(comparisonOperator)) {
        await client.query("ROLLBACK");
        return res.status(400).json({
          error: `Invalid comparison_operator for criteria ${criteriaId}: ${comparisonOperator}`
        });
      }
      let valueBool = null;
      let valueNumber = null;
      let valueDate = null;
      let valueText = null;

      if (valueType === "BOOLEAN") {
        if (item?.value_bool !== null && item?.value_bool !== undefined) {
          const parsed = parseBool(item.value_bool);
          if (parsed === null) {
            await client.query("ROLLBACK");
            return res.status(400).json({ error: `Invalid BOOLEAN value for criteria ${criteriaId}` });
          }
          valueBool = parsed;
        }
      } else if (valueType === "NUMBER") {
        if (item?.value_number !== null && item?.value_number !== undefined && item?.value_number !== "") {
          const parsed = parseNumberOrNull(item.value_number);
          if (parsed === null) {
            await client.query("ROLLBACK");
            return res.status(400).json({ error: `Invalid NUMBER value for criteria ${criteriaId}` });
          }
          valueNumber = parsed;
        }
      } else if (valueType === "DATE") {
        if (item?.value_date !== null && item?.value_date !== undefined && item?.value_date !== "") {
          const parsed = normalizeDateOrNull(item.value_date);
          if (!parsed) {
            await client.query("ROLLBACK");
            return res.status(400).json({ error: `Invalid DATE value for criteria ${criteriaId}` });
          }
          valueDate = parsed;
        }
      } else if (valueType === "ENUM") {
        if (item?.value_text !== null && item?.value_text !== undefined && item?.value_text !== "") {
          const options = normalizeEnumOptions(def.enum_options);
          const optionValues = options.map((opt) => opt.value);
          const enumOp = comparisonOperator || "EQUALS";
          const allowsMulti = enumOp === "IN" || enumOp === "NOT_IN";
          const rawValue = String(item.value_text).trim();
          
          if (allowsMulti) {
            const values = rawValue.split(",").map((v) => v.trim()).filter(Boolean);
            if (values.length === 0) {
              await client.query("ROLLBACK");
              return res.status(400).json({ error: `Invalid ENUM value for criteria ${criteriaId}` });
            }
            if (optionValues.length && values.some((v) => !optionValues.includes(v))) {
              await client.query("ROLLBACK");
              return res.status(400).json({ error: `Invalid ENUM value for criteria ${criteriaId}` });
            }
            valueText = values.join(", ");
          } else {
            const nextValue = rawValue.split(",").map((v) => v.trim()).filter(Boolean)[0] || "";
            if (!nextValue) {
              await client.query("ROLLBACK");
              return res.status(400).json({ error: `Invalid ENUM value for criteria ${criteriaId}` });
            }
            if (optionValues.length && !optionValues.includes(nextValue)) {
              await client.query("ROLLBACK");
              return res.status(400).json({ error: `Invalid ENUM value for criteria ${criteriaId}` });
            }
            valueText = nextValue;
          }
        }
      }

      await client.query(
        `
        INSERT INTO public.company_screening_profile_criteria (
          profile_id,
          screening_criteria_id,
          is_enabled,
          comparison_operator,
          value_bool,
          value_number,
          value_date,
          value_text,
          updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
        ON CONFLICT (profile_id, screening_criteria_id)
        DO UPDATE SET
          is_enabled = EXCLUDED.is_enabled,
          comparison_operator = EXCLUDED.comparison_operator,
          value_bool = EXCLUDED.value_bool,
          value_number = EXCLUDED.value_number,
          value_date = EXCLUDED.value_date,
          value_text = EXCLUDED.value_text,
          updated_at = now()
        `,
        [profileId, criteriaId, isEnabled, comparisonOperator, valueBool, valueNumber, valueDate, valueText]
      );
    }

    await client.query("COMMIT");
    try {
      await rescreenTrackedCarriersForCompany({ companyId });
    } catch (rescreenErr) {
      console.error("Post criteria-save rescreen failed:", rescreenErr);
    }
    return res.json({ ok: true });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("POST /api/screening/profiles/:profileId/criteria failed:", err);
    return res.status(500).json({ error: "Failed to save screening criteria" });
  } finally {
    client.release();
  }
});

router.get("/screening/profiles/:profileId/groups", requireAuth, loadCompanyContext, async (req, res) => {
  try {
    const { companyId } = req.companyContext;
    const { profileId } = req.params;

    const profileRes = await db.query(
      `
      SELECT id
      FROM public.company_screening_profiles
      WHERE company_id = $1
        AND id = $2
      LIMIT 1
      `,
      [companyId, profileId]
    );
    if (!profileRes.rows.length) return res.status(404).json({ error: "Profile not found" });

    const groupsRes = await db.query(
      `
      SELECT id, profile_id, group_name, match_type, display_order, is_active, created_at, updated_at
      FROM public.company_screening_profile_groups
      WHERE profile_id = $1
      ORDER BY display_order ASC, created_at ASC, id ASC
      `,
      [profileId]
    );

    const membersRes = await db.query(
      `
      SELECT
        gc.group_id,
        gc.profile_criteria_id,
        gc.display_order,
        sc.id AS screening_criteria_id,
        sc.criteria_key,
        sc.label,
        cspc.is_enabled
      FROM public.company_screening_profile_group_criteria gc
      JOIN public.company_screening_profile_criteria cspc
        ON cspc.id = gc.profile_criteria_id
      JOIN public.screening_criteria sc
        ON sc.id = cspc.screening_criteria_id
      WHERE cspc.profile_id = $1
      ORDER BY gc.display_order ASC, gc.created_at ASC, gc.id ASC
      `,
      [profileId]
    );

    const criteriaByGroupId = new Map();
    for (const row of membersRes.rows) {
      const key = String(row.group_id);
      if (!criteriaByGroupId.has(key)) criteriaByGroupId.set(key, []);
      criteriaByGroupId.get(key).push(row);
    }

    const groups = groupsRes.rows.map((group) => ({
      ...group,
      criteria: criteriaByGroupId.get(String(group.id)) || []
    }));

    return res.json({ groups });
  } catch (err) {
    console.error("GET /api/screening/profiles/:profileId/groups failed:", err);
    return res.status(500).json({ error: "Failed to load screening rule groups" });
  }
});

router.post("/screening/profiles/:profileId/groups", requireAuth, loadCompanyContext, requireCompanyAdmin, async (req, res) => {
  try {
    const { companyId } = req.companyContext;
    const { profileId } = req.params;
    const groupName = String(req.body?.group_name || "").trim();
    const matchType = normalizeGroupMatchType(req.body?.match_type || "ALL");
    const displayOrder = parseNumberOrNull(req.body?.display_order) ?? 0;

    if (!groupName) return res.status(400).json({ error: "group_name is required" });
    if (!matchType) return res.status(400).json({ error: "match_type must be ALL or ANY" });

    const profileRes = await db.query(
      `SELECT id FROM public.company_screening_profiles WHERE company_id = $1 AND id = $2 LIMIT 1`,
      [companyId, profileId]
    );
    if (!profileRes.rows.length) return res.status(404).json({ error: "Profile not found" });

    const { rows } = await db.query(
      `
      INSERT INTO public.company_screening_profile_groups (profile_id, group_name, match_type, display_order, is_active)
      VALUES ($1, $2, $3, $4, true)
      RETURNING id, profile_id, group_name, match_type, display_order, is_active, created_at, updated_at
      `,
      [profileId, groupName, matchType, Math.trunc(displayOrder)]
    );

    try {
      await rescreenTrackedCarriersForCompany({ companyId });
    } catch (rescreenErr) {
      console.error("Post group-create rescreen failed:", rescreenErr);
    }
    return res.json({ ok: true, group: rows[0] });
  } catch (err) {
    console.error("POST /api/screening/profiles/:profileId/groups failed:", err);
    return res.status(500).json({ error: "Failed to create screening rule group" });
  }
});

router.patch("/screening/profiles/:profileId/groups/:groupId", requireAuth, loadCompanyContext, requireCompanyAdmin, async (req, res) => {
  try {
    const { companyId } = req.companyContext;
    const { profileId, groupId } = req.params;

    const profileRes = await db.query(
      `SELECT id FROM public.company_screening_profiles WHERE company_id = $1 AND id = $2 LIMIT 1`,
      [companyId, profileId]
    );
    if (!profileRes.rows.length) return res.status(404).json({ error: "Profile not found" });

    const updates = [];
    const values = [profileId, groupId];

    if (Object.prototype.hasOwnProperty.call(req.body || {}, "group_name")) {
      const value = String(req.body.group_name || "").trim();
      if (!value) return res.status(400).json({ error: "group_name cannot be empty" });
      values.push(value);
      updates.push(`group_name = $${values.length}`);
    }
    if (Object.prototype.hasOwnProperty.call(req.body || {}, "match_type")) {
      const value = normalizeGroupMatchType(req.body.match_type);
      if (!value) return res.status(400).json({ error: "match_type must be ALL or ANY" });
      values.push(value);
      updates.push(`match_type = $${values.length}`);
    }
    if (Object.prototype.hasOwnProperty.call(req.body || {}, "display_order")) {
      const value = parseNumberOrNull(req.body.display_order);
      if (value === null) return res.status(400).json({ error: "display_order must be numeric" });
      values.push(Math.trunc(value));
      updates.push(`display_order = $${values.length}`);
    }
    if (Object.prototype.hasOwnProperty.call(req.body || {}, "is_active")) {
      const value = parseBool(req.body.is_active);
      if (value === null) return res.status(400).json({ error: "is_active must be boolean" });
      values.push(value);
      updates.push(`is_active = $${values.length}`);
    }
    if (!updates.length) return res.status(400).json({ error: "No valid fields to update" });

    updates.push("updated_at = now()");
    const { rows } = await db.query(
      `
      UPDATE public.company_screening_profile_groups
      SET ${updates.join(", ")}
      WHERE profile_id = $1
        AND id = $2
      RETURNING id, profile_id, group_name, match_type, display_order, is_active, created_at, updated_at
      `,
      values
    );
    if (!rows.length) return res.status(404).json({ error: "Group not found" });

    try {
      await rescreenTrackedCarriersForCompany({ companyId });
    } catch (rescreenErr) {
      console.error("Post group-update rescreen failed:", rescreenErr);
    }
    return res.json({ ok: true, group: rows[0] });
  } catch (err) {
    console.error("PATCH /api/screening/profiles/:profileId/groups/:groupId failed:", err);
    return res.status(500).json({ error: "Failed to update screening rule group" });
  }
});

router.delete("/screening/profiles/:profileId/groups/:groupId", requireAuth, loadCompanyContext, requireCompanyAdmin, async (req, res) => {
  try {
    const { companyId } = req.companyContext;
    const { profileId, groupId } = req.params;

    const profileRes = await db.query(
      `SELECT id FROM public.company_screening_profiles WHERE company_id = $1 AND id = $2 LIMIT 1`,
      [companyId, profileId]
    );
    if (!profileRes.rows.length) return res.status(404).json({ error: "Profile not found" });

    const { rowCount } = await db.query(
      `DELETE FROM public.company_screening_profile_groups WHERE profile_id = $1 AND id = $2`,
      [profileId, groupId]
    );
    if (!rowCount) return res.status(404).json({ error: "Group not found" });

    try {
      await rescreenTrackedCarriersForCompany({ companyId });
    } catch (rescreenErr) {
      console.error("Post group-delete rescreen failed:", rescreenErr);
    }
    return res.json({ ok: true });
  } catch (err) {
    console.error("DELETE /api/screening/profiles/:profileId/groups/:groupId failed:", err);
    return res.status(500).json({ error: "Failed to delete screening rule group" });
  }
});

router.post("/screening/profiles/:profileId/groups/:groupId/rules", requireAuth, loadCompanyContext, requireCompanyAdmin, async (req, res) => {
  const client = await db.connect();
  try {
    const { companyId } = req.companyContext;
    const { profileId, groupId } = req.params;
    const requestedIds = Array.isArray(req.body?.profile_criteria_ids) ? req.body.profile_criteria_ids : null;
    if (!requestedIds) return res.status(400).json({ error: "profile_criteria_ids array is required" });

    const normalizedIds = Array.from(
      new Set(
        requestedIds
          .map((value) => parseNumberOrNull(value))
          .filter((value) => Number.isFinite(value))
          .map((value) => Math.trunc(value))
      )
    );

    await client.query("BEGIN");

    const profileRes = await client.query(
      `SELECT id FROM public.company_screening_profiles WHERE company_id = $1 AND id = $2 LIMIT 1`,
      [companyId, profileId]
    );
    if (!profileRes.rows.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Profile not found" });
    }

    const groupRes = await client.query(
      `SELECT id FROM public.company_screening_profile_groups WHERE profile_id = $1 AND id = $2 LIMIT 1`,
      [profileId, groupId]
    );
    if (!groupRes.rows.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Group not found" });
    }

    if (normalizedIds.length > 0) {
      const criteriaRes = await client.query(
        `
        SELECT id, is_enabled
        FROM public.company_screening_profile_criteria
        WHERE profile_id = $1
          AND id = ANY($2::bigint[])
        `,
        [profileId, normalizedIds]
      );

      if (criteriaRes.rows.length !== normalizedIds.length) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "All profile_criteria_ids must belong to the profile" });
      }
      if (criteriaRes.rows.some((row) => !row.is_enabled)) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "Only enabled profile criteria can be assigned to groups" });
      }
    }

    await client.query(
      `DELETE FROM public.company_screening_profile_group_criteria WHERE group_id = $1`,
      [groupId]
    );

    for (let i = 0; i < normalizedIds.length; i += 1) {
      await client.query(
        `
        INSERT INTO public.company_screening_profile_group_criteria (group_id, profile_criteria_id, display_order)
        VALUES ($1, $2, $3)
        `,
        [groupId, normalizedIds[i], i]
      );
    }

    await client.query("COMMIT");
    try {
      await rescreenTrackedCarriersForCompany({ companyId });
    } catch (rescreenErr) {
      console.error("Post group-rules-save rescreen failed:", rescreenErr);
    }
    return res.json({ ok: true });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("POST /api/screening/profiles/:profileId/groups/:groupId/rules failed:", err);
    return res.status(500).json({ error: "Failed to update group rule membership" });
  } finally {
    client.release();
  }
});

router.patch("/screening/profiles/:profileId/criteria/:profileCriteriaId/group", requireAuth, loadCompanyContext, requireCompanyAdmin, async (req, res) => {
  const client = await db.connect();
  try {
    const { companyId } = req.companyContext;
    const { profileId, profileCriteriaId } = req.params;
    const rawGroupId = req.body?.group_id;
    const groupId = rawGroupId === null || rawGroupId === undefined || String(rawGroupId).trim() === ""
      ? null
      : String(rawGroupId).trim();

    await client.query("BEGIN");

    const profileRes = await client.query(
      `SELECT id FROM public.company_screening_profiles WHERE company_id = $1 AND id = $2 LIMIT 1`,
      [companyId, profileId]
    );
    if (!profileRes.rows.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Profile not found" });
    }

    const criterionRes = await client.query(
      `
      SELECT id, is_enabled
      FROM public.company_screening_profile_criteria
      WHERE profile_id = $1
        AND id = $2::bigint
      LIMIT 1
      `,
      [profileId, profileCriteriaId]
    );
    if (!criterionRes.rows.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Profile criterion not found" });
    }

    if (groupId) {
      const groupRes = await client.query(
        `SELECT id FROM public.company_screening_profile_groups WHERE profile_id = $1 AND id = $2 LIMIT 1`,
        [profileId, groupId]
      );
      if (!groupRes.rows.length) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "Group not found" });
      }
      if (!criterionRes.rows[0].is_enabled) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "Only enabled profile criteria can be assigned to groups" });
      }
    }

    await client.query(
      `
      DELETE FROM public.company_screening_profile_group_criteria
      WHERE profile_criteria_id = $1::bigint
      `,
      [profileCriteriaId]
    );

    if (groupId) {
      const nextDisplayOrderRes = await client.query(
        `
        SELECT COALESCE(MAX(display_order), -1) + 1 AS next_display_order
        FROM public.company_screening_profile_group_criteria
        WHERE group_id = $1
        `,
        [groupId]
      );
      const nextDisplayOrder = Number(nextDisplayOrderRes.rows[0]?.next_display_order || 0);

      await client.query(
        `
        INSERT INTO public.company_screening_profile_group_criteria (group_id, profile_criteria_id, display_order)
        VALUES ($1, $2::bigint, $3)
        `,
        [groupId, profileCriteriaId, nextDisplayOrder]
      );
    }

    await client.query("COMMIT");

    try {
      await rescreenTrackedCarriersForCompany({ companyId });
    } catch (rescreenErr) {
      console.error("Post criterion-group reassignment rescreen failed:", rescreenErr);
    }

    return res.json({ ok: true });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("PATCH /api/screening/profiles/:profileId/criteria/:profileCriteriaId/group failed:", err);
    return res.status(500).json({ error: "Failed to update criterion group assignment" });
  } finally {
    client.release();
  }
});

router.post("/screening/carriers/:dot/profiles/:profileId/criteria/:profileCriteriaId/override", requireAuth, loadCompanyContext, async (req, res) => {
  const client = await db.connect();
  try {
    const { companyId } = req.companyContext;
    const userId = Number(req.session?.userId) || null;
    const dot = String(req.params.dot || "").replace(/\D/g, "");
    const { profileId, profileCriteriaId } = req.params;
    if (!dot) return res.status(400).json({ error: "Valid DOT is required" });

    const mode = parseOverrideMode(req.body?.mode);
    if (!mode) return res.status(400).json({ error: "mode must be INDEFINITE, DAYS_30, or UNTIL_DATE" });

    let expiresAt = null;
    if (mode === "DAYS_30") {
      const date = new Date();
      date.setUTCDate(date.getUTCDate() + 30);
      expiresAt = date.toISOString();
    } else if (mode === "UNTIL_DATE") {
      expiresAt = normalizeIsoDateTimeOrNull(req.body?.expires_at);
      if (!expiresAt) return res.status(400).json({ error: "expires_at must be a valid ISO datetime when mode is UNTIL_DATE" });
    }

    const noteRaw = req.body?.note;
    const note = noteRaw === null || noteRaw === undefined ? null : String(noteRaw).trim() || null;

    await client.query("BEGIN");

    const profileRes = await client.query(
      `
      SELECT id
      FROM public.company_screening_profiles
      WHERE company_id = $1
        AND id = $2
      LIMIT 1
      `,
      [companyId, profileId]
    );
    if (!profileRes.rows.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Profile not found" });
    }

    const criterionRes = await client.query(
      `
      SELECT id
      FROM public.company_screening_profile_criteria
      WHERE profile_id = $1
        AND id = $2::bigint
      LIMIT 1
      `,
      [profileId, profileCriteriaId]
    );
    if (!criterionRes.rows.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Profile criterion not found" });
    }

    await client.query(
      `
      INSERT INTO public.company_carrier_screening_overrides (
        company_id,
        carrier_dot,
        profile_id,
        profile_criteria_id,
        expires_at,
        note,
        created_by,
        is_active,
        created_at,
        updated_at
      )
      VALUES ($1, $2, $3, $4::bigint, $5::timestamptz, $6, $7, true, NOW(), NOW())
      ON CONFLICT (company_id, carrier_dot, profile_id, profile_criteria_id)
      DO UPDATE SET
        expires_at = EXCLUDED.expires_at,
        note = EXCLUDED.note,
        is_active = true,
        created_by = COALESCE(public.company_carrier_screening_overrides.created_by, EXCLUDED.created_by),
        updated_at = NOW()
      `,
      [companyId, dot, profileId, profileCriteriaId, expiresAt, note, userId]
    );
    await invalidateCachedScreeningResultsForCarrier({ companyId, dot, client });

    await client.query("COMMIT");
    res.json({ ok: true });
    queueTrackedCarrierRescreen(companyId, "override-save");
    return;
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("POST /api/screening/carriers/:dot/profiles/:profileId/criteria/:profileCriteriaId/override failed:", err);
    return res.status(500).json({ error: "Failed to save screening override" });
  } finally {
    client.release();
  }
});

router.delete("/screening/carriers/:dot/profiles/:profileId/criteria/:profileCriteriaId/override", requireAuth, loadCompanyContext, async (req, res) => {
  const client = await db.connect();
  try {
    const { companyId } = req.companyContext;
    const dot = String(req.params.dot || "").replace(/\D/g, "");
    const { profileId, profileCriteriaId } = req.params;
    if (!dot) return res.status(400).json({ error: "Valid DOT is required" });

    await client.query("BEGIN");
    await client.query(
      `
      UPDATE public.company_carrier_screening_overrides
      SET is_active = false,
          updated_at = NOW()
      WHERE company_id = $1
        AND carrier_dot = $2
        AND profile_id = $3
        AND profile_criteria_id = $4::bigint
      `,
      [companyId, dot, profileId, profileCriteriaId]
    );
    await invalidateCachedScreeningResultsForCarrier({ companyId, dot, client });
    await client.query("COMMIT");
    res.json({ ok: true });
    queueTrackedCarrierRescreen(companyId, "override-remove");
    return;
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("DELETE /api/screening/carriers/:dot/profiles/:profileId/criteria/:profileCriteriaId/override failed:", err);
    return res.status(500).json({ error: "Failed to remove screening override" });
  } finally {
    client.release();
  }
});

router.get("/screening/carriers/:dot/default-result", requireAuth, loadCompanyContext, async (req, res) => {
  try {
    const { companyId } = req.companyContext;
    const dot = String(req.params.dot || "").replace(/\D/g, "");
    if (!dot) return res.status(400).json({ error: "Valid DOT is required" });
    const maxAgeMinutes = Number(process.env.CARRIER_SCREENING_MAX_AGE_MINUTES || 60);
    const response = await getOrCreateScreeningResultForCompany({
      companyId,
      dotNumber: dot,
      maxAgeMinutes
    });

    return res.json({
      has_default_profile: response.hasDefaultProfile,
      profile: response.profile,
      result: response.result,
      source: response.source
    });
  } catch (err) {
    console.error("GET /api/screening/carriers/:dot/default-result failed:", err);
    return res.status(500).json({ error: "Failed to load screening result" });
  }
});

router.get("/screening/carriers/:dot/profile-results", requireAuth, loadCompanyContext, async (req, res) => {
  try {
    const { companyId } = req.companyContext;
    const dot = String(req.params.dot || "").replace(/\D/g, "");
    if (!dot) return res.status(400).json({ error: "Valid DOT is required" });
    const maxAgeMinutes = Number(process.env.CARRIER_SCREENING_MAX_AGE_MINUTES || 60);
    const response = await getOrCreateAllActiveProfileResultsForCompany({
      companyId,
      dotNumber: dot,
      maxAgeMinutes
    });

    return res.json({
      has_default_profile: response.hasDefaultProfile,
      default_profile_id: response.defaultProfileId,
      profiles: response.profiles
    });
  } catch (err) {
    console.error("GET /api/screening/carriers/:dot/profile-results failed:", err);
    return res.status(500).json({ error: "Failed to load screening profile results" });
  }
});

  return router;
}

module.exports = screeningRoutes;
