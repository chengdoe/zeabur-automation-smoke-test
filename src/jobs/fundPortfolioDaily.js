import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

import { shanghaiDateString } from "../date.js";

export async function buildFundPortfolioDailyDryRun(options = {}) {
  const date = options.date || shanghaiDateString();
  const reportsDir = resolveReportsDir(options);
  const report = await loadReport({ reportsDir, date });
  const validation = validateFundReport(report);
  const assetStatus = await getFundPortfolioAssetStatus(options);

  return {
    ok: validation.ok,
    job: "fundPortfolioDaily",
    dryRun: true,
    msgType: "markdown",
    date,
    payload: report ? {
      sourceFile: report.file,
      markdown: report.markdown
    } : null,
    preview: report?.markdown || "",
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
  const payload = report ? buildFundPortfolioPostPayload({ date, markdown: report.markdown }) : null;
  const validation = validateFundPortfolioPost(payload, reportValidation);
  const assetStatus = await getFundPortfolioAssetStatus(options);

  return {
    ok: validation.ok,
    job: "fundPortfolioDaily",
    dryRun: false,
    msgType: "post",
    date,
    payload,
    preview: report?.markdown || "",
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

export function buildFundPortfolioPostPayload({ date, markdown }) {
  return {
    zh_cn: {
      title: "",
      content: [
        [
          { tag: "text", text: `【基金持仓日报 · ${date}】 `, style: ["bold"] },
          { tag: "at", user_id: "all" }
        ],
        [{ tag: "text", text: "　" }],
        ...chunkMarkdown(markdown).map((text) => [{ tag: "md", text }])
      ]
    }
  };
}

export function validateFundPortfolioPost(payload, reportValidation = { ok: true, errors: [] }) {
  const errors = [...(reportValidation.errors || [])];
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
  if (!content.some((row) => row?.[0]?.tag === "md" && row[0].text?.includes("今日结论"))) {
    errors.push("post markdown must include the fund report content");
  }

  return { ok: errors.length === 0, errors };
}

function chunkMarkdown(markdown, maxLength = 1800) {
  const chunks = [];
  let remaining = String(markdown || "").trim();

  while (remaining.length > maxLength) {
    let splitAt = remaining.lastIndexOf("\n\n", maxLength);
    if (splitAt < maxLength * 0.5) {
      splitAt = remaining.lastIndexOf("\n", maxLength);
    }
    if (splitAt < maxLength * 0.5) {
      splitAt = maxLength;
    }
    chunks.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).trim();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
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
