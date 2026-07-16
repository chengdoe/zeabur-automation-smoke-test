import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildFundPortfolioDailyDryRun,
  buildFundPortfolioPostPayload,
  extractFundPortfolioBrief,
  validateFundPortfolioBrief,
  validateFundPortfolioPost
} from "../src/jobs/fundPortfolioDaily.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(here, "fixtures", "fund-daily-2026-07-15.md");

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

function visibleText(payload) {
  return payload.zh_cn.content.flat().map((item) => item.text || "").join("\n");
}

test("2026-07-15 deterministic brief preserves full report and removes internal detail", async () => {
  const before = await readFile(fixture, "utf8");
  const beforeHash = hash(before);
  const brief = extractFundPortfolioBrief({
    date: "2026-07-15",
    markdown: before,
    fullReportFile: fixture
  });
  const payload = buildFundPortfolioPostPayload({ date: "2026-07-15", brief });
  const after = await readFile(fixture, "utf8");
  const text = visibleText(payload);

  assert.equal(hash(after), beforeHash, "full 14-section report must remain byte-for-byte unchanged");
  assert.equal(brief.sent, false);
  assert.equal(brief.stance, "confirm");
  assert.equal(brief.confirmations.length, 2);
  assert.deepEqual(brief.confirmations.map((item) => item.action), ["是否分批止盈", "是否部分止盈"]);
  assert.equal(brief.triggers.length, 3);
  assert.deepEqual(brief.portfolio_snapshot, {
    estimated_total: "约 21,124 元",
    as_of: "2026-06-26",
    estimated_change: null,
    largest_deviation: "QDII 占比约 46.8%，高于 40% 约束",
    weekly_quota: "剩余 2 次"
  });
  assert.match(text, /今日判断[\s\S]*需要你确认/);
  assert.match(text, /待确认/);
  assert.doesNotMatch(text, /计划内定投|智能定投/);
  assert.match(text, /持仓旧快照约 21,124 元（2026-06-26）/);
  assert.match(text, /实时估值覆盖不足，暂不计算组合涨跌/);
  assert.match(text, /完整报告已归档，所有建议均未执行/);
  assert.ok(Array.from(text).length <= 1200, `brief length was ${Array.from(text).length}`);
  assert.doesNotMatch(text, /v7|v8|score|decision_level|机会层|状态机|逐只基金/iu);
  const caveatRows = payload.zh_cn.content.filter((row) => /缺失|不是当天|较旧|不完整/.test(row.map((item) => item.text || "").join("")));
  assert.equal(caveatRows.length, 1, "stale caveats should be consolidated in one data-quality row");
  assert.equal(validateFundPortfolioBrief(brief).ok, true);
  assert.equal(validateFundPortfolioPost(payload, { ok: true, errors: [] }, { ok: true, errors: [] }, brief).ok, true);
});

test("fund dry-run emits structured brief and native post without mutating archive", async () => {
  const before = await readFile(fixture, "utf8");
  const result = await buildFundPortfolioDailyDryRun({
    date: "2026-07-15",
    reportsDir: path.dirname(fixture)
  });

  assert.equal(result.ok, true);
  assert.equal(result.dryRun, true);
  assert.equal(result.msgType, "post");
  assert.equal(result.feishuBrief.sent, false);
  assert.equal(result.payload.zh_cn.title, "");
  assert.equal(hash(await readFile(fixture, "utf8")), hash(before));
});

test("missing structured fields fail closed before live send", () => {
  const invalid = {
    stance: "confirm",
    summary: "待确认止盈复核",
    confirmations: [],
    triggers: [],
    portfolio_snapshot: {},
    data_quality: { level: "medium", note: "" },
    full_report_file: "",
    sent: false
  };
  const validation = validateFundPortfolioBrief(invalid);

  assert.equal(validation.ok, false);
  assert.match(validation.errors.join("\n"), /full_report_file/);
  assert.match(validation.errors.join("\n"), /data_quality.note/);
});
