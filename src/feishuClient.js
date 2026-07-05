const FEISHU_BASE_URL = "https://open.feishu.cn";

export function getFeishuConfig(env = process.env) {
  return {
    appId: env.FEISHU_APP_ID || "",
    appSecret: env.FEISHU_APP_SECRET || "",
    targetChatId: env.FEISHU_TARGET_CHAT_ID || "",
    baseUrl: env.FEISHU_BASE_URL || FEISHU_BASE_URL
  };
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
