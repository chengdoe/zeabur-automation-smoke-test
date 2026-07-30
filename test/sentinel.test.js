import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { runSchedulerTick, createSchedulerState } from "../src/scheduler.js";
import {
  appendSentinelEvent,
  getSentinelJobStatePath,
  readSentinelEvents,
  readSentinelIncidents,
  readSentinelJobState,
  transitionSentinelJobState
} from "../src/ops/sentinelStore.js";
import {
  confirmSentinelRecovery,
  preflightSentinelJob,
  recordSentinelRunResult,
  recordSentinelRunStarted,
  requestSentinelRecovery
} from "../src/ops/sentinelGuard.js";
import { getSentinelPolicy, getSentinelRuntimeConfig } from "../src/ops/sentinelPolicy.js";
import { buildSentinelAlertPost, scanSentinelWatchdog } from "../src/ops/sentinelWatchdog.js";

const SHADOW_ENV = {
  SENTINEL_ENABLED: "true",
  SENTINEL_MODE: "shadow"
};

const AUTO_ENV = {
  SENTINEL_ENABLED: "true",
  SENTINEL_MODE: "auto_pause"
};

test("sentinel event and state stores are versioned, persistent, and secret-safe", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "sentinel-store-"));
  const state = await readSentinelJobState({ dataDir, jobId: "wisereads-weekly" });
  assert.equal(state.state, "ACTIVE");
  assert.equal(state.schema_version, "sentinel-state-v1");

  await appendSentinelEvent({
    dataDir,
    date: "2026-07-30",
    event: {
      schema_version: "sentinel-event-v1",
      policy_version: "sentinel-policy-v1",
      job_id: "wisereads-weekly",
      run_id: "run-1",
      event_type: "run_failed",
      severity: "warning",
      occurred_at: "2026-07-30T02:00:00.000Z",
      error_class: "send_failure",
      safe_summary: "fixture failure",
      app_secret: "must-not-persist",
      authorization: "Bearer must-not-persist"
    }
  });

  const events = await readSentinelEvents({ dataDir, date: "2026-07-30" });
  assert.equal(events.length, 1);
  assert.equal(events[0].job_id, "wisereads-weekly");
  const raw = await readFile(path.join(dataDir, "outputs", "ops", "sentinel", "events", "2026-07-30.jsonl"), "utf8");
  assert.doesNotMatch(raw, /must-not-persist|authorization|app_secret/i);
});

test("shadow mode records an immediate-pause recommendation without stopping the job", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "sentinel-shadow-"));
  const config = getSentinelRuntimeConfig(SHADOW_ENV);
  const policy = getSentinelPolicy("fund-portfolio-daily");

  await recordSentinelRunStarted({
    dataDir,
    date: "2026-07-30",
    jobId: "fund-portfolio-daily",
    runId: "fund-run-1",
    now: new Date("2026-07-30T05:50:00.000Z"),
    config,
    policy
  });
  const result = await recordSentinelRunResult({
    dataDir,
    date: "2026-07-30",
    jobId: "fund-portfolio-daily",
    runId: "fund-run-1",
    result: { ok: false, phase: "model", error_class: "remote_state_unknown" },
    now: new Date("2026-07-30T05:51:00.000Z"),
    config,
    policy
  });

  assert.equal(result.action, "shadow_pause_recommended");
  assert.equal(result.state.state, "WARNING");
  assert.equal(result.state.recommended_state, "PAUSED_AUTO");
  assert.equal((await preflightSentinelJob({ dataDir, jobId: "fund-portfolio-daily", config, policy })).allowed, true);
  assert.equal((await readSentinelIncidents({ dataDir, date: "2026-07-30" })).length, 1);
});

test("auto-pause mode survives restart and isolates one failed job", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "sentinel-pause-"));
  const config = getSentinelRuntimeConfig(AUTO_ENV);
  const policy = getSentinelPolicy("fund-portfolio-daily");

  await recordSentinelRunResult({
    dataDir,
    date: "2026-07-30",
    jobId: "fund-portfolio-daily",
    runId: "fund-run-2",
    result: { ok: false, phase: "model", error_class: "remote_state_unknown" },
    now: new Date("2026-07-30T05:51:00.000Z"),
    config,
    policy
  });

  const afterRestart = await readSentinelJobState({ dataDir, jobId: "fund-portfolio-daily" });
  assert.equal(afterRestart.state, "PAUSED_AUTO");
  assert.equal((await preflightSentinelJob({ dataDir, jobId: "fund-portfolio-daily", config, policy })).allowed, false);
  assert.equal((await preflightSentinelJob({ dataDir, jobId: "ai-hot", config, policy: getSentinelPolicy("ai-hot") })).allowed, true);
});

test("consecutive Wisereads failures pause at the task policy threshold", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "sentinel-consecutive-"));
  const config = getSentinelRuntimeConfig(AUTO_ENV);
  const policy = getSentinelPolicy("wisereads-weekly");

  const first = await recordSentinelRunResult({
    dataDir,
    date: "2026-07-30",
    jobId: "wisereads-weekly",
    runId: "wise-1",
    result: { ok: false, phase: "send", error_class: "send_failure" },
    now: new Date("2026-07-30T01:00:00.000Z"),
    config,
    policy
  });
  const second = await recordSentinelRunResult({
    dataDir,
    date: "2026-07-30",
    jobId: "wisereads-weekly",
    runId: "wise-2",
    result: { ok: false, phase: "send", error_class: "send_failure" },
    now: new Date("2026-07-30T01:30:00.000Z"),
    config,
    policy
  });

  assert.equal(first.state.state, "WARNING");
  assert.equal(second.state.state, "PAUSED_AUTO");
  assert.equal(second.state.consecutive_failures, 2);
  const incidents = await readSentinelIncidents({ dataDir, date: "2026-07-30" });
  assert.equal(incidents.length, 2);
  assert.equal(new Set(incidents.map((item) => item.incident_id)).size, 1);
  assert.deepEqual(incidents.map((item) => item.update_type), ["opened", "escalated"]);
});

test("concurrent failures update one task state without losing the failure count", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "sentinel-concurrent-"));
  const config = getSentinelRuntimeConfig(AUTO_ENV);
  const policy = getSentinelPolicy("wisereads-weekly");

  await Promise.all([
    recordSentinelRunResult({
      dataDir,
      date: "2026-07-30",
      jobId: "wisereads-weekly",
      runId: "wise-concurrent-1",
      result: { ok: false, phase: "model", error_class: "model_http_status" },
      now: new Date("2026-07-30T01:00:00.000Z"),
      config,
      policy
    }),
    recordSentinelRunResult({
      dataDir,
      date: "2026-07-30",
      jobId: "wisereads-weekly",
      runId: "wise-concurrent-2",
      result: { ok: false, phase: "model", error_class: "model_http_status" },
      now: new Date("2026-07-30T01:00:01.000Z"),
      config,
      policy
    })
  ]);

  const state = await readSentinelJobState({ dataDir, jobId: "wisereads-weekly" });
  assert.equal(state.consecutive_failures, 2);
  assert.equal(state.state, "PAUSED_AUTO");
});

test("recovery requires request, confirmation, and a bounded test result", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "sentinel-recovery-"));
  await transitionSentinelJobState({
    dataDir,
    jobId: "wisereads-weekly",
    toState: "PAUSED_AUTO",
    reason: "fixture",
    actor: "sentinel",
    now: new Date("2026-07-30T02:00:00.000Z")
  });

  const pending = await requestSentinelRecovery({
    dataDir,
    jobId: "wisereads-weekly",
    actorOpenId: "ou_kane",
    now: new Date("2026-07-30T02:01:00.000Z")
  });
  assert.equal(pending.state, "RECOVERY_PENDING");
  assert.ok(pending.recovery_nonce);

  await assert.rejects(
    confirmSentinelRecovery({ dataDir, jobId: "wisereads-weekly", actorOpenId: "ou_other", nonce: pending.recovery_nonce }),
    /authorized actor/i
  );

  const failedTrial = await confirmSentinelRecovery({
    dataDir,
    jobId: "wisereads-weekly",
    actorOpenId: "ou_kane",
    nonce: pending.recovery_nonce,
    trial: async () => ({ ok: false, error_class: "fixture_failure" }),
    now: new Date("2026-07-30T02:02:00.000Z")
  });
  assert.equal(failedTrial.state, "PAUSED_AUTO");
});

test("watchdog detects missed expectations once and builds a complete private alert", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "sentinel-watchdog-"));
  const expectations = [{
    jobId: "ai-hot",
    expectedAt: "2026-07-30T02:00:00.000Z",
    graceMs: 2 * 60 * 1000,
    policy: getSentinelPolicy("ai-hot")
  }];

  const first = await scanSentinelWatchdog({
    dataDir,
    expectations,
    now: new Date("2026-07-30T02:03:00.000Z")
  });
  const second = await scanSentinelWatchdog({
    dataDir,
    expectations,
    now: new Date("2026-07-30T02:04:00.000Z")
  });

  assert.equal(first.incidents.length, 1);
  assert.equal(first.incidents[0].error_class, "missed_sla");
  assert.equal(second.incidents.length, 0);
  assert.equal(second.duplicates.length, 1);

  const payload = buildSentinelAlertPost(first.incidents[0]);
  const text = JSON.stringify(payload);
  assert.match(text, /ai-hot/);
  assert.match(text, /missed_sla/);
  assert.match(text, /incident/i);
  assert.doesNotMatch(text, /secret|authorization/i);
});

test("remote watchdog never writes a local pause without an explicit remote pause handler", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "sentinel-remote-pause-"));
  const expectation = {
    jobId: "fund-portfolio-daily",
    expectedAt: "2026-07-30T05:50:00.000Z",
    graceMs: 60_000,
    policy: getSentinelPolicy("fund-portfolio-daily")
  };

  const result = await scanSentinelWatchdog({
    dataDir,
    expectations: [expectation],
    now: new Date("2026-07-30T05:52:00.000Z"),
    config: getSentinelRuntimeConfig(AUTO_ENV),
    stateProvider: async () => ({
      job_id: "fund-portfolio-daily",
      state: "ACTIVE",
      last_run_at: null,
      last_success_at: null,
      last_heartbeat_at: null
    })
  });

  assert.equal(result.incidents[0].action_taken, "pause_recommended");
  assert.equal(result.incidents[0].recommended_state, "PAUSED_AUTO");
  assert.equal((await readSentinelJobState({ dataDir, jobId: "fund-portfolio-daily" })).state, "ACTIVE");
});

test("scheduler skips a persistently paused job before prepare, model, or send", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "sentinel-scheduler-"));
  await transitionSentinelJobState({
    dataDir,
    jobId: "ai-hot",
    toState: "PAUSED_AUTO",
    reason: "fixture pause",
    actor: "sentinel",
    now: new Date("2026-07-30T01:59:00.000Z")
  });
  let sends = 0;
  let prepares = 0;

  const result = await runSchedulerTick({
    now: new Date("2026-07-30T02:00:00.000Z"),
    state: createSchedulerState(),
    dataDir,
    liveSendEnabled: true,
    enabledJobs: {
      "ai-hot": true,
      "morning-motivation": false,
      sop13: false,
      "fund-portfolio-daily": false,
      "wisereads-weekly": false
    },
    env: {
      ...AUTO_ENV,
      AI_HOT_ENABLED: "true"
    },
    prepareJob: async () => { prepares += 1; },
    sender: { async sendMessage() { sends += 1; } }
  });

  assert.equal(result.ran.length, 1);
  assert.equal(result.ran[0].skipped, true);
  assert.equal(result.ran[0].sendSkippedReason, "sentinel_paused");
  assert.equal(prepares, 0);
  assert.equal(sends, 0);
});

test("a corrupt low-risk Sentinel state degrades monitoring without stopping the task or later jobs", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "sentinel-degraded-low-risk-"));
  const stateFile = getSentinelJobStatePath({ dataDir, jobId: "morning-motivation" });
  await mkdir(path.dirname(stateFile), { recursive: true });
  await writeFile(stateFile, "{corrupt", "utf8");

  const result = await runSchedulerTick({
    now: new Date("2026-07-30T01:00:00.000Z"),
    state: createSchedulerState(),
    dataDir,
    enabledJobs: {
      "morning-motivation": true,
      sop13: false,
      "ai-hot": false,
      "fund-portfolio-daily": false,
      "wisereads-weekly": false
    },
    env: SHADOW_ENV
  });

  assert.equal(result.ran.length, 1);
  assert.equal(result.ran[0].job, "morningMotivation");
  assert.equal(result.ran[0].ok, true);
  assert.equal(Boolean(result.ran[0].skipped), false);
});

test("fund failures carry known request usage into Sentinel while unknown cost stays unknown", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "sentinel-fund-usage-"));
  const result = await runSchedulerTick({
    now: new Date("2026-07-30T05:50:00.000Z"),
    state: createSchedulerState(),
    dataDir,
    liveSendEnabled: true,
    enabledJobs: {
      "ai-hot": false,
      "morning-motivation": false,
      sop13: false,
      "fund-portfolio-daily": true,
      "wisereads-weekly": false
    },
    env: { ...AUTO_ENV, FUND_PORTFOLIO_ENABLED: "true" },
    prepareJob: async () => {
      throw Object.assign(new Error("fixture timeout"), {
        error_class: "remote_state_unknown",
        phase: "model",
        retryable: false,
        request_count: 1,
        total_tokens: null,
        cost_usd: null
      });
    }
  });

  assert.equal(result.ran[0].request_count, 1);
  assert.equal(result.ran[0].cost_usd, null);
  const incidents = await readSentinelIncidents({ dataDir, date: "2026-07-30" });
  assert.equal(incidents.length, 1);
  assert.equal(incidents[0].request_count, 1);
  assert.equal(incidents[0].cost_usd, null);
  assert.equal(incidents[0].cost_known, false);
});

test("sentinel remains fail-closed at configuration level until explicitly enabled", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "sentinel-disabled-"));
  const config = getSentinelRuntimeConfig({});
  assert.equal(config.enabled, false);
  assert.equal(config.mode, "shadow");

  const result = await recordSentinelRunResult({
    dataDir,
    date: "2026-07-30",
    jobId: "ai-hot",
    runId: "disabled-1",
    result: { ok: false, error_class: "source_unavailable" },
    config,
    policy: getSentinelPolicy("ai-hot")
  });
  assert.equal(result.skipped, true);
  assert.equal(existsSync(path.join(dataDir, "outputs", "ops", "sentinel")), false);
});
