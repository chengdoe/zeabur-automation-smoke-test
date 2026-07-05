import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { runLiveSendJob } from "../src/liveSendRunner.js";

test("live-send runner is blocked unless explicitly enabled and confirmed", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "zeabur-live-send-blocked-"));
  let sendCount = 0;

  const disabled = await runLiveSendJob({
    job: "sop13",
    date: "2026-07-03",
    dataDir,
    enabled: false,
    confirm: "SEND",
    sender: {
      async sendMessage() {
        sendCount += 1;
      }
    }
  });

  assert.equal(disabled.sent, false);
  assert.equal(disabled.sendSkippedReason, "live send disabled");

  const unconfirmed = await runLiveSendJob({
    job: "sop13",
    date: "2026-07-03",
    dataDir,
    enabled: true,
    confirm: "",
    sender: {
      async sendMessage() {
        sendCount += 1;
      }
    }
  });

  assert.equal(unconfirmed.sent, false);
  assert.equal(unconfirmed.sendSkippedReason, "missing SEND confirmation");
  assert.equal(sendCount, 0);
});

test("live-send runner sends once and skips duplicates by sent log", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "zeabur-live-send-"));
  let sendCount = 0;

  const sender = {
    async sendMessage({ msgType, payload, uuid }) {
      sendCount += 1;
      assert.equal(msgType, "post");
      assert.equal(payload.zh_cn.title, "");
      assert.equal(uuid, "sop13-2026-07-03");
      return {
        ok: true,
        messageId: "om_test_message"
      };
    }
  };

  const first = await runLiveSendJob({
    job: "sop13",
    date: "2026-07-03",
    dataDir,
    enabled: true,
    confirm: "SEND",
    sender
  });

  assert.equal(first.sent, true);
  assert.equal(first.messageId, "om_test_message");
  assert.match(first.files.sentLog, /outputs\/automations\/sop13\/2026-07-03-sent\.json$/);

  const logged = JSON.parse(await readFile(first.files.sentLog, "utf8"));
  assert.equal(logged.sent, true);
  assert.equal(logged.messageId, "om_test_message");

  const second = await runLiveSendJob({
    job: "sop13",
    date: "2026-07-03",
    dataDir,
    enabled: true,
    confirm: "SEND",
    sender
  });

  assert.equal(second.sent, true);
  assert.equal(second.skipped, true);
  assert.equal(second.sendSkippedReason, "already sent");
  assert.equal(sendCount, 1);
});
