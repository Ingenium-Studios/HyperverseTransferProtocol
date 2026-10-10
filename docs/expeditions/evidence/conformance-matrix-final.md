# HVTP P1 Reference Conformance Matrix (final)

Integration head: branch `integration/p1-reference-candidate`, commit `7bf1613`.
Suite run on this head: `npm test` = **314 tests, 314 pass, 0 fail** (protocol-types 13, reference-host 114, client-core 83, three-client 32, agent-client 64, p1-acceptance 8).
Normative sources: `protocol-spec/p1-conformance.md` (C01-C37), `protocol-spec/prototype-profile.md` section 16.
Method: every cited test body was read; status is judged from assertions, not names. All paths are repo-relative. Evidence is `path:line` of the `test(...)` call followed by the exact test name; where a test is generated in a loop, the loop variants are noted.

## 0. Legend and scoring

* `pass`: every normative sub-assertion has direct passing evidence.
* `pass-with-documented-adaptation`: all assertions evidenced except where the spec text cannot be literally constructed or has an ambiguity the test documents; the adaptation is stated.
* `incomplete`: at least one normative sub-assertion has no direct evidence. The missing assertion and the owning package are named. Severity: `trivial` (cheap assertion on an existing test, very unlikely bug), `minor` (new small test), `material` (core behaviour unproven).
* `n/a`: independent-consumer gate (C23, C37).

Component shorthand: `RH` reference-host; `CC` client-core; `3C` three-client; `AG` agent-client; `ACC` p1-acceptance; `PT` protocol-types.
Test-file shorthand used below (all under `packages/`):

* `RH/conf-life` = `reference-host/src/conformance-lifecycle.test.ts`, `RH/conf-pres` = `.../conformance-presence.test.ts`, `RH/conf-shape` = `.../conformance-shape.test.ts`, `RH/conf-spat` = `.../conformance-spatial.test.ts`, `RH/conf-val` = `.../conformance-validation.test.ts`
* `RH/mut` = `reference-host/src/mutation.test.ts`, `RH/view` = `.../view-lifecycle.test.ts`, `RH/store` = `.../world-store.test.ts`, `RH/trans` = `.../transport.test.ts`, `RH/rate` = `.../rate-limit.test.ts`, `RH/limits` = `.../limits.test.ts`, `RH/out` = `.../outbound.test.ts`, `RH/coord` = `.../realm-coordinator.test.ts`, `RH/server` = `.../server.test.ts`
* `CC/client` = `client-core/src/client.test.ts`, `CC/int` = `client-core/src/host-integration.test.ts`, `CC/assets` = `client-core/src/assets.test.ts`
* `3C/adapter` = `three-client/src/three-adapter.test.ts`
* `AG/int` = `agent-client/src/host-integration.test.ts`, `AG/run` = `agent-client/src/run.test.ts`, `AG/state` = `agent-client/src/entity-state.test.ts`
* `ACC/happy` = `p1-acceptance/src/happy-path.test.ts`, `ACC/cross` = `p1-acceptance/src/cross-component.test.ts`
* `PT/val` = `protocol-types/src/validation.test.ts`

## 1. Headline

| Result | Count | Cases |
| --- | --- | --- |
| `pass` | 31 | C01, C02, C03, C04, C05, C06, C07, C08, C09, C11, C12, C13, C14, C16, C17, C18, C19, C20, C22, C24, C26, C27, C28, C29, C30, C31, C32, C33, C34, C35, C36 |
| `pass-with-documented-adaptation` | 4 | C10 (Variant A burst), C15 (state-dependent code and abbreviated payload), C21 (entity-serialization limit unreachable for valid P1 entities — arithmetic bound), C25 (host-direction message types) |
| `incomplete` | 0 | — (the five items found at `7bf1613` were closed; see Closure addendum) |
| `n/a` independent-consumer gate | 2 | C23, C37 |
| Total | 37 | 35 reference-applicable + 2 gate |

Compared with the baseline inventory (14 covered, 19 partial, 2 gap): the five new conformance files plus the client-core, three-client, agent-client and acceptance additions closed C02, C03, C14, C15, C16, C17, C18, C20, C24, C25, C26, C27, C29, C32, C34, C35 and most of C10/C19/C21; C08/C30/C28/C12 now have real-host client evidence. No `material` gaps remain.

## 2. Summary table

| ID | Title | Final status | Gap / adaptation (one line) |
| --- | --- | --- | --- |
| C01 | Happy-path shared persistent entity | pass | none |
| C02 | Concurrent revision conflict | pass | none |
| C03 | Authority epoch exact match | pass | none |
| C04 | Entity enters spatial interest | pass | none |
| C05 | Leave and re-enter | pass | hardening nit only: host `isTombstoned` not asserted after an interest leave (client side asserted) |
| C06 | Explicit subscription overrides distance (union) | pass | closed at `d41cd38` — see Closure addendum |
| C07 | Replacement is a view operation | pass | none |
| C08 | Snapshot mutation boundary | pass | none |
| C09 | Sparse realm sequences | pass | closed at `d41cd38` — see Closure addendum |
| C10 | Duplicate request, same content | pass-with-documented-adaptation | Variant A for durable mutations is a back-to-back burst, because host mutation execution is synchronous |
| C11 | Duplicate ID, different content | pass | pending variant exercised on `subscription.set` only (same reason as C10) |
| C12 | Lost reply across reconnect | pass | none |
| C13 | Mutation outside requester's view | pass | none |
| C14 | Presence impersonation rejected | pass | none |
| C15 | Ephemeral traffic rejected | pass-with-documented-adaptation | `invalid_state` before JOINED; abbreviated no-id example is `invalid_message` |
| C16 | Renderable fixture explicit | pass | none |
| C17 | Transform validation and interpretation | pass | none |
| C18 | Material interpretation | pass | none |
| C19 | Durable commit failure | pass | closed at `d41cd38` — see Closure addendum |
| C20 | Restart invalidates session state | pass | none |
| C21 | Resource limits | pass-with-documented-adaptation | closed at `d41cd38` — see Closure addendum |
| C22 | Read authorization precedes interest | pass | none |
| C23 | Second consumer interprets same fixture | n/a, independent-consumer gate | |
| C24 | Global deletion vs view eviction | pass | none |
| C25 | Closed JSON shape and duplicate keys | pass-with-documented-adaptation | host-direction types answer `unsupported_message`; test accepts either code |
| C26 | Merge Patch cannot delete required state | pass | none |
| C27 | Immutable renderable and presence | pass | none |
| C28 | Overlapping replacements serialize | pass | none |
| C29 | Spatial membership predicate | pass | none |
| C30 | Snapshot metadata and mutation kinds | pass | closed at `d41cd38` — see Closure addendum |
| C31 | Request-table admission and subscription retries | pass | none |
| C32 | Revision/epoch domains, precedence, no-op, overflow | pass | none |
| C33 | UTF-8, JSON syntax, shape, uncorrelated errors | pass | none |
| C34 | Asset base resolution; load failure renderer-local | pass | none |
| C35 | Creation/deletion publication precedence | pass | none |
| C36 | Live-view overflow explicit | pass | none |
| C37 | Independent transform/lifecycle trace | n/a, independent-consumer gate | |

## 3. Per-case detail

Format: requirement; components; evidence; sub-assertions not evidenced; status.

### C01 Happy-path shared persistent entity
* Requirement: A creates cube, A patches transform, B patches material, host restarts; exactly one `entity.created` for B with no `view.entity.enter`; seq advances once per mutation; one component revision each; component isolation; full envelopes; durable state after restart; new `realmEpoch`.
* Components: RH, CC, 3C, ACC.
* Evidence:
  * ack + exactly one `entity.created` on the subscriber's active subscription, no enter: `RH/conf-life:18` "C35 creation visible to A and invisible to B: A gets exactly one entity.created on its active subscription, B gets nothing"; real host to real client: `ACC/cross:41` (loop, `create` variant) "C08/C30 real host: a create committed after the snapshot cut is applied exactly once after snapshot end" (event list is exactly `created:...`); client side `CC/client:197` "entity.created adds complete state without a separate view.entity.enter".
  * full materializable entity to B, patch actions, per-mutation seq/revision: `CC/int:57` "two real clients share create, move, and recolor through the reference host (happy path 1-9)" (transform patch to rev 2, material set to rev 2, A deep-equals B, renderable rev 1); `RH/conf-val:343` "C02 concurrent updates to different components both commit and each advances only its own revision" (patch transform + patch material: revisions [2,2,1], seq +1 each, states isolated); `RH/mut:137` "valid JSON Merge Patch preserves omitted required state and presence remains private" (full resulting envelope in `component.updated`); `RH/mut:16` (seq 4 after create + 3 sets; retry does not advance).
  * end-to-end: `ACC/happy:22` "Prototype Profile section 16 happy path: steps 1-16 against a real host, two Three.js browsers, and a separate-process agent" (create ack, B sees full entity, move, recolor, `durableSeq === 3`, material revision still 1 after the move at step 7, transform position unchanged after the recolor at step 9, restart, new epoch at `:110`, revisions {2,2} and states restored at steps 11-12).
  * restart: `CC/int:147`, `RH/server:165`, `ACC/happy:22` steps 10-12.
* Not evidenced: none.
* Status: **pass**.

### C02 Concurrent revision conflict
* Requirement: two patches at the same base commit once, loser gets `revision_mismatch` with `currentRevision` 6 and epoch; base ahead also `revision_mismatch`; negative/fractional/string/>2^53-1 is `invalid_message`; different components both commit; update vs delete serializes without resurrection.
* Components: RH.
* Evidence: `RH/conf-val:317` "C02 patch race at material revision 5: exactly one commits revision 6, the loser gets revision_mismatch with currentRevision 6"; `RH/conf-val:276` "C02/C03/C32 invalid revision and epoch metadata is invalid_message and precedes every equality check" (rev 4, 6, 2^53-1 mismatch; 12 invalid literals including 0, -0, -1, 1.5, "5", 2^53, 1e400, null, true, [5], {}; for both set and patch); `RH/conf-val:343` (different components, seq +1 each, revisions [2,2,1]); `RH/conf-val:372` "C02 an update after a committed deletion is entity_not_found and cannot resurrect; update then delete both commit"; `RH/conf-val:403` "C02 concurrent update and delete serialize in one of the two legal orders"; `RH/mut:108` "two WebSocket clients racing the same revision produce one commit and one revision conflict"; `RH/mut:79` (base ahead).
* Not evidenced: none.
* Status: **pass**.

### C03 Authority epoch must match exactly
* Components: RH.
* Evidence: `RH/mut:320` "component mutation matches authority epoch, accepts no-op once, and deletion has global precedence" (epoch 2 gives `authority_epoch_mismatch`); `RH/conf-val:276` (epoch 2 and 2^53-1 give `authority_epoch_mismatch` carrying `authorityEpoch: 1`; invalid epoch literals, and invalid epoch combined with correct revision 5 and with revision 99, give `invalid_message`, proving domain validation precedes equality).
* Not evidenced: none.
* Status: **pass**.

### C04 Entity enters spatial interest
* Components: RH, CC, 3C, ACC.
* Evidence: `RH/mut:16` "real WebSocket mutations deduplicate, publish visibility transitions, and preserve sequence" (first message after the mutation is `view.entity.enter`, not a patch; enter carries entity id and transform rev 2, position [5,0,0], active `subscriptionId`); `RH/mut:403` "ordered publications keep leave N before enter N+1 across delayed enqueue" (enter at the mutation's seq 3, revision 3); `RH/conf-spat:54` "C29 the live publication path uses the same inclusive boundary" (enter on crossing); `ACC/cross:41` (`interest` variant): a real host `view.entity.enter` for an entity the client never held is materialized by the real client and the final client entity equals the host store record for record (complete state, all three components, no history request); `CC/client:230`; `3C/adapter:152`.
* Not evidenced: none material (the enter `reason: "interest"` string is not asserted at host level; not required by the case text).
* Status: **pass**.

### C05 Leave and re-enter
* Components: RH, CC, 3C, ACC.
* Evidence: leave then enter with full current state: `RH/mut:403` (observer receives `[leave, seq 2], [enter, seq 3]`, enter carries rev 3); delayed-enqueue barrier at seq 2 while the later mutation at seq 3 is acked: same test (no overtaking); client removes and rebuilds without stale state, no tombstone: `CC/client:230` "view.entity.leave evicts without a tombstone and view.entity.enter rematerializes from the message alone" (causes `leave, enter, enter`; nothing merged from earlier incarnation), `CC/client:245`, `3C/adapter:152` and `3C/adapter:186` (new Object3D, colour from enter only, 25 leave/re-enter cycles), `ACC/cross:238` "Three on a real host: subscription leave removes the object without a tombstone, re-enter rebuilds from full state, global delete removes it" (re-entered entity accepts a mutation).
* Not evidenced (hardening nit, does not change status): host-side `isTombstoned(E) === false` after an interest leave (it is asserted for subscription-replacement leave at `RH/view:97`); the delayed leave/enter pair is not replayed through a real client.
* Status: **pass**.

### C06 Explicit subscription overrides distance (union)
* Components: RH.
* Evidence (partial): store-level union `RH/store:108` "snapshot applies P1 spatial and explicit-entity union semantics" (radius 100 with far entity at 1000 included); empty view: `RH/store:108` (`snapshot({})` empty), `RH/server:52` "reference host enqueues the initial presence snapshot in protocol order" (join with empty selector yields only own presence), `RH/view:246` (join `{}` has exactly one `entity.snapshot`, the own presence); read-authorization gate: `RH/view:246` "C22 replacement interest never reveals another participant's private presence"; selector echo: `RH/conf-shape:206`.
* Not evidenced:
  1. Wire-level (join and `subscription.set`) with `{spatial: radius 25, entities: ["far"]}` and the far entity at X=1000: the snapshot/enter must include it. Currently only the store function is tested with a radius of 100 (join path shares `snapshot()` but is indirect).
  2. Union in the live projection: a pinned far entity that moves keeps receiving `component.updated` and never `view.entity.leave`; a spatial-only entity moved away does leave.
* Owner: reference-host (`conformance-spatial.test.ts`).
* Status at `7bf1613`: **incomplete (minor)** — closed at `d41cd38` (see Closure addendum).

### C07 Subscription replacement is a view operation, not world deletion
* Components: RH, CC, ACC.
* Evidence: `RH/view:97` "C07/C24 replacement evicts without deletion and later global deletion reaches only visible subscribers" (applied first with new id and `baseRealmSeq`, then leave reason `subscription`, entity live, not tombstoned, seq unchanged, other subscriber unaffected); `RH/view:123` (leave before enter); `RH/view:155`; `RH/view:178`; `RH/view:392` "C07 replacement sends every leave before every enter at one unchanged realm sequence"; client: `CC/client:316`, `CC/int:126`, `ACC/cross:115`, `ACC/cross:238`.
* Not evidenced: none.
* Status: **pass**.

### C08 Snapshot mutation boundary
* Components: RH, CC, ACC.
* Evidence: `RH/view:197` (loop: update, create, delete, interest) "C08/C30 snapshot cut buffers <kind> exactly once after complete metadata batch" (nothing interleaved while the snapshot is held, snapshot represents state through base seq, post-cut change buffered, delivered after `realm.snapshot.end` with the right kind and seq, once); end to end with a real client: `ACC/cross:41` (loop of 4 kinds) asserts the snapshot content equals state at the cut, the post-cut change is applied exactly once with the correct cause after snapshot end, and the final client state deep-equals the host store record for record, with no `protocol.violation`/`publication.stale`; partial snapshot discarded on socket close: `CC/client:149` "a partial snapshot never activates when the connection fails before end", `CC/client:161`, `RH/coord:59` "coordinator unsubscribe cancels a blocked snapshot without waiting for its barrier", `RH/out:216`.
* Not evidenced: none.
* Status: **pass**.

### C09 Sparse realm sequences are legal
* Components: RH, CC.
* Evidence: `RH/mut:360` "subscriber sequence gaps are sparse and legal" (hidden seq 3 skipped, observer receives seq 4); `CC/client:305` "sparse canonical sequences are accepted and never treated as loss" (100, 103, 9000; phase stays `live`; all applied); `CC/client:316` (equal seq is not a dedup key).
* Not evidenced: that the client sends no resync/join frame and emits no extra `view.reset` on a gap (`CC/client:305` asserts only `phase === "live"` and the applied state, not `h.socket.sent` or the event list). Add `assert.deepEqual(h.socket.sent.map(m => m.type), ["session.hello","realm.join"])` and a `view.reset` count. Owner: client-core.
* Status at `7bf1613`: **incomplete (trivial)** — closed at `d41cd38` (see Closure addendum).

### C10 Duplicate request, same content
* Components: RH.
* Evidence, Variant A: `RH/view:123` "C28/C31 overlapping generations serialize; pending and historical retries do not replay batches" (a `subscription.set` resent byte-identically while genuinely pending at the transition barrier: one logical operation, no pending-capacity consumption, one applied/leave pair, same eventual terminal result); `RH/view:312` "C31 pending-operation admission is bounded, duplicate lookup precedes pending capacity"; `RH/conf-life:156` "C10 Variant A: two structurally equal frames written back-to-back are one logical operation" (durable mutation, second frame has reordered keys: identical terminal result, one execution, one seq advance, one publication; conflicting same-id frame gives `request_id_conflict` without a second mutation).
* Evidence, Variant B: `RH/mut:16` (reordered-key retry equals the original ack, seq and observer unchanged); `RH/conf-life:128` "C10 Variant B: cached retry of create, delete and view-changing updates rebroadcasts no historical publication" (retry of create, enter-producing, update, leave-producing and delete: acks identical, seq unchanged, observer receives nothing; original publications were `entity.created, view.entity.enter, component.updated, view.entity.leave, entity.deleted`); cached terminal error: `RH/conf-life:80` "C10 Variant B: a cached terminal error is replayed identically and is not reprocessed, even after the world would give a different answer" (`revision_mismatch`, `entity_not_found`, `invalid_component_state`, replayed after the world changed so reprocessing would give a different result; reordered-key variant; no publication, no seq change); `RH/view:266` (cached `resource_limit` for `subscription.set`).
* Adaptation: host mutation execution is fully synchronous within one message dispatch, so a durable mutation is never "admitted but not yet terminal"; Variant A for `entity.*`/`component.*` is exercised as a back-to-back burst (documented in the comment at `RH/conf-life:157`), and the genuinely-pending variant is exercised on `subscription.set`, the only async state-changing request. Reordered object keys are tested in the burst and in Variant B, not while a `subscription.set` is pending.
* Status: **pass-with-documented-adaptation**.

### C11 Duplicate ID, different content
* Components: RH.
* Evidence: pending: `RH/view:123` (different-content `S1` while pending gives `request_id_conflict`; the original still completes with its own outcome), `RH/view:312` (`S0` different content while pending gives conflict); completed: `RH/mut:16` (conflict after completion, seq unchanged), `RH/conf-life:156` (`dup2` conflict in a burst, state still at the first request's value, seq +2 only), `RH/rate:82`, `RH/view:335` (conflict after cached result).
* Not evidenced: pending variant for a durable mutation (cannot exist; see C10 adaptation). The pending variant is satisfied by `subscription.set`.
* Status: **pass**.

### C12 Lost reply across reconnect
* Components: CC, AG, ACC, RH.
* Evidence: `CC/client:599` "C12: disconnect invalidates the session, marks sent mutations uncertain, and never replays them"; real host: `CC/int:147` "host restart: fresh sessions take fresh snapshots in a new epoch; an uncertain write is never replayed" (commit survives, new frames are only `session.hello, realm.join`, the lost id sent exactly once, a new request uses a new id and the current revision); `ACC/cross:191` "C12 real host: connection lost after the durable commit -> outcome-uncertain, fresh snapshot shows the commit, no replay"; agent: `AG/int:93` (I3, lost reply, target already met, not re-sent), `AG/int:126` (I4, request lost, new id with current revision), `AG/int:151` (I5, host restart while uncertain), `AG/run:120`, `AG/run:136`, `AG/run:271`; host does not assume old-session dedup: `RH/conf-life:196` (pre-restart request ids processed afresh in the new session).
* Not evidenced: none.
* Status: **pass**.

### C13 Mutation outside requester's subscription still has terminal result
* Components: CC, ACC, RH.
* Evidence: `CC/int:103` "C13: a move that evicts the requester's own view resolves from the ack; the other view keeps it" (real host: ack received, requester's view leaves the entity, other client keeps it); `CC/client:577` "C13: a move that evicts the entity from the requester's view still resolves from the terminal ack"; host publication of the leave: `RH/mut:16`.
* Not evidenced: none.
* Status: **pass**.

### C14 Presence binding impersonation is rejected
* Components: RH.
* Evidence: `RH/conf-pres:31` "C14/C27 presence matrix: every impersonation, presence mutation and renderable mutation is rejected without any change": create entity containing `hvtp.presence@1` bound to B; set and patch of B's and own presence component; set and patch of B's and own presence transform; global delete of B's and own presence entity; each reply is `not_authorized` or `presence_binding_violation` with `ref` equal to the request id, realm seq unchanged, shared entity unchanged, no durable row or tombstone for presence ids, neither A nor B receives any publication, private-presence registration intact. `RH/conf-pres:81` "C14 when B disconnects its presence disappears silently: no tombstone, no seq advance, nothing sent to A". Also `RH/mut:204`, `RH/mut:233`, `RH/mut:137`; privacy to others: `RH/view:246`.
* Not evidenced: none.
* Status: **pass**.

### C15 Ephemeral traffic is rejected in P1
* Components: RH.
* Evidence: `RH/conf-pres:97` "C15 component.ephemeral is rejected in every session state and never mutates or publishes" (JOINED: `unsupported_message` with `ref` = request id, including a minimal `{hvtp,id,type}` envelope; no mutation, no seq advance, no publication to an observer, session stays usable); `RH/conf-pres:134` "C15 the literal abbreviated example (no request id) is rejected as invalid_message with a null ref" (no mutation, session survives).
* Adaptation (documented in the test comments): before JOINED the state machine answers `invalid_state` (`packages/reference-host/src/session.ts` dispatch order: state check precedes the ephemeral branch); and the case's literal payload `{"type":"component.ephemeral"}` has no top-level `id`, so closed-shape validation rejects it as `invalid_message` (null ref) before type dispatch. Profile section 6 says unsupported types are `unsupported_message`; the spec text does not name a state. Recommend a one-line spec clarification.
* Status: **pass-with-documented-adaptation**.

### C16 Renderable fixture is explicit
* Components: RH, CC, 3C, AG, ACC.
* Evidence: creation request carries exactly the fixture renderable: `CC/client:550` "requests use unique IDs, real P1 shapes, and resolve from terminal ack/error only", `ACC/happy:22` (host store holds the exact asset); host rejection: `RH/conf-val:55` "C16/C34 renderable fixture: every deviation is invalid_component_state, an over-long URI is resource_limit, nothing is created" (other, escaping, case-variant, absolute and empty URIs; wrong/non-string mediaType; wrong/non-string node; string/numeric/null `visible`; extra/missing fields; code-point bound versus code-unit bound; URIs above `maxAssetUriCharacters` in ASCII/multibyte/astral give `resource_limit`; no entity, no tombstone; `visible:false` still creates); client resolution, no redirect, size bound, placeholder, no shared mutation: `3C/adapter:220`, `3C/adapter:261` (12 failure variants), `CC/assets:21`, `AG/int:277`, `AG/int:281`, `AG/int:285`; no geometry invented from id/name: `3C/adapter:261` (an `entity:a` whose fixture fails shows only the placeholder, no `UnitCube` node), `3C/adapter:281` "a renderable that is not the P1 fixture reference is a local load failure" (no fetch, `ok:false`).
* Not evidenced: none.
* Status: **pass**.

### C17 Transform validation and interpretation
* Components: RH, 3C, AG.
* Evidence: validation: `RH/conf-val:161` "C17 transform domain via create, component.set and component.patch: every violation is invalid_component_state with no state change" (26 invalid inputs x 3 request kinds: position out of range per axis, wrong lengths/types, `1e400`/`-1e400` raw literals, quaternion norm +/-1.1e-5, +2e-5, zero and sqrt(2) norm, quaternion length/type, scale 0, negative, 1000.0001, wrong length/type; ids not burned; observer receives nothing) and `RH/conf-val:176` "C17 transform boundaries that are inside the domain are accepted by create, set and patch" (positions at +/-1e6, norm +/-9e-6, scale exactly 1000, tiny positive scale); wire layer: `RH/trans:101` (`1e400` reaches component validation with the parsed id; literal `NaN`/`Infinity` is `invalid_json`); numeric assertion [-0.5, 1.0, 0.5] within 1e-6: `3C/adapter:62` "C17: the renderer maps local [0.5,0.5,0.5] through the loaded UnitCube node to [-0.5,1,0.5]" (real glTF node under the entity root), `3C/adapter:75` (T x R x S, [x,y,z,w] quaternion), `AG/state:26` "U2: transformPoint applies scale, then rotation, then translation (C17)" (renderer-free).
* Not evidenced: none.
* Status: **pass**.

### C18 Material interpretation
* Components: RH, 3C.
* Evidence: `RH/conf-val:189` "C18 material domain via create, component.set and component.patch: every violation is invalid_component_state with no state change" (channel above 1, below 0, alpha above 1, lengths 3 and 5, string/null channel, non-array, `1e400`/`-1e400`) and `RH/conf-val:203` "C18 material channels at 0 and 1 are accepted"; linear-light interpretation: `3C/adapter:94` "C18: baseColor is stored as linear RGBA factors without sRGB conversion; alpha drives opacity" ([0.25,0.5,0.75,1] stored verbatim in Three's linear working space), `3C/adapter:110`, `3C/adapter:119`, `ACC/happy:22` (colorOf equals [0.25,0.5,0.75,1] in both Three views).
* Not evidenced: none.
* Status: **pass**.

### C19 Durable commit failure
* Components: RH.
* Evidence: create fault over the wire: `RH/mut:169` "failed durable create returns error and leaves no state, tombstone, sequence, or publication" (error returned, internal detail not exposed, no entity, no tombstone, seq 0, observer received nothing, retry then commits exactly once); set and delete faults at store level: `RH/store:167` "fault injection before commit rolls back component replacement and deletion" (revision, state, seq and tombstone unchanged); failure after durable commit: `RH/mut:289` "response failure after commit publishes canonical state, closes requester, and is confirmed by snapshot" (no rollback, publication delivered, requester closed 1011, fresh join snapshot shows the entity), `ACC/cross:191`, `CC/int:147`, `AG/int:93`.
* Not evidenced:
  1. Wire-level fault on `component.set`/`component.patch` and `entity.delete` (no `ack committed`, no `component.updated`/`entity.deleted`, error returned, observer silent). Only create is faulted over the wire.
  2. "After recovery/restart, canonical state remains at the previous revision": no test reopens a file-backed store after an injected pre-commit fault (the store tests use `:memory:`).
* Owner: reference-host (`RH/mut` or `RH/conf-life`, file-backed host with `worldStoreOptions.beforeCommit`).
* Status at `7bf1613`: **incomplete (minor)** — closed at `d41cd38` (see Closure addendum).

### C20 Restart invalidates session-scoped state
* Components: RH, CC, AG, ACC.
* Evidence: `RH/conf-life:196` "C20/C24 a real host restart over the same SQLite file invalidates sessions but keeps tombstones and durable entities" (old connections closed 1001; `realmEpoch` differs; realm seq resets to 0; tombstone and durable entity survive; zero private presences and zero subscribers in the new process; new participant and presence ids differ from the old; a tombstoned id gives `entity_exists`; the same request ids used before the restart are processed afresh, so no old dedup cache is consulted; reconnecting watcher takes a fresh snapshot); `ACC/happy:22` steps 10-12; `CC/int:147` (clients reset, new epoch, only `hello` + `join` sent in the new session, uncertain request not resumed); `AG/int:151`; `RH/server:165`; `RH/store:34`.
* Not evidenced: none (the process restart is simulated by `close()` then a new `createReferenceHost` on the same file, not a crash/kill; see section 6).
* Status: **pass**.

### C21 Resource limits
* Components: RH, PT.
* Evidence by bullet:
  * message over `maxMessageBytes`, single and fragmented (fragments individually small): `RH/trans:35`, `RH/trans:49` (close 1009, not executed), `RH/trans:61` (within limit reassembles);
  * radius above maximum: `RH/conf-spat:105` and `RH/conf-spat:120` (`resource_limit` on join and `subscription.set`, state preserved), `RH/conf-spat:83` (maximum accepted);
  * join/replacement exceeding `maxVisibleEntitiesPerConnection`: `RH/view:266` "C21 replacement accepts exact view limit including own presence and rejects max+1 without changing generation" (cached error replay too), `RH/view:288` (loop, join rejected with `resource_limit` until narrowed);
  * live growth: `RH/view:288` (loop create/move) "C36 <kind> commits while overflowing subscriber closes; narrower subscribers and rejoin remain correct";
  * request/control flooding: `RH/rate:48`, `RH/rate:64`, `RH/rate:116`;
  * durable mutation rate: `RH/rate:82`;
  * `maxPendingStateChangingRequests`: `RH/view:312`; request dedup table: `RH/view:335`;
  * slow snapshot consumer: `RH/view:356` "C21 snapshot catch-up payload overflow disconnects only affected peer and releases blocked work"; `RH/view:411`; `RH/coord:34`;
  * outbound queue exhaustion: `RH/out:157` "C21 outbound exhaustion: transport-pending bytes count against the same 4 MiB budget and overflow closes only that connection", `RH/out:37`;
  * `maxPersistentEntityRecords`: `RH/limits:97` "C21 persistent budget: live entities plus tombstones fill maxPersistentEntityRecords, deletion frees no capacity" (creation refused with `resource_limit`, no state change);
  * entity serialization above the maximum: `RH/limits:134` "maxEntityBytes is unreachable through valid P1 wire input (worst-case entity is far below the limit)" (argued unreachable, adaptation).
* Not evidenced: over-limit explicit entity ID count on the wire. Only the parser is tested: `PT/val:164` "parseRealmJoin enforces explicit entity ID count" (257 IDs gives `resource_limit`); there is no host test sending 257 explicit IDs in `realm.join` or `subscription.set` (previous generation preserved, session joinable) and no test at the exact limit of 256 accepted. Owner: reference-host (`conformance-spatial.test.ts`).
* Adaptation: entity-size limit not constructible (see above).
* Status at `7bf1613`: **incomplete (minor)** — closed at `d41cd38` (see Closure addendum).

### C22 Read authorization precedes interest
* Components: RH, CC.
* Evidence: `RH/view:246` "C22 replacement interest never reveals another participant's private presence" (A requests B's presence id explicitly and in a combined spatial+explicit selector: `subscription.applied` and then nothing; join snapshot with the same selectors contains only the joiner's own presence; seq 0); defensive client: `CC/client:134` (foreign presence in a snapshot is rejected); `RH/conf-pres:31`.
* Not evidenced: none.
* Status: **pass**.

### C23 Second consumer interprets the same fixture
n/a, independent-consumer gate. No independent consumer and no captured fixture trace exist.

### C24 Global deletion versus view eviction
* Components: RH, ACC.
* Evidence: `RH/conf-life:196` (A evicts E and gets `leave`; B alone hears exactly one `entity.deleted` and nothing else; A hears nothing; tombstoned; after restart the tombstone remains, recreate gives `entity_exists`, delete-again gives `entity_not_found` with seq unchanged, a later subscription that would include E does not make it reappear, cached retry rebroadcasts nothing); `RH/view:97` (eviction without deletion; B alone receives `entity.deleted`, no `view.entity.leave`); `RH/mut:320` (delete again `entity_not_found`, seq unchanged, recreate `entity_exists`); `RH/conf-life:128` (cached delete retry silent); `RH/store:34`.
* Not evidenced: none.
* Status: **pass**.

### C25 Closed JSON shape and duplicate keys
* Components: PT, RH.
* Evidence: unknown top-level/body field and the explicit fixture: `RH/conf-shape:11` "C25 explicit correlation fixture: unknown top-level field is invalid_message correlated to the request id, with no mutation" (`ref` = `b4448cc1-...`, entity intact, no tombstone, no publication), `RH/conf-shape:40` (unknown top-level, body and nested entity fields on create/delete/set/patch/subscription); missing/empty/non-string/duplicate ids: `RH/conf-shape:75` (missing, empty, numeric, null, object, decoded duplicate `"id"`/`"id"`, with `ref: null`; a nested duplicate keeps the top-level id); id length: `RH/conf-shape:100` (129/130/129 UTF-8 bytes rejected for request ids and entity ids; 128 accepted); participant kind: `RH/conf-shape:144` (robot, empty, case variants, null, number, array, object; session stays CONNECTED); positive and negative selector shapes: `RH/conf-shape:206`, `RH/conf-shape:223`; parser level: `PT/val:47`, `PT/val:58`, `PT/val:69`.
* Adaptation: `RH/conf-shape:169` "C25 host-publication types sent client-to-host are rejected with the request id and mutate nothing" covers 13 host-direction types in every session state and accepts `invalid_message` or `unsupported_message`; the host answers `unsupported_message` (`session.ts` `KNOWN_CLIENT_MESSAGE_TYPES`; Profile section 6: unsupported types give `unsupported_message`). C25 allows `unsupported_message` "only when the message type itself is unknown"; whether a host-direction type counts as unknown is not stated. Recommend a spec clarification.
* Status: **pass-with-documented-adaptation**.

### C26 Merge Patch cannot delete required component state
* Components: RH.
* Evidence: `RH/conf-val:216` "C26 merge patches that would delete required state or are not valid patches are rejected atomically" (revision 5 transform; `position:null` spec example, rotation/scale null, null alongside a valid field, empty, null/array/string/number/boolean patch, unknown fields, wrong length/type, non-normalized quaternion, valid-plus-invalid mix, material `baseColor:null`/empty/unknown/wrong length; each `invalid_component_state` with unchanged full entity JSON and seq; missing `patch` member is `invalid_message`; a valid merge patch at the same revision then preserves omitted fields); `RH/mut:79`.
* Not evidenced: none.
* Status: **pass**.

### C27 Immutable renderable and presence components
* Components: RH.
* Evidence: `RH/conf-pres:31` (set and patch of the shared entity's `hvtp.renderable@1`; set and patch of `hvtp.presence@1` on own, other and shared entities; set and patch of own and other presence transforms; all `not_authorized`/`presence_binding_violation`; revisions and seq unchanged; presence registration unchanged; no publications); `RH/mut:79` (renderable set `not_authorized`), `RH/mut:137` (own presence transform `presence_binding_violation`).
* Not evidenced: none.
* Status: **pass**.

### C28 Overlapping subscription replacements serialize by generation
* Components: RH, CC, ACC.
* Evidence: host: `RH/view:123` (S1 batch `applied, leave` completes before S2 `applied, enter`; `previousSubscriptionId` chain; cached S1 retry after S2 is active returns the cached `applied` and does not replay; later live update carries S2), `RH/view:155`, `RH/view:178` (queued pre-boundary publication delivered before `subscription.applied`), `RH/view:392` (equal seq for leave and enter); client: `CC/client:333` "C28: a delayed publication tagged with an old generation is ignored after the new one is active" (3 stale kinds give `publication.stale`, state untouched), `CC/client:316` (equal seq not deduplicated), `CC/client:365` "C28: a cached older subscription.applied resolves its request but never reactivates the old generation", `CC/client:467`; real host and client: `CC/int:126`, `ACC/cross:115` "C28 real host: rapid S1 (excludes E) then S2 (includes E) settles on S2 with E present; a late S1-tagged publication is ignored".
* Not evidenced: none.
* Status: **pass**.

### C29 Spatial membership predicate
* Components: RH.
* Evidence: `RH/conf-spat:21` "C29 membership is transform-origin Euclidean distance, inclusive at the radius, in all three axes" ([100,0,0], [0,100,0], [0,0,100], [60,80,0] selected; [100.000001,0,0], [0,0,100.000001], [58,82,0] not; huge and tiny/non-uniform scale do not change membership; `visible:false` does not change membership in either direction; same predicate for join snapshot and `subscription.set`); `RH/conf-spat:54` (live publication path uses the same inclusive boundary); `RH/conf-spat:76` (radius 0 selects exactly the center); `RH/conf-spat:83` (maximum radius accepted); `RH/conf-spat:105`, `RH/conf-spat:120` (center length 2/4/non-array, string/null coordinate, negative radius, string radius, missing radius, unknown field, `1e400` center and radius give `invalid_message`; radius above maximum gives `resource_limit`; session stays joinable; active generation preserved). Asset bounds are never used (huge-scale and visibility cases).
* Not evidenced: none.
* Status: **pass**.

### C30 Snapshot metadata and mutation kinds are complete
* Components: RH, CC, ACC.
* Evidence: host agreement: `RH/view:197` (loop; `realm.joined`, `snapshot.begin`, every `entity.snapshot`, `snapshot.end` agree on `realmEpoch`, `snapshotId`, `snapshotBaseSeq`; `entityCount` equals record count), `RH/server:52`, `RH/session.test` "realm.join enqueues joined + one private presence snapshot before JOINED" (`packages/reference-host/src/session.test.ts:75`); client rejection of mismatches: `CC/client:78` (snapshotId on an entity record), `CC/client:87` (snapshotBaseSeq at end), `CC/client:97` (realmEpoch), `CC/client:104` (subscriptionId at begin and at end), `CC/client:115` (entityCount); each yields no partial activation, phase `disconnected`, close 4002; four mutation kinds applied once after end: `RH/view:197`, `ACC/cross:41`; buffered-to-live ordering variant: `RH/view:228` "C30 buffered publication cannot be overtaken by later live publication or its ACK" (later mutation is acked while the buffered publication is still held and the joiner has received nothing; delivery order seq 2 then seq 3).
* Not evidenced: the "missing" half of "mismatched/missing snapshot identifier or base sequence". No client test delivers a `realm.joined`/`snapshot.begin`/`entity.snapshot`/`snapshot.end` lacking `snapshotId`, `snapshotBaseSeq` or `realmEpoch` and asserts discard. Owner: client-core (`client.test.ts` or `wire.test.ts`).
* Status at `7bf1613`: **incomplete (minor)** — closed at `d41cd38` (see Closure addendum).

### C31 Request-table admission and subscription retries
* Components: RH.
* Evidence: `RH/view:335` "C31 request-table lookup precedes capacity and cached subscriptions remain exact" (table filled to `maxRequestDedupEntries`; existing-ID lookup still works: cached retry equal, different content gives `request_id_conflict`; new ID gives `resource_limit`, also with different content for the refused ID; a refused create does not mutate); `RH/view:312` (pending table: duplicate lookup precedes capacity, `resource_limit` for the overflow id and for a mutation, the refused ids are not reserved and are admitted after capacity is released, one `subscription.applied` per request); retry semantics: `RH/view:123`, `RH/rate:82` (refused id not reserved).
* Not evidenced: none.
* Status: **pass**.

### C32 Revision/epoch domains, precedence, no-op, overflow
* Components: RH.
* Evidence: `RH/conf-val:276` (revision 5 + epoch 1 eligible and commits to 6; revisions 4, 6, 2^53-1 give `revision_mismatch` with `currentRevision` 5; epochs 2 and 2^53-1 give `authority_epoch_mismatch`; zero/negative/fractional/string/out-of-range/other-type metadata gives `invalid_message`, ahead of every equality check); no-op: `RH/mut:320` (no-op `component.set` acks, publishes, advances seq once; same-session retry replays the ack with seq unchanged), `RH/store:34` (no-op advances the revision exactly once and seq once); overflow: `RH/limits:33` "C32 realm seq 2^53-1: create, component set and delete are resource_limit before any state change" (create, set, patch, delete; no row, no tombstone, no publication, no ack), `RH/limits:69` "C32 component revision 2^53-1: valid mutation is resource_limit before any state change".
* Not evidenced: none.
* Status: **pass**.

### C33 UTF-8, JSON syntax, request shape, and uncorrelated errors
* Components: RH, PT.
* Evidence: `RH/trans:69` (invalid UTF-8 closes 1007, pipelined later request not processed), `RH/trans:79` (invalid only after reassembly closes 1007), `RH/trans:89` (valid 4-byte code point split across fragments is accepted), `RH/trans:101` "C33 wire classifications and state-machine preservation: hello stays CONNECTED, join NEGOTIATED, mutation JOINED" (`{`, `NaN`, `Infinity` are `invalid_json` null ref; `[]`, `null`, duplicate decoded id are `invalid_message` null ref; hello/join/mutation state preserved after each rejection; `1e400` in a transform reaches component validation with `invalid_component_state` and the parsed request id), `RH/conf-shape:11` (unique valid id correlated), `PT/val:30`, `PT/val:38`, `PT/val:47`, `PT/val:58`.
* Not evidenced: none.
* Status: **pass**.

### C34 Asset base resolution and load failure are renderer-local
* Components: CC, 3C, AG, RH, ACC.
* Evidence: same URL regardless of document origin, browser and headless: `CC/assets:16` "resolveP1AssetUrl resolves against the advertised base, independent of any document origin", `3C/adapter:220`, `AG/run:244` "U12: a valid fixture is reported with the URL resolved against the advertised assetBaseUri", `ACC/happy:22` (browsers fetched only `.../assets/p1/unit-cube.gltf`; agent `asset.checked` URL equal); redirects refused (credentials omitted, `redirect: manual`): `CC/assets:21`, `CC/assets:52` (loop), `3C/adapter:261` (redirect variant), `AG/int:277` (real HTTP 302); oversized asset a local failure: `AG/int:281`, `AG/int:285`, `3C/adapter:261` (declared size and streamed variants), `CC/assets:52` (loop); fetch failure gives only a placeholder and never a shared mutation: `3C/adapter:261` (loop of 12; canonical entries unchanged, sent frames are only `session.hello, realm.join`), `AG/run:233` (loop, frames and exit code unchanged); wrong URI/media type/node and non-boolean `visible` are `invalid_component_state`: `RH/conf-val:55`; `visible:false` valid and membership-neutral: `RH/conf-val:55` (final create with `visible:false` acks), `RH/conf-spat:21` (invisible entities selected or not purely by distance), `3C/adapter:132`; host asset endpoint: `RH/limits:157`, `RH/limits:186`, `RH/server:105`.
* Not evidenced: none.
* Status: **pass**.

### C35 Creation/deletion publication precedence
* Components: RH.
* Evidence: `RH/conf-life:18` (creation visible to A and invisible to B: A exactly one `entity.created` on its replaced-generation `subscriptionId`, no enter; B nothing; deletion: A exactly one `entity.deleted` with the active `subscriptionId`, no leave; B nothing; delete again gives `entity_not_found`, seq unchanged, no publication); delayed variants: `RH/mut:381` "ordered publications keep create N before delete N+1 across delayed enqueue", `RH/conf-life:60` "C35 a delayed deletion at seq N is enqueued before a later publication at seq N+1"; `RH/mut:320`.
* Not evidenced: none.
* Status: **pass**.

### C36 Live-view overflow is explicit
* Components: RH.
* Evidence: `RH/view:288` (loop `create` and `move`) "C36 <kind> commits while overflowing subscriber closes; narrower subscribers and rejoin remain correct": the mutation commits and is acked, the affected connection receives `resource_limit` with null ref and is closed 1011, the narrow subscriber keeps its connection and gets the publication, the same too-broad selector is rejected on rejoin and a narrowed selector is accepted; `RH/out:157`.
* Not evidenced: none.
* Status: **pass**.

### C37 Independent transform/lifecycle trace
n/a, independent-consumer gate. No captured trace and no independent consumer exist.

## 4. Prototype Profile section 16 happy path (16 steps)

Automated evidence (all on this head): `ACC/happy:22` "Prototype Profile section 16 happy path: steps 1-16 against a real host, two Three.js browsers, and a separate-process agent" (real `ws` host on a temp SQLite file, two `P1Client` + `P1ThreeView` browsers in Node with real fetch, agent run as a separate OS process through `packages/agent-client` CLI). Manual real-browser evidence: `docs/expeditions/evidence/browser-acceptance-2026-10-10.md` on branch `expedition/p1-reference` (two Chromium tabs against the Vite dev server and a file-backed host; all 16 steps recorded as pass). Caveat: that manual run was made against earlier component builds (host and Three demo from `8cca804`, agent CLI from `c5b71fe`), not this integration head; it has not been re-run on `7bf1613`.

| Step | Requirement | Automated evidence (`ACC/happy:22` line, unless noted) | Manual browser run |
| --- | --- | --- | --- |
| 1 | start a clean host | `:28-:32` new temp SQLite, seq 0, no cube | pass |
| 2 | connect A and B | `:35-:38` `connect()` on both, `phase: live`, distinct participant ids | pass |
| 3 | negotiate HVTP 0.2, overlapping spatial join | `:43-:51` hello `versions ["0.2"]`, join radius 100, own presence only | pass |
| 4 | A creates a renderable unit cube | `:54-:59` committed ack; host holds the exact fixture renderable | pass |
| 5 | B materializes without reload | `:62-:73` B sees the cube, one snapshot only, asset `loaded` (real fixture, not placeholder), glTF node `UnitCube` instantiated | pass |
| 6 | A moves it | `:76-:77` ack revision 2 | pass |
| 7 | B receives canonical transform | `:80-:84` B canonical state, Three position and host store equal; material still rev 1 | pass |
| 8 | B changes base colour | `:87-:88` ack revision 2 | pass |
| 9 | A receives canonical material | `:91-:98` A canonical `[0.25,0.5,0.75,1]`, Three colour equal, `durableSeq === 3` | pass |
| 10 | stop and restart host | `:101-:111` host closed, both clients dropped session state and emptied the scene, restart on the same file and port, new epoch, seq 0 | pass |
| 11 | reconnect and take fresh snapshots | `:114-:123` two sessions each, two snapshot resets each, nothing replayed | pass |
| 12 | cube reappears with last durable revisions | `:126-:134` transform rev 2 / material rev 2 and states restored, asset loaded, Three equal | pass |
| 13 | connect a headless agent | `:138-:154` separate OS process (`agent.pid !== process.pid`), `participantKind: agent`, new participant id, exit 0, empty stderr | pass |
| 14 | agent explicitly subscribes, reads structured state | `:155-:168` join selector `{}` then `subscription.set {entities:[cube]}`; `entity.observed` with revisions 2/2 and exact states | pass |
| 15 | agent requests an allowed mutation | `:169-:173` `component.set` material and `component.patch` transform, both fenced on `baseRevision` 2, both committed to revision 3, outcome `satisfied` | pass |
| 16 | both browsers observe accepted canonical result | `:176-:188` both browsers at revisions 3/3 with agent's position and colour in canonical state and Three objects; host store matches | pass |

"No renderer-specific private channel": `ACC/happy:22` `:190-:200` asserts browsers sent only P1 frame types, all `hvtp: "0.2"`, fetched only the advertised asset endpoint, the Three view has no request surface, and the agent shares no memory with the browsers. Supporting component evidence: `CC/int:57` (steps 1-9 over a real host), `CC/int:147` and `RH/server:165` (steps 10-12), `AG/int:21` and `agent-client/src/cli.test.ts:29` (steps 13-16 from the agent side).

## 5. Minimum pass criterion cross-checks

### 5.1 "No test relies on renderer-private messages/state"
Assessment: **satisfied; no test found relies on a renderer-private channel for a protocol assertion.**
* Host tests assert only wire frames received by `ws` peers or the `P1Session.handleText` return value, plus the host's canonical store (`host.worldStore.*`). They use host-private test seams (`beforeMutationEnqueue`, `beforeSnapshotEnqueue`, `beforeTransitionEnqueue`, `afterDurableCommit`, `worldStoreOptions.beforeCommit`, raw SQLite seeding in `RH/limits`, direct `worldStore.createEntity`). These are deterministic barriers on the host, not renderer channels.
* client-core and agent-client assertions go through `client.entities` (frozen canonical records), client events and recorded outbound frames; no Three types are imported.
* three-client tests assert renderer behaviour (Object3D, material, dispose counts) only for cases that specify renderer interpretation (C17, C18, C34 placeholder, lifecycle mirroring). Protocol facts in those tests are read from `h.client.entities` / `h.socket.sent`.
* `ACC/happy` and `ACC/cross` read Three state (`positionOf`, `colorOf`, `view.object`) as a secondary assertion alongside canonical `client.entities` and the host store; every protocol-level assertion (revisions, states, ordering, causes) is made on canonical state. The stale-generation injection in `ACC/cross:115` writes wire frames to the public `P1Socket` interface.
* The 3C suite and the C12/C34/C16 "placeholder" checks use frames and messages built by `client-core/src/test-support.ts`; drift between those builders and real host output is covered by the real-host client tests (`CC/int`, `ACC/*`).
* Caveat for any future browser E2E: `packages/three-client/src/demo/main.ts` exposes `window.hvtpDemo = { client, view }` for automation; protocol assertions through it must use `hvtpDemo.client.entities`, not scene objects.

### 5.2 "A clean restart preserves durable world state"
Assessment: **satisfied** (clean shutdown via `host.close()` then a new process-equivalent host on the same SQLite file).
* Store level: `RH/store:34` "durable state/revisions/tombstones survive restart while realm seq resets" (entity, material revision, tombstone, non-reuse, seq reset to 0).
* Host over the wire: `RH/server:165` "reference host recovers durable shared state into a fresh epoch snapshot" (new epoch, snapshot revisions and states); `RH/conf-life:196` "C20/C24 a real host restart over the same SQLite file invalidates sessions but keeps tombstones and durable entities".
* Real clients: `CC/int:147`; agent: `AG/int:151` (I5); full happy path with two Three browsers and restart on the same port: `ACC/happy:22` steps 10-12 (revisions 2/2 and states restored, new `realmEpoch`).
* Not covered: abrupt process kill (no graceful `close()`); restart after an injected commit fault (see C19). SQLite WAL semantics make rollback inherent, but no test proves it.

## 6. Open items and ownership

| ID | Severity | Missing assertion | Owner |
| --- | --- | --- | --- |
| C06 | minor | (a) wire join and `subscription.set` with `{spatial radius 25, entities [far at X=1000]}` yields the far entity; (b) live: pinned far entity update stays `component.updated` and never leaves, spatial-only entity moved away leaves | reference-host (`conformance-spatial.test.ts`) |
| C09 | trivial | client-core sparse-seq test does not assert no extra frame sent / no extra `view.reset` | client-core (`client.test.ts:305`) |
| C19 | minor | (a) wire-level `beforeCommit` fault for `component.set`/`component.patch` and `entity.delete`: error, no committed ack, no publication; (b) reopen a file-backed store after the fault: previous revision/state, no tombstone | reference-host |
| C21 | minor | host wire test: `realm.join` and `subscription.set` with 257 explicit entity IDs give `resource_limit` with the previous generation preserved, and exactly 256 accepted. (Entity-size limit remains an argued-unreachable adaptation.) | reference-host |
| C30 | minor | client-core test: `realm.joined`/`snapshot.begin`/`entity.snapshot`/`snapshot.end` missing `snapshotId`, `snapshotBaseSeq` or `realmEpoch` is discarded without partial activation | client-core |

Spec clarifications suggested (not test gaps): C15 per-state error code and the abbreviated payload without `id`; C25 whether a host-direction type counts as "unknown" for `unsupported_message`; C10 Variant A for synchronous host mutations (state the `subscription.set` witness or require an async commit seam).

## Closure addendum — integration head `d41cd38` (2026-10-10)

The audit above was performed at `7bf1613` and found five incomplete items. They were closed by new tests, with no production-code change required, and the combined suite was re-run at integration head `d41cd38` (326/326: protocol-types 13, reference-host 119, client-core 90, three-client 32, agent-client 64, p1-acceptance 8).

| Case | Closing evidence | Final status |
| --- | --- | --- |
| C06 | `packages/reference-host/src/conformance-union-fault.test.ts:24` "C06 join and subscription.set take the union of spatial and explicit selection; {} selects only own presence"; `:51` "C06 live projection keeps the union: pinned entities stay when they move away, spatial-only entities leave" | pass |
| C09 | `packages/client-core/src/client.test.ts:340` "sparse canonical sequences are accepted and never treated as loss" now asserts no frame is sent and no `view.reset` occurs | pass |
| C19 | `packages/reference-host/src/conformance-union-fault.test.ts:73` "C19 pre-commit fault on set, patch and delete: error, no publication, nothing changes, and a restart on the same file keeps the prior state" | pass |
| C21 | `packages/reference-host/src/conformance-union-fault.test.ts:131` explicit-ID count 256/257 on join and `subscription.set` (generation preserved); `:167` and `limits.test.ts` worst-case entity size bound | pass-with-documented-adaptation (entity-serialization limit cannot be reached by a valid P1 entity) |
| C30 | `packages/client-core/src/client.test.ts:88`, `:102`, `:113` — snapshot messages missing `snapshotId` / `snapshotBaseSeq` / `subscriptionId` / `entityCount` / `realmEpoch` are discarded without partial activation | pass |

Line numbers in the per-case sections above refer to `7bf1613` and may have shifted.
