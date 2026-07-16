import http from "node:http";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { listJobs, runDryRunJob } from "./dryRunRunner.js";
import { runLiveSendJob } from "./liveSendRunner.js";
import { FUND_RETRY_SLOTS, startDryRunScheduler } from "./scheduler.js";
import { getFundPortfolioAssetStatus } from "./jobs/fundPortfolioDaily.js";
import { createFundPortfolioAnalyzer } from "./jobs/fundPortfolioAnalyzer.js";
import { runFundPortfolioPipeline } from "./jobs/fundPortfolioPipeline.js";
import { getJobFeishuConfig, validateJobFeishuConfig } from "./feishuClient.js";

const port = Number(process.env.PORT || 3000);
const dataDir = path.resolve(process.env.DATA_DIR || "data");
const heartbeatIntervalMs = Number(process.env.HEARTBEAT_INTERVAL_MS || 60_000);
const schedulerEnabled = process.env.SCHEDULER_ENABLED !== "false";
const schedulerIntervalMs = Number(process.env.SCHEDULER_INTERVAL_MS || 60_000);
const liveSendEnabled = process.env.LIVE_SEND_ENABLED === "true";
const aiHotEnabled = process.env.AI_HOT_ENABLED === "true";
const aiHotSchedulerEnabled = process.env.AI_HOT_SCHEDULER_ENABLED === "true";
const fundPortfolioEnabled = process.env.FUND_PORTFOLIO_ENABLED === "true";
const wisereadsWeeklyEnabled = process.env.WISEREADS_WEEKLY_ENABLED === "true";
const wisereadsSchedulerEnabled = process.env.WISEREADS_WEEKLY_SCHEDULER_ENABLED === "true";
const fundAnalysisProvider = process.env.FUND_ANALYSIS_PROVIDER || (process.env.OPENROUTER_API_KEY ? "openrouter" : "openai");
const startedAt = new Date();
let scheduler;

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
    "https://api.openai.com/",
    "https://aihot.virxact.com/api/public/fingerprint"
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
      heartbeatIntervalMs,
      schedulerEnabled,
      schedulerIntervalMs,
      liveSendEnabled,
      aiHotEnabled,
      aiHotSchedulerEnabled,
      fundPortfolioEnabled,
      wisereadsWeeklyEnabled,
      wisereadsSchedulerEnabled,
      hasFundDataKey: Boolean(process.env.MX_APIKEY),
      hasFundAnalysisKey: fundAnalysisProvider === "openrouter"
        ? Boolean(process.env.OPENROUTER_API_KEY)
        : Boolean(process.env.OPENAI_API_KEY),
      hasFundAnalysisModel: Boolean(process.env.FUND_ANALYSIS_MODEL),
      fundAnalysisProvider,
      hasOpenRouterApiKey: Boolean(process.env.OPENROUTER_API_KEY),
      hasFeishuAppId: Boolean(process.env.FEISHU_APP_ID),
      hasFeishuAppSecret: Boolean(process.env.FEISHU_APP_SECRET),
      hasFeishuTargetChatId: Boolean(process.env.FEISHU_TARGET_CHAT_ID),
      hasWisereadsRssUrl: Boolean(process.env.WISEREADS_RSS_URL),
      aiHotLiveSendGate: aiHotEnabled ? "open" : "closed",
      aiHotSchedulerGate: aiHotSchedulerEnabled ? "open" : "closed",
      wisereadsLiveSendGate: wisereadsWeeklyEnabled ? "open" : "closed",
      wisereadsSchedulerGate: wisereadsSchedulerEnabled ? "open" : "closed"
    },
    jobIdentity: Object.fromEntries([
      "ai-hot",
      "morning-motivation",
      "sop13",
      "fund-portfolio-daily",
      "wisereads-weekly"
    ].map((job) => [job, getJobIdentityStatus(job)])),
    fundPortfolioAudit: getFundPortfolioAudit(),
    fundPortfolioReliability: {
      retrySlots: FUND_RETRY_SLOTS,
      mostRecentAttempt: scheduler?.state?.lastRuns?.find((run) => run.job === "fund-portfolio-daily") || null
    },
    scheduler: schedulerStatus(),
    folders: {
      memory: dirs.memory,
      uploads: dirs.uploads,
      outputs: dirs.outputs
    },
    persistence: await getDiskProbe(),
    recentHeartbeats: await listRecentHeartbeats()
  };
}

function getJobIdentityStatus(job) {
  const jobConfig = getJobFeishuConfig(job);
  const missing = validateJobFeishuConfig(jobConfig);
  return {
    configured: missing.length === 0,
    botRole: jobConfig.botRole || null,
    connectionRef: jobConfig.connectionRef || null,
    hasTargetChat: Boolean(jobConfig.config.targetChatId),
    hasAppId: Boolean(jobConfig.config.appId),
    hasAppSecret: Boolean(jobConfig.config.appSecret),
    missing
  };
}

function getFundPortfolioAudit() {
  const provider = fundAnalysisProvider;
  const jobConfig = getJobFeishuConfig("fund-portfolio-daily");
  const missing = validateJobFeishuConfig(jobConfig);
  return {
    gates: {
      liveSendEnabled,
      fundPortfolioEnabled
    },
    analysis: {
      providerOpenAi: provider === "openai",
      providerOpenRouter: provider === "openrouter",
      providerSupported: ["openai", "openrouter"].includes(provider),
      hasFundAnalysisKey: provider === "openrouter"
        ? Boolean(process.env.OPENROUTER_API_KEY)
        : Boolean(process.env.OPENAI_API_KEY),
      hasFundAnalysisModel: Boolean(process.env.FUND_ANALYSIS_MODEL)
    },
    identity: {
      configured: missing.length === 0,
      hasBotRole: Boolean(jobConfig.botRole),
      hasConnectionRef: Boolean(jobConfig.connectionRef),
      hasTargetChat: Boolean(jobConfig.config.targetChatId),
      hasAppId: Boolean(jobConfig.config.appId),
      hasAppSecret: Boolean(jobConfig.config.appSecret),
      missingBotRole: missing.includes("bot_role"),
      missingConnectionRef: missing.includes("connection_ref"),
      missingTargetChat: missing.includes("target_chat_id"),
      missingAppId: missing.includes("app_id"),
      missingAppSecret: missing.includes("app_secret")
    }
  };
}

function schedulerStatus() {
  return {
    enabled: Boolean(scheduler?.enabled),
    mode: scheduler?.mode || (liveSendEnabled ? "live-send" : "dry-run"),
    intervalMs: scheduler?.intervalMs || schedulerIntervalMs,
    lastTickAt: scheduler?.state?.lastTickAt || null,
    recentRuns: scheduler?.state?.lastRuns || []
  };
}

async function prepareScheduledJob({ job, date, attempt, preparedSnapshot }) {
  if (job !== "fund-portfolio-daily") return;
  return runFundPortfolioPipeline({
    date,
    dataDir,
    attempt,
    preparedSnapshot,
    promote: true,
    analyzer: createFundPortfolioAnalyzer()
  });
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
    if (url.pathname === "/api/jobs/ai-hot/dry-run" && req.method === "POST") {
      return sendJson(res, 200, await runDryRunJob({
        job: "ai-hot",
        date: url.searchParams.get("date") || undefined,
        dataDir
      }));
    }
    if (url.pathname === "/api/jobs/ai-hot/send" && req.method === "POST") {
      return sendJson(res, 200, await runLiveSendJob({
        job: "ai-hot",
        date: url.searchParams.get("date") || undefined,
        dataDir,
        enabled: liveSendEnabled,
        confirm: url.searchParams.get("confirm") || "",
        force: url.searchParams.get("force") === "true"
      }));
    }
    if (url.pathname === "/api/jobs/sop13/dry-run" && req.method === "POST") {
      return sendJson(res, 200, await runDryRunJob({
        job: "sop13",
        date: url.searchParams.get("date") || undefined,
        dataDir
      }));
    }
    if (url.pathname === "/api/jobs/sop13/send" && req.method === "POST") {
      return sendJson(res, 200, await runLiveSendJob({
        job: "sop13",
        date: url.searchParams.get("date") || undefined,
        dataDir,
        enabled: liveSendEnabled,
        confirm: url.searchParams.get("confirm") || "",
        force: url.searchParams.get("force") === "true"
      }));
    }
    if (url.pathname === "/api/jobs/morning-motivation/dry-run" && req.method === "POST") {
      return sendJson(res, 200, await runDryRunJob({
        job: "morning-motivation",
        date: url.searchParams.get("date") || undefined,
        dataDir
      }));
    }
    if (url.pathname === "/api/jobs/morning-motivation/send" && req.method === "POST") {
      return sendJson(res, 200, await runLiveSendJob({
        job: "morning-motivation",
        date: url.searchParams.get("date") || undefined,
        dataDir,
        enabled: liveSendEnabled,
        confirm: url.searchParams.get("confirm") || "",
        force: url.searchParams.get("force") === "true"
      }));
    }
    if (url.pathname === "/api/jobs/fund-portfolio-daily/dry-run" && req.method === "POST") {
      return sendJson(res, 200, await runDryRunJob({
        job: "fund-portfolio-daily",
        date: url.searchParams.get("date") || undefined,
        dataDir
      }));
    }
    if (url.pathname === "/api/jobs/wisereads-weekly/dry-run" && req.method === "POST") {
      return sendJson(res, 200, await runDryRunJob({
        job: "wisereads-weekly",
        date: url.searchParams.get("date") || undefined,
        dataDir
      }));
    }
    if (url.pathname === "/api/jobs/fund-portfolio-daily/send" && req.method === "POST") {
      return sendJson(res, 200, await runLiveSendJob({
        job: "fund-portfolio-daily",
        date: url.searchParams.get("date") || undefined,
        dataDir,
        enabled: liveSendEnabled && fundPortfolioEnabled,
        confirm: url.searchParams.get("confirm") || "",
        force: url.searchParams.get("force") === "true"
      }));
    }
    if (url.pathname === "/api/jobs/wisereads-weekly/send" && req.method === "POST") {
      return sendJson(res, 200, await runLiveSendJob({
        job: "wisereads-weekly",
        date: url.searchParams.get("date") || undefined,
        dataDir,
        enabled: liveSendEnabled,
        confirm: url.searchParams.get("confirm") || "",
        force: url.searchParams.get("force") === "true"
      }));
    }
    if (url.pathname === "/api/jobs/fund-portfolio-daily/status") {
      return sendJson(res, 200, {
        ok: true,
        job: "fund-portfolio-daily",
        status: await getFundPortfolioAssetStatus({
          date: url.searchParams.get("date") || undefined,
          dataDir
        })
      });
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

  scheduler = startDryRunScheduler({
    dataDir,
    enabled: schedulerEnabled,
    intervalMs: schedulerIntervalMs,
    liveSendEnabled,
    liveEnabledJobs: {
      "ai-hot": aiHotEnabled,
      "wisereads-weekly": wisereadsWeeklyEnabled
    },
    enabledJobs: {
      "ai-hot": aiHotSchedulerEnabled,
      "fund-portfolio-daily": fundPortfolioEnabled,
      "wisereads-weekly": wisereadsSchedulerEnabled
    },
    prepareJob: prepareScheduledJob
  });

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
