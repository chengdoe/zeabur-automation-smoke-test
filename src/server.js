import http from "node:http";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { listJobs, runDryRunJob } from "./dryRunRunner.js";

const port = Number(process.env.PORT || 3000);
const dataDir = path.resolve(process.env.DATA_DIR || "data");
const heartbeatIntervalMs = Number(process.env.HEARTBEAT_INTERVAL_MS || 60_000);
const startedAt = new Date();

const dirs = {
  memory: path.join(dataDir, "memory"),
  uploads: path.join(dataDir, "uploads"),
  outputs: path.join(dataDir, "outputs"),
  heartbeat: path.join(dataDir, "outputs", "heartbeat"),
  reports: path.join(dataDir, "outputs", "reports")
};

async function ensureDirs() {
  await Promise.all(Object.values(dirs).map((dir) => mkdir(dir, { recursive: true })));
}

function nowIso() {
  return new Date().toISOString();
}

async function appendHeartbeat(reason = "interval") {
  await ensureDirs();
  const line = JSON.stringify({
    ts: nowIso(),
    reason,
    uptimeSeconds: Math.round(process.uptime()),
    dataDir,
    hasTestSecret: Boolean(process.env.TEST_SECRET)
  });
  const file = path.join(dirs.heartbeat, "heartbeat.log");
  const previous = existsSync(file) ? await readFile(file, "utf8") : "";
  await writeFile(file, `${previous}${line}\n`);
  return { file, line: JSON.parse(line) };
}

async function listRecentHeartbeats(limit = 10) {
  const file = path.join(dirs.heartbeat, "heartbeat.log");
  if (!existsSync(file)) return [];
  const text = await readFile(file, "utf8");
  return text.trim().split("\n").filter(Boolean).slice(-limit).map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      return { raw: line };
    }
  });
}

async function getDiskProbe() {
  const probeFile = path.join(dirs.reports, "persistence-probe.json");
  if (!existsSync(probeFile)) {
    await writeFile(probeFile, JSON.stringify({
      createdAt: nowIso(),
      note: "If this file survives service redeploy/restart with a persistent volume, persistence works."
    }, null, 2));
  }
  const info = await stat(probeFile);
  return {
    file: probeFile,
    exists: true,
    size: info.size,
    modifiedAt: info.mtime.toISOString()
  };
}

async function outboundCheck() {
  const targets = [
    "https://open.feishu.cn/",
    "https://api.openai.com/"
  ];
  const results = [];
  for (const url of targets) {
    const started = Date.now();
    try {
      const response = await fetch(url, { method: "HEAD" });
      results.push({
        url,
        ok: true,
        status: response.status,
        ms: Date.now() - started
      });
    } catch (error) {
      results.push({
        url,
        ok: false,
        error: error.message,
        ms: Date.now() - started
      });
    }
  }
  return results;
}

async function status() {
  await ensureDirs();
  return {
    ok: true,
    service: "zeabur-automation-smoke-test",
    startedAt: startedAt.toISOString(),
    now: nowIso(),
    uptimeSeconds: Math.round(process.uptime()),
    node: process.version,
    port,
    dataDir,
    env: {
      hasTestSecret: Boolean(process.env.TEST_SECRET),
      heartbeatIntervalMs
    },
    folders: {
      memory: dirs.memory,
      uploads: dirs.uploads,
      outputs: dirs.outputs
    },
    persistence: await getDiskProbe(),
    recentHeartbeats: await listRecentHeartbeats()
  };
}

function sendJson(res, code, body) {
  res.writeHead(code, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(JSON.stringify(body, null, 2));
}

function sendHtml(res, body) {
  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(body);
}

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname === "/health") {
      return sendJson(res, 200, { ok: true, now: nowIso() });
    }
    if (url.pathname === "/api/status") {
      return sendJson(res, 200, await status());
    }
    if (url.pathname === "/api/heartbeat" && req.method === "POST") {
      return sendJson(res, 200, await appendHeartbeat("manual"));
    }
    if (url.pathname === "/api/outbound") {
      return sendJson(res, 200, { ok: true, results: await outboundCheck() });
    }
    if (url.pathname === "/api/jobs") {
      return sendJson(res, 200, { ok: true, jobs: listJobs() });
    }
    if (url.pathname === "/api/jobs/sop13/dry-run" && req.method === "POST") {
      return sendJson(res, 200, await runDryRunJob({
        job: "sop13",
        date: url.searchParams.get("date") || undefined,
        dataDir
      }));
    }
    if (url.pathname === "/api/jobs/morning-motivation/dry-run" && req.method === "POST") {
      return sendJson(res, 200, await runDryRunJob({
        job: "morning-motivation",
        date: url.searchParams.get("date") || undefined,
        dataDir
      }));
    }
    if (url.pathname === "/") {
      const snapshot = await status();
      return sendHtml(res, `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Kane Automation Smoke Test</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 32px; line-height: 1.5; color: #1f2328; }
    main { max-width: 880px; margin: 0 auto; }
    .ok { color: #16833a; font-weight: 700; }
    code, pre { background: #f6f8fa; border-radius: 6px; }
    code { padding: 2px 5px; }
    pre { padding: 16px; overflow: auto; }
    a { color: #0969da; }
  </style>
</head>
<body>
  <main>
    <h1>Kane Automation Smoke Test <span class="ok">OK</span></h1>
    <p>这个页面证明 Zeabur 服务已启动。接下来检查环境变量、持久化、定时心跳和出网。</p>
    <ul>
      <li><a href="/health">/health</a></li>
      <li><a href="/api/status">/api/status</a></li>
      <li><a href="/api/outbound">/api/outbound</a></li>
      <li><a href="/api/jobs">/api/jobs</a></li>
    </ul>
    <pre>${escapeHtml(JSON.stringify(snapshot, null, 2))}</pre>
  </main>
</body>
</html>`);
    }
    return sendJson(res, 404, { ok: false, error: "not found" });
  } catch (error) {
    return sendJson(res, 500, { ok: false, error: error.message });
  }
}

function escapeHtml(text) {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

async function main() {
  await ensureDirs();
  await appendHeartbeat("startup");

  if (process.argv.includes("--check")) {
    console.log(JSON.stringify(await status(), null, 2));
    return;
  }

  setInterval(() => {
    appendHeartbeat("interval").catch((error) => {
      console.error("heartbeat failed", error);
    });
  }, heartbeatIntervalMs);

  const server = http.createServer((req, res) => {
    handle(req, res);
  });

  server.listen(port, "0.0.0.0", () => {
    console.log(`zeabur-automation-smoke-test listening on :${port}`);
    console.log(`data dir: ${dataDir}`);
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
