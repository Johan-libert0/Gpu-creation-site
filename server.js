require("dotenv").config();

const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const express = require("express");
const { auth: authMiddleware } = require("express-openid-connect");
const { MAX_INPUT_BYTES } = require("./worker");
const { runHuggingFaceGeneration } = require("./huggingface");
const { PAYMENT_CONFIGURATION, createPaymentRecord } = require("./payments");
const { getRuntimeConfig, validateRuntimeConfig } = require("./config");
const { createPostgresStore } = require("./postgres-store");
const {
  PAID_GENERATION_PATH,
  createX402Middleware,
  getX402Configuration,
  settlementReceiptMiddleware,
  validateX402Configuration
} = require("./x402-payment");

const HOST = "127.0.0.1";
const PORT = Number(process.env.PORT || 4173);
let dataDirectory = process.env.DATA_DIR || path.join(__dirname, "data");
let dataFile = path.join(dataDirectory, "state.json");
const MAX_BODY_BYTES = MAX_INPUT_BYTES * 2 + 4096;
const MAX_PENDING_SOURCE_JOBS = 100;
const SOURCE_RETENTION_MS = 60 * 60 * 1000;
const transientInputs = new Map();

const staticFiles = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/login", ["login.html", "text/html; charset=utf-8"]],
  ["/dashboard", ["index.html", "text/html; charset=utf-8"]],
  ["/how-it-works", ["how-it-works.html", "text/html; charset=utf-8"]],
  ["/providers", ["providers.html", "text/html; charset=utf-8"]],
  ["/docs", ["docs.html", "text/html; charset=utf-8"]],
  ["/login.css", ["login.css", "text/css; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/payment-client.js", ["payment-client.js", "text/javascript; charset=utf-8"]],
  ["/styles.css", ["styles.css", "text/css; charset=utf-8"]]
]);

async function readState() {
  try {
    const raw = await fs.readFile(dataFile, "utf8");
    const state = JSON.parse(raw);
    if (!Array.isArray(state.jobs) || !Array.isArray(state.payments)) {
      throw new Error("Invalid local state structure.");
    }
    return state;
  } catch (error) {
    if (error.code === "ENOENT") return { jobs: [], payments: [] };
    throw error;
  }
}

let writeQueue = Promise.resolve();
function writeState(state) {
  writeQueue = writeQueue.then(async () => {
    await fs.mkdir(dataDirectory, { recursive: true });
    const tempFile = `${dataFile}.${process.pid}.tmp`;
    await fs.writeFile(tempFile, JSON.stringify(state, null, 2), { mode: 0o600 });
    await fs.rename(tempFile, dataFile);
  });
  return writeQueue;
}

function sendJson(response, status, value) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff"
  });
  response.end(JSON.stringify(value));
}

function sendError(response, status, message) {
  sendJson(response, status, { error: message });
}

function databaseErrorDetails(error) {
  if (error?.code) return error.code;
  if (typeof error?.message !== "string") return "unknown database error";
  return error.message.replace(/postgres(?:ql)?:\/\/[^\s"'<>]+/gi, "postgres://[redacted]");
}

function roleFrom(request) {
  const runtime = getRuntimeConfig();
  if (runtime.auth.configured && request.oidc?.isAuthenticated()) {
    const claims = request.oidc.user || {};
    return claims["https://gpufiles.app/role"] === "provider" ? "provider" : "buyer";
  }
  if (runtime.mode === "production" || runtime.auth.configured) return null;
  return /(?:^|;\s*)demoRole=provider(?:;|$)/.test(request.headers.cookie || "")
    ? "provider"
    : "buyer";
}

function identityFrom(request) {
  if (request.oidc?.isAuthenticated()) return request.oidc.user?.sub || null;
  if (getRuntimeConfig().mode === "production" || getRuntimeConfig().auth.configured) return null;
  return roleFrom(request) === "provider" ? "local-demo-provider" : "local-demo-buyer";
}

function validSameOrigin(request) {
  const origin = request.headers.origin;
  const runtime = getRuntimeConfig();
  if (!origin) return runtime.mode !== "production";
  try {
    const parsed = new URL(origin);
    if (runtime.mode === "production") return parsed.origin === new URL(process.env.BASE_URL).origin;
    return parsed.protocol === "http:" && parsed.host === request.headers.host;
  } catch {
    return false;
  }
}

function isAuthenticated(request) {
  return Boolean(request.oidc?.isAuthenticated());
}

function isAllowedUser(request) {
  const identity = request.oidc?.user;
  const allowlist = (process.env.AUTH0_ALLOWED_EMAILS || "")
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);
  if (!allowlist.length) return getRuntimeConfig().mode !== "production";
  return identity?.email_verified === true &&
    typeof identity.email === "string" &&
    allowlist.includes(identity.email.trim().toLowerCase());
}

function publicJob(job) {
  return {
    id: job.id,
    title: job.title,
    fileName: job.fileName,
    priceUsd: job.priceUsd,
    currency: job.currency,
    network: job.network,
    status: job.status,
    createdAt: job.createdAt,
    result: job.result
      ? {
          generatedText: job.result.generatedText,
          model: job.result.model,
          worker: job.result.worker,
          executionMode: job.result.executionMode,
          provider: job.result.provider
        }
      : null
  };
}

function publicPayment(payment) {
  return {
    id: payment.id,
    jobId: payment.jobId,
    amountUsd: payment.amountUsd,
    asset: payment.asset,
    network: payment.network,
    protocol: payment.protocol,
    status: payment.status,
    transactionId: payment.transactionId,
    note: payment.note
  };
}

function stateForIdentity(state, role, identity) {
  const jobs = role === "provider"
    ? state.jobs.filter((job) => job.status === "open" || job.providerId === identity)
    : state.jobs.filter((job) => job.buyerId === identity);
  const jobIds = new Set(jobs.map((job) => job.id));
  const payments = state.payments.filter((payment) =>
    jobIds.has(payment.jobId) &&
    (payment.buyerId === identity || payment.providerId === identity)
  );
  return {
    jobs: jobs.map(publicJob),
    payments: payments.map(publicPayment)
  };
}

function publicRuntime(runtime) {
  return {
    mode: runtime.mode,
    auth: { mode: runtime.auth.mode, configured: runtime.auth.configured },
    gpu: {
      provider: runtime.gpu.provider,
      executionMode: runtime.gpu.executionMode,
      configured: runtime.gpu.configured,
      jobSubmissionEnabled: runtime.gpu.jobSubmissionEnabled
    },
    privacy: {
      mode: runtime.privacy.mode,
      sourceRetention: runtime.privacy.sourceRetention
    },
    settlement: {
      enabled: runtime.settlement.enabled,
      implemented: runtime.settlement.implemented,
      protocol: runtime.settlement.protocol,
      asset: runtime.settlement.asset,
      network: runtime.settlement.network,
      configured: runtime.settlement.configured
    }
  };
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      const error = new Error("Request body is too large.");
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    const error = new Error("Request body must be valid JSON.");
    error.status = 400;
    throw error;
  }
}

function validateJob(body) {
  const title = typeof body.title === "string" ? body.title.trim() : "";
  const prompt = typeof body.prompt === "string" ? body.prompt : "";
  const priceUsd = Number(body.priceUsd);

  if (title.length < 3 || title.length > 80) {
    return "Title must be 3–80 characters.";
  }
  if (Buffer.byteLength(prompt.trim(), "utf8") === 0 || Buffer.byteLength(prompt, "utf8") > MAX_INPUT_BYTES) {
    return "Enter a non-empty prompt no larger than 64 KiB.";
  }
  if (!Number.isInteger(priceUsd) || priceUsd < 1 || priceUsd > 10000) {
    return "The proposed payout must be between $0.01 and $100.00.";
  }
  if (getRuntimeConfig().mode === "production" && body.dataConsent !== true) {
    return "Confirm that you are authorized to send this prompt to the service and Hugging Face Inference Providers.";
  }
  return null;
}

function expirePendingInputs() {
  const now = Date.now();
  for (const [jobId, source] of transientInputs) {
    if (source.expiresAt <= now) discardTransientInput(jobId);
  }
}

function discardTransientInput(jobId) {
  const source = transientInputs.get(jobId);
  if (!source) return;
  clearTimeout(source.expiryTimer);
  transientInputs.delete(jobId);
}

async function handleApi(request, response, url, durableStore, storeReady, runInference) {
  const runtime = getRuntimeConfig();
  const authenticated = isAuthenticated(request);
  if ((runtime.mode === "production" || runtime.auth.configured) && !authenticated) {
    return sendError(response, 401, "Authentication is required.");
  }
  if (!isAllowedUser(request)) {
    return sendError(response, 403, "This account is not authorized to use this application.");
  }
  if (authenticated && !request.oidc.user?.sub) {
    return sendError(response, 401, "The authenticated session has no valid user identifier.");
  }
  if (durableStore) await storeReady;

  const role = roleFrom(request);
  if (request.method === "GET" && url.pathname === "/api/state") {
    const state = durableStore ? await durableStore.readState() : await readState();
    const identity = identityFrom(request);
    const authenticatedMode = runtime.mode === "production" || runtime.auth.configured;
    const visibleState = authenticatedMode
      ? stateForIdentity(state, role, identity)
      : { jobs: state.jobs.map(publicJob), payments: state.payments.map(publicPayment) };
    return sendJson(response, 200, {
      role,
      authenticated,
      user: authenticated
        ? {
            name: request.oidc.user?.name || request.oidc.user?.email || request.oidc.user?.sub
          }
        : null,
      jobs: visibleState.jobs,
      payments: visibleState.payments,
      paymentConfiguration: {
        enabled: false,
        protocol: PAYMENT_CONFIGURATION.protocol,
        asset: PAYMENT_CONFIGURATION.asset,
        network: PAYMENT_CONFIGURATION.network,
        reason: PAYMENT_CONFIGURATION.reason
      },
      runtime: publicRuntime(runtime),
      worker: { mode: runtime.gpu.provider, maxInputBytes: MAX_INPUT_BYTES }
    });
  }

  if (request.method === "GET" && url.pathname === "/api/config") {
    return sendJson(response, 200, { runtime: publicRuntime(runtime) });
  }

  if (request.method !== "POST") {
    return sendError(response, 405, "Method not allowed.");
  }
  if (!validSameOrigin(request)) {
    return sendError(response, 403, "Cross-origin requests are not allowed.");
  }

  if (url.pathname === "/api/demo/role") {
    if (runtime.mode === "production" || runtime.auth.configured) {
      return sendError(response, 403, "Demo role switching is disabled outside local preview.");
    }
    const body = await readJson(request);
    if (body.role !== "buyer" && body.role !== "provider") {
      return sendError(response, 400, "Choose buyer or provider.");
    }
    response.writeHead(204, {
      "set-cookie": `demoRole=${body.role}; HttpOnly; SameSite=Strict; Path=/`,
      "cache-control": "no-store"
    });
    return response.end();
  }

  if (url.pathname === "/api/jobs") {
    if (role !== "buyer") return sendError(response, 403, "Only a buyer can create a job.");
    if (!runtime.gpu.jobSubmissionEnabled) {
      return sendError(response, 503, "Prompt generation is unavailable until Hugging Face Inference Providers is configured; production also requires review of its data-handling terms.");
    }
    expirePendingInputs();
    if (transientInputs.size >= MAX_PENDING_SOURCE_JOBS) {
      return sendError(response, 503, "The service has reached its limit for pending prompts. Try again later.");
    }
    const body = await readJson(request);
    const validationError = validateJob(body);
    if (validationError) return sendError(response, 400, validationError);

    const identity = identityFrom(request);
    const job = {
      id: randomUUID(),
      title: body.title.trim(),
      fileName: "text prompt",
      buyerId: identity,
      providerId: null,
      priceUsd: Number(body.priceUsd),
      currency: "USDG",
      network: "Arbitrum",
      status: "open",
      createdAt: new Date().toISOString(),
      result: null
    };
    const payment = createPaymentRecord(job);
    if (durableStore) {
      await durableStore.createJob(job, payment, body.prompt);
    } else {
      const state = await readState();
      state.jobs.unshift(job);
      state.payments.unshift(payment);
      await writeState(state);
      const source = {
        text: body.prompt,
        expiresAt: Date.now() + SOURCE_RETENTION_MS,
        expiryTimer: null
      };
      source.expiryTimer = setTimeout(() => discardTransientInput(job.id), SOURCE_RETENTION_MS);
      source.expiryTimer.unref?.();
      transientInputs.set(job.id, source);
    }
    return sendJson(response, 201, { job: publicJob(job) });
  }

  const acceptMatch = url.pathname.match(/^\/api\/jobs\/([0-9a-f-]+)\/accept$/i);
  if (acceptMatch) {
    if (role !== "provider") return sendError(response, 403, "Only a provider can accept a job.");
    if (durableStore) {
      const accepted = await durableStore.acceptJob(acceptMatch[1], identityFrom(request));
      if (accepted.error === "not_found") return sendError(response, 404, "Job not found.");
      if (accepted.error === "not_open") return sendError(response, 409, "This job is no longer open.");
      if (accepted.error === "source_expired") {
        return sendError(response, 410, "The temporary prompt expired. Ask the buyer to create the job again.");
      }
      const state = await durableStore.readState();
      const job = state.jobs.find((item) => item.id === acceptMatch[1]);
      return sendJson(response, 202, { job: publicJob(job), queued: true });
    }
    const state = await readState();
    const job = state.jobs.find((item) => item.id === acceptMatch[1]);
    if (!job) return sendError(response, 404, "Job not found.");
    if (job.status !== "open") return sendError(response, 409, "This job is no longer open.");
    const source = transientInputs.get(job.id);
    if (!source || source.expiresAt <= Date.now()) {
      discardTransientInput(job.id);
      return sendError(response, 410, "The temporary prompt is no longer available. Create the job again.");
    }
    if (!runtime.gpu.jobSubmissionEnabled) {
      discardTransientInput(job.id);
      return sendError(response, 503, "Prompt generation is unavailable until Hugging Face Inference Providers is configured.");
    }

    discardTransientInput(job.id);
    const input = source.text;
    job.providerId = identityFrom(request);
    job.status = "processing";
    await writeState(state);

    try {
      job.result = await runInference({ jobId: job.id, prompt: input });
    } catch {
      job.status = "failed";
      await writeState(state);
      return sendJson(response, 502, { error: "Text generation failed. Check Hugging Face model access and retry." });
    }

    job.status = "completed";
    const payment = state.payments.find((item) => item.jobId === job.id);
    if (payment) payment.providerId = job.providerId;
    await writeState(state);
    return sendJson(response, 200, { job: publicJob(job) });
  }

  const approveMatch = url.pathname.match(/^\/api\/jobs\/([0-9a-f-]+)\/approve$/i);
  if (approveMatch) {
    if (role !== "buyer") return sendError(response, 403, "Only a buyer can approve a result.");
    if (durableStore) {
      const approval = await durableStore.approveJob(
        approveMatch[1],
        identityFrom(request),
        PAYMENT_CONFIGURATION.reason
      );
      if (approval.error === "not_found") return sendError(response, 404, "Job not found.");
      if (approval.error === "forbidden") return sendError(response, 403, "This is not your job.");
      if (approval.error === "not_completed") return sendError(response, 409, "Only completed jobs can be approved.");
      const state = await durableStore.readState();
      const job = state.jobs.find((item) => item.id === approveMatch[1]);
      const payment = state.payments.find((item) => item.jobId === approveMatch[1]);
      return sendJson(response, 200, { job: publicJob(job), payment: publicPayment(payment) });
    }
    const state = await readState();
    const job = state.jobs.find((item) => item.id === approveMatch[1]);
    if (!job) return sendError(response, 404, "Job not found.");
    if (job.buyerId !== identityFrom(request)) return sendError(response, 403, "This is not your job.");
    if (job.status !== "completed") return sendError(response, 409, "Only completed jobs can be approved.");
    job.status = "approved_unpaid";
    job.approvedAt = new Date().toISOString();
    const payment = state.payments.find((item) => item.jobId === job.id);
    if (payment) {
      payment.status = "not_settled";
      payment.note = PAYMENT_CONFIGURATION.reason;
    }
    await writeState(state);
    return sendJson(response, 200, { job: publicJob(job), payment: payment ? publicPayment(payment) : null });
  }

  return sendError(response, 404, "Not found.");
}

function setSecurityHeaders(response) {
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("referrer-policy", "no-referrer");
  response.setHeader("x-frame-options", "DENY");
  response.setHeader("permissions-policy", "camera=(), microphone=(), geolocation=()");
  response.setHeader("content-security-policy", "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; base-uri 'none'; object-src 'none'; form-action 'self'; frame-ancestors 'none'");
  if (getRuntimeConfig().mode === "production") {
    response.setHeader("strict-transport-security", "max-age=31536000; includeSubDomains");
  }
}

function createAuthMiddleware() {
  const runtime = getRuntimeConfig();
  if (runtime.mode === "production") validateRuntimeConfig(runtime);
  if (runtime.auth.partiallyConfigured) {
    throw new Error("Auth0 configuration is incomplete. Set AUTH0_DOMAIN, AUTH0_CLIENT_ID, AUTH0_CLIENT_SECRET, and AUTH0_SECRET together.");
  }
  if (!runtime.auth.configured) return null;

  return authMiddleware({
    authRequired: false,
    auth0Logout: true,
    routes: {
      login: false,
      logout: "/logout"
    },
    issuerBaseURL: `https://${runtime.auth.domain}`,
    baseURL: process.env.BASE_URL || `http://127.0.0.1:${PORT}`,
    clientID: process.env.AUTH0_CLIENT_ID,
    clientSecret: process.env.AUTH0_CLIENT_SECRET,
    secret: process.env.AUTH0_SECRET,
    authorizationParams: {
      scope: "openid profile email"
    }
  });
}

function createServer(options = {}) {
  const runtime = getRuntimeConfig();
  validateRuntimeConfig(runtime);
  const x402 = getX402Configuration();
  validateX402Configuration(x402);
  dataDirectory = options.dataDir || process.env.DATA_DIR || path.join(__dirname, "data");
  dataFile = path.join(dataDirectory, "state.json");
  const durableStore = options.durableStore || (runtime.mode === "production" ? createPostgresStore() : null);
  const runInference = options.runInference || runHuggingFaceGeneration;
  let databaseReady = !durableStore;
  const storeReady = durableStore
    ? durableStore.initialize().then(() => { databaseReady = true; })
    : Promise.resolve();
  storeReady.catch((error) => {
    console.error("PostgreSQL initialization failed.", databaseErrorDetails(error));
  });
  const app = express();

  app.disable("x-powered-by");
  app.use((request, response, next) => {
    setSecurityHeaders(response);
    response.setHeader("x-request-id", randomUUID());
    response.setHeader("cache-control", "no-store");
    next();
  });

  app.get("/healthz", (request, response) => {
    response.set("cache-control", "no-store");
    response.status(200).json({ status: "ok" });
  });

  app.get("/readyz", async (request, response) => {
    response.set("cache-control", "no-store");
    if (!databaseReady) {
      return response.status(503).json({ status: "not_ready", dependency: "database" });
    }
    if (durableStore) {
      try {
        await durableStore.checkHealth();
      } catch {
        return response.status(503).json({ status: "not_ready", dependency: "database" });
      }
    }
    return response.status(200).json({ status: "ready" });
  });

  const auth = createAuthMiddleware();
  if (auth) app.use(auth);

  const validatePaidGeneration = (request, response, next) => {
    const prompt = request.body?.prompt;
    if (typeof prompt !== "string" ||
      Buffer.byteLength(prompt.trim(), "utf8") === 0 ||
      Buffer.byteLength(prompt, "utf8") > MAX_INPUT_BYTES) {
      return response.status(400).json({ error: "Prompt must contain 1–64 KiB of text." });
    }
    if (runtime.mode === "production" && request.body?.dataConsent !== true) {
      return response.status(400).json({ error: "Confirm authorization to send this prompt to Hugging Face Inference Providers." });
    }
    if (!runtime.gpu.jobSubmissionEnabled) {
      return response.status(503).json({ error: "Text generation is unavailable until Hugging Face Inference Providers is configured and enabled." });
    }
    return next();
  };

  const paidGenerationHandler = async (request, response) => {
    const prompt = request.body.prompt;
    const controller = new AbortController();
    const cancelOnDisconnect = () => {
      if (!response.writableEnded) controller.abort();
    };
    request.once("aborted", cancelOnDisconnect);
    response.once("close", cancelOnDisconnect);
    try {
      const result = await runInference({
        jobId: response.getHeader("x-request-id"),
        prompt,
        signal: controller.signal
      });
      return response.status(200).json({
        success: true,
        output: result.generatedText,
        model: result.model,
        provider: result.provider
      });
    } catch (error) {
      console.error(`Paid generation failed for request ${response.getHeader("x-request-id")}.`, error.code || "inference_error");
      return response.status(502).json({ error: "Text generation failed; no successful output was produced." });
    } finally {
      request.removeListener("aborted", cancelOnDisconnect);
      response.removeListener("close", cancelOnDisconnect);
    }
  };

  if (x402.enabled) {
    const x402Middleware = options.x402Middleware || createX402Middleware();
    if (typeof durableStore?.recordApiPayment !== "function") {
      throw new Error("X402_ENABLED requires a durable store that can persist settlement receipts.");
    }
    app.post(
      PAID_GENERATION_PATH,
      (request, response, next) => storeReady.then(() => next(), next),
      express.json({ limit: "400kb", strict: true }),
      validatePaidGeneration,
      settlementReceiptMiddleware((receipt) => durableStore.recordApiPayment({
        ...receipt,
        asset: x402.assetAddress
      })),
      x402Middleware,
      paidGenerationHandler
    );
  } else {
    app.post(PAID_GENERATION_PATH, (request, response) => {
      return response.status(503).json({ error: "Paid generation is not enabled." });
    });
  }

  app.get("/auth/login", (request, response, next) => {
    if (!auth) return response.redirect(303, "/dashboard");
    return response.oidc.login({ returnTo: "/dashboard" }).catch(next);
  });

  app.get("/auth/signup", (request, response, next) => {
    if (!auth) {
      return response.status(503).json({ error: "Account sign-up is unavailable until Auth0 is configured." });
    }
    return response.oidc.login({
      returnTo: "/dashboard",
      authorizationParams: { screen_hint: "signup" }
    }).catch(next);
  });

  app.use((request, response, next) => {
    if (!request.url.startsWith("/api/") && request.method !== "GET") return next();
    if (request.url.startsWith("/api/")) {
      const url = new URL(request.originalUrl, `http://${request.headers.host || "127.0.0.1"}`);
      return handleApi(request, response, url, durableStore, storeReady, runInference).catch((error) => next(error));
    }

    const staticFile = staticFiles.get(new URL(request.originalUrl, "http://127.0.0.1").pathname);
    if (!staticFile) return next();
    const requestPath = new URL(request.originalUrl, "http://127.0.0.1").pathname;
    if (requestPath === "/dashboard"
      && (getRuntimeConfig().mode === "production" || getRuntimeConfig().auth.configured)) {
      if (!isAuthenticated(request)) {
        return response.oidc.login({ returnTo: "/dashboard" }).catch(next);
      }
      if (!isAllowedUser(request)) {
        return sendError(response, 403, "This account is not authorized to use this application.");
      }
    }
    const [fileName, contentType] = staticFile;
    response.type(contentType);
    return response.sendFile(path.join(__dirname, "public", fileName));
  });

  app.use((request, response) => sendError(response, 404, "Not found."));
  app.use((error, request, response, next) => {
    if (response.headersSent) return next(error);
    const status = error.status || 500;
    if (status === 500) {
      console.error(`Request ${response.getHeader("x-request-id")} failed.`, error.code || "request_error");
    }
    sendError(response, status, status === 500 ? "The service encountered an error." : error.message);
  });

  const server = http.createServer(app);
  let queueTimer;
  let queueRunning = false;
  let activeQueueRun = Promise.resolve();
  let queueAbortController = null;
  let closeResourcesPromise = null;

  function closeResources() {
    if (closeResourcesPromise) return closeResourcesPromise;
    if (queueTimer) clearInterval(queueTimer);
    queueAbortController?.abort();
    closeResourcesPromise = (async () => {
      await activeQueueRun;
      if (durableStore) await durableStore.close();
    })();
    return closeResourcesPromise;
  }

  async function drainQueue() {
    if (queueRunning || !durableStore || !databaseReady) return;
    queueRunning = true;
    queueAbortController = new AbortController();
    activeQueueRun = (async () => {
      try {
        await durableStore.expireSources();
        const queuedJob = await durableStore.claimNextJob();
        if (!queuedJob) return;
        try {
          const result = await runInference({
            jobId: queuedJob.jobId,
            prompt: queuedJob.text,
            signal: queueAbortController.signal
          });
          await durableStore.completeJob(queuedJob.jobId, result);
        } catch {
          await durableStore.failOrRetryJob(
            queuedJob.jobId,
            queuedJob.attempt,
            "Hugging Face inference failed."
          );
          console.error(`Queued inference job ${queuedJob.jobId} failed (attempt ${queuedJob.attempt}).`);
        }
      } catch (error) {
        console.error("Persistent job queue polling failed.", databaseErrorDetails(error));
      } finally {
        queueRunning = false;
        queueAbortController = null;
      }
    })();
    await activeQueueRun;
  }
  server.on("listening", () => {
    if (durableStore) {
      storeReady.then(() => {
        queueTimer = setInterval(drainQueue, 1000);
        queueTimer.unref?.();
        void drainQueue();
      }).catch((error) => {
        console.error("Persistent job queue startup failed.", databaseErrorDetails(error));
      });
    }
  });
  server.on("close", () => {
    void closeResources().catch((error) => {
      console.error("Application shutdown failed.", error.code || "shutdown_error");
    });
  });
  server.shutdown = async () => {
    if (queueTimer) clearInterval(queueTimer);
    queueAbortController?.abort();
    if (server.listening) {
      await new Promise((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    }
    await closeResources();
  };
  return server;
}

if (require.main === module) {
  const runtime = getRuntimeConfig();
  validateRuntimeConfig(runtime);
  const server = createServer();
  const host = process.env.HOST || (runtime.mode === "production" ? "0.0.0.0" : HOST);
  server.listen(PORT, host, () => {
    console.log(`GpuFiles runtime: ${runtime.mode}`);
    console.log(`Auth mode: ${runtime.auth.mode}; GPU: ${runtime.gpu.provider}; Settlement: ${runtime.settlement.enabled ? "x402 configured" : "disabled"}`);
    console.log(`Listening on ${host}:${PORT}`);
  });
  let shuttingDown = false;
  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`Received ${signal}; shutting down.`);
    const forceCloseTimer = setTimeout(() => {
      console.error("Graceful shutdown timed out; closing remaining HTTP connections.");
      server.closeAllConnections?.();
    }, 10_000);
    server.shutdown()
      .then(() => clearTimeout(forceCloseTimer))
      .catch((error) => {
        clearTimeout(forceCloseTimer);
        console.error("Graceful shutdown failed.", error.code || "shutdown_error");
        process.exitCode = 1;
      });
  };
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.once("SIGINT", () => shutdown("SIGINT"));
}

module.exports = { createServer, isAllowedUser, stateForIdentity };
