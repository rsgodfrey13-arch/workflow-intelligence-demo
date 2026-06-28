// /js/pages/billing.js
(function () {
  const btn = document.getElementById("checkout-btn");
  const statusEl = document.getElementById("billing-status");
  const planInput = document.getElementById("plan-input");
  const termsCheckbox = document.getElementById("terms-checkbox");
  const helper = document.getElementById("terms-helper");

  function setStatus(msg, isError) {
    if (!statusEl) return;
    statusEl.style.display = "block";
    statusEl.textContent = msg;
    statusEl.style.opacity = isError ? "1" : ".9";
  }

  async function startCheckout() {
    const plan = (planInput?.value || "core").toLowerCase();
    const params = new URLSearchParams(window.location.search);
    const context = (params.get("context") || "").toLowerCase();
    const endpoint = plan === "starter" ? "/api/billing/activate-starter" : "/api/billing/continue";

    btn.disabled = true;
    btn.classList.add("is-loading");
    setStatus(plan === "starter" ? "Activating Starter…" : "Redirecting…");

    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ plan, context })
      });

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(text || `Request failed (${res.status})`);
      }

      const data = await res.json();
      if (!data?.url) throw new Error("Missing redirect URL from server.");

      window.location.href = data.url;
    } catch (err) {
      console.error(err);
      setStatus("Couldn’t continue. Please try again. If it keeps happening, contact support.", true);
      btn.disabled = false;
      btn.classList.remove("is-loading");
    }
  }

  if (!btn || !termsCheckbox) return;

  // Start disabled until Terms checked
  btn.disabled = true;
  if (helper) helper.style.display = "block";

  termsCheckbox.addEventListener("change", () => {
    const agreed = termsCheckbox.checked;
    btn.disabled = !agreed;
    if (helper) helper.style.display = agreed ? "none" : "block";
  });

  btn.addEventListener("click", startCheckout);
})();
