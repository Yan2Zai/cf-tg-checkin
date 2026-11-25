/** DO 版单测共用的小帮手（do-idle-poll / do-memory-refactor 两份原来各抄一份）。
 *
 * 只放两边一字不差的：node:sqlite 内存后端、kv 直读写、建 AgentService。
 * seedDo 两边签名不同、计数后端统计口径不同（记 SQL 文本 vs 只计数），
 * 各留各的，不硬凑。
 */
import { DatabaseSync } from "node:sqlite";
import { Store } from "../src/db.ts";
import type { SqlBackend } from "../src/d1/backend.ts";
import { AgentService } from "../src/agent.ts";
import { MemoryLock } from "../src/d1/lock.ts";
import type { Env } from "../src/env.ts";

export const MIN = 60_000;

/** DO 单账号后端：无 queryBudget（bump 永不触发），multiAccount=false。 */
export function doBackend(db: DatabaseSync): SqlBackend {
  return {
    multiAccount: false,
    async exec<T>(sql: string, ...params: unknown[]): Promise<T[]> {
      const stmt = db.prepare(sql);
      return stmt.all(...(params as never[])) as T[];
    },
    async run(sql: string, ...params: unknown[]): Promise<void> {
      db.prepare(sql).run(...(params as never[]));
    },
    async batch(statements: Array<{ sql: string; params: unknown[] }>): Promise<void> {
      for (const s of statements) db.prepare(s.sql).run(...(s.params as never[]));
    },
  };
}

export function putKv(db: DatabaseSync, key: string, value: string): void {
  db.prepare("INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(
    key,
    value,
  );
}

export function getKvRaw(db: DatabaseSync, key: string): string | null {
  const row = db.prepare("SELECT value FROM kv WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function makeService(db: DatabaseSync, backend: SqlBackend) {
  const store = new Store(backend, "");
  const service = new AgentService(store, {} as Env, new MemoryLock());
  const cache = (service as unknown as { cachedClients: Map<string, { client: unknown; key: string; touchedAt: number }> }).cachedClients;
  return { store, service, cache };
}
