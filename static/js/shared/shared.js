// ===============================
// Google Analytics (GA4)
// ===============================
(function initGoogleAnalytics() {
  const GA_ID = "G-8TTZC22P44"; // replace with your real ID

  // Prevent double-loading
  if (window.__CS_GA_LOADED__) return;
  window.__CS_GA_LOADED__ = true;

  const script = document.createElement("script");
  script.async = true;
  script.src = `https://www.googletagmanager.com/gtag/js?id=${GA_ID}`;
  document.head.appendChild(script);

  window.dataLayer = window.dataLayer || [];
  window.gtag = function () {
    window.dataLayer.push(arguments);
  };

  window.gtag("js", new Date());
  window.gtag("config", GA_ID);
})();



async function loadHeader() {
  const container = document.getElementById("site-header");
  if (!container) return;

  try {
    const res = await fetch("/partials/header.html", { cache: "no-store" });
    if (!res.ok) throw new Error("Failed to load header.html");

    container.innerHTML = await res.text();

    // Header is now in the DOM → wire buttons
    await initAuthUI();
    initMobileHeaderMenu();

  } catch (err) {
    console.error("Header load failed:", err);
  }
}

async function loadHeaderSlim() {
  const container = document.getElementById("site-header");
  if (!container) return;

  try {
    const res = await fetch("/partials/header-slim.html", { cache: "no-store" });
    if (!res.ok) throw new Error("Failed to load header-slim.html");

    container.innerHTML = await res.text();

    // Same wiring as full header
await initAuthUI();
  } catch (err) {
    console.error("Header slim load failed:", err);
  }
}


async function trackHomepageView() {
  // only track homepage
  if (window.location.pathname !== "/") return;

  // dedupe once per tab/session
  const key = "pv:/";
  if (sessionStorage.getItem(key)) return;
  sessionStorage.setItem(key, "1");

  const r = await fetch("/pageview", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: "/" }),
    keepalive: true
  });

  if (!r.ok) {
    console.error("pageview failed:", r.status, await r.text().catch(() => ""));
  }
}

window.showConfirm = function ({
  title,
  message,
  confirmText = "Confirm",
  confirmVariant = "primary"
}) {
  return new Promise((resolve) => {
    const modal = document.getElementById("confirm-modal");
    const titleEl = document.getElementById("confirm-title");
    const msgEl = document.getElementById("confirm-message");
    const okBtn = document.getElementById("confirm-ok");
    const cancelBtn = document.getElementById("confirm-cancel");

    titleEl.textContent = title;
    msgEl.textContent = message;
    okBtn.textContent = confirmText;

    okBtn.className =
      confirmVariant === "danger"
        ? "btn-danger"
        : "btn-primary";

    modal.classList.remove("hidden");

    okBtn.onclick = () => {
      modal.classList.add("hidden");
      resolve(true);
    };

    cancelBtn.onclick = () => {
      modal.classList.add("hidden");
      resolve(false);
    };
  });
};

const DESKTOP_AUTH_DISPLAY = "inline-flex";

// ===============================
// Access Gate (reusable modal)
// ===============================
(function () {
  const OVERLAY_ID = "csAccessGateOverlay";

  function ensureAccessGateStyles() {
    if (document.getElementById("csAccessGateStyles")) return;

    const style = document.createElement("style");
    style.id = "csAccessGateStyles";
    style.textContent = `
      /* Access Gate overlay */
      #${OVERLAY_ID}{
        position: fixed; inset: 0;
        display: none;
        align-items: center; justify-content: center;
        padding: 24px;
        background: rgba(2, 6, 23, 0.62);
        z-index: 9999;
      }
      #${OVERLAY_ID}.is-open{ display:flex; }

      .cs-gate-card{
        width: min(720px, 100%);
        border-radius: 18px;
        border: 1px solid rgba(255,255,255,0.08);
        background: rgba(9, 20, 40, 0.92);
        box-shadow: 0 18px 60px rgba(0,0,0,0.55);
        padding: 22px 22px 18px;
        position: relative;
        backdrop-filter: blur(10px);
        -webkit-backdrop-filter: blur(10px);
      }
      .cs-gate-x{
        position:absolute; top:14px; right:14px;
        width: 36px; height: 36px;
        border-radius: 12px;
        border: 1px solid rgba(255,255,255,0.10);
        background: rgba(255,255,255,0.04);
        color: rgba(255,255,255,0.85);
        cursor:pointer;
      }
      .cs-gate-x:hover{ background: rgba(255,255,255,0.07); }

      .cs-gate-title{
        font-size: 1.15rem;
        font-weight: 700;
        letter-spacing: 0.02em;
        margin: 0 44px 6px 0;
        color: rgba(255,255,255,0.92);
      }
      .cs-gate-sub{
        margin: 0 0 14px 0;
        color: rgba(255,255,255,0.70);
        line-height: 1.4;
      }

      .cs-gate-actions{
        display:flex;
        gap: 10px;
        align-items:center;
        justify-content:flex-end;
        margin-top: 14px;
        flex-wrap: wrap;
      }
      .cs-gate-note{
        margin-top: 10px;
        color: rgba(255,255,255,0.55);
        font-size: .85rem;
      }

      /* Small helper button styles that match your vibe */
      .cs-btn-primary{
        appearance:none;
        border: 0;
        border-radius: 999px;
        padding: 10px 14px;
        font-weight: 700;
        cursor:pointer;
        color: #071018;
        background: #35d0ff;
      }
      .cs-btn-primary:hover{ filter: brightness(1.06); }

      .cs-btn-ghost{
        appearance:none;
        border-radius: 999px;
        padding: 10px 14px;
        font-weight: 700;
        cursor:pointer;
        color: rgba(255,255,255,0.88);
        background: rgba(255,255,255,0.06);
        border: 1px solid rgba(255,255,255,0.10);
      }
      .cs-btn-ghost:hover{ background: rgba(255,255,255,0.09); }

      .cs-btn-link{
        appearance:none;
        border: 0;
        background: transparent;
        color: rgba(255,255,255,0.65);
        cursor:pointer;
        padding: 8px 10px;
      }
      .cs-btn-link:hover{ color: rgba(255,255,255,0.82); }

      @media (max-width: 520px){
        .cs-gate-actions{ justify-content: stretch; }
        .cs-btn-primary, .cs-btn-ghost{ width: 100%; text-align:center; }
      }
    `;
    document.head.appendChild(style);
  }

  function ensureAccessGateMarkup() {
    if (document.getElementById(OVERLAY_ID)) return;

    const overlay = document.createElement("div");
    overlay.id = OVERLAY_ID;
    overlay.setAttribute("aria-hidden", "true");
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.innerHTML = `
      <div class="cs-gate-card" role="document">
        <button class="cs-gate-x" type="button" aria-label="Close">✕</button>
        <div class="cs-gate-title" id="csGateTitle">Sign in to continue</div>
        <p class="cs-gate-sub" id="csGateBody">
          Save carriers, bulk import, and monitor updates in one place.
        </p>

        <div class="cs-gate-actions">
          <button type="button" class="cs-btn-link" id="csGateNotNow">Not now</button>
          <button type="button" class="cs-btn-ghost" id="csGateSignIn">Sign in</button>
          <button type="button" class="cs-btn-primary" id="csGateCreate">Sign in</button>
        </div>

        <div class="cs-gate-note" id="csGateNote">
          Starter is free (25 carriers).
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    // Click outside to close
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) window.hideAccessGate();
    });

    // Close button
    overlay.querySelector(".cs-gate-x").addEventListener("click", () => {
      window.hideAccessGate();
    });

    // Esc to close
    document.addEventListener("keydown", (e) => {
      const el = document.getElementById(OVERLAY_ID);
      if (!el || !el.classList.contains("is-open")) return;
      if (e.key === "Escape") window.hideAccessGate();
    });

// Buttons
document.getElementById("csGateNotNow").addEventListener("click", () => window.hideAccessGate());

document.getElementById("csGateSignIn").addEventListener("click", () => {
  const overlay = document.getElementById(OVERLAY_ID);
  const href = overlay?.dataset?.signInHref || "/login";
  window.location.href = href;
});

document.getElementById("csGateCreate").addEventListener("click", () => {
  const overlay = document.getElementById(OVERLAY_ID);
  const href = overlay?.dataset?.createHref || "/login";
  window.location.href = href;
});
  }

  window.showAccessGate = function showAccessGate(opts = {}) {
    ensureAccessGateStyles();
    ensureAccessGateMarkup();

    const {
      title = "Sign in to continue",
      body = "Save carriers, bulk import, and monitor updates in one place.",
      note = "Starter is free (25 carriers).",
      // Optional: change button labels without changing wiring
      createLabel,
      signInLabel
    } = opts;

    const overlay = document.getElementById(OVERLAY_ID);
    if (!overlay) return;

    const titleEl = document.getElementById("csGateTitle");
    const bodyEl = document.getElementById("csGateBody");
    const noteEl = document.getElementById("csGateNote");
    const createBtn = document.getElementById("csGateCreate");
    const signInBtn = document.getElementById("csGateSignIn");

    if (titleEl) titleEl.textContent = title;
    if (bodyEl) bodyEl.textContent = body;
    if (noteEl) {
      noteEl.textContent = note || "";
      noteEl.style.display = note ? "block" : "none";
    }
    if (createLabel) createBtn.textContent = createLabel;
    if (signInLabel) signInBtn.textContent = signInLabel;


const {
  createHref,
  signInHref,
  hideSignIn = true,
} = opts;

overlay.dataset.createHref = createHref || "";
overlay.dataset.signInHref = signInHref || "";

if (signInBtn) {
  signInBtn.style.display = hideSignIn ? "none" : "";
}
    

    overlay.classList.add("is-open");
    overlay.setAttribute("aria-hidden", "false");
    document.documentElement.classList.add("cs-modal-open");

    // Focus primary action
    setTimeout(() => createBtn?.focus(), 0);
  };

  window.hideAccessGate = function hideAccessGate() {
    const overlay = document.getElementById(OVERLAY_ID);
    if (!overlay) return;
    overlay.classList.remove("is-open");
    overlay.setAttribute("aria-hidden", "true");
    document.documentElement.classList.remove("cs-modal-open");
  };

  // Small helper you can call in click handlers:
  // If not logged in -> show gate and return false, else true.
  window.requireAccountOrGate = function requireAccountOrGate(customOpts) {
    if (window.csIsLoggedIn) return true;
    window.showAccessGate(customOpts);
    return false;
  };
})();



function initMobileHeaderMenu() {
  const toggleBtn = document.getElementById("mobile-menu-toggle");
  const drawer = document.getElementById("mobile-nav-drawer");
  const backdrop = document.getElementById("mobile-nav-backdrop");

  if (!toggleBtn || !drawer || !backdrop) return;

  const closeMenu = () => {
    toggleBtn.setAttribute("aria-expanded", "false");
    drawer.classList.remove("is-open");
    drawer.hidden = true;
    backdrop.classList.remove("is-open");
    backdrop.hidden = true;
  };

  const openMenu = () => {
    toggleBtn.setAttribute("aria-expanded", "true");
    drawer.hidden = false;
    drawer.classList.add("is-open");
    backdrop.hidden = false;
    backdrop.classList.add("is-open");
  };

  toggleBtn.addEventListener("click", () => {
    const isOpen = toggleBtn.getAttribute("aria-expanded") === "true";
    if (isOpen) closeMenu();
    else openMenu();
  });

  backdrop.addEventListener("click", closeMenu);

  drawer.querySelectorAll("a, button").forEach((el) => {
    el.addEventListener("click", closeMenu);
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeMenu();
  });

  window.addEventListener("resize", () => {
    if (window.innerWidth > 900) closeMenu();
  });
}


async function initAuthUI() {

  const loginBtn = document.getElementById("login-btn");
  const logoutBtn = document.getElementById("logout-btn");
  const accountLink = document.getElementById("account-link");
  const mobileAccountLink = document.getElementById("mobile-account-link");
  const mobileLogoutBtn = document.getElementById("mobile-logout-btn");
  const header = document.querySelector(".site-header");

  try {
    const res = await fetch("/api/me", { cache: "no-store" });
    const data = await res.json();

    if (data.user) {
      // LOGGED IN
      if (loginBtn) loginBtn.style.display = "none";
      if (logoutBtn) logoutBtn.style.display = DESKTOP_AUTH_DISPLAY;
      window.csIsLoggedIn = true;
      
      if (header) {
        header.classList.remove("is-logged-out");
        header.classList.add("is-logged-in");
      }

      if (accountLink) {
        accountLink.style.display = DESKTOP_AUTH_DISPLAY;
        accountLink.textContent = "Settings";
        accountLink.href = "/account";
      }

      if (mobileAccountLink) {
        mobileAccountLink.style.display = "flex";
        mobileAccountLink.textContent = "Settings";
        mobileAccountLink.href = "/account";
      }

      const logoutHandler = async () => {
        await fetch("/api/logout", { method: "POST" });
        window.location.href = "/";
      };

      if (logoutBtn) {
        logoutBtn.onclick = logoutHandler;
      }

      if (mobileLogoutBtn) {
        mobileLogoutBtn.style.display = "flex";
        mobileLogoutBtn.onclick = logoutHandler;
      }


    } else {
      // LOGGED OUT
      if (loginBtn) loginBtn.style.display = DESKTOP_AUTH_DISPLAY;
      if (logoutBtn) logoutBtn.style.display = "none";
      window.csIsLoggedIn = false;

      if (header) {
        header.classList.remove("is-logged-in");
        header.classList.add("is-logged-out");
      }

      if (accountLink) {
        accountLink.style.display = "none";
        accountLink.textContent = "Settings";
        accountLink.href = "/login";
      }

      if (mobileAccountLink) {
        mobileAccountLink.style.display = "flex";
        mobileAccountLink.textContent = "Login";
        mobileAccountLink.href = "/login";
      }

      if (mobileLogoutBtn) {
        mobileLogoutBtn.style.display = "none";
      }


      if (loginBtn) {
        loginBtn.onclick = () => (window.location.href = "/login");
      }
    }

  } catch (err) {
    console.error("auth ui error", err);

    // Fail closed to logged-out UI
    if (header) {
      header.classList.remove("is-logged-in");
      header.classList.add("is-logged-out");
    }

    if (loginBtn) loginBtn.style.display = DESKTOP_AUTH_DISPLAY;
    if (logoutBtn) logoutBtn.style.display = "none";
    if (accountLink) accountLink.style.display = "none";
    if (mobileAccountLink) {
      mobileAccountLink.style.display = "flex";
      mobileAccountLink.textContent = "Login";
      mobileAccountLink.href = "/login";
    }
    if (mobileLogoutBtn) mobileLogoutBtn.style.display = "none";

    if (loginBtn) {
      loginBtn.onclick = () => (window.location.href = "/login");
    }

  }
}


async function initAccountLink() {
  const accountLink = document.getElementById("account-link");
  if (!accountLink) return;

  try {
    const res = await fetch("/api/me", { cache: "no-store" });
    const data = await res.json();

    if (data && data.user) {
      // Logged in → upgrade link
      accountLink.href = "/account";
    }
    // Not logged in → leave href as /login.html
  } catch {
    // On any error, do nothing.
    // Default /login.html remains correct.
  }
}

document.addEventListener("DOMContentLoaded", async () => {
  trackHomepageView();

  const headerEl = document.getElementById("site-header");
  const mode = headerEl ? headerEl.getAttribute("data-header") : null;

  if (mode === "slim") {
    await loadHeaderSlim();
  } else {
    await loadHeader();
  }

});
