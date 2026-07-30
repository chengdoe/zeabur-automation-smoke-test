import { createHash } from "node:crypto";

import {
  readSentinelJobState,
  recordSentinelIncident,
  transitionSentinelJobState
} from "./sentinelStore.js";

export async function scanSentinelWatchdog({
  dataDir,
  expectations = [],
  now = new Date(),
  config = {},
  stateProvider,
  pauseHandler
}) {
  const incidents = [];
  const duplicates = [];
  const healthy = [];

  for (const expectation of expectations) {
    const expectedAt = new Date(expectation.expectedAt);
    if (Number.isNaN(expectedAt.getTime())) throw new Error(`Invalid expectedAt for ${expectation.jobId}`);
    const graceMs = nonNegativeNumber(expectation.graceMs, 0);
    if (now.getTime() <= expectedAt.getTime() + graceMs) {
      healthy.push({ jobId: expectation.jobId, reason: "within_grace" });
      continue;
    }

    let state;
    try {
      state = stateProvider
        ? await stateProvider(expectation.jobId)
        : await readSentinelJobState({ dataDir, jobId: expectation.jobId });
      if (!state) throw Object.assign(new Error("missing monitored job state"), { code: "MONITORED_STATE_MISSING" });
    } catch (error) {
      state = { state: "WARNING", last_run_at: null, last_heartbeat_at: null, incident_id: null };
    }
    const lastObserved = latestDate(state.last_run_at, state.last_heartbeat_at, state.last_success_at);
    if (lastObserved && lastObserved.getTime() >= expectedAt.getTime()) {
      healthy.push({ jobId: expectation.jobId, reason: "observed", lastObservedAt: lastObserved.toISOString() });
      continue;
    }

    const incidentId = buildMissedSlaIncidentId(expectation.jobId, expectedAt.toISOString());
    const shouldPause = expectation.policy?.pauseOnMissedSla
      && config.mode === "auto_pause"
      && (!stateProvider || typeof pauseHandler === "function");
    if (shouldPause && ["ACTIVE", "WARNING"].includes(state.state)) {
      state = pauseHandler
        ? await pauseHandler({
            jobId: expectation.jobId,
            reason: "missed_sla",
            incidentId,
            policyVersion: expectation.policy?.policyVersion || "sentinel-policy-v1",
            now
          })
        : await transitionSentinelJobState({
            dataDir,
            jobId: expectation.jobId,
            toState: "PAUSED_AUTO",
            reason: "missed_sla",
            actor: "sentinel-watchdog",
            incidentId,
            policyVersion: expectation.policy?.policyVersion || "sentinel-policy-v1",
            now
          });
    }
    const recorded = await recordSentinelIncident({
      dataDir,
      date: shanghaiDateFromIso(expectedAt.toISOString()),
      incident: {
        policy_version: expectation.policy?.policyVersion || "sentinel-policy-v1",
        incident_id: incidentId,
        update_type: "opened",
        job_id: expectation.jobId,
        opened_at: now.toISOString(),
        expected_at: expectedAt.toISOString(),
        detected_at: now.toISOString(),
        phase: "watchdog",
        severity: expectation.policy?.risk === "high" ? "critical" : "warning",
        error_class: "missed_sla",
        reason: `expected run not observed within ${graceMs}ms grace`,
        action_taken: shouldPause ? "paused_auto" : expectation.policy?.pauseOnMissedSla ? "pause_recommended" : "warning",
        job_state: state.state,
        recommended_state: expectation.policy?.pauseOnMissedSla && !shouldPause ? "PAUSED_AUTO" : null,
        cost_known: false,
        safe_summary: `${expectation.jobId} missed expected run`
      }
    });
    if (recorded.duplicate) duplicates.push(recorded.incident);
    else incidents.push(recorded.incident);
  }

  return {
    checkedAt: now.toISOString(),
    incidents,
    duplicates,
    healthy
  };
}

export function buildSentinelAlertPost(incident) {
  const costText = incident.cost_known ? `${incident.cost_usd ?? "unknown"} USD` : "unknown（按未知处理）";
  const paused = ["PAUSED_AUTO", "PAUSED_MANUAL", "RECOVERY_PENDING"].includes(incident.job_state);
  return {
    zh_cn: {
      title: "",
      content: [
        [{ tag: "text", text: "【哨兵 · 自动化异常】", style: ["bold"] }],
        [{ tag: "text", text: `任务：${incident.job_id}` }],
        [{ tag: "text", text: `级别：${incident.severity} · 阶段：${incident.phase || "unknown"}` }],
        [{ tag: "text", text: `原因：${incident.error_class} · ${incident.reason}` }],
        [{ tag: "text", text: `已采取：${incident.action_taken || "warning"} · 当前状态：${incident.job_state || "unknown"}` }],
        [{ tag: "text", text: `影响：${paused ? "本任务后续执行已被阻断，其他任务不受影响" : "本任务需要检查，其他任务继续运行"}` }],
        [{ tag: "text", text: `费用：${costText}` }],
        [{ tag: "text", text: `Incident：${incident.incident_id}` }],
        [{ tag: "text", text: `策略：${incident.policy_version} · 更新：${incident.update_type || "opened"}` }],
        [{ tag: "text", text: paused
          ? "恢复：先在哨兵状态页发起恢复，再二次确认并执行一次受控试运行。"
          : "下一步：在哨兵状态页查看详情；未授权前不会自动恢复或部署。" }]
      ]
    }
  };
}

function buildMissedSlaIncidentId(jobId, expectedAt) {
  return `inc_${createHash("sha256").update(`${jobId}:${expectedAt}:missed_sla`).digest("hex").slice(0, 20)}`;
}

function latestDate(...values) {
  const dates = values.filter(Boolean).map((value) => new Date(value)).filter((date) => !Number.isNaN(date.getTime()));
  if (!dates.length) return null;
  return dates.sort((a, b) => b.getTime() - a.getTime())[0];
}

function shanghaiDateFromIso(value) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date(value));
  const data = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${data.year}-${data.month}-${data.day}`;
}

function nonNegativeNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}
