import { execFile } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { shanghaiDateString } from "../date.js";
import { validateFundReport } from "./fundPortfolioDaily.js";

const execFileAsync = promisify(execFile);

export async function runFundPortfolioPipeline({
  date,
  dataDir,
  analyzer,
  commandRunner = execFileAsync
}) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || "")) {
    throw new Error(`Invalid fund pipeline date: ${date}`);
  }
  if (typeof analyzer !== "function") {
    throw new Error("Fund pipeline analyzer is required");
  }

  const assetRoot = path.resolve(dataDir, "fund-portfolio-daily");
  const skillRoot = path.join(assetRoot, "skill");
  const projectRoot = path.join(assetRoot, "project");
  const outputsRoot = path.join(projectRoot, "outputs");
  const configDir = path.join(skillRoot, "config");
  const rawFile = path.join(outputsRoot, "reports", "raw-data", `fund-daily-raw-${date}.json`);
  const reportDir = path.join(outputsRoot, "reports", "markdown");
  const reportFile = path.join(reportDir, `fund-daily-${date}.md`);
  const tempReportFile = `${reportFile}.tmp`;
  const environment = {
    ...process.env,
    FUND_RUN_DATE: date,
    FUND_ASSET_ROOT: assetRoot,
    FUND_SKILL_ROOT: skillRoot,
    FUND_PROJECT_ROOT: projectRoot,
    FUND_OUTPUTS_ROOT: outputsRoot
  };

  await mkdir(reportDir, { recursive: true });
  await commandRunner("python3", [
    path.join(skillRoot, "scripts", "data_fetch_only.py"),
    outputsRoot,
    "--force"
  ], { env: environment });
  await commandRunner("python3", [
    path.join(skillRoot, "scripts", "v7", "portfolio_state_tracker.py")
  ], { env: environment });
  await commandRunner("python3", [
    path.join(skillRoot, "scripts", "v8", "v8_orchestrator.py"),
    "--raw-data",
    rawFile
  ], { env: environment });

  const [rawData, portfolioState, portfolio, basketConfig, scoringConfig] = await Promise.all([
    readJson(rawFile),
    readJson(path.join(configDir, "portfolio_state.json")),
    readJson(path.join(configDir, "portfolio.json")),
    readJson(path.join(configDir, "basket_config.json")),
    readJson(path.join(configDir, "scoring_config.json"))
  ]);
  if (rawData.date !== date) {
    throw new Error(`Fund raw data date mismatch: expected ${date}, got ${rawData.date || "missing"}`);
  }

  const markdown = await analyzer({
    date,
    rawData,
    portfolioState,
    portfolio,
    basketConfig,
    scoringConfig
  });
  const validation = validateFundReport({ file: reportFile, markdown }, {
    isReplay: date < shanghaiDateString()
  });
  const preservedSections = [
    "今天怎么做",
    "今天系统帮你盯到的机会",
    "v8.0 机会层",
    "市场情况",
    "精简市场总结",
    "持仓今天表现",
    "为什么今天这个结论",
    "方法论评分",
    "仓位分布",
    "催化剂提醒",
    "风险关注",
    "风险提示和下一步盯什么",
    "一句话心得"
  ];
  const missingSections = preservedSections.filter((section) => !markdown.includes(section));
  if (!validation.ok || missingSections.length > 0) {
    const errors = [
      ...validation.errors,
      ...missingSections.map((section) => `missing section: ${section}`)
    ];
    throw new Error(`Fund report validation failed: ${errors.join("; ")}`);
  }

  await writeFile(tempReportFile, markdown.trimEnd() + "\n", "utf8");
  await rename(tempReportFile, reportFile);

  return {
    ok: true,
    job: "fundPortfolioDaily",
    date,
    dryRun: true,
    sent: false,
    rawFile,
    reportFile,
    validation: {
      ok: true,
      errors: [],
      preservedSections
    }
  };
}

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}
