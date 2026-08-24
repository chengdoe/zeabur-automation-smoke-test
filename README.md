# Zeabur Automation Smoke Test

This is a tiny service to verify whether Kane's Zeabur server can host a HappyCapy-like automation core.

It checks:

- web service startup
- environment variables
- persistent file storage
- scheduled background heartbeat
- scheduled dry-run automation
- gated Feishu live-send runner
- outbound network access
- AI HOT daily intelligence dry-run
- Automation Sentinel task-level circuit breakers and standalone zero-model watchdog

## Endpoints

- `/` — simple status page
- `/health` — health check
- `/api/status` — JSON status, folders, env presence, recent heartbeats
- `/api/outbound` — tests outbound access to Feishu and OpenAI
- `/api/jobs` — lists available dry-run jobs
- `POST /api/jobs/ai-hot/dry-run` — generates AI HOT ranked native-post dry-run payload and audit files; does not send
- `POST /api/jobs/ai-hot/send?confirm=SEND` — gated AI HOT live-send endpoint; blocked unless global and task gates plus bot identity are configured
- `POST /api/jobs/sop13/dry-run` — generates SOP13 rich-post dry-run payload and audit files; does not send
- `POST /api/jobs/morning-motivation/dry-run` — generates morning motivation text dry-run payload and audit files; does not send
- `POST /api/jobs/sop13/send?confirm=SEND` — gated live-send endpoint; blocked unless `LIVE_SEND_ENABLED=true`
- `POST /api/jobs/morning-motivation/send?confirm=SEND` — gated live-send endpoint; blocked unless `LIVE_SEND_ENABLED=true`
- `POST /api/heartbeat` — writes one manual heartbeat
- `GET /api/sentinel/monitor-status` — credentialed, redacted monitor snapshot for the standalone Watchdog

The standalone Sentinel process uses `npm run sentinel:start` and exposes:

- `GET /health`
- `GET /api/sentinel/status`
- `POST /api/sentinel/watchdog/dry-run`
- `POST /api/sentinel/watchdog/send?confirm=SEND` — still blocked unless every Sentinel send gate and identity field is configured

## Zeabur Setup

Deploy from GitHub.

Set environment variables:

```text
DATA_DIR=/data
HEARTBEAT_INTERVAL_MS=60000
SCHEDULER_ENABLED=true
SCHEDULER_INTERVAL_MS=60000
LIVE_SEND_ENABLED=false
TEST_SECRET=hello-from-zeabur
```

If Zeabur asks for a port, use:

```text
3000
```

Add a persistent volume mounted to:

```text
/data
```

The app writes:

```text
/data/memory/
/data/uploads/
/data/outputs/heartbeat/heartbeat.log
/data/outputs/reports/persistence-probe.json
/data/outputs/automations/*/<YYYY-MM-DD>-dry-run.json
/data/outputs/automations/*/<YYYY-MM-DD>-dry-run.md
/data/outputs/automations/*/<YYYY-MM-DD>-sent.json
/data/outputs/automations/ai-hot/ledger.json
/data/outputs/automations/scheduler/<YYYY-MM-DD>.log.json
```

## Dry-Run Schedule

The scheduler is dry-run only. It writes payload previews and audit files, and never sends Feishu messages.

- `ai-hot` runs daily at 10:00 Asia/Shanghai when `AI_HOT_SCHEDULER_ENABLED=true`.
- `morning-motivation` runs daily at 09:00 Asia/Shanghai.
- `sop13` runs daily at 09:30 Asia/Shanghai.
- Set `SCHEDULER_ENABLED=false` to disable scheduled dry-runs.

## Message Formats

`morning-motivation` sends Feishu `post` and mirrors the current HappyCapy format:

```text
【晨间激励 · YYYY-MM-DD】

<one powerful line>

<short Chinese body><at user_id="all"></at>
```

Group delivery keeps the native `@all`; private delivery uses
`MORNING_MOTIVATION_RECEIVE_ID_TYPE=open_id` plus
`MORNING_MOTIVATION_TARGET_RECEIVE_ID` and removes only the group-only `@all`
at send time.

`sop13` sends Feishu `post`; the outer `zh_cn.title` stays empty. Group delivery keeps the native `@all`; private delivery uses `SOP13_RECEIVE_ID_TYPE=open_id` plus `SOP13_TARGET_RECEIVE_ID` and removes the group-only `@all` at send time.

`ai-hot` sends Feishu `post`; the outer `zh_cn.title` stays empty, row 0 contains the visible bold title `【AI HOT 关注简报 · YYYY-MM-DD】`, and every item title row is a Feishu markdown bold link like `**1. [Title](source-url)**`. The visible item title row only contains the rank and linked title; source and credibility metadata stay internal. Item prose is sentence-boundary trimmed, uses direct Chinese wording, and rejects ellipsis-style truncation or source boilerplate such as `了解更多`. It does not include a trailing judgment, action list, or data-source footer. It uses deterministic ranking rules and makes zero model calls.

## AI HOT Setup

AI HOT source access:

```text
AI_HOT_USER_AGENT=KaneAIHotAutomation/0.1 (+https://aihot.virxact.com/agent)
```

Optional dry-run fixture:

```text
AI_HOT_ITEMS_JSON_FILE=/path/to/selected-items.json
AI_HOT_NOW=2026-07-16T03:30:00.000Z
```

Live send stays closed until all of these are deliberately set:

```text
LIVE_SEND_ENABLED=true
AI_HOT_ENABLED=true
AI_HOT_BOT_ROLE=zhiwei_agent
AI_HOT_CONNECTION_REF=zhiwei_agent
AI_HOT_TARGET_CHAT_ID=<拾叁事务所 chat id>
FEISHU_CONNECTION_<REF>_APP_ID=<secret>
FEISHU_CONNECTION_<REF>_APP_SECRET=<secret>
```

The live runner also checks recent group messages for the visible title `【AI HOT 关注简报 · YYYY-MM-DD】` before sending, then writes `/data/outputs/automations/ai-hot/ledger.json`.

## Controlled Live Send

Live-send is intentionally gated and is not used by the scheduler.

Required environment variables:

```text
LIVE_SEND_ENABLED=true
FEISHU_APP_ID=<Zeabur secret>
FEISHU_APP_SECRET=<Zeabur secret>
FEISHU_TARGET_CHAT_ID=<target chat id>
```

The endpoint also requires `confirm=SEND`:

```text
POST /api/jobs/sop13/send?date=2026-07-05&confirm=SEND
POST /api/jobs/morning-motivation/send?date=2026-07-05&confirm=SEND
```

Safety behavior:

- If `LIVE_SEND_ENABLED` is not `true`, the endpoint returns `sent:false`.
- If `confirm=SEND` is missing, the endpoint returns `sent:false`.
- A sent log at `/data/outputs/automations/<job>/<YYYY-MM-DD>-sent.json` blocks duplicate sends.
- Use `force=true` only for deliberate manual recovery.
- The scheduler remains dry-run only.

## Automation Sentinel

Sentinel is deterministic and makes zero LLM/OpenRouter calls. Its task-level state, events, incidents, model-request budgets, and alert deliveries live under:

```text
/data/outputs/ops/sentinel/
```

The monitored automation service should start in shadow mode:

```text
SENTINEL_ENABLED=false
SENTINEL_MODE=shadow
SENTINEL_STATUS_API_CREDENTIAL=<independent random secret>
```

The standalone Watchdog service uses the same codebase with `npm run sentinel:start` and separate configuration:

```text
SENTINEL_ENABLED=false
SENTINEL_MODE=shadow
SENTINEL_WATCHDOG_ENABLED=false
SENTINEL_WATCHDOG_INTERVAL_MS=60000
SENTINEL_MONITORED_STATUS_URL=<automation service URL>/api/sentinel/monitor-status
SENTINEL_MONITORED_STATUS_CREDENTIAL=<same monitor credential>
SENTINEL_MONITOR_TIMEOUT_MS=5000

SENTINEL_FEISHU_ENABLED=false
SENTINEL_LIVE_SEND_ENABLED=false
SENTINEL_BOT_ROLE=sentinel
SENTINEL_CONNECTION_REF=sentinel
SENTINEL_TARGET_CHAT_ID=<Kane and Sentinel P2P chat id>
FEISHU_CONNECTION_SENTINEL_APP_ID=<Zeabur secret>
FEISHU_CONNECTION_SENTINEL_APP_SECRET=<Zeabur secret>
```

All gates default closed. `SENTINEL_LIVE_SEND_ENABLED=true` is independent from the business-task send gates. The first Feishu version only needs bot scope `im:message:send_as_bot` and a known P2P `chat_id`; receiving recovery commands is a later permission expansion and is not required for alert-only shadow mode.

Local verification does not send messages or call a model:

```text
npm run sentinel:dry-run
npm run sentinel:benchmark
node --test test/sentinel*.test.js
```

## Local Test

```text
npm test
```

## Verification

After deployment:

1. Open the service URL.
2. Visit `/health`; it should return `{"ok": true}`.
3. Visit `/api/status`; confirm:
   - `hasTestSecret: true`
   - `dataDir: /data`
   - recent heartbeats exist
4. Wait 3 minutes and refresh `/api/status`; heartbeat entries should increase.
5. Redeploy or restart the service; confirm `persistence-probe.json` still exists.
6. Visit `/api/outbound`; Feishu/OpenAI checks should return network results.

If all pass, this server can host the first version of Kane Automation Hub. Do not enable live-send until Kane explicitly approves the controlled send test.
