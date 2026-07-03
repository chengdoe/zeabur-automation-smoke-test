import { parseDateOnly, shanghaiDateString } from "../date.js";

const START_DATE = "2026-06-26";
const QUOTE_TEMPLATE = "> 目标：\n> 输入：\n> 输出：\n> 验收标准：\n> 最大风险：\n> 最小可交付版本：";
const SPACER = "　";

const SOP_POOL = [
  {
    name: "每日留痕 SOP",
    scene: "每天记录完成事项、问题、明日计划。",
    lifeSkill: "把经历变成可追踪素材。",
    angle: "今天先留下事实，再留下判断。"
  },
  {
    name: "高质量请教 SOP",
    scene: "不要空手问，先说理解、尝试、卡点、希望对方判断什么。",
    lifeSkill: "让别人更愿意帮你。",
    angle: "把问题整理清楚，本身就是推进的一半。"
  },
  {
    name: "任务启动 SOP",
    scene: "接到任务后确认目标、输入、输出、样例、验收标准。",
    lifeSkill: "把模糊任务变成可执行项目。",
    angle: "先定义清楚，再开始用力。"
  },
  {
    name: "显性化思考 SOP",
    scene: "展示方案比选、决策依据、风险点、版本迭代。",
    lifeSkill: "让自己的判断过程可见。",
    angle: "把脑内判断写出来，协作才有抓手。"
  },
  {
    name: "每周自我同步 SOP",
    scene: "周报三段式。",
    lifeSkill: "每周整理进展、价值、卡点和下一步。",
    angle: "和自己同步一次，比被动等待反馈更可靠。"
  },
  {
    name: "MVP 交付 SOP",
    scene: "先交可用版本，再迭代，不要完美主义拖死。",
    lifeSkill: "用低成本版本验证方向。",
    angle: "先让事情有一个能被检验的形状。"
  },
  {
    name: "价值判断 SOP",
    scene: "抢着干活不等于有责任感，先判断优先级和产出价值。",
    lifeSkill: "避免把勤奋浪费在低价值事务上。",
    angle: "先问值不值得，再问怎么做得更快。"
  },
  {
    name: "项目复盘 SOP",
    scene: "背景、目标、过程、结果、反思。",
    lifeSkill: "从经历中提取可复用经验。",
    angle: "把一次性经历变成下次可复用的方法。"
  },
  {
    name: "延迟应答 SOP",
    scene: "不要别人一开口就答应，先确认手头进度和边界。",
    lifeSkill: "保护精力和承诺质量。",
    angle: "慢一拍确认边界，是为了更可靠地答应。"
  },
  {
    name: "成果打包 SOP",
    scene: "项目完成后转成案例、模板、作品集素材。",
    lifeSkill: "把做过的事变成资产。",
    angle: "完成不是终点，打包后才会复利。"
  },
  {
    name: "主线识别 SOP",
    scene: "把力气用在主线上，别被低价值事务拖垮。",
    lifeSkill: "识别长期最重要的能力和项目。",
    angle: "每天都问一次：这件事是否靠近主线。"
  },
  {
    name: "自建 SOP 四步法",
    scene: "拆场景、列步骤、定模板、测反馈。",
    lifeSkill: "把任何重复经验变成个人方法论。",
    angle: "重复出现的问题，值得被做成流程。"
  },
  {
    name: "成长闭环 SOP",
    scene: "每周问是否留下可复用成果、经验、作品集素材。",
    lifeSkill: "形成输入、行动、沉淀、复用的闭环。",
    angle: "让每一轮行动都给下一轮留下东西。"
  },
  {
    name: "结构化汇报 SOP",
    scene: "进展、问题、下一步。",
    lifeSkill: "清晰同步任何事情的状态。",
    angle: "好的汇报让别人快速知道现状和需要什么。"
  }
];

export function selectSopForDate(date = shanghaiDateString()) {
  const start = parseDateOnly(START_DATE);
  const target = parseDateOnly(date);
  const diffDays = Math.floor((target - start) / 86_400_000);
  if (diffDays < 0) {
    throw new Error(`Date ${date} is before SOP13 start date ${START_DATE}`);
  }
  const poolIndex = diffDays % SOP_POOL.length;
  return {
    ...SOP_POOL[poolIndex],
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
  return {
    essence: `${sop.scene} 核心不是多做一步，而是把动作变得可检查、可复用。`,
    translation: `${sop.name} 可以翻译成一个日常提醒：${sop.lifeSkill} 先把场景和下一步说清楚，再进入执行。`,
    interpretation: `${sop.angle} 这个 SOP 的价值在于降低含糊带来的损耗，让一次行动留下能被下次调用的结构。`,
    question: `今天哪一件事最适合用「${sop.name.replace(" SOP", "")}」来处理？`,
    exercise: `挑一件正在推进的事，用 ${sop.name} 写出一个五分钟版本。`,
    takeaway: `${sop.lifeSkill}，从今天的一次小练习开始。`
  };
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
