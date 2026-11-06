/** Turnstile siteverify client: Cloudflare test secrets answered locally, outage vs refusal mapping. */
import { describe, expect, it } from "vitest";
import { TEST_SECRETS, turnstileClient } from "../../src/infra/clients/turnstile.js";

const PASS = "1x0000000000000000000000000000000AA";
const FAIL = "2x0000000000000000000000000000000AA";
const SPENT = "3x0000000000000000000000000000000AA";

/** A fetch that records siteverify calls and answers with `status` / `body`. */
function siteverify(status: number, body: unknown) {
  const calls: { url: string; body: unknown }[] = [];
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : null });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { f, calls };
}

describe("turnstile client", () => {
  it("answers Cloudflare's test secrets locally outside the server stage (no egress)", async () => {
    for (const env of ["local", "test"] as const) {
      const { f, calls } = siteverify(500, {});
      expect(
        await turnstileClient({ secret: PASS, env, fetch: f }).verify("XXXX.DUMMY.TOKEN.XXXX", "203.0.113.9"),
      ).toBe("ok");
      expect(await turnstileClient({ secret: FAIL, env, fetch: f }).verify("any", null)).toBe("failed");
      expect(await turnstileClient({ secret: SPENT, env, fetch: f }).verify("any", null)).toBe("failed");
      expect(calls).toHaveLength(0);
    }
    expect(Object.keys(TEST_SECRETS)).toStrictEqual([PASS, FAIL, SPENT]);
  });

  it("asks siteverify on the server even for a test secret", async () => {
    const { f, calls } = siteverify(200, { success: false });
    expect(await turnstileClient({ secret: PASS, env: "server", fetch: f }).verify("tok", null)).toBe("failed");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://challenges.cloudflare.com/turnstile/v0/siteverify");
  });

  it("asks siteverify for a real secret in every environment and maps its answer", async () => {
    const ok = siteverify(200, { success: true });
    expect(
      await turnstileClient({ secret: "0x4AAA-real", env: "local", fetch: ok.f }).verify("tok", "203.0.113.9"),
    ).toBe("ok");
    expect(ok.calls[0]?.body).toMatchObject({ secret: "0x4AAA-real", response: "tok", remoteip: "203.0.113.9" });
    expect((ok.calls[0]?.body as { idempotency_key?: string } | undefined)?.idempotency_key).toMatch(/^[0-9a-f-]{36}$/);

    const refused = siteverify(200, { success: false });
    expect(await turnstileClient({ secret: "0x4AAA-real", env: "server", fetch: refused.f }).verify("tok", null)).toBe(
      "failed",
    );
    const bad = siteverify(400, { success: false });
    expect(await turnstileClient({ secret: "0x4AAA-real", env: "server", fetch: bad.f }).verify("tok", null)).toBe(
      "failed",
    );
    // an outage is not a refusal: the attempt proceeds under the stricter per-IP limit (F-12)
    const down = siteverify(503, {});
    expect(await turnstileClient({ secret: "0x4AAA-real", env: "server", fetch: down.f }).verify("tok", null)).toBe(
      "unavailable",
    );
    expect(down.calls).toHaveLength(2); // one retry, made safe by the idempotency key
  });
});
