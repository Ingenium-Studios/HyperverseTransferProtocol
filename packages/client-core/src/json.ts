import { P1ProtocolViolationError } from "./errors.js";

/**
 * Parses one host text frame into a JSON object and rejects duplicate decoded object keys at any depth
 * (Prototype Profile §14.0), the host-side counterpart of the request parser in `@hvtp/protocol-types`.
 *
 * It deliberately does not apply the client-generated ID rule (non-empty, at most 128 UTF-8 bytes): host
 * publication and message IDs are opaque to clients (§14.0), so the caller only checks that they are non-empty.
 */
export function parseJsonObject(text: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw new P1ProtocolViolationError("Host message is not syntactically valid JSON.");
  }
  if (hasDuplicateJsonKey(text)) throw new P1ProtocolViolationError("Host message contains a duplicate JSON object key.");
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new P1ProtocolViolationError("Host message must be a JSON object.");
  }
  return value as Record<string, unknown>;
}

interface ObjectScope {
  readonly keys: Set<string>;
  /** True between `{` / `,` and the next string token, which is then a key rather than a value. */
  expectKey: boolean;
}

/**
 * `JSON.parse` silently keeps the last of several equal keys, so duplicates must be found on the raw text. The
 * input has already passed `JSON.parse`, which lets this be a single non-recursive pass: outside strings only the
 * structural characters `{ } [ ] ,` and string quotes matter, and keys are compared after unescaping
 * (`"id"` equals `"id"`). Nesting depth costs heap, not call stack, so hostile nesting cannot overflow it.
 */
export function hasDuplicateJsonKey(text: string): boolean {
  // `null` marks an array scope, whose strings are always values.
  const scopes: Array<ObjectScope | null> = [];
  for (let index = 0; index < text.length; index += 1) {
    const ch = text[index]!;
    if (ch === '"') {
      const start = index;
      for (index += 1; index < text.length && text[index] !== '"'; index += 1) if (text[index] === "\\") index += 1;
      if (index >= text.length) return false; // unterminated string: not JSON, so JSON.parse rejects it first
      const scope = scopes.at(-1);
      if (scope?.expectKey) {
        const key = JSON.parse(text.slice(start, index + 1)) as string;
        if (scope.keys.has(key)) return true;
        scope.keys.add(key);
        scope.expectKey = false;
      }
    } else if (ch === "{") {
      scopes.push({ keys: new Set(), expectKey: true });
    } else if (ch === "[") {
      scopes.push(null);
    } else if (ch === "}" || ch === "]") {
      scopes.pop();
    } else if (ch === ",") {
      const scope = scopes.at(-1);
      if (scope) scope.expectKey = true;
    }
  }
  return false;
}
