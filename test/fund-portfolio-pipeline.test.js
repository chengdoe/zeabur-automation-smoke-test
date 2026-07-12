import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { runFundPortfolioPipeline } from "../src/jobs/fundPortfolioPipeline.js";

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
        await writeFile(path.join(rawDir, "fund-daily-raw-2026-07-13.json"), JSON.stringify({
          date: "2026-07-13",
          data_quality: { overall_score: 9, decision_level: "cautious" },
          market_data: {},
          news_data: {}
        }), "utf8");
      }
      if (args[0].endsWith("portfolio_state_tracker.py")) {
        await writeFile(path.join(configDir, "portfolio_state.json"), JSON.stringify({
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
  assert.equal(commands.length, 3);
  assert.equal(commands[0].env.FUND_RUN_DATE, "2026-07-13");
  assert.equal(commands[0].env.FUND_OUTPUTS_ROOT, outputsRoot);
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
    commandRunner: async (_command, args) => {
      if (args[0].endsWith("data_fetch_only.py")) {
        await writeFile(path.join(rawDir, "fund-daily-raw-2026-07-13.json"), JSON.stringify({ date: "2026-07-13" }), "utf8");
      }
      if (args[0].endsWith("portfolio_state_tracker.py")) {
        await writeFile(path.join(configDir, "portfolio_state.json"), JSON.stringify({ _version: "7.0" }), "utf8");
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
    commandRunner: async (_command, args) => {
      if (args[0].endsWith("data_fetch_only.py")) {
        await writeFile(path.join(rawDir, "fund-daily-raw-2026-07-10.json"), JSON.stringify({ date: "2026-07-10" }), "utf8");
      }
      if (args[0].endsWith("portfolio_state_tracker.py")) {
        await writeFile(path.join(configDir, "portfolio_state.json"), "{}", "utf8");
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
