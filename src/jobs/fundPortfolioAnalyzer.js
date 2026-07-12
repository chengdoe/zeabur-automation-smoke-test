const RESPONSES_URL = "https://api.openai.com/v1/responses";
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

export function createFundPortfolioAnalyzer({
  provider = process.env.FUND_ANALYSIS_PROVIDER || (process.env.OPENROUTER_API_KEY ? "openrouter" : "openai"),
  apiKey,
  model = process.env.FUND_ANALYSIS_MODEL || "",
  fetchImpl = fetch
} = {}) {
  return async function analyzeFundPortfolio(context = {}) {
    const resolvedApiKey = apiKey ?? (
      provider === "openrouter" ? process.env.OPENROUTER_API_KEY : process.env.OPENAI_API_KEY
    ) ?? "";
    const requiredKey = provider === "openrouter" ? "OPENROUTER_API_KEY" : "OPENAI_API_KEY";
    if (!resolvedApiKey || !model) {
      throw new Error(`${requiredKey} and FUND_ANALYSIS_MODEL are required for fresh fund analysis`);
    }

    if (provider === "openrouter") {
      return analyzeWithOpenRouter({
        apiKey: resolvedApiKey,
        model,
        context,
        fetchImpl
      });
    }
    if (provider !== "openai") {
      throw new Error(`Unsupported fund analysis provider: ${provider}`);
    }

    const response = await fetchImpl(RESPONSES_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${resolvedApiKey}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model,
        tools: [{ type: "web_search" }],
        input: buildFundAnalysisPrompt(context)
      })
    });
    const body = await response.json();
    if (!response.ok) {
      throw new Error(`Fund analysis request failed (${response.status || "unknown"}): ${body?.error?.message || "unknown error"}`);
    }
    const outputText = body.output_text || extractOutputText(body.output);
    if (!outputText?.trim()) {
      throw new Error("Fund analysis returned empty output");
    }
    return stripMarkdownFence(outputText);
  };
}

async function analyzeWithOpenRouter({ apiKey, model, context, fetchImpl }) {
  const response = await fetchImpl(OPENROUTER_URL, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
      "x-openrouter-title": "Kane Fund Portfolio Daily"
    },
    body: JSON.stringify({
      model,
      messages: [{
        role: "user",
        content: buildFundAnalysisPrompt(context)
      }],
      tools: [{
        type: "openrouter:web_search",
        parameters: { max_results: 5 }
      }]
    })
  });
  const body = await response.json();
  if (!response.ok) {
    throw new Error(`Fund analysis request failed (${response.status || "unknown"}): ${body?.error?.message || "unknown error"}`);
  }
  const outputText = body?.choices?.[0]?.message?.content;
  if (!outputText?.trim()) {
    throw new Error("Fund analysis returned empty output");
  }
  return stripMarkdownFence(outputText);
}

export function buildFundAnalysisPrompt({
  date,
  rawData,
  portfolioState,
  portfolio,
  basketConfig,
  scoringConfig
}) {
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
${JSON.stringify(rawData)}

【v7/v8 组合状态】
${JSON.stringify(portfolioState)}

【持仓配置】
${JSON.stringify(portfolio)}

【篮子与硬约束】
${JSON.stringify(basketConfig)}

【评分方法】
${JSON.stringify(scoringConfig)}
`;
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
