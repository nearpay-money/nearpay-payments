/** Stage 2 integration helpers. */
import { USDC_NEAR } from "@nearpay-internal/testing";
import type { Merchant } from "./stack.js";

export interface PaidIntent {
  m: Merchant;
  token: string;
  pi: string;
  cs: string;
  secret: string;
  attempt: string;
  exId: string;
}

export type Evidence = ReturnType<typeof freshEvidence>;

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** Verified evidence (tier A) of `amount` reaching `recipient`, with a fresh tx hash. */
export function freshEvidence(recipient: string, amount: string) {
  const tx = Array.from({ length: 44 }, () => B58[Math.floor(Math.random() * 58)]).join("");
  return {
    chain: "near:mainnet",
    tx_hash: tx,
    block_ref: "1",
    recipient,
    asset_id: USDC_NEAR,
    amount,
    finality: "final",
    tier: "A",
    source: "indexer",
    observed_at: new Date().toISOString(),
    explorer_url: `https://nearblocks.io/txns/${tx}`,
  };
}

/** What payments sends agentpay for a refund leg relay. */
export const agentpayRelayBody = (refund: string, binding: string) => ({ kind: "refund", refund, binding });
