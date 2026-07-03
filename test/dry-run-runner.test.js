import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { runDryRunJob } from "../src/dryRunRunner.js";

test("dry-run runner writes audit files and never sends", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "zeabur-dry-run-"));
  const result = await runDryRunJob({
    job: "sop13",
    date: "2026-07-03",
    dataDir
  });

  assert.equal(result.ok, true);
  assert.equal(result.dryRun, true);
  assert.equal(result.sent, false);
  assert.equal(result.msgType, "post");
  assert.match(result.files.json, /outputs\/automations\/sop13\/2026-07-03-dry-run\.json$/);
  assert.match(result.files.markdown, /outputs\/automations\/sop13\/2026-07-03-dry-run\.md$/);

  const json = JSON.parse(await readFile(result.files.json, "utf8"));
  const markdown = await readFile(result.files.markdown, "utf8");

  assert.equal(json.payload.zh_cn.title, "");
  assert.equal(json.sent, false);
  assert.match(markdown, /# sop13 Dry Run/);
  assert.match(markdown, /Selected SOP: 项目复盘 SOP/);
  assert.match(markdown, /No Feishu message was sent/);
});
