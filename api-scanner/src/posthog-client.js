const { PostHog } = require("posthog-node");
const os = require("os");

// PostHog client for CLI analytics.
// Set POSTHOG_API_KEY and POSTHOG_HOST in your environment (or api-scanner/.env).
// With Node 20+, you can load the .env file via: node --env-file=.env index.js <spec>
const posthog = new PostHog(process.env.POSTHOG_API_KEY, {
  host: process.env.POSTHOG_HOST,
  // CLI is a short-lived process — flush each event immediately
  flushAt: 1,
  flushInterval: 0,
  enableExceptionAutocapture: true,
});

// Use hostname as a stable machine-level distinct ID for CLI usage analytics
const distinctId = os.hostname();

module.exports = { posthog, distinctId };
