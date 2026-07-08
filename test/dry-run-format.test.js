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

test("morning motivation dry-run preserves the HappyCapy text format", () => {
  const result = buildMorningMotivationDryRun({
    date: "2026-07-03",
    headline: "先稳住今天最小的一步",
    body: "把注意力放回能推进的一件小事上。"
  });

  assert.equal(result.job, "morningMotivation");
  assert.equal(result.dryRun, true);
  assert.equal(result.msgType, "text");
  assert.deepEqual(result.validation.errors, []);
  assert.deepEqual(result.payload, {
    text: "【晨间激励 · 2026-07-03】\n\n先稳住今天最小的一步\n\n把注意力放回能推进的一件小事上。<at user_id=\"all\"></at>"
  });
  assert.deepEqual(validateMorningPayload(result.payload), { ok: true, errors: [] });
});

test("morning motivation validator rejects old title-line @all format", () => {
  const validation = validateMorningPayload({
    text: "【晨间激励】2026-07-03 <at user_id=\"all\"></at>\n\n先稳住今天最小的一步\n\n把注意力放回能推进的一件小事上。"
  }, { date: "2026-07-03" });

  assert.equal(validation.ok, false);
  assert.match(validation.errors.join("\n"), /first line/);
  assert.match(validation.errors.join("\n"), /title line/);
  assert.match(validation.errors.join("\n"), /final body sentence/);
});

test("morning motivation default content rotates beyond a fixed weekday slogan", () => {
  const first = buildMorningMotivationDryRun({ date: "2026-07-08" });
  const nextWeek = buildMorningMotivationDryRun({ date: "2026-07-15" });

  assert.equal(first.validation.ok, true);
  assert.equal(nextWeek.validation.ok, true);
  assert.notEqual(first.selectedContent.theme, nextWeek.selectedContent.theme);
  assert.notEqual(first.payload.text, nextWeek.payload.text);
  assert.match(first.payload.text, /^【晨间激励 · 2026-07-08】\n\n/);
  assert.match(nextWeek.payload.text, /^【晨间激励 · 2026-07-15】\n\n/);
  assert.doesNotMatch(first.payload.text.replaceAll("<at user_id=\"all\"></at>", ""), /[#*_`]/);
});

test("morning motivation selection is date based, not server timezone based", () => {
  assert.equal(selectMorningContent("2026-07-06").theme, "Sunday / reset");
  assert.equal(selectMorningContent("2026-07-07").theme, "courage");
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
      text: "【每日遇见】 今日 SOP：项目复盘 SOP ",
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
      text: "> 目标：\n> 输入：\n> 输出：\n> 验收标准：\n> 最大风险：\n> 最小可交付版本："
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
  broken.zh_cn.title = "【每日遇见】 今日 SOP：项目复盘 SOP";
  broken.zh_cn.content[0] = [broken.zh_cn.content[0][0]];

  const validation = validateSop13Post(broken);

  assert.equal(validation.ok, false);
  assert.match(validation.errors.join("\n"), /outer title/);
  assert.match(validation.errors.join("\n"), /row 0.*@all/);
});
