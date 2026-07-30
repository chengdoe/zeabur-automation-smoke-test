import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { buildWisereadsWeeklyDryRun } from "../src/jobs/wisereadsWeekly.js";
import {
  getSentinelModelBudget,
  readSentinelModelLedger,
  recordSentinelModelAttemptStart,
  recordSentinelModelAttemptTerminal,
  withSentinelModelRequestLock
} from "../src/ops/sentinelModelBudget.js";

test("generic model budget blocks a second paid submission for the same business key", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "sentinel-model-budget-"));
  await recordSentinelModelAttemptStart({
    dataDir,
    jobId: "wisereads-weekly",
    businessKey: "vol-153",
    runId: "run-1",
    provider: "openrouter",
    model: "fixture-model",
    promptHash: "sha256:fixture"
  });
  await recordSentinelModelAttemptTerminal({
    dataDir,
    jobId: "wisereads-weekly",
    businessKey: "vol-153",
    entry: {
      run_id: "run-1",
      terminal_state: "request_failed",
      error_class: "model_http_status",
      retryable: false
    }
  });

  const budget = await getSentinelModelBudget({
    dataDir,
    jobId: "wisereads-weekly",
    businessKey: "vol-153",
    maxRequests: 1
  });
  assert.equal(budget.maySubmit, false);
  assert.equal(budget.submitted, 1);
  assert.equal(budget.reason, "daily_model_budget_exhausted");
});

test("remote state unknown and inflight requests block all blind retries", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "sentinel-model-unknown-"));
  await recordSentinelModelAttemptStart({
    dataDir,
    jobId: "wisereads-weekly",
    businessKey: "vol-154",
    runId: "run-1",
    provider: "openrouter",
    model: "fixture-model",
    promptHash: "sha256:fixture"
  });
  let budget = await getSentinelModelBudget({ dataDir, jobId: "wisereads-weekly", businessKey: "vol-154", maxRequests: 2 });
  assert.equal(budget.maySubmit, false);
  assert.equal(budget.reason, "request_inflight");

  await recordSentinelModelAttemptTerminal({
    dataDir,
    jobId: "wisereads-weekly",
    businessKey: "vol-154",
    entry: {
      run_id: "run-1",
      terminal_state: "remote_state_unknown",
      remote_state_unknown: true,
      error_class: "remote_state_unknown",
      retryable: false
    }
  });
  budget = await getSentinelModelBudget({ dataDir, jobId: "wisereads-weekly", businessKey: "vol-154", maxRequests: 2 });
  assert.equal(budget.maySubmit, false);
  assert.equal(budget.reason, "remote_state_unknown");
});

test("unknown model usage stays null instead of being converted to zero", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "sentinel-model-unknown-usage-"));
  await recordSentinelModelAttemptTerminal({
    dataDir,
    jobId: "wisereads-weekly",
    businessKey: "vol-unknown-usage",
    entry: {
      run_id: "run-unknown-usage",
      terminal_state: "request_failed",
      input_tokens: null,
      output_tokens: undefined,
      total_tokens: "",
      cost_usd: null,
      retryable: false
    }
  });

  const [entry] = await readSentinelModelLedger({
    dataDir,
    jobId: "wisereads-weekly",
    businessKey: "vol-unknown-usage"
  });
  assert.equal(entry.input_tokens, null);
  assert.equal(entry.output_tokens, null);
  assert.equal(entry.total_tokens, null);
  assert.equal(entry.cost_usd, null);
});

test("generic model request lock serializes callers for the same job and business key", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "sentinel-model-lock-"));
  let active = 0;
  let maxActive = 0;
  const work = () => withSentinelModelRequestLock({
    dataDir,
    jobId: "wisereads-weekly",
    businessKey: "vol-155"
  }, async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 20));
    active -= 1;
  });
  await Promise.all([work(), work()]);
  assert.equal(maxActive, 1);
});

test("Wisereads analyzer failure is not resubmitted by the next retry slot", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "sentinel-wisereads-model-"));
  let analyzerCalls = 0;
  const analyzer = async () => {
    analyzerCalls += 1;
    throw Object.assign(new Error("fixture provider failure"), { error_class: "model_http_status" });
  };
  const feedXml = buildFeedXml(156);

  const first = await buildWisereadsWeeklyDryRun({
    date: "2026-07-30",
    dataDir,
    feedXml,
    analyzer,
    env: { WISEREADS_ANALYSIS_MODEL: "fixture-model" }
  });
  const second = await buildWisereadsWeeklyDryRun({
    date: "2026-07-30",
    dataDir,
    feedXml,
    analyzer,
    env: { WISEREADS_ANALYSIS_MODEL: "fixture-model" }
  });

  assert.equal(first.ok, false);
  assert.equal(second.ok, false);
  assert.equal(analyzerCalls, 1);
  assert.match(second.analysis?.error || second.sendSkippedReason || "", /budget|blocked/i);
  const ledger = await readSentinelModelLedger({ dataDir, jobId: "wisereads-weekly", businessKey: "vol-156" });
  assert.equal(ledger.filter((entry) => entry.terminal_state === "request_submitted").length, 1);
});

function buildFeedXml(vol) {
  const sections = ["Article", "Article", "YouTube", "Twitter", "PDF", "Book"];
  return `<?xml version="1.0"?><rss><channel><item><title>Wisereads Vol. ${vol}</title><link>https://example.com/${vol}</link><pubDate>Thu, 30 Jul 2026 01:00:00 +0000</pubDate><content:encoded><![CDATA[<main>${sections.map((section, index) => `<h2>${section}</h2><h3><a href="https://example.com/${index}">Item ${index}</a></h3><p class="author">Author ${index}</p><p>Summary ${index}</p><p>Quote ${index}</p>`).join("")}</main>]]></content:encoded></item></channel></rss>`;
}
