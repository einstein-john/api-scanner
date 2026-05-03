import chalk from "chalk";
import type { EndpointResult, ReportMeta, ScanReport, TestResult } from "../types";

export function printReport(report: ScanReport): void {
  const { meta, results } = report;

  console.log("\n" + chalk.bold("━".repeat(60)));
  console.log(chalk.bold(`  📋 ${meta.specTitle} v${meta.specVersion}`));
  console.log(chalk.bold("━".repeat(60)));

  for (const result of results) {
    printEndpointResult(result);
  }

  printSummary(meta, results);
}

function printEndpointResult(result: EndpointResult): void {
  const { endpoint, response, tests, fkIssues, status } = result;
  const icon =
    status === "pass"
      ? chalk.green("✓")
      : status === "warn"
        ? chalk.yellow("⚠")
        : chalk.red("✗");
  const methodColor: Record<string, (s: string) => string> = {
    GET: chalk.blue,
    POST: chalk.green,
    PUT: chalk.yellow,
    PATCH: chalk.magenta,
    DELETE: chalk.red,
  };
  const colorFn = methodColor[endpoint.method] || chalk.white;

  console.log(
    `\n ${icon} ${colorFn(endpoint.method.padEnd(6))} ${chalk.bold(endpoint.url)}` +
      (response
        ? chalk.gray(` → ${response.status} (${response.elapsed}ms)`)
        : chalk.red(" → NO RESPONSE")),
  );

  const fails = tests.filter((t) => t.status === "fail");
  const warns = tests.filter((t) => t.status === "warn");
  const passed = tests.filter((t) => t.status === "pass");

  for (const t of fails) {
    console.log(`   ${chalk.red("✗")} ${chalk.dim(t.check)}: ${t.message}`);
    printTestDetails(t);
  }

  for (const t of warns) {
    console.log(`   ${chalk.yellow("⚠")} ${chalk.dim(t.check)}: ${t.message}`);
  }

  if (fails.length === 0 && warns.length === 0) {
    console.log(chalk.green(`   All ${passed.length} checks passed`));
  }

  if (fkIssues?.length) {
    for (const issue of fkIssues) {
      const sev =
        {
          error: chalk.red("🔴"),
          warning: chalk.yellow("🟡"),
          info: chalk.blue("🔵"),
        }[issue.severity] || "🔵";
      console.log(`   ${sev} ${chalk.dim("[FK]")} ${issue.message}`);
    }
  }
}

function printTestDetails(t: TestResult): void {
  const d = t.details;
  if (!d) return;

  const loc = d.location as
    | { method?: string; url?: string; pathTemplate?: string; operationId?: string }
    | undefined;
  if (loc && typeof loc === "object") {
    if (loc.method && loc.url) {
      console.log(
        `     ${chalk.dim("where")} ${loc.method} ${chalk.bold(loc.url)}`,
      );
    }
    if (loc.pathTemplate) {
      console.log(`     ${chalk.dim("pathTemplate")} ${loc.pathTemplate}`);
    }
    if (loc.operationId) {
      console.log(`     ${chalk.dim("operationId")} ${loc.operationId}`);
    }
  }

  if (typeof d.responseStatus === "number") {
    const st = d.responseStatusText
      ? String(d.responseStatusText)
      : "";
    console.log(
      `     ${chalk.dim("responseStatus")} ${d.responseStatus}${st ? ` ${st}` : ""}`,
    );
  }

  if (typeof d.axiosCode === "string") {
    console.log(`     ${chalk.dim("axiosCode")} ${d.axiosCode}`);
  }

  if (typeof d.explanation === "string") {
    console.log(`     ${chalk.dim("why")} ${d.explanation}`);
  }
  if (typeof d.hint === "string") {
    console.log(`     ${chalk.dim("hint")} ${d.hint}`);
  }

  if (typeof d.phase === "string" && d.phase === "no_http_response") {
    if (typeof d.reason === "string") {
      console.log(`     ${chalk.dim("reason")} ${d.reason}`);
    }
  }

  const errs = d.errors as string[] | undefined;
  if (errs) {
    for (const e of errs.slice(0, 3)) {
      console.log(`     ${chalk.red("→")} ${chalk.dim(e)}`);
    }
  }
}

function printSummary(meta: ReportMeta, results: EndpointResult[]): void {
  console.log("\n" + chalk.bold("━".repeat(60)));

  const failedEndpoints = results.filter((r) => r.status === "fail");
  const warnedEndpoints = results.filter((r) => r.status === "warn");
  const passedEndpoints = results.filter((r) => r.status === "pass");
  const allFkIssues = results.flatMap((r) => r.fkIssues || []);

  console.log(
    `  Endpoints: ${chalk.green(passedEndpoints.length + " pass")}` +
      ` ${chalk.yellow(warnedEndpoints.length + " warn")}` +
      ` ${chalk.red(failedEndpoints.length + " fail")}`,
  );
  console.log(
    `  Checks:    ${chalk.green(meta.passed + " pass")}` +
      ` ${chalk.yellow(meta.warned + " warn")}` +
      ` ${chalk.red(meta.failed + " fail")}`,
  );

  if (allFkIssues.length > 0) {
    console.log(`  FK Issues: ${chalk.yellow(allFkIssues.length + " found")}`);
  }

  console.log(chalk.bold("━".repeat(60)) + "\n");
}
