import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { runLiveSendJob } from "../src/liveSendRunner.js";
import {
  AI_HOT_JOB_ID,
  buildAIHotDryRun,
  buildAIHotPostPayload,
  classifyAIHotSource,
  getAIHotSource,
  validateAIHotPost
} from "../src/jobs/aiHot.js";

const fixture = JSON.parse(await readFile(new URL("./fixtures/ai-hot/selected-2026-07-16.json", import.meta.url), "utf8"));
const RUN_NOW = new Date("2026-07-16T03:30:00.000Z");

const AI_HOT_ENV = {
  AI_HOT_ENABLED: "true",
  AI_HOT_BOT_ROLE: "aihot-bot",
  AI_HOT_CONNECTION_REF: "aihot",
  AI_HOT_TARGET_CHAT_ID: "oc_aihot",
  FEISHU_CONNECTION_AIHOT_APP_ID: "cli_test",
  FEISHU_CONNECTION_AIHOT_APP_SECRET: "secret_test"
};

test("builds a ranked AI HOT brief from the Shanghai-day window without padding low-signal news", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "aihot-brief-"));
  const result = await buildAIHotDryRun({
    date: "2026-07-16",
    now: RUN_NOW,
    dataDir,
    itemsResponse: fixture,
    env: { AI_HOT_ENABLED: "false" }
  });

  assert.equal(result.ok, true);
  assert.equal(result.job, AI_HOT_JOB_ID);
  assert.equal(result.sourceStatus, "source_available");
  assert.equal(result.msgType, "post");
  assert.equal(result.metadata.liveSendGate, "closed");
  assert.equal(result.brief.items.length, 6);
  assert.deepEqual(result.brief.items.map((item) => item.id), [
    "aihot-agent-coding-1",
    "aihot-security-x-1",
    "aihot-research-1",
    "aihot-model-vendor-1",
    "aihot-open-source-1",
    "aihot-workflow-1"
  ]);
  assert.ok(result.brief.items.every((item) => item.sourceUrl && item.happened && item.whyWatch));
  assert.ok(result.brief.items.some((item) => item.sourceLabel === "X，需核验"));
  assert.ok(result.brief.items.some((item) => item.sourceLabel === "厂商自评"));
  assert.ok(result.brief.items.some((item) => item.sourceCredibility === "primary"));
  assert.equal(result.brief.items.some((item) => /融资/.test(item.title)), false);
  assert.equal(result.brief.items.some((item) => item.id === "aihot-before-window"), false);
  assert.equal(result.brief.items.some((item) => item.id === "aihot-after-run"), false);
  assert.equal(new Set(result.brief.items.map((item) => item.sourceUrl)).size, result.brief.items.length);
  assert.ok(result.brief.actions.length <= 2);
  assert.doesNotMatch(result.preview, /mode=|\/api\/public|take=/);

  const generated = JSON.parse(await readFile(result.generated.briefJson, "utf8"));
  assert.equal(generated.items.length, 6);
});

test("source classification labels X, reposts, vendor claims, and primary sources", () => {
  assert.deepEqual(classifyAIHotSource({ source: "X：Claude Developers (@ClaudeDevs)", url: "https://x.com/ClaudeDevs/status/1" }), {
    credibility: "x",
    label: "X，需核验",
    needsVerification: true
  });
  assert.deepEqual(classifyAIHotSource({ source: "转载：开发者周刊", url: "https://example.com/repost" }), {
    credibility: "repost",
    label: "转载",
    needsVerification: true
  });
  assert.deepEqual(classifyAIHotSource({ source: "MiniMax 官方博客", url: "https://www.minimax.io/news/code-2" }), {
    credibility: "vendor",
    label: "厂商自评",
    needsVerification: true
  });
  assert.deepEqual(classifyAIHotSource({ source: "Anthropic Alignment", url: "https://alignment.anthropic.com/2026/test" }), {
    credibility: "primary",
    label: "一手来源",
    needsVerification: false
  });
});

test("distinguishes source unavailable, parse failed, and no high-value content", async () => {
  const unavailable = await getAIHotSource({
    date: "2026-07-16",
    now: RUN_NOW,
    fetchImpl: async () => {
      throw new Error("network down");
    }
  });
  assert.equal(unavailable.ok, false);
  assert.equal(unavailable.status, "source_unavailable");

  const parseFailed = await getAIHotSource({
    date: "2026-07-16",
    now: RUN_NOW,
    fetchImpl: async () => ({ ok: true, status: 200, async text() { return "{bad json"; } })
  });
  assert.equal(parseFailed.ok, false);
  assert.equal(parseFailed.status, "parse_failed");

  const dataDir = await mkdtemp(path.join(os.tmpdir(), "aihot-empty-"));
  const noHighValue = await buildAIHotDryRun({
    date: "2026-07-16",
    now: RUN_NOW,
    dataDir,
    itemsResponse: {
      count: 1,
      items: [{
        id: "funding-only",
        title: "某 AI 营销公司完成新一轮融资",
        url: "https://example.com/funding-only",
        source: "转载：融资媒体",
        publishedAt: "2026-07-16T01:00:00.000Z",
        summary: "公司称资金将用于品牌营销。",
        category: "industry",
        score: 35
      }]
    }
  });
  assert.equal(noHighValue.ok, true);
  assert.equal(noHighValue.sourceStatus, "no_high_value_content");
  assert.equal(noHighValue.sendPolicy, "skip");
  assert.equal(noHighValue.brief.items.length, 0);
});

test("validates native Feishu post payload structure and source links", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "aihot-post-"));
  const result = await buildAIHotDryRun({
    date: "2026-07-16",
    now: RUN_NOW,
    dataDir,
    itemsResponse: fixture
  });
  const validation = validateAIHotPost(result.payload, result.brief);

  assert.deepEqual(validation, { ok: true, errors: [] });
  assert.equal(result.payload.zh_cn.title, "");
  assert.equal(result.payload.zh_cn.content[0][0].text, "AI HOT 关注简报 · 2026-07-16");
  assert.ok(result.payload.zh_cn.content.some((row) => row.some((cell) => cell.tag === "a" && cell.href === "https://openai.com/index/codex-remote-runner")));

  const brokenBrief = structuredClone(result.brief);
  brokenBrief.items[0].sourceUrl = "";
  const broken = buildAIHotPostPayload(brokenBrief);
  assert.equal(validateAIHotPost(broken, brokenBrief).ok, false);
});

test("live send stays fail-closed without a confirmed AI HOT bot identity", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "aihot-role-blocked-"));
  const fixtureFile = path.join(dataDir, "items.json");
  await writeFile(fixtureFile, JSON.stringify(fixture), "utf8");
  let sendCount = 0;

  const result = await runLiveSendJob({
    job: AI_HOT_JOB_ID,
    date: "2026-07-16",
    dataDir,
    enabled: true,
    confirm: "SEND",
    env: {
      AI_HOT_ENABLED: "true",
      AI_HOT_ITEMS_JSON_FILE: fixtureFile,
      AI_HOT_NOW: RUN_NOW.toISOString()
    },
    sender: { async sendMessage() { sendCount += 1; } }
  });

  assert.equal(result.sent, false);
  assert.equal(result.sendSkippedReason, "bot-role-unconfirmed");
  assert.ok(result.missingIdentity.includes("bot_role"));
  assert.equal(sendCount, 0);
});

test("live send checks Feishu history before sending AI HOT duplicates", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "aihot-dupe-"));
  const fixtureFile = path.join(dataDir, "items.json");
  await writeFile(fixtureFile, JSON.stringify(fixture), "utf8");
  let sendCount = 0;

  const result = await runLiveSendJob({
    job: AI_HOT_JOB_ID,
    date: "2026-07-16",
    dataDir,
    enabled: true,
    confirm: "SEND",
    env: {
      ...AI_HOT_ENV,
      AI_HOT_ITEMS_JSON_FILE: fixtureFile,
      AI_HOT_NOW: RUN_NOW.toISOString()
    },
    sender: {
      async findRecentMessageContaining({ text }) {
        assert.equal(text, "AI HOT 关注简报 · 2026-07-16");
        return { message_id: "om_existing_aihot" };
      },
      async sendMessage() {
        sendCount += 1;
      }
    }
  });

  assert.equal(result.sent, false);
  assert.equal(result.skipped, true);
  assert.equal(result.sendSkippedReason, "already delivered in Feishu");
  assert.equal(result.existingMessageId, "om_existing_aihot");
  assert.equal(sendCount, 0);
});

test("successful live send writes a date-level idempotency ledger", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "aihot-ledger-"));
  const fixtureFile = path.join(dataDir, "items.json");
  await writeFile(fixtureFile, JSON.stringify(fixture), "utf8");

  const result = await runLiveSendJob({
    job: AI_HOT_JOB_ID,
    date: "2026-07-16",
    dataDir,
    enabled: true,
    confirm: "SEND",
    env: {
      ...AI_HOT_ENV,
      AI_HOT_ITEMS_JSON_FILE: fixtureFile,
      AI_HOT_NOW: RUN_NOW.toISOString()
    },
    sender: {
      async findRecentMessageContaining() {
        return null;
      },
      async sendMessage({ uuid }) {
        assert.equal(uuid, "ai-hot-2026-07-16");
        return { ok: true, messageId: "om_aihot_sent" };
      }
    }
  });

  assert.equal(result.sent, true);
  const ledger = JSON.parse(await readFile(path.join(dataDir, "outputs", "automations", "ai-hot", "ledger.json"), "utf8"));
  assert.equal(ledger.dates["2026-07-16"].idempotencyKey, "ai-hot-2026-07-16");
  assert.equal(ledger.dates["2026-07-16"].messageId, "om_aihot_sent");
  assert.equal(ledger.dates["2026-07-16"].itemIds.length, 6);
});
