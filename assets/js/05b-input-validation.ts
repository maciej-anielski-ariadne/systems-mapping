// =============================================================================
// CANONICAL INPUT VALIDATION
// -----------------------------------------------------------------------------
// Values in the map CSV are used by formulas, lookup indexes, data attributes,
// SVG, and exported HTML. Keep their boundary rules in one small module so the
// loader, Bulk edit, and direct-edit surfaces cannot gradually accept different
// languages.
// =============================================================================

// Identifiers deliberately match the formula language: an ASCII letter or
// underscore, followed by ASCII letters, digits, or underscores. Values are
// checked exactly as authored; callers must report and reject an invalid value,
// never trim or rewrite it into a different identity.
export const CANONICAL_IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

// These names are valid-looking JavaScript property names but historically
// collided with inherited members when indexes were ordinary objects. Indexes
// are now null-prototype dictionaries as a second line of defence; rejecting
// the names keeps imported identity conservative and avoids surprises in any
// future object-backed consumer.
const RESERVED_IDENTIFIER_NAMES = new Set([
  "__defineGetter__",
  "__defineSetter__",
  "__lookupGetter__",
  "__lookupSetter__",
  "__proto__",
  "constructor",
  "hasOwnProperty",
  "isPrototypeOf",
  "propertyIsEnumerable",
  "prototype",
  "toLocaleString",
  "toString",
  "valueOf",
]);

export function isCanonicalIdentifier(value: unknown): value is string {
  return typeof value === "string" &&
    CANONICAL_IDENTIFIER_PATTERN.test(value) &&
    !RESERVED_IDENTIFIER_NAMES.has(value);
}

export function canonicalIdentifierGuidance(): string {
  return "Use a letter or underscore first, then only letters, numbers, or underscores; reserved object names are not allowed.";
}

// Imported map colours are literals, not arbitrary CSS. Hex colours cover the
// colour picker and every shipped map while excluding functions, URLs,
// declarations, and quote-bearing strings that are unsafe in style/SVG output.
export const SAFE_HEX_COLOUR_PATTERN = /^#[0-9A-Fa-f]{3}(?:[0-9A-Fa-f]{1}|[0-9A-Fa-f]{3}(?:[0-9A-Fa-f]{2})?)?$/;

export function isSafeHexColour(value: unknown): value is string {
  return typeof value === "string" && SAFE_HEX_COLOUR_PATTERN.test(value);
}

// A strict decimal accepts signs, decimals, and scientific notation, but not a
// numeric prefix followed by arbitrary text, hexadecimal syntax, or Infinity.
const STRICT_DECIMAL_PATTERN = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

export function parseStrictFiniteNumber(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  const stringValue = String(value).trim();
  if (stringValue === "" || !STRICT_DECIMAL_PATTERN.test(stringValue)) return undefined;
  const numericValue = Number(stringValue);
  return Number.isFinite(numericValue) ? numericValue : undefined;
}

export function isBlankInput(value: unknown): boolean {
  return value === undefined || value === null || String(value).trim() === "";
}

export function createIdentifierRecord<Value>(): Record<string, Value> {
  return Object.create(null) as Record<string, Value>;
}
