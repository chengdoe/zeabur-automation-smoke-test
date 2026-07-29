import assert from "node:assert/strict";
import { test } from "node:test";

import { findRecentFeishuMessageContaining } from "../src/feishuClient.js";

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
