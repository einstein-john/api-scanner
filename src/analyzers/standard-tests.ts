import Ajv from "ajv";
import addFormats from "ajv-formats";
import type {
  AuthContextSummary,
  EndpointDefinition,
  TestResult,
} from "../types";

const ajv = new Ajv({ allErrors: true, strict: false, coerceTypes: true });
addFormats(ajv);

export interface StandardTestResponse {
  status: number;
  statusText?: string;
  elapsed?: number;
  headers?: Record<string, string | string[] | undefined>;
  data: unknown;
}

export interface StandardTestOptions {
  responseTimeThreshold?: number;
  authContext?: AuthContextSummary;
}

/**
 * Runs all standard tests on a completed HTTP response.
 */
export function runStandardTests(
  response: StandardTestResponse,
  endpoint: EndpointDefinition,
  options: StandardTestOptions = {},
): TestResult[] {
  const tests: TestResult[] = [];

  tests.push(...testStatusCode(response, endpoint, options));
  tests.push(...testResponseTime(response, options));
  tests.push(...testContentType(response, endpoint, options));
  tests.push(...testSchemaValidation(response, endpoint));
  tests.push(...testRequiredFields(response, endpoint));
  tests.push(...testNullValues(response));
  tests.push(...testPagination(response, endpoint));
  tests.push(...testErrorFormat(response, endpoint));
  tests.push(...testSecurityHeaders(response));
  tests.push(...testEmptyCollections(response, endpoint));
  tests.push(...testIdConsistency(response));
  tests.push(...testDateFormats(response));

  return tests;
}

function endpointDeclaresSecurity(endpoint: EndpointDefinition): boolean {
  const s = endpoint.security;
  return Array.isArray(s) && s.length > 0;
}

function hadAnyCredentials(auth?: AuthContextSummary): boolean {
  return !!(
    auth?.hadBearer ||
    auth?.hadApiKey ||
    auth?.hadBasic
  );
}

function statusMismatchDetails(
  actual: number,
  expected: string[],
  endpoint: EndpointDefinition,
  authContext?: AuthContextSummary,
): Record<string, unknown> {
  const base: Record<string, unknown> = { actual, expected };
  const docSuccess = expected.some((c) =>
    ["200", "201", "204"].includes(c),
  );

  if (
    docSuccess &&
    (actual === 401 || actual === 403) &&
    !expected.includes(String(actual))
  ) {
    const specSecured = endpointDeclaresSecurity(endpoint);
    const sent = hadAnyCredentials(authContext);

    if (actual === 401) {
      base.explanation = sent
        ? "The server returned 401 Unauthorized while the API description expects a successful response. The credentials attached to this scan were rejected (expired token, wrong scheme, missing scope, or an extra header such as an API key may be required)."
        : specSecured
          ? "The server returned 401 Unauthorized while the document expects a successful status. This operation lists security requirements in the OpenAPI spec, but this scan did not send Bearer, API key, or Basic credentials."
          : "The server returned 401 Unauthorized while the document expects a successful status. No Bearer token, API key, or Basic auth was configured for this scan—many APIs return 401 for protected routes until valid credentials are supplied.";
      base.hint = sent
        ? "Verify the token and required headers against this URL (e.g. curl); update auth or adjust expected status codes if 401 is valid for unauthenticated calls."
        : "Add auth in the sidebar or CLI (Bearer / API key / Basic), or paste login credentials into the request body override for auth endpoints, then retest.";
    } else {
      base.explanation = sent
        ? "The server returned 403 Forbidden while the document expects success. Authenticated users may lack permission for this resource."
        : "The server returned 403 Forbidden while the document expects success. If the API requires a logged-in role, configure credentials and ensure the account is allowed to call this operation.";
      base.hint = sent
        ? "Check roles/scopes and route-level authorization."
        : "Configure credentials if this route is not anonymous.";
    }
  } else if (!expected.includes(String(actual))) {
    base.explanation = `The HTTP status ${actual} is not listed among the responses modeled in the spec (${expected.join(", ")}). Either the live API differs from the document, or something upstream (gateway, rate limit, redirect) changed the outcome.`;
    base.hint =
      "Adjust documented responses in the spec, or add a per-endpoint expected-response override if the API is correct.";
  }

  return base;
}

function testStatusCode(
  response: StandardTestResponse,
  endpoint: EndpointDefinition,
  options: StandardTestOptions,
): TestResult[] {
  const actual = response.status;
  const expected = Object.keys(endpoint.expectedResponses || {});

  if (expected.length === 0) {
    return [
      pass("STATUS_CODE", `No expected status codes defined — got ${actual}`),
    ];
  }

  const matched = expected.includes(String(actual));
  return [
    matched
      ? pass("STATUS_CODE", `Status ${actual} matches expected`)
      : fail(
          "STATUS_CODE",
          `Expected one of [${expected.join(", ")}] but got ${actual}`,
          statusMismatchDetails(actual, expected, endpoint, options.authContext),
        ),
  ];
}

function testResponseTime(
  response: StandardTestResponse,
  options: StandardTestOptions,
): TestResult[] {
  const threshold = options.responseTimeThreshold ?? 2000;
  const elapsed = response.elapsed ?? 0;

  if (elapsed > threshold) {
    return [
      warn("RESPONSE_TIME", `Slow response: ${elapsed}ms (threshold: ${threshold}ms)`, {
        elapsed,
        threshold,
      }),
    ];
  }
  return [pass("RESPONSE_TIME", `Response time ${elapsed}ms is within threshold`)];
}

function testContentType(
  response: StandardTestResponse,
  endpoint: EndpointDefinition,
  options: StandardTestOptions,
): TestResult[] {
  const hasBody = response.data !== undefined && response.data !== "";
  if (!hasBody) return [];

  const rawCt = response.headers?.["content-type"];
  const ct = String(
    Array.isArray(rawCt) ? rawCt[0] : rawCt || "",
  ).toLowerCase();
  const isJson = ct.includes("application/json");

  const expectsJson = Object.values(endpoint.expectedResponses || {}).some(
    (r) => r.schema !== null,
  );

  if (expectsJson && !isJson) {
    const details: Record<string, unknown> = {
      actual: ct,
      expected: "application/json",
    };
    if (
      (response.status === 401 || response.status === 403) &&
      !hadAnyCredentials(options.authContext)
    ) {
      details.explanation =
        "With 401/403, many gateways return HTML or plain text instead of JSON. A missing login often triggers this—fix STATUS_CODE first; Content-Type may follow once the API returns the documented JSON.";
    }
    return [
      fail(
        "CONTENT_TYPE",
        `Expected Content-Type: application/json but got: "${ct}"`,
        details,
      ),
    ];
  }

  return [pass("CONTENT_TYPE", `Content-Type is correct: ${ct}`)];
}

function testSchemaValidation(
  response: StandardTestResponse,
  endpoint: EndpointDefinition,
): TestResult[] {
  const expectedResp =
    endpoint.expectedResponses[String(response.status)];
  const schema = expectedResp?.schema;

  if (!schema)
    return [
      skip("SCHEMA_VALIDATION", "No response schema defined for this status code"),
    ];
  if (!response.data)
    return [
      skip("SCHEMA_VALIDATION", "Empty response body — nothing to validate"),
    ];

  try {
    const validate = ajv.compile(schema as object);
    const valid = validate(response.data);

    if (!valid) {
      const errors = (validate.errors || []).map(
        (e) => `${e.instancePath || "root"} ${e.message}`,
      );
      return [
        fail("SCHEMA_VALIDATION", `Response does not match schema`, {
          errors,
          explanation:
            "The response JSON failed JSON Schema validation for this status code. The running API may differ from the OpenAPI document, or the response may be an error payload shape you have not modeled.",
          hint:
            errors.slice(0, 2).join("; ") ||
            "Inspect `details.errors` for AJV paths and messages.",
        }),
      ];
    }
    return [pass("SCHEMA_VALIDATION", "Response body matches declared schema")];
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return [warn("SCHEMA_VALIDATION", `Could not compile schema: ${msg}`)];
  }
}

function testRequiredFields(
  response: StandardTestResponse,
  endpoint: EndpointDefinition,
): TestResult[] {
  const schema = endpoint.expectedResponses[String(response.status)]
    ?.schema as { required?: string[] } | null | undefined;
  if (!schema?.required || !response.data) return [];

  const data = Array.isArray(response.data) ? response.data[0] : response.data;
  if (!data || typeof data !== "object") return [];

  const missing = schema.required.filter(
    (f) => !Object.prototype.hasOwnProperty.call(data, f),
  );
  if (missing.length > 0) {
    return [
      fail("REQUIRED_FIELDS", `Missing required fields: ${missing.join(", ")}`, {
        missing,
      }),
    ];
  }
  return [pass("REQUIRED_FIELDS", "All required fields present")];
}

function testNullValues(response: StandardTestResponse): TestResult[] {
  if (!response.data) return [];
  const nullFields = findNullOrUndefined(response.data);

  if (nullFields.length > 0) {
    return [
      warn("NULL_VALUES", `${nullFields.length} null/undefined field(s) found in response`, {
        fields: nullFields.slice(0, 10),
      }),
    ];
  }
  return [pass("NULL_VALUES", "No unexpected null values found")];
}

function testPagination(
  response: StandardTestResponse,
  endpoint: EndpointDefinition,
): TestResult[] {
  const data = response.data;
  if (!Array.isArray(data) || data.length === 0) return [];

  const envelope = data && typeof data === "object" && !Array.isArray(data);
  if (envelope) {
    const hasTotal = "total" in data || "count" in data || "meta" in data;
    const hasNext =
      "next" in data || "nextCursor" in data || "nextPage" in data;

    if (
      (data as Record<string, unknown>).data &&
      Array.isArray((data as Record<string, unknown>).data)
    ) {
      const issues: TestResult[] = [];
      if (!hasTotal)
        issues.push(warn("PAGINATION", "Paginated response missing total/count field"));
      if (!hasNext)
        issues.push(
          warn("PAGINATION", "Paginated response missing next page indicator"),
        );
      if (issues.length === 0)
        issues.push(pass("PAGINATION", "Pagination envelope looks complete"));
      return issues;
    }
  }

  if (Array.isArray(data) && data.length >= 100) {
    return [
      warn(
        "PAGINATION",
        `Response returned ${data.length} items with no pagination envelope. Consider adding pagination.`,
        { count: data.length },
      ),
    ];
  }

  return [];
}

function testErrorFormat(
  response: StandardTestResponse,
  _endpoint: EndpointDefinition,
): TestResult[] {
  const isError = response.status >= 400;
  if (!isError) return [];

  const data = response.data;
  if (!data || typeof data !== "object") {
    return [warn("ERROR_FORMAT", "Error response has no JSON body")];
  }

  const d = data as Record<string, unknown>;
  const hasMessage =
    "message" in d || "error" in d || "errors" in d || "detail" in d;
  if (!hasMessage) {
    return [
      warn(
        "ERROR_FORMAT",
        "Error response missing standard message field (message/error/errors/detail)",
        {
          actualKeys: Object.keys(d),
        },
      ),
    ];
  }

  return [pass("ERROR_FORMAT", "Error response has standard message field")];
}

function testSecurityHeaders(response: StandardTestResponse): TestResult[] {
  const issues: TestResult[] = [];
  const headers = response.headers || {};

  const security: Array<{
    header: string;
    expected?: string;
    check?: (v: string | undefined) => boolean;
  }> = [
    { header: "x-content-type-options", expected: "nosniff" },
    {
      header: "x-frame-options",
      check: (v) =>
        !!v && ["deny", "sameorigin"].includes(v.toLowerCase()),
    },
  ];

  for (const { header, expected, check } of security) {
    const raw = headers[header];
    const val = Array.isArray(raw) ? raw[0] : raw;
    if (!val) {
      issues.push(info("SECURITY_HEADERS", `Missing security header: ${header}`));
    } else if (expected && val.toLowerCase() !== expected) {
      issues.push(
        info(
          "SECURITY_HEADERS",
          `${header}: "${val}" — expected "${expected}"`,
        ),
      );
    } else if (check && !check(val)) {
      issues.push(
        info("SECURITY_HEADERS", `${header}: "${val}" — unexpected value`),
      );
    }
  }

  if (issues.length === 0) {
    issues.push(pass("SECURITY_HEADERS", "Standard security headers present"));
  }

  return issues;
}

function testEmptyCollections(
  response: StandardTestResponse,
  endpoint: EndpointDefinition,
): TestResult[] {
  if (response.status !== 200) return [];
  const schema = endpoint.expectedResponses["200"]?.schema as
    | { type?: string }
    | null
    | undefined;
  if (!schema || schema.type !== "array") return [];

  if (!Array.isArray(response.data)) {
    return [
      fail("EMPTY_COLLECTION", "Schema declares array response but got non-array", {
        actual: typeof response.data,
      }),
    ];
  }

  return [
    pass("EMPTY_COLLECTION", `Array response with ${response.data.length} item(s)`),
  ];
}

function testIdConsistency(response: StandardTestResponse): TestResult[] {
  const data = response.data;
  const arr = Array.isArray(data) ? data : [data];
  const issues: TestResult[] = [];
  const idTypes = new Set<string>();

  for (const item of arr) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    if ("id" in o) idTypes.add(typeof o.id);
  }

  if (idTypes.size > 1) {
    issues.push(
      fail("ID_CONSISTENCY", `Inconsistent id field types in collection: ${[...idTypes].join(", ")}`, {
        types: [...idTypes],
      }),
    );
  }

  return issues;
}

function testDateFormats(response: StandardTestResponse): TestResult[] {
  const issues: TestResult[] = [];
  const data = response.data;
  if (!data) return [];

  const dateFields = findDateFields(data);
  const badDates = dateFields.filter(({ value }) => {
    return !/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})?)?$/.test(
      value,
    );
  });

  if (badDates.length > 0) {
    issues.push(
      warn(
        "DATE_FORMAT",
        `Non-ISO date format detected in fields: ${badDates.map((d) => d.field).join(", ")}`,
        {
          examples: badDates.slice(0, 3),
        },
      ),
    );
  }

  return issues;
}

function findNullOrUndefined(
  data: unknown,
  path = "",
  results: string[] = [],
): string[] {
  if (Array.isArray(data)) {
    data.slice(0, 2).forEach((item, i) =>
      findNullOrUndefined(item, `${path}[${i}]`, results),
    );
  } else if (data && typeof data === "object") {
    for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
      const p = path ? `${path}.${k}` : k;
      if (v === null) results.push(p);
      else if (typeof v === "object") findNullOrUndefined(v, p, results);
    }
  }
  return results;
}

function findDateFields(
  data: unknown,
  path = "",
  results: Array<{ field: string; value: string }> = [],
): Array<{ field: string; value: string }> {
  const dateKeywords = /date|time|at|on|created|updated|deleted|expires|starts|ends/i;
  if (Array.isArray(data)) {
    data.slice(0, 2).forEach((item, i) =>
      findDateFields(item, `${path}[${i}]`, results),
    );
  } else if (data && typeof data === "object") {
    for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
      const p = path ? `${path}.${k}` : k;
      if (typeof v === "string" && dateKeywords.test(k))
        results.push({ field: p, value: v });
      else if (typeof v === "object") findDateFields(v, p, results);
    }
  }
  return results;
}

function pass(check: string, message: string, details?: Record<string, unknown>): TestResult {
  return { status: "pass", check, message, details };
}
function fail(check: string, message: string, details?: Record<string, unknown>): TestResult {
  return { status: "fail", check, message, details };
}
function warn(check: string, message: string, details?: Record<string, unknown>): TestResult {
  return { status: "warn", check, message, details };
}
function skip(check: string, message: string): TestResult {
  return { status: "skip", check, message };
}
function info(check: string, message: string, details?: Record<string, unknown>): TestResult {
  return { status: "info", check, message, details };
}
