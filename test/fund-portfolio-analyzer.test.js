import assert from "node:assert/strict";
import { test } from "node:test";

import {
  FundAnalysisError,
  buildFundAnalysisPrompt,
  createFundPortfolioAnalyzer
} from "../src/jobs/fundPortfolioAnalyzer.js";

function response({ status = 200, contentType = "application/json", body = {} } = {}) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => name.toLowerCase() === "content-type" ? contentType : null },
    async text() { return text; }
  };
}

test("fund analyzer sends preserved v8 context to the Responses API", async () => {
  let request;
  const analyzer = createFundPortfolioAnalyzer({
    apiKey: "test-key",
    model: "test-model",
    fetchImpl: async (url, options) => {
      request = { url, options, body: JSON.parse(options.body) };
      return response({ body: { output_text: "# 基金日报\n\n## 今日结论\n今天不操作" } });
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
      return response({ body: { choices: [{ message: { content: "## 今日结论\n今天不操作" } }] } });
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

test("OpenRouter HTML 502 is structured, retryable, bounded, and redacted", async () => {
  const secret = "Bearer sk-test-super-secret-1234567890";
  const html = `<!doctype html><html><body>${secret} ${"A".repeat(800)}</body></html>`;
  let attempts = 0;
  const analyzer = createFundPortfolioAnalyzer({
    provider: "openrouter",
    apiKey: "sk-test-super-secret-1234567890",
    model: "test-model",
    maxAttempts: 2,
    sleep: async () => {},
    random: () => 0,
    fetchImpl: async () => {
      attempts += 1;
      return response({ status: 502, contentType: "text/html", body: html });
    }
  });

  await assert.rejects(analyzer({ date: "2026-07-16" }), (error) => {
    assert.ok(error instanceof FundAnalysisError);
    assert.equal(error.provider, "openrouter");
    assert.equal(error.status, 502);
    assert.equal(error.responseType, "text/html");
    assert.equal(error.attempt, 2);
    assert.equal(error.errorClass, "model_non_json_response");
    assert.equal(error.retryable, true);
    assert.ok(error.safeSummary.length <= 320);
    assert.doesNotMatch(error.message + error.safeSummary, /sk-test-super-secret|A{100}/);
    return true;
  });
  assert.equal(attempts, 2);
});

test("OpenAI HTML 200 fails closed without retry", async () => {
  let attempts = 0;
  const analyzer = createFundPortfolioAnalyzer({
    apiKey: "test-key",
    model: "test-model",
    sleep: async () => {},
    fetchImpl: async () => {
      attempts += 1;
      return response({ contentType: "text/html", body: "<!doctype html><title>gateway</title>" });
    }
  });
  await assert.rejects(analyzer({}), (error) => {
    assert.equal(error.errorClass, "model_non_json_response");
    assert.equal(error.retryable, false);
    return true;
  });
  assert.equal(attempts, 1);
});

test("OpenRouter retries 429 and returns the successful output", async () => {
  let attempts = 0;
  const analyzer = createFundPortfolioAnalyzer({
    provider: "openrouter",
    apiKey: "test-key",
    model: "test-model",
    sleep: async () => {},
    random: () => 0,
    fetchImpl: async () => {
      attempts += 1;
      return attempts === 1
        ? response({ status: 429, body: { error: { message: "busy" } } })
        : response({ body: { choices: [{ message: { content: "## 今日结论\n保持观察" } }] } });
    }
  });
  assert.match(await analyzer({}), /保持观察/);
  assert.equal(attempts, 2);
});

test("OpenAI 401 is permanent and is not retried", async () => {
  let attempts = 0;
  const analyzer = createFundPortfolioAnalyzer({
    apiKey: "test-key",
    model: "test-model",
    sleep: async () => {},
    fetchImpl: async () => {
      attempts += 1;
      return response({ status: 401, body: { error: { message: "bad key" } } });
    }
  });
  await assert.rejects(analyzer({}), (error) => {
    assert.equal(error.errorClass, "model_http_status");
    assert.equal(error.retryable, false);
    return true;
  });
  assert.equal(attempts, 1);
});

test("timeout aborts each request and retries only within the configured bound", async () => {
  let attempts = 0;
  const analyzer = createFundPortfolioAnalyzer({
    apiKey: "test-key",
    model: "test-model",
    timeoutMs: 5,
    maxAttempts: 2,
    sleep: async () => {},
    fetchImpl: async (_url, options) => {
      attempts += 1;
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () => reject(options.signal.reason));
      });
    }
  });
  await assert.rejects(analyzer({}), (error) => {
    assert.equal(error.errorClass, "model_timeout");
    assert.equal(error.attempt, 2);
    assert.equal(error.retryable, true);
    return true;
  });
  assert.equal(attempts, 2);
});

test("timeout remains active while reading the response body", async () => {
  const analyzer = createFundPortfolioAnalyzer({
    apiKey: "test-key",
    model: "test-model",
    timeoutMs: 5,
    maxAttempts: 1,
    fetchImpl: async (_url, options) => ({
      status: 200,
      ok: true,
      headers: { get: () => "application/json" },
      text: async () => new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () => reject(options.signal.reason));
      })
    })
  });
  await assert.rejects(analyzer({}), (error) => error.errorClass === "model_timeout");
});

test("malformed JSON and empty output have permanent structured classes", async () => {
  const malformed = createFundPortfolioAnalyzer({
    apiKey: "test-key",
    model: "test-model",
    fetchImpl: async () => response({ body: "{broken" })
  });
  await assert.rejects(malformed({}), (error) => error.errorClass === "model_malformed_json");

  const empty = createFundPortfolioAnalyzer({
    apiKey: "test-key",
    model: "test-model",
    fetchImpl: async () => response({ body: { output_text: "  " } })
  });
  await assert.rejects(empty({}), (error) => error.errorClass === "model_empty_output");
});
