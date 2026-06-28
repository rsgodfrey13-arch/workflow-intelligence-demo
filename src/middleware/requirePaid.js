"use strict";

module.exports = function requirePaid() {
  return async function (req, res, next) {
    try {
      const userId = req.session?.userId;

      if (!userId) {
        return res.status(401).json({ error: "Not authenticated" });
      }

      const { pool } = require("../db/pool");

      const { rows } = await pool.query(
        `
        SELECT subscription_status
        FROM users
        WHERE id = $1
        `,
        [userId]
      );

      if (!rows.length) {
        return res.status(401).json({ error: "User not found" });
      }

      const status = String(rows[0].subscription_status || "").toLowerCase();

      const isPaid =
        status === "active" ||
        status === "trialing";

      if (!isPaid) {
        console.warn(
          `BILLING_LOCK_BLOCK: userId=${userId} status=${status}`
        );

        return res.status(402).json({
          error: "BILLING_LOCKED",
          status,
          message: "Subscription inactive. Update billing to resume.",
          effective_plan: "STARTER"
        });
      }

      return next();
    } catch (err) {
      console.error("requirePaid error:", err);
      return res.status(500).json({ error: "Server error" });
    }
  };
};
