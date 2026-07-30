import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { recordSentinelRunResult } from "../src/ops/sentinelGuard.js";
import { getSentinelPolicy, getSentinelRuntimeConfig } from "../src/ops/sentinelPolicy.js";
import { getSentinelStatus, runSentinelWatchdogCycle } from "../src/ops/sentinelService.js";

const dataDir = await mkdtemp(path.join(os.tmpdir(), "sentinel-dry-run-"));
const now = new Date("2026-07-30T06:00:00.000Z");
const env = {
  SENTINEL_ENABLED: "true",
  SENTINEL_MODE: "shadow",
  SENTINEL_FEISHU_ENABLED: "false",
  SENTINEL_LIVE_SEND_ENABLED: "false"
};
const config = getSentinelRuntimeConfig(env);

try {
  const fund = await recordSentinelRunResult({
    dataDir,
    date: "2026-07-30",
    jobId: "fund-portfolio-daily",
    runId: "dry-run-fund-remote-unknown",
    result: {
      ok: false,
      phase: "model",
      error_class: "remote_state_unknown",
      request_count: 1,
      total_tokens: null,
      cost_usd: null
    },
    now,
    config,
    policy: getSentinelPolicy("fund-portfolio-daily")
  });
  const watchdog = await runSentinelWatchdogCycle({
    dataDir,
    now: new Date("2026-07-30T02:12:00.000Z"),
    env,
    expectations: [{
      jobId: "ai-hot",
      expectedAt: "2026-07-30T02:00:00.000Z",
      graceMs: 10 * 60 * 1000,
      policy: getSentinelPolicy("ai-hot")
    }],
    send: false
  });
  const status = await getSentinelStatus({ dataDir, date: "2026-07-30", env });
  console.log(JSON.stringify({
    fixture: "sentinel-shadow-v1",
    generatedAt: now.toISOString(),
    externalStateChanged: false,
    modelCalls: 0,
    feishuMessagesSent: 0,
    fund: {
      action: fund.action,
      state: fund.state.state,
      recommendedState: fund.state.recommended_state,
      incidentId: fund.incident.incident.incident_id,
      costKnown: fund.incident.incident.cost_known
    },
    watchdog: {
      incidents: watchdog.scan.incidents,
      delivery: watchdog.delivery
    },
    status: {
      runtime: status.runtime,
      counts: status.counts,
      jobs: status.jobs
    }
  }, null, 2));
} finally {
  await rm(dataDir, { recursive: true, force: true });
}
