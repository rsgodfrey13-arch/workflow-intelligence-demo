// /js/shared/sentry.js
(function () {
  if (!window.Sentry) return;

  // ===============================
  // FRONTEND TRACES (TEMPORARY)
  // ===============================
  
  // 🔥 Uncomment to enable frontend performance traces
  
//  const client = window.Sentry.getCurrentHub().getClient();
//  if (client) {
//    client.getOptions().tracesSampleRate = 0.1;
//    }
  
  // ===============================
  // END FRONTEND TRACES
  // ===============================


  // Prevent accidental double wiring
  if (window.__SENTRY_HELPERS__) return;
  window.__SENTRY_HELPERS__ = true;

  // Universal helper for caught errors
  window.captureToSentry = function (err, extra) {
    try {
      window.Sentry.withScope((scope) => {
        if (extra && typeof extra === "object") {
          scope.setExtras(extra);
        }
        window.Sentry.captureException(err);
      });
    } catch {}
  };

  // 🔹 CAPTURE ALL console.error CALLS
  const originalConsoleError = console.error;

  console.error = function (...args) {
    try {
      // Cap volume per page load (prevents spam)
      window.__CE_COUNT__ = (window.__CE_COUNT__ || 0) + 1;
      if (window.__CE_COUNT__ <= 20) {
        const errObj = args.find(a => a instanceof Error);

        if (errObj) {
          window.Sentry.captureException(errObj);
        } else {
          const msg = args
            .map(a => {
              if (typeof a === "string") return a;
              try { return JSON.stringify(a); } catch { return String(a); }
            })
            .join(" ");

          window.Sentry.captureMessage(`console.error: ${msg}`, "error");
        }
      }
    } catch {
      // swallow
    }

    // Preserve normal console behavior
    originalConsoleError.apply(console, args);
  };

  // Safety net for unhandled promise rejections
  window.addEventListener("unhandledrejection", (e) => {
    window.captureToSentry(
      e.reason || new Error("Unhandled promise rejection"),
      { source: "unhandledrejection" }
    );
  });
})();
