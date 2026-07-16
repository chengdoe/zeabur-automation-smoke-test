import { shanghaiDateString } from "../date.js";

const RESPONSES_URL = "https://api.openai.com/v1/responses";
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const JSON_CONTENT_TYPE = /(?:^|\/)json(?:;|$)|\+json(?:;|$)/i;
const HTML_PREFIX = /^\s*(?:<!doctype\s+html|<html|<head|<body)/i;

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class FundAnalysisError extends Error {
  constructor({ provider, status = null, responseType = "unknown", attempt = 1, errorClass, retryable = false, safeSummary = "" }) {
    const statusText = status ?? "unknown";
    const summaryText = safeSummary ? ` summary="${safeSummary}"` : "";
    super(`Fund analysis ${provider} failed: ${errorClass} status=${statusText} response_type=${responseType} attempt=${attempt}${summaryText}`);
    this.name = "FundAnalysisError";
    this.provider = provider;
    this.status = status;
    this.responseType = responseType;
    this.attempt = attempt;
    this.errorClass = errorClass;
    this.retryable = retryable;
    this.safeSummary = safeSummary;
  }
}

export function createFundPortfolioAnalyzer({
  provider = process.env.FUND_ANALYSIS_PROVIDER || (process.env.OPENROUTER_API_KEY ? "openrouter" : "openai"),
  apiKey,
  model = process.env.FUND_ANALYSIS_MODEL || "",
  fetchImpl = fetch,
  timeoutMs = 45_000,
  maxAttempts = 3,
  baseDelayMs = 500,
  sleep = defaultSleep,
  random = Math.random
} = {}) {
  return async function analyzeFundPortfolio(context = {}) {
    const resolvedApiKey = apiKey ?? (
      provider === "openrouter" ? process.env.OPENROUTER_API_KEY : process.env.OPENAI_API_KEY
    ) ?? "";
    const requiredKey = provider === "openrouter" ? "OPENROUTER_API_KEY" : "OPENAI_API_KEY";
    if (!resolvedApiKey || !model) {
      throw new FundAnalysisError({
        provider,
        errorClass: "model_configuration_error",
        retryable: false,
        safeSummary: `${requiredKey} and FUND_ANALYSIS_MODEL are required`
      });
    }

    if (!["openai", "openrouter"].includes(provider)) {
      throw new FundAnalysisError({
        provider,
        errorClass: "model_configuration_error",
        retryable: false,
        safeSummary: "unsupported provider"
      });
    }

    const prompt = buildFundAnalysisPrompt(context);
    const request = provider === "openrouter"
      ? buildOpenRouterRequest({ apiKey: resolvedApiKey, model, prompt })
      : buildOpenAiRequest({ apiKey: resolvedApiKey, model, prompt });

    return requestWithRetry({
      provider,
      request,
      fetchImpl,
      timeoutMs,
      maxAttempts,
      baseDelayMs,
      sleep,
      random
    });
  };
}

function buildOpenAiRequest({ apiKey, model, prompt }) {
  return {
    url: RESPONSES_URL,
    options: {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({ model, tools: [{ type: "web_search" }], input: prompt })
    },
    extract: (body) => body.output_text || extractOutputText(body.output)
  };
}

function buildOpenRouterRequest({ apiKey, model, prompt }) {
  return {
    url: OPENROUTER_URL,
    options: {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
      "x-openrouter-title": "Kane Fund Portfolio Daily"
    },
    body: JSON.stringify({
      model,
        messages: [{ role: "user", content: prompt }],
      tools: [{
        type: "openrouter:web_search",
        parameters: { max_results: 5 }
      }]
    })
    },
    extract: (body) => body?.choices?.[0]?.message?.content
  };
}

async function requestWithRetry({ provider, request, fetchImpl, timeoutMs, maxAttempts, baseDelayMs, sleep, random }) {
  const configuredAttempts = Math.floor(maxAttempts);
  const attempts = Number.isFinite(configuredAttempts) ? Math.max(1, configuredAttempts) : 3;
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await requestOnce({ provider, request, fetchImpl, timeoutMs, attempt });
    } catch (error) {
      lastError = normalizeRequestError(error, { provider, attempt });
      if (!lastError.retryable || attempt >= attempts) throw lastError;
      const exponential = baseDelayMs * (2 ** (attempt - 1));
      const jitter = Math.max(0, random()) * baseDelayMs;
      await sleep(Math.min(10_000, exponential + jitter));
    }
  }
  throw lastError;
}

async function requestOnce({ provider, request, fetchImpl, timeoutMs, attempt }) {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  let response;
  let text;
  try {
    response = await fetchImpl(request.url, { ...request.options, signal: controller.signal });
    text = await response.text();
  } catch (error) {
    if (timedOut || error?.name === "AbortError" || error?.name === "TimeoutError") {
      throw new FundAnalysisError({ provider, attempt, errorClass: "model_timeout", retryable: true, safeSummary: "request timed out" });
    }
    throw new FundAnalysisError({ provider, attempt, errorClass: "model_network_error", retryable: true, safeSummary: "network request failed" });
  } finally {
    clearTimeout(timer);
  }

  const status = Number.isFinite(response.status) ? response.status : null;
  const contentType = response.headers?.get?.("content-type")?.split(";", 1)[0]?.trim().toLowerCase() || "unknown";
  const htmlLike = HTML_PREFIX.test(text);
  const jsonLike = JSON_CONTENT_TYPE.test(contentType);
  const retryableStatus = isRetryableStatus(status);
  if (htmlLike || !jsonLike) {
    throw new FundAnalysisError({
      provider,
      status,
      responseType: htmlLike ? "text/html" : contentType,
      attempt,
      errorClass: "model_non_json_response",
      retryable: retryableStatus,
      safeSummary: redactSummary(text)
    });
  }

  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new FundAnalysisError({
      provider,
      status,
      responseType: contentType,
      attempt,
      errorClass: "model_malformed_json",
      retryable: false,
      safeSummary: "invalid JSON response"
    });
  }

  if (!response.ok) {
    throw new FundAnalysisError({
      provider,
      status,
      responseType: contentType,
      attempt,
      errorClass: "model_http_status",
      retryable: retryableStatus,
      safeSummary: redactSummary(body?.error?.message || `HTTP ${status ?? "unknown"}`)
    });
  }

  const outputText = request.extract(body);
  if (typeof outputText !== "string" || !outputText.trim()) {
    throw new FundAnalysisError({
      provider,
      status,
      responseType: contentType,
      attempt,
      errorClass: "model_empty_output",
      retryable: false,
      safeSummary: "model output was empty"
    });
  }
  return stripMarkdownFence(outputText);
}

function normalizeRequestError(error, { provider, attempt }) {
  if (error instanceof FundAnalysisError) return error;
  return new FundAnalysisError({
    provider,
    attempt,
    errorClass: "model_network_error",
    retryable: true,
    safeSummary: "network request failed"
  });
}

function isRetryableStatus(status) {
  return [408, 425, 429].includes(status) || (status >= 500 && status <= 599);
}

export function redactSummary(value, maxLength = 300) {
  const redacted = String(value || "")
    .replace(/Bearer\s+[^\s"'<>]+/gi, "Bearer [REDACTED]")
    .replace(/\b(?:sk|key)-[A-Za-z0-9_-]{8,}\b/gi, "[REDACTED]")
    .replace(/\b[A-Fa-f0-9]{32,}\b/g, "[REDACTED]")
    .replace(/\b[A-Za-z0-9+/_=-]{40,}\b/g, "[REDACTED]")
    .replace(/\s+/g, " ")
    .trim();
  return redacted.length > maxLength ? `${redacted.slice(0, maxLength - 3)}...` : redacted;
}

export function buildFundAnalysisPrompt({
  date,
  rawData,
  portfolioState,
  portfolio,
  basketConfig,
  scoringConfig,
  currentDate = shanghaiDateString()
}) {
  const isReplay = Boolean(date && currentDate && date < currentDate);
  const analysisData = buildAnalysisData(rawData);
  const replayRules = isReplay ? `
- 这是迁移回放预览，不发送、不执行交易、不构成交易指令。标题后第一行必须原样写：> 迁移回放预览，不发送，不执行交易。
- 历史回放中的动作只能写成“当日规则会提示复核/观察”，不得写“必做”“必须买入”“必须卖出”或让用户现在补做历史交易。` : "";

  return `你是 Kane 的基金组合纪律执行助手。请基于输入数据生成 ${date} 的完整中文 Markdown 日报。

原则：
- 资本保全优先，不是自由发挥的荐基文章。
- 只能引用输入中的数据；缺失数据必须明确写缺失，禁止编造行情、新闻、收益、评分或触发条件。
- 可使用网页搜索补齐当天指数、宏观、海外市场和新闻，但必须优先官方或可靠财经来源；无法核实就写缺失，不得猜测。
- 网页搜索只能补充市场背景，不能覆盖输入中的持仓金额、成本、状态机或方法论约束。
- 方法论优先于主观感觉；买卖评分、篮子硬约束、每周操作上限和数据质量门禁必须执行。
- v8.0 机会层必须读取 v8_opportunities，低吸、回补、止盈、定投倍率和海外基金隔夜择时都要逐项说明，没有机会也必须明确写“没有”。
- 使用全中文人话。除基金代码外，不展示内部英文变量、代码名或组件自检。
- 真实买卖仅能作为建议，不得写成用户已经执行。
- “今日持仓涨跌”的唯一依据是【今日实时估值口径】中的 estimated_change_pct；禁止把历史净值变化、持有收益率或 significant_movers 当成今日涨跌。
- 持仓金额、余额宝金额和收益率必须同时标注持仓配置的更新时间；快照不是当天时只能称为“旧快照参考”，不得表述为当前准确余额。
- 输入缺少指数、宏观或实时估值时，数据置信度只能写“中等”或“偏低”，不能写“正常/充分”。
- 所有操作结论都必须保留用户确认权；不得使用“必做确定性动作”等命令式交易语言。${replayRules}
- 输出纯 Markdown，不要代码围栏，不要前言或解释。

以下 section 必须全部保留且按顺序输出：
# 基金日报 ${date}
## 今日结论
## 今天怎么做
## 今天系统帮你盯到的机会
## v8.0 机会层
## 市场情况
## 精简市场总结
## 持仓今天表现
## 为什么今天这个结论
## 方法论评分
## 仓位分布
## 催化剂提醒
## 风险关注
## 风险提示和下一步盯什么
## 一句话心得

输入数据：

【当日原始数据】
${JSON.stringify(analysisData)}

【今日实时估值口径（今日持仓涨跌唯一来源）】
${JSON.stringify(analysisData?.market_data?.fund_realtime || {})}

【v7/v8 组合状态】
${JSON.stringify(portfolioState ?? null)}

【持仓配置】
${JSON.stringify(portfolio ?? null)}

【篮子与硬约束】
${JSON.stringify(basketConfig ?? null)}

【评分方法】
${JSON.stringify(scoringConfig ?? null)}
`;
}

function buildAnalysisData(rawData) {
  if (!rawData || typeof rawData !== "object") return rawData ?? null;
  const cloned = structuredClone(rawData);
  if (cloned?.market_data?.analytics) {
    delete cloned.market_data.analytics.significant_movers;
  }
  return cloned;
}

function extractOutputText(output) {
  if (!Array.isArray(output)) return "";
  return output.flatMap((item) => item?.content || [])
    .filter((item) => item?.type === "output_text")
    .map((item) => item.text || "")
    .join("\n");
}

function stripMarkdownFence(text) {
  return text.trim()
    .replace(/^```(?:markdown|md)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
}
