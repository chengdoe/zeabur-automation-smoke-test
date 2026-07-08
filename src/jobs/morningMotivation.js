import { parseDateOnly, shanghaiDateString } from "../date.js";

const CONTENT_PACK = [
  {
    theme: "Monday / restart",
    headline: "把这一周交给一个真实动作",
    body: "不要先追求气势，先把最重要的事情拆到能开始。今天能稳定推进一小步，这一周就有了可以依靠的起点。"
  },
  {
    theme: "Tuesday / execution",
    headline: "少一点犹豫，多一个闭环",
    body: "真正消耗人的不是任务本身，而是一直悬着不落地。今天选一件能收尾的事，把它完成，让注意力重新回到自己手里。"
  },
  {
    theme: "Wednesday / clarity",
    headline: "看清楚，比用力更重要",
    body: "如果事情变复杂，先别急着加速。把目标、下一步和阻碍写清楚，混乱会少一半，行动自然会变得更稳。"
  },
  {
    theme: "Thursday / resilience",
    headline: "把压力变成可处理的形状",
    body: "压力最大的时候，最需要把问题具体化。别和一整团焦虑对抗，先抓住一个变量、一个动作、一个可验证的结果。"
  },
  {
    theme: "Friday / harvest",
    headline: "今天不只推进，也要回收经验",
    body: "一周的价值不只在完成了多少，还在留下了什么方法。收尾时多问一句：这件事下次怎样能更轻、更准、更可复用。"
  },
  {
    theme: "Saturday / repair",
    headline: "给自己一点恢复，也保留一点前进",
    body: "休息不是放弃目标，而是修复继续走的能力。今天不用逼自己满格运转，做一个轻量但真实的动作就够了。"
  },
  {
    theme: "Sunday / reset",
    headline: "先整理方向，再进入下一周",
    body: "别让新一周从惯性里开始。今天留一点时间看清优先级，删掉不必要的承诺，把真正重要的事放回前面。"
  },
  {
    theme: "focus",
    headline: "注意力在哪里，今天就会长成什么样",
    body: "不要把清晨交给零散信息。先给最重要的事一段完整时间，哪怕只有二十分钟，也是在为今天定调。"
  },
  {
    theme: "courage",
    headline: "先做那个你一直绕开的动作",
    body: "很多拖延不是因为懒，而是因为不想面对不确定。今天不用一次做完，只要先碰一下最关键的部分，局面就会松动。"
  },
  {
    theme: "boundary",
    headline: "守住边界，才守得住推进",
    body: "不是所有请求都需要立刻回应，也不是所有念头都值得跟随。把今天的主线护住，你会更容易做出真正重要的成果。"
  },
  {
    theme: "review",
    headline: "把昨天的经验，变成今天的优势",
    body: "不要只记得哪里没做好。提取一个有效动作、一个需要调整的点，然后把它带进今天，成长就会变得具体。"
  },
  {
    theme: "small win",
    headline: "完成一个小胜利，重新建立手感",
    body: "当状态不稳时，先不要挑战最大难度。找一件十分钟内能推进的事，做完它，让行动感先回来。"
  },
  {
    theme: "patience",
    headline: "慢下来，不等于退后",
    body: "有些进展需要耐心，不适合靠焦虑催熟。今天只要保持正确方向和稳定动作，时间会把它们累积成结果。"
  },
  {
    theme: "ownership",
    headline: "把主动权拿回来，从一个选择开始",
    body: "不要等状态、环境和别人都准备好。先选定今天最值得负责的一件事，把判断和行动收回到自己这里。"
  }
];

const AT_ALL = "<at user_id=\"all\"></at>";
const BASE_DATE = "2026-07-01";

export function buildMorningMotivationDryRun(options = {}) {
  const date = options.date || shanghaiDateString();
  const fallback = selectMorningContent(date);
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
    selectedContent: {
      theme: fallback.theme
    },
    payload,
    preview: payload.text,
    validation
  };
}

export function selectMorningContent(date) {
  parseDateOnly(date);
  const dayOffset = Math.floor((dateUtcMs(date) - dateUtcMs(BASE_DATE)) / 86_400_000);
  const weekdayIndex = new Date(dateUtcMs(date)).getUTCDay();
  const rotationOffset = Math.max(0, dayOffset) % CONTENT_PACK.length;
  return CONTENT_PACK[(weekdayIndex + rotationOffset) % CONTENT_PACK.length];
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

function dateUtcMs(date) {
  const [year, month, day] = date.split("-").map(Number);
  return Date.UTC(year, month - 1, day);
}
