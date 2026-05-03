import pino from "pino";

const VALID_LEVELS = new Set([
  "fatal",
  "error",
  "warn",
  "info",
  "debug",
  "trace",
]);

function resolveEnvLevel(): string {
  const raw = (process.env.LOG_LEVEL || "info").toLowerCase().trim();
  if (raw === "silent") return "silent";
  if (VALID_LEVELS.has(raw)) return raw;
  return "info";
}

const resolved = resolveEnvLevel();
const silent = resolved === "silent";

/** Shared logger — JSON lines on stdout. `LOG_LEVEL`: fatal…trace | silent */
export const logger = pino({
  enabled: !silent,
  level: silent ? "info" : resolved,
  base: undefined,
  timestamp: pino.stdTimeFunctions.isoTime,
});
