import { shanghaiDateString } from "../date.js";

const DEFAULT_LINES = [
  {
    headline: "先把注意力放回今天能掌控的一步",
    body: "不需要一开始就解决全部问题。选一件最小但真实的事，稳稳推进它，状态会在行动里重新长出来。"
  },
  {
    headline: "把今天过成一个可推进的版本",
    body: "不用追求一口气变好。把手边的任务拆小，先完成一个清晰动作，剩下的路会因此更容易看见。"
  },
  {
    headline: "稳住节奏，比用力证明自己更重要",
    body: "今天先照顾好自己的注意力和边界。把能做的做好，把暂时做不到的放清楚，这也是一种可靠的前进。"
  }
];

export function buildMorningMotivationDryRun(options = {}) {
  const date = options.date || shanghaiDateString();
  const fallback = DEFAULT_LINES[date.charCodeAt(date.length - 1) % DEFAULT_LINES.length];
  const headline = options.headline || fallback.headline;
  const body = options.body || fallback.body;
  const payload = {
    text: `【晨间激励】${date} <at user_id="all"></at>\n\n${headline}\n\n${body}`
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
  const firstLinePattern = new RegExp(`^【晨间激励】${datePattern} <at user_id="all"></at>$`);

  if (!firstLinePattern.test(firstLine)) {
    errors.push("first line must be 【晨间激励】YYYY-MM-DD <at user_id=\"all\"></at>");
  }
  if ((text.match(/<at user_id="all"><\/at>/g) || []).length !== 1) {
    errors.push("@all must appear exactly once");
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
  const textWithoutMention = text.replaceAll("<at user_id=\"all\"></at>", "");
  if (/[#*_`]/.test(textWithoutMention)) {
    errors.push("morning motivation must be plain text without Markdown symbols");
  }

  return { ok: errors.length === 0, errors };
}
