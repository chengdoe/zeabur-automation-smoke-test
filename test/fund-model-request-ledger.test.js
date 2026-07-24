import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  appendFundModelLedgerEntry,
  buildFundPromptHash,
  evaluateDailyFundModelBudget,
  getDailyFundModelBudget,
  readFundModelLedger,
  saveFundModelResponseArtifact,
  withFundModelRequestLock
} from "../src/jobs/fundModelRequestLedger.js";
import { getFundCostGovernanceConfig, getFundCostGovernanceStatus, recordFundModelAlert, readFundModelAlerts } from "../src/jobs/fundCostGovernance.js";

test("ledger budget blocks remote_unknown and only permits one pre-generation retry", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "fund-ledger-"));
  const date = "2026-07-24";
  const promptHash = buildFundPromptHash({ date, decision: "same prompt" });

  assert.equal((await getDailyFundModelBudget({ dataDir, date, promptHash })).maySubmit, true);

  await appendFundModelLedgerEntry({
    dataDir,
    date,
    entry: {
      job: "fund-portfolio-daily",
      runId: "run-1",
      prompt_hash: promptHash,
      attempt: 1,
      terminal_state: "request_submitted",
      provider: "openrouter",
      model: "x-ai/grok-4.5"
    }
  });
  await appendFundModelLedgerEntry({
    dataDir,
    date,
    entry: {
      job: "fund-portfolio-daily",
      runId: "run-1",
      prompt_hash: promptHash,
      attempt: 1,
      terminal_state: "pre_generation_retryable_failure",
      error_class: "model_http_status",
      retryable: true,
      http_status: 429
    }
  });

  const after429 = await getDailyFundModelBudget({ dataDir, date, promptHash });
  assert.equal(after429.submitted, 1);
  assert.equal(after429.maySubmit, true);

  await appendFundModelLedgerEntry({
    dataDir,
    date,
    entry: {
      job: "fund-portfolio-daily",
      runId: "run-2",
      prompt_hash: promptHash,
      attempt: 2,
      terminal_state: "request_submitted",
      provider: "openrouter",
      model: "x-ai/grok-4.5"
    }
  });
  await appendFundModelLedgerEntry({
    dataDir,
    date,
    entry: {
      job: "fund-portfolio-daily",
      runId: "run-2",
      prompt_hash: promptHash,
      attempt: 2,
      terminal_state: "remote_state_unknown",
      error_class: "remote_state_unknown",
      remote_state_unknown: true
    }
  });

  const afterUnknown = await getDailyFundModelBudget({ dataDir, date, promptHash });
  assert.equal(afterUnknown.maySubmit, false);
  assert.equal(afterUnknown.reason, "remote_state_unknown");
});

test("daily request config can tighten but never raise the hard cap above two", () => {
  assert.equal(getFundCostGovernanceConfig({ FUND_MODEL_MAX_DAILY_REQUESTS: "1" }).maxDailyRequests, 1);
  assert.equal(getFundCostGovernanceConfig({ FUND_MODEL_MAX_DAILY_REQUESTS: "99" }).maxDailyRequests, 2);
});

test("ledger and response metadata never persist prompt text or production-shaped secrets", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "fund-ledger-redaction-"));
  const date = "2026-07-24";
  const promptHash = buildFundPromptHash("Kane holdings prompt with 易方达黄金ETF联接C");

  await appendFundModelLedgerEntry({
    dataDir,
    date,
    entry: {
      job: "fund-portfolio-daily",
      runId: "safe-run",
      prompt_hash: promptHash,
      attempt: 1,
      provider: "openrouter",
      model: "x-ai/grok-4.5",
      terminal_state: "response_received",
      usage: {},
      cost: {}
    }
  });
  const artifact = await saveFundModelResponseArtifact({
    dataDir,
    date,
    runId: "safe-run",
    attempt: 1,
    text: "## 今日结论\n模型原文可隔离保存，但不是 ledger。",
    metadata: {
      date,
      prompt_hash: promptHash,
      provider: "openrouter",
      model: "x-ai/grok-4.5",
      request_id: "gen-safe"
    }
  });

  const ledgerText = JSON.stringify(await readFundModelLedger({ dataDir, date }));
  assert.match(ledgerText, /"input_tokens":null/);
  assert.match(ledgerText, /"total_usd":null/);
  assert.doesNotMatch(ledgerText, /易方达黄金ETF联接C|Kane holdings prompt|Bearer|OPENROUTER_API_KEY/);

  const metaText = await readFile(artifact.metadataFile, "utf8");
  assert.doesNotMatch(metaText, /模型原文|Bearer|OPENROUTER_API_KEY/);
});

test("alert ledger deduplicates daily warnings and exposes circuit-breaker status", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "fund-alerts-"));
  const date = "2026-07-24";
  const logger = { warn() {} };
  await recordFundModelAlert({
    dataDir,
    date,
    logger,
    alert: {
      job: "fund-portfolio-daily",
      severity: "block",
      reason: "remote_state_unknown",
      request_count: 1
    }
  });
  await recordFundModelAlert({
    dataDir,
    date,
    logger,
    alert: {
      job: "fund-portfolio-daily",
      severity: "block",
      reason: "remote_state_unknown",
      request_count: 1
    }
  });

  const alerts = await readFundModelAlerts({ dataDir, date });
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].sent, false);

  await appendFundModelLedgerEntry({
    dataDir,
    date,
    entry: {
      job: "fund-portfolio-daily",
      runId: "run-1",
      prompt_hash: buildFundPromptHash("same"),
      attempt: 1,
      terminal_state: "remote_state_unknown",
      remote_state_unknown: true,
      error_class: "remote_state_unknown"
    }
  });
  const status = await getFundCostGovernanceStatus({ dataDir, date });
  assert.equal(status.circuitBreaker.open, true);
  assert.ok(status.circuitBreaker.reasons.includes("remote_state_unknown"));
  assert.equal(status.alerting.feishuEnabled, false);
});

test("budget evaluator blocks in-flight, success, exhausted and token/cost overage states mechanically", () => {
  const promptHash = buildFundPromptHash("same");
  assert.equal(evaluateDailyFundModelBudget({
    entries: [{ job: "fund-portfolio-daily", prompt_hash: promptHash, terminal_state: "request_submitted" }],
    promptHash
  }).reason, "request_inflight");

  assert.equal(evaluateDailyFundModelBudget({
    entries: [
      { job: "fund-portfolio-daily", prompt_hash: promptHash, terminal_state: "request_submitted" },
      { job: "fund-portfolio-daily", prompt_hash: promptHash, terminal_state: "response_received" }
    ],
    promptHash
  }).reason, "response_already_received");

  assert.equal(evaluateDailyFundModelBudget({
    entries: [
      { job: "fund-portfolio-daily", prompt_hash: promptHash, terminal_state: "request_submitted" },
      { job: "fund-portfolio-daily", prompt_hash: promptHash, terminal_state: "response_received" }
    ],
    promptHash: buildFundPromptHash("changed prompt")
  }).reason, "response_already_received");
});

test("daily request lock serializes different prompt hashes", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "fund-ledger-lock-"));
  let active = 0;
  let peak = 0;
  const enter = async (promptHash) => withFundModelRequestLock({
    dataDir,
    date: "2026-07-24",
    promptHash
  }, async () => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 20));
    active -= 1;
    return { ok: true };
  });

  await Promise.all([
    enter(buildFundPromptHash("prompt-a")),
    enter(buildFundPromptHash("prompt-b"))
  ]);
  assert.equal(peak, 1);
});
