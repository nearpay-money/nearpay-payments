# nearpay-payments

> Payment lifecycle: checkout sessions, payment intents, attempts, refunds, payment links, customers, statement ledger, reconciliation.

|                                       |                                                                                                                                                           |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Group                                 | Services                                                                                                                                                  |
| Kind                                  | service                                                                                                                                                   |
| Ships as                              | image: ghcr.io/nearpay-money/payments · routes /v1/checkout, /v1/payment_intents, /v1/refunds, /v1/payment_links, /v1/customers, /v1/balance_transactions |
| Owns                                  | CheckoutSession, PaymentIntent, PaymentAttempt, Refund, PaymentLink, Customer, BalanceTransaction                                                         |
| Depends on (published artifacts only) | spec, kit, identity, rails                                                                                                                                |
| First built in                        | Stage 1 (step 1.2)                                                                                                                                        |

## Documentation

This repo stays surgical: design docs live in [`nearpay-brain`](../nearpay-brain/README.md), not here.

- `nearpay-brain/lld/payments.md` — **low-level design (dev-ready; implement from this)**
- `nearpay-brain/lld/audits/payments.md` — audit findings already folded into the LLD
- `nearpay-brain/roadmap/development-plan.md` — stage and step this repo is built in
- `nearpay-brain/architecture/hld.md` — system design
- `nearpay-brain/architecture/repositories.md` — repo topology and dependency rules
- `nearpay-brain/architecture/domain-model.md`
- `nearpay-brain/architecture/flows.md`
- `nearpay-brain/decisions/ADR-0012-independent-verification.md`

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

## Commands

```sh
pnpm install                 # @nearpay/* from the local registry (nearpay-deploy/scripts/up.sh starts it)
pnpm verify                  # typecheck, lint, unit + property tests (coverage gate), integration, build
pnpm test                    # unit + property only (no Docker)
pnpm test:integration        # Testcontainers (Postgres, NATS, Valkey) + spec contract tests
node dist/main.js api|worker|migrate|healthcheck
```

## Configuration

| Variable                                                                  | Default                         | Meaning                                                                 |
| ------------------------------------------------------------------------- | ------------------------------- | ----------------------------------------------------------------------- |
| `NP_DB_URL_FILE`                                                          | —                               | app-role database URL (migrate: migrator role)                          |
| `NP_IDENTITY_URL`, `NP_RAILS_URL`, `NP_AGENTPAY_URL`, `NP_COMPLIANCE_URL` | —                               | peers (§10 timeouts)                                                    |
| `NP_SANDBOX_BASE_URL`                                                     | unset                           | test mode: simulated deposits and `advance`                             |
| `NP_SERVICE_CLIENT_SECRET_FILE`                                           | —                               | client credentials for service tokens                                   |
| `NP_TICKET_SIGNING_KEY_FILE`                                              | —                               | Ed25519 PEM for attestation tickets (public key configured in sentinel) |
| `NP_PII_KEK_FILE`                                                         | —                               | 32-byte KEK for customer email encryption                               |
| `NP_TURNSTILE_SECRET_FILE`                                                | unset                           | Turnstile siteverify; unset (local/test only) disables the challenge    |
| `NP_PAY_ORIGIN`                                                           | `https://pay.nearpay.localhost` | checkout origin of session URLs                                         |
| `NP_VALKEY_URL`                                                           | unset                           | payer-stream fan-out across api replicas                                |
| `NP_NATS_URL`                                                             | —                               | worker: domain events                                                   |
| `NP_MAX_LIVE_ATTEMPTS`                                                    | 5                               | live attempts per session                                               |
| `NP_UNDERPAY_TOLERANCE_MAX_BPS`                                           | 100                             | ceiling on the account's underpay tolerance                             |
| `NP_PRICING_CURRENCIES`                                                   | `usd`                           | fiat pricing currencies (Stage 1)                                       |

## Behaviour (Stage 1)

- **Sessions** (hosted + embedded) snapshot destination, fee schedule + bearer and settings onto the intent (INV-6); the client secret is returned once, in the URL fragment, and stored as SHA-256.
- **Attempts**: `route_quote` (deposit from any chain) and `intents_transfer` (signed NEAR Intents transfer, relayed by agentpay); agent attempts via `/internal/…/agent_attempts` are reused while valid. The attempt is inserted `quoting` before rails is called with key `attempt:<pa_id>`; a timeout leaves it to the recovery job.
- **Rails events** are applied only when newer than the attempt's execution version. The first verified settlement wins; later ones are overpayments. Short settlements and held verifications go to review. A session never expires while money might still arrive (INV-3); late settlements are honoured.
- **Statement**: one line per paying/overpaying attempt (`bt_once`), with evidence, at `GET /v1/balance_transactions`.
- **Payer stream**: SSE snapshots on every change (Valkey `cs:<uuid>` after commit) plus a 5 s re-check.

## Ops CLI (Stage 1)

`docker compose -p nearpay exec payments-api /nodejs/bin/node dist/ops.js <command>`: `intent <pi_…>`, `session <cs_…>`, `attempt-recover <pa_…>`, `context-refresh <acct_…> [--live]`, `stuck`.

## Status

Stage 1 implemented (step 1.2): every Stage-1 route of the spec, the 14 consumed subjects, the 10 produced ones. Stage 2 (refunds, payment links, customers, review decisions, reconciliation) is not started.

## Built with

Fastify, Kysely, pg, NATS, ioredis (via `@nearpay-internal/*`), zod, canonicalize; Vitest, fast-check, Testcontainers, Biome. Code and documentation are written with AI assistance (Claude) under human direction and review.
