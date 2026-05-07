import { PostHog } from "posthog-node";
import os from "os";

const apiKey = process.env.POSTHOG_API_KEY?.trim();
const host = process.env.POSTHOG_HOST?.trim();

function createDisabledPosthog(): PostHog {
  return {
    capture: () => {},
    captureException: () => {},
    shutdown: async () => {},
  } as unknown as PostHog;
}

const posthog: PostHog = apiKey
  ? new PostHog(apiKey, {
      host: host || undefined,
      enableExceptionAutocapture: true,
    })
  : createDisabledPosthog();

const distinctId = os.hostname();

export { posthog, distinctId };
