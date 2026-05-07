import axios, { type AxiosRequestConfig, type AxiosResponse } from "axios";
import { runStandardTests } from "./analyzers/standard-tests";
import type { StandardTestResponse } from "./analyzers/standard-tests";
import { analyzeForeignKeys, detectNPlusOne } from "./analyzers/fk-analyzer";
import { applyEndpointOverrides } from "./endpoint-overrides";
import { buildHttpConnectionFailure } from "./http-connection-error";
import {
  applyResolvedAuth,
  authContextFromResolved,
  resolveRequestAuth,
  type ResolvedRequestAuth,
} from "./request-auth";
import { logger } from "./logging";
import { posthog, distinctId } from "./posthog-client";
import type {
  AuthContextSummary,
  EndpointDefinition,
  EndpointResult,
  FKIssue,
  OpenAPISpec,
  RunTestsOptions,
  ScanReport,
  TestResult,
} from "./types";

const runnerLog = logger.child({ scope: "runner" });

/**
 * Runs all tests against all endpoints in the spec.
 */
export async function runTests(
  endpoints: EndpointDefinition[],
  spec: OpenAPISpec,
  options: RunTestsOptions = {},
): Promise<ScanReport> {
  const config = (spec["x-scanner"] as Record<string, unknown> | undefined) || {};
  const auth = resolveRequestAuth(config.auth, options.auth);
  const authContext = authContextFromResolved(auth);
  const timeout =
    options.timeout ?? (config.timeout as number | undefined) ?? 5000;
  const responseTimeThreshold = options.responseTimeThreshold ?? 2000;

  const endpointsToRun = applyEndpointOverrides(
    endpoints,
    options.endpointOverrides,
  );

  const results: EndpointResult[] = [];
  let passed = 0;
  let failed = 0;
  let warned = 0;

  for (const endpoint of endpointsToRun) {
    runnerLog.info(
      {
        method: endpoint.method,
        url: endpoint.url,
        operationId: endpoint.operationId,
      },
      "testing endpoint",
    );
    const result = await testEndpoint(endpoint, {
      auth,
      timeout,
      responseTimeThreshold,
      authContext,
    });
    results.push(result);

    for (const t of result.tests) {
      if (t.status === "pass") passed++;
      else if (t.status === "fail") failed++;
      else if (t.status === "warn") warned++;
    }

    if (result.status === "fail") {
      posthog.capture({
        distinctId,
        event: "endpoint test failed",
        properties: {
          method: endpoint.method,
          path: endpoint.pathTemplate,
          url: endpoint.url,
          operation_id: endpoint.operationId,
          fail_count: result.counts.fail,
          warn_count: result.counts.warn,
          tags: endpoint.tags,
        },
      });
    }

    if (options.stopOnFirstFail && failed > 0) break;
  }

  runnerLog.info(
    {
      totalEndpoints: endpointsToRun.length,
      checkPasses: passed,
      checkFails: failed,
      checkWarns: warned,
    },
    "run finished",
  );

  return {
    meta: {
      timestamp: new Date().toISOString(),
      specTitle: spec.info?.title || "Unknown API",
      specVersion: spec.info?.version || "?",
      totalEndpoints: endpointsToRun.length,
      passed,
      failed,
      warned,
    },
    results,
  };
}

interface RequestOptions {
  auth?: ResolvedRequestAuth;
  timeout: number;
  responseTimeThreshold: number;
  authContext?: AuthContextSummary;
}

async function testEndpoint(
  endpoint: EndpointDefinition,
  options: RequestOptions,
): Promise<EndpointResult> {
  const startTime = Date.now();
  let response: StandardTestResponse | null = null;

  try {
    const req = buildRequest(endpoint, options);
    const axiosResp = await axios(req);
    response = normalizeResponse(axiosResp, Date.now() - startTime);
  } catch (err: unknown) {
    if (axios.isAxiosError(err) && err.response) {
      response = normalizeResponse(err.response, Date.now() - startTime);
    } else {
      const tests: TestResult[] = [buildHttpConnectionFailure(endpoint, err)];
      runnerLog.warn(
        {
          operationId: endpoint.operationId,
          method: endpoint.method,
          url: endpoint.url,
          err: err instanceof Error ? err.message : String(err),
          code: axios.isAxiosError(err) ? err.code : undefined,
        },
        "no HTTP response from upstream",
      );
      return buildEndpointResult(endpoint, null, tests, []);
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

  return buildEndpointResult(endpoint, response!, tests, fkIssues);
}

function buildRequest(
  endpoint: EndpointDefinition,
  options: RequestOptions,
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

  const queryParams = (endpoint.parameters || []).filter((p) => p.in === "query");
  if (queryParams.length > 0) {
    const params: Record<string, unknown> = {};
    for (const p of queryParams) {
      params[p.name] = p.example ?? p.schema?.example ?? p.schema?.default;
    }
    req.params = params;
  }

  return req;
}

function normalizeResponse(
  axiosResp: AxiosResponse,
  elapsed: number,
): StandardTestResponse {
  const headers: Record<string, string | string[] | undefined> = {};
  for (const [k, v] of Object.entries(axiosResp.headers || {})) {
    headers[k] = v as string | string[] | undefined;
  }
  return {
    status: axiosResp.status,
    statusText: axiosResp.statusText,
    headers,
    data: axiosResp.data,
    elapsed,
  };
}

function buildEndpointResult(
  endpoint: EndpointDefinition,
  response: StandardTestResponse | null,
  tests: TestResult[],
  fkIssues: FKIssue[],
): EndpointResult {
  const counts: Record<string, number> = {
    pass: 0,
    fail: 0,
    warn: 0,
    skip: 0,
    info: 0,
  };
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
