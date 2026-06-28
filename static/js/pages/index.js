/* static/js/pages/index.js */

(() => {
  // ---------------------------------------------
  // STATE
  // ---------------------------------------------
  let myCarrierDots = new Set();
  
let ME = null;

function hasSelectedPlan(user) {
  const plan = String(user?.plan || "").trim().toLowerCase();
  if (!plan) return false;
  return !["none", "no_plan", "no-plan", "unselected"].includes(plan);
}

function isNoPlanUser(user) {
  return !!user && !hasSelectedPlan(user);
}

async function getMeCached() {
  if (ME) return ME;
  try {
    const r = await fetch("/api/me", { credentials: "include" });
    const j = await r.json().catch(() => ({}));
    ME = j?.user || null;
    return ME;
  } catch {
    return null;
  }
}

function showLimitGate({ limit, count, noPlan = false }) {
  if (typeof window.showAccessGate === "function") {
    const loggedIn = !!window.csIsLoggedIn;

    if (noPlan) {
      window.showAccessGate({
        title: "Finish setup to start adding carriers",
        body: "Your account is ready — you just need to choose a plan to activate Carrier Shark. Plans start at $0 and take less than a minute.",
        note: "Choose a plan to activate your workspace and start adding carriers.",
        createLabel: loggedIn ? "Choose Plan" : "Sign in",
        signInLabel: "Sign in",
        createHref: loggedIn ? "/activate-plan" : "/login",
        signInHref: "/login",
        hideSignIn: true,
      });
      return;
    }

    window.showAccessGate({
      title: "Carrier limit reached",
      body: "You’ve reached the carrier limit on your current plan. Upgrade to add more carriers.",
      note: `Current usage: ${count} of ${limit} carriers.`,
      createLabel: loggedIn ? "Upgrade Plan" : "Sign in",
      signInLabel: "Sign in",
      createHref: loggedIn ? "/account?tab=plan" : "/login",
      signInHref: "/login",
      hideSignIn: true,
    });
    return;
  }

  alert(noPlan
    ? "Finish setup to start adding carriers. Choose a plan to activate your account."
    : `Carrier limit reached (${count}/${limit}). Upgrade to add more.`);
}

  
  // Pagination
  let currentPage = 1;
  let pageSize = 25;
  let totalRows = 0;
  let totalPages = 0;

  // Server-side sort
  let sortBy = "carrier";
  let sortDir = "asc";
  // Grid mode
  let gridMode = "MY"; // "MY" | "SEARCH"
  let searchQuery = "";
  


  // ---------------------------------------------
  // HELPERS
  // ---------------------------------------------




  
// ---------------------------------------------
// QUEUE-DRIVEN “MIRACLE WORKER” UI
// Muted only when the carrier is in carrier_refresh_queue
// for THIS user with status PENDING or RUNNING.
// ---------------------------------------------
let updatingDots = new Set();     // DOTs in PENDING/RUNNING for this user
let queuePollTimer = null;
let queuePolling = false;
let lastQueueNonEmptyAt = 0;

const refreshStatusEl = document.getElementById("refreshStatus");

function setRefreshStatus({ pending = [], running = [] } = {}) {
  const p = Array.isArray(pending) ? pending.length : 0;
  const r = Array.isArray(running) ? running.length : 0;
  const total = p + r;

  // ✅ Default: show nothing
  if (!refreshStatusEl) return;
  if (total === 0) {
    refreshStatusEl.style.display = "none";
    refreshStatusEl.textContent = "";
    return;
  }

  // ✅ Only show when there's actually work happening
  // (keep it simple + low key)
  refreshStatusEl.textContent =
    r > 0 ? `Updating ${total}…` : `Updating ${total}…`;

  refreshStatusEl.style.display = "block";
}
async function fetchQueueStatus() {
  const res = await fetch("/api/refresh-queue/status");
  if (res.status === 401) return { authed: false, pending: [], running: [] };
  if (!res.ok) throw new Error("queue status failed");

  const data = await res.json().catch(() => ({}));
  return {
    authed: true,
    pending: Array.isArray(data.pending) ? data.pending : [],
    running: Array.isArray(data.running) ? data.running : [],
  };
}

function applyMutingFromQueue() {
  document.querySelectorAll("tr[data-dot]").forEach((tr) => {
    const dot = tr.dataset.dot;
    const wasMuted = tr.classList.contains("is-muted");
    const nowMuted = updatingDots.has(dot);

    if (nowMuted) {
      tr.classList.add("is-muted");
      tr.title = "Updating carrier data…";
    } else {
      tr.classList.remove("is-muted");
      tr.title = "";
      if (wasMuted) {
        tr.classList.add("just-updated");
        setTimeout(() => tr.classList.remove("just-updated"), 650);
      }
    }
  });


}

async function syncQueueOnce() {
  const q = await fetchQueueStatus();
  setRefreshStatus(q);
  if (!q.authed) {
    // Public/incognito: never show updating UI, never poll
    stopQueuePolling();
    updatingDots = new Set();
    setRefreshStatus({ pending: [], running: [] });
    applyMutingFromQueue();
    return;
  }

  const next = new Set([...q.pending, ...q.running].map(normDot).filter(Boolean));
  updatingDots = next;

  if (updatingDots.size > 0) lastQueueNonEmptyAt = Date.now();

  applyMutingFromQueue();
}

function startQueuePolling() {
  if (queuePolling) return;
  queuePolling = true;

  // immediate sync
  syncQueueOnce().catch(console.error);

  queuePollTimer = setInterval(async () => {
    try {
      await syncQueueOnce();

      // Stop when empty and stayed empty briefly (prevents flicker)
      if (updatingDots.size === 0) {
        const emptyForMs = Date.now() - lastQueueNonEmptyAt;
        if (emptyForMs > 2500) stopQueuePolling();
      }
    } catch (e) {
      stopQueuePolling();
    }
  }, 2000);
}

function stopQueuePolling() {
  if (queuePollTimer) {
    clearInterval(queuePollTimer);
    queuePollTimer = null;
  }
  queuePolling = false;
}

// Enqueue refresh for one DOT (server decides dedupe)
async function enqueueRefresh(dot, source = "ui") {
  const url = `/api/carriers/${encodeURIComponent(dot)}/refresh`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ source }),
  });

  if (res.status === 401) return { authed: false };
  if (res.status === 429) return { queued: true }; // still ok UX-wise
  if (!res.ok) return { ok: false };

  return { ok: true };
}

  
function normDot(val) {
  const digits = String(val ?? "").replace(/\D/g, "");
  // strip leading zeros safely
  const noLeading = digits.replace(/^0+/, "");
  return noLeading || (digits ? "0" : "");
}


  
  function setGridMode(mode, query = "") {
    gridMode = mode;
    searchQuery = query || "";

    const titleEl = $("grid-title");
    const subtitleEl = $("grid-subtitle");
    const modePill = $("grid-modepill");
    const queryEl = $("grid-query");
    const backBtn = $("grid-back-btn");

    const filtersBtn = $("filters-btn");
    const bulkImportBtn = $("bulk-import-btn");
    const downloadBtn = $("download-btn");
    const selectAll = $("select-all");
    const bulkBar = $("bulk-actions");

    const isSearch = mode === "SEARCH";

    const card = document.querySelector(".carriers-card");
    if (card) card.classList.toggle("mode-search", mode === "SEARCH");


    // Header copy
    if (titleEl) titleEl.textContent = isSearch ? "Search Results" : "My Carriers";
    if (subtitleEl)
      subtitleEl.textContent = isSearch
        ? "Showing carriers matching your search."
        : "Click a DOT number to open its profile page.";

    if (modePill) modePill.textContent = isSearch ? "Viewing: Search Results" : "Viewing: My Carriers";

    if (queryEl) {
      if (isSearch && searchQuery) {
        queryEl.hidden = false;
        queryEl.textContent = `for “${searchQuery}”`;
      } else {
        queryEl.hidden = true;
        queryEl.textContent = "";
      }
    }

    if (backBtn) backBtn.hidden = !isSearch;

    // Search mode: hide confusing actions, keep CSV export
    if (filtersBtn) filtersBtn.style.display = isSearch ? "none" : "";
    if (bulkImportBtn) bulkImportBtn.style.display = isSearch ? "none" : "";

    // Keep Download Button
    if (downloadBtn) downloadBtn.style.display = "";



    // Hide bulk UI when in search
    if (bulkBar) bulkBar.classList.add("hidden");
    if (selectAll) {
      selectAll.checked = false;
      selectAll.disabled = isSearch;
    }
  }

  function wireGridModeBar() {
    const backBtn = $("grid-back-btn");
    if (!backBtn) return;

    backBtn.addEventListener("click", () => {
      setGridMode("MY");
      currentPage = 1;
      loadCarriers();
    });
  }


  
  function $(id) {
    return document.getElementById(id);
  }

  function safeText(val, fallback = "") {
    const t = String(val ?? "").trim();
    return t ? t : fallback;
  }

  function goToCarrier(dot) {
    if (!dot) return;
    window.location.pathname = "/" + encodeURIComponent(dot);
  }

  async function isLoggedIn() {
    try {
      const me = await fetch("/api/me").then((r) => r.json());
      return !!me.user;
    } catch {
      return false;
    }
  }

  // ---------------------------------------------
  // PANEL FILTERS (DOT/MC/City/State + dropdowns)
  // ---------------------------------------------
  const panelFilters = {
    dot: "",
    mc: "",
    city: "",
    state: "",
    authorized: "", // "Y" | "N" | ""
    common: "", // "A" | "I" | "NONE" | ""
    broker: "", // "A" | "I" | "NONE" | ""
    contract: "", // "A" | "I" | "NONE" | ""
    safety: "", // "S" | "C" | "U" | "NOT_RATED" | ""
  };

  function norm(val) {
    return String(val ?? "").trim();
  }

  function getCarrierMcList(c) {
    if (Array.isArray(c?.mc_numbers)) {
      return c.mc_numbers.map(v => norm(v)).filter(Boolean);
    }

    if (typeof c?.mc_numbers === "string") {
      const raw = c.mc_numbers.trim();

      // Handle Postgres array string like "{1073611,462298}"
      if (raw.startsWith("{") && raw.endsWith("}")) {
        return raw
          .slice(1, -1)
          .split(",")
          .map(v => norm(v.replace(/^"|"$/g, "")))
          .filter(Boolean);
      }

      return raw
        .split(/[\n,|]/)
        .map(v => norm(v))
        .filter(Boolean);
    }

    const primary = norm(c?.primary_mc_number);
    if (primary) return [primary];

    const legacy = norm(c?.mc_number);
    if (legacy) return [legacy];

    return [];
  }

  function getCarrierMcText(c) {
    const list = getCarrierMcList(c);
    return list.length ? list.join(" ") : "";
  }

  function buildMcCell(mcList) {
    const wrap = document.createElement("div");
    wrap.className = "mc-stack";

    if (!mcList.length) {
      wrap.textContent = "-";
      return wrap;
    }

    mcList.forEach((mc) => {
      const line = document.createElement("div");
      line.className = "mc-stack__item";
      line.textContent = mc;
      wrap.appendChild(line);
    });

    return wrap;
  }

  function matchesText(hay, needle) {
    const n = norm(needle).toLowerCase();
    if (!n) return true;
    return norm(hay).toLowerCase().includes(n);
  }

  function normAuthorityABC(val) {
    const t = norm(val).toUpperCase();
    if (!t || t === "-" || t === "N" || t === "NO") return "NONE";
    if (t === "A") return "A";
    if (t === "I") return "I";
    return "NONE";
  }

  function safetyCode(val) {
    const t = norm(val).toUpperCase();
    if (t === "S" || t === "C" || t === "U") return t;
    return "NOT_RATED";
  }

  function carrierMatchesPanelFilters(c) {
    const dotVal = norm(c.dot || c.dotnumber || c.id);
    const mcVal = getCarrierMcText(c);
    const cityVal = norm(c.city || c.phycity);
    const stateVal = norm(c.state || c.phystate).toUpperCase();

    if (panelFilters.dot && !dotVal.includes(norm(panelFilters.dot))) return false;
    if (panelFilters.mc && !mcVal.includes(norm(panelFilters.mc))) return false;
    if (panelFilters.city && !matchesText(cityVal, panelFilters.city)) return false;
    if (panelFilters.state && stateVal !== norm(panelFilters.state).toUpperCase()) return false;

    // Authorized: Y = yes, everything else = no
    if (panelFilters.authorized) {
      const isYes = norm(c.allowedtooperate).toUpperCase() === "Y";
      if (panelFilters.authorized === "Y" && !isYes) return false;
      if (panelFilters.authorized === "N" && isYes) return false;
    }

    // A/I/NONE rules
    if (panelFilters.common) {
      const v = normAuthorityABC(c.commonauthoritystatus);
      if (panelFilters.common === "NONE" ? v !== "NONE" : v !== panelFilters.common) return false;
    }
    if (panelFilters.broker) {
      const v = normAuthorityABC(c.brokerauthoritystatus);
      if (panelFilters.broker === "NONE" ? v !== "NONE" : v !== panelFilters.broker) return false;
    }
    if (panelFilters.contract) {
      const v = normAuthorityABC(c.contractauthoritystatus);
      if (panelFilters.contract === "NONE" ? v !== "NONE" : v !== panelFilters.contract) return false;
    }

    // Safety
    if (panelFilters.safety) {
      const code = safetyCode(c.safetyrating);
      if (code !== panelFilters.safety) return false;
    }

    return true;
  }

  function countActivePanelFilters() {
    return Object.values(panelFilters).filter((v) => String(v || "").trim() !== "").length;
  }

  function setFiltersCountUi() {
    const btn = $("filters-btn");
    const badge = $("filters-count");
    const n = countActivePanelFilters();

    if (badge) {
      badge.textContent = String(n);
      badge.hidden = n === 0;
    }
    if (btn) btn.classList.toggle("is-active", n > 0);
  }

  function wireFiltersPanel() {
    const btn = $("filters-btn");
    const pop = $("filters-popover");

    const closeBtn = $("filters-close");
    const clearBtn = $("filters-clear");
    const applyBtn = $("filters-apply");

    if (!btn || !pop || !applyBtn) return;

    // prevent clipping: put popover directly under <body>
    if (pop.parentElement !== document.body) {
      document.body.appendChild(pop);
    }

    const elDot = $("f-dot");
    const elMc = $("f-mc");
    const elCity = $("f-city");
    const elState = $("f-state");
    const elAuthorized = $("f-authorized");
    const elCommon = $("f-common");
    const elBroker = $("f-broker");
    const elContract = $("f-contract");
    const elSafety = $("f-safety");

    const inputs = [
      elDot,
      elMc,
      elCity,
      elState,
      elAuthorized,
      elCommon,
      elBroker,
      elContract,
      elSafety,
    ].filter(Boolean);

    function syncFromInputs() {
      panelFilters.dot = elDot?.value || "";
      panelFilters.mc = elMc?.value || "";
      panelFilters.city = elCity?.value || "";
      panelFilters.state = elState?.value || "";
      panelFilters.authorized = elAuthorized?.value || "";
      panelFilters.common = elCommon?.value || "";
      panelFilters.broker = elBroker?.value || "";
      panelFilters.contract = elContract?.value || "";
      panelFilters.safety = elSafety?.value || "";
    }

    function clearInputs() {
      if (elDot) elDot.value = "";
      if (elMc) elMc.value = "";
      if (elCity) elCity.value = "";
      if (elState) elState.value = "";
      if (elAuthorized) elAuthorized.value = "";
      if (elCommon) elCommon.value = "";
      if (elBroker) elBroker.value = "";
      if (elContract) elContract.value = "";
      if (elSafety) elSafety.value = "";
      syncFromInputs();
      setFiltersCountUi();
    }

    // keep badge updated as user changes inputs (no apply)
    inputs.forEach((el) => {
      el.addEventListener("change", () => {
        syncFromInputs();
        setFiltersCountUi();
      });

      el.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          applyBtn.click();
        }
      });
    });

    // tiny polish: auto uppercase state
    elState &&
      elState.addEventListener("input", () => {
        elState.value = String(elState.value || "")
          .toUpperCase()
          .replace(/[^A-Z]/g, "")
          .slice(0, 2);
      });

    function positionPopover() {
      if (!pop || pop.classList.contains("hidden")) return;

      const r = btn.getBoundingClientRect();

      // Popover must be measurable. Ensure it's not display:none.
      // We do NOT remove "hidden" here. Open() handles that.
      pop.style.visibility = "hidden";

      const popW = pop.offsetWidth;
      const popH = pop.offsetHeight;

      let left = r.right - popW;
      let top = r.bottom + 10;

      const pad = 12;
      left = Math.max(pad, Math.min(left, window.innerWidth - popW - pad));
      top = Math.max(pad, Math.min(top, window.innerHeight - popH - pad));

      pop.style.left = `${left}px`;
      pop.style.top = `${top}px`;

      pop.style.visibility = "visible";
    }

    function openPopover() {
      pop.classList.remove("hidden");
      // wait a frame so width/height are correct
      requestAnimationFrame(positionPopover);
    }

    function closePopover() {
      pop.classList.add("hidden");
      pop.style.visibility = "";
    }

    btn.addEventListener("click", (e) => {
      e.preventDefault();
    
      // Gate for logged-out users
      if (typeof window.requireAccountOrGate === "function") {
        const ok = window.requireAccountOrGate({
          title: "Sign in to use Filters",
          body: "Filter your carrier list by authority, safety rating, and location.",
          note: "Starter is free (25 carriers)."
        });
        if (!ok) return;
      }
    
      if (pop.classList.contains("hidden")) openPopover();
      else closePopover();
    });

    closeBtn && closeBtn.addEventListener("click", closePopover);

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") closePopover();
    });

    document.addEventListener("click", (e) => {
      if (e.target.closest("#filters-btn")) return;
      if (e.target.closest("#filters-popover")) return;
      closePopover();
    });

    window.addEventListener("resize", positionPopover);
    window.addEventListener("scroll", positionPopover, true);

    // Apply
    applyBtn.addEventListener("click", () => {
      syncFromInputs();
      setFiltersCountUi();
      currentPage = 1;
      loadCarriers();
      closePopover();
    });

    // Clear
    clearBtn &&
      clearBtn.addEventListener("click", () => {
        clearInputs();
        currentPage = 1;
        loadCarriers();
      });

    setFiltersCountUi();
  }

  // ---------------------------------------------
  // TABLE LOAD + RENDER
  // ---------------------------------------------
  async function loadCarriers() {
    try {
      const tbody = $("carrier-table-body");
      if (!tbody) return;

      tbody.innerHTML = "";

      // 1) Determine endpoint based on grid mode + login
      let endpoint = "/api/public-carriers";

      if (gridMode === "SEARCH") {
        endpoint = "/api/search-carriers"; // <-- NEW real search endpoint
      } else {
        try {
          const me = await fetch("/api/me").then((r) => r.json());
          if (me.user) endpoint = "/api/my-carriers";
        } catch (e) {
          console.error("Error checking login:", e);
        }
      }



      // 2) Build URL with pagination + sorting
            const url = new URL(endpoint, window.location.origin);

            url.searchParams.set("page", currentPage);
            url.searchParams.set("pageSize", pageSize);
            
            if (gridMode === "SEARCH") {
              url.searchParams.set("q", searchQuery);
            }



      if (sortBy) {
        url.searchParams.set("sortBy", sortBy);
        url.searchParams.set("sortDir", sortDir);
      }

      const res = await fetch(url);
      const result = await res.json();

      let data = Array.isArray(result) ? result : result.rows;

      // panel filters
      const isClientFiltered = countActivePanelFilters() > 0;
      if (Array.isArray(data) && isClientFiltered) {
        data = data.filter(carrierMatchesPanelFilters);
      }

      const filteredCount = Array.isArray(data) ? data.length : 0;

      // IMPORTANT: Client-side filters only apply to the currently fetched page.
      // To keep pagination honest + not broken, force 1 page when filters are active.
      // Updated version for grid mode 1/27
            if (isClientFiltered) {
              // client filters only apply to the current page we fetched
              totalRows = filteredCount;
              totalPages = 1;
              currentPage = 1;
            } else {
              totalRows = result.total ?? filteredCount;
              totalPages = Math.max(1, Math.ceil(totalRows / pageSize));
            }
            
            

      if (!Array.isArray(data) || data.length === 0) {
        const row = document.createElement("tr");
        const cell = document.createElement("td");
        cell.colSpan = 10;
        cell.textContent = "No carriers found.";
        row.appendChild(cell);
        tbody.appendChild(row);

        renderPagination();
        return;
      }

data.forEach((c) => {
  const row = document.createElement("tr");   // ✅ missing
  const dotVal = c.dot || c.dotnumber || c.id || "";
  const dotKey = normDot(dotVal);

  row.dataset.dot = dotKey;
  if (updatingDots.has(dotKey)) row.classList.add("is-muted");

        // Checkbox cell (SEARCH mode: ✓ if already saved, otherwise checkbox)
        const selectCell = document.createElement("td");
        selectCell.className = "col-select select-cell";
        
        const isMine = myCarrierDots.has(dotKey);
        
        if (gridMode === "SEARCH" && isMine) {
          row.classList.add("is-mine");
          selectCell.innerHTML = `<span class="saved-check" title="Already in My Carriers">✓</span>`;
        } else {
          const checkbox = document.createElement("input");
          checkbox.type = "checkbox";
          checkbox.className = "row-select";
          checkbox.dataset.dot = normDot(dotVal);
          selectCell.appendChild(checkbox);
        }
        
        row.appendChild(selectCell);




        // DOT link
        const dotCell = document.createElement("td");
        const link = document.createElement("a");
        link.textContent = dotVal;
        link.href = "/" + encodeURIComponent(dotVal);
        link.className = "dot-link";
        dotCell.appendChild(link);
        row.appendChild(dotCell);

        // MC
        const mcCell = document.createElement("td");
        mcCell.appendChild(buildMcCell(getCarrierMcList(c)));
        row.appendChild(mcCell);

        // Carrier name
        const nameCell = document.createElement("td");
        const carrierName = c.legalname || c.dbaname || c.name || "-";
        nameCell.textContent = carrierName;
        nameCell.title = carrierName;
        row.appendChild(nameCell);

        // Location
        const locationCell = document.createElement("td");
        const city = c.city || c.phycity || "";
        const state = c.state || c.phystate || "";
        locationCell.textContent = `${city}${city && state ? ", " : ""}${state}`;
        row.appendChild(locationCell);

        // Operating
        const allowedCell = document.createElement("td");
        const isAuthorized = c.allowedtooperate === "Y";
        allowedCell.textContent = isAuthorized ? "Authorized" : "Not Authorized";
        if (isAuthorized) allowedCell.classList.add("status-ok");
        row.appendChild(allowedCell);

        // Common
        const commonCell = document.createElement("td");
        commonCell.textContent = c.commonauthoritystatus || "-";
        if (commonCell.textContent === "A") commonCell.classList.add("status-ok");
        row.appendChild(commonCell);

        // Contract
        const contractCell = document.createElement("td");
        contractCell.textContent = c.contractauthoritystatus || "-";
        if (contractCell.textContent === "A") contractCell.classList.add("status-ok");
        row.appendChild(contractCell);

        // Broker
        const brokerCell = document.createElement("td");
        brokerCell.textContent = c.brokerauthoritystatus || "-";
        if (brokerCell.textContent === "A") brokerCell.classList.add("status-ok");
        row.appendChild(brokerCell);

        // Safety
        const ratingMap = { S: "Satisfactory", C: "Conditional", U: "Unsatisfactory" };
        const rawRating = c.safetyrating ? String(c.safetyrating).trim().toUpperCase() : "";
        const safetyCell = document.createElement("td");
        safetyCell.textContent = ratingMap[rawRating] || "Not Rated";
        row.appendChild(safetyCell);

        // Row click behavior
        row.addEventListener("click", (e) => {
          if (e.target.closest(".select-cell")) return;
          if (e.target.tagName.toLowerCase() !== "a") {
            goToCarrier(dotVal);
          }
        });

        tbody.appendChild(row);
      });

      renderPagination();
    } catch (err) {
      console.error("Error fetching carriers:", err);
    }
  }




  
  function renderPagination() {
    const container = $("pagination-controls");
    if (!container) return;

    container.innerHTML = "";

    if (totalPages <= 1) return;

    const makeButton = (label, page, disabled = false, active = false) => {
      const btn = document.createElement("button");
      btn.textContent = label;
      btn.className = "page-btn";
      if (active) btn.classList.add("active");

      if (disabled) {
        btn.disabled = true;
      } else if (page !== null) {
        btn.addEventListener("click", () => {
          if (page === currentPage) return;
          currentPage = page;
          loadCarriers();
        });
      }

      return btn;
    };

    // Prev
    container.appendChild(makeButton("⟨", Math.max(1, currentPage - 1), currentPage === 1));

    const maxButtons = 7;

    if (totalPages <= maxButtons) {
      for (let p = 1; p <= totalPages; p++) {
        container.appendChild(makeButton(String(p), p, false, p === currentPage));
      }
    } else {
      container.appendChild(makeButton("1", 1, false, currentPage === 1));

      if (currentPage > 4) {
        const span = document.createElement("span");
        span.textContent = "...";
        span.className = "page-ellipsis";
        container.appendChild(span);
      }

      const start = Math.max(2, currentPage - 1);
      const end = Math.min(totalPages - 1, currentPage + 1);

      for (let p = start; p <= end; p++) {
        container.appendChild(makeButton(String(p), p, false, p === currentPage));
      }

      if (currentPage < totalPages - 3) {
        const span = document.createElement("span");
        span.textContent = "...";
        span.className = "page-ellipsis";
        container.appendChild(span);
      }

      container.appendChild(makeButton(String(totalPages), totalPages, false, currentPage === totalPages));
    }

    // Next
    container.appendChild(makeButton("⟩", Math.min(totalPages, currentPage + 1), currentPage === totalPages));
  }

  // Rows-per-page selector
  function wireRowsPerPage() {
    const rpp = $("rows-per-page");
    if (!rpp) return;

    rpp.addEventListener("change", (e) => {
      pageSize = parseInt(e.target.value, 10) || 25;
      currentPage = 1;
      loadCarriers();
    });
  }

  // ---------------------------------------------
  // AUTOCOMPLETE "MY CARRIER" PILL
  // ---------------------------------------------

async function buildMyCarrierDots() {
  try {
    const me = await fetch("/api/me").then((r) => r.json());
    if (!me.user) {
      myCarrierDots = new Set();
      return;
    }

    const res = await fetch("/api/my-carriers/dots");
    if (!res.ok) {
      myCarrierDots = new Set();
      return;
    }

    const dots = await res.json(); // array like ["123", "456"]
    myCarrierDots = new Set(dots.map((d) => normDot(d)).filter(Boolean));
  } catch (err) {
    console.error("buildMyCarrierDots error", err);
    myCarrierDots = new Set();
  }
}

  
  
  function wireAutocomplete() {
    const searchInput = $("search-input");
    const searchBtn = $("open-carrier-btn");
    const suggestionsEl = $("carrier-suggestions");
    if (!searchInput || !searchBtn || !suggestionsEl) return;

    let searchTimeout = null;

    function clearSuggestions() {
      suggestionsEl.innerHTML = "";
      suggestionsEl.classList.remove("open");
    }

    function renderSuggestions(results) {
      clearSuggestions();
      if (!Array.isArray(results) || results.length === 0) return;

      results.forEach((item) => {
        const li = document.createElement("li");
        li.className = "carrier-suggestion-item";

        const dotVal = item.dot || item.dotnumber || item.id || "";
        const dotKey = normDot(dotVal);
        const name = item.legalname || item.dbaname || "(No name)";
        const city = item.phycity || item.city || "";
        const state = item.phystate || item.state || "";
        const mcList = getCarrierMcList(item);
        const mc = mcList.length ? mcList.join(", ") : "-";

        const isMine = myCarrierDots.has(dotKey);


        li.innerHTML = `
          <div class="suggestion-main">
            <span class="suggestion-title-text">${dotVal} – ${name}</span>
            ${isMine ? '<span class="my-carrier-pill">MY CARRIER</span>' : ""}
          </div>
          <div class="suggestion-sub">
            MC: ${mc} • ${city}${city && state ? ", " : ""}${state}
          </div>
        `;

        li.addEventListener("click", () => goToCarrier(dotVal));
        suggestionsEl.appendChild(li);
      });

      suggestionsEl.classList.add("open");
    }

    let activeController = null;
    let lastQuery = "";

    async function performSearch(query) {
      const q = query.trim();
      if (q.length < 2) {
        clearSuggestions();
        return;
      }

      if (q === lastQuery) return;
      lastQuery = q;

      if (activeController) activeController.abort();
      activeController = new AbortController();

      try {
        const url = new URL("/api/carrier-search", window.location.origin);
        url.searchParams.set("q", q);

        const res = await fetch(url, { signal: activeController.signal });
        if (!res.ok) {
          clearSuggestions();
          return;
        }

        const results = await res.json();
        renderSuggestions(results);
      } catch (e) {
        if (e.name !== "AbortError") console.error("search error", e);
        clearSuggestions();
      }
    }

    searchInput.addEventListener("input", () => {
      const value = searchInput.value;
      if (searchTimeout) clearTimeout(searchTimeout);
      searchTimeout = setTimeout(() => performSearch(value), 250);
    });

        async function handleSubmitSearch() {
          const q = searchInput.value.trim();
          if (!q) return;
    
          // If there's a suggestion dropdown open, prefer first item click behavior
          /*
          const first = suggestionsEl.querySelector(".carrier-suggestion-item");
          if (first && suggestionsEl.classList.contains("open")) {
            const text = first.querySelector(".suggestion-main")?.textContent || "";
            const dot = text.split("–")[0].trim();
            goToCarrier(dot);
            return;
          }
          */
    
          // Otherwise: show results in the grid (same page)
          clearSuggestions();
          await buildMyCarrierDots();   // <-- make sure "mine" is current
          setGridMode("SEARCH", q);
          currentPage = 1;
          loadCarriers();
        }


        searchInput.addEventListener("keydown", (e) => {
          if (e.key !== "Enter") return;
          e.preventDefault();
          handleSubmitSearch();
        });
    
        searchBtn.addEventListener("click", () => {
          handleSubmitSearch();
        });


    document.addEventListener("click", (e) => {
      if (!e.target.closest(".search-shell")) clearSuggestions();
    });
  }

  // ---------------------------------------------
  // SORT HEADER HANDLERS
  // ---------------------------------------------
  function wireSortHeaders() {
    const table = $("carriers-table");
    if (!table) return;

    const headers = Array.from(table.querySelectorAll("th.sortable"));

    function updateSortHeaderClasses() {
      headers.forEach((h) => {
        h.classList.remove("sorted-asc", "sorted-desc");
        if (h.dataset.col === sortBy) {
          h.classList.add(sortDir === "asc" ? "sorted-asc" : "sorted-desc");
        }
      });
    }

    headers.forEach((th) => {
      const colKey = th.dataset.col;

      th.addEventListener("click", () => {
        if (sortBy === colKey) {
          sortDir = sortDir === "asc" ? "desc" : "asc";
        } else {
          sortBy = colKey;
          sortDir = "asc";
        }

        currentPage = 1;
        updateSortHeaderClasses();
        loadCarriers();
      });
    });

    updateSortHeaderClasses();
  }

  // ---------------------------------------------
  // CSV DOWNLOAD (exports current table view)
  // ---------------------------------------------
function wireCsvDownload() {
  const btn = $("download-btn");
  if (!btn) return;

  btn.addEventListener("click", () => {
    // Gate for logged-out users
    if (typeof window.requireAccountOrGate === "function") {
      const ok = window.requireAccountOrGate({
        title: "Sign in to download CSV exports",
        body: "Export your carrier list to CSV for quick sharing and record-keeping.",
        note: "Starter is free (25 carriers)."
      });
      if (!ok) return;
    }

    try {
      const tbody = $("carrier-table-body");
      if (!tbody) return;

      const rows = Array.from(tbody.querySelectorAll("tr"));
      const realRows = rows.filter((tr) => tr.querySelectorAll("td").length >= 2);

      if (!realRows.length) {
        alert("No carriers to export.");
        return;
      }

      const lines = [];
      lines.push(
        ["DOT", "MC", "Carrier", "Location", "Operating", "Common", "Contract", "Broker", "Safety Rating"].join(",")
      );

      function csvCell(val) {
        let t = String(val ?? "").replace(/\s+/g, " ").trim();
        if (/[",\n]/.test(t)) t = '"' + t.replace(/"/g, '""') + '"';
        return t;
      }

      realRows.forEach((tr) => {
        const tds = Array.from(tr.querySelectorAll("td"));
        const dot = tds[1]?.innerText ?? "";
        const mc = tds[2]?.innerText ?? "";
        const carrier = tds[3]?.innerText ?? "";
        const location = tds[4]?.innerText ?? "";
        const operating = tds[5]?.innerText ?? "";
        const common = tds[6]?.innerText ?? "";
        const contract = tds[7]?.innerText ?? "";
        const broker = tds[8]?.innerText ?? "";
        const safety = tds[9]?.innerText ?? "";

        const cols = [dot, mc, carrier, location, operating, common, contract, broker, safety].map(csvCell);
        lines.push(cols.join(","));
      });

      const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8;" });
      const blobUrl = URL.createObjectURL(blob);

      const a = document.createElement("a");
      a.href = blobUrl;
      a.download = "carriers.csv";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(blobUrl);
    } catch (err) {
      console.error("CSV download failed", err);
      alert("Sorry, something went wrong generating the CSV.");
    }
  });
}

  // ---------------------------------------------
  // AUTH UI (Login/Logout buttons)
  // ---------------------------------------------
  function wireAuthUi() {
    const loginBtn = $("login-btn");
    const logoutBtn = $("logout-btn");
    if (!loginBtn || !logoutBtn) return;

    loginBtn.addEventListener("click", () => {
      window.location.href = "/login.html";
    });

    async function initAuthUI() {
      try {
        const res = await fetch("/api/me");
        const data = await res.json();

        if (data.user) {
          loginBtn.style.display = "none";
          logoutBtn.style.display = "inline-block";

          logoutBtn.onclick = async () => {
            await fetch("/api/logout", { method: "POST" });
            window.location.href = "/";
          };
        } else {
          loginBtn.style.display = "inline-block";
          logoutBtn.style.display = "none";
        }
      } catch (err) {
        console.error("auth ui error", err);
      }
    }

    initAuthUI();
  }

  // ---------------------------------------------
  // BULK SELECT + REMOVE
  // ---------------------------------------------


  function wireBulkRemove() {
    const tbody = $("carrier-table-body");
    const selectAll = $("select-all");
    const bulkBar = $("bulk-actions");
    const selectedCountEl = $("selected-count");
    const bulkRemoveBtn = $("bulk-remove-btn");

    if (!tbody || !selectAll || !bulkBar || !selectedCountEl || !bulkRemoveBtn) return;

    function updateBulkBar() {
      const selected = document.querySelectorAll(".row-select:checked");
      const count = selected.length;
      // Label changes by mode
      bulkRemoveBtn.textContent = gridMode === "SEARCH"
        ? "ADD SELECTED TO MY CARRIERS"
        : "REMOVE SELECTED FROM MY CARRIERS";


      if (count === 0) {
        bulkBar.classList.add("hidden");
        selectAll.checked = false;
      } else {
        bulkBar.classList.remove("hidden");
        selectedCountEl.textContent = String(count);

        const allBoxes = document.querySelectorAll(".row-select");
        selectAll.checked = count === allBoxes.length && allBoxes.length > 0;
      }
    }

    tbody.addEventListener("change", (e) => {
      if (e.target.classList.contains("row-select")) updateBulkBar();
    });

    selectAll.addEventListener("change", () => {
      const allBoxes = document.querySelectorAll(".row-select");
      allBoxes.forEach((cb) => (cb.checked = selectAll.checked));
      updateBulkBar();
    });

bulkRemoveBtn.addEventListener("click", async () => {
  const selected = Array.from(document.querySelectorAll(".row-select:checked"));
  if (!selected.length) return;

  const isSearchMode = gridMode === "SEARCH";

  if (isSearchMode) {
const ok = await window.showConfirm({
  title: `Add ${selected.length} carriers?`,
  message: `Add ${selected.length} carriers to My Carriers?`,
  confirmText: "Add",
  confirmVariant: "primary"
});
    
    if (!ok) return;

    // bulk add using your existing endpoint (same as import)
    const dots = selected.map((cb) => cb.dataset.dot).filter(Boolean);

    // ✅ Limit gate (client-side UX)
    const me = await getMeCached();
    if (!me) {
      // logged out (shouldn't happen much in SEARCH but safe)
      if (typeof window.requireAccountOrGate === "function") {
        window.requireAccountOrGate({
          title: "Sign in to add carriers",
          body: "Save carriers to your list and track updates in one place.",
          note: "Starter is free (25 carriers).",
        });
        return;
      }
      window.location.href = "/login.html";
      return;
    }
    
    const limit = Number(me.carrier_limit ?? 0);
    const count = Number(me.carrier_count ?? 0);
    
    // only count dots that are NOT already in My Carriers
    const newDots = dots
      .map(normDot)
      .filter(Boolean)
      .filter((d) => !myCarrierDots.has(d));
    
    // If already at/over limit, no adds possible (0 means none allowed)
    if (count >= limit) {
      showLimitGate({ limit, count, noPlan: isNoPlanUser(me) });
      return;
    }
    // otherwise proceed (partial success is allowed)

    try {
      const res = await fetch("/api/my-carriers/bulk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dots }),
      });

      if (res.status === 401) {
        alert("Your session expired. Please log in again.");
        window.location.href = "/login.html";
        return;
      }

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
      
        // ✅ HARD ENFORCEMENT (server says limit hit)
        if (res.status === 409 && body?.code === "CARRIER_LIMIT") {
          // keep cached ME in sync if server provides these
          if (ME) {
            if (typeof body.carrier_count === "number") ME.carrier_count = body.carrier_count;
            if (typeof body.carrier_limit === "number") ME.carrier_limit = body.carrier_limit;
          }
      
          showLimitGate({
            limit: Number(body.carrier_limit ?? ME?.carrier_limit ?? 0),
            count: Number(body.carrier_count ?? ME?.carrier_count ?? 0),
            noPlan: isNoPlanUser(ME),
          });
          return;
        }
      
        console.error("Bulk add failed:", body);
        alert(body?.error || "Could not add carriers. Please try again.");
        return;
      }

const body = await res.json().catch(() => ({}));
if (ME && typeof body.carrier_count === "number") ME.carrier_count = body.carrier_count;

  const s = body?.summary || {};
const inserted = Number(s.inserted || 0);
const duplicates = Number(s.duplicates || 0);
const invalid = Number(s.invalid || 0);
const skipped = Number(s.skipped_limit || 0);

if (skipped > 0) {
  if (isNoPlanUser(ME)) {
    showLimitGate({
      limit: Number(ME?.carrier_limit ?? 0),
      count: Number(ME?.carrier_count ?? 0),
      noPlan: true,
    });
    return;
  }

  const limitNow = Number(ME?.carrier_limit ?? 0);
  const countNow = Number(ME?.carrier_count ?? 0);
  const loggedIn = !!window.csIsLoggedIn;

  if (typeof window.showAccessGate === "function") {
    window.showAccessGate({
      title: "Some carriers were skipped",
      body: `${inserted} added. ${skipped} skipped because you're at your carrier limit (${countNow}/${limitNow}).`,
      note: "Upgrade your plan to add more carriers.",
      createLabel: loggedIn ? "Upgrade plan" : "Sign in",
      signInLabel: "Sign in",
      createHref: loggedIn ? "/account?tab=plan" : "/login",
      signInHref: "/login",
      hideSignIn: true,
    });
  } else {
    alert(`${inserted} added. ${skipped} skipped due to plan limit.`);
  }
} else {
  // optional: success message if you want
  // alert(`${inserted} carriers added.`);
}
      
      // refresh truth from server (fixes pagination/search consistency)
      await buildMyCarrierDots();

const insertedDots = Array.isArray(body.inserted_dots) ? body.inserted_dots.map(normDot) : [];

insertedDots.forEach(d => myCarrierDots.add(d));

selected.forEach((cb) => {
  const dot = normDot(cb.dataset.dot);
  if (!insertedDots.includes(dot)) return;

  const row = cb.closest("tr");
  const cell = cb.closest("td");
  if (row) row.classList.add("is-mine");
  if (cell) cell.innerHTML = `<span class="saved-check" title="Already in My Carriers">✓</span>`;
});

      // hide bulk UI
      updateBulkBar();
    } catch (err) {
      console.error("Network error bulk add", err);
      alert("Network error adding carriers.");
    }

    return;
  }

  // ---- MY mode: remove (your existing logic) ----
const ok = await window.showConfirm({
  title: `Remove ${selected.length} carriers?`,
  message: `Remove ${selected.length} carriers from My Carriers?`,
  confirmText: "Remove",
  confirmVariant: "danger"
});

  if (!ok) return;

  for (const cb of selected) {
    const dot = cb.dataset.dot;
    try {
      const res = await fetch(`/api/my-carriers/${encodeURIComponent(dot)}`, { method: "DELETE" });

      if (res.status === 401) {
        alert("Your session expired. Please log in again.");
        window.location.href = "/login.html";
        return;
      }

      if (!res.ok) {
        console.error("Failed to remove", dot, await res.text());
      } else {
        myCarrierDots.delete(normDot(dot));
        const row = cb.closest("tr");
        if (row) row.remove();
      }
    } catch (err) {
      console.error("Network error removing", dot, err);
    }
  }

  updateBulkBar();
});

  }

  // ---------------------------------------------
  // BULK IMPORT WIZARD
  // NOTE: This assumes the modal HTML stays in index.html
  // ---------------------------------------------
  function wireBulkImportWizard() {
    // refs
    const bulkImportBtn = $("bulk-import-btn");
    const importModal = $("import-modal");
    const importCloseBtn = $("import-modal-close");
    const importCancelBtn = $("import-cancel-btn");
    const importNextBtn = $("import-next-btn");
    const importBackBtn = $("import-back-btn");

    if (!bulkImportBtn || !importModal || !importNextBtn) return;

    const stepEls = {
      1: document.querySelector(".import-step-body-1"),
      2: document.querySelector(".import-step-body-2"),
      3: document.querySelector(".import-step-body-3"),
    };

    const stepTabs = {
      1: document.querySelector(".import-step-1"),
      2: document.querySelector(".import-step-2"),
      3: document.querySelector(".import-step-3"),
    };

    let currentStep = 1;
    let importMethod = "csv";
    let parsedDotsFromCsv = [];
    let previewResult = null;

    const loadingEl = $("import-loading");
    const resultsEl = $("import-results");

    const summaryNewCount = $("summary-new-count");
    const summaryDupCount = $("summary-dup-count");
    const summaryInvCount = $("summary-invalid-count");
    
// ✅ Step 3 "Done" IDs (match index.html)
const doneInsertedEl   = $("done-imported-count");
const doneDuplicatesEl = $("done-dup-count");
const doneInvalidEl    = $("done-invalid-count");
const doneSkippedEl    = $("done-skipped-count"); // only if you have this element in HTML

// ✅ Step 2 section header counts (match index.html)
const newCountEl = $("new-count");
const dupCountEl = $("dup-count");
const invalidCountEl = $("invalid-count");

// ✅ Step 2 table bodies (match index.html)
const newTbody = $("import-new-tbody");
const dupTbody = $("import-dup-tbody");
const invalidTbody = $("import-invalid-tbody");

// ✅ "empty" placeholders (match index.html)
const newEmptyEl = $("import-new-empty");
const dupEmptyEl = $("import-dup-empty");
const invalidEmptyEl = $("import-invalid-empty");

    const methodButtons = document.querySelectorAll(".import-method-btn");
    const csvPanel = $("import-panel-csv");
    const pastePanel = $("import-panel-paste");

    const dropzone = $("csv-dropzone");
    const fileInput = $("csv-file-input");
    const browseCsvBtn = $("browse-csv-btn");
    const csvSummaryEl = $("csv-upload-summary");
    const csvFileNameEl = $("csv-file-name");
    const csvDotCountEl = $("csv-dot-count");

    const dotPasteTextarea = $("dot-paste-textarea");

    function openImportModal() {
      importModal.classList.remove("hidden");
      goToStep(1);
    }

    function resetWizardState() {
      currentStep = 1;
      previewResult = null;
      parsedDotsFromCsv = [];

      if (csvSummaryEl) {
        csvSummaryEl.classList.add("hidden");
        if (csvFileNameEl) csvFileNameEl.textContent = "";
        if (csvDotCountEl) csvDotCountEl.textContent = "0";
      }

      if (dotPasteTextarea) dotPasteTextarea.value = "";

if (newTbody) newTbody.innerHTML = "";
if (dupTbody) dupTbody.innerHTML = "";
if (invalidTbody) invalidTbody.innerHTML = "";

if (newEmptyEl) newEmptyEl.classList.remove("hidden");
if (dupEmptyEl) dupEmptyEl.classList.remove("hidden");
if (invalidEmptyEl) invalidEmptyEl.classList.remove("hidden");

setSummaryCounts(0, 0, 0);

      if (loadingEl) loadingEl.classList.add("hidden");
      if (resultsEl) resultsEl.classList.add("hidden");
    }

    function closeImportModal() {
      importModal.classList.add("hidden");
      resetWizardState();
    }

    bulkImportBtn.addEventListener("click", () => {
      // If logged out, show the reusable sign-in gate instead of opening the modal
      if (typeof window.requireAccountOrGate === "function") {
        const ok = window.requireAccountOrGate({
          title: "Sign in to use Bulk Import",
          body: "Upload a CSV or paste DOTs, then add carriers in seconds.",
          note: "Starter is free (25 carriers)."
        });
        if (!ok) return;
      }
    
      // Logged in → open bulk import modal
      openImportModal();
    });
    
    [importCloseBtn, importCancelBtn].forEach((btn) => btn && btn.addEventListener("click", closeImportModal));

    importModal.addEventListener("click", (e) => {
      if (e.target === importModal) closeImportModal();
    });

    function goToStep(step) {
      currentStep = step;

      Object.entries(stepEls).forEach(([num, el]) => {
        if (!el) return;
        el.classList.toggle("active", Number(num) === step);
      });

      Object.entries(stepTabs).forEach(([num, el]) => {
        if (!el) return;
        el.classList.toggle("import-step-active", Number(num) === step);
      });

      if (step === 1) {
        if (importBackBtn) importBackBtn.style.visibility = "hidden";
        importNextBtn.textContent = "Next";
      } else if (step === 2) {
        if (importBackBtn) importBackBtn.style.visibility = "visible";
        importNextBtn.textContent = "Import carriers";
      } else if (step === 3) {
        if (importBackBtn) importBackBtn.style.visibility = "hidden";
        importNextBtn.textContent = "Finish";
      }
    }

    if (importBackBtn) {
      importBackBtn.addEventListener("click", () => {
        if (currentStep === 2) goToStep(1);
        else if (currentStep === 3) goToStep(2);
      });
    }

    function setImportMethod(method) {
      importMethod = method;

      methodButtons.forEach((btn) => {
        const isActive = btn.dataset.importMethod === method;
        btn.classList.toggle("import-method-active", isActive);
      });

      if (csvPanel && pastePanel) {
        csvPanel.classList.toggle("active", method === "csv");
        pastePanel.classList.toggle("active", method === "paste");
      }
    }

    methodButtons.forEach((btn) => {
      btn.addEventListener("click", () => setImportMethod(btn.dataset.importMethod));
    });

    setImportMethod("csv");

    function parseDotsFromCsvText(text) {
      const parsed = Papa.parse(text, {
        header: true,
        skipEmptyLines: true,
        transformHeader: (h) => String(h || "").trim().toLowerCase(),
      });

      if (parsed.errors?.length) console.warn("CSV parse warnings:", parsed.errors);

      const rows = parsed.data || [];
      if (!rows.length) return [];

      const dotKeys = ["dot", "dotnumber", "dot_number", "usd_dot", "dot #"];
      let dotKey = null;

      const sample = rows[0];
      for (const k of Object.keys(sample)) {
        if (dotKeys.includes(k)) {
          dotKey = k;
          break;
        }
      }

      if (!dotKey) {
        alert("Could not find a DOT column. Expect a header like DOT or dotnumber.");
        return [];
      }

      const dots = [];
      for (const r of rows) {
        const raw = String(r[dotKey] ?? "").trim();
        if (!raw) continue;

        const digits = raw.replace(/\D/g, "");
        if (digits.length >= 1 && digits.length <= 7) dots.push(digits);
      }

      return [...new Set(dots)];
    }

    function handleFiles(files) {
      if (!files || !files.length) return;
      const file = files[0];

      const reader = new FileReader();
      reader.onload = (e) => {
        const text = e.target.result;
        const dots = parseDotsFromCsvText(text);
        parsedDotsFromCsv = dots;

        if (!csvSummaryEl) return;

        if (dots.length > 0) {
          csvSummaryEl.classList.remove("hidden");
          if (csvFileNameEl) csvFileNameEl.textContent = " – " + file.name;
          if (csvDotCountEl) csvDotCountEl.textContent = String(dots.length);
        } else {
          csvSummaryEl.classList.add("hidden");
          alert("No valid DOT numbers found in the CSV.");
        }
      };
      reader.readAsText(file);
    }

    if (browseCsvBtn && fileInput) {
      browseCsvBtn.addEventListener("click", () => fileInput.click());
      fileInput.addEventListener("change", (e) => handleFiles(e.target.files));
    }

    if (dropzone) {
      ["dragenter", "dragover"].forEach((eventName) => {
        dropzone.addEventListener(eventName, (e) => {
          e.preventDefault();
          e.stopPropagation();
          dropzone.classList.add("drop-active");
        });
      });

      ["dragleave", "drop"].forEach((eventName) => {
        dropzone.addEventListener(eventName, (e) => {
          e.preventDefault();
          e.stopPropagation();
          dropzone.classList.remove("drop-active");
        });
      });

      dropzone.addEventListener("drop", (e) => {
        const dt = e.dataTransfer;
        if (dt && dt.files) handleFiles(dt.files);
      });

      dropzone.addEventListener("click", () => fileInput && fileInput.click());
    }

    function getDotsFromPaste() {
      if (!dotPasteTextarea) return [];
      const raw = dotPasteTextarea.value || "";
      const lines = raw
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean);
      const dots = lines.filter((v) => /^\d+$/.test(v));
      return [...new Set(dots)];
    }

function setSummaryCounts(newCount, dupCount, invCount) {
  // top summary pills
  if (summaryNewCount) summaryNewCount.textContent = String(newCount);
  if (summaryDupCount) summaryDupCount.textContent = String(dupCount);
  if (summaryInvCount) summaryInvCount.textContent = String(invCount);

  // section header counts (the "(0)" next to each section title)
  if (newCountEl) newCountEl.textContent = String(newCount);
  if (dupCountEl) dupCountEl.textContent = String(dupCount);
  if (invalidCountEl) invalidCountEl.textContent = String(invCount);
}

function renderRows(tbody, rows, kind) {
  if (!tbody) return;
  tbody.innerHTML = "";

  (rows || []).forEach((row) => {
    const tr = document.createElement("tr");

    // DOT / Value
    const tdDot = document.createElement("td");
    tdDot.textContent = row.dot || row.value || "—";
    tr.appendChild(tdDot);

    // Carrier / Reason
    const td2 = document.createElement("td");
    if (kind === "invalid") td2.textContent = row.reason || "Invalid DOT";
    else td2.textContent = row.name || "—";
    tr.appendChild(td2);

    // Notes
    const tdNotes = document.createElement("td");
    const loc =
      row.city || row.state
        ? `${row.city || ""}${row.city && row.state ? ", " : ""}${row.state || ""}`
        : "—";
    tdNotes.textContent = kind === "invalid" ? (row.notes || "—") : loc;
    tr.appendChild(tdNotes);

    // Status
    const tdStatus = document.createElement("td");
    if (kind === "new") tdStatus.textContent = "New";
    else if (kind === "dup") tdStatus.textContent = "Current Carrier";
    else tdStatus.textContent = "Invalid";
    tr.appendChild(tdStatus);

    tbody.appendChild(tr);
  });
}

function renderPreviewTable(preview) {
  const newRows = preview?.new || [];
  const dupRows = preview?.duplicates || [];
  const invRows = preview?.invalid || [];

  renderRows(newTbody, newRows, "new");
  renderRows(dupTbody, dupRows, "dup");
  renderRows(invalidTbody, invRows, "invalid");

  // toggle empty placeholders
  if (newEmptyEl) newEmptyEl.classList.toggle("hidden", newRows.length > 0);
  if (dupEmptyEl) dupEmptyEl.classList.toggle("hidden", dupRows.length > 0);
  if (invalidEmptyEl) invalidEmptyEl.classList.toggle("hidden", invRows.length > 0);
}

    async function runPreview(dots) {
      if (!dots.length) {
        alert("No valid DOT numbers to import.");
        return;
      }

      if (loadingEl) loadingEl.classList.remove("hidden");
      if (resultsEl) resultsEl.classList.add("hidden");
      setSummaryCounts(0, 0, 0);

      try {
        const res = await fetch("/api/my-carriers/bulk/preview", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ dots }),
        });

        if (res.status === 401) {
          alert("You must be logged in to import carriers.");
          return;
        }

        if (!res.ok) {
          const errData = await res.json().catch(() => ({}));
          console.error("Preview failed:", errData);
          alert("Preview failed. Please try again.");
          return;
        }

        const data = await res.json();
        previewResult = data;

        const s = data.summary || {};
        setSummaryCounts(s.new || 0, s.duplicates || 0, s.invalid || 0);
        renderPreviewTable(data);

        if (resultsEl) resultsEl.classList.remove("hidden");
      } catch (err) {
        console.error("Error calling preview:", err);
        alert("Preview failed due to a network error.");
      } finally {
        if (loadingEl) loadingEl.classList.add("hidden");
      }
    }

    async function runImportFromPreview() {
      if (!previewResult || !previewResult.new || previewResult.new.length === 0) {
        const summary = previewResult?.summary || {};
        if (doneInsertedEl) doneInsertedEl.textContent = "0";
        if (doneDuplicatesEl) doneDuplicatesEl.textContent = String(summary.duplicates || 0);
        if (doneInvalidEl) doneInvalidEl.textContent = String(summary.invalid || 0);

        goToStep(3);
        return;
      }

      try {
        importNextBtn.disabled = true;

        const dots = previewResult.new.map((r) => r.dot).filter(Boolean);

        const res = await fetch("/api/my-carriers/bulk", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ dots }),
        });

        if (res.status === 401) {
          alert("You must be logged in to import carriers.");
          return;
        }

        if (res.status === 409) {
          const errData = await res.json().catch(() => ({}));
        
          if (errData?.code === "CARRIER_LIMIT") {
            // show your nice modal
            showLimitGate({
              limit: Number(errData.carrier_limit ?? 0),
              count: Number(errData.carrier_count ?? 0),
              noPlan: isNoPlanUser(await getMeCached()),
            });
        
            // and still take them to Step 3 with zeros (optional but feels clean)
            if (doneInsertedEl) doneInsertedEl.textContent = "0";
            if (doneDuplicatesEl) doneDuplicatesEl.textContent = "0";
            if (doneInvalidEl) doneInvalidEl.textContent = "0";
            if (doneSkippedEl) doneSkippedEl.textContent = "0";
        
            goToStep(3);
            return;
          }
        }

        if (!res.ok) {
          const errData = await res.json().catch(() => ({}));
          console.error("Bulk import failed:", errData);
          alert("Bulk import failed. Please try again.");
          return;
        }

        const data = await res.json();
        const s = data.summary || {};

        // ✅ If we partially imported due to plan limit, show the same gate popup as search-bulk
        const skipped = Number(s.skipped_limit || 0);
        const inserted = Number(s.inserted || 0);
        
        if (skipped > 0) {
          const me = await getMeCached(); // you already have this helper in index.js
          if (isNoPlanUser(me)) {
            showLimitGate({
              limit: Number(me?.carrier_limit ?? 0),
              count: Number(me?.carrier_count ?? 0),
              noPlan: true,
            });
            return;
          }

          const limitNow = Number(me?.carrier_limit ?? 0);
          const countNow  = Number(me?.carrier_count ?? 0);
          const loggedIn = !!window.csIsLoggedIn;
        
          if (typeof window.showAccessGate === "function") {
            window.showAccessGate({
              title: "Some carriers were skipped",
              body: `${inserted} added. ${skipped} skipped because you're at your carrier limit (${countNow}/${limitNow}).`,
              note: "Upgrade your plan to add more carriers.",
              createLabel: loggedIn ? "Upgrade plan" : "Sign in",
              signInLabel: "Sign in",
              createHref: loggedIn ? "/account?tab=plan" : "/login",
              signInHref: "/login",
              hideSignIn: true,
            });
          } else {
            alert(`${inserted} added. ${skipped} skipped due to plan limit.`);
          }
        }
        
        if (doneSkippedEl) doneSkippedEl.textContent = String(s.skipped_limit || 0);

        if (doneInsertedEl) doneInsertedEl.textContent = String(s.inserted || 0);
        if (doneDuplicatesEl) doneDuplicatesEl.textContent = String(s.duplicates || 0);
        if (doneInvalidEl) doneInvalidEl.textContent = String(s.invalid || 0);

        goToStep(3);
      } catch (err) {
        console.error("Error in bulk import:", err);
        alert("Bulk import failed due to a network error.");
      } finally {
        importNextBtn.disabled = false;
      }
    }

    importNextBtn.addEventListener("click", async () => {
      if (currentStep === 1) {
        const dots = importMethod === "csv" ? parsedDotsFromCsv || [] : getDotsFromPaste();
        if (!dots.length) {
          alert("Please upload a CSV with DOTs or paste DOT numbers first.");
          return;
        }
        goToStep(2);
        runPreview(dots);
      } else if (currentStep === 2) {
        runImportFromPreview();
} else if (currentStep === 3) {
  closeImportModal();
  currentPage = 1;
  setGridMode("MY");
  await loadCarriers();
  startQueuePolling(); // <-- show miracle worker
}
    });

    // Accordion toggles
    document.querySelectorAll(".import-section-header").forEach((btn) => {
      btn.addEventListener("click", () => {
        const section = btn.closest(".import-section");
        if (!section) return;
        section.classList.toggle("collapsed");
      });
    });

    // Default: collapse duplicates + invalid
    document
      .querySelectorAll('.import-section[data-section="duplicate"], .import-section[data-section="invalid"]')
      .forEach((sec) => sec.classList.add("collapsed"));
  }

  // ---------------------------------------------
  // BOOT
  // ---------------------------------------------
    document.addEventListener("DOMContentLoaded", async () => {
      wireFiltersPanel();
      wireGridModeBar();
      wireRowsPerPage();
      wireAutocomplete();

      wireSortHeaders();
      wireCsvDownload();
      wireAuthUi();
      wireBulkRemove();
      wireBulkImportWizard();
    
      setGridMode("MY");
    
      await syncQueueOnce();
      await loadCarriers();
    
      if (updatingDots.size > 0) startQueuePolling();
    });

})();
