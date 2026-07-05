import { parseDateOnly, shanghaiDateString } from "../date.js";

const DEFAULT_LINES = [
  {
    headline: "把今天交还给一个清晰动作",
    body: "不急着证明自己已经准备好，先把最重要的一小步做出来。行动会帮你把心里的雾慢慢拨开。"
  },
  {
    headline: "稳住节奏，事情就会开始向前",
    body: "今天不需要靠情绪冲刺。把注意力放回节奏、顺序和边界，能推进的地方就先推进一点。"
  },
  {
    headline: "真正的掌控感来自完成一件小事",
    body: "别让庞大的目标压住当下。选一件能闭环的小事，把它做完，今天就会多一块可靠的地面。"
  },
  {
    headline: "先照顾好注意力，再谈效率",
    body: "把分散的念头收回来，给自己一段不被打断的时间。你不需要同时处理所有事，只需要认真处理眼前这一件。"
  },
  {
    headline: "把复杂的一天拆成可以走的路",
    body: "遇到混乱时，不必立刻找到完美答案。先写下下一步，做完它，再看下一步，路会在脚下变清楚。"
  },
  {
    headline: "允许自己慢一点，但不要停在原地",
    body: "状态不是每天都一样。今天可以降低难度，但别放弃连接行动，哪怕只完成一个最小版本，也是在向前。"
  },
  {
    headline: "给自己一个重新开始的入口",
    body: "过去几天怎样都不决定今天。现在选一个轻但真实的动作，把自己带回生活和目标的正轨。"
  }
];

const AT_ALL = "<at user_id=\"all\"></at>";

export function buildMorningMotivationDryRun(options = {}) {
  const date = options.date || shanghaiDateString();
  const fallback = DEFAULT_LINES[parseDateOnly(date).getDay()];
  const headline = options.headline || fallback.headline;
  const body = stripAtAll(options.body || fallback.body).trim();
  const payload = {
    text: `【晨间激励 · ${date}】\n\n${headline}\n\n${body}${AT_ALL}`
  };
  const validation = validateMorningPayload(payload, { date });

  return {
    ok: validation.ok,
    job: "morningMotivation",
    dryRun: true,
    msgType: "text",
    date,
    payload,
    preview: payload.text,
    validation
  };
}

export function validateMorningPayload(payload, options = {}) {
  const errors = [];
  const text = payload?.text;
  const datePattern = options.date || "\\d{4}-\\d{2}-\\d{2}";

  if (typeof text !== "string") {
    errors.push("content.text must be a string");
    return { ok: false, errors };
  }

  const lines = text.split("\n");
  const firstLine = lines[0] || "";
  const firstLinePattern = new RegExp(`^【晨间激励 · ${datePattern}】$`);

  if (!firstLinePattern.test(firstLine)) {
    errors.push("first line must be 【晨间激励 · YYYY-MM-DD】");
  }
  if ((text.match(/<at user_id="all"><\/at>/g) || []).length !== 1) {
    errors.push("@all must appear exactly once");
  }
  if (firstLine.includes(AT_ALL)) {
    errors.push("@all must not appear in the title line");
  }
  if (!text.trimEnd().endsWith(AT_ALL)) {
    errors.push("@all must be appended to the final body sentence");
  }
  if (lines[1] !== "" || lines[3] !== "") {
    errors.push("blank lines must separate first line, headline, and body");
  }
  if (!lines[2]?.trim()) {
    errors.push("headline must not be empty");
  }
  if (!lines.slice(4).join("\n").trim()) {
    errors.push("body must not be empty");
  }
  const textWithoutMention = stripAtAll(text);
  if (/[#*_`]/.test(textWithoutMention)) {
    errors.push("morning motivation must be plain text without Markdown symbols");
  }

  return { ok: errors.length === 0, errors };
}

function stripAtAll(text) {
  return String(text).replaceAll(AT_ALL, "");
}
