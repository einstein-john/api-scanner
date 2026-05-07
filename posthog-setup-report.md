<wizard-report>
# PostHog post-wizard report

The wizard has completed a deep integration of PostHog analytics into the api-scanner project. The `posthog-node` SDK was installed and a shared client module (`src/posthog-client.ts`) was created using environment variables for the API key and host. Eight events were added across the three main entry points of the application — the Express HTTP server (`src/server.ts`), the core test runner (`src/runner.ts`), and the CLI (`src/cli.ts`). Exception capture (`posthog.captureException`) was added to key error handlers in the server and CLI. The CLI calls `posthog.shutdown()` before each `process.exit()` to ensure events are flushed from this short-lived process. The server retains the default batching behavior, appropriate for a long-running process.

| Event | Description | File |
|---|---|---|
| `spec parsed` | API spec successfully uploaded and parsed via the web UI | `src/server.ts` |
| `scan started` | Scan initiated via the web UI | `src/server.ts` |
| `scan completed` | Scan finished (with pass/fail/warn counts and `had_failures` flag) | `src/server.ts` |
| `export downloaded` | User downloaded a scan export (with `format` property) | `src/server.ts` |
| `endpoint test failed` | Individual endpoint produced at least one failing test | `src/runner.ts` |
| `cli scan started` | CLI user initiated a scan | `src/cli.ts` |
| `cli scan completed` | CLI scan finished (with summary counts) | `src/cli.ts` |
| `cli spec parse failed` | CLI failed to load or parse the provided spec file | `src/cli.ts` |

## Next steps

We've built some insights and a dashboard for you to keep an eye on user behavior, based on the events we just instrumented:

- [Analytics basics dashboard](/dashboard/667345)
- [Scan Volume Over Time](/insights/JALS6OyW) — server and CLI scans per day
- [Spec Parse → Scan → Export Funnel](/insights/ph390aXz) — conversion funnel from parsing a spec to downloading an export
- [Endpoint Test Failures Over Time](/insights/m6RgTYdc) — daily count of endpoint failures, a key API health signal
- [Scans With Failures](/insights/YKErmDrx) — scans with at least one failing endpoint vs all scans
- [Export Downloads by Format](/insights/evJF6vss) — which export formats (postman, insomnia, report, llm) users prefer

### Agent skill

We've left an agent skill folder in your project. You can use this context for further agent development when using Claude Code. This will help ensure the model provides the most up-to-date approaches for integrating PostHog.

</wizard-report>
