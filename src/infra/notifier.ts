/**
 * Change notifications for the payer stream (lld/payments.md §8.3: "Valkey publish `cs:<id>` after
 * commit"): api replicas subscribe once per process and fan out to their open streams. Without Valkey
 * (or while it is down) notifications stay in-process; every stream also re-checks its session on a
 * short timer, so a lost notification only delays an update.
 */
import { EventEmitter } from "node:events";
import { Redis } from "ioredis";

export interface Notifier {
  /** Announces that session `id` (uuid) changed. Never throws. */
  publish(sessionId: string): Promise<void>;
  /** Calls `fn` when session `id` changes; returns the unsubscribe function. */
  subscribe(sessionId: string, fn: () => void): () => void;
  close(): Promise<void>;
}

const channel = (id: string) => `cs:${id}`;

export function notifier(valkeyUrl: string | undefined): Notifier {
  const local = new EventEmitter();
  local.setMaxListeners(0);
  const opts = {
    lazyConnect: false,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 0,
    connectTimeout: 1_000,
  } as const;
  const pub = valkeyUrl ? new Redis(valkeyUrl, opts) : null;
  const sub = valkeyUrl ? new Redis(valkeyUrl, { ...opts, enableOfflineQueue: true }) : null;
  pub?.on("error", () => {});
  sub?.on("error", () => {});
  const counts = new Map<string, number>();
  sub?.on("message", (ch: string) => {
    if (ch.startsWith("cs:")) local.emit(ch);
  });
  // re-subscribe after a reconnect
  sub?.on("ready", () => {
    if (counts.size) sub.subscribe(...counts.keys()).catch(() => {});
  });
  return {
    async publish(id) {
      if (pub?.status === "ready") {
        // the subscriber connection delivers it to this process too
        await pub.publish(channel(id), "1").catch(() => local.emit(channel(id)));
      } else local.emit(channel(id));
    },
    subscribe(id, fn) {
      const ch = channel(id);
      local.on(ch, fn);
      const n = (counts.get(ch) ?? 0) + 1;
      counts.set(ch, n);
      if (n === 1 && sub?.status === "ready") sub.subscribe(ch).catch(() => {});
      return () => {
        local.off(ch, fn);
        const left = (counts.get(ch) ?? 1) - 1;
        if (left <= 0) {
          counts.delete(ch);
          if (sub?.status === "ready") sub.unsubscribe(ch).catch(() => {});
        } else counts.set(ch, left);
      };
    },
    async close() {
      pub?.disconnect();
      sub?.disconnect();
      local.removeAllListeners();
    },
  };
}
