# Hyperverse Transfer Protocol (HVTP) 0.2 — Draft Core Specification

Status: **Draft / experimental**

HVTP is an engine-agnostic application-layer protocol for representing, synchronizing, and interacting with shared spatial worlds across heterogeneous clients, engines, simulations, and autonomous agents.

This document defines the conceptual core of HVTP 0.2. It deliberately separates **world state** from **rendering assets**, and separates **protocol semantics** from any particular transport, engine, game, or virtual-world product.

The key design rule is:

> **HVTP describes what exists, what state it has, who is authoritative for that state, and what happened. Renderers decide how to embody it.**

The words MUST, MUST NOT, SHOULD, SHOULD NOT, and MAY are to be interpreted as normative requirements for conforming implementations.

---

## 1. Goals

HVTP 0.2 is designed to support:

- shared persistent or ephemeral spatial worlds;
- multiple simultaneous human, service, bot, and AI participants;
- engine-independent entity and component state;
- interest-based subscriptions to portions of a world;
- explicit mutation authority and conflict handling;
- portable asset references, especially glTF/GLB for renderable 3D content;
- interaction events and sandboxed behaviours;
- transport profiles ranging from WebSocket today to richer transports later;
- eventual federation and realm-to-realm transfer without coupling the core protocol to one platform.

## 2. Non-goals

HVTP core does **not** define:

- a rendering engine;
- a physics engine or deterministic cross-engine physics;
- a game ruleset;
- land ownership, currency, taxation, elections, or governance;
- a universal avatar aesthetic;
- a mandatory identity provider;
- a mandatory asset host;
- a blockchain;
- a single global world or directory;
- a requirement that all participants simulate the same state independently.

Applications MAY define higher-level components and services for those concerns.

For example, a virtual world may define land, civic, economic, and social semantics as application extensions without requiring those concepts in HVTP core.

---

## 3. Architectural principles

### 3.1 Protocol-native world model

HVTP world state is an **entity-component model**, not a glTF scene graph.

glTF/GLB is the preferred portable representation for renderable assets, but glTF is not the authoritative model for identity, ownership, permissions, behaviours, economy, or mutable world state.

Conceptually:

```text
HVTP Realm
└── Entity
    ├── hvtp.transform
    ├── hvtp.renderable ─────► glTF / GLB
    ├── hvtp.physics
    ├── hvtp.interaction
    ├── hvtp.ownership
    ├── hvtp.permissions
    └── hvtp.behaviour
```

### 3.2 Explicit authority

Ownership and authority are different concepts.

An entity may be owned by one principal while a region host remains authoritative for its physical transform. A participant may locally predict motion without becoming the canonical source of truth.

Every mutable component MUST have an authority policy.

### 3.3 Local embodiment, shared semantics

A Three.js client may represent an entity as `THREE.Object3D`; Unreal may use an Actor and Components; Godot may use Node3D.

Those engine objects are implementation details. Conforming clients MUST reason about the shared HVTP entity and component state rather than engine-specific object types.

### 3.4 Capability negotiation

HVTP is expected to evolve. Participants MUST negotiate supported protocol versions and MAY negotiate component, extension, compression, behaviour-runtime, and transport capabilities.

### 3.5 Application extensibility

Domain semantics belong in namespaced extensions rather than in the core.

A component identifier MUST be globally unambiguous. Core components use the `hvtp.*` namespace. Applications SHOULD use a stable vendor or project namespace, for example `example.land.claim@1`.

---

## 4. Core terminology

### Realm

A **Realm** is a named shared spatial state space with a stable realm identifier. A realm may be persistent or ephemeral and may be hosted by one service or partitioned across many services.

### Region

A **Region** is an implementation-level partition of a realm used for scaling, authority, persistence, or interest management.

Clients MUST NOT assume that region boundaries are permanent or map directly to visible world boundaries.

### Realm Host

A **Realm Host** is a service participating in authoritative realm operation. In the prototype profile, one host is authoritative for the entire realm.

### Participant

A **Participant** is an authenticated or anonymous actor connected to a realm session.

Participants may be humans, bots, AI agents, simulations, bridges, sensors, or services.

### Principal

A **Principal** is a persistent identity reference used for ownership or authorization. It is distinct from a session-scoped participant ID.

HVTP core treats principal identifiers as opaque strings/URIs. DID-compatible identifiers MAY be used but are not mandatory.

### Presence Entity

A **Presence Entity** is a spatial projection of a participant into a realm.

A participant MAY have zero, one, or multiple presence entities. Destroying or leaving a presence entity does not imply deletion of the external human, service, or AI identity.

This separation is intentional: a persistent external system may project an avatar into a realm while its reasoning, memory, tools, and objectives remain outside the world.

### Entity

An **Entity** is the fundamental identity-bearing unit of world state.

Entity identifiers MUST be unique within a realm and SHOULD be globally unique.

### Component

A **Component** is typed state attached to an entity.

Components are independently versioned and may have different authority and consistency semantics.

### Event

An **Event** represents something that happened. Events are not durable state unless an application or host explicitly persists them.

### Subscription

A **Subscription** declares which entities, spatial areas, component types, or event streams a participant wishes to receive.

### Asset

An **Asset** is externally stored content referenced by HVTP state, such as glTF, GLB, VRM, audio, images, or behaviour modules.

---

## 5. Entity model

A conceptual entity snapshot has the following shape:

```json
{
  "id": "01K7HVTPENTITY000000000001",
  "components": {
    "hvtp.transform@1": {
      "revision": 14,
      "authority": "participant:8f93",
      "authorityEpoch": 3,
      "consistency": "authoritative",
      "state": {
        "position": [12.4, 1.0, -8.3],
        "rotation": [0.0, 0.0, 0.0, 1.0],
        "scale": [1.0, 1.0, 1.0]
      }
    },
    "hvtp.renderable@1": {
      "revision": 2,
      "authority": "host",
      "authorityEpoch": 1,
      "consistency": "authoritative",
      "state": {
        "asset": {
          "uri": "https://example.test/assets/door.glb",
          "mediaType": "model/gltf-binary",
          "integrity": "sha256-BASE64DIGEST"
        },
        "node": "Door"
      }
    }
  }
}
```

The wire format MAY optimize repeated metadata, but the semantics above remain.

### 5.1 Component revisions

Authoritative mutable components MUST carry a monotonically increasing revision within their current authority epoch.

Authoritative components MUST also expose an `authorityEpoch` or equivalent token that changes whenever canonical authority changes. This prevents delayed messages from a former authority being accepted after handoff.

A host MUST reject a mutation that specifies a stale authority epoch. An obsolete authority epoch is a fencing failure and MUST NOT be accepted merely because a component is mergeable.

For `authoritative` components, a stale `baseRevision` MUST also be rejected. A `mergeable` component extension MAY define how stale state revisions are reconciled, but that extension does not waive authority-epoch fencing.

### 5.2 Core consistency classes

HVTP 0.2 defines these conceptual classes:

- **authoritative** — one canonical writer at a time; mutations are revision checked and ordered;
- **ephemeral** — loss-tolerant, latest-value state such as high-frequency pose updates;
- **append** — ordered event/log semantics;
- **mergeable** — extension-defined multi-writer semantics such as a CRDT.

Every component instance has exactly one active consistency class. Ordinary state mutation MUST NOT implicitly switch a component between consistency classes.

- `authoritative` component instances use revision-checked canonical state and are mutated through authoritative set/patch semantics;
- `ephemeral` component instances use loss-tolerant latest-value semantics and are not durable unless a later canonicalization operation explicitly creates or updates authoritative state;
- `append` and `mergeable` semantics are defined by their respective profiles/extensions.

A message intended for one consistency class MUST NOT be accepted against a component instance using another class unless an extension explicitly defines that transition.

The 0.2 prototype profile requires only `authoritative`.

### 5.3 Core components

The initial core component registry is intentionally small.

#### `hvtp.transform@1`

Spatial transform in realm-local coordinates.

HVTP 0.2 uses metres for position and a right-handed Cartesian coordinate system with +X right, +Y up, and +Z forward. Rotation is a unit quaternion encoded as `[x, y, z, w]`. Scale is dimensionless. Numeric values MUST be finite JSON numbers; profiles MAY impose tighter ranges.

```json
{
  "position": [0.0, 0.0, 0.0],
  "rotation": [0.0, 0.0, 0.0, 1.0],
  "scale": [1.0, 1.0, 1.0]
}
```

#### `hvtp.renderable@1`

References portable render content.

```json
{
  "asset": {
    "uri": "https://example.test/cube.glb",
    "mediaType": "model/gltf-binary",
    "integrity": "sha256-OPTIONAL"
  },
  "node": null,
  "visible": true
}
```

Clients SHOULD support glTF 2.0 / GLB for interoperable 3D rendering. Additional media types MAY be negotiated.

#### `hvtp.material@1`

Allows lightweight runtime material overrides without replacing an asset.

The prototype profile MAY initially support only base color.

`baseColor` is linear-light RGBA with each channel in the inclusive range `[0, 1]`. It replaces the runtime base-color factor for compatible renderable primitives; texture sampling remains independent and may be multiplied by that factor according to the material model.

```json
{
  "baseColor": [1.0, 0.5, 0.1, 1.0]
}
```

#### `hvtp.ownership@1`

Descriptive ownership metadata.

```json
{
  "ownerPrincipal": "did:example:fausto"
}
```

Ownership MUST NOT be treated as mutation authority by implication.

#### `hvtp.permissions@1`

Describes application/host authorization policy.

HVTP 0.2 does not standardize a complete policy language. Hosts MUST enforce authorization server-side and MUST NOT rely on clients to self-police permissions.

#### `hvtp.interaction@1`

Declares supported semantic interactions such as `use`, `touch`, or application-defined actions.

#### `hvtp.presence@1`

Associates a spatial entity with a participant.

```json
{
  "participantId": "participant:8f93",
  "kind": "human",
  "displayName": "Fausto"
}
```

`kind` MAY be `human`, `agent`, `bot`, `service`, or an extension-defined value.

#### `hvtp.avatar@1`

References avatar presentation metadata. VRM and glTF-based avatars are recommended but not mandatory.

#### `hvtp.physics@1`

Carries portable physical intent such as collider/body descriptors.

HVTP MUST NOT require two heterogeneous engines to independently simulate physics and converge on identical outcomes. A designated simulation authority publishes canonical state.

#### `hvtp.behaviour@1`

References a sandboxed behaviour module and requested capabilities.

See section 10.

---

## 6. Authority model

### 6.1 Authority identifiers

A component authority may be:

- `host`;
- a specific `participant:<id>`;
- a persistent service/principal identifier;
- an extension-defined authority.

### 6.2 Mutation rules

For an authoritative component:

1. a participant submits a mutation request against a known `baseRevision` and authority epoch;
2. the host authenticates the participant;
3. the host evaluates whether that participant is permitted to request the operation;
4. the host resolves the canonical authority for the component and validates the fencing token/revision;
5. the canonical authority accepts or rejects the requested state transition;
6. if accepted, the component revision advances;
7. the host persists the accepted state when the realm is durable;
8. the host reports a terminal result to the requester and publishes canonical state to interested subscribers.

Permission to **request** a mutation is distinct from authority to **publish canonical** state. A participant MAY be permitted to request a change while the realm host remains the sole canonical writer.

Clients MAY predict local effects before acceptance but MUST reconcile with host-published canonical state or the terminal operation result.

### 6.3 Authority transfer

Authority transfer MUST be explicit.

A host MUST NOT infer authority transfer from ownership transfer, connection state, proximity, or a client beginning to publish updates.

An authority transfer operation MUST advance the component's authority epoch (or an equivalent fencing token) so stale messages from a previous authority cannot become canonical after transfer.

### 6.4 Domain authority

Applications SHOULD assign authority according to domain responsibility.

Examples:

- avatar pose: participant-predicted, host-canonical or delegated;
- physics: active simulation host;
- inventory: inventory service;
- currency: transactional economy service;
- appearance: owner or asset-authoring service.

HVTP does not require one subsystem to own truth for every component.

---

## 7. Protocol envelope

The canonical JSON envelope for HVTP 0.2 has this conceptual form:

```json
{
  "hvtp": "0.2",
  "id": "01K7MESSAGE000000000000001",
  "type": "component.patch",
  "realm": "urn:hvtp:realm:550e8400-e29b-41d4-a716-446655440000",
  "realmEpoch": "01K7REALMEPOCH000000000001",
  "seq": 1842,
  "body": {}
}
```

Fields:

- `hvtp` — protocol version used by this message;
- `id` — collision-resistant identifier for one logical message/request generated by the sender; a new logical message MUST use a new ID, while an intentional retransmission/retry of the same logical request MAY reuse its original ID so a profile can deduplicate it;
- `type` — namespaced message type;
- `realm` — realm identifier when the message is realm-scoped;
- `realmEpoch` — host-issued realm incarnation/fencing token when canonical ordering is required;
- `seq` — host-assigned monotonically increasing **realm mutation sequence** within one `realmEpoch`; it is a canonical world-state watermark, not a per-client delivery counter;
- `body` — message-specific payload.

A host restart MUST either preserve the current realm epoch and sequence safely or issue a new realm epoch. Clients MUST treat a changed realm epoch as a new canonical sequencing domain.

Interest filtering means a participant may legitimately observe realm sequence values such as 100 followed by 103 because mutations 101 and 102 affected entities outside its authorized effective view. Therefore:

- subscribers MUST treat `seq` as a sparse realm watermark;
- a gap in received realm sequence values MUST NOT, by itself, be interpreted as message loss;
- multiple subscriber-specific messages derived from the same canonical realm mutation MAY reference the same `seq`;
- snapshot/control messages that do not represent new realm mutations need not consume a realm `seq`.

A transport/profile that needs contiguous loss detection MUST define a separate delivery sequence or acknowledgement mechanism.

Client-originated messages MUST NOT invent authoritative `realmEpoch` or `seq` values.

Binary transports MAY encode the same semantic envelope differently.

---

## 8. Session and realm lifecycle

### 8.1 Hello

A new connection begins with `session.hello`.

```json
{
  "hvtp": "0.2",
  "id": "msg-hello",
  "type": "session.hello",
  "body": {
    "versions": ["0.2"],
    "client": {
      "name": "hvtp-three-client",
      "version": "0.1.0"
    },
    "participant": {
      "kind": "human",
      "principal": "did:example:optional"
    },
    "capabilities": {
      "components": [
        "hvtp.transform@1",
        "hvtp.renderable@1",
        "hvtp.material@1",
        "hvtp.presence@1"
      ],
      "behaviourRuntimes": []
    }
  }
}
```

### 8.2 Welcome

The host replies with `session.welcome`, selecting a protocol version and assigning a session-scoped participant ID.

Any persistent principal identifier presented by the client is only a claim until validated by the host's authentication mechanism. A host MUST NOT grant durable identity or permissions merely because a client supplied a principal string.

### 8.3 Join

The participant sends `realm.join` with a realm identifier and initial subscription request.

A successful join produces `realm.joined`, including realm metadata, the current `realmEpoch`, any mandatory capabilities/components, and the snapshot boundary that follows.

### 8.4 Snapshot

A host MUST provide a consistent initial view using:

- `realm.snapshot.begin`;
- zero or more `entity.snapshot` messages;
- `realm.snapshot.end`.

The snapshot boundary MUST identify the last canonical realm mutation sequence covered by the snapshot (`snapshotBaseSeq`).

A host MUST provide an unambiguous snapshot-to-live handoff. The baseline HVTP/WS procedure is:

1. capture the participant's authorized effective view at `snapshotBaseSeq`;
2. send `realm.snapshot.begin`, the full visible entity records, and `realm.snapshot.end` without interleaving later live canonical publications on that connection;
3. buffer subscriber-relevant view changes whose realm `seq` is greater than `snapshotBaseSeq`;
4. after `realm.snapshot.end`, flush those buffered changes in increasing realm-sequence order.

A client SHOULD build the snapshot as a replacement view and make it active at `realm.snapshot.end`. It MUST ignore live canonical messages from the same realm epoch at or below `snapshotBaseSeq` if they are replayed. Realm-sequence gaps above the boundary remain legal because of interest filtering.

### 8.5 Leave

Either side may terminate realm participation. A presence entity MAY be despawned while the participant remains connected for non-spatial services.

---

## 9. Mutations and events

### 9.1 Entity creation

`entity.create` requests creation of an entity with an initial component set.

The host validates the request and publishes the canonical accepted entity to subscribers.

### 9.2 Entity deletion

`entity.delete` requests deletion or tombstoning of an entity.

Persistent realms SHOULD retain enough tombstone/version information to prevent stale recreation races.

Global deletion is distinct from a subscriber no longer being interested in or authorized to view an entity. Leaving a participant's effective view MUST NOT be represented as `entity.delete`; profiles MUST provide a view-eviction semantic that does not create a world tombstone.

### 9.3 Component set

`component.set` replaces the state of one component and includes `baseRevision` and the last observed `authorityEpoch` for authoritative components.

### 9.4 Component patch

`component.patch` applies a partial update to the component's `state` object and includes `baseRevision` and the last observed `authorityEpoch` for authoritative components.

The JSON transport profile SHOULD use [JSON Merge Patch (RFC 7396)](https://www.rfc-editor.org/rfc/rfc7396) semantics for the `patch` payload unless a component defines otherwise.

### 9.5 Ephemeral update

`component.ephemeral` carries loss-tolerant latest-value state for a component instance whose active consistency class is `ephemeral`. It SHOULD include a component-local monotonic sequence so receivers can discard stale packets.

A host MUST reject `component.ephemeral` against an `authoritative` component instance. Conversely, ordinary authoritative `component.set` / `component.patch` requests MUST NOT silently mutate an `ephemeral` instance.

Ephemeral updates MUST NOT advance an authoritative revision and MUST NOT be assumed durable. If an ephemeral component has transferable authority, its updates MUST carry the current authority epoch or equivalent fencing token.

A later profile MAY define an explicit canonicalization operation from ephemeral state into authoritative durable state; such canonicalization is not implicit.

### 9.6 Events

`event.emit` carries semantic events.

Core event identifiers include:

- `hvtp.interaction.use`;
- `hvtp.interaction.touch`;
- `hvtp.volume.enter`;
- `hvtp.volume.leave`;
- `hvtp.physics.collision`;
- `hvtp.message`;
- `hvtp.timer`.

Applications MAY define events such as `example.commerce.purchase` or `example.governance.vote`.

Hosts MUST validate whether an event source is permitted to emit an event. Events MUST NOT be trusted merely because a client claims they occurred.

### 9.7 Request outcomes

Every mutation request MUST produce a terminal success or error result to its originator, even when the resulting entity is outside that originator's effective subscription.

A client MUST NOT depend on receiving a canonical subscriber publication as proof that its own request succeeded. Profiles MUST define acknowledgement durability and duplicate-request semantics.

---

## 10. Behaviour model

HVTP behaviours are portable logic modules attached to entities.

The core protocol defines the **execution contract**, not one mandatory scripting language.

A behaviour component may reference:

```json
{
  "runtime": "wasm",
  "module": {
    "uri": "https://example.test/behaviours/door.wasm",
    "integrity": "sha256-BASE64DIGEST"
  },
  "entrypoints": [
    "on_spawn",
    "on_use",
    "on_message"
  ],
  "capabilities": [
    "entity.read.self",
    "component.patch.self"
  ],
  "limits": {
    "memoryBytes": 16777216,
    "executionMs": 10
  }
}
```

Candidate runtimes include WASM, Lua, and behaviour graphs.

### 10.1 Standard hooks

The portable behaviour ABI SHOULD eventually standardize hooks including:

- `on_spawn`;
- `on_destroy`;
- `on_use`;
- `on_touch`;
- `on_enter`;
- `on_leave`;
- `on_collision`;
- `on_message`;
- `on_timer`;
- `on_owner_changed`;
- `on_permission_changed`.

### 10.2 Sandboxing

Behaviour runtimes MUST be capability based.

A behaviour MUST NOT receive arbitrary filesystem, process, or network access by default.

Hosts SHOULD enforce CPU/instruction, memory, event-rate, and outbound-mutation budgets.

Behaviour-produced world changes MUST pass through the same authority and authorization rules as participant-produced mutations.

---

## 11. Assets

Assets are referenced, not embedded into protocol semantics.

An asset reference SHOULD contain:

- a resolvable URI;
- media type;
- optional integrity digest;
- optional size and metadata.

HTTP(S) is the baseline retrieval mechanism for the 0.2 prototype profile. Other schemes such as content-addressed stores MAY be supported through negotiation.

Clients MUST treat remote assets as untrusted input.

---

## 12. Interest management

A participant SHOULD receive only state relevant to its current task.

HVTP subscriptions may select by:

- spatial volume;
- entity IDs;
- component types;
- event types;
- application-defined query filters.

The prototype profile requires spatial-radius and explicit-entity subscriptions only.

Hosts MAY move region boundaries or rebalance hosting without changing visible realm semantics.

Subscriptions express **interest**, not authorization. The host MUST evaluate read authorization before including an entity or component in an effective view. Requesting an entity by ID or spatial location MUST NOT grant access to otherwise unauthorized state.

The standard request message for replacing a participant's active interest declaration is `subscription.set`. A host MAY clamp, reject, or transform subscriptions according to realm policy and MUST communicate the resulting effective subscription.

When an entity enters a participant's effective view, the host MUST provide sufficient current state for the client to materialize that entity without depending on unseen historical patches. When an entity leaves the effective view, the host MUST explicitly evict it from that participant's view without implying global deletion.

Profiles MUST define how multiple subscription selectors combine and how subscription replacement is ordered relative to concurrent realm mutations.

---

## 13. Identity, ownership, and permissions

HVTP distinguishes:

- **participant identity** — session actor;
- **principal identity** — durable identity reference;
- **presence** — spatial embodiment;
- **ownership** — domain metadata;
- **authority** — who may publish canonical component state;
- **permission** — who may request an operation.

These MUST NOT be collapsed into one field.

DID Core MAY be used for durable principal identifiers, but a conforming HVTP implementation MUST be able to operate with another identity system or anonymous/session identities.

Presence bindings are security-sensitive host state. A host MUST NOT allow a participant to create or mutate a presence binding that impersonates another participant merely by supplying that participant's identifier.

---

## 14. AI agents and external systems

AI agents are first-class participants, not a special NPC transport.

An agent MAY:

- authenticate as a participant;
- maintain zero or more presence entities;
- subscribe to nearby or task-relevant state;
- receive structured entity/component state directly;
- emit permitted interactions and mutations;
- communicate with human or non-human participants.

The intelligence itself SHOULD remain outside the presence entity unless an application intentionally embeds it.

This permits external agent systems to maintain persistent reasoning, memory, tools, and objectives independently while projecting one or more spatial presences into HVTP realms.

---

## 15. Transport profiles

The HVTP semantic model is transport independent.

### 15.1 HVTP/WS

The initial required profile uses:

- WebSocket;
- JSON text messages;
- reliable ordered delivery;
- TLS (`wss://`) outside local development.

This profile is intentionally boring and optimized for rapid implementation and debugging.

### 15.2 Future WebTransport profile

A future profile may map different traffic classes to WebTransport streams/datagrams:

- reliable ordered: entity lifecycle, permissions, inventory, durable mutations;
- loss-tolerant/latest-value: high-frequency poses and transforms;
- independent streams: assets, world state, event channels.

This is not normative in 0.2.

### 15.3 P2P/federated transports

Peer and federated transports are explicitly out of the 0.2 core profile. Their later introduction MUST preserve authority, identity, authorization, and canonical-state semantics rather than treating peer delivery as proof of truth.

---

## 16. Persistence

Persistence is a realm policy.

Persistent hosts SHOULD durably store accepted authoritative state before acknowledging operations whose loss would violate application expectations.

The protocol does not mandate a database.

A persistent realm SHOULD be recoverable to a canonical entity/component state after host restart.

Event history and audit history are separate from current-state persistence and MAY be retained according to realm policy.

---

## 17. Federation and realm transfer

HVTP 0.2 reserves federation as a protocol direction rather than pretending it is solved.

A future federated profile should support:

- realm discovery;
- capability negotiation;
- principal continuity across hosts;
- explicit trust relationships;
- asset portability;
- presence handoff / teleportation;
- independently administered realms.

Session-scoped participant IDs MUST NOT be assumed portable across hosts.

A realm transfer SHOULD be expressed as a destination descriptor rather than assuming one universal server operator.

---

## 18. Security and privacy

A conforming host MUST assume clients, assets, scripts, and remote services are untrusted.

Implementations SHOULD address at minimum:

- authentication where durable identity is required;
- server-side authorization;
- authority validation;
- stale/replay mutation rejection;
- bounded message, entity, snapshot, subscription, and outbound-queue sizes;
- rate limiting and resource quotas;
- behaviour sandboxing;
- asset size/type limits;
- integrity verification when supplied;
- denial-of-service resistance;
- auditability of privileged operations;
- privacy boundaries for presence, location, chat, voice metadata, and behavioural telemetry.

Clients MUST NOT be able to make state canonical solely by asserting that it happened.

---

## 19. Versioning and extensions

HVTP core versions use major/minor protocol numbers during the experimental phase.

Extensions SHOULD be independently versioned.

Examples:

- `hvtp.transform@1`;
- `org.example.vehicle@2`;
- `example.land.claim@1`.

Unknown optional components MUST NOT make an entity unusable. A client MAY ignore an unknown component while continuing to represent supported parts of the entity.

A realm MAY declare some components mandatory for participation and MUST communicate those requirements during capability negotiation.

---

## 20. Prototype conformance target

The first reference implementation is intentionally narrower than the complete design.

A 0.2 prototype-conforming host/client pair must support:

- HVTP/WS JSON transport;
- `session.hello` / `session.welcome`;
- realm join;
- initial snapshots;
- entity create/delete;
- `hvtp.transform@1`;
- `hvtp.renderable@1`;
- `hvtp.material@1`;
- `hvtp.presence@1`;
- authoritative component revisions;
- terminal request outcomes and duplicate-request handling;
- persistence across host restart;
- explicit effective-view enter/leave lifecycle;
- simple spatial and explicit-entity subscriptions;
- interoperable transform/material conventions.

See [prototype-profile.md](./prototype-profile.md) for the executable experiment contract.

---

## 21. Open design questions

The following are intentionally unresolved in 0.2:

- exact portable permissions/policy language;
- authority handoff wire messages and epochs;
- canonical IDs and identifier encoding;
- very-large-world origin rebasing and multi-coordinate-space composition;
- formal component registry process;
- binary encoding;
- WebTransport mapping;
- portable physics schema;
- deterministic or non-deterministic behaviour execution;
- WASM host ABI;
- federation/discovery;
- avatar capability negotiation;
- voice/media signalling;
- CRDT profile for collaborative authoring;
- audit/history profile.

These should be resolved through focused RFCs and working prototypes rather than speculative completeness.
