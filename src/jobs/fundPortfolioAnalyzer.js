import { shanghaiDateString } from "../date.js";

const RESPONSES_URL = "https://api.openai.com/v1/responses";
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const JSON_CONTENT_TYPE = /(?:^|\/)json(?:;|$)|\+json(?:;|$)/i;
const HTML_PREFIX = /^\s*(?:<!doctype\s+html|<html|<head|<body)/i;

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class FundAnalysisError extends Error {
  constructor({ provider, status = null, responseType = "unknown", attempt = 1, errorClass, retryable = false, safeSummary = "", remoteStateUnknown = false, requestId = null, generationId = null, durationMs = null }) {
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
    this.remoteStateUnknown = remoteStateUnknown;
    this.requestId = requestId;
    this.generationId = generationId;
    this.durationMs = durationMs;
  }
}

export function createFundPortfolioAnalyzer({
  provider = process.env.FUND_ANALYSIS_PROVIDER || (process.env.OPENROUTER_API_KEY ? "openrouter" : "openai"),
  apiKey,
  model = process.env.FUND_ANALYSIS_MODEL || "",
  fetchImpl = fetch,
  timeoutMs = 180_000,
  maxAttempts = 1,
  baseDelayMs = 500,
  maxOutputTokens = Number(process.env.FUND_ANALYSIS_MAX_OUTPUT_TOKENS || 8000),
  reasoningEffort = process.env.FUND_ANALYSIS_REASONING_EFFORT || "low",
  webSearchMaxResults = Number(process.env.FUND_ANALYSIS_WEB_SEARCH_MAX_RESULTS || 3),
  webSearchMaxTotalResults = Number(process.env.FUND_ANALYSIS_WEB_SEARCH_MAX_TOTAL_RESULTS || 6),
  webSearchMaxCharacters = Number(process.env.FUND_ANALYSIS_WEB_SEARCH_MAX_CHARACTERS || 6000),
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
    const audit = context._modelGovernance || {};
    const request = provider === "openrouter"
      ? buildOpenRouterRequest({ apiKey: resolvedApiKey, model, prompt, maxOutputTokens, reasoningEffort, webSearchMaxResults, webSearchMaxTotalResults, webSearchMaxCharacters })
      : buildOpenAiRequest({ apiKey: resolvedApiKey, model, prompt, maxOutputTokens, reasoningEffort, webSearchMaxResults, webSearchMaxTotalResults, webSearchMaxCharacters });

    return requestWithRetry({
      provider,
      model,
      request,
      fetchImpl,
      timeoutMs,
      maxAttempts,
      baseDelayMs,
      sleep,
      random,
      audit
    });
  };
}

function buildOpenAiRequest({ apiKey, model, prompt, maxOutputTokens, reasoningEffort, webSearchMaxResults }) {
  return {
    url: RESPONSES_URL,
    options: {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model,
        tools: [{ type: "web_search", search_context_size: "low", max_results: webSearchMaxResults }],
        input: prompt,
        max_output_tokens: maxOutputTokens,
        reasoning: { effort: reasoningEffort }
      })
    },
    extract: (body) => body.output_text || extractOutputText(body.output),
    metadata: (body, response) => extractResponseMetadata({ provider: "openai", body, response })
  };
}

function buildOpenRouterRequest({ apiKey, model, prompt, maxOutputTokens, reasoningEffort, webSearchMaxResults, webSearchMaxTotalResults, webSearchMaxCharacters }) {
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
      max_tokens: maxOutputTokens,
      reasoning: { effort: reasoningEffort },
      tools: [{
        type: "openrouter:web_search",
        parameters: {
          max_results: webSearchMaxResults,
          max_total_results: webSearchMaxTotalResults,
          max_characters: webSearchMaxCharacters
        }
      }]
    })
    },
    extract: (body) => body?.choices?.[0]?.message?.content,
    metadata: (body, response) => extractResponseMetadata({ provider: "openrouter", body, response })
  };
}

async function requestWithRetry({ provider, model, request, fetchImpl, timeoutMs, maxAttempts, baseDelayMs, sleep, random, audit = {} }) {
  const configuredAttempts = Math.floor(maxAttempts);
  const attempts = Number.isFinite(configuredAttempts) ? Math.max(1, configuredAttempts) : 1;
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await audit.onAttemptStart?.({ provider, model, attempt });
      const result = await requestOnce({ provider, model, request, fetchImpl, timeoutMs, attempt });
      await audit.onAttemptTerminal?.({
        provider,
        model,
        attempt,
        ...result.audit,
        terminal_state: "response_received",
        error_class: null,
        retryable: false,
        remote_state_unknown: false
      });
      await audit.onResponse?.({ provider, model, attempt, text: result.text, ...result.audit });
      return result.text;
    } catch (error) {
      lastError = normalizeRequestError(error, { provider, attempt });
      await audit.onAttemptTerminal?.({
        provider,
        model,
        attempt,
        status: lastError.status,
        responseType: lastError.responseType,
        duration_ms: lastError.durationMs,
        request_id: lastError.requestId,
        generation_id: lastError.generationId,
        terminal_state: terminalStateForError(lastError),
        error_class: lastError.errorClass,
        retryable: lastError.retryable,
        remote_state_unknown: lastError.remoteStateUnknown,
        safe_summary: lastError.safeSummary
      });
      if (!lastError.retryable || attempt >= attempts) throw lastError;
      const exponential = baseDelayMs * (2 ** (attempt - 1));
      const jitter = Math.max(0, random()) * baseDelayMs;
      await sleep(Math.min(10_000, exponential + jitter));
    }
  }
  throw lastError;
}

async function requestOnce({ provider, model, request, fetchImpl, timeoutMs, attempt }) {
  const controller = new AbortController();
  let timedOut = false;
  const started = Date.now();
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
    const durationMs = Date.now() - started;
    if (timedOut || error?.name === "AbortError" || error?.name === "TimeoutError") {
      throw new FundAnalysisError({ provider, attempt, errorClass: "remote_state_unknown", retryable: false, safeSummary: "request timed out; remote generation state unknown", remoteStateUnknown: true, durationMs });
    }
    throw new FundAnalysisError({ provider, attempt, errorClass: "model_network_error", retryable: true, safeSummary: "network request failed before response", durationMs });
  } finally {
    clearTimeout(timer);
  }

  const durationMs = Date.now() - started;
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
      safeSummary: redactSummary(text),
      durationMs
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
      safeSummary: "invalid JSON response",
      durationMs
    });
  }
  const metadata = request.metadata?.(body, response) || {};

  if (!response.ok) {
    throw new FundAnalysisError({
      provider,
      status,
      responseType: contentType,
      attempt,
      errorClass: "model_http_status",
      retryable: retryableStatus,
      safeSummary: redactSummary(body?.error?.message || `HTTP ${status ?? "unknown"}`),
      requestId: metadata.request_id,
      generationId: metadata.generation_id,
      durationMs
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
      safeSummary: "model output was empty",
      requestId: metadata.request_id,
      generationId: metadata.generation_id,
      durationMs
    });
  }
  return {
    text: stripMarkdownFence(outputText),
    audit: {
      status,
      responseType: contentType,
      duration_ms: durationMs,
      request_id: metadata.request_id,
      generation_id: metadata.generation_id,
      provider_status: metadata.provider_status,
      usage: metadata.usage,
      cost: metadata.cost
    }
  };
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

function terminalStateForError(error) {
  if (error.remoteStateUnknown) return "remote_state_unknown";
  if (error.retryable) return "pre_generation_retryable_failure";
  return "failed";
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
  const analysisData = compactForPrompt(buildAnalysisData(rawData));
  const compactPortfolio = compactForPrompt(portfolio);
  const compactBasketConfig = compactForPrompt(basketConfig);
  const compactScoringConfig = compactForPrompt(scoringConfig);
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

【v7/v8 组合状态】
${JSON.stringify(compactForPrompt(portfolioState))}

【持仓配置摘要】
${JSON.stringify({ summary: compactPortfolio, source_hash: hashSource(portfolio) })}

【篮子与硬约束摘要】
${JSON.stringify({ summary: compactBasketConfig, source_hash: hashSource(basketConfig) })}

【评分方法摘要】
${JSON.stringify({ summary: compactScoringConfig, source_hash: hashSource(scoringConfig) })}
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

export function estimatePromptBudget({ beforePrompt, afterPrompt }) {
  const beforeChars = Array.from(String(beforePrompt || "")).length;
  const afterChars = Array.from(String(afterPrompt || "")).length;
  return {
    before_chars: beforeChars,
    after_chars: afterChars,
    reduction_chars: beforeChars - afterChars,
    reduction_pct: beforeChars ? Number((((beforeChars - afterChars) / beforeChars) * 100).toFixed(2)) : 0,
    before_token_estimate: estimateTokens(beforePrompt),
    after_token_estimate: estimateTokens(afterPrompt)
  };
}

function compactForPrompt(value, depth = 0) {
  if (value === null || value === undefined) return value ?? null;
  if (typeof value === "string") return value.length > 600 ? `${value.slice(0, 600)}…[truncated ${value.length}; source_hash=${createTextHash(value)}]` : value;
  if (typeof value !== "object") return value;
  if (depth >= 6) return { _truncated: true, source_hash: hashSource(value) };
  if (Array.isArray(value)) {
    const limit = depth <= 2 ? 12 : 6;
    const items = value.slice(0, limit).map((item) => compactForPrompt(item, depth + 1));
    if (value.length > limit) items.push({ _truncated_items: value.length - limit, source_hash: hashSource(value) });
    return items;
  }
  const noisyKeys = new Set(["html", "raw_html", "full_text", "raw_text", "content_html", "body", "paragraphs", "documents", "debug", "stack"]);
  const summarizedKeys = new Set(["content", "text", "description"]);
  const output = {};
  for (const [key, item] of Object.entries(value)) {
    if (noisyKeys.has(key)) {
      output[key] = { _omitted_for_prompt_budget: true, source_hash: hashSource(item) };
      continue;
    }
    if (summarizedKeys.has(key) && typeof item === "string" && item.length > 600) {
      output[key] = compactForPrompt(item, depth + 1);
      continue;
    }
    output[key] = compactForPrompt(item, depth + 1);
  }
  return output;
}

function hashSource(value) {
  return createTextHash(stableStringify(value ?? null));
}

function createTextHash(value) {
  let hash = 0;
  const text = String(value || "");
  for (let index = 0; index < text.length; index += 1) {
    hash = ((hash << 5) - hash + text.charCodeAt(index)) | 0;
  }
  return `hash32:${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function estimateTokens(text) {
  const chars = Array.from(String(text || "")).length;
  return {
    low: Math.ceil(chars / 4),
    high: Math.ceil(chars / 2)
  };
}

function extractResponseMetadata({ provider, body, response }) {
  const usage = normalizeUsage(provider, body?.usage || {});
  const requestId = body?.id || response.headers?.get?.("x-request-id") || response.headers?.get?.("x-openrouter-request-id") || null;
  return {
    request_id: requestId,
    generation_id: body?.id || null,
    provider_status: body?.status || body?.choices?.[0]?.finish_reason || null,
    usage,
    cost: {
      total_usd: numericOrNull(body?.usage?.cost ?? body?.usage?.total_cost ?? body?.cost)
    }
  };
}

function normalizeUsage(provider, usage = {}) {
  if (provider === "openai") {
    return {
      input_tokens: numericOrNull(usage.input_tokens),
      output_tokens: numericOrNull(usage.output_tokens),
      cached_tokens: numericOrNull(usage.input_tokens_details?.cached_tokens ?? usage.prompt_tokens_details?.cached_tokens),
      reasoning_tokens: numericOrNull(usage.output_tokens_details?.reasoning_tokens ?? usage.completion_tokens_details?.reasoning_tokens),
      tool_tokens: numericOrNull(usage.output_tokens_details?.tool_tokens),
      web_search_requests: numericOrNull(usage.web_search_requests),
      total_tokens: numericOrNull(usage.total_tokens)
    };
  }
  return {
    input_tokens: numericOrNull(usage.prompt_tokens ?? usage.input_tokens),
    output_tokens: numericOrNull(usage.completion_tokens ?? usage.output_tokens),
    cached_tokens: numericOrNull(usage.prompt_tokens_details?.cached_tokens ?? usage.cached_tokens),
    reasoning_tokens: numericOrNull(usage.completion_tokens_details?.reasoning_tokens ?? usage.reasoning_tokens),
    tool_tokens: numericOrNull(usage.tool_tokens),
    web_search_requests: numericOrNull(usage.web_search_requests ?? usage.num_search_results),
    total_tokens: numericOrNull(usage.total_tokens)
  };
}

function numericOrNull(value) {
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
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
