/**
 * The exact payload the merchant signs for a refund leg (lld/payments.md §8.4, §17 item 3). Pure.
 *
 * - `sign_and_send` (source = a chain address): transfer exactly `deposit.amount_in` of the settlement
 *   asset from the destination to the leg's 1Click deposit address.
 * - `sign_intent` (source = an Intents account): ONE Verifier transfer `RefundTransfer` (receiver, token,
 *   amount, memo = binding) signed by the merchant's Intents account with a fresh nonce; payments returns
 *   the exact NEP-413 `signMessage` arguments, the exact ERC-191 / raw-ed25519 string and the parsed
 *   message. `submit_tx` accepts only that payload (same standard family, nonce and bytes).
 */

import { buildPayload, nep413Message } from "@nearpay-internal/intents";
import { formatUnits } from "@nearpay-internal/money";
import type { MultiPayload, RefundNextAction } from "@nearpay-money/spec";

export type SignIntentAction = Extract<RefundNextAction, { type: "sign_intent" }>;
export type SignAndSendAction = Extract<RefundNextAction, { type: "sign_and_send" }>;

const INTENTS = "intents.near" as const;
const unix = (iso: string) => Math.floor(Date.parse(iso) / 1000);

/** `0xab12…cd34` for long addresses. */
export function shortAddress(a: string): string {
  return a.length > 14 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}

/** Signing standards an Intents account can sign with: EVM implicit accounts sign ERC-191, NEAR accounts NEP-413. */
export function standardsFor(signerId: string): SignIntentAction["standards"] {
  return /^0x[0-9a-f]{40}$/.test(signerId) ? ["erc191"] : ["nep413", "raw_ed25519"];
}

export interface TransferInput {
  readonly signer_id: string;
  readonly receiver_id: string;
  readonly token: string;
  readonly amount: string;
  readonly memo: string;
  /** RFC 3339; the payload is signed with exactly this deadline. */
  readonly deadline: string;
}

export function signIntentAction(
  t: TransferInput,
  nonce: string,
  asset: { readonly symbol: string; readonly decimals: number },
): SignIntentAction {
  if (BigInt(t.amount) <= 0n) throw new RangeError("refund transfer amount must be positive");
  const message = buildPayload({
    signerId: t.signer_id,
    deadline: t.deadline,
    nonce,
    intents: [{ intent: "transfer", receiver_id: t.receiver_id, tokens: { [t.token]: t.amount }, memo: t.memo }],
  });
  return {
    type: "sign_intent",
    signer_id: t.signer_id,
    transfer: { receiver_id: t.receiver_id, token: t.token, amount: t.amount, memo: t.memo },
    standards: standardsFor(t.signer_id),
    nep413: { recipient: INTENTS, nonce, message: nep413Message(message) },
    payload: JSON.stringify(message),
    message,
    deadline: unix(t.deadline),
    display: `Transfer ${formatUnits(BigInt(t.amount), asset.decimals)} ${asset.symbol} to ${shortAddress(t.receiver_id)}`,
  } as SignIntentAction;
}

export interface SendInput {
  readonly chain: string;
  readonly chainName: string;
  readonly from: string;
  readonly to: string;
  readonly assetId: string;
  readonly token: { readonly standard: string; readonly address: string | null } | null;
  readonly symbol: string;
  readonly decimals: number;
  readonly amount: string;
  readonly memo: string | null;
  /** RFC 3339. */
  readonly deadline: string;
}

export function signAndSendAction(s: SendInput): SignAndSendAction {
  if (BigInt(s.amount) <= 0n) throw new RangeError("refund deposit amount must be positive");
  return {
    type: "sign_and_send",
    chain: s.chain,
    from: s.from,
    to: s.to,
    asset_id: s.assetId,
    token: (s.token ?? { standard: "other", address: null }) as SignAndSendAction["token"],
    symbol: s.symbol,
    decimals: s.decimals,
    amount: s.amount,
    memo: s.memo,
    deadline: unix(s.deadline),
    display: `Send ${formatUnits(BigInt(s.amount), s.decimals)} ${s.symbol} on ${s.chainName} to ${shortAddress(s.to)}${s.memo ? ` (memo ${s.memo})` : ""}`,
  } as SignAndSendAction;
}

/**
 * Is `signed` exactly the issued payload? The signature itself is checked separately (and by the
 * Verifier when agentpay simulates); this compares what was signed.
 */
export function matchesIssued(issued: SignIntentAction, signed: MultiPayload): boolean {
  if (!(issued.standards as readonly string[]).includes(signed.standard)) return false;
  if (signed.standard === "nep413")
    return (
      signed.payload.recipient === issued.nep413.recipient &&
      signed.payload.nonce === issued.nep413.nonce &&
      signed.payload.message === issued.nep413.message &&
      !signed.payload.callbackUrl
    );
  return signed.payload === issued.payload;
}
