/** Client secrets, attestation tickets, payer option mapping and configuration. */
import { generateKeyPairSync, verify } from "node:crypto";
import { fromUuid, uuidv7 } from "@nearpay-internal/ids";
import { routeQuoteDepositKey } from "@nearpay-money/spec";
import { describe, expect, it } from "vitest";
import { payerOption, payerReason } from "../../src/app/payer.js";
import { depositKey, hashSecret, newClientSecret, secretMatches, signTicket } from "../../src/app/secrets.js";
import { apiShape, workerShape } from "../../src/config.js";

describe("client secrets", () => {
  const cs = fromUuid("cs", uuidv7());
  it("are bound to their session and stored only as a hash", () => {
    const { secret, hash } = newClientSecret(cs);
    expect(secret).toMatch(new RegExp(`^${cs}_secret_[0-9A-Za-z]{32}$`));
    expect(hash.equals(hashSecret(secret))).toBe(true);
    expect(secretMatches(secret, cs, hash)).toBe(true);
  });
  it("reject other sessions, malformed and missing secrets", () => {
    const { secret, hash } = newClientSecret(cs);
    const other = fromUuid("cs", uuidv7());
    expect(secretMatches(secret, other, hash)).toBe(false);
    expect(secretMatches(`${secret}x`, cs, hash)).toBe(false);
    expect(secretMatches(undefined, cs, hash)).toBe(false);
    expect(secretMatches(newClientSecret(cs).secret, cs, hash)).toBe(false);
  });
});

describe("attestation tickets", () => {
  it("are JCS payloads signed with Ed25519 (sentinel verifies with the public key)", () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const payload = { attempt_id: fromUuid("pa", uuidv7()), livemode: false, deposit_key: "k", exp: 1_800_000_000 };
    const [b, s] = signTicket(payload, privateKey).split(".") as [string, string];
    const bytes = Buffer.from(b, "base64url");
    expect(JSON.parse(bytes.toString("utf8"))).toEqual(payload);
    expect(bytes.toString("utf8")).toBe(
      `{"attempt_id":"${payload.attempt_id}","deposit_key":"k","exp":1800000000,"livemode":false}`,
    );
    expect(verify(null, bytes, publicKey, Buffer.from(s, "base64url"))).toBe(true);
  });
  it("deposit keys: provider|address|memo for route quotes (sandbox in test mode), the binding for intents", () => {
    const deposit = { address: "0xabc", memo: null };
    expect(depositKey(true, { method: "route_quote", deposit, binding: null })).toBe(
      routeQuoteDepositKey("oneclick", "0xabc", null),
    );
    expect(depositKey(false, { method: "route_quote", deposit, binding: null })).toBe(
      routeQuoteDepositKey("sandbox", "0xabc", null),
    );
    expect(depositKey(true, { method: "route_quote", deposit: null, binding: null })).toBeNull();
    expect(depositKey(true, { method: "intents_transfer", deposit: null, binding: "np1abc" })).toBe("np1abc");
  });
});

describe("payment options", () => {
  const o = {
    method: "route_quote" as const,
    origin_asset_id: "nep141:base-usdc",
    chain: "eip155:8453",
    symbol: "USDC",
    decimals: 6,
    estimated_amount_in: "2010000",
    route_class: "stable_pair" as const,
    applied_fee_bps: 50,
    min_deadline_s: 300,
    available: true,
    reason: null,
  };
  it("passes rails' option through without the fee", () => {
    const v = payerOption(o, 3600, false);
    expect(v).toMatchObject({ available: true, reason: null, estimated_amount_in: "2010000" });
    expect(v).not.toHaveProperty("applied_fee_bps");
  });
  it("marks routes slower than the remaining window", () => {
    expect(payerOption(o, 100, false)).toMatchObject({ available: false, reason: "route_too_slow" });
    expect(payerOption(o, 100, true)).toMatchObject({ available: true, reason: null });
  });
  it("maps rails' reasons to the payer enum", () => {
    expect(payerOption({ ...o, available: false, reason: "amount_too_low" }, 3600, false).reason).toBe(
      "amount_too_low",
    );
    expect(payerOption({ ...o, available: false, reason: "something" }, 3600, false).reason).toBe("route_unavailable");
    expect(payerOption({ ...o, available: false, reason: null }, 3600, false).reason).toBe("route_unavailable");
  });
  it("maps rails' routing-health codes: price codes → pricing_unavailable, everything else → route_unavailable", () => {
    const reason = (r: string | null) => payerOption({ ...o, available: false, reason: r }, 3600, false).reason;
    for (const r of [
      "settlement_price_stale",
      "settlement_price_missing",
      "settlement_price_depeg",
      "settlement_price_disagree",
      "fx_unavailable",
      "no reliable price for the settlement asset", // rails before the codes
    ])
      expect(reason(r)).toBe("pricing_unavailable");
    for (const r of [
      "kill_switch_engaged",
      "kill_switch_unknown",
      "treasury_unset",
      "cross_chain_paused",
      "payments are paused",
    ])
      expect(reason(r)).toBe("route_unavailable");
    expect(payerReason("pricing_unavailable")).toBe("pricing_unavailable");
    expect(payerReason(undefined)).toBe("route_unavailable");
  });
});

describe("configuration", () => {
  it("never shares a schema between a secret and a plain setting (kit secret() marks what it wraps)", () => {
    const secrets = ["dbUrl", "serviceClientSecret", "ticketSigningKey", "piiKek", "turnstileSecret"] as const;
    const plain = ["identityUrl", "railsUrl", "agentpayUrl", "complianceUrl", "payOrigin", "valkeyUrl"] as const;
    for (const s of secrets) for (const k of plain) expect(apiShape[s]).not.toBe(apiShape[k]);
    expect(workerShape.natsUrl).toBeDefined();
  });
});
