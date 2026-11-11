/**
 * Client secrets and attestation tickets (lld/payments.md §4, §8.2).
 *
 * - Client secret `cs_<id>_secret_<32 base62>`: returned once (in the session URL fragment), stored as
 *   SHA-256, compared in constant time. It authenticates the payer API for one session only.
 * - Attestation ticket `base64url(JCS(payload)).base64url(Ed25519(JCS bytes))` with payload
 *   `{attempt_id, livemode, deposit_key, exp}` (spec `AttestationTicketPayload`, exp = now + 15 min):
 *   it only rate-gates sentinel; sentinel's verdict never depends on it.
 */
import { createHash, type KeyObject, randomInt, sign, timingSafeEqual } from "node:crypto";
import { routeQuoteDepositKey } from "@nearpay-money/spec";
import canonicalize from "canonicalize";

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const SECRET = /^(cs_[0-9a-z]{26})_secret_[0-9A-Za-z]{32}$/;
export const TICKET_TTL_S = 15 * 60;

export function newClientSecret(sessionId: string): { secret: string; hash: Buffer } {
  let tail = "";
  for (let i = 0; i < 32; i++) tail += BASE62[randomInt(62)];
  const secret = `${sessionId}_secret_${tail}`;
  return { secret, hash: hashSecret(secret) };
}

export function hashSecret(secret: string): Buffer {
  return createHash("sha256").update(secret, "utf8").digest();
}

/** True when `secret` is this session's client secret. */
export function secretMatches(secret: string | undefined, sessionId: string, storedHash: Buffer): boolean {
  if (!secret) return false;
  const m = SECRET.exec(secret);
  if (!m || m[1] !== sessionId) return false;
  const h = hashSecret(secret);
  return h.length === storedHash.length && timingSafeEqual(h, storedHash);
}

export interface TicketPayload {
  attempt_id: string;
  livemode: boolean;
  deposit_key: string;
  exp: number;
}

export function signTicket(payload: TicketPayload, key: KeyObject): string {
  const bytes = Buffer.from(canonicalize(payload) as string, "utf8");
  return `${bytes.toString("base64url")}.${sign(null, bytes, key).toString("base64url")}`;
}

/** The deposit key sentinel checks the ticket against (route_quote: provider|address|memo; intents: binding). */
export function depositKey(
  livemode: boolean,
  a: {
    method: "route_quote" | "intents_transfer";
    deposit: { address: string; memo: string | null } | null;
    binding: string | null;
  },
): string | null {
  if (a.method === "route_quote")
    return a.deposit
      ? routeQuoteDepositKey(livemode ? "oneclick" : "sandbox", a.deposit.address, a.deposit.memo)
      : null;
  return a.binding;
}
