"use strict";

(function () {
  const HELP_INDEX = [
    {
      title: "Accepting an Invitation",
      category: "Getting Started",
      description: "Accept your invitation, verify your email, and get started.",
      url: "/help/getting-started#accepting-invite",
      keywords: [
        "accept invitation",
        "invite",
        "verification",
        "verify email",
        "resend email",
        "starter plan",
        "choose plan",
        "getting started"
      ]
    },
    {
      title: "Adding Your First Carrier",
      category: "Getting Started",
      description: "Search by DOT, MC, or company name and add carriers to My Carriers.",
      url: "/help/getting-started#first-carrier",
      keywords: [
        "add carrier",
        "first carrier",
        "my carriers",
        "carrier search",
        "dot",
        "mc",
        "company name",
        "bulk import",
        "bulk import wizard",
        "watchlist"
      ]
    },
    {
      title: "Sending Your First Agreement",
      category: "Getting Started",
      description: "Upload your agreement and send it for electronic signature.",
      url: "/help/getting-started#first-agreement",
      keywords: [
        "agreement",
        "contract",
        "send agreement",
        "esign",
        "electronic signature",
        "my contracts",
        "signed agreement",
        "carrier documents"
      ]
    },
    {
      title: "Setting Up Alerts",
      category: "Getting Started",
      description: "Enable alerting so you can start monitoring important carrier changes.",
      url: "/help/getting-started#alerts",
      keywords: [
        "alerts",
        "set up alerts",
        "setup alerts",
        "monitoring",
        "notifications"
      ]
    },
    {
      title: "Understanding Carrier Profiles",
      category: "Managing Carriers",
      description: "Review carrier authority, safety history, identity, and profile details.",
      url: "/help/managing-carriers#profiles",
      keywords: [
        "carrier profile",
        "carrier profiles",
        "authority",
        "safety history",
        "identity",
        "profile details"
      ]
    },
    {
      title: "Uploading Documents",
      category: "Managing Carriers",
      description: "Upload and store carrier-related documents in the profile.",
      url: "/help/managing-carriers#documents",
      keywords: [
        "upload docs",
        "upload documents",
        "documents",
        "w9",
        "insurance document",
        "carrier docs",
        "files"
      ]
    },
    {
      title: "Monitoring Authority Changes",
      category: "Managing Carriers",
      description: "Track authority-related changes for monitored carriers.",
      url: "/help/managing-carriers#authority",
      keywords: [
        "authority changes",
        "authority",
        "monitor authority",
        "operating authority",
        "revoked authority"
      ]
    },
    {
      title: "Insurance Tracking",
      category: "Managing Carriers",
      description: "Track insurance information and document status.",
      url: "/help/managing-carriers#insurance",
      keywords: [
        "insurance",
        "insurance tracking",
        "coa",
        "certificate of insurance",
        "policy",
        "insurance status"
      ]
    },
    {
      title: "Email Alerts",
      category: "Alerts & Monitoring",
      description: "Choose which carrier changes trigger email notifications.",
      url: "/help/alerts#email-alerts",
      keywords: [
        "email alerts",
        "email notification",
        "alert categories",
        "save alert preferences",
        "alert settings"
      ]
    },
    {
      title: "Carrier-Level Controls",
      category: "Alerts & Monitoring",
      description: "Control email alert delivery at the carrier level.",
      url: "/help/alerts#carrier-level-controls",
      keywords: [
        "carrier level controls",
        "carrier alerts",
        "carrier toggle",
        "carrier email toggle",
        "per carrier alerts"
      ]
    },
    {
      title: "API Notifications",
      category: "Alerts & Monitoring",
      description: "Use API access for internal workflows and integrations.",
      url: "/help/alerts#api-notifications",
      keywords: [
        "api",
        "api notifications",
        "api access",
        "integrations",
        "documentation",
        "internal workflows",
        "api key"
      ]
    },
    {
      title: "Webhook Setup",
      category: "Alerts & Monitoring",
      description: "Send real-time events into internal systems with webhooks.",
      url: "/help/alerts#webhook-setup",
      keywords: [
        "webhook",
        "webhooks",
        "webhook setup",
        "real time events",
        "destination url",
        "push alerts"
      ]
    },
    {
      title: "Plan Comparison",
      category: "Billing & Plans",
      description: "Compare Starter, Core, Pro, and Enterprise.",
      url: "/help/billing#plan-comparison",
      keywords: [
        "plan comparison",
        "pricing",
        "starter",
        "core",
        "pro",
        "enterprise",
        "compare plans"
      ]
    },
    {
      title: "Upgrading Your Plan",
      category: "Billing & Plans",
      description: "Open plan settings and upgrade through billing management.",
      url: "/help/billing#upgrading",
      keywords: [
        "upgrade",
        "upgrading",
        "upgrade plan",
        "manage plan",
        "change plan",
        "higher plan"
      ]
    },
    {
      title: "Billing & Payments",
      category: "Billing & Plans",
      description: "Stripe checkout, payment handling, and billing basics.",
      url: "/help/billing#billing-payments",
      keywords: [
        "billing",
        "payments",
        "stripe",
        "checkout",
        "card",
        "billing portal",
        "payment details"
      ]
    },
    {
      title: "Managing Your Subscription",
      category: "Billing & Plans",
      description: "Update billing details, change plans, or cancel.",
      url: "/help/billing#subscription-management",
      keywords: [
        "subscription",
        "manage subscription",
        "cancel",
        "billing details",
        "subscription management"
      ]
    }
  ];

  function normalize(value) {
    return String(value || "")
      .toLowerCase()
      .trim()
      .replace(/\s+/g, " ");
  }

  function scoreResult(entry, query) {
    const q = normalize(query);
    if (!q) return 0;

    let score = 0;
    const title = normalize(entry.title);
    const category = normalize(entry.category);
    const description = normalize(entry.description);
    const keywords = entry.keywords.map(normalize);

    if (title === q) score += 120;
    if (title.includes(q)) score += 70;

    if (category.includes(q)) score += 25;
    if (description.includes(q)) score += 20;

    for (const keyword of keywords) {
      if (keyword === q) score += 90;
      else if (keyword.includes(q)) score += 40;
      else if (q.includes(keyword) && keyword.length > 3) score += 20;
    }

    const queryWords = q.split(" ").filter(Boolean);
    for (const word of queryWords) {
      if (word.length < 2) continue;
      if (title.includes(word)) score += 12;
      if (category.includes(word)) score += 6;
      if (description.includes(word)) score += 5;
      for (const keyword of keywords) {
        if (keyword.includes(word)) score += 8;
      }
    }

    return score;
  }

  function searchHelp(query) {
    return HELP_INDEX
      .map((entry) => ({ ...entry, score: scoreResult(entry, query) }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 8);
  }

  function createResultsBox(searchWrap) {
    let box = searchWrap.querySelector(".help-search-results");
    if (box) return box;

    box = document.createElement("div");
    box.className = "help-search-results";
    box.hidden = true;
    searchWrap.appendChild(box);
    return box;
  }

  function renderResults(resultsBox, results, query) {
    if (!query.trim()) {
      resultsBox.hidden = true;
      resultsBox.innerHTML = "";
      return;
    }

    if (!results.length) {
      resultsBox.hidden = false;
      resultsBox.innerHTML = `
        <div class="help-search-empty">
          No matching guides found.
        </div>
      `;
      return;
    }

    resultsBox.hidden = false;
    resultsBox.innerHTML = results
      .map(
        (item) => `
          <a class="help-search-result" href="${item.url}">
            <div class="help-search-result-top">
              <span class="help-search-result-title">${escapeHtml(item.title)}</span>
              <span class="help-search-result-category">${escapeHtml(item.category)}</span>
            </div>
            <div class="help-search-result-desc">${escapeHtml(item.description)}</div>
          </a>
        `
      )
      .join("");
  }

  function escapeHtml(value) {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  function goToBestMatch(query) {
    const results = searchHelp(query);
    if (results.length) {
      window.location.href = results[0].url;
      return;
    }

    const input = document.querySelector(".help-search-input");
    if (input) input.focus();
  }

  function initHelpSearch() {
    const searchWrap = document.querySelector(".help-search");
    const input = document.querySelector(".help-search-input");
    const button = document.querySelector(".help-search-btn");

    if (!searchWrap || !input || !button) return;

    input.disabled = false;
    button.disabled = false;
    input.placeholder = "Search guides...";
    button.setAttribute("aria-label", "Search help guides");

    const resultsBox = createResultsBox(searchWrap);

    const updateResults = () => {
      const query = input.value;
      const results = searchHelp(query);
      renderResults(resultsBox, results, query);
    };

    input.addEventListener("input", updateResults);

    input.addEventListener("focus", () => {
      if (input.value.trim()) updateResults();
    });

    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        goToBestMatch(input.value);
      }

      if (event.key === "Escape") {
        resultsBox.hidden = true;
      }
    });

    button.addEventListener("click", () => {
      goToBestMatch(input.value);
    });

    document.addEventListener("click", (event) => {
      if (!searchWrap.contains(event.target)) {
        resultsBox.hidden = true;
      }
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initHelpSearch);
  } else {
    initHelpSearch();
  }
})();
