const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createServer, databaseErrorDetails, isAllowedUser, stateForIdentity } = require("../server");
const { MAX_INPUT_BYTES } = require("../worker");
const { PAYMENT_CONFIGURATION, createPaymentRecord } = require("../payments");
const { getRuntimeConfig, validateRuntimeConfig } = require("../config");
const { decryptSource, encryptSource, encryptionKey, postgresSslOptions } = require("../postgres-store");
const { redactText } = require("../privacy");
const { INFERENCE_URL, MAX_GENERATION_DURATION_MS, runHuggingFaceGeneration } = require("../huggingface");
const { getX402Configuration, validateX402Configuration } = require("../x402-payment");
const { encodePaymentResponseHeader } = require("@x402/core/http");

test("prompt size limit is 64 KiB", () => {
  assert.equal(MAX_INPUT_BYTES, 64 * 1024);
});

test("Docker image explicitly copies the public site before building", async () => {
  const dockerfile = await fs.readFile(path.join(__dirname, "..", "Dockerfile"), "utf8");
  assert.match(dockerfile, /^COPY public\/ \.\/public\/$/m);
  assert.match(dockerfile, /^RUN test -f public\/index\.html$/m);
});

test("payment records cannot claim funds moved", () => {
  const record = createPaymentRecord({ id: "job-1", buyerId: "buyer", priceUsd: 125 });
  assert.equal(PAYMENT_CONFIGURATION.enabled, false);
  assert.equal(record.status, "not_settled");
  assert.equal(record.transactionId, null);
});

test("PostgreSQL verifies TLS certificates by default and supports Render internal TLS", () => {
  assert.deepEqual(postgresSslOptions({ NODE_ENV: "production" }), { rejectUnauthorized: true });
  assert.deepEqual(postgresSslOptions({
    NODE_ENV: "production",
    DATABASE_SSL_REJECT_UNAUTHORIZED: "false"
  }), { rejectUnauthorized: false });
  assert.equal(postgresSslOptions({ NODE_ENV: "development" }), undefined);
  assert.throws(() => postgresSslOptions({
    NODE_ENV: "production",
    DATABASE_SSL_REJECT_UNAUTHORIZED: "no"
  }), /DATABASE_SSL_REJECT_UNAUTHORIZED/);
});

test("database connection logs include sanitized underlying errors", () => {
  const cause = Object.assign(
    new Error("connect ECONNREFUSED postgres://db-user:secret@db.example:5432/app"),
    { code: "ECONNREFUSED" }
  );
  const error = new Error("Connection terminated due to connection timeout", { cause });
  assert.equal(
    databaseErrorDetails(error),
    "Connection terminated due to connection timeout <- ECONNREFUSED: connect ECONNREFUSED postgres://[redacted]"
  );
  assert.doesNotMatch(databaseErrorDetails(error), /secret|db-user/);
});

test("x402 stays disabled by default and requires verified token, recipient, facilitator, and receipt settings", () => {
  const keys = [
    "X402_ENABLED", "X402_NETWORK", "X402_ASSET_ADDRESS", "X402_ASSET_DECIMALS",
    "X402_ASSET_NAME", "X402_ASSET_VERSION", "X402_ASSET_TRANSFER_METHOD",
    "X402_RECIPIENT", "CDP_API_KEY_ID", "CDP_API_KEY_SECRET", "DATABASE_URL"
  ];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  assert.equal(getX402Configuration().enabled, false);
  assert.doesNotThrow(validateX402Configuration);

  Object.assign(process.env, {
    X402_ENABLED: "true",
    X402_NETWORK: "eip155:42161",
    X402_ASSET_ADDRESS: "0x004B506865409877C9fA29bfb1ebA929984B9bbC",
    X402_ASSET_DECIMALS: "6",
    X402_ASSET_NAME: "Global Dollar",
    X402_ASSET_VERSION: "1",
    X402_ASSET_TRANSFER_METHOD: "eip3009",
    X402_RECIPIENT: "0x1111111111111111111111111111111111111111",
    CDP_API_KEY_ID: "test-key-id",
    CDP_API_KEY_SECRET: "test-key-secret",
    DATABASE_URL: "postgres://localhost/gpufiles"
  });
  assert.equal(getX402Configuration().configured, true);
  assert.doesNotThrow(validateX402Configuration);

  process.env.X402_ASSET_TRANSFER_METHOD = "";
  assert.throws(validateX402Configuration, /X402_ASSET_TRANSFER_METHOD/);
  for (const key of keys) {
    if (previous[key] === undefined) delete process.env[key];
    else process.env[key] = previous[key];
  }
});

test("paid generation uses the existing inference adapter and persists successful settlement receipts", async (t) => {
  const keys = [
    "NODE_ENV", "GPUFILES_RUNTIME_MODE", "DATABASE_URL", "GPU_PROVIDER", "HF_TOKEN", "HF_MODEL",
    "X402_ENABLED", "X402_NETWORK", "X402_ASSET_ADDRESS", "X402_ASSET_DECIMALS",
    "X402_ASSET_NAME", "X402_ASSET_VERSION", "X402_ASSET_TRANSFER_METHOD",
    "X402_RECIPIENT", "CDP_API_KEY_ID", "CDP_API_KEY_SECRET", "DATA_DIR"
  ];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gpufiles-x402-test-"));
  Object.assign(process.env, {
    DATABASE_URL: "postgres://localhost/gpufiles",
    GPU_PROVIDER: "huggingface-inference",
    HF_TOKEN: "private-test-token",
    HF_MODEL: "owner/test-model",
    X402_ENABLED: "true",
    X402_NETWORK: "eip155:42161",
    X402_ASSET_ADDRESS: "0x004B506865409877C9fA29bfb1ebA929984B9bbC",
    X402_ASSET_DECIMALS: "6",
    X402_ASSET_NAME: "Global Dollar",
    X402_ASSET_VERSION: "1",
    X402_ASSET_TRANSFER_METHOD: "eip3009",
    X402_RECIPIENT: "0x1111111111111111111111111111111111111111",
    CDP_API_KEY_ID: "test-key-id",
    CDP_API_KEY_SECRET: "test-key-secret",
    DATA_DIR: directory
  });
  let generatedPrompt;
  const receipts = [];
  let paymentMiddlewareCalls = 0;
  const durableStore = {
    initialize: async () => {},
    checkHealth: async () => {},
    recordApiPayment: async (receipt) => receipts.push(receipt),
    expireSources: async () => {},
    claimNextJob: async () => null,
    close: async () => {}
  };
  const x402Middleware = (request, response, next) => {
    paymentMiddlewareCalls += 1;
    response.setHeader("PAYMENT-RESPONSE", encodePaymentResponseHeader({
      success: true,
      transaction: "0xsettled-transaction",
      network: "eip155:42161",
      payer: "0x2222222222222222222222222222222222222222",
      amount: "10000"
    }));
    next();
  };
  const server = createServer({
    dataDir: directory,
    durableStore,
    x402Middleware,
    runInference: async ({ prompt }) => {
      generatedPrompt = prompt;
      if (prompt === "fail") throw new Error("provider failed");
      return {
        generatedText: "Paid response.",
        model: "owner/test-model",
        provider: "Hugging Face Inference Providers"
      };
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections?.();
    await server.shutdown();
    await fs.rm(directory, { recursive: true, force: true });
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  });

  const endpoint = `http://127.0.0.1:${server.address().port}/api/gpu-generate-text`;
  const invalid = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt: " " })
  });
  assert.equal(invalid.status, 400);
  assert.equal(paymentMiddlewareCalls, 0);

  const failedGeneration = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt: "fail" })
  });
  assert.equal(failedGeneration.status, 502);
  assert.equal(receipts.length, 0);

  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt: "Generate this after payment." })
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    success: true,
    output: "Paid response.",
    model: "owner/test-model",
    provider: "Hugging Face Inference Providers"
  });
  assert.equal(generatedPrompt, "Generate this after payment.");
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].amount, "10000");
  assert.equal(receipts[0].asset, "0x004B506865409877C9fA29bfb1ebA929984B9bbC");
  assert.equal(receipts[0].transactionId, "0xsettled-transaction");
});

test("PostgreSQL source encryption key must encode exactly 32 bytes", () => {
  const previous = process.env.DATA_ENCRYPTION_KEY;
  process.env.DATA_ENCRYPTION_KEY = "11".repeat(32);
  assert.equal(encryptionKey().length, 32);
  process.env.DATA_ENCRYPTION_KEY = "too-short";
  assert.throws(encryptionKey, /exactly 32 bytes/);
  if (previous === undefined) delete process.env.DATA_ENCRYPTION_KEY;
  else process.env.DATA_ENCRYPTION_KEY = previous;
});

test("queued prompt payloads use authenticated encryption", () => {
  const key = Buffer.alloc(32, 7);
  const plaintext = "private source text";
  const encrypted = encryptSource(plaintext, key);
  assert.equal(encrypted.ciphertext.includes(plaintext), false);
  assert.equal(decryptSource(encrypted, key), plaintext);
  assert.throws(() => decryptSource({ ...encrypted, authTag: Buffer.alloc(16).toString("base64") }, key));
});

test("PostgreSQL readiness check confirms a live database connection", async () => {
  const statements = [];
  const { createPostgresStore } = require("../postgres-store");
  const store = createPostgresStore({
    connectionString: "postgres://test:secret@localhost/test",
    key: Buffer.alloc(32),
    pool: {
      query: async (statement) => {
        statements.push(statement);
        return { rows: [{ "?column?": 1 }] };
      },
      end: async () => {}
    }
  });
  await store.checkHealth();
  assert.deepEqual(statements, ["SELECT 1"]);
  await store.recordApiPayment({
    requestId: "request-1",
    payer: "0x1111111111111111111111111111111111111111",
    amount: "10000",
    asset: "0x2222222222222222222222222222222222222222",
    network: "eip155:42161",
    transactionId: "0xtransaction"
  });
  assert.match(statements[1], /ON CONFLICT \(network, transaction_id\) DO NOTHING/);
  await store.close();
});

test("Auth0 allowlist requires an exact verified email match", () => {
  const previous = process.env.AUTH0_ALLOWED_EMAILS;
  process.env.AUTH0_ALLOWED_EMAILS = "owner@example.com, admin@example.com";
  assert.equal(isAllowedUser({ oidc: { user: { email: "OWNER@example.com", email_verified: true } } }), true);
  assert.equal(isAllowedUser({ oidc: { user: { email: "owner@example.com", email_verified: false } } }), false);
  assert.equal(isAllowedUser({ oidc: { user: { email: "other@example.com", email_verified: true } } }), false);
  if (previous === undefined) delete process.env.AUTH0_ALLOWED_EMAILS;
  else process.env.AUTH0_ALLOWED_EMAILS = previous;
});

test("runtime config exposes the production control surface without enabling live settlement by default", () => {
  const keys = [
    "NODE_ENV", "GPUFILES_RUNTIME_MODE", "AUTH0_DOMAIN", "AUTH0_CLIENT_ID",
    "AUTH0_CLIENT_SECRET", "AUTH0_SECRET", "DATABASE_URL", "X402_ENABLED"
  ];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  const config = getRuntimeConfig();
  assert.equal(config.mode, "local-preview");
  assert.equal(config.auth.mode, "unavailable");
  assert.equal(config.privacy.redactBeforeStorage, true);
  assert.equal(config.settlement.enabled, false);
  assert.equal(redactText("x".repeat(200), 32).endsWith("…"), true);
  const previousPort = process.env.PORT;
  process.env.PORT = "not-a-port";
  assert.throws(getRuntimeConfig, /PORT must be an integer/);
  if (previousPort === undefined) delete process.env.PORT;
  else process.env.PORT = previousPort;
  for (const key of keys) {
    if (previous[key] === undefined) delete process.env[key];
    else process.env[key] = previous[key];
  }
});

test("runtime config accepts Auth0 and external GPU environment variables without leaking secrets", () => {
  const keys = [
    "AUTH0_DOMAIN", "AUTH0_CLIENT_ID", "AUTH0_CLIENT_SECRET", "AUTH0_SECRET",
    "GPU_PROVIDER", "HF_TOKEN", "HF_MODEL"
  ];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  process.env.AUTH0_DOMAIN = "dev-a47ow65vustjo8g7.us.auth0.com.";
  process.env.AUTH0_CLIENT_ID = "test-client";
  process.env.AUTH0_CLIENT_SECRET = "test-client-secret";
  process.env.AUTH0_SECRET = "test-secret-value";
  process.env.GPU_PROVIDER = "huggingface-inference";
  process.env.HF_TOKEN = "private-test-token";
  process.env.HF_MODEL = "owner/test-model";
  const config = getRuntimeConfig();
  assert.equal(config.auth.mode, "auth0");
  assert.equal(config.auth.domain, "dev-a47ow65vustjo8g7.us.auth0.com");
  assert.equal(config.gpu.provider, "huggingface-inference");
  assert.equal(config.gpu.configured, true);
  assert.equal(JSON.stringify(config).includes("private-test-token"), false);
  for (const key of keys) {
    if (previous[key] === undefined) delete process.env[key];
    else process.env[key] = previous[key];
  }
});

test("Hugging Face adapter uses the Inference Providers chat-completion API and validates output", async () => {
  const previous = {
    HF_TOKEN: process.env.HF_TOKEN,
    HF_MODEL: process.env.HF_MODEL
  };
  process.env.HF_TOKEN = "private-test-token";
  process.env.HF_MODEL = "owner/test-model";
  let requestUrl;
  let requestOptions;
  const result = await runHuggingFaceGeneration({
    jobId: "job-1",
    prompt: "Write a greeting.",
    fetchImpl: async (url, options) => {
      requestUrl = url;
      requestOptions = options;
      return new Response(JSON.stringify({
        choices: [{ message: { content: "Hello there." } }]
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
  });
  assert.equal(requestUrl, INFERENCE_URL);
  assert.equal(requestOptions.headers.authorization, "Bearer private-test-token");
  assert.equal(requestOptions.headers["x-request-id"], "job-1");
  assert.deepEqual(JSON.parse(requestOptions.body), {
    model: "owner/test-model",
    messages: [{ role: "user", content: "Write a greeting." }],
    max_tokens: 200,
    temperature: 0.7,
    stream: false
  });
  assert.equal(result.generatedText, "Hello there.");
  assert.equal(result.provider, "Hugging Face Inference Providers");
  assert.ok(MAX_GENERATION_DURATION_MS < 5 * 60 * 1000);
  await assert.rejects(
    runHuggingFaceGeneration({
      jobId: "job-2",
      prompt: "Try again",
      fetchImpl: async () => new Response(JSON.stringify({ error: "provider unavailable" }), { status: 503 })
    }),
    /temporarily unavailable/
  );
  if (previous.HF_TOKEN === undefined) delete process.env.HF_TOKEN;
  else process.env.HF_TOKEN = previous.HF_TOKEN;
  if (previous.HF_MODEL === undefined) delete process.env.HF_MODEL;
  else process.env.HF_MODEL = previous.HF_MODEL;
});

test("production configuration fails closed without complete Auth0 and HTTPS settings", () => {
  const keys = [
    "NODE_ENV", "GPUFILES_RUNTIME_MODE", "AUTH0_DOMAIN", "AUTH0_CLIENT_ID",
    "AUTH0_CLIENT_SECRET", "AUTH0_SECRET", "AUTH0_ALLOWED_EMAILS", "BASE_URL", "X402_ENABLED",
    "DATABASE_URL", "DATA_ENCRYPTION_KEY"
  ];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  process.env.NODE_ENV = "production";

  assert.throws(validateRuntimeConfig, /Production requires AUTH0_DOMAIN/);

  for (const key of keys) {
    if (previous[key] === undefined) delete process.env[key];
    else process.env[key] = previous[key];
  }
});

test("production refuses unsafe settlement activation and job uploads need a configured acknowledged provider", () => {
  const keys = [
    "NODE_ENV", "GPUFILES_RUNTIME_MODE", "AUTH0_DOMAIN", "AUTH0_CLIENT_ID",
    "AUTH0_CLIENT_SECRET", "AUTH0_SECRET", "AUTH0_ALLOWED_EMAILS", "BASE_URL", "X402_ENABLED",
    "GPU_PROVIDER", "HF_TOKEN", "HF_MODEL", "GPU_PROVIDER_PRIVACY_ACKNOWLEDGED",
    "DATABASE_URL", "DATA_ENCRYPTION_KEY", "X402_NETWORK",
    "X402_ASSET_ADDRESS", "X402_ASSET_DECIMALS", "X402_ASSET_NAME",
    "X402_ASSET_VERSION", "X402_ASSET_TRANSFER_METHOD", "X402_RECIPIENT",
    "CDP_API_KEY_ID", "CDP_API_KEY_SECRET"
  ];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  Object.assign(process.env, {
    NODE_ENV: "production",
    AUTH0_DOMAIN: "tenant.example.auth0.com",
    AUTH0_CLIENT_ID: "public-client-id",
    AUTH0_CLIENT_SECRET: "server-client-secret",
    AUTH0_SECRET: "a-session-secret-that-is-at-least-32-bytes-long",
    AUTH0_ALLOWED_EMAILS: "owner@example.com",
    BASE_URL: "https://market.example.com",
    DATABASE_URL: "postgresql://user:pass@localhost:5432/gpufiles",
    DATA_ENCRYPTION_KEY: "11".repeat(32),
    X402_ENABLED: "false"
  });

  delete process.env.AUTH0_ALLOWED_EMAILS;
  assert.throws(validateRuntimeConfig, /AUTH0_ALLOWED_EMAILS/);
  process.env.AUTH0_ALLOWED_EMAILS = "owner@example.com";
  assert.doesNotThrow(validateRuntimeConfig);
  process.env.AUTH0_DOMAIN = "https://tenant.example.auth0.com/untrusted-path";
  assert.throws(validateRuntimeConfig, /AUTH0_DOMAIN must be an HTTPS hostname/);
  process.env.AUTH0_DOMAIN = "tenant.example.auth0.com";
  assert.equal(getRuntimeConfig().gpu.jobSubmissionEnabled, false);
  process.env.GPU_PROVIDER = "huggingface-inference";
  process.env.HF_TOKEN = "server-provider-key";
  process.env.HF_MODEL = "owner/test-model";
  assert.equal(getRuntimeConfig().gpu.jobSubmissionEnabled, false);
  process.env.GPU_PROVIDER_PRIVACY_ACKNOWLEDGED = "true";
  assert.equal(getRuntimeConfig().gpu.jobSubmissionEnabled, true);
  process.env.X402_ENABLED = "true";
  assert.throws(validateRuntimeConfig, /X402_ASSET_DECIMALS/);

  for (const key of keys) {
    if (previous[key] === undefined) delete process.env[key];
    else process.env[key] = previous[key];
  }
});

test("authenticated state is scoped to the caller and omits internal identifiers", () => {
  const state = {
    jobs: [
      { id: "buyer-job", buyerId: "buyer-1", providerId: null, status: "open", title: "Buyer job", fileName: "a.txt", priceUsd: 100, result: null },
      { id: "other-job", buyerId: "buyer-2", providerId: null, status: "open", title: "Open job", fileName: "b.txt", priceUsd: 200, result: null },
      { id: "private-job", buyerId: "buyer-2", providerId: "provider-1", status: "completed", title: "Private job", fileName: "c.txt", priceUsd: 300, result: null }
    ],
    payments: [
      { id: "pay-a", jobId: "buyer-job", buyerId: "buyer-1", providerId: null, status: "not_settled", note: "No payment." },
      { id: "pay-b", jobId: "other-job", buyerId: "buyer-2", providerId: null, status: "not_settled", note: "No payment." },
      { id: "pay-c", jobId: "private-job", buyerId: "buyer-2", providerId: "provider-1", status: "not_settled", note: "No payment." }
    ]
  };

  const buyerState = stateForIdentity(state, "buyer", "buyer-1");
  assert.deepEqual(buyerState.jobs.map((job) => job.id), ["buyer-job"]);
  assert.deepEqual(buyerState.payments.map((payment) => payment.id), ["pay-a"]);
  assert.equal("buyerId" in buyerState.jobs[0], false);
  assert.equal("providerId" in buyerState.payments[0], false);

  const providerState = stateForIdentity(state, "provider", "provider-1");
  assert.deepEqual(providerState.jobs.map((job) => job.id), ["buyer-job", "other-job", "private-job"]);
  assert.deepEqual(providerState.payments.map((payment) => payment.id), ["pay-c"]);
});

test("local API enforces demo roles and prompt job lifecycle without storing prompts", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gpufiles-test-"));
  const keys = [
    "NODE_ENV", "GPUFILES_RUNTIME_MODE", "DATA_DIR", "GPU_PROVIDER", "HF_TOKEN", "HF_MODEL", "GPU_PROVIDER_PRIVACY_ACKNOWLEDGED",
    "AUTH0_DOMAIN", "AUTH0_CLIENT_ID", "AUTH0_CLIENT_SECRET", "AUTH0_SECRET", "AUTH0_ALLOWED_EMAILS",
    "X402_ENABLED"
  ];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  process.env.DATA_DIR = directory;
  process.env.NODE_ENV = "development";
  process.env.GPUFILES_RUNTIME_MODE = "local-preview";
  for (const key of ["AUTH0_DOMAIN", "AUTH0_CLIENT_ID", "AUTH0_CLIENT_SECRET", "AUTH0_SECRET", "AUTH0_ALLOWED_EMAILS"]) {
    delete process.env[key];
  }
  Object.assign(process.env, {
    GPU_PROVIDER: "huggingface-inference",
    HF_TOKEN: "private-test-token",
    HF_MODEL: "owner/test-model",
    X402_ENABLED: "false"
  });
  const server = createServer({
    runInference: async () => ({
      generatedText: "Generated response.",
      model: "owner/test-model",
      provider: "Hugging Face Inference Providers",
      executionMode: "external"
    })
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const base = `http://127.0.0.1:${address.port}`;
  t.after(async () => {
    server.closeAllConnections?.();
    await server.shutdown();
    await fs.rm(directory, { recursive: true, force: true });
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  });

  const post = (url, body, cookie = "") => fetch(`${base}${url}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body)
  });

  const page = await fetch(base);
  assert.equal(page.status, 200);
  assert.match(page.headers.get("x-request-id"), /^[0-9a-f-]{36}$/i);
  assert.deepEqual(await (await fetch(`${base}/healthz`)).json(), { status: "ok" });
  assert.deepEqual(await (await fetch(`${base}/readyz`)).json(), { status: "ready" });
  const disabledPaidEndpoint = await post("/api/gpu-generate-text", { prompt: "Do not run without payment." });
  assert.equal(disabledPaidEndpoint.status, 503);
  assert.match(page.headers.get("content-security-policy"), /default-src 'self'/);
  const pageHtml = await page.text();
  assert.match(pageHtml, /Your prompts/);
  assert.match(pageHtml, /LOCAL PREVIEW/);
  assert.match(pageHtml, /Provider and payment availability depend on the current service configuration/);
  assert.match(pageHtml, /Render enables separate x402 paid text generation/);
  assert.doesNotMatch(pageHtml, /External GPU and x402 settlement remain disabled until configured/);
  assert.match(pageHtml, /id="job-prompt"/);
  assert.match(pageHtml, /Hugging Face Inference Providers/);
  const howItWorksPage = await fetch(`${base}/how-it-works`);
  assert.match(await howItWorksPage.text(), /Render enables a separate x402 wallet checkout/);
  const docsPage = await fetch(`${base}/docs`);
  const docsHtml = await docsPage.text();
  assert.match(docsHtml, /Render Blueprint uses Free web and PostgreSQL plans and sets <code>X402_ENABLED=true<\/code>/);
  assert.match(docsHtml, /Free PostgreSQL expires after 30 days/);
  const loginPage = await fetch(`${base}/login`);
  assert.equal(loginPage.status, 200);
  assert.match(await loginPage.text(), /href="\/auth\/signup">Create an account/);
  const signupUnavailable = await fetch(`${base}/auth/signup`);
  assert.equal(signupUnavailable.status, 503);
  assert.match((await signupUnavailable.json()).error, /Auth0 is configured/);
  assert.equal((await fetch(`${base}/app.js`)).status, 200);
  const paymentClient = await fetch(`${base}/payment-client.js`);
  assert.equal(paymentClient.status, 200);
  assert.match(await paymentClient.text(), /GpuFilesPaidGeneration/);
  assert.match(pageHtml, /Pay per response/);
  const localStateResponse = await fetch(`${base}/api/state`);
  assert.equal(localStateResponse.status, 200);
  assert.equal(localStateResponse.headers.get("cache-control"), "no-store");
  assert.doesNotMatch(JSON.stringify(await localStateResponse.json()), /private-test-token/);

  const crossOrigin = await fetch(`${base}/api/demo/role`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://evil.example" },
    body: JSON.stringify({ role: "provider" })
  });
  assert.equal(crossOrigin.status, 403);

  const forbidden = await post("/api/jobs", { title: "test job" }, "demoRole=provider");
  assert.equal(forbidden.status, 403);

  const configuredModel = process.env.HF_MODEL;
  delete process.env.HF_MODEL;
  const unavailable = await post("/api/jobs", {
    title: "Unavailable generation",
    prompt: "This should not be accepted.",
    priceUsd: 150
  });
  assert.equal(unavailable.status, 503);
  process.env.HF_MODEL = configuredModel;

  const createdResponse = await post("/api/jobs", {
    title: "Draft a greeting",
    prompt: "Write a greeting.",
    priceUsd: 150
  });
  assert.equal(createdResponse.status, 201);
  const { job } = await createdResponse.json();
  assert.equal(job.fileName, "text prompt");
  assert.equal("buyerId" in job, false);

  const acceptedResponse = await post(`/api/jobs/${job.id}/accept`, {}, "demoRole=provider");
  assert.equal(acceptedResponse.status, 200);
  const accepted = (await acceptedResponse.json()).job;
  assert.equal(accepted.status, "completed");
  assert.equal(accepted.result.generatedText, "Generated response.");

  const approvalResponse = await post(`/api/jobs/${job.id}/approve`, {});
  assert.equal(approvalResponse.status, 200);
  const approved = await approvalResponse.json();
  assert.equal(approved.job.status, "approved_unpaid");
  assert.equal(approved.payment.status, "not_settled");

  const persisted = await fs.readFile(path.join(directory, "state.json"), "utf8");
  assert.equal(persisted.includes("Write a greeting."), false);
});

test("production APIs require Auth0 sessions and never expose demo identities", async (t) => {
  const keys = [
    "NODE_ENV", "GPUFILES_RUNTIME_MODE", "AUTH0_DOMAIN", "AUTH0_CLIENT_ID",
    "AUTH0_CLIENT_SECRET", "AUTH0_SECRET", "AUTH0_ALLOWED_EMAILS", "BASE_URL", "DATA_DIR",
    "DATABASE_URL", "DATA_ENCRYPTION_KEY", "X402_ENABLED", "X402_NETWORK",
    "X402_ASSET_ADDRESS", "X402_ASSET_DECIMALS", "X402_ASSET_NAME",
    "X402_ASSET_VERSION", "X402_ASSET_TRANSFER_METHOD", "X402_RECIPIENT",
    "CDP_API_KEY_ID", "CDP_API_KEY_SECRET"
  ];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gpufiles-production-test-"));
  for (const key of keys) delete process.env[key];
  Object.assign(process.env, {
    NODE_ENV: "production",
    GPUFILES_RUNTIME_MODE: "production",
    AUTH0_DOMAIN: "tenant.example.auth0.com",
    AUTH0_CLIENT_ID: "public-client-id",
    AUTH0_CLIENT_SECRET: "server-client-secret",
    AUTH0_SECRET: "a-session-secret-that-is-at-least-32-bytes-long",
    AUTH0_ALLOWED_EMAILS: "owner@example.com",
    BASE_URL: "https://market.example.com",
    DATA_DIR: directory,
    DATABASE_URL: "postgresql://user:pass@localhost:5432/gpufiles",
    DATA_ENCRYPTION_KEY: "11".repeat(32)
  });

  let databaseHealthy = true;
  let initializationAttempts = 0;
  const server = createServer({
    durableStore: {
      initialize: async () => {
        initializationAttempts += 1;
        if (initializationAttempts === 1) {
          const cause = Object.assign(new Error("temporary database connection failure"), {
            code: "ECONNRESET"
          });
          throw new Error("Connection terminated due to connection timeout", { cause });
        }
      },
      checkHealth: async () => {
        if (!databaseHealthy) throw new Error("database unavailable");
      },
      expireSources: async () => {},
      claimNextJob: async () => null,
      close: async () => {}
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.closeAllConnections?.();
    await server.shutdown();
    await fs.rm(directory, { recursive: true, force: true });
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  });

  const stateResponse = await fetch(`${base}/api/state`);
  assert.equal(stateResponse.status, 401);
  assert.match(stateResponse.headers.get("x-request-id"), /^[0-9a-f-]{36}$/i);
  assert.deepEqual(await (await fetch(`${base}/healthz`)).json(), { status: "ok" });
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if ((await fetch(`${base}/readyz`)).status === 200) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal((await fetch(`${base}/readyz`)).status, 200);
  assert.equal(initializationAttempts, 2);
  databaseHealthy = false;
  assert.equal((await fetch(`${base}/readyz`)).status, 503);
  databaseHealthy = true;
  assert.match(stateResponse.headers.get("strict-transport-security"), /max-age=31536000/);
  const signInPage = await fetch(`${base}/login`);
  assert.equal(signInPage.status, 200);
  const signInHtml = await signInPage.text();
  assert.match(signInHtml, /Continue securely/);
  assert.doesNotMatch(signInHtml, /type=["']password["']/i);
  const roleResponse = await fetch(`${base}/api/demo/role`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://market.example.com" },
    body: JSON.stringify({ role: "provider" })
  });
  assert.equal(roleResponse.status, 401);
  assert.equal((await fetch(base)).status, 200);
});
