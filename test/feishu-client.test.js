import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createFeishuClient,
  findRecentFeishuMessageContaining,
  getJobFeishuConfig
} from "../src/feishuClient.js";

test("job Feishu config supports an open_id private recipient without changing other jobs", () => {
  const result = getJobFeishuConfig("sop13", {
    SOP13_BOT_ROLE: "aheng_agent",
    SOP13_CONNECTION_REF: "aheng_agent",
    SOP13_RECEIVE_ID_TYPE: "open_id",
    SOP13_TARGET_RECEIVE_ID: "ou_kane_fixture",
    FEISHU_CONNECTION_AHENG_AGENT_APP_ID: "cli_fixture",
    FEISHU_CONNECTION_AHENG_AGENT_APP_SECRET: "fixture-secret"
  });

  assert.equal(result.config.receiveIdType, "open_id");
  assert.equal(result.config.targetReceiveId, "ou_kane_fixture");
  assert.equal(result.config.targetChatId, "");
});

test("Feishu client sends a private message with receive_id_type=open_id", async () => {
  const requests = [];
  const client = await createFeishuClient({
    config: {
      baseUrl: "https://open.feishu.cn",
      appId: "cli_fixture",
      appSecret: "fixture-secret",
      targetChatId: "",
      receiveIdType: "open_id",
      targetReceiveId: "ou_kane_fixture"
    },
    fetchImpl: async (url, options) => {
      requests.push({ url: String(url), body: options.body });
      if (String(url).includes("tenant_access_token")) {
        return { ok: true, async json() { return { code: 0, tenant_access_token: "token" }; } };
      }
      return { ok: true, async json() { return { code: 0, data: { message_id: "om_private" } }; } };
    }
  });

  const result = await client.sendMessage({
    msgType: "post",
    payload: { zh_cn: { title: "", content: [] } },
    uuid: "fixture"
  });

  assert.equal(result.messageId, "om_private");
  assert.match(requests[1].url, /receive_id_type=open_id/);
  assert.equal(JSON.parse(requests[1].body).receive_id, "ou_kane_fixture");
});

test("Feishu duplicate scan follows pagination within its bound", async () => {
  const requestedTokens = [];
  const requestedSortTypes = [];
  const fetchImpl = async (url) => {
    const parsed = new URL(url);
    const token = parsed.searchParams.get("page_token") || "";
    requestedTokens.push(token);
    requestedSortTypes.push(parsed.searchParams.get("sort_type"));
    const secondPage = token === "next-page";
    return {
      ok: true,
      async json() {
        return {
          code: 0,
          data: secondPage
            ? { has_more: false, items: [{ message_id: "om_vol_151", body: { content: "Wisereads Vol. 151" } }] }
            : { has_more: true, page_token: "next-page", items: [{ message_id: "om_other", body: { content: "other" } }] }
        };
      }
    };
  };

  const match = await findRecentFeishuMessageContaining({
    config: { baseUrl: "https://open.feishu.cn", targetChatId: "oc_test" },
    fetchImpl,
    tenantAccessToken: "token",
    text: "Wisereads Vol. 151",
    limit: 100
  });

  assert.deepEqual(requestedTokens, ["", "next-page"]);
  assert.deepEqual(requestedSortTypes, ["ByCreateTimeDesc", "ByCreateTimeDesc"]);
  assert.equal(match.message_id, "om_vol_151");
});
