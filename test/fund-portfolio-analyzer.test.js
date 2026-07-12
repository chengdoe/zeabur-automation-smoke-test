import assert from "node:assert/strict";
import { test } from "node:test";

import { buildFundAnalysisPrompt, createFundPortfolioAnalyzer } from "../src/jobs/fundPortfolioAnalyzer.js";

test("fund analyzer sends preserved v8 context to the Responses API", async () => {
  let request;
  const analyzer = createFundPortfolioAnalyzer({
    apiKey: "test-key",
    model: "test-model",
    fetchImpl: async (url, options) => {
      request = { url, options, body: JSON.parse(options.body) };
      return {
        ok: true,
        async json() {
          return { output_text: "# 基金日报\n\n## 今日结论\n今天不操作" };
        }
      };
    }
  });

  const output = await analyzer({
    date: "2026-07-13",
    rawData: { data_quality: { overall_score: 9 } },
    portfolioState: { v8_opportunities: { dip_candidates: [] } },
    portfolio: { portfolio: [] },
    basketConfig: { global_constraints: { qdii_max_pct: 40 } },
    scoringConfig: { version: "7.0" }
  });

  assert.match(request.url, /\/v1\/responses$/);
  assert.equal(request.body.model, "test-model");
  assert.deepEqual(request.body.tools, [{ type: "web_search" }]);
  assert.match(request.body.input, /v8\.0 机会层/);
  assert.match(request.body.input, /风险提示和下一步盯什么/);
  assert.match(request.body.input, /2026-07-13/);
  assert.match(output, /今日结论/);
});

test("fund analyzer fails closed when credentials are missing", async () => {
  const analyzer = createFundPortfolioAnalyzer({ apiKey: "", model: "" });
  await assert.rejects(() => analyzer({}), /OPENAI_API_KEY/);
});

test("fund analyzer supports OpenRouter with Claude and server-side web search", async () => {
  let request;
  const analyzer = createFundPortfolioAnalyzer({
    provider: "openrouter",
    apiKey: "openrouter-test-key",
    model: "anthropic/claude-opus-4.8",
    fetchImpl: async (url, options) => {
      request = { url, options, body: JSON.parse(options.body) };
      return {
        ok: true,
        async json() {
          return {
            choices: [{ message: { content: "## 今日结论\n今天不操作" } }]
          };
        }
      };
    }
  });

  const output = await analyzer({ date: "2026-07-13" });

  assert.equal(request.url, "https://openrouter.ai/api/v1/chat/completions");
  assert.equal(request.body.model, "anthropic/claude-opus-4.8");
  assert.deepEqual(request.body.tools, [{
    type: "openrouter:web_search",
    parameters: { max_results: 5 }
  }]);
  assert.equal(request.body.messages[0].role, "user");
  assert.equal(request.options.headers["x-openrouter-title"], "Kane Fund Portfolio Daily");
  assert.match(output, /今日结论/);
});

test("OpenRouter analyzer fails closed without OPENROUTER_API_KEY", async () => {
  const analyzer = createFundPortfolioAnalyzer({
    provider: "openrouter",
    apiKey: "",
    model: "anthropic/claude-opus-4.8"
  });
  await assert.rejects(() => analyzer({}), /OPENROUTER_API_KEY/);
});

test("fund analysis prompt isolates realtime estimates from historical NAV movers", () => {
  const prompt = buildFundAnalysisPrompt({
    date: "2026-07-10",
    currentDate: "2026-07-12",
    rawData: {
      market_data: {
        fund_realtime: {
          "012922": { name: "全球成长", estimated_change_pct: 1.25 }
        },
        analytics: {
          significant_movers: [{ code: "012922", daily_change: 4.59 }]
        }
      }
    },
    portfolio: { cash_in_yue_bao: 3298.53, update_date: "2026-06-26" }
  });

  assert.match(prompt, /迁移回放预览/);
  assert.match(prompt, /estimated_change_pct/);
  assert.match(prompt, /1\.25/);
  assert.doesNotMatch(prompt, /"significant_movers"/);
  assert.doesNotMatch(prompt, /4\.59/);
  assert.match(prompt, /2026-06-26/);
});
