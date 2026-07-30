import { createHash, randomUUID } from "node:crypto";

import { evaluateSentinelOutcome, SENTINEL_POLICY_VERSION } from "./sentinelPolicy.js";
import {
  appendSentinelEvent,
  readSentinelJobState,
  recordSentinelIncident,
  transitionSentinelJobState,
  updateSentinelJobState
} from "./sentinelStore.js";

const PAUSED_STATES = new Set(["PAUSED_AUTO", "PAUSED_MANUAL", "RECOVERY_PENDING"]);

export async function preflightSentinelJob({ dataDir, jobId, config, policy }) {
  if (!config?.enabled) return { allowed: true, reason: "sentinel_disabled", state: null };
  let state;
  try {
    state = await readSentinelJobState({ dataDir, jobId });
  } catch (error) {
    if (policy?.paidModel) {
      return { allowed: false, reason: "sentinel_state_unavailable", error_class: "state_store_unavailable", error, state: null };
    }
    return { allowed: true, reason: "sentinel_state_unavailable_degraded", error_class: "state_store_unavailable", error, state: null };
  }
  if (PAUSED_STATES.has(state.state)) {
    return { allowed: false, reason: "sentinel_paused", state };
  }
  return { allowed: true, reason: "sentinel_allowed", state };
}

export async function recordSentinelRunStarted({ dataDir, date, jobId, runId, now = new Date(), config, policy }) {
  if (!config?.enabled) return { skipped: true, reason: "sentinel_disabled" };
  const state = await updateSentinelJobState({
    dataDir,
    jobId,
    updater(current) {
      return {
        ...current,
        policy_version: config.policyVersion || SENTINEL_POLICY_VERSION,
        last_run_at: now.toISOString(),
        last_heartbeat_at: now.toISOString(),
        updated_at: now.toISOString()
      };
    }
  });
  const event = await appendSentinelEvent({
    dataDir,
    date,
    event: {
      policy_version: config.policyVersion || SENTINEL_POLICY_VERSION,
      job_id: jobId,
      run_id: runId,
      occurred_at: now.toISOString(),
      phase: "preflight",
      event_type: "run_started",
      severity: "info",
      action_taken: "allowed",
      job_state: state.state,
      safe_summary: `${policy?.risk || "unknown"} risk job started`
    }
  });
  return { skipped: false, state, event };
}

export async function recordSentinelRunResult({
  dataDir,
  date,
  jobId,
  runId,
  result,
  now = new Date(),
  config,
  policy
}) {
  if (!config?.enabled) return { skipped: true, reason: "sentinel_disabled" };
  let evaluated;
  let incidentId;
  let incidentUpdateType = "opened";
  const next = await updateSentinelJobState({
    dataDir,
    jobId,
    updater(current) {
      evaluated = evaluateSentinelOutcome({ state: current, result, policy, mode: config.mode });
      incidentId = evaluated.severity === "critical" || evaluated.severity === "warning"
        ? buildIncidentId({ date, jobId, reason: result?.error_class || evaluated.reason })
        : current.incident_id;
      if (incidentId && incidentId === current.incident_id && evaluated.severity === "critical" && current.state === "WARNING") {
        incidentUpdateType = "escalated";
      }
      return {
        ...current,
        policy_version: config.policyVersion || SENTINEL_POLICY_VERSION,
        state: evaluated.nextState,
        recommended_state: evaluated.recommendedState,
        state_reason: evaluated.reason,
        state_actor: evaluated.action === "paused_auto" ? "sentinel" : current.state_actor,
        incident_id: incidentId || null,
        consecutive_failures: evaluated.consecutiveFailures,
        last_run_at: now.toISOString(),
        last_heartbeat_at: now.toISOString(),
        last_success_at: result?.ok === true && !result?.skipped ? now.toISOString() : current.last_success_at,
        last_error_class: result?.ok === false ? result?.error_class || "run_failure" : null,
        updated_at: now.toISOString()
      };
    }
  });
  const eventType = result?.skipped ? "run_skipped" : result?.ok ? "run_succeeded" : "run_failed";
  const event = await appendSentinelEvent({
    dataDir,
    date,
    event: {
      policy_version: config.policyVersion || SENTINEL_POLICY_VERSION,
      job_id: jobId,
      run_id: runId,
      incident_id: incidentId,
      occurred_at: now.toISOString(),
      phase: result?.phase || "run",
      event_type: eventType,
      severity: evaluated.severity,
      request_count: result?.request_count,
      total_tokens: result?.total_tokens ?? result?.token_count,
      cost_usd: result?.cost_usd,
      cost_known: isKnownNumber(result?.cost_usd),
      error_class: result?.error_class || null,
      action_taken: evaluated.action,
      job_state: next.state,
      safe_summary: evaluated.reason
    }
  });

  let incident = null;
  if (incidentId && ["warning", "critical"].includes(evaluated.severity)) {
    incident = await recordSentinelIncident({
      dataDir,
      date,
      incident: {
        policy_version: config.policyVersion || SENTINEL_POLICY_VERSION,
        incident_id: incidentId,
        update_type: incidentUpdateType,
        job_id: jobId,
        run_id: runId,
        opened_at: now.toISOString(),
        phase: result?.phase || "run",
        severity: evaluated.severity,
        error_class: result?.error_class || "run_failure",
        reason: evaluated.reason,
        action_taken: evaluated.action,
        job_state: next.state,
        recommended_state: evaluated.recommendedState,
        request_count: result?.request_count,
        total_tokens: result?.total_tokens ?? result?.token_count,
        cost_usd: result?.cost_usd,
        cost_known: isKnownNumber(result?.cost_usd),
        safe_summary: `${jobId} ${evaluated.reason}`
      }
    });
  }
  return { skipped: false, action: evaluated.action, state: next, event, incident };
}

export async function requestSentinelRecovery({ dataDir, jobId, actorOpenId, now = new Date() }) {
  if (!actorOpenId) throw new Error("Recovery requires an authorized actor open_id");
  const current = await readSentinelJobState({ dataDir, jobId });
  if (!["PAUSED_AUTO", "PAUSED_MANUAL"].includes(current.state)) {
    throw new Error(`Recovery can only be requested for a paused job, got ${current.state}`);
  }
  const nonce = randomUUID();
  return transitionSentinelJobState({
    dataDir,
    jobId,
    toState: "RECOVERY_PENDING",
    reason: "recovery_requested",
    actor: actorOpenId,
    incidentId: current.incident_id,
    now,
    patch: {
      recovery_actor_open_id: actorOpenId,
      recovery_nonce: nonce,
      recovery_requested_at: now.toISOString()
    }
  });
}

export async function confirmSentinelRecovery({
  dataDir,
  jobId,
  actorOpenId,
  nonce,
  trial,
  now = new Date()
}) {
  const current = await readSentinelJobState({ dataDir, jobId });
  if (current.state !== "RECOVERY_PENDING") throw new Error(`Recovery is not pending for ${jobId}`);
  if (!actorOpenId || actorOpenId !== current.recovery_actor_open_id) throw new Error("Recovery confirmation requires the authorized actor");
  if (!nonce || nonce !== current.recovery_nonce) throw new Error("Recovery confirmation nonce is invalid");
  if (typeof trial !== "function") throw new Error("Recovery requires one bounded trial function");

  let outcome;
  try {
    outcome = await trial();
  } catch (error) {
    outcome = { ok: false, error_class: error.error_class || error.code || "recovery_trial_failure" };
  }
  const succeeded = outcome?.ok === true;
  return transitionSentinelJobState({
    dataDir,
    jobId,
    toState: succeeded ? "ACTIVE" : "PAUSED_AUTO",
    reason: succeeded ? "recovery_trial_succeeded" : outcome?.error_class || "recovery_trial_failed",
    actor: actorOpenId,
    incidentId: succeeded ? null : current.incident_id,
    now,
    patch: {
      recommended_state: succeeded ? null : "PAUSED_AUTO",
      consecutive_failures: succeeded ? 0 : current.consecutive_failures,
      recovery_actor_open_id: null,
      recovery_nonce: null,
      recovery_requested_at: null,
      last_success_at: succeeded ? now.toISOString() : current.last_success_at,
      last_error_class: succeeded ? null : outcome?.error_class || "recovery_trial_failure"
    }
  });
}

function buildIncidentId({ date, jobId, reason }) {
  return `inc_${createHash("sha256").update(`${date}:${jobId}:${reason}`).digest("hex").slice(0, 20)}`;
}

function isKnownNumber(value) {
  return value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value));
}
