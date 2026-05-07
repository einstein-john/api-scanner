import { PostHog } from "posthog-node";
import os from "os";

const posthog = new PostHog(process.env.POSTHOG_API_KEY!, {
  host: process.env.POSTHOG_HOST,
  enableExceptionAutocapture: true,
});

// Use hostname as a stable machine-level distinct ID for analytics
const distinctId = os.hostname();

export { posthog, distinctId };
