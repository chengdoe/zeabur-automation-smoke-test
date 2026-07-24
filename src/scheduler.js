import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

import { shanghaiDateTimeParts, weekdayForDate } from "./date.js";
import { runDryRunJob } from "./dryRunRunner.js";
import { runLiveSendJob } from "./liveSendRunner.js";

export const FUND_RETRY_SLOTS = ["13:50", "14:00", "14:10", "14:20"];

const SCHEDULED_DRY_RUN_JOBS = [
  {
    id: "ai-hot",
    hour: "09",
    minute: "00"
  },
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
    retrySlots: FUND_RETRY_SLOTS,
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
    fundRetries: new Map(),
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
    .filter((job) => isJobDueAt({ job, date, hour, minute, state }))
    .filter((job) => !job.weekdays || job.weekdays.includes(weekdayForDate(date)))
    .map((job) => ({
      ...job,
      date,
      slot: job.retryWindow || job.retrySlots ? `${hour}:${minute}` : "daily"
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
    const attempt = job.id === "fund-portfolio-daily"
      ? FUND_RETRY_SLOTS.indexOf(job.slot) + 1
      : 1;
    if (runLive && job.id === "fund-portfolio-daily" && isFundSent({ dataDir, date: job.date })) {
      const result = {
        ok: true,
        job: job.id,
        date: job.date,
        dryRun: false,
        sent: false,
        skipped: true,
        sendSkippedReason: "already sent",
        attempt,
        phase: "precheck",
        error_class: null,
        next_retry_at: null,
        files: {}
      };
      schedulerState.fundRetries.delete(job.date);
      await recordSchedulerResult({ schedulerState, dataDir, now, job, result });
      ran.push(result);
      continue;
    }

    let prepared;
    if (runLive && prepareJob) {
      try {
        prepared = await prepareJob({
          job: job.id,
          date: job.date,
          dataDir,
          attempt,
          preparedSnapshot: schedulerState.fundRetries.get(job.date)?.preparedSnapshot
        });
      } catch (error) {
        prepared = {
          ok: false,
          sent: false,
          phase: error.phase || "prepare",
          error_class: error.errorClass || error.error_class || "prepare_failure",
          retryable: Boolean(error.retryable),
          preparedSnapshot: error.preparedSnapshot,
          prompt_hash_suffix: error.prompt_hash_suffix || error.promptHash?.slice?.(-12) || null
        };
      }
    }

    if (job.id === "fund-portfolio-daily" && runLive && prepared?.ok === false) {
      const failurePhase = prepared.phase || "prepare";
      const retryablePhase = ["prepare", "model"].includes(failurePhase);
      const canRetry = Boolean(prepared.retryable && retryablePhase);
      const nextRetryAt = canRetry ? nextFundRetryAt(job.date, attempt) : null;
      const result = {
        ok: false,
        job: job.id,
        date: job.date,
        dryRun: false,
        sent: false,
        attempt,
        phase: failurePhase,
        error_class: prepared.error_class || "prepare_failure",
        retryable: canRetry,
        next_retry_at: nextRetryAt,
        preparedSnapshot: prepared.preparedSnapshot || null,
        promoted: Boolean(prepared.promoted),
        skipped: Boolean(prepared.skipped),
        sendSkippedReason: prepared.sendSkippedReason || null,
        prompt_hash_suffix: prepared.prompt_hash_suffix || prepared.promptHash?.slice?.(-12) || null,
        files: prepared.files || {}
      };
      if (nextRetryAt) {
        schedulerState.fundRetries.set(job.date, {
          retryable: true,
          attempt,
          preparedSnapshot: prepared.preparedSnapshot
        });
      } else {
        schedulerState.fundRetries.delete(job.date);
      }
      await recordSchedulerResult({ schedulerState, dataDir, now, job, result });
      ran.push(result);
      continue;
    }

    let result;
    try {
      result = runLive
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
      result = {
        ...result,
        attempt,
        phase: runLive ? "send" : "dry-run",
        error_class: null,
        next_retry_at: null
      };
    } catch {
      result = {
        ok: false,
        job: job.id,
        date: job.date,
        dryRun: false,
        sent: false,
        attempt,
        phase: "send",
        error_class: "send_failure",
        next_retry_at: null,
        files: {}
      };
    }
    if (job.id === "fund-portfolio-daily") schedulerState.fundRetries.delete(job.date);
    await recordSchedulerResult({ schedulerState, dataDir, now, job, result });
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
    attempt: result.attempt,
    phase: result.phase,
    error_class: result.error_class,
    next_retry_at: result.next_retry_at,
    sent: result.sent,
    skipped: Boolean(result.skipped),
    sendSkippedReason: result.sendSkippedReason || null,
    files: result.files || {},
    prompt_hash_suffix: result.prompt_hash_suffix || null
  });

  await writeFile(file, JSON.stringify(existing, null, 2), "utf8");
}

function isJobDueAt({ job, date, hour, minute, state }) {
  if (job.retrySlots) {
    const slot = `${hour}:${minute}`;
    const index = job.retrySlots.indexOf(slot);
    if (index < 0) return false;
    if (index === 0) return true;
    const retry = state?.fundRetries?.get(date);
    return Boolean(retry?.retryable && retry.attempt === index);
  }
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

function isFundSent({ dataDir, date }) {
  return existsSync(path.join(dataDir, "outputs", "automations", "fund-portfolio-daily", `${date}-sent.json`));
}

function nextFundRetryAt(date, attempt) {
  const nextSlot = FUND_RETRY_SLOTS[attempt];
  return nextSlot ? `${date}T${nextSlot}:00+08:00` : null;
}

async function recordSchedulerResult({ schedulerState, dataDir, now, job, result }) {
  schedulerState.ranKeys.add(schedulerKey(job.id, job.date, job.slot));
  schedulerState.lastRuns.unshift({
    ts: now.toISOString(),
    job: job.id,
    date: job.date,
    ok: result.ok,
    attempt: result.attempt,
    phase: result.phase,
    error_class: result.error_class,
    next_retry_at: result.next_retry_at,
    sent: result.sent,
    skipped: Boolean(result.skipped),
    sendSkippedReason: result.sendSkippedReason || null,
    files: result.files || {},
    prompt_hash_suffix: result.prompt_hash_suffix || null
  });
  schedulerState.lastRuns = schedulerState.lastRuns.slice(0, 20);
  await appendSchedulerLog({ dataDir, now, result });
}
