/* static/js/pages/account.js */
(() => {
  const $ = (id) => document.getElementById(id);

  // -----------------------------
  // Tabs
  // -----------------------------
  const railItems = Array.from(document.querySelectorAll(".rail-item"));
  const panels = {
    overview: $("tab-overview"),
    team: $("tab-team"),
    alerts: $("tab-alerts"),
    agreements: $("tab-agreements"),
    screening: $("tab-screening"),
    api: $("tab-api"),
    plan: $("tab-plan"),
    billing: $("tab-billing"),
    security: $("tab-security"),
    help: $("tab-help"),
  };

  const accountSectionsToggle = $("account-sections-toggle");
  const accountSectionsPanel = $("account-sections-panel");

  function setAccountSectionsOpen(isOpen) {
    if (!accountSectionsToggle || !accountSectionsPanel) return;
    accountSectionsToggle.setAttribute("aria-expanded", isOpen ? "true" : "false");
    accountSectionsPanel.hidden = !isOpen;
  }

function applyTabAccessByRole(roleRaw) {
  const role = String(roleRaw || "").trim().toUpperCase();

  // ✅ what you showed with green checks: only these for non-OWNER
  const allowedForMember = new Set(["overview", "security"]);

  // Owners see everything
  const allowed = (role === "OWNER")
    ? new Set(Object.keys(panels))
    : allowedForMember;

  // 1) Hide rail items that aren’t allowed
  railItems.forEach((btn) => {
    const tab = btn.dataset.tab;
    const ok = allowed.has(tab);
    btn.style.display = ok ? "" : "none";
  });

  // 2) Hide panels that aren’t allowed
  Object.entries(panels).forEach(([tab, el]) => {
    if (!el) return;
    el.style.display = allowed.has(tab) ? "" : "none";
  });

  // 3) Block “jump” buttons to disallowed tabs (Manage links, etc.)
  document.querySelectorAll("[data-tab-jump]").forEach((btn) => {
    const target = String(btn.dataset.tabJump || "").trim().toLowerCase();
    if (!target) return;
    btn.style.display = allowed.has(target) ? "" : "none";
  });

  // 4) If current tab is no longer allowed, force Overview
  if (!allowed.has(activeTab)) {
    window.location.hash = "overview";
    setActiveTab("overview");
  }

  // 5) Patch setActiveTab so even manual calls can’t open locked tabs
  const _setActiveTab = setActiveTab;
  setActiveTab = (name) => {
    if (!allowed.has(name)) {
      window.location.hash = "overview";
      return _setActiveTab("overview");
    }
    return _setActiveTab(name);
  };
}


  
function renderCancellation({ cancel_at_period_end, current_period_end }) {
  const row = document.getElementById("billing-cancel-row");
  const text = document.getElementById("billing-cancel-text");

  if (!row || !text) return;

  if (cancel_at_period_end && current_period_end) {
    const date = new Date(current_period_end).toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric"
    });

    text.textContent = `Access ends on ${date}`;
    row.style.display = "block";
  } else {
    row.style.display = "none";
  }
}
  
function setPlanBadge(planRaw) {
  const el = document.getElementById("plan-badge");
  if (!el) return;

  const tier = String(planRaw || "").trim().toLowerCase();

  el.textContent = tier ? tier.toUpperCase() : "—";

  el.classList.add("plan-badge");
  el.classList.remove("plan-core", "plan-pro", "plan-enterprise");

  const allowed = new Set(["core", "pro", "enterprise"]);
  if (allowed.has(tier)) el.classList.add(`plan-${tier}`);
}


let activeTab = "overview";

function setActiveTab(name) {
  if (!panels[name]) return;

  if (name === activeTab) {
    if (name === "help") loadTickets().catch(console.error);
    return;
  }

  activeTab = name;

  railItems.forEach((b) =>
    b.classList.toggle("is-active", b.dataset.tab === name)
  );

  Object.entries(panels).forEach(([k, el]) => {
    if (!el) return;
    el.classList.toggle("is-active", k === name);
  });

  if (name === "help") loadTickets().catch(console.error);

  if (window.matchMedia("(max-width: 920px)").matches) {
    setAccountSectionsOpen(false);
  }
}

// -----------------------------
// Deep link support: /account?tab=alerts  (or /account#alerts)
// -----------------------------
(function bootTabFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const tabFromQuery = (params.get("tab") || "").trim().toLowerCase();
  const tabFromHash = (window.location.hash || "").replace("#", "").trim().toLowerCase();

  const requested = tabFromQuery || tabFromHash;
  if (!requested) return;

  // only allow tabs you actually support (prevents typos breaking anything)
  const allowed = new Set(Object.keys(panels)); // overview, alerts, agreements, api, plan, security, help
  if (!allowed.has(requested)) return;

  setActiveTab(requested);
  window.scrollTo({ top: 0, behavior: "auto" });
})();


railItems.forEach((btn) => {
  btn.addEventListener("click", () => {
    const tab = btn.dataset.tab;
    if (tab) {
      window.location.hash = tab;   // ← add THIS line
      setActiveTab(tab);
    }
  });
});

accountSectionsToggle?.addEventListener("click", () => {
  const expanded = accountSectionsToggle.getAttribute("aria-expanded") === "true";
  setAccountSectionsOpen(!expanded);
});

document.addEventListener("click", (e) => {
  if (!accountSectionsToggle || !accountSectionsPanel) return;
  if (accountSectionsPanel.hidden) return;
  const t = e.target;
  if (accountSectionsToggle.contains(t) || accountSectionsPanel.contains(t)) return;
  setAccountSectionsOpen(false);
});

document.getElementById("btn-signout")?.addEventListener("click", (e) => {
  e.currentTarget.disabled = true;
  document.getElementById("logout-btn")?.click();
});

  
  document.querySelectorAll("[data-tab-jump]").forEach((btn) => {
    btn.addEventListener("click", () => setActiveTab(btn.dataset.tabJump));
  });

document.getElementById("btn-manage-billing")?.addEventListener("click", async () => {
  const btn = document.getElementById("btn-manage-billing");
  btn.disabled = true;

  try {
    // This matches your existing pattern: POST -> get URL -> redirect
    const r = await fetch("/api/billing/portal", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ returnPath: "/account?tab=billing" }),
    });

    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data?.error || `Portal failed: ${r.status}`);

    if (data?.url) window.location.href = data.url;
    else throw new Error("Missing portal URL");
  } catch (e) {
    console.error(e);
    alert("Could not open billing portal. Try again.");
    btn.disabled = false;
  }
});

  
  // -----------------------------
  // Pills
  // -----------------------------
  function setPill(id, enabled) {
    const el = document.getElementById(id);
    if (!el) return;

    // IMPORTANT: you said these are booleans. So we only treat true/false as truthy/falsey.
    el.classList.toggle("is-on", enabled === true);
    el.classList.toggle("is-off", enabled === false);
  }

  // -----------------------------
  // API
  // -----------------------------
  
  let API_KEY_FULL = null;
  let WEBHOOK_ORIGINAL = "";
  
  async function apiGet(url) {
    const r = await fetch(url, { credentials: "include" });
    if (!r.ok) throw new Error(`GET ${url} failed: ${r.status}`);
    return r.json();
  }

  async function apiPost(url, body) {
    const r = await fetch(url, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`POST ${url} failed: ${r.status}`);
    return r.json();
  }

  async function apiPatch(url, body) {
    const r = await fetch(url, {
      method: "PATCH",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`PATCH ${url} failed: ${r.status}`);
    return r.json();
  }

  async function apiDelete(url) {
    const r = await fetch(url, {
      method: "DELETE",
      credentials: "include",
    });

    const payload = await r.json().catch(() => ({}));
    if (!r.ok) {
      throw new Error(payload?.error || `DELETE ${url} failed: ${r.status}`);
    }
    return payload;
  }

// -----------------------------
// Team
// -----------------------------
function teamMsg(text) {
  const el = document.getElementById("team-msg");
  if (!el) return;
  el.textContent = text || "";
  el.style.display = text ? "block" : "none";
}

function escapeHtml(str) {
  return String(str ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function renderMembers(rows) {
  const host = document.getElementById("team-members");
  if (!host) return;

  if (!rows?.length) {
    host.innerHTML = `<div class="muted">No teammates yet.</div>`;
    return;
  }

host.innerHTML = rows.map(r => `
  <div class="team-row">
    <div class="team-col team-who">
      <div class="row-title">${escapeHtml(r.name || r.email || "—")}</div>
      <div class="row-sub">${escapeHtml(r.email || "—")}</div>
    </div>

    <div class="team-col team-role">${escapeHtml(r.role || "—")}</div>
    <div class="team-col team-status">${escapeHtml(r.status || "—")}</div>

    <div class="team-col team-action">
      ${
        String(r.role) === "OWNER"
          ? `<span class="muted team-owner-pill">Owner</span>`
          : `<button class="btn-ghost" data-team-disable="${r.id}">Disable</button>`
      }
    </div>
  </div>
`).join("");
  
  host.querySelectorAll("[data-team-disable]").forEach(btn => {
    btn.addEventListener("click", async () => {
      const id = btn.getAttribute("data-team-disable");
      if (!id) return;
      btn.disabled = true;
      try {
        await apiPost("/api/team/members/disable", { member_id: id });
        await loadTeam();
      } catch (e) {
        console.error(e);
        teamMsg("Could not disable member.");
        btn.disabled = false;
      }
    });
  });
}

function renderInvites(rows) {
  const host = document.getElementById("team-invites");
  if (!host) return;

  if (!rows?.length) {
    host.innerHTML = `<div class="muted">No pending invites.</div>`;
    return;
  }

  host.innerHTML = rows.map(r => `
    <div class="row" style="padding:10px 0;">
      <div style="flex:1;">
        <div class="row-title">${escapeHtml(r.invited_email || "—")}</div>
        <div class="row-sub">Role: ${escapeHtml(r.role || "—")} • Expires: ${escapeHtml(r.expires_at ? new Date(r.expires_at).toLocaleDateString() : "—")}</div>
      </div>
      <div class="row-actions">
        <button class="btn-ghost" data-team-resend="${r.id}">Resend</button>
        <button class="btn-ghost" data-team-revoke="${r.id}">Revoke</button>
      </div>
    </div>
  `).join("");

  host.querySelectorAll("[data-team-resend]").forEach(btn => {
    btn.addEventListener("click", async () => {
      const id = btn.getAttribute("data-team-resend");
      if (!id) return;
      btn.disabled = true;
      try {
        await apiPost("/api/team/invites/resend", { invite_id: id });
        teamMsg("Invite resent.");
        await loadTeam();
      } catch (e) {
        console.error(e);
        teamMsg("Could not resend invite.");
        btn.disabled = false;
      }
    });
  });

  host.querySelectorAll("[data-team-revoke]").forEach(btn => {
    btn.addEventListener("click", async () => {
      const id = btn.getAttribute("data-team-revoke");
      if (!id) return;
      btn.disabled = true;
      try {
        await apiPost("/api/team/invites/revoke", { invite_id: id });
        teamMsg("Invite revoked.");
        await loadTeam();
      } catch (e) {
        console.error(e);
        teamMsg("Could not revoke invite.");
        btn.disabled = false;
      }
    });
  });
}

async function loadTeam() {
  teamMsg("");

  const membersHost = document.getElementById("team-members");
  const invitesHost = document.getElementById("team-invites");
  if (membersHost) membersHost.innerHTML = `<div class="muted">Loading…</div>`;
  if (invitesHost) invitesHost.innerHTML = `<div class="muted">Loading…</div>`;

  const data = await apiGet("/api/team");
  renderMembers(data.members || []);
  renderInvites(data.invites || []);
}

// invite button
document.getElementById("btn-team-invite")?.addEventListener("click", async () => {
  const email = (document.getElementById("team-invite-email")?.value || "").trim();
  const role = (document.getElementById("team-invite-role")?.value || "MEMBER").trim();

  teamMsg("");
  if (!email.includes("@")) return teamMsg("Enter a valid email.");

  const btn = document.getElementById("btn-team-invite");
  btn.disabled = true;

  try {
    await apiPost("/api/team/invites", { email, role });
    document.getElementById("team-invite-email").value = "";
    teamMsg("Invite sent.");
    await loadTeam();
  } catch (e) {
    console.error(e);
    teamMsg("Could not send invite.");
  } finally {
    btn.disabled = false;
  }
});

document.getElementById("btn-team-refresh")?.addEventListener("click", () => loadTeam());

// Load team data whenever the Team tab becomes active
// (easy: call it once on page load, and again on tab click if you want)
setTimeout(() => {
  // safe: only loads if endpoints exist
  loadTeam().catch(() => {});
}, 0);
  

  // -----------------------------
  // Renderers (optional sections)
  // -----------------------------
function escapeHtml(str) {
  return String(str ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function fmtDate(ts) {
  if (!ts) return "—";
  const d = new Date(ts);
  return isNaN(d.getTime())
    ? "—"
    : d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "2-digit" });
}

let agreementsSelectedId = null;
let agreementsTemplates = [];
let agreementRequirementsOriginal = null;
let agreementRequirementsCurrent = null;
let agreementRequirementsTemplateId = null;
let agreementsSaveUiState = "idle";
let agreementsSaveStateTimer = null;
let agreementDeleteTargetId = null;
const AGREEMENT_LIMIT_PER_COMPANY = 5;
let screeningProfiles = [];
let selectedScreeningProfileId = null;
let screeningCriteriaOriginal = [];
let screeningCriteriaCurrent = [];
let screeningRuleGroups = [];
let screeningRuleGroupModalState = { open: false, submitting: false };
let screeningRuleGroupRenameModalState = { open: false, submitting: false, groupId: null };
let screeningRuleGroupAssignModalState = { open: false, submitting: false, groupId: null, selectedCriteriaIds: [] };

const SCREENING_GROUP_MATCH_LABELS = {
  ALL: "All of these",
  ANY: "Any of these",
};

function normalizeAgreementRequirements(tpl) {
  return {
    insurance_required: !!tpl?.insurance_required,
    w9_required: tpl?.w9_required === undefined || tpl?.w9_required === null ? true : !!tpl.w9_required,
    ach_required: !!tpl?.ach_required,
  };
}

function getSelectedTemplate() {
  return agreementsTemplates.find((t) => String(t.id) === String(agreementsSelectedId)) || null;
}

function setAgreementRequirementsSaveState() {
  const btn = document.getElementById("btn-save-agreement-requirements");
  if (!btn) return;
  const dirty = !!agreementsSelectedId
    && agreementRequirementsCurrent
    && agreementRequirementsOriginal
    && JSON.stringify(agreementRequirementsCurrent) !== JSON.stringify(agreementRequirementsOriginal);
  btn.disabled = !dirty || agreementsSaveUiState === "saving";
  if (agreementsSaveUiState === "saving") {
    setAgreementsSaveFeedback("saving", "Saving...");
    return;
  }
  if (agreementsSaveUiState === "error") {
    setAgreementsSaveFeedback("error", "Could not save changes");
    return;
  }
  if (dirty) {
    setAgreementsSaveFeedback("unsaved", "Unsaved changes");
    return;
  }
  if (agreementsSaveUiState !== "saved" && agreementsSaveUiState !== "error") {
    setAgreementsSaveFeedback("idle", "");
  }
}

function renderAgreementRequirements() {
  const host = document.getElementById("agreement-requirements");
  if (!host) return;

  const tpl = getSelectedTemplate();
  if (!tpl) {
    host.innerHTML = `<div class="muted">Select an agreement to configure supporting document requirements.</div>`;
    agreementRequirementsOriginal = null;
    agreementRequirementsCurrent = null;
    agreementRequirementsTemplateId = null;
    agreementsSaveUiState = "idle";
    setAgreementsSaveFeedback("idle", "");
    setAgreementRequirementsSaveState();
    return;
  }

  const currentTemplateId = String(tpl.id);
  const templateChanged = currentTemplateId !== String(agreementRequirementsTemplateId || "");
  agreementRequirementsTemplateId = currentTemplateId;

  if (templateChanged && agreementsSaveUiState !== "saving") {
    agreementsSaveUiState = "idle";
    setAgreementsSaveFeedback("idle", "");
  }
  agreementRequirementsOriginal = normalizeAgreementRequirements(tpl);
  agreementRequirementsCurrent = { ...agreementRequirementsOriginal };

  host.innerHTML = `
    <label class="toggle">
      <input type="checkbox" data-req-key="w9_required" ${agreementRequirementsCurrent.w9_required ? "checked" : ""}>
      <span>Require W-9 on signing</span>
    </label>
    <label class="toggle">
      <input type="checkbox" data-req-key="insurance_required" ${agreementRequirementsCurrent.insurance_required ? "checked" : ""}>
      <span>Require Insurance / COI on signing</span>
    </label>
    <label class="toggle">
      <input type="checkbox" data-req-key="ach_required" ${agreementRequirementsCurrent.ach_required ? "checked" : ""}>
      <span>Require ACH / Payment Info on signing</span>
    </label>
  `;

  host.querySelectorAll("input[type=checkbox][data-req-key]").forEach((cb) => {
    cb.addEventListener("change", () => {
      const key = cb.getAttribute("data-req-key");
      agreementRequirementsCurrent[key] = cb.checked;
      if (agreementsSaveUiState !== "saving") agreementsSaveUiState = "idle";
      setAgreementRequirementsSaveState();
    });
  });

  setAgreementRequirementsSaveState();
}

function renderAgreementsTiles({ templates, defaultId, selectedId }) {
  const grid = document.getElementById("agreements-grid");
  if (!grid) return;

  if (!templates?.length) {
    agreementsSelectedId = null;
    grid.innerHTML = `<div class="muted">No templates yet. Import one to get started.</div>`;
    setAgreementsDefaultButtonState();
    return;
  }

  const hasSelected = selectedId && templates.some((t) => String(t.id) === String(selectedId));
  agreementsSelectedId = hasSelected ? selectedId : (defaultId || String(templates[0]?.id || "") || null);
  setAgreementsDefaultButtonState();

  grid.innerHTML = templates
    .map((t) => {
      const isDefault = String(t.id) === String(defaultId);
      const isSelected = String(t.id) === String(agreementsSelectedId);

      const subtitle = ""; // intentionally blank (we're hiding version/provider for clean UI)

      return `
        <div class="agreement-tile ${isDefault ? "is-default" : ""} ${isSelected ? "is-selected" : ""}"
             role="button"
             tabindex="0"
             data-id="${t.id}">

          <button
            class="agreement-delete-trigger"
            type="button"
            data-delete-agreement="${t.id}"
            aria-label="Delete agreement ${escapeHtml(t.display_name || t.name || "Untitled")}">
            <span aria-hidden="true">✕</span>
          </button>
      
          <button
            class="tile-preview tile-preview--clickable"
            type="button"
            data-open-pdf="${t.id}"
            aria-label="Open PDF"
          >

            <div class="paper">
              <div class="paper-line w90"></div>
              <div class="paper-line w70"></div>
              <div class="paper-line w85"></div>
              <div class="paper-line w60"></div>
            </div>
            <div class="pdf-chip">OPEN PDF</div>
          </button>
      
          <div class="tile-body">
            <div class="tile-actions">
                ${isDefault ? `<span class="pill-badge pill-badge--on">DEFAULT</span>` : ``}
            </div>
              <div class="tile-name">${escapeHtml(t.display_name || t.name || "Untitled")}</div>
              <div class="tile-meta muted">Updated ${escapeHtml(fmtDate(t.created_at))}</div>
          </div>
        </div>
      `;
    })
    .join("");

  grid.querySelectorAll(".agreement-tile").forEach((btn) => {
    btn.addEventListener("click", () => {
      agreementsSelectedId = btn.getAttribute("data-id");
      grid.querySelectorAll(".agreement-tile").forEach((b) => b.classList.remove("is-selected"));
      btn.classList.add("is-selected");
      setAgreementsDefaultButtonState();
      renderAgreementRequirements();
    });
  });

grid.querySelectorAll(".agreement-tile").forEach((tile) => {
  tile.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      tile.click();
    }
  });
});


  
  grid.querySelectorAll("[data-open-pdf]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation(); // IMPORTANT: do not select tile / re-render
      const id = btn.getAttribute("data-open-pdf");
      if (!id) return;
      window.open(`/api/user-contracts/${encodeURIComponent(id)}/pdf`, "_blank", "noopener");
    });
  });

  grid.querySelectorAll("[data-delete-agreement]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const id = btn.getAttribute("data-delete-agreement");
      if (!id) return;
      openAgreementDeleteModal(id);
    });
  });
  
}

function getAgreementDisplayName(id) {
  const tpl = (agreementsTemplates || []).find((t) => String(t.id) === String(id));
  return tpl?.display_name || tpl?.name || "Untitled";
}

async function deleteAgreementById(id) {
  return apiDelete(`/api/user-contracts/${encodeURIComponent(id)}`);
}

function openAgreementDeleteModal(id) {
  const modal = document.getElementById("agreement-delete-modal");
  const targetEl = document.getElementById("agreement-delete-target");
  const errEl = document.getElementById("agreement-delete-error");
  if (!modal || !targetEl || !errEl) return;

  agreementDeleteTargetId = String(id);
  targetEl.textContent = getAgreementDisplayName(id);
  errEl.hidden = true;
  errEl.textContent = "";
  modal.hidden = false;
}

  async function loadAgreements() {
  const previouslySelectedId = agreementsSelectedId;
  const [tplRes, defRes] = await Promise.all([
    apiGet("/api/user-contracts"),
    apiGet("/api/agreements/default"),
  ]);

  const templates = tplRes?.rows || [];
  const defaultId = defRes?.row?.default_user_contract_id || null;

  agreementsTemplates = templates;
  renderAgreementsTiles({ templates, defaultId, selectedId: previouslySelectedId });
  renderAgreementRequirements();
}

function wireAgreementUploadModalOnce() {
  const modal = document.getElementById("agreement-upload-modal");
  const openBtn = document.getElementById("btn-upload-agreement");
  const closeBtn = document.getElementById("agreement-upload-close");
  const cancelBtn = document.getElementById("agreement-upload-cancel");
  const submitBtn = document.getElementById("agreement-upload-submit");
  const formEl = document.getElementById("agreement-upload-form");
  const titleEl = document.getElementById("agreement-upload-name");
  const fileEl = document.getElementById("agreement-upload-file");
  const filePickerEl = document.getElementById("agreement-file-picker");
  const fileNameEl = document.getElementById("agreement-file-name");
  const filePillEl = document.getElementById("agreement-file-pill");
  const errEl = document.getElementById("agreement-upload-error");

  if (!modal || !openBtn || !closeBtn || !cancelBtn || !submitBtn || !formEl || !titleEl || !fileEl || !filePickerEl || !fileNameEl || !filePillEl || !errEl) return;
  if (modal.dataset.wired === "1") return;
  modal.dataset.wired = "1";

  function syncFileUi() {
    const file = fileEl.files?.[0];

    if (!file) {
      fileNameEl.textContent = "No file selected";
      filePillEl.textContent = "Choose PDF";
      filePickerEl.classList.remove("has-file", "has-error");
      return;
    }

    fileNameEl.textContent = file.name || "Selected file";
    filePillEl.textContent = "PDF Selected";
    filePickerEl.classList.add("has-file");
    filePickerEl.classList.remove("has-error");
  }

  function clearError() {
    errEl.hidden = true;
    errEl.textContent = "";
    filePickerEl.classList.remove("has-error");
  }

  function setError(message) {
    errEl.hidden = false;
    errEl.textContent = message || "Upload failed.";
    filePickerEl.classList.add("has-error");
  }

  function resetModalState() {
    formEl.reset();
    clearError();
    syncFileUi();
    submitBtn.disabled = false;
  }

  function closeModal() {
    modal.hidden = true;
    resetModalState();
  }

  openBtn.addEventListener("click", () => {
    resetModalState();
    if ((agreementsTemplates || []).length >= AGREEMENT_LIMIT_PER_COMPANY) {
      setError(`Agreement limit reached. You can store up to ${AGREEMENT_LIMIT_PER_COMPANY} master agreements.`);
    }
    modal.hidden = false;
    setTimeout(() => titleEl.focus(), 0);
  });

  closeBtn.addEventListener("click", closeModal);
  cancelBtn.addEventListener("click", closeModal);
  modal.addEventListener("click", (e) => {
    if (e.target === modal) closeModal();
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !modal.hidden) closeModal();
  });

  fileEl.addEventListener("change", () => {
    clearError();
    syncFileUi();
  });

  syncFileUi();

  submitBtn.addEventListener("click", async () => {
    clearError();

    if ((agreementsTemplates || []).length >= AGREEMENT_LIMIT_PER_COMPANY) {
      setError(`Agreement limit reached. You can store up to ${AGREEMENT_LIMIT_PER_COMPANY} master agreements.`);
      return;
    }

    const file = fileEl.files?.[0];
    if (!file) {
      setError("Please select a PDF to upload.");
      return;
    }

    const fileName = String(file.name || "").toLowerCase();
    const isPdf = file.type === "application/pdf" || fileName.endsWith(".pdf");
    if (!isPdf) {
      setError("Only PDF files are supported.");
      return;
    }

    const enteredTitle = String(titleEl.value || "").trim();
    const fd = new FormData();
    fd.append("file", file);
    if (enteredTitle) fd.append("title", enteredTitle);

    try {
      submitBtn.disabled = true;
      const res = await fetch("/api/user-contracts/upload", {
        method: "POST",
        credentials: "include",
        body: fd,
      });

      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        const msg = payload?.error || `Upload failed (${res.status})`;
        throw new Error(msg);
      }

      closeModal();
      await loadAgreements();
    } catch (err) {
      console.error("agreement upload failed", err);
      setError(err?.message || "Upload failed.");
      submitBtn.disabled = false;
    }
  });
}

function wireAgreementDeleteModalOnce() {
  const modal = document.getElementById("agreement-delete-modal");
  const closeBtn = document.getElementById("agreement-delete-close");
  const cancelBtn = document.getElementById("agreement-delete-cancel");
  const confirmBtn = document.getElementById("agreement-delete-confirm");
  const errEl = document.getElementById("agreement-delete-error");

  if (!modal || !closeBtn || !cancelBtn || !confirmBtn || !errEl) return;
  if (modal.dataset.wired === "1") return;
  modal.dataset.wired = "1";

  function clearError() {
    errEl.hidden = true;
    errEl.textContent = "";
  }

  function closeModal() {
    modal.hidden = true;
    agreementDeleteTargetId = null;
    clearError();
    confirmBtn.disabled = false;
  }

  closeBtn.addEventListener("click", closeModal);
  cancelBtn.addEventListener("click", closeModal);
  modal.addEventListener("click", (e) => {
    if (e.target === modal) closeModal();
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !modal.hidden) closeModal();
  });

  confirmBtn.addEventListener("click", async () => {
    if (!agreementDeleteTargetId) return;
    clearError();
    confirmBtn.disabled = true;
    try {
      const deletedId = agreementDeleteTargetId;
      await deleteAgreementById(deletedId);
      closeModal();

      if (String(agreementsSelectedId) === String(deletedId)) {
        agreementsSelectedId = null;
      }

      await loadAgreements();
    } catch (err) {
      errEl.hidden = false;
      errEl.textContent = err?.message || "Failed to delete agreement.";
      confirmBtn.disabled = false;
    }
  });
}

function normalizeOperator(value) {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  return String(value).trim().toUpperCase();
}

const OPERATOR_LABELS = {
  EQUALS: "equals",
  NOT_EQUALS: "does not equal",
  GREATER_THAN: "greater than",
  GREATER_THAN_OR_EQUAL: "greater than or equal to",
  LESS_THAN: "less than",
  LESS_THAN_OR_EQUAL: "less than or equal to",
  IN: "includes",
  NOT_IN: "does not include",
  IS_TRUE: "is true",
  IS_FALSE: "is false",
};

const OPERATORS_BY_TYPE = {
  BOOLEAN: ["IS_TRUE", "IS_FALSE"],
  NUMBER: ["GREATER_THAN", "GREATER_THAN_OR_EQUAL", "LESS_THAN", "LESS_THAN_OR_EQUAL", "EQUALS", "NOT_EQUALS"],
  DATE: ["LESS_THAN", "LESS_THAN_OR_EQUAL", "GREATER_THAN", "GREATER_THAN_OR_EQUAL", "EQUALS", "NOT_EQUALS"],
  ENUM: ["EQUALS", "NOT_EQUALS", "IN", "NOT_IN"],
};

const SCREENING_DEFAULT_OPERATOR_BY_KEY = {
  ALLOWED_TO_OPERATE: "IS_TRUE",
  CARGO_INSURANCE_ON_FILE: "IS_TRUE",
  BIPD_INSURANCE_ON_FILE: "IS_TRUE",
  BOND_INSURANCE_ON_FILE: "IS_TRUE",
  MCS_150_OUTDATED: "IS_FALSE",
  CRASH_TOTAL: "GREATER_THAN",
  DRIVER_OOS_RATE: "GREATER_THAN",
  VEHICLE_OOS_RATE: "GREATER_THAN",
  TOTAL_DRIVERS: "LESS_THAN",
  TOTAL_POWER_UNITS: "LESS_THAN",
};

const SCREENING_INTEGER_CRITERIA_KEYS = new Set([
  "CRASH_TOTAL",
  "TOTAL_DRIVERS",
  "TOTAL_POWER_UNITS",
]);

const SCREENING_MULTI_ENUM_OPERATORS = new Set(["IN", "NOT_IN"]);
let screeningSaveUiState = "idle";
let screeningSaveStateTimer = null;
let emailSaveUiState = "idle";
let emailSaveStateTimer = null;

function clearScreeningSaveStateTimer() {
  if (!screeningSaveStateTimer) return;
  clearTimeout(screeningSaveStateTimer);
  screeningSaveStateTimer = null;
}

function clearEmailSaveStateTimer() {
  if (!emailSaveStateTimer) return;
  clearTimeout(emailSaveStateTimer);
  emailSaveStateTimer = null;
}

function clearAgreementsSaveStateTimer() {
  if (!agreementsSaveStateTimer) return;
  clearTimeout(agreementsSaveStateTimer);
  agreementsSaveStateTimer = null;
}

function setSaveStatusFeedback(el, state = "idle", message = "") {
  if (!el) return;
  el.textContent = message || "";
  el.className = "save-status";
  if (!message) return;
  el.classList.add("is-visible");
  if (state === "unsaved") el.classList.add("is-unsaved");
  if (state === "saving") el.classList.add("is-saving");
  if (state === "saved") el.classList.add("is-saved");
  if (state === "error") el.classList.add("is-error");
}

function setScreeningSaveFeedback(state = "idle", message = "") {
  const el = document.getElementById("screening-save-status");
  clearScreeningSaveStateTimer();
  screeningSaveUiState = state;
  setSaveStatusFeedback(el, state, message);

  if (state === "saved") {
    screeningSaveStateTimer = setTimeout(() => {
      setScreeningSaveFeedback("idle", "");
    }, 2500);
  }
}

function setEmailSaveFeedback(state = "idle", message = "") {
  const el = document.getElementById("email-save-status");
  clearEmailSaveStateTimer();
  emailSaveUiState = state;
  setSaveStatusFeedback(el, state, message);
  if (state === "saved") {
    emailSaveStateTimer = setTimeout(() => {
      setEmailSaveFeedback("idle", "");
    }, 2500);
  }
}

function setAgreementsSaveFeedback(state = "idle", message = "") {
  const el = document.getElementById("agreements-save-status");
  clearAgreementsSaveStateTimer();
  agreementsSaveUiState = state;
  setSaveStatusFeedback(el, state, message);
  if (state === "saved") {
    agreementsSaveStateTimer = setTimeout(() => {
      setAgreementsSaveFeedback("idle", "");
    }, 2500);
  }
}

function criterionDefaultOperator(row) {
  const type = String(row?.value_type || "").toUpperCase();
  const options = OPERATORS_BY_TYPE[type] || [];
  if (!options.length) return null;

  const key = String(row?.criteria_key || "").trim().toUpperCase();
  const mapped = SCREENING_DEFAULT_OPERATOR_BY_KEY[key];
  if (mapped && options.includes(mapped)) return mapped;

  if (type === "BOOLEAN") return "IS_TRUE";
  if (type === "NUMBER") return "GREATER_THAN";
  if (type === "DATE") return "LESS_THAN_OR_EQUAL";
  if (type === "ENUM") return "EQUALS";
  return options[0] || null;
}

function isIntegerLikeScreeningCriterion(row) {
  const key = String(row?.criteria_key || "").trim().toUpperCase();
  return SCREENING_INTEGER_CRITERIA_KEYS.has(key);
}

function normalizeNumberForCriterion(row, value) {
  if (value === null || value === undefined || value === "") return null;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  return numeric;
}

function formatNumberForDisplay(row, value) {
  if (value === null || value === undefined || value === "") return "";
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return "";
  return isIntegerLikeScreeningCriterion(row) ? String(Math.trunc(numeric)) : String(numeric);
}

function parseEnumSelections(valueText) {
  if (valueText === null || valueText === undefined || String(valueText).trim() === "") return [];
  return String(valueText).split(",").map((v) => v.trim()).filter(Boolean);
}

function getEnumOptionValue(option) {
  if (option && typeof option === "object" && !Array.isArray(option)) {
    if (option.value === null || option.value === undefined) return "";
    return String(option.value);
  }
  if (option === null || option === undefined) return "";
  return String(option);
}

function getEnumOptionLabel(option) {
  if (option && typeof option === "object" && !Array.isArray(option)) {
    if (option.label !== null && option.label !== undefined && String(option.label).trim() !== "") {
      return String(option.label);
    }
    return getEnumOptionValue(option);
  }
  return getEnumOptionValue(option);
}

function normalizeEnumOptions(options) {
  if (!Array.isArray(options)) return [];
  return options
    .map((option) => ({ value: getEnumOptionValue(option), label: getEnumOptionLabel(option) }))
    .filter((option) => option.value !== "");
}

function getEnumLabelForValue(row, value) {
  const rawValue = value === null || value === undefined ? "" : String(value);
  const options = normalizeEnumOptions(row?.enum_options);
  const match = options.find((opt) => opt.value === rawValue);
  return match?.label || rawValue;
}

function ensureScreeningDefaults(row) {
  const type = String(row?.value_type || "").toUpperCase();
  if (!row) return;

  if (!normalizeOperator(row.comparison_operator)) {
    row.comparison_operator = criterionDefaultOperator(row);
  }

  if (type === "BOOLEAN") {
    if (row.value_bool === null || row.value_bool === undefined) {
      row.value_bool = normalizeOperator(row.comparison_operator) !== "IS_FALSE";
    }
  } else if (type === "NUMBER") {
    if (row.value_number === "") {
      row.value_number = null;
    } else if (row.value_number !== null && row.value_number !== undefined) {
      row.value_number = normalizeNumberForCriterion(row, row.value_number);
    }
  } else if (type === "ENUM") {
    const options = normalizeEnumOptions(row.enum_options);
    const optionValues = options.map((opt) => opt.value);
    const op = normalizeOperator(row.comparison_operator) || criterionDefaultOperator(row);
    const selectedValues = parseEnumSelections(row.value_text).filter((val) => !optionValues.length || optionValues.includes(val));
    if (SCREENING_MULTI_ENUM_OPERATORS.has(op)) {
      row.value_text = selectedValues.length ? selectedValues.join(", ") : null;
    } else if ((row.value_text === null || row.value_text === undefined || row.value_text === "") && options.length) {
      row.value_text = options[0].value;
    } else if (selectedValues.length) {
      row.value_text = selectedValues[0];
    }
  }
}

function operatorOptionsForRow(row) {
  const type = String(row?.value_type || "").toUpperCase();
  const allowed = OPERATORS_BY_TYPE[type] || [];
  const current = normalizeOperator(row?.comparison_operator);
  const base = allowed.length ? [...allowed] : [];
  if (current && !base.includes(current)) base.unshift(current);
  if (!base.length) base.push("EQUALS");
  return base;
}

function screeningRulePreview(row) {
  const rawLabel = row.label || row.criteria_key || "Criterion";
  const label = String(rawLabel).trim();
  const key = String(row.criteria_key || "").trim().toUpperCase();
  const type = String(row.value_type || "").toUpperCase();
  const op = normalizeOperator(row.comparison_operator) || criterionDefaultOperator(row);
  const opLabel = OPERATOR_LABELS[op] || "is";

  if (type === "BOOLEAN") {
    if (key === "ALLOWED_TO_OPERATE") {
      return op === "IS_FALSE"
        ? "Carrier is flagged if the carrier is not allowed to operate."
        : "Carrier must be allowed to operate.";
    }
    if (key === "CARGO_INSURANCE_ON_FILE") {
      return op === "IS_FALSE"
        ? "Carrier is flagged if cargo insurance is not on file."
        : "Carrier must have cargo insurance on file.";
    }
    if (key === "BIPD_INSURANCE_ON_FILE") {
      return op === "IS_FALSE"
        ? "Carrier is flagged if BIPD insurance is not on file."
        : "Carrier must have BIPD insurance on file.";
    }
    if (key === "BOND_INSURANCE_ON_FILE") {
      return op === "IS_FALSE"
        ? "Carrier is flagged if bond insurance is not on file."
        : "Carrier must have bond insurance on file.";
    }
    if (key === "MCS_150_OUTDATED") {
      return op === "IS_FALSE"
        ? "Carrier must not have an outdated MCS-150."
        : "Carrier is flagged if the MCS-150 is outdated.";
    }

    return op === "IS_FALSE"
      ? `Carrier is flagged if ${label} is false.`
      : `Carrier is flagged if ${label} is true.`;
  }

  if (type === "NUMBER") {
    const hasValue = !(row.value_number === null || row.value_number === undefined || row.value_number === "");
    if (!hasValue) return `Carrier is flagged if ${label} ${opLabel} the selected value. Enter a value to complete this rule.`;
    return `Carrier is flagged if ${label} ${opLabel} ${formatNumberForDisplay(row, row.value_number)}.`;
  }

  if (type === "DATE") {
    const value = row.value_date ? String(row.value_date).slice(0, 10) : "the selected date";
    return `Carrier is flagged if ${label} ${opLabel} ${value}.`;
  }

  if (type === "ENUM") {
    const selectedValues = parseEnumSelections(row.value_text);
    const value = selectedValues.length
      ? selectedValues.map((selectedValue) => getEnumLabelForValue(row, selectedValue)).join(", ")
      : "the selected value";
    return `Carrier is flagged if ${label} ${opLabel} ${value}.`;
  }

  return `Carrier is flagged if ${label} matches this rule.`;
}

function normalizeScreeningMatchType(value) {
  const token = String(value || "").trim().toUpperCase();
  return token === "ANY" ? "ANY" : "ALL";
}

function getScreeningGroupById(groupId) {
  return (screeningRuleGroups || []).find((group) => String(group.id) === String(groupId)) || null;
}

function labelForScreeningGroupMatch(group) {
  const matchType = normalizeScreeningMatchType(group?.match_type);
  return SCREENING_GROUP_MATCH_LABELS[matchType] || SCREENING_GROUP_MATCH_LABELS.ALL;
}

function getScreeningGroupModalEls() {
  return {
    modal: document.getElementById("screening-group-modal"),
    form: document.getElementById("screening-group-modal-form"),
    nameInput: document.getElementById("screening-group-name"),
    matchTypeSelect: document.getElementById("screening-group-match-type"),
    submitBtn: document.getElementById("screening-group-modal-submit"),
    cancelBtn: document.getElementById("screening-group-modal-cancel"),
    closeBtn: document.getElementById("screening-group-modal-close"),
    errorEl: document.getElementById("screening-group-modal-error"),
  };
}

function setScreeningGroupModalError(message = "") {
  const { errorEl } = getScreeningGroupModalEls();
  if (!errorEl) return;
  errorEl.hidden = !message;
  errorEl.textContent = message || "";
}

function closeScreeningRuleGroupModal() {
  const { modal, form, nameInput, matchTypeSelect, submitBtn } = getScreeningGroupModalEls();
  if (!modal || !form || !nameInput || !matchTypeSelect || !submitBtn) return;
  screeningRuleGroupModalState = { open: false, submitting: false };
  modal.hidden = true;
  form.reset();
  nameInput.value = "";
  matchTypeSelect.value = "ALL";
  submitBtn.disabled = false;
  submitBtn.textContent = "Create Group";
  setScreeningGroupModalError("");
}

function openScreeningRuleGroupModal() {
  const { modal, nameInput, matchTypeSelect, submitBtn } = getScreeningGroupModalEls();
  if (!modal || !nameInput || !matchTypeSelect || !submitBtn) return;
  screeningRuleGroupModalState = { open: true, submitting: false };
  nameInput.value = "";
  matchTypeSelect.value = "ALL";
  submitBtn.disabled = !selectedScreeningProfileId;
  setScreeningGroupModalError(selectedScreeningProfileId ? "" : "Select a screening profile before creating a rule group.");
  modal.hidden = false;
  setTimeout(() => nameInput.focus(), 0);
}

function wireScreeningRuleGroupModalOnce() {
  const { modal, form, nameInput, matchTypeSelect, submitBtn, cancelBtn, closeBtn } = getScreeningGroupModalEls();
  if (!modal || !form || !nameInput || !matchTypeSelect || !submitBtn || !cancelBtn || !closeBtn) return;
  if (modal.dataset.wired === "1") return;
  modal.dataset.wired = "1";

  closeBtn.addEventListener("click", closeScreeningRuleGroupModal);
  cancelBtn.addEventListener("click", closeScreeningRuleGroupModal);
  modal.addEventListener("click", (event) => {
    if (event.target === modal) closeScreeningRuleGroupModal();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && screeningRuleGroupModalState.open) closeScreeningRuleGroupModal();
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (screeningRuleGroupModalState.submitting) return;
    if (!selectedScreeningProfileId) {
      setScreeningGroupModalError("Select a screening profile before creating a rule group.");
      return;
    }
    const groupName = String(nameInput.value || "").trim();
    if (!groupName) {
      setScreeningGroupModalError("Group name is required.");
      nameInput.focus();
      return;
    }
    screeningRuleGroupModalState.submitting = true;
    submitBtn.disabled = true;
    submitBtn.textContent = "Creating...";
    setScreeningGroupModalError("");
    try {
      await createScreeningRuleGroup({ groupName, matchType: matchTypeSelect.value || "ALL" });
      closeScreeningRuleGroupModal();
    } catch (err) {
      screeningRuleGroupModalState.submitting = false;
      submitBtn.disabled = false;
      submitBtn.textContent = "Create Group";
      setScreeningGroupModalError(err?.message || "Failed to create screening rule group.");
    }
  });
}

function getScreeningGroupRenameModalEls() {
  return {
    modal: document.getElementById("screening-group-rename-modal"),
    form: document.getElementById("screening-group-rename-modal-form"),
    nameInput: document.getElementById("screening-group-rename-name"),
    submitBtn: document.getElementById("screening-group-rename-modal-submit"),
    cancelBtn: document.getElementById("screening-group-rename-modal-cancel"),
    closeBtn: document.getElementById("screening-group-rename-modal-close"),
    errorEl: document.getElementById("screening-group-rename-modal-error"),
  };
}

function getScreeningGroupAssignModalEls() {
  return {
    modal: document.getElementById("screening-group-assign-modal"),
    form: document.getElementById("screening-group-assign-modal-form"),
    listEl: document.getElementById("screening-group-assign-modal-list"),
    titleEl: document.getElementById("screening-group-assign-modal-title"),
    submitBtn: document.getElementById("screening-group-assign-modal-submit"),
    cancelBtn: document.getElementById("screening-group-assign-modal-cancel"),
    closeBtn: document.getElementById("screening-group-assign-modal-close"),
    errorEl: document.getElementById("screening-group-assign-modal-error"),
  };
}

function setScreeningGroupRenameModalError(message = "") {
  const { errorEl } = getScreeningGroupRenameModalEls();
  if (!errorEl) return;
  errorEl.hidden = !message;
  errorEl.textContent = message || "";
}

function closeScreeningRuleGroupRenameModal() {
  const { modal, form, submitBtn } = getScreeningGroupRenameModalEls();
  if (!modal || !form || !submitBtn) return;
  screeningRuleGroupRenameModalState = { open: false, submitting: false, groupId: null };
  submitBtn.disabled = false;
  submitBtn.textContent = "Save";
  setScreeningGroupRenameModalError("");
  form.reset();
  modal.hidden = true;
}

function openScreeningRuleGroupRenameModal(group) {
  if (!group) return;
  const { modal, nameInput } = getScreeningGroupRenameModalEls();
  if (!modal || !nameInput) return;
  screeningRuleGroupRenameModalState = { open: true, submitting: false, groupId: String(group.id) };
  nameInput.value = String(group.group_name || "");
  setScreeningGroupRenameModalError("");
  modal.hidden = false;
  setTimeout(() => nameInput.focus(), 0);
}

function setScreeningGroupAssignModalError(message = "") {
  const { errorEl } = getScreeningGroupAssignModalEls();
  if (!errorEl) return;
  errorEl.hidden = !message;
  errorEl.textContent = message || "";
}

function closeScreeningRuleGroupAssignModal() {
  const { modal, form, submitBtn, titleEl, listEl } = getScreeningGroupAssignModalEls();
  if (!modal || !form || !submitBtn || !titleEl || !listEl) return;
  screeningRuleGroupAssignModalState = { open: false, submitting: false, groupId: null, selectedCriteriaIds: [] };
  submitBtn.disabled = false;
  submitBtn.textContent = "Save Rules";
  titleEl.textContent = "Assign Rules";
  listEl.innerHTML = "";
  setScreeningGroupAssignModalError("");
  form.reset();
  modal.hidden = true;
}

function renderScreeningGroupAssignModalList(group) {
  const { listEl } = getScreeningGroupAssignModalEls();
  if (!listEl) return;

  const rows = Array.isArray(screeningCriteriaCurrent) ? screeningCriteriaCurrent : [];
  const assignableRows = rows.filter((row) => !!row?.is_enabled && !!row?.profile_criteria_id);

  if (!assignableRows.length) {
    listEl.innerHTML = `<div class="muted">No saved and enabled rules are available to assign yet.</div>`;
    return;
  }

  const grouped = assignableRows.reduce((acc, row) => {
    const category = String(row.category || "Other").trim() || "Other";
    if (!acc[category]) acc[category] = [];
    acc[category].push(row);
    return acc;
  }, {});

  listEl.innerHTML = Object.entries(grouped).map(([category, criteria]) => {
    const items = criteria.map((row) => {
      const profileCriteriaId = Number(row.profile_criteria_id);
      const checked = screeningRuleGroupAssignModalState.selectedCriteriaIds.includes(profileCriteriaId) ? "checked" : "";
      return `
        <label class="screening-group-assign-item">
          <input type="checkbox" data-screening-assign-criteria-id="${profileCriteriaId}" ${checked}>
          <span>${escapeHtml(row.label || row.criteria_key || "Criterion")}</span>
        </label>
      `;
    }).join("");
    return `
      <section class="screening-group-assign-section">
        <header>${escapeHtml(category)}</header>
        <div class="screening-group-assign-items">${items}</div>
      </section>
    `;
  }).join("");
}

function openScreeningRuleGroupAssignModal(group) {
  if (!group || !selectedScreeningProfileId) return;
  const { modal, titleEl, submitBtn } = getScreeningGroupAssignModalEls();
  if (!modal || !titleEl || !submitBtn) return;
  const selectedIds = (group.criteria || [])
    .map((criterion) => Number(criterion?.profile_criteria_id))
    .filter((id) => Number.isFinite(id));
  screeningRuleGroupAssignModalState = {
    open: true,
    submitting: false,
    groupId: String(group.id),
    selectedCriteriaIds: selectedIds,
  };
  titleEl.textContent = `Assign Rules to ${group.group_name || "Group"}`;
  submitBtn.disabled = false;
  submitBtn.textContent = "Save Rules";
  setScreeningGroupAssignModalError("");
  renderScreeningGroupAssignModalList(group);
  modal.hidden = false;
}

function wireScreeningRuleGroupAssignModalOnce() {
  const { modal, form, listEl, submitBtn, cancelBtn, closeBtn } = getScreeningGroupAssignModalEls();
  if (!modal || !form || !listEl || !submitBtn || !cancelBtn || !closeBtn) return;
  if (modal.dataset.wired === "1") return;
  modal.dataset.wired = "1";

  closeBtn.addEventListener("click", closeScreeningRuleGroupAssignModal);
  cancelBtn.addEventListener("click", closeScreeningRuleGroupAssignModal);
  modal.addEventListener("click", (event) => {
    if (event.target === modal) closeScreeningRuleGroupAssignModal();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && screeningRuleGroupAssignModalState.open) closeScreeningRuleGroupAssignModal();
  });

  form.addEventListener("change", (event) => {
    const input = event.target?.closest?.("[data-screening-assign-criteria-id]");
    if (!input) return;
    const profileCriteriaId = Number(input.getAttribute("data-screening-assign-criteria-id"));
    if (!Number.isFinite(profileCriteriaId)) return;
    const next = new Set(screeningRuleGroupAssignModalState.selectedCriteriaIds || []);
    if (input.checked) next.add(profileCriteriaId);
    else next.delete(profileCriteriaId);
    screeningRuleGroupAssignModalState.selectedCriteriaIds = Array.from(next);
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (screeningRuleGroupAssignModalState.submitting) return;
    if (!selectedScreeningProfileId || !screeningRuleGroupAssignModalState.groupId) return;

    screeningRuleGroupAssignModalState.submitting = true;
    submitBtn.disabled = true;
    submitBtn.textContent = "Saving...";
    setScreeningGroupAssignModalError("");

    try {
      await apiPost(
        `/api/screening/profiles/${encodeURIComponent(selectedScreeningProfileId)}/groups/${encodeURIComponent(screeningRuleGroupAssignModalState.groupId)}/rules`,
        { profile_criteria_ids: screeningRuleGroupAssignModalState.selectedCriteriaIds }
      );
      closeScreeningRuleGroupAssignModal();
      await loadScreeningCriteria(selectedScreeningProfileId);
    } catch (err) {
      screeningRuleGroupAssignModalState.submitting = false;
      submitBtn.disabled = false;
      submitBtn.textContent = "Save Rules";
      setScreeningGroupAssignModalError(err?.message || "Failed to save rule assignments.");
    }
  });
}

function wireScreeningRuleGroupRenameModalOnce() {
  const { modal, form, nameInput, submitBtn, cancelBtn, closeBtn } = getScreeningGroupRenameModalEls();
  if (!modal || !form || !nameInput || !submitBtn || !cancelBtn || !closeBtn) return;
  if (modal.dataset.wired === "1") return;
  modal.dataset.wired = "1";

  closeBtn.addEventListener("click", closeScreeningRuleGroupRenameModal);
  cancelBtn.addEventListener("click", closeScreeningRuleGroupRenameModal);
  modal.addEventListener("click", (event) => {
    if (event.target === modal) closeScreeningRuleGroupRenameModal();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && screeningRuleGroupRenameModalState.open) closeScreeningRuleGroupRenameModal();
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (screeningRuleGroupRenameModalState.submitting) return;
    if (!selectedScreeningProfileId || !screeningRuleGroupRenameModalState.groupId) return;
    const nextName = String(nameInput.value || "").trim();
    if (!nextName) {
      setScreeningGroupRenameModalError("Group name is required.");
      nameInput.focus();
      return;
    }

    screeningRuleGroupRenameModalState.submitting = true;
    submitBtn.disabled = true;
    submitBtn.textContent = "Saving...";
    setScreeningGroupRenameModalError("");

    try {
      await apiPatch(
        `/api/screening/profiles/${encodeURIComponent(selectedScreeningProfileId)}/groups/${encodeURIComponent(screeningRuleGroupRenameModalState.groupId)}`,
        { group_name: nextName }
      );
      closeScreeningRuleGroupRenameModal();
      await loadScreeningCriteria(selectedScreeningProfileId);
    } catch (err) {
      screeningRuleGroupRenameModalState.submitting = false;
      submitBtn.disabled = false;
      submitBtn.textContent = "Save";
      setScreeningGroupRenameModalError(err?.message || "Failed to rename rule group.");
    }
  });
}


function normalizeScreeningCriterionForSave(row) {
  const normalizedNumber = row.value_number === null || row.value_number === undefined || row.value_number === ""
    ? null
    : normalizeNumberForCriterion(row, row.value_number);
  return {
    profile_criteria_id: row.profile_criteria_id === null || row.profile_criteria_id === undefined ? null : Number(row.profile_criteria_id),
    screening_criteria_id: Number(row.screening_criteria_id),
    is_enabled: !!row.is_enabled,
    group_id: row.group_id ? String(row.group_id) : null,
    comparison_operator: normalizeOperator(row.comparison_operator),
    value_bool: row.value_bool === null || row.value_bool === undefined ? null : !!row.value_bool,
    value_number: normalizedNumber === null
      ? null
      : (isIntegerLikeScreeningCriterion(row) ? Math.round(normalizedNumber) : normalizedNumber),
    value_date: row.value_date ? String(row.value_date).slice(0, 10) : null,
    value_text: row.value_text === null || row.value_text === undefined || row.value_text === "" ? null : String(row.value_text),
  };
}

function screeningCriteriaDirty() {
  const a = (screeningCriteriaCurrent || []).map(normalizeScreeningCriterionForSave);
  const b = (screeningCriteriaOriginal || []).map(normalizeScreeningCriterionForSave);
  return JSON.stringify(a) !== JSON.stringify(b);
}

function updateScreeningSaveState() {
  const dirty = !!selectedScreeningProfileId && screeningCriteriaDirty();
  setScreeningSaveButtonsLabel(screeningSaveUiState === "saving" ? "Saving..." : "Save Changes");
  setScreeningSaveButtonsDisabled(!dirty || screeningSaveUiState === "saving");
  if (screeningSaveUiState === "saving") {
    setScreeningSaveFeedback("saving", "Saving...");
    return;
  }
  if (screeningSaveUiState === "error") {
    setScreeningSaveFeedback("error", "Could not save changes");
    return;
  }
  if (dirty) {
    setScreeningSaveFeedback("unsaved", "Unsaved changes");
    return;
  }
  if (screeningSaveUiState !== "saved" && screeningSaveUiState !== "error") {
    setScreeningSaveFeedback("idle", "");
  }
}

function markScreeningEdited() {
  if (screeningSaveUiState !== "saving") screeningSaveUiState = "idle";
}

function getSelectedScreeningProfile() {
  return (screeningProfiles || []).find((p) => String(p.id) === String(selectedScreeningProfileId)) || null;
}

function setScreeningActionButtonState() {
  const selected = getSelectedScreeningProfile();
  const hasSelected = !!selected;
  const isDefault = !!selected?.is_default;

  const renameBtn = document.getElementById("btn-screening-rename-profile");
  const deleteBtn = document.getElementById("btn-screening-delete-profile");
  const defaultBtn = document.getElementById("btn-screening-set-default");

  if (renameBtn) renameBtn.disabled = !hasSelected;
  if (deleteBtn) deleteBtn.disabled = !hasSelected || isDefault;
  if (defaultBtn) defaultBtn.disabled = !hasSelected || isDefault;
}

function renderScreeningProfiles() {
  const host = document.getElementById("screening-profiles-list");
  if (!host) return;

  if (!screeningProfiles.length) {
    selectedScreeningProfileId = null;
    screeningCriteriaOriginal = [];
    screeningCriteriaCurrent = [];
    screeningRuleGroups = [];
    host.innerHTML = `<div class="muted">No screening profiles yet. Create one to start.</div>`;
    renderScreeningCriteria([]);
    renderScreeningRuleGroups();
    setScreeningActionButtonState();
    updateScreeningSaveState();
    return;
  }

  if (!selectedScreeningProfileId || !screeningProfiles.some((p) => String(p.id) === String(selectedScreeningProfileId))) {
    const fallback = screeningProfiles.find((p) => p.is_default) || screeningProfiles[0];
    selectedScreeningProfileId = fallback?.id || null;
  }

  host.innerHTML = screeningProfiles.map((p) => {
    const isSelected = String(p.id) === String(selectedScreeningProfileId);
    return `
      <button class="screening-profile-pill ${isSelected ? "is-selected" : ""}" data-screening-profile-id="${p.id}">
        <span class="screening-profile-pill__name">${escapeHtml(p.profile_name || "Untitled")}</span>
        <span class="screening-profile-pill__meta">
          ${p.is_default ? `<span class="pill-badge pill-badge--on">DEFAULT</span>` : ``}
          ${p.is_active ? `` : `<span class="pill-badge">INACTIVE</span>`}
        </span>
      </button>
    `;
  }).join("");

  host.querySelectorAll("[data-screening-profile-id]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const profileId = btn.getAttribute("data-screening-profile-id");
      if (!profileId || String(profileId) === String(selectedScreeningProfileId)) return;
      selectedScreeningProfileId = profileId;
      renderScreeningProfiles();
      await loadScreeningCriteria(profileId);
    });
  });

  setScreeningActionButtonState();
  updateScreeningSaveState();
}

function renderScreeningCriteria(criteria = []) {
  const host = document.getElementById("screening-criteria-list");
  if (!host) return;

  if (!selectedScreeningProfileId) {
    host.innerHTML = `<div class="muted">Select a screening profile to configure criteria.</div>`;
    updateScreeningSaveState();
    return;
  }

  if (!criteria.length) {
    host.innerHTML = `<div class="muted">No active screening criteria were found.</div>`;
    updateScreeningSaveState();
    return;
  }

  const grouped = criteria.reduce((acc, row, idx) => {
    const category = String(row.category || "Other").trim() || "Other";
    if (!acc[category]) acc[category] = [];
    acc[category].push({ row, idx });
    return acc;
  }, {});

  const sectionHtml = Object.entries(grouped).map(([category, rows]) => {
    const enabledCount = rows.filter(({ row }) => row.is_enabled).length;
    const cardsHtml = rows.map(({ row, idx }) => {
      const type = String(row.value_type || "").toUpperCase();
      const operatorOptions = operatorOptionsForRow(row);
      const isEnabled = !!row.is_enabled;
      const description = row.description ? `<div class="screening-criterion-desc">${escapeHtml(row.description)}</div>` : "";
      const assignedGroup = row.group_id ? getScreeningGroupById(row.group_id) : null;
      const groupDisplay = assignedGroup
        ? `<div class="screening-assigned-group">Assigned Group: ${escapeHtml(assignedGroup.group_name || "Untitled Group")}</div>`
        : "";

      const operatorSelect = `
        <label class="screening-field">
          <span class="screening-field-label">Operator</span>
          <select class="api-input screening-select" data-screening-operator="${idx}">
            ${operatorOptions.map((op) => `<option value="${op}" ${normalizeOperator(row.comparison_operator) === op ? "selected" : ""}>${escapeHtml(OPERATOR_LABELS[op] || op)}</option>`).join("")}
          </select>
        </label>
      `;

      let valueControl = "";
      if (type === "NUMBER") {
        const needsValue = row.value_number === null || row.value_number === undefined || row.value_number === "";
        const hasFractionalValue = isIntegerLikeScreeningCriterion(row) && Number.isFinite(Number(row.value_number)) && Number(row.value_number) % 1 !== 0;
        const numberStep = isIntegerLikeScreeningCriterion(row) ? "1" : "any";
        valueControl = `
          <label class="screening-field">
            <span class="screening-field-label">Value</span>
            <input class="api-input ${needsValue || hasFractionalValue ? "screening-value-missing" : ""}" type="number" step="${numberStep}" placeholder="Enter value" data-screening-value="value_number" data-idx="${idx}" value="${formatNumberForDisplay(row, row.value_number)}">
            ${needsValue ? `<span class="screening-field-note">Add a value to complete this rule.</span>` : ""}
            ${hasFractionalValue ? `<span class="screening-field-note">Whole numbers only.</span>` : ""}
          </label>
        `;
      } else if (type === "DATE") {
        const value = row.value_date ? String(row.value_date).slice(0, 10) : "";
        valueControl = `
          <label class="screening-field">
            <span class="screening-field-label">Date</span>
            <input class="api-input" type="date" data-screening-value="value_date" data-idx="${idx}" value="${value}">
          </label>
        `;
      } else if (type === "ENUM") {
        const options = normalizeEnumOptions(row.enum_options);
        const op = normalizeOperator(row.comparison_operator) || criterionDefaultOperator(row);
        const selectedValues = parseEnumSelections(row.value_text);
        const isMultiSelect = SCREENING_MULTI_ENUM_OPERATORS.has(op);
        if (isMultiSelect) {
          const opts = options.map((opt) => {
            const checked = selectedValues.includes(opt.value) ? "checked" : "";
            return `<label class="screening-enum-check"><input type="checkbox" data-screening-enum-multi="${idx}" value="${escapeHtml(opt.value)}" ${checked}><span>${escapeHtml(opt.label)}</span></label>`;
          }).join("");
          valueControl = `
            <fieldset class="screening-field screening-enum-group">
              <span class="screening-field-label">Values</span>
              <div class="screening-enum-checklist">${opts}</div>
              <span class="screening-field-note">Select one or more values.</span>
            </fieldset>
          `;
        } else {
          const selectedSingle = selectedValues[0] || "";
          const opts = options.map((opt) => `<option value="${escapeHtml(opt.value)}" ${selectedSingle === String(opt.value) ? "selected" : ""}>${escapeHtml(opt.label)}</option>`).join("");
          valueControl = `
            <label class="screening-field">
              <span class="screening-field-label">Value</span>
              <select class="api-input screening-select" data-screening-value="value_text" data-idx="${idx}">${opts}</select>
            </label>
          `;
        }
      }

      return `
        <article class="screening-rule-card ${isEnabled ? "is-enabled" : "is-disabled"}">
          <label class="screening-rule-head">
            <input type="checkbox" data-screening-enabled="${idx}" ${isEnabled ? "checked" : ""}>
            <span class="screening-rule-title">${escapeHtml(row.label || row.criteria_key || "Criterion")}</span>
          </label>
          ${description}
          ${isEnabled ? `
            <div class="screening-rule-body">
              ${groupDisplay}
              <div class="screening-fields">${operatorSelect}${valueControl}</div>
              <div class="screening-preview-label">Rule Preview</div>
              <div class="screening-rule-preview">${escapeHtml(screeningRulePreview(row))}</div>
            </div>
          ` : ""}
        </article>
      `;
    }).join("");

    return `
      <section class="screening-category-section">
        <header class="screening-category-head">
          <h3>${escapeHtml(category)}</h3>
          <span class="screening-category-meta">${enabledCount}/${rows.length} enabled</span>
        </header>
        <div class="screening-category-list">${cardsHtml}</div>
      </section>
    `;
  }).join("");

  host.innerHTML = sectionHtml;

  host.querySelectorAll("[data-screening-enabled]").forEach((el) => {
    el.addEventListener("change", () => {
      const idx = Number(el.getAttribute("data-screening-enabled"));
      const row = screeningCriteriaCurrent[idx];
      if (!row) return;
      row.is_enabled = el.checked;
      if (row.is_enabled) ensureScreeningDefaults(row);
      if (!row.is_enabled) row.group_id = null;
      markScreeningEdited();
      renderScreeningCriteria(screeningCriteriaCurrent);
      updateScreeningSaveState();
    });
  });

  host.querySelectorAll("[data-screening-operator]").forEach((el) => {
    el.addEventListener("change", () => {
      const idx = Number(el.getAttribute("data-screening-operator"));
      const row = screeningCriteriaCurrent[idx];
      if (!row) return;
      row.comparison_operator = normalizeOperator(el.value);
      if (String(row.value_type || "").toUpperCase() === "BOOLEAN") {
        row.value_bool = row.comparison_operator !== "IS_FALSE";
      } else if (String(row.value_type || "").toUpperCase() === "ENUM") {
        const selectedValues = parseEnumSelections(row.value_text);
        if (SCREENING_MULTI_ENUM_OPERATORS.has(row.comparison_operator)) {
          row.value_text = selectedValues.join(", ");
        } else {
          row.value_text = selectedValues[0] || null;
        }
      }
      markScreeningEdited();
      renderScreeningCriteria(screeningCriteriaCurrent);
      updateScreeningSaveState();
    });
  });

  host.querySelectorAll("[data-screening-value]").forEach((el) => {
    el.addEventListener("input", () => {
      const idx = Number(el.getAttribute("data-idx"));
      const key = el.getAttribute("data-screening-value");
      const row = screeningCriteriaCurrent[idx];
      if (!row) return;
      if (key === "value_number") row.value_number = normalizeNumberForCriterion(row, el.value);
      if (key === "value_date") row.value_date = el.value || null;
      if (key === "value_text") row.value_text = el.value || null;
      markScreeningEdited();
      updateScreeningSaveState();
      const previewEl = host.querySelector(`.screening-rule-card input[data-screening-enabled="${idx}"]`)?.closest('.screening-rule-card')?.querySelector('.screening-rule-preview');
      if (previewEl) previewEl.textContent = screeningRulePreview(row);
    });

    el.addEventListener("blur", () => {
      const idx = Number(el.getAttribute("data-idx"));
      const key = el.getAttribute("data-screening-value");
      const row = screeningCriteriaCurrent[idx];
      if (!row || key !== "value_number" || !isIntegerLikeScreeningCriterion(row)) return;
      if (row.value_number === null || row.value_number === undefined || row.value_number === "") return;
      const numeric = Number(row.value_number);
      if (!Number.isFinite(numeric)) return;
      if (numeric % 1 !== 0) {
        row.value_number = Math.round(numeric);
        renderScreeningCriteria(screeningCriteriaCurrent);
      }
    });
  });

  host.querySelectorAll("[data-screening-enum-multi]").forEach((el) => {
    el.addEventListener("change", () => {
      const idx = Number(el.getAttribute("data-screening-enum-multi"));
      const row = screeningCriteriaCurrent[idx];
      if (!row) return;
      const checked = Array.from(host.querySelectorAll(`[data-screening-enum-multi="${idx}"]:checked`)).map((input) => input.value).filter(Boolean);
      row.value_text = checked.length ? checked.join(", ") : null;
      markScreeningEdited();
      updateScreeningSaveState();
      const previewEl = host.querySelector(`.screening-rule-card input[data-screening-enabled="${idx}"]`)?.closest('.screening-rule-card')?.querySelector('.screening-rule-preview');
      if (previewEl) previewEl.textContent = screeningRulePreview(row);
    });
  });

  updateScreeningSaveState();
}

function renderScreeningRuleGroups() {
  const host = document.getElementById("screening-groups-list");
  if (!host) return;

  if (!selectedScreeningProfileId) {
    host.innerHTML = `<div class="muted">Select a screening profile to configure rule groups.</div>`;
    return;
  }

  if (!screeningRuleGroups.length) {
    host.innerHTML = `
      <div class="screening-groups-empty">
        <div>Create groups to combine multiple rules.</div>
        <ul>
          <li><strong>All of these</strong> = every rule in the group must match.</li>
          <li><strong>Any of these</strong> = at least one rule in the group must match.</li>
        </ul>
      </div>
    `;
    return;
  }

  host.innerHTML = screeningRuleGroups.map((group) => {
    const criteriaLines = (group.criteria || [])
      .map((criterion) => `<li>${escapeHtml(criterion.label || criterion.criteria_key || "Criterion")}</li>`)
      .join("");
    return `
      <article class="screening-group-card ${group.is_active ? "" : "is-inactive"}" data-screening-group-card="${group.id}">
        <div class="screening-group-head">
          <div>
            <div class="screening-group-title">${escapeHtml(group.group_name || "Untitled Group")}</div>
            <div class="screening-group-meta">Assigned rules: ${(group.criteria || []).length}</div>
          </div>
          <div class="screening-group-controls">
            <label class="screening-group-match">
              <span class="screening-field-label">Match Type: ${escapeHtml(labelForScreeningGroupMatch(group))}</span>
              <select class="api-input screening-select" data-screening-group-match-select="${group.id}">
                <option value="ALL" ${normalizeScreeningMatchType(group.match_type) === "ALL" ? "selected" : ""}>All of these</option>
                <option value="ANY" ${normalizeScreeningMatchType(group.match_type) === "ANY" ? "selected" : ""}>Any of these</option>
              </select>
            </label>
            <div class="row-actions">
              <button class="btn-primary" data-screening-group-assign="${group.id}">Assign Rules</button>
              <button class="btn-ghost" data-screening-group-rename="${group.id}">Rename</button>
              <button class="btn-ghost" data-screening-group-delete="${group.id}">Delete</button>
            </div>
          </div>
        </div>
        ${criteriaLines ? `<ul class="screening-group-criteria">${criteriaLines}</ul>` : `<div class="muted">No rules assigned yet.</div>`}
      </article>
    `;
  }).join("");

  host.querySelectorAll("[data-screening-group-rename]").forEach((button) => {
    button.addEventListener("click", () => {
      const groupId = button.getAttribute("data-screening-group-rename");
      const group = getScreeningGroupById(groupId);
      if (!group || !selectedScreeningProfileId) return;
      openScreeningRuleGroupRenameModal(group);
    });
  });

  host.querySelectorAll("[data-screening-group-assign]").forEach((button) => {
    button.addEventListener("click", () => {
      const groupId = button.getAttribute("data-screening-group-assign");
      const group = getScreeningGroupById(groupId);
      if (!group || !selectedScreeningProfileId) return;
      openScreeningRuleGroupAssignModal(group);
    });
  });

  host.querySelectorAll("[data-screening-group-match-select]").forEach((selectEl) => {
    selectEl.addEventListener("change", async () => {
      const groupId = selectEl.getAttribute("data-screening-group-match-select");
      const group = getScreeningGroupById(groupId);
      if (!group || !selectedScreeningProfileId) return;
      const next = normalizeScreeningMatchType(selectEl.value);
      await apiPatch(`/api/screening/profiles/${encodeURIComponent(selectedScreeningProfileId)}/groups/${encodeURIComponent(group.id)}`, {
        match_type: next,
      });
      await loadScreeningCriteria(selectedScreeningProfileId);
    });
  });

  host.querySelectorAll("[data-screening-group-delete]").forEach((button) => {
    button.addEventListener("click", async () => {
      const groupId = button.getAttribute("data-screening-group-delete");
      const group = getScreeningGroupById(groupId);
      if (!group || !selectedScreeningProfileId) return;
      if (!confirm(`Delete rule group "${group.group_name}"?`)) return;
      await apiDelete(`/api/screening/profiles/${encodeURIComponent(selectedScreeningProfileId)}/groups/${encodeURIComponent(group.id)}`);
      await loadScreeningCriteria(selectedScreeningProfileId);
    });
  });
}

async function loadScreeningRuleGroups(profileId) {
  if (!profileId) {
    screeningRuleGroups = [];
    renderScreeningRuleGroups();
    return;
  }
  const data = await apiGet(`/api/screening/profiles/${encodeURIComponent(profileId)}/groups`);
  screeningRuleGroups = Array.isArray(data?.groups) ? data.groups : [];
  renderScreeningRuleGroups();
}

async function loadScreeningProfiles() {
  const data = await apiGet("/api/screening/profiles");
  screeningProfiles = Array.isArray(data?.profiles) ? data.profiles : [];
  renderScreeningProfiles();
  if (selectedScreeningProfileId) {
    await loadScreeningCriteria(selectedScreeningProfileId);
  } else {
    screeningCriteriaOriginal = [];
    screeningCriteriaCurrent = [];
    screeningRuleGroups = [];
    renderScreeningCriteria([]);
    renderScreeningRuleGroups();
  }
}

async function loadScreeningCriteria(profileId) {
  if (!profileId) return;
  screeningSaveUiState = "idle";
  setScreeningSaveFeedback("idle", "");
  const data = await apiGet(`/api/screening/profiles/${encodeURIComponent(profileId)}/criteria`);
  const rows = Array.isArray(data?.criteria) ? data.criteria : [];
  screeningCriteriaOriginal = clone(rows);
  screeningCriteriaCurrent = clone(rows);
  screeningCriteriaCurrent.forEach((row) => {
    if (row?.is_enabled) ensureScreeningDefaults(row);
  });
  await loadScreeningRuleGroups(profileId);
  renderScreeningCriteria(screeningCriteriaCurrent);
}

async function saveScreeningCriteria() {
  if (!selectedScreeningProfileId) return;
  if (screeningSaveUiState === "saving") return;
  screeningSaveUiState = "saving";
  updateScreeningSaveState();
  try {
    const payload = screeningCriteriaCurrent.map((row) => {
      const norm = normalizeScreeningCriterionForSave(row);
      if (norm.value_number !== null && Number.isNaN(norm.value_number)) {
        throw new Error(`Invalid number for ${row.label || row.criteria_key}`);
      }
      return norm;
    });

    await apiPost(`/api/screening/profiles/${encodeURIComponent(selectedScreeningProfileId)}/criteria`, {
      criteria: payload,
    });

    await loadScreeningCriteria(selectedScreeningProfileId);
    screeningSaveUiState = "saved";
    setScreeningSaveFeedback("saved", "Changes saved");
  } catch (err) {
    screeningSaveUiState = "error";
    setScreeningSaveFeedback("error", "Could not save changes");
    throw err;
  } finally {
    updateScreeningSaveState();
  }
}

async function createScreeningProfile() {
  const name = prompt("Name your new screening profile:");
  if (!name || !String(name).trim()) return;
  await apiPost("/api/screening/profiles", { profile_name: String(name).trim() });
  await loadScreeningProfiles();
}

async function renameScreeningProfile() {
  const selected = getSelectedScreeningProfile();
  if (!selected) return;
  const next = prompt("Rename screening profile:", selected.profile_name || "");
  if (!next || !String(next).trim()) return;
  await apiPatch(`/api/screening/profiles/${encodeURIComponent(selected.id)}`, { profile_name: String(next).trim() });
  await loadScreeningProfiles();
}

async function deleteScreeningProfile() {
  const selected = getSelectedScreeningProfile();
  if (!selected) return;
  if (selected.is_default) {
    alert("Default profile cannot be deleted.");
    return;
  }
  if (!confirm(`Delete screening profile \"${selected.profile_name}\"?`)) return;
  await apiDelete(`/api/screening/profiles/${encodeURIComponent(selected.id)}`);
  await loadScreeningProfiles();
}

async function setDefaultScreeningProfile() {
  const selected = getSelectedScreeningProfile();
  if (!selected) return;
  await apiPost(`/api/screening/profiles/${encodeURIComponent(selected.id)}/set-default`, {});
  await loadScreeningProfiles();
}

async function createScreeningRuleGroup({ groupName, matchType } = {}) {
  if (!selectedScreeningProfileId) return;
  const nextName = String(groupName || "").trim();
  if (!nextName) throw new Error("Group name is required.");

  await apiPost(`/api/screening/profiles/${encodeURIComponent(selectedScreeningProfileId)}/groups`, {
    group_name: nextName,
    match_type: normalizeScreeningMatchType(matchType),
  });
  await loadScreeningCriteria(selectedScreeningProfileId);
}



  function renderPlans(plan) {
    const el = $("plan-grid");
    if (!el) return;

    const plans = plan?.available || [
      { id: "starter", name: "Starter", desc: "Lightweight monitoring for small teams." },
      { id: "pro", name: "Pro", desc: "More watched carriers, faster refresh, richer alerts." },
      { id: "team", name: "Team", desc: "Multi-user workflows and shared monitoring." },
    ];

    const current = plan?.current_id;

    el.innerHTML = plans
      .map((p) => {
        const active = p.id === current;
        return `
          <div class="card" style="padding:14px;">
            <div class="card-head">
              <h2 style="font-size:.95rem;">${p.name}</h2>
              ${active ? `<span class="badge">Current</span>` : ``}
            </div>
            <div class="muted" style="margin-top:0;">${p.desc}</div>
            <div style="margin-top:12px;">
              <button class="pill-btn ${active ? "pill-btn-secondary" : ""}" data-select-plan="${p.id}">
                ${active ? "Selected" : "Select"}
              </button>
            </div>
          </div>
        `;
      })
      .join("");
  }

function getSaveButtons() {
  return [
    document.getElementById("btn-save-alert-fields"),
    document.getElementById("btn-save-alert-fields-top"),
  ].filter(Boolean);
}

function setSaveButtonsDisabled(disabled) {
  getSaveButtons().forEach((b) => (b.disabled = !!disabled));
}

function setSaveButtonsLabel(text) {
  getSaveButtons().forEach((b) => { b.textContent = text; });
}

function getScreeningSaveButtons() {
  return [
    document.getElementById("btn-screening-save"),
    document.getElementById("btn-screening-save-top"),
  ].filter(Boolean);
}

function setScreeningSaveButtonsDisabled(disabled) {
  getScreeningSaveButtons().forEach((b) => { b.disabled = !!disabled; });
}

function setScreeningSaveButtonsLabel(text) {
  getScreeningSaveButtons().forEach((b) => { b.textContent = text; });
}


// -----------------------------
// Email alert fields (per-user)
// -----------------------------
let emailFieldsOriginal = [];
let emailFieldsCurrent = [];

function clone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function renderEmailAlertFields(fields) {
  const host = document.getElementById("email-alert-fields");
  if (!host) return;

  // group by category
  const groups = new Map();
  for (const f of fields) {
    const cat = f.category || "Other";
    if (!groups.has(cat)) groups.set(cat, []);
    groups.get(cat).push(f);
  }

  host.innerHTML = Array.from(groups.entries()).map(([cat, items]) => {
    const inner = items.map((f) => {
      const checked = f.enabled ? "checked" : "";
      const label = f.label || f.field_key;
      return `
        <label class="toggle">
          <input type="checkbox" data-field-key="${f.field_key}" ${checked}>
          <span>${label}</span>
        </label>
      `;
    }).join("");

    return `
      <div class="alert-cat">
        <div class="alert-cat-title">${cat}</div>
        <div class="toggle-grid">
          ${inner}
        </div>
      </div>
    `;
  }).join("");

  // bind changes
  host.querySelectorAll('input[type="checkbox"][data-field-key]').forEach((cb) => {
    cb.addEventListener("change", () => {
      const key = cb.getAttribute("data-field-key");
      const row = emailFieldsCurrent.find((x) => x.field_key === key);
      if (row) row.enabled = cb.checked;
      if (emailSaveUiState !== "saving") emailSaveUiState = "idle";
      updateEmailFieldsSaveState();
    });
  });
}

function updateEmailFieldsSaveState() {
  const dirty =
    JSON.stringify(emailFieldsCurrent) !== JSON.stringify(emailFieldsOriginal);

  setSaveButtonsLabel(emailSaveUiState === "saving" ? "Saving..." : "Save changes");
  // enable/disable BOTH buttons
  setSaveButtonsDisabled(!dirty || emailSaveUiState === "saving");
  if (emailSaveUiState === "saving") {
    setEmailSaveFeedback("saving", "Saving...");
    return;
  }
  if (emailSaveUiState === "error") {
    setEmailSaveFeedback("error", "Could not save changes");
    return;
  }
  if (dirty) {
    setEmailSaveFeedback("unsaved", "Unsaved changes");
    return;
  }
  if (emailSaveUiState !== "saved" && emailSaveUiState !== "error") {
    setEmailSaveFeedback("idle", "");
  }
}


async function loadEmailAlertFields() {
  // You implement these endpoints on backend
  const data = await apiGet("/api/account/email-alert-fields");
  const fields = data?.fields || [];

  emailFieldsOriginal = clone(fields);
  emailFieldsCurrent  = clone(fields);
  emailSaveUiState = "idle";
  setEmailSaveFeedback("idle", "");

  renderEmailAlertFields(emailFieldsCurrent);
  updateEmailFieldsSaveState();
}

async function saveEmailAlertFields() {
  if (emailSaveUiState === "saving") return;
  emailSaveUiState = "saving";
  // disable BOTH while saving
  updateEmailFieldsSaveState();

  // send only changes
  const updates = [];
  const origMap = new Map(emailFieldsOriginal.map((x) => [x.field_key, x.enabled]));
  for (const cur of emailFieldsCurrent) {
    if (origMap.get(cur.field_key) !== cur.enabled) {
      updates.push({ field_key: cur.field_key, enabled: cur.enabled });
    }
  }

  // nothing to save -> keep disabled
  if (!updates.length) {
    emailSaveUiState = "idle";
    updateEmailFieldsSaveState();
    return;
  }
  try {
    await apiPost("/api/account/email-alert-fields", { updates });
    emailFieldsOriginal = clone(emailFieldsCurrent);
    emailSaveUiState = "saved";
    setEmailSaveFeedback("saved", "Changes saved");
  } catch (err) {
    emailSaveUiState = "error";
    setEmailSaveFeedback("error", "Could not save changes");
    throw err;
  } finally {
    updateEmailFieldsSaveState(); // will disable both now (not dirty)
  }
}


function setAgreementsDefaultButtonState() {
  const btn = document.getElementById("btn-set-default");
  if (!btn) return;
  btn.disabled = !agreementsSelectedId;
}


// -----------------------------
// Email Alerts lock overlay
// -----------------------------
function applyEmailAlertsLock(user) {
  const overlay = document.getElementById("email-alerts-locked");
  if (!overlay) return;

  const enabled =
    user?.email_alerts === true ||
    user?.email_alerts === "Y" ||
    String(user?.email_alerts).toUpperCase() === "Y";

  overlay.style.display = enabled ? "none" : "flex";
}


function applyBillingLock(user) {
  const overlay = document.getElementById("billing-locked");
  if (!overlay) return;

  const plan = String(user?.plan || user?.user?.plan || "").trim().toUpperCase();
  const billingEnabled = plan !== "STARTER";

  overlay.style.display = billingEnabled ? "none" : "flex";
}

  
function setAlertsSwitchColor(enabled) {
  const wrap = document.querySelector(".alerts-switch-wrap");
  if (!wrap) return;

  wrap.classList.toggle("is-on", !!enabled);
  wrap.classList.toggle("is-off", !enabled);
}

function setAlertsFooter(enabled) {
  const wrap = document.querySelector(".alerts-switch-wrap");
  const footer = document.getElementById("alerts-footer-status");
  if (!wrap || !footer) return;

  wrap.classList.add("has-choice"); // <-- makes footer visible
  footer.textContent = enabled ? "Email alerts turned on" : "Email alerts turned off";

  footer.classList.toggle("is-on", !!enabled);
  footer.classList.toggle("is-off", !enabled);
}


  
// -----------------------------
// Email Alerts master switch (enabled on/off)
// -----------------------------
async function loadEmailAlertsEnabled(me) {
  const toggle = document.getElementById("alerts-enabled");
  if (!toggle) return;

  const wrap = document.querySelector(".alerts-switch-wrap");
  const footer = document.getElementById("alerts-footer-status");

  // 1) Always start: footer blank + hidden (no confirmation on load)
  if (wrap) wrap.classList.remove("has-choice");
  if (footer) {
    footer.textContent = "";
    footer.classList.remove("is-on", "is-off");
  }

  // 2) Make the SWITCH show *something* immediately (default unchecked => red)
  setAlertsSwitchColor(toggle.checked);

  // 3) If plan doesn’t include email alerts, lock it off
  if (me?.email_alerts !== true) {
    toggle.checked = false;
    toggle.disabled = true;
    setAlertsSwitchColor(false);
    return;
  }

  toggle.disabled = false;

  // 4) Load saved value, set switch color to match (still no footer text)
  try {
    const r = await fetch("/api/account/email-alerts-enabled", { credentials: "include" });
    if (!r.ok) throw new Error(`GET failed: ${r.status}`);

    const data = await r.json();
    toggle.checked = !!data.email_alerts_enabled;
    setAlertsSwitchColor(toggle.checked);
  } catch (err) {
    console.error("Failed to load email_alerts_enabled:", err);
  }
}


  
// -----------------------------
// Help & Support
// -----------------------------
const helpContactEmail = $("help-contact-email");
const helpContactPhone = $("help-contact-phone");
const helpSubject = $("help-subject");
const helpMessage = $("help-message");
const helpSend = $("btn-help-send");
const ticketList = $("ticket-list");
const helpErr = $("help-error");
const helpOk = $("help-ok");

function setHelpMsg(type, msg){
  helpErr && (helpErr.style.display = "none");
  helpOk && (helpOk.style.display = "none");

  if (type === "error" && helpErr) {
    helpErr.textContent = msg || "Something went wrong.";
    helpErr.style.display = "block";
  }
  if (type === "ok" && helpOk) {
    helpOk.textContent = msg || "Sent.";
    helpOk.style.display = "block";
  }
}

function updateHelpSendState(){
  const email = (helpContactEmail?.value || "").trim();
  const subj  = (helpSubject?.value || "").trim();
  const msg   = (helpMessage?.value || "").trim();

  const okEmail = email.includes("@") && email.length >= 6;
  helpSend.disabled = !(okEmail && subj.length >= 3 && msg.length >= 10);
}

[helpContactEmail, helpContactPhone, helpSubject, helpMessage].forEach((el) => {
  el?.addEventListener("input", updateHelpSendState);
});

function renderTickets(tickets){
  if (!ticketList) return;

  if (!tickets?.length) {
    ticketList.innerHTML = `<div class="muted">No tickets yet.</div>`;
    return;
  }

  ticketList.innerHTML = tickets.map(t => {
    const id = t.public_id || `CS-${String(t.id).padStart(6, "0")}`;
    const subj = escapeHtml(t.subject || "—");
    const when = t.created_at ? new Date(t.created_at).toLocaleString() : "";
    const status = escapeHtml(t.status || "open");
    return `
      <div class="ticket-item">
        <div class="ticket-top">
          <div class="ticket-id">${id}</div>
          <div class="ticket-meta">${status}</div>
        </div>
        <div class="ticket-subject">${subj}</div>
        <div class="ticket-meta">${escapeHtml(when)}</div>
      </div>
    `;
  }).join("");
}

// simple escape for innerHTML
function escapeHtml(str){
  return String(str ?? "")
    .replaceAll("&","&amp;")
    .replaceAll("<","&lt;")
    .replaceAll(">","&gt;")
    .replaceAll('"',"&quot;")
    .replaceAll("'","&#039;");
}

async function loadTickets(){
  if (!ticketList) return;
  ticketList.innerHTML = `<div class="muted">Loading…</div>`;

  const r = await fetch("/api/support/tickets", { credentials: "include" });
  if (!r.ok) {
    const text = await r.text().catch(() => "");
    console.error("GET /api/support/tickets failed:", r.status, text);
    ticketList.innerHTML = `<div class="muted">Couldn’t load tickets (${r.status}).</div>`;
    return;
  }
  const data = await r.json();
  renderTickets(data.tickets || []);
}

helpSend?.addEventListener("click", async () => {
  const contact_email = (helpContactEmail?.value || "").trim();
  const contact_phone = (helpContactPhone?.value || "").trim();
  const subject = (helpSubject?.value || "").trim();
  const message = (helpMessage?.value || "").trim();

  helpSend.disabled = true;
  setHelpMsg(null, "");

  try {
    const r = await fetch("/api/support/tickets", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contact_email, contact_phone, subject, message }),
    });

    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || "Failed to send.");

    const id = data.public_id || `CS-${String(data.ticket_id).padStart(6, "0")}`;
    setHelpMsg("ok", `Sent. ${id}`);
    // clear message only (keep contact info)
    helpSubject.value = "";
    helpMessage.value = "";
    updateHelpSendState();
    await loadTickets();
  } catch (e) {
    console.error(e);
    setHelpMsg("error", e.message || "Could not send.");
    updateHelpSendState();
  }
});

// API section lock/unlock helpers

  function setLocked(rowId, lockedId, locked) {
  const row = document.getElementById(rowId);
  const msg = document.getElementById(lockedId);
  if (row) row.classList.toggle("is-locked", !!locked);
  if (msg) msg.style.display = locked ? "flex" : "none";
}

function setDisabled(id, disabled) {
  const el = document.getElementById(id);
  if (el) el.disabled = !!disabled;
}

function setAlertsSwitchColor(checked) {
  const wrap = document.querySelector(".alerts-switch-wrap");
  if (!wrap) return;

  wrap.classList.toggle("is-on", !!checked);
  wrap.classList.toggle("is-off", !checked);
}

  
function setAlertsFooter(checked) {
  const wrap = document.querySelector(".alerts-switch-wrap");
  const footer = document.getElementById("alerts-footer-status");
  if (!wrap || !footer) return;

  // once user flips it, we "confirm" visually
  wrap.classList.add("has-choice");

  footer.textContent = checked ? "Email alerts turned on" : "Email alerts turned off";
  footer.classList.toggle("is-on", !!checked);
  footer.classList.toggle("is-off", !checked);
}


// -----------------------------
// Plan picker (table version)
// -----------------------------
function normalizePlanId(v) {
  const s = String(v || "").trim().toLowerCase();
  // if your backend uses different names, map them here.
  if (s === "core") return "core";
  if (s === "pro") return "pro";
  if (s === "enterprise") return "enterprise";
  return ""; // unknown
}


function initAccountPlanPicker({ currentPlanId, subscriptionStatus }) {
  const selectedInput = document.getElementById("selected-plan");   // hidden input
  const continueBtn   = document.getElementById("continue-btn");    // your nice button
  const helper        = document.getElementById("stripe-helper");
  const planForm      = document.getElementById("plan-form");       // form wrapper (recommended)

  // If this tab/page doesn't have the table, bail.
  if (!selectedInput || !continueBtn) return;

  const current = normalizePlanId(currentPlanId);

  const currentBadge = document.getElementById("current-plan-badge");
  if (currentBadge) {
    currentBadge.textContent = current ? `Current: ${current.toUpperCase()}` : "Current: —";
  }

  function setSelected(planId) {
    const plan = normalizePlanId(planId);
    if (!plan) return;

    // Don't allow selecting the current plan
    if (current && plan === current) {
      selectedInput.value = "";
      updateUI("");
      return;
    }

    selectedInput.value = plan;
    updateUI(plan);
  }

  function updateUI(selected) {
    const plan = normalizePlanId(selected);

    // Highlight selected column (whole body)
    document.querySelectorAll("[data-plan-col]").forEach((cell) => {
      cell.classList.toggle("is-selected", plan && cell.dataset.planCol === plan);
    });

    // Radio dot fill (if your markup uses .plan-radio inside the header)
    document.querySelectorAll("[data-plan-col] .plan-radio").forEach((dot) => {
      const col = dot.closest("[data-plan-col]")?.dataset?.planCol;
      dot.classList.toggle("is-on", plan && col === plan);
    });

    // Disable current-plan select buttons + show CURRENT label
    document.querySelectorAll("[data-plan-btn]").forEach((btn) => {
      const btnPlan = normalizePlanId(btn.dataset.planBtn);
      const isCurrent = current && btnPlan === current;
      btn.disabled = !!isCurrent;
      btn.classList.toggle("is-current", !!isCurrent);
      btn.textContent = isCurrent ? "CURRENT" : "SELECT";
    });

    // Continue button state + helper
    if (!plan) {
      continueBtn.disabled = true;
      continueBtn.textContent = "Current Plan";
      if (helper) helper.style.display = "none";
      return;
    }

    continueBtn.disabled = false;
    continueBtn.textContent = "Finalize upgrade in Stripe →";
    if (helper) helper.style.display = "block";
  } // ✅ IMPORTANT: closes updateUI()

  // ✅ Bind events ONCE (not inside updateUI)
  document.querySelectorAll("[data-plan-col]").forEach((el) => {
    el.style.cursor = "pointer";
    el.addEventListener("click", () => setSelected(el.dataset.planCol));
  });

  document.querySelectorAll("[data-plan-btn]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      setSelected(btn.dataset.planBtn);
    });
  });

  // Submit -> upgrade flow:
  // - Existing subscribers: go straight to Stripe Billing Portal
  // - New customers: continue through the retained activation page
  const submitHandler = async (e) => {
    const plan = normalizePlanId(selectedInput.value);
    if (!plan) {
      e.preventDefault();
      return;
    }

    const s = String(subscriptionStatus || "").toLowerCase();
    const isExistingSubscriber = ["active", "trialing", "past_due", "canceled", "unpaid"].includes(s);

    if (isExistingSubscriber) {
      continueBtn.disabled = true;
      const oldText = continueBtn.textContent;
      continueBtn.textContent = "Opening billing…";

      try {
        const r = await fetch("/api/billing/portal", {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ returnPath: "/account?tab=plan" }),
        });

        const data = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(data?.error || `Portal failed: ${r.status}`);
        if (!data?.url) throw new Error("Missing portal URL");

        window.location.href = data.url;
        return;
      } catch (err) {
        console.error(err);
        alert("Could not open billing portal. Try again.");
        continueBtn.disabled = false;
        continueBtn.textContent = oldText;
        return;
      }
    }

    // New / not subscribed yet
    window.location.href = `/activate-plan?plan=${encodeURIComponent(plan)}`;
  };

  if (planForm) {
    planForm.addEventListener("submit", (e) => {
      e.preventDefault();
      submitHandler(e);
    });
  } else {
    continueBtn.addEventListener("click", (e) => {
      e.preventDefault();
      submitHandler(e);
    });
  }

  // Initial state
  updateUI("");
}
  
function renderCreditsUsage(me) {
  const card = document.getElementById("usage-card");
  if (!card) return;

  // show card (JS controls it)
  card.style.display = "block";

  // relabel UI (now that card exists)
  const sub = document.getElementById("credits-subtext");
  if (sub) sub.textContent = "Carriers monitored.";

  const usedLabel = card.querySelector(".usage-metric .kv-label");
  if (usedLabel) usedLabel.textContent = "Carriers monitored";

  const src = me?.user ? me.user : me;

  const usedRaw  = src?.credits_used;
  const limitRaw = src?.credits_limit;

  const used  = Number(usedRaw);
  const limit = Number(limitRaw);

  const usedEl = document.getElementById("credits-used");
  const limEl  = document.getElementById("credits-limit");
  const barEl  = document.getElementById("credits-bar");
  const badge  = document.getElementById("credits-badge");
  const foot   = document.getElementById("credits-footnote");

  if (usedEl) usedEl.textContent = Number.isFinite(used) ? used.toLocaleString() : "—";
  if (limEl)  limEl.textContent  = Number.isFinite(limit) ? limit.toLocaleString() : "—";

  if (!Number.isFinite(used) || !Number.isFinite(limit) || limit <= 0) {
    if (barEl) barEl.style.width = "0%";
    if (badge) badge.textContent = "—";
    if (foot)  foot.textContent = "Carrier monitoring usage will appear here.";
    card.classList.remove("is-usage-warn");
    return;
  }

  const pct = Math.max(0, Math.min(100, Math.round((used / limit) * 100)));
  if (barEl) barEl.style.width = `${pct}%`;
  if (badge) badge.textContent = `${pct}% of limit`;

  const remaining = Math.max(0, limit - used);
  if (foot) foot.textContent = `${remaining.toLocaleString()} carrier slots remaining`;

  card.classList.toggle("is-usage-warn", pct >= 90);
}
  
  // -----------------------------
  // Main load
  // -----------------------------
  async function loadEverything() {
    // 1) Snapshot
    const me = await apiGet("/api/account/overview");
    
    // You need your backend to include member role on the response.
    // Prefer: me.role (or me.user.role)
    applyTabAccessByRole(me?.company_role || me?.user?.company_role);


    if ($("me-name")) $("me-name").textContent = me?.name || me?.user?.name || "—";
    if ($("me-email")) $("me-email").textContent = me?.email || me?.user?.email || "—";
    if ($("me-company")) $("me-company").textContent = me?.company || me?.user?.company || "—";
    if ($("account-plan")) $("account-plan").textContent = (me?.plan || me?.user?.plan || "—").toUpperCase();
    
    renderCreditsUsage(me);

const isCanceling =
  me?.cancel_at_period_end === true ||
  me?.user?.cancel_at_period_end === true;

if ($("billing-next-renewal")) {
  if (isCanceling) {
    $("billing-next-renewal").closest(".kv").style.display = "none";
  } else {
    const raw = me?.current_period_end || me?.user?.current_period_end;
    $("billing-next-renewal").textContent =
      raw ? new Date(raw).toLocaleDateString() : "—";
  }
}

    
// Billing tab (safe if fields are missing)
if ($("billing-plan")) $("billing-plan").textContent = me?.plan || me?.user?.plan || "—";

if ($("billing-status")) {
  const s = me?.subscription_status || me?.user?.subscription_status || "—";
  $("billing-status").textContent = String(s).replaceAll("_", " ").toUpperCase();
}

if ($("billing-next-renewal")) {
  const raw = me?.current_period_end || me?.user?.current_period_end;
  $("billing-next-renewal").textContent = raw ? new Date(raw).toLocaleDateString() : "—";
}

renderCancellation({
  cancel_at_period_end: me?.cancel_at_period_end ?? me?.user?.cancel_at_period_end,
  current_period_end: me?.current_period_end ?? me?.user?.current_period_end
});

  // Email Alerts feature gate (single overlay)
  applyEmailAlertsLock(me);
    
    setPlanBadge(me?.plan || me?.user?.plan);

initAccountPlanPicker({
  currentPlanId: me?.plan || me?.user?.plan,
  subscriptionStatus: me?.subscription_status || me?.user?.subscription_status
});

    
    setPill("me-email_alerts", me?.email_alerts);
    setPill("me-rest_alerts", me?.rest_alerts);
    setPill("me-webhook_alerts", me?.webhook_alerts);


    
const canRest = me?.rest_alerts === true;
const canWebhook = me?.webhook_alerts === true;

// Lock/unlock UI
setLocked("api-key-row", "api-key-locked", !canRest);
setLocked("webhook-row", "webhook-locked", !canWebhook);

// Disable buttons/inputs when locked
setDisabled("btn-copy-key", !canRest);
setDisabled("btn-rotate-key", !canRest);

setDisabled("webhook-url", !canWebhook);
setDisabled("btn-save-webhook", true); // stays true until changed (your existing logic)

// Docs require at least one API channel enabled
const docsLocked = !(canRest || canWebhook);
setLocked("docs-row", "docs-locked", docsLocked);
setDisabled("btn-openapi-spec", docsLocked);


    
    // Plan badge: keep it simple for now (no “tier logic”)
   // const planBadge = $("plan-badge");
  // if (planBadge) planBadge.textContent = me?.plan || me?.user?.plan || "—";

// Load per-field categories only if the container exists
if (document.getElementById("email-alert-fields")) {
  await loadEmailAlertFields();
}

    
    // 2) Agreements (only if that section exists)
    if (document.getElementById("agreements-grid")) {
      await loadAgreements();
    }

    if (document.getElementById("screening-profiles-list")) {
      await loadScreeningProfiles();
    }

    // 3) API (only if that section exists)
      if ($("api-key-masked")) {
        // Only fetch API key if REST access is enabled
        if (canRest) {
          const api = await apiGet("/api/user/api");
          $("api-key-masked").textContent = api?.masked_key || "—";
        } else {
          $("api-key-masked").textContent = "Upgrade required";
        }
      
        // Only fetch webhook value if webhook access is enabled
        if (canWebhook) {
          const wh = await apiGet("/api/user/webhook");
          const input = $("webhook-url");
          const btn = $("btn-save-webhook");
      
          if (input && btn) {
            input.value = wh?.webhook_url || "";
            WEBHOOK_ORIGINAL = input.value;
            btn.disabled = true;
      
            input.addEventListener("input", () => {
              btn.disabled = input.value.trim() === WEBHOOK_ORIGINAL;
            });
          }
        } else {
          const input = $("webhook-url");
          if (input) input.value = "";
        }
      }


    // 4) Plan grid (only if you kept that section)
    if ($("plan-grid")) {
      const plan = await apiGet("/api/user/plan");
      renderPlans(plan);
    }

    // Email Alerts feature gate (single overlay)
    applyEmailAlertsLock(me);
    applyBillingLock(me);
    await loadEmailAlertsEnabled(me);
    
  }

getSaveButtons().forEach((btn) => {
  btn.addEventListener("click", () => {
    saveEmailAlertFields().catch(console.error);
  });
});


  
document.getElementById("btn-set-default")?.addEventListener("click", async () => {
  if (!agreementsSelectedId) return;

  try {
    await apiPost("/api/agreements/default", { user_contract_id: agreementsSelectedId });
    await loadAgreements();
  } catch (err) {
    console.error(err);
    alert("Failed to set default agreement.");
  }
});

document.getElementById("btn-save-agreement-requirements")?.addEventListener("click", async () => {
  if (!agreementsSelectedId || !agreementRequirementsCurrent) return;
  if (agreementsSaveUiState === "saving") return;
  agreementsSaveUiState = "saving";
  setAgreementRequirementsSaveState();

  try {
    await apiPatch(`/api/user-contracts/${encodeURIComponent(agreementsSelectedId)}/requirements`, agreementRequirementsCurrent);
    await loadAgreements();
    agreementsSaveUiState = "saved";
    setAgreementsSaveFeedback("saved", "Changes saved");
    setAgreementRequirementsSaveState();
  } catch (err) {
    console.error(err);
    agreementsSaveUiState = "error";
    setAgreementsSaveFeedback("error", "Could not save changes");
    setAgreementRequirementsSaveState();
  }
});

document.getElementById("btn-screening-new-profile")?.addEventListener("click", () => {
  createScreeningProfile().catch((err) => {
    console.error(err);
    alert(err?.message || "Failed to create screening profile.");
  });
});

document.getElementById("btn-screening-rename-profile")?.addEventListener("click", () => {
  renameScreeningProfile().catch((err) => {
    console.error(err);
    alert(err?.message || "Failed to rename screening profile.");
  });
});

document.getElementById("btn-screening-delete-profile")?.addEventListener("click", () => {
  deleteScreeningProfile().catch((err) => {
    console.error(err);
    alert(err?.message || "Failed to delete screening profile.");
  });
});

document.getElementById("btn-screening-set-default")?.addEventListener("click", () => {
  setDefaultScreeningProfile().catch((err) => {
    console.error(err);
    alert(err?.message || "Failed to set default screening profile.");
  });
});

document.getElementById("btn-screening-new-group")?.addEventListener("click", () => {
  openScreeningRuleGroupModal();
});

getScreeningSaveButtons().forEach((btn) => {
  btn.addEventListener("click", () => {
    saveScreeningCriteria().catch((err) => {
      console.error(err);
    });
  });
});



document.getElementById("alerts-enabled")?.addEventListener("change", async (e) => {
  const toggle = e.currentTarget;

  try {
    const r = await fetch("/api/account/email-alerts-enabled", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email_alerts_enabled: toggle.checked }),
    });

    if (!r.ok) {
      const text = await r.text().catch(() => "");
      throw new Error(`POST failed: ${r.status} ${text}`);
    }

    // ✅ show confirmation only AFTER user toggles
    setAlertsSwitchColor(toggle.checked);
    setAlertsFooter(toggle.checked);

    
  } catch (err) {
    console.error("Failed to update email_alerts_enabled:", err);

    // revert UI if save fails (feels premium)
    toggle.checked = !toggle.checked;
    alert("Could not update the email alerts switch. Please try again.");
  }
});


// -----------------------------
// API buttons
// -----------------------------


$("btn-save-webhook")?.addEventListener("click", async () => {
  const input = $("webhook-url");
  if (!input) return;

  const url = input.value.trim();

  try {
    await apiPost("/api/user/webhook", { webhook_url: url });
    WEBHOOK_ORIGINAL = url;
    $("btn-save-webhook").disabled = true;
    alert("Webhook saved.");
  } catch (e) {
    console.error(e);
    alert("Failed to save webhook URL.");
  }
});


  
$("btn-copy-key")?.addEventListener("click", async () => {
  try {
    if (!API_KEY_FULL) {
      alert("For security, the full key is only shown right after rotation. Click Rotate to generate a new one.");
      return;
    }

    await navigator.clipboard.writeText(API_KEY_FULL);
    $("btn-copy-key").textContent = "Copied";
    setTimeout(() => ($("btn-copy-key").textContent = "Copy"), 900);
  } catch (e) {
    console.error(e);
    alert("Copy failed.");
  }
});

$("btn-rotate-key")?.addEventListener("click", async () => {
  if (!confirm("Rotate API key? This will break anything using the old key.")) return;

  try {
    const r = await apiPost("/api/user/api/rotate", {});
    $("api-key-masked").textContent = r?.masked_key || "—";
    API_KEY_FULL = r?.full_key || null;

    if (API_KEY_FULL) {
      await navigator.clipboard.writeText(API_KEY_FULL);
      $("btn-copy-key").textContent = "Copied";
      setTimeout(() => ($("btn-copy-key").textContent = "Copy"), 900);
    }
  } catch (e) {
    console.error(e);
    alert("Failed to rotate API key.");
  }
});

$("btn-openapi-spec")?.addEventListener("click", () => {
  window.open("/static/openapi.yaml", "_blank", "noopener");
});

  
// -----------------------------
// Change Password Modal
// -----------------------------
const pwModal = $("pw-modal");
const pwClose = $("pw-close");
const pwCancel = $("pw-cancel");
const pwSave = $("pw-save");
const pwErr = $("pw-error");
const pwOk = $("pw-ok");

const pwCurrent = $("pw-current");
const pwNew = $("pw-new");
const pwConfirm = $("pw-confirm");

function openPwModal() {
  if (!pwModal) return;
  pwErr.style.display = "none";
  pwOk.style.display = "none";
  pwErr.textContent = "";
  pwOk.textContent = "";
  pwCurrent.value = "";
  pwNew.value = "";
  pwConfirm.value = "";
  pwSave.disabled = false;

  pwModal.classList.add("is-open");
  pwModal.setAttribute("aria-hidden", "false");
  setTimeout(() => pwCurrent?.focus(), 0);
}

function closePwModal() {
  if (!pwModal) return;
  pwModal.classList.remove("is-open");
  pwModal.setAttribute("aria-hidden", "true");
}

function showPwError(msg) {
  pwOk.style.display = "none";
  pwErr.textContent = msg || "Something went wrong.";
  pwErr.style.display = "block";
}

function showPwOk(msg) {
  pwErr.style.display = "none";
  pwOk.textContent = msg || "Password updated.";
  pwOk.style.display = "block";
}

$("btn-change-password")?.addEventListener("click", openPwModal);

pwClose?.addEventListener("click", closePwModal);
pwCancel?.addEventListener("click", closePwModal);
pwModal?.addEventListener("click", (e) => {
  if (e.target === pwModal) closePwModal();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && pwModal?.classList.contains("is-open")) closePwModal();
});

pwSave?.addEventListener("click", async () => {
  const currentPassword = pwCurrent.value || "";
  const newPassword = pwNew.value || "";
  const confirm = pwConfirm.value || "";

  if (!currentPassword) return showPwError("Enter your current password.");
  if (newPassword.length < 8) return showPwError("New password must be at least 8 characters.");
  if (newPassword !== confirm) return showPwError("New passwords do not match.");

  pwSave.disabled = true;

  try {
    await apiPost("/api/change-password", { currentPassword, newPassword });
    showPwOk("Password updated.");
    setTimeout(closePwModal, 700);
  } catch (err) {
    showPwError("Could not update password. Check your current password and try again.");
    pwSave.disabled = false;
  }
});



  loadEverything()
  .then(() => {
    wireAgreementUploadModalOnce();
    wireAgreementDeleteModalOnce();
wireScreeningRuleGroupModalOnce();
wireScreeningRuleGroupRenameModalOnce();
wireScreeningRuleGroupAssignModalOnce();
  })
  .then(() => {
    if (activeTab === "help") {
      loadTickets().catch(console.error);
    }
  })
  .catch((err) => console.error(err));
})();
