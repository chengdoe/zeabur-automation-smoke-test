import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  createSchedulerState,
  getDueDryRunJobs,
  runSchedulerTick
} from "../src/scheduler.js";

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

test("scheduler marks morning motivation due at 09:00 Asia/Shanghai", () => {
  const due = getDueDryRunJobs({
    now: new Date("2026-07-04T01:00:00.000Z"),
    state: createSchedulerState()
  });

  assert.deepEqual(due.map((job) => job.id), ["ai-hot", "morning-motivation"]);
  assert.equal(due[1].date, "2026-07-04");
});

test("scheduler marks SOP13 due at 09:30 Asia/Shanghai", () => {
  const due = getDueDryRunJobs({
    now: new Date("2026-07-04T01:30:00.000Z"),
    state: createSchedulerState()
  });

  assert.deepEqual(due.map((job) => job.id), ["sop13"]);
  assert.equal(due[0].date, "2026-07-04");
});

test("scheduler marks fund portfolio daily due at 13:50 on Shanghai weekdays", () => {
  const due = getDueDryRunJobs({
    now: new Date("2026-07-08T05:50:00.000Z"),
    state: createSchedulerState()
  });

  assert.deepEqual(due.map((job) => job.id), ["fund-portfolio-daily"]);
  assert.equal(due[0].date, "2026-07-08");
});

test("scheduler skips fund portfolio daily on Shanghai weekends", () => {
  const due = getDueDryRunJobs({
    now: new Date("2026-07-04T05:50:00.000Z"),
    state: createSchedulerState()
  });

  assert.deepEqual(due, []);
});

test("scheduler marks Wisereads due every 30 minutes in the Monday-Tuesday retry window", () => {
  const mondayStart = getDueDryRunJobs({
    now: new Date("2026-07-13T01:00:00.000Z"),
    state: createSchedulerState()
  });
  const mondaySlot = getDueDryRunJobs({
    now: new Date("2026-07-13T01:30:00.000Z"),
    state: createSchedulerState()
  });
  const afterWindow = getDueDryRunJobs({
    now: new Date("2026-07-14T10:30:00.000Z"),
    state: createSchedulerState()
  });

  assert.deepEqual(mondayStart.map((job) => job.id), ["ai-hot", "morning-motivation", "wisereads-weekly"]);
  assert.deepEqual(mondaySlot.map((job) => job.id), ["sop13", "wisereads-weekly"]);
  assert.deepEqual(afterWindow, []);
});

test("scheduler uses Shanghai weekdays even when the server timezone is UTC", () => {
  const originalTimezone = process.env.TZ;
  process.env.TZ = "UTC";

  try {
    const saturday = getDueDryRunJobs({
      now: new Date("2026-07-11T05:50:00.000Z"),
      state: createSchedulerState()
    });
    const monday = getDueDryRunJobs({
      now: new Date("2026-07-13T05:50:00.000Z"),
      state: createSchedulerState()
    });

    assert.deepEqual(saturday, []);
    assert.deepEqual(monday.map((job) => job.id), ["fund-portfolio-daily"]);
  } finally {
    if (originalTimezone === undefined) {
      delete process.env.TZ;
    } else {
      process.env.TZ = originalTimezone;
    }
  }
});

test("scheduler does not run the same job twice for the same Shanghai date", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "zeabur-scheduler-"));
  const state = createSchedulerState();

  const first = await runSchedulerTick({
    now: new Date("2026-07-04T01:30:00.000Z"),
    state,
    dataDir
  });
  const second = await runSchedulerTick({
    now: new Date("2026-07-04T01:30:30.000Z"),
    state,
    dataDir
  });

  assert.equal(first.ran.length, 1);
  assert.equal(first.ran[0].job, "sop13");
  assert.equal(first.ran[0].sent, false);
  assert.deepEqual(second.ran, []);

  const log = JSON.parse(await readFile(path.join(dataDir, "outputs", "automations", "scheduler", "2026-07-04.log.json"), "utf8"));
  assert.equal(log.entries.length, 1);
  assert.equal(log.entries[0].job, "sop13");
  assert.equal(log.entries[0].sent, false);
});

test("scheduler sends live jobs when live send is enabled", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "zeabur-scheduler-live-"));
  const state = createSchedulerState();
  let sendCount = 0;

  const result = await runSchedulerTick({
    now: new Date("2026-07-04T01:30:00.000Z"),
    state,
    dataDir,
    liveSendEnabled: true,
    env: SOP_ENV,
    sender: {
      async sendMessage({ msgType, payload, uuid }) {
        sendCount += 1;
        assert.equal(msgType, "post");
        assert.equal(payload.zh_cn.content[0][1].user_id, "all");
        assert.equal(uuid, "sop13-2026-07-04");
        return { ok: true, messageId: "om_scheduler_live" };
      }
    }
  });

  assert.equal(sendCount, 1);
  assert.equal(result.ran.length, 1);
  assert.equal(result.ran[0].sent, true);
  assert.match(result.ran[0].files.sentLog, /outputs\/automations\/sop13\/2026-07-04-sent\.json$/);

  const log = JSON.parse(await readFile(path.join(dataDir, "outputs", "automations", "scheduler", "2026-07-04.log.json"), "utf8"));
  assert.equal(log.entries[0].sent, true);
});

test("scheduler can disable only the fund portfolio job", () => {
  const due = getDueDryRunJobs({
    now: new Date("2026-07-13T05:50:00.000Z"),
    state: createSchedulerState(),
    enabledJobs: {
      "fund-portfolio-daily": false
    }
  });

  assert.deepEqual(due, []);
});

test("scheduler prepares a fresh fund report before live send", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "zeabur-scheduler-fund-"));
  const state = createSchedulerState();
  const events = [];

  const result = await runSchedulerTick({
    now: new Date("2026-07-13T05:50:00.000Z"),
    state,
    dataDir,
    liveSendEnabled: true,
    env: FUND_ENV,
    prepareJob: async ({ job, date }) => {
      events.push(`prepare:${job}:${date}`);
      const reportsDir = path.join(dataDir, "fund-portfolio-daily", "project", "outputs", "reports", "markdown");
      await mkdir(reportsDir, { recursive: true });
      await writeFile(path.join(reportsDir, `fund-daily-${date}.md`), [
        "## 今日结论", "不操作。",
        "## v8.0 机会层", "暂无。",
        "## 精简市场总结", "震荡。",
        "## 方法论评分", "不足。",
        "## 风险关注", "控制仓位。"
      ].join("\n"), "utf8");
    },
    sender: {
      async sendMessage() {
        events.push("send");
        return { ok: true, messageId: "om_fund_scheduler" };
      }
    }
  });

  assert.deepEqual(events, ["prepare:fund-portfolio-daily:2026-07-13", "send"]);
  assert.equal(result.ran[0].sent, true);
});

test("scheduler keeps a task in dry-run when its independent live gate is closed", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "scheduler-wisereads-dryrun-"));
  const feedFile = path.join(dataDir, "feed.xml");
  const analysisFile = path.join(dataDir, "analysis.json");
  const sections = ["Article", "Article", "YouTube", "Twitter", "PDF", "Book"];
  await writeFile(feedFile, `<?xml version="1.0"?><rss><channel><item><title>Wisereads Vol. 151</title><link>https://example.com/151</link><pubDate>Sun, 12 Jul 2026 14:17:19 +0000</pubDate><content:encoded><![CDATA[<main>${sections.map((section, index) => `<h2>${section}</h2><h3><a href="https://example.com/${index}">Item ${index}</a></h3><p class="author">Author ${index}</p><p>Summary ${index}</p><p>Quote ${index}</p>`).join("")}</main>]]></content:encoded></item></channel></rss>`, "utf8");
  await writeFile(analysisFile, JSON.stringify({ items: Array.from({ length: 6 }, (_, index) => ({ index, title: `Item ${index}`, summary: `这是第${index}条内容的中文摘要，用于验证独立任务关闭发送后仍会正常生成预览。`, quote: `这是第${index}条内容的中文引文，用于验证不会发送飞书消息。` })) }), "utf8");

  const result = await runSchedulerTick({
    now: new Date("2026-07-13T01:00:00.000Z"),
    state: createSchedulerState(),
    dataDir,
    liveSendEnabled: true,
    liveEnabledJobs: { "wisereads-weekly": false },
    enabledJobs: { "ai-hot": false, "morning-motivation": false, sop13: false, "fund-portfolio-daily": false, "wisereads-weekly": true },
    env: {
      WISEREADS_WEEKLY_ENABLED: "false",
      WISEREADS_FEED_XML_FILE: feedFile,
      WISEREADS_ANALYSIS_JSON_FILE: analysisFile
    }
  });

  assert.equal(result.ran.length, 1);
  assert.equal(result.ran[0].job, "wisereads-weekly");
  assert.equal(result.ran[0].ok, true);
  assert.equal(result.ran[0].dryRun, true);
  assert.equal(result.ran[0].sent, false);
});

test("fund scheduler records a retryable 13:50 prepare failure and reuses its snapshot at 14:00", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "scheduler-fund-retry-"));
  const state = createSchedulerState();
  const preparedSnapshot = path.join(dataDir, "prepared", "2026-07-16");
  const prepareCalls = [];
  let sends = 0;
  const prepareJob = async ({ attempt, preparedSnapshot: reused }) => {
    prepareCalls.push({ attempt, reused });
    if (attempt === 1) {
      return { ok: false, sent: false, phase: "prepare", error_class: "prepare_failure", retryable: true, preparedSnapshot };
    }
    const reportsDir = path.join(dataDir, "fund-portfolio-daily", "project", "outputs", "reports", "markdown");
    await mkdir(reportsDir, { recursive: true });
    await writeFile(path.join(reportsDir, "fund-daily-2026-07-16.md"), [
      "## 今日结论", "观察。", "## v8.0 机会层", "暂无。", "## 精简市场总结", "震荡。",
      "## 方法论评分", "中性。", "## 风险关注", "控制仓位。"
    ].join("\n"));
    return { ok: true, sent: false, phase: "promoted", promoted: true, preparedSnapshot: reused };
  };
  const sender = { async sendMessage() { sends += 1; return { ok: true, messageId: "om_retry" }; } };

  const first = await runSchedulerTick({ now: new Date("2026-07-16T05:50:00Z"), state, dataDir, liveSendEnabled: true, env: FUND_ENV, prepareJob, sender });
  assert.equal(first.ran[0].phase, "prepare");
  assert.equal(first.ran[0].next_retry_at, "2026-07-16T14:00:00+08:00");
  assert.equal(sends, 0);
  const log = JSON.parse(await readFile(path.join(dataDir, "outputs", "automations", "scheduler", "2026-07-16.log.json")));
  assert.deepEqual(Object.keys(log.entries[0]).sort(), [
    "attempt", "dryRun", "error_class", "files", "job", "next_retry_at", "ok", "phase",
    "prompt_hash_suffix", "sendSkippedReason", "sent", "skipped", "ts"
  ]);
  assert.doesNotMatch(JSON.stringify(log), /payload|secret|full_prompt|raw_holdings/i);

  const second = await runSchedulerTick({ now: new Date("2026-07-16T06:00:00Z"), state, dataDir, liveSendEnabled: true, env: FUND_ENV, prepareJob, sender });
  assert.deepEqual(prepareCalls, [{ attempt: 1, reused: undefined }, { attempt: 2, reused: preparedSnapshot }]);
  assert.equal(second.ran[0].sent, true);
  assert.equal(sends, 1);
});

test("fund retry slots require retryable state and stop after 14:20", () => {
  const state = createSchedulerState();
  const noFailure = getDueDryRunJobs({ now: new Date("2026-07-16T06:00:00Z"), state });
  assert.deepEqual(noFailure, []);
  state.fundRetries.set("2026-07-16", { retryable: true, attempt: 1 });
  for (const [index, minute] of ["00", "10", "20"].entries()) {
    state.fundRetries.set("2026-07-16", { retryable: true, attempt: index + 1 });
    const due = getDueDryRunJobs({ now: new Date(`2026-07-16T06:${minute}:00Z`), state });
    assert.deepEqual(due.map((job) => job.id), ["fund-portfolio-daily"]);
    state.ranKeys.clear();
  }
  assert.deepEqual(getDueDryRunJobs({ now: new Date("2026-07-16T06:30:00Z"), state }), []);
});

test("permanent fund prepare failure does not retry or call sender", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "scheduler-fund-permanent-"));
  const state = createSchedulerState();
  let sends = 0;
  const first = await runSchedulerTick({
    now: new Date("2026-07-16T05:50:00Z"), state, dataDir, liveSendEnabled: true, env: FUND_ENV,
    prepareJob: async () => ({ ok: false, sent: false, phase: "model", error_class: "model_http_status", retryable: false }),
    sender: { async sendMessage() { sends += 1; } }
  });
  assert.equal(first.ran[0].next_retry_at, null);
  assert.equal(sends, 0);
  assert.deepEqual(getDueDryRunJobs({ now: new Date("2026-07-16T06:00:00Z"), state }), []);
});

test("fund validation failure never retries even if a caller marks it retryable", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "scheduler-fund-validation-"));
  const state = createSchedulerState();
  const first = await runSchedulerTick({
    now: new Date("2026-07-16T05:50:00Z"), state, dataDir, liveSendEnabled: true, env: FUND_ENV,
    prepareJob: async () => ({ ok: false, sent: false, phase: "validation", error_class: "report_validation_failure", retryable: true })
  });
  assert.equal(first.ran[0].retryable, false);
  assert.equal(first.ran[0].next_retry_at, null);
  assert.deepEqual(getDueDryRunJobs({ now: new Date("2026-07-16T06:00:00Z"), state }), []);
});

test("fund send failure is logged separately and does not schedule prepare retry", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "scheduler-fund-send-failure-"));
  const reportsDir = path.join(dataDir, "fund-portfolio-daily", "project", "outputs", "reports", "markdown");
  await mkdir(reportsDir, { recursive: true });
  await writeFile(path.join(reportsDir, "fund-daily-2026-07-16.md"), [
    "## 今日结论", "观察。", "## v8.0 机会层", "暂无。", "## 精简市场总结", "震荡。",
    "## 方法论评分", "中性。", "## 风险关注", "控制仓位。"
  ].join("\n"));
  const state = createSchedulerState();
  const result = await runSchedulerTick({
    now: new Date("2026-07-16T05:50:00Z"), state, dataDir, liveSendEnabled: true, env: FUND_ENV,
    prepareJob: async () => ({ ok: true, phase: "promoted", promoted: true }),
    sender: { async sendMessage() { throw new Error("fixture sender failure"); } }
  });
  assert.equal(result.ran[0].phase, "send");
  assert.equal(result.ran[0].error_class, "send_failure");
  assert.equal(result.ran[0].next_retry_at, null);
  assert.deepEqual(getDueDryRunJobs({ now: new Date("2026-07-16T06:00:00Z"), state }), []);
});

test("already-sent fund date skips prepare and send", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "scheduler-fund-sent-"));
  const sentDir = path.join(dataDir, "outputs", "automations", "fund-portfolio-daily");
  await mkdir(sentDir, { recursive: true });
  await writeFile(path.join(sentDir, "2026-07-16-sent.json"), JSON.stringify({ sent: true }));
  let prepares = 0;
  let sends = 0;
  const result = await runSchedulerTick({
    now: new Date("2026-07-16T05:50:00Z"), state: createSchedulerState(), dataDir, liveSendEnabled: true, env: FUND_ENV,
    prepareJob: async () => { prepares += 1; },
    sender: { async sendMessage() { sends += 1; } }
  });
  assert.equal(result.ran[0].sendSkippedReason, "already sent");
  assert.equal(result.ran[0].sent, false);
  assert.equal(prepares, 0);
  assert.equal(sends, 0);
});

test("a sent ledger reused after restart is logged as skipped, never as a new send", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "scheduler-ledger-reuse-"));
  const sentDir = path.join(dataDir, "outputs", "automations", "sop13");
  await mkdir(sentDir, { recursive: true });
  await writeFile(path.join(sentDir, "2026-07-04-sent.json"), JSON.stringify({
    ok: true,
    job: "sop13",
    date: "2026-07-04",
    dryRun: false,
    sent: true,
    files: { sentLog: path.join(sentDir, "2026-07-04-sent.json") }
  }));
  let sends = 0;
  const result = await runSchedulerTick({
    now: new Date("2026-07-04T01:30:00.000Z"),
    state: createSchedulerState(),
    dataDir,
    liveSendEnabled: true,
    env: SOP_ENV,
    sender: { async sendMessage() { sends += 1; } }
  });

  assert.equal(result.ran[0].sent, false);
  assert.equal(result.ran[0].skipped, true);
  assert.equal(result.ran[0].sendSkippedReason, "already sent");
  assert.equal(sends, 0);
  const log = JSON.parse(await readFile(
    path.join(dataDir, "outputs", "automations", "scheduler", "2026-07-04.log.json")
  ));
  assert.equal(log.entries[0].sent, false);
  assert.equal(log.entries[0].skipped, true);
  assert.equal(log.entries[0].sendSkippedReason, "already sent");
});
