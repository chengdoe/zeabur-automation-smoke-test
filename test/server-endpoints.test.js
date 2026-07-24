import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

const port = 38_000 + Math.floor(Math.random() * 1000);
const baseUrl = `http://127.0.0.1:${port}`;
const fundReadPort = port + 1000;
const fundReadBaseUrl = `http://127.0.0.1:${fundReadPort}`;
let child;
let dataDir;

before(async () => {
  dataDir = await mkdtemp(path.join(os.tmpdir(), "zeabur-server-"));
  const fundReadRoot = path.join(dataDir, "fund-read-root");
  const reportsDir = path.join(fundReadRoot, "outputs", "reports", "markdown");
  await mkdir(reportsDir, { recursive: true });
  await copyFile(
    path.resolve(import.meta.dirname, "fixtures", "fund-daily-2026-07-15.md"),
    path.join(reportsDir, "fund-daily-2026-07-15.md")
  );
  child = spawn(process.execPath, ["src/server.js"], {
    cwd: path.resolve(import.meta.dirname, ".."),
    env: {
      ...process.env,
      PORT: String(port),
      DATA_DIR: dataDir,
      HEARTBEAT_INTERVAL_MS: "600000",
      FUND_READ_PORT: String(fundReadPort),
      FUND_READ_API_CREDENTIAL: "test-readonly-credential",
      FUND_READ_DATA_ROOT: fundReadRoot
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  await waitForHealth();
});

after(() => {
  child?.kill();
});

test("GET /api/jobs lists dry-run jobs", async () => {
  const response = await fetch(`${baseUrl}/api/jobs`);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.deepEqual(body.jobs.map((job) => job.id), ["ai-hot", "morning-motivation", "sop13", "fund-portfolio-daily", "wisereads-weekly"]);
});

test("GET /api/status reports the dry-run scheduler state", async () => {
  const response = await fetch(`${baseUrl}/api/status`);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.scheduler.enabled, true);
  assert.equal(body.scheduler.mode, "dry-run");
  assert.equal(body.scheduler.intervalMs, 60000);
  assert.equal(body.env.liveSendEnabled, false);
  assert.equal(body.env.fundPortfolioEnabled, false);
  assert.equal(body.env.wisereadsWeeklyEnabled, false);
  assert.equal(body.env.wisereadsSchedulerEnabled, false);
  assert.equal(body.env.hasFundDataKey, false);
  assert.equal(body.env.hasFundAnalysisKey, false);
  assert.equal(body.env.hasFundAnalysisModel, false);
  assert.equal(body.env.fundAnalysisProvider, "openai");
  assert.equal(body.env.hasOpenRouterApiKey, false);
  assert.equal(body.jobIdentity["morning-motivation"].configured, false);
  assert.ok(body.jobIdentity["morning-motivation"].missing.includes("bot_role"));
  assert.equal(body.jobIdentity.sop13.hasAppSecret, false);
  assert.equal(body.jobIdentity["wisereads-weekly"].configured, false);
  assert.ok(body.jobIdentity["wisereads-weekly"].missing.includes("bot_role"));
  assert.deepEqual(body.fundPortfolioReliability.retrySlots, ["13:50", "14:00", "14:10", "14:20"]);
  assert.equal(body.fundPortfolioReliability.mostRecentAttempt, null);
  assert.equal(body.fundModelCostGovernance.thresholds.maxDailyRequests, 2);
  assert.equal(body.fundModelCostGovernance.alerting.feishuEnabled, false);
  assert.equal(body.fundModelCostGovernance.circuitBreaker.open, false);
  assert.ok(allLeavesAreBoolean(body.fundPortfolioAudit));
});

test("POST /api/jobs/sop13/dry-run returns rich post payload without sending", async () => {
  const response = await fetch(`${baseUrl}/api/jobs/sop13/dry-run?date=2026-07-03`, {
    method: "POST"
  });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.sent, false);
  assert.equal(body.msgType, "post");
  assert.equal(body.payload.zh_cn.title, "");
  assert.equal(body.payload.zh_cn.content[0][1].user_id, "all");
});

test("POST /api/jobs/morning-motivation/dry-run returns rich post without sending", async () => {
  const response = await fetch(`${baseUrl}/api/jobs/morning-motivation/dry-run?date=2026-07-03`, {
    method: "POST"
  });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.sent, false);
  assert.equal(body.msgType, "post");
  assert.deepEqual(body.payload.zh_cn.content[0], [
    { tag: "text", text: "【晨间激励 · 2026-07-03】", style: ["bold"] }
  ]);
  assert.deepEqual(body.payload.zh_cn.content[4][1], { tag: "at", user_id: "all" });
});

test("POST /api/jobs/fund-portfolio-daily/dry-run is safe when fund assets are missing", async () => {
  const response = await fetch(`${baseUrl}/api/jobs/fund-portfolio-daily/dry-run?date=2026-07-08`, {
    method: "POST"
  });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.ok, false);
  assert.equal(body.sent, false);
  assert.equal(body.msgType, "post");
  assert.match(body.validation.errors.join("\n"), /no fund report markdown found/);
});

test("GET /api/jobs/fund-portfolio-daily/status reports missing assets without side effects", async () => {
  const response = await fetch(`${baseUrl}/api/jobs/fund-portfolio-daily/status?date=2026-07-08`);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.job, "fund-portfolio-daily");
  assert.equal(body.status.ready, false);
  assert.equal(body.status.latestReport, null);
  assert.ok(body.status.requiredFiles.some((file) => file.exists === false));
});

test("GET /api/jobs/fund-portfolio-daily/cost-governance exposes safe budget and alert state", async () => {
  const response = await fetch(`${baseUrl}/api/jobs/fund-portfolio-daily/cost-governance?date=2026-07-15`);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.date, "2026-07-15");
  assert.equal(body.thresholds.maxDailyRequests, 2);
  assert.equal(body.alerting.feishuEnabled, false);
  assert.equal(body.alerting.feishuTargetConfigured, false);
  assert.equal(body.usage.requests, 0);
  assert.equal(body.circuitBreaker.open, false);
  assert.doesNotMatch(JSON.stringify(body), /secret|Bearer|OPENROUTER_API_KEY|OPENAI_API_KEY/i);
});

test("fund read API denies missing credentials and non-GET methods", async () => {
  const unauthorized = await fetch(`${fundReadBaseUrl}/api/readonly/fund/brief?as_of=2026-07-15`);
  assert.equal(unauthorized.status, 401);
  assert.equal((await unauthorized.json()).ok, false);

  const wrongMethod = await fetch(`${fundReadBaseUrl}/api/readonly/fund/brief?as_of=2026-07-15`, {
    method: "POST",
    headers: { authorization: "Bearer test-readonly-credential" }
  });
  assert.equal(wrongMethod.status, 405);
});

test("fund read API returns only the reviewed brief projection", async () => {
  const response = await fetch(`${fundReadBaseUrl}/api/readonly/fund/brief?as_of=2026-07-15`, {
    headers: { authorization: "Bearer test-readonly-credential" }
  });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.as_of, "2026-07-15");
  assert.deepEqual(Object.keys(body.brief).sort(), [
    "confirmations",
    "data_quality",
    "portfolio_snapshot",
    "stance",
    "summary",
    "triggers"
  ]);
  assert.equal(body.brief.confirmations.length, 2);
  assert.equal("full_report_file" in body.brief, false);
  assert.equal("sent" in body.brief, false);
});

test("fund read API serves only approved bounded report sections", async () => {
  const headers = { authorization: "Bearer test-readonly-credential" };
  const accepted = await fetch(
    `${fundReadBaseUrl}/api/readonly/fund/report-section?as_of=2026-07-15&section=${encodeURIComponent("风险关注")}`,
    { headers }
  );
  const acceptedBody = await accepted.json();
  assert.equal(accepted.status, 200);
  assert.equal(acceptedBody.ok, true);
  assert.equal(acceptedBody.section, "风险关注");
  assert.ok(Array.from(acceptedBody.content).length <= 1200);

  const rejected = await fetch(
    `${fundReadBaseUrl}/api/readonly/fund/report-section?as_of=2026-07-15&section=${encodeURIComponent("../../etc/passwd")}`,
    { headers }
  );
  assert.equal(rejected.status, 400);

  const unrelated = await fetch(`${fundReadBaseUrl}/api/status`, { headers });
  assert.equal(unrelated.status, 404);
});

test("POST /api/jobs/sop13/send is blocked by default", async () => {
  const response = await fetch(`${baseUrl}/api/jobs/sop13/send?date=2026-07-03&confirm=SEND`, {
    method: "POST"
  });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.sent, false);
  assert.equal(body.sendSkippedReason, "live send disabled");
});

test("POST /api/jobs/fund-portfolio-daily/send is blocked by default", async () => {
  const response = await fetch(`${baseUrl}/api/jobs/fund-portfolio-daily/send?date=2026-07-08&confirm=SEND`, {
    method: "POST"
  });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.sent, false);
  assert.equal(body.sendSkippedReason, "live send disabled");
});

test("POST /api/jobs/wisereads-weekly/send is blocked by default", async () => {
  const response = await fetch(`${baseUrl}/api/jobs/wisereads-weekly/send?date=2026-07-13&confirm=SEND`, {
    method: "POST"
  });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.sent, false);
  assert.equal(body.sendSkippedReason, "live send disabled");
});

async function waitForHealth() {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      const fundResponse = await fetch(`${fundReadBaseUrl}/api/readonly/fund/brief?as_of=2026-07-15`);
      if (response.ok && fundResponse.status === 401) return;
    } catch {
      // Keep waiting until the service is listening.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("server did not become healthy");
}

function allLeavesAreBoolean(value) {
  if (typeof value === "boolean") return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.values(value).every(allLeavesAreBoolean);
}
