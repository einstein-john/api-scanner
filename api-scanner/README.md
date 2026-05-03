# api-scanner

An OpenAPI-driven endpoint tester that fires real HTTP requests, validates responses against your spec, detects foreign key design issues, and exports importable collections for Postman or Insomnia.

---

## Quick Start

```bash
# Install
npm install

# Run against your spec
node index.js path/to/your-api.yml

# Export Postman only
node index.js your-api.yml --format postman

# Export Insomnia only
node index.js your-api.yml --format insomnia

# Filter to a specific tag
node index.js your-api.yml --tag users

# Custom output directory and timeout
node index.js your-api.yml --output ./results --timeout 8000
```

---

## CLI Options

| Flag | Default | Description |
|------|---------|-------------|
| `--output <path>` | `./scanner-output` | Directory for exported files |
| `--format <fmt>` | `all` | `postman`, `insomnia`, or `all` |
| `--timeout <ms>` | `5000` | HTTP request timeout |
| `--tag <tag>` | — | Only test endpoints with this tag |
| `--response-time <ms>` | `2000` | Warn threshold for slow responses |
| `--stop-on-fail` | `false` | Stop after first failing endpoint |
| `--skip-export` | `false` | Run tests only, no output files |

---

## OpenAPI Spec Extensions

Add an `x-scanner` block to your spec to configure auth, base URL, and behavior:

```yaml
x-scanner:
  baseUrl: https://api.yourapp.com
  auth:
    type: bearer          # bearer | apikey | basic
    token: "YOUR_TOKEN"
  timeout: 5000
  stopOnFirstFail: false
```

### Auth Types

```yaml
# Bearer / JWT
auth:
  type: bearer
  token: "eyJhbGci..."

# API Key in header
auth:
  type: apikey
  header: X-API-Key
  token: "your-api-key"

# Basic auth
auth:
  type: basic
  username: "user"
  password: "pass"
```

### Path Parameter Examples

Add `example` values to path parameters so the scanner can build real URLs:

```yaml
parameters:
  - name: id
    in: path
    required: true
    schema:
      type: integer
    example: 42        # ← Scanner uses this to build the URL
```

---

## What Gets Tested

### Standard Checks (run on every endpoint)

| Check | What it does |
|-------|-------------|
| `STATUS_CODE` | Response code matches your declared responses |
| `RESPONSE_TIME` | Flags responses over the threshold (default 2s) |
| `CONTENT_TYPE` | Validates `application/json` Content-Type header |
| `SCHEMA_VALIDATION` | Full AJV schema validation against your OpenAPI schema |
| `REQUIRED_FIELDS` | Checks all `required:` fields are present in response |
| `NULL_VALUES` | Warns about unexpected null fields in response body |
| `PAGINATION` | Detects large collections returned without pagination |
| `ERROR_FORMAT` | Checks 4xx/5xx responses have `message`/`error` field |
| `SECURITY_HEADERS` | Checks for `X-Content-Type-Options`, `X-Frame-Options` |
| `EMPTY_COLLECTION` | Validates array vs non-array when schema says array |
| `ID_CONSISTENCY` | Warns if `id` field has mixed types across a list |
| `DATE_FORMAT` | Flags non-ISO 8601 date/time values |

### Foreign Key Analysis

The scanner inspects your response schemas and actual response data for FK patterns:

- **`MISSING_RELATED_OBJECT`** — field `userId` exists but no `user` object in schema
- **`FK_MISSING_EMBEDDED_DATA`** — `userId: 5` in actual response, but no `user: {...}` embedded
- **`FK_WRONG_TYPE`** — FK field is typed as something other than `integer`/`string`/`number`
- **`POTENTIAL_N_PLUS_ONE`** — list endpoint has 2+ FK fields (would need N+1 requests to resolve)

#### FK Detection Rules

The scanner recognizes these naming conventions:
- `userId` → expects `user` object (camelCase)
- `user_id` → expects `user` object (snake_case)
- `categoryId` → expects `category` object
- Generic `parentId`, `createdBy` etc. are flagged but not linked

---

## Exports

After each run, the tool writes to `./scanner-output/` (configurable):

```
scanner-output/
├── my-api-2024-01-15T10-30-00.postman_collection.json   # Import to Postman
├── my-api-2024-01-15T10-30-00.insomnia.json             # Import to Insomnia
└── my-api-2024-01-15T10-30-00.report.json               # Full raw report
```

### Postman Collection

- Grouped by OpenAPI tags → folders
- Each request includes auto-generated test scripts for:
  - Status code assertions
  - Response time check
  - Content-Type assertion
  - FK issue comments embedded in the test script

### Insomnia Export (v4)

- Grouped by tags
- Environment variables for `baseUrl` and auth tokens
- Issue descriptions embedded in request notes

---

## Exit Codes

| Code | Meaning |
|------|---------|
| `0` | All checks passed (or only warnings) |
| `1` | One or more checks failed |

This makes it suitable for CI:

```yaml
# GitHub Actions example
- name: Scan API
  run: node index.js openapi.yml --format postman
```

---

## Extending the Scanner

### Add a custom analyzer

Create a file in `src/analyzers/` and import it in `src/runner.js`:

```js
// src/analyzers/my-check.js
function runMyCheck(response, endpoint) {
  // return array of { status, check, message, details }
}
module.exports = { runMyCheck };
```

### Add a custom exporter

Create a file in `src/exporters/` and wire it up in `index.js`:

```js
// src/exporters/bruno.js
function exportBruno(report, spec) {
  // return the export data structure
}
```
