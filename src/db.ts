/**
 * 异步 Store：唯一的数据层。所有状态（账号、任务、日志、配置、会话）都在这里。
 *
 * 两种后端（见 src/d1/backend.ts）：
 * - DO 内嵌 SQLite（DoBackend，单账号遗留模式，accountId 为空字符串）；
 * - D1（D1Backend，多账号，accountId 是账号标识）。
 *
 * 调用方只认 Store：kv 自动按账号加前缀（accountId 为空时不加前缀，
 * 兼容 DO 旧数据）；tasks / logs / events / auth_attempts / deletions
 * 一律按 account_id 过滤。schema 由 migrations/0001_init.sql 管（D1），
 * DO 旧库的 account_id 列由 DoBackend 构造时补。
 */
import type { CheckinAccount, LogEntry, Schedule, Settings, Step, Target, Task, TaskInput } from "./types";
import { DEFAULT_SETTINGS } from "./types";
import { taskFingerprint } from "./task";
import type { SqlBackend } from "./d1/backend";

type Row = Record<string, unknown>;

interface TaskRow extends Row {
  id: number;
  account_id: string;
  name: string;
  name_auto: number | null;
  enabled: number;
  target: string;
  targets: string | null;
  thread_id: number | null;
  schedule: string;
  steps: string;
  success_keywords: string;
  timeout_seconds: number;
  step_delay_seconds: number | null;
  delete_after_seconds: number;
  cleanup_previous: number;
  group_name: string | null;
  next_run_at: number | null;
  last_run_at: number | null;
  last_result: string | null;
  last_run_source: string | null;
  last_message: string | null;
  last_detail: string | null;
  fail_streak: number | null;
  renewal: string | null;
  source: string;
  created_at: number;
  updated_at: number;
}

export interface LogFilter {
  limit?: number;
  offset?: number;
  beforeId?: number | null;
  taskId?: number | null;
  level?: string | null;
  query?: string | null;
  /** 只看这个时间点之后的日志（ms） */
  since?: number | null;
}

export interface LogRow extends Row {
  id: number;
  account_id: string | null;
  task_id: number | null;
  task_name: string | null;
  at: number;
  ok: number;
  level: string;
  message: string;
  detail: string | null;
  source: string | null;
  duration_ms: number | null;
}

function parseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

/** 去掉和 username 重复的 title（历史数据里可能存了 "@bot"） */
function normalizeTarget(target: Target): Target {
  if (target.title && target.username && target.title === `@${target.username}`) {
    return { ...target, title: undefined };
  }
  return target;
}

export function rowToTask(row: TaskRow): Task {
  return {
    id: row.id,
    name: row.name,
    nameAuto: row.name_auto === null || row.name_auto === undefined ? undefined : row.name_auto === 1,
    enabled: !!row.enabled,
    target: normalizeTarget(parseJson<Target>(row.target, { kind: "user", id: "" })),
    targets: (() => {
      const parsed = parseJson<Target[]>(row.targets ?? "[]", []);
      return Array.isArray(parsed) && parsed.length > 1 ? parsed : undefined;
    })(),
    threadId: row.thread_id,
    schedule: parseJson<Schedule>(row.schedule, { kind: "daily", time: "09:00" }),
    steps: parseJson<Step[]>(row.steps, []),
    successKeywords: parseJson<string[]>(row.success_keywords, []),
    timeoutSeconds: row.timeout_seconds ?? 30,
    stepDelaySeconds: row.step_delay_seconds ?? 1,
    deleteAfterSeconds: row.delete_after_seconds,
    cleanupPrevious: !!row.cleanup_previous,
    group: row.group_name || undefined,
    nextRunAt: row.next_run_at,
    lastRunAt: row.last_run_at,
    lastResult: (row.last_result as Task["lastResult"]) ?? null,
    lastRunSource: (row.last_run_source as Task["lastRunSource"]) ?? null,
    lastMessage: row.last_message,
    lastDetail: row.last_detail,
    failStreak: row.fail_streak ?? 0,
    renewal: (() => {
      if (!row.renewal) return undefined;
      const parsed = parseJson<import("./types").RenewalConfig>(row.renewal, null as never);
      return parsed && typeof parsed === "object" ? parsed : undefined;
    })(),
    source: (row.source as Task["source"]) ?? "ui",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function rowToLog(row: LogRow): LogEntry {
  return {
    id: row.id,
    taskId: row.task_id,
    taskName: row.task_name,
    at: row.at,
    ok: !!row.ok,
    level: (row.level as LogEntry["level"]) ?? "info",
    message: row.message,
    detail: row.detail,
    source: (row.source as LogEntry["source"]) ?? null,
    durationMs: row.duration_ms ?? null,
  };
}

interface AccountRow extends Row {
  id: string;
  label: string | null;
  api_id: number | null;
  api_hash: string | null;
  session: string | null;
  me_json: string | null;
  phone: string | null;
  dc: number | null;
  pending_json: string | null;
  entities_json: string | null;
  last_error: string | null;
  last_connected_at: number | null;
  enabled: number;
  created_at: number;
  updated_at: number;
}

function rowToAccount(row: AccountRow): CheckinAccount {
  return {
    id: row.id,
    label: row.label ?? undefined,
    enabled: !!row.enabled,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** tick 预取的结果：到期/待删任务数 + 最早下次执行（预取本身只花 1 条查询）。 */
export interface TickPrefetch {
  dueCount: number;
  deletionCount: number;
  earliestNextRun: number | null;
}

/**
 * D1 查询用量是否超过预算的 80%（45 条预算对应 36 条）。
 * 80% 整不报，超过才报；没预算（DO 内嵌 SQLite）不报。
 */
export function queryUsageHigh(used: number, budget: number): boolean {
  if (budget <= 0) return false;
  return used > Math.floor(budget * 0.8);
}

export class Store {
  private queryCount = 0;
  private settingsMemo: Settings | null = null;
  private tasksMemo: Task[] | null = null;
  /**
   * kv 读缓存：Store 实例生命周期内有效，setAccountId 时清空。
   * D1 版每个请求新建 Store，约等于单次请求内有效；DO 版 Store 随 DO 常驻，
   * 缓存会跨请求存在，直到 setAccountId 或写操作让它失效——这没问题，
   * 因为同一个 Store 之外没人写 kv（直接删 kv 表的路径会手动清掉它，见 deleteTask）。
   * 同一轮 tick 里设置/lastPoll/游标/digest 会被反复读，各读各的要好几条查询；
   * 读到内存后后面都走内存。setKv/deleteKv 会同步更新它，写完即读到新值。
   * 值是 null 表示“查过，不存在”，避免对不存在的 key 反复查库。
   */
  private kvMemo = new Map<string, string | null>();
  /**
   * 待删消息快照（dueDeletions / nextDeletionAt 共用）：DO 实例常驻期间只读一次，
   * addDeletion / deleteDeletion 后失效。表本身很小（同时待删的只有几条），
   * 全量读进内存比每次按 due_at 查更省事；D1 版每个请求新建 Store，约等于单次请求内有效。
   */
  private deletionsMemo: Array<{ id: number; chat: string; msgIds: number[]; dueAt: number }> | null = null;
  /**
   * 当前账号的 accounts 行缓存（D1 多账号模式）。
   * 同一个请求里 session / api_id / api_hash 等字段会被反复读（shouldPoll 检查、
   * requireCredentials、afterUse），各读各的要 3、4 条查询；整行一次取齐后
   * 后面都走内存。只读不写——写字段走 setAccountField 时失效，下次再读重新查。
   */
  private accountRowMemo: { id: string; row: AccountRow } | null = null;
  /** 日志裁剪（addLog 里的 DELETE）上次跑的时间：同一 Store 实例一小时内只跑一次。 */
  private lastLogPruneAt = 0;

  constructor(
    private readonly backend: SqlBackend,
    private accountId = "",
  ) {}

  /** 当前账号（空字符串 = DO 单账号遗留模式）。 */
  getAccountId(): string {
    return this.accountId;
  }

  /** 切换账号（tick 循环账号时用；清掉按账号记忆化的缓存）。 */
  setAccountId(accountId: string): void {
    if (this.accountId === accountId) return;
    this.accountId = accountId;
    this.settingsMemo = null;
    this.tasksMemo = null;
    this.deletionsMemo = null;
    this.accountRowMemo = null;
    this.kvMemo.clear();
  }

  /**
   * 快照里原地更新一个任务（写库成功后调）：命中时不清空快照，下次读直接走内存。
   * recordRun / setTaskNextRun / updateTask 共用；createTask / deleteTask / renameGroup
   * 会改变行数或顺序，仍走“清空快照、下次重读”（低频操作，重读一次无妨）。
   */
  private patchTasksMemo(id: number, patch: Partial<Task>): void {
    if (!this.tasksMemo) return;
    const index = this.tasksMemo.findIndex((task) => task.id === id);
    if (index >= 0) this.tasksMemo[index] = { ...this.tasksMemo[index], ...patch };
  }

  /**
   * 是否有查询预算（D1 有 45 条熔断；DO 内嵌 SQLite 无此限制）。
   * D1 专属的优化（tick 预取、日志缓冲的预算收手）以它为开关；
   * 日志批量写、lastEvent 延迟写、裁剪节流自 0.27.0 起 DO 与 D1 一致，不再以它区分。
   */
  hasQueryBudget(): boolean {
    return this.backend.queryBudget !== undefined;
  }

  /** kv key 的账号前缀（accountId 为空时不加前缀，兼容 DO 旧数据）。 */
  private key(key: string): string {
    return this.accountId ? `acct:${this.accountId}:${key}` : key;
  }

  private bump(count = 1): void {
    const budget = this.backend.queryBudget;
    if (budget === undefined) return; // DO 内嵌 SQLite 无查询上限
    this.queryCount += count;
    if (this.queryCount > budget) {
      throw new Error(`D1 查询预算将超（${budget}/50），请调小 limit`);
    }
  }

  /** 本次调用还剩多少查询预算（D1 有 45 条上限；DO 无上限返回 Infinity）。tick / 轮询用它提前收手，别等到超了才报错。 */
  remainingBudget(): number {
    const budget = this.backend.queryBudget;
    if (budget === undefined) return Infinity;
    return Math.max(0, budget - this.queryCount);
  }

  /** 本次调用已用的查询数（D1 有预算时才计数；DO 无上限恒为 0）。tick 返回里带给调用方。 */
  queryCountUsed(): number {
    return this.queryCount;
  }

  /** 本次调用的查询预算（D1 是 45；DO 无上限返回 undefined）。 */
  queryBudgetLimit(): number | undefined {
    return this.backend.queryBudget;
  }

  /** 统一的行查询。 */
  private async rows<T>(query: string, ...bindings: unknown[]): Promise<T[]> {
    this.bump();
    return this.backend.exec<T>(query, ...bindings);
  }

  private async write(sql: string, ...bindings: unknown[]): Promise<void> {
    this.bump();
    await this.backend.run(sql, ...bindings);
  }

  // ---------- 账号 ----------
  async listAccounts(): Promise<CheckinAccount[]> {
    if (!this.backend.multiAccount) {
      // DO 单账号：没有 accounts 表，返回一个合成账号
      return [{ id: "", label: "", enabled: true, createdAt: 0, updatedAt: 0 }];
    }
    this.bump();
    const rows = await this.backend.exec<AccountRow>("SELECT * FROM accounts ORDER BY id");
    return rows.map(rowToAccount);
  }

  async getAccount(id: string): Promise<CheckinAccount | null> {
    if (!this.backend.multiAccount) {
      return id === "" ? { id: "", label: "", enabled: true, createdAt: 0, updatedAt: 0 } : null;
    }
    const rows = await this.rows<AccountRow>("SELECT * FROM accounts WHERE id = ?", id);
    return rows.length ? rowToAccount(rows[0]) : null;
  }

  async createAccount(id: string, label: string | undefined, now: number): Promise<CheckinAccount> {
    if (!this.backend.multiAccount) throw new Error("当前部署不支持多账号");
    await this.write(
      "INSERT INTO accounts (id, label, enabled, created_at, updated_at) VALUES (?, ?, 1, ?, ?)",
      id,
      label ?? null,
      now,
      now,
    );
    const account = await this.getAccount(id);
    if (!account) throw new Error("创建账号失败");
    return account;
  }

  async setAccountEnabled(id: string, enabled: boolean, now: number): Promise<CheckinAccount | null> {
    if (!this.backend.multiAccount) throw new Error("当前部署不支持多账号");
    await this.write("UPDATE accounts SET enabled = ?, updated_at = ? WHERE id = ?", enabled ? 1 : 0, now, id);
    return this.getAccount(id);
  }

  /** 账号会话类字段（api_id / api_hash / session / me / phone / dc / pending / entities / lastError / lastConnectedAt）。D1 版读 accounts 表；DO 版（单账号）读旧 kv，兼容老数据。 */
  async getAccountField(id: string, field: string): Promise<string | null> {
    const allowed = new Set([
      "api_id",
      "api_hash",
      "session",
      "me_json",
      "phone",
      "dc",
      "pending_json",
      "entities_json",
      "last_error",
      "last_connected_at",
    ]);
    if (!allowed.has(field)) throw new Error("未知账号字段");
    if (!this.backend.multiAccount) {
      if (id !== "") return null;
      return this.getAccountFieldLegacy(field);
    }
    // 整行一次取齐并记忆化：同一请求里多个字段各读一次要好几条查询，走内存后只剩首条。
    if (!this.accountRowMemo || this.accountRowMemo.id !== id) {
      const rows = await this.rows<AccountRow>("SELECT * FROM accounts WHERE id = ?", id);
      if (!rows.length) return null;
      this.accountRowMemo = { id, row: rows[0] };
    }
    const value = this.accountRowMemo.row[field as keyof AccountRow];
    if (value === null || value === undefined) return null;
    return String(value);
  }

  /** DO 单账号：会话类字段存在旧 kv 里（key 见 agent.ts 的 KV_* 常量）。 */
  private async getAccountFieldLegacy(field: string): Promise<string | null> {
    switch (field) {
      case "session":
        return this.getKv("account:session");
      case "me_json":
        return this.getKv("account:me");
      case "phone":
        return this.getKv("account:phone");
      case "dc":
        return this.getKv("account:dc");
      case "pending_json":
        return this.getKv("account:pending");
      case "entities_json":
        return this.getKv("entities:cache");
      case "last_error":
        return this.getKv("account:lastError");
      case "last_connected_at":
        return this.getKv("connection:lastOkAt");
      case "api_id": {
        const creds = await this.getJson<{ apiId: number | null; apiHash: string }>("account:creds", { apiId: null, apiHash: "" });
        return creds.apiId === null ? null : String(creds.apiId);
      }
      case "api_hash": {
        const creds = await this.getJson<{ apiId: number | null; apiHash: string }>("account:creds", { apiId: null, apiHash: "" });
        return creds.apiHash || null;
      }
      default:
        return null;
    }
  }

  async setAccountField(id: string, field: string, value: string | number | null, now: number): Promise<void> {
    const allowed = new Set([
      "api_id",
      "api_hash",
      "session",
      "me_json",
      "phone",
      "dc",
      "pending_json",
      "entities_json",
      "last_error",
      "last_connected_at",
    ]);
    if (!allowed.has(field)) throw new Error("未知账号字段");
    if (!this.backend.multiAccount) {
      if (id !== "") throw new Error("当前部署不支持多账号");
      await this.setAccountFieldLegacy(field, value);
      return;
    }
    // 值没变就别写：afterUse 每轮都写 last_error = NULL，本来就是 NULL 时白花一条查询
    if (this.accountRowMemo && this.accountRowMemo.id === id) {
      const current = this.accountRowMemo.row[field as keyof AccountRow];
      const currentStr = current === null || current === undefined ? null : String(current);
      const nextStr = value === null || value === undefined ? null : String(value);
      if (currentStr === nextStr) return;
    }
    await this.write(`UPDATE accounts SET ${field} = ?, updated_at = ? WHERE id = ?`, value, now, id);
    // 写完失效：同一请求里后读到的必须是新值
    if (this.accountRowMemo && this.accountRowMemo.id === id) this.accountRowMemo = null;
  }

  /** DO 单账号：会话类字段写回旧 kv。 */
  private async setAccountFieldLegacy(field: string, value: string | number | null): Promise<void> {
    const str = value === null || value === undefined ? null : String(value);
    switch (field) {
      case "session":
        if (str === null) await this.deleteKv("account:session");
        else await this.setKv("account:session", str);
        return;
      case "me_json":
        if (str === null) await this.deleteKv("account:me");
        else await this.setKv("account:me", str);
        return;
      case "phone":
        if (str === null) await this.deleteKv("account:phone");
        else await this.setKv("account:phone", str);
        return;
      case "dc":
        if (str === null) await this.deleteKv("account:dc");
        else await this.setKv("account:dc", str);
        return;
      case "pending_json":
        if (str === null) await this.deleteKv("account:pending");
        else await this.setKv("account:pending", str);
        return;
      case "entities_json":
        if (str === null) await this.deleteKv("entities:cache");
        else await this.setKv("entities:cache", str);
        return;
      case "last_error":
        if (str === null) await this.deleteKv("account:lastError");
        else await this.setKv("account:lastError", str);
        return;
      case "last_connected_at":
        if (str === null) await this.deleteKv("connection:lastOkAt");
        else await this.setKv("connection:lastOkAt", str);
        return;
      case "api_id":
      case "api_hash": {
        const creds = await this.getJson<{ apiId: number | null; apiHash: string }>("account:creds", { apiId: null, apiHash: "" });
        if (field === "api_id") creds.apiId = str === null ? null : Number(str);
        else creds.apiHash = str ?? "";
        await this.setJson("account:creds", creds);
        return;
      }
    }
  }

  // ---------- kv ----------
  async getKv(key: string): Promise<string | null> {
    const full = this.key(key);
    if (this.kvMemo.has(full)) return this.kvMemo.get(full) ?? null;
    const rows = await this.rows<{ value: string }>("SELECT value FROM kv WHERE key = ?", full);
    const value = rows.length ? rows[0].value : null;
    this.kvMemo.set(full, value);
    return value;
  }

  async setKv(key: string, value: string): Promise<void> {
    await this.write(
      "INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      this.key(key),
      value,
    );
    this.kvMemo.set(this.key(key), value);
  }

  /**
   * 多个 kv 一条语句写完（INSERT…VALUES 多行 + ON CONFLICT 更新）。
   * 轮询收尾时 lastPoll + 游标 + lastEvent 一起写，1 条查询顶原来 3 条。
   * 写完同步更新 kvMemo。entries 为空时不发查询。
   */
  async setKvMany(entries: Array<{ key: string; value: string }>): Promise<void> {
    if (!entries.length) return;
    const placeholders = entries.map(() => "(?, ?)").join(", ");
    const params: unknown[] = [];
    for (const entry of entries) {
      params.push(this.key(entry.key), entry.value);
    }
    await this.write(
      `INSERT INTO kv (key, value) VALUES ${placeholders} ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      ...params,
    );
    for (const entry of entries) this.kvMemo.set(this.key(entry.key), entry.value);
  }

  async deleteKv(key: string): Promise<void> {
    await this.write("DELETE FROM kv WHERE key = ?", this.key(key));
    this.kvMemo.delete(this.key(key));
  }

  async getJson<T>(key: string, fallback: T): Promise<T> {
    const raw = await this.getKv(key);
    return raw ? parseJson<T>(raw, fallback) : fallback;
  }

  async setJson(key: string, value: unknown): Promise<void> {
    await this.setKv(key, JSON.stringify(value));
  }

  // ---------- settings ----------
  async getSettings(): Promise<Settings> {
    if (this.settingsMemo) return this.settingsMemo;
    const settings = { ...DEFAULT_SETTINGS, ...(await this.getJson<Partial<Settings>>("settings", {})) };
    this.settingsMemo = settings;
    return settings;
  }

  async saveSettings(patch: Partial<Settings>): Promise<Settings> {
    const next = { ...(await this.getSettings()), ...patch };
    await this.setJson("settings", next);
    this.settingsMemo = next;
    return next;
  }

  // ---------- tasks ----------
  async listTasks(): Promise<Task[]> {
    if (this.tasksMemo) return this.tasksMemo;
    const tasks = (
      await this.rows<TaskRow>("SELECT * FROM tasks WHERE account_id = ? ORDER BY enabled DESC, next_run_at ASC, id ASC", this.accountId)
    ).map(rowToTask);
    this.tasksMemo = tasks;
    return tasks;
  }

  async getTask(id: number): Promise<Task | null> {
    // 快照已加载时直接走内存（DO 实例常驻期间有效；D1 每请求新建 Store，约等于单次请求内有效）
    if (this.tasksMemo) return this.tasksMemo.find((task) => task.id === id) ?? null;
    const rows = await this.rows<TaskRow>("SELECT * FROM tasks WHERE account_id = ? AND id = ?", this.accountId, id);
    return rows.length ? rowToTask(rows[0]) : null;
  }

  async findTask(query: string): Promise<Task | null> {
    const trimmed = query.trim();
    if (!trimmed) return null;
    const numeric = Number(trimmed);
    if (Number.isInteger(numeric) && numeric > 0) {
      const byId = await this.getTask(numeric);
      if (byId) return byId;
    }
    // LIKE 里的 % / _ 要转义，否则「删除 %」这类输入会一次匹配到不相干的任务
    const escaped = trimmed.replace(/[\\%_]/g, (char) => `\\${char}`);
    const rows = await this.rows<TaskRow>(
      "SELECT * FROM tasks WHERE account_id = ? AND name LIKE ? ESCAPE '\\' ORDER BY id ASC LIMIT 1",
      this.accountId,
      `%${escaped}%`,
    );
    return rows.length ? rowToTask(rows[0]) : null;
  }

  /**
   * 找「同一个目标 + 同样的调度 + 同样的动作」的任务。
   * 用于阻止同一条触发配置被发多次、或反复点保存造成的重复任务（到点会连着发好几条）。
   */
  async findDuplicateTask(input: TaskInput): Promise<Task | null> {
    const fingerprint = taskFingerprint(input);
    if (!fingerprint) return null;
    for (const task of await this.listTasks()) {
      if (taskFingerprint(task) !== fingerprint) continue;
      // 名字不同视为"有意为之"（比如同一动作跑到不同话题/不同备注），不拦
      if (task.name !== input.name) continue;
      return task;
    }
    return null;
  }

  async createTask(input: TaskInput, now: number, nextRunAt: number | null): Promise<Task> {
    const rows = await this.rows<TaskRow>(
      `INSERT INTO tasks (account_id, name, name_auto, enabled, target, targets, thread_id, schedule, steps, success_keywords,
         timeout_seconds, step_delay_seconds, delete_after_seconds, cleanup_previous, group_name, next_run_at,
         last_run_at, last_result, last_message, renewal, source, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       RETURNING *`,
      this.accountId,
      input.name,
      input.nameAuto === undefined ? null : input.nameAuto ? 1 : 0,
      input.enabled ? 1 : 0,
      JSON.stringify(input.target),
      input.targets && input.targets.length > 1 ? JSON.stringify(input.targets) : null,
      input.threadId ?? null,
      JSON.stringify(input.schedule),
      JSON.stringify(input.steps),
      JSON.stringify(input.successKeywords ?? []),
      input.timeoutSeconds ?? 25,
      input.stepDelaySeconds ?? 1,
      input.deleteAfterSeconds ?? 0,
      input.cleanupPrevious ? 1 : 0,
      input.group ?? null,
      nextRunAt,
      input.lastRunAt ?? null,
      input.lastResult ?? null,
      input.lastMessage ?? null,
      input.renewal ? JSON.stringify(input.renewal) : null,
      input.source ?? "ui",
      now,
      now,
    );
    this.tasksMemo = null;
    if (!rows.length) throw new Error("创建任务失败");
    return rowToTask(rows[0]);
  }

  async updateTask(id: number, patch: Partial<TaskInput>, now: number): Promise<Task | null> {
    const current = await this.getTask(id);
    if (!current) return null;
    const merged: Task = {
      ...current,
      ...patch,
      id: current.id,
      createdAt: current.createdAt,
      updatedAt: now,
    } as Task;

    await this.write(
      `UPDATE tasks SET name = ?, name_auto = ?, enabled = ?, target = ?, targets = ?, thread_id = ?, schedule = ?, steps = ?,
         success_keywords = ?, timeout_seconds = ?, step_delay_seconds = ?, delete_after_seconds = ?,
         cleanup_previous = ?, group_name = ?, next_run_at = ?, last_run_at = ?, last_result = ?, last_message = ?,
         last_detail = ?, renewal = ?, updated_at = ?
       WHERE account_id = ? AND id = ?`,
      merged.name,
      merged.nameAuto === undefined ? null : merged.nameAuto ? 1 : 0,
      merged.enabled ? 1 : 0,
      JSON.stringify(merged.target),
      merged.targets && merged.targets.length > 1 ? JSON.stringify(merged.targets) : null,
      merged.threadId ?? null,
      JSON.stringify(merged.schedule),
      JSON.stringify(merged.steps),
      JSON.stringify(merged.successKeywords ?? []),
      merged.timeoutSeconds ?? 25,
      merged.stepDelaySeconds ?? 1,
      merged.deleteAfterSeconds ?? 0,
      merged.cleanupPrevious ? 1 : 0,
      merged.group ?? null,
      merged.nextRunAt ?? null,
      merged.lastRunAt ?? null,
      merged.lastResult ?? null,
      merged.lastMessage ?? null,
      merged.lastDetail ?? null,
      merged.renewal ? JSON.stringify(merged.renewal) : null,
      now,
      this.accountId,
      id,
    );
    // 快照已加载时把合并后的任务原地写回去，不再重读（写进去的就是刚落库的值）
    if (this.tasksMemo) {
      this.patchTasksMemo(id, merged);
      return merged;
    }
    return this.getTask(id);
  }

  /**
   * 把某个分组下的任务整体改名（`from` 为空字符串表示「未分组」）。
   * 返回被改动的任务数。
   */
  async renameGroup(from: string, to: string, now: number): Promise<number> {
    const normalize = (value: string) => (value ?? "").trim();
    const target = normalize(from);
    const next = normalize(to);
    const rows = await this.rows<{ id: number; group_name: string | null }>(
      "SELECT id, group_name FROM tasks WHERE account_id = ?",
      this.accountId,
    );
    const ids = rows.filter((row) => normalize(row.group_name ?? "") === target).map((row) => row.id);
    for (const id of ids) {
      await this.write("UPDATE tasks SET group_name = ?, updated_at = ? WHERE account_id = ? AND id = ?", next || null, now, this.accountId, id);
    }
    if (ids.length) this.tasksMemo = null;
    return ids.length;
  }

  async setTaskNextRun(id: number, nextRunAt: number | null): Promise<void> {
    await this.write("UPDATE tasks SET next_run_at = ? WHERE account_id = ? AND id = ?", nextRunAt, this.accountId, id);
    this.patchTasksMemo(id, { nextRunAt });
  }

  async recordRun(
    id: number,
    result: "ok" | "fail",
    message: string,
    detail: string | null,
    now: number,
    source: "auto" | "manual" = "auto",
  ): Promise<void> {
    // 旧值只认两个来源：快照里有就用快照的，没有就读一次库；绝不用 ?? 0 兜底——
    // 快照未加载时旧值可能是 2、3……，捏造成 0 再 +1 会把 memo 里的 failStreak 写成 1，
    // 连续失败计数被重置，自动暂停阈值（3 次）最多晚 2 次才触发。
    // 快照已加载时不额外查库；快照未加载时多 1 条 SELECT（D1 每请求新建 Store 也如此）。
    const memoStreak = this.tasksMemo?.find((task) => task.id === id)?.failStreak;
    const prevStreak = memoStreak ?? (await this.readFailStreak(id));
    await this.write(
      `UPDATE tasks SET last_run_at = ?, last_result = ?, last_run_source = ?, last_message = ?, last_detail = ?,
         fail_streak = CASE WHEN ? = 'ok' THEN 0 ELSE fail_streak + 1 END, updated_at = ?
       WHERE account_id = ? AND id = ?`,
      now,
      result,
      source,
      message,
      detail,
      result,
      now,
      this.accountId,
      id,
    );
    // fail_streak 的新值就是 SQL 里 CASE 算出来的，不再读一次
    this.patchTasksMemo(id, {
      lastRunAt: now,
      lastResult: result,
      lastRunSource: source,
      lastMessage: message,
      lastDetail: detail,
      failStreak: result === "ok" ? 0 : prevStreak + 1,
      updatedAt: now,
    });
  }

  /** 直接读库拿 fail_streak（不走快照）：recordRun 在快照缺失时用它拿旧值。 */
  private async readFailStreak(id: number): Promise<number> {
    const rows = await this.rows<{ fail_streak: number | null }>(
      "SELECT fail_streak FROM tasks WHERE account_id = ? AND id = ?",
      this.accountId,
      id,
    );
    return rows.length ? Number(rows[0].fail_streak ?? 0) : 0;
  }

  async failStreakOf(id: number): Promise<number> {
    if (this.tasksMemo) return this.tasksMemo.find((task) => task.id === id)?.failStreak ?? 0;
    return this.readFailStreak(id);
  }

  async deleteTask(id: number): Promise<void> {
    await this.write("DELETE FROM tasks WHERE account_id = ? AND id = ?", this.accountId, id);
    await this.write("DELETE FROM logs WHERE account_id = ? AND task_id = ?", this.accountId, id);
    await this.deleteKv(`task:${id}:sent`);
    // 多目标时按目标分键存过 sent，还有各类通知的节流时间，一并清掉。
    // 通知节流的 key 形如 notify:<事件>:<任务 id>:at（见 agent.ts 的 notifyEvent）。
    await this.write("DELETE FROM kv WHERE key LIKE ?", `${this.key(`task:${id}:sent:`)}%`);
    await this.write("DELETE FROM kv WHERE key LIKE ?", `${this.key(`notify:`)}%:${id}:at`);
    await this.deleteKv(`live:${id}`);
    // 续费同日保护与最近一次跑的完整回复（汇总推送用）也随任务走
    await this.deleteKv(`renew:${id}`);
    await this.deleteKv(`run:${id}:outcome`);
    this.tasksMemo = null;
    // 上面两条 LIKE 删除绕过了 setKv/deleteKv，kvMemo 里可能还留着已删的 key，清掉防读到脏值
    this.kvMemo.clear();
  }

  /**
   * tick 检查阶段一次预取（D1 专属，DO 返回 null 走原来逐条读）。
   * 一条 SELECT 取齐：accounts 整行 + 设置/lastPoll/游标/digest/greeted（kv IN 一次取 5 个）
   * + 到期任务数 + 待删数 + 最早下次执行（三个标量子查询）。
   * 取到的值填进 accountRowMemo / settingsMemo / kvMemo，后面 getSettings / session /
   * getKv 都走内存，不再查库；没取到的 kv key 记 null（查过，不存在），同样不再查库。
   * 账号不存在时返回 null，调用方回退到逐条读。
   */
  async prefetchTickState(now: number): Promise<TickPrefetch | null> {
    if (!this.hasQueryBudget()) return null;
    const accountId = this.accountId;
    if (!accountId) return null;
    const kvKeys = [
      this.key("settings"),
      this.key("trigger:lastPoll"),
      this.key("trigger:cursor:self"),
      this.key("notify:digest:lastAt"),
      this.key("trigger:greeted:self"),
      // 下面 4 个是 tick 里各检查按需读的 key：一次取齐，后面再读都走内存，
      // 不预取的话每个检查各花 1 条（日报 00:15 的 lastSentAt 每次都读）
      this.key("report:daily:lastSentAt"),
      this.key("notify:weekly:lastAt"),
      this.key("notify:storage:lastCheckAt"),
      this.key("notify:rate:lastCheckAt"),
    ];
    const placeholders = kvKeys.map(() => "?").join(", ");
    const rows = await this.rows<{
      a_id: string;
      a_label: string | null;
      a_api_id: number | null;
      a_api_hash: string | null;
      a_session: string | null;
      a_me_json: string | null;
      a_phone: string | null;
      a_dc: number | null;
      a_pending_json: string | null;
      a_entities_json: string | null;
      a_last_error: string | null;
      a_last_connected_at: number | null;
      a_enabled: number;
      a_created_at: number;
      a_updated_at: number;
      k_key: string | null;
      k_value: string | null;
      due_count: number | null;
      deletion_count: number | null;
      earliest_next: number | null;
    }>(
      `SELECT
         a.id AS a_id, a.label AS a_label, a.api_id AS a_api_id, a.api_hash AS a_api_hash,
         a.session AS a_session, a.me_json AS a_me_json, a.phone AS a_phone, a.dc AS a_dc,
         a.pending_json AS a_pending_json, a.entities_json AS a_entities_json,
         a.last_error AS a_last_error, a.last_connected_at AS a_last_connected_at,
         a.enabled AS a_enabled, a.created_at AS a_created_at, a.updated_at AS a_updated_at,
         k.key AS k_key, k.value AS k_value,
         (SELECT COUNT(*) FROM tasks WHERE account_id = ? AND enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?) AS due_count,
         (SELECT COUNT(*) FROM deletions WHERE account_id = ? AND due_at <= ?) AS deletion_count,
         (SELECT MIN(next_run_at) FROM tasks WHERE account_id = ? AND enabled = 1 AND next_run_at IS NOT NULL) AS earliest_next
       FROM accounts a
       LEFT JOIN kv k ON k.key IN (${placeholders})
       WHERE a.id = ?`,
      accountId,
      now,
      accountId,
      now,
      accountId,
      ...kvKeys,
      accountId,
    );
    if (!rows.length) return null;
    const first = rows[0];
    this.accountRowMemo = {
      id: accountId,
      row: {
        id: first.a_id,
        label: first.a_label,
        api_id: first.a_api_id,
        api_hash: first.a_api_hash,
        session: first.a_session,
        me_json: first.a_me_json,
        phone: first.a_phone,
        dc: first.a_dc,
        pending_json: first.a_pending_json,
        entities_json: first.a_entities_json,
        last_error: first.a_last_error,
        last_connected_at: first.a_last_connected_at,
        enabled: first.a_enabled,
        created_at: first.a_created_at,
        updated_at: first.a_updated_at,
      },
    };
    const seen = new Set<string>();
    for (const row of rows) {
      if (row.k_key !== null && row.k_key !== undefined) {
        this.kvMemo.set(row.k_key, row.k_value);
        seen.add(row.k_key);
      }
    }
    for (const key of kvKeys) {
      if (!seen.has(key)) this.kvMemo.set(key, null);
    }
    const settingsRaw = this.kvMemo.get(this.key("settings"));
    this.settingsMemo = settingsRaw
      ? { ...DEFAULT_SETTINGS, ...parseJson<Partial<Settings>>(settingsRaw, {}) }
      : { ...DEFAULT_SETTINGS };
    // 游标/问候 key 跟 controlChat 走：不是 self 时上面预取的 "self" key 全错，
    // 再补一条查询把真正的 key 取进缓存（只在 controlChat 不是 self 时多花 1 条，
    // 后面 getKv 就不再查库；默认 self 不多花）。
    const controlChat = (this.settingsMemo.controlChat || "self").trim() || "self";
    if (controlChat !== "self") {
      const extraKeys = [this.key(`trigger:cursor:${controlChat}`), this.key(`trigger:greeted:${controlChat}`)];
      const extra = await this.rows<{ k_key: string; k_value: string }>(
        `SELECT key AS k_key, value AS k_value FROM kv WHERE key IN (?, ?)`,
        extraKeys[0],
        extraKeys[1],
      );
      const seenExtra = new Set<string>();
      for (const row of extra) {
        this.kvMemo.set(row.k_key, row.k_value);
        seenExtra.add(row.k_key);
      }
      for (const key of extraKeys) {
        if (!seenExtra.has(key)) this.kvMemo.set(key, null);
      }
    }
    return {
      dueCount: Number(first.due_count ?? 0),
      deletionCount: Number(first.deletion_count ?? 0),
      earliestNextRun:
        first.earliest_next === null || first.earliest_next === undefined ? null : Number(first.earliest_next),
    };
  }

  async dueTasks(now: number, limit = 20): Promise<Task[]> {
    // 冷启动时一次读全进快照（与原来按条件查同为 1 条查询），之后都在内存里筛；
    // 顺序与原来 SQL 一致（启用任务按 next_run_at 升序）。
    if (!this.tasksMemo) await this.listTasks();
    const tasks = this.tasksMemo ?? [];
    return tasks
      .filter((task) => task.enabled && task.nextRunAt !== null && task.nextRunAt !== undefined && task.nextRunAt <= now)
      .slice(0, limit);
  }

  /** 到期的任务数（tick 返回 remaining 用，只计数不取行）。 */
  async countDue(now: number): Promise<number> {
    if (this.tasksMemo) {
      return this.tasksMemo.filter(
        (task) => task.enabled && task.nextRunAt !== null && task.nextRunAt !== undefined && task.nextRunAt <= now,
      ).length;
    }
    const rows = await this.rows<{ total: number | null }>(
      "SELECT COUNT(*) AS total FROM tasks WHERE account_id = ? AND enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?",
      this.accountId,
      now,
    );
    return rows.length ? Number(rows[0].total ?? 0) : 0;
  }

  async earliestNextRun(): Promise<number | null> {
    // 冷启动时一次读全进快照（与原来 MIN 查询同为 1 条），之后都走内存
    if (!this.tasksMemo) await this.listTasks();
    const tasks = this.tasksMemo ?? [];
    let earliest: number | null = null;
    for (const task of tasks) {
      if (!task.enabled || task.nextRunAt === null || task.nextRunAt === undefined) continue;
      if (earliest === null || task.nextRunAt < earliest) earliest = task.nextRunAt;
    }
    return earliest;
  }

  /** 数据库文件大小（字节）。DO 版读 storage.databaseSize；D1 版查 PRAGMA，不放行返回 0。 */
  async databaseSize(): Promise<number> {
    if (typeof this.backend.databaseSize === "function") {
      try {
        const size = this.backend.databaseSize();
        if (typeof size === "number") return size;
      } catch {
        return 0;
      }
    }
    try {
      const rows = await this.rows<{ size: number | null }>(
        "SELECT (SELECT page_count FROM pragma_page_count()) * (SELECT page_size FROM pragma_page_size()) AS size",
      );
      return rows.length ? Number(rows[0].size ?? 0) : 0;
    } catch {
      return 0;
    }
  }

  // ---------- logs ----------

  /**
   * 日志裁剪（只保留最近 2000 条），addLog / addLogs 共用。
   * 一小时最多跑一次：原来 DO 版每次写日志都裁（INSERT + DELETE 各 1 条），
   * 一轮 tick 写好几条日志就白白多花好几条写操作，一小时一裁足够把表压在 2000 条上下；
   * D1 版沿用同一规则（查询预算同样受益）。
   */
  private async pruneLogsIfDue(): Promise<void> {
    if (Date.now() - this.lastLogPruneAt <= 3600_000) return;
    this.lastLogPruneAt = Date.now();
    await this.write(
      "DELETE FROM logs WHERE account_id = ? AND id <= (SELECT MAX(id) - 2000 FROM logs WHERE account_id = ?)",
      this.accountId,
      this.accountId,
    );
  }

  async addLog(entry: Omit<LogEntry, "id">): Promise<LogEntry> {
    const rows = await this.rows<LogRow>(
      `INSERT INTO logs (account_id, task_id, task_name, at, ok, level, message, detail, source, duration_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
      this.accountId,
      entry.taskId,
      entry.taskName,
      entry.at,
      entry.ok ? 1 : 0,
      entry.level,
      entry.message,
      entry.detail,
      entry.source ?? "system",
      entry.durationMs ?? null,
    );
    await this.pruneLogsIfDue();
    if (!rows.length) throw new Error("写日志失败");
    return rowToLog(rows[0]);
  }

  /**
   * 多条日志一次 INSERT 插多行（RETURNING * 取回 id）。
   * 轮询一轮的日志（发现 + 每条消息）攒到最后一次写完，1 条查询顶原来 N 条。
   * 超 50 行分块（SQLite 单条语句变量数上限）。裁剪节流与 addLog 共用同一规则。
   * entries 为空时不发查询，返回 []。
   */
  async addLogs(entries: Array<Omit<LogEntry, "id">>): Promise<LogEntry[]> {
    if (!entries.length) return [];
    const out: LogEntry[] = [];
    const CHUNK = 50;
    for (let i = 0; i < entries.length; i += CHUNK) {
      const chunk = entries.slice(i, i + CHUNK);
      const placeholders = chunk.map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").join(", ");
      const params: unknown[] = [];
      for (const entry of chunk) {
        params.push(
          this.accountId,
          entry.taskId,
          entry.taskName,
          entry.at,
          entry.ok ? 1 : 0,
          entry.level,
          entry.message,
          entry.detail,
          entry.source ?? "system",
          entry.durationMs ?? null,
        );
      }
      const rows = await this.rows<LogRow>(
        `INSERT INTO logs (account_id, task_id, task_name, at, ok, level, message, detail, source, duration_ms)
         VALUES ${placeholders} RETURNING *`,
        ...params,
      );
      out.push(...rows.map(rowToLog));
    }
    await this.pruneLogsIfDue();
    return out;
  }

  /**
   * 日志列表（游标分页）。
   * @param options.beforeId 只取 id 更小的（「加载更多」）—— 比 page/pageSize 稳，插入新日志不会跳行
   * @param options.level "ok"（成功）/ "fail"（失败）/ 具体 level
   */
  /** 日志筛选条件（分页 + 任务 + 级别 + 关键字） */
  private logFilter(options: LogFilter): { where: string; bindings: unknown[] } {
    const where: string[] = ["account_id = ?"];
    const bindings: unknown[] = [this.accountId];

    if (options.taskId) {
      where.push("task_id = ?");
      bindings.push(options.taskId);
    }
    if (options.beforeId) {
      where.push("id < ?");
      bindings.push(options.beforeId);
    }
    if (options.since) {
      where.push("at >= ?");
      bindings.push(options.since);
    }
    if (options.level === "ok") where.push("ok = 1");
    else if (options.level === "fail") where.push("ok = 0");
    else if (options.level) {
      where.push("level = ?");
      bindings.push(options.level);
    }
    const query = (options.query ?? "").trim();
    if (query) {
      // LIKE 通配符要转义，避免 `%` 一把梭
      const escaped = query.slice(0, 60).replace(/[\\%_]/g, (char) => `\\${char}`);
      where.push("(message LIKE ? ESCAPE '\\' OR task_name LIKE ? ESCAPE '\\')");
      bindings.push(`%${escaped}%`, `%${escaped}%`);
    }

    return { where: `WHERE ${where.join(" AND ")}`, bindings };
  }

  async listLogs(options: LogFilter = {}): Promise<LogEntry[]> {
    const limit = Math.max(1, Math.min(200, options.limit ?? 100));
    const offset = Math.max(0, Math.min(1_000_000, options.offset ?? 0));
    const { where, bindings } = this.logFilter(options);
    const sql = `SELECT * FROM logs ${where} ORDER BY id DESC LIMIT ? OFFSET ?`;
    return (await this.rows<LogRow>(sql, ...bindings, limit, offset)).map(rowToLog);
  }

  /** 当前筛选条件下的总条数（前端显示"已加载 x / 共 y"） */
  async countLogs(options: LogFilter = {}): Promise<number> {
    const { where, bindings } = this.logFilter({ ...options, beforeId: null });
    const rows = await this.rows<{ total: number | null }>(`SELECT COUNT(*) AS total FROM logs ${where}`, ...bindings);
    return rows.length ? Number(rows[0].total ?? 0) : 0;
  }

  async clearLogs(): Promise<void> {
    await this.write("DELETE FROM logs WHERE account_id = ?", this.accountId);
  }

  // ---------- 事件计数（只记事件名 + 时间，不记内容） ----------
  async recordEvent(name: string): Promise<void> {
    const at = Date.now();
    const key = name.slice(0, 40);
    // 累计总数一次 UPSERT 自增，不再先读后写（省 1 条）；写完把 kvMemo 里
    // 可能留着的旧计数值清掉，下次读重新查库，别读到脏值
    const totalKey = `event:total:${key}`;
    await this.write(
      "INSERT INTO kv (key, value) VALUES (?, '1') ON CONFLICT(key) DO UPDATE SET value = CAST(kv.value AS INTEGER) + 1",
      this.key(totalKey),
    );
    this.kvMemo.delete(this.key(totalKey));
    await this.write("INSERT INTO events (account_id, name, at) VALUES (?, ?, ?)", this.accountId, key, at);
    await this.pruneEventsIfDue(key);
  }

  /** 事件裁剪（每类只留最近 5000 条），与日志裁剪同一节流规则：一小时最多跑一次。 */
  private lastEventPruneAt = 0;
  private async pruneEventsIfDue(key: string): Promise<void> {
    if (Date.now() - this.lastEventPruneAt <= 3600_000) return;
    this.lastEventPruneAt = Date.now();
    // 每类事件只留最近 5000 条，避免无限增长
    await this.write(
      "DELETE FROM events WHERE account_id = ? AND name = ? AND id <= (SELECT MAX(id) - 5000 FROM events WHERE account_id = ? AND name = ?)",
      this.accountId,
      key,
      this.accountId,
      key,
    );
  }

  /** 一次取齐本账号全部任务的最近一次执行结果（finalize 用；1 条查询）。 */
  async listRunOutcomes(): Promise<Array<{ taskId: number; value: string }>> {
    const prefix = this.key("run:");
    const escaped = prefix.replace(/[\\%_]/g, (char) => `\\${char}`);
    const rows = await this.rows<{ key: string; value: string }>(
      "SELECT key, value FROM kv WHERE key LIKE ? ESCAPE '\\'",
      `${escaped}%:outcome`,
    );
    const out: Array<{ taskId: number; value: string }> = [];
    for (const row of rows) {
      const rest = row.key.slice(prefix.length);
      const taskId = Number(rest.slice(0, rest.indexOf(":")));
      if (Number.isInteger(taskId) && taskId > 0) out.push({ taskId, value: row.value });
    }
    return out;
  }

  /** 取某类事件在 since 之后的样本（用于趋势图） */
  async listEventSamples(prefix: string, since: number): Promise<Array<{ name: string; at: number }>> {
    return this.rows<{ name: string; at: number }>(
      "SELECT name, at FROM events WHERE account_id = ? AND name LIKE ? AND at >= ? ORDER BY at",
      this.accountId,
      `${prefix}%`,
      since,
    );
  }

  async countEvent(name: string): Promise<number> {
    // 优先用累计计数器（不受 5000 条上限影响）
    const totalKey = `event:total:${name}`;
    const stored = await this.getKv(totalKey);
    if (stored !== null && stored !== undefined) return Number(stored) || 0;

    // 老部署第一次读：用现有条数初始化计数器，再写回去，避免升级后数字突然变 0
    const rows = await this.rows<{ total: number | null }>(
      "SELECT COUNT(*) AS total FROM events WHERE account_id = ? AND name = ?",
      this.accountId,
      name,
    );
    const legacy = rows.length ? Number(rows[0].total ?? 0) : 0;
    await this.setKv(totalKey, String(legacy));
    return legacy;
  }

  async firstEventAt(name: string): Promise<number | null> {
    const rows = await this.rows<{ at: number | null }>(
      "SELECT MIN(at) AS at FROM events WHERE account_id = ? AND name = ?",
      this.accountId,
      name,
    );
    return rows.length ? rows[0].at : null;
  }

  // ---------- 登录尝试（限速） ----------
  /** 窗口内该 IP 的失败次数 */
  async countAuthFailures(ip: string, since: number): Promise<number> {
    const rows = await this.rows<{ failures: number | null }>(
      "SELECT COUNT(*) AS failures FROM auth_attempts WHERE account_id = ? AND ip = ? AND ok = 0 AND at > ?",
      this.accountId,
      ip.slice(0, 64),
      since,
    );
    return rows.length ? Number(rows[0].failures ?? 0) : 0;
  }

  /** 记录一次登录失败，返回窗口内累计失败次数 */
  async recordAuthAttempt(ip: string, ok: boolean, at: number): Promise<number> {
    await this.write(
      "INSERT INTO auth_attempts (account_id, ip, at, ok) VALUES (?, ?, ?, ?)",
      this.accountId,
      ip.slice(0, 64),
      at,
      ok ? 1 : 0,
    );
    await this.write("DELETE FROM auth_attempts WHERE account_id = ? AND at < ?", this.accountId, at - 24 * 3600_000);
    return this.countAuthFailures(ip, at - 10 * 60_000);
  }

  async clearAuthAttempts(ip: string): Promise<void> {
    await this.write("DELETE FROM auth_attempts WHERE account_id = ? AND ip = ?", this.accountId, ip.slice(0, 64));
  }

  // ---------- 待删除消息（延迟删除） ----------
  /** 待删消息全量快照（表很小，同时待删的只有几条）：首次加载一次读全，之后走内存。 */
  private async loadDeletions(): Promise<Array<{ id: number; chat: string; msgIds: number[]; dueAt: number }>> {
    if (!this.deletionsMemo) {
      const rows = await this.rows<{ id: number; chat: string; msg_ids: string; due_at: number }>(
        "SELECT * FROM deletions WHERE account_id = ?",
        this.accountId,
      );
      this.deletionsMemo = rows.map((row) => ({ id: row.id, chat: row.chat, msgIds: parseJson<number[]>(row.msg_ids, []), dueAt: row.due_at }));
    }
    return this.deletionsMemo;
  }

  async addDeletion(chat: string, msgIds: number[], dueAt: number): Promise<void> {
    if (!msgIds.length) return;
    await this.write(
      "INSERT INTO deletions (account_id, chat, msg_ids, due_at) VALUES (?, ?, ?, ?)",
      this.accountId,
      chat,
      JSON.stringify(msgIds),
      dueAt,
    );
    // 新行没有 id（自增），快照没法原地补，直接失效、下次重读
    this.deletionsMemo = null;
  }

  async dueDeletions(now: number): Promise<Array<{ id: number; chat: string; msgIds: number[] }>> {
    const all = await this.loadDeletions();
    return all
      .filter((row) => row.dueAt <= now)
      .slice(0, 20)
      .map((row) => ({ id: row.id, chat: row.chat, msgIds: row.msgIds }));
  }

  async nextDeletionAt(): Promise<number | null> {
    const all = await this.loadDeletions();
    let next: number | null = null;
    for (const row of all) {
      if (next === null || row.dueAt < next) next = row.dueAt;
    }
    return next;
  }

  async deleteDeletion(id: number): Promise<void> {
    await this.write("DELETE FROM deletions WHERE account_id = ? AND id = ?", this.accountId, id);
    this.deletionsMemo = null;
  }
}
