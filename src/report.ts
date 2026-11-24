/**
 * 汇总推送：按 tg-signer 现在的格式拼 @yan_checkin_bot 的消息（纯函数）。
 *
 * 格式口径见 nightly 收数流程：首行日期 + TG 计数，失败任务各一行 🔴，
 * 详情行只取本次跑出来的值（失败任务不贴旧值），法拉利单独一行在前，
 * 其余按固定顺序排。密码行（🔑 密码：…）永远不进消息。
 */
import type { RenewalResult } from "./renew";
import { renewalCost } from "./renew";

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
  /** 签到步的回复只来自按钮弹窗回调、没收到正文（面板只看 reply 里的「【仅回调】」前缀，这个字段供推送拼 ⚠️ 行） */
  callbackOnly?: boolean;
  /** 任务显示名（推送用，面板忽略） */
  name?: string;
  /** 失败原因（推送用，面板忽略） */
  failReason?: string;
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

/** 按执行结果定推送里的状态：群只发消息不算签到，记 ran */
export function toReportStatus(ok: boolean, detailText: string, isGroup: boolean): ReportStatus {
  if (!ok) return "failed";
  if (isGroup) return "ran";
  const body = String(detailText ?? "");
  if (body.includes("已经签") || body.includes("已签到")) return "already";
  return "success";
}

/** 详情行按这个顺序排（法拉利单独在前，不在这里） */
const DETAIL_ORDER = ["茶包", "茶百道", "帝服", "闷豹", "宸宇", "宸宇2", "乐观", "乐蛙", "绿洲", "BB"];

/** 某个任务的详情行（失败或值缺失时返回 null，整行跳过） */
function detailLine(task: ReportTaskResult): string | null {
  const reply = task.reply ?? "";
  if (task.status === "failed") return null;
  switch (task.name) {
    case "茶包": {
      const exp = lineValue(reply, "到期时间") ?? firstDate(reply);
      const last = fieldValue(reply, "上次活动");
      const past = fieldValue(reply, "过去30天");
      if (!exp && !last && !past) return null;
      const parts = [`到期时间 ${exp ?? ""}`.trim(), last ? `上次活动 ${last}` : "", past ? `过去30天 ${past}` : ""].filter(Boolean);
      return `🟢茶包：${parts.join("，")}`;
    }
    case "茶百道":
    case "帝服": {
      const exp = lineValue(reply, "到期时间") ?? firstDate(reply);
      const last = fieldValue(reply, "上次活动");
      if (!exp && !last) return null;
      const parts = [exp ? `到期时间 ${exp}` : "", last ? `上次活动 ${last}` : ""].filter(Boolean);
      return `🟢${task.name}：${parts.join("，")}`;
    }
    case "闷豹": {
      const embyRaw = fieldValue(reply, "Emby");
      const keep = fieldValue(reply, "保号");
      const emby = embyRaw ? embyRaw.replace(/｜/g, "，").replace(/（北京时间）/g, "").trim() : null;
      if (!emby && !keep) return null;
      const parts = [emby ? `Emby ${emby}` : "", keep ? `保号 ${keep}` : ""].filter(Boolean);
      return `🟢闷豹：${parts.join("，")}`;
    }
    case "宸宇":
    case "宸宇2": {
      const exp = lineValue(reply, "到期时间") ?? firstDate(reply);
      if (!exp) return null;
      return `🟢${task.name}：到期时间 ${exp}`;
    }
    case "乐观":
    case "乐蛙": {
      const exp = lineValue(reply, "有效期至") ?? firstDate(reply);
      if (!exp) return null;
      return `🟢${task.name}：有效期至 ${exp}`;
    }
    case "绿洲": {
      const month = fieldValue(reply, "本月");
      if (!month) return null;
      return `🟢绿洲：保号规则：30天至少1小时，2天播放记录，本月 ${month}`;
    }
    case "BB": {
      const total = fieldValue(reply, "本周期保号累计");
      const next = fieldValue(reply, "下次考核时间");
      if (!total && !next) return null;
      const parts = [
        "保号要求：30天至少3小时",
        total ? `本周期保号累计 ${total}` : "",
        next ? `下次考核时间 ${next}` : "",
      ].filter(Boolean);
      return `🟢BB：${parts.join("，")}`;
    }
    default:
      return null;
  }
}

/** 法拉利单独一行（失败或值缺失时返回 null） */
function ferrariLine(task: ReportTaskResult): string | null {
  if (task.status === "failed") return null;
  const left = fieldValue(task.reply ?? "", "账户剩余");
  const reward = fieldValue(task.reply ?? "", "流量奖励");
  if (!left && !reward) return null;
  const parts = [left ? `账户剩余 ${left}` : "", reward ? `流量奖励 ${reward}` : ""].filter(Boolean);
  return `🟢法拉利：${parts.join("，")}`;
}

function countsLine(results: ReportTaskResult[]): string {
  const success = results.filter((r) => r.status === "success" || r.status === "ran").length;
  const already = results.filter((r) => r.status === "already").length;
  const failed = results.filter((r) => r.status === "failed").length;
  const total = results.length;
  if (failed === 0 && already === 0) return `TG ${total}/${total} 全部成功`;
  const parts = [`${success} 成功`];
  if (already > 0) parts.push(`${already} 已签`);
  if (failed > 0) parts.push(`${failed} 失败`);
  return `TG ${parts.join("，")}`;
}

function botUrl(botUsername: string): string | null {
  const handle = String(botUsername ?? "").replace(/^@/, "").trim();
  if (!handle || /^-\d+$/.test(handle)) return null;
  return `https://t.me/${handle}`;
}

/**
 * 拼汇总消息。results 是本次跑到的任务（没跑到的不计入）。
 * dateStr 如 "11 月 23 日"，runLabel 如 "11 月 23 日 20:00"。
 */
export function buildReportMessage(
  results: ReportTaskResult[],
  runLabel: string,
  dateStr: string,
): ReportMessage {
  const lines: string[] = [];
  lines.push(`${dateStr} 签到结果（${runLabel} 开始）`);
  lines.push(countsLine(results));
  const failed = results.filter((r) => r.status === "failed");
  for (const task of failed) {
    // 失败行严格只写「失败」：task.failReason 里可能还留着旧的细分原因（按钮超时等），不进推送
    lines.push(`🔴${task.name}：失败`);
  }
  // 只拿到按钮回调的任务：状态仍按原口径记（面板只认识 success/already/failed/ran），
  // 这里单独标一行 ⚠️，别让人把它当成有正文确认的成功。
  for (const task of results) {
    if (task.status !== "failed" && task.callbackOnly) {
      lines.push(`⚠️ ${task.name}：仅收到按钮回调，未见正文回复`);
    }
  }
  const ferrari = results.find((r) => r.name === "法拉利");
  const ferrariText = ferrari ? ferrariLine(ferrari) : null;
  const others = [...results]
    .filter((r) => r.name !== "法拉利")
    .sort((a, b) => {
      const ia = DETAIL_ORDER.indexOf(a.name);
      const ib = DETAIL_ORDER.indexOf(b.name);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    })
    .map(detailLine)
    .filter((line): line is string => line !== null);
  const detailLines = [...(ferrariText ? [ferrariText] : []), ...others];
  if (detailLines.length) {
    lines.push("");
    if (ferrariText && others.length) {
      lines.push(ferrariText);
      lines.push("");
      lines.push(...others);
    } else {
      lines.push(...detailLines);
    }
  }
  const buttons: ReportButton[] = [];
  for (const task of failed) {
    const url = botUrl(task.botUsername);
    if (url) buttons.push({ label: task.name, url });
  }
  return { text: lines.join("\n"), buttons };
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
