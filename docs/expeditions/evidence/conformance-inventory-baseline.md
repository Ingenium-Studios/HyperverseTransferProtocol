# HVTP P1 Conformance Evidence Inventory (Slice 7 head, `6093344`)

Scope: read-only audit of `protocol-spec/p1-conformance.md` (C01-C37) and `protocol-spec/prototype-profile.md` section 16 against the 147 automated tests (13 protocol-types, 79 reference-host, 33 client-core, 22 three-client). Every test body was read; coverage is judged from assertions, not titles. The headless agent does not exist yet. No test was run for this audit.

All paths are repo-relative. In the per-case tables, evidence cells are `path:line` of the `test(...)` call or the specific assertion lines; the **exact test name** for every `path:line` is in Appendix A.

## 0. Legend

**Component labels**

| Label | Meaning |
| --- | --- |
| `PT` | `packages/protocol-types` unit (parsers/validators, no socket) |
| `H-unit` | reference-host unit (`P1Session`, `P1WorldStore`, rate limiter, outbound channel, coordinator) with no real socket |
| `H-ws` | reference-host test through a real `ws` WebSocket against `createReferenceHost` |
| `CC-unit` | client-core unit against `FakeSocket` with hand-built host messages |
| `CC-host` | client-core `P1Client` over real `ws` against a real `createReferenceHost` (`host-integration.test.ts`) |
| `3C` | three-client (`P1ThreeView` + loader); its session input is a client-core `FakeSocket`, never a real host |

**Strength**: `direct` = an assertion explicitly checks the sub-assertion; `partial` = exercised but part of the requirement is missed (stated); `indirect` = only implied by other assertions or by code structure; `none` = no test evidence.

**Status**: `covered` = every sub-assertion has `direct` evidence somewhere in the owning component(s) and remaining gaps are hardening only; `partial` = at least one normative sub-assertion is `partial`, `indirect`, or `none`; `gap` = the case's core assertions have no meaningful evidence; `n/a-independent` = case needs an independently implemented consumer.

## 1. Headline results

* Reference-applicable cases: 35 (C01-C22, C24-C36). **Covered 14, Partial 19, Gap 2.** Independent-consumer-only: 2 (C23, C37), no evidence possible yet (no independent consumer and no captured fixture trace exist).
* Covered: C04, C05, C07, C09, C11, C12, C13, C21, C22, C28, C30, C31, C33, C36.
* Partial: C01, C02, C03, C06, C08, C10, C14, C16, C17, C18, C19, C20, C24, C25, C26, C27, C32, C34, C35.
* Gap: **C15** (no test sends `component.ephemeral`), **C29** (no spatial-membership boundary test at all).
* Strongest areas: transport/UTF-8/limits (C21, C33), subscription generations and ordering (C07, C28, C30, C31, C35 ordering), snapshot cut (C08/C30 host side), lost-reply semantics (C12/C19 post-commit).
* Weakest areas: validation matrices (C02/C03/C17/C18/C25/C26/C32 domain checks are asserted for one or two inputs of a dozen), presence immutability matrix (C14/C27), renderable validation on the host (C16/C34), spatial predicate (C29), tombstone/restart over the wire (C20/C24), headless-agent and Three-on-real-host evidence (happy path 13-16, C01 browser leg, C34 headless leg).

## 2. Summary table (one row per case)

Evidence refs are abbreviated to the strongest 1-3 tests. "Gap summary" is the headline gap; full list in section 3 and section 6.

| ID | Title | Class | Component(s) | Status | Key evidence (file:line) | Gap summary |
| --- | --- | --- | --- | --- | --- | --- |
| C01 | Happy-path shared persistent entity | reference-applicable | CC-host, H-ws, H-unit | partial | `packages/client-core/src/host-integration.test.ts:57`, `:147`; `packages/reference-host/src/mutation.test.ts:16`; `packages/reference-host/src/server.test.ts:165` | Three client never run on a real host; no end-to-end "exactly one `entity.created`, zero `view.entity.enter`" or per-component state-isolation assertion on the real host; material is only `component.set`, never patched |
| C02 | Concurrent revision conflict | reference-applicable | H-ws | partial | `packages/reference-host/src/mutation.test.ts:108`, `:79` | No `invalid_message` tests for negative/fractional/string/>2^53-1 `baseRevision`; no concurrent different-component test; no update-vs-delete race |
| C03 | Authority epoch exact match | reference-applicable | H-ws | partial | `packages/reference-host/src/mutation.test.ts:312` | Epoch 0/negative/fractional/string/>2^53-1 never sent; domain-before-equality ordering unproven |
| C04 | Entity enters spatial interest | reference-applicable | H-ws, CC-unit, 3C | covered | `packages/reference-host/src/mutation.test.ts:16`, `:395`; `packages/reference-host/src/view-lifecycle.test.ts:195`; `packages/client-core/src/client.test.ts:230` | Enter `reason: "interest"` never asserted; host `view.entity.enter` never fed to client-core in an integration test |
| C05 | Leave and re-enter | reference-applicable | H-ws, CC-unit, CC-host, 3C | covered | `packages/reference-host/src/mutation.test.ts:395`; `packages/client-core/src/client.test.ts:230`; `packages/three-client/src/three-adapter.test.ts:151` | Host does not assert "no tombstone" after an interest leave; delayed-enqueue variant not run through a client |
| C06 | Explicit subscription overrides distance (union) | reference-applicable | H-unit | partial | `packages/reference-host/src/world-store.test.ts:108` | Live-projection union (pinned far entity keeps `component.updated`) and wire-level spatial+explicit join are untested |
| C07 | Replacement is a view operation, not deletion | reference-applicable | H-ws, CC-unit, CC-host | covered | `packages/reference-host/src/view-lifecycle.test.ts:97`, `:390`; `packages/client-core/src/host-integration.test.ts:126` | Touches Slice 7 finding "subscription.applied correlation" |
| C08 | Snapshot mutation boundary | reference-applicable | H-ws, CC-unit | partial | `packages/reference-host/src/view-lifecycle.test.ts:195`; `packages/client-core/src/client.test.ts:149` | No test proves "final client state == canonical state" with a real host + real client across the snapshot cut |
| C09 | Sparse realm sequences | reference-applicable | H-ws, CC-unit | covered | `packages/reference-host/src/mutation.test.ts:352`; `packages/client-core/src/client.test.ts:278` | Client test does not assert that no resync/join frame is sent |
| C10 | Duplicate request, same content | reference-applicable | H-ws, H-unit | partial | `packages/reference-host/src/mutation.test.ts:16` (Var B); `packages/reference-host/src/view-lifecycle.test.ts:121` (Var A) | Var A only for `subscription.set` (mutations are synchronous in host, no pending window); cached terminal *error* only for `subscription.set`; no cached-retry no-rebroadcast test for create/delete/enter |
| C11 | Duplicate ID, different content | reference-applicable | H-ws, H-unit | covered | `packages/reference-host/src/view-lifecycle.test.ts:121`; `packages/reference-host/src/mutation.test.ts:69` | Pending variant only for `subscription.set` |
| C12 | Lost reply across reconnect | reference-applicable | CC-unit, CC-host | covered | `packages/client-core/src/host-integration.test.ts:147`; `packages/client-core/src/client.test.ts:425` | Host-side "old-session dedup not assumed" has no test (low) |
| C13 | Mutation outside requester's view | reference-applicable | CC-host, CC-unit | covered | `packages/client-core/src/host-integration.test.ts:103`; `packages/client-core/src/client.test.ts:403` | None material |
| C14 | Presence impersonation rejected | reference-applicable | H-ws, H-unit | partial | `packages/reference-host/src/mutation.test.ts:137`, `:196`, `:225`; `packages/reference-host/src/view-lifecycle.test.ts:244` | No test for: set/patch of `hvtp.presence@1`, patch of presence transform, cross-participant transform set, global delete of own/other presence, disconnect-removal without tombstone/seq |
| C15 | Ephemeral traffic rejected | reference-applicable | none | **gap** | (none) | Zero tests send `component.ephemeral`; state-dependence of the code (`invalid_state` before JOINED) and abbreviated no-id form unverified |
| C16 | Renderable fixture explicit | reference-applicable | CC-unit, 3C | partial | `packages/client-core/src/client.test.ts:376`; `packages/three-client/src/three-adapter.test.ts:219`, `:256` | Host rejection of other URI/mediaType/node/non-boolean `visible` untested; `maxAssetUriCharacters` is advertised but never enforced (spec says URI-size violations are `resource_limit`) |
| C17 | Transform validation and interpretation | reference-applicable | H-ws, H-unit, 3C | partial | `packages/reference-host/src/transport.test.ts:101`; `packages/three-client/src/three-adapter.test.ts:61`, `:74` | Only `1e400` (wire) and scale `[0,..]` (store) are tested; quaternion norm, vector length/type, negative scale, scale>1000, position range all untested; client-core parser domain checks untested |
| C18 | Material interpretation | reference-applicable | 3C | partial | `packages/three-client/src/three-adapter.test.ts:93` | Host/client-core rejection of out-of-[0,1], non-finite, wrong-length `baseColor` untested |
| C19 | Durable commit failure | reference-applicable | H-ws, H-unit, CC-host | partial | `packages/reference-host/src/mutation.test.ts:169`, `:281`; `packages/reference-host/src/world-store.test.ts:167` | Set/delete faults only at store level; no restart-after-fault; "no publication" check in the create-fault test is race-prone |
| C20 | Restart invalidates session state | reference-applicable | H-ws, CC-host, H-unit | partial | `packages/reference-host/src/server.test.ts:165`; `packages/client-core/src/host-integration.test.ts:147` | "Old connections terminate" never asserted; tombstone non-reuse after restart only at store level; old presence/participant/dedup invalidation unasserted |
| C21 | Resource limits | reference-applicable | H-ws, H-unit, PT | covered | `packages/reference-host/src/transport.test.ts:35`, `:49`; `packages/reference-host/src/limits.test.ts:97`; `packages/reference-host/src/view-lifecycle.test.ts:264`, `:354` | Entity-size limit only argued unreachable; radius/explicit-ID limits tested at parser, not on a `subscription.set` wire path; mutation rate only at session level |
| C22 | Read authorization precedes interest | reference-applicable | H-ws, CC-unit | covered | `packages/reference-host/src/view-lifecycle.test.ts:244`; `packages/client-core/src/client.test.ts:134` | None material |
| C23 | Second consumer interprets same fixture | independent-consumer-only | (none) | n/a-independent | (none) | No independent consumer; no captured fixture trace in `protocol-spec/fixtures` |
| C24 | Global deletion vs view eviction | reference-applicable | H-ws, H-unit | partial | `packages/reference-host/src/view-lifecycle.test.ts:97`; `packages/reference-host/src/mutation.test.ts:312`; `packages/reference-host/src/world-store.test.ts:34` | "Tombstone remains after restart" only at store level; "E does not reappear in later subscription" untested; cached delete retry no-rebroadcast untested |
| C25 | Closed JSON shape and duplicate keys | reference-applicable | PT, H-unit, H-ws | partial | `packages/protocol-types/src/validation.test.ts:47`, `:58`, `:69`; `packages/reference-host/src/transport.test.ts:101`; `packages/reference-host/src/mutation.test.ts:249` | No tests for missing/empty request ID, >128-byte IDs, bad participant kind, host-publication type client->host; the `entity.delete` + `unexpected` explicit fixture is untested |
| C26 | Merge Patch cannot delete required state | reference-applicable | H-ws, H-unit | partial | `packages/reference-host/src/mutation.test.ts:79`, `:137` | Only `position: null`; empty/non-object/wrong-length/unknown-field patches and per-rejection state preservation untested |
| C27 | Immutable renderable and presence | reference-applicable | H-ws | partial | `packages/reference-host/src/mutation.test.ts:79`, `:137` | Only `component.set` on renderable and on own presence transform; no `component.patch`, no `hvtp.presence@1` component, no cross-participant, no "no presence state change" check |
| C28 | Overlapping replacements serialize by generation | reference-applicable | H-ws, CC-unit, CC-host | covered | `packages/reference-host/src/view-lifecycle.test.ts:121`, `:153`, `:176`; `packages/client-core/src/client.test.ts:306`, `:338` | Touches Slice 7 finding "subscription.applied correlation"; no real-host stale-injection test |
| C29 | Spatial membership predicate | reference-applicable | PT (parse only) | **gap** | `packages/reference-host/src/world-store.test.ts:108` (60 m inside 100 m only) | No boundary-inclusive, 3-D, radius-0, scale/visible-independence test |
| C30 | Snapshot metadata and mutation kinds | reference-applicable | H-ws, H-unit, CC-unit | covered | `packages/reference-host/src/view-lifecycle.test.ts:195`, `:226`; `packages/client-core/src/client.test.ts:78`-`:123` | "Missing" (vs mismatched) identifier not tested |
| C31 | Request-table admission and subscription retries | reference-applicable | H-ws | covered | `packages/reference-host/src/view-lifecycle.test.ts:310`, `:333`, `:121` | None material |
| C32 | Revision/epoch domains, precedence, no-op, overflow | reference-applicable | H-ws, H-unit | partial | `packages/reference-host/src/limits.test.ts:33`, `:69`; `packages/reference-host/src/mutation.test.ts:312`; `packages/reference-host/src/world-store.test.ts:34` | Invalid-domain metadata (0/negative/fractional/string/>max) -> `invalid_message` untested (same hole as C02/C03) |
| C33 | UTF-8, JSON syntax, shape, uncorrelated errors | reference-applicable | H-ws, PT | covered | `packages/reference-host/src/transport.test.ts:69`, `:79`, `:89`, `:101` | None material |
| C34 | Asset base resolution; load failure renderer-local | reference-applicable | 3C, H-ws | partial | `packages/three-client/src/three-adapter.test.ts:219`, `:256`, `:276`; `packages/reference-host/src/limits.test.ts:157`, `:186` | Headless URL resolution has no implementation/test; host invalid-renderable rejection untested; `visible:false` vs spatial membership untested on host |
| C35 | Creation/deletion publication precedence | reference-applicable | H-ws | partial | `packages/reference-host/src/view-lifecycle.test.ts:195`; `packages/reference-host/src/mutation.test.ts:373`, `:312` | "B (invisible) receives neither" never asserted; delete->later-publication delayed variant absent |
| C36 | Live-view overflow explicit | reference-applicable | H-ws | covered | `packages/reference-host/src/view-lifecycle.test.ts:286` (create and move variants) | None material (no client-side integration of the overflow close) |
| C37 | Independent transform/lifecycle trace | independent-consumer-only | (none) | n/a-independent | (none) | No captured trace, no independent consumer |

## 3. Cross-cutting assessments

### 3.1 Do any tests rely on renderer-private messages or state for a protocol assertion?

No test found does. Details:

* Host tests assert only wire messages (via real `ws` or the `P1Session.handleText` return value) and the host's canonical store (`host.worldStore.*`). They also use host-internal test seams (`beforeMutationEnqueue`, `beforeSnapshotEnqueue`, `beforeTransitionEnqueue`, `afterDurableCommit`, `onConnection`, `sendTransport`, `worldStoreOptions.beforeCommit`, direct `worldStore.createEntity`/`replaceMutableComponent`, raw SQLite seeding in `limits.test.ts`). These are host-private, not renderer-private; they are the intended deterministic barriers the spec asks for.
* `packages/reference-host/src/mutation.test.ts:154`, `:201`, `:434` stash `presenceEntityId` / `snapshotMessages` on the socket object; both values come from the public `realm.joined` / snapshot messages.
* client-core tests assert on `client.entities` (frozen canonical `P1ViewEntity` map), client events, and the exact frames in `socket.sent`. No Three types appear.
* three-client tests mix two kinds of assertion. Protocol/state assertions go through client-core (`h.client.entities`, `h.socket.sent`, e.g. `packages/three-client/src/three-adapter.test.ts:139`, `:256`); renderer-interpretation assertions (C17, C18, C34 placeholder, dispose counts) use `Object3D`/`Material` state, which is correct because those cases specify renderer behaviour.
* Caveat 1: `packages/three-client/src/demo/main.ts` exposes `window.hvtpDemo = { client, view }` "for debug/automation". Any future browser E2E for happy-path steps 2-5 and 11-12 will read renderer/scene state through this handle; assertions on protocol facts must still go through `hvtpDemo.client.entities`, not scene objects, to stay inside the "no renderer-private channel" rule.
* Caveat 2: the three-client suite is fed by client-core's hand-built host messages (`packages/client-core/src/test-support.ts`), not by messages emitted by the real host. Drift between those builders and real host output would not be caught by 3C tests (see gap X3/T1).

### 3.2 Client-side requirements: where each is asserted

| Requirement | Client-side (client-core / three) | Host-side | Verdict |
| --- | --- | --- | --- |
| C05 client removal w/o tombstone | `packages/client-core/src/client.test.ts:230` (leave evicts, re-enter rematerializes, causes `["leave","enter","enter"]`); `packages/client-core/src/host-integration.test.ts:113`-`:116` (real host leave); `packages/three-client/src/three-adapter.test.ts:151`, `:185` | Emits leave: `packages/reference-host/src/mutation.test.ts:48`-`:53`, `:395`. Tombstone-absent asserted only for subscription-replacement leave (`packages/reference-host/src/view-lifecycle.test.ts:111`), not for interest leave | Both; host tombstone check missing for interest leave |
| C08 partial-snapshot discard | `packages/client-core/src/client.test.ts:149` (socket drop before end), `:161` (live message interleaved), `:170` (next connect is fresh) | Cancels queued snapshot on close: `packages/reference-host/src/realm-coordinator.test.ts:59`, `packages/reference-host/src/outbound.test.ts:216` | Both |
| C09 sparse seq | `packages/client-core/src/client.test.ts:278` (100 -> 103 -> 9000) | `packages/reference-host/src/mutation.test.ts:352` (observer sees seq 4 after hidden seq 3) | Both |
| C12 no replay | `packages/client-core/src/client.test.ts:425`; `packages/client-core/src/host-integration.test.ts:147` (exactly one frame contains the lost ID) | none (no cross-session dedup test) | Client; host side absent |
| C16/C34 asset resolution, no redirects, size, placeholder | `packages/three-client/src/three-adapter.test.ts:219`, `:256` (10 failure modes), `:276`; client-core has **no** resolver (only stores `assetBaseUri`, `packages/client-core/src/client.test.ts:30`) | Serves fixture, 413 above `maxAssetBytes`, no redirect: `packages/reference-host/src/limits.test.ts:157`, `:186`; `packages/reference-host/src/server.test.ts:105` | Three only; headless resolution unimplemented/untested; host-side validation of renderable state untested |
| C17 numeric assertion | `packages/three-client/src/three-adapter.test.ts:61`, `:74` (Three scene graph) | Host validation of transform domain only `packages/reference-host/src/transport.test.ts:126`-`:130` (1e400) and store-level `packages/reference-host/src/world-store.test.ts:136` | Renderer only for the numeric assertion; no engine-neutral check |
| C18 linear RGBA | `packages/three-client/src/three-adapter.test.ts:93` | domain validation untested (host `validateMaterialState`; client `materialState` in `wire.ts`) | Renderer only |
| C28 stale-generation ignore | `packages/client-core/src/client.test.ts:306` (3 stale kinds -> `publication.stale`), `:338` (cached older `subscription.applied` never reactivates) | Generation tagging/serialization: `packages/reference-host/src/view-lifecycle.test.ts:121`, `:153`, `:176` (host cannot be made to emit a stale message) | Both, but never combined on a real host |
| C30 snapshot metadata mismatch rejection | `packages/client-core/src/client.test.ts:78`, `:87`, `:97`, `:104`, `:115` | Agreement of metadata: `packages/reference-host/src/server.test.ts:52`, `packages/reference-host/src/session.test.ts:75`, `packages/reference-host/src/view-lifecycle.test.ts:195` | Both |

### 3.3 Slice 7 review findings (context only; another worker is fixing them)

* **`subscription.applied` correlation**: `packages/client-core/src/client.ts:442`-`:458` activates a generation purely on `previousSubscriptionId === active`; it never requires `body.ref` to map to a pending `subscription.set`. Touches C07, C28, C31. Tests that exercise the path: `packages/client-core/src/client.test.ts:289`, `:306`, `:338` (third request `ref3` carries a historical S0->S1 response; the `ref1` duplicate at `:365` is the "unsolicited" case), and `packages/client-core/src/host-integration.test.ts:126`. No test sends an `applied` with an **unknown ref whose previous equals the active generation**; if the fix tightens activation this is the missing assertion (gap CC3).
* **Host-ID length parsing**: `packages/client-core/src/wire.ts:40` parses host frames with `parseJsonRequest`, which applies the *request* rule "top-level `id` is non-empty and <=128 UTF-8 bytes" (`packages/protocol-types/src/validation.ts:40`, `:345`). Profile 14.0 makes host publication IDs opaque. Inference: this is the length-parsing finding. No test uses a host `id` longer than 128 bytes; all client-core fixtures use short IDs. Touches C23/C37 (an independent consumer must accept opaque host IDs) and C30. See gap CC5.
* **Leave-reason `authorization`**: `packages/client-core/src/wire.ts:205`-`:207` accepts `subscription | interest | authorization` for both enter and leave; the host only emits `subscription` and `interest`. Tests assert `reason` only for `"subscription"` (`packages/reference-host/src/view-lifecycle.test.ts:109`, `:142`, `:401`); `"interest"` (the C04/C05 case) is never asserted on the host, and `"authorization"` is never exercised. Touches C04, C05, C07, C22 evidence.
* **Three.js dispose lifecycle**: `packages/three-client/src/scene-view.ts:95`-`:113` (`dispose()`, `#reset`) and `asset-loader.ts:66`-`:71`. Tests count only per-entity material disposal (`packages/three-client/src/three-adapter.test.ts:151`-`:183`, `:185`); template geometry, placeholder geometry/material, loader disposal on reset/reconnect (`:202`), and `P1ThreeView.dispose()` itself have no assertions. Touches C05 (re-enter cycles) and C34 (placeholder) only peripherally.

### 3.4 Spec/implementation observations that affect evidence

1. **`maxAssetUriCharacters` (2,048) is advertised in `session.welcome.limits` but never enforced** (`grep` finds it only in `packages/protocol-types/src/index.ts:26`). C16 states "URI/message size violations use `resource_limit`"; today any URI other than `unit-cube.gltf`, including an over-long one, yields `invalid_component_state` (via `validateSharedEntityInput`, `packages/reference-host/src/world-store.ts:325`-`:334`). Needs a lead decision (implement, or amend the case text) before a test can be written.
2. **Host mutations are fully synchronous** (`packages/reference-host/src/session.ts:402`, `#executeMutation`). A mutation is therefore never "admitted but not yet terminal", so C10 Variant A and the pending half of C11 cannot be constructed for `entity.*`/`component.*`; only `subscription.set` (async via the coordinator) has a pending window. C10 says "use a deterministic processing/commit barrier". Lead decision needed: add an async commit seam, or accept `subscription.set` as the pending-state witness and document it.
3. **`component.ephemeral` is state-dependent**: `packages/reference-host/src/session.ts:177` returns `unsupported_message` only when JOINED; in CONNECTED/NEGOTIATED/JOINING it returns `invalid_state` (`:156`-`:172`). The C15 example payload omits `id`; sent literally it is rejected earlier as `invalid_message` (`packages/protocol-types/src/validation.ts:40`). Profile section 2 says P1 "MUST reject `component.ephemeral`" without naming a state; confirm intended code per state.
4. A client->host message whose `type` is a known *host* publication type (e.g. `entity.created`) falls into the `unsupported_message` branch (`packages/reference-host/src/session.ts:152`). C25 lists that input under "reject with `invalid_message` (or `unsupported_message` only when the message `type` itself is unknown)". Whether a host-direction type counts as "unknown" is ambiguous; no test pins either behaviour.
5. Test-quality notes: `packages/reference-host/src/mutation.test.ts:188` attaches the observer listener after the retried create's ack (race-prone, cannot detect a spurious earlier publication); `packages/reference-host/src/view-lifecycle.test.ts:114`-`:115` uses `b.take(2)` so "exactly one `entity.deleted`" is not proven for B; the C02 race uses `component.set` on revision 1, not `component.patch` on revision 5.

## 4. Per-case detail

Row format: `#` sub-assertion | evidence (`path:line`, exact test name in Appendix A) | component | strength | note. "Gaps" list the precise missing assertion and the owning component.

---

### C01 - Happy-path shared persistent entity (reference-applicable) - status: **partial**

| # | Sub-assertion | Evidence | Comp. | Strength | Note |
| --- | --- | --- | --- | --- | --- |
| 1 | Setup: clean realm, A and B joined with overlapping spatial subscriptions, initial snapshots complete | `packages/client-core/src/host-integration.test.ts:57` (lines 59-70) | CC-host | direct | "Browsers" are client-core `P1Client` instances, not the Three view |
| 2 | Creator receives committed `ack` | `packages/client-core/src/host-integration.test.ts:71`-`:72`; `packages/reference-host/src/mutation.test.ts:22`-`:23` | CC-host, H-ws | direct | |
| 3 | B receives exactly one `entity.created`, full materializable entity, no additional `view.entity.enter` for the creation | `packages/reference-host/src/mutation.test.ts:373`-`:393` (observer gets exactly `[entity.created, entity.deleted]`, no enter between); `packages/reference-host/src/view-lifecycle.test.ts:195` ('create' kind: one `entity.created`, then fence returns `[]`); `packages/client-core/src/client.test.ts:197` (created gives full state, only cause `created`); `packages/client-core/src/host-integration.test.ts:73`-`:77` | H-ws, CC-unit, CC-host | direct (host + client separately) | The real-host integration test checks that B materializes the entity but does not assert the event-cause list (`["created"]`) or absence of `enter` |
| 4 | Creation advances realm `seq` once; each later accepted component mutation advances it once | `packages/reference-host/src/mutation.test.ts:67` (seq 4 after create + 3 sets, retry does not advance), `:189`, `:331`-`:333` | H-ws | direct | Integration test does not assert ack `seq` values |
| 5 | Both accepted component mutations advance exactly one component revision each | `packages/client-core/src/host-integration.test.ts:81`, `:86`, `:90`-`:91`; `packages/reference-host/src/mutation.test.ts:35`, `:45` | CC-host, H-ws | direct | |
| 6 | Transform mutation leaves renderable/material revisions and state untouched; material mutation leaves transform/renderable untouched | `packages/client-core/src/host-integration.test.ts:88`-`:92` (final: transform rev 2, renderable rev 1, material rev 2, A==B); `packages/client-core/src/client.test.ts:222`-`:226` (publication replaces only the named component) | CC-host, CC-unit | partial | Isolation of *state* is not asserted at the intermediate step (material state after the move; transform state after the recolor); only final revisions and final colour |
| 7 | Canonical subscriber publications carry full resulting component envelopes | `packages/reference-host/src/mutation.test.ts:43`-`:46`; `packages/client-core/src/client.test.ts:222`-`:226`; `packages/client-core/src/host-integration.test.ts:82`-`:83` | H-ws, CC-unit, CC-host | direct | `authority`/`authorityEpoch`/`consistency` envelope fields are enforced by client-core `envelope()` in `wire.ts`, so real-host integration validates them implicitly |
| 8 | After restart entity, transform, material and revisions match last durable state | `packages/client-core/src/host-integration.test.ts:192`-`:197`; `packages/reference-host/src/server.test.ts:250`-`:256` | CC-host, H-ws | direct | |
| 9 | New host process uses a new `realmEpoch` | `packages/reference-host/src/server.test.ts:202`, `:234`; `packages/client-core/src/host-integration.test.ts:188`-`:190` | H-ws, CC-host | direct | |
| 10 | Action 4: B sends a valid material **patch** at the current revision | `packages/client-core/src/host-integration.test.ts:85` uses `setComponent`, not `patchComponent` | CC-host | partial | `component.patch` on `hvtp.material@1` is never exercised anywhere |

Gaps
* (cross) Run the Three view (`P1ThreeView`) on `P1Client` over a real `ws` host through steps 4-9 and the restart (owner: three-client + cross-component, gap T1/X3).
* (cross/CC-host) In the integration test also assert: B's events for the creation are exactly `[entity.upsert cause "created"]` with no `enter`; ack `seq` increases by one per mutation; after the move, material revision/state unchanged; after the recolor, transform revision/state unchanged.
* (CC-host) Make B's material change a `patchComponent({ baseColor })` to match the case text.

---

### C02 - Concurrent revision conflict (reference-applicable) - status: **partial**

| # | Sub-assertion | Evidence | Comp. | Strength | Note |
| --- | --- | --- | --- | --- | --- |
| 1 | Two requests with same `baseRevision`/`authorityEpoch`: exactly one commits first and creates revision+1 | `packages/reference-host/src/mutation.test.ts:108`-`:130` | H-ws | direct | Uses `component.set` on transform at revision 1, not `component.patch` on material at revision 5; outcome is order-independent |
| 2 | Loser receives `error` `revision_mismatch` with `currentRevision` and `authorityEpoch` | `packages/reference-host/src/mutation.test.ts:126`-`:129` | H-ws | direct | |
| 3 | No silent last-writer-wins | `packages/reference-host/src/mutation.test.ts:125`, `:130` (exactly one ack, seq 2) | H-ws | direct | |
| 4 | `baseRevision` ahead of current (6 vs 5) -> `revision_mismatch` | `packages/reference-host/src/mutation.test.ts:97`-`:101` (base 2 vs current 1; `currentRevision` 1, `authorityEpoch` 1) | H-ws | direct | |
| 5 | Negative / fractional / string / >2^53-1 `baseRevision` -> `invalid_message` | none (code at `packages/protocol-types/src/validation.ts:228`-`:231`; `parseMutationRequest` has no unit test) | - | none | |
| 6 | Concurrent valid updates to *different components* both commit, each advancing only its own revision and realm seq once | none; transform and material updates are only sequential (`packages/client-core/src/host-integration.test.ts:80`, `:85`) | - | none | |
| 7 | Update racing global deletion serializes without resurrection (update-then-delete: both commit, tombstoned; delete-then-update: `entity_not_found`) | `packages/reference-host/src/mutation.test.ts:312`-`:343` covers update, delete, delete-again, recreate sequentially; no update-after-delete and no concurrent race | H-ws | partial | |

Gaps
* (PT + H-ws) `baseRevision` in `{0, -1, 1.5, "5", 2^53}` -> `invalid_message` with `ref`=request id, no seq change. Shared with C03/C32 (gap H6).
* (H-ws) Two sockets concurrently: transform patch and material patch on the same entity -> both ack, each component +1, realm seq +2.
* (H-ws) `component.set` after `entity.delete` -> `entity_not_found`, seq unchanged, state still tombstoned; plus a two-socket race delete vs set asserting both legal orderings.

---

### C03 - Authority epoch must match exactly (reference-applicable) - status: **partial**

| # | Sub-assertion | Evidence | Comp. | Strength | Note |
| --- | --- | --- | --- | --- | --- |
| 1 | Valid-domain `authorityEpoch: 2` -> `authority_epoch_mismatch` | `packages/reference-host/src/mutation.test.ts:319`-`:325` (code asserted, seq unchanged) | H-ws | direct | Error context field `authorityEpoch: 1` (set in `session.ts:420`) is not asserted |
| 2 | Zero, negative, fractional, string, >2^53-1 -> `invalid_message` | none (`validation.ts:228`-`:231`) | - | none | |
| 3 | Domain validation precedes equality comparison | none (e.g. epoch 0 together with a wrong `baseRevision` must yield `invalid_message`, not a mismatch code) | - | none | |

Gaps: PT/H-ws domain matrix (gap H6). Owner: host/protocol-types.

---

### C04 - Entity enters spatial interest (reference-applicable) - status: **covered**

| # | Sub-assertion | Evidence | Comp. | Strength | Note |
| --- | --- | --- | --- | --- | --- |
| 1 | Observer with spatial sub receives `view.entity.enter` at the mutation's realm `seq` | `packages/reference-host/src/view-lifecycle.test.ts:195` ('interest' kind: `event.seq === 2`, active `subscriptionId`); `packages/reference-host/src/mutation.test.ts:395`-`:410` (enter at seq 3); `packages/reference-host/src/mutation.test.ts:26`-`:31` (enter type, subscriptionId) | H-ws | direct | `mutation.test.ts:26` itself does not assert `seq` |
| 2 | Message contains complete authorized current state | `packages/reference-host/src/mutation.test.ts:33`-`:36` (id, transform revision 2 and position), `:411`-`:412` (revision 3) | H-ws | partial | Only the transform component is asserted at the host; renderable/material components of the enter body are not. client-core `viewEntity()` requires all three, but no integration test feeds a real host `enter` to client-core |
| 3 | Observer does NOT receive only a transform patch for an unknown entity | `packages/reference-host/src/mutation.test.ts:29`-`:30` (first message after the mutation is `view.entity.enter`) | H-ws | direct | |
| 4 | Client can materialize without historical state | `packages/client-core/src/client.test.ts:230`-`:243`; `packages/three-client/src/three-adapter.test.ts:151`-`:183` | CC-unit, 3C | direct | |

Gaps (hardening): assert all three components and `reason: "interest"` on the host enter (H-ws); drive a real host interest crossing into a client-core client (cross, gap X2). Touches Slice 7 finding "leave-reason authorization".

---

### C05 - Leave and re-enter (reference-applicable) - status: **covered**

| # | Sub-assertion | Evidence | Comp. | Strength | Note |
| --- | --- | --- | --- | --- | --- |
| 1 | Step 1: A receives `view.entity.leave` | `packages/reference-host/src/mutation.test.ts:48`-`:53`, `:406`-`:410` | H-ws | direct | `reason` not asserted |
| 2 | A removes E from its local view | `packages/client-core/src/client.test.ts:230`-`:234`; `packages/client-core/src/host-integration.test.ts:113`-`:116`; `packages/three-client/src/three-adapter.test.ts:165`-`:168` | CC-unit, CC-host, 3C | direct | |
| 3 | No global deletion tombstone | `packages/client-core/src/client.test.ts:236`-`:243` (re-entry works; no tombstone state exists in client); host: `packages/reference-host/src/view-lifecycle.test.ts:111` (tombstone false) but only for subscription-replacement leave | CC-unit, H-ws | partial | Host does not assert `!isTombstoned` after an *interest* leave (`mutation.test.ts:16`, `:395`) |
| 4 | Step 2: A receives `view.entity.enter` with full current state | `packages/reference-host/src/mutation.test.ts:395`-`:412` (enter, transform revision 3) | H-ws | direct | |
| 5 | Stale local state from earlier incarnation not reused | `packages/client-core/src/client.test.ts:236`-`:243` (entity equals the enter record; earlier revisions/colour not merged); `packages/three-client/src/three-adapter.test.ts:170`-`:177` (new Object3D, colour from enter only) | CC-unit, 3C | direct | |
| 6 | Delayed-enqueue variant: barrier after leave derived, later re-entry committed at N+1 while held | `packages/reference-host/src/mutation.test.ts:395`-`:408` (`beforeMutationEnqueue` holds seq 2; second mutation acked while held) | H-ws | direct | |
| 7 | seq-N leave enqueued before seq-N+1 enter; no overtaking | `packages/reference-host/src/mutation.test.ts:410` (`[leave,2],[enter,3]`) | H-ws | direct | |
| 8 | After both arrive E is present matching canonical state | `packages/reference-host/src/mutation.test.ts:411`-`:412` (enter carries revision 3) | H-ws | partial | Host-message level only; no client applies the delayed pair |

Gaps (hardening): `!isTombstoned` and entity still present after interest leave (H-ws); apply the delayed leave/enter pair through client-core against a real host and assert final map equals store (cross).

---

### C06 - Explicit subscription overrides distance by union (reference-applicable) - status: **partial**

| # | Sub-assertion | Evidence | Comp. | Strength | Note |
| --- | --- | --- | --- | --- | --- |
| 1 | Spatial 25 m + explicit far entity (X=1000): far entity included (union) | `packages/reference-host/src/world-store.test.ts:123`-`:130` (radius 100, far=1000 included via `entities`) | H-unit | direct | Store-level; the join path uses the same `snapshot()` (`session.ts:223`) so wire is indirect |
| 2 | Inclusion conditional on read authorization | `packages/reference-host/src/view-lifecycle.test.ts:244` (C22) | H-ws | direct | see C22 |
| 3 | Omitted spatial + empty entity list -> empty view except own presence | `packages/reference-host/src/world-store.test.ts:114`-`:116`; `packages/reference-host/src/server.test.ts:60`-`:85` (join `{}`: only presence, `entityCount` 1); `packages/reference-host/src/view-lifecycle.test.ts:253` | H-unit, H-ws | direct | |
| 4 | Union persists in live projection (pinned entity moved far away keeps `component.updated`, no `leave`; spatial-only entity moved away leaves) | none; `mutation.test.ts:137` pins an entity at the origin; coordinator projection is `realm-coordinator.ts:168`-`:185` | H-ws | none | |
| 5 | Replacement uses union semantics | none beyond presence-id selectors in `packages/reference-host/src/view-lifecycle.test.ts:244` | - | none | |

Gaps (H-ws): join with `{spatial:{radius:25}, entities:[far]}` yields snapshot containing both near and far; live: pinned far entity moves -> `component.updated` (not leave), unpinned near entity moved away -> leave; `subscription.set` with the same union.

---

### C07 - Replacement is a view operation, not deletion (reference-applicable) - status: **covered**

| # | Sub-assertion | Evidence | Comp. | Strength | Note |
| --- | --- | --- | --- | --- | --- |
| 1 | `subscription.applied` first, new `subscriptionId`, `baseRealmSeq` | `packages/reference-host/src/view-lifecycle.test.ts:104`-`:108`, `:397`-`:404` | H-ws | direct | |
| 2 | Then `view.entity.leave` for E | `packages/reference-host/src/view-lifecycle.test.ts:109`-`:110` (reason `subscription`, new subscriptionId, seq 1) | H-ws | direct | |
| 3 | Buffered post-boundary relevant changes afterwards | `packages/reference-host/src/view-lifecycle.test.ts:153`-`:173` (enter at 2, update at 3 on new generation) | H-ws | direct | |
| 4 | Host MUST NOT emit `entity.deleted` for E | `packages/reference-host/src/view-lifecycle.test.ts:104`-`:112` (exactly `[applied, leave]`; entity live, not tombstoned, seq unchanged) | H-ws | direct | |
| 5 | Other subscribers whose view still includes E unaffected | `packages/reference-host/src/view-lifecycle.test.ts:113`-`:116` (B later receives `entity.deleted`; A receives nothing) | H-ws | direct (indirect for "unaffected at replacement time") | |
| 6 | All leaves before all enters at one unchanged seq | `packages/reference-host/src/view-lifecycle.test.ts:390`-`:407` | H-ws | direct | |
| 7 | Client applies replacement | `packages/client-core/src/client.test.ts:289`-`:300`; `packages/client-core/src/host-integration.test.ts:126`-`:145` | CC-unit, CC-host | direct | Touches Slice 7 finding "subscription.applied correlation" |

Gaps: none material.

---

### C08 - Snapshot mutation boundary (reference-applicable) - status: **partial**

| # | Sub-assertion | Evidence | Comp. | Strength | Note |
| --- | --- | --- | --- | --- | --- |
| 1 | Snapshot begin / entity records / end delivered without interleaved live publication | `packages/reference-host/src/view-lifecycle.test.ts:195` (4 kinds; nothing delivered while snapshot batch held, `:203`; exact record sequence `:207`-`:209`; live event only after end `:218`) | H-ws | direct | |
| 2 | Snapshot represents state through `snapshotBaseSeq` | `packages/reference-host/src/view-lifecycle.test.ts:210`-`:217` (base seq 1; pre-change revision 1) | H-ws | direct | Uses a transform `move`, not a material mutation; equivalent |
| 3 | Post-cut change is buffered | `packages/reference-host/src/view-lifecycle.test.ts:202`-`:203` (mutation acked, joiner has 0 messages) | H-ws | direct | |
| 4 | After `realm.snapshot.end`, canonical view change is delivered | `packages/reference-host/src/view-lifecycle.test.ts:218`-`:220` (type by kind, seq 2, joined subscriptionId) | H-ws | direct | |
| 5 | Final client state equals canonical state at the post-cut sequence | none end-to-end (client-core only ever sees hand-built messages) | - | none | |
| 6 | No state applied twice | `packages/reference-host/src/view-lifecycle.test.ts:221` (drain + fence `[]`); client rejects a duplicate `entity.created` (`packages/client-core/src/client.test.ts:253`-`:272`) | H-ws, CC-unit | direct (host) / indirect (client) | |
| 7 | Socket closes before end -> partial snapshot discarded | `packages/client-core/src/client.test.ts:149`-`:159`, `:161`-`:168`; host: `packages/reference-host/src/realm-coordinator.test.ts:59`, `packages/reference-host/src/outbound.test.ts:216` | CC-unit, H-unit | direct | |

Gaps
* (cross, gap X1) client-core `P1Client` against a real host where the snapshot batch is held (`beforeSnapshotEnqueue`), another participant mutates, then released: assert final `client.entities` deep-equals `host.worldStore` for each of update/create/delete/interest.

---

### C09 - Sparse realm sequences (reference-applicable) - status: **covered**

| # | Sub-assertion | Evidence | Comp. | Strength | Note |
| --- | --- | --- | --- | --- | --- |
| 1 | Subscriber legally receives sequences with gaps (e.g. 300 then 303) | `packages/reference-host/src/mutation.test.ts:352`-`:370` (hidden seq 3 skipped; observer's first publication is seq 4) | H-ws | direct | |
| 2 | Client does not treat gap as loss or request resync | `packages/client-core/src/client.test.ts:278`-`:287` (100 -> 103 -> 9000, phase stays `live`, all applied) | CC-unit | direct | Does not assert `h.socket.sent` unchanged (no resync/join frame); minor |
| 3 | Equal seq is not a dedup key | `packages/client-core/src/client.test.ts:289`-`:300`; host `packages/reference-host/src/view-lifecycle.test.ts:143` | CC-unit, H-ws | direct | |

---

### C10 - Duplicate request, same content (reference-applicable) - status: **partial**

| # | Sub-assertion | Evidence | Comp. | Strength | Note |
| --- | --- | --- | --- | --- | --- |
| A1 | Pending duplicate (same ID, structurally equal, reordered keys) refers to one logical operation | `packages/reference-host/src/view-lifecycle.test.ts:128`-`:129` (`subscription.set` S1 resent byte-identical while blocked at the transition barrier) | H-ws | partial | Only `subscription.set`; keys not reordered while pending; mutations cannot be pending (synchronous host, observation 3.4-2) |
| A2 | No unbounded waiter per retransmission | `packages/reference-host/src/view-lifecycle.test.ts:310`-`:320` (duplicate of a pending ID returns nothing and does not consume pending capacity) | H-ws | indirect | |
| A3 | Exactly one mutation executes | `packages/reference-host/src/view-lifecycle.test.ts:135`-`:143` (one applied/leave pair, seq unchanged) | H-ws | partial | subscription replacement, not a durable mutation |
| A4 | Eventual terminal result is the same logical result | `packages/reference-host/src/view-lifecycle.test.ts:136`-`:145` | H-ws | direct (subscription only) | |
| B1 | Duplicate after completion returns cached terminal | `packages/reference-host/src/mutation.test.ts:55`-`:64` (reordered-key retry `deepEqual` the original ack); `packages/reference-host/src/rate-limit.test.ts:103`; `packages/reference-host/src/mutation.test.ts:332`; `packages/reference-host/src/view-lifecycle.test.ts:144` | H-ws, H-unit | direct | |
| B2 | No world mutation re-executed; revision and seq do not advance | `packages/reference-host/src/mutation.test.ts:67`, `:333`; `packages/reference-host/src/rate-limit.test.ts:105` | H-ws, H-unit | direct | |
| B3 | Cached retry does not rebroadcast historical `component.updated`, `entity.created`, `entity.deleted`, `view.entity.enter`, `view.entity.leave` | `packages/reference-host/src/mutation.test.ts:55`-`:66` (observer sees 0 messages after retry of a leave-producing mutation); `packages/reference-host/src/view-lifecycle.test.ts:145` (subscription enter/leave) | H-ws | partial | No retry test for cached create, delete, enter-producing or plain-update mutations |
| B4 | Repeat for a cached terminal **error**: same error returned, operation not reprocessed | `packages/reference-host/src/view-lifecycle.test.ts:274`-`:276` (cached `resource_limit` of `subscription.set` replayed `deepEqual`) | H-ws | partial | Mutation errors (e.g. `revision_mismatch`, `invalid_component_state`) never retried; `rate-limit.test.ts:99`-`:100` shows the opposite (refusals are *not* cached) |

Gaps
* (H-ws) Retry a mutation that returned `revision_mismatch`/`entity_not_found`, after changing the world so reprocessing would yield a different answer (e.g. delete the entity): assert the original error is replayed byte-identically and no publication.
* (H-ws) Retry cached create / delete / enter-producing mutation: observer receives 0 messages, seq unchanged.
* (H-ws) Key-reordered duplicate while a `subscription.set` is pending.
* (lead decision) Mutation Variant A: needs an async commit seam in the host or an accepted waiver.

---

### C11 - Duplicate request ID, different content (reference-applicable) - status: **covered**

| # | Sub-assertion | Evidence | Comp. | Strength | Note |
| --- | --- | --- | --- | --- | --- |
| 1 | Different content while original pending -> `request_id_conflict` | `packages/reference-host/src/view-lifecycle.test.ts:129`-`:130`, `:317`-`:319` | H-ws | direct | `subscription.set` only |
| 2 | Different content after cached terminal -> `request_id_conflict` | `packages/reference-host/src/mutation.test.ts:69`-`:71`; `packages/reference-host/src/rate-limit.test.ts:104`; `packages/reference-host/src/view-lifecycle.test.ts:344` | H-ws, H-unit | direct | |
| 3 | Original continues to its own unchanged terminal outcome | `packages/reference-host/src/view-lifecycle.test.ts:135`-`:138` (pending original still completes); completed case not re-queried after the conflict | H-ws | direct (pending) / partial (completed) | |
| 4 | No second world mutation | `packages/reference-host/src/mutation.test.ts:71` (seq 4); `packages/reference-host/src/rate-limit.test.ts:105` | H-ws, H-unit | direct | |

---

### C12 - Lost reply across reconnect is explicitly uncertain (reference-applicable) - status: **covered**

| # | Sub-assertion | Evidence | Comp. | Strength | Note |
| --- | --- | --- | --- | --- | --- |
| 1 | Old-session dedup state not assumed | client: `packages/client-core/src/client.test.ts:448`-`:451`; host: none (no test that a new session re-evaluates a previously used request ID) | CC-unit, - | direct (client) / none (host) | low risk |
| 2 | A takes a fresh snapshot | `packages/client-core/src/client.test.ts:449`-`:452`; `packages/client-core/src/host-integration.test.ts:185`-`:200` (new frames are exactly `session.hello`, `realm.join`) | CC-unit, CC-host | direct | |
| 3 | A determines canonical state from the snapshot | `packages/client-core/src/host-integration.test.ts:192`-`:197` (uncommitted-looking move revealed as revision 3) | CC-host | direct | |
| 4 | A does not automatically replay the old mutation ID | `packages/client-core/src/client.test.ts:450`-`:451`; `packages/client-core/src/host-integration.test.ts:201` (lost ID appears in exactly one sent frame) | CC-unit, CC-host | direct | |
| 5 | A new mutation uses the current revision and a new ID | `packages/client-core/src/client.test.ts:453`-`:457`; `packages/client-core/src/host-integration.test.ts:203`-`:207` | CC-unit, CC-host | direct | |
| 6 | In-flight request surfaces as uncertain | `packages/client-core/src/client.test.ts:434`-`:435`, `:443`-`:444`; `packages/client-core/src/host-integration.test.ts:176` | CC-unit, CC-host | direct | |

Gap (low, H-ws): reuse request ID X in a second session for a mutation already committed in the first -> executes as a new request (`revision_mismatch`), proving no cross-session dedup.

---

### C13 - Mutation outside requester's subscription still has terminal result (reference-applicable) - status: **covered**

| # | Sub-assertion | Evidence | Comp. | Strength | Note |
| --- | --- | --- | --- | --- | --- |
| 1 | A receives terminal `ack` directly | `packages/client-core/src/host-integration.test.ts:114`-`:115` (A, radius 10, patches its entity to x=50; ack revision 2); `packages/client-core/src/client.test.ts:403`-`:411` | CC-host, CC-unit | direct | |
| 2 | A receives `view.entity.leave` as appropriate | `packages/client-core/src/host-integration.test.ts:113`, `:116` (A's view loses the entity); `packages/client-core/src/client.test.ts:408`, `:411` | CC-host, CC-unit | direct | Observed via client state, not by capturing the frame |
| 3 | Success reporting does not depend on `component.updated` | `packages/client-core/src/client.test.ts:408`-`:410` (ack resolves with no `component.updated`); `packages/client-core/src/host-integration.test.ts:114`-`:118` | CC-unit, CC-host | direct | B (radius 100) still sees the move (`:117`) |

---

### C14 - Presence binding impersonation is rejected (reference-applicable) - status: **partial**

| # | Sub-assertion | Evidence | Comp. | Strength | Note |
| --- | --- | --- | --- | --- | --- |
| 1 | Create an entity containing `hvtp.presence@1` bound to B -> `not_authorized`/`presence_binding_violation` | `packages/reference-host/src/mutation.test.ts:225`-`:247` (components include a presence component; error, no entity, no tombstone, seq 0, no publication) | H-ws | partial | Presence state in the request names a made-up participant ID, not B's actual `participantId` (rejection is on the component's presence, so the code path is the same) |
| 2 | Create an entity using A's / B's presence entity ID | `packages/reference-host/src/mutation.test.ts:196`-`:223` | H-ws | direct | extra to the case text |
| 3 | Set/patch B's `hvtp.presence@1` | none (`session.ts:460`-`:465` rejects any mutation targeting a private presence entity) | - | none | |
| 4 | Set/patch B's presence transform | none | - | none | cross-participant path never exercised |
| 5 | Set/patch A's own presence transform | `packages/reference-host/src/mutation.test.ts:154`-`:162` (`component.set` -> `presence_binding_violation`, seq 2 unchanged) | H-ws | partial | `component.set` only; `component.patch` untested |
| 6 | Globally delete A's own presence entity | none (`session.ts:445`-`:447`) | - | none | |
| 7 | Globally delete B's presence entity | none | - | none | |
| 8 | Each rejection is `not_authorized` or `presence_binding_violation`; no state mutation | see rows 1, 2, 5 | H-ws | partial | |
| 9 | B's disconnect removes B's presence without tombstone or realm-seq mutation | `packages/reference-host/src/outbound.test.ts:216`-`:252` (`privatePresenceCount` 1 -> 0 on close) | H-ws | partial | No seq/tombstone assertion (presence never touches the store, so low risk) |
| 10 | A never receives B's private presence state | `packages/reference-host/src/view-lifecycle.test.ts:244`-`:262` | H-ws | direct | see C22 |

Gaps (H-ws, gap H3): for participants A and B: `component.set` and `component.patch` of `hvtp.presence@1` and `hvtp.transform@1` on A's and on B's presence entity ID; `entity.delete` of both; each rejected with `presence_binding_violation` (or `not_authorized`), `getRealmSeq()` unchanged, no publication to either peer, presence entity still in a fresh snapshot of its owner.

---

### C15 - Ephemeral traffic is rejected in P1 (reference-applicable) - status: **gap**

| # | Sub-assertion | Evidence | Comp. | Strength | Note |
| --- | --- | --- | --- | --- | --- |
| 1 | `component.ephemeral` -> `unsupported_message` | none (no test file contains the string `ephemeral`); implementation `packages/reference-host/src/session.ts:177`-`:179` | - | none | Only reachable in JOINED; earlier states return `invalid_state` |
| 2 | Message does not mutate an authoritative component or bypass persistence/revision rules | none | - | none | |
| 3 | Example payload (no `id`) | none; literal example gets `invalid_message`, ref null (`validation.ts:40`) | - | none | observation 3.4-3 |

Gaps (H-ws, gap H2): joined peer sends a full `component.ephemeral` envelope (with `id`, `realm`, plausible body) -> `error`/`unsupported_message`, `ref` = id, `getRealmSeq()` and all revisions unchanged, observer gets nothing, session still JOINED (next mutation succeeds); state matrix for CONNECTED/NEGOTIATED/JOINING with the agreed code; example form without `id` -> `invalid_message` ref null.

---

### C16 - Renderable fixture is explicit (reference-applicable) - status: **partial**

| # | Sub-assertion | Evidence | Comp. | Strength | Note |
| --- | --- | --- | --- | --- | --- |
| 1 | Create request includes `hvtp.renderable@1` with exactly the fixture value | `packages/client-core/src/client.test.ts:379`-`:383`; all host create helpers (`packages/reference-host/src/test-support.ts:29`-`:44`) send it | CC-unit, H-ws | direct | |
| 2 | Host rejects any other URI, media type, or node with `invalid_component_state` | none (`world-store.ts:325`-`:334`) | - | none | |
| 3 | `visible` must be a JSON boolean | none | - | none | |
| 4 | URI/message size violations use `resource_limit` | message size: `packages/reference-host/src/transport.test.ts:35`-`:59` (connection closed 1009, no reply; permitted by C21); URI size: none and not implemented (`maxAssetUriCharacters` never read) | H-ws | partial | observation 3.4-1 |
| 5 | Client resolves `unit-cube.gltf` against `session.welcome.assetBaseUri` | `packages/three-client/src/three-adapter.test.ts:219`-`:229` (fetch URL equals `http://127.0.0.1:8787/assets/p1/unit-cube.gltf`; `resolve()` for another base) | 3C | direct | client-core has no resolver; headless path absent |
| 6 | Client does not follow redirects | `packages/three-client/src/three-adapter.test.ts:224` (`redirect: "manual"`), `:234` ('redirect' failure case) | 3C | direct | |
| 7 | Client enforces `maxAssetBytes` | `packages/three-client/src/three-adapter.test.ts:238`-`:245` (declared length and streamed body) | 3C | direct | |
| 8 | Local-only placeholder on fetch/validation failure, no shared mutation | `packages/three-client/src/three-adapter.test.ts:256`-`:273` (10 failure modes; sent frames stay `["session.hello","realm.join"]`; canonical map unchanged) | 3C | direct | |
| 9 | Client does not infer geometry from entity ID, display name, or test case | `packages/three-client/src/three-adapter.test.ts:262`-`:263` (generic placeholder, no `UnitCube` child) | 3C | indirect | |

Gaps
* (H-ws, gap H4) `entity.create` with `uri:"other.gltf"`, `mediaType:"model/gltf+json; x"`, `node:"Other"`, `visible:"true"`, `visible:1`: each `invalid_component_state`, no entity/tombstone/seq change.
* (lead decision + H-ws) over-2,048-char `asset.uri`: spec says `resource_limit`, implementation says `invalid_component_state`.
* (client-core/agent) shared URL resolver used by both Three and the headless agent; test equality across base URIs.

---

### C17 - Transform validation and interpretation (reference-applicable) - status: **partial**

| # | Sub-assertion | Evidence | Comp. | Strength | Note |
| --- | --- | --- | --- | --- | --- |
| 1 | Literal `NaN`/`Infinity` are invalid JSON, handled as malformed input | `packages/reference-host/src/transport.test.ts:112`-`:113` (`invalid_json`, ref null) | H-ws | direct | |
| 2 | `1e400` decoded as non-finite -> `invalid_component_state` | `packages/reference-host/src/transport.test.ts:126`-`:130` (`component.set`, ref = request id) | H-ws | direct | `entity.create` and `component.patch` forms untested |
| 3 | Quaternion norm off by more than 1e-5 | none (`world-store.ts:380`-`:383`) | - | none | |
| 4 | Wrong vector lengths/types | none | - | none | |
| 5 | Zero or negative scale | `packages/reference-host/src/world-store.test.ts:136`-`:165` (scale `[0,1,1]` at store level) | H-unit | partial | zero only, no negative, not over the wire |
| 6 | Scale > 1000 | none | - | none | |
| 7 | Position outside P1 coordinate range | none | - | none | |
| 8 | Renderer interprets quaternion `[x,y,z,w]`, metres, right-handed, +Y up, +Z forward, active `T x R x S` after the glTF node | `packages/three-client/src/three-adapter.test.ts:74`-`:87`, `:61`-`:72` | 3C | direct | Three-specific |
| 9 | Numerical assertion: local `[0.5,0.5,0.5]`, T=0, S=`[2,1,1]`, +90 deg about +Z -> `[-0.5,1.0,0.5]` within 1e-6 | `packages/three-client/src/three-adapter.test.ts:61`-`:72` (through the loaded `UnitCube` node of the real fixture); `:74`-`:87` (composition with T) | 3C | direct | No engine-neutral/independent evaluation (that is C23/C37) |
| 10 | client-core rejects out-of-domain host transforms | none (`wire.ts` `transformState`) | - | none | |

Gaps: host transform-domain matrix over the wire for create/set/patch (H-ws, gap H5); client-core protocol-violation tests for out-of-domain host transforms in snapshot, enter, created, updated (CC-unit, gap CC1).

---

### C18 - Material interpretation (reference-applicable) - status: **partial**

| # | Sub-assertion | Evidence | Comp. | Strength | Note |
| --- | --- | --- | --- | --- | --- |
| 1 | `baseColor [0.25,0.5,0.75,1]` interpreted as linear-light RGBA factors | `packages/three-client/src/three-adapter.test.ts:93`-`:107` (colour stored 0.25/0.5/0.75 unconverted, equals linear-sRGB `setRGB`; alpha -> opacity/transparent) | 3C | direct | "Two conforming clients" agreement is C23 |
| 2 | Values outside `[0,1]` -> `invalid_component_state` | none (`world-store.ts:386`-`:404`) | - | none | |
| 3 | Non-finite values | none | - | none | |
| 4 | Wrong-length arrays | none | - | none | |
| 5 | client-core rejects out-of-domain host material | none (`wire.ts` `materialState`) | - | none | |

Gaps: host matrix for create/set/patch (H-ws, gap H5) and `component.patch` on `baseColor` (also closes C01 row 10); client-core violation tests (CC1).

---

### C19 - Durable commit failure (reference-applicable) - status: **partial**

| # | Sub-assertion | Evidence | Comp. | Strength | Note |
| --- | --- | --- | --- | --- | --- |
| 1 | No `ack` with `committed` on failure | `packages/reference-host/src/mutation.test.ts:178`-`:180` (reply is `error`); `packages/reference-host/src/world-store.test.ts:173`-`:176` | H-ws, H-unit | direct | |
| 2 | No canonical subscriber publication | `packages/reference-host/src/mutation.test.ts:176`-`:189` (observer's next message after the *retry* is `entity.created`) | H-ws | partial | Listener is attached after the retry's ack (`:188`); a spurious publication from the faulted attempt could be missed; `seq` not asserted. By construction `publish()` runs after commit (`session.ts:440`) |
| 3 | After recovery/restart canonical state remains at previous revision | `packages/reference-host/src/world-store.test.ts:177`-`:186` (same process, no restart) | H-unit | partial | No test closes and reopens the DB after a fault |
| 4 | Error returned when safe; storage detail not exposed | `packages/reference-host/src/mutation.test.ts:179`-`:181` | H-ws | direct | |
| 5 | Repeat for create: entity, tombstone, revisions, seq atomic | `packages/reference-host/src/mutation.test.ts:182`-`:184` (no entity, no tombstone, seq 0) | H-ws | direct | |
| 6 | Repeat for component replace and delete/tombstone | `packages/reference-host/src/world-store.test.ts:167`-`:190` (rollback of revision, state, seq; delete leaves entity live, not tombstoned) | H-unit | partial | No wire-level set/delete fault test |
| 7 | Failure after durable commit, before ACK/publication: no rollback, no false rejection | `packages/reference-host/src/mutation.test.ts:281`-`:310` (publication still reaches observer, requester closed 1011, store keeps entity, fresh snapshot shows it); `packages/client-core/src/host-integration.test.ts:147`-`:216` | H-ws, CC-host | direct | |
| 8 | C12 semantics apply to the disconnected requester | `packages/client-core/src/host-integration.test.ts:172`-`:207` | CC-host | direct | |

Gaps: wire-level set/patch and delete with `beforeCommit` fault (state, revision, tombstone, seq, no ack, no publication; observer peer registered *before* the faulted request); reopen the file DB after a fault and assert previous revision (H-ws/H-unit, gap H12).

---

### C20 - Restart invalidates session-scoped state (reference-applicable) - status: **partial**

| # | Sub-assertion | Evidence | Comp. | Strength | Note |
| --- | --- | --- | --- | --- | --- |
| 1 | Old connections terminate on restart | none (`ReferenceHost.close()` closes clients 1001, `server.ts:151`, but no test has connected sockets when it runs; `host-integration.test.ts:147` disconnects clients via `afterDurableCommit` terminate before `first.close()`) | - | none | |
| 2 | New sessions receive a new `realmEpoch` E2 != E1 | `packages/reference-host/src/server.test.ts:202`; `packages/client-core/src/host-integration.test.ts:188`-`:190` | H-ws, CC-host | direct | |
| 3 | Old participant IDs, presence entities, subscriptions, request-dedup caches not valid | `packages/reference-host/src/server.test.ts:258`-`:260` (a presence entity exists only for the new session); no assertion that old IDs are absent or not reusable | H-ws | indirect | structurally session-scoped in memory |
| 4 | Durable non-presence entities and tombstones remain | `packages/reference-host/src/server.test.ts:165`-`:262` (entity + revisions); `packages/reference-host/src/world-store.test.ts:34`-`:71` (tombstone after reopen) | H-ws, H-unit | direct | tombstone only at store level |
| 5 | Tombstoned ID remains non-reusable after restart | `packages/reference-host/src/world-store.test.ts:72`-`:75` (store `entity_exists`) | H-unit | partial | not over the wire after a host restart |
| 6 | In-flight old-session requests do not resume | `packages/client-core/src/host-integration.test.ts:183`-`:201` | CC-host | direct | |
| 7 | Reconnecting clients take new snapshots; seq domain resets | `packages/client-core/src/host-integration.test.ts:185`-`:197`; `packages/reference-host/src/server.test.ts:203`, `:234`-`:237` | CC-host, H-ws | direct | |

Gaps (cross, gap X4 + H8): host with two connected clients restarts -> both observe close; on the new host a wire `entity.create` of a pre-restart tombstoned ID returns `entity_exists`; old `participantId`/presence ID absent from the new snapshot.

---

### C21 - Resource limits (reference-applicable) - status: **covered**

| # | Limit / variant | Evidence | Comp. | Strength | Note |
| --- | --- | --- | --- | --- | --- |
| 1 | Reassembled message > `maxMessageBytes` (single frame) and exact-limit accepted | `packages/reference-host/src/transport.test.ts:35`-`:47` | H-ws | direct | close 1009, nothing executed |
| 2 | Fragmented message, each fragment small | `packages/reference-host/src/transport.test.ts:49`-`:59`; within-limit `:61`-`:67` | H-ws | direct | |
| 3 | Subscription radius > max | `packages/protocol-types/src/validation.test.ts:151`-`:161`, `:188`-`:189` (`resource_limit`); `packages/reference-host/src/session.test.ts:158`-`:175` (join, state stays NEGOTIATED) | PT, H-unit | partial | No `subscription.set` over-radius test through the session/wire (shares the same parser) |
| 4 | Too many explicit entity IDs | `packages/protocol-types/src/validation.test.ts:164`-`:178`, `:187`-`:189` | PT | partial | parser level only |
| 5 | Entity serialization > `maxEntityBytes` | `packages/reference-host/src/limits.test.ts:134`-`:153` (argues worst-case valid entity < 4 KiB) | H-unit | indirect | `ensureEntitySize` is never triggered; unreachable by construction |
| 6 | Join / replacement view > `maxVisibleEntitiesPerConnection`; previous/no view preserved | join: `packages/reference-host/src/view-lifecycle.test.ts:301`-`:305` (rejected, same connection then joins narrower); replacement: `:264`-`:283` (exact limit accepted, max+1 `resource_limit`, cached error replayed, generation unchanged) | H-ws | direct | |
| 7 | Live world mutation grows active view beyond cap | `packages/reference-host/src/view-lifecycle.test.ts:286`-`:307` (create and move) | H-ws | direct | see C36 |
| 8 | Request flooding > `maxClientRequestsPerSecond` | `packages/reference-host/src/rate-limit.test.ts:48`-`:62`, `:64`-`:80`, `:116`-`:151` | H-unit, H-ws | direct | |
| 9 | Durable mutation rate > `maxMutationRequestsPerSecond` | `packages/reference-host/src/rate-limit.test.ts:82`-`:114` | H-unit | direct | session level, not over a socket |
| 10 | Fill `maxPendingStateChangingRequests` | `packages/reference-host/src/view-lifecycle.test.ts:310`-`:331` | H-ws | direct | via pending `subscription.set` |
| 11 | Fill request-dedup table | `packages/reference-host/src/view-lifecycle.test.ts:333`-`:352` | H-ws | direct | |
| 12 | Slow snapshot/subscription consumer exceeding `maxQueuedOutboundBytes` | `packages/reference-host/src/view-lifecycle.test.ts:354`-`:376` (snapshot catch-up), `:409`-`:423` (queued replacements); `packages/reference-host/src/realm-coordinator.test.ts:34`-`:57` (exact vs +1 byte) | H-ws, H-unit | direct | |
| 13 | Outbound queue exhaustion | `packages/reference-host/src/outbound.test.ts:37`-`:53`, `:92`-`:116`, `:157`-`:183`, `:254`-`:311` | H-unit, H-ws | direct | |
| 14 | `maxPersistentEntityRecords` (live + tombstones) | `packages/reference-host/src/limits.test.ts:97`-`:132` | H-ws | direct | create refused without mutation, deletes free nothing, tombstoned IDs not reusable |
| 15 | Host stays bounded / no unbounded allocation | rows 1-14 collectively; `packages/reference-host/src/outbound.test.ts:216`-`:252` (release on close) | H-ws | indirect | |

Gaps (low, hardening): `subscription.set` with radius 501 / 257 IDs through the wire (H-ws); make `maxEntityBytes` injectable to trigger `ensureEntitySize` (H-unit) or record the unreachability argument as the accepted evidence; mutation-rate on a real socket (H-ws).

---

### C22 - Read authorization precedes interest (reference-applicable) - status: **covered**

| # | Sub-assertion | Evidence | Comp. | Strength | Note |
| --- | --- | --- | --- | --- | --- |
| 1 | A explicitly requests B's presence entity -> not in A's effective view | `packages/reference-host/src/view-lifecycle.test.ts:248`-`:251` ("explicit": `subscription.applied`, then no enter after drain + fence) | H-ws | direct | |
| 2 | Combined spatial selector that geometrically includes B's presence -> still omitted | `packages/reference-host/src/view-lifecycle.test.ts:249`-`:251` (B's presence at origin inside radius 10) | H-ws | direct | |
| 3 | Omitted from any snapshot delivered to A | `packages/reference-host/src/view-lifecycle.test.ts:256`-`:259` (third peer joins with B's presence ID + spatial; snapshot has only its own presence); own join `:253`-`:255` | H-ws | direct | |
| 4 | Order: authorization -> interest -> delivery | rows 1-3 | H-ws | direct (behavioural) | `realm-coordinator.ts` `#authorized`; presence never lives in the durable store |
| 5 | Client enforces: foreign presence in a snapshot is rejected | `packages/client-core/src/client.test.ts:134`-`:147` ("foreign presence" case) | CC-unit | direct | extra |

---

### C23 - Second consumer interprets the same fixture - class: **independent-consumer-only** - status: **n/a-independent**

No independent consumer exists and `protocol-spec/fixtures` contains only `unit-cube.gltf` (no captured messages). Sub-assertions the independent consumer must agree on, with the reference-side prerequisite evidence that an independent consumer would be compared against:

| # | Sub-assertion | Reference-side evidence (not an independent proof) | Independent evidence |
| --- | --- | --- | --- |
| 1 | Entity identity | `packages/client-core/src/client.test.ts:197` | none |
| 2 | Component revisions | `packages/client-core/src/client.test.ts:206`; `packages/client-core/src/host-integration.test.ts:77`-`:91` | none |
| 3 | Transform position units (metres) | `packages/three-client/src/three-adapter.test.ts:74` | none |
| 4 | Axis handedness | `packages/three-client/src/three-adapter.test.ts:74`-`:87` | none |
| 5 | Quaternion ordering `[x,y,z,w]` | `packages/three-client/src/three-adapter.test.ts:74`-`:78` | none |
| 6 | Scale | `packages/three-client/src/three-adapter.test.ts:61` | none |
| 7 | Material RGBA values | `packages/three-client/src/three-adapter.test.ts:93` | none |
| 8 | Asset/node reference | `packages/three-client/src/three-adapter.test.ts:219` | none |
| 9 | View-enter/view-leave meaning | `packages/client-core/src/client.test.ts:230` | none |
| 10 | Global deletion meaning | `packages/client-core/src/client.test.ts:245` | none |
| 11 | C17 nonuniform-scale/+90 deg assertion | `packages/three-client/src/three-adapter.test.ts:61` | none |
| 12 | Subscription-generation ordering and stale-message rejection | `packages/client-core/src/client.test.ts:306`, `:338` | none |
| 13 | Creation vs enter and deletion vs leave precedence | host `packages/reference-host/src/view-lifecycle.test.ts:195`; client `packages/client-core/src/client.test.ts:197`, `:245` | none |

Gate note: C23 is allowed to share wire/schema definitions but not Three adapter logic. Prerequisite (gap X5): a captured, replayable trace and a non-Three consumer. Profile 17 allows a "deliberately separate TypeScript consumer that shares schemas/wire definitions but not renderer implementation code"; reusing `@hvtp/client-core` parsing is therefore acceptable, but the transform/material interpretation must be a separate implementation. Slice 7 finding "host-ID length parsing" (`wire.ts:40`) would affect such a consumer if it reuses client-core.

---

### C24 - Global deletion versus view eviction (reference-applicable) - status: **partial**

| # | Sub-assertion | Evidence | Comp. | Strength | Note |
| --- | --- | --- | --- | --- | --- |
| 1 | Step 1: A receives `view.entity.leave` on replacement | `packages/reference-host/src/view-lifecycle.test.ts:109`-`:110` | H-ws | direct | |
| 2 | B continues to see E | `packages/reference-host/src/view-lifecycle.test.ts:113`-`:115` (B later receives `entity.deleted`) | H-ws | direct | |
| 3 | Step 2: B receives exactly one `entity.deleted` and no `view.entity.leave` | `packages/reference-host/src/view-lifecycle.test.ts:114`-`:115` (`take(2)` = `ack` + `entity.deleted`); `packages/reference-host/src/mutation.test.ts:335`-`:338` | H-ws | partial | `take(2)` cannot detect a third message; no fence on B |
| 4 | E globally tombstoned/deleted | `packages/reference-host/src/view-lifecycle.test.ts:117`; `packages/reference-host/src/mutation.test.ts:342` | H-ws | direct | |
| 5 | Deleting E again -> `entity_not_found`, no seq advance | `packages/reference-host/src/mutation.test.ts:339`-`:341` | H-ws | direct | |
| 6 | Recreating same ID -> `entity_exists` | `packages/reference-host/src/mutation.test.ts:343`-`:345`; `packages/reference-host/src/limits.test.ts:126` | H-ws | direct | |
| 7 | After restart the tombstone remains | `packages/reference-host/src/world-store.test.ts:61`-`:75` | H-unit | partial | store only; not over the wire after a host restart |
| 8 | A's later subscription that would have included E does not resurrect it | none | - | none | |
| 9 | Cached/replayed request handling does not rebroadcast the deletion/view transition | none for `entity.delete` retry (retry no-rebroadcast tested for `component.set` only: `mutation.test.ts:55`-`:66`) | - | none | |
| 10 | A is not sent `entity.deleted` for E after having left | `packages/reference-host/src/view-lifecycle.test.ts:116` (fence `[]`) | H-ws | direct | |

Gaps (H-ws, gap H8): after the sequence in the case, A sets `{ entities:["E"] }` -> `subscription.applied`, no enter, E absent from a fresh join snapshot; retry of B's `entity.delete` returns the cached ack, nothing is published, seq unchanged; B fenced to prove exactly one `entity.deleted`.

---

### C25 - Closed JSON shape and duplicate keys (reference-applicable) - status: **partial**

| # | Sub-assertion | Evidence | Comp. | Strength | Note |
| --- | --- | --- | --- | --- | --- |
| 1 | Unknown top-level/body field -> `invalid_message`, `ref` = unique id, no mutation | hello: `packages/protocol-types/src/validation.test.ts:69`-`:76`, `packages/reference-host/src/session.test.ts:65`-`:73`; create (unknown entity field): `packages/reference-host/src/mutation.test.ts:264`-`:271` (code only, `ref` not asserted); subscription.set: `validation.test.ts:195`-`:198` | PT, H-unit, H-ws | partial | `entity.delete` explicit fixture (top-level `unexpected`, ref = UUID, no mutation) is not tested |
| 2 | Duplicate key incl. decoded `"id"` / `"id"` | `packages/protocol-types/src/validation.test.ts:47`-`:56` (ref null), `:58`-`:67` (nested dup keeps top-level ref); `packages/reference-host/src/transport.test.ts:116` | PT, H-ws | direct | |
| 3 | Missing or empty client request ID | none | - | none | |
| 4 | Message/entity ID > 128 UTF-8 bytes | none (empty entity ID only: `mutation.test.ts:255`-`:262`; 128-byte boundary positive: `limits.test.ts:138`) | H-ws | none | 129-byte and multibyte-boundary negatives absent |
| 5 | Participant kind other than `human`/`agent` | none | - | none | |
| 6 | Host-publication type sent client->host | none (only `type:"no.such"` -> `unsupported_message`: `packages/reference-host/src/rate-limit.test.ts:73`) | H-unit | none | observation 3.4-4 |
| 7 | Correlation rule (exactly one valid id -> ref; else null) | `validation.test.ts:47`-`:76`; `transport.test.ts:114`-`:116` | PT, H-ws | direct | |
| 8 | No partial state mutation | `packages/reference-host/src/mutation.test.ts:273`-`:274` | H-ws | direct | |
| 9 | Positive: selector `{}`, entities-only, spatial-only, both accepted | `packages/protocol-types/src/validation.test.ts:87`-`:119`, `:182`-`:186` | PT | direct | |
| 10 | Reject missing fields required by the message subsection | `packages/protocol-types/src/validation.test.ts:78`-`:85` (hello components), `:187`-`:194` (selector) | PT | partial | no negative tests for `parseMutationRequest` bodies |

Gaps (PT + H-ws, gap H7): missing id, `id:""`, 129-byte id, entity id of 129 bytes (and 128 bytes of multibyte), `participant.kind:"bot"`, client sends `entity.created`/`ack`; explicit `entity.delete`+`unexpected` fixture asserting `ref` and unchanged seq.

---

### C26 - Merge Patch cannot delete required component state (reference-applicable) - status: **partial**

| # | Sub-assertion | Evidence | Comp. | Strength | Note |
| --- | --- | --- | --- | --- | --- |
| 1 | `patch:{position:null}` -> `invalid_component_state` | `packages/reference-host/src/mutation.test.ts:85`-`:89` | H-ws | direct | |
| 2 | Prior revision stays canonical; seq unchanged | `packages/reference-host/src/mutation.test.ts:97`-`:101` (later stale request reports `currentRevision` 1, seq 1) | H-ws | indirect | |
| 3 | Empty patch `{}` rejected | none (`session.ts:545`) | - | none | |
| 4 | Non-object patch rejected | none | - | none | |
| 5 | Wrong vector lengths/types | none | - | none | |
| 6 | Unknown patch fields | none | - | none | |
| 7 | Every rejection preserves complete prior state atomically | `packages/reference-host/src/world-store.test.ts:136`-`:165` | H-unit | partial | one store-level case |
| 8 | Valid patch preserves omitted fields (complement) | `packages/reference-host/src/mutation.test.ts:137`-`:152` | H-ws | direct | |

Gaps (H-ws, gap H9): table-driven rejections `{}`, `[]`, `"x"`, `null`, `{position:[1,2]}`, `{position:["a",0,0]}`, `{foo:1}`, `{baseColor:null}` on material; after each assert same revision, state, seq.

---

### C27 - Immutable renderable and presence components (reference-applicable) - status: **partial**

| # | Sub-assertion | Evidence | Comp. | Strength | Note |
| --- | --- | --- | --- | --- | --- |
| 1 | `component.set` on shared entity's renderable -> `not_authorized` | `packages/reference-host/src/mutation.test.ts:91`-`:95` | H-ws | direct | |
| 2 | `component.patch` on renderable | none | - | none | |
| 3 | set/patch on any `hvtp.presence@1` | none | - | none | |
| 4 | set/patch on presence entity transform | `packages/reference-host/src/mutation.test.ts:154`-`:162` (own, `set`) | H-ws | partial | no patch, no other participant |
| 5 | No component revision or realm seq advance | `packages/reference-host/src/mutation.test.ts:101`, `:162` | H-ws | partial | |
| 6 | No session presence state change | none | - | none | |

Gaps: shares gap H3.

---

### C28 - Overlapping subscription replacements serialize by generation (reference-applicable) - status: **covered**

| # | Sub-assertion | Evidence | Comp. | Strength | Note |
| --- | --- | --- | --- | --- | --- |
| 1 | Replacements processed serially per connection | `packages/reference-host/src/view-lifecycle.test.ts:121`-`:151` (S2 admitted while S1 blocked; order applied1, leave, applied2, enter) | H-ws | direct | |
| 2 | S1 batch completes before S2 batch begins | `packages/reference-host/src/view-lifecycle.test.ts:135`-`:136` | H-ws | direct | |
| 3 | After S2: active generation S2 and E present | `packages/reference-host/src/view-lifecycle.test.ts:141`-`:142`, `:146`-`:149`; `packages/client-core/src/host-integration.test.ts:134`-`:140` | H-ws, CC-host | direct | |
| 4 | Subscriber-scoped messages carry `subscriptionId` | `packages/reference-host/src/view-lifecycle.test.ts:140`-`:141`, `:149` | H-ws | direct | |
| 5 | Delayed S1-tagged message after S2 active is ignored | `packages/client-core/src/client.test.ts:324`-`:332` (leave, update, and a second stale update -> 3 `publication.stale`, state unchanged) | CC-unit | direct | Host cannot emit a stale message; never combined with a real host |
| 6 | Same-seq messages not treated as duplicates | `packages/client-core/src/client.test.ts:289`-`:300`; `packages/reference-host/src/view-lifecycle.test.ts:143` | CC-unit, H-ws | direct | |
| 7 | Pre-boundary publication queued before S1 delivered before `applied(S1)` | `packages/reference-host/src/view-lifecycle.test.ts:176`-`:192` | H-ws | direct | |
| 8 | Cached retry returns cached `applied`, no replay of enter/leave | `packages/reference-host/src/view-lifecycle.test.ts:144`-`:145` | H-ws | direct | |
| 9 | Cached S1 returned after S2 active does not reactivate S1 | `packages/client-core/src/client.test.ts:338`-`:370` | CC-unit | direct | Touches Slice 7 finding "subscription.applied correlation" |
| 10 | Canonical cut captured at admission | `packages/reference-host/src/view-lifecycle.test.ts:153`-`:174` | H-ws | direct | extra |

---

### C29 - Spatial membership predicate (reference-applicable) - status: **gap**

| # | Sub-assertion | Evidence | Comp. | Strength | Note |
| --- | --- | --- | --- | --- | --- |
| 1 | `[100,0,0]` selected (inclusive) | none | - | none | predicate `world-store.ts:459`-`:471` |
| 2 | `[100.000001,0,0]` not selected | none | - | none | |
| 3 | `[0,100,0]`, `[0,0,100]` selected | none | - | none | |
| 4 | `[60,80,0]` selected (3-D Euclidean) | none (`world-store.test.ts:111` has x=60 only) | H-unit | none | |
| 5 | Huge/nonuniform scale irrelevant | none | - | none | |
| 6 | `renderable.visible:false` irrelevant | none on host (`three-adapter.test.ts:131` is renderer/view-membership only) | - | none | |
| 7 | Asset geometry/bounds never used | none | - | none | |
| 8 | Radius 0 selects entity exactly at center | none (`mutation.test.ts:204` uses radius 0 with no entity at center) | - | none | |
| 9 | Malformed center length, negative radius, radius > max rejected | `packages/protocol-types/src/validation.test.ts:138`-`:162`, `:187`-`:194`; `packages/reference-host/src/session.test.ts:158`-`:175` | PT, H-unit | direct | non-finite center and out-of-range center untested |

Gaps (H-unit + H-ws, gap H1): store `snapshot()` table over the listed points with center `[0,0,0]`, radius 100, plus scale `[1000,1,1]`, `visible:false`, radius 0 at center; one live wire test where a move to `[100,0,0]` yields `enter` and to `[100.000001,0,0]` yields `leave`; selector with center `1e400` / out of +-1e6 -> `invalid_message`.

---

### C30 - Snapshot metadata and mutation kinds are complete (reference-applicable) - status: **covered**

| # | Sub-assertion | Evidence | Comp. | Strength | Note |
| --- | --- | --- | --- | --- | --- |
| 1 | `realm.joined`, begin, every `entity.snapshot`, end agree on `realmEpoch`, `snapshotId`, `snapshotBaseSeq`; `entityCount` correct | `packages/reference-host/src/server.test.ts:68`-`:85`; `packages/reference-host/src/session.test.ts:108`-`:120`; `packages/reference-host/src/view-lifecycle.test.ts:210`-`:215` | H-ws, H-unit | direct | |
| 2 | Client rejects mismatched `snapshotId` / `snapshotBaseSeq` / `realmEpoch` / `subscriptionId` / `entityCount` without partial activation | `packages/client-core/src/client.test.ts:78`, `:87`, `:97`, `:104`, `:115`, `:125` | CC-unit | direct | |
| 3 | **Missing** identifier or base sequence rejected | none (closed-shape parse in `wire.ts`, not exercised) | - | none | low |
| 4 | Post-cut existing component update buffered, applied once | `packages/reference-host/src/view-lifecycle.test.ts:195` ('update') | H-ws | direct | |
| 5 | Post-cut entity creation | same test ('create') | H-ws | direct | |
| 6 | Post-cut global deletion | same test ('delete') | H-ws | direct | |
| 7 | Post-cut membership crossing | same test ('interest') | H-ws | direct | |
| 8 | Buffered-to-live ordering variant; ACK not a state-through-seq signal | `packages/reference-host/src/view-lifecycle.test.ts:226`-`:242` (ordinary mutation acked while buffered publication held; events then arrive seq 2, 3) | H-ws | direct | client side: `client.test.ts:206`-`:221` (ACK does not change canonical state) |

---

### C31 - Request-table admission and subscription retries (reference-applicable) - status: **covered**

| # | Sub-assertion | Evidence | Comp. | Strength |
| --- | --- | --- | --- | --- |
| 1 | Existing-ID lookup precedes capacity rejection | `packages/reference-host/src/view-lifecycle.test.ts:343`-`:344`; `:317`-`:319` | H-ws | direct |
| 2 | New ID R gets `resource_limit`, not reserved/cached; retry may get it again (also with different content) | `packages/reference-host/src/view-lifecycle.test.ts:345`-`:349` | H-ws | direct |
| 3 | Admitted once capacity returns (pending capacity) | `packages/reference-host/src/view-lifecycle.test.ts:323`-`:329` (dedup-table capacity never frees in a session) | H-ws | direct |
| 4 | Same-content pending retry = one logical operation | `packages/reference-host/src/view-lifecycle.test.ts:128`-`:136` | H-ws | direct |
| 5 | Different-content same-ID -> `request_id_conflict` | `packages/reference-host/src/view-lifecycle.test.ts:130`, `:319`, `:344` | H-ws | direct |
| 6 | Completion yields one `subscription.applied`; completed retry returns cached; no repeated enter/leave | `packages/reference-host/src/view-lifecycle.test.ts:135`-`:145`, `:343` | H-ws | direct |

---

### C32 - Revision/epoch domains, precedence, no-op, overflow (reference-applicable) - status: **partial**

| # | Sub-assertion | Evidence | Comp. | Strength | Note |
| --- | --- | --- | --- | --- | --- |
| 1 | Revision + epoch matching is eligible | `packages/reference-host/src/mutation.test.ts:16` (all successes) | H-ws | direct | |
| 2 | Valid-domain revision 4 or 6 -> `revision_mismatch` | `packages/reference-host/src/mutation.test.ts:97`-`:101` (ahead), `:126`-`:129` (behind) | H-ws | direct | |
| 3 | Valid-domain epoch 2 -> `authority_epoch_mismatch` | `packages/reference-host/src/mutation.test.ts:319`-`:325` | H-ws | direct | |
| 4 | 0/negative/fractional/string/out-of-range metadata -> `invalid_message` | none | - | none | |
| 5 | Domain validation before equality | none | - | none | |
| 6 | No-op `component.set` advances revision once and seq once; retry does not | `packages/reference-host/src/mutation.test.ts:327`-`:333`; `packages/reference-host/src/world-store.test.ts:93`-`:101` | H-ws, H-unit | direct | |
| 7 | Revision `2^53-1` -> `resource_limit` before any state change | `packages/reference-host/src/limits.test.ts:69`-`:95` | H-ws | direct | set and patch |
| 8 | Realm seq `2^53-1` -> `resource_limit` for create/set/patch/delete, nothing changes | `packages/reference-host/src/limits.test.ts:33`-`:67` | H-ws | direct | |

Gaps: shares gap H6.

---

### C33 - UTF-8, JSON syntax, request shape, uncorrelated errors (reference-applicable) - status: **covered**

| # | Sub-assertion | Evidence | Comp. | Strength |
| --- | --- | --- | --- | --- |
| 1 | Invalid UTF-8 reassembled text -> close 1007, later pipelined requests not processed | `packages/reference-host/src/transport.test.ts:69`-`:77`, `:79`-`:87` | H-ws | direct |
| 2 | Valid multibyte split across fragments accepted | `packages/reference-host/src/transport.test.ts:89`-`:99` | H-ws | direct |
| 3 | Truncated `{`; `NaN`/`Infinity` -> `invalid_json`, ref null | `packages/reference-host/src/transport.test.ts:111`-`:113`; `packages/protocol-types/src/validation.test.ts:30`-`:36` | H-ws, PT | direct |
| 4 | `[]`, `null` -> `invalid_message`, ref null | `packages/reference-host/src/transport.test.ts:114`-`:115`; `validation.test.ts:38`-`:45` | H-ws, PT | direct |
| 5 | Duplicate decoded request-ID keys -> `invalid_message`, ref null | `packages/protocol-types/src/validation.test.ts:47`-`:56`; `packages/reference-host/src/transport.test.ts:116` | PT, H-ws | direct |
| 6 | Invalid shape with one valid id -> ref = id | `packages/protocol-types/src/validation.test.ts:58`-`:76`; `packages/reference-host/src/session.test.ts:65` | PT, H-unit | direct |
| 7 | `1e400` in transform -> `invalid_component_state` with parsed id | `packages/reference-host/src/transport.test.ts:126`-`:130` | H-ws | direct |
| 8 | Rejected hello stays CONNECTED; rejected join NEGOTIATED; rejected joined mutation JOINED | `packages/reference-host/src/transport.test.ts:110`-`:134`; `packages/reference-host/src/session.test.ts:158`-`:175` | H-ws, H-unit | direct |

---

### C34 - Asset base resolution and load failure are renderer-local (reference-applicable) - status: **partial**

| # | Sub-assertion | Evidence | Comp. | Strength | Note |
| --- | --- | --- | --- | --- | --- |
| 1 | `welcome` advertises absolute base ending `/` | `packages/reference-host/src/limits.test.ts:175`-`:180`, `:213`-`:242`; `packages/reference-host/src/server.test.ts:45` | H-ws | direct | |
| 2 | Browser and headless resolve to same URL regardless of document origin | browser: `packages/three-client/src/three-adapter.test.ts:219`-`:229`; headless: none | 3C | partial | no headless implementation |
| 3 | Redirects not followed | `packages/three-client/src/three-adapter.test.ts:224`, `:234`; host emits none: `packages/reference-host/src/limits.test.ts:165` | 3C, H-ws | direct | |
| 4 | Wrong URI/media type/node -> invalid component state | host: none; client-side defence: `packages/three-client/src/three-adapter.test.ts:276`-`:281` (local failure) | 3C | partial | host rejection untested |
| 5 | Non-boolean `visible` invalid | none (loader checks it, `asset-loader.ts:48`) | - | none | |
| 6 | Oversized asset is a local load failure | `packages/three-client/src/three-adapter.test.ts:238`-`:245`; host 413: `packages/reference-host/src/limits.test.ts:186`-`:211` | 3C, H-ws | direct | |
| 7 | Fetch failure -> only local placeholder, never shared mutation | `packages/three-client/src/three-adapter.test.ts:256`-`:273` | 3C | direct | |
| 8 | `visible:false` valid and does not affect spatial membership | view: `packages/three-client/src/three-adapter.test.ts:131`-`:137`; host membership: none | 3C | partial | see C29 |

Gaps: host renderable validation (H4), headless resolver parity (A2/CC6), host `visible:false` membership (H1). Touches Slice 7 finding "Three.js dispose lifecycle" (placeholder disposal).

---

### C35 - Creation/deletion publication precedence (reference-applicable) - status: **partial**

| # | Sub-assertion | Evidence | Comp. | Strength | Note |
| --- | --- | --- | --- | --- | --- |
| 1 | Create visible to A: exactly one `entity.created`, active `subscriptionId`, no `view.entity.enter` | `packages/reference-host/src/view-lifecycle.test.ts:195`-`:223` ('create': seq 2, joined subscriptionId, fence `[]`); `packages/reference-host/src/mutation.test.ts:373`-`:393` | H-ws | direct | A-side only; exercised on the snapshot-buffer path |
| 2 | Create invisible to B: B receives neither message | none (B is the creator with `{}` subscription and is never checked) | - | none | |
| 3 | Delete visible to A: exactly one `entity.deleted`, active `subscriptionId`, no `view.entity.leave` | `packages/reference-host/src/view-lifecycle.test.ts:195`-`:223` ('delete'); `packages/reference-host/src/mutation.test.ts:335`-`:338` | H-ws | direct | |
| 4 | Delete invisible to B: neither | none | - | none | |
| 5 | Delete again -> `entity_not_found`, no seq advance | `packages/reference-host/src/mutation.test.ts:339`-`:341` | H-ws | direct | |
| 6 | Create N delayed -> `entity.created` before `entity.deleted` N+1 | `packages/reference-host/src/mutation.test.ts:373`-`:393` | H-ws | direct | |
| 7 | Delete N delayed -> later publication N+1 after it | none | - | none | |

Gaps (H-ws, gap H10): two observers (A in range, B out) assert B queue empty after create and delete; delay `entity.deleted` at seq N via `beforeMutationEnqueue`, commit a later visible create/update, assert order `[deleted N, next N+1]`.

---

### C36 - Live-view overflow is explicit (reference-applicable) - status: **covered**

| # | Sub-assertion | Evidence | Comp. | Strength |
| --- | --- | --- | --- | --- |
| 1 | Realm mutation may commit | `packages/reference-host/src/view-lifecycle.test.ts:294`-`:299` (requester acked, entity stored; both create and move) | H-ws | direct |
| 2 | Affected connection not silently given a partial view; `resource_limit` (ref null) sent, connection closed | `packages/reference-host/src/view-lifecycle.test.ts:297`-`:298` (close 1011) | H-ws | direct |
| 3 | Other connections unaffected | `packages/reference-host/src/view-lifecycle.test.ts:300` | H-ws | direct |
| 4 | Reconnect with same too-broad selector rejected until narrowed | `packages/reference-host/src/view-lifecycle.test.ts:301`-`:305` | H-ws | direct |

Note: client reaction to the uncorrelated error + close is `packages/client-core/src/client.test.ts:461`-`:469`; not combined with a real host.

---

### C37 - Independent transform/lifecycle trace - class: **independent-consumer-only** - status: **n/a-independent**

No captured trace and no independent consumer exist. Trace contents required (all currently producible from `packages/client-core/src/test-support.ts` builders or by recording a real host session through a `socketFactory`): nonuniform `scale [2,1,1]` + +90 deg Z quaternion (reference numeric: `packages/three-client/src/three-adapter.test.ts:61`); a subscription transition with a stale old-generation message injected (reference: `packages/client-core/src/client.test.ts:306`); creation, update, leave/re-enter, global deletion (reference: `client.test.ts:197`, `:206`, `:230`, `:245`). Independent evidence: none (gap X5).


## 5. Prototype Profile section 16 happy path (16 steps)

The headless agent does not exist. "Browser" steps are covered by client-core instances over a real host; the Three view is never exercised against a real host.

| Step | Description | Automated evidence today | Strength |
| --- | --- | --- | --- |
| 1 | Start a clean host | `packages/client-core/src/host-integration.test.ts:57` (in-memory host) | direct |
| 2 | Connect browser A and B | `packages/client-core/src/host-integration.test.ts:59`-`:62` (two `P1Client`s); Three view not on real host | partial |
| 3 | Negotiate 0.2, join with overlapping spatial subscriptions | `packages/client-core/src/host-integration.test.ts:59`-`:70`; hello/join frames `packages/client-core/src/client.test.ts:17`-`:55` | direct |
| 4 | A creates a renderable unit cube | `packages/client-core/src/host-integration.test.ts:71`-`:72`, `:75`-`:76` | direct |
| 5 | B materializes it without reload | `packages/client-core/src/host-integration.test.ts:73`-`:77` (canonical view only; no Three scene) | partial |
| 6 | A moves it | `packages/client-core/src/host-integration.test.ts:80`-`:81` | direct |
| 7 | B receives canonical transform state | `packages/client-core/src/host-integration.test.ts:82`-`:83` | direct |
| 8 | B changes base color | `packages/client-core/src/host-integration.test.ts:85`-`:86` (`component.set`) | direct |
| 9 | A receives canonical material state | `packages/client-core/src/host-integration.test.ts:87`-`:92` | direct |
| 10 | Stop and restart host | `packages/client-core/src/host-integration.test.ts:181`-`:183` (same DB, same port); `packages/reference-host/src/server.test.ts:165` | direct |
| 11 | Reconnect both clients, fresh snapshots | `packages/client-core/src/host-integration.test.ts:185`-`:200` | direct |
| 12 | Cube reappears with last durable revisions | `packages/client-core/src/host-integration.test.ts:191`-`:197` | direct |
| 13 | Connect headless agent participant | none (agent package absent). Partial substitutes: every host test authenticates as `participant.kind:"agent"` (`packages/reference-host/src/test-support.ts:13`-`:19`); `P1Client` supports `participantKind:"agent"` (`packages/client-core/src/client.test.ts:57`-`:63`, fake socket only) | none (partial building blocks) |
| 14 | Agent explicitly subscribes to the cube and reads structured state | explicit-entity join/`subscription.set` on host: `packages/reference-host/src/mutation.test.ts:84`, `packages/reference-host/src/view-lifecycle.test.ts:101`; client `setSubscription({entities})` on real host: `packages/client-core/src/host-integration.test.ts:134` (human kind) | partial |
| 15 | Agent requests an allowed material/transform mutation | agent-kind requester performs mutations: `packages/reference-host/src/mutation.test.ts:16`; client-core path post-restart: `packages/client-core/src/host-integration.test.ts:204`-`:206` (human kind) | partial |
| 16 | Both browser clients observe the accepted canonical result | `packages/client-core/src/host-integration.test.ts:207` (B sees A's post-restart move); not with an agent author, not for both clients, not on the Three view | partial |

Not covered anywhere: one test chaining steps 1-16 on one host lifetime; any Three-view-on-real-host or browser E2E (happy path "browser" literally); the `npm run host` entrypoint.

## 6. Prioritized gap list by owner (each is a test to add)

Priority: P0 = zero or near-zero evidence for a core normative behaviour or security boundary; P1 = broad validation matrices / cross-component proof; P2 = hardening.

### 6.1 Host (`packages/reference-host`, with `packages/protocol-types` parser tests)

* **H1 (P0, C29, C34-8)**: `P1WorldStore.snapshot` table test, center `[0,0,0]`, radius 100: `[100,0,0]`, `[0,100,0]`, `[0,0,100]`, `[60,80,0]` selected; `[100.000001,0,0]` not; radius 0 selects an entity at center only; scale `[1000,1,1]` and `renderable.visible:false` do not change results. Add a wire test where a live move to `[100,0,0]` produces `enter` and to `[100.000001,0,0]` produces `leave`. Add selector tests for non-finite (`1e400`) and out-of-+-1e6 centers -> `invalid_message`.
* **H2 (P0, C15)**: joined peer sends full `component.ephemeral` -> `unsupported_message`, ref = id, seq/revisions unchanged, no publication, session still usable; pin the per-state code (CONNECTED/NEGOTIATED/JOINING) and the no-`id` example form.
* **H3 (P0, C14, C27)**: presence matrix, A and B joined: `component.set` and `component.patch` on `hvtp.presence@1` and `hvtp.transform@1` of A's and B's presence IDs; `entity.delete` of both; `component.patch` on a shared entity's `hvtp.renderable@1`; `component.set`/`patch` of `hvtp.presence@1` on a shared entity. Each: `presence_binding_violation` / `not_authorized` as appropriate, seq unchanged, no publication, presence still present in owner's re-join. Add create with a presence component bound to B's real `participantId`. Add disconnect of B: seq unchanged, nothing tombstoned.
* **H4 (P0/P1, C16, C34)**: `entity.create` with wrong `uri`, `mediaType`, `node`, non-boolean `visible` (`"true"`, `1`) -> `invalid_component_state`, no state/tombstone/seq change. Lead decision on `maxAssetUriCharacters` (spec: `resource_limit`; code: unenforced) then a test for a >2,048-char URI.
* **H5 (P1, C17, C18)**: table over create/set/patch: quaternion norm 1+2e-5, wrong lengths/types for position/rotation/scale, scale 0 / -1 / 1000.0001, position beyond +-1e6, `1e400` in create and patch, `baseColor` with -0.1, 1.1, `1e400`, 3 elements, string -> `invalid_component_state`, state and seq unchanged; `component.patch` on `baseColor` valid case.
* **H6 (P1, C02, C03, C32)**: `authorityEpoch`/`baseRevision` in `{0,-1,1.5,"1",2^53}` -> `invalid_message` with ref; precedence: `authorityEpoch:0` + stale `baseRevision` -> `invalid_message`; add `parseMutationRequest` unit tests in `packages/protocol-types`.
* **H7 (P1, C25)**: missing id, empty id, 129-byte request id and entity id, multibyte 128/129-byte boundary, `participant.kind:"bot"`, host-publication types sent by the client, and the explicit `entity.delete`+`unexpected` fixture (ref = `b4448cc1-...`, no mutation).
* **H8 (P1, C20, C24)**: after the C24 sequence A sets `{entities:["E"]}`: no enter, E absent from a fresh join; retried `entity.delete` returns cached ack with no publication and no seq change; B fenced to prove exactly one `entity.deleted`; over a host restart on the same DB, wire `entity.create` of the tombstoned ID -> `entity_exists`.
* **H9 (P1, C26)**: patch rejection table `{}`, `[]`, `"x"`, `null`, short/non-numeric vectors, unknown field, `baseColor:null`; each leaves revision, state, seq identical.
* **H10 (P1, C35)**: two observers (A visible, B not): B receives nothing for create and delete; delayed `entity.deleted` at seq N followed by a later publication at N+1 arrives in order.
* **H11 (P2, C10, C12)**: cached mutation *error* replay (e.g. `revision_mismatch` then delete entity, retry must still return `revision_mismatch`); cached create/delete/enter-producing retries publish nothing; key-reordered duplicate while `subscription.set` pending; same request ID reused in a second session is processed as new. Lead decision: mutation Variant A needs an async commit seam (observation 3.4-2).
* **H12 (P2, C19)**: wire-level `component.set`/`patch`/`entity.delete` with `beforeCommit` fault (observer registered *before* the request, assert `seq`); reopen file DB after a fault.
* **H13 (P2, C06)**: wire join with spatial+far explicit; live pinned far entity keeps `component.updated`; unpinned near entity moving away leaves.
* **H14 (P2, C04, C05)**: assert enter/leave `reason:"interest"`, all three components in enter body, `!isTombstoned` after interest leave.
* **H15 (P2, C21)**: `subscription.set` with radius 501 and 257 IDs on a socket; mutation rate on a socket; injectable `maxEntityBytes`.
* **H16 (P2, C02)**: concurrent transform+material patches both commit; `component.set` after `entity.delete` -> `entity_not_found`; two-socket delete/set race.

### 6.2 client-core (`packages/client-core`)

* **CC1 (P1, C17, C18, C16)**: `parseHostMessage`/live handling rejects (protocol violation, close 4002) out-of-domain transform, `baseColor`, non-fixture renderable and non-boolean `visible` in snapshot, enter, created and updated.
* **CC2 (P2, C30)**: snapshot messages missing `snapshotId` / `snapshotBaseSeq` are discarded.
* **CC3 (P1, finding context, C28/C31)**: unsolicited `subscription.applied` with unknown `ref` and `previousSubscriptionId` equal to active generation must not activate (post-fix expectation); `ref` of a non-subscription request.
* **CC4 (P2, C09)**: after sparse sequences assert `socket.sent` contains no new frames.
* **CC5 (P2, finding context)**: host frame whose top-level `id` exceeds 128 bytes is accepted as opaque.
* **CC6 (P2, C16/C34)**: shared asset-URI resolver in client-core used by Three and the agent; parity test over several `assetBaseUri` values.
* **CC7 (P2, C28)**: real-host + recording socket that re-injects a recorded S1 frame after S2 is active; ignored.

### 6.3 three-client (`packages/three-client`)

* **T1 (P1, C01, happy path 2-5, 11-12)**: `P1ThreeView` attached to a `P1Client` over a real `ws` host: create, move, recolor, delete, restart rebuild; fixture served by the real asset endpoint; placeholder when the host returns a real redirect (302) and an oversized fixture.
* **T2 (P2, finding context)**: dispose lifecycle: template geometry/material and placeholder resources disposed on reset, reconnect and `dispose()`.

### 6.4 Headless agent (does not exist)

* **A1 (P0 for the gate, happy path 13-16)**: agent joins as `kind:"agent"`, explicitly subscribes to the cube ID, reads structured transform/material state, requests a material or transform mutation, and both client-core "browsers" observe the canonical result; assert presence `kind:"agent"` is only visible to the agent.
* **A2 (P1, C34)**: agent resolves `unit-cube.gltf` to the same URL as the Three loader for the same `assetBaseUri`.
* **A3 (P2, C12, C28)**: agent does not replay an uncertain request ID after reconnect and ignores stale-generation publications (reuse client-core tests through the agent API).

### 6.5 Cross-component

* **X1 (P1, C08, C30)**: real host with `beforeSnapshotEnqueue` held + client-core join: another participant mutates (update / create / delete / interest) during the hold; after release `client.entities` deep-equals the store.
* **X2 (P1, C04, C05)**: real host enter/leave (interest crossing and delayed-enqueue pair) delivered to client-core; final map equals store.
* **X3 (P1, C01)**: see T1.
* **X4 (P1, C20)**: two connected clients, host restart: both see close, reconnect gets new epoch, tombstone enforced on the wire, old participant/presence IDs absent.
* **X5 (P1 for interop gate, C23, C37)**: record a real-host session (nonuniform scale + +90 deg Z, subscription transition with injected stale frame, create/update/leave/re-enter/delete) as a fixture under `protocol-spec/fixtures`, plus an independent non-Three consumer asserting `[-0.5, 1.0, 0.5]` within 1e-6 and the lifecycle outcomes.
* **X6 (P2, C36)**: real host overflow close observed by client-core; reconnect with narrower selector succeeds.

## Appendix A - Exact test names by `path:line`

(Parametrized tests list the loop cases. `path:line` is the `test(` call line.)

### packages/protocol-types/src/validation.test.ts
* :24 `parseSessionHello accepts the closed P1 hello shape`
* :30 `invalid JSON is uncorrelated`
* :38 `valid non-object JSON is invalid_message with null ref`
* :47 `duplicate decoded keys are rejected before shape validation`
* :58 `nested duplicate id preserves the unique top-level request id`
* :69 `closed-shape error preserves a unique request id`
* :78 `P1 hello requires all required components`
* :87 `parseRealmJoin accepts an empty subscription selector`
* :101 `parseRealmJoin accepts spatial and explicit selectors together`
* :121 `parseRealmJoin rejects a different realm`
* :138 `parseRealmJoin rejects invalid spatial values and over-limit radius`
* :164 `parseRealmJoin enforces explicit entity ID count`
* :180 `subscription.set reuses realm.join selector validation and preserves the closed wire envelope`

### packages/reference-host/src/server.test.ts
* :38 `reference host negotiates hello over WebSocket`
* :52 `reference host enqueues the initial presence snapshot in protocol order`
* :105 `reference host serves the checked-in P1 unit cube fixture`
* :165 `reference host recovers durable shared state into a fresh epoch snapshot`

### packages/reference-host/src/session.test.ts
* :44 `session.hello negotiates exactly once`
* :58 `realm message before welcome is invalid_state`
* :65 `invalid closed shape preserves a unique request id`
* :75 `realm.join enqueues joined + one private presence snapshot before JOINED`
* :158 `invalid realm.join leaves the session NEGOTIATED`
* :177 `subscription.set is rejected before JOINED without reserving a request operation`

### packages/reference-host/src/mutation.test.ts
* :16 `real WebSocket mutations deduplicate, publish visibility transitions, and preserve sequence`
* :79 `wire validation rejects merge-patch deletion, immutable renderable, and stale revisions`
* :108 `two WebSocket clients racing the same revision produce one commit and one revision conflict`
* :137 `valid JSON Merge Patch preserves omitted required state and presence remains private`
* :169 `failed durable create returns error and leaves no state, tombstone, sequence, or publication`
* :196 `durable creates cannot collide with this session or another active private presence ID`
* :225 `entity.create with a presence component returns an authorization error without mutation`
* :249 `malformed entity.create with presence still fails closed-shape validation first`
* :281 `response failure after commit publishes canonical state, closes requester, and is confirmed by snapshot`
* :312 `component mutation matches authority epoch, accepts no-op once, and deletion has global precedence`
* :352 `subscriber sequence gaps are sparse and legal`
* :373 `ordered publications keep create N before delete N+1 across delayed enqueue`
* :395 `ordered publications keep leave N before enter N+1 across delayed enqueue`

### packages/reference-host/src/view-lifecycle.test.ts
* :97 `C07/C24 replacement evicts without deletion and later global deletion reaches only visible subscribers`
* :121 `C28/C31 overlapping generations serialize; pending and historical retries do not replay batches`
* :153 `C28 replacement captures exact canonical cut and later mutation uses the queued generation`
* :176 `C28 queued old-view publication finishes before subscription.applied`
* :195 (loop :194 over update, create, delete, interest) `C08/C30 snapshot cut buffers ${kind} exactly once after complete metadata batch`
* :226 `C30 buffered publication cannot be overtaken by later live publication or its ACK`
* :244 `C22 replacement interest never reveals another participant's private presence`
* :264 `C21 replacement accepts exact view limit including own presence and rejects max+1 without changing generation`
* :286 (loop :285 over create, move) `C36 ${kind} commits while overflowing subscriber closes; narrower subscribers and rejoin remain correct`
* :310 `C31 pending-operation admission is bounded, duplicate lookup precedes pending capacity`
* :333 `C31 request-table lookup precedes capacity and cached subscriptions remain exact`
* :354 `C21 snapshot catch-up payload overflow disconnects only affected peer and releases blocked work`
* :378 `transition enqueue failure closes affected generation and preserves durable world state`
* :390 `C07 replacement sends every leave before every enter at one unchanged realm sequence`
* :409 `C21 queued replacement payloads share one bounded buffer and close ambiguous generation`

### packages/reference-host/src/limits.test.ts
* :33 `C32 realm seq 2^53-1: create, component set and delete are resource_limit before any state change`
* :69 `C32 component revision 2^53-1: valid mutation is resource_limit before any state change`
* :97 `C21 persistent budget: live entities plus tombstones fill maxPersistentEntityRecords, deletion frees no capacity`
* :134 `maxEntityBytes is unreachable through valid P1 wire input (worst-case entity is far below the limit)`
* :157 `asset: unit-cube is served 200 with model/gltf+json, no redirect; other paths and methods are 404`
* :186 `asset: fixture larger than maxAssetBytes is 413 with no body; exactly maxAssetBytes is served; missing fixture is 404`
* :213 `HTTPS is required for non-loopback asset origins; loopback HTTP and any HTTPS origin are accepted`
* :244 `asset stream open/read failure never crashes the host`

### packages/reference-host/src/transport.test.ts
* :35 `C21 single-frame text message over maxMessageBytes is not processed and closes with 1009; exactly maxMessageBytes is accepted`
* :49 `C21 fragmented message whose fragments are individually small but reassemble over maxMessageBytes is rejected unexecuted`
* :61 `C21 fragmented message within the limit is reassembled and processed normally`
* :69 `C33 text message with invalid UTF-8 fails the connection with 1007 and later requests are not processed`
* :79 `C33 invalid UTF-8 detected only after reassembly (first fragment ends mid-character) fails with 1007`
* :89 `C33 valid multibyte UTF-8 split across WebSocket fragments is evaluated after reassembly`
* :101 `C33 wire classifications and state-machine preservation: hello stays CONNECTED, join NEGOTIATED, mutation JOINED`

### packages/reference-host/src/outbound.test.ts
* :37 `outbound budget: exact limit is admitted, one more byte is refused, completion releases the reservation`
* :55 `outbound budget: release is exactly-once, failure callback fires once, synchronous failure releases`
* :77 `outbound budget: dispose drops all accounting and late completions are inert`
* :92 `one budget: coordinator reservation and transport-pending bytes are each counted once and compete with direct output`
* :118 `coordinator releases its undelivered reservation when the connection unsubscribes`
* :157 `C21 outbound exhaustion: transport-pending bytes count against the same 4 MiB budget and overflow closes only that connection`
* :185 `transport send failure closes the connection once, releases bytes once, and cancels queued coordinator work`
* :216 `connection close releases reservations, coordinator work, subscription state and private presence`
* :254 `B1: if the exact session.welcome cannot be admitted the connection closes; no substitute error, never left NEGOTIATED`
* :274 `B1: a computed terminal error or committed ACK that cannot fit closes the connection and is never replaced`

### packages/reference-host/src/rate-limit.test.ts
* :36 `sliding window admits exactly \`limit\` per window, expires at the window edge, and does not record refusals`
* :48 `C21 general request rate: first limit requests are processed, the next is resource_limit, window expiry restores service`
* :64 `C21 malformed and decodable-but-invalid requests spend general budget; rejected hello stays CONNECTED`
* :82 `C21 durable mutation rate: new request above the limit executes nothing, reserves no ID, and succeeds after expiry`
* :116 `C21 wire: flooding connection A does not limit connection B; refused requests do not change the view or reserve IDs`

### packages/reference-host/src/realm-coordinator.test.ts
* :34 `coordinator byte admission accepts exactly maxQueuedOutboundBytes and rejects one extra byte`
* :59 `coordinator unsubscribe cancels a blocked snapshot without waiting for its barrier`
* :70 `coordinator partial transition enqueue failure closes the connection and never completes its request`

### packages/reference-host/src/world-store.test.ts
* :34 `durable state/revisions/tombstones survive restart while realm seq resets`
* :108 `snapshot applies P1 spatial and explicit-entity union semantics`
* :136 `failed mutations roll back without advancing sequence`
* :167 `fault injection before commit rolls back component replacement and deletion`

### packages/client-core/src/client.test.ts
* :17 `negotiates HVTP 0.2 as a human participant, joins, and activates the snapshot atomically at end`
* :57 `an agent participant negotiates with kind agent`
* :78 `C30: a mismatched snapshotId discards the snapshot without partial activation`
* :87 `C30: a mismatched snapshotBaseSeq discards the snapshot`
* :97 `C30: a mismatched realmEpoch discards the snapshot`
* :104 `C30: a mismatched subscriptionId at begin or end discards the snapshot`
* :115 `C30: an entityCount that disagrees with the records discards the snapshot`
* :125 `a duplicated entity ID within one snapshot is rejected`
* :134 `snapshot records before begin, structurally invalid entities, or foreign presence are rejected`
* :149 `a partial snapshot never activates when the connection fails before end`
* :161 `a live publication interleaved into an incomplete snapshot is an order violation, not a partial update`
* :170 `after a rejected snapshot the next connect is a fresh session with a fresh snapshot`
* :181 `a rejected realm.join rejects connect with the host error and leaves no session`
* :197 `entity.created adds complete state without a separate view.entity.enter`
* :206 `component.updated replaces the complete component envelope; the request patch is never applied locally`
* :230 `view.entity.leave evicts without a tombstone and view.entity.enter rematerializes from the message alone`
* :245 `entity.deleted removes the entity from the active view`
* :253 `publications that contradict the active view are protocol violations`
* :278 `sparse canonical sequences are accepted and never treated as loss`
* :289 `legitimate messages sharing one realm seq are all applied, not deduplicated`
* :306 `C28: a delayed publication tagged with an old generation is ignored after the new one is active`
* :338 `C28: a cached older subscription.applied resolves its request but never reactivates the old generation`
* :376 `requests use unique IDs, real P1 shapes, and resolve from terminal ack/error only`
* :403 `C13: a move that evicts the entity from the requester's view still resolves from the terminal ack`
* :414 `requests are refused locally unless LIVE, and need a base revision for entities outside the view`
* :425 `C12: disconnect invalidates the session, marks sent mutations uncertain, and never replays them`
* :461 `an uncorrelated host error is surfaced as an event and the host close then invalidates the view`
* :471 `canonical records handed to consumers cannot be mutated`
* :478 `host frames that are not valid P1 JSON close the connection`

### packages/client-core/src/host-integration.test.ts
* :57 `two real clients share create, move, and recolor through the reference host (happy path 1-9)`
* :103 `C13: a move that evicts the requester's own view resolves from the ack; the other view keeps it`
* :126 `C28: serialized subscription replacements on the real host end on the newest generation`
* :147 `host restart: fresh sessions take fresh snapshots in a new epoch; an uncertain write is never replayed`

### packages/three-client/src/three-adapter.test.ts
* :61 `C17: the renderer maps local [0.5,0.5,0.5] through the loaded UnitCube node to [-0.5,1,0.5]`
* :74 `transform mapping is component-wise position/quaternion[x,y,z,w]/scale with T × R × S composition`
* :93 `C18: baseColor is stored as linear RGBA factors without sRGB conversion; alpha drives opacity`
* :109 `applyBaseColor reads frozen canonical state without writing into it`
* :118 `two entities using the cached fixture never share mutable material state`
* :131 `renderable visible:false hides the fixture but keeps canonical state and view membership`
* :139 `own presence stays in canonical state but is not rendered`
* :151 `lifecycle publications add, update, remove, and rebuild renderer objects from canonical state`
* :185 `repeated leave/re-enter cycles do not accumulate objects or undisposed materials`
* :202 `disconnect removes every renderer object; reconnect rebuilds from the fresh snapshot`
* :219 `C34: the fixture URI resolves against the advertised assetBaseUri, without redirects or credentials, once per session`
* :256 (loop :255; cases defined :233-:253) `C34: ${name} falls back to a local placeholder without touching shared state`, name in: redirect; non-200; network error; wrong media type; declared Content-Length above maxAssetBytes; streamed body above maxAssetBytes; malformed glTF JSON; structurally invalid glTF; missing UnitCube node; external buffer reference
* :276 `a renderable that is not the P1 fixture reference is a local load failure`
