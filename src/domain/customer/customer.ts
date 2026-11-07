/**
 * Customers (lld/payments.md §4, §6.1, §12). Pure. Email and name are personal data: the use cases
 * envelope-encrypt them and look emails up by a keyed hash of the normalised address.
 */

/** Lookup form of an email (exact, case-insensitive match, §6.1 `email` filter). */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export interface Wallet {
  readonly chain: string;
  readonly address: string;
}

/** Wallets without duplicates (same chain and address), first occurrence kept. */
export function dedupeWallets(ws: readonly Wallet[]): Wallet[] {
  const seen = new Set<string>();
  const out: Wallet[] = [];
  for (const w of ws) {
    const k = `${w.chain}|${w.chain.startsWith("eip155:") ? w.address.toLowerCase() : w.address}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ chain: w.chain, address: w.address });
  }
  return out;
}

/** A deleted customer cannot be changed or attached to new payments (`customer_deleted`). */
export function isUsable(c: { readonly deletedAt: Date | null }): boolean {
  return c.deletedAt === null;
}
