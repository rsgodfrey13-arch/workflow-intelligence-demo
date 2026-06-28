(() => {
  const STORAGE_KEY = "cs_tour_seen_v1";

  const kickerEl = document.querySelector(".cs-tour-kicker");
  const btnGo = document.getElementById("tourGo");

  
const slides = [
  {
    title: "One place to verify, document, and monitor carriers.",
    body: "Carrier Shark is a carrier management prototype for carrier search, screening, documents, and change alerts. Take the quick tour to learn more."
  },
  {
    title: "Search any Carrier",
    body: "Search by DOT, MC, or carrier name across all FMCSA carriers.",
    img: "/static/images/tour/search_carrier.png"
  },
  {
    title: "Open the carrier profile",
    body: `
  The carrier profile contains everything you need to vet a carrier:
  <br><br>
  • Authority & operating status<br>
  • Safety & inspection history<br>
  • Equipment & operations<br>
  • Carrier documents
  `,
    img: "/static/images/tour/carrier_profile.png"
  },
  {
    title: "Build your carrier watchlist",
    body: `
  Add carriers to <strong>Carriers</strong> so Carrier Shark can monitor authority and safety changes automatically.
  <br><br>
  Get notified when something changes:
  <br><br>
  • Email alerts<br>
  • Webhooks<br>
  • REST API
  `,
    img: "/static/images/tour/my_carriers.png"
  },
{
  title: "Build custom carrier screening profiles",
  body: `
Create multiple customizable screening profiles so Carrier Shark can automatically determine whether a carrier passes or fails your requirements.

<br><br>

Build different profiles for different customers, freight types, lanes, risk tolerances, or internal workflows.

<br><br>

Each profile can contain its own combination of rules and screening requirements, allowing you to evaluate carriers differently depending on the situation.

<br><br>

Carrier Shark instantly returns a pass or fail result and shows exactly why the carrier met or missed your requirements.
  `,
  img: "/static/images/tour/screening_criteria.png",
  imgPosition: "left top"
},
  {
    title: "Get alerts when something changes",
    body: `
  Carrier Shark monitors your carriers for authority, safety, and compliance changes.
  <br><br>
  Choose exactly what to monitor and receive alerts by email, webhooks, or the REST API.
  `,
    img: "/static/images/tour/email_alert.png"
  },
    {
    title: "Ready for more advanced workflows?",
    body: `
Carrier Shark also includes APIs for connecting carrier search, alerts, saved carriers, and screening directly into other systems.

<br><br>

Use Carrier Shark inside your:
<br><br>

• TMS<br>
• CRM<br>
• Internal onboarding flow<br>
• Dispatch workflows<br>
• Custom integrations
  `,
    img: "/static/images/tour/api_tour.png"
  },
  {
    title: "You’re ready.",
    body: `
  Start by searching for a carrier, open the profile, and add it to Carriers.
  <br><br>
  Carrier Shark will monitor the carrier and alert you when something changes.
  `,
    img: "/static/images/tour/my_account.png",
    cta: { text: "Sign in", href: "/login" }
  }
];

  const overlay = document.getElementById("tourOverlay");
  const titleEl = document.getElementById("tourTitle");
  const bodyEl  = document.getElementById("tourBody");
  const imgEl   = document.getElementById("tourImg");
  const mediaEl = document.querySelector(".cs-tour-media");
  const dotsEl  = document.getElementById("tourDots");

  const btnPrev = document.getElementById("tourPrev");
  const btnNext = document.getElementById("tourNext");
  const btnClose = document.getElementById("tourClose");
  const dontShowEl = document.getElementById("tourDontShow");
  const dismissForeverBtn = document.getElementById("tourDismissForever");
  const skipLink = document.getElementById("tourSkip");
  const TOUR_TRIGGER_SELECTOR = "#tour-link, #mobile-tour-link, #openTourLink";

  let idx = 0;

  function isSeen() {
    return localStorage.getItem(STORAGE_KEY) === "1";
  }

  function setSeen(val) {
    localStorage.setItem(STORAGE_KEY, val ? "1" : "0");
  }

  function setDontShowChecked(checked) {
    if (!dontShowEl) return;
    dontShowEl.checked = checked;
  }

  function isDontShowChecked() {
    return Boolean(dontShowEl?.checked);
  }

  function syncDontShowControls(sourceEl) {
    if (!sourceEl) return;
    setDontShowChecked(sourceEl.checked);
  }

  function openTour(startIndex = 0) {
    if (!overlay) return;
    idx = Math.max(0, Math.min(slides.length - 1, startIndex));
    overlay.setAttribute("aria-hidden", "false");
    overlay.classList.add("is-open");
    render();
    // Lock scroll (optional)
    document.documentElement.classList.add("cs-modal-open");
  }

  function closeTour() {
    if (!overlay) return;
    // Persist if checked
    if (isDontShowChecked()) setSeen(true);

    overlay.classList.remove("is-open");
    overlay.setAttribute("aria-hidden", "true");
    document.documentElement.classList.remove("cs-modal-open");
  }

  function closeMobileDrawerIfOpen() {
    const toggleBtn = document.getElementById("mobile-menu-toggle");
    const drawer = document.getElementById("mobile-nav-drawer");
    const backdrop = document.getElementById("mobile-nav-backdrop");
    if (!toggleBtn || !drawer || !backdrop) return;

    const isOpen = toggleBtn.getAttribute("aria-expanded") === "true";
    if (!isOpen && !drawer.classList.contains("is-open")) return;

    toggleBtn.setAttribute("aria-expanded", "false");
    drawer.classList.remove("is-open");
    drawer.hidden = true;
    backdrop.classList.remove("is-open");
    backdrop.hidden = true;
  }

  function renderBody(contentHtml) {
    bodyEl.innerHTML = "";

    const sections = contentHtml
      .trim()
      .split(/<br\s*\/?\s*>\s*<br\s*\/?\s*>/i)
      .map((section) => section.trim())
      .filter(Boolean);

    sections.forEach((section) => {
      const lines = section
        .split(/<br\s*\/?\s*>/i)
        .map((line) => line.trim())
        .filter(Boolean);

      const bulletLines = lines.filter((line) => /^•\s+/.test(line));
      const isBulletSection = bulletLines.length > 0 && bulletLines.length === lines.length;

      if (isBulletSection) {
        const list = document.createElement("ul");
        list.className = "cs-tour-list";

        bulletLines.forEach((line) => {
          const li = document.createElement("li");
          li.innerHTML = line.replace(/^•\s+/, "");
          list.appendChild(li);
        });

        bodyEl.appendChild(list);
      } else {
        const p = document.createElement("p");
        p.innerHTML = section;
        bodyEl.appendChild(p);
      }
    });
  }

function renderDots() {
  const stepCount = slides.length - 1;
  const stepIndex = Math.max(0, idx - 1);

  dotsEl.innerHTML = Array.from({ length: stepCount }, (_, i) =>
    `<button type="button" class="cs-dot ${i === stepIndex ? "is-active" : ""}"
      aria-label="Step ${i + 1}"></button>`
  ).join("");

  [...dotsEl.querySelectorAll(".cs-dot")].forEach((b, i) => {
    b.addEventListener("click", () => {
      idx = i + 1;   // jump to real slide (offset by 1)
      render();
    });
  });
}

function render() {
  const s = slides[idx];
  const isIntroSlide = idx === 0;

  if (kickerEl) {
  kickerEl.textContent = (idx === 0) ? "" : "QUICK TOUR";
}

  

  const modal = overlay.querySelector(".cs-modal");
  modal.classList.toggle("cs-tour-intro", isIntroSlide);

  titleEl.textContent = s.title;
  renderBody(s.body);

  if (s.cta) {
    const a = document.createElement("a");
    a.className = "cs-btn cs-btn-primary cs-tour-cta";
    a.href = s.cta.href;
    a.textContent = s.cta.text;
    bodyEl.appendChild(a);
  }

  // Image handling
  if (s.img) {
    imgEl.style.display = "";
    imgEl.src = s.img;
    imgEl.alt = `${s.title} screenshot`;
    imgEl.style.objectPosition = s.imgPosition || "center top";
    mediaEl?.classList.remove("is-missing");
  } else {
    imgEl.removeAttribute("src");
    imgEl.alt = "";
    imgEl.style.display = "none";
    mediaEl?.classList.remove("is-missing");
  }


// Back button
btnPrev.disabled = isIntroSlide;
btnPrev.style.visibility = isIntroSlide ? "hidden" : "visible";

// Next button + secondary button logic
if (isIntroSlide) {
  btnNext.textContent = "Take the Tour";
  btnNext.classList.add("cs-btn-tour-hero");

  if (btnGo) btnGo.style.display = "";
  if (dismissForeverBtn) dismissForeverBtn.style.display = "";
  if (skipLink) skipLink.style.display = "none";
  if (dontShowEl?.parentElement) dontShowEl.parentElement.style.display = "none";
} else {
  btnNext.classList.remove("cs-btn-tour-hero");

  // ✅ reset the label properly for tour slides
  btnNext.textContent = (idx === slides.length - 1) ? "Done" : "Next";

  if (btnGo) btnGo.style.display = "none";
  if (dismissForeverBtn) dismissForeverBtn.style.display = "none";
  if (skipLink) skipLink.style.display = "";
  if (dontShowEl?.parentElement) dontShowEl.parentElement.style.display = "inline-flex";
}
  
  renderDots();
}

  function next() {
    if (idx < slides.length - 1) { idx++; render(); }
    else closeTour();
  }
  function prev() {
    if (idx > 0) { idx--; render(); }
  }

  // Events
  btnNext?.addEventListener("click", next);
  btnPrev?.addEventListener("click", prev);
  btnClose?.addEventListener("click", closeTour);
  btnGo?.addEventListener("click", closeTour);
  dismissForeverBtn?.addEventListener("click", () => {
    setSeen(true);
    setDontShowChecked(true);
    closeTour();
  });

  
  // Click outside modal closes
  overlay?.addEventListener("click", (e) => {
    if (e.target === overlay) closeTour();
  });

  // Esc closes
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && overlay.classList.contains("is-open")) closeTour();
    if (e.key === "ArrowRight" && overlay.classList.contains("is-open")) next();
    if (e.key === "ArrowLeft" && overlay.classList.contains("is-open")) prev();
  });

  document.addEventListener("click", (e) => {
    const trigger = e.target.closest(TOUR_TRIGGER_SELECTOR);
    if (!trigger) return;
    e.preventDefault();
    closeMobileDrawerIfOpen();
    openTour(0);
  });

  window.openTour = openTour;
  window.closeTour = closeTour;

  skipLink?.addEventListener("click", (e) => {
    e.preventDefault();
    closeTour();
  });

  dontShowEl?.addEventListener("change", () => syncDontShowControls(dontShowEl));
  setDontShowChecked(isDontShowChecked());

  imgEl?.addEventListener("error", () => {
    mediaEl?.classList.add("is-missing");
  });

  imgEl?.addEventListener("load", () => {
    mediaEl?.classList.remove("is-missing");
  });

  // Auto-show for first-time visitors (you can gate this by logged-in status)
  if (!isSeen()) {
    // optionally delay a bit so it doesn’t feel like a pop-ad
    setTimeout(() => openTour(0), 500);
  }
})();
