# Zeabur Automation Smoke Test

This is a tiny service to verify whether Kane's Zeabur server can host a HappyCapy-like automation core.

It checks:

- web service startup
- environment variables
- persistent file storage
- scheduled background heartbeat
- outbound network access

## Endpoints

- `/` — simple status page
- `/health` — health check
- `/api/status` — JSON status, folders, env presence, recent heartbeats
- `/api/outbound` — tests outbound access to Feishu and OpenAI
- `POST /api/heartbeat` — writes one manual heartbeat

## Zeabur Setup

Deploy from GitHub.

Set environment variables:

```text
DATA_DIR=/data
HEARTBEAT_INTERVAL_MS=60000
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

If all pass, this server can host the first version of Kane Automation Hub.

