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
- B receives `entity.created` with a full materializable entity;
- both accepted mutations advance exactly one component revision each;
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
    "code": "stale_revision",
    "currentRevision": 6,
    "authorityEpoch": 1
  }
}
```

There MUST NOT be silent last-writer-wins behaviour.

---

## C03 — Stale authority epoch is never mergeable

### Setup

A component's current metadata is:

```text
revision = 9
authorityEpoch = 3
```

### Action

A client submits a mutation carrying `authorityEpoch: 2`, regardless of its base revision.

### Required result

Reject with:

```text
stale_authority_epoch
```

The request MUST NOT be accepted because a component or future extension supports mergeable state.

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

### Setup

A sends mutating request ID `req-77`. The host commits it and caches the terminal result for A's session.

The response is delayed or ignored by the test client.

### Actions

Run both variants:

1. resend the structurally identical `req-77` while the first operation is still pending;
2. resend it again after the terminal result has been cached.

### Required results

- the in-flight retry attaches to the same logical operation and receives the same eventual terminal result;
- the completed retry returns the cached terminal result;
- no second world mutation occurs in either case;
- component revision and realm sequence do not advance again.

---

## C11 — Duplicate request ID, different content

### Setup

Request ID `req-88` already has a terminal result in the current session.

### Action

The same session reuses `req-88` with different semantic request content.

### Required result

Reject with:

```text
request_id_conflict
```

No world mutation occurs.

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
- set/patch A's own presence transform.

Each request MUST be rejected with `not_authorized` or `presence_binding_violation`.

P1 presence state is static host-managed session state. Neither A nor B may mutate it.

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

The creation request includes `hvtp.renderable@1` referencing:

```text
/assets/p1/unit-cube.gltf
```

The host rejects an otherwise well-formed asset URI other than `/assets/p1/unit-cube.gltf` with `invalid_component_state`. URI/message size violations use `resource_limit`.

A client MUST NOT infer cube geometry from the entity ID, display name, or test case.

---

## C17 — Invalid transform interpretation

Each of the following transform states MUST be rejected with `invalid_component_state`:

- NaN or Infinity encoded by a non-standard parser;
- quaternion whose norm differs from 1 by more than `1e-5`;
- zero or negative P1 scale;
- scale greater than 1000;
- position outside the P1 coordinate range.

A conforming independent renderer interprets quaternion order as `[x, y, z, w]`, uses metres, right-handed coordinates, +Y up, +Z forward.

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
- durable non-presence entities remain;
- reconnecting clients take new snapshots.

---

## C21 — Resource limits

Test at least:

- JSON frame larger than advertised `maxMessageBytes`;
- subscription radius larger than advertised maximum;
- too many explicit entity IDs;
- entity serialization larger than maximum;
- a join/subscription whose effective view would exceed `maxSnapshotEntities`;
- mutation rate above advertised maximum;
- filling the request-deduplication cache;
- outbound queue exhaustion.

### Required results

The host remains bounded.

Where a safe response is possible, return `resource_limit`. For outbound queue exhaustion the host may close the connection.

The implementation MUST NOT allocate without bound to satisfy an invalid or overloaded client.

---

## C22 — Read authorization precedes interest

### Setup

Participants A and B are joined. B has host-created presence entity `entity:presence-b`.

P1 authorizes that presence entity only to B.

### Action

A explicitly requests `entity:presence-b` in `subscription.set`.

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
- global deletion meaning.

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

- B receives `entity.deleted`;
- E is globally tombstoned/deleted;
- if A later requests a subscription that would have included E, E does not reappear.

---

## C25 — Closed JSON shape and duplicate keys

### Actions

Submit each of the following independently:

- a known P1 message with an unknown top-level/body field;
- a JSON object containing a duplicate key;
- a client-generated message ID longer than 128 UTF-8 bytes;
- a participant kind other than `human` or `agent`.

### Required result

Reject with `invalid_message` (or `unsupported_message` only when the message `type` itself is unknown).

No partial state mutation occurs.

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

No component revision or realm sequence advances.

---

## Minimum pass criterion

P1 is implementation-ready only when:

- the happy path in Prototype Profile §16 passes;
- C01–C27 pass;
- no test relies on renderer-private messages/state;
- a clean restart preserves durable world state;
- an independently implemented consumer demonstrates the same wire meaning.

Failures should be fixed in the smallest relevant protocol/profile layer rather than by adding new platform-specific side channels.
