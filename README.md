# GPU Foundry

GPU Foundry is a Node.js marketplace prototype for prompt-generation jobs. Accepted prompts can be sent server-side to Hugging Face Inference Providers. It includes a blue-and-white landing page, dedicated How it works and Provider pages, floating capsule navigation, and a responsive marketplace dashboard.

The default is a local preview, not a live marketplace or production privacy system. Production mode fails closed without Auth0 and scopes dashboard records to the signed-in user. Prompt jobs stay disabled until Hugging Face credentials/model are configured and the operator acknowledges review of provider data-handling terms. An official x402 agent endpoint is implemented; the Render Blueprint explicitly enables it and requires its USDG, recipient, facilitator, and durable receipt settings.

## Run

Requires Node.js 20 or newer.

```powershell
npm ci
npm test
npm run test:escrow
npm run dev
```

Open <http://127.0.0.1:4173>. The site has separate routes for:

- `/` — blue-and-white marketplace landing page
- `/how-it-works` — job lifecycle and approval flow
- `/providers` — provider terms and responsibilities
- `/login` — public branded sign-in page; credentials are entered on Auth0
- `/auth/signup` — starts Auth0-hosted account registration; Auth0 must have sign-ups enabled
- `/dashboard` — authenticated marketplace dashboard
- `/docs` — in-site operator and developer documentation

To enable actual prompt generation locally, add `GPU_PROVIDER=huggingface-inference`, `HF_TOKEN`, and `HF_MODEL` to the ignored `.env` file. Create a fine-grained Hugging Face token with Inference Providers permission and select a currently supported chat-completion model. Never paste the token into chat or commit it. Provider usage may incur charges; a working token does not guarantee free GPU capacity.

In local preview the dashboard has buyer and provider simulation views. The role selector is not authentication. Production disables it and uses the Auth0 custom role claim `https://gpufiles.app/role` (`provider`); authenticated users without that claim have the buyer role.

## Production security controls

The server-side Auth0 settings are `AUTH0_DOMAIN`, `AUTH0_CLIENT_ID`, `AUTH0_CLIENT_SECRET`, `AUTH0_SECRET`, `AUTH0_ALLOWED_EMAILS`, and `BASE_URL`. The client ID is public; the client secret and session secret must stay in the hosting provider's secret manager. Production requires these values, a session secret of at least 32 bytes, and an HTTPS origin for `BASE_URL`; startup exits with an error if these requirements are not met. Set `AUTH0_ALLOWED_EMAILS` to the comma-separated, verified email addresses permitted to access the dashboard and API. Configure the Auth0 callback, logout, and web origins for that exact HTTPS origin.

- All API routes require an Auth0 session and an exact verified-email allowlist match in production, including `/api/state`; the dashboard route is also denied to authenticated accounts outside the allowlist. Buyer state is limited to the buyer's jobs and payments. Providers see open marketplace listings and jobs assigned to them; internal buyer/provider IDs and non-public fields are omitted from API responses.
- User passwords are handled by Auth0's hosted login and are not submitted to or stored by this application. The app keeps an Auth0 session cookie and uses the Auth0 subject to associate records; the operator remains responsible for securing Auth0 and the hosting account.
- Demo identities and `/api/demo/role` are disabled in production. Mutating API requests must have the configured site's same-origin `Origin`.
- Hugging Face tokens and Auth0/facilitator secrets are server-only. Public runtime responses are explicitly projected and omit these values.
- Production prompt jobs require `GPU_PROVIDER=huggingface-inference`, `HF_TOKEN`, `HF_MODEL`, and `GPU_PROVIDER_PRIVACY_ACKNOWLEDGED=true`. That last setting is an operator acknowledgment that provider terms have been reviewed; it is **not** a privacy guarantee. Buyers affirm authorization to send prompts.
- Production prompts are encrypted with AES-256-GCM before being stored in PostgreSQL and are deleted after processing, terminal failure, or one-hour expiry. The `DATA_ENCRYPTION_KEY` must be a stable, separately backed-up 32-byte key; losing it makes queued prompts unrecoverable. Encryption at rest does not guarantee secure deletion, and Hugging Face or its selected inference provider may have its own processing and retention.
- PostgreSQL stores job/payment metadata and encrypted pending prompts. A PostgreSQL queue table durably tracks accepted work with row-lock-based multi-instance claims, recovery of expired worker leases, and up to three processing attempts. Inference-provider requests may be repeated after ambiguous network failures; Hugging Face inference is not assumed to be idempotent, and retries can cause duplicate provider usage or charges.
- The x402 endpoint is separate from the marketplace's provider/job approval flow. It does not activate marketplace escrow or contributor payouts.
- `X402_ENABLED` defaults to `false` in the application, but the Render Blueprint sets it to `true`. Enabling it requires a verified Arbitrum One recipient, USDG contract metadata and supported transfer method, CDP facilitator credentials, and PostgreSQL for idempotent settlement receipts. Startup fails closed when any required setting is missing.

Deployment templates are included for Render (`render.yaml`) and a container host (`Dockerfile`). The Render Blueprint uses free web and PostgreSQL plans and wires the database connection string; it sets `GPU_PROVIDER_PRIVACY_ACKNOWLEDGED=true` because the operator has reviewed the selected provider's data terms. Render's internal Postgres endpoint uses a self-signed TLS certificate, so this Blueprint enables encrypted TLS without certificate verification; other production deployments verify certificates by default. Set `AUTH0_ALLOWED_EMAILS`, `DATA_ENCRYPTION_KEY`, Auth0 settings, the public `BASE_URL`, `HF_TOKEN`, `HF_MODEL`, and x402 payment settings in the hosting provider's secret settings. Do not commit real credentials. Render Free web services can spin down when idle, and Free PostgreSQL expires after 30 days, so this configuration is for testing only, not reliable production payment records. Inference-provider and facilitator usage may still incur charges.

### Deployment and operations checks

- `/healthz` is a liveness endpoint and reports only whether the Node process can answer requests. `/readyz` is a readiness endpoint; in production it also checks PostgreSQL. Render and the Docker health check use `/readyz`.
- The server listens on `HOST` and `PORT`; the container defaults to `0.0.0.0:10000`. Production should terminate HTTPS at the hosting platform and set `BASE_URL` to that public HTTPS origin.
- On `SIGTERM` or `SIGINT`, the app stops queue polling, aborts an active inference request, records the job for retry, waits for in-flight HTTP requests, and closes the PostgreSQL pool. Inference calls have a four-minute deadline, shorter than the five-minute queue lease. The remote service may still finish a request after a local timeout; retries can therefore duplicate inference usage.
- PostgreSQL connection attempts and queries have bounded timeouts. If database initialization fails transiently, the service retries with capped exponential backoff and remains unready until PostgreSQL responds; logs include sanitized underlying connection errors. The app does not configure database backups, point-in-time recovery, restore testing, alert delivery, or a distributed rate limiter; configure and exercise those through the chosen hosting/monitoring services before opening access.
- Confirm production startup fails when required secrets/configuration are missing. Then check `/readyz`, Auth0 callback/logout, allowed-user denial, database backup and restore, and shutdown/restart recovery in a staging deployment. Do not expose production job uploads until the selected provider contract has been tested end-to-end.

### Hugging Face and payment integration status

The Hugging Face adapter uses the documented OpenAI-compatible chat-completions route at `https://router.huggingface.co/v1/chat/completions`, sends the selected `HF_MODEL`, and validates a bounded text response. Configure a fine-grained Hugging Face token with Inference Providers permission. Choose a model that currently has a compatible provider; availability, price, hardware type, and data handling depend on Hugging Face and the selected inference provider. This integration does not guarantee a GPU-backed deployment. See the [Hugging Face chat-completion docs](https://huggingface.co/docs/inference-providers/tasks/chat-completion) for model and provider availability.

`POST /api/gpu-generate-text` is a dedicated agent/API endpoint protected only by the official `@x402/express` middleware and CDP facilitator; unrelated pages and marketplace API routes continue through their existing handlers. The dashboard also includes a browser checkout form that uses the official x402 fetch client and an injected EVM wallet; buyers confirm the payment in their wallet. It charges 0.01 USDG per successful response on Arbitrum One (`eip155:42161`). The middleware validates the payment before generation and settles only after the handler returns a successful response; invalid prompts, unavailable inference, and inference failures are not successful paid responses. This route does not use Auth0 sessions because x402 is its payment gate; the marketplace dashboard and other APIs keep their existing Auth0 and same-origin protections.

The endpoint uses the existing Hugging Face adapter and bounds prompts to 64 KiB. Production API requests must include `"dataConsent": true`; the dashboard requires an explicit authorization/data-handling acknowledgment before prompting the wallet. The browser build is generated with `npm run build:payment-client` (also run automatically by `npm run dev` and `npm start`; the Docker image builds it). The checkout requires a browser wallet that supports EIP-712 typed-data signing and an Arbitrum account. After settlement, the server stores a deduplicated settlement receipt (network and transaction ID) in PostgreSQL and the dashboard links the receipt to Arbiscan. Since blockchain settlement and database writes cannot be one atomic transaction, a receipt-write failure is logged and the successful paid response still returns; monitor these errors and reconcile against facilitator/on-chain records.

Configure these values only in the hosting secret manager after independently verifying the USDG contract on Arbitrum and testing CDP facilitator support:

- `X402_ENABLED=true`
- `X402_NETWORK=eip155:42161`
- `X402_ASSET_ADDRESS` — USDG contract address
- `X402_ASSET_DECIMALS` — verified token decimals; the 0.01 price is converted to atomic units using this value
- `X402_ASSET_NAME` and `X402_ASSET_VERSION` — verified EIP-712 domain metadata
- `X402_ASSET_TRANSFER_METHOD` — facilitator-confirmed `eip3009` or `permit2`
- `X402_RECIPIENT` — your public receiving wallet address (not a private key)
- `CDP_API_KEY_ID` and `CDP_API_KEY_SECRET` — facilitator credentials
- `DATABASE_URL` — required for durable settlement receipts

Set the USDG contract address, token decimals, EIP-712 domain metadata, and transfer method to match the token and facilitator used by the integration. Render Free web services can sleep, and the PostgreSQL database expires after 30 days without backups. Do not rely on it for durable payment receipts or production settlement. Inference and facilitator usage can still incur charges. Existing marketplace job payment records remain `not_settled`; this x402 route is not escrow and does not create contributor payouts.

## How security and payments work

- **Account access:** Auth0 handles production sign-in. APIs require an authenticated session and a verified email on the configured allowlist, and marketplace records are scoped to the signed-in buyer or provider. Passwords are handled by Auth0; server credentials belong in the hosting provider's secret store.
- **Prompt handling:** Accepted marketplace prompts are encrypted with AES-256-GCM while queued in PostgreSQL, then sent server-side to Hugging Face Inference Providers for generation. The selected inference provider controls its own processing and retention. Queue encryption is not a secure-deletion guarantee; do not submit confidential prompts unless the provider's terms are suitable.
- **Direct-generation payment:** The separate x402 endpoint charges 0.01 USDG on Arbitrum One for a successful response. A supported browser wallet signs the payment authorization, the CDP facilitator verifies and settles it, and the service records a deduplicated receipt in PostgreSQL. The end-to-end payment flow depends on valid token/facilitator settings, available inference, and working receipt storage.
- **Marketplace payments:** A proposed job payout is an indicative record only; posting or approving a marketplace job does not transfer funds. The x402 direct-generation flow is not marketplace escrow and does not pay providers. The separate escrow contract is a local test project, not part of the deployed payment flow.
- **Hosting and costs:** Render Free web services can sleep, and Free PostgreSQL expires after 30 days without backups. Inference and facilitator usage may incur charges. The Render Blueprint enables x402 and lists the required payment settings above.

## What works

- The site runs locally without inference credentials, but job submission and paid generation are unavailable until Hugging Face and payment settings are configured. No mock generation result is presented as real inference.
- Public visitors can browse `/`, `/how-it-works`, `/providers`, and `/docs`; `/dashboard` requires sign-in when Auth0 is configured. `/login` is a branded gateway to Auth0 and never asks for a password itself.
- Production prompt jobs call Hugging Face's chat-completions endpoint server-side; prompts are not sent from the browser directly to Hugging Face, and the token is never exposed in public runtime data.
- Buyers can approve a marketplace result, but its payment record remains unpaid. Render enables the separate x402 agent endpoint and browser checkout; its payment settings must be supplied and validated, and inference must be available, before paid generation can succeed.
- Local preview stores job metadata in `data/state.json` and pending prompts in process memory. Production uses PostgreSQL for durable job/payment metadata and the persistent queue; prompts are encrypted using `DATA_ENCRYPTION_KEY` and retained only while awaiting or undergoing processing.

## Test-only escrow contract

`evm/contracts/GPU FoundryEscrow.sol` is a local-EVM experiment, not a deployed or audited payment system. It models escrow with an ERC-20 token, buyer-funded jobs, provider acceptance, result-hash submission, buyer-approved payout, buyer cancellation before acceptance, and an immutable arbitrator that can resolve disputes to either side. It uses an exact-transfer check and OpenZeppelin `SafeERC20`/`ReentrancyGuard`.

- Run the local contract tests with `npm run test:escrow`. Tests use a mock six-decimal token, not real USDG.
- There is no automatic timeout. With buyer-approval-only settlement, jobs can stay locked indefinitely if the buyer does not approve and no dispute is resolved.
- The arbitrator is a centralized trust role in this prototype. A production design should use a reviewed dispute process and likely a multisig or other carefully governed mechanism.
- The contract takes direct ERC-20 `transferFrom`; it is not integrated with x402 and has not been deployed to Arbitrum or a public testnet.
- Never deploy this contract or send real tokens based only on these tests. Independent smart-contract security review, deployment controls, verified token compatibility, and end-to-end testnet validation are required first.

## Public integration references

- [Auth0 Express integration guide](https://auth0.com/docs/quickstart/webapp/express): use an Auth0 tenant and configured callback/logout URLs; no Auth0 credentials are included here.
- [Coinbase x402 overview](https://docs.cdp.coinbase.com/x402/welcome) and [CDP Facilitator](https://docs.cdp.coinbase.com/x402/seller/facilitator): reference the facilitator documentation when updating the verified USDG transfer configuration. The direct-generation x402 flow does not provide marketplace escrow or provider payouts.
- [CDP supported schemes and networks endpoint](https://docs.cdp.coinbase.com/api-reference/v2/rest-api/x402-facilitator/get-supported-payment-schemes-and-networks): recheck supported schemes and networks when changing payment configuration; chain support alone does not establish support for a particular asset or escrow/payout behavior.
