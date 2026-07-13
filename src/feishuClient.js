const FEISHU_BASE_URL = "https://open.feishu.cn";

export function getFeishuConfig(env = process.env) {
  return {
    appId: env.FEISHU_APP_ID || "",
    appSecret: env.FEISHU_APP_SECRET || "",
    targetChatId: env.FEISHU_TARGET_CHAT_ID || "",
    baseUrl: env.FEISHU_BASE_URL || FEISHU_BASE_URL
  };
}

export function getJobFeishuConfig(job, env = process.env) {
  const prefix = envToken(job);
  const botRole = env[`${prefix}_BOT_ROLE`] || "";
  const connectionRef = env[`${prefix}_CONNECTION_REF`] || "";
  const targetChatId = env[`${prefix}_TARGET_CHAT_ID`] || "";
  const connectionPrefix = connectionRef
    ? `FEISHU_CONNECTION_${envToken(connectionRef)}`
    : "";

  return {
    botRole,
    connectionRef,
    config: {
      appId: connectionPrefix ? env[`${connectionPrefix}_APP_ID`] || "" : "",
      appSecret: connectionPrefix ? env[`${connectionPrefix}_APP_SECRET`] || "" : "",
      targetChatId,
      baseUrl: env.FEISHU_BASE_URL || FEISHU_BASE_URL
    }
  };
}

export function validateJobFeishuConfig(jobConfig) {
  const missing = [];
  if (!jobConfig.botRole) missing.push("bot_role");
  if (!jobConfig.connectionRef) missing.push("connection_ref");
  if (!jobConfig.config.targetChatId) missing.push("target_chat");
  missing.push(...validateFeishuConfig(jobConfig.config));
  return [...new Set(missing)];
}

export function validateFeishuConfig(config) {
  const missing = [];
  if (!config.appId) missing.push("FEISHU_APP_ID");
  if (!config.appSecret) missing.push("FEISHU_APP_SECRET");
  if (!config.targetChatId) missing.push("FEISHU_TARGET_CHAT_ID");
  return missing;
}

export async function createFeishuClient({ config = getFeishuConfig(), fetchImpl = fetch } = {}) {
  return {
    async findRecentMessageContaining({ text, limit = 200 }) {
      const missing = validateFeishuConfig(config);
      if (missing.length) {
        throw new Error(`Missing Feishu configuration: ${missing.join(", ")}`);
      }
      const tenantAccessToken = await fetchTenantAccessToken({ config, fetchImpl });
      return findRecentFeishuMessageContaining({ config, fetchImpl, tenantAccessToken, text, limit });
    },
    async sendMessage({ msgType, payload, uuid }) {
      const missing = validateFeishuConfig(config);
      if (missing.length) {
        throw new Error(`Missing Feishu configuration: ${missing.join(", ")}`);
      }

      const tenantAccessToken = await fetchTenantAccessToken({ config, fetchImpl });
      return sendFeishuMessage({
        config,
        fetchImpl,
        tenantAccessToken,
        msgType,
        payload,
        uuid
      });
    }
  };
}

function envToken(value) {
  return String(value).replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_+|_+$/g, "").toUpperCase();
}

async function fetchTenantAccessToken({ config, fetchImpl }) {
  const response = await fetchImpl(`${config.baseUrl}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: "POST",
    headers: {
      "content-type": "application/json; charset=utf-8"
    },
    body: JSON.stringify({
      app_id: config.appId,
      app_secret: config.appSecret
    })
  });
  const body = await response.json();
  if (!response.ok || body.code !== 0 || !body.tenant_access_token) {
    throw new Error(`Feishu token request failed: ${body.msg || response.status}`);
  }
  return body.tenant_access_token;
}

async function sendFeishuMessage({ config, fetchImpl, tenantAccessToken, msgType, payload, uuid }) {
  const response = await fetchImpl(`${config.baseUrl}/open-apis/im/v1/messages?receive_id_type=chat_id`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${tenantAccessToken}`,
      "content-type": "application/json; charset=utf-8"
    },
    body: JSON.stringify({
      receive_id: config.targetChatId,
      msg_type: msgType,
      content: JSON.stringify(payload),
      uuid
    })
  });
  const body = await response.json();
  if (!response.ok || body.code !== 0) {
    throw new Error(`Feishu message send failed: ${body.msg || response.status}`);
  }
  return {
    ok: true,
    messageId: body.data?.message_id || null,
    raw: body.data || null
  };
}

export async function findRecentFeishuMessageContaining({ config, fetchImpl, tenantAccessToken, text, limit = 200 }) {
  let pageToken = "";
  let scanned = 0;
  do {
    const url = new URL(`${config.baseUrl}/open-apis/im/v1/messages`);
    url.searchParams.set("container_id_type", "chat");
    url.searchParams.set("container_id", config.targetChatId);
    url.searchParams.set("page_size", String(Math.min(limit - scanned, 50)));
    if (pageToken) url.searchParams.set("page_token", pageToken);
    const response = await fetchImpl(url, {
      method: "GET",
      headers: { authorization: `Bearer ${tenantAccessToken}` }
    });
    const body = await response.json();
    if (!response.ok || body.code !== 0) {
      throw new Error(`Feishu message list failed: ${body.msg || response.status}`);
    }
    const items = body.data?.items || [];
    scanned += items.length;
    const match = items.find((item) => {
      if (item.deleted) return false;
      return String(item.body?.content || item.content || "").includes(text);
    });
    if (match) return match;
    pageToken = body.data?.has_more ? body.data?.page_token || "" : "";
  } while (pageToken && scanned < limit);
  return null;
}
