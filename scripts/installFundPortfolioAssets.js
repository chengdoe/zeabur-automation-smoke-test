import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { getFundPortfolioAssetStatus } from "../src/jobs/fundPortfolioDaily.js";

const execFileAsync = promisify(execFile);

async function main() {
  const archive = path.resolve(process.argv[2] || process.env.FUND_PORTFOLIO_EXPORT_TAR || "");
  if (!archive || archive === process.cwd()) {
    throw new Error("Usage: node scripts/installFundPortfolioAssets.js <fund-export.tar>");
  }
  if (!existsSync(archive)) {
    throw new Error(`Fund export archive not found: ${archive}`);
  }

  const dataDir = path.resolve(process.env.DATA_DIR || "data");
  const assetRoot = path.resolve(process.env.FUND_PORTFOLIO_ASSET_ROOT || path.join(dataDir, "fund-portfolio-daily"));
  await mkdir(assetRoot, { recursive: true });

  await execFileAsync("tar", ["-xf", archive, "-C", assetRoot]);
  const status = await getFundPortfolioAssetStatus({ assetRoot });

  console.log(JSON.stringify({
    ok: status.ready,
    archive,
    assetRoot,
    status
  }, null, 2));

  if (!status.ready) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
