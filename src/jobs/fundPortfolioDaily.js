import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

import { shanghaiDateString } from "../date.js";

export async function buildFundPortfolioDailyDryRun(options = {}) {
  const date = options.date || shanghaiDateString();
  const reportsDir = resolveReportsDir(options);
  const report = await loadReport({ reportsDir, date });
  const reportValidation = validateFundReport(report);
  const feishuBrief = report ? extractFundPortfolioBrief({
    date,
    markdown: report.markdown,
    fullReportFile: report.file
  }) : null;
  const briefValidation = validateFundPortfolioBrief(feishuBrief);
  const payload = feishuBrief ? buildFundPortfolioPostPayload({ date, brief: feishuBrief }) : null;
  const validation = validateFundPortfolioPost(payload, reportValidation, briefValidation, feishuBrief);
  const assetStatus = await getFundPortfolioAssetStatus(options);

  return {
    ok: validation.ok,
    job: "fundPortfolioDaily",
    dryRun: true,
    msgType: "post",
    date,
    payload,
    preview: payload ? renderFundPortfolioPostText(payload) : "",
    feishuBrief,
    sourceFile: report?.file || null,
    assetStatus,
    validation
  };
}

export async function buildFundPortfolioDailyPost(options = {}) {
  const date = options.date || shanghaiDateString();
  const reportsDir = resolveReportsDir(options);
  const report = await loadReport({ reportsDir, date, allowFallback: false });
  const reportValidation = validateFundReport(report, {
    missingMessage: `exact-date fund report missing: ${date}`
  });
  const feishuBrief = report ? extractFundPortfolioBrief({
    date,
    markdown: report.markdown,
    fullReportFile: report.file
  }) : null;
  const briefValidation = validateFundPortfolioBrief(feishuBrief);
  const payload = feishuBrief ? buildFundPortfolioPostPayload({ date, brief: feishuBrief }) : null;
  const validation = validateFundPortfolioPost(payload, reportValidation, briefValidation, feishuBrief);
  const assetStatus = await getFundPortfolioAssetStatus(options);

  return {
    ok: validation.ok,
    job: "fundPortfolioDaily",
    dryRun: false,
    msgType: "post",
    date,
    payload,
    preview: payload ? renderFundPortfolioPostText(payload) : "",
    feishuBrief,
    assetStatus,
    sourceFile: report?.file || null,
    validation
  };
}

export async function getFundPortfolioAssetStatus(options = {}) {
  const root = resolveAssetRoot(options);
  const reportsDir = resolveReportsDir(options);
  const requiredFiles = [
    "skill/skill.md",
    "skill/scripts/data_fetch_only.py",
    "skill/scripts/v7/portfolio_state_tracker.py",
    "skill/scripts/v8/v8_orchestrator.py",
    "skill/config/portfolio.json",
    "skill/config/decision_history.json",
    "skill/config/portfolio_state.json",
    "project/outputs/portfolio/shared-context.md",
    "project/outputs/tracking/system-pending.md",
    "project/outputs/tracking/user-pending.md"
  ];
  const files = requiredFiles.map((relativePath) => ({
    path: relativePath,
    exists: existsSync(path.join(root, relativePath))
  }));
  const latestReport = await loadReport({
    reportsDir,
    date: options.date || shanghaiDateString()
  });

  return {
    root,
    reportsDir,
    ready: files.every((file) => file.exists) && Boolean(latestReport),
    requiredFiles: files,
    latestReport: latestReport?.file || null
  };
}

export function validateFundReport(report, options = {}) {
  const errors = [];
  if (!report) {
    errors.push(options.missingMessage || "no fund report markdown found");
    return { ok: false, errors };
  }

  const requiredSections = [
    "今日结论",
    "v8.0 机会层",
    "精简市场总结",
    "方法论评分",
    "风险关注"
  ];

  for (const section of requiredSections) {
    if (!report.markdown.includes(section)) {
      errors.push(`missing section: ${section}`);
    }
  }

  if (/必做确定性动作|必须买入|必须卖出/.test(report.markdown)) {
    errors.push("imperative trade language is forbidden");
  }
  if (options.isReplay && !report.markdown.includes("迁移回放预览，不发送，不执行交易")) {
    errors.push("migration replay warning is required");
  }

  return { ok: errors.length === 0, errors };
}

export function extractFundPortfolioBrief({ date, markdown, fullReportFile }) {
  const sections = splitReportSections(markdown);
  const conclusion = sectionLines(sections, "今日结论").join(" ");
  const actionLines = sectionLines(sections, "今天怎么做");
  const allocationLines = sectionLines(sections, "仓位分布");
  const qualityText = cleanText(sectionLines(sections, "数据可靠性").join(" "));
  const confirmations = actionLines
    .map(parseConfirmation)
    .filter(Boolean)
    .slice(0, 3);
  const triggers = allocationLines
    .map(cleanListLine)
    .filter((line) => /高于|超配|剩余\s*\d+\s*次/.test(line))
    .map(removeInternalTerms)
    .filter(Boolean)
    .slice(0, 3);
  const fullText = cleanText(markdown);
  const summary = buildSummary(conclusion);
  const stance = determineStance({ summary, confirmations, qualityText });
  const totalMatch = fullText.match(/(?:旧快照)?总额\s*(约?\s*[\d,，.]+\s*元)/);
  const asOfMatch = fullText.match(/(?:持仓基准日|快照(?:日期|日)|截至)\s*(?:为|：|:)??\s*(\d{4}-\d{2}-\d{2})/);
  const changeMatch = /不给出(?:组合)?精确涨跌|实时估值覆盖不完整/.test(fullText)
    ? null
    : fullText.match(/(?:组合|持仓)(?:今日)?(?:估算|预计|实时)?(?:涨跌|变动)\s*(?:为|：|:)?\s*([+-]?[\d.]+%|[+-]?[\d,.]+\s*元)/)?.[1] || null;
  const deviation = allocationLines.map(cleanListLine).find((line) => /QDII.*(?:高于|超配)/i.test(line))
    || allocationLines.map(cleanListLine).find((line) => /高于|超配/.test(line))
    || null;
  const quotaLine = allocationLines.map(cleanListLine).find((line) => /剩余\s*\d+\s*次/.test(line));
  const quality = buildDataQuality(qualityText, fullText);

  return {
    stance,
    summary,
    confirmations,
    triggers,
    portfolio_snapshot: {
      estimated_total: totalMatch?.[1]?.replace(/\s+/g, " ") || null,
      as_of: asOfMatch?.[1] || null,
      estimated_change: changeMatch,
      largest_deviation: deviation ? trimText(removeInternalTerms(deviation), 120).replace(/[。；;]$/, "") : null,
      weekly_quota: quotaLine?.match(/剩余\s*\d+\s*次/)?.[0].replace(/\s+/g, " ") || null
    },
    data_quality: quality,
    full_report_file: String(fullReportFile || ""),
    sent: false
  };
}

export function validateFundPortfolioBrief(brief) {
  const errors = [];
  if (!brief || typeof brief !== "object") {
    return { ok: false, errors: ["feishu_brief is required"] };
  }
  if (!new Set(["watch", "confirm", "risk", "insufficient_data"]).has(brief.stance)) {
    errors.push("feishu_brief.stance is invalid");
  }
  if (!String(brief.summary || "").trim()) errors.push("feishu_brief.summary is required");
  if (Array.from(String(brief.summary || "")).length > 70) errors.push("feishu_brief.summary exceeds 70 characters");
  if (!Array.isArray(brief.confirmations)) errors.push("feishu_brief.confirmations must be an array");
  if ((brief.confirmations?.length || 0) > 3) errors.push("feishu_brief.confirmations exceeds 3 items");
  if (brief.stance === "confirm" && !brief.confirmations?.length) errors.push("confirm stance requires a confirmation item");
  for (const [index, item] of (brief.confirmations || []).entries()) {
    for (const field of ["fund_code", "fund_name", "action", "reason"]) {
      if (typeof item?.[field] !== "string" || (field !== "fund_code" && !item[field].trim())) {
        errors.push(`feishu_brief.confirmations[${index}].${field} is required`);
      }
    }
    if (!(item?.amount_or_range === null || typeof item?.amount_or_range === "string")) {
      errors.push(`feishu_brief.confirmations[${index}].amount_or_range must be string|null`);
    }
  }
  if (!Array.isArray(brief.triggers)) errors.push("feishu_brief.triggers must be an array");
  if ((brief.triggers?.length || 0) > 3) errors.push("feishu_brief.triggers exceeds 3 items");
  if (!brief.portfolio_snapshot || typeof brief.portfolio_snapshot !== "object") {
    errors.push("feishu_brief.portfolio_snapshot is required");
  }
  if (!brief.data_quality || !new Set(["high", "medium", "low"]).has(brief.data_quality.level)) {
    errors.push("feishu_brief.data_quality.level is invalid");
  }
  if (!String(brief.data_quality?.note || "").trim()) errors.push("feishu_brief.data_quality.note is required");
  if (!String(brief.full_report_file || "").trim()) errors.push("feishu_brief.full_report_file is required");
  if (brief.sent !== false) errors.push("feishu_brief.sent must remain false");
  if (/\bv(?:7|8)(?:\.0)?\b|score|decision_level|机会层|状态机/iu.test(JSON.stringify({
    summary: brief.summary,
    confirmations: brief.confirmations,
    triggers: brief.triggers,
    data_quality: brief.data_quality
  }))) errors.push("feishu_brief contains internal implementation jargon");
  return { ok: errors.length === 0, errors };
}

export function buildFundPortfolioPostPayload({ date, brief }) {
  const labels = {
    watch: "观望",
    confirm: "待确认",
    risk: "有风险触发",
    insufficient_data: "数据不足"
  };
  const confirmations = brief.confirmations.length
    ? brief.confirmations.map((item, index) => [{
      tag: "md",
      text: `${index + 1}. **待确认**｜${formatConfirmation(item)}`
    }])
    : [[{ tag: "text", text: "今天没有需要确认的动作。" }]];
  const triggers = brief.triggers.length
    ? brief.triggers.map((item) => [{ tag: "text", text: `• ${trimText(item, 120)}` }])
    : [[{ tag: "text", text: "今天没有新增规则触发。" }]];
  const snapshot = formatSnapshot(brief.portfolio_snapshot, brief.triggers, date);

  return {
    zh_cn: {
      title: "",
      content: [
        [
          { tag: "text", text: `【基金持仓日报 · ${date}】 `, style: ["bold"] },
          { tag: "at", user_id: "all" }
        ],
        [{ tag: "text", text: "　" }],
        sectionTitle("今日判断"),
        [{ tag: "text", text: `${labels[brief.stance]}：${trimText(brief.summary, 70)}` }],
        sectionTitle("需要你确认"),
        ...confirmations,
        sectionTitle("今日触发"),
        ...triggers,
        sectionTitle("组合概览"),
        ...snapshot.map((text) => [{ tag: "text", text: `• ${text}` }]),
        sectionTitle("数据可靠性"),
        [{ tag: "text", text: `${qualityLabel(brief.data_quality.level)}：${trimText(brief.data_quality.note, 120)}` }],
        [{ tag: "text", text: "　" }],
        [{ tag: "text", text: "完整报告已归档，所有建议均未执行。" }]
      ]
    }
  };
}

export function validateFundPortfolioPost(
  payload,
  reportValidation = { ok: true, errors: [] },
  briefValidation = { ok: true, errors: [] },
  brief = null
) {
  const errors = [...(reportValidation.errors || []), ...(briefValidation.errors || [])];
  const zhCn = payload?.zh_cn;
  const content = zhCn?.content;

  if (!payload) {
    errors.push("fund post payload is missing");
    return { ok: false, errors };
  }
  if (!zhCn || typeof zhCn !== "object") {
    errors.push("payload.zh_cn is required");
    return { ok: false, errors };
  }
  if (zhCn.title !== "" && zhCn.title !== " ") {
    errors.push("outer title must be empty or a single space");
  }
  if (!Array.isArray(content)) {
    errors.push("content must be an array of rows");
    return { ok: false, errors };
  }

  const row0 = content[0] || [];
  if (!row0.some((item) => item?.tag === "text" && item.text?.startsWith("【基金持仓日报 · ") && item.style?.includes("bold"))) {
    errors.push("row 0 must contain the bold visible title");
  }
  if (!row0.some((item) => item?.tag === "at" && item.user_id === "all")) {
    errors.push("row 0 must contain @all");
  }
  const text = renderFundPortfolioPostText(payload);
  if (!text.includes("今日判断") || !text.includes("需要你确认")) errors.push("first screen must include 今日判断 and 需要你确认");
  if ((text.match(/【基金持仓日报/g) || []).length !== 1) errors.push("post must contain exactly one visible fund report title");
  if (Array.from(text).length > 1200) errors.push("fund post exceeds 1200 characters");
  if (/\bv(?:7|8)(?:\.0)?\b|score|decision_level|机会层|状态机/iu.test(text)) errors.push("fund post contains internal implementation jargon");
  if (/[/\\](?:data|Users|private|tmp)\//.test(text)) errors.push("fund post must not expose local or container paths");
  if (brief && brief.confirmations?.some((item) => /已执行|已完成/.test(`${item.action}${item.reason}`))) {
    errors.push("confirmation items must not be recorded as executed");
  }

  return { ok: errors.length === 0, errors };
}

function splitReportSections(markdown) {
  const sections = new Map();
  let current = "";
  for (const line of String(markdown || "").split("\n")) {
    const heading = line.match(/^##\s+(.+?)\s*$/)?.[1];
    if (heading) {
      current = cleanText(heading);
      sections.set(current, []);
    } else if (current) {
      sections.get(current).push(line);
    }
  }
  return sections;
}

function sectionLines(sections, name) {
  return (sections.get(name) || []).map((line) => line.trim()).filter(Boolean);
}

function cleanText(value) {
  return String(value || "")
    .replace(/<[^>]+>/g, "")
    .replace(/[`*_>#|]/g, "")
    .replace(/\[(.*?)\]\([^)]*\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanListLine(value) {
  return cleanText(value).replace(/^[-+•]\s*/, "").replace(/^\d+[.)、]\s*/, "").trim();
}

function removeInternalTerms(value) {
  return cleanText(value)
    .replace(/\bv(?:7|8)(?:\.0)?\b/giu, "")
    .replace(/\b(?:buy|sell)_score\s*=\s*[-\d.]+/giu, "")
    .replace(/\bdecision_level\s*=\s*[\w-]+/giu, "")
    .replace(/机会层|状态机/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function buildSummary(conclusion) {
  const cleaned = removeInternalTerms(conclusion)
    .replace(/(?:所有)?建议均?待确认，?未执行[。；;]?/g, "")
    .replace(/\bno_trade\b/gi, "保持观察")
    .trim();
  const sentence = cleaned.match(/^.{1,68}?[。！？；;]/)?.[0] || cleaned;
  return trimText(sentence.replace(/[。；;]$/, ""), 70) || "今天保持观察，不新增临时操作";
}

function determineStance({ summary, confirmations, qualityText }) {
  if (/^低|数据不足|无法判断/.test(qualityText)) return "insufficient_data";
  if (confirmations.length) return "confirm";
  if (/风险|触发|止损/.test(summary)) return "risk";
  return "watch";
}

function parseConfirmation(line) {
  const text = cleanListLine(line);
  const codeMatch = text.match(/\b(\d{6})\b/);
  if (!codeMatch) return null;
  const code = codeMatch[1];
  const afterCode = text.slice(codeMatch.index + code.length).trim();
  const [rawName, ...restParts] = afterCode.split(/[：:]/);
  const rest = restParts.join("：").trim();
  const actionBase = (rest.match(/待确认(?:是否)?([^；;。]+)/)?.[1] || rest.match(/(分批止盈|部分止盈|减仓|加仓|复核)/)?.[1] || "复核操作").trim();
  const action = actionBase.startsWith("是否") ? actionBase : `是否${actionBase}`;
  let reason = rest.split(/[；;]/).slice(1).join("；").trim() || "需要 Kane 确认后再处理";
  if (/快照|不是当天|较旧|缺失/.test(reason)) reason = "触发条件已出现，操作前先核对平台持仓";
  const amount = rest.match(/(?:约\s*)?[\d,.]+\s*元|\d+(?:\s*[-~至]\s*\d+)?%/)?.[0] || null;
  return {
    fund_code: code,
    fund_name: cleanText(rawName),
    action: trimText(action, 30),
    amount_or_range: amount,
    reason: trimText(reason.replace(/[。；;]$/, ""), 60)
  };
}

function buildDataQuality(qualityText, fullText) {
  const source = qualityText || (/缺失|不完整|不是当天|旧快照/.test(fullText)
    ? "中：部分数据缺失或不是当天数据；操作前请以平台为准。"
    : "高：关键数据完整，仍需以平台成交前信息为准。");
  const levelText = source.match(/^(高|中|低)\s*[：:]/)?.[1];
  const level = levelText === "高" ? "high" : levelText === "低" ? "low" : "medium";
  let note = source.replace(/^(高|中|低)\s*[：:]\s*/, "");
  note = note.replace(/宏观数据缺失，部分实时估值/g, "宏观、部分实时估值");
  return { level, note: trimText(note, 120) };
}

function formatConfirmation(item) {
  const identity = item.fund_code ? `${item.fund_code} ${item.fund_name}` : item.fund_name;
  const amount = item.amount_or_range ? `（${item.amount_or_range}）` : "";
  return trimText(`${identity}：${item.action}${amount}。${item.reason}。`, 120);
}

function formatSnapshot(snapshot, triggers = [], reportDate = null) {
  const lines = [];
  if (snapshot.estimated_total || snapshot.as_of) {
    const isOldSnapshot = Boolean(snapshot.as_of && reportDate && snapshot.as_of < reportDate);
    lines.push(isOldSnapshot
      ? `持仓旧快照${snapshot.estimated_total || "金额未提供"}（${snapshot.as_of}）`
      : `组合估算 ${snapshot.estimated_total || "未提供"}${snapshot.as_of ? `（基准日 ${snapshot.as_of}）` : ""}`);
  }
  lines.push(snapshot.estimated_change ? `今日估算变动 ${snapshot.estimated_change}` : "实时估值覆盖不足，暂不计算组合涨跌");
  const normalizedTriggers = triggers.map((item) => cleanText(item).replace(/[。；;]$/, ""));
  if (snapshot.largest_deviation && !normalizedTriggers.includes(cleanText(snapshot.largest_deviation).replace(/[。；;]$/, ""))) {
    lines.push(snapshot.largest_deviation);
  }
  if (snapshot.weekly_quota && !triggers.some((item) => item.includes(snapshot.weekly_quota))) {
    lines.push(`本周非豁免操作额度${snapshot.weekly_quota}`);
  }
  return lines.slice(0, 4).map((line) => trimText(line, 120));
}

function sectionTitle(text) {
  return [{ tag: "text", text, style: ["bold"] }];
}

function qualityLabel(level) {
  return level === "high" ? "高" : level === "low" ? "低" : "中";
}

function trimText(value, maxLength) {
  const chars = Array.from(cleanText(value));
  return chars.length <= maxLength ? chars.join("") : `${chars.slice(0, maxLength - 1).join("")}…`;
}

function renderFundPortfolioPostText(payload) {
  return (payload?.zh_cn?.content || [])
    .flat()
    .map((item) => item?.text || (item?.tag === "at" ? "@all" : ""))
    .filter(Boolean)
    .join("\n");
}

function resolveReportsDir(options) {
  if (options.reportsDir) return path.resolve(options.reportsDir);
  if (process.env.FUND_PORTFOLIO_REPORTS_DIR) {
    return path.resolve(process.env.FUND_PORTFOLIO_REPORTS_DIR);
  }
  return path.join(resolveAssetRoot(options), "project", "outputs", "reports", "markdown");
}

function resolveAssetRoot(options) {
  if (options.assetRoot) return path.resolve(options.assetRoot);
  if (process.env.FUND_PORTFOLIO_ASSET_ROOT) {
    return path.resolve(process.env.FUND_PORTFOLIO_ASSET_ROOT);
  }
  const dataDir = path.resolve(options.dataDir || process.env.DATA_DIR || "data");
  return path.join(dataDir, "fund-portfolio-daily");
}

async function loadReport({ reportsDir, date, allowFallback = true }) {
  const exactFile = path.join(reportsDir, `fund-daily-${date}.md`);
  if (existsSync(exactFile)) {
    return {
      file: exactFile,
      markdown: await readFile(exactFile, "utf8")
    };
  }

  if (!allowFallback) {
    return null;
  }

  if (!existsSync(reportsDir)) {
    return null;
  }

  const files = (await readdir(reportsDir))
    .filter((file) => /^fund-daily-\d{4}-\d{2}-\d{2}.*\.md$/.test(file))
    .sort();
  const latest = files.at(-1);
  if (!latest) return null;

  const latestFile = path.join(reportsDir, latest);
  return {
    file: latestFile,
    markdown: await readFile(latestFile, "utf8")
  };
}
