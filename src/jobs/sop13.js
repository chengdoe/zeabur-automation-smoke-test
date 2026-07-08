import { parseDateOnly, shanghaiDateString } from "../date.js";
import { SOP_CONTENT_PACK } from "./sop13Content.js";

const START_DATE = "2026-06-26";
const QUOTE_TEMPLATE = "> 目标：\n> 输入：\n> 输出：\n> 验收标准：\n> 最大风险：\n> 最小可交付版本：";
const SPACER = "　";

export function selectSopForDate(date = shanghaiDateString()) {
  const start = parseDateOnly(START_DATE);
  const target = parseDateOnly(date);
  const diffDays = Math.floor((target - start) / 86_400_000);
  if (diffDays < 0) {
    throw new Error(`Date ${date} is before SOP13 start date ${START_DATE}`);
  }
  const poolIndex = diffDays % SOP_CONTENT_PACK.length;
  return {
    ...SOP_CONTENT_PACK[poolIndex],
    date,
    dayNumber: diffDays + 1,
    index: poolIndex + 1
  };
}

export function buildSop13DryRun(options = {}) {
  const date = options.date || shanghaiDateString();
  const selectedSop = options.selectedSop || selectSopForDate(date);
  const card = buildCardText(selectedSop);
  const payload = buildSop13PostPayload(selectedSop, card);
  const validation = validateSop13Post(payload);

  return {
    ok: validation.ok,
    job: "sop13",
    dryRun: true,
    msgType: "post",
    date,
    selectedSop,
    payload,
    preview: card,
    validation
  };
}

export function buildSop13PostPayload(sop, card) {
  return {
    zh_cn: {
      title: "",
      content: [
        [
          { tag: "text", text: `【每日遇见】 今日 SOP：${sop.name} `, style: ["bold"] },
          { tag: "at", user_id: "all" }
        ],
        spacerRow(),
        boldRow("原文精华"),
        textRow(card.essence),
        spacerRow(),
        boldRow("个人化翻译"),
        textRow(card.translation),
        spacerRow(),
        boldRow("我的解读"),
        textRow(card.interpretation),
        spacerRow(),
        boldRow("今日内化问题"),
        textRow(card.question),
        spacerRow(),
        boldRow("5 分钟练习"),
        textRow(card.exercise),
        [{ tag: "md", text: QUOTE_TEMPLATE }],
        spacerRow(),
        boldRow("一句话带走"),
        textRow(card.takeaway)
      ]
    }
  };
}

export function validateSop13Post(payload) {
  const errors = [];
  const zhCn = payload?.zh_cn;
  const content = zhCn?.content;

  if (!zhCn || typeof zhCn !== "object") {
    errors.push("payload.zh_cn is required");
    return { ok: false, errors };
  }
  if (zhCn.title !== "" && zhCn.title !== " ") {
    errors.push("outer title must be empty or a single space");
  }
  if (typeof zhCn.title === "string" && zhCn.title.includes("【每日遇见】")) {
    errors.push("outer title must not contain the visible title");
  }
  if (!Array.isArray(content)) {
    errors.push("content must be an array of rows");
    return { ok: false, errors };
  }

  const row0 = content[0] || [];
  const hasTitleText = row0.some((item) =>
    item?.tag === "text" &&
    item.text?.startsWith("【每日遇见】 今日 SOP：") &&
    Array.isArray(item.style) &&
    item.style.includes("bold")
  );
  const hasAtAll = row0.some((item) => item?.tag === "at" && item.user_id === "all");
  if (!hasTitleText) {
    errors.push("row 0 must contain the bold visible title");
  }
  if (!hasAtAll) {
    errors.push("row 0 must contain @all");
  }

  for (const heading of ["原文精华", "个人化翻译", "我的解读", "今日内化问题", "5 分钟练习", "一句话带走"]) {
    if (!content.some((row) => row?.[0]?.tag === "text" && row[0].text === heading && row[0].style?.includes("bold"))) {
      errors.push(`missing bold heading: ${heading}`);
    }
  }

  if (!content.some((row) => row?.[0]?.tag === "md" && row[0].text === QUOTE_TEMPLATE)) {
    errors.push("missing quote-style exercise template");
  }
  if (JSON.stringify(payload).includes("是否值得复现")) {
    errors.push("payload must not include 是否值得复现");
  }

  return { ok: errors.length === 0, errors };
}

function buildCardText(sop) {
  return sop.card;
}

function boldRow(text) {
  return [{ tag: "text", text, style: ["bold"] }];
}

function textRow(text) {
  return [{ tag: "text", text }];
}

function spacerRow() {
  return [{ tag: "text", text: SPACER }];
}
