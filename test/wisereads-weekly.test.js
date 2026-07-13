import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { runLiveSendJob } from "../src/liveSendRunner.js";
import {
  buildWisereadsWeeklyDryRun,
  getLatestWisereadsSource,
  parseWisereadsFeed,
  WISEREADS_JOB_ID
} from "../src/jobs/wisereadsWeekly.js";

const VOL_151_FEED = `<?xml version="1.0"?>
<rss version="2.0">
  <channel>
    <item>
      <title><![CDATA[Wisereads Vol. 151 — Pax by Tom Holland, the quiet economics of overlooked industries, and more]]></title>
      <link>https://wise.readwise.io/issues/wisereads-vol-151/</link>
      <pubDate>Sun, 12 Jul 2026 14:17:19 +0000</pubDate>
      <content:encoded><![CDATA[
        <main>
          <h2>Article</h2>
          <h3><a href="https://example.com/arguing">Why I Stopped Arguing With People</a></h3>
          <p class="author">Cong Wang · 6 mins</p>
          <p>Conversation improves when status games stop driving the exchange.</p>
          <p>“The fastest way to lose the point is to try to win the person.”</p>
          <hr />
          <h3><a href="https://example.com/invisible">Invisible Companies</a></h3>
          <p class="author">Jay Barney &amp; Haiyang Zhang · 13 mins</p>
          <p>Many valuable industries stay quiet because their markets are narrow and unglamorous.</p>
          <p>“Most overlooked companies win by being boring for longer than competitors can tolerate.”</p>
          <hr />
          <h3><a href="https://example.com/reading">The Age of Reading Is Over</a></h3>
          <p class="author">Rose Horowitch · 34 mins</p>
          <p>The essay follows how reading changes when attention is continuously negotiated.</p>
          <p>“Reading now competes with the whole machine of interruption.”</p>
          <hr />
          <h2>YouTube</h2>
          <h3><a href="https://youtube.com/watch?v=w1">The Best Car I've Ever Driven: McLaren W1</a></h3>
          <p class="author">Marques Brownlee · 17 mins</p>
          <p>A technical review of the McLaren W1 through the lens of product ambition.</p>
          <p>“The surprising part is how calm the machine feels at the edge.”</p>
          <hr />
          <h2>Twitter</h2>
          <h3><a href="https://x.com/example/status/1">Career advice in the age of AI</a></h3>
          <p class="author">Phil Chen · 6 mins</p>
          <p>A short thread on durable career judgment when tools keep changing.</p>
          <p>“The scarce skill is knowing what deserves automation.”</p>
          <hr />
          <h2>PDF</h2>
          <h3><a href="https://example.com/fundsmith.pdf">Fundsmith Equity Fund Semi-Annual Letter To Shareholders 2026</a></h3>
          <p class="author">Fundsmith LLP · 23 mins</p>
          <p>The shareholder letter reviews discipline, valuation, and the cost of impatience.</p>
          <p>“Quality is easiest to admire and hardest to hold.”</p>
          <hr />
          <h2>Book</h2>
          <h3><a href="https://example.com/pax">Pax: War and Peace in Rome's Golden Age</a></h3>
          <p class="author">Tom Holland</p>
          <p>A book excerpt on empire, peace, and the violence hidden beneath order.</p>
          <p>“Peace was not the opposite of power, but one of its costumes.”</p>
          <hr />
          <h2>RSS</h2>
          <h3><a href="https://example.com/small-potatoes">Small Potatoes</a></h3>
          <p>Paul Bloom reflects on small stakes and large emotional reactions.</p>
          <p>“Trivial things are rarely trivial to the person holding them.”</p>
        </main>
      ]]></content:encoded>
    </item>
  </channel>
</rss>`;

const WISEREADS_ENV = {
  LIVE_SEND_ENABLED: "true",
  WISEREADS_WEEKLY_ENABLED: "true",
  WISEREADS_WEEKLY_BOT_ROLE: "xiaoman",
  WISEREADS_WEEKLY_CONNECTION_REF: "xiaoman",
  WISEREADS_WEEKLY_TARGET_CHAT_ID: "oc_test",
  FEISHU_CONNECTION_XIAOMAN_APP_ID: "cli_test",
  FEISHU_CONNECTION_XIAOMAN_APP_SECRET: "secret_test"
};

const ANALYSIS_151 = {
  items: [
    ["Why I Stopped Arguing With People", "Cong Wang 解释为何争论常被情绪与地位竞争主导，真正有效的沟通要先停止把对方当作需要击败的对象。", "人首先凭情绪形成判断，再倒推理由为感受辩护；我们只是偶尔思考的情绪动物。"],
    ["Invisible Companies", "Jay Barney 与 Haiyang Zhang 分析被忽视的小众行业为何能形成耐久利润，并给出识别隐形公司的线索。", "最被忽视的公司，往往靠着比竞争者更久地忍受无聊而获胜。"],
    ["The Age of Reading Is Over", "Rose Horowitch 追踪碎片化注意力如何侵蚀深度阅读，并讨论它对思考、教育与文化的长期影响。", "文字阅读正成为少数人的小众爱好，极少数读者贡献了绝大多数阅读量。"],
    ["The Best Car I've Ever Driven: McLaren W1", "Marques Brownlee 从工程与驾驶体验审视 McLaren W1，呈现极致性能如何仍能保持可控与从容。", "从动力系统到空气动力学与赛道表现，它比以往任何公路车都更接近一台有牌照的一级方程式赛车。"],
    ["Career advice in the age of AI", "Phil Chen 为 AI 时代的年轻建设者梳理职业优先级：把精力放在难以被标准答案衡量的判断与选择上。", "未来十年最有价值的工作，是那些无法在模型训练周期内被打分的问题。"],
    ["Fundsmith Equity Fund Semi-Annual Letter To Shareholders 2026", "Fundsmith 的股东信讨论纪律、估值与耐心成本，并警惕被动投资把市场进一步推向动量驱动。", "指数基金起初有合理依据，但金融创新一旦走向极端，最终也可能带来严重后果。"],
    ["Pax: War and Peace in Rome's Golden Age", "Tom Holland 从帝国秩序背后的征服与暴力切入，重新理解罗马黄金时代所谓和平的真实含义。", "罗马帝国至今仍是一面镜子，我们总愿意从中看见令自己满意的倒影。"],
    ["Small Potatoes", "心理学家 Paul Bloom 从小事与强烈情绪反应出发，思考人如何赋予琐碎经历以超出表面的重量。", "人生可以只是开始、中段、更多中段，再多一些中段，而不必急着迎来结尾。"]
  ].map(([title, summary, quote], index) => ({ index, title, summary, quote }))
};

function enrichFixture(issue) {
  return {
    ...issue,
    items: issue.items.map((item, index) => ({
      ...item,
      summaryZh: ANALYSIS_151.items[index].summary,
      quoteZh: ANALYSIS_151.items[index].quote
    }))
  };
}

async function writeAnalysisFixture(dataDir) {
  const file = path.join(dataDir, "analysis.json");
  await writeFile(file, JSON.stringify(ANALYSIS_151), "utf8");
  return file;
}

test("parses the latest Wisereads RSS issue with Vol.151 content groups", () => {
  const issue = parseWisereadsFeed(VOL_151_FEED);

  assert.equal(issue.vol, 151);
  assert.equal(issue.issueDate, "2026-07-12");
  assert.equal(issue.items.length, 8);
  assert.deepEqual([...new Set(issue.items.map((item) => item.section))], ["Article", "YouTube", "Twitter", "PDF", "Book", "RSS"]);
});

test("builds a native Feishu post dry-run while keeping live send closed", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "wisereads-dryrun-"));
  const result = await buildWisereadsWeeklyDryRun({
    date: "2026-07-13",
    dataDir,
    feedXml: VOL_151_FEED,
    analyzer: enrichFixture,
    env: { WISEREADS_WEEKLY_ENABLED: "false" }
  });

  assert.equal(result.ok, true);
  assert.equal(result.sent, undefined);
  assert.equal(result.metadata.sent, false);
  assert.equal(result.metadata.liveSendGate, "closed");
  assert.equal(result.sourceStatus, "source_available");
  assert.equal(result.source.vol, 151);
  assert.equal(result.payload.zh_cn.content[0][0].text, "Wisereads Vol. 151");
  assert.equal(result.payload.zh_cn.content[0][2].tag, "at");
  assert.equal(result.payload.zh_cn.content[0][2].user_id, "all");
  assert.ok(result.payload.zh_cn.content.some((row) => row[0]?.tag === "md" && row[0].text === "### 热门文章"));
  assert.ok(result.payload.zh_cn.content.some((row) => row[0]?.tag === "md" && row[0].text === "### 影音与社交"));
  assert.ok(result.payload.zh_cn.content.some((row) => row[0]?.tag === "md" && row[0].text === "### 长读与订阅"));
  assert.ok(result.generated.postJson.endsWith("wisereads-vol-151-post.json"));
  const generated = JSON.parse(await readFile(result.generated.postJson, "utf8"));
  assert.equal(generated.zh_cn.content[0][0].text, "Wisereads Vol. 151");
});

test("distinguishes unavailable and parse failed source states", async () => {
  const unavailable = await getLatestWisereadsSource({
    fetchImpl: async () => {
      throw new Error("network down");
    }
  });
  assert.equal(unavailable.ok, false);
  assert.equal(unavailable.status, "source_unavailable");

  const parseFailed = await getLatestWisereadsSource({
    feedXml: VOL_151_FEED.replace(/<h3>/g, "<h4>")
  });
  assert.equal(parseFailed.ok, false);
  assert.equal(parseFailed.status, "parse_failed");
});

test("falls back to the GitHub source mirror when Zeabur cannot reach Readwise", async () => {
  const requested = [];
  const source = await getLatestWisereadsSource({
    rssUrl: "https://wise.readwise.io/feed/",
    mirrorUrl: "https://raw.githubusercontent.com/example/latest.xml",
    fetchImpl: async (url) => {
      requested.push(url);
      if (url.includes("wise.readwise.io")) throw new Error("connect timeout");
      return { ok: true, async text() { return VOL_151_FEED; } };
    }
  });

  assert.deepEqual(requested, [
    "https://wise.readwise.io/feed/",
    "https://raw.githubusercontent.com/example/latest.xml"
  ]);
  assert.equal(source.ok, true);
  assert.equal(source.type, "rss-mirror");
  assert.equal(source.issue.vol, 151);
  assert.equal(source.primaryError, "connect timeout");
});

test("generates Chinese editorial content once and reuses the persisted cache", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "wisereads-analysis-cache-"));
  let modelCalls = 0;
  const fetchImpl = async (_url, options) => {
    modelCalls += 1;
    const request = JSON.parse(options.body);
    assert.equal(request.model, "x-ai/test-model");
    assert.equal(request.response_format.type, "json_object");
    return {
      ok: true,
      async json() {
        return { choices: [{ message: { content: JSON.stringify(ANALYSIS_151) } }] };
      }
    };
  };
  const env = {
    OPENROUTER_API_KEY: "test-key",
    WISEREADS_ANALYSIS_MODEL: "x-ai/test-model",
    WISEREADS_WEEKLY_ENABLED: "false"
  };

  const first = await buildWisereadsWeeklyDryRun({ dataDir, feedXml: VOL_151_FEED, fetchImpl, env });
  const second = await buildWisereadsWeeklyDryRun({
    dataDir,
    feedXml: VOL_151_FEED,
    fetchImpl: async () => { throw new Error("cache should avoid a second model call"); },
    env
  });

  assert.equal(first.ok, true);
  assert.equal(first.analysis.status, "generated");
  assert.equal(first.analysis.model, "x-ai/test-model");
  assert.equal(second.ok, true);
  assert.equal(second.analysis.status, "cached");
  assert.equal(modelCalls, 1);
});

test("live send stays blocked until the Wisereads task gate is explicitly open", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "wisereads-blocked-"));
  const result = await runLiveSendJob({
    job: WISEREADS_JOB_ID,
    date: "2026-07-13",
    dataDir,
    enabled: true,
    confirm: "SEND",
    env: { ...WISEREADS_ENV, WISEREADS_WEEKLY_ENABLED: "false" }
  });

  assert.equal(result.sent, false);
  assert.equal(result.sendSkippedReason, "WISEREADS_WEEKLY_ENABLED disabled");
});

test("checks Feishu before sending to avoid duplicate Wisereads delivery", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "wisereads-feishu-dupe-"));
  const fixtureFile = path.join(dataDir, "feed.xml");
  await writeFile(fixtureFile, VOL_151_FEED, "utf8");
  const analysisFile = await writeAnalysisFixture(dataDir);
  let sendCount = 0;

  const result = await runLiveSendJob({
    job: WISEREADS_JOB_ID,
    date: "2026-07-13",
    dataDir,
    enabled: true,
    confirm: "SEND",
    env: { ...WISEREADS_ENV, WISEREADS_FEED_XML_FILE: fixtureFile, WISEREADS_ANALYSIS_JSON_FILE: analysisFile },
    sender: {
      async findRecentMessageContaining({ text }) {
        assert.equal(text, "Wisereads Vol. 151");
        return { message_id: "om_existing_151" };
      },
      async sendMessage() {
        sendCount += 1;
        return { ok: true, messageId: "om_should_not_send" };
      }
    }
  });

  assert.equal(sendCount, 0);
  assert.equal(result.sent, false);
  assert.equal(result.skipped, true);
  assert.equal(result.sendSkippedReason, "already delivered in Feishu");
  assert.equal(result.existingMessageId, "om_existing_151");
});

test("writes a Vol-scoped sent ledger and state after successful send", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "wisereads-sent-"));
  const fixtureFile = path.join(dataDir, "feed.xml");
  await writeFile(fixtureFile, VOL_151_FEED, "utf8");
  const analysisFile = await writeAnalysisFixture(dataDir);
  let sendCount = 0;

  const sender = {
    async findRecentMessageContaining() {
      return null;
    },
    async sendMessage({ msgType, uuid }) {
      sendCount += 1;
      assert.equal(msgType, "post");
      assert.equal(uuid, "wisereads-vol-151");
      return { ok: true, messageId: "om_sent_151" };
    }
  };

  const first = await runLiveSendJob({
    job: WISEREADS_JOB_ID,
    date: "2026-07-13",
    dataDir,
    enabled: true,
    confirm: "SEND",
    env: { ...WISEREADS_ENV, WISEREADS_FEED_XML_FILE: fixtureFile, WISEREADS_ANALYSIS_JSON_FILE: analysisFile },
    sender
  });
  const second = await runLiveSendJob({
    job: WISEREADS_JOB_ID,
    date: "2026-07-13",
    dataDir,
    enabled: true,
    confirm: "SEND",
    env: { ...WISEREADS_ENV, WISEREADS_FEED_XML_FILE: fixtureFile, WISEREADS_ANALYSIS_JSON_FILE: analysisFile },
    sender
  });

  assert.equal(first.sent, true);
  assert.match(first.files.sentLog, /outputs\/automations\/wisereads-weekly\/vol-151-sent\.json$/);
  assert.equal(second.sent, true);
  assert.equal(second.skipped, true);
  assert.equal(sendCount, 1);

  const state = JSON.parse(await readFile(path.join(dataDir, "outputs", "automations", "wisereads-weekly", "state.json"), "utf8"));
  assert.equal(state.lastDeliveredVol, 151);
  assert.equal(state.lastDeliveredMessageId, "om_sent_151");
});
