/**
 * `payCheckoutSessionTestHelper` rules (lld/payments.md §16.1, test mode only). Pure.
 *
 * The helper pays a session the way a payer would on the sandbox rail: a `route_quote` attempt from an
 * origin asset, a refund address the payer "owns", a simulated deposit and a sandbox advance to the
 * requested outcome.
 */
import type { ChainFamily } from "@nearpay-internal/chains";

export type TestOutcome = "succeeded" | "payment_failed" | "refunded" | "none";
export type SandboxStep = "deposit" | "processing" | "success" | "refund" | "fail";

/**
 * Refund addresses of the simulated payer per chain family (test mode only; nothing is ever sent there
 * outside the sandbox). Well-formed for `@nearpay-internal/chains` validation and free of the sandbox's
 * magic words (`sanctioned`).
 */
export const SANDBOX_REFUND_ADDRESSES: Readonly<Record<ChainFamily, string>> = {
  evm: "0x000000000000000000000000000000000000dEaD",
  near: "sandbox-payer.near",
  solana: "11111111111111111111111111111111",
  bitcoin: "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq",
};

/** The sandbox step that drives an attempt to the outcome (`none`: only the attempt is created). */
export function sandboxStepOf(outcome: TestOutcome): SandboxStep | null {
  switch (outcome) {
    case "succeeded":
      return "success";
    case "payment_failed":
      return "fail";
    case "refunded":
      return "refund";
    case "none":
      return null;
  }
}

export interface OptionLike {
  readonly method: string;
  readonly origin_asset_id: string;
  readonly chain: string;
  readonly available: boolean;
}

/**
 * The default origin when none is requested: the first available `route_quote` option of the session (rails'
 * ranking). `null` = nothing payable. A requested asset is not looked up here: it is quoted like a payer's
 * choice and rails accepts or refuses it.
 */
export function defaultOrigin(options: readonly OptionLike[]): { asset: string; chain: string } | null {
  const first = options.find((o) => o.method === "route_quote" && o.available);
  return first ? { asset: first.origin_asset_id, chain: first.chain } : null;
}
