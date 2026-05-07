#!/usr/bin/env node

const { Command } = require("commander");
const fs = require("fs");
const path = require("path");
const ora = require("ora");
const chalk = require("chalk");

const { loadSpec, extractEndpoints } = require("./src/parser");
const { runTests } = require("./src/runner");
const { printReport } = require("./src/reporters/terminal");
const { exportPostman } = require("./src/exporters/postman");
const { exportInsomnia } = require("./src/exporters/insomnia");
const { posthog, distinctId } = require("./src/posthog-client");

const program = new Command();

program
  .name("api-scanner")
  .description("OpenAPI endpoint scanner and tester")
  .version("1.0.0")
  .argument("<spec>", "Path to your OpenAPI YAML or JSON file")
  .option("-o, --output <path>", "Output directory for export files", "./scanner-output")
  .option("-f, --format <format>", "Export format: postman, insomnia, all", "all")
  .option("-t, --timeout <ms>", "Request timeout in ms", "5000")
  .option("--tag <tag>", "Only test endpoints with this tag")
  .option("--stop-on-fail", "Stop after first failing endpoint")
  .option("--skip-export", "Run tests but skip file export")
  .option("--response-time <ms>", "Response time warning threshold in ms", "2000")
  .action(async (specPath, options) => {
    console.log(chalk.bold("\n🔍 api-scanner\n"));

    posthog.capture({
      distinctId,
      event: "scan started",
      properties: {
        spec_path: specPath,
        format: options.format,
        tag: options.tag || null,
        timeout: parseInt(options.timeout),
        stop_on_fail: options.stopOnFail || false,
        skip_export: options.skipExport || false,
      },
    });

    // ── Load & parse spec ──────────────────────────────────────────────────
    const loadSpinner = ora("Loading spec...").start();
    let spec, endpoints;
    try {
      spec = loadSpec(specPath);
      endpoints = extractEndpoints(spec);
      loadSpinner.succeed(`Loaded: ${chalk.bold(spec.info?.title || specPath)} (${endpoints.length} endpoints)`);
      posthog.capture({
        distinctId,
        event: "spec loaded",
        properties: {
          spec_title: spec.info?.title || specPath,
          spec_version: spec.info?.version || null,
          endpoint_count: endpoints.length,
        },
      });
    } catch (err) {
      loadSpinner.fail(`Failed to load spec: ${err.message}`);
      posthog.captureException(err, distinctId);
      posthog.capture({
        distinctId,
        event: "spec load failed",
        properties: {
          spec_path: specPath,
          error: err.message,
        },
      });
      await posthog.shutdown();
      process.exit(1);
    }

    // ── Filter by tag ──────────────────────────────────────────────────────
    let filtered = endpoints;
    if (options.tag) {
      filtered = endpoints.filter((e) => e.tags.includes(options.tag));
      console.log(chalk.dim(`  Filtered to tag "${options.tag}": ${filtered.length} endpoints`));
    }

    if (filtered.length === 0) {
      console.log(chalk.yellow("No endpoints to test."));
      await posthog.shutdown();
      process.exit(0);
    }

    // ── Run tests ──────────────────────────────────────────────────────────
    console.log(chalk.bold("\nRunning tests...\n"));
    const testOptions = {
      timeout: parseInt(options.timeout),
      responseTimeThreshold: parseInt(options.responseTime),
      stopOnFirstFail: options.stopOnFail || false,
    };

    let report;
    try {
      report = await runTests(filtered, spec, testOptions);
    } catch (err) {
      console.error(chalk.red(`Test runner error: ${err.message}`));
      posthog.captureException(err, distinctId);
      await posthog.shutdown();
      process.exit(1);
    }

    posthog.capture({
      distinctId,
      event: "scan completed",
      properties: {
        spec_title: report.meta.specTitle,
        total_endpoints: report.meta.totalEndpoints,
        passed: report.meta.passed,
        failed: report.meta.failed,
        warned: report.meta.warned,
      },
    });

    // ── Print report ───────────────────────────────────────────────────────
    printReport(report);

    // ── Export ─────────────────────────────────────────────────────────────
    if (!options.skipExport) {
      const outputDir = path.resolve(options.output);
      if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

      const specName = path.basename(specPath, path.extname(specPath));
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const prefix = `${specName}-${timestamp}`;

      const exports = [];

      if (options.format === "postman" || options.format === "all") {
        const postmanData = exportPostman(report, spec);
        const postmanPath = path.join(outputDir, `${prefix}.postman_collection.json`);
        fs.writeFileSync(postmanPath, JSON.stringify(postmanData, null, 2));
        exports.push({ name: "Postman", path: postmanPath });
      }

      if (options.format === "insomnia" || options.format === "all") {
        const insomniaData = exportInsomnia(report, spec);
        const insomniaPath = path.join(outputDir, `${prefix}.insomnia.json`);
        fs.writeFileSync(insomniaPath, JSON.stringify(insomniaData, null, 2));
        exports.push({ name: "Insomnia", path: insomniaPath });
      }

      // Always write the raw JSON report
      const reportPath = path.join(outputDir, `${prefix}.report.json`);
      fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
      exports.push({ name: "JSON Report", path: reportPath });

      console.log(chalk.bold("📤 Exported files:"));
      for (const exp of exports) {
        console.log(`   ${chalk.green("✓")} ${exp.name}: ${chalk.cyan(exp.path)}`);
      }
      console.log();

      posthog.capture({
        distinctId,
        event: "export completed",
        properties: {
          format: options.format,
          export_count: exports.length,
          output_dir: outputDir,
        },
      });
    }

    // Exit code based on failures
    await posthog.shutdown();
    process.exit(report.meta.failed > 0 ? 1 : 0);
  });

program.parse();
