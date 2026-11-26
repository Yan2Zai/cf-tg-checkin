/**
 * AgentService —— 账号无关的业务逻辑层（D1 版与 DO 版共用）。
 *  1. 持有 Telegram session（D1 版存在 D1 的 accounts 表，DO 版存在 DO 内嵌 SQLite）
 *  2. 执行签到动作（发消息 / 点按钮 / 判定成功）
 *  3. 轮询控制会话里的触发消息（收藏夹发 `9.30 签到` 即可建任务）
 *  4. 给管理界面提供 JSON API
 * 调度不在这一层：D1 版由外部定时任务调 POST /api/tick，DO 版由 TgAgent 的 alarm() 驱动。
 * DO 版的 Store 带记忆化缓存（设置/任务/kv/待删消息），随 DO 实例常驻、跨请求有效，
 * 驱逐后下次请求重新从 SQLite 加载（可重建的缓存，不是事实来源）；
 * 正确性关键的写（任务状态、续费标记）即时落库，日志/lastEvent 类攒批后写。
 * D1 版每个请求新建 Store，缓存约等于单次请求内有效。
 */
import { Api } from "teleproto";
import { password as PasswordModule } from "teleproto";
import type { TelegramClient } from "teleproto";
import { Store, queryUsageHigh } from "./db";
import { DoBackend } from "./d1/backend";
import type { ExecLock } from "./d1/lock";
import { MemoryLock } from "./d1/lock";
import type {
  AccountInfo,
  AgentState,
  CheckinAccount,
  LogEntry,
  LogSource,
  Settings,
  Target,
  Task,
  TaskInput,
  WebhookKind,
} from "./types";
import { DEFAULT_SETTINGS } from "./types";
import {
  buildDigest,
  buildWeeklyDigest,
  countTasks,
  failedTaskNames,
  nextDigestAt,
  nextWeeklyAt,
  shouldSendDigest,
  shouldSendWeeklyDigest,
  topFailingTasks,
  weekStart,
} from "./notify/digest";
import { describeLowRate, pickLowRateTasks, taskRates } from "./notify/rate";
import { buildTestMessage } from "./notify/test";
import { NOTIFY_EVENTS, isFailureEvent, isNotifyEventId, isThrottledEvent, normalizeNotifyEvents, throttleWindowMs } from "./notify/events";
import type { NotifyEventId } from "./notify/events";
import {
  WEBHOOK_TEMPLATES,
  buildWebhookPayload,
  detectWebhookKind,
  maskWebhookUrl,
  normalizeWebhookUrl,
  parseWebhookResult,
  usableWebhookToken,
  webhookUrlFromToken,
} from "./notify/webhook";
import { createTgClient, createTgClientOnDc, errorMessage, isConnectionError, migrateDcFromError } from "./telegram/client";
import { classifyPeer, executeTask, normalizeHistoryMessages, parseHistoryRequest, resolveEntity, type ExecHooks, type HistoryRequest } from "./telegram/executor";
import { runRenewal, beijingDate, type RenewalResult } from "./renew";
import {
  buildExpiryWarnings,
  buildReportMessage,
  buildRenewalMessages,
  briefFailReason,
  mergeRenewals,
  mergeSummaryResults,
  renewalFailureWarnings,
  selectRetryTargets,
  stripPasswordLines,
  toReportStatus,
  type PanelSummaryResult,
  type ReportStatus,
  type ReportTaskResult,
} from "./report";
import { computeNextRun, formatInTimezone, localDayElapsedMs } from "./schedule/time";
import { decideRun, shouldAutoPause } from "./schedule/guard";
import { taskToCommand } from "./schedule/command";
import {
  defaultName,
  findTimeToken,
  parseTrigger,
  renameForTarget,
  stripTriggerPrefix,
  tokenize,
  type TriggerContext,
} from "./schedule/dsl";
import { messageTargetHint, usernameFromLink, type MessageLike, type MessageTargetHint } from "./telegram/targets";
import type { Env } from "./env";
import { bucketDaily } from "./events";
import { applyTargetPatch, normalizeTaskInput, preserveTargetMeta, shouldAutoRename, shouldCleanupPrevious, taskFingerprint, taskToExport } from "./task";
import { BUILD } from "./version";
import { redactSettingsForClient, redactState, shouldAutoFillAdminId } from "./settings";

interface Credentials {
  apiId: number | null;
  apiHash: string;
}

interface PendingLogin {
  apiId: number;
  apiHash: string;
  phone: string;
  phoneCodeHash: string;
  session: string;
  stage: "code" | "password";
  at: number;
}

/** 手动执行的实时进度（按任务保存，前端轮询读取） */
interface LiveEvent {
  at: number;
  level: "info" | "warn" | "error";
  message: string;
}

interface LiveRun {
  taskId: number;
  taskName: string;
  startedAt: number;
  finishedAt: number | null;
  running: boolean;
  ok: boolean | null;
  message: string | null;
  events: LiveEvent[];
}

/** 实时进度保留时间（结束后仍可被前端读取） */
const LIVE_KEEP_MS = 5 * 60_000;
/** 实时进度多久没更新才判定执行已死（实例被回收） */
const LIVE_STALE_MS = 2 * 60_000;
const LIVE_MAX_EVENTS = 200;

/** 控制会话里最近一次"转发/回复过来的目标"（先转发机器人、再单独发配置时用） */
const KV_TRIGGER_TARGET = "trigger:target";
/** 触发消息单批拉取条数 / 最多回溯几批（多了会拖慢轮询，少了会丢指令） */
const TRIGGER_FETCH_BATCH = 100;
const TRIGGER_FETCH_BATCHES = 5;
/**
 * 触发轮询循环里预留的查询预算：循环到剩这么多就停，剩下的留给收尾
 * （批量写日志 + 合并写 lastPoll/游标/lastEvent + afterUse + 最终 earliestNextRun 约 3 条，
 * 剩下的给重指令留余量）。重指令（建任务等）如果单条就超预算，bump 会抛错、
 * 该条不计入已处理、下轮重试，不会丢消息。
 */
const TRIGGER_BUDGET_RESERVE = 8;
/** run-all 单批默认任务数（前端也可以自己传 limit） */
const RUN_ALL_BATCH = 8;
/** run-all 单批最多占用的时间：超过就交给前端下一轮 */
const RUN_ALL_BATCH_BUDGET_MS = 80_000;
/** BB 机器人：永不重试（用户定下的规矩） */
const NO_RETRY_BOT = "bbembybot";
/** 签到成功的关键词（用于从回复里区分「已签」和「新签」） */
const SIGNIN_OK_WORDS = ["签到成功", "已经签", "签到奖励"];
/** /myinfo 类命令：任务最后一步是它时，最后一条回复就是 myinfo 回复 */
const INFO_COMMANDS = new Set(["/myinfo", "/profile", "/stats"]);

/** `run:<taskId>:outcome` 里存的最近一次执行结果（kv 按任务覆盖，只留最新一次） */
export interface StoredRunOutcome {
  ok: boolean;
  replyText: string | null;
  replyFullText: string | null;
  allReplies: string[];
  /** 按步骤归属的回复（与 steps 一一对应；老数据没有这个字段） */
  stepReplies?: Array<string | null> | null;
  /** 每步的回复是不是只来自弹窗回调（与 steps 一一对应；老数据没有这个字段） */
  stepCallbackOnly?: boolean[] | null;
  /** 本次执行的结束时间（毫秒），finalize 按它挑出今天跑过的任务；老数据没有 */
  at?: number;
  /** 本次执行耗时（毫秒），finalize 重建汇总行用；老数据没有 */
  durationMs?: number | null;
}

/**
 * 把一次任务执行的回复拆成「签到回复」和「myinfo 回复」（面板 reply / myinfoReply 用）。
 *
 * 执行器现在按步骤归属回复（stepReplies，与 steps 一一对应）：
 * 签到回复取签到步（追加指令之前最后一步）的回复，myinfo 回复取最后一步的回复。
 * 没抓到签到回复时宁可留空，也别拿 myinfo 回复顶上。
 * 老数据没有 stepReplies：非追加指令任务沿用旧逻辑；追加指令任务直接留空
 * （allReplies 里只有 myinfo 回复，不能当签到回复）。
 * signInCallbackOnly：签到步的回复只来自弹窗回调、没收到正文——弹窗回调
 * （「签到中...」「✔️ Done!」）不能证明签到真的成功了，上层把它标出来，
 * 状态仍按原口径记（面板只认识 success/already/failed/ran，不引入新状态值）。
 * myinfoCallbackOnly：老数据（没有 stepReplies）里，信息步自己的回复是空的，
 * myinfo 回复是从最终回复（弹窗回调）兜底来的——不是一条真的信息回复，
 * 上层收到续费现读的信息回复时可以用它补上。新数据没抓到就留空，不标这个。
 */
export function resolveTaskReplies(
  steps: Task["steps"],
  stored: StoredRunOutcome | null,
): { reply: string; myinfoReply: string; signInCallbackOnly: boolean; myinfoCallbackOnly: boolean } {
  const allReplies = stored?.allReplies ?? [];
  const replyFullText = stored?.replyFullText ?? stored?.replyText ?? "";
  const lastStep = steps[steps.length - 1];
  const isInfoStep =
    lastStep?.type === "text" && INFO_COMMANDS.has((lastStep.text ?? "").trim().toLowerCase());
  const stepReplies = stored?.stepReplies ?? null;

  // myinfo 回复：最后一步的回复（新数据取步骤归属，老数据取 replyFullText）。
  // 新数据只取信息步自己的回复：没抓到就留空，别拿最终回复（可能是弹窗回调
  // 「签到中...」）顶上——回调不是信息回复，面板上留空比显示一句回调干净。
  // 老数据没有 stepReplies，只能拿最终回复（那时最终回复就是信息步的回复）。
  let myinfoReply = "";
  let myinfoCallbackOnly = false;
  if (isInfoStep) {
    const lastStepReply = (stepReplies?.[steps.length - 1] ?? "").trim();
    myinfoReply = stepReplies ? lastStepReply : lastStepReply || replyFullText.trim();
    // 只有老数据才可能有回调兜底；新数据没抓到就是空，不再标回调兜底。
    myinfoCallbackOnly = !stepReplies && !lastStepReply && Boolean(myinfoReply);
  }

  // 签到回复：签到步（追加指令之前最后一步）的回复；没抓到就留空，
  // 不往前找、不回退到 allReplies[0]（那就是 myinfo 回复）
  let reply = "";
  const signInIndex = isInfoStep ? steps.length - 2 : steps.length - 1;
  if (stepReplies && signInIndex >= 0) {
    reply = (stepReplies[signInIndex] ?? "").trim();
  } else if (!stepReplies && !isInfoStep) {
    // 老数据且最后一步不是追加指令：沿用旧逻辑（allReplies 只有最后一步的回复，就是签到回复）
    reply = (
      allReplies.find((text) => SIGNIN_OK_WORDS.some((w) => text.includes(w))) ??
      allReplies[0] ??
      replyFullText
    ).trim();
  }
  // 老数据且最后一步是追加指令：reply 留空（allReplies 里只有 myinfo 回复）
  const signInCallbackOnly =
    stepReplies !== null && signInIndex >= 0 && (stored?.stepCallbackOnly?.[signInIndex] ?? false);
  return { reply, myinfoReply, signInCallbackOnly, myinfoCallbackOnly };
}

/** 北京式「M 月 D 日 HH:mm」（面板 ranAt / runLabel 用） */
function formatRanAt(ms: number, tzHours: number): string {
  const d = new Date(ms + tzHours * 3_600_000);
  return `${d.getUTCMonth() + 1} 月 ${d.getUTCDate()} 日 ${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}

/** 北京式「M 月 D 日」（推送首行用） */
function formatDateLabel(ms: number, tzHours: number): string {
  const d = new Date(ms + tzHours * 3_600_000);
  return `${d.getUTCMonth() + 1} 月 ${d.getUTCDate()} 日`;
}

/** 一次定时跑里单个任务的结果（汇总推送 + 面板 ingest 共用） */
interface CollectedResult {
  taskId: number;
  name: string;
  botUsername: string;
  accountId: string;
  status: "success" | "already" | "failed" | "ran";
  /** 签到回复（面板 reply）；签到步只拿到弹窗回调时前面加「【仅回调】」 */
  reply: string;
  /** /myinfo 或 /profile 回复（面板 myinfoReply），没有为空 */
  myinfoReply: string;
  /** myinfo 回复不是真的信息回复、只是弹窗回调兜底来的（续费现读的信息回复可以补上它） */
  myinfoCallbackOnly: boolean;
  /** 签到步的回复只来自按钮弹窗回调、没收到正文 */
  callbackOnly: boolean;
  ranAt: string;
  via: string;
  failReason: string;
  /** 本次执行耗时（毫秒），日志里有才有 */
  durationMs: number | null;
}

/** 每任务最近一次执行的耗时（毫秒）：日志按 id 倒序，最先见到的就是最新一次。
 * 只有执行类日志带 durationMs；没有耗时（或系统日志，taskId 为空）的不记。
 * 最新一条日志没有耗时时不挡路，继续往前找带耗时的那条。 */
export function lastDurationsByTask(logs: LogEntry[]): Map<number, number> {
  const out = new Map<number, number>();
  for (const log of logs) {
    if (log.taskId === null || log.taskId === undefined) continue;
    if (out.has(log.taskId)) continue;
    if (log.durationMs === null || log.durationMs === undefined) continue;
    out.set(log.taskId, log.durationMs);
  }
  return out;
}

/** 存在 kv（report:lastRunSummary）里的最近一次跑，供面板收数和 /api/run-summary 用。
 * 自 0.21.2 起它是当天的全量汇总：同一天的多次 tick 会把各自的结果按任务合并进来，
 * 而不是每 tick 覆盖一次；这样面板收数和 00:15 的单条推送拿到的都是全天结果。
 * results 里额外存 name（推送拼消息用）/ failReason（只存档，推送的失败行只写「失败」，
 * 不展示它），面板 ingest 会忽略多余字段。 */
export interface PanelRunSummary {
  date: string;
  runLabel: string;
  runStartedBeijing: string;
  runFinishedBeijing: string;
  results: PanelSummaryResult[];
  renewals: RenewalResult[];
}

/** 「M 月 D 日 HH:mm」转可比元组（月、日、时、分）；解析失败排最后，不挡合并。 */
function beijingLabelOrder(label: string): [number, number, number, number] {
  const m = /(\d+) 月 (\d+) 日 (\d+):(\d+)/.exec(label);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])] : [99, 99, 99, 99];
}

function compareBeijingLabels(a: string, b: string): number {
  const x = beijingLabelOrder(a);
  const y = beijingLabelOrder(b);
  for (let i = 0; i < 4; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

/**
 * 多账号汇总合并：不带 ?account= 的 GET /api/run-summary 用（D1 版）。
 * DO 单账号版 accountId 恒为空，裸键 report:lastRunSummary 就是全量；
 * D1 版汇总按账号前缀存（acct:<id>:report:lastRunSummary），裸键从来没人写，
 * 不聚合就永远回 null。带 ?account= 时不走这里，只返回该账号的汇总。
 * 合并规则：results / renewals 按传入的账号顺序拼接；date 取最早的一天；
 * runLabel 取 runStartedBeijing 最早的那份；runStartedBeijing 取最早、
 * runFinishedBeijing 取最晚。空数组返回 null。
 */
export function mergeRunSummaries(summaries: PanelRunSummary[]): PanelRunSummary | null {
  if (!summaries.length) return null;
  const byStart = [...summaries].sort((a, b) => compareBeijingLabels(a.runStartedBeijing, b.runStartedBeijing));
  const byFinish = [...summaries].sort((a, b) => compareBeijingLabels(a.runFinishedBeijing, b.runFinishedBeijing));
  return {
    date: [...summaries].map((s) => s.date).sort()[0],
    runLabel: byStart[0].runLabel,
    runStartedBeijing: byStart[0].runStartedBeijing,
    runFinishedBeijing: byFinish[byFinish.length - 1].runFinishedBeijing,
    results: summaries.flatMap((s) => s.results),
    renewals: summaries.flatMap((s) => s.renewals),
  };
}
/**
 * 实体缓存（[markedId, accessHash, username, phone, name]）。
 * teleproto 把这份缓存放在 session 对象里，StringSession.save() 不会带上它，
 * 而我们的 client 每次执行都是新建的 —— 不落地的话数字 id 永远解析不出来。
 */
/**
 * 连接复用窗口（毫秒）。
 *
 * DO 里的长连接是可行的（Cloudflare 2026 起，活跃的 outbound 连接会阻止驱逐，
 * 单连接上限 15 分钟），但会被部署/迁移/驱逐随时打断，所以不当成可用性前提。
 * 这里只做「短时间内复用」：连着点几个任务、或一次 tick 里跑多个任务时不必反复重连；
 * 空闲超过这个时间就主动断开，省得白占 DO 常驻时长。
 *
 * 5 秒就够了：一次 tick 内的连续操作通常间隔毫秒级；跨 tick 的间隔至少 60 秒，
 * 本来就复用不上，30 秒保温纯粹是白占时长（免费限额 Duration 的大头）。
 * 但注意：`wait` 步骤最长 600 秒、步骤间隔最长 60 秒，一次 tick 内也可能中途
 * 断开重连——重连是透明的（session 里的 auth key，1 RTT），正确性不受影响，
 * 只是多一次连接开销；不要以为 5 秒保温能覆盖整个 tick。
 *
 * 设成 0 表示每次操作都新建连接。
 */
const CLIENT_IDLE_REUSE_MS = 5_000;

/** DO 闲时触发轮询间隔（毫秒）：没任务临近时，触发轮询按这个间隔来，不再每 60 秒醒一次。 */
const IDLE_POLL_MS = 15 * 60_000;
/** 任务在这个时间窗口内到期就算「忙」：恢复 pollSeconds 的轮询间隔。 */
const IDLE_POLL_BUSY_WINDOW_MS = 10 * 60_000;
/**
 * 闲时轮询的第二档：下次任务在 10–60 分钟内到期时用 15 分钟；
 * 下次任务超过 60 分钟（或没有启用任务）时用 60 分钟——触发命令最多延迟
 * 60 分钟，但 DO 一天只醒约 24 次轮询。两档都取 max(pollSeconds, 档位)：
 * pollSeconds 配得更大时（如 3600 秒）以配置为准，不会被档位拉短。
 * 注意两个常量值碰巧相同，含义不同：一个是「中档的分档边界」（距下次任务
 * 60 分钟以内算中档），一个是「长档的轮询间隔」（60 分钟醒一次），改一个
 * 不要顺手改另一个。
 */
/** 中档分档边界（毫秒）：距下次任务 ≤ 该值算中档。 */
const IDLE_POLL_MID_BOUNDARY_MS = 60 * 60_000;
/** 长档轮询间隔（毫秒）：无任务临近时每该值醒一次。 */
const IDLE_POLL_LONG_INTERVAL_MS = 60 * 60_000;

const REPLY_MARKERS = ["✅", "❌", "⚠️", "📋", "💡", "⚙️", "🔧", "📝", "🚀", "⏰", "🗑️"];

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function jsonError(error: unknown, status = 400): Response {
  return json({ error: publicError(error) }, status);
}

/** 把内部错误翻译成对外可读、且不泄露实现细节的信息 */
function publicError(error: unknown): string {
  const message = errorMessage(error);
  // 数据库/驱动层错误不外泄（例如 "datatype mismatch: SQLITE_MISMATCH"）
  if (/SQLITE|datatype|constraint|no such (table|column)/i.test(message)) {
    return "请求参数不合法";
  }
  return message;
}

/** 入参校验失败：路由层转 400，其余错误继续走 500（见 fetch() 的 catch）。 */
class ValidationError extends Error {}

/** 合法的日历日期（YYYY-MM-DD，2026-02-30 这类不存在的日期不算）。 */
function isValidDateString(date: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const [y, m, d] = date.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/** query/body 里的数字参数：非数字一律回落到默认值，避免把 "abc" 塞进 SQL */
/** 目标类型的中文写法（消息里显示用） */
const PEER_KIND_TEXT: Record<string, string> = {
  bot: "机器人",
  group: "群组",
  channel: "频道",
  user: "用户",
};

/** 字节数转人话（存储告警用） */
function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value < 10 && unit > 0 ? 1 : 0)} ${units[unit]}`;
}

/** 按消息 id 去重（分批拉取时相邻批次可能重叠） */
function dedupeById<T extends { id: number }>(items: T[]): T[] {
  const seen = new Map<number, T>();
  for (const item of items) if (!seen.has(item.id)) seen.set(item.id, item);
  return [...seen.values()];
}

function intParam(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function isOwnReply(text: string): boolean {
  const trimmed = text.trimStart();
  return REPLY_MARKERS.some((marker) => trimmed.startsWith(marker));
}

export class AgentService {
  private readonly store: Store;
  private readonly env: Env;
  private readonly lock: ExecLock;
  /** 复用的 client（见 CLIENT_IDLE_REUSE_MS），按账号分，只在单次请求内有效 */
  private cachedClients = new Map<string, { client: TelegramClient; key: string; touchedAt: number }>();
  private idleTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** 当前是否真的有活跃的 MTProto 连接（内存态，请求结束即失效） */
  private connected = false;
  /** 正在进行的 withClient 操作数：空闲计时器不能在这时候掐连接 */
  private activeOps = 0;
  /** 手动执行的实时进度（与 kv 同步，读请求可以直接拿到最新状态） */
  private liveRuns = new Map<number, LiveRun>();
  /** 已受理但还没轮到执行的手动任务（防止连接建立前重复提交） */
  private pendingManualRuns = new Set<number>();
  /**
   * 本轮触发消息里最后一条的事件（只记内存，不立即写库）。
   * trigger:lastEvent 是给界面看的“最近一次触发事件”，一批消息里只有最后一条有用，
   * 轮询结束时（pollTriggers 的 finally）与 lastPoll、游标一次合并写回，中途抛错也不丢；
   * 只有轮询中途实例被驱逐才会丢（展示用的值，下轮轮询会重新产生）。
   */
  private pendingLastEvent: { at: number; ok: boolean; message: string; detail: string | null } | null = null;
  /**
   * 轮询的日志缓冲：pollTriggers 开始时建一个空数组，record / 轮询日志先攒进来，
   * 结束时（finally）一次 addLogs 插多行。DO 与 D1 都启用。
   * null = 未缓冲，直接写库。
   */
  private logBuffer: Array<Omit<LogEntry, "id">> | null = null;

  /**
   * 写一条日志。缓冲启用时（轮询中）先攒进 logBuffer，结束时一次写完；
   * 否则直接 store.addLog（轮询之外的日志都走这里）。
   */
  private async writeLog(entry: Omit<LogEntry, "id">): Promise<void> {
    if (this.logBuffer) {
      this.logBuffer.push(entry);
      return;
    }
    await this.store.addLog(entry);
  }

  constructor(store: Store, env: Env, lock: ExecLock) {
    this.store = store;
    this.env = env;
    this.lock = lock;
  }

  /** 当前账号的执行锁 key（DO 版 accountId 为空，key 就是 "exec:"）。 */
  private execLockKey(): string {
    return `exec:${this.store.getAccountId()}`;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;
    try {
      // 多账号：?account=<id> 切换账号（D1 版）；DO 版只有一个账号，非法 id 直接忽略
      const accountParam = (url.searchParams.get("account") ?? "").trim();
      if (accountParam) {
        const account = await this.store.getAccount(accountParam);
        if (account) this.store.setAccountId(account.id);
      }
      const colo = request.headers.get("x-cf-colo");
      if (colo && await this.store.getKv("runtime:colo") !== colo) await this.store.setKv("runtime:colo", colo);
      if (path === "/accounts" && method === "GET") {
        return json({ accounts: await this.store.listAccounts() });
      }
      if (path === "/accounts" && method === "POST") {
        const body = (await request.json()) as { id?: string; label?: string };
        const id = String(body.id ?? "").trim().toLowerCase();
        if (!/^[a-z0-9-]{1,32}$/.test(id)) {
          return jsonError("账号 id 只允许小写字母、数字、连字符，1–32 位", 400);
        }
        const label = String(body.label ?? "").trim() || undefined;
        const account = await this.store.createAccount(id, label, Date.now());
        return json({ account });
      }
      const accountEnableMatch = /^\/accounts\/([a-z0-9-]{1,32})\/enable$/.exec(path);
      if (accountEnableMatch && method === "POST") {
        const body = (await request.json()) as { enabled?: boolean };
        const account = await this.store.setAccountEnabled(accountEnableMatch[1], body.enabled !== false, Date.now());
        if (!account) return jsonError("账号不存在", 404);
        return json({ account });
      }
      if (path === "/state" && method === "GET") return json(redactState(await this.buildState()));
      if (path === "/run-summary" && method === "GET") {
        // D1 多账号：不带 ?account= 时聚合各启用账号的汇总（裸键没人写，不聚合
        // 永远回 null）。带 ?account= 时上面已切到该账号，只读该账号的汇总；
        // DO 单账号版没有查询预算，走裸键，行为不动。
        if (!this.store.getAccountId() && this.store.hasQueryBudget()) {
          const accounts = (await this.store.listAccounts()).filter((a) => a.enabled);
          const summaries: PanelRunSummary[] = [];
          for (const account of accounts) {
            this.store.setAccountId(account.id);
            const one = await this.store.getJson<PanelRunSummary | null>("report:lastRunSummary", null);
            if (one) summaries.push(one);
          }
          this.store.setAccountId("");
          return json({ summary: mergeRunSummaries(summaries) });
        }
        const summary = await this.store.getJson<PanelRunSummary | null>("report:lastRunSummary", null);
        return json({ summary });
      }
      if (path === "/settings" && method === "POST") {
        // D1 版设置按账号存：不带 ?account= 时 accountId 是空串，设置会静默写到
        // 没人读的裸键 "settings"，界面上改完实际没生效。直接拒绝，让调用方带上账号。
        // DO 单账号版没有这个分法，不拦。
        if (this.store.hasQueryBudget() && !this.store.getAccountId()) {
          return jsonError("设置按账号保存：请带 ?account=<账号 id> 再调这个接口", 400);
        }
        type SettingsBody = Partial<Settings> & {
          clearTurnstileSecret?: boolean;
          clearNotifyWebhookSecret?: boolean;
          clearNotifyWebhook?: boolean;
          clearAdminUserId?: boolean;
          notifyWebhookToken?: string;
        };
        const body = (await request.json()) as SettingsBody;
        const {
          clearTurnstileSecret,
          clearNotifyWebhookSecret,
          clearNotifyWebhook,
          clearAdminUserId,
          notifyWebhookToken,
          ...rest
        } = body;
        const patch: Partial<Settings> = { ...rest };
        // 地址回传时是脱敏的：留空表示"不修改"，要清空请勾「清除 Webhook」
        if (patch.notifyWebhook !== undefined && !String(patch.notifyWebhook).trim() && !clearNotifyWebhook) {
          delete patch.notifyWebhook;
        }
        if (clearNotifyWebhook) patch.notifyWebhook = "";
        // 管理员 ID 回传时也是脱敏的：留空表示"不修改"，要清空请勾「清除管理员 ID」
        if (patch.adminUserId !== undefined && !String(patch.adminUserId).trim() && !clearAdminUserId) {
          delete patch.adminUserId;
        }
        if (clearAdminUserId) {
          patch.adminUserId = "";
          // 明确清空过就别再自动回填
          await this.store.setKv("adminId:autoFilled", "1");
        }
        // 固定渠道（钉钉/企微/飞书）只提交 token，地址由模板生成；空值与脱敏值表示保持不变。
        if (notifyWebhookToken !== undefined) {
          const token = usableWebhookToken(notifyWebhookToken);
          if (token) {
            const kind = (patch.notifyWebhookKind ?? (await this.store.getSettings()).notifyWebhookKind ?? "generic") as WebhookKind;
            patch.notifyWebhook = webhookUrlFromToken(kind, token);
          }
        }
        if (clearTurnstileSecret) patch.turnstileSecretKey = "";
        const before = await this.store.getSettings();
        const saved = await this.store.saveSettings(sanitizeSettings(patch));
        if (clearTurnstileSecret) await this.store.saveSettings({ turnstileSecretKey: "" });
        if (clearNotifyWebhookSecret) await this.store.saveSettings({ notifyWebhookSecret: "" });
        // 只粘了 token / 少了 https:// 的地址，按渠道补全（再存一次）
        const effective = await this.store.getSettings();
        const normalizedUrl = normalizeWebhookUrl(effective.notifyWebhook ?? "", effective.notifyWebhookKind ?? "generic");
        if (normalizedUrl !== (effective.notifyWebhook ?? "")) {
          await this.store.saveSettings({ notifyWebhook: normalizedUrl });
        }
        if (before.controlChat !== saved.controlChat) await this.resetTriggerCursor();
        return json({ settings: redactSettingsForClient(await this.store.getSettings()) });
      }

      if (path === "/tasks" && method === "POST") {
        const body = (await request.json()) as TaskInput;
        let result: { task: Task; created: boolean };
        try {
          result = await this.createTask(body);
        } catch (error) {
          return jsonError(error, 400);
        }
        const { task, created } = result;
        if (!created) return json({ task, error: `已存在相同任务 #${task.id}` }, 409);
        return json({ task });
      }
      if (path === "/tasks/export" && method === "GET") {
        // ?group=名称 只导出这个分组；?group=__ungrouped 只导出未分组的；不传 = 全部
        const groupParam = (url.searchParams.get("group") ?? "").trim();
        const all = (await this.store.listTasks()).map(taskToExport);
        const tasks = !groupParam
          ? all
          : groupParam === "__ungrouped"
            ? all.filter((task) => !(task.group ?? "").trim())
            : all.filter((task) => (task.group ?? "").trim() === groupParam);
        return json({
          format: "cf-tg-checkin.tasks",
          version: 1,
          exportedAt: Date.now(),
          ...(groupParam ? { group: groupParam === "__ungrouped" ? "" : groupParam } : {}),
          tasks,
        });
      }

      if (path === "/tasks/batch-update" && method === "POST") {
        const body = (await request.json()) as { ids?: number[]; enabled?: boolean; group?: string | null };
        const ids = Array.isArray(body.ids)
          ? [...new Set(body.ids.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0))].slice(0, 200)
          : [];
        if (!ids.length) return jsonError("没有选中任务", 400);
        const patch: Partial<TaskInput> = {};
        if (typeof body.enabled === "boolean") patch.enabled = body.enabled;
        if (body.group !== undefined) patch.group = String(body.group ?? "").trim().slice(0, 20);
        if (!Object.keys(patch).length) return jsonError("没有要修改的内容", 400);

        let updated = 0;
        for (const id of ids) {
          if (!await this.store.getTask(id)) continue;
          await this.updateTask(id, patch);
          updated += 1;
        }
        const bits = [
          patch.enabled === undefined ? "" : patch.enabled ? "启用" : "停用",
          patch.group === undefined ? "" : `分组改为「${patch.group || "未分组"}」`,
        ].filter(Boolean);
        await this.store.addLog({
          taskId: null,
          taskName: null,
          at: Date.now(),
          ok: true,
          level: "info",
          message: `批量修改任务：${updated} 个（${bits.join("，")}）`,
          detail: null,
          source: "system",
        });
        return json({ ok: true, updated });
      }

      if (path === "/tasks/delete-batch" && method === "POST") {
        const body = (await request.json()) as { ids?: number[] };
        const ids = Array.isArray(body.ids)
          ? [...new Set(body.ids.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0))].slice(0, 200)
          : [];
        if (!ids.length) return jsonError("没有选中任务", 400);
        let deleted = 0;
        for (const id of ids) {
          if (!await this.store.getTask(id)) continue;
          await this.store.deleteTask(id);
          deleted += 1;
        }
        await this.store.addLog({
          taskId: null,
          taskName: null,
          at: Date.now(),
          ok: true,
          level: "info",
          message: `批量删除任务：${deleted} 个`,
          detail: ids.length > deleted ? `另有 ${ids.length - deleted} 个已经不存在` : null,
          source: "system",
        });
        return json({ ok: true, deleted });
      }

      if (path === "/tasks/group-rename" && method === "POST") {
        const body = (await request.json()) as { from?: string; to?: string };
        const from = String(body.from ?? "").trim();
        const to = String(body.to ?? "").trim().slice(0, 20);
        if (!to) return jsonError("新分组名不能为空", 400);
        if (to === from) return json({ ok: true, updated: 0, from, to });
        const updated = await this.store.renameGroup(from, to, Date.now());
        await this.store.addLog({
          taskId: null,
          taskName: null,
          at: Date.now(),
          ok: true,
          level: "info",
          message: `分组改名：${from || "未分组"} → ${to}（${updated} 个任务）`,
          detail: null,
          source: "system",
        });
        return json({ ok: true, updated, from, to });
      }

      if (path === "/tasks/import" && method === "POST") {
        const body = (await request.json()) as { tasks?: TaskInput[]; group?: string };
        const fallbackGroup = String(body.group ?? "").trim().slice(0, 20);
        const incoming = (Array.isArray(body.tasks) ? body.tasks.slice(0, 200) : []).map((item) =>
          // 导入到当前分组：文件里自带分组的保持原样，没分组的落到目标分组
          fallbackGroup && !String(item?.group ?? "").trim() ? { ...item, group: fallbackGroup } : item,
        );
        if (!incoming.length) return jsonError("没有可导入的任务", 400);

        const created: number[] = [];
        const skipped: Array<{ name: string; reason: string }> = [];
        for (const item of incoming) {
          try {
            const result = await this.createTask(item);
            if (result.created) created.push(result.task.id);
            else skipped.push({ name: item.name ?? "未命名", reason: `已存在相同任务 #${result.task.id}` });
          } catch (error) {
            skipped.push({ name: item.name ?? "未命名", reason: errorMessage(error) });
          }
        }
        return json({ ok: true, created: created.length, ids: created, skipped });
      }

      if (path === "/tasks/run-all" && method === "POST") {
        // 手动执行保留：暂停只停自动调度（tick/alarm），这里是显式管理员操作，
        // 不走 tick()，暂停的 DO 仍可手动跑任务。
        // 一次跑太多会撞网关超时（前端看到 524、其实任务还在跑）：
        // 每次只处理一批，把剩余数量返回给前端，由前端接着调。
        const limit = intParam(url.searchParams.get("limit"), RUN_ALL_BATCH, 1, 50);
        const offset = intParam(url.searchParams.get("offset"), 0, 0, 10_000);
        // ?group=名称 只跑这个分组（__ungrouped = 未分组），不传 = 全部
        const group = (url.searchParams.get("group") ?? "").trim();
        const outcome = await this.lock.withLock(this.execLockKey(), () => this.runAllTasksBatch(offset, limit, group));
        if (!outcome.locked) return jsonError("该账号正在执行中", 409);
        const result = outcome.result;
        return json(result);
      }

      const taskMatch = /^\/tasks\/(\d+)(\/run|\/logs|\/command|\/clone|\/live)?$/.exec(path);
      if (taskMatch) {
        const id = Number(taskMatch[1]);
        const suffix = taskMatch[2];
        const task = await this.store.getTask(id);
        if (!task) return jsonError("任务不存在", 404);

        if (suffix === "/clone" && method === "POST") {
          const base = taskToExport(task);
          const clone = await this.createTask({
            ...base,
            name: `${task.name} 副本`,
            // 副本默认停用：复制出来通常还要改时间和目标，避免复制完立刻跑一遍
            enabled: false,
            nameAuto: false,
          });
          await this.store.addLog({
            taskId: clone.task.id,
            taskName: clone.task.name,
            at: Date.now(),
            ok: true,
            level: "info",
            message: `从任务 #${task.id} 复制出 #${clone.task.id}（默认停用）`,
            detail: null,
            source: "system",
          });
          return json({ task: clone.task });
        }
        if (suffix === "/run" && method === "POST") {
          // 手动执行保留：与 /tasks/run-all 一样，显式管理员操作不走 tick()，
          // 暂停只停自动调度，不锁死手动跑任务。
          if (this.pendingManualRuns.has(id) || (await this.liveOf(id))?.running) {
            return jsonError("任务正在执行中，请等待当前执行结束", 409);
          }
          this.pendingManualRuns.add(id);
          try {
            const outcome = await this.lock.withLock(this.execLockKey(), () => this.runTasks([task], undefined, { manual: true }));
            if (!outcome.locked) return jsonError("该账号正在执行中", 409);
            const log = outcome.result;
            return json({ ok: log[0]?.ok ?? false, log: log[0] });
          } finally {
            this.pendingManualRuns.delete(id);
          }
        }
        if (suffix === "/live" && method === "GET") {
          return json(
            await this.liveOf(id) ?? {
              taskId: id,
              taskName: task.name,
              startedAt: null,
              finishedAt: null,
              running: false,
              ok: null,
              message: null,
              events: [],
            },
          );
        }
        if (suffix === "/command" && method === "GET") {
          const settings = await this.store.getSettings();
          return json({ command: taskToCommand(task, settings.triggerPrefix ?? "") });
        }
        if (suffix === "/logs" && method === "GET") {
          const limit = intParam(url.searchParams.get("limit"), 20, 1, 100);
          return json({
            logs: await this.store.listLogs({
              limit,
              taskId: id,
              beforeId: intParam(url.searchParams.get("before"), 0, 0, Number.MAX_SAFE_INTEGER) || null,
            }),
          });
        }
        if (!suffix && (method === "PATCH" || method === "PUT")) {
          const patch = (await request.json()) as Partial<TaskInput>;
          let updated: Task | null;
          try {
            updated = await this.updateTask(id, patch);
          } catch (error) {
            return jsonError(error, 400);
          }
          return json({ task: updated });
        }
        if (!suffix && method === "DELETE") {
          await this.store.deleteTask(id);
          return json({ ok: true });
        }
      }

      if (path === "/logs" && method === "GET") {
        const pageSize = intParam(url.searchParams.get("pageSize") ?? url.searchParams.get("limit"), 20, 1, 100);
        const level = url.searchParams.get("level");
        const taskIdParam = intParam(url.searchParams.get("taskId"), 0, 0, Number.MAX_SAFE_INTEGER) || null;
        const query = url.searchParams.get("q");
        const beforeId = intParam(url.searchParams.get("before"), 0, 0, Number.MAX_SAFE_INTEGER) || null;
        const sinceHours = intParam(url.searchParams.get("sinceHours"), 0, 0, 24 * 365);
        const since = sinceHours > 0 ? Date.now() - sinceHours * 3600 * 1000 : null;

        const filter = { limit: pageSize, beforeId, level, taskId: taskIdParam, query, since };
        const total = await this.store.countLogs(filter);
        const pages = Math.max(1, Math.ceil(total / pageSize));
        const page = Math.min(pages, intParam(url.searchParams.get("page"), 1, 1, 100_000));

        const logs = await this.store.listLogs({ ...filter, offset: (page - 1) * pageSize });
        return json({
          logs,
          total,
          page,
          pageSize,
          pages,
          // 游标模式下仍然返回（兼容旧调用）
          nextBefore: beforeId && logs.length === pageSize ? logs[logs.length - 1].id : null,
        });
      }
      if (path === "/notify/test" && method === "POST") {
        // 允许前端带上「表单里当前的值」来测：改完地址不用先保存也能验证
        const overlay = (await request.json().catch(() => ({}))) as Partial<Settings>;
        const stored = await this.store.getSettings();
        const merged = { ...stored, ...sanitizeSettings(overlay) };
        const overlayKind = (merged.notifyWebhookKind ?? "generic") as WebhookKind;
        const overlayToken = usableWebhookToken((overlay as { notifyWebhookToken?: string }).notifyWebhookToken);
        // 空值与脱敏值表示沿用已保存的地址。
        const overlayUrl = String(overlay.notifyWebhook ?? "").trim();
        const settings: Settings = {
          ...merged,
          notifyWebhook: overlayToken
            ? webhookUrlFromToken(overlayKind, overlayToken)
            : normalizeWebhookUrl(
                overlayUrl && !overlayUrl.includes("****") ? overlayUrl : String(stored.notifyWebhook ?? ""),
                overlayKind,
              ),
          // 密钥留空表示沿用已保存的（和保存设置的语义一致）
          notifyWebhookSecret: String(overlay.notifyWebhookSecret ?? "").trim() || stored.notifyWebhookSecret,
        };
        const sample = buildTestMessage(settings);
        const result: {
          telegram: { ok: boolean; error?: string; skipped?: boolean };
          webhook: { ok: boolean; kind: string; error?: string; skipped?: boolean; target?: string };
        } = {
          telegram: { ok: false, skipped: true },
          webhook: { ok: false, kind: settings.notifyWebhookKind ?? "generic", skipped: true },
        };

        // Telegram：只有登录过、且开着私聊提醒才发
        if (settings.notifyOnFailure !== false && (await this.session())) {
          result.telegram = { ok: false };
          try {
            await this.withClient(this.store.getAccountId(), (client) =>
              client.sendMessage("me" as never, { message: `${sample.title}\n${sample.text}`, parseMode: false }),
            );
            result.telegram = { ok: true };
          } catch (error) {
            result.telegram = { ok: false, error: errorMessage(error) };
          }
        } else {
          result.telegram = {
            ok: false,
            skipped: true,
            error: settings.notifyOnFailure === false ? "私聊提醒已关闭" : "还没登录 Telegram",
          };
        }

        // Webhook：配了地址就真打一遍（带上 card，能看到真实排版）
        if ((settings.notifyWebhook ?? "").trim()) {
          const sent = await this.sendWebhook(settings, {
            title: sample.title,
            text: sample.text,
            card: sample.card,
          });
          result.webhook = {
            ok: sent.ok,
            kind: sent.kind,
            error: sent.error,
            target: maskWebhookUrl(settings.notifyWebhook ?? ""),
          };
        } else {
          result.webhook = { ok: false, kind: result.webhook.kind, skipped: true, error: "还没有填 Webhook 地址" };
        }

        return json({ ok: result.telegram.ok || result.webhook.ok, result });
      }

      if (path === "/notify/event" && method === "POST") {
        // 只给 Worker 内部调用（登录失败发生在 Worker 侧，那里拿不到 Telegram client）
        if (request.headers.get("x-internal-call") !== "notify") return jsonError("仅限内部调用", 403);
        const body = (await request.json()) as { type?: string; detail?: string };
        if (!isNotifyEventId(body.type)) return jsonError("未知通知类型", 400);
        await this.notifyEvent(null, body.type, {
          title: body.type === "login_failed" ? "🔒 管理界面登录被暂时锁定" : "通知",
          text: String(body.detail ?? "").slice(0, 300),
        });
        return json({ ok: true });
      }

      if (path === "/events" && method === "POST") {
        const body = (await request.json()) as { name?: string };
        const allowed = new Set(["failure_handled", "template_used", "command_copied"]);
        const name = String(body.name ?? "");
        if (!allowed.has(name)) return jsonError("未知事件", 400);
        await this.store.recordEvent(name);
        return json({ ok: true });
      }

      if (path === "/logs/clear" && method === "POST") {
        await this.store.clearLogs();
        return json({ ok: true });
      }

      if (path === "/auth/turnstile" && method === "GET") {
        // 这个接口会回传 Turnstile 的 secret，只给 Worker 内部用：
        // proxyToAgent 会重建请求头（只带 content-type / x-cf-colo），外部请求塞不进这个标记
        if (request.headers.get("x-internal-call") !== "turnstile") {
          return jsonError("仅限内部调用", 403);
        }
        const settings = await this.store.getSettings();
        const siteKey = (this.env.TURNSTILE_SITE_KEY ?? "").trim() || settings.turnstileSiteKey;
        const secretKey = (this.env.TURNSTILE_SECRET_KEY ?? "").trim() || settings.turnstileSecretKey;
        return json({
          siteKey: siteKey || null,
          secretKey: secretKey || null,
          source: (this.env.TURNSTILE_SECRET_KEY ?? "").trim() ? "env" : secretKey ? "settings" : null,
        });
      }

      if (path === "/auth/attempt" && method === "POST") {
        const body = (await request.json()) as { ip?: string; mode?: "peek" | "fail" | "success" };
        const ip = String(body.ip ?? "unknown").slice(0, 64);
        const mode = body.mode === "fail" || body.mode === "success" ? body.mode : "peek";
        const now = Date.now();
        const limit = 10;
        const windowMs = 10 * 60_000;

        if (mode === "peek") {
          const failures = await this.store.countAuthFailures(ip, now - windowMs);
          return json({ allowed: failures < limit, failures, retryAfterSeconds: failures < limit ? 0 : 600 });
        }

        if (mode === "success") {
          await this.store.clearAuthAttempts(ip);
          return json({ allowed: true, attempts: 0 });
        }

        const failures = await this.store.recordAuthAttempt(ip, false, now);
        return json({
          allowed: failures < limit,
          failures,
          retryAfterSeconds: failures < limit ? 0 : 600,
        });
      }

      if (path === "/command" && method === "POST") {
        const body = (await request.json()) as TaskInput;
        const settings = await this.store.getSettings();
        const normalized = normalizeTaskInput({ ...body, name: body.name ?? "" });
        return json({ command: taskToCommand(normalized, settings.triggerPrefix ?? "") });
      }

      if (path === "/trigger/parse" && method === "POST") {
        const body = (await request.json()) as { text?: string };
        const settings = await this.store.getSettings();
        const ctx: TriggerContext = { defaultTarget: settings.defaultTarget || undefined, allowMissingTarget: true };
        const rawText = String(body.text ?? "");
        const prefix = (settings.triggerPrefix ?? "").trim();
        let parseText = rawText;
        if (prefix) {
          const stripped = stripTriggerPrefix(rawText, prefix);
          if (!stripped.matched) {
            return json({
              ok: false,
              error: `消息要以「${prefix}」开头，例如：${prefix} ${rawText.slice(0, 60)}`,
            });
          }
          parseText = stripped.rest;
        }
        const parsed = parseTrigger(parseText, ctx);
        if (!parsed.ok) return json({ ok: false, error: parsed.error });
        const result = parsed.result;
        if (result.kind !== "create" || !result.task) {
          return json({ ok: true, command: result.kind, argument: result.argument });
        }
        const now = Date.now();
        // 试算也尽量把目标补全（显示名 / access_hash），和真正建任务时保持一致
        let previewInput = result.task as TaskInput;
        if (await this.session()) {
          try {
            previewInput = await this.withClient(this.store.getAccountId(), (client) => this.enrichTarget(client, result.task as TaskInput));
          } catch {
            /* 没连上就按原样展示 */
          }
        }
        if (result.autoName) {
          previewInput = { ...previewInput, name: defaultName(previewInput.target, "", previewInput.steps ?? []) };
        }
        const preview: Task = {
          ...previewInput,
          id: 0,
          nextRunAt: computeNextRun(previewInput.schedule, now, settings.timezone),
          lastRunAt: null,
          lastResult: null,
          lastMessage: null,
          createdAt: now,
          updatedAt: now,
        } as Task;
        return json({ ok: true, task: preview, explanation: result.explanation });
      }

      if (path === "/account/send-code" && method === "POST") {
        const body = (await request.json()) as { apiId?: number; apiHash?: string; phone?: string };
        const outcome = await this.lock.withLock(this.execLockKey(), () => this.sendCode(body));
        if (!outcome.locked) return jsonError("该账号正在执行中", 409);
        return json(outcome.result);
      }
      if (path === "/account/sign-in" && method === "POST") {
        const body = (await request.json()) as { code?: string; password?: string };
        const outcome = await this.lock.withLock(this.execLockKey(), () => this.signIn(body));
        if (!outcome.locked) return jsonError("该账号正在执行中", 409);
        return json(outcome.result);
      }
      if (path === "/account/logout" && method === "POST") {
        const outcome = await this.lock.withLock(this.execLockKey(), () => this.logout());
        if (!outcome.locked) return jsonError("该账号正在执行中", 409);
        return json(outcome.result);
      }
      if (path === "/resolve" && method === "POST") {
        const body = (await request.json()) as { query?: string };
        return json(await this.resolvePeer(String(body.query ?? "")));
      }
      if (path === "/history" && method === "POST") {
        const body = (await request.json()) as { peer?: unknown; limit?: unknown };
        let input: HistoryRequest;
        try {
          input = parseHistoryRequest(body);
        } catch (error) {
          return jsonError(error, 400);
        }
        return json(await this.fetchHistory(input.peer, input.limit));
      }
      if (path === "/tick" && method === "POST") {
        const limit = intParam(url.searchParams.get("limit"), 5, 1, 50);
        const outcome = await this.lock.withLock(this.execLockKey(), () => this.tick(limit));
        if (!outcome.locked) {
          return json({ ok: true, ran: [], locked: false, message: "该账号正在执行中" });
        }
        return json({ ok: true, locked: true, ...outcome.result });
      }
      if (path === "/retry-failed" && method === "POST") {
        return json(await this.retryFailedOnce());
      }
      if (path === "/finalize-run" && method === "POST") {
        // D1 多账号：不带 ?account= 时 accountId 是空串，listTasks 查 0 行，
        // 回 ok:true 会让调用方误以为成功；DO 单账号没有这个概念，不拦。
        if (this.store.hasQueryBudget() && !this.store.getAccountId()) {
          return jsonError("finalize-run 请带 ?account=<账号 id> 再调这个接口", 400);
        }
        const body = (await request.json().catch(() => ({}))) as {
          date?: string;
          runStartMs?: number;
          taskIds?: number[];
        } | null;
        try {
          return json(await this.finalizeRun(body ?? {}));
        } catch (error) {
          if (error instanceof ValidationError) return jsonError(error, 400);
          throw error;
        }
      }

      return jsonError(
        `未找到该接口：${method} ${path}（如果这是新接口，多半是部署的版本过旧，看 GET /api/version）`,
        404,
      );
    } catch (error) {
      return jsonError(error, 500);
    }
  }

  /**
   * D1 备份导出（GET /api/backup 用，D1 版专属；DO 不走这条路由）。
   * 全部账号的任务 / 设置 / 续费配置。敏感值不落盘：
   * 账号只给 id / label / enabled（apiId / apiHash / session 不出）；
   * 设置先走 redactSettingsForClient，再删掉打码后也无法恢复的字段
   * （Webhook 地址 / 管理员 ID / 密钥原文），只留“配没配”的布尔标记；
   * 恢复时这些值需另行填入（见 docs/BACKUP.md）。
   */
  async buildBackup(): Promise<{
    format: string;
    version: number;
    exportedAt: number;
    accounts: Array<{ id: string; label?: string; enabled: boolean; settings: Partial<Settings>; tasks: TaskInput[] }>;
  }> {
    const accounts = await this.store.listAccounts();
    const out: Array<{ id: string; label?: string; enabled: boolean; settings: Partial<Settings>; tasks: TaskInput[] }> = [];
    for (const account of accounts) {
      this.store.setAccountId(account.id);
      const settings = redactSettingsForClient(await this.store.getSettings());
      const {
        notifyWebhook: _webhook,
        adminUserId: _admin,
        turnstileSecretKey: _turnstile,
        notifyWebhookSecret: _secret,
        ...rest
      } = settings;
      out.push({
        id: account.id,
        ...(account.label ? { label: account.label } : {}),
        enabled: account.enabled,
        settings: rest,
        tasks: (await this.store.listTasks()).map(taskToExport),
      });
    }
    return { format: "cf-tg-checkin.d1-backup", version: 1, exportedAt: Date.now(), accounts: out };
  }

  /** 下一次需要被唤醒的时间（毫秒 epoch；没有待办事项返回 null）。DO 包装层用它排 alarm。
   * 暂停只对 DO 生效，与 tick() 用同一道门（无查询预算时才判断 paused）：
   * D1 是唯一签到通道，绝不暂停；两处同一道门，D1 即使以后有了调用方行为也不变。 */
  async nextScheduledAt(): Promise<number | null> {
    const now = Date.now();
    const settings = await this.store.getSettings();
    // 已暂停：不跑任务、不设 alarm，DO 不再自己醒来（管理接口与手动执行仍可用）
    if (!this.store.hasQueryBudget() && settings.paused) return null;
    const candidates: number[] = [];

    const nextRun = await this.store.earliestNextRun();
    if (nextRun) candidates.push(nextRun);

    // 没配控制会话时 tick 里根本不轮询（见 tickAccount 的 shouldPoll），这里也别为轮询设 alarm
    if (settings.triggerEnabled && (settings.controlChat || "").trim() && (await this.session())) {
      const lastPoll = Number((await this.store.getKv("trigger:lastPoll")) ?? 0);
      candidates.push(lastPoll ? lastPoll + (await this.effectivePollIntervalMs(now, nextRun)) : now + 1_000);
    }

    const nextDeletion = await this.store.nextDeletionAt();
    if (nextDeletion) candidates.push(nextDeletion);

    const digestAt = this.nextDigestAtMs(settings);
    if (digestAt) candidates.push(digestAt);

    const weeklyAt = this.nextWeeklyAtMs(settings);
    if (weeklyAt) candidates.push(weeklyAt);

    if (!candidates.length) return null;
    return Math.max(Math.min(...candidates), now + 5_000);
  }

  // ---------------------------------------------------------------- 调度

  private async pollIntervalMs(): Promise<number> {
    const settings = await this.store.getSettings();
    return Math.max(15, Math.min(3600, settings.pollSeconds || 60)) * 1000;
  }

  /**
   * 本轮触发轮询的实际间隔（毫秒）。
   *
   * DO 闲时按「距下次任务多远」分档：任务在 10 分钟内到期（忙）用 pollSeconds，
   * 10–60 分钟内到期用 max(pollSeconds, 15 分钟)，超过 60 分钟或没有启用任务
   * 用 max(pollSeconds, 60 分钟)。闲时触发命令最多延迟 60 分钟，签到不受影响
   * （alarm 仍按最早任务时间醒）。D1 不走 alarm（由外部 cron 调 tick），保持原有间隔不变。
   */
  private async effectivePollIntervalMs(now: number, earliestNextRun: number | null): Promise<number> {
    const base = await this.pollIntervalMs();
    if (this.store.hasQueryBudget()) return base; // D1：保持原有轮询间隔
    if (earliestNextRun !== null && earliestNextRun - now <= IDLE_POLL_BUSY_WINDOW_MS) return base;
    if (earliestNextRun !== null && earliestNextRun - now <= IDLE_POLL_MID_BOUNDARY_MS) return Math.max(base, IDLE_POLL_MS);
    return Math.max(base, IDLE_POLL_LONG_INTERVAL_MS);
  }

  /** 下一次日报时间（没开启日报就是 null） */
  private nextDigestAtMs(settings: Settings): number | null {
    if (!(settings.notifyEvents ?? []).includes("daily_digest")) return null;
    const now = Date.now();
    return nextDigestAt(settings.digestHour ?? 22, 0, now, settings.timezone ?? 8);
  }

  /**
   * 到点就发当天日报：统计来自事件计数，失败任务名来自日志。
   * 用 kv 里的 lastSentAt 保证一天只发一次（alarm 可能一小时内被唤醒很多次）。
   */
  private async maybeSendDigest(now: number): Promise<void> {
    const settings = await this.store.getSettings();
    if (!(settings.notifyEvents ?? []).includes("daily_digest")) return;

    const lastSentAt = Number(await this.store.getKv("notify:digest:lastAt") ?? 0) || null;
    const due = shouldSendDigest({
      now,
      hour: settings.digestHour ?? 22,
      minute: 0,
      timezone: settings.timezone ?? 8,
      lastSentAt,
    });
    if (!due) return;

    // 一个通道都没配就别假装发了（也不写 lastAt，配好后当天还能补发）
    const hasTelegram = settings.notifyOnFailure !== false && Boolean(await this.session());
    const hasWebhook = Boolean((settings.notifyWebhook ?? "").trim());
    if (!hasTelegram && !hasWebhook) return;

    await this.store.setKv("notify:digest:lastAt", String(now));
    try {
      const tasks = await this.store.listTasks();
      const counts = countTasks(tasks);
      // 统计以日志为准：连接级失败不写 run_finished 事件，用事件计数会漏报
      const dayStart = now - localDayElapsedMs(now, settings.timezone ?? 8);
      const logs = await this.store.listLogs({ limit: 500, since: dayStart });
      const runs = logs.filter((item) => item.source === "auto" || item.source === "manual");
      const bucket = {
        ok: runs.filter((item) => item.ok).length,
        fail: runs.filter((item) => !item.ok).length,
      };
      const content = buildDigest(
        {
          ok: bucket.ok,
          fail: bucket.fail,
          failedTasks: failedTaskNames(logs),
          totalTasks: counts.total,
          enabledTasks: counts.enabled,
          nextRunAt: await this.store.earliestNextRun(),
          lastMessage: tasks.find((task) => task.lastMessage)?.lastMessage ?? null,
        },
        { timezone: settings.timezone ?? 8, now },
      );

      // 日报直接发给两个通道（不再走事件节流：一天本来就只发一次）
      if (hasTelegram) {
        try {
          await this.withClient(this.store.getAccountId(), (client) =>
            client.sendMessage("me" as never, { message: `${content.title}\n${content.text}`, parseMode: false }),
          );
        } catch {
          /* 发不出去就只发 webhook */
        }
      }
      await this.sendWebhook(settings, { title: content.title, text: content.text, card: content.card });
      await this.store.addLog({
        taskId: null,
        taskName: null,
        at: now,
        ok: true,
        level: "info",
        message: "已发送日报",
        detail: `${content.title}\n${content.text}`,
        source: "system",
      });
    } catch (error) {
      await this.store.addLog({
        taskId: null,
        taskName: null,
        at: now,
        ok: false,
        level: "warn",
        message: `日报发送失败：${errorMessage(error)}`,
        detail: null,
        source: "system",
      });
    }
  }

  private nextWeeklyAtMs(settings: Settings): number | null {
    if (!(settings.notifyEvents ?? []).includes("weekly_digest")) return null;
    return nextWeeklyAt(
      settings.digestWeekday ?? 0,
      settings.weeklyHour ?? 22,
      0,
      Date.now(),
      settings.timezone ?? 8,
    );
  }

  /** 周报：本周 vs 上周 + 失败最多的任务（同一周只发一次） */
  private async maybeSendWeeklyDigest(now: number): Promise<void> {
    const settings = await this.store.getSettings();
    if (!(settings.notifyEvents ?? []).includes("weekly_digest")) return;

    const lastSentAt = Number(await this.store.getKv("notify:weekly:lastAt") ?? 0) || null;
    const due = shouldSendWeeklyDigest({
      now,
      weekday: settings.digestWeekday ?? 0,
      hour: settings.weeklyHour ?? 22,
      minute: 0,
      timezone: settings.timezone ?? 8,
      lastSentAt,
    });
    if (!due) return;

    const hasTelegram = settings.notifyOnFailure !== false && Boolean(await this.session());
    const hasWebhook = Boolean((settings.notifyWebhook ?? "").trim());
    if (!hasTelegram && !hasWebhook) return;

    await this.store.setKv("notify:weekly:lastAt", String(now));
    try {
      const tz = settings.timezone ?? 8;
      const thisWeek = weekStart(now, tz);
      const lastWeek = thisWeek - 7 * 86_400_000;
      const logs = await this.store.listLogs({ limit: 1000, since: lastWeek });
      const runs = logs.filter((item) => item.source === "auto" || item.source === "manual");
      const current = runs.filter((item) => item.at >= thisWeek);
      const previous = runs.filter((item) => item.at < thisWeek);
      const tasks = await this.store.listTasks();
      const counts = countTasks(tasks);

      const content = buildWeeklyDigest(
        {
          ok: current.filter((item) => item.ok).length,
          fail: current.filter((item) => !item.ok).length,
          prevOk: previous.filter((item) => item.ok).length,
          prevFail: previous.filter((item) => !item.ok).length,
          topFailed: topFailingTasks(current),
          totalTasks: counts.total,
          enabledTasks: counts.enabled,
          nextRunAt: await this.store.earliestNextRun(),
        },
        { timezone: tz, now },
      );

      if (hasTelegram) {
        try {
          await this.withClient(this.store.getAccountId(), (client) =>
            client.sendMessage("me" as never, { message: `${content.title}\n${content.text}`, parseMode: false }),
          );
        } catch {
          /* 发不出去就只发 webhook */
        }
      }
      await this.sendWebhook(settings, { title: content.title, text: content.text, card: content.card });
      await this.store.addLog({
        taskId: null,
        taskName: null,
        at: now,
        ok: true,
        level: "info",
        message: "已发送周报",
        detail: `${content.title}\n${content.text}`,
        source: "system",
      });
    } catch (error) {
      await this.store.addLog({
        taskId: null,
        taskName: null,
        at: now,
        ok: false,
        level: "warn",
        message: `周报发送失败：${errorMessage(error)}`,
        detail: null,
        source: "system",
      });
    }
  }

  /** 存储用量（字节）。DO 版读 storage.databaseSize；D1 版查 PRAGMA，不放行返回 0（用量条隐藏）。 */
  async storageUsage(): Promise<{ bytes: number; limitBytes: number; percent: number }> {
    const limitBytes = 10 * 1024 * 1024 * 1024;
    let bytes = 0;
    try {
      bytes = await this.store.databaseSize();
    } catch {
      bytes = 0;
    }
    return { bytes, limitBytes, percent: Math.min(100, Math.round((bytes / limitBytes) * 1000) / 10) };
  }

  /** 存储告警：超过阈值时提醒（每 24 小时最多一条） */
  private async maybeCheckStorage(now: number): Promise<void> {
    const settings = await this.store.getSettings();
    if (!(settings.notifyEvents ?? []).includes("storage_warning")) return;
    const threshold = settings.storageWarnPercent ?? 0;
    if (!threshold) return;

    // 每天最多检查一次，别让 alarm 每次都读体积
    const lastCheck = Number(await this.store.getKv("notify:storage:lastCheckAt") ?? 0);
    if (now - lastCheck < 6 * 3600_000) return;
    await this.store.setKv("notify:storage:lastCheckAt", String(now));

    const usage = await this.storageUsage();
    if (usage.percent < threshold) return;

    await this.notifyEvent(null, "storage_warning", {
      title: "💾 存储用量偏高",
      text:
        `已用 ${formatBytes(usage.bytes)}（约 ${usage.percent}%，阈值 ${threshold}%）。\n` +
        "可以先清空日志，或减少任务数量；长期偏高说明该换更大额度了。",
    });
  }

  /** 成功率告警：每小时最多算一次，每个任务每天最多提醒一条 */
  private async maybeCheckSuccessRate(now: number): Promise<void> {
    const settings = await this.store.getSettings();
    if (!(settings.notifyEvents ?? []).includes("success_rate_low")) return;
    const threshold = settings.successRateThreshold ?? 0;
    if (!threshold) return;

    const lastCheck = Number(await this.store.getKv("notify:rate:lastCheckAt") ?? 0);
    if (now - lastCheck < 3600_000) return;
    await this.store.setKv("notify:rate:lastCheckAt", String(now));

    const windowDays = 7;
    const since = now - windowDays * 86_400_000;
    const logs = await this.store.listLogs({ limit: 1000, since });
    const low = pickLowRateTasks(taskRates(logs, { threshold }), { threshold, minSamples: 3 });
    for (const item of low.slice(0, 5)) {
      const task = item.taskId ? await this.store.getTask(item.taskId) : null;
      await this.notifyEvent(null, "success_rate_low", {
        title: `📉 任务「${item.name}」成功率偏低`,
        text: describeLowRate(item, { threshold, windowDays }),
        task,
      });
    }
  }

  /**
   * 一轮调度：跑所有启用账号的到期任务。
   * limit 限制本轮最多跑的任务数（D1 每调用 50 条查询的预算），跑不完的留在 remaining 里，
   * 调用方（Muse 定时任务 / CF cron）按 remaining 接着调下一轮。
   * 返回 { ran（本轮跑出的日志）, remaining（还没跑完的工作：到期任务 + 未处理的触发消息）,
   * nextRunAt（下次最早到期时间）, queriesUsed（本调用实际用的 D1 查询数；DO 为 0） }。
   * queriesUsed 超过预算 80%（45 条对应 36 条）时记一条警告日志，提醒下轮可能触发预算熔断。
   */
  async tick(limit = 5): Promise<{ ran: LogEntry[]; remaining: number; nextRunAt: number | null; queriesUsed: number }> {
    const ran: LogEntry[] = [];
    let remaining = 0;
    let nextRunAt: number | null = null;
    // 已暂停（DO 专属开关）：不轮询、不跑任务、不发日报/周报/存储/成功率检查，直接返回空结果。
    // 只在无查询预算时读设置（DO 内嵌 SQLite 无上限）：D1 是唯一签到通道，绝不暂停，
    // 且这里多一条查询会顶破 D1 的 45 条预算（tick-budget 单测会抓到），所以 D1 直接跳过。
    // 判断放在 listAccounts() 之前：暂停的 DO 不必为一轮空跑先读一次账号表。
    // 暂停只停自动调度：手动执行（/tasks/:id/run、/tasks/run-all）是显式管理员操作，不走 tick()，不受影响。
    if (!this.store.hasQueryBudget()) {
      const settings = await this.store.getSettings();
      if (settings.paused) {
        return { ran: [], remaining: 0, nextRunAt: null, queriesUsed: 0 };
      }
    }
    const accounts = await this.store.listAccounts();
    // ?account= 指定了账号时只跑该账号：D1 每调用 50 条查询，多账号一轮跑很容易超预算，调用方按账号循环调。
    const onlyAccount = this.store.getAccountId();
    const targetAccounts = onlyAccount ? accounts.filter((account) => account.id === onlyAccount) : accounts;
    let stoppedEarly = false;
    let processed = 0;
    for (const account of targetAccounts) {
      if (!account.enabled) continue;
      // 预算不够跑完一个账号（检查约 4 条 + 收尾 3 条）时停下，剩下的下次调用再跑。
      if (processed > 0 && this.store.remainingBudget() < 16) {
        stoppedEarly = true;
        break;
      }
      const outcome = await this.tickAccount(account.id, Math.max(0, limit - ran.length));
      processed += 1;
      ran.push(...outcome.ran);
      remaining += outcome.remaining;
      if (outcome.nextRunAt !== null && (nextRunAt === null || outcome.nextRunAt < nextRunAt)) {
        nextRunAt = outcome.nextRunAt;
      }
      if (ran.length >= limit) break;
    }
    if (stoppedEarly) {
      // 没跑完的账号可能还有到期任务，让调用方再调一轮（下次调用预算是满的）。
      remaining = Math.max(remaining, 1);
      if (nextRunAt === null || nextRunAt > Date.now()) nextRunAt = Date.now();
    }
    // 用量预警：写警告日志本身也要花查询（INSERT + 裁剪共 2 条），余量不足时只打 console.warn，
    // 绝不能为了记日志把本轮结果顶成预算错误。
    const budget = this.store.queryBudgetLimit();
    const used = this.store.queryCountUsed();
    if (budget !== undefined && queryUsageHigh(used, budget)) {
      if (this.store.remainingBudget() >= 2) {
        await this.store.addLog({
          taskId: null,
          taskName: null,
          at: Date.now(),
          ok: true,
          level: "warn",
          message: `D1 查询用量偏高：本轮用了 ${used}/${budget} 条（超过 80%），下轮可能触发预算熔断`,
          detail: null,
          source: "system",
        });
      } else {
        console.warn(`D1 查询用量偏高：本轮用了 ${used}/${budget} 条（超过 80%），下轮可能触发预算熔断`);
      }
    }
    // 警告日志写完后重读：返回的必须是本调用最终的实际用量
    return { ran, remaining, nextRunAt, queriesUsed: this.store.queryCountUsed() };
  }

  /** 单个账号的一轮调度（本轮最多跑 limit 个到期任务）。 */
  private async tickAccount(
    accountId: string,
    limit: number,
  ): Promise<{ ran: LogEntry[]; remaining: number; nextRunAt: number | null }> {
    this.store.setAccountId(accountId);
    const now = Date.now();
    // 检查阶段一次预取（D1：1 条 SELECT 取齐设置/lastPoll/游标/digest/账号行/due 计数/
    // 最早下次执行，后面都走内存；DO 返回 null，走原来逐条读）。
    const prefetch = await this.store.prefetchTickState(now);
    const settings = await this.store.getSettings();
    // 日报 / 周报 / 存储 / 成功率这些检查都不依赖 Telegram 连接，先处理掉
    await this.maybeSendDigest(now);
    await this.maybeSendWeeklyDigest(now);
    await this.maybeSendDailyReport(now);
    await this.maybeCheckStorage(now);
    await this.maybeCheckSuccessRate(now);
    const ran: LogEntry[] = [];
    const logs: string[] = [];
    // 本轮没处理完的新触发消息数（预算不够时 >0）：计入 remaining，调用方再调一轮
    let pendingTriggers = 0;

    const earliestNextRun = prefetch ? prefetch.earliestNextRun : await this.store.earliestNextRun();
    const shouldPoll =
      settings.triggerEnabled &&
      // 没配控制会话的账号不轮询：没地方拉指令，轮询只会白白花查询
      Boolean((settings.controlChat || "").trim()) &&
      !!(await this.session()) &&
      now - Number(await this.store.getKv("trigger:lastPoll") ?? 0) >=
        await this.effectivePollIntervalMs(now, earliestNextRun);
    // 预取已数过到期/待删任务：0 条就不取行，省 2 条查询；没预取（DO）照常取
    const due = prefetch && prefetch.dueCount === 0 ? [] : await this.store.dueTasks(now);
    const deletions = prefetch && prefetch.deletionCount === 0 ? [] : await this.store.dueDeletions(now);

    // 本轮只跑前 limit 个到期任务，剩下的留在 remaining 里给下一轮
    const batch = due.slice(0, Math.max(0, limit));
    const remaining = due.length - batch.length;

    if (!shouldPoll && !batch.length && !deletions.length) {
      // 没到期任务、没到轮询时间：直接返回最早下次执行（上面已算过，不再查库）
      return { ran, remaining, nextRunAt: earliestNextRun };
    }

    try {
      await this.withClient(accountId, async (client) => {
        if (deletions.length) {
          try {
            await this.processDeletions(client, deletions);
          } catch (error) {
            logs.push(`延迟删除失败：${errorMessage(error)}`);
          }
        }
        if (shouldPoll) {
          // DO 版：先写 lastPoll（轮询前标记，避免失败后立刻重试；pollTriggers 里
          // resolveEntity 抛错时 finally 不执行，靠这一次顶着）。
          // finally 结束时还会把 lastPoll 再合并写一次（幂等，多 1 条写操作）。
          // D1 版：lastPoll 由 pollTriggers 的 finally 与游标、lastEvent 合并写回，省 1 条查询。
          if (!this.store.hasQueryBudget()) {
            await this.store.setKv("trigger:lastPoll", String(now));
          }
          const controlChat = settings.controlChat || "self";
          try {
            pendingTriggers = await this.pollTriggers(client, logs, now);
          } catch (error) {
            const message = errorMessage(error);
            logs.push(`触发器轮询失败（控制会话 ${controlChat}）：${message}`);
            // 连接类错误：换一条新连接重试一次（复用的 socket 可能已经半死）
            const transient = /disconnect|not connected|socket|timeout|network|closed/i.test(message);
            let recovered = false;
            if (transient) {
              try {
                await this.dropClient(accountId);
                pendingTriggers = await this.withClient(accountId, (fresh) => this.pollTriggers(fresh, logs, now));
                recovered = true;
                await this.store.addLog({
                  taskId: null,
                  taskName: null,
                  at: Date.now(),
                  ok: true,
                  level: "info",
                  message: "触发器轮询：重连后成功",
                  source: "system",
                  detail: `控制会话 ${controlChat}`,
                });
              } catch (retryError) {
                logs.push(`重试仍失败：${errorMessage(retryError)}`);
              }
            }
            if (!recovered) {
              // 轮询失败且重连也没成：新消息都没处理，记一笔让调用方再调一轮
              pendingTriggers = Math.max(pendingTriggers, 1);
              await this.store.addLog({
                taskId: null,
                taskName: null,
                at: Date.now(),
                ok: false,
                level: "warn",
                message: `触发器轮询失败（控制会话 ${controlChat}）：${message}`,
                source: "system",
                detail: transient ? "已自动重连重试一次，仍失败" : null,
              });
            }
          }
        }
        if (batch.length) {
          // 护栏：同一任务 45 秒内不重复执行（防止调度 bug / 窗口边界造成连发）
          const runnable: Task[] = [];
          for (const task of batch) {
            const decision = decideRun(task, now, settings.timezone);
            if (!decision.run) {
              if (decision.reason !== "not-due") {
                await this.store.addLog({
                  taskId: task.id,
                  taskName: task.name,
                  at: now,
                  ok: false,
                  level: "warn",
                  source: "system",
                  message:
                    decision.reason === "already-ran-today"
                      ? "跳过：今天已经执行过（每天类型任务一天只跑一次）"
                      : `跳过：${decision.detail ?? "刚执行过"}`,
                  detail: decision.detail ?? null,
                });
                if (decision.nextRunAt) await this.store.setTaskNextRun(task.id, decision.nextRunAt);
              }
              continue;
            }
            runnable.push(task);
          }
          if (runnable.length) {
            const nightlyLogs = await this.runTasks(runnable, client);
            ran.push(...nightlyLogs);
            // 链式重试：失败的立刻再跑一次（BB 永不重试），无失败则静默
            const retryLogs = await this.retryFailedTasks(runnable, nightlyLogs, client);
            ran.push(...retryLogs);
            // 续费 + 汇总推送 + 存面板汇总
            await this.postRun(runnable, nightlyLogs, retryLogs, client, now);
          }
        }
      });
    } catch (error) {
      // 连不上 Telegram（或凭证失效）：把本轮的任务顺延，避免每个 alarm 都重试同一批
      for (const task of batch) {
        if (task.schedule.kind === "once") {
          await this.store.updateTask(task.id, { enabled: false, nextRunAt: null }, Date.now());
        } else {
          await this.store.setTaskNextRun(task.id, computeNextRun(task.schedule, Date.now(), settings.timezone));
        }
      }
      await this.setAcctField("last_error", errorMessage(error));
      await this.store.addLog({
        taskId: null,
        taskName: null,
        at: Date.now(),
        ok: false,
        level: "error",
        message: `调度出错：${errorMessage(error)}`,
        source: "system",
        detail: logs.join("\n") || null,
      });
      // 连不上 / 会话过期会导致整批任务都跑不了，单独推一条
      await this.notifyConnectionProblem(null, errorMessage(error));
    }

    return { ran, remaining: remaining + (pendingTriggers > 0 ? 1 : 0), nextRunAt: await this.store.earliestNextRun() };
  }

  // ---------------------------------------------------------------- 定时跑的链式动作（重试 / 续费 / 汇总推送）

  /** 面板里的 botUsername：机器人取 @username，群取 @ + 去掉 -100 前缀的 id */
  private panelBotUsername(task: Task): string {
    const username = (task.target.username ?? "").trim();
    if (username) return `@${username.replace(/^@/, "")}`;
    const id = String(task.target.id ?? "").trim();
    if (id.startsWith("-100")) return `@${id.slice(4)}`;
    return id;
  }

  /** 链式重试：失败的任务立刻再跑一次（BB 永不重试），无失败则静默 */
  private async retryFailedTasks(
    tasks: Task[],
    nightlyLogs: LogEntry[],
    client: TelegramClient,
  ): Promise<LogEntry[]> {
    const failedIds = new Set(nightlyLogs.filter((log) => !log.ok).map((log) => log.taskId));
    if (!failedIds.size) return [];
    const retryTasks = tasks.filter((task) => {
      if (!failedIds.has(task.id)) return false;
      if ((task.target.username ?? "").toLowerCase() === NO_RETRY_BOT) return false;
      return true;
    });
    if (!retryTasks.length) return [];
    return await this.runTasks(retryTasks, client);
  }

  /**
   * POST /api/retry-failed：只重跑上一轮（各账号 report:lastRunSummary）失败的任务。
   * BB 永不重试；每个任务每天只重跑一次（kv report:retry-failed:<日期> 记已重跑的任务，
   * 同一天再调只会挑还没重跑过的失败任务）；本端点内部不再链式重试；续费不重跑。
   * 重跑结果合并进当天全量汇总，面板下次收数就能看到。没有上一轮汇总、或没有失败
   * 任务时返回空列表，不报错。?account= 指定账号时只重跑该账号。
   */
  private async retryFailedOnce(): Promise<{
    ok: boolean;
    retried: Array<{ name: string; botUsername: string; accountId: string; status: string; ranAt: string }>;
    skippedBB: string[];
    skippedRetried: string[];
    skipped: Array<{ name: string; reason: string }>;
  }> {
    const out: {
      ok: boolean;
      retried: Array<{ name: string; botUsername: string; accountId: string; status: string; ranAt: string }>;
      skippedBB: string[];
      skippedRetried: string[];
      skipped: Array<{ name: string; reason: string }>;
    } = { ok: true, retried: [], skippedBB: [], skippedRetried: [], skipped: [] };
    const onlyAccount = this.store.getAccountId();
    const accounts = (await this.store.listAccounts()).filter(
      (account) => account.enabled && (!onlyAccount || account.id === onlyAccount),
    );
    const runStartMs = Date.now();
    for (const account of accounts) {
      this.store.setAccountId(account.id);
      const summary = await this.store.getJson<PanelRunSummary | null>("report:lastRunSummary", null);
      if (!summary || !summary.results.length) continue;
      const date = summary.date;
      const retriedKeys = (await this.store.getJson<string[]>(`report:retry-failed:${date}`, [])) ?? [];
      const picked = selectRetryTargets(summary.results, retriedKeys);
      out.skippedBB.push(...picked.skippedBB);
      out.skippedRetried.push(...picked.skippedRetried);
      if (!picked.targets.length) continue;
      const tasks = await this.store.listTasks();
      const byBot = new Map(tasks.map((task) => [this.panelBotUsername(task), task]));
      const toRun: Task[] = [];
      for (const target of picked.targets) {
        const task = byBot.get(target.botUsername);
        const name = target.name ?? target.botUsername.replace(/^@/, "");
        if (!task) out.skipped.push({ name, reason: "任务不存在" });
        else if (!task.enabled) out.skipped.push({ name, reason: "任务已停用" });
        else toRun.push(task);
      }
      if (!toRun.length) continue;
      let nightlyLogs: LogEntry[] | null = null;
      try {
        const outcome = await this.lock.withLock(this.execLockKey(), () =>
          this.withClient(account.id, (client) => this.runTasks(toRun, client)),
        );
        if (!outcome.locked) {
          for (const task of toRun) out.skipped.push({ name: task.name, reason: "该账号正在执行中" });
          continue;
        }
        nightlyLogs = outcome.result;
      } catch (error) {
        for (const task of toRun) out.skipped.push({ name: task.name, reason: errorMessage(error) });
        continue;
      }
      // 先记已重跑（再往下收结果失败也不重复跑），再收结果进汇总
      await this.store.setJson(`report:retry-failed:${date}`, [
        ...retriedKeys,
        ...toRun.map((task) => `${account.id}|${this.panelBotUsername(task)}`),
      ]);
      const results = await this.collectRunResults(toRun, nightlyLogs, [], runStartMs);
      await this.mergeDailySummary(date, runStartMs, this.toSummaryResults(results));
      for (const r of results) {
        out.retried.push({
          name: r.name,
          botUsername: r.botUsername,
          accountId: r.accountId,
          status: r.status,
          ranAt: r.ranAt,
        });
      }
    }
    return out;
  }

  /** 续费：所有开了续费的启用任务各跑一次。
   * 余额优先用本轮签到刚抓到的 myinfo 回复（reuseByTaskId，同一轮、同一任务），
   * 里面有余额才算，没有再现读——5 个续费任务里 4 个本身就开了追加指令，
   * 签到刚抓过同一份，不必为续费再发一次。 */
  private async runRenewalsForTasks(
    tasks: Task[],
    client: TelegramClient,
    reuseByTaskId?: Map<number, string>,
  ): Promise<RenewalResult[]> {
    const settings = await this.store.getSettings();
    const out: RenewalResult[] = [];
    for (const task of tasks) {
      if (!task.enabled || !task.renewal?.enabled) continue;
      try {
        const result = await runRenewal(client, task, {
          store: this.store,
          hooks: { log: (level, message) => { void this.store.addLog({
            taskId: task.id,
            taskName: task.name,
            at: Date.now(),
            ok: level !== "error",
            level,
            message: `续费：${message}`,
            detail: null,
            source: "auto",
          }); } },
          pollIntervalMs: (settings.stepPollSeconds ?? 1) * 1000,
          stepWaitMs: (settings.stepWaitSeconds ?? DEFAULT_SETTINGS.stepWaitSeconds) * 1000,
          timezone: settings.timezone ?? 8,
        }, reuseByTaskId?.get(task.id) ?? null);
        out.push(result);
      } catch (error) {
        out.push({
          name: task.name,
          bot: this.panelBotUsername(task),
          outcome: "failed",
          button: task.renewal?.button ?? "",
          detail: errorMessage(error),
        });
      }
    }
    return out;
  }

  /** 把本次跑的任务整理成汇总用的一行结果（重试成功的会翻转白天的失败）。
   * preloaded：finalize 已一次取齐的 run:outcome（省得每任务再读 1 条）；
   * 不传时照常逐个读（postRun 里读的是刚写过的 kv，走内存缓存，不花查询）。 */
  private async collectRunResults(
    tasks: Task[],
    nightlyLogs: LogEntry[],
    retryLogs: LogEntry[],
    runStartMs: number,
    preloaded?: Map<number, StoredRunOutcome | null>,
  ): Promise<CollectedResult[]> {
    const settings = await this.store.getSettings();
    const tz = settings.timezone ?? 8;
    const accountId = (settings.accountId ?? "").trim();
    const byId = new Map<number, LogEntry>();
    for (const log of nightlyLogs) if (log.taskId !== null) byId.set(log.taskId, log);
    // 重试只覆盖白天失败的任务；重试失败不能盖掉白天的成功
    for (const log of retryLogs) {
      if (log.taskId === null) continue;
      const nightly = byId.get(log.taskId);
      if (nightly && !nightly.ok) byId.set(log.taskId, log);
    }
    const out: CollectedResult[] = [];
    for (const task of tasks) {
      const log = byId.get(task.id);
      if (!log) continue;
      const stored = preloaded?.has(task.id)
        ? (preloaded.get(task.id) ?? null)
        : await this.store.getJson<StoredRunOutcome | null>(`run:${task.id}:outcome`, null);
      const isGroup =
        task.target.peerKind === "group" || String(task.target.id ?? "").startsWith("-100");
      // 签到回复与 myinfo 回复按步骤拆分（见 resolveTaskReplies）
      const { reply: signInReply, myinfoReply, signInCallbackOnly, myinfoCallbackOnly } = resolveTaskReplies(task.steps, stored);
      const detailText = log.detail ?? "";
      const status = toReportStatus(log.ok, detailText, isGroup);
      // 只拿到弹窗回调：状态不动（面板只认识 success/already/failed/ran），
      // 签到回复前面加「【仅回调】」，面板和推送都能看见；via 也如实记成按钮点击。
      const callbackOnly = signInCallbackOnly && status !== "failed";
      const reply = callbackOnly && signInReply ? `【仅回调】${signInReply}` : signInReply;
      const hasRealText = Boolean(myinfoReply) || (Boolean(signInReply) && !callbackOnly);
      // 入库过滤：信息回复里的密码行不进汇总（面板原样展示会把密码露出来）；
      // 只删密码行，余额/到期时间不动，续费读余额也不受影响。
      out.push({
        taskId: task.id,
        name: task.name,
        botUsername: this.panelBotUsername(task),
        accountId,
        status,
        reply: stripPasswordLines(reply),
        myinfoReply: stripPasswordLines(myinfoReply),
        myinfoCallbackOnly,
        callbackOnly,
        ranAt: formatRanAt(log.at, tz),
        via: hasRealText ? "消息回复" : "按钮点击",
        failReason: status === "failed" ? briefFailReason(log.message ?? "") : "",
        durationMs: log.durationMs ?? null,
      });
    }
    void runStartMs;
    return out;
  }

  /** 经 Bot API 给汇报聊天发一条汇总（token 走 REPORT_BOT_TOKEN secret） */
  private async sendReportMessage(text: string, buttons: Array<{ label: string; url: string }>): Promise<boolean> {
    const token = (this.env.REPORT_BOT_TOKEN ?? "").trim();
    const settings = await this.store.getSettings();
    const chatId = (settings.reportChatId ?? "").trim();
    if (!token || !chatId) return false;
    const body: Record<string, unknown> = { chat_id: chatId, text };
    if (buttons.length) {
      body.reply_markup = { inline_keyboard: buttons.map((b) => [{ text: b.label, url: b.url }]) };
    }
    try {
      const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) {
        await this.store.addLog({
          taskId: null,
          taskName: null,
          at: Date.now(),
          ok: false,
          level: "warn",
          message: `汇总推送失败：Bot API ${response.status}`,
          detail: null,
          source: "system",
        });
        return false;
      }
      return true;
    } catch (error) {
      await this.store.addLog({
        taskId: null,
        taskName: null,
        at: Date.now(),
        ok: false,
        level: "warn",
        message: `汇总推送失败：${errorMessage(error)}`,
        detail: null,
        source: "system",
      });
      return false;
    }
  }

  /** CollectedResult → 面板汇总行（postRun 与 retry-failed 共用） */
  private toSummaryResults(results: CollectedResult[]): PanelSummaryResult[] {
    return results.map((r) => ({
      accountId: r.accountId,
      botUsername: r.botUsername,
      status: r.status,
      reply: r.reply,
      ranAt: r.ranAt,
      via: r.via,
      ...(r.myinfoReply ? { myinfoReply: r.myinfoReply, myinfoRanAt: r.ranAt } : {}),
      ...(r.myinfoCallbackOnly ? { myinfoCallbackOnly: true } : {}),
      ...(r.callbackOnly ? { callbackOnly: true } : {}),
      name: r.name,
      ...(r.failReason ? { failReason: r.failReason } : {}),
      ...(r.durationMs !== null && r.durationMs !== undefined ? { lastDurationMs: r.durationMs } : {}),
    }));
  }

  /** 把一轮结果合并进当天全量汇总并存回（postRun 与 retry-failed 共用；
   * renewals 只在 postRun 传，重跑不重算续费）。同一任务以最新一次为准，
   * runLabel 取当晚第一批的。 */
  private async mergeDailySummary(
    date: string,
    runStartMs: number,
    tickResults: PanelSummaryResult[],
    renewals?: RenewalResult[],
  ): Promise<void> {
    const settings = await this.store.getSettings();
    const tz = settings.timezone ?? 8;
    const dailyKey = `report:daily:${date}`;
    const prev = await this.store.getJson<PanelRunSummary | null>(dailyKey, null);
    const mergedResults = mergeSummaryResults(prev?.results ?? [], tickResults);
    const mergedRenewals = renewals ? mergeRenewals(prev?.renewals ?? [], renewals) : (prev?.renewals ?? []);
    // 续费现读到的信息回复，回写进对应任务行的 myinfoReply：只在那行还没有真的
    // 信息回复（空、或只是弹窗回调兜底）时补上；已有的真回复不动。
    // 用合并后的 renewals（不只本批新到的），postRun 与 finalize 哪边先跑都能补上，
    // finalize 后跑也不会把补好的值盖回去（补上后标记已清，下次不再覆盖）。
    for (const renewal of mergedRenewals) {
      const infoReply = (renewal.infoReply ?? "").trim();
      if (!infoReply) continue;
      const row = mergedResults.find((r) => r.botUsername === renewal.bot);
      if (!row) continue;
      if (!row.myinfoReply || row.myinfoCallbackOnly) {
        row.myinfoReply = stripPasswordLines(infoReply);
        row.myinfoRanAt = row.ranAt;
        row.myinfoCallbackOnly = false;
      }
    }
    const summary: PanelRunSummary = {
      date,
      runLabel: prev?.runLabel ?? formatRanAt(runStartMs, tz),
      runStartedBeijing: prev?.runStartedBeijing ?? formatRanAt(runStartMs, tz),
      runFinishedBeijing: formatRanAt(Date.now(), tz),
      results: mergedResults,
      renewals: mergedRenewals,
    };
    await this.store.setJson(dailyKey, summary);
    await this.store.setJson("report:lastRunSummary", summary);
  }

  /**
   * 定时跑完的收尾：续费（要复用本轮签到刚抓到的 myinfo 回复，仍在 tick 里）+
   * 即时推续费消息，再把续费结果合入当天汇总。任务结果的汇总合并不在这里：
   * 见 POST /api/finalize-run，tick 只跑任务、汇总单独走一个轻请求，续费中途断了
   * 也不丢汇总；但 finalize 只从已落库的任务执行结果重建汇总，重建不出续费
   * （renew:<id> 只存日期），所以续费结果必须在这里合入，否则 summary.renewals
   * 恒为空，面板看不到续费结果，续费预警的去重也失效。
   * 汇总消息不在这里推：多个 tick 各推一条会把一晚的结果打散，改由 maybeSendDailyReport
   * 在 00:15 统一推一条全天汇总。续费消息仍在这里即时推（续费是独立事件）。
   */
  private async postRun(
    tasks: Task[],
    nightlyLogs: LogEntry[],
    retryLogs: LogEntry[],
    client: TelegramClient,
    runStartMs: number,
  ): Promise<void> {
    // 先收结果再跑续费：续费要复用本轮签到刚抓到的 myinfo 回复（同一轮、同一任务），
    // 里面有余额就不必为续费再发一次 info 命令。
    const results = await this.collectRunResults(tasks, nightlyLogs, retryLogs, runStartMs);
    const renewals = await this.runRenewalsForTasks(
      tasks,
      client,
      new Map(results.map((r) => [r.taskId, r.myinfoReply])),
    );
    for (const renewalMsg of buildRenewalMessages(renewals)) {
      await this.sendReportMessage(renewalMsg.text, renewalMsg.buttons);
    }
    // results 传空即保留旧任务结果，只合入续费；约 3 条查询（读汇总 + 两次写回），
    // limit=3 实测 38/45 条，仍在预算内。
    const settings = await this.store.getSettings();
    await this.mergeDailySummary(beijingDate(runStartMs, settings.timezone ?? 8), runStartMs, [], renewals);
  }

  /**
   * POST /api/finalize-run：把已落库的执行结果合并进当天全量汇总（轻请求，不跑任务、不续费）。
   * 结果来源是 runSingleTask 每次写下的 run:${id}:outcome + tasks 行的 last_*（recordRun），
   * 所以 tick 里续费中途断了、甚至 tick 本身没跑完，汇总也能重建；mergeDailySummary 本身幂等
   * （同一任务最新一次为准），同一晚调多次结果不变。?account= 指定账号时只合并该账号；
   * body 可带 { date?: "YYYY-MM-DD"（默认今天，北京时间）, runStartMs?: number（汇总 runLabel 用，
   * 默认现在）, taskIds?: number[]（只合并这些任务，默认今天跑过的全部） }。
   * run:outcome 里没有的任务（老数据 / 只有日志）：用最近一条执行日志兜底重建一行。
   * 入参校验（不合法抛 ValidationError，路由层转 400）：date 须为合法 YYYY-MM-DD
   * 且不晚于今天（北京时间）；taskIds 提供时须全是库中存在的数字 id；
   * 当天没有新结果（merged:0）时直接返回，不写汇总、不碰 report:lastRunSummary，
   * 避免空合并把最新汇总指针写成空。
   */
  private async finalizeRun(body: {
    date?: string;
    runStartMs?: number;
    taskIds?: number[];
  }): Promise<{ ok: true; date: string; merged: number }> {
    const input = (body ?? {}) as { date?: unknown; runStartMs?: unknown; taskIds?: unknown };
    const settings = await this.store.getSettings();
    const tz = settings.timezone ?? 8;
    const now = Date.now();
    const today = beijingDate(now, tz);
    const date = String(input.date ?? "").trim() || today;
    if (!isValidDateString(date) || date > today) {
      throw new ValidationError("date 须为合法的 YYYY-MM-DD，且不晚于今天（北京时间）");
    }
    const runStartMs = typeof input.runStartMs === "number" && input.runStartMs > 0 ? input.runStartMs : now;
    if (input.taskIds !== undefined && !Array.isArray(input.taskIds)) {
      throw new ValidationError("taskIds 须是数字 id 数组");
    }
    const onlyIds =
      Array.isArray(input.taskIds) && input.taskIds.length ? new Set(input.taskIds as unknown[]) : null;
    if (onlyIds && [...onlyIds].some((id) => typeof id !== "number" || !Number.isInteger(id))) {
      throw new ValidationError("taskIds 须是数字 id 数组");
    }
    const tasks = await this.store.listTasks();
    if (onlyIds) {
      const known = new Set(tasks.map((task) => task.id));
      for (const id of onlyIds as Set<number>) {
        if (!known.has(id)) throw new ValidationError(`taskIds 里有不存在的任务 id：${id}`);
      }
    }
    const outcomes = await this.store.listRunOutcomes();
    const preloaded = new Map<number, StoredRunOutcome | null>();
    for (const item of outcomes) {
      try {
        preloaded.set(item.taskId, JSON.parse(item.value) as StoredRunOutcome);
      } catch {
        preloaded.set(item.taskId, null);
      }
    }
    const logs: LogEntry[] = [];
    const picked: Task[] = [];
    for (const task of tasks) {
      if (onlyIds && !onlyIds.has(task.id)) continue;
      const stored = preloaded.get(task.id) ?? null;
      // 只合并当天跑过的：先看 outcome 的 at，没有再看 tasks 行的 lastRunAt
      const ranAt = stored?.at ?? task.lastRunAt ?? null;
      if (ranAt === null || beijingDate(ranAt, tz) !== date) continue;
      // 用 tasks 行的 last_* 重建一条执行日志（ok/at/message/detail/duration）
      const lastLog = !stored
        ? (await this.store.listLogs({ taskId: task.id, limit: 1 }))[0] ?? null
        : null;
      logs.push({
        id: 0,
        taskId: task.id,
        taskName: task.name,
        at: ranAt,
        ok: task.lastResult === "ok",
        level: task.lastResult === "ok" ? "info" : "warn",
        message: task.lastMessage ?? lastLog?.message ?? "",
        detail: task.lastDetail ?? lastLog?.detail ?? null,
        source: "auto",
        durationMs: stored?.durationMs ?? lastLog?.durationMs ?? null,
      });
      picked.push(task);
    }
    const results = await this.collectRunResults(picked, logs, [], runStartMs, preloaded);
    if (!results.length) return { ok: true, date, merged: 0 };
    await this.mergeDailySummary(date, runStartMs, this.toSummaryResults(results));
    return { ok: true, date, merged: results.length };
  }

  /**
   * 一晚只推一条全天汇总：北京时间 00:15 后、且今天还没推过时，把当天的全量汇总推给汇报聊天。
   * 用 shouldSendDigest 的“时间已过 + 今天没发过”判定，一天只推一次；没结果时不推也不标记，
   * 下个 alarm 再来时还能补推。放在 tick() 开头，和日报 / 周报同一批检查里跑。
   */
  private async maybeSendDailyReport(now: number): Promise<void> {
    const settings = await this.store.getSettings();
    if (!settings.reportEnabled) return;
    const tz = settings.timezone ?? 8;
    const lastSentAt = Number(await this.store.getKv("report:daily:lastSentAt") ?? 0) || null;
    const due = shouldSendDigest({ now, hour: 0, minute: 15, timezone: tz, lastSentAt });
    if (!due) return;
    const date = beijingDate(now, tz);
    let summary = await this.store.getJson<PanelRunSummary | null>(`report:daily:${date}`, null);
    if (!summary || !summary.results.length) {
      // 汇总缺失（finalize 没调 / 中途断了）：先从已落库的执行结果重建一份再推，
      // 别让 00:15 的单条推送因为汇总没来就静默跳过
      const rebuilt = await this.finalizeRun({ date, runStartMs: now });
      if (!rebuilt.merged) return;
      summary = await this.store.getJson<PanelRunSummary | null>(`report:daily:${date}`, null);
    }
    if (!summary || !summary.results.length) return;
    await this.store.setKv("report:daily:lastSentAt", String(now));
    const reportResults: ReportTaskResult[] = summary.results.map((r) => ({
      name: r.name ?? r.botUsername.replace(/^@/, ""),
      botUsername: r.botUsername,
      status: r.status as ReportStatus,
      reply: r.myinfoReply || r.reply,
      failReason: r.failReason,
      ...(r.callbackOnly ? { callbackOnly: true } : {}),
      ranAt: r.ranAt,
    }));
    const dateStr = formatDateLabel(now, tz);
    // P2-11：7 天内到期且余额 < 阈值的任务，在汇总里补一行预警；
    // P1-4 即时推过的同一任务不再重复（去重在 buildExpiryWarnings 里）。
    // 续费失败行在前，预警行在后，都跟在失败行后面。
    const tasks = await this.store.listTasks();
    const warnings = [
      ...renewalFailureWarnings(summary.renewals),
      ...buildExpiryWarnings(
        summary.results,
        summary.renewals,
        tasks
          .filter((task) => task.renewal?.enabled)
          .map((task) => ({ name: task.name, minBalance: Math.max(0, task.renewal?.minBalance ?? 0) })),
        date,
      ),
    ];
    const message = buildReportMessage(reportResults, summary.runLabel, dateStr, warnings, date);
    await this.sendReportMessage(message.text, message.buttons);
  }

  // ---------------------------------------------------------------- Telegram 会话

  /** 当前账号的会话类字段（读 accounts 表；DO 版读旧 kv）。调用前须先 setAccountId。 */
  private async getAcctField(field: string): Promise<string | null> {
    return this.store.getAccountField(this.store.getAccountId(), field);
  }

  private async setAcctField(field: string, value: string | number | null): Promise<void> {
    await this.store.setAccountField(this.store.getAccountId(), field, value, Date.now());
  }

  private async credentials(): Promise<Credentials> {
    const apiId = await this.getAcctField("api_id");
    const apiHash = await this.getAcctField("api_hash");
    if (apiId && apiHash) return { apiId: Number(apiId), apiHash };
    const envApiId = Number(this.env.TG_API_ID ?? 0);
    const envApiHash = String(this.env.TG_API_HASH ?? "");
    if (envApiId && envApiHash) return { apiId: envApiId, apiHash: envApiHash };
    return { apiId: apiId ? Number(apiId) : null, apiHash: apiHash ?? "" };
  }

  private async session(): Promise<string> {
    return (await this.getAcctField("session")) ?? "";
  }

  private async requireCredentials(): Promise<{ apiId: number; apiHash: string; session: string }> {
    const creds = await this.credentials();
    if (!creds.apiId || !creds.apiHash) throw new Error("还没配置 apiId / apiHash");
    return { apiId: Number(creds.apiId), apiHash: creds.apiHash, session: await this.session() };
  }

  /** 一次操作一个连接：连上 → 干活 → 保存 session → 断开 */
  /**
   * 一次操作用一个连接；如果上一个操作刚结束不久（CLIENT_IDLE_REUSE_MS 内），
   * 直接复用仍然活着的 client，省掉一次重连 + 实体缓存回灌。
   *
   * 复用失败（socket 被 CM 掐断、DO 侧被驱逐前的半死状态）时自动重连重试一次。
   */
  private async withClient<T>(accountId: string, fn: (client: TelegramClient) => Promise<T>): Promise<T> {
    const creds = await this.requireCredentials();
    if (!creds.session) throw new Error("还没登录 Telegram");

    this.activeOps += 1;
    try {
      const reusable = this.reusableClient(accountId, creds);
      if (reusable) {
        try {
          const result = await fn(reusable);
          await this.afterUse(accountId, reusable);
          return result;
        } catch (error) {
          // 复用的连接可能已经半死：丢掉它，重连一次再试。
          // 业务错误（目标不存在 / 参数不合法）不重试 —— 否则会把副作用重放一遍。
          if (!isConnectionError(error)) throw error;
          await this.setAcctField("last_error", errorMessage(error));
          await this.dropClient(accountId);
          return await this.runWithFreshClient(accountId, creds, fn);
        }
      }

      return await this.runWithFreshClient(accountId, creds, fn);
    } finally {
      this.activeOps -= 1;
    }
  }

  private async runWithFreshClient<T>(
    accountId: string,
    creds: { apiId: number; apiHash: string; session: string },
    fn: (client: TelegramClient) => Promise<T>,
  ): Promise<T> {
    const client = createTgClient(creds);
    try {
      await client.connect();
      this.connected = true;
      await this.setAcctField("last_connected_at", String(Date.now()));
      await this.restoreEntities(client);
      const result = await fn(client);
      await this.afterUse(accountId, client);
      return result;
    } catch (error) {
      this.connected = false;
      await this.setAcctField("last_error", errorMessage(error));
      throw error;
    } finally {
      if (CLIENT_IDLE_REUSE_MS > 0) this.keepWarm(accountId, client, `${creds.apiId}:${creds.session}`);
      else {
        await client.disconnect().catch(() => undefined);
        this.connected = false;
      }
    }
  }

  private reusableClient(accountId: string, creds: { apiId: number; session: string }): TelegramClient | null {
    if (CLIENT_IDLE_REUSE_MS <= 0) return null;
    const entry = this.cachedClients.get(accountId);
    if (!entry) return null;
    if (entry.key !== `${creds.apiId}:${creds.session}`) return null;
    if (!entry.client.connected) return null;
    return entry.client;
  }

  /** 保存 session / 实体缓存，并刷新"最近使用"时间 */
  private async afterUse(accountId: string, client: TelegramClient): Promise<void> {
    await this.persistEntities(client);
    await this.persistSession(client);
    await this.setAcctField("last_error", null);
    const entry = this.cachedClients.get(accountId);
    if (entry) entry.touchedAt = Date.now();
  }

  private keepWarm(accountId: string, client: TelegramClient, key: string): void {
    this.cachedClients.set(accountId, { client, key, touchedAt: Date.now() });
    const old = this.idleTimers.get(accountId);
    if (old) clearTimeout(old);
    this.idleTimers.set(
      accountId,
      setTimeout(() => {
        this.idleTimers.delete(accountId);
        // 还有操作在跑：绝对不能断开，等它结束后 afterUse() 会重新排计时器
        if (this.activeOps > 0) return;
        const entry = this.cachedClients.get(accountId);
        if (!entry) return;
        const idleFor = Date.now() - entry.touchedAt;
        if (idleFor >= CLIENT_IDLE_REUSE_MS) void this.dropClient(accountId);
        else this.keepWarm(accountId, entry.client, entry.key);
      }, CLIENT_IDLE_REUSE_MS),
    );
  }

  /** 丢弃缓存的连接（登录态变化、出错、空闲超时都会走这里）。不传 accountId 则丢弃全部。 */
  private async dropClient(accountId?: string): Promise<void> {
    const ids = accountId !== undefined ? [accountId] : [...this.cachedClients.keys()];
    for (const id of ids) {
      const timer = this.idleTimers.get(id);
      if (timer) {
        clearTimeout(timer);
        this.idleTimers.delete(id);
      }
      const entry = this.cachedClients.get(id);
      this.cachedClients.delete(id);
      if (entry) await entry.client.disconnect().catch(() => undefined);
    }
    this.connected = false;
  }

  /**
   * 登录阶段的连接封装。
   *
   * 账号归属的 DC 不是默认 DC2 时，Telegram 会返回 `PHONE_MIGRATE_5` 之类的错误，
   * 要求去目标 DC 上重新发起登录（验证码要在那个 DC 上申请）。
   * teleproto 内部的重试本来会处理，但登录流程要拿到迁移后的 session，
   * 这里再自己兜一层：命中迁移错误就换到目标 DC 重连重试一次。
   */
  private async withLoginClient<T>(
    creds: { apiId: number; apiHash: string; session?: string },
    fn: (client: TelegramClient) => Promise<T>,
    options: { retryOnMigrate: boolean; startDc?: number | null } = { retryOnMigrate: true },
  ): Promise<T> {
    let pinnedDc: number | null = options.startDc ?? null;
    let retried = false;
    let lastError: unknown = null;

    for (let attempt = 0; attempt < 2; attempt++) {
      const usePinned = pinnedDc !== null && !creds.session;
      const client = usePinned
        ? createTgClientOnDc(creds, pinnedDc as number)
        : createTgClient({ apiId: creds.apiId, apiHash: creds.apiHash, session: creds.session ?? "" });
      try {
        await client.connect();
        return await fn(client);
      } catch (error) {
        lastError = error;
        const targetDc = migrateDcFromError(error);
        if (targetDc !== null) await this.setAcctField("dc", String(targetDc));
        if (targetDc !== null && options.retryOnMigrate && !retried) {
          retried = true;
          pinnedDc = targetDc;
          continue;
        }
        if (targetDc !== null && !options.retryOnMigrate) {
          throw new Error(
            `该账号归属 DC${targetDc}，验证码需要在该数据中心申请：请重新点击「获取验证码」再登录（已自动记住 DC${targetDc}）`,
          );
        }
        if (targetDc !== null) {
          // 已经在目标 DC 上重试过，仍被要求迁移 —— 把上下文说清楚，方便排查
          throw new Error(
            `账号归属 DC${targetDc}，已在该 DC 重试仍被要求迁移（${errorMessage(error)}）。` +
              `请确认 apiId/apiHash 属于你自己的应用，并稍后重试`,
          );
        }
        throw error;
      } finally {
        await client.disconnect().catch(() => undefined);
      }
    }

    throw lastError ?? new Error("登录失败");
  }

  /** 把落地的实体缓存灌回新 client 的 session */
  private async restoreEntities(client: TelegramClient): Promise<void> {
    try {
      const entitiesJson = await this.getAcctField("entities_json");
      const rows: Array<[string, string, string | null, string | null, string | null]> = entitiesJson
        ? (JSON.parse(entitiesJson) as Array<[string, string, string | null, string | null, string | null]>)
        : [];
      if (!rows.length) return;
      const cache = (client.session as unknown as { _entities?: Map<string, unknown> })._entities;
      if (!cache) return;
      for (const row of rows) {
        if (row?.[0]) cache.set(String(row[0]), row);
      }
    } catch {
      /* 缓存不可用就算了 */
    }
  }

  /** 把 session 里的实体缓存落地，下次连接直接用 */
  private async persistEntities(client: TelegramClient): Promise<void> {
    try {
      const cache = (client.session as unknown as { _entities?: Map<string, unknown[]> })._entities;
      if (!cache || cache.size === 0) return;
      const rows = [...cache.values()]
        .slice(-600)
        .map((row) => [
          row[0] != null ? String(row[0]) : "",
          row[1] != null ? String(row[1]) : "",
          (row[2] as string | null) ?? null,
          (row[3] as string | null) ?? null,
          (row[4] as string | null) ?? null,
        ]);
      await this.setAcctField("entities_json", JSON.stringify(rows));
    } catch {
      /* 忽略 */
    }
  }

  private async persistSession(client: TelegramClient): Promise<void> {
    try {
      const saved = client.session.save();
      if (typeof saved === "string" && saved) await this.setAcctField("session", saved);
    } catch {
      /* ignore */
    }
  }

  // ---------------------------------------------------------------- 账号

  private async sendCode(body: { apiId?: number; apiHash?: string; phone?: string }) {
    const apiId = Number(body.apiId ?? (await this.credentials()).apiId ?? 0);
    const apiHash = String(body.apiHash ?? (await this.credentials()).apiHash ?? "");
    const phone = String(body.phone ?? "").trim();
    if (!apiId || !apiHash) throw new Error("请填写应用 ID 和应用密钥（在 my.telegram.org 申请）");
    if (!phone) throw new Error("请填写手机号（含国家码，例如 +8613800000000）");

    await this.setAcctField("api_id", String(apiId));
    await this.setAcctField("api_hash", apiHash);

    const knownDc = Number((await this.getAcctField("dc")) ?? 0) || null;
    const { result, session } = await this.withLoginClient(
      { apiId, apiHash },
      async (client) => {
        const sent = (await client.sendCode({ apiId, apiHash }, phone)) as {
          phoneCodeHash: string;
          isCodeViaApp: boolean;
        };
        return { result: sent, session: String(client.session.save() ?? "") };
      },
      { retryOnMigrate: true, startDc: knownDc },
    );

    const pending: PendingLogin = {
      apiId,
      apiHash,
      phone,
      phoneCodeHash: result.phoneCodeHash,
      session,
      stage: "code",
      at: Date.now(),
    };
    await this.setAcctField("pending_json", JSON.stringify(pending));
    return {
      stage: "code" as const,
      hint: result.isCodeViaApp ? "验证码已发送到 Telegram App" : "验证码已通过短信发送",
      dc: session ? Number((await this.getAcctField("dc")) ?? 0) || undefined : undefined,
    };
  }

  private async signIn(body: { code?: string; password?: string }) {
    const pendingJson = await this.getAcctField("pending_json");
    const pending: PendingLogin | null = pendingJson ? (JSON.parse(pendingJson) as PendingLogin) : null;
    if (!pending) throw new Error("请先获取验证码");
    if (Date.now() - pending.at > 10 * 60_000) {
      await this.setAcctField("pending_json", null);
      throw new Error("验证码已过期，请重新获取");
    }

    const outcome = await this.withLoginClient(
      { apiId: pending.apiId, apiHash: pending.apiHash, session: pending.session },
      async (client): Promise<{ kind: "password" } | { kind: "ok"; me: { id: string; username: string | null; firstName: string } }> => {
        if (body.code) {
          try {
            const auth = await client.invoke(
              new Api.auth.SignIn({
                phoneNumber: pending.phone,
                phoneCodeHash: pending.phoneCodeHash,
                phoneCode: String(body.code).trim(),
              }),
            );
            if (auth.className === "auth.AuthorizationSignUpRequired") {
              throw new Error("该号码还没有 Telegram 账号，请先在官方客户端注册");
            }
          } catch (error) {
            const message = errorMessage(error);
            if (message === "SESSION_PASSWORD_NEEDED") {
              await this.setAcctField("pending_json", JSON.stringify({
                ...pending,
                stage: "password",
                session: String(client.session.save() ?? pending.session),
              } satisfies PendingLogin));
              return { kind: "password" };
            }
            if (message === "PHONE_CODE_INVALID") throw new Error("验证码不正确");
            if (message === "PHONE_CODE_EXPIRED") throw new Error("验证码已过期，请重新获取");
            throw error;
          }
        } else if (body.password) {
          const passwordInfo = await client.invoke(new Api.account.GetPassword());
          const check = await PasswordModule.computeCheck(passwordInfo, String(body.password));
          await client.invoke(new Api.auth.CheckPassword({ password: check }));
        } else {
          throw new Error("请填写验证码或两步验证密码");
        }

        const me = (await client.getMe()) as Api.User;
        const info = {
          id: String(me.id),
          username: me.username ?? null,
          firstName: me.firstName || me.username || "Telegram 用户",
        };
        await this.setAcctField("session", String(client.session.save() ?? ""));
        await this.setAcctField("me_json", JSON.stringify(info));
        return { kind: "ok", me: info };
      },
      { retryOnMigrate: false },
    );

    if (outcome.kind === "password") return { stage: "password" as const };

    await this.setAcctField("phone", pending.phone);
    await this.setAcctField("pending_json", null);
    await this.setAcctField("last_error", null);
    await this.resetTriggerCursor();
    return { ok: true as const, me: outcome.me };
  }

  /**
   * 管理员 ID 默认 = 当前登录的 Telegram 账号。
   * 只在「从没设置过」时填一次（用 kv 标记），用户日后手动清空不会被覆盖。
   */
  private async applyDefaultAdminId(meId: string): Promise<void> {
    const settings = await this.store.getSettings();
    const should = shouldAutoFillAdminId({
      adminUserId: settings.adminUserId,
      meId,
      alreadyAutoFilled: Boolean(await this.store.getKv("adminId:autoFilled")),
    });
    if (!should) return;
    await this.store.saveSettings({ adminUserId: String(meId) });
    await this.store.setKv("adminId:autoFilled", "1");
    await this.store.addLog({
      taskId: null,
      taskName: null,
      at: Date.now(),
      ok: true,
      level: "info",
      message: `管理员 ID 已设为当前账号（${meId}）`,
      source: "system",
      detail: "只有这个账号发出的消息指令会生效；可在设置里修改。",
    });
  }

  private async logout() {
    const session = await this.session();
    if (session) {
      try {
        const creds = await this.credentials();
        if (creds.apiId && creds.apiHash) {
          const client = createTgClient({ apiId: Number(creds.apiId), apiHash: creds.apiHash, session });
          await client.connect();
          await client.invoke(new Api.auth.LogOut()).catch(() => undefined);
          await client.disconnect().catch(() => undefined);
        }
      } catch {
        /* 忽略：本地登出优先 */
      }
    }
    await this.dropClient(this.store.getAccountId());
    // 管理员 ID 与当前账号相同时一并清空，便于切换账号后重新回填。
    const meJson = await this.getAcctField("me_json");
    const me: AccountInfo["me"] = meJson ? (JSON.parse(meJson) as AccountInfo["me"]) : null;
    const settings = await this.store.getSettings();
    if (me?.id && settings.adminUserId && settings.adminUserId === me.id) {
      await this.store.saveSettings({ adminUserId: "" });
      await this.store.deleteKv("adminId:autoFilled");
    }
    await this.setAcctField("session", null);
    await this.setAcctField("me_json", null);
    await this.setAcctField("pending_json", null);
    await this.resetTriggerCursor();
    return { ok: true };
  }

  private async resolvePeer(query: string) {
    const raw = query.trim();
    if (!raw) throw new Error("目标为空");
    return this.withClient(this.store.getAccountId(), async (client) => {
      const entity = await resolveEntity(client, raw);
      return { peer: await this.toTarget(client, entity, raw) };
    });
  }

  /**
   * 只读：拉取群组/频道/用户的近期消息（不发消息、不点按钮、不测速）。
   * 只返回 id / 时间 / 正文 / 发送者，媒体内容不拉取；顺序按 id 升序（时间顺序）。
   */
  private async fetchHistory(peer: string, limit: number) {
    return this.withClient(this.store.getAccountId(), async (client) => {
      const entity = await resolveEntity(client, peer);
      const target = await this.toTarget(client, entity, peer);
      const messages = (await client.getMessages(entity as never, { limit })) as Api.Message[];
      return {
        ok: true,
        peer: { id: target.id, title: target.title, username: target.username },
        messages: normalizeHistoryMessages(messages),
      };
    });
  }

  // ---------------------------------------------------------------- 触发消息

  /** 最近一次登记的目标（30 分钟内有效） */
  private async rememberedTarget(): Promise<Target | null> {
    const stored = await this.store.getJson<{ target?: Target; at?: number } | null>(KV_TRIGGER_TARGET, null);
    if (!stored?.target || !stored.at) return null;
    if (Date.now() - stored.at > 30 * 60_000) return null;
    return stored.target;
  }

  private async resetTriggerCursor(): Promise<void> {
    const settings = await this.store.getSettings();
    await this.store.deleteKv(`trigger:cursor:${settings.controlChat || "self"}`);
  }

  /**
   * 轮询控制会话的新触发消息。返回未处理的新消息数（预算不够只处理一部分时 >0，
   * tickAccount 把它计入 remaining，调用方就知道要再调一轮，别误以为做完了）。
   * now：本轮 tick 的时间戳，D1 版由 finally 合并写回 lastPoll 用。
   */
  private async pollTriggers(client: TelegramClient, logs: string[], now: number): Promise<number> {
    const settings = await this.store.getSettings();
    const controlRef = settings.controlChat || "self";
    const entity = await resolveEntity(client, controlRef);
    const cursorKey = `trigger:cursor:${controlRef}`;
    const cursor = Number(await this.store.getKv(cursorKey) ?? 0);
    // 每轮新开一批：上一轮没写完的 lastEvent 不带进来
    this.pendingLastEvent = null;
    // 日志缓冲 + 延迟写 lastEvent + 合并写回（DO 与 D1 一致）：
    // 轮询里的日志先攒进 logBuffer，结束时（finally）一次 addLogs 插多行；
    // lastEvent 只记内存，结束时与 lastPoll/游标一次 setKvMany 写回。
    // 游标也只在 finally 写（处理中途被驱逐会重处理，建任务有指纹去重、
    // 删除/开关幂等，只有“立即执行”可能重跑一次，见 CHANGELOG）。
    let newCursor = cursor;
    try {
      this.logBuffer = [];
      // 一次只取最近 20 条会在「短时间内发很多指令」时静默丢消息：
      // 游标直接跳到最高 id，中间那些没被看到的就再也不会被处理了。
      // 这里按批往回翻，直到取够 5 批（500 条）或已经翻到游标之前。
      const batchSize = TRIGGER_FETCH_BATCH;
      const collected: Api.Message[] = [];
      let offsetId = 0;
      for (let batch = 0; batch < TRIGGER_FETCH_BATCHES; batch += 1) {
        const page = (await client.getMessages(entity as never, {
          limit: batchSize,
          ...(offsetId ? { offsetId } : {}),
        })) as Api.Message[];
        if (!page.length) break;
        collected.push(...page);
        const lowest = Math.min(...page.map((message) => message.id));
        if (!cursor || lowest <= cursor) break;
        offsetId = lowest;
      }
      const messages = dedupeById(collected);
      if (!messages.length) return 0;
      const highest = Math.max(cursor, ...messages.map((message) => message.id));

      if (!cursor) {
        // 首次只记录游标，避免把历史消息全解析一遍（游标由 finally 合并写回）
        newCursor = highest;
        // 把这件事写进日志：否则"发了配置却没反应"会让人以为是坏了
        await this.writeLog({
          taskId: null,
          taskName: null,
          at: Date.now(),
          ok: true,
          level: "info",
          message: `触发器首次轮询：记录游标 #${highest}（之前的历史消息不处理，从现在开始监听）`,
          source: "system",
          detail: `控制会话：${controlRef}\n如果刚刚发过配置，请再发一次。`,
        });
        const greetKey = `trigger:greeted:${controlRef}`;
        if (!await this.store.getKv(greetKey)) {
          await this.store.setKv(greetKey, "1");
          await client
            .sendMessage(entity as never, { message: welcomeText(settings.triggerPrefix ?? ""), parseMode: false })
            .catch(() => undefined);
        }
        return 0;
      }

      const fresh = messages.filter((message) => message.id > cursor).sort((a, b) => a.id - b.id);
      if (fresh.length) {
        logs.push(`本轮轮询：${fresh.length} 条新消息（cursor=${cursor} → ${highest}）`);
        await this.writeLog({
          taskId: null,
          taskName: null,
          at: Date.now(),
          ok: true,
          level: "info",
          message: `触发器轮询：发现 ${fresh.length} 条新消息`,
          source: "system",
          detail: fresh.map((item) => `#${item.id} ${(item.message ?? "").slice(0, 80).replace(/\n/g, " / ") || "（无文本）"}`).join("\n"),
        });
      }
      // 一条触发消息约 0 条查询（日志攒到最后批量写，lastEvent 一批只写一次；
      // 记住的目标只读一次）。预算不够时只处理一部分，游标只推到已处理的那条，
      // 剩下的下次轮询再处理（D1 每调用 50 条查询；DO 无预算，不受影响）。
      // 预留 TRIGGER_BUDGET_RESERVE 条：收尾批量写日志 + 合并写 lastPoll/游标/lastEvent
      // + afterUse + 最终 earliestNextRun 约 3 条，剩下的给重指令留余量。
      // 重指令（建任务等）如果单条就超预算，bump 会抛错、该条不计入已处理、下轮重试，不会丢消息。
      const processedIds: number[] = [];
      for (const message of fresh) {
        if (this.store.remainingBudget() < TRIGGER_BUDGET_RESERVE) break;
        try {
          await this.handleTriggerMessage(client, entity, message, settings, logs);
        } catch (error) {
          await this.writeLog({
            taskId: null,
            taskName: null,
            at: Date.now(),
            ok: false,
            level: "error",
            message: `处理触发消息失败：${errorMessage(error)}`,
            detail: (message.message ?? "").slice(0, 500),
            source: "trigger",
          });
        }
        processedIds.push(message.id);
      }
      newCursor = processedIds.length ? Math.max(cursor, ...processedIds) : cursor;
      // 没处理完的新消息数：预算不够时 >0，调用方据此再调一轮
      return fresh.length - processedIds.length;
    } finally {
      // 收尾（finally：正常、提前返回、预算中断、抛错都走这里，lastEvent 不丢）：
      // 1）缓冲的日志一次 addLogs 插多行；2）lastPoll + 游标 + lastEvent 一条 setKvMany 写完。
      // 写回是 best-effort：失败不掩盖主流程（游标没推，消息下轮会重处理，不丢）。
      try {
        if (this.logBuffer && this.logBuffer.length) {
          const buffered = this.logBuffer;
          this.logBuffer = null;
          await this.store.addLogs(buffered);
        }
      } catch {
        /* 日志丢了不影响主流程 */
      }
      try {
        const kvEntries = [{ key: "trigger:lastPoll", value: String(now) }];
        if (newCursor !== cursor) kvEntries.push({ key: cursorKey, value: String(newCursor) });
        if (this.pendingLastEvent) {
          kvEntries.push({ key: "trigger:lastEvent", value: JSON.stringify(this.pendingLastEvent) });
          this.pendingLastEvent = null;
        }
        await this.store.setKvMany(kvEntries);
      } catch (error) {
        // 写回失败不掩盖主流程（游标没推，消息下轮会重处理，不丢），但要记一笔警告，
        // 否则 lastPoll/游标/lastEvent 丢了都没人知道。
        // 直接调 store.addLog，不走 writeLog：这时 logBuffer 正要被清空，写进缓冲会被丢掉。
        try {
          await this.store.addLog({
            taskId: null,
            taskName: null,
            at: Date.now(),
            ok: false,
            level: "warn",
            message: `触发器收尾写回失败：${errorMessage(error)}`,
            detail: "lastPoll / 游标 / lastEvent 没保存，消息下轮会重处理，不丢",
            source: "system",
          });
        } catch {
          /* 警告日志也写不进去就算了（库本身不可用），绝不能从 finally 里抛错 */
        }
      }
      this.logBuffer = null;
      this.pendingLastEvent = null;
    }
  }

  private async handleTriggerMessage(
    client: TelegramClient,
    entity: Parameters<TelegramClient["sendMessage"]>[0],
    message: Api.Message,
    settings: Settings,
    logs: string[],
  ): Promise<void> {
    const raw = (message.message ?? "").trim();
    // 超长消息不解析（保护 CPU，也避免被拿来塞垃圾）
    const text = raw.slice(0, 2000);

    /** 识别链路，最后统一写进日志 detail —— 出了问题能一眼看到卡在哪 */
    const trace: string[] = [
      `消息 #${message.id}：${text.replace(/\n/g, " / ").slice(0, 120) || "（无文本）"}`,
      `out=${String(message.out)} senderId=${String(message.senderId ?? "—")} 控制会话=${settings.controlChat || "self"}`,
    ];
    const record = async (ok: boolean, summary: string, extra?: { taskId?: number; taskName?: string }) => {
      const event = {
        at: Date.now(),
        ok,
        message: summary,
        detail: trace.join("\n"),
      };
      // lastEvent 只记内存，pollTriggers 结束时（finally）一次合并写回——
      // 中途抛错也不丢；只有轮询中途实例被驱逐才会丢（界面上的“最近一次触发事件”，可重建）。
      this.pendingLastEvent = event;
      // 日志：D1 轮询中先攒进缓冲，结束时一次 addLogs；DO 版直接写库。
      await this.writeLog({
        source: "trigger",
        taskId: extra?.taskId ?? null,
        taskName: extra?.taskName ?? null,
        at: Date.now(),
        ok,
        level: ok ? "info" : "warn",
        message: summary,
        detail: trace.join("\n"),
      });
    };

    if (!text || isOwnReply(text)) return;

    if (settings.adminUserId && String(message.senderId ?? "") && String(message.senderId) !== settings.adminUserId) {
      trace.push(`忽略：发送者不是配置的 adminUserId（${settings.adminUserId}）`);
      await record(false, "忽略触发消息：发送者不是管理员");
      return;
    }

    // 控制会话是群组、又没配 adminUserId 时，只认「自己发的」消息。
    // 否则群里任何人都能让我这个账号往任意聊天发消息（等于开放了发信能力）。
    const controlChatIsSelf = (settings.controlChat || "self") === "self";
    if (!controlChatIsSelf && !settings.adminUserId && !message.out) {
      trace.push("忽略：群聊控制会话未配 adminUserId，且消息不是本人发的");
      await record(false, "忽略触发消息：群聊里请到设置填 adminUserId");
      return;
    }

    const reply = async (body: string) => {
      await client.sendMessage(entity as never, { message: body, parseMode: false });
    };

    // 机器人自己发来的消息不当作配置（控制会话设成机器人的聊天时，别把欢迎语当指令）
    if (!message.out) {
      const sender = message.senderId as { className?: string; userId?: unknown } | undefined;
      if (sender?.className === "PeerUser") {
        try {
          const entityOfSender = await client.getEntity(sender as never);
          if ((entityOfSender as unknown as { bot?: boolean }).bot) return;
        } catch {
          /* 拿不到就按普通消息处理 */
        }
      }
    }

    // 可选前缀：设置后只有以它开头的消息才当配置解析，收藏夹里的随手笔记不会被误处理
    const prefix = (settings.triggerPrefix ?? "").trim();
    let messageText = text;
    if (prefix) {
      const stripped = stripTriggerPrefix(text, prefix);
      if (stripped.matched) {
        messageText = stripped.rest;
        trace.push(`命中前缀「${prefix}」，去掉后：${messageText.slice(0, 80)}`);
      } else {
        // 没前缀：只允许"纯转发/分享"用来登记目标，其余静默忽略
        const hinted = await this.inferTarget(client, entity, message);
        if (hinted) {
          await this.store.setJson(KV_TRIGGER_TARGET, { target: hinted, at: Date.now() });
          trace.push(`未带前缀，但有可识别来源 → 登记目标：${JSON.stringify(hinted)}`);
          await record(true, `登记目标（无前缀）：${hinted.title || (hinted.username ? `@${hinted.username}` : hinted.id)}`);
        } else if (findTimeToken(tokenize(text))) {
          trace.push(`看起来像配置但缺少前缀「${prefix}」→ 忽略`);
          await record(false, `忽略：消息缺少前缀「${prefix}」`);
          // 只在"看起来像配置"时提醒，且 10 分钟最多一次，避免刷屏
          const lastHint = Number(await this.store.getKv("trigger:prefixHintAt") ?? 0);
          if (Date.now() - lastHint > 10 * 60_000) {
            await this.store.setKv("trigger:prefixHintAt", String(Date.now()));
            await client
              .sendMessage(entity as never, {
                message: `需要在开头加「${prefix}」，例如：\n${prefix} ${text.slice(0, 120)}`,
                parseMode: false,
              })
              .catch(() => undefined);
          }
        }
        return;
      }
      if (!messageText) return;
    }

    // 这条消息自己指向谁（转发来源 / 联系人卡片 / 链接 / 回复的那条 / 最近的上一条）
    const hint = await this.inferTarget(client, entity, message);
    const hasTime = Boolean(findTimeToken(tokenize(messageText)));

    // 没有时间表达式 → 当成「目标登记」。
    // 常见操作是「先转发机器人到收藏夹，再单独发一条 9.30 签到」；
    // 纯转发不回复（否则机器人每转发一次都要被数落一顿），只在完全看不懂时才提示。
    if (!hasTime) {
      if (hint) {
        await this.store.setJson(KV_TRIGGER_TARGET, { target: hint, at: Date.now() });
        logs.push(`登记目标：${hint.username ?? hint.title ?? hint.id}`);
        trace.push(`没有时间表达式 → 只登记目标：${JSON.stringify(hint)}`);
        await record(true, `登记目标：${hint.title || (hint.username ? `@${hint.username}` : hint.id)}`);
        return;
      }
      trace.push("没有时间表达式，也没有可识别的目标 → 回帮助文本");
      await record(false, "触发消息无法识别（缺时间/目标），已回帮助文本");
      await reply(helpText(settings.triggerPrefix ?? ""));
      return;
    }

    // rememberedTarget 只读一次：forwarded 与 trace 各读一次是纯浪费（每条消息 1 条查询）
    const rememberedTarget = await this.rememberedTarget();
    const ctx: TriggerContext = {
      defaultTarget: settings.defaultTarget || undefined,
      forwarded: hint ?? rememberedTarget,
      sourceChat: await this.toTarget(client, entity, ""),
    };
    trace.push(
      `上下文：推断目标=${hint ? JSON.stringify(hint) : "无"} 记住的目标=${rememberedTarget ? "有" : "无"} 默认目标=${settings.defaultTarget || "无"}`,
    );

    const parsed = parseTrigger(messageText, ctx);
    if (!parsed.ok) {
      trace.push(`解析失败：${parsed.error}`);
      await record(false, `触发解析失败：${parsed.error}`);
      await reply(`⚠️ ${parsed.error}`);
      return;
    }

    const result = parsed.result;
    logs.push(`${result.kind}: ${messageText.slice(0, 60)}`);

    switch (result.kind) {
      case "help": {
        trace.push("命令：帮助");
        await record(true, "触发器命令：帮助");
        await reply(helpText(settings.triggerPrefix ?? ""));
        return;
      }
      case "list": {
        trace.push("命令：列表");
        await record(true, "触发器命令：列表");
        await reply(await this.renderTaskList());
        return;
      }
      case "create": {
        const incoming = result.task as TaskInput;
        trace.push(
          `推断到的目标：${
            hint
              ? `${hint.title ?? ""}${hint.title && hint.username ? " " : ""}${hint.username ? `@${hint.username}` : ""}（kind=${hint.kind} id=${hint.id}${
                  hint.accessHash ? " hash=有" : ""
                }）`.trim()
              : "无（使用记住的目标 / 默认目标）"
          }`,
        );
        const enriched = await this.enrichTarget(
          client,
          { ...incoming, nameAuto: result.autoName === true },
          trace,
        );
        // 自动生成的名字要用「补全后的目标」重新算，否则会留下旧标签（@username）
        if (result.autoName) {
          const regenerated = defaultName(enriched.target, "", enriched.steps ?? []);
          if (regenerated !== enriched.name) {
            trace.push(`任务名按最终目标生成：${regenerated}（原：${enriched.name}）`);
            enriched.name = regenerated;
          }
          enriched.nameAuto = true;
        } else {
          enriched.nameAuto = false;
        }
        trace.push(`目标最终：${JSON.stringify(enriched.target)}`);
        trace.push(`调度：${JSON.stringify(enriched.schedule)}`);
        trace.push(`动作：${(enriched.steps ?? []).map((step) => step.type).join(" → ")}`);

        const { task, created } = await this.createTask(enriched);
        trace.push(created ? `建任务：#${task.id}` : `已存在相同任务 #${task.id}，未重复创建`);
        await record(true, created ? `触发器创建任务 #${task.id}` : `跳过重复任务（已有 #${task.id}）`, {
          taskId: task.id,
          taskName: task.name,
        });
        await reply(
          created
            ? `✅ 已创建任务 #${task.id}\n「${task.name}」\n⏰ 下次执行 ${formatInTimezone(task.nextRunAt, settings.timezone)}（UTC${settings.timezone >= 0 ? "+" : ""}${settings.timezone}）\n${result.explanation ?? ""}`
            : `ℹ️ 已有相同任务 #${task.id}「${task.name}」，没有重复创建\n要重建的话，先发「删除 ${task.id}」`,
        );
        return;
      }
      case "run":
      case "enable":
      case "disable":
      case "delete": {
        const found = await this.store.findTask(result.argument ?? "");
        if (!found) {
          await reply(`❌ 没找到任务「${result.argument ?? ""}」，发「列表」看看`);
          return;
        }
        if (result.kind === "delete") {
          trace.push(`命令：删除任务 #${found.id}`);
          await record(true, `触发器命令：删除 #${found.id}`, { taskId: found.id, taskName: found.name });
          await this.store.deleteTask(found.id);
          await reply(`🗑️ 已删除任务 #${found.id}「${found.name}」`);
          return;
        }
        if (result.kind === "enable" || result.kind === "disable") {
          await this.updateTask(found.id, { enabled: result.kind === "enable" });
          await reply(
            `${result.kind === "enable" ? "✅" : "⏸️"} 任务 #${found.id}「${found.name}」已${result.kind === "enable" ? "启用" : "停用"}`,
          );
          return;
        }
        const task = (await this.store.getTask(found.id))!;
        trace.push(`命令：立即执行任务 #${task.id}`);
        await record(true, `触发器命令：立即执行 #${task.id}`, { taskId: task.id, taskName: task.name });
        const [log] = await this.runTasks([task], client, { manual: true });
        await reply(`${log.ok ? "✅" : "❌"} 任务 #${task.id} ${task.name}\n${log.message}${log.detail ? `\n${log.detail}` : ""}`.slice(0, 3500));
        return;
      }
      default:
        await reply(helpText(settings.triggerPrefix ?? ""));
    }
  }

  /**
   * 推断签到目标。用户表达"发给谁"的方式，按可信度从高到低：
   *
   *  1. 转发 / 分享机器人消息 → fwd_from.from_id
   *  2. **回复了机器人的某条消息** → 取被回复消息的发送者 / 转发来源
   *  3. 分享联系人卡片 → media.user_id
   *  4. 内联机器人 → via_bot_id
   *  5. 文本或网页预览里的 t.me 链接
   *
   * 注：触发消息本身的发送者永远是账号自己，所以只在"被回复的消息"里才看发送者。
   */
  private async inferTarget(
    client: TelegramClient,
    chat: Parameters<TelegramClient["sendMessage"]>[0],
    message: Api.Message,
  ): Promise<Target | null> {
    const direct = await this.resolveHint(client, messageTargetHint(message as unknown as MessageLike, { allowSender: false }));
    if (direct) return direct;

    const replyTo = (message as unknown as {
      replyTo?: { replyToMsgId?: number; replyToPeerId?: unknown };
    }).replyTo;

    // 跨会话回复（新版 layer 才有 reply_to_peer_id）
    if (replyTo?.replyToPeerId) {
      try {
        const entity = await client.getEntity(replyTo.replyToPeerId as never);
        return await this.toTarget(client, entity, "");
      } catch {
        /* 忽略，继续走同会话回复 */
      }
    }

    // 同会话回复：把被回复的那条消息捞出来再推断一次
    const repliedId = replyTo?.replyToMsgId;
    if (repliedId) {
      try {
        const [replied] = (await client.getMessages(chat as never, { ids: [repliedId] })) as Api.Message[];
        if (replied) {
          const fromReplied = await this.resolveHint(
            client,
            messageTargetHint(replied as unknown as MessageLike, { allowSender: true }),
          );
          if (fromReplied) return fromReplied;
        }
      } catch {
        /* 忽略 */
      }
    }

    return null;
  }

  /** 把纯函数里提取出的线索换成真实实体 */
  private async resolveHint(client: TelegramClient, hint: MessageTargetHint | null): Promise<Target | null> {
    if (!hint) return null;

    if (hint.kind === "peer") {
      const peer = hint.peer;
      const instance =
        peer.className === "PeerChannel"
          ? new Api.PeerChannel({ channelId: peer.channelId as never })
          : peer.className === "PeerChat"
            ? new Api.PeerChat({ chatId: peer.chatId as never })
            : new Api.PeerUser({ userId: peer.userId as never });
      try {
        const entity = await client.getEntity(instance as never);
        // 线索来自"发送者"时，只认机器人/频道/群，避免群里随便谁的发言都被当成目标
        if (hint.fromSender && peer.className === "PeerUser") {
          const isBot = Boolean((entity as unknown as { bot?: boolean }).bot);
          if (!isBot) return null;
        }
        return await this.toTarget(client, entity, "");
      } catch {
        return null;
      }
    }

    if (hint.kind === "username") {
      try {
        const entity = await client.getEntity(hint.value);
        return await this.toTarget(client, entity, hint.value);
      } catch {
        return { kind: "user", id: hint.value, username: hint.value };
      }
    }

    return null;
  }

  private async toTarget(client: TelegramClient, entity: unknown, fallback: string): Promise<Target> {
    const anyEntity = entity as {
      className?: string;
      id?: unknown;
      title?: string;
      firstName?: string;
      lastName?: string;
      username?: string;
      accessHash?: unknown;
    };
    const kind = anyEntity.className === "Channel" ? "channel" : anyEntity.className === "Chat" ? "chat" : "user";
    let id = String(anyEntity.id ?? fallback);
    try {
      id = (await client.getPeerId(entity as never)) ?? id;
    } catch {
      /* ignore */
    }
    // 显示名：群/频道用 title，用户用「名 + 姓」，都没有才退回 username / id
    const displayName =
      anyEntity.title ||
      [anyEntity.firstName, anyEntity.lastName].filter(Boolean).join(" ").trim() ||
      undefined;
    const title = displayName;
    const accessHash = anyEntity.accessHash;
    return {
      kind,
      id,
      title,
      username: anyEntity.username,
      peerKind: classifyPeer(entity),
      // 记下 access_hash：私有机器人/用户没有 username 时，只能靠它解析
      ...(accessHash !== undefined && accessHash !== null ? { accessHash: String(accessHash) } : {}),
    };
  }

  private async renderTaskList(): Promise<string> {
    const tasks = await this.store.listTasks();
    if (!tasks.length) return "📋 还没有任务。在收藏夹发一条 `9.30 签到` 试试，或发「帮助」看写法。";
    const settings = await this.store.getSettings();
    const lines = tasks.map((task) => {
      const status = task.enabled ? "✅" : "❌";
      const target = task.target.username ? `@${task.target.username}` : task.target.title || task.target.id;
      const next = formatInTimezone(task.nextRunAt, settings.timezone);
      const last = task.lastResult === "ok" ? "上次成功" : task.lastResult === "fail" ? "上次失败" : "还没执行过";
      const kind = PEER_KIND_TEXT[task.target.peerKind ?? ""] ?? "";
      return `${status} #${task.id} ${task.name}\n   ${kind ? `${kind} ` : ""}${target} · 下次 ${next} · ${last}`;
    });
    return ["📋 任务列表", ...lines, "", "管理：立即 3 · 开启 3 · 关闭 3 · 删除 3"].join("\n");
  }

  // ---------------------------------------------------------------- 任务

  /**
   * 补全目标任务信息。
   *
   * DSL 里从链接（`https://t.me/xxx_bot 9.30 签到`）解析出来的目标只有 username，
   * 没有显示名 —— 直接建任务就会得到 `@xxx_bot 签到` 这种名字。
   * 这里用当前连接把实体解析出来，补上 title / access_hash。
   */
  private async enrichTarget(client: TelegramClient, input: TaskInput, trace?: string[]): Promise<TaskInput> {
    const label = input.target.username ? `@${input.target.username}` : input.target.id;
    if (input.target.title && input.target.accessHash && input.target.peerKind) {
      trace?.push(`目标已带显示名：${input.target.title}（${label}，${input.target.peerKind}）`);
      return input;
    }
    try {
      trace?.push(`解析目标 ${label} …`);
      const entity = await resolveEntity(client, input.target);
      const target = await this.toTarget(client, entity, input.target.id);
      trace?.push(
        `解析成功：kind=${target.kind} id=${target.id} title=${target.title ?? "（无）"} ` +
          `username=${target.username ? `@${target.username}` : "（无）"} access_hash=${target.accessHash ? "有" : "无"}`,
      );
      const merged: Target = { ...target, id: target.id || input.target.id };
      const autoRename = shouldAutoRename({
        name: input.name,
        nameAuto: input.nameAuto,
        target: input.target,
        steps: input.steps ?? [],
      });
      const name = autoRename ? renameForTarget(input.name, input.target, merged) : input.name;
      if (name !== input.name) trace?.push(`任务名同步：${input.name} → ${name}（原名由系统生成）`);
      return { ...input, name, target: merged };
    } catch (error) {
      // 不再静默丢弃：把原因写进日志
      trace?.push(`解析失败：${errorMessage(error)}`);
      return input;
    }
  }

  /** 建任务；如果已存在完全相同的任务则不重复创建（返回 existing） */
  private async createTask(input: TaskInput): Promise<{ task: Task; created: boolean }> {
    const settings = await this.store.getSettings();
    const now = Date.now();
    const normalized = normalizeTaskInput(input);
    // 空目标无法执行，创建时直接拒绝。
    if (!normalized.target.id && !normalized.target.username) {
      throw new Error("任务目标不能为空（填 @username / 数字 id，或先用「解析」确认）");
    }

    const duplicate = await this.store.findDuplicateTask(normalized);
    if (duplicate) {
      await this.store.addLog({
        taskId: duplicate.id,
        taskName: duplicate.name,
        at: now,
        ok: true,
        level: "warn",
        message: `跳过重复任务：#${duplicate.id} 已存在相同的目标/调度/动作`,
        source: "system",
        detail: "同一条触发配置发多次、或反复点保存，都会产生重复任务；这里直接复用已有的。",
      });
      return { task: duplicate, created: false };
    }

    const nextRunAt = normalized.enabled ? computeNextRun(normalized.schedule, now, settings.timezone) : null;
    await this.store.recordEvent(`task_created:${normalized.source ?? "ui"}`);
    return { task: await this.store.createTask(normalized, now, nextRunAt), created: true };
  }

  private async updateTask(id: number, patch: Partial<TaskInput>): Promise<Task | null> {
    const settings = await this.store.getSettings();
    const current = await this.store.getTask(id);
    if (!current) return null;
    // renewal 子对象要深合并，不能整体替换：面板编辑器保存时只发它有字段的那几项
    // （空 menuPath 不发），整体替换会把没发出来的字段悄悄清掉
    // （0.27.9 的教训：钟陌 menuPath: [] 被一次只改步骤的保存抹掉，续费又走了 /shop）。
    // patch.renewal 为 null 时照常清空（编辑器用它表示“去掉续费”）；没传则保留原值。
    const merged = {
      ...current,
      ...patch,
      ...(patch.renewal && typeof patch.renewal === "object"
        ? { renewal: { ...(current.renewal ?? {}), ...patch.renewal } }
        : {}),
    } as Task;
    const normalized = normalizeTaskInput(merged);
    // PATCH 发了续费对象、原任务也有续费，归一化后续费却没了：说明合并后的续费
    // 不完整（没按钮）被 normalizeRenewal 丢了。别静默丢配置，打一条日志。
    if (patch.renewal && typeof patch.renewal === "object" && current.renewal && !normalized.renewal) {
      await this.store
        .addLog({
          taskId: id,
          taskName: current.name,
          at: Date.now(),
          ok: false,
          level: "warn",
          message: "续费配置被丢弃：保存的续费没有按钮",
          detail: "这次保存把续费清掉了（发来的续费对象没有按钮）；如要恢复，请在编辑器里填好续费按钮再保存",
        })
        .catch(() => {});
    }
    if (!normalized.target.id && !normalized.target.username) {
      throw new Error("任务目标不能为空（填 @username / 数字 id，或先用「解析」确认）");
    }
    // 按句柄/话题从现有目标补齐 accessHash 等元信息。
    const known = [current.target, ...(current.targets ?? [])];
    const target = preserveTargetMeta(normalized.target, known);
    const targets = normalized.targets?.map((item) => preserveTargetMeta(item, known));
    const scheduleChanged =
      JSON.stringify(current.schedule) !== JSON.stringify(normalized.schedule) || current.enabled !== normalized.enabled;
    const nextRunAt = normalized.enabled
      ? scheduleChanged || !current.nextRunAt
        ? computeNextRun(normalized.schedule, Date.now(), settings.timezone)
        : current.nextRunAt
      : null;
    const updated = await this.store.updateTask(id, { ...normalized, target, targets, nextRunAt }, Date.now());
    // 停用的任务被重新启用时，把连续失败计数清零：不然 failStreak 还留在阈值上，
    // 刚启用、再失败一次就立刻又被自动暂停，等于白开。
    // （auto-pause 本身只在 run 后检查，decideRun 不查 failStreak，所以重新启用
    // 当晚就能跑；清零是给它一个完整的新 3 次机会。）
    if (updated && !current.enabled && normalized.enabled) {
      await this.store.resetFailStreak(id, Date.now());
      updated.failStreak = 0;
    }
    return updated;
  }

  // ---------------------------------------------------------------- 实时进度

  private liveKey(taskId: number): string {
    return `live:${taskId}`;
  }

  /** 实时状态只用于展示，写入失败不能影响任务执行 */
  private async persistLive(taskId: number, run: LiveRun): Promise<void> {
    try {
      await this.store.setJson(this.liveKey(taskId), run);
    } catch {
      /* ignore */
    }
  }

  /** 当前任务的实时进度；结束超过保留期或实例被回收的执行会被清理 */
  private async liveOf(taskId: number): Promise<LiveRun | null> {
    const inMemory = this.liveRuns.get(taskId);
    let run = inMemory ?? await this.store.getJson<LiveRun | null>(this.liveKey(taskId), null);
    if (!run) return null;
    // 内存里没有但存储里还是 running：可能是上一个实例已回收，也可能只是这次轮询
    // 落到了另一个实例（Workers 会把请求分到不同实例，内存里的进度别的实例看不到）。
    // 只有当最后一次进度也很久没更新时，才判定执行已死；刚更新过说明还在别的实例里跑。
    if (run.running && !inMemory) {
      const lastAt = run.events.length ? run.events[run.events.length - 1].at : run.startedAt;
      if (Date.now() - lastAt > LIVE_STALE_MS) {
        const at = Date.now();
        const stale: LiveEvent = { at, level: "error", message: "执行中断（实例被回收）" };
        run = {
          ...run,
          running: false,
          finishedAt: at,
          ok: false,
          message: stale.message,
          events: [...run.events, stale].slice(-LIVE_MAX_EVENTS),
        };
        this.liveRuns.set(taskId, run);
        await this.persistLive(taskId, run);
      }
    }
    if (!run.running && run.finishedAt && Date.now() - run.finishedAt > LIVE_KEEP_MS) {
      this.liveRuns.delete(taskId);
      await this.store.deleteKv(this.liveKey(taskId));
      return null;
    }
    return run;
  }

  private async startLive(task: Task, persist = true): Promise<void> {
    const now = Date.now();
    const run: LiveRun = {
      taskId: task.id,
      taskName: task.name,
      startedAt: now,
      finishedAt: null,
      running: true,
      ok: null,
      message: null,
      events: [{ at: now, level: "info", message: "开始执行" }],
    };
    this.liveRuns.set(task.id, run);
    if (persist) await this.persistLive(task.id, run);
  }

  private async appendLive(taskId: number, level: LiveEvent["level"], message: string, persist = true): Promise<void> {
    const run = this.liveRuns.get(taskId) ?? await this.store.getJson<LiveRun | null>(this.liveKey(taskId), null);
    if (!run || !run.running) return;
    run.events.push({ at: Date.now(), level, message });
    if (run.events.length > LIVE_MAX_EVENTS) run.events.splice(0, run.events.length - LIVE_MAX_EVENTS);
    this.liveRuns.set(taskId, run);
    if (persist) await this.persistLive(taskId, run);
  }

  private async finishLive(taskId: number, ok: boolean, message: string, persist = true): Promise<void> {
    const run = this.liveRuns.get(taskId) ?? await this.store.getJson<LiveRun | null>(this.liveKey(taskId), null);
    if (!run) return;
    const now = Date.now();
    run.running = false;
    run.finishedAt = now;
    run.ok = ok;
    run.message = message;
    run.events.push({ at: now, level: ok ? "info" : "error", message: ok ? "执行完成" : "执行失败" });
    if (run.events.length > LIVE_MAX_EVENTS) run.events.splice(0, run.events.length - LIVE_MAX_EVENTS);
    this.liveRuns.set(taskId, run);
    if (persist) await this.persistLive(taskId, run);
  }

  /**
   * @param options.manual 手动触发（界面按钮 / Telegram 命令）。
   *   手动跑一次不应该打乱定时：只有「已经到期」或「本来就没排期」的任务才重算 nextRunAt，
   *   也不会把 once 任务提前消费掉。
   */
  private async runTasks(
    tasks: Task[],
    client?: TelegramClient,
    options: { manual?: boolean } = {},
  ): Promise<LogEntry[]> {
    const runner = async (tg: TelegramClient): Promise<LogEntry[]> => {
      const results: LogEntry[] = [];
      for (const task of tasks) {
        results.push(await this.runSingleTask(tg, task, options));
      }
      return results;
    };
    if (client) return runner(client);
    try {
      return await this.withClient(this.store.getAccountId(), runner);
    } catch (error) {
      // 连接 / 凭证级失败：也落日志，让界面看得到，而不是只回一个 500
      const message = errorMessage(error);
      // 这时还没进到 runSingleTask，通知得在这里发，否则「手动执行失败」永远不通知
      await this.notifyConnectionProblem(null, message);
      return Promise.all(tasks.map(async (task) => {
        // 连接级失败没有进入 runSingleTask，这里补一条实时状态，前端能看到失败原因
        await this.startLive(task);
        await this.appendLive(task.id, "error", message);
        await this.finishLive(task.id, false, message);
        return this.store.addLog({
          taskId: task.id,
          taskName: task.name,
          at: Date.now(),
          ok: false,
          level: "error",
          message,
          detail: null,
          source: options.manual ? "manual" : "auto",
        });
      }));
    }
  }

  /** 单次 run-all 最多跑几个任务（前端会分批调用） */
  private async runAllTasksBatch(
    offset: number,
    limit: number,
    group = "",
  ): Promise<{ ok: boolean; logs: LogEntry[]; processed: number; remaining: number; nextOffset: number }> {
    const inGroup = (task: Task) => {
      if (!group) return true;
      const name = (task.group ?? "").trim();
      return group === "__ungrouped" ? !name : name === group;
    };
    const tasks = (await this.store.listTasks()).filter((task) => task.enabled && inGroup(task));
    const startedAt = Date.now();
    // 单批按时间封顶，剩余任务交给下一轮；每轮至少执行一个任务。
    const batch: Task[] = [];
    for (const task of tasks.slice(offset, offset + limit)) {
      if (batch.length > 0 && Date.now() - startedAt > RUN_ALL_BATCH_BUDGET_MS) break;
      batch.push(task);
    }
    const logs = batch.length ? await this.runTasks(batch, undefined, { manual: true }) : [];
    const nextOffset = offset + batch.length;
    return {
      ok: logs.every((log) => log.ok),
      logs,
      processed: logs.length,
      remaining: Math.max(0, tasks.length - nextOffset),
      nextOffset,
    };
  }

  /**
   * 解析任务目标（每次运行只解析一次）。
   *
   * - 解析本身有兜底：@username → access_hash → getDialogs 预热后重试（见 executor.resolveEntity）
   * - 解析成功后顺手把 username / accessHash 回填进任务，下次就不必再靠 getDialogs
   */
  /**
   * 执行时解析目标。
   *
   * **只补"解析必需"的信息，不改任务名**：改名只发生在建任务那一刻（见 enrichTarget），
   * 否则用户手动起的名字会被"执行时的补全"覆盖掉（v0.18.0 之前的坑）。
   *
   * 什么情况下才写回：
   *   - 目标既没有 username 也没有 access_hash → 下次解析还得靠 getDialogs 预热，补一次省事
   *   - 缺 peerKind（界面上要标类型）→ 补上
   * 其余情况（已经有 username / access_hash）不再动数据库，执行只是读。
   */
  private async ensureTarget(
    client: TelegramClient,
    task: Task,
    index = 0,
  ): Promise<{ entity: Awaited<ReturnType<typeof resolveEntity>>; task: Task; target: Target }> {
    const targets = task.targets && task.targets.length > 1 ? task.targets : null;
    const current: Target = (targets ? targets[index] : undefined) ?? task.target;
    const entity = await resolveEntity(client, current);
    const resolvedKind = classifyPeer(entity);

    // 已经有 username / access_hash、类型也标过了 → 纯粹读，不写库
    if ((current.username || current.accessHash) && current.peerKind) {
      return { entity, task, target: current };
    }

    const peerId = await client.getPeerId(entity as never).catch(() => null);
    const anyEntity = entity as unknown as {
      username?: string;
      accessHash?: unknown;
      title?: string;
      firstName?: string;
      lastName?: string;
    };
    const displayName =
      anyEntity.title || [anyEntity.firstName, anyEntity.lastName].filter(Boolean).join(" ").trim() || undefined;
    const patch: Target = {
      ...current,
      peerKind: resolvedKind,
      id: peerId ? String(peerId) : current.id,
      username: current.username ?? anyEntity.username,
      title: current.title ?? displayName,
      ...(current.accessHash
        ? { accessHash: current.accessHash }
        : anyEntity.accessHash !== undefined && anyEntity.accessHash !== null
          ? { accessHash: String(anyEntity.accessHash) }
          : {}),
    };

    if (JSON.stringify(patch) === JSON.stringify(current)) {
      return { entity, task, target: current };
    }

    // 只写目标信息，绝不改名（要不要改名只由建任务时的 nameAuto 决定）
    const updated = await this.store.updateTask(task.id, applyTargetPatch(task, index, patch), Date.now());
    this.bufferLog({
      taskId: task.id,
      taskName: task.name,
      at: Date.now(),
      ok: true,
      level: "info",
      message: `补齐目标信息：${patch.title || (patch.username ? `@${patch.username}` : patch.id)}`,
      detail: "只是记下用户名 / access_hash / 类型，方便下次直接解析；任务名不会被改动。",
      source: "system",
    });
    return { entity, task: updated ?? task, target: patch };
  }

  /**
   * 本任务内攒下的日志（ensureTarget 补齐 + 执行结果 + 自动暂停），跑完一次
   * addLogs 多行 INSERT 写完（1 条查询顶原来 2–3 条）。只在 runSingleTask 内攒，
   * 跑完即刷；攒日志期间 tick 崩了会丢这几条——执行结果本身还在 tasks 行
   * （recordRun）和 run:outcome 里，汇总不丢。
   */
  private pendingTaskLogs: Array<Omit<LogEntry, "id">> | null = null;

  /** 任务执行里产生的日志先攒起来；不在任务执行里时直接写（兜底）。 */
  private bufferLog(entry: Omit<LogEntry, "id">): void {
    if (this.pendingTaskLogs) this.pendingTaskLogs.push(entry);
    else void this.store.addLog(entry).catch(() => undefined);
  }

  /** 把攒下的日志一次写完，返回带 id 的条目（顺序与攒入一致）；写失败返回 []。 */
  private async flushTaskLogs(): Promise<LogEntry[]> {
    const entries = this.pendingTaskLogs ?? [];
    this.pendingTaskLogs = null;
    if (!entries.length) return [];
    try {
      return await this.store.addLogs(entries);
    } catch {
      return [];
    }
  }

  private async runSingleTask(
    client: TelegramClient,
    task: Task,
    options: { manual?: boolean } = {},
  ): Promise<LogEntry> {
    const settings = await this.store.getSettings();
    const sentKey = `task:${task.id}:sent`;
    /** 自动 tick 没人看 live 中间过程：开始/每步只记内存，结束才落库（1 条查询顶原来每步 1 条）；
     * 手动跑全程落库，前端能看实时进度。 */
    const persistLive = options.manual === true;
    this.startLive(task, persistLive);
    const hooks: ExecHooks = { log: (level, message) => { void this.appendLive(task.id, level, message, persistLive); } };
    // 本任务的日志攒起来跑完一次写完（见 pendingTaskLogs）
    const prevPendingLogs = this.pendingTaskLogs;
    this.pendingTaskLogs = [];

    const triggerSource: LogSource = options.manual ? "manual" : "auto";
    const startedAt = Date.now();
    /** 跑之前的连续失败次数：判断这次是不是「恢复」 */
    const streakBefore = await this.store.failStreakOf(task.id);
    let runLogEntry: Omit<LogEntry, "id">;
    try {
      const settings = await this.store.getSettings();
      const targets = task.targets && task.targets.length > 1 ? task.targets : [task.target];
      const outcomes: Array<{ target: Target; outcome: Awaited<ReturnType<typeof executeTask>> }> = [];

      for (const [index, target] of targets.entries()) {
        const prepared = await this.ensureTarget(client, task, index);
        const effective = prepared.target;
        const targetKey = (effective.username || effective.id || target.username || target.id || "").toLowerCase();
        const previousForTarget = await this.store.getJson<number[]>(`${sentKey}:${targetKey}`, []);
        await this.appendLive(
          task.id,
          "info",
          `目标 ${effective.username ? `@${effective.username}` : effective.title || effective.id}`,
          persistLive,
        );
        const outcome = await executeTask(
          client,
          {
            ...prepared.task,
            target: effective,
            cleanupPrevious: shouldCleanupPrevious(settings.cleanupPrevious, prepared.task.cleanupPrevious),
          },
          {
            previousSent: previousForTarget,
            hooks,
            entity: prepared.entity,
            pollIntervalMs: (settings.stepPollSeconds ?? 1) * 1000,
            stepWaitMs: (settings.stepWaitSeconds ?? DEFAULT_SETTINGS.stepWaitSeconds) * 1000,
          },
        );
        await this.store.setJson(`${sentKey}:${targetKey}`, outcome.sent);
        if (task.deleteAfterSeconds > 0 && outcome.sent.length) {
          await this.store.addDeletion(
            outcome.chatId ?? effective.id,
            outcome.sent,
            Date.now() + task.deleteAfterSeconds * 1000,
          );
        }
        outcomes.push({ target: effective, outcome });

        // 多目标时每个目标单独记一条日志，便于看出是哪个群失败
        if (targets.length > 1) {
          const label = effective.username ? `@${effective.username}` : effective.title || effective.id;
          this.bufferLog({
            taskId: task.id,
            taskName: `${task.name} → ${label}`,
            at: Date.now(),
            ok: outcome.ok,
            level: outcome.ok ? "info" : "warn",
            message: outcome.message,
            detail: outcome.detail || null,
            source: triggerSource,
            durationMs: Date.now() - startedAt,
          });
        }
      }

      const passed = outcomes.filter((item) => item.outcome.ok).length;
      const firstOk = outcomes.find((item) => item.outcome.ok);
      // 多目标全部成功才算任务成功。
      const ok = passed === targets.length;
      const outcome = {
        ok,
        message: ok
          ? targets.length > 1
            ? `${passed}/${targets.length} 个目标成功` + (firstOk ? `（例：${firstOk.outcome.message}）` : "")
            : outcomes[0].outcome.message
          : targets.length > 1
            ? `${passed}/${targets.length} 个目标成功（有目标失败）` + (firstOk ? `（例：${firstOk.outcome.message}）` : "")
            : outcomes[0].outcome.message,
        detail: outcomes
          .map((item) => `▶ ${item.target.username || item.target.id}\n${item.outcome.detail}`)
          .join("\n\n"),
        sent: outcomes.flatMap((item) => item.outcome.sent),
        chatId: outcomes[0].outcome.chatId,
        // 单目标时直接用那次的结果；多目标时拼成列表
        replyText:
          targets.length > 1
            ? outcomes
                .filter((item) => item.outcome.replyText)
                .map((item) => `${item.target.username || item.target.id}：${item.outcome.replyText}`)
                .join("；") || null
            : outcomes[0].outcome.replyText,
        peerKind: outcomes[0].outcome.peerKind,
      };

      // 汇总推送用：把本次完整回复存一份（kv 按任务覆盖，只留最新一次）；
      // at / durationMs 一起存，finalize 重建汇总行时不用再读日志
      const replyFullText =
        targets.length > 1
          ? outcomes
              .filter((item) => item.outcome.replyFullText)
              .map((item) => `${item.target.username || item.target.id}：${item.outcome.replyFullText}`)
              .join("；") || null
          : outcomes[0].outcome.replyFullText;
      await this.store.setJson(`run:${task.id}:outcome`, {
        ok: outcome.ok,
        replyText: outcome.replyText,
        replyFullText,
        allReplies: outcomes.flatMap((item) => item.outcome.allReplies),
        // 按步骤归属的回复（与 steps 一一对应；多目标时取第一个目标的）
        stepReplies: outcomes[0]?.outcome.stepReplies ?? [],
        // 每步的回复是不是只来自弹窗回调（同上，老数据没有时按没有处理）
        stepCallbackOnly: outcomes[0]?.outcome.stepCallbackOnly ?? [],
        at: Date.now(),
        durationMs: Date.now() - startedAt,
      });
      // 回复已经作为「收到机器人回复 #id：…」记在 detail 里了，这里不要再追加一遍
      await this.store.recordRun(
        task.id,
        outcome.ok ? "ok" : "fail",
        outcome.message,
        outcome.detail || null,
        Date.now(),
        options.manual ? "manual" : "auto",
      );
      runLogEntry = {
        taskId: task.id,
        taskName: task.name,
        at: Date.now(),
        ok: outcome.ok,
        level: outcome.ok ? "info" : "warn",
        message: outcome.message,
        detail: outcome.detail || null,
        source: triggerSource,
        durationMs: Date.now() - startedAt,
      };
    } catch (error) {
      const message = errorMessage(error);
      await this.store.recordRun(task.id, "fail", message, null, Date.now(), options.manual ? "manual" : "auto");
      runLogEntry = {
        taskId: task.id,
        taskName: task.name,
        at: Date.now(),
        ok: false,
        level: "error",
        message,
        detail: null,
        source: triggerSource,
        durationMs: Date.now() - startedAt,
      };
    }
    // 执行日志先攒着（与 ensureTarget 补齐日志一起），跑完一次写完
    const runLogIndex = this.pendingTaskLogs?.length ?? 0;
    this.bufferLog(runLogEntry);
    // 先占位（id 为 0），刷库后换成带真实 id 的那条；刷库失败也照常用这条返回
    let log: LogEntry = { id: 0, ...runLogEntry };

    if (log) await this.finishLive(task.id, log.ok, log.message, persistLive);

    if (log) await this.store.recordEvent(`run_finished:${log.ok ? "ok" : "fail"}`);

    // recordRun 已经把 fail_streak 写对了（成功清零、失败 +1）：这次的值就是
    // streakBefore 推出来的，不再读一次
    const streak = log.ok ? 0 : streakBefore + 1;
    let autoPaused = false;
    if (log && !log.ok && shouldAutoPause(streak)) {
      autoPaused = true;
      await this.store.updateTask(task.id, { enabled: false, nextRunAt: null }, Date.now());
      this.bufferLog({
        taskId: task.id,
        taskName: task.name,
        at: Date.now(),
        ok: false,
        level: "error",
        message: `已自动暂停：连续失败 ${streak} 次`,
        detail: "排查后到任务详情里重新启用；可在设置里关掉失败提醒。",
        source: "system",
      });
      await this.notifyEvent(client, "auto_paused", {
        title: `⏸ 任务「${task.name}」已自动暂停`,
        text: `连续失败 ${streak} 次，已停用该任务。\n原因：${(log.message || "执行失败").slice(0, 200)}`,
        task,
      });
    } else if (log && !log.ok) {
      const reason = log.message || "执行失败";
      const type = this.classifyRunFailure(reason);
      // 连接/会话类错误不按「任务失败」发，避免每个任务各发一条
      if (type === "connection_error" || type === "session_expired") {
        await this.notifyConnectionProblem(client, reason);
      } else {
        await this.notifyEvent(client, "run_failed", {
          title: `⚠️ 任务「${task.name}」执行失败`,
          text: reason.slice(0, 300),
          task,
        });
      }
    } else if (log && log.ok) {
      if (streakBefore >= 1) {
        await this.notifyEvent(client, "run_recovered", {
          title: `✅ 任务「${task.name}」恢复正常`,
          text: `之前连续失败 ${streakBefore} 次，这次执行成功。`,
          task,
        });
      }
      await this.notifyEvent(client, "run_success", {
        title: `✅ 任务「${task.name}」执行成功`,
        text: log.message || "执行完成",
        task,
      });
    }

    // 计算下一次执行：手动跑一次不打乱定时
    const wasDue = task.nextRunAt !== null && task.nextRunAt <= Date.now();
    const shouldReschedule = !options.manual || wasDue;
    // task 是本轮开始时的快照：执行中只有自动暂停会改 enabled（上面已记 autoPaused），
    // schedule 不会被执行改写；直接用它重算下次执行，省一次 getTask
    if (shouldReschedule && !autoPaused) {
      if (task.schedule.kind === "once") {
        await this.store.updateTask(task.id, { enabled: false, nextRunAt: null }, Date.now());
      } else if (task.enabled) {
        await this.store.setTaskNextRun(
          task.id,
          computeNextRun(task.schedule, Date.now(), settings.timezone, { afterExecution: true }),
        );
      }
    }
    // 攒下的日志一次写完；换成带真实 id 的执行日志条目返回
    const flushed = await this.flushTaskLogs();
    this.pendingTaskLogs = prevPendingLogs;
    const flushedRunLog = flushed[runLogIndex];
    if (flushedRunLog) log = flushedRunLog;
    return log;
  }

  /**
   * 失败提醒：默认给自己发一条 Telegram 私聊（同一任务 1 小时最多一次），
   * 另外可选 POST 到自定义 Webhook。
   */
  /**
   * 事件通知的统一入口。
   *
   * - 事件类型由设置里的 notifyEvents 多选决定
   * - 两个通道：Telegram 私聊（notifyOnFailure）与 Webhook（配了地址才发）
   * - 带 throttled 的事件按「事件 + 任务」1 小时节流，避免刷屏
   */
  private async notifyEvent(
    client: TelegramClient | null,
    type: NotifyEventId,
    payload: { title: string; text: string; task?: Task | null },
  ): Promise<void> {
    const settings = await this.store.getSettings();
    const selected = settings.notifyEvents ?? [];
    if (!selected.includes(type)) return;

    const throttleKey = `notify:${type}:${payload.task?.id ?? "global"}:at`;
    if (isThrottledEvent(type)) {
      const last = Number(await this.store.getKv(throttleKey) ?? 0);
      if (Date.now() - last < throttleWindowMs(type)) return;
    }
    await this.store.setKv(throttleKey, String(Date.now()));

    const text = `${payload.title}\n${payload.text}\n时间：${formatInTimezone(Date.now(), settings.timezone)}`;

    if (settings.notifyOnFailure !== false && client) {
      try {
        await client.sendMessage("me" as never, { message: text, parseMode: false });
      } catch {
        /* 自己给自己发也可能失败（被限流等），不影响主流程 */
      }
    }

    await this.sendWebhook(settings, {
      taskId: payload.task?.id ?? null,
      taskName: payload.task?.name ?? null,
      title: payload.title,
      text: payload.text,
      ok: !isFailureEvent(type),
    });
  }

  /** 连不上 / 会话过期：这两类要区分开，处理方式不一样 */
  private classifyRunFailure(reason: string): NotifyEventId {
    return /AUTH_KEY|SESSION_(REVOKED|EXPIRED)|USER_DEACTIVATED|AUTH_KEY_UNREGISTERED/i.test(reason)
      ? "session_expired"
      : "connection_error";
  }

  /** 整批跑不动时的提醒（独立于按任务的节流，见 notifyEvent 的 throttled） */
  private async notifyConnectionProblem(client: TelegramClient | null, reason: string): Promise<void> {
    const type = this.classifyRunFailure(reason);
    await this.notifyEvent(client, type, {
      title: type === "session_expired" ? "⚠️ Telegram 登录已失效" : "⚠️ 签到台连不上 Telegram",
      text:
        (type === "session_expired"
          ? "会话被注销或过期，所有任务都不会执行。请到「账号」页重新登录。"
          : "所有到期任务都没能执行，通常是网络/机房问题，稍后会自动重试。") + `\n原因：${reason.slice(0, 200)}`,
    });
  }

  /**
   * 推送一条 Webhook 消息。
   *
   * 渠道由设置里手动选择（钉钉 / 企业微信 / 飞书 / 通用 JSON）；
   * 这些平台**出错也返回 HTTP 200**，所以必须解析 body 里的 errcode/code，
   * 失败要落日志，否则「消息没到」会被当成推送成功。
   */
  private async sendWebhook(
    settings: Settings,
    message: {
      taskId?: number | null;
      taskName?: string | null;
      title: string;
      text: string;
      /** 是不是「出问题」的通知（通用 Webhook 的 ok 字段） */
      ok?: boolean;
      card?: import("./notify/digest").DigestCard;
    },
  ): Promise<{ ok: boolean; kind: WebhookKind; error?: string }> {
    const webhook = (settings.notifyWebhook ?? "").trim();
    const kindHint = settings.notifyWebhookKind ?? "generic";
    if (!webhook) {
      return { ok: false, kind: kindHint, error: "还没有填 Webhook 地址" };
    }
    if (!/^https?:\/\//i.test(webhook)) {
      // 最常见的两种：只填了 token（旧版本没有 token 框）、漏了 https://
      return {
        ok: false,
        kind: kindHint,
        error: `地址不完整：「${webhook.slice(0, 20)}${webhook.length > 20 ? "…" : ""}」——钉钉/企微/飞书请填机器人 Token，自定义渠道请填 http(s):// 开头的完整地址`,
      };
    }

    // 老配置没有渠道字段时按域名兜底猜一次
    const kind = kindHint ?? detectWebhookKind(webhook);
    const now = Date.now();
    try {
      const payload = await buildWebhookPayload(
        webhook,
        settings.notifyWebhookSecret ?? "",
        {
          ...message,
          text: `${message.text}\n时间：${formatInTimezone(now, settings.timezone)}`,
          at: now,
        },
        { kind, now },
      );
      const response = await fetch(payload.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: payload.body,
        signal: AbortSignal.timeout(8000),
      });
      const body = await response.text().catch(() => "");
      const result = parseWebhookResult(payload.kind, response.status, body);
      if (!result.ok) {
        await this.store.addLog({
          taskId: message.taskId ?? null,
          taskName: message.taskName ?? null,
          at: now,
          ok: false,
          level: "warn",
          message: `Webhook 推送失败（${payload.kind}）：${result.error}`,
          detail: "检查地址、加签密钥是否正确；钉钉的加签密钥只存服务端，留空保存表示不修改。",
          source: "system",
        });
      }
      return { ok: result.ok, kind: payload.kind, error: result.error };
    } catch (error) {
      await this.store.addLog({
        taskId: message.taskId ?? null,
        taskName: message.taskName ?? null,
        at: now,
        ok: false,
        level: "warn",
        message: `Webhook 推送失败（${kind}）：${errorMessage(error)}`,
        detail: null,
        source: "system",
      });
      return { ok: false, kind, error: errorMessage(error) };
    }
  }

  private async processDeletions(
    client: TelegramClient,
    deletions: Array<{ id: number; chat: string; msgIds: number[] }>,
  ): Promise<void> {
    for (const deletion of deletions) {
      try {
        const entity = await resolveEntity(client, deletion.chat);
        await client.deleteMessages(entity as never, deletion.msgIds, { revoke: true });
      } catch (error) {
        // 删除失败写入日志，保留聊天与消息 id。
        await this.store.addLog({
          taskId: null,
          taskName: null,
          at: Date.now(),
          ok: false,
          level: "warn",
          message: `延迟删除失败：${errorMessage(error)}`,
          detail: `聊天 ${deletion.chat} · 消息 ${deletion.msgIds.join(", ")}`,
          source: "system",
        });
      }
      await this.store.deleteDeletion(deletion.id);
    }
  }

  // ---------------------------------------------------------------- 状态

  /** 下一次触发器轮询时间（没登录 / 关了触发消息就是 null） */
  private async nextPollAt(): Promise<number | null> {
    const settings = await this.store.getSettings();
    if (!settings.triggerEnabled || !(await this.session())) return null;
    const lastPoll = Number(await this.store.getKv("trigger:lastPoll") ?? 0);
    const now = Date.now();
    return lastPoll ? lastPoll + (await this.effectivePollIntervalMs(now, await this.store.earliestNextRun())) : now;
  }

  /**
   * 近 7 天执行趋势。前端每 30 秒拉一次 state，没必要每次都扫一遍事件表 —— 缓存 60 秒。
   */
  private async usageTrend(tzHours: number): Promise<Array<{ date: string; ok: number; fail: number }>> {
    const cached = await this.store.getJson<{ at: number; tz: number; data: Array<{ date: string; ok: number; fail: number }> } | null>(
      "cache:usageTrend",
      null,
    );
    const now = Date.now();
    if (cached && cached.tz === tzHours && now - cached.at < 60_000) return cached.data;

    const data = bucketDaily(
      (await this.store.listEventSamples("run_finished:", now - 8 * 86400 * 1000))
        .map((row) => ({ ok: row.name === "run_finished:ok", at: row.at })),
      { now, tzHours, days: 7 },
    );
    await this.store.setJson("cache:usageTrend", { at: now, tz: tzHours, data });
    return data;
  }

  private async buildState(): Promise<AgentState> {
    let settings = await this.store.getSettings();
    // 每任务上次耗时：从最近的执行日志里取（P2-9，面板显示用，不落任务表）
    const durations = lastDurationsByTask(await this.store.listLogs({ limit: 200 }));
    const tasks = (await this.store.listTasks()).map((task) => {
      const durationMs = durations.get(task.id);
      return durationMs === undefined ? task : { ...task, lastDurationMs: durationMs };
    });
    const meJson = await this.getAcctField("me_json");
    const me: AccountInfo["me"] = meJson ? (JSON.parse(meJson) as AccountInfo["me"]) : null;
    const creds = await this.credentials();
    const pendingJson = await this.getAcctField("pending_json");
    const pending: PendingLogin | null = pendingJson ? (JSON.parse(pendingJson) as PendingLogin) : null;

    // 老部署补一次：管理员 ID 默认 = 当前登录账号
    if (me?.id) {
      await this.applyDefaultAdminId(me.id);
      settings = await this.store.getSettings();
    }

    const lastRunAt = tasks.reduce<number | null>((acc, task) => {
      if (!task.lastRunAt) return acc;
      return acc === null ? task.lastRunAt : Math.max(acc, task.lastRunAt);
    }, null);

    return {
      account: {
        configured: !!creds.apiId && !!creds.apiHash,
        apiId: creds.apiId ? Number(creds.apiId) : null,
        phone: pending?.phone ?? (await this.getAcctField("phone")),
        signedIn: !!await this.session() && !!me,
        me,
        connected: this.connected,
        lastConnectedAt: Number((await this.getAcctField("last_connected_at")) ?? 0) || null,
        pendingLogin: pending ? { phone: pending.phone, stage: pending.stage } : null,
        dc: Number((await this.getAcctField("dc")) ?? 0) || null,
        lastError: await this.getAcctField("last_error"),
      },
      // 这里先原样给出，fetch 出口统一走 redactState()（settings 会被脱敏）
      settings,
      tasks,
      logs: await this.store.listLogs({ limit: 50 }),
      stats: {
        totalTasks: tasks.length,
        enabledTasks: tasks.filter((task) => task.enabled).length,
        nextRunAt: await this.store.earliestNextRun(),
        lastRunAt,
      },
      now: Date.now(),
      events: {
        firstLoginAt: await this.store.firstEventAt("first_login"),
        tasksCreated: {
          ui: await this.store.countEvent("task_created:ui"),
          trigger: await this.store.countEvent("task_created:trigger"),
        },
        runs: {
          ok: await this.store.countEvent("run_finished:ok"),
          fail: await this.store.countEvent("run_finished:fail"),
        },
        failureHandled: await this.store.countEvent("failure_handled"),
        trend: await this.usageTrend(settings.timezone ?? 8),
      },
      notifyCatalog: NOTIFY_EVENTS.map((item) => ({
        id: item.id,
        label: item.label,
        hint: item.hint,
        throttled: Boolean(item.throttled),
      })),
      runtime: {
        // DO 自己的构建信息：Worker 与 DO 可能短暂不同步（部署后旧 isolate 还在跑），
        // 排查「接口 404 但 /api/version 是新的」时看这里
        build: BUILD,
        storage: await this.storageUsage(),
        colo: await this.store.getKv("runtime:colo"),
        locationHint: this.env.DO_LOCATION_HINT ?? null,
        nextPollAt: await this.nextPollAt(),
        lastPollAt: Number(await this.store.getKv("trigger:lastPoll") ?? 0) || null,
        lastTriggerEvent: await this.store.getJson<{ at: number; ok: boolean; message: string } | null>(
          "trigger:lastEvent",
          null,
        ),
        pollSeconds: settings.pollSeconds,
      },
    };
  }
}

function sanitizeSettings(patch: Partial<Settings>): Partial<Settings> {
  const clean: Partial<Settings> = {};
  if (patch.timezone !== undefined) {
    const tz = Number(patch.timezone);
    if (Number.isFinite(tz) && tz >= -12 && tz <= 14) clean.timezone = tz;
  }
  if (patch.pollSeconds !== undefined) {
    const poll = Number(patch.pollSeconds);
    if (Number.isFinite(poll)) clean.pollSeconds = Math.max(15, Math.min(3600, Math.round(poll)));
  }
  if (patch.triggerEnabled !== undefined) clean.triggerEnabled = !!patch.triggerEnabled;
  if (patch.paused !== undefined) clean.paused = !!patch.paused;
  if (patch.controlChat !== undefined) clean.controlChat = String(patch.controlChat).trim() || "self";
  if (patch.adminUserId !== undefined) clean.adminUserId = String(patch.adminUserId).trim();
  if (patch.defaultTarget !== undefined) clean.defaultTarget = String(patch.defaultTarget).trim();
  if (patch.stepPollSeconds !== undefined) {
    const value = Number(patch.stepPollSeconds);
    if (Number.isFinite(value)) clean.stepPollSeconds = Math.max(1, Math.min(30, value));
  }
  if (patch.turnstileSiteKey !== undefined) {
    clean.turnstileSiteKey = String(patch.turnstileSiteKey).trim().slice(0, 200);
  }
  if (patch.turnstileSecretKey !== undefined) {
    const secret = String(patch.turnstileSecretKey).trim().slice(0, 200);
    // 空字符串表示"保持不变"，要清除请用 clearTurnstileSecret
    if (secret) clean.turnstileSecretKey = secret;
  }
  if (patch.stepWaitSeconds !== undefined) {
    const value = Number(patch.stepWaitSeconds);
    if (Number.isFinite(value)) clean.stepWaitSeconds = Math.max(5, Math.min(300, value));
  }
  if (patch.cleanupPrevious !== undefined) clean.cleanupPrevious = !!patch.cleanupPrevious;
  if (patch.notifyOnFailure !== undefined) clean.notifyOnFailure = !!patch.notifyOnFailure;
  if (patch.notifyEvents !== undefined) clean.notifyEvents = normalizeNotifyEvents(patch.notifyEvents);
  if (patch.digestHour !== undefined) {
    const hour = Number(patch.digestHour);
    if (Number.isFinite(hour)) clean.digestHour = Math.max(0, Math.min(23, Math.round(hour)));
  }
  if (patch.weeklyHour !== undefined) {
    const hour = Number(patch.weeklyHour);
    if (Number.isFinite(hour)) clean.weeklyHour = Math.max(0, Math.min(23, Math.round(hour)));
  }
  if (patch.digestWeekday !== undefined) {
    const day = Number(patch.digestWeekday);
    if (Number.isFinite(day)) clean.digestWeekday = Math.max(0, Math.min(6, Math.round(day)));
  }
  if (patch.successRateThreshold !== undefined) {
    const value = Number(patch.successRateThreshold);
    if (Number.isFinite(value)) clean.successRateThreshold = Math.max(0, Math.min(99, Math.round(value)));
  }
  if (patch.storageWarnPercent !== undefined) {
    const percent = Number(patch.storageWarnPercent);
    if (Number.isFinite(percent)) clean.storageWarnPercent = Math.max(0, Math.min(99, Math.round(percent)));
  }
  if (patch.notifyWebhook !== undefined) {
    clean.notifyWebhook = String(patch.notifyWebhook).trim().slice(0, 300);
  }
  if (patch.notifyWebhookKind !== undefined) {
    const kinds = ["generic", "dingtalk", "wecom", "feishu"];
    if (kinds.includes(String(patch.notifyWebhookKind))) {
      clean.notifyWebhookKind = patch.notifyWebhookKind;
    }
  }
  if (patch.notifyWebhookSecret !== undefined) {
    const secret = String(patch.notifyWebhookSecret).trim().slice(0, 200);
    // 空字符串表示"保持不变"，要清除请用 clearNotifyWebhookSecret
    if (secret) clean.notifyWebhookSecret = secret;
  }
  if (patch.triggerPrefix !== undefined) {
    clean.triggerPrefix = String(patch.triggerPrefix).trim().slice(0, 20);
  }
  if (patch.templates !== undefined) {
    const list = Array.isArray(patch.templates) ? patch.templates.slice(0, 20) : [];
    clean.templates = list
      .map((item, index) => ({
        id: String(item?.id || `t${Date.now()}${index}`).slice(0, 40),
        name: String(item?.name || "未命名模板").trim().slice(0, 20),
        command: String(item?.command || "").trim().slice(0, 500),
      }))
      .filter((item) => item.command);
  }
  if (patch.accountId !== undefined) {
    clean.accountId = String(patch.accountId).trim().slice(0, 100);
  }
  if (patch.reportEnabled !== undefined) clean.reportEnabled = !!patch.reportEnabled;
  if (patch.reportChatId !== undefined) {
    clean.reportChatId = String(patch.reportChatId).trim().slice(0, 100);
  }
  return clean;
}


/** 对外输出设置时，把敏感字段换成布尔标记 */

function welcomeText(prefix: string): string {
  const p = prefix ? `${prefix} ` : "";
  const rule = prefix ? `每条消息都要以「${prefix}」开头。` : "";
  return `👋 签到台已就绪

${rule}把要签到的机器人转发到收藏夹，再发一条指令就能建任务，例如：
${p}9.30 签到
${p}9.30 签到 btn:立即签到 #kw:签到成功
${p}8.30-9.30 rand:早上好|午安

看任务：${p}列表　　看写法：${p}帮助`;
}

function helpText(prefix: string): string {
  const head = prefix ? `每条指令都要以「${prefix}」开头，例如：${prefix} 9.30 签到\n\n` : "";
  return head + HELP_BODY;
}

const HELP_BODY = `写法：[时间] + [要做的事]

时间（放在哪都行）
 · 9.30 / 09:30 / 0930 / 9点半
 · 窗口：8.30-10.30（这段时间里随机挑一次）
 · 间隔：每30分 / 每2小时
 · 只跑一次：在时间后面加 once

要做的事（按顺序执行）
 · 直接写文字 → 发这段文字；带空格时用引号括起来
 · btn:按钮文字 → 点这个按钮（也可以 btn:0,1 按行列点，行列从 0 开始）
 · num:1 → 直接发数字（数字菜单类的机器人）
 · wait:5 → 等 5 秒
 · rand:早安|晚上好|午安 → 随机挑一条发

附加设置（写在最后，多个用空格隔开）
 · #kw:签到成功|已签到 → 机器人回复里出现任一个词就算成功
 · #jitter:120 → 执行前随机等 0-120 秒
 · #delay:5 → 每步之间停几秒（默认 3 秒，0 表示不停）
 · #timeout:40 → 等机器人回应的上限（秒）
 · #delete:30 → 发完 30 秒后删掉自己发的消息
 · #thread:12 → 发到话题 12
 · #keep → 保留上一次发的消息（默认会先删掉）
 · #once → 只执行一次
 · #name:名称 → 自定义任务名

发给谁
 · @机器人 / @群组 / t.me 链接 / 到:-100xxx
 · 到:@a|@b → 一次发给多个目标（最多 8 个）
 · @here → 发到当前这个群
 · 不写也行：先把机器人的消息转发到收藏夹，30 分钟内有效

管理任务
 · 列表 · 立即 <编号> · 开启 <编号> · 关闭 <编号> · 删除 <编号> · 帮助

例子
 9.30 签到
 9.30 签到 btn:立即签到 #kw:签到成功
 8.30-9.30 参与 rand:早上好|午安
 每2小时 打卡`;


/**
 * TgAgent —— DO 包装层（旧部署用）：把 AgentService 包成 Durable Object。
 * 每个请求建一个 AgentService（DoBackend + MemoryLock），fetch 后按 nextScheduledAt() 重排 alarm。
 * D1 版不用这个类（见 index-d1.ts）。
 */
export class TgAgent implements DurableObject {
  private readonly service: AgentService;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: Env,
  ) {
    const store = new Store(new DoBackend(ctx.storage.sql), "");
    this.service = new AgentService(store, env, new MemoryLock());
  }

  /** DO 内的串行队列（复用旧 serialize 语义）。 */
  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async fetch(request: Request): Promise<Response> {
    const res = await this.serialize(() => this.service.fetch(request));
    await this.scheduleNextAlarm().catch(() => undefined);
    return res;
  }

  async alarm(): Promise<void> {
    await this.serialize(() => this.service.tick());
    await this.scheduleNextAlarm().catch(() => undefined);
  }

  /** 按 AgentService 算出的下次唤醒时间排 alarm（带 ≤1 秒防抖）。 */
  private async scheduleNextAlarm(): Promise<void> {
    const at = await this.service.nextScheduledAt();
    if (at === null) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    const existing = await this.ctx.storage.getAlarm();
    if (existing === null || Math.abs(existing - at) > 1_000) {
      await this.ctx.storage.setAlarm(at);
    }
  }
}
