/**
 * Console operator actions (T-12, lld/payments.md §15): every console write payments executes publishes
 * `evt.payments.ops_action.recorded` (ids only) in the same transaction, and identity copies it into the
 * console's one audit trail.
 */
import { emit } from "@nearpay-internal/db";
import { fromUuid, uuidv7 } from "@nearpay-internal/ids";
import { ApiError, type RequestContext } from "@nearpay-internal/service";
import type { Tx } from "./context.js";

export interface Operator {
  /** `usr_…` */
  readonly sub: string;
  readonly opsRole: "ops" | "ops_admin";
}

/** The console operator of an ops route (`ptype=ops`, `ops_role` claim). */
export function operatorOf(ctx: Pick<RequestContext, "principal">): Operator {
  const c = ctx.principal as { ptype?: string; sub?: string; ops_role?: string } | null;
  if (c?.ptype !== "ops" || !c.sub) throw new ApiError("authentication_required");
  if (c.ops_role !== "ops" && c.ops_role !== "ops_admin")
    throw new ApiError("permission_denied", { message: "The console session carries no ops role." });
  return { sub: c.sub, opsRole: c.ops_role };
}

export async function recordOpsAction(
  tx: Tx,
  o: {
    operator: Operator;
    action: string;
    target: { type: string; id: string };
    accountUuid: string | null;
    livemode: boolean | null;
    at: Date;
  },
): Promise<void> {
  const id = uuidv7();
  await emit(tx, {
    subject: "evt.payments.ops_action.recorded",
    aggregate: { type: "ops_action", id, version: 1 },
    accountId: o.accountUuid,
    livemode: o.livemode,
    data: {
      object: {
        id,
        actor: { sub: o.operator.sub, ops_role: o.operator.opsRole },
        action: o.action,
        target: o.target,
        account_id: o.accountUuid ? fromUuid("acct", o.accountUuid) : null,
        approval: null,
        occurred_at: o.at.toISOString(),
      },
    },
  });
}
