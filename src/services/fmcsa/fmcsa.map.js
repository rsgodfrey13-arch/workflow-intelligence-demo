// lib/fmcsa_map.js
export function map_fmcsa_search_payload(payload) {
  const carrier = payload?.content?.carrier || {};
  const links = payload?.content?._links || {};

  // normalize links: your frontend expects link_basics, link_cargo_carried, etc.
  const link_basics = links?.basics?.href || null;
  const link_cargo_carried = links?.["cargo carried"]?.href || null;
  const link_operation_classification = links?.["operation classification"]?.href || null;
  const link_docket_numbers = links?.["docket numbers"]?.href || null;
  const link_active_for_hire = links?.["carrier active-For-hire authority"]?.href || null;
  const link_self = links?.self?.href || null;

  return {
    dotnumber: carrier?.dotNumber ?? null,

    allowedtooperate: carrier?.allowedToOperate ?? null,

    bipdinsuranceonfile: carrier?.bipdInsuranceOnFile ?? null,
    bipdinsurancerequired: carrier?.bipdInsuranceRequired ?? null,
    bipdrequiredamount: carrier?.bipdRequiredAmount ?? null,

    bondinsuranceonfile: carrier?.bondInsuranceOnFile ?? null,
    bondinsurancerequired: carrier?.bondInsuranceRequired ?? null,

    cargoinsuranceonfile: carrier?.cargoInsuranceOnFile ?? null,
    cargoinsurancerequired: carrier?.cargoInsuranceRequired ?? null,

    brokerauthoritystatus: carrier?.brokerAuthorityStatus ?? null,
    commonauthoritystatus: carrier?.commonAuthorityStatus ?? null,
    contractauthoritystatus: carrier?.contractAuthorityStatus ?? null,

    carrieroperation_carrieroperationcode: carrier?.carrierOperation?.carrierOperationCode ?? null,
    carrieroperation_carrieroperationdesc: carrier?.carrierOperation?.carrierOperationDesc ?? null,

    censustypeid_censustype: carrier?.censusTypeId?.censusType ?? null,
    censustypeid_censustypedesc: carrier?.censusTypeId?.censusTypeDesc ?? null,
    censustypeid_censustypeid: carrier?.censusTypeId?.censusTypeId ?? null,

    crashtotal: carrier?.crashTotal ?? null,
    fatalcrash: carrier?.fatalCrash ?? null,
    injcrash: carrier?.injCrash ?? null,
    towawaycrash: carrier?.towawayCrash ?? null,

    driverinsp: carrier?.driverInsp ?? null,
    driveroosinsp: carrier?.driverOosInsp ?? null,
    driveroosrate: carrier?.driverOosRate ?? null,
    driveroosratenationalaverage: carrier?.driverOosRateNationalAverage ?? null,

    hazmatinsp: carrier?.hazmatInsp ?? null,
    hazmatoosinsp: carrier?.hazmatOosInsp ?? null,
    hazmatoosrate: carrier?.hazmatOosRate ?? null,
    hazmatoosratenationalaverage: carrier?.hazmatOosRateNationalAverage ?? null,

    vehicleinsp: carrier?.vehicleInsp ?? null,
    vehicleoosinsp: carrier?.vehicleOosInsp ?? null,
    vehicleoosrate: carrier?.vehicleOosRate ?? null,
    vehicleoosratenationalaverage: carrier?.vehicleOosRateNationalAverage ?? null,

    ein: carrier?.ein ?? null,
    ispassengercarrier: carrier?.isPassengerCarrier ?? null,
    issscore: carrier?.issScore ?? null,

    legalname: carrier?.legalName ?? null,
    dbaname: carrier?.dbaName ?? null,

    mcs150outdated: carrier?.mcs150Outdated ?? null,

    oosdate: carrier?.oosDate ?? null,
    oosratenationalaverageyear: carrier?.oosRateNationalAverageYear ?? null,

    phycity: carrier?.phyCity ?? null,
    phycountry: carrier?.phyCountry ?? null,
    phystate: carrier?.phyState ?? null,
    phystreet: carrier?.phyStreet ?? null,
    phyzipcode: carrier?.phyZipcode ?? null,

    reviewdate: carrier?.reviewDate ?? null,
    reviewtype: carrier?.reviewType ?? null,

    safetyrating: carrier?.safetyRating ?? null,
    safetyratingdate: carrier?.safetyRatingDate ?? null,

    safetyreviewdate: carrier?.safetyReviewDate ?? null,
    safetyreviewtype: carrier?.safetyReviewType ?? null,

    snapshotdate: carrier?.snapshotDate ?? null,

    statuscode: carrier?.statusCode ?? null,

    totaldrivers: carrier?.totalDrivers ?? null,
    totalpowerunits: carrier?.totalPowerUnits ?? null,

    // links you already render
    link_basics,
    link_cargo_carried,
    link_operation_classification,
    link_docket_numbers,
    link_active_for_hire,
    link_self,

    // metadata
    profile_source: "fmcsa",
    profile_retrievaldate: payload?.retrievalDate || null
  };
}
