// api-v1.js
const express = require("express");
const crypto = require("crypto");
const rateLimit = require("express-rate-limit");
const { getPolicyForUser } = require("../../policies/importPolicy");
const { sendContractEmail } = require("../../clients/mailgun");
const {
  buildEmptyInsuranceSummary,
  buildInsuranceDataFromCoverageRows,
  buildInsuranceSummariesByDot,
  mergeDocumentOnlyDotsIntoSummaries,
} = require("./carrierInsurance.helpers");

function getCompanyId(req) {
  return req.auth?.companyId || req.company?.id || null;
}

function getCompanyPlan(req) {
  return req.auth?.plan || "FREE";
}


function getCompanyPolicy(req) {
  return getPolicyForUser({
    companyId: getCompanyId(req),
    plan: getCompanyPlan(req),
  });
}

function getApiAuthContext(req, res) {
  const companyId = getCompanyId(req);
  if (!companyId) {
    res.status(401).json({ error: 'Not authorized' });
    return null;
  }

  return {
    companyId,
    plan: getCompanyPlan(req),
  };
}

function appendCompanyScope({ conditions, params, alias, companyId, startIndex }) {
  conditions.push(`${alias}.company_id = $${startIndex}`);
  params.push(companyId);
  return startIndex + 1;
}

function isValidContractIdentifier(value) {
  return /^\d+$/.test(value) || /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function makeToken() {
  return crypto.randomBytes(24).toString("hex");
}

function getTrimmedLength(value) {
  return String(value ?? "").trim().length;
}

function hasValue(value) {
  return getTrimmedLength(value) > 0;
}

function getNormalizedSearchInput(query = {}) {
  return {
    dot: String(query.dot ?? "").trim(),
    mc: String(query.mc ?? "").trim(),
    legalname: String(query.legalname ?? "").trim(),
    dbaname: String(query.dbaname ?? "").trim(),
    city: String(query.city ?? "").trim(),
    state: String(query.state ?? "").trim(),
  };
}

function validateCarrierSearchInput(searchInput) {
  const hasDot = hasValue(searchInput.dot);
  const hasMc = hasValue(searchInput.mc);
  const hasLegalname = hasValue(searchInput.legalname);
  const hasDbaname = hasValue(searchInput.dbaname);
  const hasCity = hasValue(searchInput.city);
  const hasState = hasValue(searchInput.state);

  if (hasState && !hasCity && !hasLegalname && !hasDbaname && !hasDot && !hasMc) {
    return {
      valid: false,
      error: "state alone is too broad; combine it with city, legalname, or dbaname.",
    };
  }

  if (hasCity && !hasState && !hasDot && !hasMc && !hasLegalname && !hasDbaname) {
    return {
      valid: false,
      error: "city alone is too broad; include state.",
    };
  }

  if (hasDot) {
    return { valid: true };
  }

  if (hasMc) {
    return { valid: true };
  }

  if (getTrimmedLength(searchInput.legalname) > 0 && getTrimmedLength(searchInput.legalname) < 3) {
    return {
      valid: false,
      error: "Search requires dot, mc, legalname (3+ chars), dbaname (3+ chars), or city + state.",
    };
  }

  if (getTrimmedLength(searchInput.dbaname) > 0 && getTrimmedLength(searchInput.dbaname) < 3) {
    return {
      valid: false,
      error: "Search requires dot, mc, legalname (3+ chars), dbaname (3+ chars), or city + state.",
    };
  }

  if (getTrimmedLength(searchInput.legalname) >= 3) {
    return { valid: true };
  }

  if (getTrimmedLength(searchInput.dbaname) >= 3) {
    return { valid: true };
  }

  if (getTrimmedLength(searchInput.city) >= 2 && getTrimmedLength(searchInput.state) >= 2) {
    return { valid: true };
  }

  return {
    valid: false,
    error: "Search requires dot, mc, legalname (3+ chars), dbaname (3+ chars), or city + state.",
  };
}

function createExternalCarrierSearchLimiter() {
  return rateLimit({
    windowMs: 60 * 1000,
    max: 6,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => {
      const companyId = getCompanyId(req);
      if (companyId) return `company:${companyId}`;

      const apiKey = String(
        req.auth?.apiKey ||
        req.auth?.apiKeyId ||
        req.auth?.key ||
        req.get("x-api-key") ||
        ""
      ).trim();
      if (apiKey) return `api_key:${apiKey}`;

      return req.ip;
    },
    handler: (req, res) => {
      res.status(429).json({
        error: "Carrier search rate limit exceeded. Please slow down.",
      });
    },
  });
}


function createApiV1(pool) {
  const router = express.Router();
  const externalCarrierSearchLimiter = createExternalCarrierSearchLimiter();

  if (!pool || typeof pool.query !== "function") {
    throw new Error("V1 router initialized without a valid pool");
  }

  async function loadInsuranceSummariesForDots(companyId, dots) {
    if (!companyId || !Array.isArray(dots) || dots.length === 0) {
      return new Map();
    }

    const [coverageRes, documentRes] = await Promise.all([
      pool.query(
        `
        SELECT c.*
        FROM public.insurance_coverages c
        JOIN public.insurance_documents d
          ON d.id = c.document_id
        WHERE d.company_id = $1
          AND c.dot_number = ANY($2::text[]);
        `,
        [companyId, dots]
      ),
      pool.query(
        `
        SELECT DISTINCT d.dot_number
        FROM public.insurance_documents d
        WHERE d.company_id = $1
          AND d.dot_number = ANY($2::text[]);
        `,
        [companyId, dots]
      ),
    ]);

    const summariesByDot = buildInsuranceSummariesByDot(coverageRes.rows);
    const dotsWithDocuments = documentRes.rows.map((row) => row.dot_number);
    return mergeDocumentOnlyDotsIntoSummaries(summariesByDot, dotsWithDocuments);
  }

  
function normalizeAlertIds(input) {
  if (!input) return [];

  const arr = Array.isArray(input) ? input : [input];

  // numeric strings -> ints, dedupe
  return [...new Set(
    arr
      .map(x => String(x).trim())
      .filter(x => /^\d+$/.test(x))
      .map(x => parseInt(x, 10))
  )];
}

function normalizeRecipientList(input) {
  const values = Array.isArray(input) ? input : [input];
  return [...new Set(
    values
      .flatMap(v => String(v || '').split(','))
      .map(v => v.trim().toLowerCase())
      .filter(Boolean)
  )];
}
  
function normalizeIdArray(input) {
  if (!input) return [];
  const arr = Array.isArray(input) ? input : [input];
  const isUuid = (value) => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);

  return [...new Set(
    arr
      .map((x) => String(x).trim())
      .filter((x) => /^\d+$/.test(x) || isUuid(x))
  )];
}

function normalizeDotArray(input) {
  if (!input) return [];
  const arr = Array.isArray(input) ? input : [input];
  return [...new Set(
    arr
      .map(d => String(d).trim())
      .filter(d => /^\d+$/.test(d))
  )];
}

function normalizeDotsWithInvalid(input) {
  const invalid = [];
  const cleaned = [];

  const arr = Array.isArray(input) ? input : [input];

  for (const raw of arr) {
    const s = String(raw ?? '').trim();
    if (!s) continue;

    // keep digits only
    const digits = s.replace(/\D/g, '');

    // DOT is typically up to 7 digits
    if (digits.length < 1 || digits.length > 7) {
      invalid.push(s);
      continue;
    }

    cleaned.push(digits);
  }

  const unique = [...new Set(cleaned)];
  return { unique, invalid };
}

function carrierSelectColumns(alias = 'c', { includeCompatibilityAliases = true } = {}) {
  const columns = [`${alias}.*`];

  if (includeCompatibilityAliases) {
    columns.unshift(`${alias}.dotnumber AS dot`);
  }

  return columns.join(',\n        ');
}

;

// ---------------------------------------------
// GET /api/v1/me/carriers/import-limits
// tells UI the limits + current usage
// ---------------------------------------------
router.get('/me/carriers/import-limits', async (req, res) => {
  try {
    const companyId = getCompanyId(req);
    if (!companyId) return res.status(401).json({ error: 'Not authorized' });

    const policy = getCompanyPolicy(req);

    const countRes = await pool.query(
      `SELECT COUNT(*)::int AS current_total
       FROM user_carriers
       WHERE company_id = $1;`,
      [companyId]
    );

    res.json({
      plan: getCompanyPlan(req),
      max_total: policy.MAX_TOTAL,
      max_per_import: policy.MAX_PER_IMPORT,
      chunk_size: policy.CHUNK_SIZE,
      current_total: countRes.rows[0].current_total
    });
  } catch (err) {
    console.error('Error in GET /api/v1/me/carriers/import-limits:', err);
    res.status(500).json({ error: 'Failed to load import limits' });
  }
});

// ---------------------------------------------
// POST /api/v1/me/carriers/import
// Body: { "dots": ["336075","123456", ...] }
// Bulk add carriers to My Carriers with plan caps
// ---------------------------------------------
router.post('/me/carriers/import', async (req, res) => {
  try {
    const companyId = getCompanyId(req);
    if (!companyId) return res.status(401).json({ error: 'Not authorized' });

    const policy = getCompanyPolicy(req);

    // Client sends { dots: [...] }
    const { unique, invalid } = normalizeDotsWithInvalid(req.body?.dots);

    // Enforce per-import cap
    let accepted = unique;
    let rejected_due_to_import_limit = 0;

    if (accepted.length > policy.MAX_PER_IMPORT) {
      rejected_due_to_import_limit = accepted.length - policy.MAX_PER_IMPORT;
      accepted = accepted.slice(0, policy.MAX_PER_IMPORT);
    }

    // Enforce max total carriers cap (FREE_MAX_TOTAL etc.)
    const countRes = await pool.query(
      `SELECT COUNT(*)::int AS current_total
       FROM user_carriers
       WHERE company_id = $1;`,
      [companyId]
    );

    const currentTotal = countRes.rows[0].current_total;
    const remainingCapacity = Math.max(0, policy.MAX_TOTAL - currentTotal);

    let rejected_due_to_plan_limit = 0;
    if (accepted.length > remainingCapacity) {
      rejected_due_to_plan_limit = accepted.length - remainingCapacity;
      accepted = accepted.slice(0, remainingCapacity);
    }

    // If nothing can be inserted, return summary
    if (accepted.length === 0) {
      return res.json({
        received: unique.length,
        valid_unique: unique.length,
        attempted: 0,
        inserted: 0,
        already_had: 0,
        rejected_due_to_import_limit,
        rejected_due_to_plan_limit,
        invalid_count: invalid.length,
        invalid_sample: invalid.slice(0, policy.MAX_INVALID_TO_RETURN)
      });
    }

    // IMPORTANT: Your current /me/carriers endpoint requires carriers exist.
    // For "lenient", we will NOT check carriers table here.
    // We'll just insert into user_carriers and let your UI join show what exists.
    //
    // Ensure you have a UNIQUE constraint on (company_id, carrier_dot)

    const insertRes = await pool.query(
      `
      WITH input(d) AS (
        SELECT UNNEST($2::text[])
      )
      INSERT INTO user_carriers (company_id, carrier_dot, added_at)
      SELECT $1, d, NOW()
      FROM input
      ON CONFLICT (company_id, carrier_dot) DO NOTHING
      RETURNING carrier_dot;
      `,
      [companyId, accepted]
    );

    const inserted = insertRes.rowCount;
    const already_had = accepted.length - inserted;

    res.json({
      received: unique.length,
      valid_unique: unique.length,
      attempted: accepted.length,
      inserted,
      already_had,
      rejected_due_to_import_limit,
      rejected_due_to_plan_limit,
      invalid_count: invalid.length,
      invalid_sample: invalid.slice(0, policy.MAX_INVALID_TO_RETURN)
    });
  } catch (err) {
    console.error('Error in POST /api/v1/me/carriers/import:', err);
    res.status(500).json({ error: 'Failed to import carriers' });
  }
});


  
  

  // ---------------------------------------------
  // GET /api/v1/carriers/:dot  (mounted as /carriers/:dot here)
  // ---------------------------------------------
  router.get('/carriers/:dot', async (req, res) => {
    const auth = getApiAuthContext(req, res);
    if (!auth) return;

    const dot = req.params.dot;
    const companyId = auth.companyId;

    try {
      const carrierColumns = carrierSelectColumns('c');
      const carrierResult = await pool.query(`
        SELECT
          ${carrierColumns},
          c.phystreet AS address1,
          NULL AS address2,
          c.phycity AS city,
          c.phystate AS state,
          c.phyzipcode AS zip,
          TO_CHAR(c.retrieval_date::timestamp, 'Mon DD, YYYY HH12:MI AM EST') AS retrieval_date_formatted
        FROM public.carriers c
        WHERE c.dotnumber = $1;
      `, [dot]);

      if (carrierResult.rows.length === 0) {
        return res.status(404).json({ error: 'Carrier not found' });
      }

      const carrier = carrierResult.rows[0];

      const cargoResult = await pool.query(
        `SELECT cargo_desc, cargo_class
         FROM public.cargo
         WHERE dot_number = $1
         ORDER BY cargo_desc;`,
        [dot]
      );

      carrier.cargo_carried = cargoResult.rows.map(r => r.cargo_desc);
      const insuranceResult = await pool.query(
        `
        SELECT c.*
        FROM public.insurance_coverages c
        JOIN public.insurance_documents d
          ON d.id = c.document_id
        WHERE c.dot_number = $1
          AND d.company_id = $2
        ORDER BY c.expiration_date DESC NULLS LAST, c.created_at DESC;
        `,
        [dot, companyId]
      );

      const insuranceData = buildInsuranceDataFromCoverageRows(insuranceResult.rows);
      if (
        insuranceData.insurance_coverages.length === 0 &&
        !insuranceData.insurance_summary.has_on_file
      ) {
        const insuranceDocumentResult = await pool.query(
          `
          SELECT 1
          FROM public.insurance_documents d
          WHERE d.dot_number = $1
            AND d.company_id = $2
          LIMIT 1;
          `,
          [dot, companyId]
        );

        if (insuranceDocumentResult.rowCount > 0) {
          // Document-only fallback: treat as on-file but not yet fully
          // structured into coverage rows, so we avoid marking definitively expired.
          insuranceData.insurance_summary.has_on_file = true;
          insuranceData.insurance_summary.has_structured_coverages = false;
          insuranceData.insurance_summary.is_expired = false;
        }
      }

      carrier.insurance_summary = insuranceData.insurance_summary;
      carrier.insurance_coverages = insuranceData.insurance_coverages;

      res.json(carrier);
    } catch (err) {
      console.error("V1 DB ERROR:", err);   // <— Temp Debug
      console.error('Error in GET /api/v1/carriers/:dot:', err);
      res.status(500).json({ error: 'Database query failed' });
    }
  });

// ---------------------------------------------
// GET /api/v1/carriers — field-based search / list
// External carrier search is intentionally lookup-oriented.
// Broad extraction should use saved carriers or enterprise workflows.
// Strict rate limits are intentional to discourage bulk polling.
// ---------------------------------------------
router.get('/carriers', externalCarrierSearchLimiter, async (req, res) => {
  try {
    const auth = getApiAuthContext(req, res);
    if (!auth) return;

    const companyId = auth.companyId;
    const { page = 1, pageSize = 25 } = req.query;
    const searchInput = getNormalizedSearchInput(req.query);

    const parsedPage = parseInt(page, 10) || 1;
    const parsedPageSize = parseInt(pageSize, 10) || 25;

    if (parsedPageSize > 25) {
      return res.status(400).json({ error: "pageSize cannot exceed 25." });
    }

    if (parsedPage > 5) {
      return res.status(400).json({ error: "page cannot exceed 5 for carrier search." });
    }

    const validation = validateCarrierSearchInput(searchInput);
    if (!validation.valid) {
      return res.status(400).json({ error: validation.error });
    }

    const limit = Math.min(parsedPageSize, 25);
    const offset = (parsedPage - 1) * limit;

    const conditions = [];
    const params = [];
    let i = 1;

    if (searchInput.dot) {
      conditions.push(`c.dotnumber = $${i}`);
      params.push(searchInput.dot);
      i++;
    }

    if (searchInput.mc) {
      conditions.push(`c.mc_number = $${i}`);
      params.push(searchInput.mc);
      i++;
    }

    if (searchInput.legalname) {
      conditions.push(`c.legalname ILIKE $${i}`);
      params.push(`%${searchInput.legalname}%`);
      i++;
    }

    if (searchInput.dbaname) {
      conditions.push(`c.dbaname ILIKE $${i}`);
      params.push(`%${searchInput.dbaname}%`);
      i++;
    }

    if (searchInput.city) {
      conditions.push(`c.phycity ILIKE $${i}`);
      params.push(`%${searchInput.city}%`);
      i++;
    }

    if (searchInput.state) {
      conditions.push(`c.phystate ILIKE $${i}`);
      params.push(`%${searchInput.state}%`);
      i++;
    }

    const whereClause = `WHERE ${conditions.join(' AND ')}`;
    const carrierColumns = carrierSelectColumns('c');

    const sql = `
      SELECT
        ${carrierColumns}
      FROM carriers c
      ${whereClause}
      ORDER BY c.legalname
      LIMIT ${limit} OFFSET ${offset};
    `;

    const countSql = `
      SELECT COUNT(*)::int AS count
      FROM carriers c
      ${whereClause};
    `;

    const [dataResult, countResult] = await Promise.all([
      pool.query(sql, params),
      pool.query(countSql, params)
    ]);

    const dots = [...new Set(
      dataResult.rows
        .map((row) => row.dotnumber || row.dot)
        .filter((value) => value !== null && value !== undefined)
        .map((value) => String(value))
    )];

    const summariesByDot = await loadInsuranceSummariesForDots(companyId, dots);

    const rowsWithInsuranceSummary = dataResult.rows.map((row) => {
      const dotKey = String(row.dotnumber || row.dot || "");
      return {
        ...row,
        insurance_summary: summariesByDot.get(dotKey) || buildEmptyInsuranceSummary(),
      };
    });

    res.json({
      rows: rowsWithInsuranceSummary,
      total: countResult.rows[0].count,
      page: parsedPage,
      pageSize: limit
    });
  } catch (err) {
    console.error('Error in GET /api/v1/carriers:', err);
    res.status(500).json({ error: 'Search failed' });
  }
});

  // ---------------------------------------------
// GET /api/v1/me/carriers — user's carriers
// ---------------------------------------------
router.get('/me/carriers', async (req, res) => {
  try {
    const auth = getApiAuthContext(req, res);
    if (!auth) return;

    const companyId = auth.companyId;

    const {
      dot,
      mc,
      legalname,
      dbaname,
      city,
      state,
      page = 1,
      pageSize = 25
    } = req.query;

    const limit = Math.min(parseInt(pageSize, 10) || 25, 100);
    const offset = (parseInt(page, 10) - 1) * limit;

    // Base condition: this company's saved carriers
    const conditions = ['uc.company_id = $1'];
    const params = [companyId];
    let i = 2; // start at $2 because $1 is company_id

    if (dot) {
      conditions.push(`c.dotnumber = $${i}`);
      params.push(dot);
      i++;
    }

    if (mc) {
      conditions.push(`c.mc_number = $${i}`);
      params.push(mc);
      i++;
    }

    if (legalname) {
      conditions.push(`c.legalname ILIKE $${i}`);
      params.push(`%${legalname}%`);
      i++;
    }

    if (dbaname) {
      conditions.push(`c.dbaname ILIKE $${i}`);
      params.push(`%${dbaname}%`);
      i++;
    }

    if (city) {
      conditions.push(`c.phycity ILIKE $${i}`);
      params.push(`%${city}%`);
      i++;
    }

    if (state) {
      conditions.push(`c.phystate ILIKE $${i}`);
      params.push(`%${state}%`);
      i++;
    }

    const whereClause = `WHERE ${conditions.join(' AND ')}`;
    const carrierColumns = carrierSelectColumns('c');

    const sql = `
      SELECT
        ${carrierColumns},
        uc.added_at
      FROM user_carriers uc
      JOIN carriers c
        ON c.dotnumber = uc.carrier_dot
      ${whereClause}
      ORDER BY c.legalname
      LIMIT ${limit} OFFSET ${offset};
    `;

    const countSql = `
      SELECT COUNT(*)::int AS count
      FROM user_carriers uc
      JOIN carriers c
        ON c.dotnumber = uc.carrier_dot
      ${whereClause};
    `;

    const [dataResult, countResult] = await Promise.all([
      pool.query(sql, params),
      pool.query(countSql, params)
    ]);

    const dots = [...new Set(
      dataResult.rows
        .map((row) => row.dotnumber || row.dot)
        .filter((value) => value !== null && value !== undefined)
        .map((value) => String(value))
    )];

    const summariesByDot = await loadInsuranceSummariesForDots(companyId, dots);
    const rowsWithInsuranceSummary = dataResult.rows.map((row) => {
      const dotKey = String(row.dotnumber || row.dot || "");
      return {
        ...row,
        insurance_summary: summariesByDot.get(dotKey) || buildEmptyInsuranceSummary(),
      };
    });

    res.json({
      rows: rowsWithInsuranceSummary,
      total: countResult.rows[0].count,
      page: parseInt(page, 10),
      pageSize: limit
    });
  } catch (err) {
    console.error('Error in GET /api/v1/me/carriers:', err);
    res.status(500).json({ error: 'Failed to load company carriers' });
  }
});


// ---------------------------------------------
// POST /api/v1/me/carriers — Add 1 or many carriers
// ---------------------------------------------
router.post('/me/carriers', async (req, res) => {
  try {
    const companyId = getCompanyId(req);
    if (!companyId) {
      return res.status(401).json({ error: 'Not authorized' });
    }

    let { dot } = req.body || {};

    // Normalize into an array:
    // "336075" → ["336075"]
    // ["336075", "123456"] → ["336075", "123456"]
    if (!dot) {
      return res.status(400).json({ error: 'dot is required' });
    }

    let dots = Array.isArray(dot) ? dot : [dot];

    // Clean + numeric validation + dedupe
    dots = dots
      .map(d => String(d).trim())
      .filter(d => /^\d+$/.test(d));

    const uniqueDots = [...new Set(dots)];

    if (uniqueDots.length === 0) {
      return res.status(400).json({ error: 'No valid DOT numbers provided' });
    }

    let inserted = 0;
    let duplicates = 0;
    let invalid = 0;
    const details = [];

    for (const d of uniqueDots) {
      // Carrier must exist
      const exists = await pool.query(
        'SELECT 1 FROM carriers WHERE dotnumber = $1 LIMIT 1;',
        [d]
      );

      if (exists.rowCount === 0) {
        invalid++;
        details.push({ dot: d, status: 'invalid' });
        continue;
      }

      // Insert (idempotent)
      const result = await pool.query(
        `
        INSERT INTO user_carriers (company_id, carrier_dot)
        VALUES ($1, $2)
        ON CONFLICT (company_id, carrier_dot) DO NOTHING;
        `,
        [companyId, d]
      );

      if (result.rowCount === 1) {
        inserted++;
        details.push({ dot: d, status: 'inserted' });
      } else {
        duplicates++;
        details.push({ dot: d, status: 'already_saved' });
      }
    }

    res.json({
      summary: {
        totalSubmitted: uniqueDots.length,
        inserted,
        duplicates,
        invalid
      },
      details
    });

  } catch (err) {
    console.error('Error in POST /api/v1/me/carriers:', err);
    res.status(500).json({ error: 'Failed to add carriers' });
  }
});


// ---------------------------------------------
// DELETE /api/v1/me/carriers — Remove 1 or many carriers
// ---------------------------------------------
router.delete('/me/carriers', async (req, res) => {
  try {
    const companyId = getCompanyId(req);
    if (!companyId) {
      return res.status(401).json({ error: 'Not authorized' });
    }

    let { dot } = req.body || {};

    if (!dot) {
      return res.status(400).json({ error: 'dot is required' });
    }

    // Normalize to array
    let dots = Array.isArray(dot) ? dot : [dot];

    // Clean + numeric-only + dedupe
    dots = dots
      .map(d => String(d).trim())
      .filter(d => /^\d+$/.test(d));

    const uniqueDots = [...new Set(dots)];

    if (uniqueDots.length === 0) {
      return res.status(400).json({ error: 'No valid DOT numbers provided' });
    }

    // Delete in bulk and see what was actually removed
    const deleteResult = await pool.query(
      `
      DELETE FROM user_carriers
      WHERE company_id = $1
        AND carrier_dot = ANY($2::text[])
      RETURNING carrier_dot;
      `,
      [companyId, uniqueDots]
    );

    const deletedDots = deleteResult.rows.map(r => r.carrier_dot);
    const deletedSet = new Set(deletedDots);

    const details = uniqueDots.map(d => ({
      dot: d,
      status: deletedSet.has(d) ? 'deleted' : 'not_found'
    }));

    const deleted = deletedDots.length;
    const notFound = uniqueDots.length - deleted;

    res.json({
      summary: {
        totalSubmitted: uniqueDots.length,
        deleted,
        notFound
      },
      details
    });
  } catch (err) {
    console.error('Error in DELETE /api/v1/me/carriers:', err);
    res.status(500).json({ error: 'Failed to remove carriers' });
  }
});

// ---------------------------------------------
// GET /api/v1/carriers/:dot/alerts
// Returns payload objects (info -> changes -> carrier)
// Includes all statuses except ERROR
// ---------------------------------------------
router.get('/carriers/:dot/alerts', async (req, res) => {
  try {
    const auth = getApiAuthContext(req, res);
    if (!auth) return;

    const dot = String(req.params.dot || '').trim();
    const {
      id,
      status,
      page = 1,
      pageSize = 25
    } = req.query;

    const limit = Math.min(parseInt(pageSize, 10) || 25, 100);
    const offset = (parseInt(page, 10) - 1) * limit;

    const conditions = [
      "ra.channel = 'API'",
      'ra.dotnumber = $1',
      "ra.status <> 'ERROR'"
    ];
    const params = [dot];
    let i = 2;

    i = appendCompanyScope({
      conditions,
      params,
      alias: 'ra',
      companyId: auth.companyId,
      startIndex: i,
    });

    if (id) {
      conditions.push(`ra.alert_id = $${i}`);
      params.push(id);
      i++;
    }

    if (status) {
      conditions.push(`ra.status = $${i}`);
      params.push(status);
      i++;
    }

    const whereClause = `WHERE ${conditions.join(' AND ')}`;
    const sql = `
      SELECT ra.alert_id, ra.dotnumber, ra.payload, ra.created_at, ra.status
      FROM rest_alerts ra
      ${whereClause}
      ORDER BY ra.created_at DESC
      LIMIT $${i} OFFSET $${i + 1};
    `;
    const countSql = `
      SELECT COUNT(*)::int AS count
      FROM rest_alerts ra
      ${whereClause};
    `;

    const [dataResult, countResult] = await Promise.all([
      pool.query(sql, [...params, limit, offset]),
      pool.query(countSql, params)
    ]);

    const rows = dataResult.rows.map(row => {
      const payload = (typeof row.payload === 'string') ? JSON.parse(row.payload) : row.payload;

      return {
        info: {
          alert_id: row.alert_id,
          event_id: payload.event_id,
          event_type: payload.event_type,
          dotnumber: row.dotnumber,
          occurred_at: payload.occurred_at,
          status: row.status,
          created_at: row.created_at
        },
        changes: payload.changes,
        carrier: payload.carrier
      };
    });

    res.json({
      rows,
      total: countResult.rows[0].count,
      page: parseInt(page, 10),
      pageSize: limit
    });
  } catch (err) {
    console.error('Error in GET /api/v1/carriers/:dot/alerts:', err);
    res.status(500).json({ error: 'Failed to load carrier alerts' });
  }
});

// PATCH /api/v1/alerts/processed
// Body: { "alerts": ["46","47"] }
router.patch('/alerts/processed', async (req, res) => {
  try {
    const auth = getApiAuthContext(req, res);
    if (!auth) return;

    const alertIds = normalizeAlertIds(req.body?.alerts);
    if (alertIds.length === 0) {
      return res.status(400).json({ error: 'alerts array is required (numeric ids)' });
    }

    const updateResult = await pool.query(
      `
      UPDATE rest_alerts
      SET status = 'PROCESSED'
      WHERE company_id = $1
        AND UPPER(channel) = 'API'
        AND alert_id = ANY($2::int[])
      RETURNING alert_id;
      `,
      [auth.companyId, alertIds]
    );

    const updatedIds = updateResult.rows.map(r => String(r.alert_id));
    const updatedSet = new Set(updatedIds);

    res.json({
      summary: {
        totalSubmitted: alertIds.length,
        updated: updatedIds.length,
        notFound: alertIds.length - updatedIds.length
      },
      details: alertIds.map(id => ({
        id: String(id),
        status: updatedSet.has(String(id)) ? 'processed' : 'not_found'
      }))
    });
  } catch (err) {
    console.error('Error in PATCH /api/v1/alerts/processed:', err);
    res.status(500).json({ error: 'Failed to mark alerts processed' });
  }
});

// PATCH /api/v1/alerts/unprocessed
// Body: { "alerts": ["46","47"] }
router.patch('/alerts/unprocessed', async (req, res) => {
  try {
    const auth = getApiAuthContext(req, res);
    if (!auth) return;

    const alertIds = normalizeAlertIds(req.body?.alerts);
    if (alertIds.length === 0) {
      return res.status(400).json({ error: 'alerts array is required (numeric ids)' });
    }

    const updateResult = await pool.query(
      `
      UPDATE rest_alerts
      SET status = 'NEW'
      WHERE company_id = $1
        AND UPPER(channel) = 'API'
        AND alert_id = ANY($2::int[])
      RETURNING alert_id;
      `,
      [auth.companyId, alertIds]
    );

    const updatedIds = updateResult.rows.map(r => String(r.alert_id));
    const updatedSet = new Set(updatedIds);

    res.json({
      summary: {
        totalSubmitted: alertIds.length,
        updated: updatedIds.length,
        notFound: alertIds.length - updatedIds.length
      },
      details: alertIds.map(id => ({
        id: String(id),
        status: updatedSet.has(String(id)) ? 'unprocessed' : 'not_found'
      }))
    });
  } catch (err) {
    console.error('Error in PATCH /api/v1/alerts/unprocessed:', err);
    res.status(500).json({ error: 'Failed to mark alerts unprocessed' });
  }
});

// ---------------------------------------------
// GET /api/v1/alerts
// Returns payload objects (info -> changes -> carrier)
// Includes all statuses except ERROR
// Filterable by: id, status, dotnumber
// ---------------------------------------------
router.get('/alerts', async (req, res) => {
  try {
    const auth = getApiAuthContext(req, res);
    if (!auth) return;

    const {
      id,
      status,
      dotnumber,
      page = 1,
      pageSize = 25
    } = req.query;

    const limit = Math.min(parseInt(pageSize, 10) || 25, 100);
    const offset = (parseInt(page, 10) - 1) * limit;

    const conditions = [
      "ra.channel = 'API'",
      "ra.status <> 'ERROR'"
    ];
    const params = [];
    let i = 1;

    i = appendCompanyScope({
      conditions,
      params,
      alias: 'ra',
      companyId: auth.companyId,
      startIndex: i,
    });

    if (id) {
      conditions.push(`ra.alert_id = $${i}`);
      params.push(id);
      i++;
    }

    if (status) {
      conditions.push(`ra.status = $${i}`);
      params.push(status);
      i++;
    }

    if (dotnumber) {
      conditions.push(`ra.dotnumber = $${i}`);
      params.push(dotnumber);
      i++;
    }

    const whereClause = `WHERE ${conditions.join(' AND ')}`;
    const sql = `
      SELECT ra.alert_id, ra.dotnumber, ra.payload, ra.created_at, ra.status
      FROM rest_alerts ra
      ${whereClause}
      ORDER BY ra.created_at DESC
      LIMIT $${i} OFFSET $${i + 1};
    `;
    const countSql = `
      SELECT COUNT(*)::int AS count
      FROM rest_alerts ra
      ${whereClause};
    `;

    const [dataResult, countResult] = await Promise.all([
      pool.query(sql, [...params, limit, offset]),
      pool.query(countSql, params)
    ]);

    const rows = dataResult.rows.map(row => {
      const payload = (typeof row.payload === 'string') ? JSON.parse(row.payload) : row.payload;

      return {
        info: {
          alert_id: row.alert_id,
          event_id: payload.event_id,
          event_type: payload.event_type,
          dotnumber: row.dotnumber,
          occurred_at: payload.occurred_at,
          status: row.status,
          created_at: row.created_at
        },
        changes: payload.changes,
        carrier: payload.carrier
      };
    });

    res.json({
      rows,
      total: countResult.rows[0].count,
      page: parseInt(page, 10),
      pageSize: limit
    });
  } catch (err) {
    console.error('Error in GET /api/v1/alerts:', err);
    res.status(500).json({ error: 'Failed to load alerts' });
  }
});

// ---------------------------------------------
// GET /api/v1/alerts/new
// Returns only status = 'NEW'
// ---------------------------------------------
router.get('/alerts/new', async (req, res) => {
  try {
    const auth = getApiAuthContext(req, res);
    if (!auth) return;

    const {
      id,
      dotnumber,
      page = 1,
      pageSize = 25
    } = req.query;

    const limit = Math.min(parseInt(pageSize, 10) || 25, 100);
    const offset = (parseInt(page, 10) - 1) * limit;

    const conditions = [
      "ra.channel = 'API'",
      "ra.status = 'NEW'"
    ];
    const params = [];
    let i = 1;

    i = appendCompanyScope({
      conditions,
      params,
      alias: 'ra',
      companyId: auth.companyId,
      startIndex: i,
    });

    if (id) {
      conditions.push(`ra.alert_id = $${i}`);
      params.push(id);
      i++;
    }

    if (dotnumber) {
      conditions.push(`ra.dotnumber = $${i}`);
      params.push(dotnumber);
      i++;
    }

    const whereClause = `WHERE ${conditions.join(' AND ')}`;
    const sql = `
      SELECT ra.alert_id, ra.dotnumber, ra.payload, ra.created_at, ra.status
      FROM rest_alerts ra
      ${whereClause}
      ORDER BY ra.created_at DESC
      LIMIT $${i} OFFSET $${i + 1};
    `;
    const countSql = `
      SELECT COUNT(*)::int AS count
      FROM rest_alerts ra
      ${whereClause};
    `;

    const [dataResult, countResult] = await Promise.all([
      pool.query(sql, [...params, limit, offset]),
      pool.query(countSql, params)
    ]);

    const rows = dataResult.rows.map(row => {
      const payload = (typeof row.payload === 'string') ? JSON.parse(row.payload) : row.payload;

      return {
        info: {
          alert_id: row.alert_id,
          event_id: payload.event_id,
          event_type: payload.event_type,
          dotnumber: row.dotnumber,
          occurred_at: payload.occurred_at,
          status: row.status,
          created_at: row.created_at
        },
        changes: payload.changes,
        carrier: payload.carrier
      };
    });

    res.json({
      rows,
      total: countResult.rows[0].count,
      page: parseInt(page, 10),
      pageSize: limit
    });
  } catch (err) {
    console.error('Error in GET /api/v1/alerts/new:', err);
    res.status(500).json({ error: 'Failed to load NEW alerts' });
  }
});

// =============================
// CONTRACT ROUTES (v1)
// Status lifecycle:
// SENT -> COMPLETED -> PROCESSED
// =============================

// helper to select a contract + carrier
function contractSelectSql(whereClause) {
  return `
    SELECT
      c.contract_id,
      c.company_id,
      c.dotnumber,
      c.status,
      c.created_at,
      c.updated_at,
      c.sent_at,
      c.signed_at,
      c.provider,
      c.external_id,
      c.payload,
      to_jsonb(car) AS carrier
    FROM contracts c
    JOIN carriers car
      ON car.dotnumber = c.dotnumber
    ${whereClause}
  `;
}

// ---------------------------------------------
// GET /api/v1/contracts/new
// "new" = COMPLETED (ready for broker), NOT PROCESSED yet
// ---------------------------------------------
router.get('/contracts/new', async (req, res) => {
  try {
    const auth = getApiAuthContext(req, res);
    if (!auth) return;

    const page = parseInt(req.query.page, 10) || 1;
    const pageSizeRaw = parseInt(req.query.pageSize, 10) || 25;
    const limit = Math.min(pageSizeRaw, 100);
    const offset = (page - 1) * limit;

    const conditions = ["c.status = 'SIGNED'"];
    const params = [];
    let i = appendCompanyScope({
      conditions,
      params,
      alias: 'c',
      companyId: auth.companyId,
      startIndex: 1,
    });
    const whereClause = `WHERE ${conditions.join(' AND ')}`;

    const sql = `
      ${contractSelectSql(whereClause)}
      ORDER BY c.created_at DESC
      LIMIT $${i} OFFSET $${i + 1};
    `;
    const countSql = `
      SELECT COUNT(*)::int AS count
      FROM contracts c
      ${whereClause};
    `;

    const [dataResult, countResult] = await Promise.all([
      pool.query(sql, [...params, limit, offset]),
      pool.query(countSql, params)
    ]);

    res.json({
      contracts: dataResult.rows.map(r => ({
        contract: {
          contract_id: r.contract_id,
          dotnumber: r.dotnumber,
          status: r.status,
          created_at: r.created_at,
          updated_at: r.updated_at,
          sent_at: r.sent_at,
          signed_at: r.signed_at,
          provider: r.provider,
          external_id: r.external_id,
          payload: r.payload
        },
        carrier: r.carrier
      })),
      total: countResult.rows[0].count,
      page,
      pageSize: limit
    });
  } catch (err) {
    console.error('Error in GET /api/v1/contracts/new:', err);
    res.status(500).json({ error: 'Failed to load new contracts' });
  }
});

// ---------------------------------------------
// GET /api/v1/carriers/:dot/contracts
// ---------------------------------------------
router.get('/carriers/:dot/contracts', async (req, res) => {
  try {
    const auth = getApiAuthContext(req, res);
    if (!auth) return;

    const dot = String(req.params.dot || '').trim();
    if (!/^\d+$/.test(dot)) return res.status(400).json({ error: 'Invalid DOT' });

    const page = parseInt(req.query.page, 10) || 1;
    const pageSizeRaw = parseInt(req.query.pageSize, 10) || 25;
    const limit = Math.min(pageSizeRaw, 100);
    const offset = (page - 1) * limit;

    const conditions = ['c.dotnumber = $1'];
    const params = [dot];
    const i = appendCompanyScope({
      conditions,
      params,
      alias: 'c',
      companyId: auth.companyId,
      startIndex: 2,
    });
    const whereClause = `WHERE ${conditions.join(' AND ')}`;

    const sql = `
      ${contractSelectSql(whereClause)}
      ORDER BY c.created_at DESC
      LIMIT $${i} OFFSET $${i + 1};
    `;
    const countSql = `
      SELECT COUNT(*)::int AS count
      FROM contracts c
      ${whereClause};
    `;

    const [dataResult, countResult] = await Promise.all([
      pool.query(sql, [...params, limit, offset]),
      pool.query(countSql, params)
    ]);

    res.json({
      contracts: dataResult.rows.map(r => ({
        contract: {
          contract_id: r.contract_id,
          dotnumber: r.dotnumber,
          status: r.status,
          created_at: r.created_at,
          updated_at: r.updated_at,
          sent_at: r.sent_at,
          signed_at: r.signed_at,
          provider: r.provider,
          external_id: r.external_id,
          payload: r.payload
        },
        carrier: r.carrier
      })),
      total: countResult.rows[0].count,
      page,
      pageSize: limit
    });
  } catch (err) {
    console.error('Error in GET /api/v1/carriers/:dot/contracts:', err);
    res.status(500).json({ error: 'Failed to load carrier contracts' });
  }
});

// ---------------------------------------------
// PATCH /api/v1/contracts/processed
// Body: { "contracts": ["12","13"] }
// only COMPLETED -> PROCESSED
// ---------------------------------------------
router.patch('/contracts/processed', async (req, res) => {
  try {
    const auth = getApiAuthContext(req, res);
    if (!auth) return;

    const ids = normalizeIdArray(req.body?.contracts);
    if (ids.length === 0) {
      return res.status(400).json({ error: 'contracts array is required (UUID or numeric ids)' });
    }

    const updateResult = await pool.query(
      `
      UPDATE contracts
      SET status = 'PROCESSED',
          updated_at = NOW()
      WHERE company_id = $1
        AND contract_id::text = ANY($2::text[])
        AND status = 'SIGNED'
      RETURNING contract_id;
      `,
      [auth.companyId, ids]
    );

    const updated = updateResult.rows.map(r => String(r.contract_id));
    const updatedSet = new Set(updated);

    res.json({
      summary: {
        totalSubmitted: ids.length,
        updated: updated.length,
        notFoundOrNotSigned: ids.length - updated.length
      },
      details: ids.map(id => ({
        contract_id: String(id),
        status: updatedSet.has(String(id)) ? 'processed' : 'not_found_or_not_signed'
      }))
    });
  } catch (err) {
    console.error('Error in PATCH /api/v1/contracts/processed:', err);
    res.status(500).json({ error: 'Failed to mark contracts processed' });
  }
});

// ---------------------------------------------
// PATCH /api/v1/contracts/unprocessed
// Body: { "contracts": ["12","13"] }
// only PROCESSED -> COMPLETED
// ---------------------------------------------
router.patch('/contracts/unprocessed', async (req, res) => {
  try {
    const auth = getApiAuthContext(req, res);
    if (!auth) return;

    const ids = normalizeIdArray(req.body?.contracts);
    if (ids.length === 0) {
      return res.status(400).json({ error: 'contracts array is required (UUID or numeric ids)' });
    }

    const updateResult = await pool.query(
      `
      UPDATE contracts
      SET status = 'SIGNED',
          updated_at = NOW()
      WHERE company_id = $1
        AND contract_id::text = ANY($2::text[])
        AND status = 'PROCESSED'
      RETURNING contract_id;
      `,
      [auth.companyId, ids]
    );

    const updated = updateResult.rows.map(r => String(r.contract_id));
    const updatedSet = new Set(updated);

    res.json({
      summary: {
        totalSubmitted: ids.length,
        updated: updated.length,
        notFoundOrNotProcessed: ids.length - updated.length
      },
      details: ids.map(id => ({
        contract_id: String(id),
        status: updatedSet.has(String(id)) ? 'unprocessed' : 'not_found_or_not_processed'
      }))
    });
  } catch (err) {
    console.error('Error in PATCH /api/v1/contracts/unprocessed:', err);
    res.status(500).json({ error: 'Failed to mark contracts unprocessed' });
  }
});

// ---------------------------------------------
// POST /api/v1/contracts/send
// DEPRECATED: legacy create-only endpoint retained for backward compatibility.
// Use POST /api/v1/contracts/send/:dot for real send flow + email dispatch.
// ---------------------------------------------
router.post('/contracts/send', async (req, res) => {
  try {
    const auth = getApiAuthContext(req, res);
    if (!auth) return;

    const dots = normalizeDotArray(req.body?.dot);
    if (dots.length === 0) {
      return res.status(400).json({ error: 'dot is required (numeric DOT or array of DOTs)' });
    }

    const carriersRes = await pool.query(
      `SELECT dotnumber FROM carriers WHERE dotnumber = ANY($1::text[])`,
      [dots]
    );
    const validSet = new Set(carriersRes.rows.map(r => String(r.dotnumber)));
    const validDots = dots.filter(d => validSet.has(d));
    const invalidDots = dots.filter(d => !validSet.has(d));

    if (validDots.length === 0) {
      return res.status(400).json({ error: 'No valid DOTs found in carriers table', invalidDots });
    }

    const insertRes = await pool.query(
      `
      INSERT INTO contracts (company_id, dotnumber, status, payload, sent_at)
      SELECT $1, unnest($2::text[]), 'SENT', '{}'::jsonb, NOW()
      RETURNING contract_id, dotnumber, status, created_at, sent_at;
      `,
      [auth.companyId, validDots]
    );

    res.json({
      summary: {
        totalSubmitted: dots.length,
        created: insertRes.rowCount,
        invalidDots: invalidDots.length
      },
      created: insertRes.rows,
      invalidDots
    });
  } catch (err) {
    console.error('Error in POST /api/v1/contracts/send:', err);
    res.status(500).json({ error: 'Failed to create contracts' });
  }
});

// ---------------------------------------------
// POST /api/v1/contracts/send/:dot
// Body: { user_contract_id, email_to, carrier_name? }
// Mirrors broker send flow but uses v1 API auth context.
// ---------------------------------------------
router.post('/contracts/send/:dot', async (req, res) => {
  const dotnumber = String(req.params.dot || '').trim();
  const { user_contract_id, email_to, carrier_name } = req.body || {};

  if (!dotnumber || !/^\d+$/.test(dotnumber)) {
    return res.status(400).json({ error: 'dot must be a numeric USDOT value' });
  }

  if (!user_contract_id || !email_to) {
    return res.status(400).json({ error: 'user_contract_id and email_to are required' });
  }

  try {
    const auth = getApiAuthContext(req, res);
    if (!auth) return;



    const token = makeToken();
    const token_expires_at = new Date(Date.now() + 72 * 60 * 60 * 1000);
    const link = `https://carriershark.com/contract/${token}`;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

          const carrierRes = await client.query(
  `
    SELECT email_address, legalname, dbaname
    FROM public.carriers
    WHERE dotnumber = $1
    LIMIT 1;
    `,
    [dotnumber]
  );
  
  if (carrierRes.rowCount === 0) {
    throw Object.assign(new Error('Carrier not found'), { statusCode: 404 });
  }
  
  const carrier = carrierRes.rows[0] || {};
  const mainRecipient = String(carrier.email_address || '').trim().toLowerCase();
  
  if (!mainRecipient) {
    throw Object.assign(new Error('No FMCSA contact email found for this carrier'), {
      statusCode: 400
    });
  }
  
  const requestedRecipients = normalizeRecipientList(email_to);
  const finalRecipients = [...new Set([mainRecipient, ...requestedRecipients])];
  const finalEmailTo = finalRecipients.join(', ');

      const actorRes = await client.query(
        `
        SELECT cm.user_id
        FROM public.company_members cm
        JOIN public.users u
          ON u.id = cm.user_id
        WHERE cm.company_id = $1
          AND cm.status = 'ACTIVE'
        ORDER BY
          CASE
            WHEN cm.role = 'OWNER' THEN 0
            WHEN cm.role = 'ADMIN' THEN 1
            ELSE 2
          END,
          cm.created_at ASC
        LIMIT 1;
        `,
        [auth.companyId]
      );

      if (actorRes.rowCount === 0) {
        throw Object.assign(
          new Error('No active company user available to attribute contract'),
          { statusCode: 400 }
        );
      }
      const userId = actorRes.rows[0].user_id;

      const templateRes = await client.query(
        `
        SELECT
          name,
          display_name,
          COALESCE(insurance_required, FALSE) AS insurance_required,
          COALESCE(w9_required, TRUE) AS w9_required,
          COALESCE(ach_required, FALSE) AS ach_required
        FROM public.user_contracts
        WHERE id = $1
          AND company_id = $2
          AND storage_provider = 'DO_SPACES'
          AND storage_key IS NOT NULL
        LIMIT 1;
        `,
        [user_contract_id, auth.companyId]
      );

      if (templateRes.rowCount === 0) {
        throw Object.assign(new Error('Invalid or unauthorized contract template'), {
          statusCode: 400,
        });
      }

      const agreement_type = templateRes.rows[0].name || 'Carrier Agreement';
      const broker_name = templateRes.rows[0].display_name || 'Carrier Agreement';
      const insurance_required = templateRes.rows[0].insurance_required;
      const w9_required = templateRes.rows[0].w9_required;
      const ach_required = templateRes.rows[0].ach_required;

      const insertRes = await client.query(
        `
        INSERT INTO public.contracts (
          user_id,
          company_id,
          dotnumber,
          status,
          channel,
          provider,
          payload,
          sent_at,
          token,
          token_expires_at,
          email_to,
          user_contract_id,
          insurance_required,
          w9_required,
          ach_required
        )
        VALUES (
          $1,
          $2,
          $3,
          'SENT',
          'EMAIL',
          'MAILGUN',
          $4::jsonb,
          NOW(),
          $5,
          $6,
          $7,
          $8,
          $9,
          $10,
          $11
        )
        RETURNING contract_id;
        `,
        [
          userId,
          auth.companyId,
          dotnumber,
          JSON.stringify({ broker_name, agreement_type }),
          token,
          token_expires_at.toISOString(),
          finalEmailTo,
          user_contract_id,
          insurance_required,
          w9_required,
          ach_required,
        ]
      );

      const contract_id = insertRes.rows[0]?.contract_id;
      if (!contract_id) throw new Error('Failed to create contract');

      await sendContractEmail({
        to: finalEmailTo,
        broker_name,
        carrier_name: carrier_name || '',
        dotnumber,
        agreement_type,
        link,
      });

      await client.query('COMMIT');

      return res.json({
        ok: true,
        contract_id,
        status: 'SENT',
        link,
      });
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {}
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('Error in POST /api/v1/contracts/send/:dot:', err);
    return res.status(err.statusCode || 500).json({
      error: err.message || 'Failed to send contract',
    });
  }
});

// ---------------------------------------------
// GET /api/v1/contracts
// filterable + paginated: status, dotnumber, contract_id, created_after, created_before
// ---------------------------------------------
router.get('/contracts', async (req, res) => {
  try {
    const auth = getApiAuthContext(req, res);
    if (!auth) return;

    const {
      status,
      dotnumber,
      contract_id,
      created_after,
      created_before,
      page = 1,
      pageSize = 25
    } = req.query;

    const limit = Math.min(parseInt(pageSize, 10) || 25, 100);
    const offset = (parseInt(page, 10) - 1) * limit;

    const conditions = [];
    const params = [];
    let i = appendCompanyScope({
      conditions,
      params,
      alias: 'c',
      companyId: auth.companyId,
      startIndex: 1,
    });

    if (contract_id && isValidContractIdentifier(String(contract_id))) {
      conditions.push(`c.contract_id::text = $${i}`);
      params.push(String(contract_id));
      i++;
    }

    if (status) {
      conditions.push(`c.status = $${i}`);
      params.push(String(status).trim().toUpperCase());
      i++;
    }

    if (dotnumber) {
      conditions.push(`c.dotnumber = $${i}`);
      params.push(String(dotnumber).trim());
      i++;
    }

    if (created_after) {
      conditions.push(`c.created_at >= $${i}`);
      params.push(created_after);
      i++;
    }

    if (created_before) {
      conditions.push(`c.created_at <= $${i}`);
      params.push(created_before);
      i++;
    }

    const whereClause = `WHERE ${conditions.join(' AND ')}`;
    const sql = `
      ${contractSelectSql(whereClause)}
      ORDER BY c.created_at DESC
      LIMIT $${i} OFFSET $${i + 1};
    `;
    const countSql = `
      SELECT COUNT(*)::int AS count
      FROM contracts c
      ${whereClause};
    `;

    const [dataResult, countResult] = await Promise.all([
      pool.query(sql, [...params, limit, offset]),
      pool.query(countSql, params)
    ]);

    res.json({
      contracts: dataResult.rows.map(r => ({
        contract: {
          contract_id: r.contract_id,
          dotnumber: r.dotnumber,
          status: r.status,
          created_at: r.created_at,
          updated_at: r.updated_at,
          sent_at: r.sent_at,
          signed_at: r.signed_at,
          provider: r.provider,
          external_id: r.external_id,
          payload: r.payload
        },
        carrier: r.carrier
      })),
      total: countResult.rows[0].count,
      page: parseInt(page, 10),
      pageSize: limit
    });
  } catch (err) {
    console.error('Error in GET /api/v1/contracts:', err);
    res.status(500).json({ error: 'Failed to load contracts' });
  }
});

// ---------------------------------------------
// GET /api/v1/contracts/:contract_id
// ---------------------------------------------
router.get('/contracts/:contract_id', async (req, res) => {
  try {
    const auth = getApiAuthContext(req, res);
    if (!auth) return;

    const contractId = String(req.params.contract_id || '').trim();
    if (!isValidContractIdentifier(contractId)) {
      return res.status(400).json({ error: 'Invalid contract_id' });
    }

    const conditions = ['c.contract_id::text = $1'];
    const params = [contractId];
    appendCompanyScope({
      conditions,
      params,
      alias: 'c',
      companyId: auth.companyId,
      startIndex: 2,
    });
    const whereClause = `WHERE ${conditions.join(' AND ')}`;

    const sql = `
      ${contractSelectSql(whereClause)}
      LIMIT 1;
    `;

    const result = await pool.query(sql, params);
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Contract not found' });
    }

    const r = result.rows[0];

    res.json({
      contract: {
        contract_id: r.contract_id,
        dotnumber: r.dotnumber,
        status: r.status,
        created_at: r.created_at,
        updated_at: r.updated_at,
        sent_at: r.sent_at,
        signed_at: r.signed_at,
        provider: r.provider,
        external_id: r.external_id,
        payload: r.payload
      },
      carrier: r.carrier
    });
  } catch (err) {
    console.error('Error in GET /api/v1/contracts/:contract_id:', err);
    res.status(500).json({ error: 'Failed to load contract' });
  }
});

  // Add more v1 routes above this line
  return router;
}

module.exports = createApiV1;
