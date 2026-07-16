import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

import { shanghaiDateString } from "../date.js";

export const AI_HOT_JOB_ID = "ai-hot";
export const AI_HOT_BASE_URL = "https://aihot.virxact.com";
export const AI_HOT_DEFAULT_USER_AGENT = "KaneAIHotAutomation/0.1 (+https://aihot.virxact.com/agent)";

const SPACER = "　";
const MAX_BRIEF_ITEMS = 8;
const HIGH_VALUE_THRESHOLD = 45;

const SOURCE_PRIMARY_DOMAINS = [
  "openai.com",
  "anthropic.com",
  "alignment.anthropic.com",
  "x.ai",
  "github.com",
  "arxiv.org",
  "deepmind.google",
  "developers.googleblog.com",
  "googleblog.com",
  "research.google",
  "microsoft.com",
  "apple.com",
  "thinkingmachines.ai"
];

const SOURCE_VENDOR_SELF_DOMAINS = [
  "minimax.io",
  "prismml.com",
  "qwenlm.github.io"
];

export async function buildAIHotDryRun({
  date = shanghaiDateString(),
  now = process.env.AI_HOT_NOW ? new Date(process.env.AI_HOT_NOW) : new Date(),
  dataDir,
  fetchImpl = fetch,
  itemsResponse,
  env = process.env
} = {}) {
  const source = await getAIHotSource({ date, now, fetchImpl, itemsResponse, env });
  if (!source.ok) {
    return buildUnavailableResult({ date, now, source, env });
  }

  const selected = selectHighValueAIHotItems(source.items, { date, now });
  const sourceStatus = selected.length ? "source_available" : "no_high_value_content";
  const brief = buildStructuredAIHotBrief({
    date,
    now,
    items: selected,
    source,
    sourceStatus
  });
  const payload = buildAIHotPostPayload(brief);
  const validation = validateAIHotPost(payload, brief);
  const generated = await persistGeneratedArtifact({ dataDir, source, brief, payload, validation });

  return {
    ok: validation.ok,
    job: AI_HOT_JOB_ID,
    dryRun: true,
    msgType: "post",
    date,
    sourceStatus,
    source: {
      type: source.type,
      fingerprint: source.fingerprint || null,
      etag: source.etag || null,
      count: source.items.length,
      windowStart: source.window.startIso,
      windowEnd: source.window.endIso
    },
    brief,
    payload,
    validation,
    preview: renderAIHotPreview(brief),
    idempotencyKey: `ai-hot-${date}`,
    sentLogKey: date,
    duplicateSearchText: brief.title,
    sendPolicy: selected.length ? "send" : "skip",
    sendSkippedReason: selected.length ? null : "no high-value AI HOT items",
    generated,
    metadata: {
      sent: false,
      liveSendGate: env.AI_HOT_ENABLED === "true" ? "open" : "closed",
      modelCalls: 0,
      maxModelCostUsd: 0
    }
  };
}

export async function getAIHotSource({
  date = shanghaiDateString(),
  now = new Date(),
  fetchImpl = fetch,
  itemsResponse,
  env = process.env
} = {}) {
  const window = shanghaiDayWindow({ date, now });
  if (itemsResponse) return parseItemsResponse({ body: itemsResponse, type: "fixture", window });
  if (env.AI_HOT_ITEMS_JSON_FILE) {
    try {
      const body = JSON.parse(await readFile(env.AI_HOT_ITEMS_JSON_FILE, "utf8"));
      return parseItemsResponse({ body, type: "json-fixture", window });
    } catch (error) {
      return { ok: false, status: "parse_failed", error: error.message, window };
    }
  }

  const userAgent = env.AI_HOT_USER_AGENT || AI_HOT_DEFAULT_USER_AGENT;
  const fingerprint = await fetchFingerprint({ fetchImpl, userAgent });
  const url = new URL("/api/public/items", AI_HOT_BASE_URL);
  url.searchParams.set("mode", "selected");
  url.searchParams.set("since", window.startIso);
  url.searchParams.set("take", "50");

  const response = await fetchJson({ url, fetchImpl, userAgent });
  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      error: response.error,
      httpStatus: response.httpStatus || null,
      window,
      fingerprint: fingerprint.ok ? fingerprint.body : null,
      fingerprintStatus: fingerprint.status
    };
  }
  return parseItemsResponse({
    body: response.body,
    type: "api",
    window,
    etag: response.etag,
    fingerprint: fingerprint.ok ? fingerprint.body : null,
    fingerprintStatus: fingerprint.status
  });
}

export function classifyAIHotSource({ source = "", url = "" } = {}) {
  const sourceText = String(source);
  const lowerSource = sourceText.toLowerCase();
  const host = safeHostname(url);

  if (/^x[:：]/i.test(sourceText) || host === "x.com" || host === "twitter.com" || host.endsWith(".x.com")) {
    return { credibility: "x", label: "X，需核验", needsVerification: true };
  }
  if (/转载|转自|via|聚合|媒体/i.test(sourceText)) {
    return { credibility: "repost", label: "转载", needsVerification: true };
  }
  if (SOURCE_VENDOR_SELF_DOMAINS.some((domain) => host === domain || host.endsWith(`.${domain}`)) || /官方博客|公众号[:：].*（|vendor/i.test(lowerSource)) {
    return { credibility: "vendor", label: "厂商自评", needsVerification: true };
  }
  if (SOURCE_PRIMARY_DOMAINS.some((domain) => host === domain || host.endsWith(`.${domain}`))) {
    return { credibility: "primary", label: "一手来源", needsVerification: false };
  }
  return { credibility: "unknown", label: "来源待核验", needsVerification: true };
}

export function selectHighValueAIHotItems(items, { date, now = new Date() } = {}) {
  const seen = new Set();
  return items
    .filter((item) => isInsideWindow(item, { date, now }))
    .map(normalizeAIHotItem)
    .filter((item) => {
      const key = duplicateKey(item);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((item) => ({ ...item, ranking: scoreAIHotItem(item) }))
    .filter((item) => item.ranking.score >= HIGH_VALUE_THRESHOLD && !item.ranking.lowSignal)
    .sort((left, right) => {
      if (right.ranking.score !== left.ranking.score) return right.ranking.score - left.ranking.score;
      return new Date(right.publishedAt || 0) - new Date(left.publishedAt || 0);
    })
    .slice(0, MAX_BRIEF_ITEMS)
    .map((item, index) => toBriefItem(item, index + 1));
}

export function buildStructuredAIHotBrief({ date, now = new Date(), items, source, sourceStatus }) {
  const title = `AI HOT 关注简报 · ${date}`;
  const window = source?.window || shanghaiDayWindow({ date, now });
  const brief = {
    title,
    date,
    timezone: "Asia/Shanghai",
    generatedAt: now.toISOString(),
    sourceStatus,
    window: {
      start: formatShanghaiDateTime(window.startIso),
      end: formatShanghaiDateTime(window.endIso)
    },
    items,
    judgment: buildDailyJudgment(items),
    actions: buildActions(items),
    provenance: {
      sourceName: "AI HOT",
      sourceUrl: "https://aihot.virxact.com",
      fingerprint: source?.fingerprint || null,
      itemCount: source?.items?.length || 0,
      modelCalls: 0
    }
  };
  return brief;
}

export function buildAIHotPostPayload(brief) {
  const rows = [];
  const addSpacer = () => rows.push([{ tag: "text", text: SPACER }]);
  const addHeading = (text) => rows.push([{ tag: "text", text, style: ["bold"] }]);

  rows.push([{ tag: "text", text: brief.title, style: ["bold"] }]);
  addSpacer();
  rows.push([{ tag: "md", text: `*窗口：${brief.window.start} 至 ${brief.window.end} · ${brief.items.length} 条*` }]);
  addSpacer();

  if (!brief.items.length) {
    rows.push([{ tag: "text", text: "今天暂未筛出足够高信号的 AI HOT 条目；不凑数。" }]);
  } else {
    for (const [index, item] of brief.items.entries()) {
      rows.push([
        { tag: "text", text: `${item.rank}. ` },
        { tag: "a", text: item.title, href: item.sourceUrl },
        { tag: "text", text: ` · ${item.source} · ${item.sourceLabel}` }
      ]);
      addSpacer();
      rows.push([{ tag: "text", text: `发生了什么：${item.happened}` }]);
      rows.push([{ tag: "text", text: `为什么关注：${item.whyWatch}` }]);
      if (item.flags.length) {
        rows.push([{ tag: "md", text: `> 标签：${item.flags.join(" / ")}` }]);
      }
      if (index !== brief.items.length - 1) {
        addSpacer();
        rows.push([{ tag: "hr" }]);
        addSpacer();
      }
    }
  }

  addSpacer();
  addHeading("今日判断");
  rows.push([{ tag: "text", text: brief.judgment }]);
  if (brief.actions.length) {
    addSpacer();
    addHeading("立即行动");
    for (const action of brief.actions) rows.push([{ tag: "text", text: action }]);
  }

  return { zh_cn: { title: "", content: rows } };
}

export function validateAIHotPost(payload, brief) {
  const errors = [];
  const zhCn = payload?.zh_cn;
  const content = zhCn?.content;
  if (!zhCn || typeof zhCn !== "object") return { ok: false, errors: ["payload.zh_cn is required"] };
  if (zhCn.title !== "") errors.push("outer title must be empty");
  if (!Array.isArray(content)) return { ok: false, errors: [...errors, "content must be an array"] };
  if (content[0]?.[0]?.tag !== "text" || content[0]?.[0]?.text !== brief.title || !content[0]?.[0]?.style?.includes("bold")) {
    errors.push("row 0 must contain the bold AI HOT title");
  }
  if (brief.items.length > MAX_BRIEF_ITEMS) errors.push("brief must not exceed eight items");
  if (brief.actions.length > 2) errors.push("brief must not exceed two actions");
  if (JSON.stringify(payload).match(/\/api\/public|mode=|take=|cursor|hasNext/)) {
    errors.push("payload must not expose API internals");
  }

  for (const item of brief.items) {
    if (!item.sourceUrl) errors.push(`missing source URL: ${item.title}`);
    const hasLink = content.some((row) => row.some((cell) => cell.tag === "a" && cell.href === item.sourceUrl));
    if (!hasLink) errors.push(`missing native link: ${item.title}`);
    if (!item.happened || !item.whyWatch) errors.push(`missing explanation: ${item.title}`);
    if (["x", "repost", "vendor"].includes(item.sourceCredibility) && !item.sourceLabel) {
      errors.push(`missing weak-source label: ${item.title}`);
    }
  }
  if (brief.items.length && !brief.judgment) errors.push("missing daily judgment");
  return { ok: errors.length === 0, errors };
}

export async function recordAIHotDelivered({ dataDir, brief, messageId, deliveredAt = new Date().toISOString() }) {
  const dir = path.join(dataDir, "outputs", "automations", AI_HOT_JOB_ID);
  await mkdir(dir, { recursive: true });
  const ledgerFile = path.join(dir, "ledger.json");
  const ledger = existsSync(ledgerFile)
    ? JSON.parse(await readFile(ledgerFile, "utf8"))
    : { dates: {} };
  ledger.dates[brief.date] = {
    idempotencyKey: `ai-hot-${brief.date}`,
    messageId: messageId || null,
    deliveredAt,
    itemIds: brief.items.map((item) => item.id),
    itemUrls: brief.items.map((item) => item.sourceUrl),
    sourceStatus: brief.sourceStatus,
    fingerprint: brief.provenance.fingerprint || null,
    duplicateSearchText: brief.title
  };
  await writeFile(ledgerFile, JSON.stringify(ledger, null, 2), "utf8");
  return ledger;
}

function buildUnavailableResult({ date, now, source, env }) {
  const brief = buildStructuredAIHotBrief({
    date,
    now,
    source,
    sourceStatus: source.status,
    items: []
  });
  const payload = buildAIHotPostPayload(brief);
  return {
    ok: false,
    job: AI_HOT_JOB_ID,
    dryRun: true,
    sent: false,
    msgType: "post",
    date,
    sourceStatus: source.status,
    source: {
      type: source.type || "api",
      error: source.error,
      httpStatus: source.httpStatus || null,
      windowStart: source.window?.startIso || null,
      windowEnd: source.window?.endIso || null
    },
    brief,
    payload,
    validation: { ok: false, errors: [source.error || source.status] },
    preview: renderAIHotPreview(brief),
    idempotencyKey: `ai-hot-${date}`,
    sentLogKey: date,
    duplicateSearchText: brief.title,
    sendPolicy: "skip",
    sendSkippedReason: source.status,
    metadata: {
      sent: false,
      liveSendGate: env.AI_HOT_ENABLED === "true" ? "open" : "closed",
      modelCalls: 0,
      maxModelCostUsd: 0
    }
  };
}

function normalizeAIHotItem(item) {
  const sourceInfo = classifyAIHotSource(item);
  return {
    id: String(item.id || ""),
    title: cleanText(item.title),
    sourceUrl: String(item.url || ""),
    permalink: item.permalink || null,
    source: cleanText(item.source),
    publishedAt: item.publishedAt || null,
    summary: cleanText(item.summary || ""),
    category: item.category || null,
    originalScore: Number.isFinite(item.score) ? item.score : null,
    sourceCredibility: sourceInfo.credibility,
    sourceLabel: sourceInfo.label,
    needsVerification: sourceInfo.needsVerification
  };
}

function scoreAIHotItem(item) {
  const text = `${item.title}\n${item.summary}\n${item.category || ""}`;
  const signals = {
    agentCoding: /Codex|Claude Code|Cursor|AI IDE|SWE-bench|CLI|编程|代码|编码|仓库|remote runner|runner/i.test(text),
    model: item.category === "ai-models" || /模型|GPT-\d|Gemma|Llama|多模态|长上下文|benchmark|SWE-bench/i.test(text),
    workflow: /工作流|自动化|MCP|连接器|报告|表格|远程|开源|应用|可编辑文件|生成/i.test(text),
    security: /安全|权限|token|隐私|漏洞|恶意|越权|读取.*token|泄露|风险|对齐|misalignment/i.test(text),
    research: item.category === "paper" || /研究团队|研究发布|论文|模拟实验|alignment|arxiv/i.test(text),
    industry: /开源|收购|监管|诉讼|合作|行业|平台/i.test(text)
  };
  const funding = /融资|估值|募资|投资|[ABCDEF]\s*轮/i.test(text);
  const marketing = /全球首个|重磅|震撼|颠覆|遥遥领先|大幅提升/i.test(text);
  const weights = [];
  if (signals.agentCoding) weights.push(["agent-coding", 50]);
  if (signals.security) weights.push(["security", 48]);
  if (signals.model) weights.push(["model", 42]);
  if (signals.research) weights.push(["research", 40]);
  if (signals.workflow) weights.push(["workflow", 34]);
  if (signals.industry) weights.push(["industry", 24]);
  weights.sort((left, right) => right[1] - left[1]);
  const primary = weights[0] || ["general", 12];
  const secondaryBonus = Math.min(8, weights.slice(1).length * 3);
  const sourceAdjustment = {
    primary: 3,
    vendor: -3,
    x: -3,
    repost: -10,
    unknown: -4
  }[item.sourceCredibility] ?? 0;
  const urgencyBonus = signals.security && item.needsVerification ? 5 : 0;
  const lowSignal = funding && !signals.security && !signals.agentCoding && !signals.model;
  const score = Math.round(((item.originalScore ?? 50) * 0.3) + primary[1] + secondaryBonus + sourceAdjustment + urgencyBonus - (lowSignal ? 60 : 0) - (marketing && item.sourceCredibility === "vendor" ? 8 : 0));
  return {
    score,
    topic: primary[0],
    signals,
    lowSignal
  };
}

function toBriefItem(item, rank) {
  const flags = flagsForItem(item);
  return {
    rank,
    id: item.id,
    title: item.title,
    source: item.source,
    sourceUrl: item.sourceUrl,
    publishedAt: item.publishedAt,
    publishedAtShanghai: formatShanghaiDateTime(item.publishedAt),
    category: item.category,
    originalScore: item.originalScore,
    internalScore: item.ranking.score,
    topic: item.ranking.topic,
    sourceCredibility: item.sourceCredibility,
    sourceLabel: item.sourceLabel,
    needsVerification: item.needsVerification,
    flags,
    happened: trimSentence(item.summary || item.title, 120),
    whyWatch: whyWatch(item)
  };
}

function flagsForItem(item) {
  const flags = [];
  if (item.ranking.signals.agentCoding) flags.push("Agent/编码工具");
  if (item.ranking.signals.security) flags.push("安全/权限风险");
  if (item.ranking.signals.model) flags.push("模型能力");
  if (item.ranking.signals.workflow) flags.push("可用工作流");
  if (item.ranking.signals.research) flags.push("研究");
  if (item.sourceCredibility !== "primary") flags.push(item.sourceLabel);
  return [...new Set(flags)];
}

function whyWatch(item) {
  const signals = item.ranking.signals;
  if (signals.security) return "涉及仓库、token、权限或代理越权边界，值得先看风险面，再决定是否试用。";
  if (signals.agentCoding) return "和 Agent 编码、远程开发或仓库级自动化直接相关，可能改变日常开发工作流。";
  if (signals.model) return "模型能力变化会影响编码工具、Agent 选型和后续评测优先级。";
  if (signals.workflow) return "有机会直接复用到数据连接、报告生成或自动化交付流程。";
  if (signals.research) return "会影响对长期 Agent 权限、可靠性和安全边界的判断。";
  return "信息信号高于普通营销稿，值得保留原始链接后续核验。";
}

function buildDailyJudgment(items) {
  if (!items.length) return "今天 AI HOT 暂时没有足够值得打断注意力的高信号内容。";
  const hasSecurity = items.some((item) => item.flags.includes("安全/权限风险"));
  const agentOrWorkflowCount = items.filter((item) => item.flags.includes("Agent/编码工具") || item.flags.includes("可用工作流")).length;
  const hasModel = items.some((item) => item.flags.includes("模型能力"));
  if (hasSecurity && agentOrWorkflowCount >= 2) {
    return "今天主线是 Agent/编码工具继续变得更可用，但权限、token 和仓库边界也同步变成真实风险。";
  }
  if (agentOrWorkflowCount >= 2) return "今天主线是 AI 工具从单点能力走向可组合工作流，值得优先找能马上试用的环节。";
  if (hasModel) return "今天主线偏模型能力更新，但仍要把厂商自评当线索，用自己的小样本验证。";
  return "今天没有单一爆点，价值主要在少数可复用工具和一手来源的持续跟踪。";
}

function buildActions(items) {
  if (!items.length) return [];
  const actions = [];
  if (items.some((item) => item.flags.includes("安全/权限风险"))) {
    actions.push("先把涉及仓库、token、插件权限的条目标为隔离试用，避免直接接入主力工作区。");
  }
  const firstAgent = items.find((item) => item.flags.includes("Agent/编码工具") || item.flags.includes("可用工作流"));
  if (firstAgent) {
    actions.push(`挑第 ${firstAgent.rank} 条做一次 30 分钟 dry-run，只验证输入输出、权限边界和是否能进入你的真实流程。`);
  }
  if (actions.length < 2 && items.some((item) => item.sourceCredibility === "vendor")) {
    actions.push("厂商 benchmark 只进入观察清单，等第三方复现或用自己的仓库样本再判断。");
  }
  return actions.slice(0, 2);
}

async function persistGeneratedArtifact({ dataDir, source, brief, payload, validation }) {
  if (!dataDir) return null;
  const dir = path.join(dataDir, "outputs", "automations", AI_HOT_JOB_ID, "generated");
  await mkdir(dir, { recursive: true });
  const briefJson = path.join(dir, `${brief.date}-brief.json`);
  const postJson = path.join(dir, `${brief.date}-post.json`);
  const sourceJson = path.join(dir, `${brief.date}-source.json`);
  await writeFile(briefJson, JSON.stringify(brief, null, 2), "utf8");
  await writeFile(postJson, JSON.stringify(payload, null, 2), "utf8");
  await writeFile(sourceJson, JSON.stringify({
    status: brief.sourceStatus,
    source: {
      type: source.type,
      fingerprint: source.fingerprint || null,
      etag: source.etag || null,
      count: source.items?.length || 0
    },
    validation
  }, null, 2), "utf8");
  return { briefJson, postJson, sourceJson };
}

async function fetchFingerprint({ fetchImpl, userAgent }) {
  const url = new URL("/api/public/fingerprint", AI_HOT_BASE_URL);
  try {
    const response = await fetchJson({ url, fetchImpl, userAgent });
    return response.ok ? response : { ok: false, status: response.status, error: response.error };
  } catch (error) {
    return { ok: false, status: "source_unavailable", error: error.message };
  }
}

async function fetchJson({ url, fetchImpl, userAgent }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  let response;
  try {
    response = await fetchImpl(url, {
      headers: { "user-agent": userAgent },
      signal: controller.signal
    });
  } catch (error) {
    clearTimeout(timeout);
    return { ok: false, status: "source_unavailable", error: error.message };
  }
  clearTimeout(timeout);

  const httpStatus = response.status || 0;
  const etag = typeof response.headers?.get === "function" ? response.headers.get("etag") : null;
  if (!response.ok) {
    return { ok: false, status: "source_unavailable", httpStatus, error: `AI HOT request failed: ${httpStatus}` };
  }
  let text;
  try {
    text = await response.text();
  } catch (error) {
    return { ok: false, status: "source_unavailable", httpStatus, error: error.message };
  }
  try {
    return { ok: true, status: "source_available", httpStatus, body: JSON.parse(text), etag };
  } catch (error) {
    return { ok: false, status: "parse_failed", httpStatus, error: error.message };
  }
}

function parseItemsResponse({ body, type, window, etag = null, fingerprint = null, fingerprintStatus = null }) {
  if (!body || !Array.isArray(body.items)) {
    return { ok: false, status: "parse_failed", error: "AI HOT response must contain items array", type, window };
  }
  const errors = [];
  const items = body.items.map((item, index) => {
    for (const field of ["id", "title", "url", "source"]) {
      if (!item?.[field]) errors.push(`item ${index} missing ${field}`);
    }
    return item;
  });
  if (errors.length) return { ok: false, status: "parse_failed", error: errors.join("; "), type, window };
  return {
    ok: true,
    status: "source_available",
    type,
    window,
    etag,
    fingerprint,
    fingerprintStatus,
    count: body.count ?? items.length,
    items
  };
}

function shanghaiDayWindow({ date, now = new Date() }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`Invalid date: ${date}`);
  const start = new Date(`${date}T00:00:00+08:00`);
  const nowDate = shanghaiDateString(now);
  const end = nowDate === date ? now : new Date(`${date}T23:59:59.999+08:00`);
  return {
    start,
    end,
    startIso: start.toISOString(),
    endIso: end.toISOString()
  };
}

function isInsideWindow(item, { date, now }) {
  if (!item.publishedAt) return false;
  const published = new Date(item.publishedAt);
  if (Number.isNaN(published.getTime())) return false;
  const window = shanghaiDayWindow({ date, now });
  return published >= window.start && published <= window.end;
}

function duplicateKey(item) {
  return item.sourceUrl
    ? `url:${item.sourceUrl.toLowerCase().replace(/[#?].*$/, "")}`
    : `title:${item.title.toLowerCase().replace(/\s+/g, "")}`;
}

function renderAIHotPreview(brief) {
  const lines = [
    brief.title,
    `窗口：${brief.window.start} 至 ${brief.window.end}`,
    ""
  ];
  if (!brief.items.length) {
    lines.push("今天暂未筛出足够高信号的 AI HOT 条目；不凑数。");
  } else {
    for (const item of brief.items) {
      lines.push(`${item.rank}. ${item.title} — ${item.source}（${item.sourceLabel}）`);
      lines.push(`发生了什么：${item.happened}`);
      lines.push(`为什么关注：${item.whyWatch}`);
      lines.push(item.sourceUrl);
      lines.push("");
    }
  }
  lines.push(`今日判断：${brief.judgment}`);
  if (brief.actions.length) {
    lines.push("立即行动：");
    for (const action of brief.actions) lines.push(`- ${action}`);
  }
  return lines.join("\n");
}

function formatShanghaiDateTime(value) {
  if (!value) return "";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(date).replaceAll("/", "-");
}

function safeHostname(url) {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

function cleanText(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function trimSentence(text, limit) {
  const cleaned = cleanText(text);
  if (Array.from(cleaned).length <= limit) return cleaned;
  return `${Array.from(cleaned).slice(0, limit - 1).join("")}…`;
}
