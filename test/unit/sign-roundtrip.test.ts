/** The issued sign_intent payload, signed by real wallets' standards, verifies and matches (lld/payments.md §17 item 3). */
import { randomBytes } from "node:crypto";
import { signErc191, signNep413, signRawEd25519, verifySigned } from "@nearpay-internal/intents";
import { describe, expect, it } from "vitest";
import { matchesIssued, signIntentAction } from "../../src/domain/refund/next-action.js";

const t = {
  signer_id: "acme.near",
  receiver_id: "payer.near",
  token: "nep141:usdc.near",
  amount: "1000000",
  memo: `np1:${"1".repeat(44)}`,
  deadline: new Date(Date.now() + 600_000).toISOString(),
};
const NONCE = `WgK+EQ${"A".repeat(37)}=`;

describe("sign_intent round trip", () => {
  it("NEP-413 and raw ed25519 signatures of the issued payload verify and match", () => {
    const a = signIntentAction(t, NONCE, { symbol: "USDC", decimals: 6 });
    const back = JSON.parse(JSON.stringify(a)) as typeof a; // as the merchant receives it
    const sk = new Uint8Array(randomBytes(32));
    for (const signed of [signNep413(back.message, sk), signRawEd25519(back.message, sk)]) {
      const v = verifySigned(signed);
      expect(v.ok, JSON.stringify(v)).toBe(true);
      expect(matchesIssued(a, signed)).toBe(true);
    }
  });
  it("ERC-191 for an EVM implicit account", () => {
    const a = signIntentAction({ ...t, signer_id: `0x${"a".repeat(40)}` }, NONCE, { symbol: "USDC", decimals: 6 });
    const signed = signErc191(a.message, new Uint8Array(randomBytes(32)));
    expect(verifySigned(signed).ok).toBe(true);
    expect(matchesIssued(a, signed)).toBe(true);
  });
});
