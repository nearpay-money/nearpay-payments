/**
 * Cursor pagination (api-conventions §2): newest first by `(created_at desc, id desc)`; ids are
 * UUIDv7, so id order is creation order. `starting_after` pages towards older objects;
 * `ending_before` returns the objects immediately newer than the cursor (still newest first).
 * `created[gte]` / `created[lte]` are unix seconds.
 */
import { toUuid } from "@nearpay-internal/ids";
import type { SelectQueryBuilder } from "kysely";

export interface PageQuery {
  readonly limit: number;
  readonly starting_after?: string | undefined;
  readonly ending_before?: string | undefined;
  readonly "created[gte]"?: number | undefined;
  readonly "created[lte]"?: number | undefined;
}

export interface Page<R> {
  readonly rows: R[];
  readonly hasMore: boolean;
}

interface Keyed {
  id: string;
  created_at: Date;
}

/** An id prefix (`cs`, `pi`, `txn`, …). */
export type IdPrefix = NonNullable<Parameters<typeof toUuid>[1]>;

// biome-ignore lint/suspicious/noExplicitAny: works over any table with `id` and `created_at`
type Q<R> = SelectQueryBuilder<any, any, R>;

export async function pageOf<R extends Keyed>(base: Q<R>, q: PageQuery, prefix: IdPrefix): Promise<Page<R>> {
  let query = base;
  if (q["created[gte]"] !== undefined) query = query.where("created_at", ">=", new Date(q["created[gte]"] * 1000));
  if (q["created[lte]"] !== undefined) query = query.where("created_at", "<", new Date((q["created[lte]"] + 1) * 1000));
  if (q.ending_before && !q.starting_after) {
    const rows = (await query
      .where("id", ">", toUuid(q.ending_before, prefix))
      .orderBy("id", "asc")
      .limit(q.limit + 1)
      .execute()) as R[];
    return { rows: rows.slice(0, q.limit).reverse(), hasMore: rows.length > q.limit };
  }
  if (q.starting_after) query = query.where("id", "<", toUuid(q.starting_after, prefix));
  const rows = (await query
    .orderBy("id", "desc")
    .limit(q.limit + 1)
    .execute()) as R[];
  return { rows: rows.slice(0, q.limit), hasMore: rows.length > q.limit };
}
