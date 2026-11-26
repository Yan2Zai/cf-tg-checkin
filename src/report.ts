/**
 * 汇总推送：按 van 定版的精简高密格式拼 @yan_checkin_bot 的消息（纯函数）。
 *
 * 格式（2026-11-27，方案 A）：首行月-日 + ✅成功数 · 已签数 · ❌失败数；
 * 失败任务只占一行（各带 🔴，只写名字）；续费失败一行 ⚠️ 不附原因；
 * 详情行只留每任务最关键的值（不写标签词、不要秒数），已签用 🔵 置顶；
 * 没有详情行的成功任务折叠成最后一行 ✅ 点名。密码行（🔑 密码：…）永远不进消息。
 */
import type { RenewalOutcome, RenewalResult } from "./renew";
import { parseBalance, parseRenewState, renewalCost } from "./renew";

export type ReportStatus = "success" | "already" | "failed" | "ran";

export interface ReportTaskResult {
  name: string;
  botUsername: string;
  status: ReportStatus;
  /** 本次最后一条回复（签到回复，或 /myinfo、/profile、/stats 的回包） */
  reply: string;
  /** 失败时的原因（只存档用；对外推送/汇总的失败行只写「失败」，不展示它） */
  failReason?: string;
  /** 签到步的回复只来自按钮弹窗回调、没收到正文（薄回调，见 executor.stepCallbackOnly） */
  callbackOnly?: boolean;
  ranAt: string;
}

export interface ReportButton {
  label: string;
  url: string;
}

export interface ReportMessage {
  text: string;
  buttons: ReportButton[];
}

/** 面板汇总（report:lastRunSummary）里单个任务的一行结果 */
export interface PanelSummaryResult {
  accountId: string;
  botUsername: string;
  status: string;
  reply: string;
  ranAt: string;
  via: string;
  myinfoReply?: string;
  myinfoRanAt?: string;
  /** myinfo 回复不是真的信息回复、只是弹窗回调兜底来的（续费现读的信息回复可以补上它） */
  myinfoCallbackOnly?: boolean;
  /** 签到步的回复只来自按钮弹窗回调、没收到正文（面板只看 reply 里的「【仅回调】」前缀，这个字段供推送拼 ⚠️ 行） */
  callbackOnly?: boolean;
  /** 任务显示名（推送用，面板忽略） */
  name?: string;
  /** 失败原因（推送用，面板忽略） */
  failReason?: string;
  /** 上次执行耗时（毫秒），面板显示用；没跑过就没有 */
  lastDurationMs?: number;
}

/**
 * 把本 tick 的结果合并进当天已有的汇总：同一任务（账号 + bot）以最新一次为准，
 * 其余任务保留。旧版汇总里没有 name 时用 botUsername 兜底。
 */
export function mergeSummaryResults(
  prev: PanelSummaryResult[],
  tick: PanelSummaryResult[],
): PanelSummaryResult[] {
  const merged = new Map<string, PanelSummaryResult>();
  for (const r of prev) {
    merged.set(`${r.accountId}|${r.botUsername}`, {
      ...r,
      name: r.name ?? r.botUsername.replace(/^@/, ""),
    });
  }
  for (const r of tick) merged.set(`${r.accountId}|${r.botUsername}`, r);
  return [...merged.values()];
}

/** 把本 tick 的续费结果合并进当天已有的续费汇总：同一任务以最新一次为准 */
export function mergeRenewals(prev: RenewalResult[], tick: RenewalResult[]): RenewalResult[] {
  const merged = new Map<string, RenewalResult>();
  for (const r of prev) merged.set(r.name, r);
  for (const r of tick) merged.set(r.name, r);
  return [...merged.values()];
}

/** 去掉值里的 emoji（只留 🟢/🔴 前缀） */
export function stripEmoji(text: string): string {
  return String(text ?? "").replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu, "").trim();
}

/** 取回复里某标签后面的值（到行尾或逗号为止），找不到返回 null */
export function fieldValue(text: string, label: string): string | null {
  const body = String(text ?? "");
  const idx = body.indexOf(label);
  if (idx < 0) return null;
  const rest = body.slice(idx + label.length);
  // 值从冒号/空格后开始，到换行或中文逗号为止
  const m = /^[\s：:]*([^\n，,]+)/.exec(rest);
  if (!m) return null;
  const value = stripEmoji(m[1].trim());
  return value ? value : null;
}

/** 取包含某标签的那一行里，标签后面的值 */
export function lineValue(text: string, label: string): string | null {
  const body = String(text ?? "");
  for (const line of body.split("\n")) {
    if (line.includes(label)) {
      const value = fieldValue(line, label);
      if (value) return value;
    }
  }
  return null;
}

/** 从一段文本里取第一个 YYYY-MM-DD 日期 */
export function firstDate(text: string): string | null {
  const m = /(\d{4}-\d{2}-\d{2})/.exec(String(text ?? ""));
  return m ? m[1] : null;
}

/**
 * 对外推送/汇总的失败口径：失败只写「失败」，不细分原因。
 * 细分原因（按钮超时、无回复……）只留在面板日志详情里，推送里不出现。
 */
export function briefFailReason(_message: string): string {
  return "失败";
}

/** 按执行结果定推送里的状态：群任务收到带「签到成功」的群组回复算成功，「已经签」算已签；只发了消息、没收到回执的才记 ran */
export function toReportStatus(ok: boolean, detailText: string, isGroup: boolean): ReportStatus {
  if (!ok) return "failed";
  const body = String(detailText ?? "");
  if (body.includes("已经签") || body.includes("已签到")) return "already";
  if (isGroup) return body.includes("签到成功") ? "success" : "ran";
  return "success";
}

/** 详情行顺序（已签置顶除外）；新任务排最后 */
const DETAIL_ORDER = ["法拉利", "宸宇", "宸宇2", "乐观", "绿洲", "BB", "茶百道", "闷豹", "帝服", "茶包", "乐蛙"];

/** 入库前删掉回复里的密码行：只删带「密码：/密码:」的行，余额/到期时间等字段不动。
 * 密码行只出现在 /profile 这类信息回复里，签到回复本身没有密码行。 */
export function stripPasswordLines(text: string): string {
  return String(text ?? "")
    .split("\n")
    .filter((line) => !/密码\s*[：:]/.test(line))
    .join("\n");
}

/** "2026-11-27" → { y: 2026, m: 11, d: 27 }，解析失败返回 null */
function parseIsoDate(text: string | undefined): { y: number; m: number; d: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(text ?? "").trim());
  if (!m) return null;
  return { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) };
}

/** 两个 YYYY-MM-DD 日期相差天数（后 - 前，可为负） */
function daysBetween(from: { y: number; m: number; d: number }, to: { y: number; m: number; d: number }): number {
  const utc = (p: { y: number; m: number; d: number }) => Date.UTC(p.y, p.m - 1, p.d);
  return Math.round((utc(to) - utc(from)) / 86400000);
}

/** "2027-02-14" → "02-14" */
function shortDate(iso: string): string {
  const p = parseIsoDate(iso);
  return p ? `${String(p.m).padStart(2, "0")}-${String(p.d).padStart(2, "0")}` : iso;
}

/** 到期日后面跟的剩天数：≤7 天才加，0 天写今天到期；不传 today 时不加 */
function daysLeftSuffix(expiryIso: string, today: { y: number; m: number; d: number } | null): string {
  if (!today) return "";
  const exp = parseIsoDate(expiryIso);
  if (!exp) return "";
  const days = daysBetween(today, exp);
  if (days === 0) return "（今天到期）";
  if (days > 0 && days <= 7) return `（剩${days}天）`;
  return "";
}

/** "0 小时 0 分钟" → { h: 0, m: 0 }；"2小时" → { h: 2, m: 0 }；读不到返回 null */
function parseHoursMinutes(text: string): { h: number; m: number } | null {
  const body = String(text ?? "");
  const hm = /(\d+)\s*小时\s*(\d+)\s*分钟/.exec(body);
  if (hm) return { h: Number(hm[1]), m: Number(hm[2]) };
  const hOnly = /(\d+)\s*小时/.exec(body);
  if (hOnly) return { h: Number(hOnly[1]), m: 0 };
  const mOnly = /(\d+)\s*分钟/.exec(body);
  if (mOnly) return { h: 0, m: Number(mOnly[1]) };
  return null;
}

/** "0 小时 0 分钟" / "1小时4分钟" / "2小时" → "0h" / "1h4m" / "2h" */
function hoursText(text: string): string | null {
  const hm = parseHoursMinutes(text);
  if (!hm) return null;
  if (hm.h > 0 && hm.m > 0) return `${hm.h}h${hm.m}m`;
  if (hm.h > 0) return `${hm.h}h`;
  if (hm.m > 0) return `${hm.m}m`;
  return "0h";
}

/** 从一段文本里取日期：优先 YYYY-MM-DD，否则 MM-DD；都没有返回 null */
function extractDate(text: string): { iso: string | null; short: string } | null {
  const full = firstDate(text);
  if (full) return { iso: full, short: shortDate(full) };
  const m = /(\d{1,2})-(\d{1,2})/.exec(text);
  if (m) return { iso: null, short: `${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}` };
  return null;
}

/** "154.85 GB" → "154.85G"；"+122 MB" → "+122M" */
function trafficText(text: string): string {
  return String(text ?? "")
    .replace(/\s+/g, "")
    .replace(/GB$/i, "G")
    .replace(/MB$/i, "M");
}

/**
 * 某个任务详情行的值（失败或值缺失时返回 null，整行跳过，任务进最后一行折叠点名）。
 * 按任务名分发，不按回复内容判定：同一字段在不同任务里的推送含义不同——
 * ok 的到期时间不进推送、宸宇的进；钟陌 /start 菜单里的到期时间也不进——
 * 内容判定分不出来，只能按任务名定。新任务走通用回退：只取到期时间。
 */
function detailValue(
  name: string,
  reply: string,
  today: { y: number; m: number; d: number } | null,
): string | null {
  switch (name) {
    case "法拉利": {
      const left = fieldValue(reply, "账户剩余");
      const reward = fieldValue(reply, "流量奖励");
      const parts = [left ? trafficText(left) : "", reward ? trafficText(reward) : ""].filter(Boolean);
      return parts.length ? parts.join(" · ") : null;
    }
    case "宸宇":
    case "宸宇2": {
      const exp = lineValue(reply, "到期时间");
      const d = exp ? extractDate(exp) : null;
      if (!d) return null;
      return d.iso ? d.iso + daysLeftSuffix(d.iso, today) : d.short;
    }
    case "乐观": {
      const valid = lineValue(reply, "有效期至");
      const d = valid ? extractDate(valid) : null;
      if (!d) return null;
      return d.iso ? d.iso + daysLeftSuffix(d.iso, today) : d.short;
    }
    case "绿洲": {
      const month = /本月[：:]\s*([^\n]+)/.exec(reply)?.[1] ?? null;
      if (!month) return null;
      const m = /(\d+)\s*次播放[，,]\s*(.+)/.exec(month);
      if (!m) return null;
      const dur = hoursText(m[2]);
      if (!dur) return null;
      return `本月${m[1]}次·${dur}`;
    }
    case "BB": {
      const total = fieldValue(reply, "本周期保号累计");
      const req = /至少\s*(\d+)\s*小时/.exec(reply)?.[1] ?? null;
      const next = fieldValue(reply, "下次考核时间");
      const parts: string[] = [];
      if (total && req) {
        const hm = parseHoursMinutes(total);
        if (hm) {
          // 整小时只写数字（0/3h），带分钟才写完整时长（1h30m/3h）
          const cur = hm.m > 0 ? (hm.h > 0 ? `${hm.h}h${hm.m}m` : `${hm.m}m`) : String(hm.h);
          parts.push(`${cur}/${req}h`);
        }
      }
      if (next) {
        const date = firstDate(next);
        if (date) parts.push(`考核${shortDate(date)}`);
      }
      return parts.length ? parts.join(" · ") : null;
    }
    case "茶百道": {
      const last = fieldValue(reply, "上次活动");
      const d = last ? extractDate(last) : null;
      return d ? `上次活动${d.short}` : null;
    }
    case "帝服": {
      const last = fieldValue(reply, "上次活动");
      const lastDate = last ? extractDate(last) : null;
      if (lastDate) return `上次活动${lastDate.short}`;
      const exp = lineValue(reply, "到期时间");
      const d = exp ? extractDate(exp) : null;
      if (!d) return null;
      return d.iso ? d.iso + daysLeftSuffix(d.iso, today) : d.short;
    }
    case "闷豹": {
      const exp = fieldValue(reply, "本周期到期");
      // 进度行里的 ✅ 要保留，fieldValue 会把 emoji 全 strip 掉，这里直接取行内值
      const prog = /进度[：:]\s*([^\n，,]+)/.exec(reply)?.[1]?.replace(/\s+/g, "") ?? null;
      const parts: string[] = [];
      if (exp) {
        const date = firstDate(exp);
        const time = /(\d{1,2}:\d{2})/.exec(exp)?.[1] ?? null;
        if (date && time) {
          const expDate = parseIsoDate(date);
          if (today && expDate) {
            const days = daysBetween(today, expDate);
            if (days === 0) parts.push(`今晚${time}到期`);
            else if (days === 1) parts.push(`明天${time}到期`);
            else parts.push(`${shortDate(date)} ${time}到期`);
          } else {
            parts.push(`${shortDate(date)} ${time}到期`);
          }
        }
      }
      if (prog) parts.push(prog.replace(/\s+/g, ""));
      return parts.length ? parts.join(" · ") : null;
    }
    // 以下任务只报成败，不进详情行（van 定版）：
    case "ok":
    case "海豚":
    case "ikuuuu":
    case "muse1":
    case "muse2":
    case "佬友记":
    case "钟陌":
    case "群每日签到":
    case "BDL":
    case "宸澄":
      return null;
    default: {
      // 新任务：通用回退，只取到期时间
      const exp = lineValue(reply, "到期时间") ?? lineValue(reply, "有效期至") ?? firstDate(reply);
      const d = exp ? extractDate(exp) : null;
      if (!d) return null;
      return d.iso ? d.iso + daysLeftSuffix(d.iso, today) : d.short;
    }
  }
}

/** 某个任务的详情行（失败或值缺失时返回 null，整行跳过） */
function detailLine(task: ReportTaskResult, today: { y: number; m: number; d: number } | null): string | null {
  if (task.status === "failed") return null;
  const value = detailValue(task.name, task.reply ?? "", today);
  if (value === null) return null;
  return `${task.status === "already" ? "🔵" : "🟢"}${task.name} ${value}`;
}

/** 首行：月-日 + ✅成功数 · 已签数 · ❌失败数；已签/失败为 0 时省略该段 */
function headerLine(results: ReportTaskResult[], dateStr: string): string {
  const m = /(\d{1,2})\s*月\s*(\d{1,2})\s*日/.exec(dateStr);
  const short = m ? `${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}` : dateStr;
  const success = results.filter((r) => r.status === "success" || r.status === "ran").length;
  const already = results.filter((r) => r.status === "already").length;
  const failed = results.filter((r) => r.status === "failed").length;
  const parts = [`✅${success}`];
  if (already > 0) parts.push(`已签${already}`);
  if (failed > 0) parts.push(`❌${failed}`);
  return `${short} ${parts.join(" · ")}`;
}

/** 折叠行里的任务名缩写（只影响显示，任务名本身不动） */
const FOLDED_NAME: Record<string, string> = { 群每日签到: "群签到" };

function botUrl(botUsername: string): string | null {
  const handle = String(botUsername ?? "").replace(/^@/, "").trim();
  if (!handle || /^-\d+$/.test(handle)) return null;
  return `https://t.me/${handle}`;
}

/**
 * 拼汇总消息。results 是本次跑到的任务（没跑到的不计入），按汇总顺序传；
 * dateStr 如 "11 月 27 日"；runLabel 已不再用（首行只留月-日）；
 * warnings 是续费失败行与续费预警行（跟在失败行后）；todayIso 如 "2026-11-27"，
 * 用于「今晚到期」与「剩 N 天」的相对判断，不传时只写绝对日期。
 */
export function buildReportMessage(
  results: ReportTaskResult[],
  _runLabel: string,
  dateStr: string,
  warnings: string[] = [],
  todayIso?: string,
): ReportMessage {
  const today = parseIsoDate(todayIso);
  const lines: string[] = [headerLine(results, dateStr)];
  const failed = results.filter((r) => r.status === "failed");
  if (failed.length) lines.push(failed.map((t) => `🔴${t.name}`).join(" "));
  for (const w of warnings) lines.push(w);
  const detailRows: { name: string; already: boolean; line: string }[] = [];
  const folded: string[] = [];
  for (const task of results) {
    if (task.status === "failed") continue;
    const line = detailLine(task, today);
    if (line) detailRows.push({ name: task.name, already: task.status === "already", line });
    else folded.push(FOLDED_NAME[task.name] ?? task.name);
  }
  detailRows.sort((a, b) => {
    if (a.already !== b.already) return a.already ? -1 : 1;
    const ia = DETAIL_ORDER.indexOf(a.name);
    const ib = DETAIL_ORDER.indexOf(b.name);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });
  for (const row of detailRows) lines.push(row.line);
  if (folded.length) lines.push(`✅ ${folded.join(" ")}`);
  const buttons: ReportButton[] = [];
  for (const task of failed) {
    const url = botUrl(task.botUsername);
    if (url) buttons.push({ label: task.name, url });
  }
  return { text: lines.join("\n"), buttons };
}

/**
 * 续费没成的任务，在汇总里各占一行 ⚠️，不附原因（原因是诊断信息，放面板）。
 * 余额不足 / 读不到余额不算失败（续费只是跳过），只在距到期 ≤7 天时另走预警。
 */
const RENEWAL_FAILED_OUTCOMES: RenewalOutcome[] = [
  "failed",
  "not-renewed",
  "click-sent-unclear",
  "no-profile-reply",
  "no-shop-reply",
];

export function renewalFailureWarnings(renewals: RenewalResult[]): string[] {
  return renewals
    .filter((r) => RENEWAL_FAILED_OUTCOMES.includes(r.outcome))
    .map((r) => `⚠️${r.name}续费失败`);
}

/** 续费结果 detail 是「余额 204 小于阈值 700」这种句子时，从里面取余额数 */
function detailBalance(detail: string): number | null {
  const m = /余额\s*(\d+)/.exec(String(detail ?? ""));
  return m ? Number(m[1]) : null;
}

export interface ExpiryWarningConfig {
  name: string;
  minBalance: number;
}

/** 余额不足 / 快到期预警（P2-11）：7 天内到期且余额 < 阈值的任务，列进每晚汇总。
 * 去重（P1-4 已推过的同一任务不再重复）：续费结果里 outcome 是 no-balance-found /
 * balance-below-threshold 且 daysLeft ≤ 7 的，P1-4 在 postRun 里已经即时推过一条 ⚠️，
 * 这里跳过。已续上 / 今天已续过的也不预警（余额够、到期已延后）。
 * 余额与到期优先从汇总回复（myinfoReply || reply）里现解析——续费没跑、或续费那条
 * 回复里读不到天数时，汇总回复里可能还有；续费结果的 daysLeft / detail 只当回退。 */
export function buildExpiryWarnings(
  results: PanelSummaryResult[],
  renewals: RenewalResult[],
  configs: ExpiryWarningConfig[],
  today: string,
): string[] {
  const warned = new Set(
    renewals
      .filter(
        (r) =>
          (r.outcome === "no-balance-found" || r.outcome === "balance-below-threshold") &&
          r.daysLeft !== null &&
          r.daysLeft !== undefined &&
          r.daysLeft <= 7,
      )
      .map((r) => r.name),
  );
  const renewed = new Set(
    renewals
      .filter((r) => r.outcome === "renewed" || r.outcome === "already-renewed-today")
      .map((r) => r.name),
  );
  const byName = new Map(results.map((r) => [r.name ?? r.botUsername.replace(/^@/, ""), r]));
  const renewalByName = new Map(renewals.map((r) => [r.name, r]));
  const out: string[] = [];
  for (const cfg of configs) {
    if (warned.has(cfg.name) || renewed.has(cfg.name)) continue;
    const result = byName.get(cfg.name);
    if (!result) continue;
    const reply = result.myinfoReply || result.reply || "";
    const renewal = renewalByName.get(cfg.name);
    const balance = parseBalance(reply) ?? detailBalance(renewal?.detail ?? "");
    const daysLeft = parseRenewState(reply, today).days ?? renewal?.daysLeft ?? null;
    if (balance === null || balance >= cfg.minBalance) continue;
    if (daysLeft === null || daysLeft > 7) continue;
    out.push(`⚠️ ${cfg.name}续费预警：余额 ${balance} 小于阈值 ${cfg.minBalance}，距到期 ${daysLeft} 天`);
  }
  return out;
}

/** 重跑端点的挑任务逻辑（纯函数）：上一轮汇总里 status failed 的任务；
 * BB 永不重试；今天已经重跑过的（retriedKeys，`账号|bot`）不再重复挑。 */
export function selectRetryTargets(
  results: PanelSummaryResult[],
  retriedKeys: string[],
): { targets: PanelSummaryResult[]; skippedBB: string[]; skippedRetried: string[] } {
  const retried = new Set(retriedKeys);
  const targets: PanelSummaryResult[] = [];
  const skippedBB: string[] = [];
  const skippedRetried: string[] = [];
  for (const r of results) {
    if (r.status !== "failed") continue;
    const name = r.name ?? r.botUsername.replace(/^@/, "");
    // BB 机器人：永不重试（与 tick 里的链式重试同一条规矩，见 agent.ts 的 NO_RETRY_BOT）
    if (String(r.botUsername ?? "").replace(/^@/, "").toLowerCase() === "bbembybot") {
      skippedBB.push(name);
      continue;
    }
    const key = `${r.accountId}|${r.botUsername}`;
    if (retried.has(key)) {
      skippedRetried.push(name);
      continue;
    }
    targets.push(r);
  }
  return { targets, skippedBB, skippedRetried };
}

/** 续费结果的单独推送（成功/失败才发；余额不足且距到期超过 7 天、或读不到余额且
 * 不紧急时静默）。距到期 ≤7 天时，读不到余额 / 余额不足不再静默，改推一条 ⚠️ 预警。 */
export function buildRenewalMessages(renewals: RenewalResult[]): ReportMessage[] {
  const out: ReportMessage[] = [];
  for (const r of renewals) {
    if (r.outcome === "renewed") {
      const cost = renewalCost(r.button);
      const costText = cost !== null ? `（${cost}积分）` : "";
      out.push({ text: `✅ ${r.name}自动续费成功：${r.button}${costText}`, buttons: [] });
    } else if (r.outcome === "click-sent-unclear" || r.outcome === "failed" || r.outcome === "no-profile-reply") {
      const url = botUrl(r.bot);
      out.push({
        text: `🔴 ${r.name}自动续费失败：${r.detail || "无回复"}`,
        buttons: url ? [{ label: r.name, url }] : [],
      });
    } else if (r.outcome === "no-balance-found" || r.outcome === "balance-below-threshold") {
      // 读不到余额 / 余额不足：距到期 ≤7 天才预警（已过期也算，daysLeft 会是负数）；
      // 还有 7 天以上、或剩余天数未知时不打扰，等续费成功 / 失败的正常推送。
      if (r.daysLeft !== null && r.daysLeft !== undefined && r.daysLeft <= 7) {
        const url = botUrl(r.bot);
        out.push({
          text: `⚠️ ${r.name}续费预警：${r.detail || "读不到余额"}，距到期 ${r.daysLeft} 天`,
          buttons: url ? [{ label: r.name, url }] : [],
        });
      }
    }
    // already-renewed-today / no-shop-reply / not-renewed：静默
  }
  return out;
}
