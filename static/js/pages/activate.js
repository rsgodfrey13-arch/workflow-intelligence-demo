(function () {
  const planInput = document.querySelector("#selected-plan");
  const continueBtn = document.querySelector("#continue-btn");
  const planForm = document.querySelector("#activation-plan-form");
  const plans = ["starter", "core", "pro", "enterprise"];

  const columns = {
    starter: document.querySelectorAll("[data-plan-col='starter']"),
    core: document.querySelectorAll("[data-plan-col='core']"),
    pro: document.querySelectorAll("[data-plan-col='pro']"),
    enterprise: document.querySelectorAll("[data-plan-col='enterprise']")
  };

  const mobileTrack = document.querySelector("#plans-mobile-track");
  const mobileCarousel = document.querySelector(".plans-mobile-carousel");

  const cardByPlan = {};

  function clearSelection() {
    Object.values(columns).forEach((col) =>
      col.forEach((el) => el.classList.remove("selected-col"))
    );

    Object.values(cardByPlan).forEach((card) => {
      card.classList.remove("is-selected");
      const cta = card.querySelector(".plan-mobile-select");
      if (cta) cta.textContent = "Tap to select";
    });
  }

  function formatPlan(plan) {
    return plan.charAt(0).toUpperCase() + plan.slice(1);
  }

  function setSelected(plan) {
    if (!plans.includes(plan)) return;

    clearSelection();
    columns[plan]?.forEach((el) => el.classList.add("selected-col"));

    const selectedCard = cardByPlan[plan];
    if (selectedCard) {
      selectedCard.classList.add("is-selected");
      const cta = selectedCard.querySelector(".plan-mobile-select");
      if (cta) cta.textContent = "Selected";
    }

    if (planInput) planInput.value = plan;

    if (continueBtn) {
      continueBtn.disabled = false;
      continueBtn.textContent = `Continue with ${formatPlan(plan)}`;
    }
  }

  function extractFeatureRows(table) {
    const rows = Array.from(table.querySelectorAll("tbody tr"));

    return rows.map((row) => {
      const labelEl = row.querySelector("th[scope='row']");
      const features = {};

      plans.forEach((plan) => {
        const cell = row.querySelector(`td[data-plan-col='${plan}']`);
        features[plan] = cell ? cell.innerHTML.trim() : "";
      });

      return {
        label: labelEl ? labelEl.textContent.trim() : "",
        features
      };
    });
  }

  function getPlanHeaderData(table) {
    const data = {};

    plans.forEach((plan) => {
      const col = table.querySelector(`thead [data-plan-col='${plan}']`);
      const name = col?.querySelector(".plan-name")?.textContent?.trim() || formatPlan(plan);
      const price = col?.querySelector(".plan-price")?.innerHTML?.trim() || "";
      const featured = col?.classList.contains("is-featured") || false;

      data[plan] = { name, price, featured };
    });

    return data;
  }

  function buildMobileCards() {
    if (!mobileTrack || !mobileCarousel) return;

    const table = document.querySelector(".plans-table");
    if (!table) return;

    const headerData = getPlanHeaderData(table);
    const featureRows = extractFeatureRows(table);

    mobileTrack.innerHTML = "";

    plans.forEach((plan) => {
      const card = document.createElement("article");
      card.className = "plan-mobile-card";
      if (headerData[plan].featured) card.classList.add("is-featured");
      card.setAttribute("data-mobile-plan", plan);
      card.setAttribute("role", "button");
      card.setAttribute("tabindex", "0");
      card.setAttribute("aria-label", `Select ${headerData[plan].name} plan`);

      const featureItems = featureRows
        .map((row) => `
          <li>
            <strong>${row.label}</strong>
            <span>${row.features[plan]}</span>
          </li>
        `)
        .join("");

      card.innerHTML = `
        <div class="plan-mobile-top">
          ${headerData[plan].featured ? '<div class="plan-mobile-badge">Best value</div>' : ""}
          <div class="plan-mobile-name">${headerData[plan].name}</div>
          <div class="plan-mobile-price">${headerData[plan].price}</div>
        </div>
        <ul class="plan-mobile-features">${featureItems}</ul>
        <button class="plan-mobile-select" type="button" tabindex="-1">Tap to select</button>
      `;

      card.addEventListener("click", () => setSelected(plan));
      card.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          setSelected(plan);
        }
      });

      mobileTrack.appendChild(card);
      cardByPlan[plan] = card;
    });

    mobileCarousel.hidden = false;
  }

  Object.entries(columns).forEach(([plan, els]) => {
    els.forEach((el) => {
      el.addEventListener("click", () => setSelected(plan));
    });
  });

  buildMobileCards();

  const params = new URLSearchParams(location.search);
  const pre = params.get("plan");

  async function continueWithPlan(event) {
    event.preventDefault();

    const plan = (planInput?.value || "").toLowerCase();
    if (!plans.includes(plan) || !continueBtn) return;

    const endpoint = plan === "starter"
      ? "/api/billing/activate-starter"
      : "/api/billing/continue";

    continueBtn.disabled = true;
    continueBtn.textContent = plan === "starter" ? "Activating Starter…" : "Redirecting…";

    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ plan })
      });
      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(data?.error || `Request failed (${response.status})`);
      }
      if (!data?.url) throw new Error("Missing redirect URL from server.");

      window.location.href = data.url;
    } catch (error) {
      console.error(error);
      alert("Could not continue. Please try again or open Help if the problem continues.");
      continueBtn.disabled = false;
      continueBtn.textContent = `Continue with ${formatPlan(plan)}`;
    }
  }

  planForm?.addEventListener("submit", continueWithPlan);

  if (pre && plans.includes(pre)) {
    setSelected(pre);
  } else if (continueBtn) {
    continueBtn.disabled = true;
  }

  if (!pre && mobileTrack) {
    window.requestAnimationFrame(() => {
      const proCard = cardByPlan.pro;
      if (!proCard) return;
      proCard.scrollIntoView({ behavior: "auto", inline: "center", block: "nearest" });
    });
  }
})();
