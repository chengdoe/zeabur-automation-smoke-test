import { shanghaiDateString } from "../date.js";

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
