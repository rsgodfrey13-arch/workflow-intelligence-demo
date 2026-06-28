"use strict";

function requireAuth(req, res, next) {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ error: "Not logged in" });
  }
  next();
}

module.exports = { requireAuth };
