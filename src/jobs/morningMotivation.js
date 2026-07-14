import { parseDateOnly, shanghaiDateString } from "../date.js";

const CONTENT_PACK = [
  {
    theme: "start",
    headline: "把这一周交给一个真实动作",
    body: "不要先追求气势，先把最重要的事情拆到能开始。今天能稳定推进一小步，这一周就有了可以依靠的起点。"
  },
  {
    theme: "closure",
    headline: "少一点犹豫，多一个闭环",
    body: "真正消耗人的不是任务本身，而是一直悬着不落地。今天选一件能收尾的事，把它完成，让注意力重新回到自己手里。"
  },
  {
    theme: "clarity",
    headline: "看清楚，比用力更重要",
    body: "如果事情变复杂，先别急着加速。把目标、下一步和阻碍写清楚，混乱会少一半，行动自然会变得更稳。"
  },
  {
    theme: "resilience",
    headline: "把压力变成可处理的形状",
    body: "压力最大的时候，最需要把问题具体化。别和一整团焦虑对抗，先抓住一个变量、一个动作、一个可验证的结果。"
  },
  {
    theme: "review",
    headline: "今天不只推进，也要回收经验",
    body: "一周的价值不只在完成了多少，还在留下了什么方法。收尾时多问一句：这件事下次怎样能更轻、更准、更可复用。"
  },
  {
    theme: "recovery",
    headline: "给自己一点恢复，也保留一点前进",
    body: "休息不是放弃目标，而是修复继续走的能力。今天不用逼自己满格运转，做一个轻量但真实的动作就够了。"
  },
  {
    theme: "reset",
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
    theme: "learning",
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
  },
  {
    theme: "energy",
    headline: "把精力留给真正需要你的地方",
    body: "忙碌不等于有效投入，疲惫也不代表做得足够多。先停掉一项低价值消耗，把清醒留给最重要的判断。"
  },
  {
    theme: "priority",
    headline: "重要的事，要先得到完整的时间",
    body: "优先级不是写在清单上的顺序，而是时间真实流向哪里。今天先锁定一段不被挪用的时间，交给最关键的任务。"
  },
  {
    theme: "uncertainty",
    headline: "不确定的时候，先获得一个反馈",
    body: "想得再久，也无法替代现实给出的信息。把方案缩成一个能验证的小实验，今天先拿到第一份真实反馈。"
  },
  {
    theme: "craft",
    headline: "把手上的一件事，再做扎实一点",
    body: "进步有时不是开启更多任务，而是提高完成的质地。今天挑一个关键细节认真打磨，让结果经得起回看。"
  },
  {
    theme: "communication",
    headline: "把话说清楚，也把期待对齐",
    body: "很多摩擦并不是立场冲突，而是双方理解的目标不同。今天主动确认一次目标、边界和交付，让合作少一点猜测。"
  },
  {
    theme: "subtraction",
    headline: "删掉一个干扰，比增加计划更有效",
    body: "当安排已经拥挤，继续加码只会稀释注意力。今天明确放下一件不重要的事，给真正的主线腾出空间。"
  },
  {
    theme: "consistency",
    headline: "稳定出现，本身就是一种力量",
    body: "真正拉开差距的往往不是偶尔的高峰，而是低谷时仍能继续。今天守住那个最小动作，让节奏不断线。"
  },
  {
    theme: "decision",
    headline: "给犹豫设一个清晰的截止点",
    body: "有些选择不会因为继续等待就自动变得完美。补齐最关键的信息，然后在截止点做决定，把精力还给行动。"
  },
  {
    theme: "curiosity",
    headline: "先问一个好问题，再寻找答案",
    body: "卡住时，可能不是能力不够，而是问题问得太宽。把它改成一个具体、可验证的问题，下一步会更容易出现。"
  },
  {
    theme: "self-trust",
    headline: "用一次兑现，积累对自己的信任",
    body: "信心不是靠说服自己得到的，而是来自一次次说到做到。今天少承诺一点，但把答应自己的那件小事完成。"
  },
  {
    theme: "adaptability",
    headline: "方向不变，走法可以随时调整",
    body: "计划遇到变化，并不意味着之前的努力失效。重新看一眼现有条件，换一条成本更低的路径继续推进。"
  },
  {
    theme: "completion",
    headline: "先完成，再决定哪里值得完善",
    body: "过早追求完美，常常会让最重要的验证迟迟不到。今天先交出一个完整版本，再根据真实反馈精修。"
  },
  {
    theme: "gratitude",
    headline: "看见已经拥有的，也继续认真前行",
    body: "感激不是停下脚步，而是避免把一切都视为理所当然。今天记住一份支持，再用一个行动回应它。"
  },
  {
    theme: "perspective",
    headline: "把今天放远一点，再看眼前的难题",
    body: "此刻很重的事情，放进更长的时间里未必同样沉重。分清什么真正重要，然后只处理今天能够改变的部分。"
  }
];

const BASE_DATE = "2026-07-01";
const SPACER = "　";

export function buildMorningMotivationDryRun(options = {}) {
  const date = options.date || shanghaiDateString();
  const fallback = selectMorningContent(date);
  const headline = options.headline || fallback.headline;
  const body = String(options.body || fallback.body).trim();
  const payload = {
    zh_cn: {
      title: "",
      content: [
        [{ tag: "text", text: `【晨间激励 · ${date}】`, style: ["bold"] }],
        [{ tag: "text", text: SPACER }],
        [{ tag: "text", text: headline }],
        [{ tag: "text", text: SPACER }],
        [
          { tag: "text", text: body },
          { tag: "at", user_id: "all" }
        ]
      ]
    }
  };
  const validation = validateMorningPayload(payload, { date });

  return {
    ok: validation.ok,
    job: "morningMotivation",
    dryRun: true,
    msgType: "post",
    date,
    selectedContent: {
      theme: fallback.theme
    },
    payload,
    preview: `【晨间激励 · ${date}】\n\n${headline}\n\n${body}<at user_id="all"></at>`,
    validation
  };
}

export function selectMorningContent(date) {
  parseDateOnly(date);
  const dayOffset = Math.floor((dateUtcMs(date) - dateUtcMs(BASE_DATE)) / 86_400_000);
  const contentIndex = ((dayOffset % CONTENT_PACK.length) + CONTENT_PACK.length) % CONTENT_PACK.length;
  return CONTENT_PACK[contentIndex];
}

export function validateMorningPayload(payload, options = {}) {
  const errors = [];
  const zhCn = payload?.zh_cn;
  const content = zhCn?.content;
  const datePattern = options.date || "\\d{4}-\\d{2}-\\d{2}";

  if (!zhCn || typeof zhCn !== "object") {
    errors.push("payload.zh_cn is required");
    return { ok: false, errors };
  }
  if (zhCn.title !== "") {
    errors.push("outer title must be empty");
  }
  if (!Array.isArray(content)) {
    errors.push("content must be an array of rows");
    return { ok: false, errors };
  }
  if (content.length !== 5) {
    errors.push("morning motivation must contain exactly five rows");
  }

  const titleItem = content[0]?.[0];
  const firstLinePattern = new RegExp(`^【晨间激励 · ${datePattern}】$`);
  const titleIsValid = content[0]?.length === 1 &&
    titleItem?.tag === "text" &&
    firstLinePattern.test(titleItem.text || "") &&
    Array.isArray(titleItem.style) &&
    titleItem.style.includes("bold");
  if (!titleIsValid) {
    errors.push("row 0 must contain the bold title 【晨间激励 · YYYY-MM-DD】");
  }
  for (const rowIndex of [1, 3]) {
    const row = content[rowIndex];
    if (row?.length !== 1 || row[0]?.tag !== "text" || row[0].text !== SPACER) {
      errors.push(`expected full-width spacer at row ${rowIndex}`);
    }
  }

  const headlineItem = content[2]?.[0];
  if (content[2]?.length !== 1 || headlineItem?.tag !== "text" || !headlineItem.text?.trim()) {
    errors.push("headline must not be empty");
  }

  const bodyRow = content[4] || [];
  const bodyItem = bodyRow[0];
  const atItem = bodyRow[1];
  if (bodyRow.length !== 2 || bodyItem?.tag !== "text" || !bodyItem.text?.trim()) {
    errors.push("body must not be empty");
  }
  if (atItem?.tag !== "at" || atItem.user_id !== "all") {
    errors.push("final body row must end with @all");
  }
  const visibleText = [titleItem?.text, headlineItem?.text, bodyItem?.text].filter(Boolean).join("\n");
  if (/[#*_`]/.test(visibleText)) {
    errors.push("morning motivation must be plain text without Markdown symbols");
  }

  return { ok: errors.length === 0, errors };
}

function dateUtcMs(date) {
  const [year, month, day] = date.split("-").map(Number);
  return Date.UTC(year, month - 1, day);
}
