import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

import { buildMorningMotivationDryRun } from "./jobs/morningMotivation.js";
import { buildSop13DryRun } from "./jobs/sop13.js";
import { createFeishuClient } from "./feishuClient.js";

const LIVE_JOBS = {
  "morning-motivation": {
    folder: "morning-motivation",
    build: buildMorningMotivationDryRun
  },
  sop13: {
    folder: "sop13",
    build: buildSop13DryRun
  }
};

export async function runLiveSendJob({
  job,
  date,
  dataDir,
  enabled = false,
  confirm = "",
  force = false,
  sender
}) {
  const definition = LIVE_JOBS[job];
  if (!definition) {
    throw new Error(`Unknown job: ${job}`);
  }

  if (!enabled) {
    return blockedResult({ job, date, reason: "live send disabled" });
  }
  if (confirm !== "SEND") {
    return blockedResult({ job, date, reason: "missing SEND confirmation" });
  }

  const draft = definition.build({ date });
  const outputDir = path.join(dataDir, "outputs", "automations", definition.folder);
  await mkdir(outputDir, { recursive: true });

  const sentLogFile = path.join(outputDir, `${draft.date}-sent.json`);
  if (!force && existsSync(sentLogFile)) {
    const existing = JSON.parse(await readFile(sentLogFile, "utf8"));
    return {
      ...existing,
      skipped: true,
      sendSkippedReason: "already sent"
    };
  }

  if (!draft.validation.ok) {
    return {
      ...draft,
      dryRun: false,
      sent: false,
      sendSkippedReason: "validation failed",
      files: {
        sentLog: sentLogFile
      }
    };
  }

  const messageSender = sender || await createFeishuClient();
  const uuid = `${job}-${draft.date}`;
  const sendResult = await messageSender.sendMessage({
    msgType: draft.msgType,
    payload: draft.payload,
    uuid
  });

  const result = {
    ...draft,
    dryRun: false,
    sent: true,
    sentAt: new Date().toISOString(),
    messageId: sendResult.messageId,
    uuid,
    files: {
      sentLog: sentLogFile
    }
  };

  await writeFile(sentLogFile, JSON.stringify(redactResult(result), null, 2), "utf8");
  return result;
}

function blockedResult({ job, date, reason }) {
  return {
    ok: false,
    job,
    date: date || null,
    dryRun: false,
    sent: false,
    sendSkippedReason: reason
  };
}

function redactResult(result) {
  return {
    ...result,
    payload: result.payload
  };
}
