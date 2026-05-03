import type { AxiosRequestConfig } from "axios";
import type { AuthContextSummary } from "./types";

/**
 * Normalized credentials: bearer + API key can both be set for gateways that require both.
 */
export interface ResolvedRequestAuth {
  bearerToken?: string;
  apiKey?: { header: string; value: string };
  basic?: { username: string; password: string };
}

function normalizeAuthPartial(input: unknown): Partial<ResolvedRequestAuth> {
  if (!input || typeof input !== "object") return {};
  const r = input as Record<string, unknown>;

  const out: Partial<ResolvedRequestAuth> = {};

  const bearerRaw = typeof r.bearerToken === "string" ? r.bearerToken.trim() : "";
  if (bearerRaw) out.bearerToken = bearerRaw;

  const apiKeyHeaderRaw =
    typeof r.apiKeyHeader === "string" ? r.apiKeyHeader.trim() : "";
  const apiKeyValRaw =
    typeof r.apiKeyValue === "string" ? r.apiKeyValue.trim() : "";
  if (apiKeyValRaw) {
    out.apiKey = {
      header: apiKeyHeaderRaw || "X-API-Key",
      value: apiKeyValRaw,
    };
  }

  const basicUser =
    typeof r.basicUsername === "string" ? r.basicUsername : "";
  const basicPass =
    typeof r.basicPassword === "string" ? r.basicPassword : "";
  if (basicUser !== "" || basicPass !== "") {
    out.basic = { username: basicUser, password: basicPass };
  }

  const typ = typeof r.type === "string" ? r.type : "";
  const legacyToken = String(r.token ?? "").trim();
  if (typ === "bearer" || typ === "jwt") {
    if (legacyToken) out.bearerToken = legacyToken;
  } else if (typ === "apikey") {
    if (legacyToken) {
      out.apiKey = {
        header: String(r.header || "X-API-Key"),
        value: legacyToken,
      };
    }
  } else if (typ === "basic") {
    out.basic = {
      username: String(r.username ?? ""),
      password: String(r.password ?? ""),
    };
  }

  return out;
}

/** Merge spec `x-scanner.auth` with request options; options override per mechanism when set. */
export function resolveRequestAuth(
  specAuth: unknown,
  optionsAuth: unknown,
): ResolvedRequestAuth | undefined {
  const s = normalizeAuthPartial(specAuth);
  const o = normalizeAuthPartial(optionsAuth);
  const merged: ResolvedRequestAuth = {};
  merged.bearerToken = o.bearerToken ?? s.bearerToken;
  merged.apiKey = o.apiKey ?? s.apiKey;
  merged.basic = o.basic ?? s.basic;

  if (!merged.bearerToken && !merged.apiKey && !merged.basic) return undefined;
  return merged;
}

/** Snapshot of which auth mechanisms were configured (used in test failure hints). */
export function authContextFromResolved(
  auth: ResolvedRequestAuth | undefined,
): AuthContextSummary {
  return {
    hadBearer: !!auth?.bearerToken,
    hadApiKey: !!auth?.apiKey?.value,
    hadBasic: !!(auth?.basic?.username || auth?.basic?.password),
  };
}

export function applyResolvedAuth(
  req: AxiosRequestConfig,
  auth: ResolvedRequestAuth | undefined,
): void {
  if (!auth) return;
  const h = { ...(req.headers as Record<string, string>) };
  if (auth.bearerToken) {
    h["Authorization"] = `Bearer ${auth.bearerToken}`;
  }
  if (auth.apiKey?.value) {
    const name = auth.apiKey.header || "X-API-Key";
    h[name] = auth.apiKey.value;
  }
  req.headers = h;
  if (
    auth.basic &&
    (auth.basic.username !== "" || auth.basic.password !== "")
  ) {
    req.auth = {
      username: auth.basic.username,
      password: auth.basic.password,
    };
  }
}
