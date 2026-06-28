"use strict";

const express = require("express");
const router = express.Router();

const alertsRoutes = require("./alerts.routes");
const billingRoutes = require("./billing.routes");
const gettingStartedRoutes = require("./getting-started.routes");
const managingCarriersRoutes = require("./managing-carriers.routes");

// Mount help article routes
router.use(alertsRoutes);
router.use(billingRoutes);
router.use(gettingStartedRoutes);
router.use(managingCarriersRoutes);

module.exports = router;
