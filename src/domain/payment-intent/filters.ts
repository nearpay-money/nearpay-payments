/**
 * List filters on payment intents (ADR-0018, lld/payments.md §6.1). Pure.
 *
 * `amount[gte|gt|lte|lt]` compares the priced amount: fiat minor units (`bigint` column) or asset base
 * units (`numeric(78,0)`). Values may exceed the fiat column's range, so a fiat predicate is resolved
 * here to "everything", "nothing" or an in-range comparison (an index can still serve it).
 */

export type AmountOp = "gte" | "gt" | "lte" | "lt";
export const AMOUNT_OPS: readonly AmountOp[] = ["gte", "gt", "lte", "lt"];

const FIAT_MAX = 2n ** 63n - 1n;

export type FiatPredicate = "all" | "none" | { readonly op: AmountOp; readonly value: bigint };

export function fiatPredicate(op: AmountOp, value: bigint): FiatPredicate {
  if (value < 0n) return op === "gte" || op === "gt" ? "all" : "none";
  if (value > FIAT_MAX || (op === "gt" && value === FIAT_MAX)) return op === "gte" || op === "gt" ? "none" : "all";
  return { op, value };
}

export const SQL_OP: Record<AmountOp, ">=" | ">" | "<=" | "<"> = { gte: ">=", gt: ">", lte: "<=", lt: "<" };

/** The `amount[…]` entries of a parsed query. */
export function amountFilters(q: Record<string, unknown>): { op: AmountOp; value: bigint }[] {
  const out: { op: AmountOp; value: bigint }[] = [];
  for (const op of AMOUNT_OPS) {
    const v = q[`amount[${op}]`];
    if (typeof v === "string") out.push({ op, value: BigInt(v) });
  }
  return out;
}
