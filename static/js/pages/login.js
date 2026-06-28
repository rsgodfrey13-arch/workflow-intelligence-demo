"use strict";

document.addEventListener("DOMContentLoaded", () => {
  const form = document.getElementById("login-form");
  const errorEl = document.getElementById("login-error");



  
  if (!form) return;

  form.addEventListener("submit", async (e) => {
    e.preventDefault();

    if (errorEl) {
      errorEl.style.display = "none";
      errorEl.textContent = "";
    }

    const email = (document.getElementById("email")?.value || "").trim();
    const password = document.getElementById("password")?.value || "";

    try {
      const res = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });

      const data = await res.json().catch(() => ({}));

      if (!res.ok || !data.ok) {
        if (errorEl) {
          errorEl.textContent = data.error || "Login failed";
          errorEl.style.display = "block";
        }
        return;
      }

      // success → cookie set by server → redirect to home
      const params = new URLSearchParams(window.location.search);
      const next = params.get("next");
      window.location.href = next || "/";
      
    } catch (err) {
      if (errorEl) {
        errorEl.textContent = "Network error, please try again.";
        errorEl.style.display = "block";
      }
    }
  });

    // -----------------------------
    // Forgot Password Modal
    // -----------------------------
    const fpModal = document.getElementById("fp-modal");
    const fpEmail = document.getElementById("fp-email");
    const fpOk = document.getElementById("fp-ok");
    const fpErr = document.getElementById("fp-error");
    const fpSend = document.getElementById("fp-send");
    
    function fpShowOk(msg) {
      if (fpErr) fpErr.style.display = "none";
      if (fpOk) {
        fpOk.textContent = msg;
        fpOk.style.display = "block";
      }
    }
    function fpShowErr(msg) {
      if (fpOk) fpOk.style.display = "none";
      if (fpErr) {
        fpErr.textContent = msg;
        fpErr.style.display = "block";
      }
    }
    
    function fpOpen() {
      if (!fpModal) return;
      if (fpOk) fpOk.style.display = "none";
      if (fpErr) fpErr.style.display = "none";
      if (fpEmail) fpEmail.value = document.getElementById("email")?.value?.trim() || "";
      fpModal.classList.add("is-open");
      fpModal.setAttribute("aria-hidden", "false");
      setTimeout(() => fpEmail?.focus(), 0);
    }
    function fpClose() {
      if (!fpModal) return;
      fpModal.classList.remove("is-open");
      fpModal.setAttribute("aria-hidden", "true");
    }
    
    document.getElementById("btn-forgot")?.addEventListener("click", fpOpen);
    document.getElementById("fp-close")?.addEventListener("click", fpClose);
    document.getElementById("fp-cancel")?.addEventListener("click", fpClose);
    
    fpModal?.addEventListener("click", (e) => {
      if (e.target === fpModal) fpClose();
    });
    
    fpSend?.addEventListener("click", async () => {
      const email = (fpEmail?.value || "").trim();
      if (!email) return fpShowErr("Enter your email.");
    
      fpSend.disabled = true;
      try {
        const res = await fetch("/api/forgot-password", {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email }),
        });
        await res.json().catch(() => ({}));
    
        // Always show success (no account enumeration)
        fpShowOk("If an account exists for that email, a reset link was sent.");
      } catch (e) {
        fpShowOk("If an account exists for that email, a reset link was sent.");
      } finally {
        fpSend.disabled = false;
      }
    });
  
});
