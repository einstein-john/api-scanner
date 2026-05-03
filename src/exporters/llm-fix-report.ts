import type { EndpointResult, ScanReport, TestResult } from "../types";

const STATUS_CHECK = "STATUS_CODE";

/** Failures omitted from the LLM actionable list (401/403 vs declared 200, etc.). */
export function isStatusCodeFailure(t: TestResult): boolean {
  return t.status === "fail" && t.check === STATUS_CHECK;
}

export function actionableFailures(result: EndpointResult): TestResult[] {
  return result.tests.filter(
    (t) => t.status === "fail" && !isStatusCodeFailure(t),
  );
}

/** Every failure is only STATUS_CODE (typical for protected routes). */
export function isStatusOnlyFailureEndpoint(result: EndpointResult): boolean {
  const fails = result.tests.filter((t) => t.status === "fail");
  return fails.length > 0 && fails.every(isStatusCodeFailure);
}

export interface LlmFixReportJson {
  generatedAt: string;
  specTitle: string;
  specVersion: string;
  instructions: string;
  actionableEndpoints: Array<{
    operationId: string;
    method: string;
    pathTemplate: string;
    url: string;
    summary?: string;
    httpStatus?: number;
    failures: Array<{ check: string; message: string; details?: Record<string, unknown> }>;
    fkIssues: Array<{ type: string; severity: string; message: string }>;
  }>;
  statusOnlyEndpoints: Array<{
    operationId: string;
    method: string;
    pathTemplate: string;
    url: string;
    httpStatus?: number;
    note: string;
  }>;
}

export function buildLlmFixReportJson(report: ScanReport): LlmFixReportJson {
  const actionableEndpoints: LlmFixReportJson["actionableEndpoints"] = [];
  const statusOnlyEndpoints: LlmFixReportJson["statusOnlyEndpoints"] = [];

  for (const r of report.results) {
    const fails = actionableFailures(r);
    const fk = r.fkIssues?.filter((x) => x.severity !== "info") ?? [];

    if (
      fails.length === 0 &&
      fk.length === 0 &&
      isStatusOnlyFailureEndpoint(r)
    ) {
      statusOnlyEndpoints.push({
        operationId: r.endpoint.operationId,
        method: r.endpoint.method,
        pathTemplate: r.endpoint.pathTemplate,
        url: r.endpoint.url,
        httpStatus: r.response?.status,
        note:
          "Only STATUS_CODE mismatch — common when routes require auth. Skipped from actionable fixes.",
      });
      continue;
    }

    if (fails.length > 0 || fk.length > 0) {
      actionableEndpoints.push({
        operationId: r.endpoint.operationId,
        method: r.endpoint.method,
        pathTemplate: r.endpoint.pathTemplate,
        url: r.endpoint.url,
        summary: r.endpoint.summary,
        httpStatus: r.response?.status,
        failures: fails.map((t) => ({
          check: t.check,
          message: t.message,
          details: t.details,
        })),
        fkIssues: fk.map((x) => ({
          type: x.type,
          severity: x.severity,
          message: x.message,
        })),
      });
    }
  }

  return {
    generatedAt: report.meta.timestamp,
    specTitle: report.meta.specTitle,
    specVersion: report.meta.specVersion,
    instructions:
      "Fix the actionable issues below. STATUS_CODE mismatches are intentionally omitted from actionable items — many endpoints return 401/403 without correct bearer tokens or API keys. Focus on schema validation, required fields, content-type, HTTP connection errors, and FK/design warnings.",
    actionableEndpoints,
    statusOnlyEndpoints,
  };
}

export function exportLlmFixReportMarkdown(report: ScanReport): string {
  const json = buildLlmFixReportJson(report);
  const lines: string[] = [];

  lines.push(`# LLM fix report: ${json.specTitle}`);
  lines.push("");
  lines.push(`- **Spec version:** ${json.specVersion}`);
  lines.push(`- **Generated:** ${json.generatedAt}`);
  lines.push("");
  lines.push("## Instructions for the LLM");
  lines.push("");
  lines.push(json.instructions);
  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push(
    `## Actionable endpoints (${json.actionableEndpoints.length})`,
  );
  lines.push("");

  if (json.actionableEndpoints.length === 0) {
    lines.push(
      "_No actionable failures (after excluding STATUS_CODE-only issues)._",
    );
    lines.push("");
  }

  for (const ep of json.actionableEndpoints) {
    lines.push(`### \`${ep.method}\` ${ep.pathTemplate}`);
    lines.push("");
    lines.push(`- **operationId:** \`${ep.operationId}\``);
    lines.push(`- **URL tested:** ${ep.url}`);
    if (ep.summary) lines.push(`- **summary:** ${ep.summary}`);
    if (ep.httpStatus != null) {
      lines.push(
        `- **HTTP status received:** ${ep.httpStatus} _(informational)_`,
      );
    }
    lines.push("");

    if (ep.failures.length > 0) {
      lines.push("**Failures (non–status-code):**");
      for (const f of ep.failures) {
        lines.push(`- **${f.check}:** ${f.message}`);
        if (f.details && Object.keys(f.details).length > 0) {
          lines.push(`  - details: \`${JSON.stringify(f.details)}\``);
        }
      }
      lines.push("");
    }

    if (ep.fkIssues.length > 0) {
      lines.push("**Foreign-key / design findings:**");
      for (const fk of ep.fkIssues) {
        lines.push(`- **[${fk.severity}] ${fk.type}:** ${fk.message}`);
      }
      lines.push("");
    }

    lines.push("---");
    lines.push("");
  }

  lines.push(
    `## Status-only mismatches (${json.statusOnlyEndpoints.length})`,
  );
  lines.push("");
  lines.push(
    "_These only failed the expected HTTP status check — often auth-related; do not assume an implementation bug._",
  );
  lines.push("");

  for (const ep of json.statusOnlyEndpoints) {
    lines.push(
      `- **${ep.method}** \`${ep.pathTemplate}\` (\`${ep.operationId}\`) → HTTP ${ep.httpStatus ?? "?"} — ${ep.note}`,
    );
  }

  lines.push("");
  lines.push("## Machine-readable JSON");
  lines.push("");
  lines.push("```json");
  lines.push(JSON.stringify(json, null, 2));
  lines.push("```");

  return lines.join("\n");
}
