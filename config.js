const { getX402Configuration, validateX402Configuration } = require("./x402-payment");

function getRuntimeConfig() {
  const nodeEnv = process.env.NODE_ENV || "development";
  const requestedMode = process.env.GPUFILES_RUNTIME_MODE;
  if (requestedMode && !["local-preview", "production"].includes(requestedMode)) {
    throw new Error("GPUFILES_RUNTIME_MODE must be local-preview or production.");
  }
  const mode = nodeEnv === "production" || requestedMode === "production"
    ? "production"
    : requestedMode || "local-preview";
  const port = Number(process.env.PORT || 4173);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("PORT must be an integer between 1 and 65535.");
  }
  const gpuProvider = process.env.GPU_PROVIDER || (mode === "production" ? "unconfigured" : "local-cpu");
  const huggingFaceConfigured = Boolean(process.env.HF_TOKEN && process.env.HF_MODEL);
  const privacyAcknowledged = process.env.GPU_PROVIDER_PRIVACY_ACKNOWLEDGED === "true";
  const authPresent = Boolean(
    process.env.AUTH0_DOMAIN ||
      process.env.AUTH0_CLIENT_ID ||
      process.env.AUTH0_CLIENT_SECRET ||
      process.env.AUTH0_SECRET
  );
  const authConfigured = Boolean(
    process.env.AUTH0_DOMAIN &&
      process.env.AUTH0_CLIENT_ID &&
      process.env.AUTH0_CLIENT_SECRET &&
      process.env.AUTH0_SECRET
  );
  const allowedEmails = (process.env.AUTH0_ALLOWED_EMAILS || "")
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);
  const x402 = getX402Configuration();

  return {
    mode,
    startedAt: new Date().toISOString(),
    auth: {
      mode: authConfigured ? "auth0" : "unavailable",
      configured: authConfigured,
      partiallyConfigured: authPresent && !authConfigured,
      allowedUsersConfigured: allowedEmails.length > 0,
      provider: authConfigured ? "Auth0" : "unavailable",
      domain: process.env.AUTH0_DOMAIN
        ? process.env.AUTH0_DOMAIN.replace(/^https?:\/\//, "").replace(/\/$/, "").replace(/\.+$/, "")
        : null
    },
    gpu: {
      provider: gpuProvider,
      executionMode: gpuProvider === "local-cpu" ? "unavailable" : "external",
      configured: gpuProvider === "huggingface-inference" && huggingFaceConfigured,
      privacyAcknowledged,
      jobSubmissionEnabled: Boolean(
        gpuProvider === "huggingface-inference" &&
        huggingFaceConfigured &&
        (mode !== "production" || privacyAcknowledged)
      ),
      supported: ["huggingface-inference"]
    },
    privacy: {
      mode: process.env.PRIVACY_MODE || (mode === "production" ? "external-provider" : "ephemeral-memory"),
      redactBeforeStorage: true,
      sourceRetention: mode === "production"
        ? "encrypted PostgreSQL prompt; removed after processing or expiry, not secure erasure"
        : "ephemeral process memory for up to one hour; not a secure deletion guarantee",
      auditLogging: "no source payloads"
    },
    settlement: {
      enabled: x402.enabled && x402.configured,
      implemented: true,
      protocol: "x402",
      asset: "USDG",
      network: x402.network,
      configured: x402.configured,
      recipient: x402.recipient || null
    },
    storage: {
      durable: Boolean(process.env.DATABASE_URL),
      queue: process.env.DATABASE_URL ? "postgresql" : "in-memory"
    },
    environment: {
      nodeEnv,
      host: process.env.HOST || "127.0.0.1",
      port
    }
  };
}

function validateRuntimeConfig(config = getRuntimeConfig()) {
  if (config.mode !== "production") return;
  if (config.auth.partiallyConfigured || !config.auth.configured) {
    throw new Error("Production requires AUTH0_DOMAIN, AUTH0_CLIENT_ID, AUTH0_CLIENT_SECRET, and AUTH0_SECRET.");
  }
  let authDomain;
  try {
    authDomain = new URL(
      process.env.AUTH0_DOMAIN.includes("://")
        ? process.env.AUTH0_DOMAIN
        : `https://${process.env.AUTH0_DOMAIN}`
    );
  } catch {
    throw new Error("AUTH0_DOMAIN must be a valid Auth0 hostname.");
  }
  if (authDomain.protocol !== "https:" || !authDomain.hostname ||
    authDomain.username || authDomain.password || authDomain.pathname !== "/" ||
    authDomain.search || authDomain.hash) {
    throw new Error("AUTH0_DOMAIN must be an HTTPS hostname without credentials, path, query, or fragment.");
  }
  if (Buffer.byteLength(process.env.AUTH0_SECRET || "", "utf8") < 32) {
    throw new Error("AUTH0_SECRET must contain at least 32 bytes.");
  }
  let baseUrl;
  try {
    baseUrl = new URL(process.env.BASE_URL);
  } catch {
    throw new Error("Production requires BASE_URL to be the public HTTPS service URL.");
  }
  if (baseUrl.protocol !== "https:" || baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash) {
    throw new Error("Production BASE_URL must be a public HTTPS URL without credentials, query, or fragment.");
  }
  if (baseUrl.pathname !== "/") {
    throw new Error("Production BASE_URL must be the HTTPS origin without a path.");
  }
  const allowedEmails = (process.env.AUTH0_ALLOWED_EMAILS || "")
    .split(",")
    .map((email) => email.trim())
    .filter(Boolean);
  if (!allowedEmails.length || allowedEmails.some((email) =>
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
  )) {
    throw new Error("Production requires AUTH0_ALLOWED_EMAILS with at least one valid email address.");
  }
  if (!process.env.DATABASE_URL) {
    throw new Error("Production requires DATABASE_URL for durable PostgreSQL storage and job queueing.");
  }
  let databaseUrl;
  try {
    databaseUrl = new URL(process.env.DATABASE_URL);
  } catch {
    throw new Error("DATABASE_URL must be a valid PostgreSQL connection URL.");
  }
  if (!["postgres:", "postgresql:"].includes(databaseUrl.protocol)) {
    throw new Error("DATABASE_URL must use the PostgreSQL protocol.");
  }
  const encryptionKey = process.env.DATA_ENCRYPTION_KEY || "";
  const keyBytes = /^[0-9a-f]{64}$/i.test(encryptionKey)
    ? 32
    : Buffer.from(encryptionKey, "base64").length;
  if (keyBytes !== 32) {
    throw new Error("Production requires DATA_ENCRYPTION_KEY encoding exactly 32 bytes as hex or base64.");
  }
  validateX402Configuration();
}

module.exports = { getRuntimeConfig, validateRuntimeConfig };
