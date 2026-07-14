import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

const port = 38_000 + Math.floor(Math.random() * 1000);
const baseUrl = `http://127.0.0.1:${port}`;
let child;

before(async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "zeabur-server-"));
  child = spawn(process.execPath, ["src/server.js"], {
    cwd: path.resolve(import.meta.dirname, ".."),
    env: {
      ...process.env,
      PORT: String(port),
      DATA_DIR: dataDir,
      HEARTBEAT_INTERVAL_MS: "600000"
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
  assert.deepEqual(body.jobs.map((job) => job.id), ["morning-motivation", "sop13", "fund-portfolio-daily", "wisereads-weekly"]);
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
  assert.equal(body.msgType, "markdown");
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
      if (response.ok) return;
    } catch {
      // Keep waiting until the service is listening.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("server did not become healthy");
}
