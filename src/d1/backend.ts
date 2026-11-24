/**
 * SQL 后端：Store 的两种实现（DO 内嵌 SQLite / D1）。
 *
 * Store 的 SQL 文本两种后端共用（占位符都是 `?`），区别只在执行方式：
 * DO 是同步 SqlStorage，包一层 Promise；D1 是异步 prepare/bind。
 */
export interface SqlBackend {
  /** 是否支持多账号（D1 有 accounts 表；DO 是单账号遗留模式，返回合成账号） */
  readonly multiAccount: boolean;
  /** 单次 Worker 调用的查询预算（D1 是 50 条，留 5 条余量；DO 内嵌 SQLite 无此限制，不设） */
  readonly queryBudget?: number;
  /** 执行并返回行（SELECT / INSERT…RETURNING）。 */
  exec<T = Record<string, unknown>>(sql: string, ...params: unknown[]): Promise<T[]>;
  /** 执行写操作（INSERT / UPDATE / DELETE），不需要返回行。 */
  run(sql: string, ...params: unknown[]): Promise<void>;
  /** 原子执行多条写语句。 */
  batch(statements: Array<{ sql: string; params: unknown[] }>): Promise<void>;
  /** 存储总字节数（只有 DO 能直接读；D1 返回 undefined，走 PRAGMA 查询）。 */
  databaseSize?(): number | undefined;
}

const LEGACY_TABLES = ["tasks", "logs", "events", "auth_attempts", "deletions"];

/** DO 内嵌 SQLite 的建表语句（全新 DO 第一次用时建表；老库 IF NOT EXISTS 直接跳过）。 */
const DO_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      name_auto INTEGER,
      enabled INTEGER NOT NULL DEFAULT 1,
      target TEXT NOT NULL,
      targets TEXT,
      thread_id INTEGER,
      schedule TEXT NOT NULL,
      steps TEXT NOT NULL,
      success_keywords TEXT NOT NULL DEFAULT '[]',
      timeout_seconds INTEGER NOT NULL DEFAULT 25,
      step_delay_seconds INTEGER NOT NULL DEFAULT 1,
      delete_after_seconds INTEGER NOT NULL DEFAULT 0,
      cleanup_previous INTEGER NOT NULL DEFAULT 0,
      group_name TEXT,
      next_run_at INTEGER,
      last_run_at INTEGER,
      last_result TEXT,
      last_run_source TEXT,
      last_message TEXT,
      last_detail TEXT,
      fail_streak INTEGER NOT NULL DEFAULT 0,
      renewal TEXT,
      source TEXT NOT NULL DEFAULT 'ui',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`,
  `CREATE INDEX IF NOT EXISTS idx_tasks_next ON tasks(enabled, next_run_at)`,
  `CREATE TABLE IF NOT EXISTS logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER,
      task_name TEXT,
      at INTEGER NOT NULL,
      ok INTEGER NOT NULL,
      level TEXT NOT NULL,
      message TEXT NOT NULL,
      detail TEXT,
      source TEXT,
      duration_ms INTEGER
    )`,
  `CREATE INDEX IF NOT EXISTS idx_logs_at ON logs(at DESC)`,
  `CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      at INTEGER NOT NULL
    )`,
  `CREATE INDEX IF NOT EXISTS idx_events_name ON events(name, at)`,
  `CREATE TABLE IF NOT EXISTS auth_attempts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ip TEXT NOT NULL,
      at INTEGER NOT NULL,
      ok INTEGER NOT NULL
    )`,
  `CREATE INDEX IF NOT EXISTS idx_auth_at ON auth_attempts(at)`,
  `CREATE TABLE IF NOT EXISTS deletions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat TEXT NOT NULL,
      msg_ids TEXT NOT NULL,
      due_at INTEGER NOT NULL
    )`,
  `CREATE INDEX IF NOT EXISTS idx_deletions_due ON deletions(due_at)`,
];

/** DO 后端：包一层同步 SqlStorage。单账号遗留模式，accountId 用空字符串。 */
export class DoBackend implements SqlBackend {
  readonly multiAccount = false;

  constructor(private readonly sql: SqlStorage) {
    // 全新 DO 先建表（老库 IF NOT EXISTS 跳过）
    for (const statement of DO_SCHEMA) {
      try {
        this.sql.exec(statement);
      } catch {
        /* 建表失败不阻塞启动，首次查询会报错 */
      }
    }
    // 给旧库补 account_id 列（新库建表时已有，重复会报错，忽略即可）
    for (const table of LEGACY_TABLES) {
      try {
        this.sql.exec(`ALTER TABLE ${table} ADD COLUMN account_id TEXT`);
      } catch {
        /* 列已存在 */
      }
    }
    // 旧数据 account_id 是 NULL，回填成 ''（单账号模式的标识）
    for (const table of LEGACY_TABLES) {
      try {
        this.sql.exec(`UPDATE ${table} SET account_id = '' WHERE account_id IS NULL`);
      } catch {
        /* 表不存在（全新 DO，建表由旧版 Store 负责） */
      }
    }
  }

  async exec<T = Record<string, unknown>>(sql: string, ...params: unknown[]): Promise<T[]> {
    return this.sql.exec(sql, ...params).toArray() as T[];
  }

  async run(sql: string, ...params: unknown[]): Promise<void> {
    this.sql.exec(sql, ...params);
  }

  async batch(statements: Array<{ sql: string; params: unknown[] }>): Promise<void> {
    // DO 里执行已由 serialize() 串行，顺序执行即可
    for (const s of statements) this.sql.exec(s.sql, ...s.params);
  }

  databaseSize(): number | undefined {
    return this.sql.databaseSize;
  }
}

/** D1 后端：调 D1Database 的 prepare / run / batch。 */
export class D1Backend implements SqlBackend {
  readonly multiAccount = true;
  /** D1 每 Worker 调用 50 条查询，留 5 条余量。 */
  readonly queryBudget = 45;

  constructor(private readonly db: D1Database) {}

  async exec<T = Record<string, unknown>>(sql: string, ...params: unknown[]): Promise<T[]> {
    const result = await this.db.prepare(sql).bind(...params).all<T>();
    return result.results ?? [];
  }

  async run(sql: string, ...params: unknown[]): Promise<void> {
    await this.db.prepare(sql).bind(...params).run();
  }

  async batch(statements: Array<{ sql: string; params: unknown[] }>): Promise<void> {
    if (!statements.length) return;
    await this.db.batch(statements.map((s) => this.db.prepare(s.sql).bind(...s.params)));
  }
}
