import type { EndpointDefinition } from "./types";

export interface SingleEndpointOptions {
  /** Exact match on `operationId` */
  onlyOperationId?: string;
  /** 0-based index into the current (already tag-filtered) list */
  onlyIndex?: number;
}

export interface SingleEndpointFilterResult {
  endpoints: EndpointDefinition[];
  error?: string;
}

/**
 * Narrows a list to a single endpoint for individual test runs.
 */
export function filterToSingleEndpoint(
  endpoints: EndpointDefinition[],
  opts: SingleEndpointOptions,
): SingleEndpointFilterResult {
  const id =
    opts.onlyOperationId !== undefined
      ? String(opts.onlyOperationId).trim()
      : "";
  const hasId = id.length > 0;
  const idxRaw = opts.onlyIndex;

  if (hasId && idxRaw !== undefined) {
    return {
      endpoints: [],
      error: "Use either onlyOperationId or onlyIndex, not both.",
    };
  }

  if (!hasId && idxRaw === undefined) {
    return { endpoints };
  }

  if (hasId) {
    const matches = endpoints.filter((e) => e.operationId === id);
    if (matches.length === 0) {
      const sample = endpoints.slice(0, 5).map((e) => e.operationId);
      return {
        endpoints: [],
        error: `No endpoint with operationId "${id}". First endpoints: ${sample.join(", ") || "(none)"}`,
      };
    }
    return { endpoints: [matches[0]] };
  }

  const idx =
    typeof idxRaw === "number"
      ? idxRaw
      : parseInt(String(idxRaw), 10);
  if (!Number.isFinite(idx) || !Number.isInteger(idx)) {
    return {
      endpoints: [],
      error: `Invalid only-index "${String(idxRaw)}" — expected an integer.`,
    };
  }
  if (idx < 0 || idx >= endpoints.length) {
    return {
      endpoints: [],
      error: `Invalid only-index ${idx} — must be between 0 and ${Math.max(0, endpoints.length - 1)} (${endpoints.length} endpoints in scope).`,
    };
  }
  return { endpoints: [endpoints[idx]] };
}
