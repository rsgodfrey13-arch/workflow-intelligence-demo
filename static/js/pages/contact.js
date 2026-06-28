// contact.js
(() => {
  // If you already have a shared loader for header/footer, keep using it.
  // loadHeader(); loadFooter();

  const form = document.getElementById("contact-form");
  const statusEl = document.getElementById("contact-status");

  if (!form || !statusEl) return;

  // Optional: if your button is <button type="submit">Send</button>
  const submitBtn = form.querySelector('button[type="submit"], .contact-send');

  const showStatus = (type, msg) => {
    statusEl.classList.remove("hidden", "ok", "err");
    if (type) statusEl.classList.add(type); // "ok" or "err"
    statusEl.textContent = msg;
  };

  const setSubmitting = (isSubmitting) => {
    if (!submitBtn) return;
    submitBtn.disabled = isSubmitting;
    submitBtn.dataset.originalText = submitBtn.dataset.originalText || submitBtn.textContent;
    submitBtn.textContent = isSubmitting ? "Sending…" : submitBtn.dataset.originalText;
  };

  const safeJson = async (res) => {
    // Handles empty bodies or non-JSON gracefully
    const text = await res.text();
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  };

  form.addEventListener("submit", async (e) => {
    e.preventDefault();

    // Clear old state
    statusEl.classList.add("hidden");
    statusEl.classList.remove("ok", "err");

    setSubmitting(true);
    showStatus(null, "Sending…");

    try {
      const payload = Object.fromEntries(new FormData(form));

      // If you want to force a consistent endpoint regardless of form.action:
      // const url = "/api/public/contact";
      const url = form.getAttribute("action") || "/api/public/contact";

      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      const data = await safeJson(res);

      if (!res.ok) {
        // Prefer server-provided message if present
        const msg =
          (data && (data.error || data.message)) ||
          "Something didn’t send. Please try again.";
        throw new Error(msg);
      }

      const ref = data && (data.ref_id || data.refId || data.reference);
      if (ref) {
        showStatus("ok", `Message sent. Reference: ${ref}`);
      } else {
        showStatus("ok", "Message sent. We’ll reply within 1 business day.");
      }

      form.reset();
    } catch (err) {
      showStatus(
        "err",
        err?.message || "Something didn’t send. Email us at support@carriershark.com."
      );
    } finally {
      setSubmitting(false);
    }
  });
})();
