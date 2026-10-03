# HVTP 0.2 Prototype Profile P1

Status: **Experimental implementation contract**

P1 deliberately constrains the first HVTP implementation so protocol semantics can be tested before adding richer transports, federation, scripting, physics, or engine integrations.

The prototype must answer one question:

> Can independently implemented participants share, mutate, persist, and resynchronize a spatial world through HVTP without depending on one renderer's private object model?

P1 is intentionally small, but the rules below are normative. An implementation that invents incompatible answers for sequencing, visibility, authorization, retries, or coordinate interpretation is not P1-conformant.

---

## 1. Reference topology

```text
                  HVTP/WS
                      │
              TypeScript Host
                + persistence
                      │
         ┌────────────┼────────────┐
         │            │            │
    Three.js A   Three.js B   Headless Agent
       human        human          agent
```

The first visual clients SHOULD be browser clients using Three.js for rapid iteration.

Unreal, Godot, Unity, WebXR, WebTransport, and federation are deferred until P1 passes.

---

## 2. Fixed implementation choices

P1 fixes:

- **reference language:** TypeScript;
- **transport:** WebSocket;
- **encoding:** UTF-8 JSON text frames;
- **rendering:** Three.js for the first visual reference client;
- **3D asset format:** glTF 2.0;
- **asset transport:** same-origin HTTP(S);
- **persistence:** implementation-defined, with SQLite recommended;
- **topology:** one authoritative host for one realm;
- **canonical authority:** the host for every P1 component;
- **component consistency:** authoritative only;
- **federation:** unsupported;
- **P2P:** unsupported;
- **WebTransport:** unsupported;
- **binary encoding:** unsupported;
- **CRDTs:** unsupported;
- **portable behaviours:** unsupported;
- **portable physics:** unsupported.

P1 MUST reject `component.ephemeral`. Ephemeral transport is deliberately postponed until a later profile defines its lifecycle independently from durable state.

A prototype that adds deferred features before satisfying the P1 conformance suite is missing the point. Architecture bingo remains non-normative.

---

## 3. Spatial and material conventions

P1 uses the HVTP 0.2 transform convention:

- position unit: **metres**;
- coordinate system: **right-handed**;
- +X: right;
- +Y: up;
- +Z: forward;
- quaternion encoding: **[x, y, z, w]**;
- quaternions MUST be finite and normalized within an implementation tolerance of `1e-5`;
- P1 scale components MUST be finite, greater than zero, and no greater than `1000`;
- P1 position components MUST be finite and in the inclusive range `[-1_000_000, 1_000_000]` metres.

`hvtp.material@1.baseColor` is linear-light RGBA. All four values MUST be finite and in `[0, 1]`.

For P1, a material base-color override applies to every compatible primitive in the referenced renderable and replaces that primitive's runtime base-color factor. Texture sampling is not replaced.

---

## 4. Required components

P1 requires:

- `hvtp.transform@1`;
- `hvtp.renderable@1`;
- `hvtp.material@1`;
- `hvtp.presence@1`.

Optional core components such as ownership, portable permissions, interactions, physics, and behaviours are not required for P1.

Every P1 component instance uses:

```json
{
  "revision": 4,
  "authority": "host",
  "authorityEpoch": 1,
  "consistency": "authoritative",
  "state": {}
}
```

The P1 host MUST NOT delegate canonical component authority to clients. Clients submit mutation requests; the host remains the canonical writer.

---

## 5. P1 authorization policy

P1 has no durable user-authentication system. `participantId` values are session-scoped and issued by the host.

A client-supplied `principal` in `session.hello` is informational only in P1 and MUST NOT grant permissions.

### 5.1 Read policy

All joined participants may read non-presence P1 world state that:

1. is allowed by P1's public realm policy; and
2. is selected by their effective subscription.

A participant's P1 presence entity is readable only by that same participant. P1 does not expose one participant's presence entity to other participants.

Subscription interest does not itself grant authorization. An explicit entity ID that is not readable MUST be omitted from the effective view.

### 5.2 Shared test entities

Any joined participant may:

- create a non-presence P1 entity using the allowed components/fixture asset;
- request `hvtp.transform@1` and `hvtp.material@1` mutations on a non-presence P1 entity;
- delete a non-presence P1 entity.

A P1 non-presence entity creation request MUST include exactly one `hvtp.transform@1`, one `hvtp.renderable@1`, and one `hvtp.material@1` component and MUST NOT include `hvtp.presence@1`.

This intentionally permissive collaborative policy exists only for the prototype.

`hvtp.renderable@1` is immutable after creation in P1.

### 5.3 Presence entities

After a successful realm join, the host creates one session-scoped presence entity for that participant and returns its ID in `realm.joined`.

Rules:

- only the host may create or delete a presence entity;
- only the host may create or mutate `hvtp.presence@1`;
- P1 presence transforms are static host state and are not client-mutable;
- a participant MUST NOT mutate any presence transform or binding;
- a client MUST NOT create an entity containing `hvtp.presence@1`;
- each presence entity is visible only to its bound participant;
- presence entities are not durable across host restart and do not consume the persistent realm mutation sequence.

Violation MUST return `not_authorized` or `presence_binding_violation`.

The host-created P1 presence entity has exactly these components:

```json
{
  "id": "entity:presence-8f93",
  "components": {
    "hvtp.transform@1": {
      "revision": 1,
      "authority": "host",
      "authorityEpoch": 1,
      "consistency": "authoritative",
      "state": {
        "position": [0, 0, 0],
        "rotation": [0, 0, 0, 1],
        "scale": [1, 1, 1]
      }
    },
    "hvtp.presence@1": {
      "revision": 1,
      "authority": "host",
      "authorityEpoch": 1,
      "consistency": "authoritative",
      "state": {
        "participantId": "participant:8f93",
        "kind": "human"
      }
    }
  }
}
```

The presence `kind` MUST equal the participant kind accepted during session negotiation.

Dynamic avatar/presence motion is intentionally deferred with ephemeral pose transport.

---

## 6. Required messages and direction

P1 requires these message types.

| Message | Direction | Purpose |
| --- | --- | --- |
| `session.hello` | client → host | negotiate protocol/client capabilities |
| `session.welcome` | host → client | select version, assign participant, advertise limits |
| `realm.join` | client → host | join realm with initial interest |
| `realm.joined` | host → client | confirm realm, epoch, presence, subscription and snapshot boundary |
| `realm.snapshot.begin` | host → client | begin replacement snapshot |
| `entity.snapshot` | host → client | full entity record inside snapshot |
| `realm.snapshot.end` | host → client | commit replacement snapshot |
| `entity.create` | client → host | request entity creation |
| `entity.created` | host → subscriber | canonical visible entity creation |
| `entity.delete` | client → host | request global entity deletion |
| `entity.deleted` | host → subscriber | canonical global entity deletion |
| `component.set` | client → host | request full authoritative state replacement |
| `component.patch` | client → host | request JSON Merge Patch against state |
| `component.updated` | host → subscriber | canonical full component state after mutation |
| `subscription.set` | client → host | replace active interest declaration |
| `subscription.applied` | host → client | report effective subscription and boundary |
| `view.entity.enter` | host → client | materialize full entity entering effective view |
| `view.entity.leave` | host → client | evict entity from this client's view only |
| `ack` | host → requester | terminal committed result |
| `error` | host → requester | terminal rejected result |

P1 MUST reject unsupported message types with `unsupported_message`.

Snapshot records, subscriber publications, request results, and client requests are intentionally distinct message types.

---

## 7. Realm epoch and sequence semantics

The reference realm identifier is:

```text
urn:hvtp:realm:prototype-world
```

P1 uses `seq` as a **realm mutation watermark**.

- Every accepted persistent world mutation increments the realm sequence exactly once.
- The resulting canonical subscriber messages reference that sequence.
- A single mutation may result in different subscriber-specific messages sharing the same `seq`.
- Snapshot/control messages do not consume realm sequence numbers.
- Interest filtering makes observed realm sequences sparse. Receiving sequence 100 then 103 is legal.
- Clients MUST NOT treat sequence gaps as packet loss.
- WebSocket provides ordered reliable delivery for the connection.
- After connection loss, P1 clients MUST rejoin and take a fresh snapshot; P1 defines no incremental catch-up protocol.

### 7.1 Host restart

P1 issues a new `realmEpoch` on every host process start.

Persistent entity/component state and revisions survive restart, but session participants, presence entities, request-deduplication state, subscriptions, and the previous realm sequencing domain do not.

A reconnecting client MUST negotiate a new session and take a fresh snapshot.

---

## 8. Persistence and commit boundary

For a durable mutation, the P1 host MUST:

1. validate syntax, authorization, authority epoch, and base revision;
2. compute the canonical new state;
3. durably commit the entity/component state, component revision, deletion/tombstone state where applicable, and realm mutation sequence in one persistence transaction or equivalent atomic unit;
4. only after that durable commit, send terminal `ack` and canonical subscriber publications.

An `ack` with `status: "committed"` means the operation passed the P1 durability boundary.

If persistence fails, the host MUST return `error` when possible and MUST NOT publish the mutation as canonical.

---

## 9. Snapshot-to-live handoff

When a participant joins:

1. the host resolves read authorization and the requested initial subscription;
2. the host captures the effective visible entity set at realm sequence `snapshotBaseSeq`;
3. the host sends `realm.joined`;
4. the host sends `realm.snapshot.begin`;
5. the host sends zero or more `entity.snapshot` messages containing complete visible entity state;
6. the host sends `realm.snapshot.end`;
7. while steps 4–6 are in progress, subscriber-relevant world/view changes with sequence greater than `snapshotBaseSeq` are buffered for that connection;
8. after `realm.snapshot.end`, buffered changes are flushed in increasing realm-sequence order.

Live canonical publications MUST NOT be interleaved inside the snapshot stream.

The client MUST build the snapshot as a replacement view. At `realm.snapshot.end`, it replaces its previous realm view with the completed snapshot, then applies buffered live messages.

Snapshot messages repeat the same `snapshotId`, `realmEpoch`, and `snapshotBaseSeq`.

If the connection fails before `realm.snapshot.end`, the partial snapshot MUST be discarded.

---

## 10. Interest management and view lifecycle

P1 supports:

- one optional spatial-radius selector;
- zero or more explicit entity IDs.

Selectors combine by **union** after read authorization.

- If both selectors are omitted/empty, the effective subscribed view is empty.
- Explicitly named entities remain selected regardless of distance, subject to read authorization.
- The participant's own presence entity is always included in that participant's effective view.
- Other participants' presence entities are excluded by P1 read authorization even if their IDs are explicitly requested.

P1 does not require occlusion, portals, semantic queries, region routing, or adaptive LOD.

### 10.1 Subscription replacement

`subscription.set` replaces the previous interest declaration; it is not additive.

The host:

1. captures a boundary `baseRealmSeq`;
2. computes the new authorized effective view at that boundary;
3. buffers post-boundary subscriber-relevant changes;
4. sends `subscription.applied` with a new `subscriptionId`, the effective selectors, and `baseRealmSeq`;
5. sends `view.entity.leave` for entities in the old view but not the new view;
6. sends `view.entity.enter` with complete current entity state for entities in the new view but not the old view;
7. flushes buffered post-boundary changes.

The enter/leave messages created by the replacement MAY reference `baseRealmSeq`; they do not create new realm mutations.

### 10.2 Membership changes caused by world mutation

For a canonical mutation at realm sequence N:

- entity visible before and after → send the normal canonical change such as `component.updated`;
- invisible before, visible after → send `view.entity.enter` with complete post-mutation entity state and `seq: N`;
- visible before, invisible after → send `view.entity.leave` with `seq: N`;
- invisible before and after → send nothing.

A client receiving `view.entity.leave` MUST remove the entity from its local view without creating a global tombstone.

A client receiving `view.entity.enter` MUST be able to materialize the entity using that message alone.

### 10.3 Global deletion

A globally deleted entity that was visible to a subscriber produces `entity.deleted`.

`entity.deleted` is semantically different from `view.entity.leave`.

---

## 11. Request IDs, acknowledgements, and retries

Every client request ID MUST be collision-resistant.

Within a session, the host MUST cache the terminal result of every mutating request ID until that session ends, subject to the advertised `maxRequestDedupEntries` bound. The host MUST NOT evict a cached result and later re-execute the same request ID within that session.

If the deduplication cache is full, new mutating requests MUST be rejected with `resource_limit` rather than growing memory without bound or silently dropping older deduplication records.

If the same session repeats:

- the same request ID with structurally equal parsed JSON request content (object-key ordering ignored, array ordering significant) → return the previously cached terminal result and MUST NOT execute the mutation again;
- the same request ID with different parsed request content → reject with `request_id_conflict`.

Every accepted/rejected mutating request receives `ack` or `error` directly, regardless of the requester's active subscription.

The requester MUST NOT rely on subscriber publications to learn its own operation result.

### 11.1 Lost reply / reconnect

If a connection fails after a request was sent but before its terminal result was received, the client MUST treat the operation outcome as **uncertain**.

P1 does not preserve request-deduplication state across sessions. After reconnect, the client MUST:

1. rejoin;
2. obtain a fresh snapshot;
3. resolve the intended outcome from canonical state;
4. if a new mutation is still required, submit it with a **new** request ID and current base revision.

A client MUST NOT blindly replay an old-session mutation after reconnect.

---

## 12. Resource and asset limits

The reference host advertises P1 limits in `session.welcome`.

Required default limits:

| Limit | P1 default |
| --- | ---: |
| maximum JSON message bytes | 262,144 |
| maximum serialized entity bytes | 131,072 |
| maximum entities in one snapshot | 2,048 |
| maximum spatial subscription radius | 500 m |
| maximum explicit entity IDs | 256 |
| maximum queued outbound bytes per connection | 4,194,304 |
| maximum mutation requests per participant per second | 60 |
| maximum cached mutating request results per session | 4,096 |
| maximum asset bytes | 5,242,880 |
| maximum asset URI characters | 2,048 |

The host MAY advertise smaller limits but MUST NOT silently accept values above its advertised limits.

If a realm join would require more than `maxSnapshotEntities`, the host MUST reject the join with `resource_limit` before sending a partial snapshot. If a subscription replacement would exceed that limit, the host MUST reject the request and keep the previous subscription active.

Exceeded limits return `resource_limit` when a response remains safe to send. If the outbound queue limit is exceeded, the host MAY close the connection rather than allocate unbounded memory.

### 12.1 P1 asset fixture

P1 uses one checked-in conformance asset:

```text
protocol-spec/fixtures/unit-cube.gltf
```

The reference host MUST serve it at:

```text
/assets/p1/unit-cube.gltf
```

with media type `model/gltf+json`.

For P1, `hvtp.renderable@1.asset.uri` MUST equal that same-origin path. Arbitrary remote asset URLs are intentionally not supported.

This restriction is a prototype safety/scope decision, not an HVTP core requirement.

---

## 13. Participant and renderer boundaries

Three.js types MUST NOT leak into shared protocol state.

```text
HVTP Entity
    │
    ▼
Entity Store
    │
    ▼
Three.js Adapter
    │
    ▼
THREE.Object3D
```

The same wire/entity model must remain consumable by a headless agent and by a later independently implemented renderer.

An agent participant receives structured HVTP state; it does not require screenshots or renderer-private object references.

---

## 14. P1 wire contract

All messages use the core HVTP envelope.

Client requests omit authoritative top-level `realmEpoch` and `seq`. When a mutation needs a fencing token, the last observed `authorityEpoch` appears inside the request body.

Host subscriber publications for persistent realm mutations carry top-level `realmEpoch` and `seq`.

### 14.1 Session hello

```json
{
  "hvtp": "0.2",
  "id": "req-hello-01",
  "type": "session.hello",
  "body": {
    "versions": ["0.2"],
    "client": {
      "name": "hvtp-three-client",
      "version": "0.1.0"
    },
    "participant": {
      "kind": "human"
    },
    "capabilities": {
      "components": [
        "hvtp.transform@1",
        "hvtp.renderable@1",
        "hvtp.material@1",
        "hvtp.presence@1"
      ]
    }
  }
}
```

Before `session.welcome`, the host MUST reject realm-scoped messages with `invalid_state`.

### 14.2 Session welcome

```json
{
  "hvtp": "0.2",
  "id": "res-welcome-01",
  "type": "session.welcome",
  "body": {
    "version": "0.2",
    "participantId": "participant:8f93",
    "server": {
      "name": "hvtp-reference-host",
      "version": "0.1.0"
    },
    "limits": {
      "maxMessageBytes": 262144,
      "maxEntityBytes": 131072,
      "maxSnapshotEntities": 2048,
      "maxSubscriptionRadiusMeters": 500,
      "maxExplicitEntityIds": 256,
      "maxQueuedOutboundBytes": 4194304,
      "maxMutationRequestsPerSecond": 60,
      "maxRequestDedupEntries": 4096,
      "maxAssetBytes": 5242880,
      "maxAssetUriCharacters": 2048
    }
  }
}
```

### 14.3 Realm join

```json
{
  "hvtp": "0.2",
  "id": "req-join-01",
  "type": "realm.join",
  "body": {
    "realm": "urn:hvtp:realm:prototype-world",
    "subscription": {
      "spatial": {
        "center": [0, 0, 0],
        "radius": 100
      },
      "entities": []
    }
  }
}
```

A participant may join only one P1 realm per connection. A second `realm.join` before leaving returns `invalid_state`.

### 14.4 Realm joined

```json
{
  "hvtp": "0.2",
  "id": "res-joined-01",
  "type": "realm.joined",
  "realm": "urn:hvtp:realm:prototype-world",
  "realmEpoch": "epoch-process-01",
  "body": {
    "participantId": "participant:8f93",
    "presenceEntityId": "entity:presence-8f93",
    "subscriptionId": "subscription:01",
    "effectiveSubscription": {
      "spatial": {
        "center": [0, 0, 0],
        "radius": 100
      },
      "entities": []
    },
    "snapshotId": "snapshot:01",
    "snapshotBaseSeq": 120,
    "requiredComponents": [
      "hvtp.transform@1",
      "hvtp.renderable@1",
      "hvtp.material@1",
      "hvtp.presence@1"
    ]
  }
}
```

### 14.5 Snapshot begin

```json
{
  "hvtp": "0.2",
  "id": "snapshot-begin-01",
  "type": "realm.snapshot.begin",
  "realm": "urn:hvtp:realm:prototype-world",
  "realmEpoch": "epoch-process-01",
  "body": {
    "snapshotId": "snapshot:01",
    "subscriptionId": "subscription:01",
    "snapshotBaseSeq": 120
  }
}
```

### 14.6 Entity snapshot

```json
{
  "hvtp": "0.2",
  "id": "snapshot-entity-cube",
  "type": "entity.snapshot",
  "realm": "urn:hvtp:realm:prototype-world",
  "realmEpoch": "epoch-process-01",
  "body": {
    "snapshotId": "snapshot:01",
    "entity": {
      "id": "entity:cube-01",
      "components": {
        "hvtp.transform@1": {
          "revision": 4,
          "authority": "host",
          "authorityEpoch": 1,
          "consistency": "authoritative",
          "state": {
            "position": [0, 0.5, 0],
            "rotation": [0, 0, 0, 1],
            "scale": [1, 1, 1]
          }
        },
        "hvtp.renderable@1": {
          "revision": 1,
          "authority": "host",
          "authorityEpoch": 1,
          "consistency": "authoritative",
          "state": {
            "asset": {
              "uri": "/assets/p1/unit-cube.gltf",
              "mediaType": "model/gltf+json"
            },
            "node": "UnitCube",
            "visible": true
          }
        },
        "hvtp.material@1": {
          "revision": 3,
          "authority": "host",
          "authorityEpoch": 1,
          "consistency": "authoritative",
          "state": {
            "baseColor": [1, 1, 1, 1]
          }
        }
      }
    }
  }
}
```

The illustrative snapshot above contains one shared cube plus the participant's own host-created presence entity. The presence `entity.snapshot` record uses the exact shape defined in §5.3.

### 14.7 Snapshot end

```json
{
  "hvtp": "0.2",
  "id": "snapshot-end-01",
  "type": "realm.snapshot.end",
  "realm": "urn:hvtp:realm:prototype-world",
  "realmEpoch": "epoch-process-01",
  "body": {
    "snapshotId": "snapshot:01",
    "subscriptionId": "subscription:01",
    "snapshotBaseSeq": 120,
    "entityCount": 2
  }
}
```

### 14.8 Entity creation request

```json
{
  "hvtp": "0.2",
  "id": "req-create-cube-01",
  "type": "entity.create",
  "realm": "urn:hvtp:realm:prototype-world",
  "body": {
    "entity": {
      "id": "entity:01K7CUBE000000000000001",
      "components": {
        "hvtp.transform@1": {
          "state": {
            "position": [0, 0.5, 0],
            "rotation": [0, 0, 0, 1],
            "scale": [1, 1, 1]
          }
        },
        "hvtp.renderable@1": {
          "state": {
            "asset": {
              "uri": "/assets/p1/unit-cube.gltf",
              "mediaType": "model/gltf+json"
            },
            "node": "UnitCube",
            "visible": true
          }
        },
        "hvtp.material@1": {
          "state": {
            "baseColor": [1, 1, 1, 1]
          }
        }
      }
    }
  }
}
```

A creation request MUST NOT provide canonical metadata such as `revision`, `authority`, `authorityEpoch`, or `consistency`. The host assigns it.

Entity IDs are immutable after acceptance and MUST NOT be reused after global deletion. The P1 host persists tombstones; a create request using either a live or tombstoned ID returns `entity_exists`.

### 14.9 Canonical entity creation

A subscriber for whom the new entity is visible receives:

```json
{
  "hvtp": "0.2",
  "id": "pub-created-cube-01",
  "type": "entity.created",
  "realm": "urn:hvtp:realm:prototype-world",
  "realmEpoch": "epoch-process-01",
  "seq": 121,
  "body": {
    "entity": {
      "id": "entity:01K7CUBE000000000000001",
      "components": {
        "hvtp.transform@1": {
          "revision": 1,
          "authority": "host",
          "authorityEpoch": 1,
          "consistency": "authoritative",
          "state": {
            "position": [0, 0.5, 0],
            "rotation": [0, 0, 0, 1],
            "scale": [1, 1, 1]
          }
        },
        "hvtp.renderable@1": {
          "revision": 1,
          "authority": "host",
          "authorityEpoch": 1,
          "consistency": "authoritative",
          "state": {
            "asset": {
              "uri": "/assets/p1/unit-cube.gltf",
              "mediaType": "model/gltf+json"
            },
            "node": "UnitCube",
            "visible": true
          }
        },
        "hvtp.material@1": {
          "revision": 1,
          "authority": "host",
          "authorityEpoch": 1,
          "consistency": "authoritative",
          "state": {
            "baseColor": [1, 1, 1, 1]
          }
        }
      }
    }
  }
}
```

### 14.10 Component patch request

```json
{
  "hvtp": "0.2",
  "id": "req-move-cube-01",
  "type": "component.patch",
  "realm": "urn:hvtp:realm:prototype-world",
  "body": {
    "entityId": "entity:01K7CUBE000000000000001",
    "component": "hvtp.transform@1",
    "authorityEpoch": 1,
    "baseRevision": 1,
    "patch": {
      "position": [2, 0.5, 0]
    }
  }
}
```

P1 uses RFC 7396 JSON Merge Patch against the component's `state` object.

`component.set` has the same metadata fields but replaces `patch` with a complete `state`.

### 14.11 Canonical component update

P1 subscriber publications send the complete resulting component envelope, not merely the originating patch:

```json
{
  "hvtp": "0.2",
  "id": "pub-transform-01",
  "type": "component.updated",
  "realm": "urn:hvtp:realm:prototype-world",
  "realmEpoch": "epoch-process-01",
  "seq": 122,
  "body": {
    "entityId": "entity:01K7CUBE000000000000001",
    "component": "hvtp.transform@1",
    "value": {
      "revision": 2,
      "authority": "host",
      "authorityEpoch": 1,
      "consistency": "authoritative",
      "state": {
        "position": [2, 0.5, 0],
        "rotation": [0, 0, 0, 1],
        "scale": [1, 1, 1]
      }
    }
  }
}
```

### 14.12 Entity deletion

Request:

```json
{
  "hvtp": "0.2",
  "id": "req-delete-cube-01",
  "type": "entity.delete",
  "realm": "urn:hvtp:realm:prototype-world",
  "body": {
    "entityId": "entity:01K7CUBE000000000000001"
  }
}
```

Visible subscribers receive:

```json
{
  "hvtp": "0.2",
  "id": "pub-deleted-cube-01",
  "type": "entity.deleted",
  "realm": "urn:hvtp:realm:prototype-world",
  "realmEpoch": "epoch-process-01",
  "seq": 123,
  "body": {
    "entityId": "entity:01K7CUBE000000000000001"
  }
}
```

### 14.13 Subscription replacement

```json
{
  "hvtp": "0.2",
  "id": "req-subscription-02",
  "type": "subscription.set",
  "realm": "urn:hvtp:realm:prototype-world",
  "body": {
    "spatial": {
      "center": [200, 0, 0],
      "radius": 50
    },
    "entities": ["entity:pinned-01"]
  }
}
```

Applied response:

```json
{
  "hvtp": "0.2",
  "id": "res-subscription-02",
  "type": "subscription.applied",
  "realm": "urn:hvtp:realm:prototype-world",
  "realmEpoch": "epoch-process-01",
  "body": {
    "ref": "req-subscription-02",
    "previousSubscriptionId": "subscription:01",
    "subscriptionId": "subscription:02",
    "baseRealmSeq": 130,
    "effectiveSubscription": {
      "spatial": {
        "center": [200, 0, 0],
        "radius": 50
      },
      "entities": ["entity:pinned-01"]
    }
  }
}
```

### 14.14 View enter

```json
{
  "hvtp": "0.2",
  "id": "view-enter-01",
  "type": "view.entity.enter",
  "realm": "urn:hvtp:realm:prototype-world",
  "realmEpoch": "epoch-process-01",
  "seq": 130,
  "body": {
    "subscriptionId": "subscription:02",
    "reason": "subscription",
    "entity": {
      "id": "entity:pinned-01",
      "components": {
        "hvtp.transform@1": {
          "revision": 2,
          "authority": "host",
          "authorityEpoch": 1,
          "consistency": "authoritative",
          "state": {
            "position": [200, 0.5, 0],
            "rotation": [0, 0, 0, 1],
            "scale": [1, 1, 1]
          }
        },
        "hvtp.renderable@1": {
          "revision": 1,
          "authority": "host",
          "authorityEpoch": 1,
          "consistency": "authoritative",
          "state": {
            "asset": {
              "uri": "/assets/p1/unit-cube.gltf",
              "mediaType": "model/gltf+json"
            },
            "node": "UnitCube",
            "visible": true
          }
        },
        "hvtp.material@1": {
          "revision": 1,
          "authority": "host",
          "authorityEpoch": 1,
          "consistency": "authoritative",
          "state": {
            "baseColor": [0.25, 0.5, 0.75, 1]
          }
        }
      }
    }
  }
}
```

The `entity` field is complete current authorized state; a client MUST NOT need unseen historical patches to materialize it.

### 14.15 View leave

```json
{
  "hvtp": "0.2",
  "id": "view-leave-01",
  "type": "view.entity.leave",
  "realm": "urn:hvtp:realm:prototype-world",
  "realmEpoch": "epoch-process-01",
  "seq": 130,
  "body": {
    "subscriptionId": "subscription:02",
    "reason": "subscription",
    "entityId": "entity:no-longer-visible"
  }
}
```

Allowed reasons are `subscription`, `interest`, and `authorization`.

### 14.16 Terminal acknowledgement

```json
{
  "hvtp": "0.2",
  "id": "res-ack-move-01",
  "type": "ack",
  "realm": "urn:hvtp:realm:prototype-world",
  "realmEpoch": "epoch-process-01",
  "body": {
    "ref": "req-move-cube-01",
    "status": "committed",
    "seq": 122,
    "entityId": "entity:01K7CUBE000000000000001",
    "component": "hvtp.transform@1",
    "revision": 2,
    "authorityEpoch": 1
  }
}
```

The host sends this acknowledgement directly to the requester even if the resulting entity is outside the requester's effective view.

### 14.17 Terminal error

```json
{
  "hvtp": "0.2",
  "id": "res-error-stale-01",
  "type": "error",
  "realm": "urn:hvtp:realm:prototype-world",
  "realmEpoch": "epoch-process-01",
  "body": {
    "ref": "req-move-cube-01",
    "code": "stale_revision",
    "message": "Component revision is no longer current.",
    "entityId": "entity:01K7CUBE000000000000001",
    "component": "hvtp.transform@1",
    "currentRevision": 2,
    "authorityEpoch": 1
  }
}
```

P1 error codes MUST include:

- `unsupported_version`;
- `unsupported_component`;
- `unsupported_message`;
- `realm_not_found`;
- `invalid_state`;
- `invalid_message`;
- `invalid_component_state`;
- `not_authorized`;
- `presence_binding_violation`;
- `stale_revision`;
- `stale_authority_epoch`;
- `entity_exists`;
- `entity_not_found`;
- `request_id_conflict`;
- `resource_limit`.

Clients MUST NOT need to parse human-readable error text.

---

## 15. Rendering rules

### Transform

The Three.js adapter converts the HVTP transform convention explicitly. The protocol model remains independent from Three.js camera conventions.

### Renderable

P1 clients:

- support the P1 unit-cube glTF fixture;
- instantiate the referenced scene/node;
- validate media type and advertised asset limits;
- display a local non-network placeholder if fixture loading fails.

The placeholder is a client error presentation and MUST NOT mutate shared HVTP state.

### Material

P1 clients apply `hvtp.material@1.baseColor` using the P1 linear RGBA semantics defined above.

---

## 16. Conformance and acceptance

P1 succeeds only when both the happy-path demonstration and the adversarial conformance cases in [p1-conformance.md](./p1-conformance.md) pass.

The happy path is:

1. start a clean host;
2. connect browser A and browser B;
3. both negotiate HVTP 0.2 and join with overlapping spatial subscriptions;
4. A creates a renderable P1 unit cube;
5. B materializes it without reload;
6. A moves it;
7. B receives canonical transform state;
8. B changes its base color;
9. A receives canonical material state;
10. stop and restart the host;
11. reconnect both clients and take fresh snapshots;
12. the cube reappears with the last durable transform/material revisions;
13. connect a headless agent participant;
14. the agent explicitly subscribes to the cube and reads structured component state;
15. the agent requests an allowed material/transform mutation;
16. both browser clients observe the accepted canonical result.

No renderer-specific private channel may be used.

---

## 17. Interoperability milestone

After P1 passes, the next significant milestone is a **second independently implemented consumer**, not more protocol features.

Examples:

- minimal Godot client;
- Unreal bridge;
- Python/headless renderer;
- deliberately separate TypeScript consumer that shares schemas/wire definitions but not renderer implementation code.

The proof is:

> The same persisted realm and fixture state has the same meaning outside the original Three.js renderer.

---

## 18. Deferred experiments

Consciously deferred:

- WebTransport;
- CBOR/MessagePack;
- ephemeral pose transport;
- authority delegation/handoff;
- WASM/Lua behaviours;
- portable physics;
- voice/media;
- federated identity;
- realm transfer;
- region migration;
- peer hosting;
- arbitrary remote assets;
- content-addressed asset stores;
- CRDT collaborative editing;
- incremental reconnect/catch-up;
- persistent cross-session request deduplication;
- application-specific land, government, economy, or civic systems.

---

## 19. Suggested repository evolution

```text
/protocol-spec
  hvtp.md
  prototype-profile.md
  p1-conformance.md
  /fixtures
    unit-cube.gltf

/packages                 # future
  protocol-types
  reference-host
  three-client
  agent-client

/examples                 # future
/docs                     # future RFCs
```

This layout is informative rather than normative.
