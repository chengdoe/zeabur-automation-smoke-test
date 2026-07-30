import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

export const SENTINEL_STATE_SCHEMA_VERSION = "sentinel-state-v1";
export const SENTINEL_EVENT_SCHEMA_VERSION = "sentinel-event-v1";
export const SENTINEL_INCIDENT_SCHEMA_VERSION = "sentinel-incident-v1";

export const SENTINEL_JOB_STATES = Object.freeze([
  "ACTIVE",
  "WARNING",
  "PAUSED_AUTO",
  "PAUSED_MANUAL",
  "RECOVERY_PENDING"
]);

const ROOT = ["outputs", "ops", "sentinel"];
const STATE_LOCK_STALE_MS = 60_000;
const TRANSITIONS = new Map([
  ["ACTIVE", new Set(["ACTIVE", "WARNING", "PAUSED_AUTO", "PAUSED_MANUAL"])],
  ["WARNING", new Set(["WARNING", "ACTIVE", "PAUSED_AUTO", "PAUSED_MANUAL"])],
  ["PAUSED_AUTO", new Set(["PAUSED_AUTO", "RECOVERY_PENDING", "PAUSED_MANUAL"])],
  ["PAUSED_MANUAL", new Set(["PAUSED_MANUAL", "RECOVERY_PENDING"])],
  ["RECOVERY_PENDING", new Set(["RECOVERY_PENDING", "ACTIVE", "PAUSED_AUTO", "PAUSED_MANUAL"])]
]);

export function getSentinelRoot(dataDir) {
  return path.join(dataDir, ...ROOT);
}

export function getSentinelJobStatePath({ dataDir, jobId }) {
  return path.join(getSentinelRoot(dataDir), "jobs", `${safeJobId(jobId)}.state.json`);
}

export async function readSentinelJobState({ dataDir, jobId }) {
  const file = getSentinelJobStatePath({ dataDir, jobId });
  if (!existsSync(file)) return defaultState(jobId);
  try {
    const parsed = JSON.parse(await readFile(file, "utf8"));
    validateStoredState(parsed, jobId);
    return parsed;
  } catch (error) {
    const wrapped = new Error(`Sentinel state is corrupt for ${jobId}: ${error.message}`);
    wrapped.code = "SENTINEL_STATE_CORRUPT";
    wrapped.jobId = jobId;
    wrapped.file = file;
    throw wrapped;
  }
}

export async function writeSentinelJobState({ dataDir, jobId, state }) {
  const next = sanitizeState({ ...defaultState(jobId), ...state, job_id: jobId });
  validateStoredState(next, jobId);
  const file = getSentinelJobStatePath({ dataDir, jobId });
  await atomicWrite(file, `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

export async function updateSentinelJobState({ dataDir, jobId, updater, waitMs = 2500 }) {
  if (typeof updater !== "function") throw new Error("Sentinel state updater is required");
  return withSentinelStateLock({ dataDir, jobId, waitMs }, async () => {
    const current = await readSentinelJobState({ dataDir, jobId });
    const proposed = await updater(current);
    return writeSentinelJobState({ dataDir, jobId, state: proposed });
  });
}

export async function transitionSentinelJobState({
  dataDir,
  jobId,
  toState,
  reason,
  actor = "sentinel",
  incidentId = null,
  policyVersion = "sentinel-policy-v1",
  now = new Date(),
  patch = {}
}) {
  if (!SENTINEL_JOB_STATES.includes(toState)) throw new Error(`Invalid Sentinel state: ${toState}`);
  return updateSentinelJobState({
    dataDir,
    jobId,
    updater(current) {
      if (!TRANSITIONS.get(current.state)?.has(toState)) {
        throw new Error(`Invalid Sentinel transition for ${jobId}: ${current.state} -> ${toState}`);
      }
      return {
        ...current,
        ...patch,
        state: toState,
        state_reason: reason || null,
        state_actor: actor,
        incident_id: incidentId ?? current.incident_id ?? null,
        policy_version: policyVersion || current.policy_version,
        updated_at: now.toISOString()
      };
    }
  });
}

export async function appendSentinelEvent({ dataDir, date, event }) {
  const dir = path.join(getSentinelRoot(dataDir), "events");
  await mkdir(dir, { recursive: true });
  const safe = sanitizeEvent({ ...event, business_date: event.business_date || date });
  const file = path.join(dir, `${date}.jsonl`);
  await appendFile(file, `${JSON.stringify(safe)}\n`, "utf8");
  return safe;
}

export async function readSentinelEvents({ dataDir, date }) {
  return readJsonLines(path.join(getSentinelRoot(dataDir), "events", `${date}.jsonl`));
}

export async function recordSentinelIncident({ dataDir, date, incident }) {
  const dir = path.join(getSentinelRoot(dataDir), "incidents");
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${date}.jsonl`);
  const safe = sanitizeIncident({ ...incident, business_date: incident.business_date || date });
  const existing = await readJsonLines(file);
  const duplicate = existing.find((item) => (
    item.incident_id === safe.incident_id && item.update_type === safe.update_type
  ));
  if (duplicate) return { written: false, duplicate: true, incident: duplicate, file };
  await appendFile(file, `${JSON.stringify(safe)}\n`, "utf8");
  return { written: true, duplicate: false, incident: safe, file };
}

export async function readSentinelIncidents({ dataDir, date }) {
  return readJsonLines(path.join(getSentinelRoot(dataDir), "incidents", `${date}.jsonl`));
}

export async function recordSentinelAlertDelivery({ dataDir, date, delivery }) {
  const dir = path.join(getSentinelRoot(dataDir), "alerts");
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${date}.jsonl`);
  const safe = sanitizeAlertDelivery({ ...delivery, business_date: delivery.business_date || date });
  const existing = await readJsonLines(file);
  const duplicate = existing.find((item) => (
    item.incident_id === safe.incident_id
      && item.delivery_kind === safe.delivery_kind
      && item.delivery_state === safe.delivery_state
  ));
  if (duplicate) return { written: false, duplicate: true, delivery: duplicate, file };
  await appendFile(file, `${JSON.stringify(safe)}\n`, "utf8");
  return { written: true, duplicate: false, delivery: safe, file };
}

export async function readSentinelAlertDeliveries({ dataDir, date }) {
  return readJsonLines(path.join(getSentinelRoot(dataDir), "alerts", `${date}.jsonl`));
}

function defaultState(jobId) {
  return {
    schema_version: SENTINEL_STATE_SCHEMA_VERSION,
    policy_version: "sentinel-policy-v1",
    job_id: safeJobId(jobId),
    state: "ACTIVE",
    recommended_state: null,
    state_reason: null,
    state_actor: null,
    incident_id: null,
    consecutive_failures: 0,
    last_run_at: null,
    last_success_at: null,
    last_heartbeat_at: null,
    last_error_class: null,
    recovery_actor_open_id: null,
    recovery_nonce: null,
    recovery_requested_at: null,
    updated_at: null
  };
}

function sanitizeState(state) {
  return {
    schema_version: SENTINEL_STATE_SCHEMA_VERSION,
    policy_version: stringOrNull(state.policy_version) || "sentinel-policy-v1",
    job_id: safeJobId(state.job_id),
    state: state.state,
    recommended_state: SENTINEL_JOB_STATES.includes(state.recommended_state) ? state.recommended_state : null,
    state_reason: stringOrNull(state.state_reason),
    state_actor: stringOrNull(state.state_actor),
    incident_id: stringOrNull(state.incident_id),
    consecutive_failures: nonNegativeInteger(state.consecutive_failures),
    last_run_at: isoOrNull(state.last_run_at),
    last_success_at: isoOrNull(state.last_success_at),
    last_heartbeat_at: isoOrNull(state.last_heartbeat_at),
    last_error_class: stringOrNull(state.last_error_class),
    recovery_actor_open_id: stringOrNull(state.recovery_actor_open_id),
    recovery_nonce: stringOrNull(state.recovery_nonce),
    recovery_requested_at: isoOrNull(state.recovery_requested_at),
    updated_at: isoOrNull(state.updated_at)
  };
}

function sanitizeEvent(event) {
  return removeUndefined({
    schema_version: SENTINEL_EVENT_SCHEMA_VERSION,
    policy_version: stringOrNull(event.policy_version) || "sentinel-policy-v1",
    job_id: safeJobId(event.job_id),
    run_id: stringOrNull(event.run_id),
    incident_id: stringOrNull(event.incident_id),
    business_date: stringOrNull(event.business_date),
    occurred_at: isoOrNull(event.occurred_at) || new Date().toISOString(),
    phase: stringOrNull(event.phase),
    event_type: stringOrNull(event.event_type) || "unknown",
    severity: stringOrNull(event.severity) || "info",
    request_count: numberOrNull(event.request_count),
    input_tokens: numberOrNull(event.input_tokens),
    output_tokens: numberOrNull(event.output_tokens),
    total_tokens: numberOrNull(event.total_tokens),
    cost_usd: numberOrNull(event.cost_usd),
    cost_known: typeof event.cost_known === "boolean" ? event.cost_known : null,
    error_class: stringOrNull(event.error_class),
    error_code: stringOrNull(event.error_code),
    action_taken: stringOrNull(event.action_taken),
    job_state: SENTINEL_JOB_STATES.includes(event.job_state) ? event.job_state : null,
    idempotency_key: stringOrNull(event.idempotency_key),
    prompt_hash: stringOrNull(event.prompt_hash),
    safe_summary: stringOrNull(event.safe_summary),
    expected_at: isoOrNull(event.expected_at),
    detected_at: isoOrNull(event.detected_at)
  });
}

function sanitizeIncident(incident) {
  return removeUndefined({
    schema_version: SENTINEL_INCIDENT_SCHEMA_VERSION,
    policy_version: stringOrNull(incident.policy_version) || "sentinel-policy-v1",
    incident_id: stringOrNull(incident.incident_id) || randomUUID(),
    update_type: ["opened", "escalated", "recovered"].includes(incident.update_type) ? incident.update_type : "opened",
    job_id: safeJobId(incident.job_id),
    run_id: stringOrNull(incident.run_id),
    business_date: stringOrNull(incident.business_date),
    opened_at: isoOrNull(incident.opened_at) || new Date().toISOString(),
    expected_at: isoOrNull(incident.expected_at),
    detected_at: isoOrNull(incident.detected_at),
    phase: stringOrNull(incident.phase),
    severity: stringOrNull(incident.severity) || "warning",
    error_class: stringOrNull(incident.error_class) || "unknown",
    reason: stringOrNull(incident.reason) || "unknown",
    action_taken: stringOrNull(incident.action_taken),
    job_state: SENTINEL_JOB_STATES.includes(incident.job_state) ? incident.job_state : null,
    recommended_state: SENTINEL_JOB_STATES.includes(incident.recommended_state) ? incident.recommended_state : null,
    request_count: numberOrNull(incident.request_count),
    total_tokens: numberOrNull(incident.total_tokens),
    cost_usd: numberOrNull(incident.cost_usd),
    cost_known: typeof incident.cost_known === "boolean" ? incident.cost_known : null,
    safe_summary: stringOrNull(incident.safe_summary)
  });
}

function sanitizeAlertDelivery(delivery) {
  return removeUndefined({
    schema_version: "sentinel-alert-delivery-v1",
    incident_id: stringOrNull(delivery.incident_id),
    delivery_kind: ["opened", "escalated", "recovered"].includes(delivery.delivery_kind) ? delivery.delivery_kind : "opened",
    job_id: safeJobId(delivery.job_id),
    business_date: stringOrNull(delivery.business_date),
    delivery_state: stringOrNull(delivery.delivery_state) || "previewed",
    message_id: stringOrNull(delivery.message_id),
    delivered_at: isoOrNull(delivery.delivered_at),
    safe_summary: stringOrNull(delivery.safe_summary)
  });
}

function validateStoredState(state, jobId) {
  if (state?.schema_version !== SENTINEL_STATE_SCHEMA_VERSION) throw new Error("unsupported schema_version");
  if (state?.job_id !== safeJobId(jobId)) throw new Error("job_id mismatch");
  if (!SENTINEL_JOB_STATES.includes(state?.state)) throw new Error("invalid state");
}

async function readJsonLines(file) {
  if (!existsSync(file)) return [];
  const text = await readFile(file, "utf8");
  return text.split("\n").map((line) => line.trim()).filter(Boolean).map((line) => JSON.parse(line));
}

async function atomicWrite(file, content) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, content, "utf8");
  await rename(temporary, file);
}

async function withSentinelStateLock({ dataDir, jobId, waitMs }, fn) {
  const jobsDir = path.join(getSentinelRoot(dataDir), "jobs");
  await mkdir(jobsDir, { recursive: true });
  const lockDir = path.join(jobsDir, `.${safeJobId(jobId)}.lock`);
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
        const timeout = new Error(`Sentinel state lock timed out for ${jobId}`);
        timeout.code = "SENTINEL_STATE_LOCK_TIMEOUT";
        throw timeout;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
}

async function isStaleLock(lockDir) {
  try {
    const info = await stat(lockDir);
    return Date.now() - info.mtimeMs > STATE_LOCK_STALE_MS;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

function safeJobId(value) {
  const jobId = String(value || "");
  if (!/^[a-z0-9][a-z0-9-]{0,79}$/.test(jobId)) throw new Error(`Invalid Sentinel job_id: ${jobId}`);
  return jobId;
}

function stringOrNull(value) {
  if (value === undefined || value === null || value === "") return null;
  return String(value).slice(0, 500);
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

function nonNegativeInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : 0;
}

function isoOrNull(value) {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function removeUndefined(value) {
  return JSON.parse(JSON.stringify(value));
}
