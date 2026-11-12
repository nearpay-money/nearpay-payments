import { describe, expect, it } from "vitest";
import type { Payments } from "../../src/app/context.js";
import { killSwitchSyncTask } from "../../src/app/kill-switch.js";
import { runOps } from "../../src/ops/cli.js";

describe("kit 0.6.0 adoption", () => {
  it("kill-switch-sync declares a liveness budget and beats every tick, failed reads included", async () => {
    const task = killSwitchSyncTask({} as Payments, { tickMs: 5 });
    expect(task.maxSilenceMs).toBe(120_000);
    let beats = 0;
    const running = await task.start({ beat: () => void beats++, idle: () => {} });
    await new Promise((r) => setTimeout(r, 60));
    await running.stop();
    expect(beats).toBeGreaterThan(0);
  });

  it("ops CLI routes dead-letters/outbox to the kit and prints its usage on a bad sub-command", async () => {
    const errs: string[] = [];
    const p = { db: {} } as unknown as Payments;
    expect(await runOps(["dead-letters"], p, { err: (l) => errs.push(l), out: () => {} })).toBe(2);
    expect(await runOps(["outbox", "nope"], p, { err: (l) => errs.push(l), out: () => {} })).toBe(2);
    expect(errs.join("\n")).toContain("dead-letters replay <id>");
  });
});
