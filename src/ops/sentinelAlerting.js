import { randomUUID } from "node:crypto";

import { createFeishuClient, getJobFeishuConfig, validateJobFeishuConfig } from "../feishuClient.js";
import { getSentinelRuntimeConfig } from "./sentinelPolicy.js";
import {
  readSentinelAlertDeliveries,
  readSentinelIncidents,
  recordSentinelAlertDelivery
} from "./sentinelStore.js";
import { buildSentinelAlertPost } from "./sentinelWatchdog.js";

export function getSentinelIdentityStatus(env = process.env) {
  const jobConfig = getJobFeishuConfig("sentinel", env);
  const rawMissing = validateJobFeishuConfig(jobConfig);
  const missing = normalizeMissingIdentity(rawMissing);
  return {
    configured: rawMissing.length === 0,
    botRole: jobConfig.botRole || null,
    connectionRef: jobConfig.connectionRef || null,
    hasTargetChat: Boolean(jobConfig.config.targetChatId),
    hasAppId: Boolean(jobConfig.config.appId),
    hasAppSecret: Boolean(jobConfig.config.appSecret),
    missing
  };
}

function normalizeMissingIdentity(missing) {
  const normalized = [];
  if (missing.includes("bot_role")) normalized.push("bot_role");
  if (missing.includes("connection_ref")) normalized.push("connection_ref");
  if (missing.includes("target_chat") || missing.includes("FEISHU_TARGET_CHAT_ID")) normalized.push("target_chat");
  if (missing.includes("FEISHU_APP_ID") || missing.includes("FEISHU_APP_SECRET")) normalized.push("app_credentials");
  return [...new Set(normalized)];
}

export async function deliverSentinelIncidents({
  dataDir,
  date,
  incidents = [],
  env = process.env,
  sender,
  now = new Date()
}) {
  const runtime = getSentinelRuntimeConfig(env);
  const identity = getSentinelIdentityStatus(env);
  const blockedReason = deliveryGateReason(runtime, identity);
  if (blockedReason) {
    return {
      ok: true,
      sent: [],
      failed: [],
      duplicates: [],
      previews: incidents.map((incident) => ({ incident_id: incident.incident_id, payload: buildSentinelAlertPost(incident) })),
      blockedReason,
      identity
    };
  }

  const existing = await readSentinelAlertDeliveries({ dataDir, date });
  const alreadySent = new Set(existing
    .filter((item) => item.delivery_state === "sent")
    .map((item) => deliveryKey(item.incident_id, item.delivery_kind)));
  const messageSender = sender || await createFeishuClient({ config: getJobFeishuConfig("sentinel", env).config });
  const sent = [];
  const failed = [];
  const duplicates = [];

  for (const incident of incidents) {
    const kind = incident.update_type || "opened";
    const key = deliveryKey(incident.incident_id, kind);
    if (alreadySent.has(key)) {
      duplicates.push({ incident_id: incident.incident_id, delivery_kind: kind, reason: "already_sent" });
      continue;
    }
    try {
      const response = await messageSender.sendMessage({
        msgType: "post",
        payload: buildSentinelAlertPost(incident),
        uuid: `sentinel-${incident.incident_id || randomUUID()}-${kind}`
      });
      const delivery = await recordSentinelAlertDelivery({
        dataDir,
        date,
        delivery: {
          incident_id: incident.incident_id,
          job_id: incident.job_id,
          delivery_kind: kind,
          delivery_state: "sent",
          message_id: response?.messageId || null,
          delivered_at: now.toISOString(),
          safe_summary: `${incident.job_id} alert delivered`
        }
      });
      sent.push(delivery.delivery);
      alreadySent.add(key);
    } catch (error) {
      const delivery = await recordSentinelAlertDelivery({
        dataDir,
        date,
        delivery: {
          incident_id: incident.incident_id,
          job_id: incident.job_id,
          delivery_kind: kind,
          delivery_state: "failed",
          delivered_at: now.toISOString(),
          safe_summary: `${incident.job_id} alert delivery failed`
        }
      });
      failed.push({ ...delivery.delivery, error_class: error.code || "feishu_send_failure" });
    }
  }

  return { ok: failed.length === 0, sent, failed, duplicates, previews: [], blockedReason: null, identity };
}

export async function listPendingSentinelIncidents({ dataDir, date }) {
  const [incidents, deliveries] = await Promise.all([
    readSentinelIncidents({ dataDir, date }),
    readSentinelAlertDeliveries({ dataDir, date })
  ]);
  const sent = new Set(deliveries
    .filter((item) => item.delivery_state === "sent")
    .map((item) => deliveryKey(item.incident_id, item.delivery_kind)));
  const pending = new Map();
  for (const incident of incidents) {
    const key = deliveryKey(incident.incident_id, incident.update_type);
    if (!sent.has(key)) pending.set(key, incident);
  }
  return [...pending.values()];
}

function deliveryKey(incidentId, kind) {
  return `${incidentId}:${kind || "opened"}`;
}

function deliveryGateReason(runtime, identity) {
  if (!runtime.enabled) return "sentinel_disabled";
  if (!runtime.alertEnabled) return "sentinel_alert_disabled";
  if (!runtime.alertSendEnabled) return "sentinel_live_send_disabled";
  if (!identity.configured) return "sentinel_identity_incomplete";
  return null;
}
