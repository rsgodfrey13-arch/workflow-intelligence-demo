"use strict";

const express = require("express");
const { pool } = require("../../db/pool");

const {
  map_fmcsa_search_payload
} = require("../../services/fmcsa/fmcsa.map");

const {
  fetch_fmcsa_carrier_search
} = require("../../services/fmcsa/fmcsa.client");

const router = express.Router();

/* ---------------- option b config ---------------- */

const profile_ttl_ms = 24 * 60 * 60 * 1000; // 24h
const wait_ms = 1200;

function is_fresh(row) {
  if (!row || !row.profile_fetched_at) return false;
  return Date.now() - new Date(row.profile_fetched_at).getTime() <= profile_ttl_ms;
}

/* ---------------- refresh helper ---------------- */

async function refresh_carrier_in_db(dot, timeout_ms) {
  const client = await pool.connect();
  try {
    await client.query("begin");

    // claim lock
    const lock = await client.query(
      `
      update carriers
      set profile_lock_until = now() + interval '2 minutes'
      where dotnumber = $1
        and (profile_lock_until is null or profile_lock_until < now())
      returning dotnumber
      `,
      [dot]
    );

    if (lock.rowCount === 0) {
      await client.query("rollback");
      return { ok: false, reason: "locked" };
    }

    // fetch fmcs a
    const payload = await fetch_fmcsa_carrier_search(dot, { timeout_ms });
    const mapped = map_fmcsa_search_payload(payload);

    await client.query(
      `
      update carriers
      set
        allowedtooperate = $2,
        bipdinsuranceonfile = $3,
        bipdinsurancerequired = $4,
        bipdrequiredamount = $5,
        bondinsuranceonfile = $6,
        bondinsurancerequired = $7,
        brokerauthoritystatus = $8,
        cargoinsuranceonfile = $9,
        cargoinsurancerequired = $10,
        carrieroperation_carrieroperationcode = $11,
        carrieroperation_carrieroperationdesc = $12,
        censustypeid_censustype = $13,
        censustypeid_censustypedesc = $14,
        censustypeid_censustypeid = $15,
        commonauthoritystatus = $16,
        contractauthoritystatus = $17,
        crashtotal = $18,
        dbaname = $19,
        driverinsp = $20,
        driveroosinsp = $21,
        driveroosrate = $22,
        driveroosratenationalaverage = $23,
        ein = $24,
        fatalcrash = $25,
        hazmatinsp = $26,
        hazmatoosinsp = $27,
        hazmatoosrate = $28,
        hazmatoosratenationalaverage = $29,
        injcrash = $30,
        ispassengercarrier = $31,
        issscore = $32,
        legalname = $33,
        mcs150outdated = $34,
        oosdate = $35,
        oosratenationalaverageyear = $36,
        phycity = $37,
        phycountry = $38,
        phystate = $39,
        phystreet = $40,
        phyzipcode = $41,
        reviewdate = $42,
        reviewtype = $43,
        safetyrating = $44,
        safetyratingdate = $45,
        safetyreviewdate = $46,
        safetyreviewtype = $47,
        snapshotdate = $48,
        statuscode = $49,
        totaldrivers = $50,
        totalpowerunits = $51,
        towawaycrash = $52,

        link_basics = $53,
        link_cargo_carried = $54,
        link_operation_classification = $55,
        link_docket_numbers = $56,
        link_active_for_hire = $57,
        link_self = $58,

        profile_payload = $59::jsonb,
        profile_source = 'fmcsa',
        profile_fetched_at = now(),
        profile_expires_at = now() + interval '24 hours',
        profile_error = null,
        profile_error_at = null,
        profile_lock_until = null
      where dotnumber = $1
      `,
      [
        dot,
        mapped.allowedtooperate,
        mapped.bipdinsuranceonfile,
        mapped.bipdinsurancerequired,
        mapped.bipdrequiredamount,
        mapped.bondinsuranceonfile,
        mapped.bondinsurancerequired,
        mapped.brokerauthoritystatus,
        mapped.cargoinsuranceonfile,
        mapped.cargoinsurancerequired,
        mapped.carrieroperation_carrieroperationcode,
        mapped.carrieroperation_carrieroperationdesc,
        mapped.censustypeid_censustype,
        mapped.censustypeid_censustypedesc,
        mapped.censustypeid_censustypeid,
        mapped.commonauthoritystatus,
        mapped.contractauthoritystatus,
        mapped.crashtotal,
        mapped.dbaname,
        mapped.driverinsp,
        mapped.driveroosinsp,
        mapped.driveroosrate,
        mapped.driveroosratenationalaverage,
        mapped.ein,
        mapped.fatalcrash,
        mapped.hazmatinsp,
        mapped.hazmatoosinsp,
        mapped.hazmatoosrate,
        mapped.hazmatoosratenationalaverage,
        mapped.injcrash,
        mapped.ispassengercarrier,
        mapped.issscore,
        mapped.legalname,
        mapped.mcs150outdated,
        mapped.oosdate,
        mapped.oosratenationalaverageyear,
        mapped.phycity,
        mapped.phycountry,
        mapped.phystate,
        mapped.phystreet,
        mapped.phyzipcode,
        mapped.reviewdate,
        mapped.reviewtype,
        mapped.safetyrating,
        mapped.safetyratingdate,
        mapped.safetyreviewdate,
        mapped.safetyreviewtype,
        mapped.snapshotdate,
        mapped.statuscode,
        mapped.totaldrivers,
        mapped.totalpowerunits,
        mapped.towawaycrash,
        mapped.link_basics,
        mapped.link_cargo_carried,
        mapped.link_operation_classification,
        mapped.link_docket_numbers,
        mapped.link_active_for_hire,
        mapped.link_self,
        JSON.stringify(payload)
      ]
    );

    await client.query("commit");
    return { ok: true };
  } catch (e) {
    try {
      await client.query(
        `
        update carriers
        set profile_error = $2,
            profile_error_at = now(),
            profile_lock_until = now() + interval '15 minutes'
        where dotnumber = $1
        `,
        [dot, String(e)]
      );
      await client.query("commit");
    } catch {
      await client.query("rollback");
    }
    return { ok: false, reason: "error" };
  } finally {
    client.release();
  }
}






/* ---------------- list route (unchanged) ---------------- */

router.get("/carriers", async (req, res) => {
  // unchanged — your existing list logic is fine
  /* ... */
});

/* ---------------- SINGLE CARRIER (OPTION B) ---------------- */

router.get("/carriers/:dot", async (req, res) => {
  const dot = req.params.dot;

  const base = await pool.query(
    `
    select
      dotnumber as dot,
      phystreet as address1,
      null as address2,
      phycity as city,
      phystate as state,
      phyzipcode as zip,
      to_char(
        (coalesce(profile_fetched_at, updated_at) AT TIME ZONE 'America/New_York'),
        'Mon DD, YYYY HH12:MI AM'
      ) || ' ET' as retrieval_date_formatted,
      *,
      COALESCE(primary_mc_number, NULLIF(mc_number::text,'')) AS mc_number
    from carriers
    where dotnumber = $1
    `,
    [dot]
  );

  if (base.rowCount === 0) {
    return res.status(404).json({ error: "carrier not found" });
  }

  const carrier = base.rows[0];

  // attach cargo (always)
  const cargoResult = await pool.query(
    `select cargo_desc from cargo where dot_number = $1 order by cargo_desc`,
    [dot]
  );
  carrier.cargo_carried = cargoResult.rows.map(r => r.cargo_desc);

  // fresh → return immediately
  if (is_fresh(carrier)) {
    return res.json({ source: "cache_fresh", carrier });
  }

  // try fast refresh
  const quick = refresh_carrier_in_db(dot, wait_ms);

  const result = await Promise.race([
    quick,
    new Promise(r => setTimeout(() => r({ ok: false, reason: "timeout" }), wait_ms + 50))
  ]);

  if (result.ok) {
    const updated = await pool.query( `
      select
        dotnumber as dot,
        phystreet as address1,
        null as address2,
        phycity as city,
        phystate as state,
        phyzipcode as zip,
        to_char(
          (coalesce(profile_fetched_at, updated_at) AT TIME ZONE 'America/New_York'),
          'Mon DD, YYYY HH12:MI AM'
        ) || ' ET' as retrieval_date_formatted,
        *,
        COALESCE(primary_mc_number, NULLIF(mc_number::text,'')) AS mc_number
      from carriers
      where dotnumber = $1
      `,
      [dot]
    );

    updated.rows[0].cargo_carried = carrier.cargo_carried;
    return res.json({ source: "fmcsa_fast", carrier: updated.rows[0] });
  }

  // stale now, refresh continues in background
  res.json({ source: "cache_stale", carrier });

  if (result.reason === "timeout") {
    refresh_carrier_in_db(dot, 15000).catch(() => {});
  }
});

// --- MANUAL REFRESH (premium button) ---
router.post("/carriers/:dot/refresh", async (req, res) => {
  const dot = req.params.dot;
    if (String(dot) === '9999999') {
    return res.json({
      success: true,
      skipped: true,
      reason: 'demo_carrier'
    });
  }

  // optional: if locked, return quickly
  const result = await refresh_carrier_in_db(dot, 15000);

  if (result.ok) {
    // pull the updated row so the client can immediately update "Last Verified"
    const updated = await pool.query(
      `
      select
        dotnumber as dot,
        phystreet as address1,
        null as address2,
        phycity as city,
        phystate as state,
        phyzipcode as zip,
        to_char(
          (coalesce(profile_fetched_at, updated_at) AT TIME ZONE 'America/New_York'),
          'Mon DD, YYYY HH12:MI AM'
        ) || ' ET' as retrieval_date_formatted,
        *,
        COALESCE(primary_mc_number, NULLIF(mc_number::text,'')) AS mc_number
      from carriers
      where dotnumber = $1
      `,
      [dot]
    );

    return res.json({ ok: true, status: "done", carrier: updated.rows[0] });
  }

  // If locked/timeout/error, don't break UX. Treat as queued.
  return res.json({ ok: true, status: result.reason || "queued" });
});


module.exports = router;
