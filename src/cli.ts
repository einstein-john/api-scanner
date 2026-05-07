#!/usr/bin/env node

import "./load-env";
import { Command, type OptionValues } from "commander";
import fs from "fs";
import path from "path";
import chalk from "chalk";
import ora from "ora";
import { exportInsomnia } from "./exporters/insomnia";
import {
  buildLlmFixReportJson,
  exportLlmFixReportMarkdown,
} from "./exporters/llm-fix-report";
import { exportPostman } from "./exporters/postman";
import { filterToSingleEndpoint } from "./endpoint-selection";
import { logger } from "./logging";
import { posthog, distinctId } from "./posthog-client";
import { loadSpec, extractEndpoints } from "./parser";
import type { EndpointOverridesMap } from "./types";
import { printReport } from "./reporters/terminal";
import { runTests } from "./runner";

const cliLog = logger.child({ scope: "cli" });

interface CliOptions extends OptionValues {
  output: string;
  format: string;
  timeout: string;
  tag?: string;
  stopOnFail?: boolean;
  skipExport?: boolean;
  responseTime: string;
  onlyOperationId?: string;
  onlyIndex?: string;
  bearer?: string;
  apiKey?: string;
  apiKeyHeader?: string;
  writeLlmReport?: boolean;
  endpointOverrides?: string;
}

function buildCliAuth(
  options: CliOptions,
): Record<string, unknown> | undefined {
  const bearer = options.bearer?.trim();
  const apiKey = options.apiKey?.trim();
  const header = options.apiKeyHeader?.trim() || "X-API-Key";
  if (!bearer && !apiKey) return undefined;
  const o: Record<string, unknown> = {};
  if (bearer) o.bearerToken = bearer;
  if (apiKey) {
    o.apiKeyHeader = header;
    o.apiKeyValue = apiKey;
  }
  return o;
}

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
  .option(
    "--only-operation-id <id>",
    "Run tests only for the endpoint with this exact operationId",
  )
  .option(
    "--only-index <n>",
    "Run tests only for the endpoint at this index (0-based, after --tag filter)",
  )
  .option("--bearer <token>", "Bearer JWT/access token (can combine with --api-key)")
  .option("--api-key <value>", "API key value sent in a header (default header: X-API-Key)")
  .option(
    "--api-key-header <name>",
    "Header name for --api-key (default: X-API-Key)",
  )
  .option(
    "--write-llm-report",
    "Write LLM-oriented fix report (.md + .json) to --output (ignores STATUS_CODE-only failures)",
  )
  .option(
    "--endpoint-overrides <file>",
    "JSON map operationId → { requestBody?, expectedResponses?: { \"200\": { schema?, description? } } }",
  )
  .action(async (specPath: string, options: CliOptions) => {
    console.log(chalk.bold("\n🔍 api-scanner\n"));

    const resolvedSpecPath = path.resolve(specPath);
    cliLog.info(
      {
        specPath: resolvedSpecPath,
        tag: options.tag,
        onlyOperationId: options.onlyOperationId?.trim() || undefined,
        onlyIndex:
          options.onlyIndex !== undefined && String(options.onlyIndex).trim() !== ""
            ? options.onlyIndex
            : undefined,
        timeout: parseInt(options.timeout, 10),
        stopOnFirstFail: options.stopOnFail || false,
        skipExport: options.skipExport || false,
        format: options.format,
        writeLlmReport: options.writeLlmReport || false,
        hasBearer: Boolean(options.bearer?.trim()),
        hasApiKey: Boolean(options.apiKey?.trim()),
        endpointOverridesPath: options.endpointOverrides?.trim() || undefined,
      },
      "cli scan starting",
    );

    posthog.capture({
      distinctId,
      event: "cli scan started",
      properties: {
        tag_filter: options.tag || undefined,
        format: options.format,
        stop_on_fail: options.stopOnFail || false,
        has_bearer: Boolean(options.bearer?.trim()),
        has_api_key: Boolean(options.apiKey?.trim()),
      },
    });

    const loadSpinner = ora("Loading spec...").start();
    let spec: ReturnType<typeof loadSpec>;
    let endpoints: ReturnType<typeof extractEndpoints>;
    try {
      spec = loadSpec(specPath);
      endpoints = extractEndpoints(spec);
      loadSpinner.succeed(
        `Loaded: ${chalk.bold(spec.info?.title || specPath)} (${endpoints.length} endpoints)`,
      );
      cliLog.info(
        {
          title: spec.info?.title,
          endpoints: endpoints.length,
          version: spec.info?.version,
        },
        "spec parsed for cli",
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      loadSpinner.fail(`Failed to load spec: ${msg}`);
      cliLog.error({ err: msg, specPath: resolvedSpecPath }, "cli spec load failed");
      posthog.capture({
        distinctId,
        event: "cli spec parse failed",
        properties: { spec_path: resolvedSpecPath, error: msg },
      });
      posthog.captureException(err, distinctId, { spec_path: resolvedSpecPath });
      await posthog.shutdown();
      process.exit(1);
    }

    let filtered = endpoints;
    if (options.tag) {
      const tag = options.tag;
      filtered = endpoints.filter((e) => e.tags.includes(tag));
      console.log(
        chalk.dim(
          `  Filtered to tag "${options.tag}": ${filtered.length} endpoints`,
        ),
      );
      cliLog.info({ tag, endpoints: filtered.length }, "cli tag filter applied");
    }

    let onlyIndexArg: number | undefined;
    if (
      options.onlyIndex !== undefined &&
      String(options.onlyIndex).trim() !== ""
    ) {
      const n = parseInt(String(options.onlyIndex), 10);
      if (!Number.isFinite(n)) {
        console.error(
          chalk.red(`Invalid --only-index: "${options.onlyIndex}"`),
        );
        cliLog.error(
          { onlyIndex: options.onlyIndex },
          "cli invalid --only-index",
        );
        process.exit(1);
      }
      onlyIndexArg = n;
    }

    const singleSel = filterToSingleEndpoint(filtered, {
      onlyOperationId: options.onlyOperationId?.trim() || undefined,
      onlyIndex: onlyIndexArg,
    });
    if (singleSel.error) {
      console.error(chalk.red(singleSel.error));
      cliLog.warn({ message: singleSel.error }, "cli endpoint selection failed");
      process.exit(1);
    }
    filtered = singleSel.endpoints;

    if (
      options.onlyOperationId?.trim() ||
      (options.onlyIndex !== undefined && String(options.onlyIndex).trim() !== "")
    ) {
      console.log(
        chalk.dim(
          `  Single endpoint: ${filtered[0].method} ${filtered[0].pathTemplate} (${filtered[0].operationId})`,
        ),
      );
    }

    if (filtered.length === 0) {
      console.log(chalk.yellow("No endpoints to test."));
      cliLog.warn("cli exiting: zero endpoints after filters");
      process.exit(0);
    }

    console.log(chalk.bold("\nRunning tests...\n"));
    const cliAuth = buildCliAuth(options);
    if (cliAuth) {
      const parts: string[] = [];
      if (cliAuth.bearerToken) parts.push("Bearer token");
      if (cliAuth.apiKeyValue)
        parts.push(`API key (${String(cliAuth.apiKeyHeader)})`);
      console.log(chalk.dim(`  Auth: ${parts.join(" + ")}`));
    }

    let endpointOverrides: EndpointOverridesMap | undefined;
    const eoPath = options.endpointOverrides?.trim();
    if (eoPath) {
      const abs = path.resolve(eoPath);
      try {
        const raw = fs.readFileSync(abs, "utf8");
        const parsed = JSON.parse(raw) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          console.error(
            chalk.red("--endpoint-overrides must be a JSON object keyed by operationId"),
          );
          cliLog.error({ path: abs }, "cli endpoint overrides invalid shape");
          process.exit(1);
        }
        endpointOverrides = parsed as EndpointOverridesMap;
        console.log(chalk.dim(`  Endpoint overrides: ${abs}`));
        cliLog.info(
          { path: abs, operationIds: Object.keys(endpointOverrides).length },
          "cli endpoint overrides loaded",
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`Failed to read --endpoint-overrides: ${msg}`));
        cliLog.error({ err: msg, path: abs }, "cli endpoint overrides read failed");
        process.exit(1);
      }
    }

    const testOptions = {
      timeout: parseInt(options.timeout, 10),
      responseTimeThreshold: parseInt(options.responseTime, 10),
      stopOnFirstFail: options.stopOnFail || false,
      auth: cliAuth,
      ...(endpointOverrides ? { endpointOverrides } : {}),
    };

    let report: Awaited<ReturnType<typeof runTests>>;
    try {
      report = await runTests(filtered, spec, testOptions);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(chalk.red(`Test runner error: ${msg}`));
      cliLog.error({ err: msg }, "cli runTests failed");
      process.exit(1);
    }

    cliLog.info(
      {
        endpointsTested: report.meta.totalEndpoints,
        checksPassed: report.meta.passed,
        checksFailed: report.meta.failed,
        checksWarned: report.meta.warned,
      },
      "cli tests finished",
    );

    printReport(report);

    const outputDir = path.resolve(options.output);
    const specName = path.basename(specPath, path.extname(specPath));
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const prefix = `${specName}-${timestamp}`;

    if (!options.skipExport || options.writeLlmReport) {
      if (!fs.existsSync(outputDir))
        fs.mkdirSync(outputDir, { recursive: true });
    }

    if (!options.skipExport) {
      const exported: Array<{ name: string; path: string }> = [];

      if (options.format === "postman" || options.format === "all") {
        const postmanData = exportPostman(report, spec);
        const postmanPath = path.join(
          outputDir,
          `${prefix}.postman_collection.json`,
        );
        fs.writeFileSync(postmanPath, JSON.stringify(postmanData, null, 2));
        exported.push({ name: "Postman", path: postmanPath });
      }

      if (options.format === "insomnia" || options.format === "all") {
        const insomniaData = exportInsomnia(report, spec);
        const insomniaPath = path.join(outputDir, `${prefix}.insomnia.json`);
        fs.writeFileSync(insomniaPath, JSON.stringify(insomniaData, null, 2));
        exported.push({ name: "Insomnia", path: insomniaPath });
      }

      const reportPath = path.join(outputDir, `${prefix}.report.json`);
      fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
      exported.push({ name: "JSON Report", path: reportPath });

      console.log(chalk.bold("📤 Exported files:"));
      for (const exp of exported) {
        console.log(
          `   ${chalk.green("✓")} ${exp.name}: ${chalk.cyan(exp.path)}`,
        );
      }
      console.log();
      cliLog.info(
        {
          outputDir,
          files: exported.map((e) => ({ kind: e.name, path: e.path })),
        },
        "cli exports written",
      );
    } else if (!options.writeLlmReport) {
      cliLog.info("cli skip-export: file exports skipped");
    }

    if (options.writeLlmReport) {
      const mdPath = path.join(outputDir, `${prefix}.llm-fix-report.md`);
      const jsonPath = path.join(outputDir, `${prefix}.llm-fix-report.json`);
      fs.writeFileSync(mdPath, exportLlmFixReportMarkdown(report));
      fs.writeFileSync(
        jsonPath,
        JSON.stringify(buildLlmFixReportJson(report), null, 2),
      );
      console.log(chalk.bold("🤖 LLM fix reports:"));
      console.log(`   ${chalk.green("✓")} Markdown: ${chalk.cyan(mdPath)}`);
      console.log(`   ${chalk.green("✓")} JSON: ${chalk.cyan(jsonPath)}`);
      console.log();
      cliLog.info({ markdownPath: mdPath, jsonPath }, "cli llm reports written");
    }

    const exitCode = report.meta.failed > 0 ? 1 : 0;
    posthog.capture({
      distinctId,
      event: "cli scan completed",
      properties: {
        spec_title: report.meta.specTitle,
        spec_version: report.meta.specVersion,
        total_endpoints: report.meta.totalEndpoints,
        passed: report.meta.passed,
        failed: report.meta.failed,
        warned: report.meta.warned,
        had_failures: report.meta.failed > 0,
        format: options.format,
        skip_export: options.skipExport || false,
      },
    });
    cliLog.info({ exitCode }, "cli exiting");
    await posthog.shutdown();
    process.exit(exitCode);
  });

program.parse();
