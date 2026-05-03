/**
 * FK Analyzer
 * Detects foreign key fields in responses that don't have a corresponding
 * related object — a common API design smell that forces extra round-trips.
 *
 * Patterns detected:
 *   userId  → looks for `user` object
 *   user_id → looks for `user` object
 *   categoryId → looks for `category` object
 *   parentId → generic FK with no obvious related object
 */

// Matches common FK naming conventions
const FK_PATTERNS = [
  /^(.+)Id$/,        // camelCase: userId, categoryId
  /^(.+)_id$/,       // snake_case: user_id, category_id
  /^(.+)ID$/,        // ALL_CAPS suffix: userID
  /^id_(.+)$/,       // prefix style: id_user (less common)
];

/**
 * Analyzes a JSON schema to find FK fields.
 * Returns an array of FK issues found.
 */
function analyzeForeignKeys(schema, data = null, path = "") {
  const issues = [];
  if (!schema || typeof schema !== "object") return issues;

  const schemaIssues = analyzeSchemaForFKs(schema, path);
  issues.push(...schemaIssues);

  // If we also have real response data, check the actual values
  if (data) {
    const dataIssues = analyzeDataForFKs(data, schema, path);
    issues.push(...dataIssues);
  }

  return issues;
}

function analyzeSchemaForFKs(schema, path) {
  const issues = [];

  if (schema.type === "array" && schema.items) {
    return analyzeSchemaForFKs(schema.items, `${path}[]`);
  }

  const properties = schema.properties || {};
  const propertyNames = Object.keys(properties);

  for (const [field, fieldSchema] of Object.entries(properties)) {
    const fkMatch = matchFKField(field);
    if (!fkMatch) continue;

    const { relatedName } = fkMatch;

    // Check if a sibling property exists that looks like the related object
    const hasRelatedObject = propertyNames.some((p) => {
      const normalized = p.toLowerCase().replace(/_/g, "");
      const target = relatedName.toLowerCase().replace(/_/g, "");
      return normalized === target && (
        properties[p].type === "object" ||
        properties[p].$ref ||
        properties[p].properties
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

    // Also check if the FK is typed correctly (should be int or string UUID)
    if (fieldSchema.type && !["integer", "string", "number"].includes(fieldSchema.type)) {
      issues.push({
        type: "FK_WRONG_TYPE",
        severity: "error",
        field: fieldPath,
        message: `Foreign key "${field}" has type "${fieldSchema.type}" — expected integer, string (UUID), or number.`,
      });
    }
  }

  // Recurse into nested objects
  for (const [field, fieldSchema] of Object.entries(properties)) {
    if (fieldSchema.type === "object" || fieldSchema.properties) {
      const nested = analyzeSchemaForFKs(fieldSchema, `${path ? path + "." : ""}${field}`);
      issues.push(...nested);
    }
  }

  return issues;
}

/**
 * Analyzes actual response data to find FKs with null/missing related objects.
 */
function analyzeDataForFKs(data, schema, path) {
  const issues = [];
  if (!data) return issues;

  const items = Array.isArray(data) ? data.slice(0, 3) : [data]; // Check first 3 items

  for (const item of items) {
    if (!item || typeof item !== "object") continue;

    for (const [field, value] of Object.entries(item)) {
      const fkMatch = matchFKField(field);
      if (!fkMatch) continue;

      const { relatedName } = fkMatch;

      // If FK has a value but related object is missing/null in actual data
      if (value !== null && value !== undefined) {
        const hasRelatedInData = Object.keys(item).some((k) => {
          const normalized = k.toLowerCase().replace(/_/g, "");
          const target = relatedName.toLowerCase().replace(/_/g, "");
          return normalized === target && item[k] !== null && typeof item[k] === "object";
        });

        if (!hasRelatedInData) {
          issues.push({
            type: "FK_MISSING_EMBEDDED_DATA",
            severity: "info",
            field: `${path}.${field}`,
            fkValue: value,
            expectedRelation: relatedName,
            message: `"${field}" = ${value} but no "${relatedName}" object in response. Client will need a separate request to resolve this reference.`,
          });
        }
      }
    }
  }

  return issues;
}

function matchFKField(fieldName) {
  for (const pattern of FK_PATTERNS) {
    const match = fieldName.match(pattern);
    if (match) {
      // Extract the entity name from the FK field
      let relatedName = match[1] || match[2];
      // Convert snake_case to camelCase for display
      relatedName = relatedName.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
      // Remove common suffixes that aren't entity names
      if (["parent", "created", "updated", "deleted"].includes(relatedName.toLowerCase())) {
        return null; // Skip generic fields
      }
      return { relatedName };
    }
  }
  return null;
}

/**
 * Checks for N+1 query smell — when a list endpoint returns many FK fields
 * that would each require a separate lookup.
 */
function detectNPlusOne(schema, endpointPath) {
  const issues = [];
  if (!schema || schema.type !== "array") return issues;

  const itemSchema = schema.items || {};
  const properties = itemSchema.properties || {};
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

module.exports = { analyzeForeignKeys, detectNPlusOne, matchFKField };
