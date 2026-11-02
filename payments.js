const { getRuntimeConfig } = require("./config");

const runtime = getRuntimeConfig();
const PAYMENT_CONFIGURATION = Object.freeze({
  enabled: false,
  protocol: "x402",
  asset: runtime.settlement.asset,
  network: runtime.settlement.network,
  reason: "No payment route is implemented. No funds can be transferred or settled."
});

function createPaymentRecord(job) {
  return {
    id: `pay_${job.id}`,
    jobId: job.id,
    buyerId: job.buyerId,
    providerId: job.providerId || null,
    amountUsd: job.priceUsd,
    asset: PAYMENT_CONFIGURATION.asset,
    network: PAYMENT_CONFIGURATION.network,
    protocol: PAYMENT_CONFIGURATION.protocol,
    status: "not_settled",
    transactionId: null,
    note: PAYMENT_CONFIGURATION.reason
  };
}

module.exports = { PAYMENT_CONFIGURATION, createPaymentRecord };
