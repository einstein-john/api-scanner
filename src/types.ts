/** OpenAPI / scanner spec: intentionally loose for dynamic documents */
export type OpenAPISpec = Record<string, unknown> & {
  info?: { title?: string; version?: string; description?: string };
  paths?: Record<string, PathItemObject>;
  servers?: Array<{ url?: string }>;
  security?: unknown[];
};

export interface PathItemObject extends Record<string, unknown> {
  parameters?: OpenAPIParameter[];
}

export type HttpMethodLower =
  | "get"
  | "post"
  | "put"
  | "patch"
  | "delete"
  | "head"
  | "options";

export interface OpenAPIParameter {
  name: string;
  in: string;
  required?: boolean;
  description?: string;
  example?: unknown;
  schema?: {
    example?: unknown;
    default?: unknown;
    type?: string;
    format?: string;
    enum?: unknown[];
  };
}

export interface ExpectedResponse {
  description?: string;
  schema: unknown | null;
}

export interface EndpointDefinition {
  operationId: string;
  method: string;
  pathTemplate: string;
  url: string;
  tags: string[];
  summary: string;
  parameters: OpenAPIParameter[];
  requestBody: unknown;
  expectedResponses: Record<string, ExpectedResponse>;
  security: unknown[];
  rawOperation: unknown;
}

export interface ScannerAuth {
  type: string;
  token?: string;
  header?: string;
  username?: string;
  password?: string;
}

export interface ScannerXConfig {
  baseUrl?: string;
  timeout?: number;
  auth?: ScannerAuth;
}

export type TestStatus = "pass" | "fail" | "warn" | "skip" | "info";

export interface TestResult {
  status: TestStatus;
  check: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface FKIssue {
  type: string;
  severity: "error" | "warning" | "info";
  message: string;
  field?: string;
  fkField?: string;
  fkValue?: unknown;
  expectedRelation?: string;
  endpoint?: string;
  fkFields?: string[];
  suggestion?: string;
}

export interface ResponseSummary {
  status: number;
  elapsed: number;
  contentType?: string;
}

export interface EndpointResult {
  endpoint: {
    operationId: string;
    method: string;
    url: string;
    pathTemplate: string;
    tags: string[];
    summary: string;
    expectedResponses?: Record<string, ExpectedResponse>;
    requestBody?: unknown;
    parameters?: OpenAPIParameter[];
  };
  response: ResponseSummary | null;
  status: "pass" | "fail" | "warn";
  counts: Record<string, number>;
  tests: TestResult[];
  fkIssues: FKIssue[];
}

export interface ReportMeta {
  timestamp: string;
  specTitle: string;
  specVersion: string;
  totalEndpoints: number;
  passed: number;
  failed: number;
  warned: number;
}

export interface ScanReport {
  meta: ReportMeta;
  results: EndpointResult[];
  _spec?: OpenAPISpec;
}

/** What credentials the scan attached (for richer 401/403 messages). */
export interface AuthContextSummary {
  hadBearer: boolean;
  hadApiKey: boolean;
  hadBasic: boolean;
}

/** Per-operation overrides merged onto parsed endpoints before requests. */
export interface EndpointOverridePayload {
  requestBody?: unknown;
  expectedResponses?: Record<
    string,
    { schema?: unknown | null; description?: string }
  >;
}

export type EndpointOverridesMap = Record<string, EndpointOverridePayload>;

/** CLI/UI JSON: combine `bearerToken` + `apiKeyHeader`/`apiKeyValue`, or legacy `{ type, token, header }`. */
export interface RunTestsOptions {
  auth?: ScannerAuth | Record<string, unknown>;
  timeout?: number;
  responseTimeThreshold?: number;
  stopOnFirstFail?: boolean;
  endpointOverrides?: EndpointOverridesMap;
}
