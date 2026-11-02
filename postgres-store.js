const { Pool } = require("pg");
const { createCipheriv, createDecipheriv, randomBytes, randomUUID } = require("node:crypto");

const SOURCE_RETENTION_MS = 60 * 60 * 1000;
const QUEUE_LEASE_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 3;

function encryptionKey(value = process.env.DATA_ENCRYPTION_KEY) {
  if (!value) throw new Error("DATA_ENCRYPTION_KEY is required for PostgreSQL source encryption.");
  const key = /^[0-9a-f]{64}$/i.test(value)
    ? Buffer.from(value, "hex")
    : Buffer.from(value, "base64");
  if (key.length !== 32) throw new Error("DATA_ENCRYPTION_KEY must encode exactly 32 bytes as hex or base64.");
  return key;
}

function encryptSource(text, key) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  return {
    iv: iv.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64")
  };
}

function decryptSource(source, key) {
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(source.iv, "base64"));
  decipher.setAuthTag(Buffer.from(source.authTag || source.auth_tag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(source.ciphertext, "base64")),
    decipher.final()
  ]).toString("utf8");
}

function createPostgresStore({ connectionString = process.env.DATABASE_URL, key = encryptionKey(), pool } = {}) {
  if (!connectionString && !pool) throw new Error("DATABASE_URL is required for PostgreSQL storage.");
  const database = pool || new Pool({
    connectionString,
    max: 10,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
    query_timeout: 20_000,
    statement_timeout: 15_000,
    ...(process.env.NODE_ENV === "production" ? { ssl: { rejectUnauthorized: true } } : {})
  });

  async function initialize() {
    await database.query(`
      CREATE TABLE IF NOT EXISTS marketplace_jobs (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        file_name TEXT NOT NULL,
        buyer_id TEXT NOT NULL,
        provider_id TEXT,
        price_usd INTEGER NOT NULL,
        currency TEXT NOT NULL,
        network TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        approved_at TIMESTAMPTZ,
        result JSONB
      );
      CREATE INDEX IF NOT EXISTS marketplace_jobs_buyer_created
        ON marketplace_jobs (buyer_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS marketplace_jobs_provider_status
        ON marketplace_jobs (provider_id, status);
      CREATE TABLE IF NOT EXISTS marketplace_payments (
        id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL REFERENCES marketplace_jobs(id) ON DELETE CASCADE,
        buyer_id TEXT NOT NULL,
        provider_id TEXT,
        amount_usd INTEGER NOT NULL,
        asset TEXT NOT NULL,
        network TEXT NOT NULL,
        protocol TEXT NOT NULL,
        status TEXT NOT NULL,
        transaction_id TEXT,
        note TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS marketplace_payments_job ON marketplace_payments (job_id);
      CREATE TABLE IF NOT EXISTS marketplace_api_payments (
        id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL,
        payer TEXT,
        amount TEXT,
        asset TEXT NOT NULL,
        network TEXT NOT NULL,
        transaction_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'settled',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (network, transaction_id)
      );
      CREATE TABLE IF NOT EXISTS marketplace_sources (
        job_id TEXT PRIMARY KEY REFERENCES marketplace_jobs(id) ON DELETE CASCADE,
        ciphertext TEXT NOT NULL,
        iv TEXT NOT NULL,
        auth_tag TEXT NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL
      );
      CREATE TABLE IF NOT EXISTS marketplace_job_queue (
        job_id TEXT PRIMARY KEY REFERENCES marketplace_jobs(id) ON DELETE CASCADE,
        status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        locked_until TIMESTAMPTZ,
        last_error TEXT
      );
      CREATE INDEX IF NOT EXISTS marketplace_queue_ready
        ON marketplace_job_queue (available_at, locked_until)
        WHERE status IN ('pending', 'processing');
    `);
  }

  async function checkHealth() {
    await database.query("SELECT 1");
  }

  async function recordApiPayment(payment) {
    await database.query(
      `INSERT INTO marketplace_api_payments
       (id, request_id, payer, amount, asset, network, transaction_id, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'settled')
       ON CONFLICT (network, transaction_id) DO NOTHING`,
      [randomUUID(), payment.requestId, payment.payer, payment.amount, payment.asset,
        payment.network, payment.transactionId]
    );
  }

  async function readState() {
    const [jobs, payments] = await Promise.all([
      database.query("SELECT * FROM marketplace_jobs ORDER BY created_at DESC"),
      database.query("SELECT * FROM marketplace_payments ORDER BY id DESC")
    ]);
    return {
      jobs: jobs.rows.map((row) => ({
        id: row.id,
        title: row.title,
        fileName: row.file_name,
        buyerId: row.buyer_id,
        providerId: row.provider_id,
        priceUsd: row.price_usd,
        currency: row.currency,
        network: row.network,
        status: row.status,
        createdAt: row.created_at.toISOString(),
        approvedAt: row.approved_at?.toISOString(),
        result: row.result
      })),
      payments: payments.rows.map((row) => ({
        id: row.id,
        jobId: row.job_id,
        buyerId: row.buyer_id,
        providerId: row.provider_id,
        amountUsd: row.amount_usd,
        asset: row.asset,
        network: row.network,
        protocol: row.protocol,
        status: row.status,
        transactionId: row.transaction_id,
        note: row.note
      }))
    };
  }

  async function createJob(job, payment, text) {
    const encrypted = encryptSource(text, key);
    const client = await database.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO marketplace_jobs
         (id, title, file_name, buyer_id, price_usd, currency, network, status, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [job.id, job.title, job.fileName, job.buyerId, job.priceUsd, job.currency, job.network, job.status, job.createdAt]
      );
      await client.query(
        `INSERT INTO marketplace_payments
         (id, job_id, buyer_id, amount_usd, asset, network, protocol, status, transaction_id, note)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [payment.id, payment.jobId, payment.buyerId, payment.amountUsd, payment.asset, payment.network,
          payment.protocol, payment.status, payment.transactionId, payment.note]
      );
      await client.query(
        `INSERT INTO marketplace_sources (job_id, ciphertext, iv, auth_tag, expires_at)
         VALUES ($1,$2,$3,$4,NOW() + ($5 * INTERVAL '1 millisecond'))`,
        [job.id, encrypted.ciphertext, encrypted.iv, encrypted.authTag, SOURCE_RETENTION_MS]
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async function acceptJob(jobId, providerId) {
    const client = await database.connect();
    try {
      await client.query("BEGIN");
      const selected = await client.query(
        "SELECT status FROM marketplace_jobs WHERE id = $1 FOR UPDATE",
        [jobId]
      );
      if (!selected.rowCount) {
        await client.query("ROLLBACK");
        return { error: "not_found" };
      }
      if (selected.rows[0].status !== "open") {
        await client.query("ROLLBACK");
        return { error: "not_open" };
      }
      const source = await client.query(
        "SELECT 1 FROM marketplace_sources WHERE job_id = $1 AND expires_at > NOW()",
        [jobId]
      );
      if (!source.rowCount) {
        await client.query(
          "UPDATE marketplace_jobs SET status = 'failed' WHERE id = $1",
          [jobId]
        );
        await client.query("DELETE FROM marketplace_sources WHERE job_id = $1", [jobId]);
        await client.query("COMMIT");
        return { error: "source_expired" };
      }
      await client.query(
        "UPDATE marketplace_jobs SET status = 'processing', provider_id = $2 WHERE id = $1",
        [jobId, providerId]
      );
      await client.query(
        `UPDATE marketplace_sources
         SET expires_at = NOW() + ($2 * INTERVAL '1 millisecond')
         WHERE job_id = $1`,
        [jobId, SOURCE_RETENTION_MS]
      );
      await client.query(
        `INSERT INTO marketplace_job_queue (job_id) VALUES ($1)
         ON CONFLICT (job_id) DO NOTHING`,
        [jobId]
      );
      await client.query("COMMIT");
      return { accepted: true };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async function claimNextJob() {
    const client = await database.connect();
    try {
      await client.query("BEGIN");
      const claimed = await client.query(
        `SELECT q.job_id, q.attempts, s.ciphertext, s.iv, s.auth_tag, s.expires_at,
                j.file_name
         FROM marketplace_job_queue q
         JOIN marketplace_jobs j ON j.id = q.job_id
         JOIN marketplace_sources s ON s.job_id = q.job_id
         WHERE q.available_at <= NOW()
           AND (q.status = 'pending' OR (q.status = 'processing' AND q.locked_until < NOW()))
           AND s.expires_at > NOW()
         ORDER BY q.available_at
         FOR UPDATE OF q SKIP LOCKED
         LIMIT 1`
      );
      if (!claimed.rowCount) {
        await client.query("COMMIT");
        return null;
      }
      const row = claimed.rows[0];
      await client.query(
        `UPDATE marketplace_job_queue
         SET status = 'processing', attempts = attempts + 1,
             locked_until = NOW() + ($2 * INTERVAL '1 millisecond')
         WHERE job_id = $1`,
        [row.job_id, QUEUE_LEASE_MS]
      );
      await client.query("COMMIT");
      return {
        jobId: row.job_id,
        attempt: row.attempts + 1,
        fileName: row.file_name,
        text: decryptSource(row, key)
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async function completeJob(jobId, result) {
    const client = await database.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "UPDATE marketplace_jobs SET status = 'completed', result = $2::jsonb WHERE id = $1 AND status = 'processing'",
        [jobId, JSON.stringify(result)]
      );
      await client.query("UPDATE marketplace_payments SET provider_id = (SELECT provider_id FROM marketplace_jobs WHERE id = $1) WHERE job_id = $1", [jobId]);
      await client.query("UPDATE marketplace_job_queue SET status = 'completed', locked_until = NULL WHERE job_id = $1", [jobId]);
      await client.query("DELETE FROM marketplace_sources WHERE job_id = $1", [jobId]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async function failOrRetryJob(jobId, attempt, errorMessage) {
    const client = await database.connect();
    try {
      await client.query("BEGIN");
      if (attempt < MAX_ATTEMPTS) {
        const delayMs = 5_000 * attempt;
        await client.query(
          `UPDATE marketplace_job_queue
           SET status = 'pending', available_at = NOW() + ($2 * INTERVAL '1 millisecond'),
               locked_until = NULL, last_error = $3
           WHERE job_id = $1`,
          [jobId, delayMs, errorMessage.slice(0, 500)]
        );
      } else {
        await client.query("UPDATE marketplace_jobs SET status = 'failed' WHERE id = $1", [jobId]);
        await client.query(
          "UPDATE marketplace_job_queue SET status = 'failed', locked_until = NULL, last_error = $2 WHERE job_id = $1",
          [jobId, errorMessage.slice(0, 500)]
        );
        await client.query("DELETE FROM marketplace_sources WHERE job_id = $1", [jobId]);
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async function approveJob(jobId, buyerId, note) {
    const client = await database.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query(
        `UPDATE marketplace_jobs SET status = 'approved_unpaid', approved_at = NOW()
         WHERE id = $1 AND buyer_id = $2 AND status = 'completed'
         RETURNING id`,
        [jobId, buyerId]
      );
      if (!result.rowCount) {
        const job = await client.query("SELECT buyer_id, status FROM marketplace_jobs WHERE id = $1", [jobId]);
        await client.query("ROLLBACK");
        if (!job.rowCount) return { error: "not_found" };
        if (job.rows[0].buyer_id !== buyerId) return { error: "forbidden" };
        return { error: "not_completed" };
      }
      const payment = await client.query(
        `UPDATE marketplace_payments SET status = 'not_settled', note = $2
         WHERE job_id = $1 RETURNING *`,
        [jobId, note]
      );
      await client.query("COMMIT");
      return { payment: payment.rows[0] };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async function expireSources() {
    await database.query(
      `UPDATE marketplace_jobs SET status = 'failed'
       WHERE status IN ('open', 'processing') AND id IN (
         SELECT job_id FROM marketplace_sources WHERE expires_at <= NOW()
       )`
    );
    await database.query(
      `UPDATE marketplace_job_queue SET status = 'failed', locked_until = NULL,
         last_error = 'Source retention period expired'
       WHERE job_id IN (
         SELECT job_id FROM marketplace_sources WHERE expires_at <= NOW()
       )`
    );
    await database.query("DELETE FROM marketplace_sources WHERE expires_at <= NOW()");
  }

  return {
    initialize,
    checkHealth,
    recordApiPayment,
    readState,
    createJob,
    acceptJob,
    claimNextJob,
    completeJob,
    failOrRetryJob,
    approveJob,
    expireSources,
    close: () => database.end()
  };
}

module.exports = { createPostgresStore, decryptSource, encryptSource, encryptionKey };
