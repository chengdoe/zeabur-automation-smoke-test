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

test("scheduler marks fund portfolio daily due at 13:50 on Shanghai weekdays", () => {
  const due = getDueDryRunJobs({
    now: new Date("2026-07-08T05:50:00.000Z"),
    state: createSchedulerState()
  });

  assert.deepEqual(due.map((job) => job.id), ["fund-portfolio-daily"]);
  assert.equal(due[0].date, "2026-07-08");
});

test("scheduler skips fund portfolio daily on Shanghai weekends", () => {
  const due = getDueDryRunJobs({
    now: new Date("2026-07-04T05:50:00.000Z"),
    state: createSchedulerState()
  });

  assert.deepEqual(due, []);
});

test("scheduler uses Shanghai weekdays even when the server timezone is UTC", () => {
  const originalTimezone = process.env.TZ;
  process.env.TZ = "UTC";

  try {
    const saturday = getDueDryRunJobs({
      now: new Date("2026-07-11T05:50:00.000Z"),
      state: createSchedulerState()
    });
    const monday = getDueDryRunJobs({
      now: new Date("2026-07-13T05:50:00.000Z"),
      state: createSchedulerState()
    });

    assert.deepEqual(saturday, []);
    assert.deepEqual(monday.map((job) => job.id), ["fund-portfolio-daily"]);
  } finally {
    if (originalTimezone === undefined) {
      delete process.env.TZ;
    } else {
      process.env.TZ = originalTimezone;
    }
  }
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

test("scheduler sends live jobs when live send is enabled", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "zeabur-scheduler-live-"));
  const state = createSchedulerState();
  let sendCount = 0;

  const result = await runSchedulerTick({
    now: new Date("2026-07-04T01:30:00.000Z"),
    state,
    dataDir,
    liveSendEnabled: true,
    sender: {
      async sendMessage({ msgType, payload, uuid }) {
        sendCount += 1;
        assert.equal(msgType, "post");
        assert.equal(payload.zh_cn.content[0][1].user_id, "all");
        assert.equal(uuid, "sop13-2026-07-04");
        return { ok: true, messageId: "om_scheduler_live" };
      }
    }
  });

  assert.equal(sendCount, 1);
  assert.equal(result.ran.length, 1);
  assert.equal(result.ran[0].sent, true);
  assert.match(result.ran[0].files.sentLog, /outputs\/automations\/sop13\/2026-07-04-sent\.json$/);

  const log = JSON.parse(await readFile(path.join(dataDir, "outputs", "automations", "scheduler", "2026-07-04.log.json"), "utf8"));
  assert.equal(log.entries[0].sent, true);
});
