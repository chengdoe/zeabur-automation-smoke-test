#!/usr/bin/env node

import path from "node:path";

import { runDryRunJob } from "../src/dryRunRunner.js";
import { getFundPortfolioAssetStatus } from "../src/jobs/fundPortfolioDaily.js";

const dataDir = path.resolve(process.env.DATA_DIR || "data");
const morningDate = process.argv[2] || todayShanghai();
const sopDate = process.argv[3] || morningDate;
const fundDate = process.argv[4] || "2026-07-08";

async function main() {
  const fundStatus = await getFundPortfolioAssetStatus({ date: fundDate, dataDir });
  const jobs = [
    ["morning-motivation", morningDate],
    ["sop13", sopDate],
    ["fund-portfolio-daily", fundDate]
  ];
  const dryRuns = [];

  for (const [job, date] of jobs) {
    const result = await runDryRunJob({ job, date, dataDir });
    dryRuns.push({
      job,
      date,
      ok: result.ok,
      dryRun: result.dryRun,
      sent: result.sent,
      msgType: result.msgType,
      validation: result.validation,
      outputFiles: result.files,
      selectedContent: result.selectedContent || null,
      selectedSop: result.selectedSop || null
    });
  }

  const checks = [
    fundStatus.ready,
    ...dryRuns.map((run) => run.ok && run.dryRun === true && run.sent === false && run.validation.ok === true)
  ];
  const body = {
    ok: checks.every(Boolean),
    dataDir,
    dates: {
      morning: morningDate,
      sop13: sopDate,
      fund: fundDate
    },
    liveSendEnabled: process.env.LIVE_SEND_ENABLED === "true",
    fundStatus,
    dryRuns
  };

  console.log(JSON.stringify(body, null, 2));
  if (!body.ok) {
    process.exitCode = 1;
  }
}

function todayShanghai() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date());
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
