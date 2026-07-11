#!/usr/bin/env node

import path from "node:path";

import { shanghaiDateString } from "../src/date.js";
import { createFundPortfolioAnalyzer } from "../src/jobs/fundPortfolioAnalyzer.js";
import { runFundPortfolioPipeline } from "../src/jobs/fundPortfolioPipeline.js";

const date = process.argv[2] || shanghaiDateString();
const dataDir = path.resolve(process.env.DATA_DIR || "data");

runFundPortfolioPipeline({
  date,
  dataDir,
  analyzer: createFundPortfolioAnalyzer()
}).then((result) => {
  console.log(JSON.stringify(result, null, 2));
}).catch((error) => {
  console.error(error.message);
  process.exit(1);
});
