import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { buildFundPortfolioDailyDryRun } from "./jobs/fundPortfolioDaily.js";
import { buildMorningMotivationDryRun } from "./jobs/morningMotivation.js";
import { buildSop13DryRun } from "./jobs/sop13.js";

const JOBS = {
  "morning-motivation": {
    key: "morningMotivation",
    folder: "morning-motivation",
    build: buildMorningMotivationDryRun
  },
  morningMotivation: {
    key: "morningMotivation",
    folder: "morning-motivation",
    build: buildMorningMotivationDryRun
  },
  sop13: {
    key: "sop13",
    folder: "sop13",
    build: buildSop13DryRun
  },
  "fund-portfolio-daily": {
    key: "fundPortfolioDaily",
    folder: "fund-portfolio-daily",
    build: buildFundPortfolioDailyDryRun
  }
};

export function listJobs() {
  return [
    {
      id: "morning-motivation",
      name: "晨间激励",
      schedule: "daily 09:00 Asia/Shanghai",
      dryRunEndpoint: "/api/jobs/morning-motivation/dry-run",
      liveSendEndpoint: "/api/jobs/morning-motivation/send"
    },
    {
      id: "sop13",
      name: "每日个人工作系统 SOP",
      schedule: "daily 09:30 Asia/Shanghai",
      dryRunEndpoint: "/api/jobs/sop13/dry-run",
      liveSendEndpoint: "/api/jobs/sop13/send"
    },
    {
      id: "fund-portfolio-daily",
      name: "基金持仓日报",
      schedule: "weekdays 13:50 Asia/Shanghai",
      dryRunEndpoint: "/api/jobs/fund-portfolio-daily/dry-run",
      liveSendEndpoint: null
    }
  ];
}

export async function runDryRunJob({ job, date, dataDir }) {
  const definition = JOBS[job];
  if (!definition) {
    throw new Error(`Unknown job: ${job}`);
  }

  const dryRun = await definition.build({ date, dataDir });
  const result = {
    ...dryRun,
    sent: false,
    sendSkippedReason: "dry-run only"
  };
  const outputDir = path.join(dataDir, "outputs", "automations", definition.folder);
  await mkdir(outputDir, { recursive: true });

  const jsonFile = path.join(outputDir, `${dryRun.date}-dry-run.json`);
  const markdownFile = path.join(outputDir, `${dryRun.date}-dry-run.md`);
  await writeFile(jsonFile, JSON.stringify(result, null, 2), "utf8");
  await writeFile(markdownFile, renderMarkdown(result), "utf8");

  return {
    ...result,
    files: {
      json: jsonFile,
      markdown: markdownFile
    }
  };
}

function renderMarkdown(result) {
  const lines = [
    `# ${result.job} Dry Run`,
    "",
    `- Date (Asia/Shanghai): ${result.date}`,
    `- Message type: ${result.msgType}`,
    `- Validation: ${result.validation.ok ? "passed" : "failed"}`,
    "- No Feishu message was sent."
  ];

  if (result.selectedSop) {
    lines.splice(2, 0, `- Selected SOP: ${result.selectedSop.name}`, `- Selected index: ${result.selectedSop.index} (Day ${result.selectedSop.dayNumber})`);
  }
  if (result.validation.errors.length) {
    lines.push("", "## Validation Errors", "", ...result.validation.errors.map((error) => `- ${error}`));
  }
  lines.push("", "## Payload", "", "```json", JSON.stringify(result.payload, null, 2), "```", "");
  return lines.join("\n");
}
