#!/usr/bin/env node

import { getJobFeishuConfig, validateJobFeishuConfig } from "../src/feishuClient.js";

const provider = process.env.FUND_ANALYSIS_PROVIDER || (process.env.OPENROUTER_API_KEY ? "openrouter" : "openai");
const jobConfig = getJobFeishuConfig("fund-portfolio-daily");
const missing = validateJobFeishuConfig(jobConfig);

console.log(JSON.stringify({
  gates: {
    liveSendEnabled: process.env.LIVE_SEND_ENABLED === "true",
    fundPortfolioEnabled: process.env.FUND_PORTFOLIO_ENABLED === "true"
  },
  analysis: {
    providerOpenAi: provider === "openai",
    providerOpenRouter: provider === "openrouter",
    providerSupported: ["openai", "openrouter"].includes(provider),
    hasFundAnalysisKey: provider === "openrouter"
      ? Boolean(process.env.OPENROUTER_API_KEY)
      : Boolean(process.env.OPENAI_API_KEY),
    hasFundAnalysisModel: Boolean(process.env.FUND_ANALYSIS_MODEL)
  },
  identity: {
    configured: missing.length === 0,
    hasBotRole: Boolean(jobConfig.botRole),
    hasConnectionRef: Boolean(jobConfig.connectionRef),
    hasTargetChat: Boolean(jobConfig.config.targetChatId),
    hasAppId: Boolean(jobConfig.config.appId),
    hasAppSecret: Boolean(jobConfig.config.appSecret),
    missingBotRole: missing.includes("bot_role"),
    missingConnectionRef: missing.includes("connection_ref"),
    missingTargetChat: missing.includes("target_chat_id"),
    missingAppId: missing.includes("app_id"),
    missingAppSecret: missing.includes("app_secret")
  }
}, null, 2));
