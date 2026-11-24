-- cf-tg-checkin D1 版初始建表（设计文档 §5）。
-- 一个库服务全部账号；accounts 表一行 = 一个 TG 账号。
-- 与 DO 版 schema 对应：kv / tasks / logs / events / auth_attempts / deletions 原样保留，
-- tasks 等五张表加 account_id 列；accounts 与 locks 是新增的。

-- 账号（一行 = 一个 TG 账号；替代原来每个部署各一份的 kv 会话）
CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  label TEXT,
  api_id INTEGER,
  api_hash TEXT,
  session TEXT,
  me_json TEXT,
  phone TEXT,
  dc INTEGER,
  pending_json TEXT,
  entities_json TEXT,
  last_error TEXT,
  last_connected_at INTEGER,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- 通用 kv（原 DO 的 kv 表原样保留；所有 key 按账号加前缀，见设计 §5.2）
CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- 任务（原表 + account_id；其余列与原 SCHEMA 一字不改）
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL REFERENCES accounts(id),
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
  step_delay_seconds INTEGER NOT NULL DEFAULT 3,
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
);
CREATE INDEX IF NOT EXISTS idx_tasks_account_next ON tasks(account_id, enabled, next_run_at);
CREATE INDEX IF NOT EXISTS idx_tasks_account ON tasks(account_id, id);

-- 日志（原表 + account_id；2000 条上限保留）
CREATE TABLE IF NOT EXISTS logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT REFERENCES accounts(id),
  task_id INTEGER,
  task_name TEXT,
  at INTEGER NOT NULL,
  ok INTEGER NOT NULL,
  level TEXT NOT NULL,
  message TEXT NOT NULL,
  detail TEXT,
  source TEXT,
  duration_ms INTEGER
);
CREATE INDEX IF NOT EXISTS idx_logs_account_at ON logs(account_id, at DESC);

-- 事件计数（原表 + account_id）
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT REFERENCES accounts(id),
  name TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_account_name ON events(account_id, name, at);

-- 登录尝试（原表 + account_id；限速按 IP + 账号算）
CREATE TABLE IF NOT EXISTS auth_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT REFERENCES accounts(id),
  ip TEXT NOT NULL,
  at INTEGER NOT NULL,
  ok INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_auth_account_at ON auth_attempts(account_id, at);

-- 待删除消息（原表 + account_id）
CREATE TABLE IF NOT EXISTS deletions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT REFERENCES accounts(id),
  chat TEXT NOT NULL,
  msg_ids TEXT NOT NULL,
  due_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_deletions_account_due ON deletions(account_id, due_at);

-- 租约锁（替代 serialize()，见设计 §7）
CREATE TABLE IF NOT EXISTS locks (
  name TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
