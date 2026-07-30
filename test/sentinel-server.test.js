import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

const port = 40_000 + Math.floor(Math.random() * 1000);
const baseUrl = `http://127.0.0.1:${port}`;
let child;

before(async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "sentinel-server-"));
  child = spawn(process.execPath, ["src/sentinelServer.js"], {
    cwd: path.resolve(import.meta.dirname, ".."),
    env: {
      ...process.env,
      PORT: String(port),
      DATA_DIR: dataDir,
      SENTINEL_ENABLED: "true",
      SENTINEL_MODE: "shadow",
      SENTINEL_WATCHDOG_ENABLED: "false",
      AI_HOT_SCHEDULER_ENABLED: "true",
      FEISHU_CONNECTION_SENTINEL_APP_SECRET: "must-not-leak"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  await waitForHealth();
});

after(() => child?.kill());

test("standalone Sentinel server exposes a safe read-only status", async () => {
  const response = await fetch(`${baseUrl}/api/sentinel/status?date=2026-07-30`);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.service, "automation-sentinel");
  assert.equal(body.runtime.watchdogEnabled, false);
  assert.equal(body.modelCalls, 0);
  assert.doesNotMatch(JSON.stringify(body), /must-not-leak|APP_SECRET|authorization|Bearer/i);
});

test("watchdog dry-run detects a missed SLA without sending", async () => {
  const response = await fetch(
    `${baseUrl}/api/sentinel/watchdog/dry-run?now=${encodeURIComponent("2026-07-30T02:12:00.000Z")}`,
    { method: "POST" }
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.modelCalls, 0);
  assert.equal(body.delivery.sent.length, 0);
  assert.equal(body.delivery.blockedReason, "dry_run");
  assert.ok(body.scan.incidents.some((item) => item.job_id === "ai-hot"));
});

test("watchdog send endpoint requires an explicit request confirmation", async () => {
  const response = await fetch(`${baseUrl}/api/sentinel/watchdog/send`, { method: "POST" });
  assert.equal(response.status, 403);
  assert.equal((await response.json()).error, "explicit_confirmation_required");
});

async function waitForHealth() {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
    } catch {
      // Keep waiting until the standalone service is listening.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Sentinel server did not become healthy");
}
