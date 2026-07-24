import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { runLiveSendJob } from "../src/liveSendRunner.js";

const SOP_ENV = {
  SOP13_BOT_ROLE: "aheng",
  SOP13_CONNECTION_REF: "aheng",
  SOP13_TARGET_CHAT_ID: "oc_test",
  FEISHU_CONNECTION_AHENG_APP_ID: "cli_test",
  FEISHU_CONNECTION_AHENG_APP_SECRET: "secret_test"
};

const FUND_ENV = {
  FUND_PORTFOLIO_DAILY_BOT_ROLE: "aheng",
  FUND_PORTFOLIO_DAILY_CONNECTION_REF: "aheng",
  FUND_PORTFOLIO_DAILY_TARGET_CHAT_ID: "oc_test",
  FEISHU_CONNECTION_AHENG_APP_ID: "cli_test",
  FEISHU_CONNECTION_AHENG_APP_SECRET: "secret_test"
};

test("live-send runner is blocked unless explicitly enabled and confirmed", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "zeabur-live-send-blocked-"));
  let sendCount = 0;

  const disabled = await runLiveSendJob({
    job: "sop13",
    date: "2026-07-03",
    dataDir,
    enabled: false,
    confirm: "SEND",
    sender: {
      async sendMessage() {
        sendCount += 1;
      }
    }
  });

  assert.equal(disabled.sent, false);
  assert.equal(disabled.sendSkippedReason, "live send disabled");

  const unconfirmed = await runLiveSendJob({
    job: "sop13",
    date: "2026-07-03",
    dataDir,
    enabled: true,
    confirm: "",
    sender: {
      async sendMessage() {
        sendCount += 1;
      }
    }
  });

  assert.equal(unconfirmed.sent, false);
  assert.equal(unconfirmed.sendSkippedReason, "missing SEND confirmation");
  assert.equal(sendCount, 0);
});

test("live-send runner sends once and skips duplicates by sent log", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "zeabur-live-send-"));
  let sendCount = 0;

  const sender = {
    async sendMessage({ msgType, payload, uuid }) {
      sendCount += 1;
      assert.equal(msgType, "post");
      assert.equal(payload.zh_cn.title, "");
      assert.equal(uuid, "sop13-2026-07-03");
      return {
        ok: true,
        messageId: "om_test_message"
      };
    }
  };

  const first = await runLiveSendJob({
    job: "sop13",
    date: "2026-07-03",
    dataDir,
    enabled: true,
    confirm: "SEND",
    env: SOP_ENV,
    sender
  });

  assert.equal(first.sent, true);
  assert.equal(first.messageId, "om_test_message");
  assert.match(first.files.sentLog, /outputs\/automations\/sop13\/2026-07-03-sent\.json$/);

  const logged = JSON.parse(await readFile(first.files.sentLog, "utf8"));
  assert.equal(logged.sent, true);
  assert.equal(logged.messageId, "om_test_message");

  const second = await runLiveSendJob({
    job: "sop13",
    date: "2026-07-03",
    dataDir,
    enabled: true,
    confirm: "SEND",
    env: SOP_ENV,
    sender
  });

  assert.equal(second.sent, false);
  assert.equal(second.skipped, true);
  assert.equal(second.sendSkippedReason, "already sent");
  assert.equal(sendCount, 1);
});

test("live-send runner blocks a globally enabled job without task-level bot mapping", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "zeabur-live-send-role-blocked-"));
  let sendCount = 0;
  const result = await runLiveSendJob({
    job: "sop13",
    date: "2026-07-03",
    dataDir,
    enabled: true,
    confirm: "SEND",
    env: {},
    sender: { async sendMessage() { sendCount += 1; } }
  });

  assert.equal(result.sent, false);
  assert.equal(result.sendSkippedReason, "bot-role-unconfirmed");
  assert.ok(result.missingIdentity.includes("bot_role"));
  assert.equal(sendCount, 0);
});

test("live-send runner can send fund portfolio daily as a Feishu post", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "zeabur-live-fund-"));
  const reportsDir = path.join(dataDir, "fund-portfolio-daily", "project", "outputs", "reports", "markdown");
  await mkdir(reportsDir, { recursive: true });
  await writeFile(path.join(reportsDir, "fund-daily-2026-07-08.md"), [
    "# 基金持仓日报",
    "",
    "## 今日结论",
    "保持观察。",
    "",
    "## v8.0 机会层",
    "等待信号。",
    "",
    "## 精简市场总结",
    "市场震荡。",
    "",
    "## 方法论评分",
    "中性。",
    "",
    "## 风险关注",
    "控制仓位。"
  ].join("\n"), "utf8");

  const result = await runLiveSendJob({
    job: "fund-portfolio-daily",
    date: "2026-07-08",
    dataDir,
    enabled: true,
    confirm: "SEND",
    env: FUND_ENV,
    sender: {
      async sendMessage({ msgType, payload, uuid }) {
        assert.equal(msgType, "post");
        assert.equal(payload.zh_cn.title, "");
        assert.equal(payload.zh_cn.content[0][1].user_id, "all");
        assert.match(JSON.stringify(payload), /今日判断/);
        assert.doesNotMatch(JSON.stringify(payload), /v8\.0 机会层|方法论评分/);
        assert.doesNotMatch(JSON.stringify(payload), /# 基金持仓日报/);
        assert.equal(uuid, "fund-portfolio-daily-2026-07-08");
        return { ok: true, messageId: "om_fund_live" };
      }
    }
  });

  assert.equal(result.sent, true);
  assert.equal(result.messageId, "om_fund_live");
  assert.match(result.files.sentLog, /outputs\/automations\/fund-portfolio-daily\/2026-07-08-sent\.json$/);
});

test("live-send runner refuses to send a stale fund report for a newer date", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "zeabur-live-fund-stale-"));
  const reportsDir = path.join(dataDir, "fund-portfolio-daily", "project", "outputs", "reports", "markdown");
  await mkdir(reportsDir, { recursive: true });
  await writeFile(path.join(reportsDir, "fund-daily-2026-07-08.md"), [
    "## 今日结论",
    "旧报告",
    "## v8.0 机会层",
    "旧机会",
    "## 精简市场总结",
    "旧市场",
    "## 方法论评分",
    "旧评分",
    "## 风险关注",
    "旧风险"
  ].join("\n"), "utf8");
  let sendCount = 0;

  const result = await runLiveSendJob({
    job: "fund-portfolio-daily",
    date: "2026-07-13",
    dataDir,
    enabled: true,
    confirm: "SEND",
    env: FUND_ENV,
    sender: {
      async sendMessage() {
        sendCount += 1;
      }
    }
  });

  assert.equal(result.sent, false);
  assert.equal(result.sendSkippedReason, "validation failed");
  assert.match(result.validation.errors.join("\n"), /exact-date fund report missing/);
  assert.equal(sendCount, 0);
});

test("fund live send skips an already delivered recent Feishu message", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "zeabur-live-fund-dedupe-"));
  const reportsDir = path.join(dataDir, "fund-portfolio-daily", "project", "outputs", "reports", "markdown");
  await mkdir(reportsDir, { recursive: true });
  await writeFile(path.join(reportsDir, "fund-daily-2026-07-16.md"), [
    "# 基金日报 2026-07-16",
    "## 今日结论", "保持观察。",
    "## v8.0 机会层", "暂无。",
    "## 精简市场总结", "震荡。",
    "## 方法论评分", "中性。",
    "## 风险关注", "控制仓位。"
  ].join("\n"), "utf8");
  let sendCount = 0;
  let searchedText = "";

  const result = await runLiveSendJob({
    job: "fund-portfolio-daily",
    date: "2026-07-16",
    dataDir,
    enabled: true,
    confirm: "SEND",
    env: FUND_ENV,
    sender: {
      async findRecentMessageContaining({ text }) {
        searchedText = text;
        return { message_id: "om_existing_fund" };
      },
      async sendMessage() { sendCount += 1; }
    }
  });

  assert.match(searchedText, /基金持仓日报.*2026-07-16/);
  assert.equal(result.sent, false);
  assert.equal(result.skipped, true);
  assert.equal(result.sendSkippedReason, "already delivered in Feishu");
  assert.equal(result.existingMessageId, "om_existing_fund");
  assert.equal(sendCount, 0);
  await assert.rejects(readFile(path.join(dataDir, "outputs", "automations", "fund-portfolio-daily", "2026-07-16-sent.json")));
});
