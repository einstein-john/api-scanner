const chalk = require("chalk");

function printReport(report) {
  const { meta, results } = report;

  console.log("\n" + chalk.bold("━".repeat(60)));
  console.log(chalk.bold(`  📋 ${meta.specTitle} v${meta.specVersion}`));
  console.log(chalk.bold("━".repeat(60)));

  for (const result of results) {
    printEndpointResult(result);
  }

  printSummary(meta, results);
}

function printEndpointResult(result) {
  const { endpoint, response, tests, fkIssues, status } = result;
  const icon = status === "pass" ? chalk.green("✓") : status === "warn" ? chalk.yellow("⚠") : chalk.red("✗");
  const methodColor = {
    GET: chalk.blue, POST: chalk.green, PUT: chalk.yellow,
    PATCH: chalk.magenta, DELETE: chalk.red,
  }[endpoint.method] || chalk.white;

  console.log(
    `\n ${icon} ${methodColor(endpoint.method.padEnd(6))} ${chalk.bold(endpoint.url)}` +
    (response ? chalk.gray(` → ${response.status} (${response.elapsed}ms)`) : chalk.red(" → NO RESPONSE"))
  );

  const fails = tests.filter((t) => t.status === "fail");
  const warns = tests.filter((t) => t.status === "warn");
  const passed = tests.filter((t) => t.status === "pass");

  for (const t of fails) {
    console.log(`   ${chalk.red("✗")} ${chalk.dim(t.check)}: ${t.message}`);
    if (t.details?.errors) {
      for (const e of t.details.errors.slice(0, 3)) {
        console.log(`     ${chalk.red("→")} ${chalk.dim(e)}`);
      }
    }
  }

  for (const t of warns) {
    console.log(`   ${chalk.yellow("⚠")} ${chalk.dim(t.check)}: ${t.message}`);
  }

  if (fails.length === 0 && warns.length === 0) {
    console.log(
      chalk.green(`   All ${passed.length} checks passed`)
    );
  }

  if (fkIssues?.length > 0) {
    for (const issue of fkIssues) {
      const sev = { error: chalk.red("🔴"), warning: chalk.yellow("🟡"), info: chalk.blue("🔵") }[issue.severity] || "🔵";
      console.log(`   ${sev} ${chalk.dim("[FK]")} ${issue.message}`);
    }
  }
}

function printSummary(meta, results) {
  console.log("\n" + chalk.bold("━".repeat(60)));

  const failedEndpoints = results.filter((r) => r.status === "fail");
  const warnedEndpoints = results.filter((r) => r.status === "warn");
  const passedEndpoints = results.filter((r) => r.status === "pass");
  const allFkIssues = results.flatMap((r) => r.fkIssues || []);

  console.log(
    `  Endpoints: ${chalk.green(passedEndpoints.length + " pass")}` +
    ` ${chalk.yellow(warnedEndpoints.length + " warn")}` +
    ` ${chalk.red(failedEndpoints.length + " fail")}`
  );
  console.log(
    `  Checks:    ${chalk.green(meta.passed + " pass")}` +
    ` ${chalk.yellow(meta.warned + " warn")}` +
    ` ${chalk.red(meta.failed + " fail")}`
  );

  if (allFkIssues.length > 0) {
    console.log(`  FK Issues: ${chalk.yellow(allFkIssues.length + " found")}`);
  }

  console.log(chalk.bold("━".repeat(60)) + "\n");
}

module.exports = { printReport };
