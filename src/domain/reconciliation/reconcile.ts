/**
 * Daily reconciliation (lld/payments.md §9 `reconcile.daily`, domain-model §6, RB-05). Pure.
 *
 * For one account, mode and UTC day: Σ statement = Σ verified evidence per settlement asset, matched
 * execution by execution:
 * - inflow: `payment` + `overpayment` lines vs settled payment executions (`settled_amount`);
 * - outflow: `refund` lines (what left the merchant destination) vs settled refund executions
 *   (`refund.amount`, what the merchant sent), and what reached the payer (`received` vs `settled_amount`);
 * - fees: the statement's estimated fees vs fees rails observed, when rails reports them.
 * A statement line's day is its execution's `terminal_at` (Stage 1 lines: their creation time), the
 * same clock rails files evidence under, so consistent data always reconciles to zero diffs.
 */

export type LineType = "payment" | "overpayment" | "refund" | "fee_adjustment";

export interface StatementLine {
  /** `txn_…` */
  readonly id: string;
  readonly type: LineType;
  readonly assetId: string;
  readonly settled: bigint;
  /** Refund lines: what reached the payer. */
  readonly received: bigint | null;
  readonly feeEst: bigint | null;
  readonly feeAssetId: string | null;
  /** `ex_…` behind the line; null when it cannot be linked. */
  readonly executionId: string | null;
  readonly paymentIntent: string | null;
  readonly refund: string | null;
}

export interface EvidenceItem {
  /** `ex_…` */
  readonly executionId: string;
  readonly kind: "payment" | "refund";
  /** Settlement asset (payments) / source = settlement asset the merchant sent (refunds). */
  readonly assetId: string;
  /** Payments: `settled_amount`. Refunds: what the merchant sent (`refund.amount`). */
  readonly amount: bigint;
  /** Refunds: what reached the payer (`settled_amount`). */
  readonly received: bigint | null;
  /** Fee rails observed for the execution (Explorer `appFees`), when available. */
  readonly observedFee: { readonly amount: bigint; readonly assetId: string } | null;
  readonly paymentIntent: string | null;
  readonly refund: string | null;
}

export type DiffKind =
  | "missing_statement_line"
  | "missing_evidence"
  | "amount_mismatch"
  | "asset_mismatch"
  | "fee_mismatch"
  | "duplicate_line";

export interface Diff {
  readonly kind: DiffKind;
  readonly asset_id: string;
  readonly execution_id: string | null;
  readonly balance_transaction: string | null;
  readonly payment_intent: string | null;
  readonly refund: string | null;
  readonly statement_amount: string | null;
  readonly evidence_amount: string | null;
  readonly detail: string;
}

export interface Flow {
  statement: string;
  evidence: string;
  statement_lines: number;
  executions: number;
}

export interface Totals {
  readonly asset_id: string;
  readonly inflow: Flow;
  readonly outflow: Flow;
  readonly fees: { expected: string; observed: string | null };
}

export interface Result {
  readonly totals: Totals[];
  readonly diffs: Diff[];
}

interface Acc {
  inflow: { s: bigint; e: bigint; l: number; x: number };
  outflow: { s: bigint; e: bigint; l: number; x: number };
  feeExpected: bigint;
  feeObserved: bigint;
  feeRelevant: boolean;
}

const flowOf = (type: LineType | "payment_ex" | "refund_ex") =>
  type === "refund" || type === "refund_ex" ? "outflow" : "inflow";

export function reconcile(lines: readonly StatementLine[], evidence: readonly EvidenceItem[]): Result {
  const acc = new Map<string, Acc>();
  const of = (asset: string): Acc => {
    let a = acc.get(asset);
    if (!a) {
      a = {
        inflow: { s: 0n, e: 0n, l: 0, x: 0 },
        outflow: { s: 0n, e: 0n, l: 0, x: 0 },
        feeExpected: 0n,
        feeObserved: 0n,
        feeRelevant: false,
      };
      acc.set(asset, a);
    }
    return a;
  };
  const diffs: Diff[] = [];
  const diff = (d: Omit<Diff, "statement_amount" | "evidence_amount"> & { s?: bigint | null; e?: bigint | null }) => {
    const { s, e, ...rest } = d;
    diffs.push({
      ...rest,
      statement_amount: s === undefined || s === null ? null : s.toString(),
      evidence_amount: e === undefined || e === null ? null : e.toString(),
    });
  };

  const counted = lines.filter((l) => l.type !== "fee_adjustment");
  for (const l of counted) {
    const f = of(l.assetId)[flowOf(l.type)];
    f.s += l.settled;
    f.l += 1;
    if (l.type === "payment" && l.feeEst !== null && l.feeAssetId) {
      const fa = of(l.feeAssetId);
      fa.feeExpected += l.feeEst;
      fa.feeRelevant = true;
    }
  }
  for (const x of evidence) {
    const a = of(x.assetId);
    const f = a[x.kind === "refund" ? "outflow" : "inflow"];
    f.e += x.amount;
    f.x += 1;
    if (x.kind === "payment") {
      if (x.observedFee) of(x.observedFee.assetId).feeObserved += x.observedFee.amount;
    }
  }
  // fees are only comparable when every payment execution of the day reports its observed fee
  const payments = evidence.filter((x) => x.kind === "payment");
  const feesComparable = payments.length > 0 && payments.every((x) => x.observedFee !== null);

  // execution-by-execution matching
  const byExecution = new Map<string, StatementLine[]>();
  for (const l of counted) {
    if (!l.executionId) {
      diff({
        kind: "missing_evidence",
        asset_id: l.assetId,
        execution_id: null,
        balance_transaction: l.id,
        payment_intent: l.paymentIntent,
        refund: l.refund,
        s: l.settled,
        e: null,
        detail: `statement line ${l.id} (${l.type}) is not linked to any rails execution`,
      });
      continue;
    }
    byExecution.set(l.executionId, [...(byExecution.get(l.executionId) ?? []), l]);
  }
  const seen = new Set<string>();
  for (const x of evidence) {
    seen.add(x.executionId);
    const ls = byExecution.get(x.executionId) ?? [];
    const expectFlow = x.kind === "refund" ? "outflow" : "inflow";
    const matching = ls.filter((l) => flowOf(l.type) === expectFlow);
    if (matching.length === 0) {
      diff({
        kind: "missing_statement_line",
        asset_id: x.assetId,
        execution_id: x.executionId,
        balance_transaction: null,
        payment_intent: x.paymentIntent,
        refund: x.refund,
        s: null,
        e: x.amount,
        detail: `settled ${x.kind} execution ${x.executionId} has no statement line`,
      });
      continue;
    }
    if (matching.length > 1)
      for (const l of matching.slice(1))
        diff({
          kind: "duplicate_line",
          asset_id: l.assetId,
          execution_id: x.executionId,
          balance_transaction: l.id,
          payment_intent: l.paymentIntent,
          refund: l.refund,
          s: l.settled,
          e: x.amount,
          detail: `execution ${x.executionId} has ${matching.length} statement lines`,
        });
    const l = matching[0] as StatementLine;
    if (l.assetId !== x.assetId) {
      diff({
        kind: "asset_mismatch",
        asset_id: l.assetId,
        execution_id: x.executionId,
        balance_transaction: l.id,
        payment_intent: l.paymentIntent,
        refund: l.refund,
        s: l.settled,
        e: x.amount,
        detail: `line ${l.id} records ${l.assetId}; execution ${x.executionId} settled ${x.assetId}`,
      });
      continue;
    }
    if (l.settled !== x.amount)
      diff({
        kind: "amount_mismatch",
        asset_id: l.assetId,
        execution_id: x.executionId,
        balance_transaction: l.id,
        payment_intent: l.paymentIntent,
        refund: l.refund,
        s: l.settled,
        e: x.amount,
        detail: `line ${l.id} records ${l.settled}; evidence of ${x.executionId} shows ${x.amount}`,
      });
    else if (x.kind === "refund" && x.received !== null && l.received !== null && x.received !== l.received)
      diff({
        kind: "amount_mismatch",
        asset_id: l.assetId,
        execution_id: x.executionId,
        balance_transaction: l.id,
        payment_intent: l.paymentIntent,
        refund: l.refund,
        s: l.received,
        e: x.received,
        detail: `refund line ${l.id} records ${l.received} received by the payer; evidence shows ${x.received}`,
      });
  }
  for (const [ex, ls] of byExecution) {
    if (seen.has(ex)) continue;
    for (const l of ls)
      diff({
        kind: "missing_evidence",
        asset_id: l.assetId,
        execution_id: ex,
        balance_transaction: l.id,
        payment_intent: l.paymentIntent,
        refund: l.refund,
        s: l.settled,
        e: null,
        detail: `statement line ${l.id} (${l.type}) has no settled execution ${ex} on this day`,
      });
  }

  const totals: Totals[] = [...acc.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([asset, a]) => {
      const observed = feesComparable && (a.feeRelevant || a.feeObserved > 0n) ? a.feeObserved.toString() : null;
      if (observed !== null && BigInt(observed) !== a.feeExpected)
        diff({
          kind: "fee_mismatch",
          asset_id: asset,
          execution_id: null,
          balance_transaction: null,
          payment_intent: null,
          refund: null,
          s: a.feeExpected,
          e: BigInt(observed),
          detail: `estimated fees ${a.feeExpected} vs observed ${observed} in ${asset}`,
        });
      return {
        asset_id: asset,
        inflow: {
          statement: a.inflow.s.toString(),
          evidence: a.inflow.e.toString(),
          statement_lines: a.inflow.l,
          executions: a.inflow.x,
        },
        outflow: {
          statement: a.outflow.s.toString(),
          evidence: a.outflow.e.toString(),
          statement_lines: a.outflow.l,
          executions: a.outflow.x,
        },
        fees: { expected: a.feeExpected.toString(), observed },
      };
    });
  return { totals, diffs };
}

/** Whether `day` (`YYYY-MM-DD`) is a completed UTC day at `now`. */
export function isCompletedDay(day: string, now: number): boolean {
  const start = Date.parse(`${day}T00:00:00.000Z`);
  if (Number.isNaN(start)) return false;
  return start + 86_400_000 <= now;
}

/** The UTC day of an instant. */
export const utcDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** `[start, end)` of a UTC day. */
export function dayBounds(day: string): { start: Date; end: Date } {
  const start = new Date(`${day}T00:00:00.000Z`);
  return { start, end: new Date(start.getTime() + 86_400_000) };
}
