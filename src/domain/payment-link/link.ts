/**
 * Payment links (lld/payments.md §6.1–§6.2, §17 item 11). Pure.
 *
 * A link is deactivated, never deleted; `uses` counts succeeded payments; a link with
 * `uses ≥ max_uses` stops accepting new payers (`link_inactive`). Sessions already opened still complete
 * (truth wins), so `uses` may end above `max_uses`.
 *
 * `max_uses` holds under concurrency (audit finding 12): a session opened from a link reserves one use
 * while its intent can still succeed (`requires_payment`, `processing`, `requires_review`); session
 * creation counts `uses + reserved` under the link's row lock. A reservation ends when the intent
 * succeeds (it becomes a use) or is canceled or expires.
 */

export interface LinkState {
  readonly active: boolean;
  readonly uses: number;
  readonly maxUses: number | null;
}

/** Whether a new payer may open a session; `reserved` = sessions whose intent can still succeed. */
export function acceptsPayers(l: LinkState, reserved = 0): boolean {
  return l.active && (l.maxUses === null || l.uses + reserved < l.maxUses);
}

/** Intent statuses that still hold a link use (the payment may succeed). */
export const RESERVING_INTENT_STATUSES = ["requires_payment", "processing", "requires_review"] as const;

/** Fields a PATCH may change (pricing is immutable, INV-6). */
export const LINK_MUTABLE = ["active", "description", "success_url", "max_uses", "collect_email", "metadata"] as const;
