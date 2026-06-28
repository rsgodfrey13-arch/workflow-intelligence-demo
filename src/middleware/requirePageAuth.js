"use strict";

function requirePageAuth(req, res, next) {
  if (!req.session || !req.session.userId) {
    const nextUrl = encodeURIComponent(req.originalUrl || "/account");
    return res.redirect(`/login?next=${nextUrl}`);
  }
  next();
}

module.exports = { requirePageAuth };
