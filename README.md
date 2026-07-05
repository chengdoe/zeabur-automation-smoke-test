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

## Endpoints

- `/` — simple status page
- `/health` — health check
- `/api/status` — JSON status, folders, env presence, recent heartbeats
- `/api/outbound` — tests outbound access to Feishu and OpenAI
- `/api/jobs` — lists available dry-run jobs
- `POST /api/jobs/sop13/dry-run` — generates SOP13 rich-post dry-run payload and audit files; does not send
- `POST /api/jobs/morning-motivation/dry-run` — generates morning motivation text dry-run payload and audit files; does not send
- `POST /api/jobs/sop13/send?confirm=SEND` — gated live-send endpoint; blocked unless `LIVE_SEND_ENABLED=true`
- `POST /api/jobs/morning-motivation/send?confirm=SEND` — gated live-send endpoint; blocked unless `LIVE_SEND_ENABLED=true`
- `POST /api/heartbeat` — writes one manual heartbeat

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
/data/outputs/automations/scheduler/<YYYY-MM-DD>.log.json
```

## Dry-Run Schedule

The scheduler is dry-run only. It writes payload previews and audit files, and never sends Feishu messages.

- `morning-motivation` runs daily at 09:00 Asia/Shanghai.
- `sop13` runs daily at 09:30 Asia/Shanghai.
- Set `SCHEDULER_ENABLED=false` to disable scheduled dry-runs.

## Message Formats

`morning-motivation` sends Feishu `text` and mirrors the current HappyCapy format:

```text
【晨间激励 · YYYY-MM-DD】

<one powerful line>

<short Chinese body><at user_id="all"></at>
```

`sop13` sends Feishu `post`; the outer `zh_cn.title` stays empty, and row 0 contains the visible bold title plus `{ "tag": "at", "user_id": "all" }`.

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
