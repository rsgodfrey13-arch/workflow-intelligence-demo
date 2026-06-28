// static/js/pages/carrier.js
(() => {

function openContractSuccessModal() {
  const modal = document.getElementById("contractSuccessModal");
  if (!modal) return;
  modal.classList.remove("hidden");
  modal.setAttribute("aria-hidden", "false");
}

function closeContractSuccessModal() {
  const modal = document.getElementById("contractSuccessModal");
  if (!modal) return;
  modal.classList.add("hidden");
  modal.setAttribute("aria-hidden", "true");
}

document.getElementById("contractSuccessOk")?.addEventListener("click", closeContractSuccessModal);
document.getElementById("contractSuccessClose")?.addEventListener("click", closeContractSuccessModal);

document.querySelector("#contractSuccessModal .contract-success-backdrop")?.addEventListener("click", closeContractSuccessModal);

  
function showFeatureGate({ title, body, note = "", primaryText = "Continue", onPrimary }) {
  const backdrop = document.getElementById("feature-gate-modal");
  const elTitle = document.getElementById("feature-gate-title");
  const elBody = document.getElementById("feature-gate-body");
  const elNote = document.getElementById("feature-gate-note");
  const btnPrimary = document.getElementById("feature-gate-primary");
  const btnCancel = document.getElementById("feature-gate-cancel");
  const btnClose = document.getElementById("feature-gate-close");

  if (!backdrop || !elTitle || !elBody || !elNote || !btnPrimary || !btnCancel || !btnClose) {
    // fallback (shouldn't happen)
    alert(`${title}\n\n${body}`);
    return;
  }

  elTitle.textContent = title || "";
  elBody.textContent = body || "";
  elNote.textContent = note || "";
  elNote.style.display = note ? "" : "none";
  btnPrimary.textContent = primaryText || "Continue";

  function close() {
    backdrop.hidden = true;
    btnPrimary.onclick = null;
    backdrop.onclick = null;
    document.removeEventListener("keydown", onEsc);
  }

  function onEsc(e) {
    if (e.key === "Escape") close();
  }

  btnPrimary.onclick = () => {
    try { onPrimary && onPrimary(); } finally { close(); }
  };
  btnCancel.onclick = close;
  btnClose.onclick = close;

  // click outside closes
  backdrop.onclick = (e) => {
    if (e.target === backdrop) close();
  };

  document.addEventListener("keydown", onEsc);
  backdrop.hidden = false;
}

function fmtSignedDate(d) {
  if (!d) return "";
  const parsed = new Date(d);
  if (Number.isNaN(parsed.getTime())) return "";

  return parsed.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric"
  });
}
  
  function getDotFromPath() {
    // take first path segment only, ignore trailing slash / extra segments
    const seg = window.location.pathname.split("/").filter(Boolean).pop() || "";
    // DOT should be digits only
    const digits = decodeURIComponent(seg).replace(/\D/g, "");
    // strip leading zeros safely (optional)
    const noLeading = digits.replace(/^0+/, "");
    return noLeading || (digits ? "0" : "");
  }

  const CURRENT_DOT = getDotFromPath(); 
  let initButtonsRunning = false;
  let initButtonsRerun = false; // NEW: queue reruns instead of dropping
  let screeningResultPayload = null;
  let selectedScreeningProfileId = null;
  let selectedOverrideContext = null;
  let isOverrideSaveInFlight = false;
  let removeOverrideConfirmResolver = null;
  let showAdminInsuranceActions = false;
  let selectedInsuranceCoverageDelete = null;
  let insuranceDeleteInFlight = false;
  let insuranceRaiseReviewInFlight = false;
  let insuranceRaiseReviewCompleted = false;

  
  function setText(id, value) {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent =
      value !== null && value !== undefined && value !== "" ? value : "—";
  }

  function getCarrierMcList(c) {
    if (Array.isArray(c?.mc_numbers)) {
      return c.mc_numbers
        .map(v => String(v ?? "").trim())
        .filter(Boolean);
    }

    if (typeof c?.mc_numbers === "string") {
      const raw = c.mc_numbers.trim();

      if (raw.startsWith("{") && raw.endsWith("}")) {
        return raw
          .slice(1, -1)
          .split(",")
          .map(v => String(v ?? "").replace(/^"|"$/g, "").trim())
          .filter(Boolean);
      }

      return raw
        .split(/[\n,|]/)
        .map(v => String(v ?? "").trim())
        .filter(Boolean);
    }

    const primary = String(c?.primary_mc_number ?? "").trim();
    if (primary) return [primary];

    const legacy = String(c?.mc_number ?? "").trim();
    if (legacy) return [legacy];

    return [];
  }

  function setCarrierMcDisplay(c) {
    const el = document.getElementById("carrier-mc");
    if (!el) return;

    const list = getCarrierMcList(c);
    el.innerHTML = "";

    if (!list.length) {
      el.textContent = "—";
      return;
    }

    if (list.length === 1) {
      el.textContent = list[0];
      return;
    }

    const wrap = document.createElement("div");
    wrap.className = "mc-stack";

    list.forEach((mc) => {
      const line = document.createElement("div");
      line.className = "mc-stack__item";
      line.textContent = mc;
      wrap.appendChild(line);
    });

    el.appendChild(wrap);
  }

  function setLink(id, url) {
    const el = document.getElementById(id);
    if (!el) return;

    if (url) {
      el.textContent = "Open";
      el.href = url;
    } else {
      el.textContent = "—";
      el.removeAttribute("href");
    }
  }

async function getMe() {
  try {
    const r = await fetch("/api/me", { credentials: "include" });
    const j = await r.json().catch(() => ({}));
    return j?.user || null; // your /api/me returns { user: ... }
  } catch {
    return null;
  }
}

function hasSelectedPlan(user) {
  const plan = String(user?.plan || "").trim().toLowerCase();
  if (!plan) return false;
  return !["none", "no_plan", "no-plan", "unselected"].includes(plan);
}

function isNoPlanUser(user) {
  return !!user && !hasSelectedPlan(user);
}

function showLoggedInGate({ title, body, primaryText, onPrimary }) {
  const ok = confirm(`${title}\n\n${body}\n\nContinue?`);
  if (ok) onPrimary?.();
}
  
function applyInsuranceLock(me) {
  const overlay = document.getElementById("insurance-locked");
  const upgradeBtn = document.getElementById("btn-upgrade-insurance");
  const titleEl = document.getElementById("insurance-lock-title");
  const bodyEl = document.getElementById("insurance-lock-body");

  if (!overlay) return;

  const loggedIn = !!me;
  const allowed = me?.view_insurance === true;

  // ------------------------
  // NOT LOGGED IN
  // ------------------------
  if (!loggedIn) {
    setInsuranceLocked(true);

    if (titleEl) titleEl.textContent = "Sign in to view insurance coverages";
    if (bodyEl) bodyEl.textContent =
      "Sign in to view carrier insurance coverages and document status.";

    if (upgradeBtn) {
      upgradeBtn.textContent = "Sign in";
      upgradeBtn.onclick = (e) => {
        e.preventDefault();
        window.requireAccountOrGate({
          title: "Sign in to view insurance",
          body: "Insurance coverage access is not enabled for this account.",
          note: "",
          createLabel: "Sign in",
          createHref: "/login",
          hideSignIn: true
        });
      };
    }

    return;
  }


  
  // ------------------------
  // LOGGED IN BUT NOT ALLOWED
  // ------------------------
  if (!allowed) {
    setInsuranceLocked(true);

    if (titleEl) titleEl.textContent = "Insurance access isn’t enabled";
    if (bodyEl) bodyEl.textContent =
      "Upgrade to Pro to view carrier insurance coverages.";

    if (upgradeBtn) {
      upgradeBtn.textContent = "Open account";
      upgradeBtn.onclick = () => {
        window.location.href = "/account";
      };
    }

    return;
  }

  // ------------------------
  // ALLOWED
  // ------------------------
  setInsuranceLocked(false);
}

function setInsuranceLocked(locked) {
  const card = document.getElementById("ins-coverages-card");
  const overlay = document.getElementById("insurance-locked");

  if (overlay) overlay.style.display = locked ? "flex" : "none";
  if (card) card.classList.toggle("is-locked", locked);
}

  
function fmtDate(d) {
  if (!d) return "—";
  // if backend returns YYYY-MM-DD
  const s = String(d).slice(0, 10);
  const [y, m, day] = s.split("-");
  if (!y || !m || !day) return s;
  return `${m}/${day}/${y}`;
}

function setContractSignStatus(text = "", show = false) {
  const el = document.getElementById("contract-sign-status");
  if (!el) return;

  if (!show || !text) {
    el.hidden = true;
    el.textContent = "";
    return;
  }

  el.textContent = text;
  el.hidden = false;
}
  
function fmtDateTime(d) {
  if (!d) return "—";
  const parsed = new Date(d);
  if (Number.isNaN(parsed.getTime())) return fmtDate(d);
  try {
    return parsed.toLocaleString();
  } catch {
    return fmtDate(d);
  }
}

function safeText(value, fallback = "—") {
  if (value === null || value === undefined) return fallback;
  const text = String(value).trim();
  return text || fallback;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function screeningBadgeClass(status) {
  const normalized = String(status || "").toUpperCase();
  if (normalized === "PASS") return "pill-ok";
  if (normalized === "REVIEW") return "pill-warn";
  if (normalized === "FAIL") return "pill-fail";
  return "";
}

function computeScreeningCounts(result) {
  const passed = Number(result?.matched_count) || 0;
  const failed = Number(result?.failed_count) || 0;
  const review = Number(result?.review_count) || 0;
  const total = passed + failed + review;
  return { passed, failed, review, total };
}

function getScreeningRatioText(result) {
  if (!result) return "No screening result";
  const { passed, total } = computeScreeningCounts(result);
  if (total === 0) return "No checks configured";
  return `${passed}/${total} checks passed`;
}

function normalizeWholeNumberDisplay(value) {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return value;
    return Number.isInteger(value) ? String(value) : String(value);
  }

  const text = String(value ?? "").trim();
  if (!text) return value;

  const wholeNumberMatch = text.match(/^([+-]?\d+)\.0+$/);
  if (wholeNumberMatch) return wholeNumberMatch[1];

  return text;
}
  
function prettifyValue(value) {
  if (value === null || value === undefined) return "—";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return "—";
    return String(normalizeWholeNumberDisplay(value));
  }

  const text = String(normalizeWholeNumberDisplay(value)).trim();
  if (!text) return "—";

  const aliases = {
    Y: "Yes",
    N: "None",
    A: "Active"
  };
  if (aliases[text.toUpperCase()]) return aliases[text.toUpperCase()];

  return text
    .replaceAll(/[_-]+/g, " ")
    .replaceAll(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function operatorLabel(operator) {
  const op = String(operator || "EQUALS").toUpperCase();
  return {
    EQUALS: "",
    NOT_EQUALS: "Not",
    IN: "One of",
    NOT_IN: "Not one of",
    LESS_THAN: "Less than",
    LESS_THAN_OR_EQUAL: "Less than or equal to",
    GREATER_THAN: "Greater than",
    GREATER_THAN_OR_EQUAL: "Greater than or equal to",
    IS_TRUE: "Yes",
    IS_FALSE: "No"
  }[op] || op.replaceAll("_", " ").toLowerCase();
}

function formatRequirement(item) {
  if (!item || typeof item !== "object") return "—";
  const op = String(item.comparison_operator || "EQUALS").toUpperCase();
  if (op === "IS_TRUE" || op === "IS_FALSE") return operatorLabel(op);

  const expected = item.expected_value || {};
  const rawExpected =
    expected.value_text ?? expected.value_number ?? expected.value_date ?? expected.value_bool ?? null;

  if (rawExpected === null || rawExpected === undefined || rawExpected === "") {
    return "—";
  }

  if (op === "IN" || op === "NOT_IN") {
    const tokens = String(rawExpected)
      .split(",")
      .map((token) => prettifyValue(token))
      .filter((token) => token && token !== "—");
    if (!tokens.length) return "—";
    const joined = tokens.join(" or ");
    return op === "IN" ? joined : `Not ${joined}`;
  }

  const expectedDisplay = prettifyValue(rawExpected);
  const opDisplay = operatorLabel(op);
  return opDisplay ? `${opDisplay} ${expectedDisplay}` : expectedDisplay;
}

function formatCarrierValue(item) {
  if (!item || typeof item !== "object") return "—";

  if (item.actual_value_normalized !== null && item.actual_value_normalized !== undefined && String(item.actual_value_normalized).trim() !== "") {
    return prettifyValue(item.actual_value_normalized);
  }

  if (item.actual_value_raw === null || item.actual_value_raw === undefined || String(item.actual_value_raw).trim() === "") {
    if (String(item.criteria_key || "").toLowerCase().includes("safety") || String(item.label || "").toLowerCase().includes("safety")) {
      return "Not Rated";
    }
    return "—";
  }

  return prettifyValue(item.actual_value_raw);
}

function flattenScreeningDetails(resultSummary) {
  if (!resultSummary || typeof resultSummary !== "object") return [];

  const normalizeItem = (item, profileId) => {
    if (!item || typeof item !== "object") return null;
    const check = String(item.label ?? item.criterion ?? item.name ?? item.title ?? item.check ?? "").trim();
    const status = String(item.status ?? item.result ?? item.outcome ?? item.verdict ?? "").trim().toUpperCase();
    const profileCriteriaId = item.profile_criteria_id ?? null;
    if (!check || !status) return null;
    return {
      check,
      carrier: formatCarrierValue(item),
      requirement: formatRequirement(item),
      status,
      profile_id: profileId || null,
      profile_criteria_id: profileCriteriaId,
      is_overridden: item.is_overridden === true,
      override_expires_at: item.override_expires_at || null,
      override_note: item.override_note || null
    };
  };

  const dedupeBy = new Set();
  const dedupePush = (rows, row) => {
    if (!row) return;
    const key = `${row.profile_criteria_id ?? row.check}::${row.status}`;
    if (dedupeBy.has(key)) return;
    dedupeBy.add(key);
    rows.push(row);
  };

  if (Array.isArray(resultSummary)) {
    const rows = [];
    resultSummary.forEach((item) => dedupePush(rows, normalizeItem(item, null)));
    return rows;
  }

  const rows = [];
  const candidateArrays = [];
  if (Array.isArray(resultSummary.criteria)) candidateArrays.push(resultSummary.criteria);
  if (Array.isArray(resultSummary.standalone_criteria)) candidateArrays.push(resultSummary.standalone_criteria);
  if (Array.isArray(resultSummary.groups)) {
    resultSummary.groups.forEach((group) => {
      if (Array.isArray(group?.criteria)) candidateArrays.push(group.criteria);
    });
  }

  if (!candidateArrays.length) {
    const arrayKeys = ["checks", "results", "items", "breakdown"];
    for (const key of arrayKeys) {
      if (Array.isArray(resultSummary[key])) candidateArrays.push(resultSummary[key]);
    }
  }

  candidateArrays.flat().forEach((item) => dedupePush(rows, normalizeItem(item, null)));
  return rows;
}

function getOverrideExpiresText(row) {
  if (!row?.override_expires_at) return "Indefinite";
  return fmtDateTime(row.override_expires_at);
}

function isOverrideableRow(row) {
  return !!(row && row.profile_id && row.profile_criteria_id);
}

function getDisplayStatusForRow(item) {
  if (item?.is_overridden) return "OVERRIDDEN";
  return String(item?.status || "").toUpperCase();
}

function getResultBadgeClass(item) {
  const status = getDisplayStatusForRow(item).toLowerCase();
  if (status === "overridden") return "screening-result-overridden";
  return `screening-result-${status}`;
}

function buildOverrideActionsHtml(item) {
  if (!isOverrideableRow(item)) return '<span class="cs-hint">—</span>';

  return `
    <button
      type="button"
      class="screening-override-toggle ${item.is_overridden ? "is-active" : ""}"
      data-override-action="open"
      data-profile-id="${escapeHtml(String(item.profile_id))}"
      data-profile-criteria-id="${escapeHtml(String(item.profile_criteria_id))}"
      data-check="${escapeHtml(item.check)}"
      aria-pressed="${item.is_overridden ? "true" : "false"}"
    >
      <span class="screening-override-dot" aria-hidden="true"></span>
      <span>${item.is_overridden ? "Active" : "Set"}</span>
    </button>
  `;
}

async function refreshScreeningDataForCurrentDot() {
  const dot = CURRENT_DOT;
  if (!dot) return;
  await loadDefaultScreeningResult(dot);
  renderScreeningDetailsModal(screeningResultPayload || {});
}

async function saveScreeningOverride(context) {
  const modeSelect = document.querySelector('input[name="override-duration-mode"]:checked');
  const expiresInput = document.getElementById("override-expires-at");
  const noteInput = document.getElementById("override-note");
  if (!modeSelect || !expiresInput || !noteInput) {
    throw new Error("Override form is not available.");
  }

  const mode = String(modeSelect.value || "").trim().toUpperCase();
  const payload = { mode };
  if (mode === "UNTIL_DATE") {
    const rawDate = String(expiresInput.value || "").trim();
    if (!rawDate) {
      throw new Error("Please choose an expiration date/time.");
    }
    const parsed = new Date(rawDate);
    if (Number.isNaN(parsed.getTime())) {
      throw new Error("Please provide a valid expiration date/time.");
    }
    payload.expires_at = parsed.toISOString();
  }

  const note = String(noteInput.value || "").trim();
  if (note) payload.note = note;

  const response = await fetch(`/api/screening/carriers/${encodeURIComponent(CURRENT_DOT)}/profiles/${encodeURIComponent(context.profile_id)}/criteria/${encodeURIComponent(context.profile_criteria_id)}/override`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body?.error || "Failed to save override");
  }
}

async function removeScreeningOverride(context) {
  const response = await fetch(`/api/screening/carriers/${encodeURIComponent(CURRENT_DOT)}/profiles/${encodeURIComponent(context.profile_id)}/criteria/${encodeURIComponent(context.profile_criteria_id)}/override`, {
    method: "DELETE",
    credentials: "include"
  });

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body?.error || "Failed to remove override");
  }
}

function closeOverrideModal({ force = false } = {}) {
  if (isOverrideSaveInFlight && !force) return;
  const modal = document.getElementById("screening-override-modal");
  if (!modal) return;
  setOverrideModalSavingState(false);
  modal.hidden = true;
  selectedOverrideContext = null;
}

function closeRemoveOverrideConfirmModal(confirmed = false) {
  const modal = document.getElementById("screening-override-remove-confirm-modal");
  if (modal) modal.hidden = true;
  if (removeOverrideConfirmResolver) {
    removeOverrideConfirmResolver(Boolean(confirmed));
    removeOverrideConfirmResolver = null;
  }
}

function confirmRemoveOverride() {
  const modal = document.getElementById("screening-override-remove-confirm-modal");
  if (!modal) return Promise.resolve(false);
  modal.hidden = false;
  return new Promise((resolve) => {
    removeOverrideConfirmResolver = resolve;
  });
}

function setOverrideModalSavingState(isSaving, { action = "save" } = {}) {
  isOverrideSaveInFlight = isSaving === true;
  const modal = document.querySelector("#screening-override-modal .screening-override-modal");
  const saveBtn = document.getElementById("screening-override-save");
  const cancelBtn = document.getElementById("screening-override-cancel");
  const closeBtn = document.getElementById("screening-override-close");
  const removeBtn = document.getElementById("screening-override-remove");
  const statusEl = document.getElementById("screening-override-status");
  if (modal) modal.classList.toggle("is-saving", isOverrideSaveInFlight);
  if (saveBtn) {
    saveBtn.disabled = isOverrideSaveInFlight;
    saveBtn.textContent = isOverrideSaveInFlight
      ? (action === "remove" ? "Removing..." : "Saving...")
      : "Save Override";
  }
  if (cancelBtn) cancelBtn.disabled = isOverrideSaveInFlight;
  if (closeBtn) closeBtn.disabled = isOverrideSaveInFlight;
  if (removeBtn) removeBtn.disabled = isOverrideSaveInFlight;
  if (statusEl) {
    statusEl.textContent = action === "remove" ? "Removing override..." : "Saving override…";
    statusEl.hidden = !isOverrideSaveInFlight;
  }
}

function syncOverrideExpiresVisibility() {
  const modeSelect = document.querySelector('input[name="override-duration-mode"]:checked');
  const expiresWrap = document.getElementById("override-expires-wrap");
  if (!modeSelect || !expiresWrap) return;
  const show = String(modeSelect.value || "").toUpperCase() === "UNTIL_DATE";
  expiresWrap.hidden = !show;
}

function openOverrideModal(context) {
  selectedOverrideContext = context;
  const modal = document.getElementById("screening-override-modal");
  if (!modal) return;

  const profileEl = document.getElementById("override-profile-name");
  const checkEl = document.getElementById("override-check-name");
  const noteEl = document.getElementById("override-note");
  const modeEls = Array.from(document.querySelectorAll('input[name="override-duration-mode"]'));
  const expiresEl = document.getElementById("override-expires-at");
  const activeEl = document.getElementById("override-current-active");
  const removeEl = document.getElementById("screening-override-remove");

  if (profileEl) profileEl.textContent = safeText(context.profile_name, "—");
  if (checkEl) checkEl.textContent = safeText(context.check, "—");
  if (noteEl) noteEl.value = context.override_note || "";
  const nextMode = context.is_overridden && context.override_expires_at ? "UNTIL_DATE" : "INDEFINITE";
  modeEls.forEach((radio) => {
    radio.checked = radio.value === nextMode;
  });
  if (expiresEl) expiresEl.value = context.override_expires_at ? new Date(context.override_expires_at).toISOString().slice(0, 16) : "";
  if (activeEl) activeEl.textContent = context.is_overridden ? `Active override: ${getOverrideExpiresText(context)}` : "No active override";
  if (removeEl) removeEl.hidden = !context.is_overridden;
  setOverrideModalSavingState(false);
  syncOverrideExpiresVisibility();
  modal.hidden = false;
}

function renderScreeningDetailsModal(data) {
  const body = document.getElementById("screening-details-body");
  if (!body) return;

  const profiles = Array.isArray(data?.profiles) ? data.profiles : [];
  if (!profiles.length) {
    body.innerHTML = `<div class="cs-hint">No screening profiles are active yet.</div>`;
    return;
  }

  const defaultProfileId = data?.default_profile_id ?? null;
  const fallbackProfile = profiles.find((p) => p?.is_default) || profiles[0];
  const activeProfile = profiles.find((p) => String(p?.profile_id) === String(selectedScreeningProfileId))
    || profiles.find((p) => String(p?.profile_id) === String(defaultProfileId))
    || fallbackProfile;
  if (!activeProfile) {
    body.innerHTML = `<div class="cs-hint">No screening result.</div>`;
    return;
  }

  selectedScreeningProfileId = activeProfile.profile_id;
  const profileName = safeText(activeProfile.profile_name, "Unnamed profile");
  const result = activeProfile.result || null;
  const status = result?.screening_status ? String(result.screening_status).toUpperCase() : "NOT SCREENED";
  const ratio = getScreeningRatioText(result);
  const details = flattenScreeningDetails(result?.result_summary).map((item) => ({
    ...item,
    profile_id: activeProfile.profile_id,
    profile_name: profileName
  }));
  const tabsHtml = `
    <div class="screening-profile-tabs" role="tablist" aria-label="Screening profiles">
      ${profiles.map((profile) => {
    const isSelected = String(profile.profile_id) === String(activeProfile.profile_id);
    return `
          <button
            type="button"
            class="screening-profile-tab ${isSelected ? "is-active" : ""}"
            data-screening-profile-tab-id="${escapeHtml(String(profile.profile_id))}"
            role="tab"
            aria-selected="${isSelected ? "true" : "false"}"
          >
            ${escapeHtml(safeText(profile.profile_name, "Unnamed profile"))}
          </button>
        `;
  }).join("")}
    </div>
  `;

  const metaHtml = `
    <div class="screening-modal-grid">
      <div class="screening-modal-key">Profile</div><div class="screening-modal-val">${escapeHtml(profileName)}</div>
      <div class="screening-modal-key">Overall status</div><div class="screening-modal-val">${escapeHtml(status)}</div>
      <div class="screening-modal-key">Passed ratio</div><div class="screening-modal-val">${escapeHtml(ratio)}</div>
    </div>
  `;

  if (!details.length) {
    body.innerHTML = `${tabsHtml}${metaHtml}<div class="cs-hint">Detailed screening breakdown is not available yet.</div>`;
    bindScreeningProfileTabClicks();
    return;
  }

  const detailRows = details.map((item) => `
    <div class="screening-detail-row" role="row">
      <div class="screening-detail-cell screening-detail-check" role="cell" data-label="Check">${escapeHtml(item.check)}</div>
      <div class="screening-detail-cell screening-detail-carrier" role="cell" data-label="Carrier">${escapeHtml(item.carrier)}</div>
      <div class="screening-detail-cell screening-detail-requirement" role="cell" data-label="Requirement">${escapeHtml(item.requirement)}</div>
      <div class="screening-detail-cell screening-detail-result" role="cell" data-label="Result">
        <span class="screening-result-badge ${escapeHtml(getResultBadgeClass(item))}">${escapeHtml(getDisplayStatusForRow(item))}</span>
        ${item.is_overridden ? `<div class="screening-override-indicator">Override${item.override_expires_at ? ` until ${escapeHtml(fmtDate(item.override_expires_at))}` : " active"}</div>` : ""}
      </div>
      <div class="screening-detail-cell screening-detail-override" role="cell" data-label="Override">${buildOverrideActionsHtml(item)}</div>
    </div>
  `).join("");

  body.innerHTML = `${tabsHtml}${metaHtml}
    <div class="screening-detail-scroll">
      <div class="screening-detail-list" role="table" aria-label="Screening detail breakdown">
        <div class="screening-detail-header" role="row">
          <div class="screening-detail-head" role="columnheader">Check</div>
          <div class="screening-detail-head" role="columnheader">Carrier</div>
          <div class="screening-detail-head" role="columnheader">Requirement</div>
          <div class="screening-detail-head" role="columnheader">Result</div>
          <div class="screening-detail-head" role="columnheader">Override</div>
        </div>
        ${detailRows}
      </div>
    </div>`;
  bindScreeningProfileTabClicks();
  bindScreeningOverrideActions();
}

function bindScreeningProfileTabClicks() {
  const buttons = document.querySelectorAll("[data-screening-profile-tab-id]");
  buttons.forEach((button) => {
    button.addEventListener("click", () => {
      selectedScreeningProfileId = button.getAttribute("data-screening-profile-tab-id");
      renderScreeningDetailsModal(screeningResultPayload || {});
    });
  });
}

function bindScreeningOverrideActions() {
  const buttons = document.querySelectorAll("[data-override-action]");
  buttons.forEach((button) => {
    button.addEventListener("click", async (event) => {
      event.stopPropagation();
      const action = button.getAttribute("data-override-action");
      const profileId = button.getAttribute("data-profile-id");
      const profileCriteriaId = button.getAttribute("data-profile-criteria-id");
      const check = button.getAttribute("data-check");
      const profile = (screeningResultPayload?.profiles || []).find((item) => String(item.profile_id) === String(profileId));
      const resultSummary = profile?.result?.result_summary || {};
      const row = flattenScreeningDetails(resultSummary).find((item) => String(item.profile_criteria_id) === String(profileCriteriaId));
      const context = {
        profile_id: profileId,
        profile_name: profile?.profile_name || "Unnamed profile",
        profile_criteria_id: profileCriteriaId,
        check: check || row?.check || "",
        is_overridden: row?.is_overridden === true,
        override_expires_at: row?.override_expires_at || null,
        override_note: row?.override_note || null
      };

      if (action === "open") {
        openOverrideModal(context);
        return;
      }

    });
  });
}

function openScreeningModal() {
  const modal = document.getElementById("screening-details-modal");
  if (!modal) return;
  selectedScreeningProfileId = screeningResultPayload?.default_profile_id ?? null;
  renderScreeningDetailsModal(screeningResultPayload || {});
  modal.hidden = false;
}

function closeScreeningModal() {
  const modal = document.getElementById("screening-details-modal");
  if (!modal) return;
  modal.hidden = true;
}

function wireScreeningModalOnce() {
  const card = document.getElementById("screening-summary-card");
  const viewDetails = document.getElementById("screening-view-details");
  const closeBtn = document.getElementById("screening-details-close");
  const dismissBtn = document.getElementById("screening-details-dismiss");
  const backdrop = document.getElementById("screening-details-modal");
  if (!card || !viewDetails || !closeBtn || !dismissBtn || !backdrop) return;

  card.addEventListener("click", () => {
    if (card.hidden) return;
    openScreeningModal();
  });
  card.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      openScreeningModal();
    }
  });

  viewDetails.addEventListener("click", (e) => {
    e.stopPropagation();
    openScreeningModal();
  });
  closeBtn.addEventListener("click", closeScreeningModal);
  dismissBtn.addEventListener("click", closeScreeningModal);
  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) closeScreeningModal();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeScreeningModal();
  });
}

function wireOverrideModalOnce() {
  const modal = document.getElementById("screening-override-modal");
  const removeConfirmModal = document.getElementById("screening-override-remove-confirm-modal");
  const closeBtn = document.getElementById("screening-override-close");
  const cancelBtn = document.getElementById("screening-override-cancel");
  const saveBtn = document.getElementById("screening-override-save");
  const removeBtn = document.getElementById("screening-override-remove");
  const removeConfirmCloseBtn = document.getElementById("screening-override-remove-confirm-close");
  const removeConfirmCancelBtn = document.getElementById("screening-override-remove-confirm-cancel");
  const removeConfirmConfirmBtn = document.getElementById("screening-override-remove-confirm-confirm");
  const modeOptions = document.querySelectorAll('input[name="override-duration-mode"]');
  if (!modal || !closeBtn || !cancelBtn || !saveBtn || !removeBtn || !modeOptions.length) return;

  closeBtn.addEventListener("click", closeOverrideModal);
  cancelBtn.addEventListener("click", closeOverrideModal);
  modeOptions.forEach((option) => {
    option.addEventListener("change", syncOverrideExpiresVisibility);
  });
  modal.addEventListener("click", (e) => {
    if (e.target === modal && !isOverrideSaveInFlight) closeOverrideModal();
  });
  if (removeConfirmModal && removeConfirmCloseBtn && removeConfirmCancelBtn && removeConfirmConfirmBtn) {
    removeConfirmCloseBtn.addEventListener("click", () => closeRemoveOverrideConfirmModal(false));
    removeConfirmCancelBtn.addEventListener("click", () => closeRemoveOverrideConfirmModal(false));
    removeConfirmConfirmBtn.addEventListener("click", () => closeRemoveOverrideConfirmModal(true));
    removeConfirmModal.addEventListener("click", (e) => {
      if (e.target === removeConfirmModal) closeRemoveOverrideConfirmModal(false);
    });
  }

  saveBtn.addEventListener("click", async () => {
    if (!selectedOverrideContext || isOverrideSaveInFlight) return;
    setOverrideModalSavingState(true);
    try {
      await saveScreeningOverride(selectedOverrideContext);
      closeOverrideModal({ force: true });
      await refreshScreeningDataForCurrentDot();
    } catch (err) {
      setOverrideModalSavingState(false);
      alert(err.message || "Failed to save override");
    }
  });

  removeBtn.addEventListener("click", async () => {
    if (isOverrideSaveInFlight) return;
    if (!selectedOverrideContext?.is_overridden) {
      closeOverrideModal();
      return;
    }
const hasCustomRemoveConfirm =
  !!(removeConfirmModal && removeConfirmCloseBtn && removeConfirmCancelBtn && removeConfirmConfirmBtn);

const confirmed = hasCustomRemoveConfirm
  ? await confirmRemoveOverride()
  : window.confirm("Remove this screening override?");

if (!confirmed) return;
    setOverrideModalSavingState(true, { action: "remove" });
    try {
      await removeScreeningOverride(selectedOverrideContext);
      closeOverrideModal({ force: true });
      await refreshScreeningDataForCurrentDot();
    } catch (err) {
      setOverrideModalSavingState(false);
      alert(err.message || "Failed to remove override");
    }
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && removeConfirmModal && !removeConfirmModal.hidden) {
      closeRemoveOverrideConfirmModal(false);
    }
  });
}

function wireInsuranceDeleteModalOnce() {
  const modal = document.getElementById("insurance-delete-confirm-modal");
  const closeBtn = document.getElementById("insurance-delete-confirm-close");
  const cancelBtn = document.getElementById("insurance-delete-confirm-cancel");
  const confirmBtn = document.getElementById("insurance-delete-confirm-confirm");
  if (!modal || !closeBtn || !cancelBtn || !confirmBtn) return;

  closeBtn.addEventListener("click", closeInsuranceDeleteConfirmModal);
  cancelBtn.addEventListener("click", closeInsuranceDeleteConfirmModal);
  confirmBtn.addEventListener("click", confirmDeleteInsuranceCoverage);

  modal.addEventListener("click", (e) => {
    if (e.target === modal) closeInsuranceDeleteConfirmModal();
  });
}

function wireInsuranceDocumentReviewModalOnce() {
  const modal = document.getElementById("insurance-document-review-modal");
  const openBtn = document.getElementById("btn-raise-insurance-document-review");
  const closeBtn = document.getElementById("insurance-document-review-close");
  const cancelBtn = document.getElementById("insurance-document-review-cancel");
  const confirmBtn = document.getElementById("insurance-document-review-confirm");
  if (!modal || !openBtn || !closeBtn || !cancelBtn || !confirmBtn) return;

  openBtn.addEventListener("click", openInsuranceDocumentReviewModal);
  closeBtn.addEventListener("click", closeInsuranceDocumentReviewModal);
  cancelBtn.addEventListener("click", closeInsuranceDocumentReviewModal);
  confirmBtn.addEventListener("click", confirmInsuranceDocumentReviewRaise);

  modal.addEventListener("click", (e) => {
    if (e.target === modal) closeInsuranceDocumentReviewModal();
  });
}

function renderScreeningSummary(data) {
  const card = document.getElementById("screening-summary-card");
  const badge = document.getElementById("screening-status-badge");
  const ratioText = document.getElementById("screening-ratio-text");
  if (!card || !badge || !ratioText) return;

  screeningResultPayload = data || {};
  card.hidden = false;
  card.setAttribute("role", "button");
  card.setAttribute("tabindex", "0");
  const profiles = Array.isArray(data?.profiles) ? data.profiles : [];
  const defaultProfileId = data?.default_profile_id ?? null;
  const defaultProfile = profiles.find((profile) => String(profile?.profile_id) === String(defaultProfileId))
    || profiles.find((profile) => profile?.is_default)
    || null;
  const result = defaultProfile?.result || null;
  const status = result?.screening_status ? String(result.screening_status).toUpperCase() : "NOT SCREENED";
  badge.textContent = status;
  badge.classList.remove("pill-ok", "pill-warn", "pill-purp", "pill-fail");
  const klass = screeningBadgeClass(status);
  if (klass) badge.classList.add(klass);
  ratioText.textContent = getScreeningRatioText(result);
}

async function loadDefaultScreeningResult(dot) {
  const card = document.getElementById("screening-summary-card");
  if (!card || !dot) return;
  try {
    const res = await fetch(`/api/screening/carriers/${encodeURIComponent(dot)}/profile-results`, { credentials: "include" });
    if (!res.ok) throw new Error(`screening failed (${res.status})`);
    const data = await res.json().catch(() => null);
    renderScreeningSummary(data || {});
  } catch (err) {
    console.warn("screening summary unavailable", err);
    screeningResultPayload = null;
    card.hidden = true;
  }
}

function renderRowActionLink({ href, label }) {
  if (!href) return '<span class="cs-hint">—</span>';
  return `<a class="agreements-link" href="${href}" target="_blank" rel="noopener">${label}</a>`;
}

function fmtMoney(amount, currency) {
  if (amount === null || amount === undefined || amount === "") return "—";
  const n = Number(amount);
  if (Number.isNaN(n)) return String(amount);
  try {
    // keep it simple & US-looking (ACORD-style)
    return n.toLocaleString(undefined, { maximumFractionDigits: 0 });
  } catch {
    return String(amount);
  }
}

function setRefreshUi(state, message) {
  const btn = document.getElementById("btn-refresh-carrier");
  const msg = document.getElementById("carrier-refresh-status");

  if (msg) msg.textContent = message || "";

  if (!btn) return;

  if (state === "loading") {
    btn.disabled = true;
    btn.classList.add("is-spinning");
  } else {
    btn.disabled = false;
    btn.classList.remove("is-spinning");
  }
}

// allow a manual click to re-run the “cache_stale retry once” behavior
function clearStaleGuard(dot) {
  const key = `carrier_refetch_${dot}`;
  window[key] = false;
}

  
function getScrollOffset() {
  // If your #site-header is fixed/sticky, this makes landing perfect.
  const header = document.getElementById("site-header");
  const h = header ? header.offsetHeight : 0;

  // add a little breathing room so the section title isn't glued to the top
  return Math.max(72, h + 18);
}

function smoothJumpToId(id) {
  const el = document.getElementById(id);
  if (!el) return;

  const offset = getScrollOffset();
  const y = el.getBoundingClientRect().top + window.scrollY - offset;

  window.scrollTo({ top: y, behavior: "smooth" });
}

function wireQuickJump() {
  const nav = document.querySelector(".quick-jump");
  if (!nav || nav.__wired) return;
  nav.__wired = true;

  // click -> scroll
  nav.addEventListener("click", (e) => {
    const btn = e.target.closest(".quick-jump-link");
    if (!btn) return;

    const id = btn.dataset.jump;
    if (!id) return;

    smoothJumpToId(id);
  });

  // highlight active section (very light)
  const links = Array.from(nav.querySelectorAll(".quick-jump-link"));
  const ids = links.map(b => b.dataset.jump).filter(Boolean);

  const obs = new IntersectionObserver((entries) => {
    // pick the most "visible" entry
    let best = null;
    for (const en of entries) {
      if (!en.isIntersecting) continue;
      if (!best || en.intersectionRatio > best.intersectionRatio) best = en;
    }
    if (!best) return;

    const activeId = best.target.id;
    links.forEach((b) => b.classList.toggle("is-active", b.dataset.jump === activeId));
  }, {
    root: null,
    // start considering a section "active" when it's near the top area
    rootMargin: `-${getScrollOffset()}px 0px -65% 0px`,
    threshold: [0.08, 0.18, 0.28, 0.38]
  });

  ids.forEach((id) => {
    const el = document.getElementById(id);
    if (el) obs.observe(el);
  });
}

  function wireBackToOverview() {
  const btn = document.getElementById("back-to-overview");
  const hero = document.getElementById("carrier-header");
  if (!btn || !hero) return;

  btn.addEventListener("click", () => {
    smoothJumpToId("carrier-header");
  });

  window.addEventListener("scroll", () => {
    const showAfter = 320;
    if (window.scrollY > showAfter) {
      btn.classList.add("is-visible");
    } else {
      btn.classList.remove("is-visible");
    }
  });
}

  
function humanCoverageType(t, raw) {
  const v = (t || "").toUpperCase().trim();
  if (v === "GENERAL_LIABILITY") return "Commercial General Liability";
  if (v === "AUTO_LIABILITY") return "Automobile Liability";
  if (v === "MOTOR_TRUCK_CARGO") return "Motor Truck Cargo";
  // fall back to what you parsed off the PDF if you have it
  return raw || t || "Coverage";
}

function safeText(v) {
  const s = (v ?? "").toString().trim();
  return s ? s : "—";
}

function isCompanyAdminUser(me) {
  // /api/me includes chosen.company_role in src/routes/internal/auth.routes.js.
  const role = String(me?.company_role || me?.user?.company_role || "").trim().toUpperCase();
  return role === "OWNER" || role === "ADMIN";
}

function updateInsuranceDeleteConfirmUi() {
  const confirmBtn = document.getElementById("insurance-delete-confirm-confirm");
  const closeBtn = document.getElementById("insurance-delete-confirm-close");
  const cancelBtn = document.getElementById("insurance-delete-confirm-cancel");

  if (confirmBtn) {
    confirmBtn.disabled = insuranceDeleteInFlight;
    confirmBtn.textContent = insuranceDeleteInFlight ? "Deleting…" : "Delete Coverage";
  }
  if (closeBtn) closeBtn.disabled = insuranceDeleteInFlight;
  if (cancelBtn) cancelBtn.disabled = insuranceDeleteInFlight;
}

function updateInsuranceDocumentReviewButtonVisibility() {
  const btn = document.getElementById("btn-raise-insurance-document-review");
  if (!btn) return;
  btn.hidden = !showAdminInsuranceActions;
}

function updateInsuranceDocumentReviewModalUi() {
  const confirmBtn = document.getElementById("insurance-document-review-confirm");
  const closeBtn = document.getElementById("insurance-document-review-close");
  const cancelBtn = document.getElementById("insurance-document-review-cancel");
  if (!confirmBtn || !closeBtn || !cancelBtn) return;

  confirmBtn.disabled = insuranceRaiseReviewInFlight;
  closeBtn.disabled = insuranceRaiseReviewInFlight;
  cancelBtn.disabled = insuranceRaiseReviewInFlight;
  confirmBtn.textContent = insuranceRaiseReviewCompleted
    ? "Done"
    : (insuranceRaiseReviewInFlight ? "Raising…" : "Raise Exception");
}

function openInsuranceDocumentReviewModal() {
  const modal = document.getElementById("insurance-document-review-modal");
  const errorEl = document.getElementById("insurance-document-review-error");
  const successEl = document.getElementById("insurance-document-review-success");
  if (!modal) return;

  insuranceRaiseReviewInFlight = false;
  insuranceRaiseReviewCompleted = false;

  if (errorEl) {
    errorEl.hidden = true;
    errorEl.textContent = "";
  }
  if (successEl) {
    successEl.hidden = true;
    successEl.textContent = "";
  }

  updateInsuranceDocumentReviewModalUi();
  modal.hidden = false;
}

function closeInsuranceDocumentReviewModal() {
  const modal = document.getElementById("insurance-document-review-modal");
  if (!modal || insuranceRaiseReviewInFlight) return;
  modal.hidden = true;
}

async function confirmInsuranceDocumentReviewRaise() {
  const errorEl = document.getElementById("insurance-document-review-error");
  const successEl = document.getElementById("insurance-document-review-success");
  if (insuranceRaiseReviewInFlight) return;

  if (insuranceRaiseReviewCompleted) {
    closeInsuranceDocumentReviewModal();
    return;
  }

  insuranceRaiseReviewInFlight = true;
  if (errorEl) {
    errorEl.hidden = true;
    errorEl.textContent = "";
  }
  if (successEl) {
    successEl.hidden = true;
    successEl.textContent = "";
  }
  updateInsuranceDocumentReviewModalUi();

  try {
    const res = await fetch(
      `/api/admin/insurance/documents/${encodeURIComponent(CURRENT_DOT)}/raise-document-review`,
      {
        method: "POST",
        credentials: "include",
      }
    );
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data?.ok !== true) {
      throw new Error(data?.error || "Unable to raise a document review exception.");
    }

    insuranceRaiseReviewCompleted = true;
    if (successEl) {
      successEl.textContent = "Document review exception is now OPEN for this insurance document.";
      successEl.hidden = false;
    }
    await loadInsuranceCoverages(CURRENT_DOT);
  } catch (err) {
    if (errorEl) {
      errorEl.textContent = err?.message || "Request failed.";
      errorEl.hidden = false;
    } else {
      alert(err?.message || "Request failed.");
    }
  } finally {
    insuranceRaiseReviewInFlight = false;
    updateInsuranceDocumentReviewModalUi();
  }
}

function openInsuranceDeleteConfirmModal({ coverageId, title }) {
  const modal = document.getElementById("insurance-delete-confirm-modal");
  const titleEl = document.getElementById("insurance-delete-confirm-title");
  const errorEl = document.getElementById("insurance-delete-confirm-error");
  if (!modal || !titleEl) return;

  selectedInsuranceCoverageDelete = {
    coverageId: String(coverageId || "").trim(),
    title: String(title || "").trim() || "this coverage",
  };
  insuranceDeleteInFlight = false;
  titleEl.textContent = `Delete Coverage: ${selectedInsuranceCoverageDelete.title}`;
  if (errorEl) {
    errorEl.hidden = true;
    errorEl.textContent = "";
  }
  updateInsuranceDeleteConfirmUi();
  modal.hidden = false;
}

function closeInsuranceDeleteConfirmModal() {
  const modal = document.getElementById("insurance-delete-confirm-modal");
  if (!modal || insuranceDeleteInFlight) return;
  modal.hidden = true;
  selectedInsuranceCoverageDelete = null;
}

async function confirmDeleteInsuranceCoverage() {
  const errorEl = document.getElementById("insurance-delete-confirm-error");
  if (!selectedInsuranceCoverageDelete?.coverageId || insuranceDeleteInFlight) return;

  insuranceDeleteInFlight = true;
  if (errorEl) {
    errorEl.hidden = true;
    errorEl.textContent = "";
  }
  updateInsuranceDeleteConfirmUi();

  try {
    const coverageId = selectedInsuranceCoverageDelete.coverageId;
    const res = await fetch(`/api/admin/insurance/coverages/${encodeURIComponent(coverageId)}`, {
      method: "DELETE",
      credentials: "include",
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data?.ok !== true) {
      throw new Error(data?.error || "Unable to delete coverage.");
    }

    const modal = document.getElementById("insurance-delete-confirm-modal");
    if (modal) modal.hidden = true;
    selectedInsuranceCoverageDelete = null;
    await loadInsuranceCoverages(CURRENT_DOT);
  } catch (err) {
    if (errorEl) {
      errorEl.textContent = err?.message || "Delete failed.";
      errorEl.hidden = false;
    } else {
      alert(err?.message || "Delete failed.");
    }
  } finally {
    insuranceDeleteInFlight = false;
    updateInsuranceDeleteConfirmUi();
  }
}

function renderInsuranceDocumentOnly(doc, dot) {
  const wrap = document.getElementById("ins-coverages-body");
  if (!wrap) return;
  const canViewDocument = doc?.can_view_document === true;
  const openBtn = canViewDocument
    ? `
            <button class="ins-open-coi" type="button" data-open-ins-doc="${doc.id}">
              View Insurance Certificate
            </button>
      `
    : ``;
  const hintText = canViewDocument
    ? "Open the certificate to view coverage details."
    : "Structured coverage data is available, but the source document is only visible to the company that owns or requested it.";

  wrap.innerHTML = `
    <div class="ins-coverage ins-coverage--doconly">
      <div class="ins-top">
        <div class="ins-title-row">
          <div class="ins-title">Insurance Certificate on File</div>
          <div class="ins-title-actions">
            ${openBtn}
          </div>
        </div>
        <div class="cs-hint" style="margin-top:10px;">
          ${hintText}
        </div>
      </div>
    </div>
  `;

  // Frontend only hides buttons/links; backend must also enforce document access.
  if (!canViewDocument) return;
  wrap.querySelectorAll("[data-open-ins-doc]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      const id = btn.getAttribute("data-open-ins-doc");
      if (!id) return;
      window.open(
        `/api/carriers/${encodeURIComponent(dot)}/insurance-documents/${encodeURIComponent(id)}/pdf`,
        "_blank",
        "noopener"
      );
    });
  });
}

  
  function renderInsuranceCoverages(rows, dot) {
  const wrap = document.getElementById("ins-coverages-body");
  if (!wrap) return;

  if (!Array.isArray(rows) || rows.length === 0) {
    wrap.innerHTML = `<div class="cs-hint">No insurance coverages found.</div>`;
    return;
  }

  // Each row should look like:
  // { id, coverage_type, coverage_type_raw, insurer_name, policy_number, insurer_letter, effective_date, expiration_date,
  //   additional_insured, subrogation_waived, limits: [{ label, currency, amount, ... }] }

  wrap.innerHTML = "";

  rows.forEach((c) => {
    const title = humanCoverageType(c.coverage_type, c.coverage_type_raw);
    const insurer = safeText(c.insurer_name);
    const policy = safeText(c.policy_number);
    const eff = fmtDate(c.effective_date);
    const exp = fmtDate(c.expiration_date);
    const expirationDate = c.expiration_date ? new Date(c.expiration_date) : null;
    const isExpired = expirationDate && expirationDate < new Date();
    const canViewDocument = c.can_view_document === true;
    const openBtn = c.document_id && canViewDocument
      ? `<button class="ins-open-coi" type="button" data-open-ins-doc="${c.document_id}">View Insurance Certificate</button>`
      : ``;
    const deleteBtn = showAdminInsuranceActions && c.id
      ? `<button class="ins-delete-coverage" type="button" data-delete-ins-coverage="${c.id}" data-delete-ins-title="${escapeHtml(title)}">Delete Coverage</button>`
      : ``;
    const privateHint = c.document_id && !canViewDocument
      ? `<div class="cs-hint" style="margin-top:10px;">Source certificate is private to the company that uploaded or requested it.</div>`
      : ``;

    const addl = (c.additional_insured || "").toString().trim();
    const subr = (c.subrogation_waived || "").toString().trim();

    const flags = []
      .concat(addl ? [`<span class="ins-flag">ADDL INSD: ${addl}</span>`] : [])
      .concat(subr ? [`<span class="ins-flag">SUBR WVD: ${subr}</span>`] : [])
      .join("");

    const limits = Array.isArray(c.limits) ? c.limits : [];

    const limitsHtml = limits.length
      ? `
        <div class="ins-limits">
          ${limits.map((l) => {
            const label = safeText(l.label);

            //New Amount
            const splitA = Number(l.amount_primary || 0);
            const splitB = Number(l.amount_secondary || 0);
            
            const value =
              (l.value_text && String(l.value_text).trim()) ||
              (l.amount_text && String(l.amount_text).trim()) ||
              (splitA > 0 || splitB > 0
                ? [
                    splitA > 0 ? fmtMoney(splitA, l.currency) : null,
                    splitB > 0 ? fmtMoney(splitB, l.currency) : null
                  ].filter(Boolean).join(" / ")
                : (l.amount != null ? fmtMoney(l.amount, l.currency) : "—"));

            return `
              <div class="ins-limit-row">
                <div class="ins-limit-label">${label}</div>
                <div class="ins-limit-value">${value}</div>
              </div>
            `;
          }).join("")}
        </div>
      `
      : `<div class="cs-hint">No limits parsed.</div>`;

    const card = document.createElement("div");
    card.className = `ins-coverage ${isExpired ? "ins-coverage--expired" : ""}`;

    card.innerHTML = `
      <div class="ins-top">
        <div class="ins-title-row">
          <div class="ins-title-wrap">
            <div class="ins-title">${title}</div>
            ${isExpired ? `<span class="ins-expired-badge">Expired</span>` : ``}
          </div>
          <div class="ins-title-actions">
              ${openBtn}
              ${deleteBtn}
          </div>
        </div>

        <div class="ins-meta">
          <div class="ins-meta-row"><span class="ins-k">Insurer</span><span class="ins-v">${insurer}</span></div>
          <div class="ins-meta-row"><span class="ins-k">Policy</span><span class="ins-v">${policy}</span></div>
          <div class="ins-meta-row"><span class="ins-k">Effective</span><span class="ins-v">${eff}</span></div>
          <div class="ins-meta-row"><span class="ins-k">Expires</span><span class="ins-v">${exp}</span></div>
        </div>

        ${flags ? `<div class="ins-flags">${flags}</div>` : ``}
        ${privateHint}
      </div>

      <div class="ins-divider"></div>

      ${limitsHtml}
    `;

    wrap.appendChild(card);
  });
    // Frontend only hides buttons/links; backend must also enforce document access.
    wrap.querySelectorAll("[data-open-ins-doc]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        const id = btn.getAttribute("data-open-ins-doc");
        if (!id) return;
        window.open(
          `/api/carriers/${encodeURIComponent(dot)}/insurance-documents/${encodeURIComponent(id)}/pdf`,
          "_blank",
          "noopener"
        );
      });
    });

    wrap.querySelectorAll("[data-delete-ins-coverage]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        if (!showAdminInsuranceActions || insuranceDeleteInFlight) return;
        const coverageId = btn.getAttribute("data-delete-ins-coverage");
        const title = btn.getAttribute("data-delete-ins-title") || "Coverage";
        if (!coverageId) return;
        openInsuranceDeleteConfirmModal({ coverageId, title });
      });
    });
}

async function loadInsuranceCoverages(dot) {
  const wrap = document.getElementById("ins-coverages-body");
  if (wrap) wrap.innerHTML = `<div class="cs-hint">Loading…</div>`;

  try {
    const res = await fetch(`/api/carriers/${encodeURIComponent(dot)}/insurance-coverages`);
    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      if (wrap) wrap.innerHTML = `<div class="cs-hint">Unable to load coverages.</div>`;
      console.warn("insurance coverages failed", res.status, data);
      return;
    }

    const mode = (data.mode || "").toUpperCase();
    const rows = Array.isArray(data.rows) ? data.rows : [];
    const doc = data.document || null;
    
    if (mode === "STRUCTURED") {
      renderInsuranceCoverages(rows, dot);
      return;
    }
    
    if (mode === "ON_FILE" && doc?.id) {
      renderInsuranceDocumentOnly(doc, dot);
      return;
    }
    
    // default: missing / unknown
    renderInsuranceCoverages([], dot);
  } catch (e) {
    console.error("insurance coverages error", e);
    if (wrap) wrap.innerHTML = `<div class="cs-hint">Unable to load coverages.</div>`;
  }
}



  function normalizeRating(r) {
    const val = (r || "").toString().trim().toUpperCase();
    if (!val) return "Not Rated";
    if (val === "C") return "Conditional";
    if (val === "S") return "Satisfactory";
    if (val === "U") return "Unsatisfactory";
    return "Not Rated";
  }

  function authorityText(code) {
    const v = (code || "").toString().trim().toUpperCase();
    if (v === "A") return "Active";
    if (v === "I") return "Interstate";
    return "—";
  }

// ----------------------------
// SEND CONTRACT MODAL HELPERS
// ----------------------------
function showSendContractModal() {
  const el = document.getElementById("send-contract-modal");
  if (el) el.hidden = false;
  document.body.style.overflow = "hidden";
}

function hideSendContractModal() {
  const el = document.getElementById("send-contract-modal");
  if (el) el.hidden = true;
  document.body.style.overflow = "";
}


  // ----------------------------
  // EMAIL ALERTS MODAL HELPERS
  // ----------------------------
  function showEmailModal() {
    const el = document.getElementById("email-alerts-modal");
    if (el) el.hidden = false;
    document.body.style.overflow = "hidden";
  }

  function hideEmailModal() {
    const el = document.getElementById("email-alerts-modal");
    if (el) el.hidden = true;
    document.body.style.overflow = "";
  }

function setEmailAlertPill(enabled) {
  const pill = document.getElementById("btn-email-alerts");
  if (!pill) return;

  // ✅ If the iOS switch exists (your real UI), update it
  const ios = pill.querySelector(".ios-switch");
  if (ios) {
    ios.classList.toggle("on", enabled === true);
    ios.classList.toggle("off", enabled === false);

    // optional: unknown state (if you ever use it)
    ios.classList.toggle("unknown", enabled == null);

    // store state if you want for CSS hooks
    pill.dataset.enabled = enabled === true ? "on" : enabled === false ? "off" : "unknown";
    return;
  }

  // -------- fallback (only if you ever render a different pill elsewhere) --------
  pill.dataset.enabled = enabled === true ? "on" : enabled === false ? "off" : "unknown";
}



  
  function wireEmailModalOnce() {
  if (window.__emailModalWired) return;
  window.__emailModalWired = true;

  document.getElementById("email-alerts-close")?.addEventListener("click", hideEmailModal);
  document.getElementById("email-alerts-cancel")?.addEventListener("click", hideEmailModal);

  document.getElementById("email-alerts-save")?.addEventListener("click", async () => {
  const dot = CURRENT_DOT;
  const enabled = !!document.getElementById("email-alerts-enabled")?.checked;     
    
      // pull recipients from state (chips)
      const recipients = Array.isArray(EMAIL_ALERTS_STATE?.recipients)
        ? EMAIL_ALERTS_STATE.recipients
        : [];
      
      const res = await fetch(`/api/my-carriers/${encodeURIComponent(dot)}/alerts/email`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled, recipients })
      });

  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    alert(body.error || "Failed to save email alerts.");
    return;
  }

  // update pill text immediately
  setEmailAlertPill(enabled);

  hideEmailModal();
});


  document.getElementById("email-alerts-modal")?.addEventListener("click", (e) => {
    if (e.target && e.target.id === "email-alerts-modal") hideEmailModal();
  });
}

// ----- Email Alerts modal state (chips) -----
let EMAIL_ALERTS_STATE = {
  dot: null,
  enabled: false,
  recipients: [] // normalized lowercase
};

function normalizeEmail(v) {
  return String(v || "").trim().toLowerCase();
}

function isValidEmail(v) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
}

function renderEmailChips() {
  const wrap = document.getElementById("email-alerts-chips");
  if (!wrap) return;

  wrap.innerHTML = "";

  if (!EMAIL_ALERTS_STATE.recipients.length) {
    const empty = document.createElement("div");
    empty.className = "cs-hint";
    empty.textContent = "No recipients yet. Add one below.";
    wrap.appendChild(empty);
    return;
  }

  EMAIL_ALERTS_STATE.recipients.forEach((email) => {
    const chip = document.createElement("span");
    chip.className = "cs-chip";

    const label = document.createElement("span");
    label.textContent = email;

    const x = document.createElement("button");
    x.type = "button";
    x.className = "cs-chip-x";
    x.textContent = "×";
    x.addEventListener("click", () => {
      EMAIL_ALERTS_STATE.recipients = EMAIL_ALERTS_STATE.recipients.filter(e => e !== email);
      renderEmailChips();
    });

    chip.appendChild(label);
    chip.appendChild(x);
    wrap.appendChild(chip);
  });
}

function bindEmailAlertsUIOnce() {
  if (window.__emailRecipientsWired) return;
  window.__emailRecipientsWired = true;

  const enabledEl = document.getElementById("email-alerts-enabled");
  const inputEl = document.getElementById("email-alerts-input");
  const addBtn = document.getElementById("email-alerts-add");

  enabledEl?.addEventListener("change", () => {
    EMAIL_ALERTS_STATE.enabled = !!enabledEl.checked;
  });

  function addFromInput() {
    const raw = normalizeEmail(inputEl?.value);
    if (!raw) return;

    if (!isValidEmail(raw)) {
      alert("Please enter a valid email address.");
      inputEl?.focus();
      return;
    }

    if (!EMAIL_ALERTS_STATE.recipients.includes(raw)) {
      EMAIL_ALERTS_STATE.recipients.push(raw);
      EMAIL_ALERTS_STATE.recipients.sort();
      renderEmailChips();
    }

    if (inputEl) inputEl.value = "";
    inputEl?.focus();
  }

  addBtn?.addEventListener("click", addFromInput);

  inputEl?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      addFromInput();
    }
  });
}

async function openEmailAlertsModal(dot) {
  bindEmailAlertsUIOnce();

  EMAIL_ALERTS_STATE = {
    dot: String(dot || "").trim(),
    enabled: false,
    recipients: []
  };

  let data = null;
  try {
    const res = await fetch(`/api/my-carriers/${encodeURIComponent(dot)}/alerts/email`);
    if (res.ok) data = await res.json();
  } catch {}

  const enabledEl = document.getElementById("email-alerts-enabled");

  EMAIL_ALERTS_STATE.enabled = !!data?.enabled;
  if (enabledEl) enabledEl.checked = EMAIL_ALERTS_STATE.enabled;

  const defaultEmail = normalizeEmail(data?.defaultEmail);
  const extras = Array.isArray(data?.recipients) ? data.recipients.map(normalizeEmail) : [];

  EMAIL_ALERTS_STATE.recipients = [...new Set(
    []
      .concat(defaultEmail ? [defaultEmail] : [])
      .concat(extras)
      .filter(Boolean)
  )];

  renderEmailChips();
  showEmailModal();
}


let SEND_CONTRACT_STATE = {
  dot: null,
  defaultEmail: "",      // locked
  recipients: [],        // extras (removable)
  user_contract_id: "",  // required by backend
  carrier_name: ""       // NEW
};

function renderSendContractDefaultChip() {
  const wrap = document.getElementById("send-contract-default-chip");
  if (!wrap) return;

  wrap.innerHTML = "";

  const email = normalizeEmail(SEND_CONTRACT_STATE.defaultEmail);
  if (!email) {
    const empty = document.createElement("div");
    empty.className = "cs-hint";
    empty.textContent = "No FMCSA contact email found for this carrier.";
    wrap.appendChild(empty);
    return;
  }

  const chip = document.createElement("span");
  chip.className = "cs-chip";

  const label = document.createElement("span");
  label.textContent = email;

  // locked: no X
  chip.appendChild(label);
  wrap.appendChild(chip);
}

function renderSendContractChips() {
  const wrap = document.getElementById("send-contract-chips");
  if (!wrap) return;

  wrap.innerHTML = "";

  if (!SEND_CONTRACT_STATE.recipients.length) {
    const empty = document.createElement("div");
    empty.className = "cs-hint";
    empty.textContent = "No additional recipients yet. Add one below.";
    wrap.appendChild(empty);
    return;
  }

  SEND_CONTRACT_STATE.recipients.forEach((email) => {
    const chip = document.createElement("span");
    chip.className = "cs-chip";

    const label = document.createElement("span");
    label.textContent = email;

    const x = document.createElement("button");
    x.type = "button";
    x.className = "cs-chip-x";
    x.textContent = "×";
    x.addEventListener("click", () => {
      SEND_CONTRACT_STATE.recipients = SEND_CONTRACT_STATE.recipients.filter(e => e !== email);
      renderSendContractChips();
    });

    chip.appendChild(label);
    chip.appendChild(x);
    wrap.appendChild(chip);
  });
}

function wireSendContractModalOnce() {
  if (window.__sendContractModalWired) return;
  window.__sendContractModalWired = true;

  document.getElementById("send-contract-close")?.addEventListener("click", hideSendContractModal);
  document.getElementById("send-contract-cancel")?.addEventListener("click", hideSendContractModal);

  document.getElementById("send-contract-modal")?.addEventListener("click", (e) => {
    if (e.target && e.target.id === "send-contract-modal") hideSendContractModal();
  });

  // Add recipient behavior
  const inputEl = document.getElementById("send-contract-input");
  const addBtn = document.getElementById("send-contract-add");

  function addFromInput() {
    const raw = normalizeEmail(inputEl?.value);
    if (!raw) return;

    if (!isValidEmail(raw)) {
      alert("Please enter a valid email address.");
      inputEl?.focus();
      return;
    }

    // Prevent duplicates and prevent adding the locked default as an "extra"
    const def = normalizeEmail(SEND_CONTRACT_STATE.defaultEmail);
    if (raw === def) {
      if (inputEl) inputEl.value = "";
      return;
    }

    if (!SEND_CONTRACT_STATE.recipients.includes(raw)) {
      SEND_CONTRACT_STATE.recipients.push(raw);
      SEND_CONTRACT_STATE.recipients.sort();
      renderSendContractChips();
    }

    if (inputEl) inputEl.value = "";
    inputEl?.focus();
  }

  addBtn?.addEventListener("click", addFromInput);
  inputEl?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      addFromInput();
    }
  });

  // SEND button
  document.getElementById("send-contract-send")?.addEventListener("click", async () => {
    const dot = SEND_CONTRACT_STATE.dot;
    const templateId = SEND_CONTRACT_STATE.user_contract_id;
    const defaultEmail = normalizeEmail(SEND_CONTRACT_STATE.defaultEmail);

    if (!dot) return alert("Missing DOT.");
    if (!templateId) return alert("Please select a contract template.");
    if (!defaultEmail) return alert("No FMCSA contact email found for this carrier.");

    // backend expects email_to (string). We'll send comma-separated list.
    const allRecipients = [defaultEmail].concat(SEND_CONTRACT_STATE.recipients || []);
    const email_to = allRecipients.join(", ");

    const res = await fetch(`/api/contracts/send/${encodeURIComponent(dot)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
      user_contract_id: templateId,
      email_to,
      carrier_name: SEND_CONTRACT_STATE.carrier_name || ""
    })
    });

    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      alert(body.error || "Failed to send contract.");
      return;
    }

    hideSendContractModal();
    openContractSuccessModal();
  });
}

async function openSendContractModal(dot, carrierObj) {
  // ensure modal is wired
  wireSendContractModalOnce();

  // ✅ For now: only use carriers.email_address
// Later you can expand this to FMCSA contact fields if you add them.
const guessedDefault = carrierObj?.email_address || "";

const carrierName =
  (carrierObj?.legalname || carrierObj?.dbaname || "").toString().trim();

// --- FUTURE (optional) --- FUUU TURREE FUUUU TURRREEE
// If you later add FMCSA fields or parse from FMCSA API, you can do:
// const guessedDefault =
//   carrierObj?.email_address ||
//   carrierObj?.fmcsa_email ||
//   carrierObj?.fmcsa_contact_email ||
//   carrierObj?.contact_email ||
//   "";

  SEND_CONTRACT_STATE = {
    dot: String(dot || "").trim(),
    defaultEmail: guessedDefault,
    recipients: [],
    user_contract_id: "",
    carrier_name: carrierName
  };

  // Load templates
  const sel = document.getElementById("send-contract-template");
  if (sel) {
    sel.innerHTML = `<option value="">Loading…</option>`;
  }

  try {
    const r = await fetch("/api/user-contracts");
    const data = r.ok ? await r.json() : null;
    const rows = Array.isArray(data?.rows) ? data.rows : [];

    if (!sel) return;

    if (!rows.length) {
      sel.innerHTML = `<option value="">No templates found</option>`;
      SEND_CONTRACT_STATE.user_contract_id = "";
    } else {
      sel.innerHTML = `<option value="">Select a template…</option>` + rows.map((t) => {
        const label = `${t.name || "Contract"}${t.version ? " v" + t.version : ""}`;
        return `<option value="${t.id}">${label}</option>`;
      }).join("");

      // default to most recent template (first row based on your ORDER BY created_at DESC)
      sel.value = rows[0].id;
      SEND_CONTRACT_STATE.user_contract_id = rows[0].id;
    }

    sel.onchange = () => {
      SEND_CONTRACT_STATE.user_contract_id = sel.value || "";
    };

  } catch (e) {
    if (sel) sel.innerHTML = `<option value="">Failed to load templates</option>`;
  }

  renderSendContractDefaultChip();
  renderSendContractChips();
  showSendContractModal();
}

  async function manualRefresh(dot) {
  // show spinner + "Checking..."
  setRefreshUi("loading", "Checking…");

  // capture what the page currently shows as "Last Verified"
  const before =
    document.getElementById("field-retrieval_date_formatted")?.textContent?.trim() || "";

  try {
    // 🔥 NEW: trigger backend refresh (your step 1 route)
    await fetch(`/api/carriers/${encodeURIComponent(dot)}/refresh`, {
      method: "POST"
    });

    // now poll your existing GET a few times to see if "Last Verified" changes
    const start = Date.now();
    while (Date.now() - start < 10000) {
      await new Promise((r) => setTimeout(r, 1200));

      const res = await fetch(`/api/carriers/${encodeURIComponent(dot)}`);
      const data = await res.json().catch(() => ({}));
      const c = data && data.carrier ? data.carrier : data;

      const after = (c?.retrieval_date_formatted || "").trim();

      if (after && after !== before) {
        // ✅ updated — re-render the whole page using your existing code
        await loadCarrier({ manual: true });
        return;
      }
    }

    // nothing changed
    setRefreshUi("idle", "No changes found");
    setTimeout(() => setRefreshUi("idle", ""), 2200);
  } catch (e) {
    setRefreshUi("idle", "Couldn’t refresh");
    setTimeout(() => setRefreshUi("idle", ""), 2200);
  }
}


  // Load Carrier Stuff

  async function loadCarrier(opts = {}) {
    const dot = CURRENT_DOT;
    if (!dot) return;

      if (opts.manual === true) {
        clearStaleGuard(dot);
        setRefreshUi("loading", "Refreshing…");
      }

    try {
      const res = await fetch("/api/carriers/" + encodeURIComponent(dot));

      if (!res.ok) {
        console.error("Carrier fetch failed:", res.status, await res.text());
        const nameEl = document.getElementById("carrier-name");
        const dotEl = document.getElementById("carrier-dot");
        if (nameEl) nameEl.textContent = "Carrier not found";
        if (dotEl) dotEl.textContent = dot;
        return;
      }

const data = await res.json();

// support both old and new response shapes
const c = data && data.carrier ? data.carrier : data;
window.__carrierProfile = c;

      
// if backend returned stale data, re-fetch once after background refresh
if (data && data.source === "cache_stale") {
  const key = `carrier_refetch_${dot}`;
  if (!window[key]) {
    window[key] = true;
    setTimeout(() => loadCarrier(), 1300);
  }
}


      // Header
      const name = (c.legalname || c.dbaname || `Carrier ${c.dotnumber || ""}`).trim();
      setText("carrier-name", name);
      setText("carrier-dot", c.dotnumber);
      setCarrierMcDisplay(c);
      setText("carrier-ein", c.ein);

      const addr = [c.phystreet].filter(Boolean).join(", ");
      setText("carrier-address", addr);

      const loc = [c.phycity, c.phystate, c.phycountry].filter(Boolean).join(", ");
      setText("carrier-location", loc);

      setText("carrier-zip", c.phyzipcode);

      // Status pills
      const statusText =
        c.statuscode === "A" ? "Active" :
        c.statuscode === "I" ? "Inactive" :
        "None";

      const allowedText =
        (c.allowedtooperate || "").toString().toUpperCase() === "Y"
          ? "Authorized"
          : "Not Authorized";

      const commonText = authorityText(c.commonauthoritystatus);
      const contractText = authorityText(c.contractauthoritystatus);
      const brokerText = authorityText(c.brokerauthoritystatus);

      const safetyRatingText = normalizeRating(c.safetyrating);

      // Body: replace codes with friendly values
      setText("field-commonauthoritystatus", commonText);
      setText("field-contractauthoritystatus", contractText);
      setText("field-brokerauthoritystatus", brokerText);
      setText("field-safetyrating", safetyRatingText);

      // Pill labels
      const statusEl = document.getElementById("carrier-status");
      const allowedEl = document.getElementById("carrier-allowed");
      const commonEl = document.getElementById("carrier-commonauthoritystatus");
      const contractEl = document.getElementById("carrier-contractauthoritystatus");
      const brokerEl = document.getElementById("carrier-brokerauthoritystatus");
      const safetyEl = document.getElementById("carrier-safetyrating");

      if (statusEl) statusEl.textContent = `STATUS: ${statusText}`;
      if (allowedEl) allowedEl.textContent = `OPERATING STATUS: ${allowedText}`;
      if (commonEl) commonEl.textContent = `COMMON AUTHORITY: ${commonText}`;
      if (contractEl) contractEl.textContent = `CONTRACT AUTHORITY: ${contractText}`;
      if (brokerEl) brokerEl.textContent = `BROKER AUTHORITY: ${brokerText}`;
      if (safetyEl) safetyEl.textContent = `Safety Rating: ${safetyRatingText}`;

      // Pill colors
      if (statusEl) {
        statusEl.classList.add(
          (c.statuscode || "").toString().toUpperCase() === "A" ? "pill-ok" : "pill-warn"
        );
      }

      if (allowedEl) {
        allowedEl.classList.add(
          (c.allowedtooperate || "").toString().toUpperCase() === "Y" ? "pill-ok" : "pill-warn"
        );
      }

      const authPill = (el, raw) => {
        if (!el) return;
        const v = (raw || "").toString().toUpperCase();
        if (v === "A") el.classList.add("pill-ok");
        else if (v === "I") el.classList.add("pill-purp");
      };

      authPill(commonEl, c.commonauthoritystatus);
      authPill(contractEl, c.contractauthoritystatus);
      authPill(brokerEl, c.brokerauthoritystatus);

      // Header meta
      setText("carrier-legalname", c.legalname);
      setText("carrier-dbaname", c.dbaname);
      setText("field-snapshotdate", c.snapshotdate);
      setText("field-issscore", c.issscore);
      setText("field-mcs150outdated", c.mcs150outdated);

      // Basics & meta
      setText("field-retrieval_date_formatted", c.retrieval_date_formatted);
      setText("field-statuscode", c.statuscode);
      setText("field-reviewdate", c.reviewdate);
      setText("field-reviewtype", c.reviewtype);
      setText("field-safetyratingdate", c.safetyratingdate);
      setText("field-safetyreviewdate", c.safetyreviewdate);
      setText("field-safetyreviewtype", c.safetyreviewtype);
      setText("field-oosdate", c.oosdate);
      setText("field-oosratenationalaverageyear", c.oosratenationalaverageyear);

      // Operations & authority (raw details)
      setText("field-carrieroperation_carrieroperationcode", c.carrieroperation_carrieroperationcode);
      setText("field-carrieroperation_carrieroperationdesc", c.carrieroperation_carrieroperationdesc);
      setText("field-censustypeid_censustype", c.censustypeid_censustype);
      setText("field-censustypeid_censustypedesc", c.censustypeid_censustypedesc);
      setText("field-censustypeid_censustypeid", c.censustypeid_censustypeid);
      setText("field-ispassengercarrier", c.ispassengercarrier);

      // Insurance & financial
      setText("field-bipdinsuranceonfile", c.bipdinsuranceonfile);
      setText("field-bipdinsurancerequired", c.bipdinsurancerequired);
      setText("field-bipdrequiredamount", c.bipdrequiredamount);
      setText("field-bondinsuranceonfile", c.bondinsuranceonfile);
      setText("field-bondinsurancerequired", c.bondinsurancerequired);
      setText("field-cargoinsuranceonfile", c.cargoinsuranceonfile);
      setText("field-cargoinsurancerequired", c.cargoinsurancerequired);
      setText("field-allowedtooperate", c.allowedtooperate);
      setText("field-ein", c.ein);

      // Crashes
      setText("field-crashtotal", c.crashtotal);
      setText("field-fatalcrash", c.fatalcrash);
      setText("field-injcrash", c.injcrash);
      setText("field-towawaycrash", c.towawaycrash);

      // Inspections & OOS
      setText("field-driverinsp", c.driverinsp);
      setText("field-driveroosinsp", c.driveroosinsp);
      setText("field-driveroosrate", c.driveroosrate);
      setText("field-driveroosratenationalaverage", c.driveroosratenationalaverage);

      setText("field-hazmatinsp", c.hazmatinsp);
      setText("field-hazmatoosinsp", c.hazmatoosinsp);
      setText("field-hazmatoosrate", c.hazmatoosrate);
      setText("field-hazmatoosratenationalaverage", c.hazmatoosratenationalaverage);

      setText("field-vehicleinsp", c.vehicleinsp);
      setText("field-vehicleoosinsp", c.vehicleoosinsp);
      setText("field-vehicleoosrate", c.vehicleoosrate);
      setText("field-vehicleoosratenationalaverage", c.vehicleoosratenationalaverage);

      setText("field-totaldrivers", c.totaldrivers);
      setText("field-totalpowerunits", c.totalpowerunits);

      // Counts & flags (dup view)
      setText("field-statuscode-dup", c.statuscode);
      setText("field-mcs150outdated-dup", c.mcs150outdated);
      setText("field-snapshotdate-dup", c.snapshotdate);

      // FMCSA links
      setLink("field-link_basics", c.link_basics);
      setLink("field-link_cargo_carried", c.link_cargo_carried);
      setLink("field-link_operation_classification", c.link_operation_classification);
      setLink("field-link_docket_numbers", c.link_docket_numbers);
      setLink("field-link_active_for_hire", c.link_active_for_hire);
      setLink("field-link_self", c.link_self);

      // Cargo carried
      const cargoListEl = document.getElementById("cargo-list");
      if (cargoListEl) {
        if (Array.isArray(c.cargo_carried) && c.cargo_carried.length > 0) {
          cargoListEl.innerHTML = "";
          c.cargo_carried.forEach((desc) => {
            if (!desc) return;
            const li = document.createElement("li");
            li.textContent = desc;
            cargoListEl.appendChild(li);
          });
        } else {
          cargoListEl.innerHTML = "<li>—</li>";
        }
      }

      const me = await getMe();
      showAdminInsuranceActions = isCompanyAdminUser(me);
      updateInsuranceDocumentReviewButtonVisibility();
      applyInsuranceLock(me);
      if (me) {
        await loadDefaultScreeningResult(dot);
      } else {
        const screeningCard = document.getElementById("screening-summary-card");
        screeningResultPayload = null;
        closeScreeningModal();
        if (screeningCard) screeningCard.hidden = true;
      }
      
      // Only load insurance if unlocked (optional)
      if (me?.view_insurance === true) {
        await loadInsuranceCoverages(dot);
      } else {
      const wrap = document.getElementById("ins-coverages-body");
      if (wrap) wrap.innerHTML = `<div class="cs-hint">—</div>`;
    }
      
      await loadCarrierAgreements(dot);
      await loadCarrierDocuments(dot);
      if (opts.manual === true) {
        setRefreshUi("idle", "Updated just now");
        setTimeout(() => setRefreshUi("idle", ""), 2200);
      }


      // Buttons
      await initCarrierButtons(dot);
    } catch (err) {
      console.error("Error fetching carrier:", err);
      if (opts.manual === true) {
        setRefreshUi("idle", "Couldn’t refresh");
        setTimeout(() => setRefreshUi("idle", ""), 2200);
      }
      const nameEl = document.getElementById("carrier-name");
      if (nameEl) nameEl.textContent = "Error loading carrier";
    }
  }

  function formatUploadedBy(doc) {
    const role = String(doc?.uploaded_by_role || doc?.source || "carrier").trim().toLowerCase();
    if (role === "user") {
      const name = String(doc?.uploaded_by_name || "").trim();
      const email = String(doc?.uploaded_by_email || "").trim();
      return name || email || "User";
    }
    if (role === "system") return "System";
    return "Carrier";
  }

  async function loadCarrierDocuments(dot) {
  const wrap = document.getElementById("carrier-documents");
  const summaryEl = document.getElementById("documents-summary-status");
  const typeSummaryEl = document.getElementById("documents-type-summary");
  const tableBodyEl = document.getElementById("documents-table-body");
  const mobileListEl = document.getElementById("documents-mobile-list");
  const emptyEl = document.getElementById("documents-empty");

  if (!wrap || !summaryEl || !typeSummaryEl || !tableBodyEl || !mobileListEl || !emptyEl) return;

  wrap.hidden = true;
  summaryEl.textContent = "No documents on file";
  typeSummaryEl.innerHTML = "";
  tableBodyEl.innerHTML = "";
  mobileListEl.innerHTML = "";
  emptyEl.classList.remove("is-visible");

  try {
    const res = await fetch(`/api/carrier-documents/${encodeURIComponent(dot)}`, { credentials: "include" });
    if (!res.ok) throw new Error(`carrier documents request failed (${res.status})`);

    const data = await res.json().catch(() => null);
    const docs = Array.isArray(data?.documents) ? data.documents : [];
    const counts = data?.counts || {};
    const w9Count = Number(counts?.w9 ?? docs.filter((d) => d.type === "W-9").length);
    const achCount = Number(counts?.ach ?? docs.filter((d) => d.type === "ACH").length);
    const otherCount = Number(counts?.other ?? docs.filter((d) => d.type === "Other").length);
    const total = Number(data?.count ?? docs.length);

    typeSummaryEl.innerHTML = [
      `<span class="docs-summary-chip">W-9: ${w9Count} Document${w9Count === 1 ? "" : "s"} On File</span>`,
      `<span class="docs-summary-chip">ACH: ${achCount} Document${achCount === 1 ? "" : "s"} On File</span>`,
      `<span class="docs-summary-chip">Other: ${otherCount} Document${otherCount === 1 ? "" : "s"} On File</span>`,
    ].join("");

    if (docs.length > 0) {
      tableBodyEl.innerHTML = docs.map((doc) => {
        const canViewDocument = doc?.can_view_document === true;
        const actions = [
          // Frontend only hides buttons/links; backend must also enforce document access.
          canViewDocument
            ? renderRowActionLink({ href: doc.pdf_url, label: "View" })
            : `<span class="cs-hint">Private</span>`,
        ];
        if (doc.certificate_url) {
          actions.push(renderRowActionLink({ href: doc.certificate_url, label: "Certificate" }));
        }
        return `
          <tr>
            <td>${safeText(doc.type)}</td>
            <td>${safeText(doc.original_filename)}</td>
            <td>${fmtDateTime(doc.uploaded_at || doc.created_at)}</td>
            <td>${safeText(formatUploadedBy(doc))}</td>
            <td>${safeText(doc.mime_type)}</td>
            <td><div class="docs-row-actions">${actions.join("")}</div></td>
          </tr>
        `;
      }).join("");

      mobileListEl.innerHTML = docs.map((doc) => {
        const canViewDocument = doc?.can_view_document === true;
        const actions = [
          // Frontend only hides buttons/links; backend must also enforce document access.
          canViewDocument
            ? renderRowActionLink({ href: doc.pdf_url, label: "View Document" })
            : `<span class="cs-hint">Private</span>`,
        ];
        if (doc.certificate_url) {
          actions.push(renderRowActionLink({ href: doc.certificate_url, label: "Certificate" }));
        }
        return `
          <article class="docs-mobile-card">
            <div class="docs-mobile-title">${safeText(doc.type)}</div>
            <div class="docs-mobile-subtitle">${safeText(doc.original_filename)}</div>
            <div class="docs-mobile-meta">Uploaded: ${fmtDateTime(doc.uploaded_at || doc.created_at)}</div>
            <div class="docs-mobile-meta">By: ${safeText(formatUploadedBy(doc))}</div>
            <div class="docs-row-actions docs-mobile-actions">${actions.join("")}</div>
          </article>
        `;
      }).join("");
    } else {
      emptyEl.classList.add("is-visible");
    }

    summaryEl.textContent = total > 0
      ? `${total} Document${total === 1 ? "" : "s"} On File`
      : "No documents on file";
    wrap.hidden = false;
  } catch (err) {
    console.error("carrier documents load failed", err);
    wrap.hidden = false;
    emptyEl.classList.add("is-visible");
  }
}


async function loadCarrierAgreements(dot) {
  const wrap = document.getElementById("carrier-agreements");
  const statusEl = document.getElementById("agreements-status");
  const metaEl = document.getElementById("agreements-summary-meta");
  const tableBodyEl = document.getElementById("agreements-table-body");
  const mobileListEl = document.getElementById("agreements-mobile-list");
  const emptyEl = document.getElementById("agreements-empty");

  if (!wrap || !statusEl || !metaEl || !tableBodyEl || !mobileListEl || !emptyEl) return;

  wrap.hidden = true;
  statusEl.textContent = "No signed agreements yet";
  metaEl.innerHTML = "";
  tableBodyEl.innerHTML = "";
  mobileListEl.innerHTML = "";
  emptyEl.classList.remove("is-visible");
  setContractSignStatus("", false);

  try {
    const res = await fetch(`/api/carrier-agreements/${encodeURIComponent(dot)}`, {
      credentials: "include"
    });

    if (!res.ok) return;

    const data = await res.json().catch(() => null);
    if (!data || typeof data !== "object") return;

    const count = Number(data.count ?? 0);
    const agreements = Array.isArray(data.agreements) ? data.agreements : [];
    const latestSignedAt = data.latest_signed_at;

    if (count > 0 && latestSignedAt) {
      setContractSignStatus(`✓ Signed ${fmtSignedDate(latestSignedAt)}`, true);
    } else if (count > 0 && agreements.length > 0) {
      const fallbackSignedAt =
        agreements[0]?.signed_at || agreements[0]?.sent_at || agreements[0]?.created_at;

      setContractSignStatus(
  fallbackSignedAt ? `✓ Signed ${fmtSignedDate(fallbackSignedAt)}` : "✓ Signed",
  true
);
    } else {
      setContractSignStatus("", false);
    }

    statusEl.textContent = `${count} Agreement${count === 1 ? "" : "s"} Signed`;

    if (latestSignedAt) {
      metaEl.innerHTML = `<span class="docs-summary-chip">Latest Signed: ${fmtDateTime(latestSignedAt)}</span>`;
    }

    if (agreements.length > 0) {
      tableBodyEl.innerHTML = agreements.map((agreement) => `
        <tr>
          <td>${safeText(agreement.agreement_type, "Carrier Agreement")}</td>
          <td>${fmtDateTime(agreement.signed_at || agreement.sent_at || agreement.created_at)}</td>
          <td>${renderRowActionLink({ href: agreement.pdf_url, label: "View Agreement" })}</td>
          <td>${renderRowActionLink({ href: agreement.certificate_url, label: "View Certificate" })}</td>
        </tr>
      `).join("");

      mobileListEl.innerHTML = agreements.map((agreement) => `
        <article class="docs-mobile-card">
          <div class="docs-mobile-title">${safeText(agreement.agreement_type, "Carrier Agreement")}</div>
          <div class="docs-mobile-meta">Signed: ${fmtDateTime(agreement.signed_at || agreement.sent_at || agreement.created_at)}</div>
          <div class="docs-row-actions docs-mobile-actions">
            ${renderRowActionLink({ href: agreement.pdf_url, label: "View Agreement" })}
            ${renderRowActionLink({ href: agreement.certificate_url, label: "View Certificate" })}
          </div>
        </article>
      `).join("");
    } else {
      emptyEl.classList.add("is-visible");
    }

    wrap.hidden = false;
  } catch (err) {
    console.error("agreements load failed", err);
    setContractSignStatus("", false);
    wrap.hidden = false;
    emptyEl.classList.add("is-visible");
  }
}
  
function wireAddDocumentModalOnce() {
  const modal = document.getElementById("add-document-modal");
  const openBtn = document.getElementById("btn-add-document");
  const closeBtn = document.getElementById("add-document-close");
  const cancelBtn = document.getElementById("add-document-cancel");
  const submitBtn = document.getElementById("add-document-submit");
  const typeEl = document.getElementById("document-type");
  const fileEl = document.getElementById("document-file");
const errEl = document.getElementById("add-document-error");

if (!modal || !openBtn || !closeBtn || !cancelBtn || !submitBtn || !typeEl || !fileEl || !errEl) {
  return;
}

  function clearError() {
    errEl.hidden = true;
    errEl.textContent = "";
  }

  function setError(message) {
    errEl.hidden = false;
    errEl.textContent = message || "Upload failed.";
  }



function closeModal() {
  modal.hidden = true;
  clearError();
  submitBtn.disabled = false;
  fileEl.value = "";
}

openBtn.addEventListener("click", () => {
  clearError();
  modal.hidden = false;
});
  
  closeBtn.addEventListener("click", closeModal);
  cancelBtn.addEventListener("click", closeModal);
  modal.addEventListener("click", (e) => {
    if (e.target === modal) closeModal();
  });

  submitBtn.addEventListener("click", async () => {
    clearError();
    if (!fileEl.files?.[0]) {
      setError("Please select a document to upload.");
      return;
    }

    const dot = CURRENT_DOT;
    if (!dot) {
      setError("Missing carrier DOT.");
      return;
    }

const fd = new FormData();
fd.append("document_type", String(typeEl.value || "other"));
fd.append("file", fileEl.files[0]);

    try {
      submitBtn.disabled = true;
      const res = await fetch(`/api/carrier-documents/${encodeURIComponent(dot)}/upload`, {
        method: "POST",
        body: fd,
        credentials: "include",
      });

      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(payload?.error || `Upload failed (${res.status})`);
      }

      closeModal();
      await loadCarrierDocuments(dot);
    } catch (err) {
      console.error("carrier document upload failed", err);
      setError(err?.message || "Upload failed.");
      submitBtn.disabled = false;
    }
  });
}


  async function initCarrierButtons(dot) {
    if (initButtonsRunning) {
      initButtonsRerun = true;   // NEW
      return;
    }
    initButtonsRunning = true;
  
    try {
      const addBtn = document.getElementById("btn-add-carrier");
      const removeBtn = document.getElementById("btn-remove-carrier");
      const emailBtn = document.getElementById("btn-email-alerts"); 
      const contractBtn = document.getElementById("btn-send-contract"); 
  
      if (!addBtn || !removeBtn) return;





    function setState({ isSaved, isLoggedIn, canEmailAlerts, canSendContracts }) {
      // NOT LOGGED IN
      if (!isLoggedIn) {
        addBtn.textContent = "Login to Add";
        addBtn.classList.remove("added");
        addBtn.classList.add("pill-disabled");
    
        removeBtn.classList.add("pill-disabled");
        removeBtn.classList.remove("active");
    
        if (emailBtn) {
          emailBtn.classList.add("pill-disabled");
          setEmailAlertPill(null);
        }
        
        if (contractBtn) {
          contractBtn.classList.add("pill-disabled");
        }

    
        return;
      }
    
      // LOGGED IN + SAVED
      if (isSaved) {
        addBtn.textContent = "Added";
        addBtn.classList.add("added", "pill-disabled");
    
        removeBtn.textContent = "Remove Carrier";
        removeBtn.classList.remove("pill-disabled");
        removeBtn.classList.add("active");
    
        if (emailBtn) {
          if (canEmailAlerts) emailBtn.classList.remove("pill-disabled");
          else emailBtn.classList.add("pill-disabled");
        }
        
        if (contractBtn) {
          if (canSendContracts) contractBtn.classList.remove("pill-disabled");
          else contractBtn.classList.add("pill-disabled");
        }
    
      // LOGGED IN BUT NOT SAVED
      } else {
        addBtn.textContent = "+ Add Carrier";
        addBtn.classList.remove("added", "pill-disabled");
    
        removeBtn.textContent = "Remove Carrier";
        removeBtn.classList.add("pill-disabled");
        removeBtn.classList.remove("active");
    
        if (emailBtn) {
          emailBtn.classList.add("pill-disabled");
          setEmailAlertPill(null);
        }

          if (contractBtn) {
          contractBtn.classList.add("pill-disabled");
        }

      }
    }


    // logged in?
let me = null;
let loggedIn = false;

try {
  const meRes = await fetch("/api/me", { credentials: "include" });
  const meData = await meRes.json().catch(() => ({}));
  me = meData?.user || null;
  loggedIn = !!me;
} catch (err) {
  console.error("auth check failed", err);
}

      
if (!loggedIn) {
  setState({ isSaved: false, isLoggedIn: false, canEmailAlerts: false, canSendContracts: false });

  // Make the "disabled-looking" pills clickable as a gate
  addBtn.classList.add("pill-disabled", "gate-click");
  addBtn.onclick = (e) => {
    e.preventDefault();
    window.requireAccountOrGate({
      title: "Sign in to add carriers",
      body: "Save this carrier to your list and track updates in one place.",
      note: "Starter is free (25 carriers)."
    });
  };

  if (emailBtn) {
    emailBtn.classList.add("pill-disabled", "gate-click");
    emailBtn.onclick = (e) => {
      e.preventDefault();
      window.requireAccountOrGate({
        title: "Sign in to use Email Alerts",
        body: "Get notified when a carrier changes status, authority, or insurance signals.",
        note: "Starter is free (25 carriers)."
      });
    };
  }


if (contractBtn) {
  contractBtn.classList.add("pill-disabled", "gate-click");
  contractBtn.onclick = (e) => {
    e.preventDefault();
    window.requireAccountOrGate({
      title: "Sign in to send contracts",
      body: "Add carriers, send contracts, and track signatures in one place.",
      note: "Starter is free (25 carriers)."
    });
  };
}

  // Optional: if you have a remove button on this page, gate it too.
  if (removeBtn) {
    removeBtn.classList.add("pill-disabled", "gate-click");
    removeBtn.onclick = (e) => {
      e.preventDefault();
      window.requireAccountOrGate({
        title: "Sign in to manage carriers",
        body: "Add and remove carriers from your list anytime.",
        note: "Starter is free (25 carriers)."
      });
    };
  }

  return;
}

const canEmailAlerts = me?.email_alerts === true;
const canSendContracts = me?.send_contracts === true;
      


    // saved?
    let isSaved = false;
    try {
      const checkRes = await fetch(`/api/my-carriers/${encodeURIComponent(dot)}`);
    
      if (checkRes.ok) {
        const checkData = await checkRes.json().catch(() => ({}));
    
      isSaved = checkData.saved === true || checkData.isSaved === true;

    
      } else if (checkRes.status === 404) {
        isSaved = false;
      } else {
        console.warn("saved check non-200:", checkRes.status);
      }
    } catch (err) {
      console.error("check saved failed", err);
    }


    setState({ isSaved, isLoggedIn: true, canEmailAlerts, canSendContracts });


      
      
    // If saved, load current email alerts state and display it in the pill
    if (emailBtn && isSaved) {
      try {
        const r = await fetch(`/api/my-carriers/${encodeURIComponent(dot)}/alerts/email`);
        if (r.ok) {
          const s = await r.json();

          console.log("ALERTS GET:", s); // 👈 ADD THIS LINE
          
          setEmailAlertPill(!!s.enabled);   
          
        } else {
          
          setEmailAlertPill(null);
        }
      } catch {
        setEmailAlertPill(null);
      }
    }

// EMAIL ALERTS pill
if (emailBtn) {
  emailBtn.classList.add("gate-click");

  // default: muted until proven usable
  emailBtn.classList.add("pill-disabled");

  emailBtn.onclick = (e) => {
    e.preventDefault();

    // 1) Plan lock
    if (!canEmailAlerts) {
      return showFeatureGate({
        title: "Email Alerts require Core",
        body: "Email Alerts are not enabled for this account.",
        primaryText: "Open Account",
        onPrimary: () => (window.location.href = "/account"),
      });
    }

    // 2) Allowed by plan but carrier not added
    if (!isSaved) {
      return showFeatureGate({
        title: "Add this carrier to enable alerts",
        body: "Email Alerts work after you add this carrier to My Carriers.",
        primaryText: "Add Carrier",
        onPrimary: () => addBtn.click(),
      });
    }

    // 3) Allowed + saved → actually open
    emailBtn.classList.remove("pill-disabled");
    openEmailAlertsModal(dot);
  };

  // if it IS usable right now, un-mute it
  if (canEmailAlerts && isSaved) {
    emailBtn.classList.remove("pill-disabled");
  }
}


// SEND CONTRACT pill
if (contractBtn) {
  contractBtn.classList.add("gate-click");

  // default: muted until proven usable
  contractBtn.classList.add("pill-disabled");

  contractBtn.onclick = (e) => {
    e.preventDefault();

    // 1) Plan lock
    if (!canSendContracts) {
      return showFeatureGate({
        title: "Contracts require Pro",
        body: "Upgrade to Pro to send broker-carrier contracts and track signatures.",
        primaryText: "Open Account",
        onPrimary: () => (window.location.href = "/account"),
      });
    }

    // 2) Allowed but carrier not added
    if (!isSaved) {
      return showFeatureGate({
        title: "Add this carrier to send a contract",
        body: "Contracts can only be sent for carriers in your saved list.",
        primaryText: "Add Carrier",
        onPrimary: () => addBtn.click(),
      });
    }

    // 3) Allowed + saved → open modal
    contractBtn.classList.remove("pill-disabled");
    openSendContractModal(dot, window.__carrierProfile || null);
  };

  // if it IS usable right now, un-mute it
  if (canSendContracts && isSaved) {
    contractBtn.classList.remove("pill-disabled");
  }
}
      
      
      
      addBtn.onclick = async () => {
        if (addBtn.classList.contains("pill-disabled")) return;
      
        try {
          const res = await fetch("/api/my-carriers", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ dot }),
          });
      
          const body = await res.json().catch(() => ({}));

          // ✅ Carrier limit gate
          if (res.status === 409 && body?.code === "CARRIER_LIMIT") {
            const limit = Number(body.carrier_limit ?? me?.carrier_limit ?? 0);
            const count = Number(body.carrier_count ?? me?.carrier_count ?? 0);

            if (isNoPlanUser(me)) {
              return showFeatureGate({
                title: "Finish setup to start adding carriers",
                body: "This account cannot add carriers yet.",
                primaryText: "Open Account",
                onPrimary: () => (window.location.href = "/account"),
              });
            }
          
            return showFeatureGate({
              title: "Carrier limit reached",
              body: "This account has reached its carrier limit.",
              note: `Current usage: ${count} of ${limit} carriers.`,
              primaryText: "Open Account",
              onPrimary: () => (window.location.href = "/account"),
            });
          }
      
          if (res.status === 401) {
            window.location.href = "/login.html";
            return;
          }
      
          if (res.ok && body.ok) {
            // update UI immediately
            setState({ isSaved: true, isLoggedIn: true, canEmailAlerts, canSendContracts });
            isSaved = true;

            // 🔥 Update cached carrier_count if backend returns it
            if (typeof body.carrier_count === "number" && me) {
              me.carrier_count = body.carrier_count;
            }
          
            if (emailBtn) {
              if (canEmailAlerts) emailBtn.classList.remove("pill-disabled");
              else emailBtn.classList.add("pill-disabled");

          
              // fetch alert state after add
              try {
                const r = await fetch(`/api/my-carriers/${encodeURIComponent(dot)}/alerts/email`);
                if (r.ok) {
                  const s = await r.json();
                  setEmailAlertPill(!!s.enabled);   // ✅ THIS is the line you were missing
                } else {
                  setEmailAlertPill(null);
                }
              } catch {
                  setEmailAlertPill(null);
              }
            }

            if (contractBtn) {
              if (canSendContracts) contractBtn.classList.remove("pill-disabled");
              else contractBtn.classList.add("pill-disabled");
            }         
            return;
          }

      
          alert(body.error || "Failed to add carrier.");
        } catch (err) {
          console.error("add carrier failed", err);
          alert("Network error adding carrier.");
        }
      };


    removeBtn.onclick = async () => {
      if (removeBtn.classList.contains("pill-disabled")) return;

      try {
        const res = await fetch(`/api/my-carriers/${encodeURIComponent(dot)}`, {
          method: "DELETE",
        });

        const body = await res.json().catch(() => ({}));

        if (res.status === 401) {
          window.location.href = "/login.html";
          return;
        }

        if (res.ok && body.ok) {
          
          if (typeof body.carrier_count === "number" && me) {
            me.carrier_count = body.carrier_count;
          }
          
          // update UI immediately (trust the delete)
          setState({ isSaved: false, isLoggedIn: true, canEmailAlerts, canSendContracts });
          isSaved = false;
        
          // reset email pill
          if (emailBtn) {
            emailBtn.classList.add("pill-disabled");
            setEmailAlertPill(null);
          }

          if (contractBtn) {
            contractBtn.classList.add("pill-disabled");
          }
        
          // OPTIONAL: confirm backend truth after a short delay
          setTimeout(() => initCarrierButtons(dot), 300);
        
          return; // IMPORTANT: stop here so nothing else runs
        }

 else {
          alert(body.error || "Failed to remove carrier.");
        }
      } catch (err) {
        console.error("remove carrier failed", err);
        alert("Network error removing carrier.");
      }
    };
  } finally {
    initButtonsRunning = false;

    // If someone tried to run again while we were busy, run once more.
    if (initButtonsRerun) {
      initButtonsRerun = false;
      setTimeout(() => initCarrierButtons(dot), 0);
    }
  }
}

  // Copy button handler (kept global for whole page)
  document.addEventListener("click", async (e) => {
    const btn = e.target.closest(".copy-btn");
    if (!btn) return;

    const targetId = btn.dataset.target;
    const el = document.getElementById(targetId);
    if (!el) return;

    const text = (el.textContent || "").trim();
    if (!text || text === "—") return;

    try {
      await navigator.clipboard.writeText(text);
      const prev = btn.getAttribute("data-tip") || "Copy";
      btn.setAttribute("data-tip", "Copied!");
      setTimeout(() => btn.setAttribute("data-tip", prev), 900);
    } catch {
      // ignore
    }
  });


  // Run ONCE
document.addEventListener("DOMContentLoaded", () => {
  wireEmailModalOnce();
  wireSendContractModalOnce(); 
  wireAddDocumentModalOnce();
  wireScreeningModalOnce();
  wireOverrideModalOnce();
  wireInsuranceDeleteModalOnce();
  wireInsuranceDocumentReviewModalOnce();
  wireQuickJump();
  wireBackToOverview();
  document.getElementById("btn-refresh-carrier")?.addEventListener("click", () => {
    const dot = CURRENT_DOT;
    if (!dot) return;
    manualRefresh(dot);
  });
  loadCarrier();
});

})();
