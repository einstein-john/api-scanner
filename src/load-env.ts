import dotenv from "dotenv";
import fs from "fs";
import path from "path";

/** Resolve repo-root `.env` whether running from `src/` (tsx) or `dist/` (node). */
function resolveEnvPath(): string {
  return path.resolve(__dirname, "..", ".env");
}

const envPath = resolveEnvPath();
if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath });
}
