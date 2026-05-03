import axios, { type AxiosRequestConfig } from "axios";
import cors from "cors";
import express, { type Request, type Response } from "express";
import fs from "fs";
import multer from "multer";
import os from "os";
import path from "path";
import { analyzeForeignKeys, detectNPlusOne } from "./analyzers/fk-analyzer";
import { runStandardTests } from "./analyzers/standard-tests";
import type { StandardTestResponse } from "./analyzers/standard-tests";
import { exportInsomnia } from "./exporters/insomnia";
import {
  buildLlmFixReportJson,
  exportLlmFixReportMarkdown,
} from "./exporters/llm-fix-report";
import { exportPostman } from "./exporters/postman";
import { buildHttpConnectionFailure } from "./http-connection-error";
import { filterToSingleEndpoint } from "./endpoint-selection";
import { applyEndpointOverrides } from "./endpoint-overrides";
import { loadSpec, extractEndpoints, applyBaseUrlOverride } from "./parser";
import { logger } from "./logging";
import pinoHttp from "pino-http";
import {
  applyResolvedAuth,
  authContextFromResolved,
  resolveRequestAuth,
  type ResolvedRequestAuth,
} from "./request-auth";
import type {
  AuthContextSummary,
  EndpointDefinition,
  EndpointOverridePayload,
  EndpointResult,
  FKIssue,
  OpenAPISpec,
  ScanReport,
  ScannerXConfig,
  TestResult,
} from "./types";

const parseLog = logger.child({ scope: "parse" });
const scanLog = logger.child({ scope: "scan" });
const exportLog = logger.child({ scope: "export" });

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

const activeReports = new Map<string, ScanReport>();

app.use(cors());
app.use(express.json());

app.use(
  pinoHttp({
    logger,
    autoLogging: {
      ignore: (req) => !(req.url ?? "").startsWith("/api"),
    },
  }),
);

app.use(express.static(path.join(__dirname, "..", "public")));

app.post(
  "/api/parse",
  upload.single("spec"),
  (req: Request, res: Response): void => {
    try {
      let specContent: string | undefined;
      if (req.file) {
        specContent = req.file.buffer.toString("utf8");
      } else if (typeof req.body.yaml === "string") {
        specContent = req.body.yaml;
      } else {
        res.status(400).json({ error: "No spec provided" });
        return;
      }

      const tmpFile = path.join(os.tmpdir(), `spec-${Date.now()}.yml`);
      fs.writeFileSync(tmpFile, specContent as string);

      const spec = loadSpec(tmpFile);
      fs.unlinkSync(tmpFile);

      const body = req.body as { baseUrl?: string };
      const baseUrlField =
        typeof body.baseUrl === "string" ? body.baseUrl.trim() : "";
      if (baseUrlField) {
        applyBaseUrlOverride(spec, baseUrlField);
      }

      const endpoints = extractEndpoints(spec);
      const tags = [...new Set(endpoints.flatMap((e) => e.tags))];

      const xScanner = spec["x-scanner"] as ScannerXConfig | undefined;

      res.json({
        title: spec.info?.title || "Unknown API",
        version: spec.info?.version || "?",
        description: spec.info?.description || "",
        baseUrl: xScanner?.baseUrl || spec.servers?.[0]?.url || "",
        endpointCount: endpoints.length,
        tags,
        endpoints: endpoints.map((e) => ({
          operationId: e.operationId,
          method: e.method,
          url: e.url,
          pathTemplate: e.pathTemplate,
          tags: e.tags,
          summary: e.summary,
        })),
        specContent,
      });
      parseLog.info(
        {
          title: spec.info?.title,
          endpoints: endpoints.length,
          baseUrlOverride: Boolean(baseUrlField),
        },
        "spec parsed",
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      parseLog.error({ err: msg }, "parse failed");
      res.status(400).json({ error: msg });
    }
  },
);

app.post(
  "/api/scan",
  upload.single("spec"),
  async (req: Request, res: Response): Promise<void> => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    const send = (event: string, data: unknown): void => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    try {
      let specContent: string | undefined;
      if (req.file) {
        specContent = req.file.buffer.toString("utf8");
      } else {
        send("error", { message: "No spec provided" });
        res.end();
        return;
      }

      const rawOpts = (req.body as { options?: string }).options;
      const options: Record<string, unknown> = JSON.parse(
        typeof rawOpts === "string" ? rawOpts : "{}",
      );

      const tmpFile = path.join(os.tmpdir(), `spec-${Date.now()}.yml`);
      fs.writeFileSync(tmpFile, specContent);
      const spec = loadSpec(tmpFile);
      fs.unlinkSync(tmpFile);

      const baseFromOpts = options["baseUrl"];
      const baseOverride =
        typeof baseFromOpts === "string" ? baseFromOpts.trim() : "";
      if (baseOverride) {
        applyBaseUrlOverride(spec, baseOverride);
      }

      let endpoints = extractEndpoints(spec);
      const tagOpt = options["tag"];
      if (typeof tagOpt === "string") {
        endpoints = endpoints.filter((e) => e.tags.includes(tagOpt));
      }

      const onlyOpRaw = options["onlyOperationId"];
      const onlyIdxRaw = options["onlyIndex"];
      let onlyIdxParsed: number | undefined;
      if (typeof onlyIdxRaw === "number" && Number.isInteger(onlyIdxRaw)) {
        onlyIdxParsed = onlyIdxRaw;
      } else if (
        typeof onlyIdxRaw === "string" &&
        onlyIdxRaw.trim() !== ""
      ) {
        const n = parseInt(onlyIdxRaw, 10);
        if (Number.isFinite(n)) onlyIdxParsed = n;
      }
      const singleSel = filterToSingleEndpoint(endpoints, {
        onlyOperationId:
          typeof onlyOpRaw === "string" && onlyOpRaw.trim()
            ? onlyOpRaw.trim()
            : undefined,
        onlyIndex: onlyIdxParsed,
      });
      if (singleSel.error) {
        scanLog.warn({ message: singleSel.error }, "scan rejected: endpoint selection");
        send("error", { message: singleSel.error });
        res.end();
        return;
      }
      endpoints = singleSel.endpoints;

      const eoRaw = options["endpointOverrides"];
      let endpointOverrides: Record<string, EndpointOverridePayload> | undefined;
      if (
        eoRaw &&
        typeof eoRaw === "object" &&
        !Array.isArray(eoRaw)
      ) {
        endpointOverrides = eoRaw as Record<string, EndpointOverridePayload>;
      }
      endpoints = applyEndpointOverrides(endpoints, endpointOverrides);

      if (endpoints.length === 0) {
        scanLog.warn("scan aborted: no endpoints after filters");
        send("error", {
          message:
            "No endpoints to test after filters (tag / single-endpoint selection).",
        });
        res.end();
        return;
      }

      scanLog.info(
        {
          title: spec.info?.title,
          endpoints: endpoints.length,
          tag: typeof tagOpt === "string" ? tagOpt : undefined,
          onlyOperationId:
            typeof onlyOpRaw === "string" && onlyOpRaw.trim()
              ? onlyOpRaw.trim()
              : undefined,
          endpointOverridesCount: endpointOverrides
            ? Object.keys(endpointOverrides).length
            : 0,
        },
        "scan started",
      );

      const config = (spec["x-scanner"] as ScannerXConfig | undefined) || {};
      const auth = resolveRequestAuth(config.auth, options.auth);
      const authContext = authContextFromResolved(auth);
      const timeout =
        (options.timeout as number | undefined) ?? config.timeout ?? 5000;
      const responseTimeThreshold =
        (options.responseTimeThreshold as number | undefined) ?? 2000;

      send("start", {
        total: endpoints.length,
        title: spec.info?.title,
        version: spec.info?.version,
      });

      const results: EndpointResult[] = [];
      let passed = 0;
      let failed = 0;
      let warned = 0;

      for (let i = 0; i < endpoints.length; i++) {
        const endpoint = endpoints[i];
        send("progress", {
          index: i,
          endpoint: {
            method: endpoint.method,
            url: endpoint.url,
            operationId: endpoint.operationId,
          },
        });

        const result = await testEndpointStreaming(endpoint, {
          auth,
          timeout,
          responseTimeThreshold,
          authContext,
        });
        results.push(result);

        scanLog.debug(
          {
            index: i,
            operationId: endpoint.operationId,
            method: endpoint.method,
            outcome: result.status,
            httpStatus: result.response?.status,
            elapsedMs: result.response?.elapsed,
          },
          "endpoint tested",
        );

        for (const t of result.tests) {
          if (t.status === "pass") passed++;
          else if (t.status === "fail") failed++;
          else if (t.status === "warn") warned++;
        }

        send("result", result);

        if (options.stopOnFirstFail && failed > 0) break;
      }

      const report: ScanReport = {
        meta: {
          timestamp: new Date().toISOString(),
          specTitle: spec.info?.title || "Unknown API",
          specVersion: spec.info?.version || "?",
          totalEndpoints: endpoints.length,
          passed,
          failed,
          warned,
        },
        results,
        _spec: spec,
      };

      activeReports.set("latest", report);

      send("done", { meta: report.meta });
      scanLog.info(
        {
          totalEndpoints: report.meta.totalEndpoints,
          passed: report.meta.passed,
          failed: report.meta.failed,
          warned: report.meta.warned,
        },
        "scan finished",
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      scanLog.error({ err: msg }, "scan failed");
      send("error", { message: msg });
    }

    res.end();
  },
);

app.get("/api/export/:format", (req: Request, res: Response): void => {
  const report = activeReports.get("latest");
  if (!report) {
    exportLog.warn({ format: req.params.format }, "export missing report");
    res
      .status(404)
      .json({ error: "No report available. Run a scan first." });
    return;
  }

  const spec = report._spec;
  if (!spec) {
    exportLog.error("export report has no spec reference");
    res.status(500).json({ error: "Report missing spec reference" });
    return;
  }

  const { format } = req.params;

  if (format === "postman") {
    const data = exportPostman(report, spec);
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${report.meta.specTitle}.postman_collection.json"`,
    );
    res.json(data);
  } else if (format === "insomnia") {
    const data = exportInsomnia(report, spec);
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${report.meta.specTitle}.insomnia.json"`,
    );
    res.json(data);
  } else if (format === "llm") {
    const md = exportLlmFixReportMarkdown(report);
    const safeName = String(report.meta.specTitle).replace(/[^\w\-]+/g, "_");
    res.setHeader("Content-Type", "text/markdown; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${safeName}.llm-fix-report.md"`,
    );
    res.send(md);
  } else if (format === "llm-json") {
    const data = buildLlmFixReportJson(report);
    const safeName = String(report.meta.specTitle).replace(/[^\w\-]+/g, "_");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${safeName}.llm-fix-report.json"`,
    );
    res.json(data);
  } else if (format === "report") {
    const { _spec: _drop, ...cleanReport } = report;
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${report.meta.specTitle}.report.json"`,
    );
    res.json(cleanReport);
  } else {
    exportLog.warn({ format }, "unknown export format");
    res
      .status(400)
      .json({
        error:
          "Unknown format. Use: postman, insomnia, report, llm, llm-json",
      });
  }

  if (
    format === "postman" ||
    format === "insomnia" ||
    format === "report" ||
    format === "llm" ||
    format === "llm-json"
  ) {
    exportLog.info({ format }, "export served");
  }
});

interface StreamTestOptions {
  auth?: ResolvedRequestAuth;
  timeout: number;
  responseTimeThreshold: number;
  authContext?: AuthContextSummary;
}

async function testEndpointStreaming(
  endpoint: EndpointDefinition,
  options: StreamTestOptions,
): Promise<EndpointResult> {
  const startTime = Date.now();
  let response: StandardTestResponse | null = null;

  try {
    const axiosReq = buildStreamerRequest(endpoint, options);
    const axiosResp = await axios(axiosReq);
    response = {
      status: axiosResp.status,
      headers: normalizeHeaders(axiosResp.headers),
      data: axiosResp.data,
      elapsed: Date.now() - startTime,
    };
  } catch (err: unknown) {
    if (axios.isAxiosError(err) && err.response) {
      response = {
        status: err.response.status,
        headers: normalizeHeaders(err.response.headers),
        data: err.response.data,
        elapsed: Date.now() - startTime,
      };
    } else {
      scanLog.warn(
        {
          operationId: endpoint.operationId,
          method: endpoint.method,
          url: endpoint.url,
          err: err instanceof Error ? err.message : String(err),
          code: axios.isAxiosError(err) ? err.code : undefined,
        },
        "no HTTP response from upstream",
      );
      const tests: TestResult[] = [buildHttpConnectionFailure(endpoint, err)];
      return buildStreamerResult(endpoint, null, tests, []);
    }
  }

  const tests: TestResult[] = [];

  tests.push(
    ...runStandardTests(response!, endpoint, {
      responseTimeThreshold: options.responseTimeThreshold,
      authContext: options.authContext,
    }),
  );
  const schema =
    endpoint.expectedResponses[String(response!.status)]?.schema;
  const fkIssues: FKIssue[] = [
    ...analyzeForeignKeys(schema, response!.data, "response"),
    ...detectNPlusOne(schema, endpoint.pathTemplate),
  ];
  return buildStreamerResult(endpoint, response!, tests, fkIssues);
}

function normalizeHeaders(
  h: Record<string, unknown>,
): Record<string, string | string[] | undefined> {
  const out: Record<string, string | string[] | undefined> = {};
  for (const [k, v] of Object.entries(h || {})) {
    out[k] = v as string | string[] | undefined;
  }
  return out;
}

function buildStreamerRequest(
  endpoint: EndpointDefinition,
  options: StreamTestOptions,
): AxiosRequestConfig {
  const req: AxiosRequestConfig = {
    method: endpoint.method.toLowerCase(),
    url: endpoint.url,
    timeout: options.timeout,
    validateStatus: () => true,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
  };

  applyResolvedAuth(req, options.auth);
  if (
    endpoint.requestBody &&
    req.method &&
    ["post", "put", "patch"].includes(String(req.method))
  ) {
    req.data = endpoint.requestBody;
  }
  return req;
}

function buildStreamerResult(
  endpoint: EndpointDefinition,
  response: StandardTestResponse | null,
  tests: TestResult[],
  fkIssues: FKIssue[],
): EndpointResult {
  const counts: Record<string, number> = {};
  for (const t of tests) counts[t.status] = (counts[t.status] || 0) + 1;
  const status =
    counts.fail > 0 ? "fail" : counts.warn > 0 ? "warn" : "pass";
  const rawCt = response?.headers?.["content-type"];
  const contentType = rawCt
    ? String(Array.isArray(rawCt) ? rawCt[0] : rawCt)
    : undefined;
  return {
    endpoint: {
      operationId: endpoint.operationId,
      method: endpoint.method,
      url: endpoint.url,
      pathTemplate: endpoint.pathTemplate,
      tags: endpoint.tags,
      summary: endpoint.summary,
      expectedResponses: endpoint.expectedResponses,
      requestBody: endpoint.requestBody,
      parameters: endpoint.parameters,
    },
    response: response
      ? {
          status: response.status,
          elapsed: response.elapsed ?? 0,
          contentType,
        }
      : null,
    status,
    counts,
    tests,
    fkIssues,
  };
}

const PORT = Number(process.env.PORT) || 3847;
app.listen(PORT, () => {
  logger.info({ port: PORT }, "api-scanner listening");
});
