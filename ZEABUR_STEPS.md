# Zeabur Deployment Steps

## 1. Put This Project On GitHub

Create a GitHub repository named:

`zeabur-automation-smoke-test`

Push this folder as the repository root:

`/Users/kane/Documents/Codex/2026-06-26/wo-x/outputs/zeabur-automation-smoke-test`

## 2. Deploy In Zeabur

In the Zeabur project `happycapy-automations`:

1. Click `部署新服务`.
2. Choose `GitHub`.
3. Pick the `zeabur-automation-smoke-test` repository.
4. Deploy it as a Node.js service.

If Zeabur asks for a port, use:

`3000`

## 3. Environment Variables

Add these variables in the service configuration:

```text
DATA_DIR=/data
HEARTBEAT_INTERVAL_MS=60000
TEST_SECRET=hello-from-zeabur
```

Do not add real Feishu/OpenAI secrets yet. This is only a smoke test.

## 4. Persistent Volume

Add a persistent volume mounted at:

`/data`

This is the key test. Without it, `memory/uploads/outputs` may disappear after restart/redeploy.

## 5. Verify

Open the deployed service URL.

Check:

- `/health`
- `/api/status`
- `/api/outbound`

Pass criteria:

- `/health` returns `ok: true`
- `/api/status` shows `hasTestSecret: true`
- `/api/status` shows `dataDir: /data`
- `recentHeartbeats` grows over several minutes
- restart/redeploy does not delete `persistence-probe.json`
- `/api/outbound` can reach Feishu or at least returns network results

If these pass, the server is ready for the real `Kane Automation Hub` MVP.

