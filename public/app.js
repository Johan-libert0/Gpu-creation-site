if (window.location.pathname === "/dashboard") document.body.classList.add("app-view");

const motionPreference = window.matchMedia("(prefers-reduced-motion: reduce)");
const motionSelector = [
  ".hero-copy",
  ".hero-visual",
  ".info-hero",
  ".info-grid > *",
  ".docs-index",
  ".docs-content > section",
  ".app-view .welcome-row",
  ".app-view .trust-strip",
  ".app-view .metrics-grid > *",
  ".app-view .content-section",
  ".app-view .provider-banner",
  ".app-view main > footer",
  ".app-view .job-card",
  ".app-view .payment-row"
].join(", ");
let motionObserver;
const pendingMotionElements = new Set();
let motionFrame;

function registerMotionElements(root = document) {
  if (motionPreference.matches) return;

  const elements = root.querySelectorAll(motionSelector);
  for (const element of elements) {
    if (element.classList.contains("reveal-on-scroll")) continue;
    element.classList.add("reveal-on-scroll");
    const bounds = element.getBoundingClientRect();
    const inViewport = bounds.top < window.innerHeight && bounds.bottom > 0
      && bounds.left < window.innerWidth && bounds.right > 0;
    if (inViewport || !motionObserver) element.classList.add("is-visible");
    else {
      pendingMotionElements.add(element);
      motionObserver.observe(element);
    }
  }
}

if (!motionPreference.matches) {
  document.documentElement.classList.add("motion-ready");
  if ("IntersectionObserver" in window) {
    motionObserver = new IntersectionObserver((entries, observer) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.classList.add("is-visible");
        pendingMotionElements.delete(entry.target);
        observer.unobserve(entry.target);
      }
    }, { threshold: 0.12, rootMargin: "0px" });
  }
  registerMotionElements();

  const revealInViewport = () => {
    motionFrame = undefined;
    for (const element of pendingMotionElements) {
      const bounds = element.getBoundingClientRect();
      if (bounds.top < window.innerHeight + 100 && bounds.bottom > -100
        && bounds.left < window.innerWidth && bounds.right > 0) {
        element.classList.add("is-visible");
        pendingMotionElements.delete(element);
        motionObserver?.unobserve(element);
      }
    }
  };
  const queueMotionCheck = () => {
    if (motionFrame === undefined) motionFrame = requestAnimationFrame(revealInViewport);
  };
  window.addEventListener("scroll", queueMotionCheck, { passive: true });
  window.addEventListener("resize", queueMotionCheck, { passive: true });
}

if (window.location.pathname !== "/dashboard") {
  const mobileToggle = document.querySelector("[data-nav-toggle]");
  const nav = document.querySelector("[data-pill-nav]");
  mobileToggle?.addEventListener("click", () => {
    const open = mobileToggle.getAttribute("aria-expanded") === "true";
    mobileToggle.setAttribute("aria-expanded", String(!open));
    nav?.classList.toggle("is-open", !open);
  });
  window.addEventListener("load", () => document.documentElement.classList.add("is-ready"));
} else {
const roleSelect = document.querySelector("#role-select");

const buyerPanel = document.querySelector("#buyer-panel");
const providerBanner = document.querySelector("#provider-banner");
const jobsList = document.querySelector("#jobs-list");
const paymentsList = document.querySelector("#payments-list");
const toast = document.querySelector("#toast");
let currentRole = "buyer";
let toastTimer;
let statePollTimer;

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { "content-type": "application/json", ...(options.headers || {}) }
  });
  if (response.status === 204) return null;
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || "The request could not be completed.");
  return body;
}

function notify(message) {
  toast.textContent = message;
  toast.classList.add("visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("visible"), 3500);
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function makeJobCard(job) {
  const card = element("article", "job-card");
  const top = element("div", "job-top");
  const titleBlock = element("div");
  titleBlock.append(element("h4", "", job.title), element("p", "file-name", job.fileName));
  const status = element("span", `job-status status-${job.status}`, job.status.replaceAll("_", " "));
  top.append(titleBlock, status);
  card.append(top);

  const terms = element("div", "job-terms");
  terms.append(
    element("span", "", `Proposed payout: $${(job.priceUsd / 100).toFixed(2)} USDG`),
    element("span", "", `Network proposal: ${job.network}`),
    element("span", "", `Execution: ${job.result?.provider || "Hugging Face inference after acceptance"}`)
  );
  card.append(terms);

  if (job.result) {
    const result = element("div", "result-box");
    result.append(
      element("strong", "", `Generated text${job.result.model ? ` · ${job.result.model}` : ""}`),
      element("pre", "generated-output", job.result.generatedText || "No generated text was returned.")
    );
    card.append(result);
  }

  if (currentRole === "provider" && job.status === "open") {
    const accept = element("button", "button button-primary compact", "Accept & process");
    accept.type = "button";
    accept.addEventListener("click", async () => {
      accept.disabled = true;
      try {
        await api(`/api/jobs/${job.id}/accept`, { method: "POST", body: "{}" });
        notify("Job accepted and queued. Processing may take a few moments.");
        await loadState();
      } catch (error) {
        notify(error.message);
        accept.disabled = false;
      }
    });
    card.append(accept);
  }

  if (currentRole === "buyer" && job.status === "completed") {
    const approve = element("button", "button button-secondary compact", "Approve result");
    approve.type = "button";
    approve.addEventListener("click", async () => {
      approve.disabled = true;
      try {
        await api(`/api/jobs/${job.id}/approve`, { method: "POST", body: "{}" });
        notify("Result approved. Settlement remains disabled and unpaid.");
        await loadState();
      } catch (error) {
        notify(error.message);
        approve.disabled = false;
      }
    });
    card.append(approve);
  }
  return card;
}

function renderPayments(payments) {
  paymentsList.replaceChildren();
  if (!payments.length) {
    paymentsList.append(element("div", "empty-state", "Payment records will appear when a local job is created."));
    return;
  }
  for (const payment of payments) {
    const row = element("article", "payment-row");
    const left = element("div");
    left.append(
      element("strong", "", `$${(payment.amountUsd / 100).toFixed(2)} ${payment.asset}`),
      element("span", "payment-meta", `${payment.protocol} · ${payment.network} · ${payment.id.slice(0, 15)}`)
    );
    row.append(
      left,
      element("span", "payment-network", payment.network),
      element("span", "disabled-pill", payment.status.replaceAll("_", " "))
    );
    row.append(element("p", "payment-note", payment.note));
    paymentsList.append(row);
  }
}

async function loadState() {
  try {
    const state = await api("/api/state");
    currentRole = state.role;
    roleSelect.value = currentRole;
    document.querySelector("#demo-role-switch").hidden = state.runtime.mode === "production" || state.runtime.auth.configured;
    const authControl = document.querySelector("#auth-control");
    authControl.textContent = state.authenticated ? (state.user?.name || "A").slice(0, 1).toUpperCase() : "A";
    authControl.href = state.authenticated ? "/logout" : "/login";
    authControl.setAttribute("aria-label", state.authenticated ? "Sign out" : "Sign in");
    document.querySelector("#runtime-status").lastChild.textContent = state.runtime.mode === "production" ? "PRODUCTION" : "LOCAL PREVIEW";
    document.querySelector("#service-status").innerHTML = state.runtime.mode === "production"
      ? 'PRODUCTION MODE <b>·</b> INFERENCE AND X402 STATUS SHOWN ABOVE'
      : 'LOCAL PREVIEW <b>·</b> NOT A LIVE SERVICE';
    document.querySelector("#gpu-label").textContent = state.runtime.gpu.configured
      ? "Hugging Face inference"
      : (state.runtime.mode === "production" ? "Hugging Face setup required" : "Inference not configured");
    document.querySelector("#gpu-detail").textContent = state.runtime.gpu.jobSubmissionEnabled
      ? "Model and token configured"
      : (state.runtime.gpu.provider !== "huggingface-inference"
        ? "Set GPU_PROVIDER=huggingface-inference to select the provider"
        : (state.runtime.gpu.configured
          ? "Review provider data terms and set GPU_PROVIDER_PRIVACY_ACKNOWLEDGED=true"
          : "Configure HF_TOKEN and HF_MODEL to generate text"));
    const paidGenerationEnabled = state.runtime.settlement.enabled && state.runtime.gpu.jobSubmissionEnabled;
    document.querySelector("#settlement-label").textContent = state.runtime.settlement.enabled
      ? "x402 USDG payments"
      : (state.runtime.settlement.configured ? "x402 configured · disabled" : "Settlement setup incomplete");
    document.querySelector("#settlement-detail").textContent = state.runtime.settlement.enabled
      ? "Arbitrum One · 0.01 USDG per successful response"
      : (state.runtime.settlement.configured
        ? "The payment gateway is disabled in this runtime."
        : "Required USDG, recipient, facilitator, or receipt settings are incomplete.");
    document.querySelector("#paid-generation-status").textContent = paidGenerationEnabled ? "x402 enabled" : "x402 disabled";
    document.querySelector("#paid-generation-note").textContent = paidGenerationEnabled
      ? "Connect an Arbitrum wallet. You will review the payment in your wallet before it is sent."
      : (state.runtime.settlement.enabled
        ? "Payment is configured, but inference is unavailable. The service will not charge you."
        : "The payment gateway is disabled in this runtime. The service will not charge you.");
    document.querySelector("#paid-generation-submit").disabled = !paidGenerationEnabled;
    document.querySelector("#payments .section-copy").textContent = paidGenerationEnabled
      ? "Pay 0.01 USDG on Arbitrum One for each successful generated response. A wallet confirmation is required; failed generation requests are not settled. Marketplace jobs and provider payouts remain separate."
      : "Payment availability depends on the current service configuration. Marketplace job records are separate and do not represent blockchain transactions.";
    document.querySelector(".side-nav .nav-link[href=\"#payments\"] .soon-tag").textContent = paidGenerationEnabled ? "x402" : "OFF";
    document.querySelector("#paid-generation-submit").textContent = paidGenerationEnabled
      ? "Connect wallet & generate · 0.01 USDG"
      : "Payments unavailable";
    document.querySelector("#auth-label").textContent = state.runtime.auth.mode === "auth0" ? "Auth0 identity" : "Local preview identity";
    document.querySelector("#auth-detail").textContent = state.authenticated
      ? state.user.name
      : (state.runtime.mode === "production" ? "Sign-in required" : "Local preview identity");
    document.querySelector("#view-title").textContent = currentRole === "buyer" ? "Create a job" : "Browse available work";
    document.querySelector("#breadcrumb-title").textContent = currentRole === "buyer" ? "Overview" : "Provider workspace";
    buyerPanel.hidden = currentRole !== "buyer";
    providerBanner.hidden = currentRole !== "provider";
    const submitButton = document.querySelector('#job-form button[type="submit"]');
    submitButton.disabled = !state.runtime.gpu.jobSubmissionEnabled;
    if (submitButton.disabled) {
      document.querySelector("#form-status").textContent = "Prompt jobs are unavailable until Hugging Face Inference Providers is configured; production also requires review of its data-handling terms.";
    }
    const jobs = state.jobs;
    document.querySelector("#job-count").textContent = `${jobs.length} ${jobs.length === 1 ? "job" : "jobs"}`;
    document.querySelector("#nav-job-count").textContent = jobs.filter((job) => job.status === "open").length;
    document.querySelector("#metric-open").textContent = jobs.filter((job) => job.status === "open").length;
    document.querySelector("#metric-completed").textContent = jobs.filter((job) => job.status === "completed" || job.status === "approved_unpaid").length;
    document.querySelector("#metric-volume").textContent = `$${(jobs.reduce((total, job) => total + job.priceUsd, 0) / 100).toFixed(2)}`;
    jobsList.replaceChildren();
    if (!jobs.length) jobsList.append(element("div", "empty-state", "No jobs in the local preview yet. Create a job to see it appear here."));
    else for (const job of jobs) jobsList.append(makeJobCard(job));
    renderPayments(state.payments);
    if (jobs.some((job) => job.status === "processing") && !statePollTimer) {
      statePollTimer = setTimeout(() => {
        statePollTimer = null;
        loadState();
      }, 2500);
    }
    registerMotionElements(jobsList);
    registerMotionElements(paymentsList);
  } catch (error) {
    notify(error.message);
  }
}

roleSelect.addEventListener("change", async () => {
  try {
    await api("/api/demo/role", { method: "POST", body: JSON.stringify({ role: roleSelect.value }) });
    await loadState();
  } catch (error) {
    notify(error.message);
  }
});

document.querySelector("#refresh-button").addEventListener("click", loadState);

document.querySelectorAll(".nav-link").forEach((link) => {
  link.addEventListener("click", () => {
    document.querySelectorAll(".nav-link").forEach((item) => item.classList.remove("active"));
    link.classList.add("active");
    document.querySelector("#breadcrumb-title").textContent = link.textContent.trim().replace(/\s+\d+$/, "");
  });
});

document.querySelector("#job-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const status = document.querySelector("#form-status");
  const prompt = document.querySelector("#job-prompt").value;
  const submit = form.querySelector('button[type="submit"]');
  if (new TextEncoder().encode(prompt).byteLength > 64 * 1024) {
    status.textContent = "The prompt exceeds the 64 KiB limit.";
    return;
  }

  submit.disabled = true;
  status.textContent = "Posting the prompt job…";
  try {
    await api("/api/jobs", {
      method: "POST",
      body: JSON.stringify({
        title: document.querySelector("#job-title").value,
        prompt,
        dataConsent: document.querySelector("#job-data-consent").checked,
        priceUsd: Math.round(Number(document.querySelector("#job-price").value) * 100)
      })
    });
    form.reset();
    document.querySelector("#job-price").value = "1.00";
    status.textContent = "Posted. The prompt is sent to Hugging Face only after a provider accepts the job.";
    await loadState();
  } catch (error) {
    status.textContent = error.message;
  } finally {
    submit.disabled = false;
  }
});

document.querySelector("#paid-generation-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const prompt = document.querySelector("#paid-generation-prompt").value;
  const submit = document.querySelector("#paid-generation-submit");
  const status = document.querySelector("#paid-generation-result");
  const output = document.querySelector("#paid-generation-output");
  output.hidden = true;
  output.textContent = "";
  if (new TextEncoder().encode(prompt).byteLength > 64 * 1024) {
    status.textContent = "The prompt exceeds the 64 KiB limit.";
    return;
  }
  if (typeof window.GpuFilesPaidGeneration?.generatePaidText !== "function") {
    status.textContent = "The secure x402 payment client did not load. Refresh the page and try again.";
    return;
  }

  submit.disabled = true;
  status.textContent = "Connect your Arbitrum wallet and approve the payment request to continue.";
  try {
    const dataConsent = document.querySelector("#paid-generation-consent").checked;
    const result = await window.GpuFilesPaidGeneration.generatePaidText(prompt, dataConsent);
    output.textContent = result.output;
    output.hidden = false;
    status.replaceChildren(document.createTextNode(`Payment settled from ${result.payer.slice(0, 6)}…${result.payer.slice(-4)}. `));
    const transaction = result.payment?.transaction;
    if (typeof transaction === "string" && /^0x[0-9a-f]{64}$/i.test(transaction)) {
      const link = element("a", "paid-generation-result-link", "View Arbitrum transaction");
      link.href = `https://arbiscan.io/tx/${transaction}`;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      status.append(link);
    }
    document.querySelector("#paid-generation-prompt").value = "";
    document.querySelector("#paid-generation-consent").checked = false;
  } catch (error) {
    status.textContent = error.message || "Paid generation could not be completed.";
  } finally {
    submit.disabled = !document.querySelector("#paid-generation-status").textContent.includes("enabled");
  }
});

loadState();
}
