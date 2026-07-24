import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

import { buildAIHotDryRun, recordAIHotDelivered } from "./jobs/aiHot.js";
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
  "ai-hot": {
    folder: "ai-hot",
    build: buildAIHotDryRun,
    enabledEnv: "AI_HOT_ENABLED"
  },
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
    const { messageId, sentAt, ...previous } = existing;
    return {
      ...previous,
      sent: false,
      skipped: true,
      sendSkippedReason: "already sent",
      existingMessageId: messageId || null,
      previousSentAt: sentAt || null
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

  if (draft.sendPolicy === "skip") {
    return {
      ...draft,
      dryRun: false,
      sent: false,
      skipped: true,
      sendSkippedReason: draft.sendSkippedReason || "send policy skipped",
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
  const duplicateSearchText = draft.duplicateSearchText || (job === "wisereads-weekly" && draft.source?.vol ? `Wisereads Vol. ${draft.source.vol}` : "");
  if (duplicateSearchText && typeof messageSender.findRecentMessageContaining === "function") {
    const existing = await messageSender.findRecentMessageContaining({ text: duplicateSearchText });
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
  if (job === "fund-portfolio-daily" && typeof messageSender.findRecentMessageContaining === "function") {
    const titleToken = `【基金持仓日报 · ${draft.date}】`;
    const existing = await messageSender.findRecentMessageContaining({ text: titleToken });
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
  if (job === "ai-hot" && draft.brief) {
    await recordAIHotDelivered({
      dataDir,
      brief: draft.brief,
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
