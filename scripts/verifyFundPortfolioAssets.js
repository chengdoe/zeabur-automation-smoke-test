import { getFundPortfolioAssetStatus } from "../src/jobs/fundPortfolioDaily.js";
import { buildFundPortfolioDailyDryRun } from "../src/jobs/fundPortfolioDaily.js";

async function main() {
  const date = process.argv[2] || process.env.FUND_PORTFOLIO_VERIFY_DATE;
  const status = await getFundPortfolioAssetStatus({ date });
  const dryRun = await buildFundPortfolioDailyDryRun({ date });
  const result = {
    ok: status.ready && dryRun.validation.ok,
    status,
    dryRun: {
      ok: dryRun.ok,
      date: dryRun.date,
      sent: false,
      validation: dryRun.validation,
      sourceFile: dryRun.payload?.sourceFile || null
    }
  };

  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
