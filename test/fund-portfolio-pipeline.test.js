import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { runFundPortfolioPipeline } from "../src/jobs/fundPortfolioPipeline.js";

function validReport(date = "2026-07-16") {
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

async function createPipelineFixture(prefix = "fund-pipeline-reliability-") {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), prefix));
  const configDir = path.join(dataDir, "fund-portfolio-daily", "skill", "config");
  const v8Dir = path.join(configDir, "v8_state");
  await mkdir(v8Dir, { recursive: true });
  const canonical = {
    portfolio: { marker: "canonical-portfolio" },
    portfolio_state: { marker: "canonical-state" },
    basket_config: { marker: "canonical-basket" },
    scoring_config: { marker: "canonical-scoring" },
    rebuy_log: { marker: "canonical-rebuy" },
    tp_state: { marker: "canonical-tp" }
  };
  await writeFile(path.join(configDir, "portfolio.json"), JSON.stringify(canonical.portfolio));
  await writeFile(path.join(configDir, "portfolio_state.json"), JSON.stringify(canonical.portfolio_state));
  await writeFile(path.join(configDir, "basket_config.json"), JSON.stringify(canonical.basket_config));
  await writeFile(path.join(configDir, "scoring_config.json"), JSON.stringify(canonical.scoring_config));
  await writeFile(path.join(v8Dir, "rebuy_log.json"), JSON.stringify(canonical.rebuy_log));
  await writeFile(path.join(v8Dir, "tp_state.json"), JSON.stringify(canonical.tp_state));
  return { dataDir, configDir, canonical };
}

function stagingCommandRunner(commands) {
  return async (command, args, options) => {
    commands.push(path.basename(args[0]));
    const configDir = path.join(options.env.FUND_SKILL_ROOT, "config");
    const rawDir = path.join(options.env.FUND_OUTPUTS_ROOT, "reports", "raw-data");
    if (args[0].endsWith("data_fetch_only.py")) {
      await mkdir(rawDir, { recursive: true });
      await writeFile(path.join(rawDir, `fund-daily-raw-${options.env.FUND_RUN_DATE}.json`), JSON.stringify({
        date: options.env.FUND_RUN_DATE,
        data_quality: { overall_score: 9 },
        market_data: {},
        news_data: {}
      }));
    }
    if (args[0].endsWith("portfolio_state_tracker.py")) {
      await writeFile(path.join(configDir, "portfolio_state.json"), JSON.stringify({ marker: "prepared-state", _version: "7.0" }));
    }
    return { stdout: "", stderr: "" };
  };
}

test("fund pipeline runs data, v7, v8 and writes an exact-date report", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "fund-pipeline-"));
  const assetRoot = path.join(dataDir, "fund-portfolio-daily");
  const skillRoot = path.join(assetRoot, "skill");
  const outputsRoot = path.join(assetRoot, "project", "outputs");
  const configDir = path.join(skillRoot, "config");
  const rawDir = path.join(outputsRoot, "reports", "raw-data");
  await mkdir(configDir, { recursive: true });
  await mkdir(rawDir, { recursive: true });
  await writeFile(path.join(configDir, "portfolio.json"), JSON.stringify({ portfolio: [] }), "utf8");
  await writeFile(path.join(configDir, "basket_config.json"), JSON.stringify({}), "utf8");
  await writeFile(path.join(configDir, "scoring_config.json"), JSON.stringify({}), "utf8");

  const commands = [];
  const result = await runFundPortfolioPipeline({
    date: "2026-07-13",
    dataDir,
    commandRunner: async (command, args, options) => {
      commands.push({ command, args, env: options.env });
      if (args[0].endsWith("data_fetch_only.py")) {
        const stagedRawDir = path.join(options.env.FUND_OUTPUTS_ROOT, "reports", "raw-data");
        await mkdir(stagedRawDir, { recursive: true });
        await writeFile(path.join(stagedRawDir, "fund-daily-raw-2026-07-13.json"), JSON.stringify({
          date: "2026-07-13",
          data_quality: { overall_score: 9, decision_level: "cautious" },
          market_data: {},
          news_data: {}
        }), "utf8");
      }
      if (args[0].endsWith("portfolio_state_tracker.py")) {
        await writeFile(path.join(options.env.FUND_SKILL_ROOT, "config", "portfolio_state.json"), JSON.stringify({
          _version: "7.0",
          v8_opportunities: {}
        }), "utf8");
      }
      return { stdout: "", stderr: "" };
    },
    analyzer: async ({ date, rawData, portfolioState }) => {
      assert.equal(date, "2026-07-13");
      assert.equal(rawData.date, date);
      assert.equal(portfolioState._version, "7.0");
      return [
        `# 基金日报 ${date}`, "",
        "> 迁移回放预览，不发送，不执行交易", "",
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
  });

  assert.equal(result.ok, true);
  assert.equal(result.sent, false);
  assert.equal(result.dryRun, true);
  assert.equal(result.promoted, false);
  assert.equal(result.phase, "validated-preview");
  assert.equal(commands.length, 3);
  assert.equal(commands[0].env.FUND_RUN_DATE, "2026-07-13");
  assert.match(commands[0].env.FUND_OUTPUTS_ROOT, /staging\/2026-07-13-/);
  assert.match(result.reportFile, /fund-daily-2026-07-13\.md$/);
  assert.match(await readFile(result.reportFile, "utf8"), /## v8\.0 机会层/);
});

test("fund pipeline refuses analyzer output missing preserved sections", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "fund-pipeline-invalid-"));
  const assetRoot = path.join(dataDir, "fund-portfolio-daily");
  const configDir = path.join(assetRoot, "skill", "config");
  const rawDir = path.join(assetRoot, "project", "outputs", "reports", "raw-data");
  await mkdir(configDir, { recursive: true });
  await mkdir(rawDir, { recursive: true });
  await writeFile(path.join(configDir, "portfolio.json"), "{}", "utf8");
  await writeFile(path.join(configDir, "basket_config.json"), "{}", "utf8");
  await writeFile(path.join(configDir, "scoring_config.json"), "{}", "utf8");

  await assert.rejects(() => runFundPortfolioPipeline({
    date: "2026-07-13",
    dataDir,
    commandRunner: async (_command, args, options) => {
      if (args[0].endsWith("data_fetch_only.py")) {
        const stagedRawDir = path.join(options.env.FUND_OUTPUTS_ROOT, "reports", "raw-data");
        await mkdir(stagedRawDir, { recursive: true });
        await writeFile(path.join(stagedRawDir, "fund-daily-raw-2026-07-13.json"), JSON.stringify({ date: "2026-07-13" }), "utf8");
      }
      if (args[0].endsWith("portfolio_state_tracker.py")) {
        await writeFile(path.join(options.env.FUND_SKILL_ROOT, "config", "portfolio_state.json"), JSON.stringify({ _version: "7.0" }), "utf8");
      }
      return { stdout: "", stderr: "" };
    },
    analyzer: async () => "## 今天怎么做\n不操作"
  }), /missing section/);
});

test("fund pipeline rejects replay output without a replay warning", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "fund-pipeline-replay-"));
  const assetRoot = path.join(dataDir, "fund-portfolio-daily");
  const configDir = path.join(assetRoot, "skill", "config");
  const rawDir = path.join(assetRoot, "project", "outputs", "reports", "raw-data");
  await mkdir(configDir, { recursive: true });
  await mkdir(rawDir, { recursive: true });
  await writeFile(path.join(configDir, "portfolio.json"), "{}", "utf8");
  await writeFile(path.join(configDir, "basket_config.json"), "{}", "utf8");
  await writeFile(path.join(configDir, "scoring_config.json"), "{}", "utf8");

  await assert.rejects(() => runFundPortfolioPipeline({
    date: "2026-07-10",
    dataDir,
    commandRunner: async (_command, args, options) => {
      if (args[0].endsWith("data_fetch_only.py")) {
        const stagedRawDir = path.join(options.env.FUND_OUTPUTS_ROOT, "reports", "raw-data");
        await mkdir(stagedRawDir, { recursive: true });
        await writeFile(path.join(stagedRawDir, "fund-daily-raw-2026-07-10.json"), JSON.stringify({ date: "2026-07-10" }), "utf8");
      }
      if (args[0].endsWith("portfolio_state_tracker.py")) {
        await writeFile(path.join(options.env.FUND_SKILL_ROOT, "config", "portfolio_state.json"), "{}", "utf8");
      }
      return { stdout: "", stderr: "" };
    },
    analyzer: async () => [
      "# 基金日报 2026-07-10",
      "## 今日结论", "必做确定性动作：定投。",
      "## 今天怎么做", "定投。",
      "## 今天系统帮你盯到的机会", "暂无。",
      "## v8.0 机会层", "暂无。",
      "## 市场情况", "震荡。",
      "## 精简市场总结", "震荡。",
      "## 持仓今天表现", "暂无。",
      "## 为什么今天这个结论", "评分不足。",
      "## 方法论评分", "不足操作线。",
      "## 仓位分布", "正常。",
      "## 催化剂提醒", "暂无。",
      "## 风险关注", "控制仓位。",
      "## 风险提示和下一步盯什么", "关注数据。",
      "## 一句话心得", "纪律优先。"
    ].join("\n")
  }), /migration replay warning|imperative trade language/);
});

test("model retry reuses a prepared snapshot and does not rerun data, v7, or v8", async () => {
  const { dataDir } = await createPipelineFixture();
  const commands = [];
  let preparedSnapshot;
  await assert.rejects(() => runFundPortfolioPipeline({
    date: "2026-07-16",
    dataDir,
    commandRunner: stagingCommandRunner(commands),
    analyzer: async () => {
      const error = new Error("temporary model outage");
      error.errorClass = "model_network_error";
      error.retryable = true;
      throw error;
    }
  }), (error) => {
    preparedSnapshot = error.preparedSnapshot;
    return Boolean(preparedSnapshot);
  });

  const result = await runFundPortfolioPipeline({
    date: "2026-07-16",
    dataDir,
    preparedSnapshot,
    promote: true,
    attempt: 2,
    commandRunner: stagingCommandRunner(commands),
    analyzer: async () => validReport()
  });

  assert.deepEqual(commands, ["data_fetch_only.py", "portfolio_state_tracker.py", "v8_orchestrator.py"]);
  assert.equal(result.attempt, 2);
  assert.equal(result.promoted, true);
});

for (const failureKind of ["analyzer", "validation"]) {
  test(`${failureKind} failure preserves canonical fund state and writes isolated evidence`, async () => {
    const { dataDir, configDir, canonical } = await createPipelineFixture(`fund-pipeline-${failureKind}-`);
    const analyzer = failureKind === "analyzer"
      ? async () => { throw Object.assign(new Error("upstream failed"), { errorClass: "model_network_error", retryable: true }); }
      : async () => "## 今日结论\ninvalid";

    await assert.rejects(() => runFundPortfolioPipeline({
      date: "2026-07-16",
      dataDir,
      commandRunner: stagingCommandRunner([]),
      analyzer
    }));

    assert.deepEqual(JSON.parse(await readFile(path.join(configDir, "portfolio.json"))), canonical.portfolio);
    assert.deepEqual(JSON.parse(await readFile(path.join(configDir, "portfolio_state.json"))), canonical.portfolio_state);
    assert.deepEqual(JSON.parse(await readFile(path.join(configDir, "v8_state", "rebuy_log.json"))), canonical.rebuy_log);
    assert.deepEqual(JSON.parse(await readFile(path.join(configDir, "v8_state", "tp_state.json"))), canonical.tp_state);
    const failedRoot = path.join(dataDir, "outputs", "automations", "fund-portfolio-daily", "failed-runs");
    const failedRuns = await readdir(failedRoot);
    assert.equal(failedRuns.length, 1);
    const evidence = JSON.parse(await readFile(path.join(failedRoot, failedRuns[0], "failure.json")));
    assert.equal(evidence.date, "2026-07-16");
    assert.equal(typeof evidence.error_class, "string");
    assert.doesNotMatch(JSON.stringify(evidence), /upstream failed|payload|prompt/);
  });
}

test("successful staging promotes raw data, report, and prepared state only after validation", async () => {
  const { dataDir, configDir } = await createPipelineFixture("fund-pipeline-promote-");
  const result = await runFundPortfolioPipeline({
    date: "2026-07-16",
    dataDir,
    promote: true,
    commandRunner: stagingCommandRunner([]),
    analyzer: async () => validReport()
  });

  assert.equal(result.phase, "promoted");
  assert.equal(result.promoted, true);
  assert.match(result.preparedSnapshot, /prepared\/2026-07-16$/);
  assert.equal(JSON.parse(await readFile(result.rawFile)).date, "2026-07-16");
  assert.match(await readFile(result.reportFile, "utf8"), /## 一句话心得/);
  assert.equal(JSON.parse(await readFile(path.join(configDir, "portfolio_state.json"))).marker, "prepared-state");
  const manifest = JSON.parse(await readFile(path.join(result.preparedSnapshot, "manifest.json")));
  assert.equal(manifest.requestedDate, "2026-07-16");
  assert.deepEqual(manifest.commands, ["data_fetch_only.py", "portfolio_state_tracker.py", "v8_orchestrator.py"]);
  assert.ok(Object.values(manifest.inputHashes).every((value) => /^[a-f0-9]{64}$/.test(value)));
});

test("successful default dry-run writes a preview without promoting canonical state", async () => {
  const { dataDir, configDir, canonical } = await createPipelineFixture("fund-pipeline-preview-");
  const result = await runFundPortfolioPipeline({
    date: "2026-07-16",
    dataDir,
    commandRunner: stagingCommandRunner([]),
    analyzer: async () => validReport()
  });

  assert.equal(result.dryRun, true);
  assert.equal(result.promoted, false);
  assert.equal(result.phase, "validated-preview");
  assert.match(result.reportFile, /outputs\/automations\/fund-portfolio-daily\/previews\//);
  assert.deepEqual(JSON.parse(await readFile(path.join(configDir, "portfolio_state.json"))), canonical.portfolio_state);
  assert.deepEqual(JSON.parse(await readFile(path.join(configDir, "v8_state", "rebuy_log.json"))), canonical.rebuy_log);
  assert.deepEqual(JSON.parse(await readFile(path.join(configDir, "v8_state", "tp_state.json"))), canonical.tp_state);
});
