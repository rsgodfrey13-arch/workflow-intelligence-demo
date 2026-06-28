(() => {
  const NORMALIZED_COVERAGE_TYPES = [
    "AUTO_LIABILITY",
    "CARGO",
    "GENERAL_LIABILITY",
    "UMBRELLA_LIABILITY",
    "WORKERS_COMP",
    "ERRORS_OMISSIONS",
    "CONTINGENT_AUTO_LIABILITY",
    "PHYSICAL_DAMAGE",
    "TRAILER_INTERCHANGE",
  ];

  const state = {
    activeTab: "document-review",
    loading: {
      "document-review": false,
      normalization: false,
    },
    documentReview: {
      rows: [],
      expandedExceptionId: null,
      loaded: false,
      draftsByExceptionId: {},
      submittingByExceptionId: {},
    },
    normalization: {
      rows: [],
      expandedExceptionId: null,
      loaded: false,
    },
  };

  const tabButtons = Array.from(document.querySelectorAll(".tab-btn"));
  const tabSections = Array.from(document.querySelectorAll(".tab-section"));
  const refreshBtn = document.getElementById("refresh-btn");
  const statusBanner = document.getElementById("status-banner");

  const docQueueBody = document.getElementById("doc-queue-body");
  const docEmptyState = document.getElementById("doc-empty-state");

  const normQueueBody = document.getElementById("norm-queue-body");
  const normEmptyState = document.getElementById("norm-empty-state");

  const escapeHtml = (value) =>
    String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");

  const carrierProfileLinkHtml = (dotNumber) => {
    const normalized = String(dotNumber ?? "").replace(/\D/g, "");
    if (!normalized) return "—";
    return `<a href="/${encodeURIComponent(normalized)}" target="_blank" rel="noopener noreferrer">${escapeHtml(normalized)}</a>`;
  };

  function showStatus(message, type = "error") {
    statusBanner.hidden = false;
    statusBanner.classList.toggle("is-error", type === "error");
    statusBanner.classList.toggle("is-success", type === "success");
    statusBanner.textContent = message;
  }

  function clearStatus() {
    statusBanner.hidden = true;
    statusBanner.classList.remove("is-error", "is-success");
    statusBanner.textContent = "";
  }

  async function apiGet(url) {
    const response = await fetch(url, { credentials: "include" });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.ok === false) {
      throw new Error(payload.error || `Request failed: ${response.status}`);
    }
    return payload;
  }

  async function apiPost(url, body) {
    const response = await fetch(url, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.ok === false) {
      throw new Error(payload.error || `Request failed: ${response.status}`);
    }
    return payload;
  }

  function formatDate(value) {
    if (!value) return "—";
    return new Date(value).toLocaleString();
  }

  function renderTabs() {
    tabButtons.forEach((btn) => {
      const tab = btn.getAttribute("data-tab");
      const active = tab === state.activeTab;
      btn.classList.toggle("is-active", active);
      btn.setAttribute("aria-selected", active ? "true" : "false");
    });

    tabSections.forEach((section) => {
      section.hidden = section.getAttribute("data-tab-section") !== state.activeTab;
    });
  }

  function createBlankDocumentCoverageDraft() {
    return {
      coverage_type: "AUTO LIABILITY",
      insurer_name: "",
      amount: "",
      insurer_letter: "",
      policy_number: "",
      effective_date: "",
      expiration_date: "",
      currency: "USD",
      coverage_type_raw: "",
      limit_label: "",
    };
  }

  function ensureDocumentDrafts(exceptionId) {
    if (!Array.isArray(state.documentReview.draftsByExceptionId[exceptionId])) {
      state.documentReview.draftsByExceptionId[exceptionId] = [createBlankDocumentCoverageDraft()];
    }
    if (!state.documentReview.draftsByExceptionId[exceptionId].length) {
      state.documentReview.draftsByExceptionId[exceptionId] = [createBlankDocumentCoverageDraft()];
    }
    return state.documentReview.draftsByExceptionId[exceptionId];
  }

  function docCoverageBlockHtml(row, draft, index, totalCount) {
    return `
      <section class="coverage-block">
        <div class="coverage-block-header">
          <h4>Coverage ${index + 1}</h4>
          ${
            totalCount > 1
              ? `<button class="btn-inline is-danger" type="button" data-doc-remove-coverage="${row.exception_id}" data-draft-index="${index}">Remove</button>`
              : ""
          }
        </div>
        <div class="form-grid doc-form-grid">
          <div>
            <label>Coverage Type</label>
            <select name="coverage_type" data-doc-field="coverage_type" data-draft-index="${index}" required>
              <option value="AUTO LIABILITY" ${draft.coverage_type === "AUTO LIABILITY" ? "selected" : ""}>AUTO LIABILITY</option>
              <option value="CARGO" ${draft.coverage_type === "CARGO" ? "selected" : ""}>CARGO</option>
              <option value="GENERAL LIABILITY" ${draft.coverage_type === "GENERAL LIABILITY" ? "selected" : ""}>GENERAL LIABILITY</option>
              <option value="UMBRELLA LIAB" ${draft.coverage_type === "UMBRELLA LIAB" ? "selected" : ""}>UMBRELLA LIAB</option>
              <option value="WORKERS COMP" ${draft.coverage_type === "WORKERS COMP" ? "selected" : ""}>WORKERS COMP</option>
              <option value="ERRORS & OMISSIONS" ${draft.coverage_type === "ERRORS & OMISSIONS" ? "selected" : ""}>ERRORS & OMISSIONS</option>
              <option value="PHYSICAL DAMAGE" ${draft.coverage_type === "PHYSICAL DAMAGE" ? "selected" : ""}>PHYSICAL DAMAGE</option>
              <option value="TRAILER INTERCHANGE" ${draft.coverage_type === "TRAILER INTERCHANGE" ? "selected" : ""}>TRAILER INTERCHANGE</option>
            </select>
          </div>
          <div>
            <label>Insurer Name</label>
            <input name="insurer_name" data-doc-field="insurer_name" data-draft-index="${index}" type="text" value="${escapeHtml(draft.insurer_name)}" required />
          </div>
          <div>
            <label>Amount</label>
            <input name="amount" data-doc-field="amount" data-draft-index="${index}" type="number" min="0" step="0.01" value="${escapeHtml(draft.amount)}" required />
          </div>
          <div>
            <label>Insurer Letter</label>
            <input name="insurer_letter" data-doc-field="insurer_letter" data-draft-index="${index}" type="text" maxlength="2" value="${escapeHtml(draft.insurer_letter)}" />
          </div>
          <div>
            <label>Policy Number</label>
            <input name="policy_number" data-doc-field="policy_number" data-draft-index="${index}" type="text" value="${escapeHtml(draft.policy_number)}" />
          </div>
        </div>
        <div class="form-grid doc-form-grid">
          <div>
            <label>Effective Date</label>
            <input name="effective_date" data-doc-field="effective_date" data-draft-index="${index}" type="date" value="${escapeHtml(draft.effective_date)}" required />
          </div>
          <div>
            <label>Expiration Date</label>
            <input name="expiration_date" data-doc-field="expiration_date" data-draft-index="${index}" type="date" value="${escapeHtml(draft.expiration_date)}" required />
          </div>
          <div>
            <label>Currency</label>
            <select name="currency" data-doc-field="currency" data-draft-index="${index}" required>
              <option value="USD" selected>USD</option>
            </select>
          </div>
          <div>
            <label>Coverage Type Raw</label>
            <input name="coverage_type_raw" data-doc-field="coverage_type_raw" data-draft-index="${index}" type="text" value="${escapeHtml(draft.coverage_type_raw)}" />
          </div>
          <div>
            <label>Limit Label</label>
            <input name="limit_label" data-doc-field="limit_label" data-draft-index="${index}" type="text" value="${escapeHtml(draft.limit_label)}" />
          </div>
        </div>
      </section>
    `;
  }

  function docResolveFormHtml(row) {
    const drafts = ensureDocumentDrafts(row.exception_id);
    const isSubmitting = state.documentReview.submittingByExceptionId[row.exception_id] === true;
    return `
      <div class="resolve-panel">
        <form class="doc-resolve-form" data-exception-id="${row.exception_id}">
          <div class="coverage-list">
            ${drafts.map((draft, index) => docCoverageBlockHtml(row, draft, index, drafts.length)).join("")}
          </div>
          <button class="btn-inline" type="button" data-doc-add-coverage="${row.exception_id}" ${isSubmitting ? "disabled" : ""}>Add Coverage</button>
          <div class="panel-actions">
            <button class="btn-inline" type="submit" ${isSubmitting ? "disabled" : ""}>Save and Resolve</button>
            <button class="btn-inline" type="button" data-doc-close-resolve="${row.exception_id}" ${isSubmitting ? "disabled" : ""}>Cancel</button>
          </div>
        </form>
      </div>
    `;
  }

  function normResolveFormHtml(row) {
    const coverageOptions = NORMALIZED_COVERAGE_TYPES.map((v) => `<option value="${v}">${v}</option>`).join("");
    const existingAmount = Number(row.current_amount);
    const hasExistingAmount = Number.isFinite(existingAmount) && existingAmount > 0;
    const existingAmountText = hasExistingAmount ? existingAmount.toLocaleString(undefined, { maximumFractionDigits: 2 }) : "—";

    return `
      <div class="resolve-panel">
        <form class="norm-resolve-form" data-exception-id="${row.exception_id}">
          <div class="form-grid">
            <div>
              <label>Coverage Type</label>
              <select name="normalized_coverage_type" required>${coverageOptions}</select>
            </div>
            ${
              hasExistingAmount
                ? `<div class="amount-context"><label>Current Amount</label><div class="amount-readonly">${escapeHtml(existingAmountText)}</div></div>`
                : `<div>
                    <label>Amount (fallback)</label>
                    <input name="selected_limit_amount" type="number" min="0" step="0.01" required />
                  </div>`
            }
          </div>
          <div class="panel-actions">
            <button class="btn-inline" type="submit">Resolve</button>
            <button class="btn-inline" type="button" data-norm-close-resolve="${row.exception_id}">Cancel</button>
          </div>
        </form>
      </div>
    `;
  }

  function renderDocumentReviewRows() {
    docQueueBody.innerHTML = "";

    if (!state.documentReview.rows.length) {
      docEmptyState.hidden = false;
      return;
    }

    docEmptyState.hidden = true;

    for (const row of state.documentReview.rows) {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${carrierProfileLinkHtml(row.dot_number)}</td>
        <td>${escapeHtml(row.carrier_name || "—")}</td>
        <td class="errors-cell">
          <div class="exception-copy">
            <div class="exception-title">${escapeHtml(row.exception_type || "—")}</div>
            <div class="exception-detail">${escapeHtml(row.exception_reason || "—")}</div>
          </div>
        </td>
        <td>${escapeHtml(formatDate(row.uploaded_at))}</td>
        <td><button class="btn-inline" type="button" data-open-pdf="${row.document_id}">Open PDF</button></td>
        <td>
          <div class="actions">
            <button class="btn-inline" type="button" data-doc-toggle-resolve="${row.exception_id}">Resolve</button>
            <button class="btn-inline is-danger" type="button" data-doc-close="${row.exception_id}">Close</button>
          </div>
        </td>
      `;
      docQueueBody.appendChild(tr);

      if (state.documentReview.expandedExceptionId === row.exception_id) {
        const resolveRow = document.createElement("tr");
        resolveRow.className = "resolve-row";
        resolveRow.innerHTML = `<td colspan="6">${docResolveFormHtml(row)}</td>`;
        docQueueBody.appendChild(resolveRow);
      }
    }
  }

  function renderNormalizationRows() {
    normQueueBody.innerHTML = "";

    if (!state.normalization.rows.length) {
      normEmptyState.hidden = false;
      return;
    }

    normEmptyState.hidden = true;

    for (const row of state.normalization.rows) {
      const sourceCoverageTypeRaw = row.source_coverage_type_raw || "";
      const sourceCoverageType = row.source_coverage_type || "";
      const sourceValue = sourceCoverageTypeRaw || sourceCoverageType || "—";
      const currentAmount = Number(row.current_amount);
      const hasCurrentAmount = Number.isFinite(currentAmount) && currentAmount > 0;
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${carrierProfileLinkHtml(row.dot_number)}</td>
        <td>${escapeHtml(row.carrier_name || "—")}</td>
        <td class="errors-cell">
          <div class="exception-copy">
            <div class="exception-detail">${escapeHtml(sourceValue)}</div>
          </div>
        </td>
        <td>${hasCurrentAmount ? escapeHtml(currentAmount.toLocaleString(undefined, { maximumFractionDigits: 2 })) : '<span class="muted">—</span>'}</td>
        <td>${escapeHtml(formatDate(row.uploaded_at))}</td>
        <td><button class="btn-inline" type="button" data-open-pdf="${row.document_id}">Open PDF</button></td>
        <td>
          <div class="actions">
            <button class="btn-inline" type="button" data-norm-toggle-resolve="${row.exception_id}">Resolve</button>
            <button class="btn-inline" type="button" data-norm-raise-document-review="${row.exception_id}">Raise Exception</button>
            <button class="btn-inline is-danger" type="button" data-norm-close="${row.exception_id}">Close</button>
          </div>
        </td>
      `;
      normQueueBody.appendChild(tr);

      if (state.normalization.expandedExceptionId === row.exception_id) {
        const resolveRow = document.createElement("tr");
        resolveRow.className = "resolve-row";
        resolveRow.innerHTML = `<td colspan="7">${normResolveFormHtml(row)}</td>`;
        normQueueBody.appendChild(resolveRow);
      }
    }
  }

  async function openPdf(documentId) {
    if (!documentId) throw new Error("No document available for this exception.");
    const data = await apiGet(`/api/insurance/documents/${encodeURIComponent(documentId)}/signed-url`);
    if (!data?.signedUrl) throw new Error("Signed URL not returned.");
    window.open(data.signedUrl, "_blank", "noopener,noreferrer");
  }

  function wireHandlers() {
    document.querySelectorAll("[data-open-pdf]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        clearStatus();
        try {
          await openPdf(btn.getAttribute("data-open-pdf"));
        } catch (error) {
          showStatus(error.message || "Failed to open PDF.");
        }
      });
    });

    document.querySelectorAll("[data-doc-toggle-resolve]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const exceptionId = btn.getAttribute("data-doc-toggle-resolve");
        if (state.documentReview.expandedExceptionId === exceptionId) {
          state.documentReview.expandedExceptionId = null;
        } else {
          state.documentReview.expandedExceptionId = exceptionId;
          ensureDocumentDrafts(exceptionId);
        }
        renderDocumentReviewRows();
        wireHandlers();
      });
    });

    document.querySelectorAll("[data-doc-close-resolve]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const exceptionId = btn.getAttribute("data-doc-close-resolve");
        delete state.documentReview.draftsByExceptionId[exceptionId];
        state.documentReview.expandedExceptionId = null;
        renderDocumentReviewRows();
        wireHandlers();
      });
    });

    document.querySelectorAll("[data-doc-add-coverage]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const exceptionId = btn.getAttribute("data-doc-add-coverage");
        const drafts = ensureDocumentDrafts(exceptionId);
        drafts.push(createBlankDocumentCoverageDraft());
        renderDocumentReviewRows();
        wireHandlers();
      });
    });

    document.querySelectorAll("[data-doc-remove-coverage]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const exceptionId = btn.getAttribute("data-doc-remove-coverage");
        const index = Number(btn.getAttribute("data-draft-index"));
        const drafts = ensureDocumentDrafts(exceptionId);
        if (!Number.isInteger(index) || index < 0 || index >= drafts.length) return;
        drafts.splice(index, 1);
        if (!drafts.length) drafts.push(createBlankDocumentCoverageDraft());
        renderDocumentReviewRows();
        wireHandlers();
      });
    });

    document.querySelectorAll("[data-doc-field]").forEach((input) => {
      const syncDraftValue = () => {
        const exceptionId = input.closest("form")?.getAttribute("data-exception-id");
        const field = input.getAttribute("data-doc-field");
        const index = Number(input.getAttribute("data-draft-index"));
        if (!exceptionId || !field || !Number.isInteger(index)) return;
        const drafts = ensureDocumentDrafts(exceptionId);
        if (!drafts[index]) return;
        drafts[index][field] = input.value;
      };

      input.addEventListener("input", syncDraftValue);
      input.addEventListener("change", syncDraftValue);
    });

    document.querySelectorAll("[data-doc-close]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const exceptionId = btn.getAttribute("data-doc-close");
        btn.disabled = true;
        clearStatus();
        try {
          await apiPost(`/api/admin/insurance/document-review-exceptions/${encodeURIComponent(exceptionId)}/resolve`, {
            action: "CLOSE",
          });
          showStatus("Document review exception closed.", "success");
          await loadDocumentReviewQueue(true);
        } catch (error) {
          showStatus(error.message || "Failed to close exception.");
        } finally {
          btn.disabled = false;
        }
      });
    });

    document.querySelectorAll("[data-norm-toggle-resolve]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const exceptionId = btn.getAttribute("data-norm-toggle-resolve");
        state.normalization.expandedExceptionId =
          state.normalization.expandedExceptionId === exceptionId ? null : exceptionId;
        renderNormalizationRows();
        wireHandlers();
      });
    });

    document.querySelectorAll("[data-norm-close-resolve]").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.normalization.expandedExceptionId = null;
        renderNormalizationRows();
        wireHandlers();
      });
    });

    document.querySelectorAll("[data-norm-close]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const exceptionId = btn.getAttribute("data-norm-close");
        btn.disabled = true;
        clearStatus();
        try {
          await apiPost(`/api/admin/insurance/normalization-exceptions/${encodeURIComponent(exceptionId)}/resolve`, {
            action: "CLOSE",
          });
          showStatus("Normalization exception closed.", "success");
          await loadNormalizationQueue(true);
        } catch (error) {
          showStatus(error.message || "Failed to close exception.");
        } finally {
          btn.disabled = false;
        }
      });
    });

    document.querySelectorAll("[data-norm-raise-document-review]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const exceptionId = btn.getAttribute("data-norm-raise-document-review");
        btn.disabled = true;
        clearStatus();
        try {
          await apiPost(
            `/api/admin/insurance/normalization-exceptions/${encodeURIComponent(exceptionId)}/raise-document-review`,
            {}
          );
          showStatus("Raised document review exception and removed item from normalization queue.", "success");
          state.normalization.expandedExceptionId = null;
          await loadNormalizationQueue(true);
        } catch (error) {
          showStatus(error.message || "Failed to raise document review exception.");
        } finally {
          btn.disabled = false;
        }
      });
    });

    document.querySelectorAll(".doc-resolve-form").forEach((form) => {
      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        clearStatus();

        const exceptionId = form.getAttribute("data-exception-id");
        const drafts = ensureDocumentDrafts(exceptionId);
        const payload = {
          action: "SAVE_COVERAGES",
          coverages: drafts.map((draft) => ({
            coverage_type: String(draft.coverage_type || ""),
            coverage_type_raw: String(draft.coverage_type_raw || ""),
            insurer_letter: String(draft.insurer_letter || ""),
            insurer_name: String(draft.insurer_name || ""),
            policy_number: String(draft.policy_number || ""),
            effective_date: String(draft.effective_date || ""),
            expiration_date: String(draft.expiration_date || ""),
            limit_label: String(draft.limit_label || ""),
            currency: String(draft.currency || "USD"),
            amount: Number(draft.amount || "0"),
          })),
        };
        state.documentReview.submittingByExceptionId[exceptionId] = true;
        renderDocumentReviewRows();
        wireHandlers();

        try {
          await apiPost(`/api/admin/insurance/document-review-exceptions/${encodeURIComponent(exceptionId)}/resolve`, payload);
          showStatus("Coverages inserted and document review exception resolved.", "success");
          delete state.documentReview.draftsByExceptionId[exceptionId];
          state.documentReview.expandedExceptionId = null;
          await loadDocumentReviewQueue(true);
        } catch (error) {
          showStatus(error.message || "Failed to save coverage.");
        } finally {
          delete state.documentReview.submittingByExceptionId[exceptionId];
          renderDocumentReviewRows();
          wireHandlers();
        }
      });
    });

    document.querySelectorAll(".norm-resolve-form").forEach((form) => {
      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        clearStatus();

        const exceptionId = form.getAttribute("data-exception-id");
        const submitBtn = form.querySelector("button[type='submit']");
        submitBtn.disabled = true;

        const fd = new FormData(form);
        const payload = {
          action: "SAVE_COVERAGE",
          normalized_coverage_type: String(fd.get("normalized_coverage_type") || ""),
        };
        const selectedLimitAmount = Number(fd.get("selected_limit_amount"));
        if (Number.isFinite(selectedLimitAmount) && selectedLimitAmount > 0) {
          payload.selected_limit_amount = selectedLimitAmount;
        }

        try {
          const response = await apiPost(
            `/api/admin/insurance/normalization-exceptions/${encodeURIComponent(exceptionId)}/resolve`,
            payload
          );

          const fnResult = response?.result;
          if (!fnResult) {
            showStatus("Coverage saved, but resolve result was empty.", "success");
          } else if (fnResult.out_result_status && fnResult.out_result_status !== "RESOLVED") {
            showStatus(
              `Resolve returned ${fnResult.out_result_status}: ${fnResult.out_message || "No message."}`,
              "error"
            );
          } else {
            showStatus(fnResult.out_message || "Coverage saved.", "success");
          }

          state.normalization.expandedExceptionId = null;
          await loadNormalizationQueue(true);
        } catch (error) {
          showStatus(error.message || "Failed to save coverage.");
        } finally {
          submitBtn.disabled = false;
        }
      });
    });
  }

  async function loadDocumentReviewQueue(force = false) {
    if (state.loading["document-review"]) return;
    if (state.documentReview.loaded && !force) return;

    state.loading["document-review"] = true;
    refreshBtn.disabled = true;

    try {
      const payload = await apiGet("/api/admin/insurance/document-review-exceptions");
      state.documentReview.rows = Array.isArray(payload.rows) ? payload.rows : [];
      state.documentReview.loaded = true;
      renderDocumentReviewRows();
      wireHandlers();
    } catch (error) {
      state.documentReview.rows = [];
      renderDocumentReviewRows();
      showStatus(error.message || "Failed to load document review queue.");
    } finally {
      state.loading["document-review"] = false;
      refreshBtn.disabled = false;
    }
  }

  async function loadNormalizationQueue(force = false) {
    if (state.loading.normalization) return;
    if (state.normalization.loaded && !force) return;

    state.loading.normalization = true;
    refreshBtn.disabled = true;

    try {
      const payload = await apiGet("/api/admin/insurance/normalization-exceptions");
      state.normalization.rows = Array.isArray(payload.rows) ? payload.rows : [];
      state.normalization.loaded = true;
      renderNormalizationRows();
      wireHandlers();
    } catch (error) {
      state.normalization.rows = [];
      renderNormalizationRows();
      showStatus(error.message || "Failed to load normalization queue.");
    } finally {
      state.loading.normalization = false;
      refreshBtn.disabled = false;
    }
  }

  async function onTabChange(tab) {
    state.activeTab = tab;
    renderTabs();

    if (tab === "document-review") {
      await loadDocumentReviewQueue();
      return;
    }

    await loadNormalizationQueue();
  }

  tabButtons.forEach((btn) => {
    btn.addEventListener("click", async () => {
      clearStatus();
      await onTabChange(btn.getAttribute("data-tab"));
    });
  });

  refreshBtn.addEventListener("click", async () => {
    clearStatus();
    if (state.activeTab === "document-review") {
      await loadDocumentReviewQueue(true);
      return;
    }
    await loadNormalizationQueue(true);
  });

  window.addEventListener("DOMContentLoaded", async () => {
    await loadHeader();
    renderTabs();
    await loadDocumentReviewQueue(true);
  });
})();
