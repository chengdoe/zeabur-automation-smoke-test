import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

import { shanghaiDateTimeParts, weekdayForDate } from "./date.js";
import { runDryRunJob } from "./dryRunRunner.js";
import { runLiveSendJob } from "./liveSendRunner.js";

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
  },
  {
    id: "fund-portfolio-daily",
    hour: "13",
    minute: "50",
    weekdays: [1, 2, 3, 4, 5]
  },
  {
    id: "wisereads-weekly",
    retryWindow: true,
    weekdays: [1, 2],
    start: "09:00",
    end: "18:00",
    intervalMinutes: 30
  }
];

export function createSchedulerState() {
  return {
    ranKeys: new Set(),
    lastTickAt: null,
    lastRuns: []
  };
}

export function getDueDryRunJobs({ now = new Date(), state, enabledJobs = {} }) {
  const parts = shanghaiDateTimeParts(now);
  const date = `${parts.year}-${parts.month}-${parts.day}`;
  const hour = parts.hour;
  const minute = parts.minute;
  const ranKeys = state?.ranKeys || new Set();

  return SCHEDULED_DRY_RUN_JOBS
    .filter((job) => enabledJobs[job.id] !== false)
    .filter((job) => isJobDueAt({ job, date, hour, minute }))
    .filter((job) => !job.weekdays || job.weekdays.includes(weekdayForDate(date)))
    .map((job) => ({
      ...job,
      date,
      slot: job.retryWindow ? `${hour}:${minute}` : "daily"
    }))
    .filter((job) => !ranKeys.has(schedulerKey(job.id, date, job.slot)));
}

export async function runSchedulerTick({
  now = new Date(),
  state,
  dataDir,
  liveSendEnabled = false,
  liveEnabledJobs,
  sender,
  enabledJobs = {},
  prepareJob,
  env = process.env
}) {
  const schedulerState = state || createSchedulerState();
  schedulerState.lastTickAt = now.toISOString();
  const dueJobs = getDueDryRunJobs({ now, state: schedulerState, enabledJobs });
  const ran = [];

  for (const job of dueJobs) {
    const runLive = liveSendEnabled && (liveEnabledJobs ? liveEnabledJobs[job.id] !== false : true);
    if (runLive && prepareJob) {
      await prepareJob({ job: job.id, date: job.date, dataDir });
    }
    const result = runLive
      ? await runLiveSendJob({
        job: job.id,
        date: job.date,
        dataDir,
        enabled: true,
        confirm: "SEND",
        sender,
        env
      })
      : await runDryRunJob({
        job: job.id,
        date: job.date,
        dataDir,
        env
      });
    schedulerState.ranKeys.add(schedulerKey(job.id, job.date, job.slot));
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

export function startDryRunScheduler({
  dataDir,
  intervalMs = 30_000,
  enabled = true,
  liveSendEnabled = false,
  liveEnabledJobs,
  enabledJobs = {},
  prepareJob,
  logger = console
} = {}) {
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
    runSchedulerTick({ state, dataDir, liveSendEnabled, liveEnabledJobs, enabledJobs, prepareJob }).catch((error) => {
      logger.error("scheduler dry-run tick failed", error);
    });
  };
  const timer = setInterval(tick, intervalMs);
  tick();

  return {
    enabled: true,
    mode: liveSendEnabled ? "live-send" : "dry-run",
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

function isJobDueAt({ job, hour, minute }) {
  if (!job.retryWindow) return job.hour === hour && job.minute === minute;
  const current = Number(hour) * 60 + Number(minute);
  const [startHour, startMinute] = job.start.split(":").map(Number);
  const [endHour, endMinute] = job.end.split(":").map(Number);
  const start = startHour * 60 + startMinute;
  const end = endHour * 60 + endMinute;
  const interval = job.intervalMinutes || 30;
  return current >= start && current <= end && (current - start) % interval === 0;
}

function schedulerKey(job, date, slot = "daily") {
  return `${job}:${date}:${slot}`;
}
