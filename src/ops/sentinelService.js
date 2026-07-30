import { createHash } from "node:crypto";

import { weekdayForDate } from "../date.js";
import {
  deliverSentinelIncidents,
  getSentinelIdentityStatus,
  listPendingSentinelIncidents
} from "./sentinelAlerting.js";
import {
  getSentinelRuntimeConfig,
  getSentinelPolicy,
  listSentinelPolicies
} from "./sentinelPolicy.js";
import {
  readSentinelAlertDeliveries,
  readSentinelEvents,
  readSentinelIncidents,
  readSentinelJobState,
  recordSentinelIncident
} from "./sentinelStore.js";
import { buildSentinelAlertPost, scanSentinelWatchdog } from "./sentinelWatchdog.js";

const MINUTE = 60_000;
const REGISTERED_JOB_IDS = Object.freeze([
  "morning-motivation",
  "sop13",
  "ai-hot",
  "fund-portfolio-daily",
  "wisereads-weekly"
]);

export function buildSentinelExpectations({ now = new Date(), env = process.env } = {}) {
  if (env.SCHEDULER_ENABLED === "false") return [];
  const date = shanghaiDate(now);
  const weekday = weekdayForDate(date);
  const expectations = [
    expectation("morning-motivation", date, "09:00", 10 * MINUTE),
    expectation("sop13", date, "09:30", 10 * MINUTE)
  ];
  if (env.AI_HOT_SCHEDULER_ENABLED === "true") {
    expectations.push(expectation("ai-hot", date, "10:00", 10 * MINUTE));
  }
  if (env.FUND_PORTFOLIO_ENABLED === "true" && [1, 2, 3, 4, 5].includes(weekday)) {
    expectations.push(expectation("fund-portfolio-daily", date, "13:50", 40 * MINUTE));
  }
  if (env.WISEREADS_WEEKLY_SCHEDULER_ENABLED === "true" && weekday === 2) {
    expectations.push(expectation("wisereads-weekly", date, "18:00", 10 * MINUTE));
  }
  return expectations;
}

export async function getSentinelStatus({ dataDir, date = shanghaiDate(new Date()), env = process.env }) {
  const runtime = getSentinelRuntimeConfig(env);
  const jobs = await Promise.all(REGISTERED_JOB_IDS.map(async (jobId) => {
    try {
      return await readSentinelJobState({ dataDir, jobId });
    } catch (error) {
      return {
        job_id: jobId,
        state: "UNKNOWN",
        error_class: error.code || "sentinel_state_unavailable"
      };
    }
  }));
  const [events, incidents, deliveries] = await Promise.all([
    readSentinelEvents({ dataDir, date }),
    readSentinelIncidents({ dataDir, date }),
    readSentinelAlertDeliveries({ dataDir, date })
  ]);
  return {
    ok: true,
    service: "automation-sentinel",
    date,
    runtime,
    identity: getSentinelIdentityStatus(env),
    modelCalls: 0,
    policies: listSentinelPolicies(),
    jobs,
    counts: {
      events: events.length,
      incidents: new Set(incidents.map((item) => item.incident_id)).size,
      incidentUpdates: incidents.length,
      alertsSent: deliveries.filter((item) => item.delivery_state === "sent").length,
      alertsFailed: deliveries.filter((item) => item.delivery_state === "failed").length
    },
    recent: {
      events: events.slice(-20),
      incidents: incidents.slice(-20),
      deliveries: deliveries.slice(-20)
    }
  };
}

export async function runSentinelWatchdogCycle({
  dataDir,
  now = new Date(),
  env = process.env,
  expectations = buildSentinelExpectations({ now, env }),
  send = false,
  sender,
  fetchImpl = fetch
}) {
  const runtime = getSentinelRuntimeConfig(env);
  const date = shanghaiDate(now);
  let scan;
  if (env.SENTINEL_MONITORED_STATUS_URL) {
    try {
      const snapshot = await fetchSentinelMonitorSnapshot({
        url: env.SENTINEL_MONITORED_STATUS_URL,
        credential: env.SENTINEL_MONITORED_STATUS_CREDENTIAL,
        fetchImpl,
        timeoutMs: env.SENTINEL_MONITOR_TIMEOUT_MS
      });
      const states = new Map(snapshot.jobs.map((state) => [state.job_id, state]));
      scan = await scanSentinelWatchdog({
        dataDir,
        expectations,
        now,
        config: runtime,
        stateProvider: async (jobId) => states.get(jobId) || null
      });
    } catch {
      scan = await recordMonitorUnavailable({ dataDir, date, now, runtime });
    }
  } else {
    scan = await scanSentinelWatchdog({ dataDir, expectations, now, config: runtime });
  }
  const candidates = await listPendingSentinelIncidents({ dataDir, date });
  const delivery = send
    ? await deliverSentinelIncidents({ dataDir, date, incidents: candidates, env, sender, now })
    : {
        ok: true,
        sent: [],
        failed: [],
        duplicates: [],
        previews: candidates.map((incident) => ({ incident_id: incident.incident_id, payload: buildSentinelAlertPost(incident) })),
        blockedReason: "dry_run",
        identity: getSentinelIdentityStatus(env)
      };
  return {
    ok: scan.incidents.length === 0 && delivery.failed.length === 0,
    checkedAt: now.toISOString(),
    modelCalls: 0,
    expectations,
    scan,
    delivery
  };
}

export async function fetchSentinelMonitorSnapshot({
  url,
  credential,
  fetchImpl = fetch,
  timeoutMs = 5000
}) {
  if (!url) throw Object.assign(new Error("Sentinel monitor URL is required"), { code: "SENTINEL_MONITOR_URL_MISSING" });
  if (!credential) throw Object.assign(new Error("Sentinel monitor credential is required"), { code: "SENTINEL_MONITOR_CREDENTIAL_MISSING" });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), positiveTimeout(timeoutMs, 5000));
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      headers: { authorization: `Bearer ${credential}` },
      signal: controller.signal
    });
    const body = await response.json();
    if (!response.ok || body?.ok !== true || !Array.isArray(body?.sentinel?.jobs)) {
      throw Object.assign(new Error("Sentinel monitor response is unavailable"), {
        code: "SENTINEL_MONITOR_BAD_RESPONSE"
      });
    }
    return {
      jobs: body.sentinel.jobs.map(sanitizeRemoteState)
    };
  } finally {
    clearTimeout(timeout);
  }
}

function expectation(jobId, date, time, graceMs) {
  return {
    jobId,
    expectedAt: new Date(`${date}T${time}:00+08:00`).toISOString(),
    graceMs,
    policy: getSentinelPolicy(jobId)
  };
}

function shanghaiDate(value) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(value);
  const fields = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${fields.year}-${fields.month}-${fields.day}`;
}

async function recordMonitorUnavailable({ dataDir, date, now, runtime }) {
  const incidentId = `inc_${createHash("sha256").update(`${date}:automation-service:monitor_target_unavailable`).digest("hex").slice(0, 20)}`;
  const recorded = await recordSentinelIncident({
    dataDir,
    date,
    incident: {
      policy_version: runtime.policyVersion,
      incident_id: incidentId,
      job_id: "automation-service",
      opened_at: now.toISOString(),
      detected_at: now.toISOString(),
      phase: "watchdog",
      severity: "critical",
      error_class: "monitor_target_unavailable",
      reason: "monitored service status endpoint unavailable",
      action_taken: "alert_only",
      job_state: null,
      cost_known: false,
      safe_summary: "monitored automation service unavailable"
    }
  });
  return {
    checkedAt: now.toISOString(),
    incidents: recorded.duplicate ? [] : [recorded.incident],
    duplicates: recorded.duplicate ? [recorded.incident] : [],
    healthy: []
  };
}

function sanitizeRemoteState(state) {
  const allowedStates = new Set(["ACTIVE", "WARNING", "PAUSED_AUTO", "PAUSED_MANUAL", "RECOVERY_PENDING", "UNKNOWN"]);
  return {
    job_id: String(state?.job_id || ""),
    state: allowedStates.has(state?.state) ? state.state : "UNKNOWN",
    last_run_at: isoOrNull(state?.last_run_at),
    last_success_at: isoOrNull(state?.last_success_at),
    last_heartbeat_at: isoOrNull(state?.last_heartbeat_at),
    incident_id: state?.incident_id ? String(state.incident_id) : null
  };
}

function isoOrNull(value) {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function positiveTimeout(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.min(number, 30_000) : fallback;
}
