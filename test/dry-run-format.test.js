import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildMorningMotivationDryRun,
  selectMorningContent,
  validateMorningPayload
} from "../src/jobs/morningMotivation.js";
import {
  buildSop13DryRun,
  selectSopForDate,
  validateSop13Post
} from "../src/jobs/sop13.js";

test("morning motivation dry-run uses a bold native-post title", () => {
  const result = buildMorningMotivationDryRun({
    date: "2026-07-03",
    headline: "先稳住今天最小的一步",
    body: "把注意力放回能推进的一件小事上。"
  });

  assert.equal(result.job, "morningMotivation");
  assert.equal(result.dryRun, true);
  assert.equal(result.msgType, "post");
  assert.deepEqual(result.validation.errors, []);
  assert.deepEqual(result.payload, {
    zh_cn: {
      title: "",
      content: [
        [{ tag: "text", text: "【晨间激励 · 2026-07-03】", style: ["bold"] }],
        [{ tag: "text", text: "　" }],
        [{ tag: "text", text: "先稳住今天最小的一步" }],
        [{ tag: "text", text: "　" }],
        [
          { tag: "text", text: "把注意力放回能推进的一件小事上。" },
          { tag: "at", user_id: "all" }
        ]
      ]
    }
  });
  assert.deepEqual(validateMorningPayload(result.payload), { ok: true, errors: [] });
});

test("morning motivation validator rejects the old plain-text payload", () => {
  const validation = validateMorningPayload({
    text: "【晨间激励】2026-07-03 <at user_id=\"all\"></at>\n\n先稳住今天最小的一步\n\n把注意力放回能推进的一件小事上。"
  }, { date: "2026-07-03" });

  assert.equal(validation.ok, false);
  assert.match(validation.errors.join("\n"), /payload.zh_cn/);
});

test("morning motivation default content rotates beyond a fixed weekday slogan", () => {
  const first = buildMorningMotivationDryRun({ date: "2026-07-08" });
  const nextWeek = buildMorningMotivationDryRun({ date: "2026-07-15" });

  assert.equal(first.validation.ok, true);
  assert.equal(nextWeek.validation.ok, true);
  assert.notEqual(first.selectedContent.theme, nextWeek.selectedContent.theme);
  assert.notEqual(first.preview, nextWeek.preview);
  assert.match(first.preview, /^【晨间激励 · 2026-07-08】\n\n/);
  assert.match(nextWeek.preview, /^【晨间激励 · 2026-07-15】\n\n/);
  assert.doesNotMatch(first.preview.replaceAll("<at user_id=\"all\"></at>", ""), /[#*_`]/);
});

test("morning motivation selection is date based, not server timezone based", () => {
  const originalTimezone = process.env.TZ;
  process.env.TZ = "America/Los_Angeles";

  try {
    assert.equal(selectMorningContent("2026-07-01").theme, "start");
    assert.equal(selectMorningContent("2026-07-28").theme, "perspective");
  } finally {
    if (originalTimezone === undefined) {
      delete process.env.TZ;
    } else {
      process.env.TZ = originalTimezone;
    }
  }
});

test("morning motivation provides 28 deterministic days before repeating", () => {
  const dates = Array.from({ length: 29 }, (_, index) => {
    const date = new Date(Date.UTC(2026, 6, 1 + index));
    return date.toISOString().slice(0, 10);
  });
  const results = dates.map((date) => buildMorningMotivationDryRun({ date }));
  const firstCycle = results.slice(0, 28);

  assert.equal(new Set(firstCycle.map((result) => result.preview)).size, 28);
  assert.equal(new Set(firstCycle.map((result) => result.selectedContent.theme)).size, 28);
  assert.equal(new Set(firstCycle.map((result) => result.preview.split("\n")[2])).size, 28);
  assert.equal(new Set(firstCycle.map((result) => result.preview.split("\n")[4])).size, 28);
  assert.equal(results[28].selectedContent.theme, results[0].selectedContent.theme);
  assert.equal(results[28].preview.replace("2026-07-29", "2026-07-01"), results[0].preview);
  assert.ok(firstCycle.every((result) => !/^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\b/.test(result.selectedContent.theme)));
});

test("morning motivation content pack stays grounded and action oriented", () => {
  const bannedCliches = /加油|相信自己|你一定可以|未来可期|全力以赴|正能量/;

  for (let day = 1; day <= 28; day += 1) {
    const date = `2026-07-${String(day).padStart(2, "0")}`;
    const result = buildMorningMotivationDryRun({ date });
    const [, , headline, , bodyWithMention] = result.preview.split("\n");
    const body = bodyWithMention.replaceAll("<at user_id=\"all\"></at>", "");

    assert.equal(result.validation.ok, true, `${date} validation`);
    assert.equal(result.preview.split("\n").length, 5, `${date} line count`);
    assert.ok(Array.from(headline).length >= 8 && Array.from(headline).length <= 24, `${date} headline length`);
    assert.ok(Array.from(body).length >= 32 && Array.from(body).length <= 80, `${date} body length`);
    assert.doesNotMatch(`${headline}${body}`, bannedCliches, `${date} cliché check`);
    assert.match(body, /[。！？].*[。！？]$/, `${date} body should contain at least two sentences`);
  }
});

test("morning motivation validator rejects extra lines and unexpected mentions", () => {
  const valid = buildMorningMotivationDryRun({ date: "2026-07-03" }).payload;
  const extraRowPayload = structuredClone(valid);
  extraRowPayload.zh_cn.content.push([{ tag: "text", text: "额外一行" }]);
  const missingAtPayload = structuredClone(valid);
  missingAtPayload.zh_cn.content[4][1] = { tag: "at", user_id: "someone" };
  const extraLine = validateMorningPayload(extraRowPayload, { date: "2026-07-03" });
  const unexpectedMention = validateMorningPayload(missingAtPayload, { date: "2026-07-03" });

  assert.equal(extraLine.ok, false);
  assert.match(extraLine.errors.join("\n"), /exactly five rows/);
  assert.equal(unexpectedMention.ok, false);
  assert.match(unexpectedMention.errors.join("\n"), /end with @all/);
});

test("SOP13 rotation selects item 8 on 2026-07-03", () => {
  const selected = selectSopForDate("2026-07-03");

  assert.equal(selected.dayNumber, 8);
  assert.equal(selected.index, 8);
  assert.equal(selected.name, "项目复盘 SOP");
});

test("SOP13 dry-run preserves the HappyCapy rich-post format", () => {
  const result = buildSop13DryRun({ date: "2026-07-03" });
  const content = result.payload.zh_cn.content;

  assert.equal(result.job, "sop13");
  assert.equal(result.dryRun, true);
  assert.equal(result.msgType, "post");
  assert.equal(result.selectedSop.name, "项目复盘 SOP");
  assert.deepEqual(result.validation.errors, []);
  assert.equal(result.payload.zh_cn.title, "");
  assert.deepEqual(content[0], [
    {
      tag: "text",
      text: "【每日遇见】 今日 SOP：项目复盘 ",
      style: ["bold"]
    },
    {
      tag: "at",
      user_id: "all"
    }
  ]);
  assert.deepEqual(content[1], [{ tag: "text", text: "　" }]);
  assert.deepEqual(content[2], [{ tag: "text", text: "原文精华", style: ["bold"] }]);
  assert.equal(content.at(-6)[0].text, "5 分钟练习");
  assert.deepEqual(content.at(-4), [
    {
      tag: "md",
      text: "> 复盘对象：\n> 原目标：\n> 实际结果：\n> 关键偏差：\n> 下次保留：\n> 下次调整："
    }
  ]);
  assert.deepEqual(content.at(-2), [{ tag: "text", text: "一句话带走", style: ["bold"] }]);
  assert.deepEqual(validateSop13Post(result.payload), { ok: true, errors: [] });
});

test("SOP13 content pack reproduces HappyCapy-style depth for known sent examples", () => {
  const projectReview = buildSop13DryRun({ date: "2026-07-03" });
  const projectReviewText = JSON.stringify(projectReview.payload);

  assert.match(projectReviewText, /经历不等于经验/);
  assert.match(projectReviewText, /留痕提供素材，复盘提取经验，成长闭环确保经验被复用/);
  assert.doesNotMatch(projectReviewText, /核心不是多做一步/);

  const sopBuilder = buildSop13DryRun({ date: "2026-07-07" });
  const sopBuilderText = JSON.stringify(sopBuilder.payload);

  assert.match(sopBuilderText, /四步把重复经验变成方法论/);
  assert.match(sopBuilderText, /隐性经验显性化的最小路径/);
  assert.match(sopBuilderText, /经验不写成步骤就只是直觉/);
  assert.doesNotMatch(sopBuilderText, /降低含糊带来的损耗/);
});

test("SOP13 validator rejects duplicate visible outer title and missing @all", () => {
  const result = buildSop13DryRun({ date: "2026-07-03" });
  const broken = structuredClone(result.payload);
  broken.zh_cn.title = "【每日遇见】 今日 SOP：项目复盘";
  broken.zh_cn.content[0] = [broken.zh_cn.content[0][0]];

  const validation = validateSop13Post(broken);

  assert.equal(validation.ok, false);
  assert.match(validation.errors.join("\n"), /outer title/);
  assert.match(validation.errors.join("\n"), /row 0.*@all/);
});

test("SOP13 validator rejects a repeated SOP suffix in the visible title", () => {
  const result = buildSop13DryRun({ date: "2026-07-03" });
  const broken = structuredClone(result.payload);
  broken.zh_cn.content[0][0].text = "【每日遇见】 今日 SOP：项目复盘 SOP ";

  const validation = validateSop13Post(broken, {
    expectedSopName: result.selectedSop.name
  });

  assert.equal(validation.ok, false);
  assert.match(validation.errors.join("\n"), /must not repeat SOP/);
});
