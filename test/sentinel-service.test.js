import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  buildSentinelExpectations,
  fetchSentinelMonitorSnapshot,
  getSentinelStatus,
  runSentinelWatchdogCycle
} from "../src/ops/sentinelService.js";
import { deliverSentinelIncidents } from "../src/ops/sentinelAlerting.js";
import { getSentinelPolicy } from "../src/ops/sentinelPolicy.js";
import { readSentinelAlertDeliveries } from "../src/ops/sentinelStore.js";

const INCIDENT = {
  policy_version: "sentinel-policy-v1",
  incident_id: "inc_fixture_1",
  job_id: "fund-portfolio-daily",
  business_date: "2026-07-30",
  opened_at: "2026-07-30T06:00:00.000Z",
  phase: "model",
  severity: "critical",
  error_class: "remote_state_unknown",
  reason: "remote_state_unknown",
  action_taken: "paused_auto",
  job_state: "PAUSED_AUTO",
  cost_known: false
};

test("schedule-aware expectations use Shanghai time and only monitor enabled optional jobs", () => {
  const expectations = buildSentinelExpectations({
    now: new Date("2026-07-30T06:31:00.000Z"),
    env: {
      SCHEDULER_ENABLED: "true",
      AI_HOT_SCHEDULER_ENABLED: "true",
      FUND_PORTFOLIO_ENABLED: "true",
      WISEREADS_WEEKLY_SCHEDULER_ENABLED: "false"
    }
  });

  assert.deepEqual(expectations.map((item) => item.jobId), [
    "morning-motivation",
    "sop13",
    "ai-hot",
    "fund-portfolio-daily"
  ]);
  assert.equal(expectations.find((item) => item.jobId === "ai-hot").expectedAt, "2026-07-30T02:00:00.000Z");
  assert.equal(expectations.find((item) => item.jobId === "fund-portfolio-daily").expectedAt, "2026-07-30T05:50:00.000Z");
});

test("sentinel status is read-only, secret-safe, and explicit about closed gates", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "sentinel-status-"));
  const status = await getSentinelStatus({
    dataDir,
    date: "2026-07-30",
    env: {
      SENTINEL_ENABLED: "true",
      SENTINEL_MODE: "shadow",
      SENTINEL_BOT_ROLE: "sentinel",
      SENTINEL_CONNECTION_REF: "sentinel",
      SENTINEL_TARGET_CHAT_ID: "oc_fixture",
      FEISHU_CONNECTION_SENTINEL_APP_ID: "cli_fixture",
      FEISHU_CONNECTION_SENTINEL_APP_SECRET: "must-not-leak"
    }
  });

  assert.equal(status.ok, true);
  assert.equal(status.runtime.mode, "shadow");
  assert.equal(status.runtime.alertSendEnabled, false);
  assert.equal(status.identity.configured, true);
  assert.equal(status.modelCalls, 0);
  assert.equal(status.jobs.length, 5);
  assert.doesNotMatch(JSON.stringify(status), /must-not-leak|APP_SECRET|authorization|Bearer/i);
});

test("alert delivery stays closed until every Sentinel gate and identity field is ready", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "sentinel-alert-closed-"));
  let sends = 0;
  const sender = { async sendMessage() { sends += 1; } };

  const preview = await deliverSentinelIncidents({
    dataDir,
    date: "2026-07-30",
    incidents: [INCIDENT],
    env: { SENTINEL_ENABLED: "true", SENTINEL_FEISHU_ENABLED: "true" },
    sender
  });
  assert.equal(preview.sent.length, 0);
  assert.equal(preview.blockedReason, "sentinel_live_send_disabled");
  assert.equal(sends, 0);

  const missingIdentity = await deliverSentinelIncidents({
    dataDir,
    date: "2026-07-30",
    incidents: [INCIDENT],
    env: {
      SENTINEL_ENABLED: "true",
      SENTINEL_FEISHU_ENABLED: "true",
      SENTINEL_LIVE_SEND_ENABLED: "true"
    },
    sender
  });
  assert.equal(missingIdentity.sent.length, 0);
  assert.equal(missingIdentity.blockedReason, "sentinel_identity_incomplete");
  assert.equal(sends, 0);
});

test("enabled alert delivery sends one native post per incident update and deduplicates across restarts", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "sentinel-alert-send-"));
  const requests = [];
  const sender = {
    async sendMessage(request) {
      requests.push(request);
      return { ok: true, messageId: "om_sentinel_fixture" };
    }
  };
  const env = {
    SENTINEL_ENABLED: "true",
    SENTINEL_FEISHU_ENABLED: "true",
    SENTINEL_LIVE_SEND_ENABLED: "true",
    SENTINEL_BOT_ROLE: "sentinel",
    SENTINEL_CONNECTION_REF: "sentinel",
    SENTINEL_TARGET_CHAT_ID: "oc_fixture",
    FEISHU_CONNECTION_SENTINEL_APP_ID: "cli_fixture",
    FEISHU_CONNECTION_SENTINEL_APP_SECRET: "fixture-secret"
  };

  const first = await deliverSentinelIncidents({ dataDir, date: "2026-07-30", incidents: [INCIDENT], env, sender });
  const second = await deliverSentinelIncidents({ dataDir, date: "2026-07-30", incidents: [INCIDENT], env, sender });
  const escalated = await deliverSentinelIncidents({
    dataDir,
    date: "2026-07-30",
    incidents: [{ ...INCIDENT, update_type: "escalated" }],
    env,
    sender
  });

  assert.equal(first.sent.length, 1);
  assert.equal(second.sent.length, 0);
  assert.equal(second.duplicates.length, 1);
  assert.equal(escalated.sent.length, 1);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].msgType, "post");
  assert.match(JSON.stringify(requests[0].payload), /remote_state_unknown/);
  assert.notEqual(requests[0].uuid, requests[1].uuid);
  assert.match(requests[0].uuid, /-opened$/);
  assert.match(requests[1].uuid, /-escalated$/);
  const deliveries = await readSentinelAlertDeliveries({ dataDir, date: "2026-07-30" });
  assert.equal(deliveries.filter((item) => item.delivery_state === "sent").length, 2);
});

test("watchdog cycle is zero-model and defaults to a non-sending dry run", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "sentinel-cycle-"));
  let sends = 0;
  const result = await runSentinelWatchdogCycle({
    dataDir,
    now: new Date("2026-07-30T02:12:00.000Z"),
    env: {
      SENTINEL_ENABLED: "true",
      SENTINEL_MODE: "shadow",
      SCHEDULER_ENABLED: "true",
      AI_HOT_SCHEDULER_ENABLED: "true"
    },
    send: false,
    sender: { async sendMessage() { sends += 1; } }
  });

  assert.ok(result.scan.incidents.some((item) => item.job_id === "ai-hot"));
  assert.equal(result.delivery.sent.length, 0);
  assert.equal(result.modelCalls, 0);
  assert.equal(sends, 0);
});

test("remote monitor snapshot uses a bounded authenticated read without exposing its credential", async () => {
  let request;
  const snapshot = await fetchSentinelMonitorSnapshot({
    url: "https://automation.example.test/api/sentinel/monitor-status",
    credential: "fixture-monitor-credential",
    fetchImpl: async (url, options) => {
      request = { url: String(url), options };
      return new Response(JSON.stringify({
        ok: true,
        sentinel: { jobs: [{ job_id: "ai-hot", state: "ACTIVE", last_run_at: "2026-07-30T02:00:00.000Z" }] }
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
  });

  assert.equal(request.options.headers.authorization, "Bearer fixture-monitor-credential");
  assert.equal(snapshot.jobs[0].job_id, "ai-hot");
  assert.doesNotMatch(JSON.stringify(snapshot), /fixture-monitor-credential|authorization/i);
});

test("an unreachable monitored service produces one deduplicated service-level incident", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "sentinel-remote-down-"));
  const env = {
    SENTINEL_ENABLED: "true",
    SENTINEL_MODE: "shadow",
    SENTINEL_MONITORED_STATUS_URL: "https://automation.example.test/api/sentinel/monitor-status",
    SENTINEL_MONITORED_STATUS_CREDENTIAL: "fixture-credential"
  };
  const fetchImpl = async () => { throw Object.assign(new Error("offline"), { code: "ECONNREFUSED" }); };

  const first = await runSentinelWatchdogCycle({
    dataDir,
    now: new Date("2026-07-30T02:12:00.000Z"),
    env,
    fetchImpl,
    send: false
  });
  const second = await runSentinelWatchdogCycle({
    dataDir,
    now: new Date("2026-07-30T02:13:00.000Z"),
    env,
    fetchImpl,
    send: false
  });

  assert.equal(first.scan.incidents.length, 1);
  assert.equal(first.scan.incidents[0].job_id, "automation-service");
  assert.equal(first.scan.incidents[0].error_class, "monitor_target_unavailable");
  assert.equal(second.scan.incidents.length, 0);
  assert.equal(second.scan.duplicates.length, 1);
});

test("a failed alert is retried on the next watchdog cycle without creating a new incident", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "sentinel-alert-retry-"));
  const env = {
    SENTINEL_ENABLED: "true",
    SENTINEL_MODE: "shadow",
    SENTINEL_FEISHU_ENABLED: "true",
    SENTINEL_LIVE_SEND_ENABLED: "true",
    SENTINEL_BOT_ROLE: "sentinel",
    SENTINEL_CONNECTION_REF: "sentinel",
    SENTINEL_TARGET_CHAT_ID: "oc_fixture",
    FEISHU_CONNECTION_SENTINEL_APP_ID: "cli_fixture",
    FEISHU_CONNECTION_SENTINEL_APP_SECRET: "fixture-secret"
  };
  const expectations = [{
    jobId: "ai-hot",
    expectedAt: "2026-07-30T02:00:00.000Z",
    graceMs: 60_000,
    policy: getSentinelPolicy("ai-hot")
  }];
  let attempts = 0;
  const sender = {
    async sendMessage() {
      attempts += 1;
      if (attempts === 1) throw Object.assign(new Error("fixture send failure"), { code: "FEISHU_SEND_FAILED" });
      return { messageId: "om_retry_success" };
    }
  };

  const first = await runSentinelWatchdogCycle({
    dataDir,
    now: new Date("2026-07-30T02:03:00.000Z"),
    env,
    expectations,
    send: true,
    sender
  });
  const second = await runSentinelWatchdogCycle({
    dataDir,
    now: new Date("2026-07-30T02:04:00.000Z"),
    env,
    expectations,
    send: true,
    sender
  });

  assert.equal(first.delivery.failed.length, 1);
  assert.equal(second.scan.incidents.length, 0);
  assert.equal(second.scan.duplicates.length, 1);
  assert.equal(second.delivery.sent.length, 1);
  assert.equal(attempts, 2);
});
