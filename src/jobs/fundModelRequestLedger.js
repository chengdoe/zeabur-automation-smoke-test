import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const MODEL_REQUEST_ROOT = ["outputs", "automations", "fund-portfolio-daily", "model-requests"];
const LOCK_STALE_MS = 10 * 60 * 1000;

export function buildFundPromptHash(value) {
  const source = typeof value === "string" ? value : stableStringify(value);
  return `sha256:${createHash("sha256").update(source).digest("hex")}`;
}

export function buildFundModelIdempotencyKey({ job = "fund-portfolio-daily", date, promptHash }) {
  return `${job}:${date}:${promptHash}`;
}

export function getFundModelLedgerDir({ dataDir, date }) {
  return path.join(dataDir, ...MODEL_REQUEST_ROOT, date);
}

export function getFundModelLedgerPath({ dataDir, date }) {
  return path.join(getFundModelLedgerDir({ dataDir, date }), "ledger.jsonl");
}

export async function readFundModelLedger({ dataDir, date }) {
  const file = getFundModelLedgerPath({ dataDir, date });
  if (!existsSync(file)) return [];
  const text = await readFile(file, "utf8");
  return text.split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

export async function appendFundModelLedgerEntry({ dataDir, date, entry }) {
  const dir = getFundModelLedgerDir({ dataDir, date });
  await mkdir(dir, { recursive: true });
  const safe = sanitizeLedgerEntry({
    ...entry,
    date,
    created_at: entry.created_at || new Date().toISOString()
  });
  await appendFile(getFundModelLedgerPath({ dataDir, date }), `${JSON.stringify(safe)}\n`, "utf8");
  return safe;
}

export async function findBlockingRemoteUnknown({ dataDir, date, promptHash, job = "fund-portfolio-daily", now = new Date(), cooldownMs = 24 * 60 * 60 * 1000 }) {
  const entries = await readFundModelLedger({ dataDir, date });
  return entries.find((entry) => {
    if (entry.job !== job || entry.prompt_hash !== promptHash || !entry.remote_state_unknown) return false;
    const createdAt = Date.parse(entry.created_at || "");
    if (!Number.isFinite(createdAt)) return true;
    return now.getTime() - createdAt < cooldownMs;
  }) || null;
}

export async function getDailyFundModelBudget({ dataDir, date, promptHash, job = "fund-portfolio-daily", maxDailyRequests = 2, now = new Date(), cooldownMs = 24 * 60 * 60 * 1000 }) {
  const entries = await readFundModelLedger({ dataDir, date });
  return evaluateDailyFundModelBudget({ entries, promptHash, job, maxDailyRequests, now, cooldownMs });
}

export function evaluateDailyFundModelBudget({ entries, promptHash, job = "fund-portfolio-daily", maxDailyRequests = 2, now = new Date(), cooldownMs = 24 * 60 * 60 * 1000 }) {
  const daily = entries.filter((entry) => entry.job === job);
  const blockingUnknown = daily.find((entry) => {
    if (!entry.remote_state_unknown) return false;
    const createdAt = Date.parse(entry.created_at || "");
    if (!Number.isFinite(createdAt)) return true;
    return now.getTime() - createdAt < cooldownMs;
  });
  if (blockingUnknown) {
    return { submitted: countSubmissions(daily), remaining: 0, maySubmit: false, reason: "remote_state_unknown", blockingEntry: blockingUnknown };
  }

  const starts = daily.filter((entry) => entry.terminal_state === "request_submitted");
  const terminals = daily.filter((entry) => entry.terminal_state && entry.terminal_state !== "request_submitted");
  if (starts.length > terminals.length) {
    return { submitted: starts.length, remaining: 0, maySubmit: false, reason: "request_inflight" };
  }
  if (terminals.some((entry) => ["response_received", "validated", "promoted", "sent"].includes(entry.terminal_state))) {
    return { submitted: starts.length, remaining: 0, maySubmit: false, reason: "response_already_received" };
  }
  if (starts.length === 0) {
    return { submitted: 0, remaining: maxDailyRequests, maySubmit: true };
  }

  const lastTerminal = terminals.at(-1);
  const canRetry = starts.length < maxDailyRequests && lastTerminal?.terminal_state === "pre_generation_retryable_failure";
  return {
    submitted: starts.length,
    remaining: Math.max(0, maxDailyRequests - starts.length),
    maySubmit: canRetry,
    reason: canRetry ? null : "daily_model_budget_exhausted"
  };
}

export async function recordFundModelAttemptStart({ dataDir, date, job = "fund-portfolio-daily", runId, promptHash, attempt, provider, model, idempotencyKey }) {
  return appendFundModelLedgerEntry({
    dataDir,
    date,
    entry: {
      job,
      runId,
      prompt_hash: promptHash,
      idempotency_key: idempotencyKey || buildFundModelIdempotencyKey({ job, date, promptHash }),
      attempt,
      provider,
      model,
      phase: "model",
      terminal_state: "request_submitted",
      remote_state_unknown: false
    }
  });
}

export async function recordFundModelAttemptTerminal({ dataDir, date, entry }) {
  return appendFundModelLedgerEntry({ dataDir, date, entry });
}

export async function saveFundModelResponseArtifact({ dataDir, date, runId, attempt, text, metadata = {} }) {
  const dir = getFundModelLedgerDir({ dataDir, date });
  await mkdir(dir, { recursive: true });
  const safeRunId = String(runId || randomUUID()).replace(/[^A-Za-z0-9_.-]/g, "_");
  const safeAttempt = Number.isFinite(Number(attempt)) ? Number(attempt) : 1;
  const markdownFile = path.join(dir, `${safeRunId}-attempt-${safeAttempt}.response.md`);
  const metadataFile = path.join(dir, `${safeRunId}-attempt-${safeAttempt}.response.meta.json`);
  await atomicWrite(markdownFile, `${String(text || "").trimEnd()}\n`);
  await atomicWrite(metadataFile, JSON.stringify(sanitizeResponseMetadata(metadata), null, 2));
  return { markdownFile, metadataFile };
}

export async function loadFundModelResponseArtifact(file) {
  return readFile(file, "utf8");
}

export async function withFundModelRequestLock({ dataDir, date, promptHash, waitMs = 2500 }, fn) {
  const dir = getFundModelLedgerDir({ dataDir, date });
  await mkdir(dir, { recursive: true });
  const lockDir = path.join(dir, "daily-model-budget.lock");
  const started = Date.now();
  while (true) {
    try {
      await mkdir(lockDir);
      await atomicWrite(path.join(lockDir, "owner.json"), JSON.stringify({ created_at: new Date().toISOString() }));
      try {
        return await fn();
      } finally {
        await removeLock(lockDir);
      }
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (Date.now() - started >= waitMs) {
        return {
          ok: false,
          sent: false,
          skipped: true,
          phase: "pre_model_gate",
          error_class: "model_request_blocked",
          sendSkippedReason: "model request lock held",
          retryable: false
        };
      }
      if (await isStaleLock(lockDir)) await removeLock(lockDir);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}

function countSubmissions(entries) {
  return entries.filter((entry) => entry.terminal_state === "request_submitted").length;
}

function sanitizeLedgerEntry(entry) {
  const allowed = {
    date: entry.date,
    job: entry.job || "fund-portfolio-daily",
    runId: entry.runId || null,
    prompt_hash: entry.prompt_hash || null,
    idempotency_key: entry.idempotency_key || null,
    attempt: Number.isFinite(Number(entry.attempt)) ? Number(entry.attempt) : 1,
    provider: entry.provider || null,
    model: entry.model || null,
    request_id: entry.request_id || null,
    generation_id: entry.generation_id || null,
    http_status: Number.isFinite(Number(entry.http_status)) ? Number(entry.http_status) : null,
    provider_status: entry.provider_status || null,
    content_type: entry.content_type || null,
    duration_ms: Number.isFinite(Number(entry.duration_ms)) ? Number(entry.duration_ms) : null,
    phase: entry.phase || "model",
    terminal_state: entry.terminal_state || null,
    remote_state_unknown: Boolean(entry.remote_state_unknown),
    usage: normalizeUsage(entry.usage),
    cost: normalizeCost(entry.cost),
    error_class: entry.error_class || null,
    retryable: typeof entry.retryable === "boolean" ? entry.retryable : null,
    safe_summary: entry.safe_summary || null,
    created_at: entry.created_at || new Date().toISOString()
  };
  return JSON.parse(JSON.stringify(allowed));
}

function normalizeUsage(usage = {}) {
  return {
    input_tokens: numericOrNull(usage.input_tokens),
    output_tokens: numericOrNull(usage.output_tokens),
    cached_tokens: numericOrNull(usage.cached_tokens),
    reasoning_tokens: numericOrNull(usage.reasoning_tokens),
    tool_tokens: numericOrNull(usage.tool_tokens),
    web_search_requests: numericOrNull(usage.web_search_requests),
    total_tokens: numericOrNull(usage.total_tokens)
  };
}

function normalizeCost(cost = {}) {
  return {
    total_usd: numericOrNull(cost.total_usd)
  };
}

function numericOrNull(value) {
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

function sanitizeResponseMetadata(metadata = {}) {
  return {
    date: metadata.date || null,
    job: metadata.job || "fund-portfolio-daily",
    runId: metadata.runId || null,
    prompt_hash: metadata.prompt_hash || null,
    attempt: Number.isFinite(Number(metadata.attempt)) ? Number(metadata.attempt) : 1,
    provider: metadata.provider || null,
    model: metadata.model || null,
    request_id: metadata.request_id || null,
    generation_id: metadata.generation_id || null,
    saved_at: metadata.saved_at || new Date().toISOString()
  };
}

async function atomicWrite(file, content) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, content, "utf8");
  await rename(temporary, file);
}

async function removeLock(lockDir) {
  const { rm } = await import("node:fs/promises");
  await rm(lockDir, { recursive: true, force: true });
}

async function isStaleLock(lockDir) {
  try {
    const text = await readFile(path.join(lockDir, "owner.json"), "utf8");
    const createdAt = Date.parse(JSON.parse(text).created_at || "");
    return Number.isFinite(createdAt) && Date.now() - createdAt > LOCK_STALE_MS;
  } catch {
    return false;
  }
}

function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}
