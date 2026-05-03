const fs = require("fs");
const yaml = require("js-yaml");
const path = require("path");

/**
 * Loads and parses the OpenAPI YAML/JSON spec.
 * Resolves $ref references inline.
 */
function loadSpec(filePath) {
  const abs = path.resolve(filePath);
  const raw = fs.readFileSync(abs, "utf8");
  const spec = yaml.load(raw);
  return resolveRefs(spec, spec);
}

/**
 * Recursively resolves $ref pointers within the same document.
 */
function resolveRefs(node, root, depth = 0) {
  if (depth > 20) return node; // guard against circular refs
  if (Array.isArray(node)) return node.map((n) => resolveRefs(n, root, depth + 1));
  if (node && typeof node === "object") {
    if (node["$ref"]) {
      const ref = node["$ref"];
      if (ref.startsWith("#/")) {
        const resolved = resolveLocalRef(ref, root);
        return resolveRefs(resolved, root, depth + 1);
      }
      return node; // external refs unsupported, leave as-is
    }
    const out = {};
    for (const [k, v] of Object.entries(node)) {
      out[k] = resolveRefs(v, root, depth + 1);
    }
    return out;
  }
  return node;
}

function resolveLocalRef(ref, root) {
  const parts = ref.replace(/^#\//, "").split("/");
  let cur = root;
  for (const p of parts) {
    cur = cur?.[p];
    if (cur === undefined) throw new Error(`Cannot resolve $ref: ${ref}`);
  }
  return cur;
}

/**
 * Extracts all testable endpoints from the spec.
 * Returns an array of EndpointDefinition objects.
 */
function extractEndpoints(spec) {
  const endpoints = [];
  const baseConfig = spec["x-scanner"] || {};
  const servers = spec.servers || [];
  const baseUrl = baseConfig.baseUrl || servers[0]?.url || "";

  for (const [pathTemplate, pathItem] of Object.entries(spec.paths || {})) {
    const methods = ["get", "post", "put", "patch", "delete", "head", "options"];
    for (const method of methods) {
      if (!pathItem[method]) continue;
      const op = pathItem[method];

      // Merge path-level and operation-level parameters
      const allParams = [
        ...(pathItem.parameters || []),
        ...(op.parameters || []),
      ];

      // Build example URL by substituting path params with example values
      const url = buildExampleUrl(baseUrl, pathTemplate, allParams);

      // Extract expected responses keyed by status code
      const expectedResponses = {};
      for (const [code, resp] of Object.entries(op.responses || {})) {
        const schema = extractResponseSchema(resp);
        expectedResponses[code] = { description: resp.description, schema };
      }

      // Build example request body if present
      const requestBody = buildExampleBody(op.requestBody);

      endpoints.push({
        operationId: op.operationId || `${method.toUpperCase()} ${pathTemplate}`,
        method: method.toUpperCase(),
        pathTemplate,
        url,
        tags: op.tags || [],
        summary: op.summary || "",
        parameters: allParams,
        requestBody,
        expectedResponses,
        security: op.security || spec.security || [],
        rawOperation: op,
      });
    }
  }

  return endpoints;
}

function buildExampleUrl(base, template, params) {
  let url = base.replace(/\/$/, "") + template;
  const pathParams = params.filter((p) => p.in === "path");
  for (const p of pathParams) {
    const val = p.example ?? p.schema?.example ?? p.schema?.default ?? `{${p.name}}`;
    url = url.replace(`{${p.name}}`, encodeURIComponent(val));
  }
  return url;
}

function extractResponseSchema(resp) {
  const content = resp.content || {};
  for (const mediaType of ["application/json", "application/json; charset=utf-8"]) {
    if (content[mediaType]?.schema) return content[mediaType].schema;
  }
  return null;
}

function buildExampleBody(requestBody) {
  if (!requestBody) return null;
  const content = requestBody.content || {};
  const schema = content["application/json"]?.schema || content["multipart/form-data"]?.schema;
  if (!schema) return null;
  return generateExampleFromSchema(schema);
}

function generateExampleFromSchema(schema) {
  if (!schema) return null;
  if (schema.example !== undefined) return schema.example;
  if (schema.type === "object" || schema.properties) {
    const obj = {};
    for (const [k, v] of Object.entries(schema.properties || {})) {
      obj[k] = generateExampleFromSchema(v);
    }
    return obj;
  }
  if (schema.type === "array") return [generateExampleFromSchema(schema.items)];
  if (schema.type === "string") {
    if (schema.format === "email") return "test@example.com";
    if (schema.format === "date") return "2024-01-01";
    if (schema.format === "date-time") return "2024-01-01T00:00:00Z";
    if (schema.enum) return schema.enum[0];
    return schema.default ?? "string";
  }
  if (schema.type === "integer" || schema.type === "number") return schema.default ?? 1;
  if (schema.type === "boolean") return schema.default ?? true;
  return null;
}

module.exports = { loadSpec, extractEndpoints };
