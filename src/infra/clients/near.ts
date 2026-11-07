/**
 * Verifier nonces for refund legs signed from an Intents account (lld/payments.md §8.4, foundations §14):
 * 32 bytes = the Verifier's 4-byte `current_salt` ‖ 28 random bytes. Live mode reads `current_salt` from
 * `intents.near` over NEAR RPC (cached 60 s); test mode uses the sandbox Verifier's fixed salt, so a
 * test payload can never execute on mainnet (INV-8).
 */
import { intentsRpc, makeNonce } from "@nearpay-internal/intents";

export const SANDBOX_SALT = "5a0dbe11";
const SALT_TTL_MS = 60_000;

export interface Nonces {
  /** A fresh nonce for `livemode`; throws when the live salt cannot be read. */
  fresh(livemode: boolean): Promise<string>;
}

export function verifierNonces(o: { rpcUrls: readonly string[]; fetch?: typeof fetch; now?: () => number }): Nonces {
  const rpc = intentsRpc({ rpcUrls: [...o.rpcUrls], timeoutMs: 2_000, ...(o.fetch ? { fetch: o.fetch } : {}) });
  const now = o.now ?? Date.now;
  let cached: { salt: string; at: number } | null = null;
  return {
    async fresh(livemode) {
      if (!livemode) return makeNonce(SANDBOX_SALT);
      if (!cached || now() - cached.at > SALT_TTL_MS) {
        const salt = await rpc.currentSalt();
        if (typeof salt !== "string" || !/^[0-9a-f]{8}$/.test(salt)) throw new Error("unexpected current_salt");
        cached = { salt, at: now() };
      }
      return makeNonce(cached.salt);
    },
  };
}
