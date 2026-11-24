# D1 备份与恢复

D1 是单点：库坏了、误删了，没有兜底。这份备份就是兜底 —— 每天一次，
把任务 / 账号 / 设置 / 续费配置导出成 JSON，存到全屋备份里。

## 备份里有什么、没有什么

`GET /api/backup`（机器认证 `x-admin-password`，或登录 Cookie）返回：

```jsonc
{
  "format": "cf-tg-checkin.d1-backup",
  "version": 1,
  "exportedAt": 1764020000000,
  "accounts": [
    {
      "id": "yanneo20",
      "label": "大号",
      "enabled": true,
      "settings": { /* 脱敏后的设置 */ },
      "tasks": [ /* TaskInput 数组，含 renewal 续费配置 */ ]
    }
  ]
}
```

**有的**：全部账号的任务（含步骤、调度、分组、续费阈值）、设置（时区、轮询、
触发、日报、续费开关等非敏感项）、账号 id / 展示名 / 启用状态。

**没有的（故意不备份，恢复时另行填入）**：

| 不备份 | 原因 / 恢复时怎么办 |
| --- | --- |
| `apiId` / `apiHash` / `session` | Telegram 登录凭证。恢复后在管理界面重新登录账号（收一次验证码） |
| 管理员口令（`ADMIN_PASSWORD`） | Worker 密钥，`wrangler secret put ADMIN_PASSWORD` 重设 |
| Turnstile Secret、Webhook 加签密钥 | 备份里只留 `turnstileSecretConfigured` / `notifyWebhookSecretConfigured` 布尔标记；在设置页重新填 |
| Webhook 地址、管理员 ID | 地址里带机器人 Token、ID 是个人标识；备份里只留 `notifyWebhookConfigured` / `adminUserIdConfigured` 标记；在设置页重新填 |
| 执行日志、汇总、触发游标 | 运行态数据，恢复后从零开始记；不影响任务本身 |

备份文件本身不含任何敏感值，可以放心进全屋备份（R2 + GitHub 私有库）。

## 每日备份（定时任务）

Muse 定时任务 `cf-tg-checkin-d1-backup` 每天 02:00（北京时间）跑一次：

1. 口令从 `~/.config/cf-tg-checkin-d1/admin-password`（600 权限）读，不打印、不落盘；
2. `curl -s -H "x-admin-password: <口令>" https://cf-tg-checkin-d1.yanneo2003.workers.dev/api/backup`
   存到 `~/workspace/cf-tg-checkin-backups/d1-backup.json`（每天覆盖同一个文件）；
3. 校验 JSON 能解析、`format` 是 `cf-tg-checkin.d1-backup`、且不含 `apiHash` / `session` 字样。

存档靠现有的全屋备份：R2 每天打包 whole-home（7 天保留）、GitHub 私有库
`Yan2Zai/muse-backup` 按文件推送（只推变化）。成功时静默，只有失败才汇报。

任务配置很少变，每天一次足够；改了配置想立刻备份，手动调一次上面第 2 步即可。

## 从备份恢复到 D1（具体操作）

前提：D1 库还在（Worker 能起来）。如果整个 Worker / D1 都没了，先按
`docs/DEPLOY.md` 重建 Worker 与 D1 绑定、跑一遍迁移，再按下面恢复。

**1. 取备份文件**：从 `~/workspace/cf-tg-checkin-backups/d1-backup.json`
取最新一份（或从 R2 / GitHub 历史里取某一天的）。

**2. 建账号并重新登录**（每个账号都要做，凭证不备份）：

- 管理界面 → 账号 → 新建账号，id 填备份里的 `id`（必须一致，否则任务落不到对应账号）；
- 按界面登录向导走完 Telegram 登录（填 `apiId` / `apiHash`、收验证码）。

**3. 恢复设置**（每个账号）：

```bash
# 先登录管理界面拿到 Cookie（浏览器里登录一次即可），再调：
curl -s -X POST "https://cf-tg-checkin-d1.yanneo2003.workers.dev/api/settings?account=<账号 id>" \
  -H "content-type: application/json" -H "cookie: <登录 Cookie>" \
  -d '<备份里该账号的 settings 对象>'
```

备份里的 `settings` 已经是脱敏后的安全子集（敏感字段已删，只剩 `*Configured`
标记），直接提交不会覆盖掉任何密钥；提交后在设置页把 Webhook 地址、
管理员 ID、Turnstile Secret、加签密钥按需重新填上。

**4. 恢复任务**（每个账号）：

```bash
curl -s -X POST "https://cf-tg-checkin-d1.yanneo2003.workers.dev/api/tasks/import?account=<账号 id>" \
  -H "content-type: application/json" -H "cookie: <登录 Cookie>" \
  -d '{"tasks": <备份里该账号的 tasks 数组>}'
```

返回 `created` 是新建数；`skipped` 是已存在相同任务（指纹相同）的跳过数。
导入后在任务页核对数量与续费配置（`renewal` 在备份里是完整的）。

**5. 核对**：任务页两个账号的任务数与备份一致；调一次
`POST /api/tick?limit=1`（机器认证）确认能跑；当晚 00:00 正常签到即恢复完成。

## 健康盯守（同一个口令，另一个定时任务）

Muse 定时任务 `cf-tg-checkin-health-watch` 每天 01:00（北京时间，00:00 那轮
tick 之后）跑一次，只做两件事：

1. `GET /api/version`（明文版与混淆版各一次）返回 200，且版本号与
   `~/workspace/cf-tg-checkin-test/package.json` 一致；
2. `GET /api/run-summary`（机器认证）里 `summary.date` 是今天（北京时间
   `YYYY-MM-DD`），且 `results` 非空 —— 说明 00:00 那轮 tick 成功跑过。
   `date` 还是昨天，说明上次成功 tick 距今已超 25 小时。

成功时静默不打扰，只有失败 / 过期才汇报。每天一次，一天只唤醒一次，
不做每 30 分钟轮询。
