import {
  HVTP_VERSION,
  P1_LIMITS,
  P1_REQUIRED_COMPONENTS,
  type ParseResult,
  type ParticipantKind,
  type SessionHelloRequest,
} from "./index.js";

type JsonObject = Record<string, unknown>;

const textEncoder = new TextEncoder();

export function parseJsonRequest(text: string): ParseResult<JsonObject> {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    return failure("invalid_json", null, "Message is not syntactically valid JSON.");
  }

  const duplicate = findDuplicateJsonKey(text);
  if (duplicate !== null) {
    return failure("invalid_message", duplicate === "id" ? null : uniqueRequestId(value), `Duplicate JSON object key: ${duplicate}`);
  }

  if (!isObject(value)) {
    return failure("invalid_message", null, "P1 requests must be JSON objects.");
  }

  const ref = validRequestId(value.id) ? value.id : null;
  if (ref === null) {
    return failure("invalid_message", null, "Request must contain one valid top-level id.");
  }

  return { ok: true, value };
}

export function parseSessionHello(text: string): ParseResult<SessionHelloRequest> {
  const parsed = parseJsonRequest(text);
  if (!parsed.ok) return parsed;

  const request = parsed.value;
  const ref = request.id as string;

  if (!hasOnlyKeys(request, ["hvtp", "id", "type", "body"])) {
    return failure("invalid_message", ref, "session.hello contains unsupported top-level fields.");
  }
  if (request.hvtp !== HVTP_VERSION) {
    return failure("unsupported_version", ref, "Only HVTP 0.2 is supported by P1.");
  }
  if (request.type !== "session.hello") {
    return failure("invalid_message", ref, "Expected session.hello.");
  }
  if (!isObject(request.body) || !hasOnlyKeys(request.body, ["versions", "client", "participant", "capabilities"])) {
    return failure("invalid_message", ref, "session.hello body has an invalid closed shape.");
  }

  const { versions, client, participant, capabilities } = request.body;
  if (!Array.isArray(versions) || versions.some((v) => typeof v !== "string") || !versions.includes(HVTP_VERSION)) {
    return failure("unsupported_version", ref, "Client must advertise HVTP 0.2.");
  }

  if (!isObject(client) || !hasOnlyKeys(client, ["name", "version"]) || !nonEmptyString(client.name) || !nonEmptyString(client.version)) {
    return failure("invalid_message", ref, "client must contain non-empty name and version strings.");
  }

  if (!isObject(participant) || !hasOnlyKeys(participant, ["kind"]) || !participantKind(participant.kind)) {
    return failure("invalid_message", ref, "participant.kind must be human or agent.");
  }

  if (!isObject(capabilities) || !hasOnlyKeys(capabilities, ["components"]) || !Array.isArray(capabilities.components)) {
    return failure("invalid_message", ref, "capabilities.components must be an array.");
  }
  const components = capabilities.components;
  if (components.some((component) => typeof component !== "string")) {
    return failure("invalid_message", ref, "capabilities.components values must be strings.");
  }
  for (const required of P1_REQUIRED_COMPONENTS) {
    if (!components.includes(required)) {
      return failure("unsupported_component", ref, `P1 requires component ${required}.`);
    }
  }

  const normalized: SessionHelloRequest = {
    hvtp: HVTP_VERSION,
    id: ref,
    type: "session.hello",
    body: {
      versions: versions as string[],
      client: { name: client.name as string, version: client.version as string },
      participant: { kind: participant.kind as ParticipantKind },
      capabilities: { components: components as string[] },
    },
  };
  return { ok: true, value: normalized };
}

function failure(code: "invalid_json" | "invalid_message" | "unsupported_version" | "unsupported_component", ref: string | null, message: string): ParseResult<never> {
  return { ok: false, error: { code, ref, message } };
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function participantKind(value: unknown): value is ParticipantKind {
  return value === "human" || value === "agent";
}

function validRequestId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && textEncoder.encode(value).byteLength <= 128;
}

function uniqueRequestId(value: unknown): string | null {
  return isObject(value) && validRequestId(value.id) ? value.id : null;
}

function hasOnlyKeys(value: JsonObject, allowed: readonly string[]): boolean {
  const allowedSet = new Set(allowed);
  return Object.keys(value).every((key) => allowedSet.has(key)) && allowed.every((key) => Object.hasOwn(value, key));
}

/**
 * JSON.parse discards duplicate object keys before a reviver can observe them.
 * P1 forbids duplicate decoded keys, so after syntax validation we scan the raw
 * JSON grammar and report the first repeated key in any object.
 */
function findDuplicateJsonKey(text: string): string | null {
  let index = 0;

  const skipWhitespace = (): void => {
    while (index < text.length && /\s/.test(text[index]!)) index += 1;
  };

  const scanString = (): string => {
    const start = index;
    index += 1; // opening quote
    while (index < text.length) {
      const ch = text[index]!;
      if (ch === "\\") {
        index += 2;
        continue;
      }
      if (ch === '"') {
        index += 1;
        return JSON.parse(text.slice(start, index)) as string;
      }
      index += 1;
    }
    throw new Error("Unterminated string after successful JSON.parse");
  };

  const scanPrimitive = (): void => {
    while (index < text.length && !/[\s,}\]]/.test(text[index]!)) index += 1;
  };

  const scanValue = (): string | null => {
    skipWhitespace();
    const ch = text[index];
    if (ch === "{") return scanObject();
    if (ch === "[") return scanArray();
    if (ch === '"') {
      scanString();
      return null;
    }
    scanPrimitive();
    return null;
  };

  const scanArray = (): string | null => {
    index += 1;
    skipWhitespace();
    if (text[index] === "]") {
      index += 1;
      return null;
    }
    while (index < text.length) {
      const duplicate = scanValue();
      if (duplicate !== null) return duplicate;
      skipWhitespace();
      if (text[index] === ",") {
        index += 1;
        continue;
      }
      if (text[index] === "]") {
        index += 1;
        return null;
      }
      throw new Error("Invalid array after successful JSON.parse");
    }
    return null;
  };

  const scanObject = (): string | null => {
    index += 1;
    const keys = new Set<string>();
    skipWhitespace();
    if (text[index] === "}") {
      index += 1;
      return null;
    }
    while (index < text.length) {
      skipWhitespace();
      const key = scanString();
      if (keys.has(key)) return key;
      keys.add(key);
      skipWhitespace();
      index += 1; // colon; JSON.parse already validated grammar
      const duplicate = scanValue();
      if (duplicate !== null) return duplicate;
      skipWhitespace();
      if (text[index] === ",") {
        index += 1;
        continue;
      }
      if (text[index] === "}") {
        index += 1;
        return null;
      }
      throw new Error("Invalid object after successful JSON.parse");
    }
    return null;
  };

  return scanValue();
}

export function exceedsP1MessageLimit(byteLength: number): boolean {
  return byteLength > P1_LIMITS.maxMessageBytes;
}
