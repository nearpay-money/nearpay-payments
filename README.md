# nearpay-payments

Payment lifecycle service: checkout sessions, payment intents, attempts, refunds, payment links, customers, statement ledger and reconciliation.

Part of [NearPay](https://github.com/nearpay-money/nearpay) — start there for the live demo, the architecture diagram and the full "do X, see Y" walkthrough.

- **Where it sits:** the gateway routes the public `/v1/checkout`, `/v1/payment_intents`, `/v1/refunds`, `/v1/payment_links`, `/v1/customers` and `/v1/balance_transactions` calls here; billing (invoice sessions) and agentpay (agent attempts) call its internal routes. It calls identity (settlement context), rails (quotes, executions, evidence), compliance, agentpay (relay of signed transfers), sentinel (kill-switch state) and, in test mode, sandbox.
- **Status:** NearPay runs on NEAR mainnet as a closed beta (https://nearpay.money, API at https://api.nearpay.money). This service is part of that deployment.

|                                       |                                                                                                                                                           |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Group                                 | Services                                                                                                                                                  |
| Kind                                  | service                                                                                                                                                   |
| Ships as                              | image: ghcr.io/nearpay-money/payments · routes /v1/checkout, /v1/payment_intents, /v1/refunds, /v1/payment_links, /v1/customers, /v1/balance_transactions |
| Owns                                  | CheckoutSession, PaymentIntent, PaymentAttempt, Refund, PaymentLink, Customer, BalanceTransaction                                                         |
| Depends on (published artifacts only) | spec, kit, identity, rails                                                                                                                                |
| First built in                        | Stage 1 (step 1.2)                                                                                                                                        |

## Documentation

Design docs live in [`nearpay-brain`](https://github.com/nearpay-money/nearpay-brain), not here.

- [`lld/payments.md`](https://github.com/nearpay-money/nearpay-brain/blob/main/lld/payments.md) — low-level design this service is implemented from
- [`lld/audits/payments.md`](https://github.com/nearpay-money/nearpay-brain/blob/main/lld/audits/payments.md) — audit findings already folded into the LLD
- [`roadmap/development-plan.md`](https://github.com/nearpay-money/nearpay-brain/blob/main/roadmap/development-plan.md) — stage and step this repo is built in
- [`architecture/hld.md`](https://github.com/nearpay-money/nearpay-brain/blob/main/architecture/hld.md) — system design
- [`architecture/repositories.md`](https://github.com/nearpay-money/nearpay-brain/blob/main/architecture/repositories.md) — repo topology and dependency rules
- [`architecture/domain-model.md`](https://github.com/nearpay-money/nearpay-brain/blob/main/architecture/domain-model.md) · [`architecture/flows.md`](https://github.com/nearpay-money/nearpay-brain/blob/main/architecture/flows.md)
- [ADR-0012](https://github.com/nearpay-money/nearpay-brain/blob/main/decisions/ADR-0012-independent-verification.md) (evidence before success) and [ADR-0022](https://github.com/nearpay-money/nearpay-brain/blob/main/decisions/ADR-0022-evm-l2-confirmations.md) (a payment confirms on one block of the chain the settlement evidence is read from)

## Layout

```
nearpay-payments/
├── migrations/
├── src/
│   ├── api/
│   ├── app/
│   ├── consumers/
│   ├── domain/
│   │   ├── checkout-session/
│   │   ├── customer/
│   │   ├── payment-attempt/
│   │   ├── payment-intent/
│   │   ├── payment-link/
│   │   ├── refund/
│   │   └── statement/
│   ├── infra/
│   │   ├── bus/
│   │   ├── clients/
│   │   └── db/
│   ├── sse/
│   └── workers/
├── test/
│   ├── contract/
│   ├── integration/
│   ├── property/
│   └── unit/
└── .github/
    └── workflows/
```

## Verify this repo

Needs Node 22 (`.nvmrc`) and pnpm 9. `.npmrc` points the `@nearpay-money` and `@nearpay-internal` scopes at a local package registry, so start that first.

1. Start the local registry (no Docker, Node 22 only):
   `git clone https://github.com/nearpay-money/nearpay-deploy ../nearpay-deploy && ../nearpay-deploy/scripts/registry.sh start`
   → `curl http://127.0.0.1:4873/-/ping` answers `{}`.
2. `pnpm install --frozen-lockfile` → ends with `Done in …`, no registry errors.
3. `pnpm test` (unit and property tests, no Docker) → `Test Files  20 passed (20)`, `Tests  151 passed (151)`.
4. `pnpm verify` (the full gate: typecheck, lint, unit tests with the coverage gate of ≥ 90 % branches on `src/domain`, integration tests, build) → exits 0. The integration step starts Postgres, NATS and Valkey with Testcontainers, so it needs a running Docker daemon; steps 1–3 do not.

To see this service take a real payment, follow the walkthrough in the [entry repo](https://github.com/nearpay-money/nearpay).

## Commands

```sh
pnpm install --frozen-lockfile   # NearPay packages from the local registry (see "Verify this repo")
pnpm verify                      # typecheck, lint, unit + property tests (coverage gate), integration, build
pnpm test                        # unit + property only (no Docker)
pnpm test:integration            # Testcontainers (Postgres, NATS, Valkey) + spec contract tests
pnpm build                       # tsc → dist/
node dist/main.js api|worker|migrate|healthcheck
```

## Configuration

| Variable                                                                                   | Default                         | Meaning                                                                                                                                                                               |
| ------------------------------------------------------------------------------------------ | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NP_DB_URL_FILE`                                                                           | —                               | app-role database URL (migrate: migrator role)                                                                                                                                        |
| `NP_IDENTITY_URL`, `NP_RAILS_URL`, `NP_AGENTPAY_URL`, `NP_COMPLIANCE_URL`                  | —                               | peers (§10 timeouts)                                                                                                                                                                  |
| `NP_SENTINEL_URL`                                                                          | unset                           | kill-switch read at boot / while unknown (spec 0.2.1); unset → unknown until the first `evt.sentinel.kill_switch.*` (live refunds fail closed)                                        |
| `NP_SANDBOX_BASE_URL`                                                                      | unset                           | test mode: simulated deposits and `advance`                                                                                                                                           |
| `NP_SERVICE_CLIENT_SECRET_FILE`                                                            | —                               | client credentials for service tokens                                                                                                                                                 |
| `NP_TICKET_SIGNING_KEY_FILE`                                                               | —                               | Ed25519 PEM for attestation tickets (public key configured in sentinel)                                                                                                               |
| `NP_PII_KEK_FILE`                                                                          | —                               | 32-byte KEK for customer email encryption                                                                                                                                             |
| `NP_TURNSTILE_SECRET_FILE`                                                                 | unset                           | Turnstile siteverify; unset (local/test only) disables the challenge                                                                                                                  |
| `NP_PAY_ORIGIN`                                                                            | `https://pay.nearpay.localhost` | checkout origin of session URLs                                                                                                                                                       |
| `NP_VALKEY_URL`                                                                            | unset                           | payer-stream fan-out across api replicas                                                                                                                                              |
| `NP_NATS_URL`                                                                              | —                               | worker: domain events                                                                                                                                                                 |
| `NP_MAX_LIVE_ATTEMPTS`                                                                     | 5                               | live attempts per session                                                                                                                                                             |
| `NP_UNDERPAY_TOLERANCE_MAX_BPS`                                                            | 100                             | ceiling on the account's underpay tolerance                                                                                                                                           |
| `NP_PRICING_CURRENCIES`                                                                    | `usd,eur,gbp,chf,jpy,cad,aud`   | fiat pricing currencies payments accepts; rails FX rates decide availability (Stage 2)                                                                                                |
| `NP_NEAR_RPC_URLS`                                                                         | `https://free.rpc.fastnear.com` | Verifier `current_salt` fallback when rails sends no `RefundTransfer.nonce` (rails < 0.2.1)                                                                                           |
| `NP_LINK_SESSIONS_PER_IP`, `NP_LINK_SESSIONS_PER_LINK_CLIENT`, `NP_LINK_SESSIONS_PER_LINK` | 10, 5, 600                      | anonymous payment-link sessions per minute: per client network (/24, /64), per link and client network, per link (ceiling); shared through Valkey (`NP_VALKEY_URL`), else per replica |

## Behaviour (Stage 1)

- **Sessions** (hosted + embedded) snapshot destination, fee schedule + bearer and settings onto the intent (INV-6); the client secret is returned once, in the URL fragment, and stored as SHA-256.
- **Attempts**: `route_quote` (deposit from any chain) and `intents_transfer` (signed NEAR Intents transfer, relayed by agentpay); agent attempts via `/internal/…/agent_attempts` are reused while valid. The attempt is inserted `quoting` before rails is called with key `attempt:<pa_id>`; a timeout leaves it to the recovery job.
- **Rails events** are applied only when newer than the attempt's execution version. The first verified settlement wins; later ones are overpayments. Short settlements and held verifications go to review. A session never expires while money might still arrive (INV-3); late settlements are honoured.
- **Statement**: one line per paying/overpaying attempt (`bt_once`), with evidence, at `GET /v1/balance_transactions`.
- **Payer stream**: SSE snapshots on every change (Valkey `cs:<uuid>` after commit) plus a 5 s re-check.

## Behaviour (Stage 2)

- **Refunds** (`re_`): legs are rails refund executions (`POST /internal/refund_executions`, key `refund:<re>:leg:<n>`);
  the merchant signs `next_action` (`sign_and_send`, or a `sign_intent` Verifier transfer payments builds with a fresh
  nonce); `submit_tx` forwards a tx hash to rails or relays the exact signed payload through agentpay (`kind: refund`).
  Success only on payer-side evidence; duplicate legs and late successes beyond the budget go to `extra_amount_sent`, so
  refunded + pending never exceeds settled (intent budget, or the attempt's for overpayments / rejected short
  settlements). Transient rail failures leave the leg `preparing` for `refund.prepare_recovery`. While sentinel's kill
  switch is engaged no new live leg is prepared and no live payload relayed.
- **Payment links** (`plink_`), **customers** (`cus_`, encrypted PII, DELETE erases), `POST /v1/payment_intents`
  (headless session, client secret once), ADR-0018 list filters, review accept/reject (reject drafts a refund).
- **Reconciliation**: `reconcile.daily` (02:00 UTC) → `reconcile.run` per account/mode/day against rails evidence
  summary + pages; append-only runs on `/ops/reconciliation_runs…`; `diff`/`error` opens a compliance
  `reconciliation_diff` case; console writes publish `evt.payments.ops_action.recorded`.

## Behaviour (Stage 3)

- **Invoice sessions for billing** (`/internal/checkout_sessions…`, lld §20): billing opens the hosted session that
  pays an invoice (`source: invoice`, `invoice`, customer, `expires_at` 5 min–30 d) with every session guard
  (live account, active destination, rails minimum, unverified cap, currency); one `open` session per invoice
  (unique index → `409`); `Idempotency-Key` honoured for billing's service token; secret and URL returned once.
  `getInternalCheckoutSession` never returns the secret; `expireInvoiceCheckoutSession` acts like the merchant
  expire. `invoice` is on every intent/session object and event; `listPaymentIntents?invoice=`;
  `getInternalCustomer` (decrypted email, `deleted`). The hosted invoice payer routes are billing's.
- **`nearpay trigger`**: `POST /v1/test_helpers/checkout_sessions/{id}/pay` (test mode) quotes a `route_quote`
  attempt from the first sandbox option with the simulated payer's refund address, deposits and advances the
  sandbox; outcomes arrive as normal rails events. The test helpers also accept the CLI's restricted test key.
- **Executions of other owners** (`Execution.owner ≠ payments`, agentpay's x402) are acknowledged without effect;
  reconciliation lists `listEvidence?owner=payments` and checks the count against rails' all-owner summary.

## Ops CLI

`docker compose -p nearpay exec payments-api /nodejs/bin/node dist/ops.js <command>`: `intent <pi_…>`, `session <cs_…>`, `attempt-recover <pa_…>`, `context-refresh <acct_…> [--live]`, `stuck`, and the kit 0.6.0 commands `dead-letters …` and `outbox …`.

## Status

Stage 1 implemented (step 1.2). Stage 2 implemented (step 2.2, spec 0.2.0, kit 0.2.0): every stage ≤ 2 route of the
spec including the `/ops` console routes, the 16 consumed subjects, the 17 produced ones. Stage 3 implemented (step
3.2, spec 0.3.0, kit 0.2.1): internal invoice sessions and customer read, the checkout-session pay test helper,
foreign-owner executions ignored, owner-filtered reconciliation (migration `0005_stage3_invoices.sql`).

Current pins (`package.json`): `@nearpay-money/spec` 0.5.0 and the `@nearpay-internal/*` kit packages at 0.6.0
(supervised consumers, liveness from loop heartbeats, outbox dead-letter).

## Built with

- Runtime: TypeScript on Node 22; Fastify, Kysely and pg, NATS (through the `@nearpay-internal/*` kit packages); ioredis (Valkey), zod, canonicalize; contracts from `@nearpay-money/spec`.
- Tests and tooling: Vitest, fast-check, Testcontainers, Biome.
- Licence: Apache-2.0 (`LICENSE`).

Code and documentation are written with AI assistance (Claude) under human direction and review. Built for the NEAR Hackathon (Nov 2026).
