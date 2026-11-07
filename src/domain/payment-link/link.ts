/**
 * Payment links (lld/payments.md §6.1–§6.2, §17 item 11). Pure.
 *
 * A link is deactivated, never deleted; `uses` counts succeeded payments; a link with
 * `uses ≥ max_uses` stops accepting new payers (`link_inactive`). Sessions already opened still complete
 * (truth wins), so `uses` may end above `max_uses`.
 */

export interface LinkState {
  readonly active: boolean;
  readonly uses: number;
  readonly maxUses: number | null;
}

/** Whether a new payer may open a session. */
export function acceptsPayers(l: LinkState): boolean {
  return l.active && (l.maxUses === null || l.uses < l.maxUses);
}

/** Fields a PATCH may change (pricing is immutable, INV-6). */
export const LINK_MUTABLE = ["active", "description", "success_url", "max_uses", "collect_email", "metadata"] as const;
