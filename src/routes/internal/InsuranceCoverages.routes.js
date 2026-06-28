"use strict";

const express = require("express");
const { pool } = require("../../db/pool");
const { requireAuth } = require("../../middleware/requireAuth");
const { loadCompanyContext } = require("../../middleware/companyContext");

const router = express.Router();

function canViewerAccessInsuranceDocument(docRow, companyId) {
  // Contract for frontend: structured coverage data may be visible even when
  // document viewing is not. UI must use explicit can_view_document and never
  // infer ownership. PDF endpoint still enforces authorization independently.
  if (!companyId) return false;
  if (!docRow?.company_id) return false;
  return String(docRow.company_id) === String(companyId);
}

// GET /api/carriers/:dot/insurance-coverages
router.get("/carriers/:dot/insurance-coverages", requireAuth, loadCompanyContext, async (req, res) => {
  const dot = String(req.params.dot || "").replace(/\D/g, "");
  if (!dot) return res.status(400).json({ error: "Missing DOT" });
  const companyId = req.companyContext?.companyId || null;

const sql = `
  WITH cov AS (
    SELECT
      c.id,
      c.coverage_type,
      c.coverage_type_raw,
      c.insurer_name,
      c.policy_number,
      c.insurer_letter,
      c.additional_insured,
      c.subrogation_waived,
      c.effective_date,
      c.expiration_date,
      c.created_at,
      c.document_id
    FROM public.insurance_coverages c
    WHERE c.dot_number = $1
  )
  SELECT
    c.*,
    COALESCE(lim.limits, '[]'::jsonb) AS limits
  FROM cov c
  LEFT JOIN LATERAL (
    SELECT jsonb_agg(
      jsonb_build_object(
        'label', l."label",
        'currency', l.currency,
        'amount', l.amount,
        'amount_primary', l.amount_primary,
        'amount_secondary', l.amount_secondary,
        'amount_text', l.amount_text,
        'value_text', l.value_text,
        'sort_order', l.sort_order
      )
      ORDER BY
        (l.sort_order IS NULL) ASC,
        l.sort_order ASC,
        l."label" ASC
    ) AS limits
    FROM public.insurance_coverage_limits l
    WHERE l.coverage_id = c.id
  ) lim ON true
  ORDER BY
    c.expiration_date DESC NULLS LAST,
    c.coverage_type ASC,
    c.created_at DESC;
`;

  try {
    // 1) Load coverages (existing logic)
    const { rows } = await pool.query(sql, [dot]);
  
    // If parsed coverages exist, we're done
    if (rows.length > 0) {
      const documentIds = [
        ...new Set(
          rows
            .map((row) => row.document_id)
            .filter((documentId) => documentId !== null && documentId !== undefined)
        ),
      ];

      const docById = new Map();
      if (documentIds.length > 0) {
        const docsRes = await pool.query(
          `
          SELECT id, company_id
          FROM public.insurance_documents
          WHERE id = ANY($1::uuid[]);
          `,
          [documentIds]
        );

        for (const doc of docsRes.rows) {
          docById.set(String(doc.id), doc);
        }
      }

      const rowsWithVisibility = rows.map((row) => {
        const doc = row.document_id ? docById.get(String(row.document_id)) : null;
        return {
          ...row,
          can_view_document: canViewerAccessInsuranceDocument(doc, companyId),
        };
      });

      return res.json({ mode: "STRUCTURED", rows: rowsWithVisibility, document: null });
    }
  
    // 2) No coverages → check if there's a COI document on file
    const docRes = await pool.query(
      `
      SELECT id, uploaded_at, company_id
      FROM public.insurance_documents
      WHERE dot_number = $1
        AND document_type = 'COI'
      ORDER BY uploaded_at DESC NULLS LAST
      LIMIT 1;
      `,
      [dot]
    );
  
    if (docRes.rows.length > 0) {
      const document = docRes.rows[0];
      return res.json({
        mode: "ON_FILE",
        rows: [],
        document: {
          id: document.id,
          uploaded_at: document.uploaded_at,
          can_view_document: canViewerAccessInsuranceDocument(document, companyId),
        },
      });
    }
  
    // 3) Nothing at all
    return res.json({ mode: "MISSING", rows: [], document: null });
  } catch (e) {
    console.error("carrier insurance coverages error", e);
    return res.status(500).json({ error: "Failed to load insurance coverages" });
  }
});

module.exports = router;
