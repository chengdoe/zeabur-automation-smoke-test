import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { runDryRunJob } from "../src/dryRunRunner.js";

test("dry-run runner writes audit files and never sends", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "zeabur-dry-run-"));
  const result = await runDryRunJob({
    job: "sop13",
    date: "2026-07-03",
    dataDir
  });

  assert.equal(result.ok, true);
  assert.equal(result.dryRun, true);
  assert.equal(result.sent, false);
  assert.equal(result.msgType, "post");
  assert.match(result.files.json, /outputs\/automations\/sop13\/2026-07-03-dry-run\.json$/);
  assert.match(result.files.markdown, /outputs\/automations\/sop13\/2026-07-03-dry-run\.md$/);

  const json = JSON.parse(await readFile(result.files.json, "utf8"));
  const markdown = await readFile(result.files.markdown, "utf8");

  assert.equal(json.payload.zh_cn.title, "");
  assert.equal(json.sent, false);
  assert.match(markdown, /# sop13 Dry Run/);
  assert.match(markdown, /Selected SOP: 项目复盘 SOP/);
  assert.match(markdown, /No Feishu message was sent/);
});

test("fund portfolio dry-run preserves latest migrated markdown report sections", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "zeabur-fund-dry-run-"));
  const reportsDir = path.join(dataDir, "fund-portfolio-daily", "project", "outputs", "reports", "markdown");
  await mkdir(reportsDir, { recursive: true });
  await writeFile(path.join(reportsDir, "fund-daily-2026-07-08.md"), [
    "# 基金持仓日报 2026-07-08",
    "",
    "## 今日结论",
    "no_trade",
    "",
    "## v8.0 机会层",
    "低吸观察 / 回补监控 / 止盈触发",
    "",
    "## 精简市场总结",
    "市场摘要",
    "",
    "## 方法论评分",
    "买入/卖出评分",
    "",
    "## 风险关注",
    "风险列表",
    ""
  ].join("\n"), "utf8");

  const result = await runDryRunJob({
    job: "fund-portfolio-daily",
    date: "2026-07-08",
    dataDir
  });

  assert.equal(result.ok, true);
  assert.equal(result.dryRun, true);
  assert.equal(result.sent, false);
  assert.equal(result.msgType, "markdown");
  assert.match(result.payload.markdown, /v8\.0 机会层/);
  assert.match(result.files.json, /outputs\/automations\/fund-portfolio-daily\/2026-07-08-dry-run\.json$/);

  const markdown = await readFile(result.files.markdown, "utf8");
  assert.match(markdown, /# fundPortfolioDaily Dry Run/);
  assert.match(markdown, /No Feishu message was sent/);
  assert.match(markdown, /基金持仓日报 2026-07-08/);
});
