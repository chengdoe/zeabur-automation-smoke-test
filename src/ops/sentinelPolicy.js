export const SENTINEL_POLICY_VERSION = "sentinel-policy-v1";

const IMMEDIATE_PAUSE_ERRORS = Object.freeze([
  "remote_state_unknown",
  "daily_request_budget_reached",
  "daily_token_budget_reached",
  "daily_cost_budget_reached",
  "request_inflight_unknown",
  "state_store_unavailable"
]);

const POLICIES = Object.freeze({
  "fund-portfolio-daily": Object.freeze({
    jobId: "fund-portfolio-daily",
    risk: "high",
    paidModel: true,
    maxConsecutiveFailures: 2,
    maxDailyRequests: 2,
    maxDailyTokens: 120_000,
    maxDailyCostUsd: 1,
    pauseOnMissedSla: true,
    immediatePauseErrors: IMMEDIATE_PAUSE_ERRORS
  }),
  "wisereads-weekly": Object.freeze({
    jobId: "wisereads-weekly",
    risk: "high",
    paidModel: true,
    maxConsecutiveFailures: 2,
    maxDailyRequests: 1,
    maxDailyTokens: 80_000,
    maxDailyCostUsd: 0.75,
    pauseOnMissedSla: false,
    immediatePauseErrors: IMMEDIATE_PAUSE_ERRORS
  }),
  "ai-hot": Object.freeze({
    jobId: "ai-hot",
    risk: "medium",
    paidModel: false,
    maxConsecutiveFailures: 3,
    pauseOnMissedSla: false,
    immediatePauseErrors: Object.freeze(["state_store_unavailable"])
  }),
  "morning-motivation": Object.freeze({
    jobId: "morning-motivation",
    risk: "low",
    paidModel: false,
    maxConsecutiveFailures: 3,
    pauseOnMissedSla: false,
    immediatePauseErrors: Object.freeze(["state_store_unavailable"])
  }),
  sop13: Object.freeze({
    jobId: "sop13",
    risk: "low",
    paidModel: false,
    maxConsecutiveFailures: 3,
    pauseOnMissedSla: false,
    immediatePauseErrors: Object.freeze(["state_store_unavailable"])
  })
});

export function getSentinelRuntimeConfig(env = process.env) {
  const mode = env.SENTINEL_MODE === "auto_pause" ? "auto_pause" : "shadow";
  return {
    enabled: env.SENTINEL_ENABLED === "true",
    mode,
    alertEnabled: env.SENTINEL_FEISHU_ENABLED === "true",
    alertSendEnabled: env.SENTINEL_LIVE_SEND_ENABLED === "true",
    watchdogEnabled: env.SENTINEL_WATCHDOG_ENABLED === "true",
    alertTargetConfigured: Boolean(env.SENTINEL_TARGET_CHAT_ID || env.SENTINEL_FEISHU_CHAT_ID),
    policyVersion: SENTINEL_POLICY_VERSION
  };
}

export function getSentinelPolicy(jobId) {
  return POLICIES[jobId] || {
    jobId,
    risk: "medium",
    paidModel: false,
    maxConsecutiveFailures: 3,
    pauseOnMissedSla: false,
    immediatePauseErrors: ["state_store_unavailable"]
  };
}

export function listSentinelPolicies() {
  return Object.values(POLICIES).map((policy) => ({
    ...policy,
    policyVersion: SENTINEL_POLICY_VERSION,
    immediatePauseErrors: [...policy.immediatePauseErrors]
  }));
}

export function evaluateSentinelOutcome({ state, result, policy, mode = "shadow" }) {
  if (result?.skipped) {
    return {
      action: "none",
      nextState: state.state,
      recommendedState: state.recommended_state || null,
      consecutiveFailures: state.consecutive_failures,
      reason: result.sendSkippedReason || "skipped",
      severity: "info"
    };
  }

  if (result?.ok === true) {
    const protectedState = ["PAUSED_AUTO", "PAUSED_MANUAL", "RECOVERY_PENDING"].includes(state.state);
    return {
      action: protectedState ? "none" : "recovered",
      nextState: protectedState ? state.state : "ACTIVE",
      recommendedState: protectedState ? state.recommended_state : null,
      consecutiveFailures: protectedState ? state.consecutive_failures : 0,
      reason: protectedState ? state.state_reason : "run_succeeded",
      severity: "info"
    };
  }

  const consecutiveFailures = state.consecutive_failures + 1;
  const errorClass = result?.error_class || "run_failure";
  const pauseReasons = [];
  if (policy.immediatePauseErrors.includes(errorClass)) pauseReasons.push(errorClass);
  if (consecutiveFailures >= policy.maxConsecutiveFailures) pauseReasons.push("consecutive_failure_budget_reached");
  if (knownAtLeast(result?.request_count, policy.maxDailyRequests)) pauseReasons.push("daily_request_budget_reached");
  if (knownAtLeast(result?.total_tokens ?? result?.token_count, policy.maxDailyTokens)) pauseReasons.push("daily_token_budget_reached");
  if (knownAtLeast(result?.cost_usd, policy.maxDailyCostUsd)) pauseReasons.push("daily_cost_budget_reached");

  if (pauseReasons.length) {
    const autoPause = mode === "auto_pause";
    return {
      action: autoPause ? "paused_auto" : "shadow_pause_recommended",
      nextState: autoPause ? "PAUSED_AUTO" : "WARNING",
      recommendedState: "PAUSED_AUTO",
      consecutiveFailures,
      reason: [...new Set(pauseReasons)].join(","),
      severity: "critical"
    };
  }

  return {
    action: "warning",
    nextState: "WARNING",
    recommendedState: null,
    consecutiveFailures,
    reason: errorClass,
    severity: "warning"
  };
}

function knownAtLeast(value, threshold) {
  return Number.isFinite(Number(value)) && Number.isFinite(Number(threshold)) && Number(value) >= Number(threshold);
}
