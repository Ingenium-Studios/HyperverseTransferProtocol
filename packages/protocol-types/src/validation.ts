import {
  HVTP_VERSION,
  P1_LIMITS,
  P1_POSITION_LIMIT_METERS,
  P1_REALM_ID,
  P1_REQUIRED_COMPONENTS,
  type P1ErrorCode,
  type ParseResult,
  type ParticipantKind,
  type RealmJoinRequest,
  type SessionHelloRequest,
  type SubscriptionSelector,
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
    const ref = duplicate.topLevel && duplicate.key === "id" ? null : uniqueRequestId(value);
    return failure("invalid_message", ref, `Duplicate JSON object key: ${duplicate.key}`);
  }

  if (!isObject(value)) {
    return failure("invalid_message", null, "P1 requests must be JSON objects.");
  }

  const ref = validOpaqueId(value.id) ? value.id : null;
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

  return {
    ok: true,
    value: {
      hvtp: HVTP_VERSION,
      id: ref,
      type: "session.hello",
      body: {
        versions: versions as string[],
        client: { name: client.name as string, version: client.version as string },
        participant: { kind: participant.kind as ParticipantKind },
        capabilities: { components: components as string[] },
      },
    },
  };
}

export function parseRealmJoin(text: string): ParseResult<RealmJoinRequest> {
  const parsed = parseJsonRequest(text);
  if (!parsed.ok) return parsed;

  const request = parsed.value;
  const ref = request.id as string;

  if (!hasOnlyKeys(request, ["hvtp", "id", "type", "body"])) {
    return failure("invalid_message", ref, "realm.join contains unsupported top-level fields.");
  }
  if (request.hvtp !== HVTP_VERSION) {
    return failure("unsupported_version", ref, "Only HVTP 0.2 is supported by P1.");
  }
  if (request.type !== "realm.join") {
    return failure("invalid_message", ref, "Expected realm.join.");
  }
  if (!isObject(request.body) || !hasOnlyKeys(request.body, ["realm", "subscription"])) {
    return failure("invalid_message", ref, "realm.join body has an invalid closed shape.");
  }
  if (request.body.realm !== P1_REALM_ID) {
    return failure("realm_not_found", ref, "P1 exposes only the prototype realm.");
  }

  const subscription = parseSubscriptionSelector(request.body.subscription, ref);
  if (!subscription.ok) return subscription;

  return {
    ok: true,
    value: {
      hvtp: HVTP_VERSION,
      id: ref,
      type: "realm.join",
      body: {
        realm: P1_REALM_ID,
        subscription: subscription.value,
      },
    },
  };
}

function parseSubscriptionSelector(value: unknown, ref: string): ParseResult<SubscriptionSelector> {
  if (!isObject(value) || !hasNoUnknownKeys(value, ["spatial", "entities"])) {
    return failure("invalid_message", ref, "subscription must be an object containing only spatial and/or entities.");
  }

  const normalized: {
    spatial?: { center: [number, number, number]; radius: number };
    entities?: string[];
  } = {};

  if (Object.hasOwn(value, "entities")) {
    if (!Array.isArray(value.entities)) {
      return failure("invalid_message", ref, "subscription.entities must be an array.");
    }
    if (value.entities.length > P1_LIMITS.maxExplicitEntityIds) {
      return failure("resource_limit", ref, "subscription.entities exceeds maxExplicitEntityIds.");
    }
    if (value.entities.some((entityId) => !validOpaqueId(entityId))) {
      return failure("invalid_message", ref, "subscription.entities values must be valid entity IDs.");
    }
    normalized.entities = value.entities as string[];
  }

  if (Object.hasOwn(value, "spatial")) {
    if (!isObject(value.spatial) || !hasOnlyKeys(value.spatial, ["center", "radius"])) {
      return failure("invalid_message", ref, "subscription.spatial must contain exactly center and radius.");
    }

    const center = value.spatial.center;
    const radius = value.spatial.radius;
    if (
      !Array.isArray(center) ||
      center.length !== 3 ||
      center.some(
        (coordinate) =>
          typeof coordinate !== "number" ||
          !Number.isFinite(coordinate) ||
          coordinate < -P1_POSITION_LIMIT_METERS ||
          coordinate > P1_POSITION_LIMIT_METERS,
      )
    ) {
      return failure("invalid_message", ref, "subscription.spatial.center must contain three finite P1 coordinates.");
    }

    if (typeof radius !== "number" || !Number.isFinite(radius) || radius < 0) {
      return failure("invalid_message", ref, "subscription.spatial.radius must be a finite nonnegative number.");
    }
    if (radius > P1_LIMITS.maxSubscriptionRadiusMeters) {
      return failure("resource_limit", ref, "subscription.spatial.radius exceeds maxSubscriptionRadiusMeters.");
    }

    normalized.spatial = {
      center: [center[0] as number, center[1] as number, center[2] as number],
      radius,
    };
  }

  return { ok: true, value: normalized };
}

function failure(code: P1ErrorCode, ref: string | null, message: string): ParseResult<never> {
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

function validOpaqueId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && textEncoder.encode(value).byteLength <= 128;
}

function uniqueRequestId(value: unknown): string | null {
  return isObject(value) && validOpaqueId(value.id) ? value.id : null;
}

function hasOnlyKeys(value: JsonObject, allowed: readonly string[]): boolean {
  const allowedSet = new Set(allowed);
  return Object.keys(value).every((key) => allowedSet.has(key)) && allowed.every((key) => Object.hasOwn(value, key));
}

function hasNoUnknownKeys(value: JsonObject, allowed: readonly string[]): boolean {
  const allowedSet = new Set(allowed);
  return Object.keys(value).every((key) => allowedSet.has(key));
}

/**
 * JSON.parse discards duplicate object keys before a reviver can observe them.
 * P1 forbids duplicate decoded keys, so after syntax validation we scan the raw
 * JSON grammar and report the first repeated key in any object.
 */
interface DuplicateJsonKey {
  readonly key: string;
  readonly topLevel: boolean;
}

function findDuplicateJsonKey(text: string): DuplicateJsonKey | null {
  let index = 0;

  const skipWhitespace = (): void => {
    while (index < text.length && /\s/.test(text[index]!)) index += 1;
  };

  const scanString = (): string => {
    const start = index;
    index += 1;
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

  const scanValue = (objectDepth: number): DuplicateJsonKey | null => {
    skipWhitespace();
    const ch = text[index];
    if (ch === "{") return scanObject(objectDepth);
    if (ch === "[") return scanArray(objectDepth);
    if (ch === '"') {
      scanString();
      return null;
    }
    scanPrimitive();
    return null;
  };

  const scanArray = (objectDepth: number): DuplicateJsonKey | null => {
    index += 1;
    skipWhitespace();
    if (text[index] === "]") {
      index += 1;
      return null;
    }
    while (index < text.length) {
      const duplicate = scanValue(objectDepth);
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

  const scanObject = (objectDepth: number): DuplicateJsonKey | null => {
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
      if (keys.has(key)) return { key, topLevel: objectDepth === 0 };
      keys.add(key);
      skipWhitespace();
      index += 1;
      const duplicate = scanValue(objectDepth + 1);
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

  return scanValue(0);
}

export function exceedsP1MessageLimit(byteLength: number): boolean {
  return byteLength > P1_LIMITS.maxMessageBytes;
}
