/**
 * Stage 1 ops CLI (platform §3): `docker compose exec payments-api /nodejs/bin/node dist/ops.js
 * <command>`. Read-mostly support tools; every command prints one JSON document; errors print
 * `{"error": …}` and exit 1 (2: usage).
 */
import { parseArgs } from "node:util";
import { isId, toUuid } from "@nearpay-internal/ids";
import { ApiError } from "@nearpay-internal/service";
import { recoverQuoting } from "../app/attempts.js";
import type { Payments } from "../app/context.js";
import { getInternalIntent } from "../app/intents.js";
import { attemptsOf } from "../app/ledger.js";
import { refreshContext } from "../app/settlement-context.js";

export const USAGE = `usage: ops.js <command> [arguments]

  intent <pi_…>                       payment intent with attempts and its transitions
  session <cs_…>                      checkout session (no secret) and its transitions
  attempt-recover <pa_…>              re-ask rails for an attempt stuck in quoting (same idempotency key)
  context-refresh <acct_…> [--live]   re-read the settlement context from identity (test mode by default)
  stuck [--limit N]                   attempts in quoting for more than 2 minutes`;

class UsageError extends Error {}

export interface OpsDeps {
  out?: (line: string) => void;
  err?: (line: string) => void;
}

export async function runOps(argv: readonly string[], p: Payments, deps: OpsDeps = {}): Promise<number> {
  const out = deps.out ?? ((l: string) => process.stdout.write(`${l}\n`));
  const err = deps.err ?? ((l: string) => process.stderr.write(`${l}\n`));
  try {
    const { values, positionals } = parseArgs({
      args: [...argv],
      allowPositionals: true,
      strict: true,
      options: { live: { type: "boolean" }, limit: { type: "string" } },
    });
    const [cmd, ...args] = positionals;
    const result = await run(p, cmd, args, { live: values.live ?? false, limit: values.limit });
    out(JSON.stringify(result, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
    return 0;
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (
      e instanceof UsageError ||
      code === "ERR_PARSE_ARGS_UNKNOWN_OPTION" ||
      code === "ERR_PARSE_ARGS_INVALID_OPTION_VALUE"
    ) {
      err(`${e instanceof Error ? e.message : String(e)}\n\n${USAGE}`);
      return 2;
    }
    err(JSON.stringify({ error: e instanceof ApiError ? { code: e.code, message: e.message } : String(e) }));
    return 1;
  }
}

function idArg(args: readonly string[], prefix: Parameters<typeof isId>[0]): string {
  const id = args[0];
  if (!id || !isId(prefix, id)) throw new UsageError(`expected a ${prefix}_… id`);
  return id;
}

async function run(
  p: Payments,
  cmd: string | undefined,
  args: readonly string[],
  o: { live: boolean; limit: string | undefined },
): Promise<unknown> {
  switch (cmd) {
    case "intent": {
      const id = idArg(args, "pi");
      const transitions = await p.db
        .selectFrom("payment_intent_transitions")
        .selectAll()
        .where("payment_intent_id", "=", toUuid(id, "pi"))
        .orderBy("created_at", "asc")
        .execute();
      return { intent: await getInternalIntent(p, id), transitions };
    }
    case "session": {
      const id = idArg(args, "cs");
      const s = await p.db
        .selectFrom("checkout_sessions")
        .select([
          "id",
          "status",
          "expires_at",
          "ui_mode",
          "payment_intent_id",
          "live_attempts_count",
          "late",
          "completed_at",
        ])
        .where("id", "=", toUuid(id, "cs"))
        .executeTakeFirst();
      if (!s) throw ApiError.missing("checkout_session", id);
      const transitions = await p.db
        .selectFrom("checkout_session_transitions")
        .selectAll()
        .where("checkout_session_id", "=", s.id)
        .orderBy("created_at", "asc")
        .execute();
      const attempts = await p.db.transaction().execute((tx) => attemptsOf(tx, s.payment_intent_id));
      return {
        session: s,
        attempts: attempts.map((a) => ({
          id: a.id,
          status: a.status,
          method: a.method,
          execution: a.execution_id,
          visible: a.visible,
        })),
        transitions,
      };
    }
    case "attempt-recover": {
      const id = idArg(args, "pa");
      const changed = await recoverQuoting(p, toUuid(id, "pa"));
      if (changed) await p.notifier.publish(changed);
      const a = await p.db
        .selectFrom("payment_attempts")
        .select(["status", "execution_id", "failure_code"])
        .where("id", "=", toUuid(id, "pa"))
        .executeTakeFirst();
      return { attempt: id, ...a };
    }
    case "context-refresh": {
      const id = idArg(args, "acct");
      const ctx = await refreshContext(p, toUuid(id, "acct"), o.live);
      return {
        account: id,
        livemode: o.live,
        live_enabled: ctx.account.live_enabled,
        destinations: ctx.destinations.length,
        context_version: ctx.context_version,
      };
    }
    case "stuck": {
      const limit = Math.min(500, Math.max(1, Number(o.limit ?? 50) || 50));
      return p.db
        .selectFrom("payment_attempts")
        .select(["id", "payment_intent_id", "method", "created_at"])
        .where("status", "=", "quoting")
        .where("created_at", "<", new Date(p.now() - 120_000))
        .orderBy("created_at", "asc")
        .limit(limit)
        .execute();
    }
    default:
      throw new UsageError(cmd ? `unknown command '${cmd}'` : "missing command");
  }
}
