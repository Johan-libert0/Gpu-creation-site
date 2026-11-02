const PAID_GENERATION_PATH = "/api/gpu-generate-text";
const ARBITRUM_ONE = "eip155:42161";
const DEFAULT_USDG_ADDRESS = "0x004B506865409877C9fA29bfb1ebA929984B9bbC";

function amountInAtomicUnits(decimals) {
  if (!Number.isInteger(decimals) || decimals < 2 || decimals > 18) {
    throw new Error("USDG must use a verified token decimal count between 2 and 18.");
  }
  return (10n ** BigInt(decimals - 2)).toString();
}

function getX402Configuration(env = process.env) {
  const enabled = env.X402_ENABLED === "true";
  const network = env.X402_NETWORK || ARBITRUM_ONE;
  const assetAddress = env.X402_ASSET_ADDRESS || DEFAULT_USDG_ADDRESS;
  const decimals = env.X402_ASSET_DECIMALS === undefined || env.X402_ASSET_DECIMALS === ""
    ? Number.NaN
    : Number(env.X402_ASSET_DECIMALS);
  const transferMethod = env.X402_ASSET_TRANSFER_METHOD;
  const recipient = env.X402_RECIPIENT || "";
  const assetName = env.X402_ASSET_NAME || "";
  const assetVersion = env.X402_ASSET_VERSION || "";
  const facilitatorConfigured = Boolean(env.CDP_API_KEY_ID && env.CDP_API_KEY_SECRET);
  const configured = Boolean(
    network === ARBITRUM_ONE &&
    /^0x[0-9a-f]{40}$/i.test(assetAddress) &&
    /^(0|[1-9]\d*)$/.test(env.X402_ASSET_DECIMALS || "") &&
    Number.isInteger(decimals) && decimals >= 2 && decimals <= 18 &&
    ["eip3009", "permit2"].includes(transferMethod) &&
    assetName.length > 0 && assetName.length <= 128 &&
    assetVersion.length > 0 && assetVersion.length <= 32 &&
    /^0x[0-9a-f]{40}$/i.test(recipient) &&
    facilitatorConfigured &&
    env.DATABASE_URL
  );
  return {
    enabled,
    configured,
    network,
    assetAddress,
    decimals,
    transferMethod,
    recipient,
    assetName,
    assetVersion,
    facilitatorConfigured
  };
}

function validateX402Configuration(config = getX402Configuration()) {
  if (!config.enabled) return;
  if (config.network !== ARBITRUM_ONE) {
    throw new Error("X402_NETWORK must be eip155:42161 (Arbitrum One).");
  }
  if (!/^0x[0-9a-f]{40}$/i.test(config.assetAddress)) {
    throw new Error("X402_ASSET_ADDRESS must be a valid ERC-20 contract address.");
  }
  if (!Number.isInteger(config.decimals) || config.decimals < 2 || config.decimals > 18) {
    throw new Error("X402_ASSET_DECIMALS must be the verified token decimal count (2–18).");
  }
  if (!["eip3009", "permit2"].includes(config.transferMethod)) {
    throw new Error("X402_ASSET_TRANSFER_METHOD must be the facilitator-verified eip3009 or permit2 method.");
  }
  if (!config.assetName || config.assetName.length > 128 ||
    !config.assetVersion || config.assetVersion.length > 32) {
    throw new Error("X402_ASSET_NAME and X402_ASSET_VERSION must match the verified token payment domain.");
  }
  if (!/^0x[0-9a-f]{40}$/i.test(config.recipient)) {
    throw new Error("X402_RECIPIENT must be your verified Arbitrum receiving wallet address.");
  }
  if (!config.facilitatorConfigured) {
    throw new Error("X402_ENABLED requires CDP_API_KEY_ID and CDP_API_KEY_SECRET in the secret manager.");
  }
  if (!process.env.DATABASE_URL) {
    throw new Error("X402_ENABLED requires DATABASE_URL for durable settlement receipts.");
  }
}

function createX402Middleware() {
  const config = getX402Configuration();
  validateX402Configuration(config);
  if (!config.enabled) {
    throw new Error("Cannot create x402 middleware while X402_ENABLED is false.");
  }

  const { paymentMiddleware } = require("@x402/express");
  const { x402ResourceServer } = require("@x402/core/server");
  const { convertToTokenAmount } = require("@x402/core/utils");
  const { ExactEvmScheme } = require("@x402/evm/exact/server");
  const { createCdpFacilitatorClient } = require("@coinbase/cdp-sdk/x402");

  const server = new x402ResourceServer(createCdpFacilitatorClient())
    .register(config.network, new ExactEvmScheme());
  const price = {
    amount: convertToTokenAmount("0.01", config.decimals),
    asset: config.assetAddress,
    extra: {
      name: config.assetName,
      version: config.assetVersion,
      assetTransferMethod: config.transferMethod
    }
  };

  return paymentMiddleware({
    [`POST ${PAID_GENERATION_PATH}`]: {
      accepts: [{
        scheme: "exact",
        price,
        network: config.network,
        payTo: config.recipient,
        maxTimeoutSeconds: 300
      }],
      description: "One Hugging Face text generation response",
      mimeType: "application/json"
    }
  }, server);
}

function settlementReceiptMiddleware(recordSettlement) {
  return (request, response, next) => {
    const originalEnd = response.end;
    response.end = function (...args) {
      const encoded = response.getHeader("PAYMENT-RESPONSE");
      if (response.statusCode < 200 || response.statusCode >= 300 ||
        typeof encoded !== "string" || typeof recordSettlement !== "function") {
        return originalEnd.apply(response, args);
      }

      let settlement;
      try {
        const { decodePaymentResponseHeader } = require("@x402/core/http");
        settlement = decodePaymentResponseHeader(encoded);
      } catch (error) {
        console.error(`x402 settlement receipt decode failed for request ${response.getHeader("x-request-id")}.`);
        return originalEnd.apply(response, args);
      }
      if (!settlement.success || !settlement.transaction || !settlement.network) {
        console.error(`x402 returned an incomplete settlement receipt for request ${response.getHeader("x-request-id")}.`);
        return originalEnd.apply(response, args);
      }

      Promise.resolve().then(() => recordSettlement({
        requestId: response.getHeader("x-request-id"),
        payer: settlement.payer || null,
        amount: settlement.amount || amountInAtomicUnits(Number(process.env.X402_ASSET_DECIMALS)),
        network: settlement.network,
        transactionId: settlement.transaction
      })).catch((error) => {
        console.error(`x402 settlement receipt persistence failed for request ${response.getHeader("x-request-id")}.`, error.code || "database_error");
      }).finally(() => originalEnd.apply(response, args));
      return response;
    };
    next();
  };
}

module.exports = {
  ARBITRUM_ONE,
  DEFAULT_USDG_ADDRESS,
  PAID_GENERATION_PATH,
  amountInAtomicUnits,
  createX402Middleware,
  getX402Configuration,
  settlementReceiptMiddleware,
  validateX402Configuration
};
