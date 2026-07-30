import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";

import {
  preflightSentinelJob,
  recordSentinelRunResult,
  recordSentinelRunStarted
} from "../src/ops/sentinelGuard.js";
import { getSentinelPolicy, getSentinelRuntimeConfig } from "../src/ops/sentinelPolicy.js";

const dataDir = await mkdtemp(path.join(os.tmpdir(), "sentinel-benchmark-"));
const config = getSentinelRuntimeConfig({ SENTINEL_ENABLED: "true", SENTINEL_MODE: "shadow" });
const policy = getSentinelPolicy("ai-hot");
const timings = [];

try {
  for (let index = 0; index < 200; index += 1) {
    const started = performance.now();
    const now = new Date(1_785_379_200_000 + index * 1000);
    const runId = `benchmark-${index}`;
    await preflightSentinelJob({ dataDir, jobId: "ai-hot", config, policy });
    await recordSentinelRunStarted({
      dataDir,
      date: "2026-07-30",
      jobId: "ai-hot",
      runId,
      now,
      config,
      policy
    });
    await recordSentinelRunResult({
      dataDir,
      date: "2026-07-30",
      jobId: "ai-hot",
      runId,
      result: { ok: true, phase: "benchmark" },
      now,
      config,
      policy
    });
    timings.push(performance.now() - started);
  }
  timings.sort((a, b) => a - b);
  const memory = process.memoryUsage();
  console.log(JSON.stringify({
    ok: true,
    iterations: timings.length,
    guardRoundTripMs: {
      p50: round(percentile(timings, 0.5)),
      p95: round(percentile(timings, 0.95)),
      max: round(timings.at(-1)),
      mean: round(timings.reduce((sum, value) => sum + value, 0) / timings.length)
    },
    processMemoryMb: {
      rss: round(memory.rss / 1024 / 1024),
      heapUsed: round(memory.heapUsed / 1024 / 1024)
    },
    modelCalls: 0,
    externalCalls: 0
  }, null, 2));
} finally {
  await rm(dataDir, { recursive: true, force: true });
}

function percentile(values, fraction) {
  return values[Math.min(values.length - 1, Math.floor(values.length * fraction))];
}

function round(value) {
  return Math.round(value * 100) / 100;
}
