"use strict";

document.addEventListener("DOMContentLoaded", () => {
  const form = document.getElementById("reset-form");
  const errEl = document.getElementById("reset-error");

  const token = (() => {
    // /reset-password/<token>
    const parts = window.location.pathname.split("/").filter(Boolean);
    // ["reset-password", "<token>"]
    return parts[0] === "reset-password" ? (parts[1] || "") : "";
  })();

  function showErr(msg) {
    if (!errEl) return;
    errEl.textContent = msg || "Something went wrong.";
    errEl.style.display = "block";
  }

  if (!form) return;

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (errEl) { errEl.style.display = "none"; errEl.textContent = ""; }

    if (!token) {
  showErr("Missing reset token. Please use the link from your email.");
  form.querySelector("button[type='submit']").disabled = true;
  return;
}


    const newPassword = document.getElementById("newPassword")?.value || "";
    const confirmPassword = document.getElementById("confirmPassword")?.value || "";

    if (newPassword.length < 8) return showErr("Password must be at least 8 characters.");
    if (newPassword !== confirmPassword) return showErr("Passwords do not match.");

    try {
      const res = await fetch("/api/reset-password", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, newPassword }),
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) {
        return showErr(data.error || "Reset failed. Your link may be expired.");
      }

      // Option B: auto-login succeeded; go home
      window.location.href = "/";
    } catch (err) {
      showErr("Network error. Please try again.");
    }
  });
});
