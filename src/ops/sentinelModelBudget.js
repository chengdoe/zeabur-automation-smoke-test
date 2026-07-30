import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const LOCK_STALE_MS = 10 * 60 * 1000;

export function buildSentinelPromptHash(value) {
  const source = typeof value === "string" ? value : stableStringify(value);
  return `sha256:${createHash("sha256").update(source).digest("hex")}`;
}

export function getSentinelModelLedgerPath({ dataDir, jobId, businessKey }) {
  return path.join(
    dataDir,
    "outputs",
    "ops",
    "sentinel",
    "model-requests",
    safeSegment(jobId),
    safeSegment(businessKey),
    "ledger.jsonl"
  );
}

export async function readSentinelModelLedger({ dataDir, jobId, businessKey }) {
  const file = getSentinelModelLedgerPath({ dataDir, jobId, businessKey });
  if (!existsSync(file)) return [];
  const text = await readFile(file, "utf8");
  return text.split("\n").map((line) => line.trim()).filter(Boolean).map((line) => JSON.parse(line));
}

export async function recordSentinelModelAttemptStart({
  dataDir,
  jobId,
  businessKey,
  runId,
  provider,
  model,
  promptHash,
  now = new Date()
}) {
  return appendEntry({
    dataDir,
    jobId,
    businessKey,
    entry: {
      run_id: runId || randomUUID(),
      provider,
      model,
      prompt_hash: promptHash,
      terminal_state: "request_submitted",
      remote_state_unknown: false,
      retryable: null,
      created_at: now.toISOString()
    }
  });
}

export async function recordSentinelModelAttemptTerminal({ dataDir, jobId, businessKey, entry, now = new Date() }) {
  return appendEntry({
    dataDir,
    jobId,
    businessKey,
    entry: {
      ...entry,
      created_at: entry.created_at || now.toISOString()
    }
  });
}

export async function getSentinelModelBudget({ dataDir, jobId, businessKey, maxRequests = 1 }) {
  const entries = await readSentinelModelLedger({ dataDir, jobId, businessKey });
  const starts = entries.filter((entry) => entry.terminal_state === "request_submitted");
  const terminals = entries.filter((entry) => entry.terminal_state && entry.terminal_state !== "request_submitted");
  const unknown = terminals.find((entry) => entry.remote_state_unknown || entry.terminal_state === "remote_state_unknown");
  if (unknown) return { maySubmit: false, submitted: starts.length, remaining: 0, reason: "remote_state_unknown", blockingEntry: unknown };
  if (starts.length > terminals.length) return { maySubmit: false, submitted: starts.length, remaining: 0, reason: "request_inflight" };
  if (terminals.some((entry) => ["response_received", "validated", "cached", "sent"].includes(entry.terminal_state))) {
    return { maySubmit: false, submitted: starts.length, remaining: 0, reason: "response_already_received" };
  }
  const limit = Math.max(1, Math.floor(Number(maxRequests) || 1));
  if (starts.length >= limit) return { maySubmit: false, submitted: starts.length, remaining: 0, reason: "daily_model_budget_exhausted" };
  return { maySubmit: true, submitted: starts.length, remaining: limit - starts.length, reason: null };
}

export async function withSentinelModelRequestLock({ dataDir, jobId, businessKey, waitMs = 2500 }, fn) {
  const ledgerFile = getSentinelModelLedgerPath({ dataDir, jobId, businessKey });
  const lockDir = path.join(path.dirname(ledgerFile), "model-request.lock");
  await mkdir(path.dirname(lockDir), { recursive: true });
  const started = Date.now();
  while (true) {
    try {
      await mkdir(lockDir);
      await writeFile(path.join(lockDir, "owner.json"), JSON.stringify({ created_at: new Date().toISOString() }), "utf8");
      try {
        return await fn();
      } finally {
        await rm(lockDir, { recursive: true, force: true });
      }
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (await isStaleLock(lockDir)) {
        await rm(lockDir, { recursive: true, force: true });
        continue;
      }
      if (Date.now() - started >= waitMs) {
        const blocked = new Error("Sentinel model request lock held");
        blocked.error_class = "model_request_blocked";
        blocked.retryable = false;
        throw blocked;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}

async function appendEntry({ dataDir, jobId, businessKey, entry }) {
  const file = getSentinelModelLedgerPath({ dataDir, jobId, businessKey });
  await mkdir(path.dirname(file), { recursive: true });
  const safe = sanitizeEntry({ ...entry, job_id: jobId, business_key: businessKey });
  await appendFile(file, `${JSON.stringify(safe)}\n`, "utf8");
  return safe;
}

function sanitizeEntry(entry) {
  return {
    schema_version: "sentinel-model-request-v1",
    job_id: safeSegment(entry.job_id),
    business_key: safeSegment(entry.business_key),
    run_id: stringOrNull(entry.run_id),
    provider: stringOrNull(entry.provider),
    model: stringOrNull(entry.model),
    prompt_hash: stringOrNull(entry.prompt_hash),
    request_id: stringOrNull(entry.request_id),
    generation_id: stringOrNull(entry.generation_id),
    terminal_state: stringOrNull(entry.terminal_state),
    remote_state_unknown: Boolean(entry.remote_state_unknown),
    http_status: numberOrNull(entry.http_status),
    input_tokens: numberOrNull(entry.input_tokens),
    output_tokens: numberOrNull(entry.output_tokens),
    total_tokens: numberOrNull(entry.total_tokens),
    cost_usd: numberOrNull(entry.cost_usd),
    error_class: stringOrNull(entry.error_class),
    retryable: typeof entry.retryable === "boolean" ? entry.retryable : null,
    safe_summary: stringOrNull(entry.safe_summary),
    created_at: isoOrNow(entry.created_at)
  };
}

async function isStaleLock(lockDir) {
  try {
    const owner = JSON.parse(await readFile(path.join(lockDir, "owner.json"), "utf8"));
    const createdAt = Date.parse(owner.created_at || "");
    return Number.isFinite(createdAt) && Date.now() - createdAt > LOCK_STALE_MS;
  } catch {
    return false;
  }
}

function safeSegment(value) {
  const segment = String(value || "");
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,119}$/.test(segment)) throw new Error(`Invalid Sentinel path segment: ${segment}`);
  return segment;
}

function stringOrNull(value) {
  if (value === undefined || value === null || value === "") return null;
  return String(value).slice(0, 500);
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

function isoOrNow(value) {
  const date = value ? new Date(value) : new Date();
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}
