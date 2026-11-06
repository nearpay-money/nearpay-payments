/**
 * Ops CLI entry (platform §3): `docker compose exec payments-api /nodejs/bin/node dist/ops.js …`.
 * Reads the api container's configuration; logs go to stderr, results to stdout.
 */
import { ConfigError, createLogger } from "@nearpay-internal/service";
import { createOpsContext } from "./app/services.js";
import { readOpsConfig } from "./config.js";
import { runOps } from "./ops/cli.js";

let code = 1;
try {
  const config = readOpsConfig();
  const log = createLogger({
    service: "payments-ops",
    env: config.env,
    level: config.logLevel,
    destination: process.stderr,
  });
  const ops = createOpsContext(config, log);
  try {
    code = await runOps(process.argv.slice(2), ops.payments);
  } finally {
    await ops.close();
  }
} catch (e) {
  process.stderr.write(
    `${e instanceof ConfigError ? e.message : e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`,
  );
}
process.exit(code);
