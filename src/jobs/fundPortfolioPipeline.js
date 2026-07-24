import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { cp, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import { shanghaiDateString, weekdayForDate } from "../date.js";
import { buildFundAnalysisPrompt } from "./fundPortfolioAnalyzer.js";
import { validateFundReport } from "./fundPortfolioDaily.js";
import { getFundCostGovernanceConfig, getFundCostGovernanceStatus, recordFundModelAlert } from "./fundCostGovernance.js";
import {
  buildFundPromptHash,
  getDailyFundModelBudget,
  loadFundModelResponseArtifact,
  recordFundModelAttemptStart,
  recordFundModelAttemptTerminal,
  saveFundModelResponseArtifact,
  withFundModelRequestLock
} from "./fundModelRequestLedger.js";

const execFileAsync = promisify(execFile);
const COMMANDS = ["data_fetch_only.py", "portfolio_state_tracker.py", "v8_orchestrator.py"];
const REQUIRED_SECTIONS = [
  "今日结论",
  "今天怎么做",
  "今天系统帮你盯到的机会",
  "v8.0 机会层",
  "市场情况",
  "精简市场总结",
  "持仓今天表现",
  "为什么今天这个结论",
  "方法论评分",
  "仓位分布",
  "催化剂提醒",
  "风险关注",
  "风险提示和下一步盯什么",
  "一句话心得"
];

export async function runFundPortfolioPipeline({
  date,
  dataDir,
  analyzer,
  commandRunner = execFileAsync,
  preparedSnapshot,
  promote = false,
  scheduled = false,
  env = process.env,
  logger = console,
  replayModelArtifact,
  attempt = 1,
  runId = randomUUID()
}) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || "")) {
    throw new Error(`Invalid fund pipeline date: ${date}`);
  }
  if (typeof analyzer !== "function") {
    throw new Error("Fund pipeline analyzer is required");
  }

  const canonicalRoot = path.resolve(dataDir, "fund-portfolio-daily");
  const automationRoot = path.resolve(dataDir, "outputs", "automations", "fund-portfolio-daily");
  let phase = preparedSnapshot ? "model" : "prepare";
  let snapshotRoot = preparedSnapshot ? path.resolve(preparedSnapshot) : null;

  try {
    if (!snapshotRoot) {
      snapshotRoot = await prepareSnapshot({
        date,
        runId,
        canonicalRoot,
        automationRoot,
        commandRunner
      });
    } else {
      const manifest = await readJson(path.join(snapshotRoot, "manifest.json"));
      if (manifest.requestedDate !== date) {
        throw Object.assign(new Error("Prepared snapshot date mismatch"), {
          errorClass: "prepared_snapshot_date_mismatch",
          retryable: false
        });
      }
    }

    const context = await readPreparedContext(snapshotRoot);
    if (context.rawData.date !== date) {
      throw Object.assign(new Error("Fund raw data date mismatch"), {
        errorClass: "raw_data_date_mismatch",
        retryable: false
      });
    }

    const promptHash = buildFundPromptHash(buildFundAnalysisPrompt({ date, ...context }));
    const lockedResult = await withFundModelRequestLock({ dataDir, date, promptHash }, async () => {
      const preModelGate = replayModelArtifact
        ? null
        : await checkPreModelGate({
          dataDir,
          date,
          promptHash,
          scheduled,
          env,
          logger,
          runId,
          attempt
        });
      if (preModelGate) return preModelGate;

      phase = replayModelArtifact ? "model-replay" : "model";
      let responseArtifact = replayModelArtifact ? { markdownFile: replayModelArtifact } : null;
      const markdown = replayModelArtifact
        ? await loadFundModelResponseArtifact(replayModelArtifact)
        : await analyzer({
          date,
          ...context,
          _modelGovernance: buildModelGovernanceCallbacks({
            dataDir,
            date,
            runId,
            promptHash,
            attempt,
            setResponseArtifact: (artifact) => {
              responseArtifact = artifact;
            }
          })
        });

      if (!responseArtifact) {
        responseArtifact = await saveFundModelResponseArtifact({
          dataDir,
          date,
          runId,
          attempt,
          text: markdown,
          metadata: {
            date,
            job: "fund-portfolio-daily",
            runId,
            prompt_hash: promptHash,
            attempt,
            provider: replayModelArtifact ? "replay" : "unknown",
            model: replayModelArtifact ? "replay-artifact" : "unknown"
          }
        });
      }

      phase = "validation";
      const canonicalReport = path.join(canonicalRoot, "project", "outputs", "reports", "markdown", `fund-daily-${date}.md`);
      const validation = validateFundReport({ file: canonicalReport, markdown }, {
        isReplay: date < shanghaiDateString()
      });
      const sectionErrors = validateSectionOrder(markdown);
      if (!validation.ok || sectionErrors.length) {
        const validationErrors = [...validation.errors, ...sectionErrors];
        throw Object.assign(new Error(`Fund report validation failed: ${validationErrors.join("; ")}`), {
          errorClass: "report_validation_failure",
          retryable: false,
          validationErrors,
          promptHash,
          responseArtifact
        });
      }

      phase = promote ? "promotion" : "preview";
      const output = promote
        ? await promoteSnapshot({ date, canonicalRoot, snapshotRoot, markdown })
        : await writePreview({ date, runId, automationRoot, snapshotRoot, markdown });
      return {
        ok: true,
        job: "fundPortfolioDaily",
        date,
        dryRun: !promote,
        sent: false,
        phase: promote ? "promoted" : "validated-preview",
        attempt,
        preparedSnapshot: snapshotRoot,
        promoted: promote,
        promptHash,
        prompt_hash_suffix: promptHash.slice(-12),
        modelResponseArtifact: responseArtifact,
        ...output,
        validation: {
          ok: true,
          errors: [],
          preservedSections: REQUIRED_SECTIONS.slice(1)
        }
      };
    });
    return lockedResult;
  } catch (error) {
    const failure = classifyFailure(error, phase);
    await writeFailureEvidence({
      automationRoot,
      date,
      runId,
      phase,
      attempt,
      preparedSnapshot: snapshotRoot,
      promptHash: error.promptHash,
      responseArtifact: error.responseArtifact,
      ...failure
    });
    error.phase = phase;
    error.errorClass = failure.error_class;
    error.error_class = failure.error_class;
    error.retryable = failure.retryable;
    error.attempt = attempt;
    error.preparedSnapshot = snapshotRoot;
    throw error;
  }
}

function buildModelGovernanceCallbacks({ dataDir, date, runId, promptHash, attempt, setResponseArtifact }) {
  return {
    date,
    job: "fund-portfolio-daily",
    runId,
    promptHash,
    attempt,
    onAttemptStart: async (event) => {
      await recordFundModelAttemptStart({
        dataDir,
        date,
        job: "fund-portfolio-daily",
        runId,
        promptHash,
        attempt: event.attempt || attempt,
        provider: event.provider,
        model: event.model
      });
    },
    onAttemptTerminal: async (event) => {
      await recordFundModelAttemptTerminal({
        dataDir,
        date,
        entry: {
          job: "fund-portfolio-daily",
          runId,
          prompt_hash: promptHash,
          attempt: event.attempt || attempt,
          provider: event.provider,
          model: event.model,
          request_id: event.request_id,
          generation_id: event.generation_id,
          http_status: event.status,
          provider_status: event.provider_status,
          content_type: event.responseType,
          duration_ms: event.duration_ms,
          phase: "model",
          terminal_state: event.terminal_state,
          remote_state_unknown: Boolean(event.remote_state_unknown),
          usage: event.usage,
          cost: event.cost,
          error_class: event.error_class,
          retryable: event.retryable,
          safe_summary: event.safe_summary
        }
      });
    },
    onResponse: async (event) => {
      const artifact = await saveFundModelResponseArtifact({
        dataDir,
        date,
        runId,
        attempt: event.attempt || attempt,
        text: event.text,
        metadata: {
          date,
          job: "fund-portfolio-daily",
          runId,
          prompt_hash: promptHash,
          attempt: event.attempt || attempt,
          provider: event.provider,
          model: event.model,
          request_id: event.request_id,
          generation_id: event.generation_id
        }
      });
      setResponseArtifact(artifact);
    }
  };
}

async function checkPreModelGate({ dataDir, date, promptHash, scheduled, env, logger, runId, attempt }) {
  const config = getFundCostGovernanceConfig(env);
  const block = async ({ reason, errorClass = "model_request_blocked", retryable = false, requestCount = null }) => {
    await recordFundModelAlert({
      dataDir,
      date,
      env,
      logger,
      alert: {
        job: "fund-portfolio-daily",
        severity: "block",
        reason,
        phase: "pre_model_gate",
        error_class: errorClass,
        request_count: requestCount,
        runId
      }
    });
    return {
      ok: false,
      job: "fundPortfolioDaily",
      date,
      dryRun: true,
      sent: false,
      skipped: true,
      phase: "pre_model_gate",
      attempt,
      error_class: errorClass,
      retryable,
      sendSkippedReason: reason,
      next_retry_at: null,
      promptHash,
      prompt_hash_suffix: promptHash.slice(-12),
      promoted: false,
      files: {}
    };
  };

  if (env.FUND_PORTFOLIO_ENABLED !== "true") {
    return block({ reason: "fund gate closed" });
  }
  if (scheduled && [0, 6].includes(weekdayForDate(date))) {
    return block({ reason: "weekend fund schedule closed" });
  }
  if (isFundSent({ dataDir, date })) {
    return block({ reason: "already sent" });
  }

  const budget = await getDailyFundModelBudget({
    dataDir,
    date,
    promptHash,
    maxDailyRequests: config.maxDailyRequests,
    cooldownMs: config.remoteUnknownCooldownMs
  });
  if (!budget.maySubmit) {
    return block({
      reason: budget.reason || "daily model budget blocked",
      requestCount: budget.submitted
    });
  }

  const status = await getFundCostGovernanceStatus({ dataDir, date, env });
  if (status.circuitBreaker.open && status.circuitBreaker.reasons.some((reason) => reason !== "response_already_received")) {
    return block({
      reason: status.circuitBreaker.reasons.join(","),
      requestCount: status.usage.requests
    });
  }

  return null;
}

async function prepareSnapshot({ date, runId, canonicalRoot, automationRoot, commandRunner }) {
  const stagingRoot = path.join(automationRoot, "staging", `${date}-${runId}`, "fund-portfolio-daily");
  const stagingSkill = path.join(stagingRoot, "skill");
  const stagingProject = path.join(stagingRoot, "project");
  const stagingOutputs = path.join(stagingProject, "outputs");
  await mkdir(stagingRoot, { recursive: true });
  await cp(path.join(canonicalRoot, "skill"), stagingSkill, { recursive: true, force: true });

  const environment = {
    ...process.env,
    FUND_RUN_DATE: date,
    FUND_ASSET_ROOT: stagingRoot,
    FUND_SKILL_ROOT: stagingSkill,
    FUND_PROJECT_ROOT: stagingProject,
    FUND_OUTPUTS_ROOT: stagingOutputs
  };
  const rawFile = path.join(stagingOutputs, "reports", "raw-data", `fund-daily-raw-${date}.json`);
  await commandRunner("python3", [path.join(stagingSkill, "scripts", "data_fetch_only.py"), stagingOutputs, "--force"], { env: environment });
  await commandRunner("python3", [path.join(stagingSkill, "scripts", "v7", "portfolio_state_tracker.py")], { env: environment });
  await commandRunner("python3", [path.join(stagingSkill, "scripts", "v8", "v8_orchestrator.py"), "--raw-data", rawFile], { env: environment });

  const configDir = path.join(stagingSkill, "config");
  const sources = {
    "raw-data.json": rawFile,
    "portfolio_state.json": path.join(configDir, "portfolio_state.json"),
    "portfolio.json": path.join(configDir, "portfolio.json"),
    "basket_config.json": path.join(configDir, "basket_config.json"),
    "scoring_config.json": path.join(configDir, "scoring_config.json")
  };
  const snapshotRoot = path.join(automationRoot, "prepared", date);
  await mkdir(snapshotRoot, { recursive: true });
  const inputHashes = {};
  for (const [name, source] of Object.entries(sources)) {
    const content = await readFile(source);
    inputHashes[name] = createHash("sha256").update(content).digest("hex");
    await atomicWrite(path.join(snapshotRoot, name), content);
  }
  try {
    await cp(path.join(configDir, "v8_state"), path.join(snapshotRoot, "v8_state"), { recursive: true, force: true });
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await atomicWrite(path.join(snapshotRoot, "manifest.json"), JSON.stringify({
    requestedDate: date,
    preparedAt: new Date().toISOString(),
    inputHashes,
    commands: COMMANDS
  }, null, 2));
  return snapshotRoot;
}

async function readPreparedContext(snapshotRoot) {
  const [rawData, portfolioState, portfolio, basketConfig, scoringConfig] = await Promise.all([
    readJson(path.join(snapshotRoot, "raw-data.json")),
    readJson(path.join(snapshotRoot, "portfolio_state.json")),
    readJson(path.join(snapshotRoot, "portfolio.json")),
    readJson(path.join(snapshotRoot, "basket_config.json")),
    readJson(path.join(snapshotRoot, "scoring_config.json"))
  ]);
  return { rawData, portfolioState, portfolio, basketConfig, scoringConfig };
}

function validateSectionOrder(markdown) {
  const errors = [];
  let previous = -1;
  for (const section of REQUIRED_SECTIONS) {
    const index = markdown.indexOf(`## ${section}`);
    if (index < 0) errors.push(`missing section: ${section}`);
    if (index >= 0 && index <= previous) errors.push(`section out of order: ${section}`);
    if (index >= 0) previous = index;
  }
  return errors;
}

async function promoteSnapshot({ date, canonicalRoot, snapshotRoot, markdown }) {
  const rawFile = path.join(canonicalRoot, "project", "outputs", "reports", "raw-data", `fund-daily-raw-${date}.json`);
  const reportFile = path.join(canonicalRoot, "project", "outputs", "reports", "markdown", `fund-daily-${date}.md`);
  const configDir = path.join(canonicalRoot, "skill", "config");
  await atomicWrite(rawFile, await readFile(path.join(snapshotRoot, "raw-data.json")));
  await atomicWrite(reportFile, `${markdown.trimEnd()}\n`);
  await atomicWrite(path.join(configDir, "portfolio_state.json"), await readFile(path.join(snapshotRoot, "portfolio_state.json")));
  for (const name of ["rebuy_log.json", "tp_state.json"]) {
    try {
      await atomicWrite(path.join(configDir, "v8_state", name), await readFile(path.join(snapshotRoot, "v8_state", name)));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  return { rawFile, reportFile };
}

async function writePreview({ date, runId, automationRoot, snapshotRoot, markdown }) {
  const previewDir = path.join(automationRoot, "previews", `${date}-${runId}`);
  const rawFile = path.join(previewDir, `fund-daily-raw-${date}.json`);
  const reportFile = path.join(previewDir, `fund-daily-${date}.md`);
  await atomicWrite(rawFile, await readFile(path.join(snapshotRoot, "raw-data.json")));
  await atomicWrite(reportFile, `${markdown.trimEnd()}\n`);
  return { rawFile, reportFile };
}

function classifyFailure(error, phase) {
  const errorClass = error?.errorClass || error?.error_class || {
    prepare: "prepare_failure",
    model: "model_failure",
    validation: "report_validation_failure",
    promotion: "promotion_failure"
  }[phase] || "pipeline_failure";
  const retryable = typeof error?.retryable === "boolean"
    ? error.retryable
    : phase === "prepare";
  return { error_class: errorClass, retryable };
}

async function writeFailureEvidence({ automationRoot, date, runId, phase, attempt, preparedSnapshot, promptHash, responseArtifact, error_class, retryable }) {
  const dir = path.join(automationRoot, "failed-runs", `${date}-${runId}`);
  await mkdir(dir, { recursive: true });
  await atomicWrite(path.join(dir, "failure.json"), JSON.stringify({
    date,
    failedAt: new Date().toISOString(),
    phase,
    attempt,
    error_class,
    retryable,
    preparedSnapshot: preparedSnapshot || null,
    prompt_hash_suffix: promptHash ? promptHash.slice(-12) : null,
    responseArtifact: responseArtifact || null,
    promoted: false,
    sent: false
  }, null, 2));
}

function isFundSent({ dataDir, date }) {
  return existsSync(path.join(dataDir, "outputs", "automations", "fund-portfolio-daily", `${date}-sent.json`));
}

async function atomicWrite(file, content) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, content);
  await rename(temporary, file);
}

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}
