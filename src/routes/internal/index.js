"use strict";

const express = require("express");
const carrierSearchResultsRoutes = require("./carrierSearchResults.routes");
const authRoutes = require("./auth.routes");
const carrierSearchRoutes = require("./carrierSearch.routes");
const carriersRoutes = require("./carriers.routes");
const myCarriersRoutes = require("./myCarriers.routes");
const contractsRoutes = require("./contracts.routes");
const insuranceRoutes = require("./insurance.routes");
const accountRoutes = require("./account.routes");
const debugRoutes = require("./debug.routes");
const userApiRoutes = require("./userApi.routes");
const supportRoutes = require("./support.routes");
const teamRoutes = require("./team.routes");
const InsuranceCoveragesRoutes = require("./InsuranceCoverages.routes");
const insuranceDocumentsRoutes = require("./insuranceDocuments.routes");
const billingRoutes = require("./billing.routes");
const healthInternalRoutes = require("./healthInternal.routes"); // router export
const screeningRoutes = require("./screening.routes");
const adminEmailReviewRoutes = require("./adminEmailReview.routes");
const { healthRoutes } = require("./health.routes"); // factory export

const publicCarriersRoutes = require("./publicCarriers.routes");
const { globalApiLimiter } = require("../../middleware/rateLimit");

function internalRoutes({ pool } = {}) {
  if (!pool || typeof pool.query !== "function") {
    throw new Error(
      "internalRoutes() requires a Postgres pool. Mount like: app.use('/api', internalRoutes({ pool }))"
    );
  }

  const router = express.Router();

  router.get("/_test500", (req, res) => {
  throw new Error("test crash");
});

  // Health first (no auth/session dependency)
  router.use(healthRoutes({ pool })); // GET /api/health
  router.use(healthInternalRoutes);   // GET /api/health-internal

  // Apply a light shared limit to public API traffic only. Authenticated
  // internal/admin requests are skipped in the middleware itself.
  router.use(globalApiLimiter);

  // Existing internal routers
  router.use(authRoutes);
  router.use(carrierSearchRoutes);
  router.use(carrierSearchResultsRoutes);
  router.use(teamRoutes);
  router.use(carriersRoutes);
  router.use(myCarriersRoutes);
  router.use(contractsRoutes);
  router.use(insuranceRoutes);
  router.use(debugRoutes);
  router.use(billingRoutes);
  router.use(InsuranceCoveragesRoutes);
  router.use(accountRoutes);
  router.use(screeningRoutes({ pool }));
  router.use(userApiRoutes);
  router.use(supportRoutes);
  router.use(insuranceDocumentsRoutes);
  router.use(adminEmailReviewRoutes);
  router.use(publicCarriersRoutes);
  return router;
}

module.exports = { internalRoutes };
