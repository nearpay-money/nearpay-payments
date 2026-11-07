/**
 * Daily reconciliation (lld/payments.md §6.4, §9 `reconcile.daily`, domain-model §6, RB-05).
 *
 * Per account, mode and completed UTC day: Σ statement = Σ verified evidence per settlement asset,
 * execution by execution (`domain/reconciliation`), against rails `GET /internal/evidence/summary`
 * (the day must be `complete` for rails) and `GET /internal/evidence` (settled payment and refund
 * executions). Each run is an append-only row (`rcn_`; a re-run records `rerun_of`, completed runs are
 * immutable except for their resolution, enforced by a trigger). A `diff`/`error` run opens a
 * `reconciliation_diff` compliance case (`POST /internal/cases`, `Idempotency-Key: rcn:<run>`) so it
 * lands in the console case queue; operators read and resolve runs on `/ops/reconciliation_runs…`.
 */
import { enqueueJob, sql } from "@nearpay-internal/db";
import { fromUuid, toUuid, uuidv7 } from "@nearpay-internal/ids";
import { ApiError } from "@nearpay-internal/service";
import type { Execution } from "@nearpay-internal/spec";
import {
  dayBounds,
  type EvidenceItem,
  isCompletedDay,
  reconcile,
  type StatementLine,
  utcDay,
} from "../domain/reconciliation/reconcile.js";
import type { EvidenceSummaryResponse } from "../infra/clients/peers.js";
import type { Payments, Tx } from "./context.js";
import { type Operator, recordOpsAction } from "./ops-audit.js";
import { dayString, type RunRow, runView } from "./views.js";

export const RECONCILE_DAILY_JOB = "reconcile.daily";
export const RECONCILE_RUN_JOB = "reconcile.run";
export const RECONCILE_CASE_JOB = "reconcile.case";
/** Transient failures of a run are retried this often before the run records `error`. */
const RUN_ATTEMPTS_BEFORE_ERROR = 3;

// ============================================================================================ schedule

/**
 * `reconcile.daily` at 02:00 UTC: one `reconcile.run` job per account and mode with activity on the
 * previous UTC day (statement lines, or executions of attempts and refund legs touched that day).
 */
export async function scheduleDaily(p: Payments, day = utcDay(p.now() - 86_400_000)): Promise<number> {
  const { start, end } = dayBounds(day);
  const grace = new Date(end.getTime() + 86_400_000);
  const accounts = await sql<{ account_id: string; livemode: boolean }>`
    select distinct account_id, livemode from (
      select account_id, livemode from balance_transactions
        where coalesce(terminal_at, created_at) >= ${start} and coalesce(terminal_at, created_at) < ${end}
      union
      select account_id, livemode from payment_attempts
        where execution_id is not null and updated_at >= ${start} and updated_at < ${grace}
      union
      select r.account_id, r.livemode from refund_legs l join refunds r on r.id = l.refund_id
        where l.execution_id is not null and l.updated_at >= ${start} and l.updated_at < ${grace}
    ) a`.execute(p.db);
  let n = 0;
  for (const a of accounts.rows) {
    const r = await enqueueJob(p.db, {
      kind: RECONCILE_RUN_JOB,
      payload: { account: a.account_id, livemode: a.livemode, day },
      dedupeKey: `${RECONCILE_RUN_JOB}:${a.account_id}:${a.livemode}:${day}`,
      maxAttempts: 48,
    });
    if (r.inserted) n++;
  }
  return n;
}

async function latestRunOf(db: Payments["db"] | Tx, account: string, livemode: boolean, day: string) {
  return db
    .selectFrom("reconciliation_runs")
    .select("id")
    .where("account_id", "=", account)
    .where("livemode", "=", livemode)
    .where("day", "=", day)
    .orderBy("id", "desc")
    .executeTakeFirst();
}

async function insertRun(
  db: Tx,
  o: { account: string; livemode: boolean; day: string; trigger: "schedule" | "ops"; createdBy: string },
): Promise<RunRow> {
  const prev = await latestRunOf(db, o.account, o.livemode, o.day);
  return db
    .insertInto("reconciliation_runs")
    .values({
      id: uuidv7(),
      account_id: o.account,
      livemode: o.livemode,
      day: o.day,
      status: "running",
      trigger: o.trigger,
      rerun_of: prev?.id ?? null,
      created_by: o.createdBy,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

/** The `reconcile.run` job: an ops run (`{run}`) or a scheduled day (`{account, livemode, day}`). */
export async function runJob(p: Payments, payload: unknown, attempt: number): Promise<void> {
  const o = payload as { run?: string; account?: string; livemode?: boolean; day?: string } | null;
  if (typeof o?.run === "string") return executeRun(p, o.run, attempt);
  if (typeof o?.account !== "string" || typeof o.livemode !== "boolean" || typeof o.day !== "string")
    throw new Error("reconcile.run payload without a run or an account day");
  const summary = await p.rails.evidenceSummary(fromUuid("acct", o.account), o.livemode, o.day);
  // rails has not closed the day yet: retry later (backoff) rather than record a spurious diff
  if (!summary.complete) throw new Error(`evidence of ${o.day} not complete yet (in_flight ${summary.in_flight})`);
  const run = await p.db.transaction().execute((tx) =>
    insertRun(tx, { account: o.account as string, livemode: o.livemode as boolean, day: o.day as string, trigger: "schedule", createdBy: "system" }),
  );
  await executeRun(p, run.id, RUN_ATTEMPTS_BEFORE_ERROR, summary);
}

// ============================================================================================ execution

async function allEvidence(p: Payments, account: string, livemode: boolean, day: string): Promise<Execution[]> {
  const out: Execution[] = [];
  let after: string | undefined;
  for (;;) {
    const page = await p.rails.evidence({
      account_id: fromUuid("acct", account),
      livemode: livemode ? "true" : "false",
      day,
      limit: 1000,
      states: "succeeded",
      ...(after ? { starting_after: after } : {}),
    } as never);
    out.push(...page.data);
    if (!page.has_more || page.data.length === 0) return out;
    after = page.data[page.data.length - 1]?.id;
  }
}

async function statementOf(p: Payments, account: string, livemode: boolean, day: string): Promise<StatementLine[]> {
  const { start, end } = dayBounds(day);
  const rows = await p.db
    .selectFrom("balance_transactions")
    .selectAll()
    .where("account_id", "=", account)
    .where("livemode", "=", livemode)
    .where(sql<boolean>`coalesce(terminal_at, created_at) >= ${start} and coalesce(terminal_at, created_at) < ${end}`)
    .execute();
  // Stage 1 lines carry no execution id: link them through their attempt / refund leg
  const attemptIds = rows.filter((r) => !r.execution_id && r.payment_attempt_id).map((r) => r.payment_attempt_id as string);
  const refundIds = rows.filter((r) => !r.execution_id && r.refund_id).map((r) => r.refund_id as string);
  const [attempts, legs] = await Promise.all([
    attemptIds.length
      ? p.db.selectFrom("payment_attempts").select(["id", "execution_id"]).where("id", "in", attemptIds).execute()
      : [],
    refundIds.length
      ? p.db.selectFrom("refund_legs").select(["refund_id", "number", "execution_id"]).where("refund_id", "in", refundIds).execute()
      : [],
  ]);
  const exOfAttempt = new Map(attempts.map((a) => [a.id, a.execution_id]));
  const exOfLeg = new Map(legs.map((l) => [`${l.refund_id}:${l.number}`, l.execution_id]));
  return rows.map((r) => ({
    id: fromUuid("txn", r.id),
    type: r.type,
    assetId: r.settlement_asset_id,
    settled: BigInt(r.settled_amount),
    received: r.received ? BigInt(r.received.amount) : null,
    feeEst: r.fee_amount_est === null ? null : BigInt(r.fee_amount_est),
    feeAssetId: r.fee_asset_id,
    executionId:
      r.execution_id ??
      (r.payment_attempt_id ? exOfAttempt.get(r.payment_attempt_id) : exOfLeg.get(`${r.refund_id}:${r.refund_leg}`)) ??
      null,
    paymentIntent: r.payment_intent_id ? fromUuid("pi", r.payment_intent_id) : null,
    refund: r.refund_id ? fromUuid("re", r.refund_id) : null,
  }));
}

export function evidenceItem(x: Execution): EvidenceItem {
  const refund = x.kind === "refund";
  return {
    executionId: x.id,
    kind: refund ? "refund" : "payment",
    assetId: refund ? x.origin.asset_id : x.settlement.asset_id,
    amount: BigInt(refund ? (x.refund?.amount ?? "0") : (x.settled_amount ?? "0")),
    received: refund ? BigInt(x.settled_amount ?? "0") : null,
    // rails does not report observed fees on executions yet (change request in the step report)
    observedFee: null,
    paymentIntent: x.reference?.payment_intent ?? null,
    refund: x.reference?.refund ?? null,
  };
}

function summaryCount(s: EvidenceSummaryResponse): number {
  return s.totals.filter((t) => t.state === "succeeded").reduce((n, t) => n + t.count, 0);
}

/** Computes a `running` run and completes it (`ok`/`diff`/`error`). */
export async function executeRun(
  p: Payments,
  runId: string,
  attempt: number,
  summary0?: EvidenceSummaryResponse,
): Promise<void> {
  const run = await p.db.selectFrom("reconciliation_runs").selectAll().where("id", "=", runId).executeTakeFirst();
  if (run?.status !== "running") return;
  const day = dayString(run.day);
  try {
    const summary = summary0 ?? (await p.rails.evidenceSummary(fromUuid("acct", run.account_id), run.livemode, day));
    if (!summary.complete)
      return await finish(p, run, {
        status: "error",
        error: `rails evidence for ${day} is not complete (${summary.in_flight} in flight, ${summary.held_open} held)`,
      });
    const [evidence, lines] = await Promise.all([
      allEvidence(p, run.account_id, run.livemode, day),
      statementOf(p, run.account_id, run.livemode, day),
    ]);
    if (evidence.length !== summaryCount(summary))
      return await finish(p, run, {
        status: "error",
        error: `rails evidence pages (${evidence.length}) disagree with its summary (${summaryCount(summary)})`,
      });
    const out = reconcile(lines, evidence.map(evidenceItem));
    await finish(p, run, { status: out.diffs.length ? "diff" : "ok", totals: out.totals, diffs: out.diffs });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (attempt < RUN_ATTEMPTS_BEFORE_ERROR) throw e; // transient: the job retries the same run
    await finish(p, run, { status: "error", error: `reconciliation could not complete: ${msg}`.slice(0, 1000) });
  }
}

async function finish(
  p: Payments,
  run: RunRow,
  o: { status: "ok" | "diff" | "error"; totals?: unknown[]; diffs?: unknown[]; error?: string },
): Promise<void> {
  await p.db.transaction().execute(async (tx) => {
    const done = await tx
      .updateTable("reconciliation_runs")
      .set({
        status: o.status,
        totals: JSON.stringify(o.totals ?? []),
        diffs: JSON.stringify(o.diffs ?? []),
        error: o.error ?? null,
        completed_at: new Date(p.now()),
      })
      .where("id", "=", run.id)
      .where("status", "=", "running")
      .returning("id")
      .executeTakeFirst();
    if (done && o.status !== "ok")
      await enqueueJob(tx, {
        kind: RECONCILE_CASE_JOB,
        payload: { run: run.id },
        dedupeKey: `${RECONCILE_CASE_JOB}:${run.id}`,
        maxAttempts: 50,
      });
  });
  const n = o.diffs?.length ?? 0;
  p.metrics.reconciliation(o.status, n);
  if (o.status !== "ok")
    p.log.error(
      { run: fromUuid("rcn", run.id), account: run.account_id, day: dayString(run.day), status: o.status, diffs: n },
      "ALERT reconciliation run with differences",
    );
}

/** The `reconcile.case` job: opens the run's `reconciliation_diff` case in compliance (idempotent). */
export async function openCase(p: Payments, runUuid: string): Promise<void> {
  const run = await p.db.selectFrom("reconciliation_runs").selectAll().where("id", "=", runUuid).executeTakeFirst();
  if (!run || run.case_id || (run.status !== "diff" && run.status !== "error")) return;
  const rcn = fromUuid("rcn", run.id);
  const diffs = run.diffs as { kind: string }[];
  const kinds = new Map<string, number>();
  for (const d of diffs) kinds.set(d.kind, (kinds.get(d.kind) ?? 0) + 1);
  const note =
    run.status === "error"
      ? `Reconciliation ${dayString(run.day)} errored: ${run.error ?? "unknown"}`
      : `Reconciliation ${dayString(run.day)}: ${diffs.length} diff${diffs.length === 1 ? "" : "s"}: ${[...kinds]
          .map(([k, n]) => `${k} ×${n}`)
          .join(", ")}`;
  const c = await p.compliance.createCase(
    {
      kind: "reconciliation_diff",
      account_id: fromUuid("acct", run.account_id),
      livemode: run.livemode,
      subject: { type: "reconciliation_run", id: rcn },
      severity: "high",
      note: note.slice(0, 2000),
    } as never,
    `rcn:${rcn}`,
  );
  await p.db
    .updateTable("reconciliation_runs")
    .set({ case_id: c.id })
    .where("id", "=", run.id)
    .where("case_id", "is", null)
    .execute();
}

// ============================================================================================ console (/ops)

export interface RunListQuery {
  readonly limit: number;
  readonly starting_after?: string | undefined;
  readonly ending_before?: string | undefined;
  readonly account?: string | undefined;
  readonly livemode?: string | undefined;
  readonly status?: string | undefined;
  readonly day?: string | undefined;
  readonly "day[gte]"?: string | undefined;
  readonly "day[lte]"?: string | undefined;
  readonly unresolved?: string | undefined;
}

/** `GET /ops/reconciliation_runs`: newest first (by day, then id). */
export async function listRuns(p: Payments, q: RunListQuery) {
  let base = p.db.selectFrom("reconciliation_runs").selectAll();
  if (q.account) base = base.where("account_id", "=", toUuid(q.account, "acct"));
  if (q.livemode) base = base.where("livemode", "=", q.livemode === "true");
  if (q.status) base = base.where("status", "=", q.status as RunRow["status"]);
  if (q.day) base = base.where("day", "=", q.day);
  if (q["day[gte]"]) base = base.where("day", ">=", q["day[gte]"]);
  if (q["day[lte]"]) base = base.where("day", "<=", q["day[lte]"]);
  if (q.unresolved === "true") base = base.where("status", "in", ["diff", "error"]).where("resolution", "is", null);
  if (q.unresolved === "false")
    base = base.where((eb) => eb.or([eb("status", "in", ["ok", "running"]), eb("resolution", "is not", null)]));
  // ids are UUIDv7: id order is creation order (pages by id like every list)
  if (q.ending_before && !q.starting_after) {
    const rows = await base
      .where("id", ">", toUuid(q.ending_before, "rcn"))
      .orderBy("id", "asc")
      .limit(q.limit + 1)
      .execute();
    return {
      object: "list" as const,
      data: rows.slice(0, q.limit).reverse().map(runView),
      has_more: rows.length > q.limit,
      url: "/ops/reconciliation_runs",
    };
  }
  if (q.starting_after) base = base.where("id", "<", toUuid(q.starting_after, "rcn"));
  const rows = await base
    .orderBy("id", "desc")
    .limit(q.limit + 1)
    .execute();
  return {
    object: "list" as const,
    data: rows.slice(0, q.limit).map(runView),
    has_more: rows.length > q.limit,
    url: "/ops/reconciliation_runs",
  };
}

async function runRow(p: Payments, id: string): Promise<RunRow> {
  const r = await p.db.selectFrom("reconciliation_runs").selectAll().where("id", "=", toUuid(id, "rcn")).executeTakeFirst();
  if (!r) throw ApiError.missing("reconciliation_run", id);
  return r;
}

export async function getRun(p: Payments, id: string) {
  return runView(await runRow(p, id));
}

/** `POST /ops/reconciliation_runs`: completed UTC days only; one running run per account, mode and day. */
export async function createRun(
  p: Payments,
  op: Operator,
  body: { account_id: string; livemode: boolean; day: string },
) {
  if (!isCompletedDay(body.day, p.now()))
    throw new ApiError("reconciliation_day_open", { param: "day", message: `${body.day} is not a completed UTC day.` });
  const account = toUuid(body.account_id, "acct");
  let run: RunRow;
  try {
    run = await p.db.transaction().execute(async (tx) => {
      const r = await insertRun(tx, { account, livemode: body.livemode, day: body.day, trigger: "ops", createdBy: op.sub });
      await enqueueJob(tx, {
        kind: RECONCILE_RUN_JOB,
        payload: { run: r.id },
        dedupeKey: `${RECONCILE_RUN_JOB}:run:${r.id}`,
        maxAttempts: 10,
      });
      await recordOpsAction(tx, {
        operator: op,
        action: "reconciliation_run.created",
        target: { type: "reconciliation_run", id: fromUuid("rcn", r.id) },
        accountUuid: account,
        livemode: body.livemode,
        at: new Date(p.now()),
      });
      return r;
    });
  } catch (e) {
    if ((e as { code?: string }).code === "23505")
      throw new ApiError("state_conflict", { message: `A reconciliation of ${body.day} is already running.` });
    throw e;
  }
  return runView(run);
}

/** `POST /ops/reconciliation_runs/{id}/resolution` (RB-05): once, on a completed `diff`/`error` run. */
export async function resolveRun(
  p: Payments,
  op: Operator,
  id: string,
  body: { classification: string; note: string },
) {
  const r = await runRow(p, id);
  const out = await p.db.transaction().execute(async (tx) => {
    const resolution = {
      classification: body.classification,
      note: body.note,
      actor: op.sub,
      resolved_at: new Date(p.now()).toISOString(),
    };
    const done = await tx
      .updateTable("reconciliation_runs")
      .set({ resolution: JSON.stringify(resolution) })
      .where("id", "=", r.id)
      .where("status", "in", ["diff", "error"])
      .where("resolution", "is", null)
      .where("completed_at", "is not", null)
      .returningAll()
      .executeTakeFirst();
    if (!done)
      throw new ApiError("state_conflict", {
        message: `The run is ${r.status}${r.resolution ? " and already resolved" : ""}; only an unresolved diff/error run is resolved.`,
      });
    await recordOpsAction(tx, {
      operator: op,
      action: "reconciliation_run.resolved",
      target: { type: "reconciliation_run", id: fromUuid("rcn", r.id) },
      accountUuid: r.account_id,
      livemode: r.livemode,
      at: new Date(p.now()),
    });
    return done;
  });
  return runView(out);
}
