import fs from "fs";
import yaml from "js-yaml";
import path from "path";
import type {
  EndpointDefinition,
  ExpectedResponse,
  OpenAPIParameter,
  OpenAPISpec,
  PathItemObject,
  ScannerXConfig,
} from "./types";

/**
 * Loads and parses the OpenAPI YAML/JSON spec.
 * Resolves $ref references inline.
 */
export function loadSpec(filePath: string): OpenAPISpec {
  const abs = path.resolve(filePath);
  const raw = fs.readFileSync(abs, "utf8");
  const spec = yaml.load(raw) as OpenAPISpec;
  return resolveRefs(spec, spec) as OpenAPISpec;
}

/**
 * Recursively resolves $ref pointers within the same document.
 */
function resolveRefs(
  node: unknown,
  root: OpenAPISpec,
  depth = 0,
): unknown {
  if (depth > 20) return node;
  if (Array.isArray(node))
    return node.map((n) => resolveRefs(n, root, depth + 1));
  if (node && typeof node === "object") {
    const o = node as Record<string, unknown>;
    if (o["$ref"]) {
      const ref = String(o["$ref"]);
      if (ref.startsWith("#/")) {
        const resolved = resolveLocalRef(ref, root);
        return resolveRefs(resolved, root, depth + 1);
      }
      return node;
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(o)) {
      out[k] = resolveRefs(v, root, depth + 1);
    }
    return out;
  }
  return node;
}

function resolveLocalRef(ref: string, root: OpenAPISpec): unknown {
  const parts = ref.replace(/^#\//, "").split("/");
  let cur: unknown = root;
  for (const p of parts) {
    if (cur === null || typeof cur !== "object") {
      throw new Error(`Cannot resolve $ref: ${ref}`);
    }
    cur = (cur as Record<string, unknown>)[p];
    if (cur === undefined) throw new Error(`Cannot resolve $ref: ${ref}`);
  }
  return cur;
}

/**
 * Merge UI/user base URL override into the spec so extractEndpoints uses it.
 */
export function applyBaseUrlOverride(
  spec: OpenAPISpec,
  override: string | undefined | null,
): void {
  const t = typeof override === "string" ? override.trim() : "";
  if (!t) return;
  const cur =
    (spec["x-scanner"] as Record<string, unknown> | undefined) || {};
  spec["x-scanner"] = { ...cur, baseUrl: t } as ScannerXConfig;
}

/**
 * Extracts all testable endpoints from the spec.
 */
export function extractEndpoints(spec: OpenAPISpec): EndpointDefinition[] {
  const endpoints: EndpointDefinition[] = [];
  const baseConfig = (spec["x-scanner"] as ScannerXConfig | undefined) || {};
  const servers = spec.servers || [];
  const baseUrl = baseConfig.baseUrl || servers[0]?.url || "";

  const paths = spec.paths || {};
  for (const [pathTemplate, pathItemUnknown] of Object.entries(paths)) {
    const pathItem = pathItemUnknown as PathItemObject;
    const methods = [
      "get",
      "post",
      "put",
      "patch",
      "delete",
      "head",
      "options",
    ] as const;
    for (const method of methods) {
      const op = pathItem[method];
      if (!op || typeof op !== "object") continue;
      const opObj = op as Record<string, unknown>;

      const allParams: OpenAPIParameter[] = [
        ...(Array.isArray(pathItem.parameters)
          ? (pathItem.parameters as OpenAPIParameter[])
          : []),
        ...(Array.isArray(opObj.parameters)
          ? (opObj.parameters as OpenAPIParameter[])
          : []),
      ];

      const url = buildExampleUrl(baseUrl, pathTemplate, allParams);

      const expectedResponses: Record<string, ExpectedResponse> = {};
      const responses = (opObj.responses || {}) as Record<string, { description?: string; content?: Record<string, { schema?: unknown }> }>;
      for (const [code, resp] of Object.entries(responses)) {
        const schema = extractResponseSchema(resp);
        expectedResponses[code] = { description: resp.description, schema };
      }

      const requestBody = buildExampleBody(opObj.requestBody as Record<string, unknown> | undefined);

      endpoints.push({
        operationId:
          (opObj.operationId as string | undefined) ||
          `${method.toUpperCase()} ${pathTemplate}`,
        method: method.toUpperCase(),
        pathTemplate,
        url,
        tags: (opObj.tags as string[] | undefined) || [],
        summary: (opObj.summary as string | undefined) || "",
        parameters: allParams,
        requestBody,
        expectedResponses,
        security: (opObj.security as unknown[] | undefined) || spec.security || [],
        rawOperation: op,
      });
    }
  }

  return endpoints;
}

function buildExampleUrl(
  base: string,
  template: string,
  params: OpenAPIParameter[],
): string {
  let url = base.replace(/\/$/, "") + template;
  const pathParams = params.filter((p) => p.in === "path");
  for (const p of pathParams) {
    const val =
      p.example ??
      p.schema?.example ??
      p.schema?.default ??
      `{${p.name}}`;
    url = url.replace(`{${p.name}}`, encodeURIComponent(String(val)));
  }
  return url;
}

function extractResponseSchema(resp: {
  content?: Record<string, { schema?: unknown }>;
}): unknown {
  const content = resp.content || {};
  for (const mediaType of [
    "application/json",
    "application/json; charset=utf-8",
  ]) {
    if (content[mediaType]?.schema) return content[mediaType].schema;
  }
  return null;
}

function buildExampleBody(
  requestBody: Record<string, unknown> | undefined,
): unknown {
  if (!requestBody) return null;
  const content = (requestBody.content || {}) as Record<
    string,
    { schema?: unknown }
  >;
  const schema =
    content["application/json"]?.schema ||
    content["multipart/form-data"]?.schema;
  if (!schema) return null;
  return generateExampleFromSchema(schema as Record<string, unknown>);
}

function generateExampleFromSchema(schema: Record<string, unknown> | null): unknown {
  if (!schema) return null;
  if (schema.example !== undefined) return schema.example;
  if (schema.type === "object" || schema.properties) {
    const obj: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(
      (schema.properties || {}) as Record<string, unknown>,
    )) {
      obj[k] = generateExampleFromSchema(v as Record<string, unknown>);
    }
    return obj;
  }
  if (schema.type === "array")
    return [generateExampleFromSchema(schema.items as Record<string, unknown>)];
  if (schema.type === "string") {
    if (schema.format === "email") return "test@example.com";
    if (schema.format === "date") return "2024-01-01";
    if (schema.format === "date-time") return "2024-01-01T00:00:00Z";
    const en = schema.enum as unknown[] | undefined;
    if (en) return en[0];
    return schema.default ?? "string";
  }
  if (schema.type === "integer" || schema.type === "number")
    return schema.default ?? 1;
  if (schema.type === "boolean") return schema.default ?? true;
  return null;
}
