/**
 * 自动续费：余额解析 + 续费执行（照搬 tg-signer 的 renew.py）。
 *
 * 流程：余额优先用本轮签到刚抓到的 myinfo 回复（同一轮、同一任务，里面有余额才算）；
 * 读不到时再发命令现读一次（/myinfo 或 /profile）
 * → 余额达标且今天没续过 → 发 /shop（或走多级菜单）找续费按钮点下去
 * → 有二次确认弹窗就点确认 → 按成功/失败关键词定胜负，含糊时重读剩余
 * 天数/到期时间前后对比，绝不靠猜测补点。
 *
 * 余额与续费按钮等配置在任务的 renewal 字段里（真实 bot 名由用户在界面填，
 * 不写进仓库）；今天续过没有存在 kv（`renew:<任务 id>` = 北京日期）。
 */
import type { Task } from "./types";
import type { TelegramClient } from "teleproto";
import { executeTask, resolveEntity, type ExecHooks, type ExecuteOutcome } from "./telegram/executor";

const BALANCE_RES = [/积分余额[：:]\s*(\d+)/, /持有积分\s*[|｜]\s*(\d+)/, /当前积分[：:]\s*(\d+)/];
const EXP_RE = /到期时间[ |]*(\d{4})-(\d{2})-(\d{2})/;
const DAYS_RE = /剩余\s*(\d+)\s*天/;
/** 续费结果里的成功字样 */
export const RENEW_POS = ["成功", "已续", "续费成功", "开通成功", "已开通"];
/** 续费结果里的失败字样 */
export const RENEW_NEG = ["余额不足", "失败", "已结束", "已过期", "已失效", "未成功"];

export type RenewalOutcome =
  | "renewed"
  | "not-renewed"
  | "balance-below-threshold"
  | "already-renewed-today"
  | "no-balance-found"
  | "no-profile-reply"
  | "no-shop-reply"
  | "click-sent-unclear"
  | "failed";

export interface RenewalResult {
  name: string;
  bot: string;
  outcome: RenewalOutcome;
  /** 续费按钮文本（推送里用，如「续费7天」） */
  button: string;
  /** 简短原因（推送失败行用） */
  detail: string;
  /** 按信息回复算出的剩余天数（到期时间优先；读不到为 null）。读不到余额 / 余额不足时，
   * 距到期 ≤7 天要推预警，靠它判定紧急程度；其它结果不填 */
  daysLeft?: number | null;
}

/** 从一段 bot 回复里解析积分余额，找不到返回 null */
export function parseBalance(text: string): number | null {
  const body = String(text ?? "");
  for (const rx of BALANCE_RES) {
    const m = rx.exec(body);
    if (m) return Number(m[1]);
  }
  return null;
}

export interface RenewState {
  days: number | null;
  /** 到期日期 "YYYY-MM-DD"，没有为 null */
  exp: string | null;
}

/** 从信息回复里解析（剩余天数，到期日期）；到期时间优先。today 供单测固定当天，默认北京今天 */
export function parseRenewState(text: string, today?: string): RenewState {
  const body = String(text ?? "");
  const m = EXP_RE.exec(body);
  const exp = m ? `${m[1]}-${m[2]}-${m[3]}` : null;
  const m2 = DAYS_RE.exec(body);
  let days = m2 ? Number(m2[1]) : null;
  if (days === null && exp) {
    // 只有到期日期时，按北京今天算剩余天数
    const base = today ?? beijingDate(Date.now(), 8);
    days = Math.round((Date.parse(exp) - Date.parse(base)) / 86_400_000);
  }
  return { days, exp };
}

/** 指定时刻在某时区（小时偏移）的北京式日期 "YYYY-MM-DD" */
export function beijingDate(nowMs: number, timezoneOffsetHours: number): string {
  const shifted = new Date(nowMs + timezoneOffsetHours * 3_600_000);
  const y = shifted.getUTCFullYear();
  const m = String(shifted.getUTCMonth() + 1).padStart(2, "0");
  const d = String(shifted.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** 续费结果文本定胜负：有成功字样且无失败字样 → 续上了 */
export function classifyRenewReply(text: string): "renewed" | "not-renewed" | "unclear" {
  const body = String(text ?? "");
  const pos = RENEW_POS.some((w) => body.includes(w));
  const neg = RENEW_NEG.some((w) => body.includes(w));
  if (pos && !neg) return "renewed";
  if (neg && !pos) return "not-renewed";
  return "unclear";
}

function hasPos(text: string): boolean {
  return RENEW_POS.some((w) => text.includes(w));
}

function oneLine(text: string, limit = 200): string {
  return String(text ?? "")
    .replace(/\s*\n+\s*/g, " / ")
    .replace(/[ \t]{2,}/g, " ")
    .trim()
    .slice(0, limit);
}

/** 拼一个仅供 executeTask 用的合成任务（只填执行器会读的字段） */
function syntheticTask(task: Task, steps: Task["steps"], keywords: string[]): Task {
  return {
    ...task,
    id: -1,
    steps,
    successKeywords: keywords,
    timeoutSeconds: 30,
    stepDelaySeconds: 3,
    cleanupPrevious: false,
    deleteAfterSeconds: 0,
  };
}

export interface RenewStore {
  getKv(key: string): Promise<string | null>;
  setKv(key: string, value: string): Promise<void>;
}

export interface RenewDeps {
  store: RenewStore;
  hooks: ExecHooks;
  pollIntervalMs: number;
  stepWaitMs: number;
  /** 时区偏移小时（用于「今天」的判定），默认 8 */
  timezone?: number;
}

/**
 * 对一个签到任务跑续费。余额优先用本轮签到刚抓到的 myinfo 回复（同一轮、同一任务），
 * 只有它里面读不到余额时才现发 infoCommand 补读一次。
 */
export async function runRenewal(
  client: TelegramClient,
  task: Task,
  deps: RenewDeps,
  reuseInfoReply?: string | null,
): Promise<RenewalResult> {
  const renewal = task.renewal;
  const bot = task.target.username ? `@${task.target.username}` : task.target.id;
  const name = task.name;
  const button = renewal?.button ?? "";
  const fail = (outcome: RenewalOutcome, detail: string, daysLeft?: number | null): RenewalResult => ({
    name,
    bot,
    outcome,
    button,
    detail,
    ...(daysLeft !== undefined ? { daysLeft } : {}),
  });
  if (!renewal || !renewal.enabled) {
    return fail("failed", "未配置续费");
  }
  const tz = deps.timezone ?? 8;
  const today = beijingDate(Date.now(), tz);
  const renewedKey = `renew:${task.id}`;
  if (await deps.store.getKv(renewedKey) === today) {
    return fail("already-renewed-today", "今天已续过");
  }
  const minBalance = Math.max(0, renewal.minBalance ?? 0);
  const infoCommand = (renewal.infoCommand ?? "/myinfo").trim() || "/myinfo";

  // 1. 读余额：本轮签到刚抓到的回复里有余额就直接用（不重发）；没有余额才现读。
  //    回调文本（「签到中...」）里没有余额，不算“有”，必须现读，不能拿它当余额。
  const entity = await resolveEntity(client, task.target);
  let infoText = "";
  if (reuseInfoReply && parseBalance(reuseInfoReply) !== null) {
    infoText = reuseInfoReply;
  } else {
    const infoTask = syntheticTask(task, [{ type: "text", text: infoCommand }], []);
    const infoOutcome = await executeTask(client, infoTask, {
      hooks: deps.hooks,
      entity,
      pollIntervalMs: deps.pollIntervalMs,
      stepWaitMs: deps.stepWaitMs,
    });
    infoText = infoOutcome.replyFullText ?? infoOutcome.replyText ?? "";
  }
  if (!infoText) {
    return fail("no-profile-reply", `发 ${infoCommand} 后没有收到带余额的回复`);
  }
  const before = parseRenewState(infoText);
  const balance = parseBalance(infoText);
  if (balance === null) {
    return fail("no-balance-found", "回复里没有找到积分余额", before.days);
  }
  if (balance < minBalance) {
    return fail("balance-below-threshold", `余额 ${balance} 小于阈值 ${minBalance}`, before.days);
  }

  // 2. 找续费按钮：有菜单路径先 /start 逐级点进去，否则直接发 /shop
  const steps: Task["steps"] = [];
  if (renewal.menuPath && renewal.menuPath.length) {
    steps.push({ type: "text", text: "/start" });
    for (const menu of renewal.menuPath) steps.push({ type: "click", text: menu });
  } else {
    steps.push({ type: "text", text: "/shop" });
  }
  steps.push({ type: "click", text: button });
  const shopTask = syntheticTask(task, steps, []);
  let outcome: ExecuteOutcome;
  try {
    outcome = await executeTask(client, shopTask, {
      hooks: deps.hooks,
      entity,
      pollIntervalMs: deps.pollIntervalMs,
      stepWaitMs: deps.stepWaitMs,
    });
  } catch (error) {
    return fail("failed", `续费执行失败：${error instanceof Error ? error.message : String(error)}`);
  }
  const afterClick = `${outcome.replyFullText ?? outcome.replyText ?? ""}\n${outcome.detail ?? ""}`;
  if (!outcome.ok && !afterClick.trim()) {
    return fail("no-shop-reply", `没有找到续费按钮「${button}」`);
  }
  // 3. 二次确认：弹窗里有「确认」就再点一次确认按钮
  if (afterClick.includes("确认")) {
    const confirmTask = syntheticTask(task, [{ type: "click", text: "确认" }], []);
    try {
      const confirmOutcome = await executeTask(client, confirmTask, {
        hooks: deps.hooks,
        entity,
        pollIntervalMs: deps.pollIntervalMs,
        stepWaitMs: deps.stepWaitMs,
      });
      const confirmText = `${confirmOutcome.replyFullText ?? confirmOutcome.replyText ?? ""}\n${confirmOutcome.detail ?? ""}`;
      const decided = classifyRenewReply(confirmText);
      if (decided === "renewed") {
        await deps.store.setKv(renewedKey, today);
        return fail("renewed", oneLine(confirmText));
      }
      if (decided === "not-renewed") {
        return fail("not-renewed", oneLine(confirmText));
      }
    } catch {
      /* 确认点不上就继续走重读核验，不在这里定胜负 */
    }
  } else {
    const decided = classifyRenewReply(afterClick);
    if (decided === "renewed") {
      await deps.store.setKv(renewedKey, today);
      return fail("renewed", oneLine(afterClick));
    }
    if (decided === "not-renewed") {
      return fail("not-renewed", oneLine(afterClick));
    }
  }

  // 4. 含糊：重读一次剩余天数/到期时间，前后对比定胜负；before 未知时不瞎报
  const reread = await executeTask(
    client,
    syntheticTask(task, [{ type: "text", text: infoCommand }], []),
    { hooks: deps.hooks, entity, pollIntervalMs: deps.pollIntervalMs, stepWaitMs: deps.stepWaitMs },
  ).catch(() => null);
  const rereadText = reread ? (reread.replyFullText ?? reread.replyText ?? "") : "";
  const after = parseRenewState(rereadText);
  let renewed: boolean | null = null;
  if (after.days !== null && before.days !== null) renewed = after.days > before.days;
  else if (after.exp !== null && before.exp !== null) renewed = after.exp > before.exp;
  if (renewed === null) {
    return fail("click-sent-unclear", "点击已发出，但没确认到是否续上");
  }
  if (renewed) {
    await deps.store.setKv(renewedKey, today);
    return fail("renewed", `重读核验：剩余天数/到期时间变长了`);
  }
  return fail("not-renewed", "重读核验：剩余天数/到期时间没变");
}

/** 续费成功后推送里要用的扣费数（与 tg-signer 的续费成本一致） */
export function renewalCost(button: string): number | null {
  if (button.includes("续费7天")) return 700;
  if (button.includes("周卡")) return 699;
  if (button.includes("账号续期30天")) return 666;
  if (button.includes("账号续期")) return 500;
  if (button.includes("积分续期30天")) return 400;
  return null;
}

/** 仅供单测：确认弹窗里有没有「确认」 */
export function needsConfirm(text: string): boolean {
  return String(text ?? "").includes("确认") && !hasPos(text);
}
