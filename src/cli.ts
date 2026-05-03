#!/usr/bin/env node

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
import { loadSpec, extractEndpoints } from "./parser";
import type { EndpointOverridesMap } from "./types";
import { printReport } from "./reporters/terminal";
import { runTests } from "./runner";

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

    const loadSpinner = ora("Loading spec...").start();
    let spec: ReturnType<typeof loadSpec>;
    let endpoints: ReturnType<typeof extractEndpoints>;
    try {
      spec = loadSpec(specPath);
      endpoints = extractEndpoints(spec);
      loadSpinner.succeed(
        `Loaded: ${chalk.bold(spec.info?.title || specPath)} (${endpoints.length} endpoints)`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      loadSpinner.fail(`Failed to load spec: ${msg}`);
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
          process.exit(1);
        }
        endpointOverrides = parsed as EndpointOverridesMap;
        console.log(chalk.dim(`  Endpoint overrides: ${abs}`));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`Failed to read --endpoint-overrides: ${msg}`));
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
      process.exit(1);
    }

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
    }

    process.exit(report.meta.failed > 0 ? 1 : 0);
  });

program.parse();
