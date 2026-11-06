/**
 * Payer geo policy (FR-CMP-03, L-PAY-01, lld/payments.md §8.2): the gateway forwards `CF-IPCountry`
 * (+ `cf-region-code`); compliance owns the policy, payments caches it (refreshed by
 * `evt.compliance.policy.updated`). Without a country header (local) the payer is allowed. When the
 * policy has never been loaded and compliance is unreachable, attempts are refused
 * (`503 screening_unavailable`) rather than skipping the check.
 */
import { ApiError } from "@nearpay-internal/service";
import type { Db, Payments } from "./context.js";

export interface Policy {
  readonly version: string;
  readonly blocked_countries: readonly string[];
  readonly blocked_regions: readonly string[];
}

export async function storePolicy(db: Db, pol: Policy): Promise<void> {
  await db
    .insertInto("geo_policy")
    .values({
      id: 1,
      version: pol.version,
      blocked_countries: [...pol.blocked_countries],
      blocked_regions: [...pol.blocked_regions],
      updated_at: new Date(),
    })
    .onConflict((oc) =>
      oc.column("id").doUpdateSet({
        version: pol.version,
        blocked_countries: [...pol.blocked_countries],
        blocked_regions: [...pol.blocked_regions],
        updated_at: new Date(),
      }),
    )
    .execute();
}

export async function currentPolicy(p: Payments): Promise<Policy> {
  const row = await p.db.selectFrom("geo_policy").selectAll().where("id", "=", 1).executeTakeFirst();
  if (row) return row;
  try {
    const pol = await p.compliance.geoPolicy();
    await storePolicy(p.db, pol);
    return pol;
  } catch (e) {
    p.log.error({ err: e instanceof Error ? e.message : String(e) }, "geo policy unavailable");
    throw new ApiError("screening_unavailable");
  }
}

/** Blocked when the country, or `<country>-<region>` (ISO 3166-2), is on the policy. */
export function isBlocked(pol: Policy, country: string, region: string | null): boolean {
  const c = country.toUpperCase();
  if (pol.blocked_countries.includes(c)) return true;
  if (!region) return false;
  const r = region.toUpperCase();
  return pol.blocked_regions.includes(r.includes("-") ? r : `${c}-${r}`);
}

export async function checkGeo(p: Payments, country: string | null, region: string | null): Promise<void> {
  if (!country || !/^[A-Za-z]{2}$/.test(country)) return; // no header (local) or Cloudflare's XX/T1
  if (isBlocked(await currentPolicy(p), country, region)) throw new ApiError("geo_blocked");
}
