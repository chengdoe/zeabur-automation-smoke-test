import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

import { shanghaiDateString } from "../date.js";

export const WISEREADS_JOB_ID = "wisereads-weekly";
export const DEFAULT_WISEREADS_RSS_URL = "https://wise.readwise.io/feed/";
export const DEFAULT_WISEREADS_MIRROR_URL = "https://raw.githubusercontent.com/chengdoe/zeabur-automation-smoke-test/main/data-sources/wisereads/latest.xml";
export const NBSP = "\u00a0";

const GROUPS = {
  article: "热门文章",
  social: "影音与社交",
  long: "长读与订阅"
};

export async function buildWisereadsWeeklyDryRun({
  date = shanghaiDateString(),
  dataDir,
  fetchImpl = fetch,
  feedXml,
  analyzer,
  env = process.env
} = {}) {
  const rssUrl = env.WISEREADS_RSS_URL || DEFAULT_WISEREADS_RSS_URL;
  const mirrorUrl = env.WISEREADS_MIRROR_URL || DEFAULT_WISEREADS_MIRROR_URL;
  const previousDeliveredVol = await readLastDeliveredVol({ dataDir });
  const fixtureXml = feedXml ?? (env.WISEREADS_FEED_XML_FILE ? await readFile(env.WISEREADS_FEED_XML_FILE, "utf8") : undefined);
  const source = await getLatestWisereadsSource({ rssUrl, mirrorUrl, fetchImpl, feedXml: fixtureXml });

  if (!source.ok) {
    return buildUnavailableResult({ date, source, previousDeliveredVol });
  }

  if (previousDeliveredVol && source.issue.vol <= previousDeliveredVol) {
    return buildAlreadyDeliveredResult({ date, source, previousDeliveredVol, env });
  }

  const enrichment = await getEnrichedIssue({
    dataDir,
    issue: source.issue,
    analyzer: analyzer ?? createWisereadsAnalyzer({ env, fetchImpl })
  });
  if (!enrichment.ok) {
    return buildAnalysisUnavailableResult({ date, source, previousDeliveredVol, error: enrichment.error, env });
  }

  const payload = buildWisereadsPostPayload(enrichment.issue);
  const validation = validateWisereadsPost(payload, { expectedVol: source.issue.vol });
  const generated = await persistGeneratedArtifact({ dataDir, issue: enrichment.issue, payload, validation });

  return {
    ok: validation.ok,
    job: WISEREADS_JOB_ID,
    dryRun: true,
    msgType: "post",
    date,
    issueDate: source.issue.issueDate,
    sourceStatus: "source_available",
    source: {
      type: source.type || "rss",
      url: rssUrl,
      mirrorUrl: source.type === "rss-mirror" ? mirrorUrl : null,
      vol: source.issue.vol,
      title: source.issue.title,
      link: source.issue.link,
      pubDate: source.issue.pubDate
    },
    previousDeliveredVol,
    analysis: {
      status: enrichment.cached ? "cached" : "generated",
      model: enrichment.model || null
    },
    payload,
    validation,
    preview: renderPreview(source.issue),
    idempotencyKey: `wisereads-vol-${source.issue.vol}`,
    sentLogKey: `vol-${source.issue.vol}`,
    generated,
    metadata: {
      sent: false,
      liveSendGate: env.WISEREADS_WEEKLY_ENABLED === "true" ? "open" : "closed"
    }
  };
}

export function createWisereadsAnalyzer({
  env = process.env,
  fetchImpl = fetch,
  apiKey = env.OPENROUTER_API_KEY || "",
  model = env.WISEREADS_ANALYSIS_MODEL || env.FUND_ANALYSIS_MODEL || ""
} = {}) {
  if (env.WISEREADS_ANALYSIS_JSON_FILE) {
    return async function analyzeWisereadsFromFixture(issue) {
      const analysis = JSON.parse(await readFile(env.WISEREADS_ANALYSIS_JSON_FILE, "utf8"));
      return applyWisereadsAnalysis(issue, analysis);
    };
  }
  if (!apiKey || !model) return null;
  return async function analyzeWisereads(issue) {
    const response = await fetchImpl("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
        "x-openrouter-title": "Kane Wisereads Weekly"
      },
      body: JSON.stringify({
        model,
        temperature: 0.2,
        messages: [{ role: "user", content: buildWisereadsAnalysisPrompt(issue) }],
        response_format: { type: "json_object" }
      })
    });
    const body = await response.json();
    if (!response.ok) {
      throw new Error(`Wisereads analysis failed (${response.status}): ${body?.error?.message || "unknown error"}`);
    }
    const text = body?.choices?.[0]?.message?.content;
    if (!text) throw new Error("Wisereads analysis returned empty output");
    return { ...applyWisereadsAnalysis(issue, parseJsonObject(text)), analysisModel: model };
  };
}

export async function getLatestWisereadsSource({
  rssUrl = DEFAULT_WISEREADS_RSS_URL,
  mirrorUrl = DEFAULT_WISEREADS_MIRROR_URL,
  fetchImpl = fetch,
  feedXml
} = {}) {
  if (feedXml !== undefined) return parseSourceXml(feedXml, { type: "rss-fixture" });
  try {
    return parseSourceXml(await fetchText({ url: rssUrl, fetchImpl }), { type: "rss" });
  } catch (primaryError) {
    try {
      const mirrored = parseSourceXml(await fetchText({ url: mirrorUrl, fetchImpl }), { type: "rss-mirror" });
      return { ...mirrored, primaryError: primaryError.message };
    } catch (mirrorError) {
      return {
        ok: false,
        status: "source_unavailable",
        error: `primary: ${primaryError.message}; mirror: ${mirrorError.message}`
      };
    }
  }
}

function parseSourceXml(xml, { type }) {
  const issue = parseWisereadsFeed(xml);
  if (!issue) return { ok: false, status: "source_absent", error: "no Wisereads RSS item found", type };
  const validation = validateIssue(issue);
  if (!validation.ok) return { ok: false, status: "parse_failed", error: validation.errors.join("; "), issue, type };
  return { ok: true, status: "source_available", issue, type };
}

export async function readLastDeliveredVol({ dataDir }) {
  if (!dataDir) return null;
  const dir = path.join(dataDir, "outputs", "automations", WISEREADS_JOB_ID);
  if (!existsSync(dir)) return null;
  try {
    const stateFile = path.join(dir, "state.json");
    if (!existsSync(stateFile)) return null;
    const state = JSON.parse(await readFile(stateFile, "utf8"));
    return Number.isInteger(state.lastDeliveredVol) ? state.lastDeliveredVol : null;
  } catch {
    return null;
  }
}

export async function recordWisereadsDelivered({ dataDir, vol, messageId, deliveredAt = new Date().toISOString() }) {
  const dir = path.join(dataDir, "outputs", "automations", WISEREADS_JOB_ID);
  await mkdir(dir, { recursive: true });
  const stateFile = path.join(dir, "state.json");
  const existing = existsSync(stateFile) ? JSON.parse(await readFile(stateFile, "utf8")) : {};
  const state = {
    ...existing,
    lastDeliveredVol: vol,
    lastDeliveredMessageId: messageId || null,
    lastDeliveredAt: deliveredAt
  };
  await writeFile(stateFile, JSON.stringify(state, null, 2), "utf8");
  return state;
}

export function parseWisereadsFeed(xml) {
  const item = firstMatch(xml, /<item>([\s\S]*?)<\/item>/i);
  if (!item) return null;
  const title = decodeXml(stripCdata(firstMatch(item, /<title>([\s\S]*?)<\/title>/i) || "").trim());
  const link = decodeXml(stripCdata(firstMatch(item, /<link>([\s\S]*?)<\/link>/i) || "").trim());
  const pubDate = decodeXml(stripCdata(firstMatch(item, /<pubDate>([\s\S]*?)<\/pubDate>/i) || "").trim());
  const html = stripCdata(firstMatch(item, /<content:encoded>([\s\S]*?)<\/content:encoded>/i) || "");
  const vol = Number((title.match(/Wisereads Vol\.\s*(\d+)/i) || [])[1]);
  const parsedItems = parseWisereadsHtmlItems(html);

  return {
    vol: Number.isInteger(vol) ? vol : null,
    title,
    link,
    pubDate,
    issueDate: pubDate ? shanghaiDateFromPubDate(pubDate) : null,
    items: parsedItems
  };
}

export function parseWisereadsHtmlItems(html) {
  const sections = [];
  const sectionRegex = /<h2>([\s\S]*?)<\/h2>([\s\S]*?)(?=<h2>|<\/main>|$)/gi;
  let sectionMatch;
  while ((sectionMatch = sectionRegex.exec(html))) {
    const section = htmlToText(sectionMatch[1]);
    const body = sectionMatch[2];
    const h3Regex = /<h3>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>\s*<\/h3>([\s\S]*?)(?=<h3>|<hr \/>|<hr>|$)/gi;
    let h3Match;
    while ((h3Match = h3Regex.exec(body))) {
      const after = h3Match[3];
      const author = htmlToText(firstMatch(after, /<p class="author">([\s\S]*?)<\/p>/i) || "");
      const paragraphs = [];
      const pRegex = /<p(?! class="author")[^>]*>([\s\S]*?)<\/p>/gi;
      let pMatch;
      while ((pMatch = pRegex.exec(after))) {
        const text = htmlToText(pMatch[1]);
        if (text) paragraphs.push(text);
      }
      sections.push({
        section,
        title: htmlToText(h3Match[2]),
        link: decodeXml(h3Match[1]),
        author,
        paragraphs
      });
    }
  }
  return sections;
}

export function buildWisereadsPostPayload(issue) {
  const rows = [];
  const addSpacer = () => rows.push([{ tag: "text", text: NBSP }]);
  const addHr = () => rows.push([{ tag: "hr" }]);
  const addSection = (name) => {
    rows.push([{ tag: "md", text: `### ${name}` }]);
    addSpacer();
  };
  const addItem = (entry, isLast = false) => {
    const meta = metadataForEntry(entry);
    rows.push([
      { tag: "text", text: `${iconForEntry(entry)} ` },
      { tag: "a", text: entry.title, href: entry.link },
      { tag: "text", text: ` · ${meta}` }
    ]);
    addSpacer();
    rows.push([{ tag: "text", text: summaryForEntry(entry) }]);
    addSpacer();
    rows.push([{ tag: "md", text: `> ${quoteForEntry(entry)}` }]);
    if (!isLast) {
      addSpacer();
      addHr();
      addSpacer();
    }
  };

  rows.push([
    { tag: "text", text: `Wisereads Vol. ${issue.vol}`, style: ["bold"] },
    { tag: "text", text: " " },
    { tag: "at", user_id: "all", user_name: "所有人" }
  ]);
  addSpacer();
  rows.push([{ tag: "md", text: `*${issue.issueDate} · Readwise 社区高亮精选*` }]);
  addSpacer();

  const grouped = groupItems(issue.items);
  const sections = [GROUPS.article, GROUPS.social, GROUPS.long];
  for (const sectionName of sections) {
    const items = grouped[sectionName] || [];
    if (!items.length) continue;
    addSection(sectionName);
    items.forEach((entry, index) => addItem(entry, sectionName === sections.at(-1) && index === items.length - 1));
  }
  return { zh_cn: { content: rows } };
}

export function validateWisereadsPost(payload, { expectedVol } = {}) {
  const errors = [];
  const content = payload?.zh_cn?.content;
  if (!Array.isArray(content)) return { ok: false, errors: ["payload.zh_cn.content must be an array"] };
  const row0 = content[0] || [];
  if (row0[0]?.tag !== "text" || !row0[0].style?.includes("bold") || !row0[0].text?.startsWith("Wisereads Vol.")) {
    errors.push("row 0 must start with bold Wisereads title");
  }
  if (expectedVol && row0[0]?.text !== `Wisereads Vol. ${expectedVol}`) {
    errors.push(`row 0 title must match Vol.${expectedVol}`);
  }
  if (row0[2]?.tag !== "at" || row0[2]?.user_id !== "all") {
    errors.push("row 0 must include real @all");
  }
  if (!content.some((row) => row[0]?.tag === "md" && row[0].text === "### 热门文章")) errors.push("missing 热门文章 section");
  if (!content.some((row) => row[0]?.tag === "md" && row[0].text === "### 影音与社交")) errors.push("missing 影音与社交 section");
  if (!content.some((row) => row[0]?.tag === "md" && row[0].text === "### 长读与订阅")) errors.push("missing 长读与订阅 section");
  if (!content.some((row) => row[0]?.tag === "a" || row.some((item) => item.tag === "a"))) errors.push("missing native links");
  if (!content.some((row) => row[0]?.tag === "hr")) errors.push("missing hr separators");
  if (!content.some((row) => row[0]?.tag === "text" && row[0].text === NBSP)) errors.push("missing NBSP spacer rows");
  const proseRows = content.filter((row) => row.length === 1 && ["text", "md"].includes(row[0]?.tag));
  const nonStructuralProse = proseRows.filter((row) => {
    const text = row[0]?.text || "";
    return text !== NBSP && !text.startsWith("### ") && !text.startsWith("*");
  });
  if (!nonStructuralProse.length || nonStructuralProse.some((row) => !hasCjk(row[0].text))) {
    errors.push("summaries and quotes must be Chinese-localized");
  }
  return { ok: errors.length === 0, errors };
}

export function shouldBlockWisereadsLiveSend(env = process.env) {
  return env.WISEREADS_WEEKLY_ENABLED !== "true";
}

function buildUnavailableResult({ date, source, previousDeliveredVol }) {
  return {
    ok: false,
    job: WISEREADS_JOB_ID,
    dryRun: true,
    sent: false,
    msgType: "post",
    date,
    sourceStatus: source.status,
    source: { type: "rss", error: source.error || "unknown" },
    previousDeliveredVol,
    payload: { zh_cn: { content: [] } },
    validation: { ok: false, errors: [source.error || source.status] },
    preview: "",
    metadata: { sent: false }
  };
}

function buildAlreadyDeliveredResult({ date, source, previousDeliveredVol, env }) {
  return {
    ok: true,
    job: WISEREADS_JOB_ID,
    dryRun: true,
    sent: false,
    msgType: "post",
    date,
    sourceStatus: "already_delivered_ledger",
    source: { type: "rss", vol: source.issue.vol, title: source.issue.title, link: source.issue.link, pubDate: source.issue.pubDate },
    previousDeliveredVol,
    payload: { zh_cn: { content: [] } },
    validation: { ok: true, errors: [] },
    preview: renderPreview(source.issue),
    idempotencyKey: `wisereads-vol-${source.issue.vol}`,
    sentLogKey: `vol-${source.issue.vol}`,
    metadata: { sent: false, liveSendGate: env.WISEREADS_WEEKLY_ENABLED === "true" ? "open" : "closed" }
  };
}

function buildAnalysisUnavailableResult({ date, source, previousDeliveredVol, error, env }) {
  return {
    ok: false,
    job: WISEREADS_JOB_ID,
    dryRun: true,
    sent: false,
    msgType: "post",
    date,
    sourceStatus: "analysis_unavailable",
    source: { type: "rss", vol: source.issue.vol, title: source.issue.title, link: source.issue.link, pubDate: source.issue.pubDate },
    previousDeliveredVol,
    payload: { zh_cn: { content: [] } },
    validation: { ok: false, errors: [error] },
    preview: renderPreview(source.issue),
    idempotencyKey: `wisereads-vol-${source.issue.vol}`,
    sentLogKey: `vol-${source.issue.vol}`,
    metadata: { sent: false, liveSendGate: env.WISEREADS_WEEKLY_ENABLED === "true" ? "open" : "closed" }
  };
}

async function getEnrichedIssue({ dataDir, issue, analyzer }) {
  const cacheFile = dataDir
    ? path.join(dataDir, "outputs", "automations", WISEREADS_JOB_ID, "generated", `wisereads-vol-${issue.vol}-enriched.json`)
    : null;
  if (cacheFile && existsSync(cacheFile)) {
    try {
      const cached = JSON.parse(await readFile(cacheFile, "utf8"));
      validateEnrichedIssue(cached);
      return { ok: true, issue: cached, cached: true, model: cached.analysisModel || null };
    } catch {
      // Regenerate a corrupt or obsolete cache instead of trusting it.
    }
  }
  if (!analyzer) {
    return { ok: false, error: "OPENROUTER_API_KEY and WISEREADS_ANALYSIS_MODEL (or FUND_ANALYSIS_MODEL) are required" };
  }
  try {
    const enriched = await analyzer(issue);
    validateEnrichedIssue(enriched);
    if (cacheFile) {
      await mkdir(path.dirname(cacheFile), { recursive: true });
      await writeFile(cacheFile, JSON.stringify(enriched, null, 2), "utf8");
    }
    return { ok: true, issue: enriched, cached: false, model: enriched.analysisModel || null };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

function buildWisereadsAnalysisPrompt(issue) {
  const entries = issue.items.map((item, index) => ({
    index,
    title: item.title,
    author: item.author,
    section: item.section,
    paragraphs: item.paragraphs
  }));
  return `你是 Kane 的 Wisereads 中文编辑。请把每条英文条目提炼为适合飞书周刊的中文摘要与中文引文。\n\n要求：\n- 只依据给定内容，不补充外部事实，不编造。\n- summary 用 1 句自然中文说明作者、主题与核心价值，约 35-75 个汉字。\n- quote 忠实翻译最有代表性的一句或一小段，约 25-90 个汉字。\n- 保留全部 ${entries.length} 条，index 和 title 必须原样对应。\n- 输出严格 JSON 对象：{\"items\":[{\"index\":0,\"title\":\"...\",\"summary\":\"...\",\"quote\":\"...\"}]}，不要 Markdown。\n\n期刊：Wisereads Vol. ${issue.vol}\n条目：${JSON.stringify(entries)}`;
}

function applyWisereadsAnalysis(issue, analysis) {
  if (!Array.isArray(analysis?.items) || analysis.items.length !== issue.items.length) {
    throw new Error("Wisereads analysis item count mismatch");
  }
  const byIndex = new Map(analysis.items.map((item) => [item.index, item]));
  const items = issue.items.map((item, index) => {
    const analyzed = byIndex.get(index);
    if (!analyzed || analyzed.title !== item.title) throw new Error(`Wisereads analysis title mismatch at item ${index}`);
    return { ...item, summaryZh: cleanSentence(analyzed.summary), quoteZh: cleanSentence(analyzed.quote) };
  });
  return { ...issue, items };
}

function validateEnrichedIssue(issue) {
  for (const [index, item] of issue.items.entries()) {
    if (!hasCjk(item.summaryZh) || !hasCjk(item.quoteZh)) {
      throw new Error(`Wisereads item ${index} is missing Chinese summary or quote`);
    }
  }
}

function parseJsonObject(text) {
  const cleaned = String(text).trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  return JSON.parse(cleaned);
}

async function persistGeneratedArtifact({ dataDir, issue, payload, validation }) {
  if (!dataDir) return null;
  const dir = path.join(dataDir, "outputs", "automations", WISEREADS_JOB_ID, "generated");
  await mkdir(dir, { recursive: true });
  const postJson = path.join(dir, `wisereads-vol-${issue.vol}-post.json`);
  const sourceJson = path.join(dir, `wisereads-vol-${issue.vol}-source.json`);
  await writeFile(postJson, JSON.stringify(payload, null, 2), "utf8");
  await writeFile(sourceJson, JSON.stringify({ issue, validation }, null, 2), "utf8");
  return { postJson, sourceJson };
}

async function fetchText({ url, fetchImpl }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  let response;
  try {
    response = await fetchImpl(url, {
      headers: { "user-agent": "KaneWisereadsAutomation/1.0" },
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) throw new Error(`RSS fetch failed: ${response.status}`);
  return response.text();
}

function groupItems(items) {
  const grouped = { [GROUPS.article]: [], [GROUPS.social]: [], [GROUPS.long]: [] };
  for (const item of items) {
    grouped[groupForEntry(item)].push(item);
  }
  return grouped;
}

function groupForEntry(entry) {
  if (/Article/i.test(entry.section)) return GROUPS.article;
  if (/YouTube|Twitter/i.test(entry.section)) return GROUPS.social;
  return GROUPS.long;
}

function iconForEntry(entry) {
  if (/YouTube/i.test(entry.section)) return "🎥";
  if (/Twitter/i.test(entry.section)) return "🏗️";
  if (/PDF/i.test(entry.section)) return "📊";
  if (/book/i.test(entry.section)) return "📘";
  if (/RSS/i.test(entry.section)) return "📡";
  if (/AI|Reading|Arguing|think/i.test(entry.title)) return "🧠";
  return "🧩";
}

function metadataForEntry(entry) {
  const author = entry.author || authorFromRssTitle(entry);
  if (/YouTube/i.test(entry.section)) return `${author} · YouTube 视频`;
  if (/Twitter/i.test(entry.section)) return `${author} · 推特`;
  if (/PDF/i.test(entry.section)) return `${author} · PDF`;
  if (/book/i.test(entry.section)) return `${author} · 书籍试读`;
  if (/RSS/i.test(entry.section)) return `${author} · RSS`;
  return author;
}

function authorFromRssTitle(entry) {
  if (entry.title === "Small Potatoes") return "Paul Bloom";
  return "Readwise";
}

function summaryForEntry(entry) {
  return cleanSentence(entry.summaryZh || "");
}

function quoteForEntry(entry) {
  return cleanSentence(entry.quoteZh || "");
}

function cleanSentence(text) {
  return htmlToText(text).replace(/\s+/g, " ").trim();
}

function renderPreview(issue) {
  return `Wisereads Vol. ${issue.vol}\n${issue.title}\n${issue.link}`;
}

function validateIssue(issue) {
  const errors = [];
  if (!Number.isInteger(issue.vol)) errors.push("missing issue vol");
  if (!issue.title) errors.push("missing title");
  if (!issue.link) errors.push("missing link");
  if (!issue.pubDate) errors.push("missing pubDate");
  if (!issue.issueDate) errors.push("missing issueDate");
  if (!Array.isArray(issue.items) || issue.items.length < 6) errors.push("expected at least six content items");
  return { ok: errors.length === 0, errors };
}

function shanghaiDateFromPubDate(pubDate) {
  const date = new Date(pubDate);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(date);
}

function firstMatch(text, regex) {
  return (text.match(regex) || [])[1] || "";
}

function stripCdata(text) {
  return text.replace(/^<!\[CDATA\[/, "").replace(/\]\]>$/, "");
}

function htmlToText(html) {
  return decodeXml(String(html)
    .replace(/<a\b[^>]*>([\s\S]*?)<\/a>/gi, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim());
}

function decodeXml(text) {
  return String(text)
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#x27;", "'")
    .replaceAll("&rsquo;", "’")
    .replaceAll("&lsquo;", "‘")
    .replaceAll("&rdquo;", "”")
    .replaceAll("&ldquo;", "“")
    .replaceAll("&mdash;", "—")
    .replaceAll("&ndash;", "–")
    .replaceAll("&nbsp;", " ");
}

function hasCjk(text) {
  return /[\u3400-\u9fff]/.test(String(text));
}
