/**
 * FK Analyzer
 * Detects foreign key fields in responses that don't have a corresponding
 * related object — a common API design smell that forces extra round-trips.
 */

import type { FKIssue } from "../types";

const FK_PATTERNS = [
  /^(.+)Id$/,
  /^(.+)_id$/,
  /^(.+)ID$/,
  /^id_(.+)$/,
];

export function analyzeForeignKeys(
  schema: unknown,
  data: unknown = null,
  pathPrefix = "",
): FKIssue[] {
  const issues: FKIssue[] = [];
  if (!schema || typeof schema !== "object") return issues;

  const schemaIssues = analyzeSchemaForFKs(schema as Record<string, unknown>, pathPrefix);
  issues.push(...schemaIssues);

  if (data) {
    const dataIssues = analyzeDataForFKs(data, schema as Record<string, unknown>, pathPrefix);
    issues.push(...dataIssues);
  }

  return issues;
}

function analyzeSchemaForFKs(
  schema: Record<string, unknown>,
  path: string,
): FKIssue[] {
  const issues: FKIssue[] = [];

  if (schema.type === "array" && schema.items) {
    return analyzeSchemaForFKs(schema.items as Record<string, unknown>, `${path}[]`);
  }

  const properties = (schema.properties || {}) as Record<string, Record<string, unknown>>;
  const propertyNames = Object.keys(properties);

  for (const [field, fieldSchema] of Object.entries(properties)) {
    const fkMatch = matchFKField(field);
    if (!fkMatch) continue;

    const { relatedName } = fkMatch;

    const hasRelatedObject = propertyNames.some((p) => {
      const normalized = p.toLowerCase().replace(/_/g, "");
      const target = relatedName.toLowerCase().replace(/_/g, "");
      return (
        normalized === target &&
        (properties[p].type === "object" ||
          properties[p].$ref ||
          properties[p].properties)
      );
    });

    const fieldPath = path ? `${path}.${field}` : field;

    if (!hasRelatedObject) {
      issues.push({
        type: "MISSING_RELATED_OBJECT",
        severity: "warning",
        field: fieldPath,
        fkField: field,
        expectedRelation: relatedName,
        message: `Field "${field}" looks like a foreign key (→ ${relatedName}) but no "${relatedName}" object is included in the schema. Consider embedding the object or documenting the relationship explicitly.`,
        suggestion: `Add a "${relatedName}" field of type object, or use a $ref to the related schema. If this is intentional (lightweight list), suppress with x-scanner-ignore: fk.`,
      });
    }

    if (
      fieldSchema.type &&
      !["integer", "string", "number"].includes(fieldSchema.type as string)
    ) {
      issues.push({
        type: "FK_WRONG_TYPE",
        severity: "error",
        field: fieldPath,
        message: `Foreign key "${field}" has type "${String(fieldSchema.type)}" — expected integer, string (UUID), or number.`,
      });
    }
  }

  for (const [field, fieldSchema] of Object.entries(properties)) {
    if (fieldSchema.type === "object" || fieldSchema.properties) {
      const nested = analyzeSchemaForFKs(
        fieldSchema,
        `${path ? path + "." : ""}${field}`,
      );
      issues.push(...nested);
    }
  }

  return issues;
}

function analyzeDataForFKs(
  data: unknown,
  _schema: Record<string, unknown>,
  path: string,
): FKIssue[] {
  const issues: FKIssue[] = [];
  if (!data) return issues;

  const items = Array.isArray(data) ? data.slice(0, 3) : [data];

  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const itemObj = item as Record<string, unknown>;

    for (const [field, value] of Object.entries(itemObj)) {
      const fkMatch = matchFKField(field);
      if (!fkMatch) continue;

      const { relatedName } = fkMatch;

      if (value !== null && value !== undefined) {
        const hasRelatedInData = Object.keys(itemObj).some((k) => {
          const normalized = k.toLowerCase().replace(/_/g, "");
          const target = relatedName.toLowerCase().replace(/_/g, "");
          return (
            normalized === target &&
            itemObj[k] !== null &&
            typeof itemObj[k] === "object"
          );
        });

        if (!hasRelatedInData) {
          issues.push({
            type: "FK_MISSING_EMBEDDED_DATA",
            severity: "info",
            field: `${path}.${field}`,
            fkValue: value,
            expectedRelation: relatedName,
            message: `"${field}" = ${String(value)} but no "${relatedName}" object in response. Client will need a separate request to resolve this reference.`,
          });
        }
      }
    }
  }

  return issues;
}

export function matchFKField(
  fieldName: string,
): { relatedName: string } | null {
  for (const pattern of FK_PATTERNS) {
    const match = fieldName.match(pattern);
    if (match) {
      let relatedName = match[1] || match[2];
      if (relatedName === undefined) continue;
      relatedName = relatedName.replace(/_([a-z])/g, (_, c: string) =>
        c.toUpperCase(),
      );
      if (
        ["parent", "created", "updated", "deleted"].includes(
          relatedName.toLowerCase(),
        )
      ) {
        return null;
      }
      return { relatedName };
    }
  }
  return null;
}

export function detectNPlusOne(
  schema: unknown,
  endpointPath: string,
): FKIssue[] {
  const issues: FKIssue[] = [];
  if (!schema || typeof schema !== "object") return issues;
  const sch = schema as Record<string, unknown>;
  if (sch.type !== "array") return issues;

  const itemSchema = (sch.items || {}) as Record<string, unknown>;
  const properties = (itemSchema.properties || {}) as Record<string, unknown>;
  const fkFields = Object.keys(properties).filter((f) => matchFKField(f));

  if (fkFields.length >= 2) {
    issues.push({
      type: "POTENTIAL_N_PLUS_ONE",
      severity: "info",
      endpoint: endpointPath,
      fkFields,
      message: `List endpoint has ${fkFields.length} FK fields (${fkFields.join(", ")}). If clients need to resolve all of them, this could cause N+1 query patterns. Consider embedding related objects or providing a batch expansion parameter (e.g., ?include=user,category).`,
    });
  }

  return issues;
}
