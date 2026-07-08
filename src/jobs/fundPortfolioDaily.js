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

export function validateFundReport(report) {
  const errors = [];
  if (!report) {
    errors.push("no fund report markdown found");
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

  return { ok: errors.length === 0, errors };
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

async function loadReport({ reportsDir, date }) {
  const exactFile = path.join(reportsDir, `fund-daily-${date}.md`);
  if (existsSync(exactFile)) {
    return {
      file: exactFile,
      markdown: await readFile(exactFile, "utf8")
    };
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
