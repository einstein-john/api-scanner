const Ajv = require("ajv");
const addFormats = require("ajv-formats");

const ajv = new Ajv({ allErrors: true, strict: false, coerceTypes: true });
addFormats(ajv);

/**
 * Runs all standard tests on a completed HTTP response.
 * Returns an array of TestResult objects.
 */
function runStandardTests(response, endpoint, options = {}) {
  const tests = [];

  tests.push(...testStatusCode(response, endpoint));
  tests.push(...testResponseTime(response, options));
  tests.push(...testContentType(response, endpoint));
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

// ─── Individual Test Functions ────────────────────────────────────────────────

function testStatusCode(response, endpoint) {
  const actual = response.status;
  const expected = Object.keys(endpoint.expectedResponses || {});

  if (expected.length === 0) {
    return [pass("STATUS_CODE", `No expected status codes defined — got ${actual}`)];
  }

  const matched = expected.includes(String(actual));
  return [
    matched
      ? pass("STATUS_CODE", `Status ${actual} matches expected`)
      : fail("STATUS_CODE", `Expected one of [${expected.join(", ")}] but got ${actual}`, {
          actual,
          expected,
        }),
  ];
}

function testResponseTime(response, options) {
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

function testContentType(response, endpoint) {
  const hasBody = response.data !== undefined && response.data !== "";
  if (!hasBody) return [];

  const ct = (response.headers?.["content-type"] || "").toLowerCase();
  const isJson = ct.includes("application/json");

  // Check if endpoint declares JSON response
  const expectsJson = Object.values(endpoint.expectedResponses || {}).some(
    (r) => r.schema !== null
  );

  if (expectsJson && !isJson) {
    return [
      fail("CONTENT_TYPE", `Expected Content-Type: application/json but got: "${ct}"`, {
        actual: ct,
        expected: "application/json",
      }),
    ];
  }

  return [pass("CONTENT_TYPE", `Content-Type is correct: ${ct}`)];
}

function testSchemaValidation(response, endpoint) {
  const expectedResp = endpoint.expectedResponses?.[String(response.status)];
  const schema = expectedResp?.schema;

  if (!schema) return [skip("SCHEMA_VALIDATION", "No response schema defined for this status code")];
  if (!response.data) return [skip("SCHEMA_VALIDATION", "Empty response body — nothing to validate")];

  try {
    const validate = ajv.compile(schema);
    const valid = validate(response.data);

    if (!valid) {
      const errors = (validate.errors || []).map((e) => `${e.instancePath || "root"} ${e.message}`);
      return [
        fail("SCHEMA_VALIDATION", `Response does not match schema`, { errors }),
      ];
    }
    return [pass("SCHEMA_VALIDATION", "Response body matches declared schema")];
  } catch (err) {
    return [warn("SCHEMA_VALIDATION", `Could not compile schema: ${err.message}`)];
  }
}

function testRequiredFields(response, endpoint) {
  const schema = endpoint.expectedResponses?.[String(response.status)]?.schema;
  if (!schema?.required || !response.data) return [];

  const data = Array.isArray(response.data) ? response.data[0] : response.data;
  if (!data || typeof data !== "object") return [];

  const missing = schema.required.filter((f) => !(f in data));
  if (missing.length > 0) {
    return [fail("REQUIRED_FIELDS", `Missing required fields: ${missing.join(", ")}`, { missing })];
  }
  return [pass("REQUIRED_FIELDS", "All required fields present")];
}

function testNullValues(response) {
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

function testPagination(response, endpoint) {
  const data = response.data;
  if (!Array.isArray(data) || data.length === 0) return [];

  // Common pagination envelope fields
  const envelope = data && typeof data === "object" && !Array.isArray(data);
  if (envelope) {
    const hasTotal = "total" in data || "count" in data || "meta" in data;
    const hasNext = "next" in data || "nextCursor" in data || "nextPage" in data;

    if (data.data && Array.isArray(data.data)) {
      const issues = [];
      if (!hasTotal)
        issues.push(warn("PAGINATION", "Paginated response missing total/count field"));
      if (!hasNext)
        issues.push(warn("PAGINATION", "Paginated response missing next page indicator"));
      if (issues.length === 0)
        issues.push(pass("PAGINATION", "Pagination envelope looks complete"));
      return issues;
    }
  }

  // Raw array — check if it might be unpaginated (too many items)
  if (Array.isArray(data) && data.length >= 100) {
    return [
      warn("PAGINATION", `Response returned ${data.length} items with no pagination envelope. Consider adding pagination.`, { count: data.length }),
    ];
  }

  return [];
}

function testErrorFormat(response, endpoint) {
  const isError = response.status >= 400;
  if (!isError) return [];

  const data = response.data;
  if (!data || typeof data !== "object") {
    return [warn("ERROR_FORMAT", "Error response has no JSON body")];
  }

  const hasMessage = "message" in data || "error" in data || "errors" in data || "detail" in data;
  if (!hasMessage) {
    return [
      warn("ERROR_FORMAT", "Error response missing standard message field (message/error/errors/detail)", {
        actualKeys: Object.keys(data),
      }),
    ];
  }

  return [pass("ERROR_FORMAT", "Error response has standard message field")];
}

function testSecurityHeaders(response) {
  const issues = [];
  const headers = response.headers || {};

  const security = [
    { header: "x-content-type-options", expected: "nosniff" },
    { header: "x-frame-options", check: (v) => ["deny", "sameorigin"].includes(v?.toLowerCase()) },
  ];

  for (const { header, expected, check } of security) {
    const val = headers[header];
    if (!val) {
      issues.push(info("SECURITY_HEADERS", `Missing security header: ${header}`));
    } else if (expected && val.toLowerCase() !== expected) {
      issues.push(info("SECURITY_HEADERS", `${header}: "${val}" — expected "${expected}"`));
    } else if (check && !check(val)) {
      issues.push(info("SECURITY_HEADERS", `${header}: "${val}" — unexpected value`));
    }
  }

  if (issues.length === 0) {
    issues.push(pass("SECURITY_HEADERS", "Standard security headers present"));
  }

  return issues;
}

function testEmptyCollections(response, endpoint) {
  if (response.status !== 200) return [];
  const schema = endpoint.expectedResponses?.["200"]?.schema;
  if (!schema || schema.type !== "array") return [];

  if (!Array.isArray(response.data)) {
    return [fail("EMPTY_COLLECTION", "Schema declares array response but got non-array", { actual: typeof response.data })];
  }

  return [pass("EMPTY_COLLECTION", `Array response with ${response.data.length} item(s)`)];
}

function testIdConsistency(response) {
  const data = Array.isArray(response.data) ? response.data : [response.data];
  const issues = [];
  const idTypes = new Set();

  for (const item of data) {
    if (!item || typeof item !== "object") continue;
    if ("id" in item) idTypes.add(typeof item.id);
  }

  if (idTypes.size > 1) {
    issues.push(
      fail("ID_CONSISTENCY", `Inconsistent id field types in collection: ${[...idTypes].join(", ")}`, {
        types: [...idTypes],
      })
    );
  }

  return issues;
}

function testDateFormats(response) {
  const issues = [];
  const data = response.data;
  if (!data) return [];

  const dateFields = findDateFields(data);
  const badDates = dateFields.filter(({ value }) => {
    // Accept ISO 8601
    return !/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})?)?$/.test(value);
  });

  if (badDates.length > 0) {
    issues.push(
      warn("DATE_FORMAT", `Non-ISO date format detected in fields: ${badDates.map((d) => d.field).join(", ")}`, {
        examples: badDates.slice(0, 3),
      })
    );
  }

  return issues;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function findNullOrUndefined(data, path = "", results = []) {
  if (Array.isArray(data)) {
    data.slice(0, 2).forEach((item, i) => findNullOrUndefined(item, `${path}[${i}]`, results));
  } else if (data && typeof data === "object") {
    for (const [k, v] of Object.entries(data)) {
      const p = path ? `${path}.${k}` : k;
      if (v === null) results.push(p);
      else if (typeof v === "object") findNullOrUndefined(v, p, results);
    }
  }
  return results;
}

function findDateFields(data, path = "", results = []) {
  const dateKeywords = /date|time|at|on|created|updated|deleted|expires|starts|ends/i;
  if (Array.isArray(data)) {
    data.slice(0, 2).forEach((item, i) => findDateFields(item, `${path}[${i}]`, results));
  } else if (data && typeof data === "object") {
    for (const [k, v] of Object.entries(data)) {
      const p = path ? `${path}.${k}` : k;
      if (typeof v === "string" && dateKeywords.test(k)) results.push({ field: p, value: v });
      else if (typeof v === "object") findDateFields(v, p, results);
    }
  }
  return results;
}

// ─── Result Builders ─────────────────────────────────────────────────────────

function pass(check, message, details) {
  return { status: "pass", check, message, details };
}
function fail(check, message, details) {
  return { status: "fail", check, message, details };
}
function warn(check, message, details) {
  return { status: "warn", check, message, details };
}
function skip(check, message) {
  return { status: "skip", check, message };
}
function info(check, message, details) {
  return { status: "info", check, message, details };
}

module.exports = { runStandardTests };
