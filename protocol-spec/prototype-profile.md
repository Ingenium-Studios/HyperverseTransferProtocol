# HVTP 0.2 Prototype Profile P1

Status: **Experimental implementation contract**

This profile deliberately constrains the first HVTP implementation so the team can test protocol semantics quickly without prematurely solving every transport, engine, federation, or scripting problem.

The prototype is intended to answer one question:

> Can independently connected participants share and persist a spatial world through HVTP without depending on one rendering engine?

---

## 1. Reference topology

The initial topology is:

```text
                  HVTP/WS
                      │
              TypeScript Host
                + persistence
                      │
         ┌────────────┼────────────┐
         │            │            │
    Three.js A   Three.js B   Headless Agent
       human        human       / agent later
```

The first visual clients SHOULD be browser clients using Three.js for fast iteration.

Unreal, Godot, Unity, WebXR, and other bridges are explicitly deferred until the protocol has survived this reference implementation.

---

## 2. Required implementation choices

P1 fixes the following choices:

- **Language:** TypeScript for reference host and browser client;
- **Transport:** WebSocket;
- **Encoding:** JSON text frames;
- **Rendering:** Three.js;
- **Asset retrieval:** HTTP(S);
- **3D asset format:** glTF 2.0 / GLB;
- **Persistence:** implementation-defined, with SQLite recommended for the reference host;
- **Topology:** one authoritative host for one realm;
- **Physics:** not required;
- **Behaviour runtime:** not required;
- **Federation:** not required;
- **WebTransport:** not required;
- **P2P:** not required;
- **binary encoding:** not required;
- **CRDTs:** not required.

A prototype that adds those features before satisfying the acceptance test is noncompliant with the spirit of P1. The point is to validate the model, not win architecture bingo.

---

## 3. Required components

P1 requires support for:

- `hvtp.transform@1`;
- `hvtp.renderable@1`;
- `hvtp.material@1`;
- `hvtp.presence@1`.

Optional for P1:

- `hvtp.ownership@1`;
- `hvtp.permissions@1`;
- `hvtp.interaction@1`.

Unsupported components MUST be ignored safely unless the realm declares them required.

---

## 4. Required messages

A P1 implementation must support the following message types:

### Session

- `session.hello`
- `session.welcome`

### Realm

- `realm.join`
- `realm.joined`
- `realm.snapshot.begin`
- `realm.snapshot.end`

### Entity

- `entity.snapshot`
- `entity.create`
- `entity.delete`

### Components

- `component.set`
- `component.patch`
- `component.ephemeral`

### Subscription

- `subscription.set`

### Generic responses

- `ack`
- `error`

The exact JSON Schemas are intentionally deferred until the first implementation pass reveals whether the envelope is ergonomically sound.

---

## 5. Prototype realm

The reference host exposes exactly one realm.

Suggested development identity:

```text
urn:hvtp:realm:prototype-world
```

This identifier is only a concrete test realm for the first implementation and has no special protocol semantics.

The host is authoritative for:

- entity lifecycle;
- persistence;
- canonical component revisions;
- presence lifecycle;
- subscription filtering.

A connected participant may be delegated transform authority for its own presence entity.

---

## 6. Persistence requirements

The reference realm must survive host restart.

At minimum, the host persists:

- entity IDs;
- component state;
- component revisions;
- entity deletion/tombstone state as needed to prevent stale resurrection.

Presence entities may be ephemeral and need not survive restart.

The persistence layer is not exposed as part of the protocol.

SQLite is recommended because it is operationally trivial, inspectable, and sufficient for this experiment.

---

## 7. Interest management

P1 supports two subscription forms.

### 7.1 Explicit entity subscription

A participant may subscribe to named entity IDs.

### 7.2 Spatial-radius subscription

A participant may subscribe around a center point and radius.

Example conceptual request:

```json
{
  "type": "subscription.set",
  "body": {
    "spatial": {
      "center": [0, 0, 0],
      "radius": 100
    }
  }
}
```

The host decides which entities intersect the subscription.

P1 does not require occlusion, portals, semantic queries, region-aware routing, or adaptive LOD.

---

## 8. Three.js adapter boundary

The browser client must keep HVTP state separate from Three.js objects.

Recommended boundary:

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

Three.js-specific types MUST NOT leak into shared protocol packages.

The same entity store and wire types should remain usable by a future Unreal bridge, headless agent, test harness, or alternative renderer.

---

## 9. Participant and presence model

P1 must support at least:

- `human`;
- `agent`.

A participant may connect without immediately having a presence entity.

When a spatial presence is created, it uses `hvtp.presence@1` to reference the session participant.

This allows an external agent adapter to connect as an agent participant while keeping its reasoning, memory, objectives, tools, and orchestration outside the realm.

The world sees the projection, not the whole system.

---

## 10. Mutation flow

For authoritative components, P1 follows this flow:

1. client receives component revision N;
2. client sends `component.set` or `component.patch` with `baseRevision: N`;
3. host validates authority and revision;
4. host accepts or rejects;
5. on success, host persists revision N+1;
6. host broadcasts canonical revision N+1 to relevant subscribers;
7. sender reconciles local state to the canonical result.

Clients may render optimistic local movement, but only host-accepted state is canonical.

---

## 11. Minimal P1 wire contract

P1 intentionally avoids a full JSON Schema package until the first implementation validates the message ergonomics, but independent implementations still need a concrete common shape.

All messages use the core envelope. Client requests omit authoritative `realmEpoch` and `seq` unless explicitly echoing a fencing token inside the body. Host-published canonical realm messages carry `realmEpoch` and `seq`.

### 11.1 Welcome

```json
{
  "hvtp": "0.2",
  "id": "msg-welcome",
  "type": "session.welcome",
  "body": {
    "version": "0.2",
    "participantId": "participant:8f93",
    "server": {
      "name": "hvtp-reference-host",
      "version": "0.1.0"
    }
  }
}
```

### 11.2 Join and snapshot boundary

Client:

```json
{
  "hvtp": "0.2",
  "id": "msg-join",
  "type": "realm.join",
  "body": {
    "realm": "urn:hvtp:realm:prototype-world"
  }
}
```

Host:

```json
{
  "hvtp": "0.2",
  "id": "msg-joined",
  "type": "realm.joined",
  "realm": "urn:hvtp:realm:prototype-world",
  "realmEpoch": "epoch-01",
  "body": {
    "snapshotBaseSeq": 120,
    "requiredComponents": []
  }
}
```

The host then emits `realm.snapshot.begin`, zero or more `entity.snapshot` messages, and `realm.snapshot.end`. The snapshot end message repeats the covered sequence boundary.

### 11.3 Entity snapshot

```json
{
  "hvtp": "0.2",
  "id": "msg-entity-snapshot",
  "type": "entity.snapshot",
  "realm": "urn:hvtp:realm:prototype-world",
  "realmEpoch": "epoch-01",
  "body": {
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
        }
      }
    }
  }
}
```

### 11.4 Entity creation

A P1 client generates a globally unique entity ID and submits initial component state.

```json
{
  "hvtp": "0.2",
  "id": "msg-create-cube",
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

The host assigns canonical component metadata, persists the entity, and publishes canonical `entity.create` to interested subscribers.

Entity IDs are immutable after acceptance. A duplicate ID with incompatible state MUST be rejected.

### 11.5 Authoritative component mutation

Client request:

```json
{
  "hvtp": "0.2",
  "id": "msg-move-cube",
  "type": "component.patch",
  "realm": "urn:hvtp:realm:prototype-world",
  "body": {
    "entityId": "entity:01K7CUBE000000000000001",
    "component": "hvtp.transform@1",
    "authorityEpoch": 1,
    "baseRevision": 4,
    "patch": {
      "position": [2, 0.5, 0]
    }
  }
}
```

Canonical host publication:

```json
{
  "hvtp": "0.2",
  "id": "msg-move-cube",
  "type": "component.patch",
  "realm": "urn:hvtp:realm:prototype-world",
  "realmEpoch": "epoch-01",
  "seq": 121,
  "body": {
    "entityId": "entity:01K7CUBE000000000000001",
    "component": "hvtp.transform@1",
    "authorityEpoch": 1,
    "baseRevision": 4,
    "revision": 5,
    "patch": {
      "position": [2, 0.5, 0]
    }
  }
}
```

The same message ID allows the originating client to correlate its optimistic request with canonical publication.

### 11.6 Ephemeral component update

```json
{
  "hvtp": "0.2",
  "id": "msg-pose-202",
  "type": "component.ephemeral",
  "realm": "urn:hvtp:realm:prototype-world",
  "body": {
    "entityId": "entity:presence-01",
    "component": "hvtp.transform@1",
    "authorityEpoch": 3,
    "localSeq": 202,
    "state": {
      "position": [3.1, 0, 8.2],
      "rotation": [0, 0.707, 0, 0.707]
    }
  }
}
```

The host may relay, clamp, reject, or periodically canonicalize ephemeral state according to authority policy.

### 11.7 Subscription

```json
{
  "hvtp": "0.2",
  "id": "msg-subscribe",
  "type": "subscription.set",
  "realm": "urn:hvtp:realm:prototype-world",
  "body": {
    "spatial": {
      "center": [0, 0, 0],
      "radius": 100
    },
    "entities": []
  }
}
```

### 11.8 Acknowledgement and error

`ack` correlates to the originating message and may include the canonical sequence.

```json
{
  "hvtp": "0.2",
  "id": "msg-ack",
  "type": "ack",
  "body": {
    "ref": "msg-move-cube",
    "seq": 121
  }
}
```

Rejected operations use `error`.

```json
{
  "hvtp": "0.2",
  "id": "msg-error",
  "type": "error",
  "body": {
    "ref": "msg-move-cube",
    "code": "stale_revision",
    "message": "Component revision is no longer current.",
    "currentRevision": 5,
    "authorityEpoch": 1
  }
}
```

P1 error codes should include at least:

- `unsupported_version`;
- `unsupported_component`;
- `realm_not_found`;
- `not_authorized`;
- `not_authority`;
- `stale_revision`;
- `stale_authority_epoch`;
- `entity_exists`;
- `entity_not_found`;
- `invalid_message`.

The reference implementation SHOULD keep errors machine-actionable and MUST NOT require clients to parse human-readable error text.

---

## 12. Initial rendering rules

P1 keeps rendering deliberately narrow.

### Transform

Map `hvtp.transform@1` to Three.js position, quaternion, and scale.

### Renderable

For `hvtp.renderable@1`:

- resolve HTTP(S) assets;
- support GLB/glTF;
- instantiate the referenced scene/node;
- use a placeholder mesh if loading fails.

### Material

For `hvtp.material@1`, support at least a base-color override on compatible renderables.

The material component exists partly to prove that an entity may carry mutable visual state independently from its source glTF asset.

---

## 13. Acceptance test

P1 is successful only when the following sequence works against a clean reference realm.

1. Start the HVTP host.
2. Open browser client A.
3. Open browser client B.
4. Both negotiate HVTP 0.2 and join the same realm.
5. A creates a cube entity.
6. B observes the cube without page reload.
7. A moves the cube.
8. B observes the canonical transform update.
9. B changes the cube material/base color.
10. A observes the canonical material update.
11. Close both clients.
12. Restart the host process.
13. Reopen A and B.
14. The same cube reappears with its last canonical transform and material state.
15. Connect a headless `agent` participant.
16. The agent subscribes to the cube and reads its structured component state.
17. The agent requests a permitted mutation.
18. Both browser clients observe the accepted change.

No renderer-specific private channel may be used to satisfy the test.

---

## 14. Interoperability milestone

After P1 passes, the next significant milestone is **not more features**.

It is a second independently implemented consumer of the protocol.

Examples:

- a minimal Godot client;
- an Unreal bridge;
- a Python/headless renderer;
- a deliberately separate TypeScript client that shares wire schemas but not renderer code.

The important proof is:

> The same realm state remains intelligible and interactive outside the original Three.js implementation.

Only after that milestone should the project consider the protocol model substantially validated.

---

## 15. Deferred experiments

The following are consciously postponed:

- WebTransport;
- CBOR/MessagePack;
- WASM behaviours;
- Lua behaviours;
- portable physics;
- voice/media;
- federated identity;
- realm transfer;
- region migration;
- peer hosting;
- content-addressed asset stores;
- CRDT collaborative editing;
- persistent event/audit replay;
- application-specific land, government, economy, or civic systems.

Each may become an RFC or later profile after P1 succeeds.

---

## 16. Suggested repository evolution

Once implementation begins, a reasonable layout is:

```text
/protocol-spec
  hvtp.md
  prototype-profile.md

/packages
  protocol-types
  reference-host
  three-client
  agent-client

/examples
  prototype-world

/docs
  rfcs
```

This layout is informative rather than normative.
