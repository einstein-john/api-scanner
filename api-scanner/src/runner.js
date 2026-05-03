const axios = require("axios");
const { runStandardTests } = require("./analyzers/standard-tests");
const { analyzeForeignKeys, detectNPlusOne } = require("./analyzers/fk-analyzer");

/**
 * Runs all tests against all endpoints in the spec.
 * Returns a full test run report.
 */
async function runTests(endpoints, spec, options = {}) {
  const config = spec["x-scanner"] || {};
  const auth = options.auth || config.auth;
  const timeout = options.timeout || config.timeout || 5000;
  const responseTimeThreshold = options.responseTimeThreshold || 2000;

  const results = [];
  let passed = 0;
  let failed = 0;
  let warned = 0;

  for (const endpoint of endpoints) {
    console.log(`  ▸ ${endpoint.method} ${endpoint.url}`);
    const result = await testEndpoint(endpoint, { auth, timeout, responseTimeThreshold });
    results.push(result);

    for (const t of result.tests) {
      if (t.status === "pass") passed++;
      else if (t.status === "fail") failed++;
      else if (t.status === "warn") warned++;
    }

    if (options.stopOnFirstFail && failed > 0) break;
  }

  return {
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
  };
}

async function testEndpoint(endpoint, options = {}) {
  const startTime = Date.now();
  let response = null;
  let httpError = null;

  try {
    const req = buildRequest(endpoint, options);
    const axiosResp = await axios(req);
    response = normalizeResponse(axiosResp, Date.now() - startTime);
  } catch (err) {
    if (err.response) {
      response = normalizeResponse(err.response, Date.now() - startTime);
    } else {
      httpError = err.message;
    }
  }

  const tests = [];

  if (httpError) {
    tests.push({
      status: "fail",
      check: "HTTP_CONNECTION",
      message: `Request failed: ${httpError}`,
    });
    return buildEndpointResult(endpoint, null, tests, []);
  }

  // Run standard tests
  tests.push(...runStandardTests(response, endpoint, options));

  // Run FK analysis on schema + actual data
  const schema = endpoint.expectedResponses?.[String(response.status)]?.schema;
  const fkIssues = analyzeForeignKeys(schema, response.data, "response");
  const nplusIssues = detectNPlusOne(schema, endpoint.pathTemplate);

  return buildEndpointResult(endpoint, response, tests, [...fkIssues, ...nplusIssues]);
}

function buildRequest(endpoint, options) {
  const req = {
    method: endpoint.method.toLowerCase(),
    url: endpoint.url,
    timeout: options.timeout,
    validateStatus: () => true, // Don't throw on 4xx/5xx
    headers: {
      "Accept": "application/json",
      "Content-Type": "application/json",
    },
  };

  // Auth injection
  const auth = options.auth;
  if (auth) {
    if (auth.type === "bearer" || auth.type === "jwt") {
      req.headers["Authorization"] = `Bearer ${auth.token}`;
    } else if (auth.type === "apikey") {
      const headerName = auth.header || "X-API-Key";
      req.headers[headerName] = auth.token;
    } else if (auth.type === "basic") {
      req.auth = { username: auth.username, password: auth.password };
    }
  }

  // Request body
  if (endpoint.requestBody && ["post", "put", "patch"].includes(req.method)) {
    req.data = endpoint.requestBody;
  }

  // Query params from endpoint parameters
  const queryParams = (endpoint.parameters || []).filter((p) => p.in === "query");
  if (queryParams.length > 0) {
    req.params = {};
    for (const p of queryParams) {
      req.params[p.name] = p.example ?? p.schema?.example ?? p.schema?.default;
    }
  }

  return req;
}

function normalizeResponse(axiosResp, elapsed) {
  return {
    status: axiosResp.status,
    statusText: axiosResp.statusText,
    headers: axiosResp.headers || {},
    data: axiosResp.data,
    elapsed,
  };
}

function buildEndpointResult(endpoint, response, tests, fkIssues) {
  const counts = { pass: 0, fail: 0, warn: 0, skip: 0, info: 0 };
  for (const t of tests) counts[t.status] = (counts[t.status] || 0) + 1;

  const status =
    counts.fail > 0 ? "fail" : counts.warn > 0 ? "warn" : "pass";

  return {
    endpoint: {
      operationId: endpoint.operationId,
      method: endpoint.method,
      url: endpoint.url,
      pathTemplate: endpoint.pathTemplate,
      tags: endpoint.tags,
      summary: endpoint.summary,
    },
    response: response
      ? {
          status: response.status,
          elapsed: response.elapsed,
          contentType: response.headers["content-type"],
        }
      : null,
    status,
    counts,
    tests,
    fkIssues,
  };
}

module.exports = { runTests };
