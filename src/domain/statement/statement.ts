/**
 * Statement lines (domain-model §6): NearPay holds no balances; a line records what settled where,
 * with its evidence. Pure.
 */
import { bpsOf } from "@nearpay-internal/money";

export interface LineInput {
  readonly type: "payment" | "overpayment";
  readonly intent: {
    readonly currency: string;
    readonly amount: bigint | null;
    readonly settlementAssetId: string;
    readonly settlementDecimals: number;
    readonly settlementSymbol: string;
  };
  readonly attempt: {
    readonly method: "route_quote" | "intents_transfer";
    readonly settled: bigint;
    readonly appliedFeeBps: number | null;
    readonly originAssetId: string;
    /** Payer's deposit (`route_quote`): appFees are bps of amountIn, in the origin asset. */
    readonly amountIn: bigint | null;
    /** `intents_transfer`: the fee transfer of the requirement, in the settlement asset. */
    readonly requirementFee: bigint | null;
  };
}

export interface Line {
  readonly type: "payment" | "overpayment";
  readonly grossAmount: bigint | null;
  readonly grossCurrency: string | null;
  readonly settledAmount: bigint;
  readonly settlementAssetId: string;
  readonly settlementDecimals: number;
  readonly settlementSymbol: string;
  readonly feeBps: number | null;
  readonly feeAmountEst: bigint | null;
  readonly feeAssetId: string | null;
}

export function statementLine(i: LineInput): Line {
  const fiat = i.intent.currency !== "asset";
  const payment = i.type === "payment";
  const a = i.attempt;
  let fee: { bps: number; amount: bigint; asset: string } | null = null;
  if (payment && a.appliedFeeBps !== null) {
    if (a.method === "intents_transfer" && a.requirementFee !== null)
      fee = { bps: a.appliedFeeBps, amount: a.requirementFee, asset: i.intent.settlementAssetId };
    else if (a.amountIn !== null)
      fee = { bps: a.appliedFeeBps, amount: bpsOf(a.amountIn, a.appliedFeeBps), asset: a.originAssetId };
  }
  return {
    type: i.type,
    grossAmount: payment && fiat ? i.intent.amount : null,
    grossCurrency: payment && fiat ? i.intent.currency : null,
    settledAmount: a.settled,
    settlementAssetId: i.intent.settlementAssetId,
    settlementDecimals: i.intent.settlementDecimals,
    settlementSymbol: i.intent.settlementSymbol,
    feeBps: fee?.bps ?? null,
    feeAmountEst: fee?.amount ?? null,
    feeAssetId: fee?.asset ?? null,
  };
}
