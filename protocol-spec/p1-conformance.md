# HVTP 0.2 P1 Conformance Cases

Status: **Normative for Prototype Profile P1**

This document defines the minimum behavioural test cases required by [Prototype Profile P1](./prototype-profile.md).

A P1 implementation is not conformant merely because the happy-path cube demo works. The host and clients must also agree on conflict handling, snapshot boundaries, subscription membership, retry uncertainty, presence authorization, persistence, limits, and cross-client interpretation.

The examples below use abbreviated payloads where the surrounding profile already fixes the exact shape. Assertions are normative.

---

## C01 — Happy-path shared persistent entity

### Setup

- clean realm;
- browser A and browser B joined;
- overlapping subscriptions around origin;
- both clients completed their initial snapshots.

### Actions

1. A sends a valid `entity.create` for the P1 unit-cube asset.
2. Host commits it.
3. A sends a valid transform patch.
4. B sends a valid material patch using the current material revision.
5. Host restarts.
6. A and B reconnect and take fresh snapshots.

### Required results

- creator receives committed `ack`;
- B receives exactly one `entity.created` with a full materializable entity and no additional `view.entity.enter` for that creation;
- creation advances realm `seq` once; each later accepted component mutation advances realm `seq` once;
- both accepted component mutations advance exactly one component revision each;
- mutating transform does not change renderable/material revisions or state, and mutating material does not change transform/renderable revisions or state;
- canonical subscriber publications contain full resulting component envelopes;
- after restart the entity, transform, material, and component revisions match the last durable state;
- the new host process uses a new `realmEpoch`.

---

## C02 — Concurrent revision conflict

### Setup

A and B both observe:

```text
hvtp.material@1 revision = 5
authorityEpoch = 1
```

### Actions

A and B independently submit different `component.patch` requests with:

```text
baseRevision = 5
authorityEpoch = 1
```

### Required results

Exactly one request commits first and creates revision 6.

The other request MUST receive:

```json
{
  "type": "error",
  "body": {
    "code": "revision_mismatch",
    "currentRevision": 6,
    "authorityEpoch": 1
  }
}
```

There MUST NOT be silent last-writer-wins behaviour.

Repeat with `baseRevision: 6` while current revision is 5: it is also rejected with `revision_mismatch`. A request with a negative, fractional, string, or value above `2^53-1` is rejected as `invalid_message`.

Concurrent valid updates to different components may both commit independently, each advancing only its own component revision and the realm sequence once. An update racing a successful global deletion must serialize so exactly one operation observes an existing entity; the loser receives the appropriate `entity_not_found` or revision error without resurrecting state.

---

## C03 — Authority epoch must match exactly

### Setup

A component's current metadata is:

```text
revision = 9
authorityEpoch = 3
```

### Actions

Run mutations carrying `authorityEpoch: 2`, `authorityEpoch: 4`, and invalid-domain epoch values.

### Required results

Epochs 2 and 4 are rejected with:

```text
authority_epoch_mismatch
```

Negative, zero, fractional, string, or values above `2^53-1` are rejected as `invalid_message`.

No mismatch may be accepted because a component or future extension supports mergeable state.
---

## C04 — Entity enters spatial interest

### Setup

- client A has spatial subscription centered at origin with radius 100 m;
- entity E exists at X=150 and is not explicitly pinned;
- A has never received E.

### Action

A canonical transform mutation moves E to X=90.

### Required results

- A receives `view.entity.enter` at the mutation's realm `seq`;
- the message contains complete authorized current state for E;
- A does NOT receive only a transform patch for an unknown entity;
- A can materialize E without requesting historical state.

---

## C05 — Entity leaves spatial interest and re-enters

### Setup

- A currently sees entity E at X=90 inside a 100 m radius;
- E is not explicitly pinned.

### Actions

1. canonical transform mutation moves E to X=120;
2. later canonical transform mutation moves E to X=80.

### Required results

For step 1:

- A receives `view.entity.leave`;
- A removes E from its local view;
- A does not create a global deletion tombstone.

For step 2:

- A receives `view.entity.enter` with full current state;
- stale local state from the earlier incarnation is not reused as authoritative state.

---

## C06 — Explicit subscription overrides distance by union

### Setup

A requests:

```json
{
  "spatial": {
    "center": [0, 0, 0],
    "radius": 25
  },
  "entities": ["entity:far-away"]
}
```

`entity:far-away` is at X=1000.

### Required result

If read authorization permits the entity, it is included because P1 combines spatial and explicit selectors by **union**.

An omitted spatial selector plus an empty entity list produces an empty subscribed view, except for the participant's own presence entity.

---

## C07 — Subscription replacement is a view operation, not world deletion

### Setup

A's old subscription includes E. A replacement subscription excludes E.

### Action

A submits `subscription.set`.

### Required results

The host sends:

1. `subscription.applied` with a new `subscriptionId` and `baseRealmSeq`;
2. `view.entity.leave` for E;
3. buffered post-boundary relevant changes afterwards.

The host MUST NOT emit `entity.deleted` for E merely because A no longer subscribes to it.

Other subscribers whose effective view still includes E remain unaffected.

---

## C08 — Snapshot mutation boundary

### Setup

The host captures a join snapshot at `snapshotBaseSeq = 200`.

### Action

While snapshot records are being generated, another participant commits a material mutation at realm sequence 201.

### Required results

On the joining connection:

1. snapshot begin/entity records/end are delivered without interleaved live publication;
2. the snapshot represents state through sequence 200;
3. the sequence-201 change is buffered;
4. after `realm.snapshot.end`, the canonical sequence-201 view change is delivered;
5. the final client state equals canonical state at sequence 201;
6. no state is applied twice.

If the socket closes before snapshot end, the partial snapshot is discarded.

---

## C09 — Sparse realm sequences are legal

### Setup

A sees entity X but not entity Y.

### Realm mutations

- seq 300 updates X;
- seq 301 updates Y;
- seq 302 updates Y;
- seq 303 updates X.

### Required result

A may legally receive canonical publications carrying sequence 300 then 303.

The client MUST NOT interpret missing 301/302 as packet loss or request a resync solely because of that gap.

---

## C10 — Duplicate request, same content

Run two independent variants.

### Variant A — duplicate while pending

Use a deterministic processing/commit barrier so request `req-77` is admitted but not yet terminal. Resend structurally equal parsed JSON using the same ID, including reordered object keys.

Required:

- both transmissions refer to one logical operation;
- no unbounded waiter is allocated per retransmission;
- exactly one mutation executes;
- the eventual terminal result is the same logical result.

### Variant B — duplicate after completion

Let `req-77` complete and cache its terminal result, then resend structurally equal parsed JSON with the same ID.

Required:

- the cached terminal result is returned;
- no world mutation is re-executed;
- component revision and realm sequence do not advance again;
- cached retry handling does not rebroadcast historical `component.updated`, `entity.created`, `entity.deleted`, `view.entity.enter`, or `view.entity.leave` messages.

Repeat Variant B for a cached terminal error: the same error is returned without reprocessing the operation.
---

## C11 — Duplicate request ID, different content

Run two variants: reuse `req-88` with different parsed request content while the original request is still pending, and reuse it after the original request has a cached terminal result.

Both retries are rejected with:

```text
request_id_conflict
```

The original request continues to its own unchanged terminal outcome. No second world mutation occurs.
---

## C12 — Lost reply across reconnect is explicitly uncertain

### Setup

A sends a valid mutation. The host may or may not have committed it when the connection disappears before A receives `ack` or `error`.

### Actions

A reconnects.

### Required results

- old session deduplication state is not assumed available;
- A takes a fresh snapshot;
- A determines canonical state from that snapshot;
- A does not automatically replay the old mutation ID;
- if another mutation remains necessary, A sends a new request using the current revision and a new request ID.

P1 makes no exactly-once guarantee across sessions.

---

## C13 — Mutation outside requester's subscription still has terminal result

### Setup

A is permitted to mutate an explicitly known shared entity but its active spatial view will no longer contain that entity after the mutation.

### Action

A moves the entity outside A's effective view.

### Required results

- A receives terminal `ack` directly;
- A receives `view.entity.leave` as appropriate;
- successful operation reporting does not depend on receiving `component.updated`.

---

## C14 — Presence binding impersonation is rejected

### Setup

Participants A and B each have host-created presence entities.

### Actions and required results

A attempts any of the following:

- create a new entity containing `hvtp.presence@1` bound to B;
- set/patch B's `hvtp.presence@1`;
- set/patch B's presence transform;
- set/patch A's own presence transform;
- globally delete A's own presence entity;
- globally delete B's presence entity.

Each request MUST be rejected with `not_authorized` or `presence_binding_violation`.

P1 presence state is static host-managed session state. Neither A nor B may mutate/delete it. When B disconnects, B's presence is removed as session state without a persistent tombstone or realm-sequence mutation, and A never receives B's private presence state.

---

## C15 — Ephemeral traffic is rejected in P1

### Action

A sends:

```json
{
  "type": "component.ephemeral"
}
```

### Required result

Reject with:

```text
unsupported_message
```

The message MUST NOT mutate an authoritative component or bypass persistence/revision rules.

---

## C16 — Renderable fixture is explicit

### Action

A creates the happy-path cube.

### Required result

The creation request includes `hvtp.renderable@1` with exactly:

```json
{
  "asset": {
    "uri": "unit-cube.gltf",
    "mediaType": "model/gltf+json"
  },
  "node": "UnitCube",
  "visible": true
}
```

The host rejects any other URI, media type, or node name with `invalid_component_state`; `visible` must be a JSON boolean. URI/message size violations use `resource_limit`.

The client resolves `unit-cube.gltf` against `session.welcome.assetBaseUri`, does not follow redirects, enforces `maxAssetBytes`, and uses a local-only placeholder on fetch/validation failure without mutating shared state.

A client MUST NOT infer cube geometry from the entity ID, display name, or test case.
---

## C17 — Transform validation and interpretation

At the byte/JSON layer, literal `NaN` or `Infinity` tokens are invalid JSON and are handled as malformed input, not component state.

After valid JSON parsing, each of the following transform states MUST be rejected with `invalid_component_state`:

- a numeric token such as `1e400` that the implementation decodes to a non-finite value;
- quaternion whose norm differs from 1 by more than `1e-5`;
- wrong vector lengths/types;
- zero or negative P1 scale;
- scale greater than 1000;
- position outside the P1 coordinate range.

A conforming independent renderer interprets quaternion order as `[x, y, z, w]`, uses metres, right-handed coordinates, +Y up, +Z forward, and active `T × R × S` composition after the selected glTF node hierarchy.

Numerical assertion: for local point `[0.5,0.5,0.5]`, translation `[0,0,0]`, scale `[2,1,1]`, and +90° active rotation about +Z represented by quaternion approximately `[0,0,0.7071067811865475,0.7071067811865476]`, the realm point MUST be approximately `[-0.5,1.0,0.5]` within tolerance `1e-9`.
---

## C18 — Material interpretation

Given:

```json
{
  "baseColor": [0.25, 0.5, 0.75, 1.0]
}
```

two conforming clients MUST interpret those values as linear-light RGBA base-color factors.

Values outside `[0, 1]`, non-finite values, or arrays of the wrong length are rejected with `invalid_component_state`.

---

## C19 — Durable commit failure

### Setup

The persistence layer is fault-injected so a valid mutation cannot complete its durable transaction.

### Required results

- no `ack` with `status: "committed"` is sent;
- no canonical subscriber publication is sent;
- after recovery/restart, canonical state remains at the previous revision;
- the host returns an error when it can do so safely.

The exact storage engine error is not exposed as a protocol contract.

Repeat fault injection for create and delete/tombstone transactions: entity state, tombstone state, component revisions, and sequence assignment must be atomic.

Also test a failure after the durable commit succeeds but before ACK/publication is sent. The host MUST NOT roll back or report a false rejected state; if the client disconnects before learning the outcome, reconnect semantics from C12 apply and canonical state reveals the committed result.

---

## C20 — Restart invalidates session-scoped state

### Setup

A and B are connected under `realmEpoch = E1`.

### Action

Host process restarts.

### Required results

- old connections terminate;
- new sessions receive a new realm epoch E2 where `E2 != E1`;
- old participant IDs, presence entities, subscriptions, and request-dedup caches are not treated as valid session state;
- durable non-presence entities and durable tombstones remain;
- a tombstoned entity ID remains non-reusable after restart;
- in-flight old-session requests do not resume automatically in the new process/session;
- reconnecting clients take new snapshots.

---

## C21 — Resource limits

Test at least:

- a complete reassembled WebSocket message larger than advertised `maxMessageBytes`, including a fragmented-message variant where each fragment is individually small;
- subscription radius larger than advertised maximum;
- too many explicit entity IDs;
- entity serialization larger than maximum;
- join/subscription replacement whose effective view would exceed `maxVisibleEntitiesPerConnection`;
- a live world mutation that would grow an already-active view above `maxVisibleEntitiesPerConnection`;
- all-request/control flooding above `maxClientRequestsPerSecond`;
- durable mutation rate above `maxMutationRequestsPerSecond`;
- filling `maxPendingStateChangingRequests`;
- filling the request-deduplication table;
- a slow snapshot/subscription consumer whose buffered catch-up would exceed `maxQueuedOutboundBytes`;
- outbound queue exhaustion;
- host-wide live-entity+tombstone storage reaching `maxPersistentEntityRecords`.

### Required results

The host remains bounded.

Where a safe response is possible, return `resource_limit`. A join/replacement rejected for view size preserves the previous/no view. If later world growth exceeds a connection's live-view cap, the host reports `resource_limit` when safe and closes that connection rather than silently dropping selected entities.

When the persistent-record budget is full, new entity creation is rejected without mutating world state.

For outbound/buffer/message conditions that prevent a safe response, the host may close the connection.

The implementation MUST NOT allocate without bound to satisfy an invalid, fragmented, slow, or overloaded client.
---

## C22 — Read authorization precedes interest

### Setup

Participants A and B are joined. B has host-created presence entity `entity:presence-b`.

P1 authorizes that presence entity only to B.

### Action

A explicitly requests `entity:presence-b` in `subscription.set`, then repeats with a combined spatial selector that would also geometrically include B's presence.

### Required result

B's presence entity does not enter A's effective view and is omitted from any `view.entity.enter` or snapshot state delivered to A.

The required ordering is:

```text
authorization → interest selection → delivery
```

Interest is not a capability grant.

---

## C23 — Second consumer interprets the same fixture

After the primary P1 host/Three.js client passes C01–C22, run at least one independently implemented consumer against the same persisted realm or captured fixture messages.

The second consumer MUST agree on:

- entity identity;
- component revisions;
- transform position units;
- axis handedness;
- quaternion ordering;
- scale;
- material RGBA values;
- asset/node reference;
- view-enter/view-leave meaning;
- global deletion meaning;
- the nonuniform-scale/+90° transform assertion from C17;
- subscription-generation ordering and stale-message rejection;
- creation versus view-enter and deletion versus view-leave publication precedence.

Sharing wire/schema definitions is allowed. Sharing Three.js adapter logic is not sufficient proof.

---

## C24 — Global deletion versus view eviction

### Setup

A and B both see E.

### Actions

1. A changes subscription so E leaves A's view.
2. Later B submits valid `entity.delete` for E.

### Required results

Step 1:

- A receives `view.entity.leave`;
- B continues to see E.

Step 2:

- B receives exactly one `entity.deleted` and no `view.entity.leave` for that deletion;
- E is globally tombstoned/deleted;
- deleting E again returns `entity_not_found` without sequence advance;
- recreating E with the same entity ID returns `entity_exists`;
- after restart the tombstone remains;
- if A later requests a subscription that would have included E, E does not reappear;
- replay/cached request handling does not rebroadcast the historical deletion/view transition.

---

## C25 — Closed JSON shape and duplicate keys

### Actions

Submit each of the following independently:

- a known P1 message with an unknown top-level/body field;
- a JSON object containing a duplicate key, including a decoded duplicate such as `"id"` and `"\u0069d"`;
- a missing or empty client request ID;
- a client-generated message/entity ID longer than 128 UTF-8 bytes;
- a participant kind other than `human` or `agent`;
- a host-publication message type sent in the client→host direction.

### Required result

Reject with `invalid_message` (or `unsupported_message` only when the message `type` itself is unknown).

No partial state mutation occurs.

Positive shape checks MUST also accept `SubscriptionSelector` as `{}`, explicit-entity-only, spatial-only, and both-fields forms; reject missing fields that are actually required by the corresponding message subsection.

---

## C26 — Merge Patch cannot delete required component state

### Setup

A shared entity has a valid transform at revision 5.

### Action

Submit:

```json
{
  "type": "component.patch",
  "body": {
    "entityId": "entity:test",
    "component": "hvtp.transform@1",
    "authorityEpoch": 1,
    "baseRevision": 5,
    "patch": {
      "position": null
    }
  }
}
```

### Required result

The host applies RFC 7396 semantics conceptually, validates the resulting full transform, and rejects the request with `invalid_component_state`.

Revision 5 remains canonical and the realm sequence does not advance.

Also reject empty patch objects, non-object patches, wrong vector lengths/types, and unknown patch fields. Every rejected patch preserves the complete prior component state atomically.

---

## C27 — Immutable renderable and presence components

### Setup

A shared non-presence entity exists with valid renderable state. Participant A also has its host-created presence entity.

### Actions

A attempts:

- `component.set` or `component.patch` against the shared entity's `hvtp.renderable@1`;
- `component.set` or `component.patch` against any `hvtp.presence@1`;
- `component.set` or `component.patch` against any presence entity transform.

### Required results

All requests are rejected with `not_authorized` or `presence_binding_violation` according to the target.

No component revision or realm sequence advances, and no session presence state changes.

---

## C28 — Overlapping subscription replacements serialize by generation

### Setup

Initial subscription S0 includes E. Prepare two accepted replacement requests on the same connection:

- S1 excludes E;
- S2 includes E.

### Required results

- the host processes replacements serially per connection;
- S1's `subscription.applied` + transition batch completes before S2's batch begins;
- after S2 applies, the active generation is S2 and E is present;
- subscriber-scoped messages carry their `subscriptionId`;
- a deliberately delayed message tagged with S1 after S2 is active is ignored by the client;
- two legitimate messages sharing the same realm `seq` are not treated as duplicates merely because the sequence is equal.

Repeat with a pre-boundary canonical publication already queued before S1: it is delivered before `subscription.applied(S1)`.

A cached retry of either `subscription.set` returns cached `subscription.applied` but does not replay historical enter/leave publications.

---

## C29 — Spatial membership predicate is transform-origin Euclidean distance

Use spatial center `[0,0,0]` and radius 100.

Required:

- `[100,0,0]` is selected;
- `[100.000001,0,0]` is not;
- `[0,100,0]` and `[0,0,100]` are selected;
- `[60,80,0]` is selected;
- huge/nonuniform scale does not change membership;
- `renderable.visible: false` does not change membership;
- asset geometry/bounds are never used;
- radius 0 selects an entity exactly at the center;
- malformed center lengths, nonfinite values, negative radius, or radius above the advertised maximum are rejected.

---

## C30 — Snapshot metadata and mutation kinds are complete

For every snapshot, `realm.joined`, `realm.snapshot.begin`, every `entity.snapshot`, and `realm.snapshot.end` agree on `realmEpoch`, `snapshotId`, and `snapshotBaseSeq`. `entityCount` equals the number of entity records.

A mismatched/missing snapshot identifier or base sequence causes the client to discard/reject the snapshot rather than partially activate it.

Repeat C08 with each post-cut event:

- existing component update;
- entity creation;
- global deletion;
- existing entity crossing spatial membership.

Each change is buffered and applied exactly once after `realm.snapshot.end` using the correct publication kind.

---

## C31 — Request-table admission and subscription retries

Fill `maxRequestDedupEntries` with admitted pending/cached state-changing IDs.

For a new ID R:

- existing-ID lookup happens before capacity rejection;
- R receives `resource_limit` and is not reserved/cached;
- retrying R while full may receive `resource_limit` again;
- after capacity becomes available, R may be admitted as a new logical request.

For `subscription.set` retries:

- same-content pending retry is one logical operation;
- different-content same-ID retry returns `request_id_conflict`;
- completion produces one logical `subscription.applied` result;
- completed retry returns cached `subscription.applied`;
- cached retry never repeats historical enter/leave messages.

---

## C32 — Revision/epoch domains and no-op mutation

For a component at revision 5 / authority epoch 1:

- revision 5 + epoch 1 is eligible;
- revision 4 or 6 returns `revision_mismatch`;
- epoch below or above 1 returns `authority_epoch_mismatch`;
- zero/negative/fractional/string/out-of-range metadata is `invalid_message`.

Submit a valid `component.set` whose resulting state equals current state.

Required: it advances revision exactly once and realm `seq` exactly once; same-session retry does not advance them again.

---

## C33 — Malformed and uncorrelated errors

Send exact wire inputs:

1. truncated JSON `{`;
2. literal `NaN` / `Infinity` token;
3. duplicate decoded request-ID keys such that no unique valid ID exists;
4. valid JSON with `1e400` in a transform field that decodes outside the finite component domain.

Required:

- cases 1–2 use `invalid_json` with `body.ref: null` if the host sends an error; permitted close behavior is acceptable;
- case 3 uses `invalid_message` with `body.ref: null` if the host sends an error;
- case 4 reaches component validation and returns `invalid_component_state` with the parsed request ID;
- rejected hello remains `CONNECTED`;
- rejected join remains `NEGOTIATED`;
- rejected joined-state mutation remains `JOINED` unless an explicit close rule applies.

---

## C34 — Asset base resolution and load failure are renderer-local

`session.welcome` advertises e.g. `https://realm.example/assets/p1/`.

Required:

- browser and headless clients resolve `unit-cube.gltf` to the same URL regardless of document origin;
- redirects are not followed;
- wrong URI, media type, or node name is invalid component state;
- non-boolean `visible` is invalid component state;
- oversized asset is a local load failure;
- fetch failure causes only local placeholder/error presentation, never shared mutation;
- `visible: false` remains valid and does not affect spatial subscription membership.

---

## C35 — Creation/deletion publication precedence

Create an entity visible to A and invisible to B.

Required: A receives exactly one `entity.created` with active `subscriptionId` and no `view.entity.enter`; B receives neither.

Then delete an entity visible to A and invisible to B.

Required: A receives exactly one `entity.deleted` with active `subscriptionId` and no `view.entity.leave`; B receives neither.

Deleting again returns `entity_not_found` without realm-sequence advancement.

---

## C36 — Live-view overflow is explicit

A connection already has exactly `maxVisibleEntitiesPerConnection` selected entities. Another participant creates/moves one more entity into that effective view.

Required:

- the realm mutation may commit;
- the affected connection is not silently given a partial view;
- host sends `resource_limit` when safe and closes the affected connection;
- reconnecting with the same too-broad selector is rejected until narrowed.

---

## C37 — Independent transform/lifecycle trace

The independent consumer receives a captured trace including:

- nonuniform `scale: [2,1,1]`;
- +90° active quaternion rotation about +Z;
- a subscription transition with a stale old-generation message injected afterwards;
- creation, ordinary update, view leave/re-enter, and global deletion.

It MUST produce C17's numerical transform result and exact lifecycle/publication outcomes without using Three.js adapter logic.

---

## Minimum pass criterion

**P1 Reference Implementation Complete** requires:

- the happy path in Prototype Profile `16 passes;
- C01–C22 and C24–C36 pass for the reference host/clients;
- no test relies on renderer-private messages/state;
- a clean restart preserves durable world state.

**P1 Interoperability Accepted** additionally requires:

- C23 and C37 pass with an independently implemented consumer;
- the independent consumer demonstrates the same numeric transform and lifecycle/wire meaning.

Only the second gate is sufficient to freeze P1 as an interoperability profile.

Failures should be fixed in the smallest relevant protocol/profile layer rather than by adding new platform-specific side channels.
