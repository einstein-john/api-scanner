import type {
  EndpointDefinition,
  EndpointOverridePayload,
  ExpectedResponse,
} from "./types";

export function applyEndpointOverrides(
  endpoints: EndpointDefinition[],
  overrides: Record<string, EndpointOverridePayload> | undefined | null,
): EndpointDefinition[] {
  if (!overrides || typeof overrides !== "object") return endpoints;

  return endpoints.map((ep) => {
    const o = overrides[ep.operationId];
    if (!o || typeof o !== "object") return ep;

    const mergedResponses =
      o.expectedResponses && typeof o.expectedResponses === "object"
        ? mergeExpectedResponses(ep.expectedResponses, o.expectedResponses)
        : ep.expectedResponses;

    const requestBody = Object.prototype.hasOwnProperty.call(o, "requestBody")
      ? o.requestBody
      : ep.requestBody;

    return {
      ...ep,
      requestBody,
      expectedResponses: mergedResponses,
    };
  });
}

function mergeExpectedResponses(
  base: Record<string, ExpectedResponse>,
  override: Record<string, { schema?: unknown | null; description?: string }>,
): Record<string, ExpectedResponse> {
  const out: Record<string, ExpectedResponse> = { ...base };
  for (const [code, v] of Object.entries(override)) {
    if (!v || typeof v !== "object") continue;
    const prev = out[code] ?? { schema: null };
    out[code] = {
      description:
        v.description !== undefined ? v.description : prev.description,
      schema: v.schema !== undefined ? v.schema : prev.schema,
    };
  }
  return out;
}
