import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  createSchedulerState,
  getDueDryRunJobs,
  runSchedulerTick
} from "../src/scheduler.js";

test("scheduler marks morning motivation due at 09:00 Asia/Shanghai", () => {
  const due = getDueDryRunJobs({
    now: new Date("2026-07-04T01:00:00.000Z"),
    state: createSchedulerState()
  });

  assert.deepEqual(due.map((job) => job.id), ["morning-motivation"]);
  assert.equal(due[0].date, "2026-07-04");
});

test("scheduler marks SOP13 due at 09:30 Asia/Shanghai", () => {
  const due = getDueDryRunJobs({
    now: new Date("2026-07-04T01:30:00.000Z"),
    state: createSchedulerState()
  });

  assert.deepEqual(due.map((job) => job.id), ["sop13"]);
  assert.equal(due[0].date, "2026-07-04");
});

test("scheduler does not run the same job twice for the same Shanghai date", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "zeabur-scheduler-"));
  const state = createSchedulerState();

  const first = await runSchedulerTick({
    now: new Date("2026-07-04T01:30:00.000Z"),
    state,
    dataDir
  });
  const second = await runSchedulerTick({
    now: new Date("2026-07-04T01:30:30.000Z"),
    state,
    dataDir
  });

  assert.equal(first.ran.length, 1);
  assert.equal(first.ran[0].job, "sop13");
  assert.equal(first.ran[0].sent, false);
  assert.deepEqual(second.ran, []);

  const log = JSON.parse(await readFile(path.join(dataDir, "outputs", "automations", "scheduler", "2026-07-04.log.json"), "utf8"));
  assert.equal(log.entries.length, 1);
  assert.equal(log.entries[0].job, "sop13");
  assert.equal(log.entries[0].sent, false);
});
