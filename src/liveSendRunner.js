import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

import { buildFundPortfolioDailyPost } from "./jobs/fundPortfolioDaily.js";
import { buildMorningMotivationDryRun } from "./jobs/morningMotivation.js";
import { buildSop13DryRun } from "./jobs/sop13.js";
import { buildWisereadsWeeklyDryRun, recordWisereadsDelivered } from "./jobs/wisereadsWeekly.js";
import {
  createFeishuClient,
  getJobFeishuConfig,
  validateJobFeishuConfig
} from "./feishuClient.js";

const LIVE_JOBS = {
  "morning-motivation": {
    folder: "morning-motivation",
    build: buildMorningMotivationDryRun
  },
  sop13: {
    folder: "sop13",
    build: buildSop13DryRun
  },
  "fund-portfolio-daily": {
    folder: "fund-portfolio-daily",
    build: buildFundPortfolioDailyPost
  },
  "wisereads-weekly": {
    folder: "wisereads-weekly",
    build: buildWisereadsWeeklyDryRun,
    enabledEnv: "WISEREADS_WEEKLY_ENABLED"
  }
};

export async function runLiveSendJob({
  job,
  date,
  dataDir,
  enabled = false,
  confirm = "",
  force = false,
  sender,
  env = process.env
}) {
  const definition = LIVE_JOBS[job];
  if (!definition) {
    throw new Error(`Unknown job: ${job}`);
  }

  if (!enabled) {
    return blockedResult({ job, date, reason: "live send disabled" });
  }
  if (definition.enabledEnv && env[definition.enabledEnv] !== "true") {
    return blockedResult({ job, date, reason: `${definition.enabledEnv} disabled` });
  }
  if (confirm !== "SEND") {
    return blockedResult({ job, date, reason: "missing SEND confirmation" });
  }

  const jobFeishuConfig = getJobFeishuConfig(job, env);
  const missingIdentity = validateJobFeishuConfig(jobFeishuConfig);
  if (missingIdentity.length) {
    return blockedResult({
      job,
      date,
      reason: "bot-role-unconfirmed",
      missingIdentity
    });
  }

  const draft = await definition.build({ date, dataDir, env });
  const outputDir = path.join(dataDir, "outputs", "automations", definition.folder);
  await mkdir(outputDir, { recursive: true });

  const sentKey = draft.sentLogKey || draft.date;
  const sentLogFile = path.join(outputDir, `${sentKey}-sent.json`);
  if (!force && existsSync(sentLogFile)) {
    const existing = JSON.parse(await readFile(sentLogFile, "utf8"));
    return {
      ...existing,
      skipped: true,
      sendSkippedReason: "already sent"
    };
  }

  if (job === "wisereads-weekly" && draft.sourceStatus === "already_delivered_ledger") {
    return {
      ...draft,
      dryRun: false,
      sent: false,
      skipped: true,
      sendSkippedReason: "already delivered by state ledger",
      files: { sentLog: sentLogFile }
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

  const messageSender = sender || await createFeishuClient({ config: jobFeishuConfig.config });
  if (job === "wisereads-weekly" && draft.source?.vol && typeof messageSender.findRecentMessageContaining === "function") {
    const existing = await messageSender.findRecentMessageContaining({ text: `Wisereads Vol. ${draft.source.vol}` });
    if (existing) {
      return {
        ...draft,
        dryRun: false,
        sent: false,
        skipped: true,
        sendSkippedReason: "already delivered in Feishu",
        existingMessageId: existing.message_id || existing.messageId || null,
        files: { sentLog: sentLogFile }
      };
    }
  }

  const uuid = draft.idempotencyKey || `${job}-${draft.date}`;
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
  if (job === "wisereads-weekly" && draft.source?.vol) {
    await recordWisereadsDelivered({
      dataDir,
      vol: draft.source.vol,
      messageId: sendResult.messageId,
      deliveredAt: result.sentAt
    });
  }
  return result;
}

function blockedResult({ job, date, reason, missingIdentity = [] }) {
  return {
    ok: false,
    job,
    date: date || null,
    dryRun: false,
    sent: false,
    sendSkippedReason: reason,
    missingIdentity
  };
}

function redactResult(result) {
  return {
    ...result,
    payload: result.payload
  };
}
