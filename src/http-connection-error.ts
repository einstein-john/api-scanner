import axios from "axios";
import type { EndpointDefinition, TestResult } from "./types";

/** Builds a failure result when no usable HTTP response was received (or axios threw before attach). */
export function buildHttpConnectionFailure(
  endpoint: EndpointDefinition,
  err: unknown,
): TestResult {
  const location = {
    method: endpoint.method,
    url: endpoint.url,
    pathTemplate: endpoint.pathTemplate,
    operationId: endpoint.operationId,
  };

  const where =
    `${endpoint.method} ${endpoint.url} · ${endpoint.pathTemplate} · operationId "${endpoint.operationId}"`;

  if (axios.isAxiosError(err)) {
    const status = err.response?.status;
    const statusText = err.response?.statusText;
    const code = err.code;
    const msg = err.message || "Unknown axios error";

    const details: Record<string, unknown> = {
      location,
      ...(code !== undefined ? { axiosCode: code } : {}),
    };

    let message: string;

    if (status != null) {
      details.responseStatus = status;
      if (statusText) details.responseStatusText = statusText;
      message = `HTTP ${status}${statusText ? ` ${statusText}` : ""} at ${where}.`;
      if (code) message += ` [${code}]`;
      if (msg && !/^request failed with status code/i.test(msg)) {
        message += ` ${msg}`;
      }
    } else {
      details.phase = "no_http_response";
      details.reason = msg;
      message = `No HTTP response · ${where}`;
      if (code) message += ` · [${code}]`;
      message += `: ${msg}`;
    }

    return {
      status: "fail",
      check: "HTTP_CONNECTION",
      message,
      details,
    };
  }

  const msg = err instanceof Error ? err.message : String(err);
  return {
    status: "fail",
    check: "HTTP_CONNECTION",
    message: `No HTTP response · ${where}: ${msg}`,
    details: {
      location,
      phase: "no_http_response",
      reason: msg,
    },
  };
}
