import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

import { shanghaiDateTimeParts } from "./date.js";
import { runDryRunJob } from "./dryRunRunner.js";

const SCHEDULED_DRY_RUN_JOBS = [
  {
    id: "morning-motivation",
    hour: "09",
    minute: "00"
  },
  {
    id: "sop13",
    hour: "09",
    minute: "30"
  }
];

export function createSchedulerState() {
  return {
    ranKeys: new Set(),
    lastTickAt: null,
    lastRuns: []
  };
}

export function getDueDryRunJobs({ now = new Date(), state }) {
  const parts = shanghaiDateTimeParts(now);
  const date = `${parts.year}-${parts.month}-${parts.day}`;
  const hour = parts.hour;
  const minute = parts.minute;
  const ranKeys = state?.ranKeys || new Set();

  return SCHEDULED_DRY_RUN_JOBS
    .filter((job) => job.hour === hour && job.minute === minute)
    .filter((job) => !ranKeys.has(schedulerKey(job.id, date)))
    .map((job) => ({
      ...job,
      date
    }));
}

export async function runSchedulerTick({ now = new Date(), state, dataDir }) {
  const schedulerState = state || createSchedulerState();
  schedulerState.lastTickAt = now.toISOString();
  const dueJobs = getDueDryRunJobs({ now, state: schedulerState });
  const ran = [];

  for (const job of dueJobs) {
    const result = await runDryRunJob({
      job: job.id,
      date: job.date,
      dataDir
    });
    schedulerState.ranKeys.add(schedulerKey(job.id, job.date));
    schedulerState.lastRuns.unshift({
      ts: now.toISOString(),
      job: job.id,
      date: job.date,
      ok: result.ok,
      sent: result.sent,
      files: result.files
    });
    schedulerState.lastRuns = schedulerState.lastRuns.slice(0, 20);
    await appendSchedulerLog({ dataDir, now, result });
    ran.push(result);
  }

  return {
    checkedAt: now.toISOString(),
    dueJobs,
    ran
  };
}

export function startDryRunScheduler({ dataDir, intervalMs = 30_000, enabled = true, logger = console } = {}) {
  const state = createSchedulerState();

  if (!enabled) {
    return {
      enabled: false,
      intervalMs,
      state,
      stop() {}
    };
  }

  const tick = () => {
    runSchedulerTick({ state, dataDir }).catch((error) => {
      logger.error("scheduler dry-run tick failed", error);
    });
  };
  const timer = setInterval(tick, intervalMs);
  tick();

  return {
    enabled: true,
    intervalMs,
    state,
    stop() {
      clearInterval(timer);
    }
  };
}

async function appendSchedulerLog({ dataDir, now, result }) {
  const date = result.date;
  const dir = path.join(dataDir, "outputs", "automations", "scheduler");
  const file = path.join(dir, `${date}.log.json`);
  await mkdir(dir, { recursive: true });

  const existing = existsSync(file)
    ? JSON.parse(await readFile(file, "utf8"))
    : { date, entries: [] };

  existing.entries.push({
    ts: now.toISOString(),
    job: result.job,
    ok: result.ok,
    dryRun: result.dryRun,
    sent: result.sent,
    files: result.files
  });

  await writeFile(file, JSON.stringify(existing, null, 2), "utf8");
}

function schedulerKey(job, date) {
  return `${job}:${date}`;
}
