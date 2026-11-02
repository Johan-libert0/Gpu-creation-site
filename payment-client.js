import { x402Client } from "@x402/core/client";
import { decodePaymentResponseHeader } from "@x402/core/http";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { wrapFetchWithPayment } from "@x402/fetch";
import { createWalletClient, custom } from "viem";

const ARBITRUM_CHAIN_ID = 42161;

async function connectWallet() {
  const provider = window.ethereum;
  if (!provider?.request) {
    throw new Error("Install or unlock an EVM wallet such as MetaMask to pay with x402.");
  }
  const accounts = await provider.request({ method: "eth_requestAccounts" });
  const address = accounts?.[0];
  if (typeof address !== "string" || !/^0x[0-9a-f]{40}$/i.test(address)) {
    throw new Error("Your wallet did not return a valid account.");
  }

  let chainId = Number.parseInt(await provider.request({ method: "eth_chainId" }), 16);
  if (chainId !== ARBITRUM_CHAIN_ID) {
    await provider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: "0xa4b1" }]
    });
    chainId = Number.parseInt(await provider.request({ method: "eth_chainId" }), 16);
  }
  if (chainId !== ARBITRUM_CHAIN_ID) {
    throw new Error("Switch your wallet to Arbitrum One to continue.");
  }

  const walletClient = createWalletClient({
    account: address,
    transport: custom(provider)
  });
  const signer = {
    address,
    signTypedData: (message) => walletClient.signTypedData({ account: address, ...message })
  };
  const client = new x402Client();
  registerExactEvmScheme(client, { signer });
  return {
    address,
    fetchWithPayment: wrapFetchWithPayment(window.fetch.bind(window), client)
  };
}

async function generatePaidText(prompt, dataConsent) {
  const wallet = await connectWallet();
  const response = await wallet.fetchWithPayment("/api/gpu-generate-text", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt, dataConsent })
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || "Paid generation failed.");
  let payment = null;
  const paymentHeader = response.headers.get("PAYMENT-RESPONSE");
  if (paymentHeader) payment = decodePaymentResponseHeader(paymentHeader);
  return { ...body, payer: wallet.address, payment };
}

window.GpuFilesPaidGeneration = { connectWallet, generatePaidText };
