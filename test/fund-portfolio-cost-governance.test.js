import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { createFundPortfolioAnalyzer } from "../src/jobs/fundPortfolioAnalyzer.js";
import { runFundPortfolioPipeline } from "../src/jobs/fundPortfolioPipeline.js";
import { readFundModelLedger } from "../src/jobs/fundModelRequestLedger.js";

function validReport(date = "2026-07-24") {
  return [
    `# 基金日报 ${date}`, "",
    "## 今日结论", "今天不操作。", "",
    "## 今天怎么做", "今天不操作。", "",
    "## 今天系统帮你盯到的机会", "暂无。", "",
    "## v8.0 机会层", "暂无。", "",
    "## 市场情况", "震荡。", "",
    "## 精简市场总结", "震荡。", "",
    "## 持仓今天表现", "暂无。", "",
    "## 为什么今天这个结论", "评分不足。", "",
    "## 方法论评分", "不足操作线。", "",
    "## 仓位分布", "正常。", "",
    "## 催化剂提醒", "暂无。", "",
    "## 风险关注", "控制仓位。", "",
    "## 风险提示和下一步盯什么", "关注数据。", "",
    "## 一句话心得", "纪律优先。"
  ].join("\n");
}

async function createPreparedFixture(date = "2026-07-24") {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "fund-cost-governance-"));
  const snapshotRoot = path.join(dataDir, "outputs", "automations", "fund-portfolio-daily", "prepared", date);
  await mkdir(snapshotRoot, { recursive: true });
  await writeFile(path.join(snapshotRoot, "raw-data.json"), JSON.stringify({
    date,
    data_quality: { overall_score: 8 },
    market_data: {
      fund_realtime: [{ code: "000001", estimated_change_pct: 0.1 }],
      analytics: { significant_movers: [{ should_not_be_prompt_source: true }] }
    },
    news_data: {}
  }));
  await writeFile(path.join(snapshotRoot, "portfolio_state.json"), JSON.stringify({ _version: "7.0", v8_opportunities: { buy_low: [] } }));
  await writeFile(path.join(snapshotRoot, "portfolio.json"), JSON.stringify({ holdings: [{ code: "000001", name: "易方达黄金ETF联接C", amount: 1000 }] }));
  await writeFile(path.join(snapshotRoot, "basket_config.json"), JSON.stringify({ hard_limits: { qdii: 0.3 } }));
  await writeFile(path.join(snapshotRoot, "scoring_config.json"), JSON.stringify({ sell_score: 80, buy_score: 75 }));
  await writeFile(path.join(snapshotRoot, "manifest.json"), JSON.stringify({ requestedDate: date }));
  return { dataDir, snapshotRoot };
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "x-request-id": `req-${status}` }
  });
}

test("timeout writes remote_state_unknown and blocks later slots and restarts from resubmitting", async () => {
  const { dataDir, snapshotRoot } = await createPreparedFixture();
  let fetchCalls = 0;
  const analyzer = createFundPortfolioAnalyzer({
    provider: "openrouter",
    apiKey: "test-key",
    model: "x-ai/grok-4.5",
    timeoutMs: 5,
    fetchImpl: (_url, options) => new Promise((_resolve, reject) => {
      fetchCalls += 1;
      options.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
    })
  });

  await assert.rejects(() => runFundPortfolioPipeline({
    date: "2026-07-24",
    dataDir,
    preparedSnapshot: snapshotRoot,
    scheduled: true,
    env: { FUND_PORTFOLIO_ENABLED: "true" },
    logger: { warn() {} },
    analyzer
  }), /remote_state_unknown/);

  let secondAnalyzerCalls = 0;
  const second = await runFundPortfolioPipeline({
    date: "2026-07-24",
    dataDir,
    preparedSnapshot: snapshotRoot,
    scheduled: true,
    env: { FUND_PORTFOLIO_ENABLED: "true" },
    logger: { warn() {} },
    analyzer: async () => {
      secondAnalyzerCalls += 1;
      return validReport();
    }
  });

  assert.equal(fetchCalls, 1);
  assert.equal(secondAnalyzerCalls, 0);
  assert.equal(second.skipped, true);
  assert.equal(second.sendSkippedReason, "remote_state_unknown");
  const ledger = await readFundModelLedger({ dataDir, date: "2026-07-24" });
  assert.equal(ledger.filter((entry) => entry.terminal_state === "request_submitted").length, 1);
  assert.ok(ledger.some((entry) => entry.remote_state_unknown));
});

test("429 pre-generation failure allows only one additional request; success blocks more repeats", async () => {
  const { dataDir, snapshotRoot } = await createPreparedFixture();
  const firstAnalyzer = createFundPortfolioAnalyzer({
    provider: "openrouter",
    apiKey: "test-key",
    model: "x-ai/grok-4.5",
    fetchImpl: async () => jsonResponse({ error: { message: "rate limited" } }, 429)
  });

  await assert.rejects(() => runFundPortfolioPipeline({
    date: "2026-07-24",
    dataDir,
    preparedSnapshot: snapshotRoot,
    scheduled: true,
    env: { FUND_PORTFOLIO_ENABLED: "true" },
    logger: { warn() {} },
    analyzer: firstAnalyzer
  }), /model_http_status/);

  const secondAnalyzer = createFundPortfolioAnalyzer({
    provider: "openrouter",
    apiKey: "test-key",
    model: "x-ai/grok-4.5",
    fetchImpl: async () => jsonResponse({
      id: "gen-success",
      choices: [{ message: { content: validReport() }, finish_reason: "stop" }],
      usage: { prompt_tokens: 100, completion_tokens: 200, total_tokens: 300, cost: 0.01 }
    })
  });
  const second = await runFundPortfolioPipeline({
    date: "2026-07-24",
    dataDir,
    preparedSnapshot: snapshotRoot,
    scheduled: true,
    env: { FUND_PORTFOLIO_ENABLED: "true" },
    logger: { warn() {} },
    analyzer: secondAnalyzer
  });
  assert.equal(second.ok, true);

  let thirdCalls = 0;
  const third = await runFundPortfolioPipeline({
    date: "2026-07-24",
    dataDir,
    preparedSnapshot: snapshotRoot,
    scheduled: true,
    env: { FUND_PORTFOLIO_ENABLED: "true" },
    logger: { warn() {} },
    analyzer: async () => {
      thirdCalls += 1;
      return validReport();
    }
  });
  assert.equal(third.skipped, true);
  assert.equal(third.sendSkippedReason, "response_already_received");
  assert.equal(thirdCalls, 0);

  const ledger = await readFundModelLedger({ dataDir, date: "2026-07-24" });
  assert.equal(ledger.filter((entry) => entry.terminal_state === "request_submitted").length, 2);
  assert.ok(ledger.some((entry) => entry.usage?.input_tokens === 100));
  assert.ok(ledger.some((entry) => entry.cost?.total_usd === 0.01));
});

test("gate false, weekend schedule, and sent ledger all stop before model", async () => {
  const gateFixture = await createPreparedFixture("2026-07-24");
  let calls = 0;
  const gated = await runFundPortfolioPipeline({
    date: "2026-07-24",
    dataDir: gateFixture.dataDir,
    preparedSnapshot: gateFixture.snapshotRoot,
    scheduled: true,
    env: { FUND_PORTFOLIO_ENABLED: "false" },
    logger: { warn() {} },
    analyzer: async () => {
      calls += 1;
      return validReport();
    }
  });
  assert.equal(gated.skipped, true);
  assert.equal(gated.sendSkippedReason, "fund gate closed");

  const weekendFixture = await createPreparedFixture("2026-07-18");
  const weekend = await runFundPortfolioPipeline({
    date: "2026-07-18",
    dataDir: weekendFixture.dataDir,
    preparedSnapshot: weekendFixture.snapshotRoot,
    scheduled: true,
    env: { FUND_PORTFOLIO_ENABLED: "true" },
    logger: { warn() {} },
    analyzer: async () => {
      calls += 1;
      return validReport("2026-07-18");
    }
  });
  assert.equal(weekend.skipped, true);
  assert.equal(weekend.sendSkippedReason, "weekend fund schedule closed");

  const sentFixture = await createPreparedFixture("2026-07-24");
  const sentDir = path.join(sentFixture.dataDir, "outputs", "automations", "fund-portfolio-daily");
  await mkdir(sentDir, { recursive: true });
  await writeFile(path.join(sentDir, "2026-07-24-sent.json"), JSON.stringify({ sent: true }));
  const sent = await runFundPortfolioPipeline({
    date: "2026-07-24",
    dataDir: sentFixture.dataDir,
    preparedSnapshot: sentFixture.snapshotRoot,
    scheduled: true,
    env: { FUND_PORTFOLIO_ENABLED: "true" },
    logger: { warn() {} },
    analyzer: async () => {
      calls += 1;
      return validReport();
    }
  });
  assert.equal(sent.skipped, true);
  assert.equal(sent.sendSkippedReason, "already sent");
  assert.equal(calls, 0);
});

test("validation failure preserves paid response artifact and replay uses zero analyzer calls", async () => {
  const { dataDir, snapshotRoot } = await createPreparedFixture();
  const paidAnalyzer = createFundPortfolioAnalyzer({
    provider: "openrouter",
    apiKey: "test-key",
    model: "x-ai/grok-4.5",
    fetchImpl: async () => jsonResponse({
      id: "gen-invalid",
      choices: [{ message: { content: "## 今日结论\ninvalid" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, cost: 0.001 }
    })
  });
  await assert.rejects(() => runFundPortfolioPipeline({
    date: "2026-07-24",
    dataDir,
    preparedSnapshot: snapshotRoot,
    env: { FUND_PORTFOLIO_ENABLED: "true" },
    logger: { warn() {} },
    analyzer: paidAnalyzer
  }), /missing section/);

  const requestDir = path.join(dataDir, "outputs", "automations", "fund-portfolio-daily", "model-requests", "2026-07-24");
  const files = await readdir(requestDir);
  const responseFile = files.find((file) => file.endsWith(".response.md"));
  assert.ok(responseFile);
  const ledger = await readFundModelLedger({ dataDir, date: "2026-07-24" });
  assert.ok(ledger.some((entry) => entry.terminal_state === "response_received"));
  await writeFile(path.join(requestDir, responseFile), validReport());

  let analyzerCalls = 0;
  const replay = await runFundPortfolioPipeline({
    date: "2026-07-24",
    dataDir,
    preparedSnapshot: snapshotRoot,
    env: { FUND_PORTFOLIO_ENABLED: "false" },
    replayModelArtifact: path.join(requestDir, responseFile),
    logger: { warn() {} },
    analyzer: async () => {
      analyzerCalls += 1;
      throw new Error("analyzer must not run during replay");
    }
  });
  assert.equal(replay.ok, true);
  assert.equal(analyzerCalls, 0);
});

test("concurrent same prompt does not double submit after first response", async () => {
  const { dataDir, snapshotRoot } = await createPreparedFixture();
  let fetchCalls = 0;
  const analyzer = createFundPortfolioAnalyzer({
    provider: "openrouter",
    apiKey: "test-key",
    model: "x-ai/grok-4.5",
    fetchImpl: async () => {
      fetchCalls += 1;
      return jsonResponse({
        id: `gen-${fetchCalls}`,
        choices: [{ message: { content: validReport() }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 }
      });
    }
  });

  const results = await Promise.all([
    runFundPortfolioPipeline({
      date: "2026-07-24",
      dataDir,
      preparedSnapshot: snapshotRoot,
      scheduled: true,
      env: { FUND_PORTFOLIO_ENABLED: "true" },
      logger: { warn() {} },
      analyzer
    }),
    runFundPortfolioPipeline({
      date: "2026-07-24",
      dataDir,
      preparedSnapshot: snapshotRoot,
      scheduled: true,
      env: { FUND_PORTFOLIO_ENABLED: "true" },
      logger: { warn() {} },
      analyzer
    })
  ]);

  assert.equal(fetchCalls, 1);
  assert.equal(results.filter((result) => result.ok).length, 1);
  assert.equal(results.filter((result) => result.skipped).length, 1);
});
