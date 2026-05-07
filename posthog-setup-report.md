<wizard-report>
# PostHog post-wizard report

The wizard has completed a deep integration of PostHog analytics into `api-scanner`, a Node.js CLI tool for scanning OpenAPI specs and testing endpoints.

## What was changed

- **`api-scanner/src/posthog-client.js`** (new) — PostHog client helper. Initializes `posthog-node` with `flushAt: 1` and `flushInterval: 0` (required for short-lived CLI processes), reads credentials from environment variables, and exports a shared `distinctId` derived from `os.hostname()`.
- **`api-scanner/index.js`** — Added six event captures covering the full scan lifecycle: scan started, spec loaded, spec load failed (with exception capture), scan completed, and export completed. Added `await posthog.shutdown()` before every `process.exit()` to flush events before the process ends.
- **`api-scanner/src/runner.js`** — Added `endpoint test failed` capture for every endpoint that produces a failing test result, including method, path, operation ID, and counts.
- **`api-scanner/.env`** — Created with `POSTHOG_API_KEY` and `POSTHOG_HOST` environment variables.
- **`api-scanner/package.json`** — `posthog-node` added as a dependency.

> **Loading `.env`:** With Node.js 20+, run the CLI as `node --env-file=.env index.js <spec>` to load the env file automatically.

## Events

| Event | Description | File |
|-------|-------------|------|
| `scan started` | Fired when the user begins a scan; includes spec path, format, tag, timeout, and flags | `api-scanner/index.js` |
| `spec loaded` | Fired after the OpenAPI spec is successfully parsed; includes title, version, and endpoint count | `api-scanner/index.js` |
| `spec load failed` | Fired (with exception capture) when the spec file fails to load or parse | `api-scanner/index.js` |
| `scan completed` | Fired after all endpoint tests finish; includes passed, failed, and warned counts | `api-scanner/index.js` |
| `export completed` | Fired after scan results are exported to files; includes format and export count | `api-scanner/index.js` |
| `endpoint test failed` | Fired for each endpoint that fails; includes method, path, operation ID, and fail/warn counts | `api-scanner/src/runner.js` |

## Next steps

We've built some insights and a dashboard for you to keep an eye on user behavior, based on the events we just instrumented:

- [Analytics basics dashboard](/dashboard/667312)
- [Daily scans](/insights/mIiJ48PJ) — scan volume over time
- [Scan success vs failures](/insights/l9RaK8O7) — completed scans vs spec load failures side by side
- [Endpoint test failures over time](/insights/HsmU49zU) — how many endpoint tests fail per day
- [Export format usage](/insights/8pNkG60T) — which export formats (postman, insomnia, all) are used most
- [Spec load error rate](/insights/DXZCvZ2D) — percentage of scans that fail at spec parsing

### Agent skill

We've left an agent skill folder in your project. You can use this context for further agent development when using Claude Code. This will help ensure the model provides the most up-to-date approaches for integrating PostHog.

</wizard-report>
