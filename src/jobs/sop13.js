import { parseDateOnly, shanghaiDateString } from "../date.js";
import { SOP_CONTENT_PACK, SOP_SECOND_ROUND_CARDS } from "./sop13Content.js";

const START_DATE = "2026-06-26";
const SPACER = "　";
const SECTION_LAYOUT = [
  { heading: "原文精华", headingRow: 2, bodyRow: 3 },
  { heading: "个人化翻译", headingRow: 5, bodyRow: 6 },
  { heading: "我的解读", headingRow: 8, bodyRow: 9 },
  { heading: "今日内化问题", headingRow: 11, bodyRow: 12 },
  { heading: "5 分钟练习", headingRow: 14, bodyRow: 15 },
  { heading: "一句话带走", headingRow: 18, bodyRow: 19 }
];
const SPACER_ROWS = [1, 4, 7, 10, 13, 17];

export function selectSopForDate(date = shanghaiDateString()) {
  const start = parseDateOnly(START_DATE);
  const target = parseDateOnly(date);
  const diffDays = Math.floor((target - start) / 86_400_000);
  if (diffDays < 0) {
    throw new Error(`Date ${date} is before SOP13 start date ${START_DATE}`);
  }
  const poolIndex = diffDays % SOP_CONTENT_PACK.length;
  const cycleNumber = Math.floor(diffDays / SOP_CONTENT_PACK.length) + 1;
  const variantIndex = (cycleNumber - 1) % 2;
  const { card: firstRoundCard, ...sop } = SOP_CONTENT_PACK[poolIndex];
  const secondRoundCard = SOP_SECOND_ROUND_CARDS[sop.name];
  if (!secondRoundCard) {
    throw new Error(`Missing second-round SOP13 variant: ${sop.name}`);
  }
  return {
    ...sop,
    card: variantIndex === 0 ? firstRoundCard : secondRoundCard,
    date,
    dayNumber: diffDays + 1,
    index: poolIndex + 1,
    cycleNumber,
    variantIndex
  };
}

export function buildSop13DryRun(options = {}) {
  const date = options.date || shanghaiDateString();
  const selectedSop = options.selectedSop || selectSopForDate(date);
  const card = buildCardText(selectedSop);
  const payload = buildSop13PostPayload(selectedSop, card);
  const validation = validateSop13Post(payload, {
    expectedSopName: selectedSop.name,
    expectedExerciseTemplate: card.exerciseTemplate
  });

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
        [{ tag: "md", text: card.exerciseTemplate }],
        spacerRow(),
        boldRow("一句话带走"),
        textRow(card.takeaway)
      ]
    }
  };
}

export function validateSop13Post(payload, options = {}) {
  const errors = [];
  const zhCn = payload?.zh_cn;
  const content = zhCn?.content;

  if (!zhCn || typeof zhCn !== "object") {
    errors.push("payload.zh_cn is required");
    return { ok: false, errors };
  }
  if (zhCn.title !== "") {
    errors.push("outer title must be empty");
  }
  if (typeof zhCn.title === "string" && zhCn.title.includes("【每日遇见】")) {
    errors.push("outer title must not contain the visible title");
  }
  if (!Array.isArray(content)) {
    errors.push("content must be an array of rows");
    return { ok: false, errors };
  }
  if (content.length !== 20) {
    errors.push("content must contain exactly 20 rows");
  }

  const row0 = content[0] || [];
  const titleItem = row0[0];
  const atItem = row0[1];
  const hasTitleText = titleItem?.tag === "text" &&
    titleItem.text?.startsWith("【每日遇见】 今日 SOP：") &&
    Array.isArray(titleItem.style) &&
    titleItem.style.includes("bold");
  const hasAtAll = atItem?.tag === "at" && atItem.user_id === "all";
  if (!hasTitleText) {
    errors.push("row 0 must contain the bold visible title");
  }
  if (!hasAtAll) {
    errors.push("row 0 must contain @all");
  }
  if (row0.length !== 2) {
    errors.push("row 0 must contain only the visible title and @all");
  }
  if (options.expectedSopName) {
    const expectedTitle = `【每日遇见】 今日 SOP：${options.expectedSopName} `;
    if (titleItem?.text !== expectedTitle) {
      errors.push(`visible title must match selected SOP: ${options.expectedSopName}`);
    }
  }

  const bodies = [];
  for (const section of SECTION_LAYOUT) {
    const headingItem = content[section.headingRow]?.[0];
    const bodyItem = content[section.bodyRow]?.[0];
    const headingIsExact = content[section.headingRow]?.length === 1 &&
      headingItem?.tag === "text" &&
      headingItem.text === section.heading &&
      Array.isArray(headingItem.style) &&
      headingItem.style.includes("bold");
    if (!headingIsExact) {
      errors.push(`expected heading ${section.heading} at row ${section.headingRow}`);
    }
    const bodyText = bodyItem?.tag === "text" && typeof bodyItem.text === "string"
      ? bodyItem.text.trim()
      : "";
    if (content[section.bodyRow]?.length !== 1 || !bodyText) {
      errors.push(`non-empty body: ${section.heading}`);
    } else {
      bodies.push({ heading: section.heading, normalized: normalizeText(bodyText) });
    }
  }

  for (const rowIndex of SPACER_ROWS) {
    const row = content[rowIndex];
    if (row?.length !== 1 || row[0]?.tag !== "text" || row[0].text !== SPACER) {
      errors.push(`expected full-width spacer at row ${rowIndex}`);
    }
  }

  const exerciseTemplate = content[16]?.[0];
  if (content[16]?.length !== 1 || exerciseTemplate?.tag !== "md" || !exerciseTemplate.text?.trim()) {
    errors.push("missing quote-style exercise template at row 16");
  } else if (options.expectedExerciseTemplate && exerciseTemplate.text !== options.expectedExerciseTemplate) {
    errors.push("exercise template must match selected SOP variant");
  }

  for (let left = 0; left < bodies.length; left += 1) {
    for (let right = left + 1; right < bodies.length; right += 1) {
      if (bodies[left].normalized === bodies[right].normalized) {
        errors.push(`section bodies must be unique: ${bodies[left].heading} and ${bodies[right].heading}`);
      }
    }
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

function normalizeText(text) {
  return text.trim().replace(/\s+/g, " ");
}
