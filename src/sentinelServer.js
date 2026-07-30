import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { getSentinelRuntimeConfig } from "./ops/sentinelPolicy.js";
import { getSentinelStatus, runSentinelWatchdogCycle } from "./ops/sentinelService.js";

const MIN_INTERVAL_MS = 60_000;
const MAX_INTERVAL_MS = 120_000;

export function createSentinelServer({
  env = process.env,
  dataDir = path.resolve(env.DATA_DIR || "data"),
  logger = console
} = {}) {
  const runtime = getSentinelRuntimeConfig(env);
  const intervalMs = boundedInterval(env.SENTINEL_WATCHDOG_INTERVAL_MS);
  let lastCycle = null;
  let timer = null;

  async function cycle({ send = runtime.alertSendEnabled, now = new Date() } = {}) {
    lastCycle = await runSentinelWatchdogCycle({ dataDir, now, env, send });
    return lastCycle;
  }

  const handler = async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`);
    try {
      if (url.pathname === "/health") {
        return sendJson(res, 200, {
          ok: true,
          service: "automation-sentinel",
          now: new Date().toISOString(),
          watchdogEnabled: runtime.watchdogEnabled,
          lastCycleAt: lastCycle?.checkedAt || null
        });
      }
      if (url.pathname === "/api/sentinel/status" && req.method === "GET") {
        const status = await getSentinelStatus({ dataDir, date: url.searchParams.get("date") || undefined, env });
        return sendJson(res, 200, {
          ...status,
          watchdog: {
            enabled: runtime.watchdogEnabled,
            intervalMs,
            lastCycleAt: lastCycle?.checkedAt || null
          }
        });
      }
      if (url.pathname === "/api/sentinel/watchdog/dry-run" && req.method === "POST") {
        return sendJson(res, 200, await cycle({ send: false, now: parseNow(url.searchParams.get("now")) }));
      }
      if (url.pathname === "/api/sentinel/watchdog/send" && req.method === "POST") {
        if (url.searchParams.get("confirm") !== "SEND") {
          return sendJson(res, 403, { ok: false, error: "explicit_confirmation_required" });
        }
        return sendJson(res, 200, await cycle({ send: true, now: parseNow(url.searchParams.get("now")) }));
      }
      return sendJson(res, 404, { ok: false, error: "not_found" });
    } catch (error) {
      logger.error?.("sentinel request failed", {
        error_class: error.code || "sentinel_request_failure",
        path: url.pathname
      });
      return sendJson(res, 500, { ok: false, error: error.code || "sentinel_request_failure" });
    }
  };

  return {
    runtime,
    intervalMs,
    handler,
    cycle,
    start() {
      if (!runtime.watchdogEnabled || timer) return;
      const tick = () => cycle().catch((error) => logger.error?.("sentinel watchdog cycle failed", {
        error_class: error.code || "sentinel_watchdog_failure"
      }));
      timer = setInterval(tick, intervalMs);
      tick();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    }
  };
}

async function main() {
  const port = Number(process.env.PORT || 3100);
  const app = createSentinelServer();
  if (process.argv.includes("--check")) {
    console.log(JSON.stringify(await getSentinelStatus({
      dataDir: path.resolve(process.env.DATA_DIR || "data"),
      env: process.env
    }), null, 2));
    return;
  }
  app.start();
  const server = http.createServer((req, res) => app.handler(req, res));
  server.listen(port, "0.0.0.0", () => {
    console.log(`automation-sentinel listening on :${port}`);
  });
}

function boundedInterval(value) {
  const number = Number(value || MIN_INTERVAL_MS);
  if (!Number.isFinite(number)) return MIN_INTERVAL_MS;
  return Math.min(MAX_INTERVAL_MS, Math.max(MIN_INTERVAL_MS, Math.round(number)));
}

function parseNow(value) {
  if (!value) return new Date();
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    const error = new Error("Invalid now timestamp");
    error.code = "invalid_now";
    throw error;
  }
  return parsed;
}

function sendJson(res, status, body) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(JSON.stringify(body, null, 2));
}

const isEntrypoint = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntrypoint) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
