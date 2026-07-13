import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildSop13DryRun,
  selectSopForDate,
  validateSop13Post
} from "../src/jobs/sop13.js";

const DAY_MS = 86_400_000;
const FIRST_ROUND_START = new Date("2026-06-26T00:00:00.000Z");
const SECOND_ROUND_START = new Date("2026-07-10T00:00:00.000Z");

test("SOP13 selects a deterministic authored variant for every second-round theme", () => {
  for (let offset = 0; offset < 14; offset += 1) {
    const firstDate = dateAt(FIRST_ROUND_START, offset);
    const secondDate = dateAt(SECOND_ROUND_START, offset);
    const first = selectSopForDate(firstDate);
    const second = selectSopForDate(secondDate);
    const secondAgain = selectSopForDate(secondDate);

    assert.equal(first.name, second.name);
    assert.equal(first.variantIndex, 0);
    assert.equal(second.variantIndex, 1);
    assert.equal(second.cycleNumber, 2);
    assert.notDeepEqual(second.card, first.card, `${second.name} must not repeat round one`);
    assert.deepEqual(second, secondAgain, `${second.name} selection must be deterministic`);
    assert.equal(second.variants, undefined, "selection must not expose the complete content pack");
  }
});

test("SOP13 alternates the two calibrated variants after the second round", () => {
  const first = selectSopForDate("2026-06-26");
  const second = selectSopForDate("2026-07-10");
  const third = selectSopForDate("2026-07-24");

  assert.equal(first.variantIndex, 0);
  assert.equal(second.variantIndex, 1);
  assert.equal(third.variantIndex, 0);
  assert.deepEqual(third.card, first.card);
});

test("SOP13 validator enforces non-empty ordered sections and matching title", () => {
  const result = buildSop13DryRun({ date: "2026-07-10" });

  const empty = structuredClone(result.payload);
  empty.zh_cn.content[3][0].text = "   ";
  assert.match(
    validateForSelected(empty, result).errors.join("\n"),
    /non-empty body: 原文精华/
  );

  const reordered = structuredClone(result.payload);
  [reordered.zh_cn.content[2], reordered.zh_cn.content[5]] = [
    reordered.zh_cn.content[5],
    reordered.zh_cn.content[2]
  ];
  assert.match(
    validateForSelected(reordered, result).errors.join("\n"),
    /expected heading 原文精华 at row 2/
  );

  const wrongTitle = structuredClone(result.payload);
  wrongTitle.zh_cn.content[0][0].text = "【每日遇见】 今日 SOP：错误主题 SOP ";
  assert.match(
    validateForSelected(wrongTitle, result).errors.join("\n"),
    /visible title must match selected SOP: 每日留痕 SOP/
  );
});

test("SOP13 validator rejects duplicate section bodies and a mismatched exercise template", () => {
  const result = buildSop13DryRun({ date: "2026-07-10" });

  const duplicate = structuredClone(result.payload);
  duplicate.zh_cn.content[6][0].text = duplicate.zh_cn.content[3][0].text;
  assert.match(
    validateForSelected(duplicate, result).errors.join("\n"),
    /section bodies must be unique: 原文精华 and 个人化翻译/
  );

  const mismatchedExercise = structuredClone(result.payload);
  mismatchedExercise.zh_cn.content[16][0].text = "> 通用字段：";
  assert.match(
    validateForSelected(mismatchedExercise, result).errors.join("\n"),
    /exercise template must match selected SOP variant/
  );
});

test("SOP13 second-round payload matches the reviewed rich-post snapshot", () => {
  const result = buildSop13DryRun({ date: "2026-07-10" });

  assert.deepEqual(snapshotPayload(result.payload), {
    title: "",
    visibleTitle: "【每日遇见】 今日 SOP：每日留痕 SOP ",
    mention: { tag: "at", user_id: "all" },
    sections: [
      ["原文精华", "第二轮练习不再只记录“做了什么”，而是补上“什么值得继续、什么应该停止、下次怎样更省力”。留痕要服务选择，而不是积累流水账。"],
      ["个人化翻译", "把每日记录从行动清单升级为选择日志：事实只写关键节点，随后标记继续、停止和调整。这样几天后回看，看到的是自己的判断如何变化。"],
      ["我的解读", "第一轮留痕解决的是遗忘，第二轮要解决的是重复犯错。记录如果只有完成事项，会越来越像仓库；加入取舍和下次调整，它才会变成反馈系统。真正值得保留的不是一天的全部细节，而是改变下一次行动的证据。"],
      ["今日内化问题", "今天留下的哪条事实，会让你明天选择继续、停止或调整一件事？"],
      ["5 分钟练习", "选今天最关键的一件事，写下事实、判断，以及明天要做的一个最小调整。"],
      ["一句话带走", "留痕的第二层价值，不是记住过去，而是改进下一次选择。"]
    ],
    exerciseTemplate: "> 今日关键事实：\n> 它说明了什么：\n> 值得继续：\n> 应该停止：\n> 明天最小调整："
  });
  assert.deepEqual(result.validation, { ok: true, errors: [] });
});

function validateForSelected(payload, result) {
  return validateSop13Post(payload, {
    expectedSopName: result.selectedSop.name,
    expectedExerciseTemplate: result.selectedSop.card.exerciseTemplate
  });
}

function snapshotPayload(payload) {
  const content = payload.zh_cn.content;
  return {
    title: payload.zh_cn.title,
    visibleTitle: content[0][0].text,
    mention: content[0][1],
    sections: [
      [content[2][0].text, content[3][0].text],
      [content[5][0].text, content[6][0].text],
      [content[8][0].text, content[9][0].text],
      [content[11][0].text, content[12][0].text],
      [content[14][0].text, content[15][0].text],
      [content[18][0].text, content[19][0].text]
    ],
    exerciseTemplate: content[16][0].text
  };
}

function dateAt(start, offset) {
  return new Date(start.getTime() + (offset * DAY_MS)).toISOString().slice(0, 10);
}
