import { timingSafeEqual } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import { extractFundPortfolioBrief } from "./fundPortfolioDaily.js";

const API_PREFIX = "/api/readonly/fund";
const APPROVED_SECTIONS = new Set([
  "今日结论",
  "精简市场总结",
  "持仓今天表现",
  "仓位分布",
  "产业链验证",
  "基金经理观点",
  "反向论证",
  "认知偏差检查",
  "今天怎么做",
  "风险关注",
  "下次检查",
  "数据可靠性"
]);

export async function handleFundReadonlyRequest({ req, url, dataRoot, credential }) {
  if (!url.pathname.startsWith(`${API_PREFIX}/`)) return null;
  if (req.method !== "GET") return response(405, "method_not_allowed");
  if (!String(credential || "").trim()) return response(503, "service_not_configured");
  if (!authorized(req.headers.authorization, credential)) return response(401, "unauthorized");

  const asOf = url.searchParams.get("as_of") || null;
  if (asOf && !validDate(asOf)) return response(400, "invalid_date");

  if (url.pathname === `${API_PREFIX}/brief`) {
    const report = await loadReport({ dataRoot, asOf });
    if (!report) return response(404, "report_not_found");
    const brief = extractFundPortfolioBrief({
      date: report.asOf,
      markdown: report.markdown,
      fullReportFile: report.file
    });
    return {
      status: 200,
      body: {
        ok: true,
        as_of: report.asOf,
        brief: projectBrief(brief)
      }
    };
  }

  if (url.pathname === `${API_PREFIX}/report-section`) {
    const section = String(url.searchParams.get("section") || "").trim();
    if (!APPROVED_SECTIONS.has(section)) return response(400, "section_not_allowed");
    const report = await loadReport({ dataRoot, asOf });
    if (!report) return response(404, "report_not_found");
    const content = extractSection(report.markdown, section);
    if (!content) return response(404, "section_not_found");
    return {
      status: 200,
      body: {
        ok: true,
        as_of: report.asOf,
        section,
        content: Array.from(content).slice(0, 1200).join("")
      }
    };
  }

  return response(404, "not_found");
}

function response(status, errorCode) {
  return { status, body: { ok: false, error_code: errorCode } };
}

function authorized(header, credential) {
  const actual = Buffer.from(String(header || ""));
  const expected = Buffer.from(`Bearer ${String(credential || "").trim()}`);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

async function loadReport({ dataRoot, asOf }) {
  const root = path.resolve(String(dataRoot || ""));
  const reportsDir = path.join(root, "outputs", "reports", "markdown");
  let date = asOf;
  if (!date) {
    let names;
    try {
      names = await readdir(reportsDir);
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
    date = names
      .map((name) => name.match(/^fund-daily-(\d{4}-\d{2}-\d{2})\.md$/)?.[1])
      .filter((value) => value && validDate(value))
      .sort()
      .at(-1);
    if (!date) return null;
  }
  const file = path.join(reportsDir, `fund-daily-${date}.md`);
  if (path.dirname(file) !== reportsDir) return null;
  try {
    return { asOf: date, file, markdown: await readFile(file, "utf8") };
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function projectBrief(brief) {
  return {
    stance: brief.stance,
    summary: brief.summary,
    confirmations: (brief.confirmations || []).slice(0, 3).map((item) => ({
      fund_code: String(item.fund_code || ""),
      fund_name: String(item.fund_name || ""),
      action: String(item.action || ""),
      reason: String(item.reason || ""),
      amount_or_range: item.amount_or_range ?? null
    })),
    triggers: (brief.triggers || []).slice(0, 3).map(String),
    portfolio_snapshot: {
      estimated_total: brief.portfolio_snapshot?.estimated_total ?? null,
      as_of: brief.portfolio_snapshot?.as_of ?? null,
      estimated_change: brief.portfolio_snapshot?.estimated_change ?? null,
      largest_deviation: brief.portfolio_snapshot?.largest_deviation ?? null,
      weekly_quota: brief.portfolio_snapshot?.weekly_quota ?? null
    },
    data_quality: {
      level: brief.data_quality?.level || "low",
      note: String(brief.data_quality?.note || "")
    }
  };
}

function extractSection(markdown, section) {
  let current = null;
  const lines = [];
  for (const line of String(markdown || "").split("\n")) {
    const match = line.match(/^##\s+(.+?)\s*$/);
    if (match) {
      if (current === section) break;
      current = match[1].trim();
      continue;
    }
    if (current === section) lines.push(line);
  }
  return lines.join("\n").trim() || null;
}

