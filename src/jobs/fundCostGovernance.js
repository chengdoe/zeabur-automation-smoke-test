import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

import { readFundModelLedger } from "./fundModelRequestLedger.js";

const ALERT_ROOT = ["outputs", "automations", "fund-portfolio-daily", "alerts"];

export function getFundCostGovernanceConfig(env = process.env) {
  return {
    maxDailyRequests: Math.min(2, positiveNumber(env.FUND_MODEL_MAX_DAILY_REQUESTS, 2)),
    maxDailyTokens: positiveNumber(env.FUND_MODEL_MAX_DAILY_TOKENS, 120_000),
    maxDailyCostUsd: positiveNumber(env.FUND_MODEL_MAX_DAILY_COST_USD, 1),
    maxConsecutiveFailures: positiveNumber(env.FUND_MODEL_MAX_CONSECUTIVE_FAILURES, 2),
    remoteUnknownCooldownMs: positiveNumber(env.FUND_MODEL_REMOTE_UNKNOWN_COOLDOWN_MS, 24 * 60 * 60 * 1000),
    alertOnceDaily: env.FUND_MODEL_ALERT_ONCE_DAILY !== "false",
    feishuAlertEnabled: env.FUND_MODEL_ALERT_FEISHU_ENABLED === "true",
    feishuAlertTargetConfigured: Boolean(env.FUND_MODEL_ALERT_FEISHU_OPEN_ID || env.FUND_MODEL_ALERT_FEISHU_CHAT_ID)
  };
}

export async function getFundCostGovernanceStatus({ dataDir, date, env = process.env }) {
  const config = getFundCostGovernanceConfig(env);
  const entries = await readFundModelLedger({ dataDir, date });
  const alerts = await readFundModelAlerts({ dataDir, date });
  const usage = summarizeFundModelUsage(entries);
  return {
    ok: true,
    date,
    thresholds: {
      maxDailyRequests: config.maxDailyRequests,
      maxDailyTokens: config.maxDailyTokens,
      maxDailyCostUsd: config.maxDailyCostUsd,
      maxConsecutiveFailures: config.maxConsecutiveFailures,
      remoteUnknownCooldownMs: config.remoteUnknownCooldownMs
    },
    usage,
    circuitBreaker: evaluateCircuitBreaker({ usage, entries, config }),
    alerting: {
      onceDaily: config.alertOnceDaily,
      feishuEnabled: config.feishuAlertEnabled,
      feishuTargetConfigured: config.feishuAlertTargetConfigured
    },
    latestAlert: alerts.at(-1) || null,
    alertCount: alerts.length
  };
}

export function summarizeFundModelUsage(entries = []) {
  const starts = entries.filter((entry) => entry.terminal_state === "request_submitted");
  const terminals = entries.filter((entry) => entry.terminal_state && entry.terminal_state !== "request_submitted");
  const failures = terminals.filter((entry) => entry.error_class);
  const tokenFields = ["input_tokens", "output_tokens", "cached_tokens", "reasoning_tokens", "tool_tokens", "web_search_requests", "total_tokens"];
  const tokens = Object.fromEntries(tokenFields.map((field) => [field, sumKnown(entries, (entry) => entry.usage?.[field])]));
  return {
    requests: starts.length,
    terminalEvents: terminals.length,
    failures: failures.length,
    consecutiveFailures: countTrailingFailures(terminals),
    remoteUnknown: terminals.some((entry) => entry.remote_state_unknown),
    tokens,
    cost: {
      total_usd: sumKnown(entries, (entry) => entry.cost?.total_usd)
    },
    unknown: {
      usage: entries.some((entry) => entry.usage && Object.values(entry.usage).some((value) => value === null)),
      cost: entries.some((entry) => entry.cost?.total_usd === null)
    }
  };
}

export function evaluateCircuitBreaker({ usage, entries = [], config }) {
  const reasons = [];
  if (usage.remoteUnknown) reasons.push("remote_state_unknown");
  if (usage.requests >= config.maxDailyRequests) reasons.push("daily_request_budget_reached");
  if (usage.tokens.total_tokens.known && usage.tokens.total_tokens.value >= config.maxDailyTokens) reasons.push("daily_token_budget_reached");
  if (usage.cost.total_usd.known && usage.cost.total_usd.value >= config.maxDailyCostUsd) reasons.push("daily_cost_budget_reached");
  if (usage.consecutiveFailures >= config.maxConsecutiveFailures) reasons.push("consecutive_failure_budget_reached");
  if (entries.some((entry) => entry.terminal_state === "response_received")) reasons.push("response_already_received");
  return {
    open: reasons.length > 0,
    reasons
  };
}

export async function recordFundModelAlert({ dataDir, date, alert, env = process.env, logger = console }) {
  const config = getFundCostGovernanceConfig(env);
  const dir = path.join(dataDir, ...ALERT_ROOT);
  const file = path.join(dir, `${date}.alerts.jsonl`);
  await mkdir(dir, { recursive: true });
  const safe = sanitizeAlert({ ...alert, date, created_at: alert.created_at || new Date().toISOString() });
  if (config.alertOnceDaily) {
    const existing = await readFundModelAlerts({ dataDir, date });
    if (existing.some((item) => item.alert_key === safe.alert_key)) {
      return { written: false, duplicate: true, file, alert: safe, preview: buildFundModelAlertPreview(safe, config) };
    }
  }
  await appendFile(file, `${JSON.stringify(safe)}\n`, "utf8");
  logger.warn?.("[fund-model-governance]", JSON.stringify({
    date: safe.date,
    severity: safe.severity,
    alert_key: safe.alert_key,
    reason: safe.reason,
    job: safe.job,
    sent: false
  }));
  return { written: true, duplicate: false, file, alert: safe, preview: buildFundModelAlertPreview(safe, config) };
}

export async function readFundModelAlerts({ dataDir, date }) {
  const file = path.join(dataDir, ...ALERT_ROOT, `${date}.alerts.jsonl`);
  if (!existsSync(file)) return [];
  const text = await readFile(file, "utf8");
  return text.split("\n").map((line) => line.trim()).filter(Boolean).map((line) => JSON.parse(line));
}

export function buildFundModelAlertPreview(alert, config = getFundCostGovernanceConfig()) {
  return {
    enabled: false,
    reason: config.feishuAlertEnabled && config.feishuAlertTargetConfigured
      ? "private Feishu alert implementation is gated and requires Kane approval before enabling"
      : "private Feishu alert disabled until bot and recipient are approved",
    msgType: "post",
    payload: {
      zh_cn: {
        title: "",
        content: [
          [{ tag: "text", text: `【基金模型费用预警 · ${alert.date}】`, style: ["bold"] }],
          [{ tag: "text", text: `${alert.severity}：${alert.reason}` }],
          [{ tag: "text", text: `job=${alert.job} phase=${alert.phase || "unknown"} request_count=${alert.request_count ?? "unknown"} cost_usd=${alert.cost_usd ?? "unknown"}` }],
          [{ tag: "text", text: "未发送：私聊告警机器人和对象尚未获 Kane 确认。" }]
        ]
      }
    }
  };
}

function sanitizeAlert(alert) {
  const alertKeySource = `${alert.date}:${alert.job || "fund-portfolio-daily"}:${alert.severity || "warn"}:${alert.reason || "unknown"}`;
  return {
    date: alert.date,
    job: alert.job || "fund-portfolio-daily",
    severity: alert.severity || "warn",
    alert_key: alert.alert_key || createHash("sha256").update(alertKeySource).digest("hex").slice(0, 16),
    reason: alert.reason || "unknown",
    phase: alert.phase || null,
    error_class: alert.error_class || null,
    request_count: numberOrNull(alert.request_count),
    token_count: numberOrNull(alert.token_count),
    cost_usd: numberOrNull(alert.cost_usd),
    consecutive_failures: numberOrNull(alert.consecutive_failures),
    runId: alert.runId || randomUUID(),
    sent: false,
    created_at: alert.created_at || new Date().toISOString()
  };
}

async function atomicWrite(file, content) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, content, "utf8");
  await rename(temporary, file);
}

function positiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function numberOrNull(value) {
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

function sumKnown(entries, getter) {
  const values = entries.map(getter).filter((value) => Number.isFinite(Number(value)));
  return {
    known: values.length > 0,
    value: values.reduce((sum, value) => sum + Number(value), 0)
  };
}

function countTrailingFailures(terminals) {
  let count = 0;
  for (let index = terminals.length - 1; index >= 0; index -= 1) {
    if (!terminals[index].error_class) break;
    count += 1;
  }
  return count;
}
