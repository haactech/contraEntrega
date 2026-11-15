import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import * as schema from "./schema";

export type Db = DrizzleD1Database<typeof schema>;
export { schema };

export function createDb(d1: D1Database): Db {
  return drizzle(d1, { schema });
}

/** Anything drizzle can compile to SQL (insert/update/delete builders). */
export interface Compilable {
  toSQL(): { sql: string; params: unknown[] };
}

/**
 * D1 has no interactive transactions: atomic multi-statement writes go through `d1.batch`.
 * Drizzle builders are compiled to prepared statements so they can be mixed with raw ones.
 */
export function stmt(d1: D1Database, q: Compilable): D1PreparedStatement {
  const { sql, params } = q.toSQL();
  return d1.prepare(sql).bind(...params);
}

export function rawStmt(d1: D1Database, sqlText: string, ...params: unknown[]): D1PreparedStatement {
  return d1.prepare(sqlText).bind(...params);
}
