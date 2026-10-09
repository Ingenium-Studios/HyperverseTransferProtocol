# P1 headless reference agent and §16 acceptance test: implementation design

Status: **design / investigated**. Nothing here is implemented, merged, released or deployed.
Base studied: Slice 7 PR head `6093344` (detached `slice7-base` worktree). All `file:line` references are to that
commit and **will shift** once the in-flight M1 client-core/three-client fixes land. Paths are repo-relative.

Assumed already fixed by M1 (not designed around): unmatched `subscription.applied` never activates a generation;
the host-frame parser does not apply the 128-byte client-ID rule to host IDs; `view.entity.leave` accepts reason
`authorization` (enter does not); `P1ThreeView` dispose/detach lifecycle.

---

## 0. Decisions at a glance

| Question | Decision |
| --- | --- |
| Client-core changes needed for the agent's protocol behaviour | **None.** Agent kind, join, atomic snapshot, `subscription.set`, revision-fenced requests, terminal outcomes, outcome-uncertain on disconnect, and fresh-session reconnect all exist. |
| Recommended client-core change | **One additive module**: engine-neutral fixture URL resolution + bounded fetch policy + JSON-level fixture inspection (`packages/client-core/src/assets.ts`), extracted from `packages/three-client/src/asset-loader.ts`. Sequenced **after M1**. |
| WebSocket in Node | Node ≥ 22 **global `WebSocket`** through the existing `platformSocketFactory`. No `ws` runtime dependency. Verified against a `ws` server: string `data`, `onclose` codes 1011/1006 surfaced correctly. |
| New package | `packages/agent-client` = `@hvtp/agent-client`; depends only on `@hvtp/client-core` + `@hvtp/protocol-types`; **no `three`**, not even as a devDependency. |
| CLI | `hvtp-agent` (`npm run agent -- …`): deterministic step script, JSON Lines on stdout, fixed exit codes. |
| Uncertain mutation | Never re-sent. Reconnect → fresh snapshot → explicit re-subscribe → compare canonical state to the frozen target → new request ID + current revision only if still unsatisfied. Bounded attempts. |
| Lost-reply fault injection | Existing host seam `afterDurableCommit` **throwing** → host closes **only the requester** with 1011 after durable commit and publication admission, before the ACK (`packages/reference-host/src/session.ts:507-516`). Deterministic; the requester also never receives its own publication. |
| §16 automated test location | New test-only workspace `packages/p1-acceptance` (`@hvtp/p1-acceptance`). Browsers A/B = `P1Client` + `P1ThreeView` in Node with real `fetch`; the agent runs as a **child process via its CLI**. Nothing depends on this package, so there are no cycles. |

---

## 1. client-core API inventory (agent-relevant)

### 1.1 Construction, negotiation, join, snapshot

| Capability | Where | Notes for the agent |
| --- | --- | --- |
| Options | `packages/client-core/src/client.ts:44-56` | `url`, `socketFactory`, `participantKind` (default `human`; **agent passes `"agent"`**, l.48-49), `clientName/clientVersion`, initial `subscription` (default `{}`), `createId`. |
| Phases | `client.ts:23` | `disconnected → connecting → negotiating → joining → snapshot → live`. |
| `connect({subscription?})` | `client.ts:168-224` | One fresh session per call. It resolves only after atomic snapshot activation (l.407-416) and rejects with `P1ConnectionError` on pre-LIVE close or setup error. Socket from `options.socketFactory ?? platformSocketFactory` (l.175). |
| `session.hello` | `client.ts:185-197` | `participant: { kind: options.participantKind ?? "human" }` (l.193). Capabilities = all four P1 components. |
| Welcome handling | `client.ts:307-317` | Stores `participantId`, `assetBaseUri`, `limits`, then sends `realm.join` with the connection's subscription. |
| Welcome validation | `packages/client-core/src/wire.ts:90-113` | `assetBaseUri` must be absolute HTTP(S) ending in `/` (l.99-108). Limits closed shape. |
| Snapshot assembly / atomic activation | `client.ts:354-417` | Private map; activation replaces the view in one step and emits `view.reset{reason:"snapshot"}`. |
| Join-subscription memory | `client.ts:127, 170-171, 450` | After an activated `subscription.applied`, `#joinSubscription` becomes the effective selector, so a later `connect()` **without** an explicit subscription re-joins with it. **The agent always passes `connect({ subscription: {} })`** and then re-subscribes explicitly, so each session shows the explicit `subscription.set`. |

### 1.2 Subscription

| Capability | Where | Notes |
| --- | --- | --- |
| `setSubscription(selector)` | `client.ts:266-268` | Resolves `P1SubscriptionResult { body, activated }` (l.60-67). |
| Activation rule | `client.ts:442-458` | Only `previousSubscriptionId === active` activates (M1 additionally makes unmatched responses non-activating). Emits `subscription.activated`. |
| Transition completion | (none) | P1 has no "transition batch complete" marker. `setSubscription` resolves on `subscription.applied`, **before** the following `view.entity.enter` frames are processed. The agent must wait for the entity with an event predicate (§4.4). |

### 1.3 Requests and terminal outcomes

| Capability | Where | Notes |
| --- | --- | --- |
| `setComponent(entityId, component, state, {baseRevision?, authorityEpoch?})` | `client.ts:255-258` | `component.set`. |
| `patchComponent(...)` | `client.ts:261-264` | `component.patch` (RFC 7396). No optimistic local apply. |
| Default fencing | `client.ts:270-280` | Defaults `baseRevision`/`authorityEpoch` from the canonical view. The call rejects locally with `P1ClientStateError` if the entity is not in view and no explicit values are given. **The agent passes both explicitly** from its observation so its log shows exactly what was fenced. |
| Request send | `client.ts:282-299` | LIVE only. Enforces `maxPendingStateChangingRequests` and `maxMessageBytes`. ID = `createId("req")`. **Synchronous send** inside the Promise executor, so the frame is on the socket when the method returns. The request ID is **not returned** before the terminal result (see §2.3). |
| ACK | `client.ts:426-432` | Resolves with `ack.body` (`ref`, `seq`, `revision`, `authorityEpoch`). |
| Error | `client.ts:333-352` | Correlated → rejects `P1RequestError` (`code`, `ref`, `body.currentRevision`, `body.authorityEpoch`; `packages/client-core/src/errors.ts:14-32`). Uncorrelated → `host.error` event. |
| Other create/delete | `client.ts:234-253` | The agent's default flow does not use them; seeding in tests does. |

### 1.4 Disconnect and uncertainty

| Capability | Where | Notes |
| --- | --- | --- |
| `disconnect()` | `client.ts:227-232` | Close 1000; pending requests become uncertain. |
| Teardown | `client.ts:530-553` | Drops every session-scoped ID and the view (`view.reset{reason:"disconnect"}`). Rejects each pending request with `P1OutcomeUncertainError(requestId, requestType)` (l.550; `errors.ts:34-45`). Emits `closed{code, reason, uncertainRequestIds}` (l.552). Never replays anything. |
| Reconnect | `client.ts:168-169` | The same `P1Client` instance can `connect()` again once `disconnected`. This is proven against the real host in `packages/client-core/src/host-integration.test.ts:147-217`. |

### 1.5 Entity store / read API

| Capability | Where | Notes |
| --- | --- | --- |
| `entities: ReadonlyMap<string, P1ViewEntity>` | `client.ts:155-156` | Deep-frozen canonical records (`wire.ts:343-350`). Empty unless LIVE. |
| `isPresenceEntity(entity)` | `wire.ts:233-235` | Separates shared entities from own presence. |
| Session getters | `client.ts:147-157` | `phase`, `participantId`, `assetBaseUri`, `limits` (→ `maxAssetBytes`), `realmEpoch`, `presenceEntityId`, `subscriptionId`, `effectiveSubscription`, `pendingRequestCount`. **All of them are `null` after teardown**, so the agent captures them per session. |
| Own presence kind | `client.entities.get(client.presenceEntityId)` → `components["hvtp.presence@1"].state.kind` | The host sets kind = negotiated kind (`packages/reference-host/src/session.ts:194, 579-612`). The wire validator accepts `agent` (`wire.ts:279-285`). |
| Fixture constant | `wire.ts:33` | `P1_FIXTURE_RENDERABLE`; renderable shape is enforced on every inbound record (`wire.ts:260-270`). |

### 1.6 Events (`client.ts:27-40`, `on()` l.159-162)

`phase`, `view.reset`, `entity.upsert{cause: created|updated|enter}`, `entity.remove{cause: deleted|leave}`,
`subscription.activated`, `publication.stale`, `host.error`, `protocol.violation`, `closed`.
**Caveat:** `#emit` (l.565-574) rethrows a listener exception in a microtask. In Node that is an uncaught exception
that would kill the CLI, so every agent listener must be total (no throw).

### 1.7 Errors (`packages/client-core/src/errors.ts`)

`P1ClientStateError` (l.9, nothing sent), `P1RequestError` (l.14, terminal reject, nothing committed),
`P1OutcomeUncertainError` (l.34), `P1ProtocolViolationError` (l.47), `P1ConnectionError` (l.52).

### 1.8 `kind: "agent"` support

Already supported end to end: option (`client.ts:48-49`), hello (`client.ts:193`), unit test
`packages/client-core/src/client.test.ts:57-63`, host presence kind (`session.ts:194`, `605`).

### 1.9 Node runtime and browser-only assumptions

- `packages/client-core/src/socket.ts:6-22`: `P1Socket` is the minimal WHATWG surface. `platformSocketFactory` uses
  `globalThis.WebSocket`. Node ≥ 22 has a global (undici) `WebSocket`; root `engines` is `>=22.13.0` and CI uses Node 22.
  A scratch check on Node 24 against a `ws` server confirmed string `event.data`, close 1011 with reason, and abrupt
  terminate → `error` then `close 1006`. **The agent needs no `ws` dependency.**
- `packages/client-core/src/ids.ts:10-20`: `randomId` uses `globalThis.crypto.randomUUID` (available in Node).
- Close codes 1000/4002 (`socket.ts:25-26`) are legal from undici too.
- No DOM use in client-core. **No browser-only assumptions block Node.**
- Node `fetch` (scratch-verified): `redirect: "manual"` returns the raw 3xx (`type: "basic"`), which the existing
  policy treats as "redirect refused". `mode: "cors"` and `credentials: "omit"` are accepted.

### 1.10 three-client: renderer-specific vs reusable

| Piece | Where | Classification |
| --- | --- | --- |
| `P1FixtureLoader.resolve` | `packages/three-client/src/asset-loader.ts:43-45` | Engine-neutral (`new URL(uri, assetBaseUri)`). |
| Fixture-reference check | `asset-loader.ts:47-51` | Engine-neutral. |
| `#fetchBounded` (no redirects, 200 only, media type, declared + streamed size, credentials omitted) | `asset-loader.ts:83-105` | Engine-neutral. |
| `readBounded` | `asset-loader.ts:109-131` | Engine-neutral. |
| `parseFixture` JSON pre-checks (UTF-8, JSON object, embedded `data:` only, node lookup) | `asset-loader.ts:133-149` | Engine-neutral. |
| `GLTFLoader.parseAsync` + `getDependency("node")` | `asset-loader.ts:151-157` | Three-specific. |
| `disposeObject`, `entity-adapter.ts`, placeholder, `scene-view.ts` | — | Three-specific. |
| `P1ViewSource` | `packages/three-client/src/scene-view.ts:11-15` | Read-only view source (`on`, `assetBaseUri`, `limits`); `P1Client` satisfies it. |

Headless use of `P1ThreeView` already works in Node: `packages/three-client/src/three-adapter.test.ts` drives it with
the client-core fake socket harness (l.31-39) and an injected `fetch` (l.23-28). It needs one test-only shim, a
`ProgressEvent` global for GLTFLoader's FileLoader on `data:` buffers (l.13-15). There is no WebGL; assertions are
made on the scene graph.

### 1.11 reference-host: lifecycle, SQLite, asset base, seams

| Item | Where |
| --- | --- |
| `createReferenceHost(options)` | `packages/reference-host/src/server.ts:51-157`. Options l.16-32. Returns `{host, port, realmEpoch, worldStore, realmCoordinator, wsServer, close()}` (l.40-49). |
| SQLite path | `server.ts:58-61`: `options.databasePath ?? HVTP_DB_PATH ?? <cwd>/data/p1.sqlite`. Tests use `":memory:"` or a temp file for restart. |
| Asset route / base | `server.ts:65-97` serves `/assets/p1/unit-cube.gltf` (200, `model/gltf+json`, content-length, `no-store`, CORS `*`). Base `http://<host>:<port>/assets/p1/` (l.116). |
| New epoch per process | `server.ts:117`; realm seq reset (`packages/reference-host/src/world-store.ts:94-99`). |
| Stop | `close()` l.150-156: clients get 1001 `host shutdown`, then the store closes. |
| Restart in tests | New `createReferenceHost({ databasePath, port })` on the **same file and port** (`packages/client-core/src/host-integration.test.ts:147-217`). |
| `npm run host` | `server.ts:235-240`: `PORT` (default 8787), `HOST` (default 127.0.0.1), and `HVTP_DB_PATH`. |
| Seam: post-commit response failure | `afterDurableCommit` (`server.ts:30-31` → `session.ts:507-516`). **If it throws**, the session closes itself and **only the requester** connection gets 1011 `durable mutation committed but response failed`. This happens after the durable commit and after publication admission, with no ACK. The requester's own subscriber is removed synchronously, while coordinator delivery is microtask-pumped (`packages/reference-host/src/realm-coordinator.ts:187-205`), so the requester sees neither ACK nor its own publication. Observers still receive the publication. Host-level evidence: `packages/reference-host/src/mutation.test.ts:281-308`. |
| Seam: pre-commit failure | `worldStoreOptions.beforeCommit` (`world-store.ts:33-36, 285`). Throwing rolls back and the host returns a correlated `error` (C19), so this is **not** an uncertain outcome. |
| Seam: transport write | `sendTransport` (`server.ts:26-27`), per-socket write replacement. |
| Seam: connection observer | `onConnection` (`server.ts:28-29`). |

---

## 2. Gaps and client-core changes

> client-core and three-client are currently owned by the M1 worker. Every change below is **sequenced after M1
> merges**. The agent's protocol work (§3–§5) does not wait for it.

### 2.1 Required for agent protocol behaviour: **none**

Every mission behaviour maps onto §1. The remaining needs are met inside the agent package:

- **Request ID before the terminal result:** a socket tap (wrapping the `P1SocketFactory`) records each outbound
  frame. Because `#request` sends synchronously (`client.ts:295-298`), the frame is recorded by the time
  `setComponent` returns. The tap also powers `--trace-wire`.
- **Knowing when the subscribed entity is in view:** an event predicate with a bounded timeout (§4.4).
- **Presence kind:** read from the canonical own-presence record.

### 2.2 Recommended (small, additive): engine-neutral asset policy in client-core

**Decision: it lives in `@hvtp/client-core`**, in a new `packages/client-core/src/assets.ts` exported from
`packages/client-core/src/index.ts`. The three-client `P1FixtureLoader` delegates to it and keeps only the
`GLTFLoader` parse and dispose.

Why client-core:

1. Profile §12.1 says *"This rule is identical for browser and headless consumers"*. C34 requires *"browser and
   headless clients resolve `unit-cube.gltf` to the same URL"*. One implementation makes that hold by construction,
   so it does not depend on two copies staying in sync.
2. The policy (no redirects, HTTP 200 only, media type, declared and streamed `maxAssetBytes`, credentials omitted,
   embedded-only resources, node present) is security- and limit-relevant. Two drifting copies are a real risk.
3. It has no renderer dependency. Only `GLTFLoader.parseAsync` is Three-specific (`asset-loader.ts:151-157`).
   client-core is the documented engine-neutral layer ("reusable by the future headless agent").

Why not the alternatives:

- **three-client:** the agent may not import it, because it pulls in `three`.
- **agent-only copy:** this duplicates the C34 policy.

Proposed API (pure functions plus injectable `fetch`; no new package dependencies):

```ts
// packages/client-core/src/assets.ts
export type P1FetchLike = (url: string, init: RequestInit) => Promise<Response>;   // moved from three-client
export function resolveP1AssetUrl(assetBaseUri: string, uri: string): string;     // new URL(uri, base).href
export type P1AssetFetchResult =
  | { readonly ok: true; readonly url: string; readonly bytes: Uint8Array }
  | { readonly ok: false; readonly url: string | null; readonly reason: string };
export function fetchP1Fixture(renderable: P1RenderableState,
  options: { readonly assetBaseUri: string; readonly maxAssetBytes: number; readonly fetch?: P1FetchLike }): Promise<P1AssetFetchResult>;
export type P1FixtureInspection =
  | { readonly ok: true; readonly text: string; readonly nodeIndex: number }
  | { readonly ok: false; readonly reason: string };
export function inspectP1FixtureDocument(bytes: Uint8Array, nodeName: string): P1FixtureInspection; // UTF-8, JSON object, data:-only, node lookup
```

The three-client delegation is a mechanical move: `P1FixtureLoader` becomes `fetchP1Fixture` → `inspectP1FixtureDocument`
→ `GLTFLoader.parseAsync`. `three-client` keeps re-exporting `P1FetchLike` for compatibility. The existing
ten-case C34 matrix in `three-adapter.test.ts:219-281` must pass **unchanged**. That is the regression proof.

**Fallback if M1 slips:** the agent ships with the asset check behind its own module boundary
(`src/asset-check.ts`) calling the same function names. The move to client-core then becomes a one-import change.
Prefer waiting, because the change is small.

### 2.3 Considered and rejected (keep client-core untouched)

| Idea | Why not now |
| --- | --- |
| `request.sent` client event, or returning the request ID from `setComponent` | The socket tap gives the same truth from the wire with zero client.ts churn, and client.ts is the M1 hot file. Revisit only if a second consumer needs it. |
| "Transition complete" signal after `subscription.set` | The protocol has no such marker, so client-core cannot know either (open question Q1). |
| Presence-kind getter | One map lookup in the agent is enough. |
| Stop remembering the join subscription | This is existing intended behaviour (README "Subscription generations"). The agent passes an explicit selector. |
| `presence(kind)` parameter in `packages/client-core/src/test-support.ts:60-66` | Optional nicety. The agent's scripted host can build an `agent` presence literal itself. |

---

## 3. Package design: `packages/agent-client` (`@hvtp/agent-client`)

### 3.1 Files

```text
packages/agent-client/
  package.json
  tsconfig.json                 # identical shape to packages/client-core/tsconfig.json (no DOM lib needed)
  src/index.ts                  # public exports
  src/run.ts                    # runAgent(): the deterministic step script (§4.3)
  src/entity-state.ts           # describeEntity(), intentSatisfied(), transformPoint()  (pure)
  src/events.ts                 # P1AgentEvent union, outcome/exit-code table, JSON-lines serializer
  src/wire-tap.ts               # tapSocketFactory(): records outbound frames, optional inbound trace
  src/wait.ts                   # until(client, predicate, {timeoutMs}) → resolves | Disconnected | Timeout
  src/asset-check.ts            # thin wrapper over client-core assets (fetch + inspect); local-only result
  src/args.ts                   # parseAgentArgs(argv) (pure, node:util parseArgs, strict)
  src/cli.ts                    # main(argv, io): parse → runAgent → write JSON lines → return exit code
  src/bin.ts                    # #!/usr/bin/env node; process.exitCode = await main(process.argv.slice(2), …)
  src/test-support.ts           # ScriptedHost over client-core FakeSocket (tests only; not in "exports")
  src/entity-state.test.ts
  src/args.test.ts
  src/run.test.ts               # scripted-host unit tests
  src/host-integration.test.ts  # real in-process reference host, fault injection, restart
  src/cli.test.ts               # spawns dist/bin.js against an in-process host
  src/package-boundary.test.ts  # asserts no three / three-client dependency or import
```

`bin.ts` is kept separate from `cli.ts` so importing `main` has no side effects. This avoids the fragile
`process.argv[1] === fileURLToPath(import.meta.url)` guard, which breaks under npm bin shims on Windows.

### 3.2 Public API (`src/index.ts`)

```ts
export type P1AgentIntent =
  | { readonly kind: "material"; readonly baseColor: readonly [number, number, number, number] } // component.set
  | { readonly kind: "position"; readonly position: readonly [number, number, number] };        // component.patch {position}

export interface P1AgentOptions {
  readonly url: string;
  readonly entityId: string;
  readonly intents?: readonly P1AgentIntent[];            // [] → observe only
  readonly clientName?: string;                           // default "hvtp-agent-client"
  readonly clientVersion?: string;                        // default "0.1.0"
  readonly maxAttempts?: number;                          // per intent, default 3
  readonly reconnect?: { readonly attempts: number; readonly delayMs: number };  // default {5, 500}, fixed delay
  readonly timeoutMs?: number;                            // per wait step, default 10_000
  readonly assetCheck?: boolean;                          // default true
  readonly traceWire?: boolean;                           // emit wire.in / wire.out events
  readonly onEvent?: (event: P1AgentEvent) => void;       // JSON-lines sink; must not throw
  /** @internal seams for deterministic tests */
  readonly socketFactory?: P1SocketFactory;
  readonly fetch?: P1FetchLike;
  readonly createId?: (prefix: string) => string;
  readonly delay?: (ms: number) => Promise<void>;
  readonly hooks?: {
    readonly beforeSubmit?: (ctx: { intent: number; attempt: number; entity: P1SharedEntity }) => void | Promise<void>;
    readonly beforeReconnect?: (ctx: { session: number; lastClose: { code: number; reason: string } | null }) => void | Promise<void>;
  };
}

export type P1AgentOutcome = "satisfied" | "observed" | "entity-not-visible" | "rejected"
  | "exhausted" | "connection-failed" | "protocol-violation" | "internal-error";

export interface P1AgentResult {
  readonly outcome: P1AgentOutcome;
  readonly exitCode: number;
  readonly events: readonly P1AgentEvent[];
  readonly finalEntity: P1EntityDescription | null;
}

export function runAgent(options: P1AgentOptions): Promise<P1AgentResult>;
export function describeEntity(entity: P1SharedEntity, assetBaseUri: string | null): P1EntityDescription;
export function intentSatisfied(entity: P1SharedEntity, intent: P1AgentIntent): boolean;  // exact equality
export function transformPoint(state: P1TransformState, local: readonly [number, number, number]): [number, number, number]; // T×R×S
export { parseAgentArgs, type P1AgentEvent, AGENT_EXIT_CODES };
```

`P1EntityDescription` = `{ id, components: <the three canonical envelopes verbatim>, derived: { assetUrl, visible } }`.
Canonical envelopes (revision, authority, authorityEpoch, consistency, state) are emitted exactly as received. The
`derived` block holds only what the agent computed: the asset URL resolved against **this session's**
`assetBaseUri`, and nothing inferred from the entity ID (C16). `baseColor` is reported as linear RGBA factors with no
conversion (C18).

`transformPoint` is a pure ~20-line quaternion/T×R×S implementation. It gives the agent a renderer-free C17
interpretation (unit-tested). It does **not** make the agent the C23/C37 independent consumer, because the agent
shares client-core with the Three client. The README already says so.

### 3.3 Dependencies and scripts

```json
{
  "name": "@hvtp/agent-client",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "bin": { "hvtp-agent": "./dist/bin.js" },
  "exports": {
    ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" },
    "./bin": "./dist/bin.js"
  },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "npm run build && node --test dist/*.test.js",
    "start": "node dist/bin.js"
  },
  "dependencies": { "@hvtp/client-core": "0.1.0", "@hvtp/protocol-types": "0.1.0" },
  "devDependencies": { "@hvtp/reference-host": "0.1.0" }
}
```

- No `three`, `@hvtp/three-client`, `ws` or `vite`. Built-ins only: `node:util` `parseArgs`, `node:child_process`
  (tests), `node:fs`/`node:os` (tests).
- `tsconfig.json`: `{ "extends": "../../tsconfig.base.json", "compilerOptions": { "rootDir": "src", "outDir": "dist" }, "include": ["src/**/*.ts"] }`.
- The `./bin` export exists so `@hvtp/p1-acceptance` can resolve the CLI path with
  `import.meta.resolve("@hvtp/agent-client/bin")` without executing it.

### 3.4 Root `package.json` changes

```jsonc
"build": "… && npm run build --workspace @hvtp/three-client && npm run build --workspace @hvtp/agent-client && npm run build --workspace @hvtp/p1-acceptance",
"test":  "… && npm run test  --workspace @hvtp/three-client && npm run test  --workspace @hvtp/agent-client && npm run test  --workspace @hvtp/p1-acceptance",
"agent": "npm run start --workspace @hvtp/agent-client --",
"acceptance": "npm run test --workspace @hvtp/p1-acceptance"
```

The order must stay protocol-types → reference-host → client-core → three-client → agent-client → p1-acceptance.
Both new workspaces need `npm install` to be linked; CI already runs `npm install` (`.github/workflows/p1-reference.yml`).

---

## 4. CLI design

### 4.1 Command

```text
npm run agent -- --url ws://127.0.0.1:8787/hvtp --entity entity:cube-01 --color 1,0,0,1
npm run agent -- --entity entity:cube-01 --position=-2,0.5,0 --trace-wire
node packages/agent-client/dist/bin.js --entity entity:cube-01           # observe only
```

| Argument | Default | Meaning |
| --- | --- | --- |
| `--url <ws-url>` | `ws://127.0.0.1:8787/hvtp` | Host WebSocket endpoint. |
| `--entity <id>` | required | Shared entity to subscribe to explicitly. |
| `--color r,g,b,a` | — | Target `hvtp.material@1.baseColor`, linear [0,1]. Sent as `component.set`. |
| `--position x,y,z` | — | Target `hvtp.transform@1.position`. Sent as `component.patch {position}`. **Negative values need `=`** (`--position=-2,0.5,0`): `parseArgs` rejects `--position -2,…` as ambiguous (scratch-verified). |
| `--max-attempts <n>` | 3 | Total submissions per intent across conflicts and uncertainty. |
| `--reconnect-attempts <n>` / `--reconnect-delay-ms <n>` | 5 / 500 | Fixed, jitter-free reconnect budget. |
| `--timeout-ms <n>` | 10000 | Per-wait bound (entity in view, publication confirmation). |
| `--no-asset-check` | check on | Skip the local fixture fetch and inspection. |
| `--trace-wire` | off | Also emit every frame as `wire.out` / `wire.in`. |
| `--client-name <s>` | `hvtp-agent-client` | `session.hello.client.name`. |
| `--help` | — | Usage on stderr, exit 0. |

With no `--color` or `--position`, the agent only observes. If both are given, the intents run in order: material,
then position. Local argument validation rejects non-finite numbers, wrong arity, colours outside [0,1] and positions
outside ±1e6 with exit 2 before connecting. This is a UX check only; the host stays authoritative.

### 4.2 Output: JSON Lines (stdout); human text only on stderr

- One object per line: `{"n":<ordinal>,"event":"<name>",…}`. Keys are in fixed construction order, with no
  timestamps.
- Host-issued IDs and epochs and the agent's random request IDs vary per run. The **event sequence and fields** are
  deterministic for a given host state.
- Output is written with `process.stdout.write`. The process sets `process.exitCode` and returns naturally, without
  `process.exit()`, so piped output is never truncated.

Event vocabulary:

| Event | Fields |
| --- | --- |
| `agent.start` | `url`, `entityId`, `intents` |
| `session.live` | `session` (1-based), `participantId`, `participantKind` (from own presence), `realmEpoch`, `assetBaseUri`, `presenceEntityId`, `subscriptionId`, `snapshotEntityCount` |
| `subscription.applied` | `session`, `previousSubscriptionId`, `subscriptionId`, `effectiveSubscription`, `activated` |
| `entity.observed` | `session`, `reason` (`subscribed`, `after-ack`, `after-conflict`, `after-reconnect`), `entity` (`P1EntityDescription`) |
| `asset.checked` | `url`, `ok`, `bytes`, or `reason` (local only; never affects shared state or exit code) |
| `request.sent` | `session`, `intent`, `attempt`, `requestId`, `type`, `component`, `baseRevision`, `authorityEpoch`, `state`/`patch` (taken from the recorded wire frame) |
| `request.committed` | `requestId`, `seq`, `revision`, `authorityEpoch` |
| `request.rejected` | `requestId`, `code`, `currentRevision?`, `authorityEpoch?` |
| `request.uncertain` | `requestId`, `requestType` |
| `session.closed` | `session`, `code`, `reason`, `uncertainRequestIds` |
| `host.error` / `protocol.violation` | `code`/`message` |
| `intent.resolved` | `intent`, `resolution` (`committed`, `already-satisfied`, `satisfied-after-uncertain`, `satisfied-after-conflict`), `attempts` |
| `result` | `outcome`, `exitCode` (always last) |
| `wire.out` / `wire.in` | `frame` (only with `--trace-wire`) |

Example (§16 step 13–15, trimmed):

```jsonl
{"n":1,"event":"agent.start","url":"ws://127.0.0.1:8787/hvtp","entityId":"entity:p1-happy-cube","intents":[{"kind":"material","baseColor":[1,0,0,1]}]}
{"n":2,"event":"session.live","session":1,"participantId":"participant:…","participantKind":"agent","realmEpoch":"epoch:…","assetBaseUri":"http://127.0.0.1:8787/assets/p1/","presenceEntityId":"entity:presence-…","subscriptionId":"subscription:…","snapshotEntityCount":1}
{"n":3,"event":"subscription.applied","session":1,"previousSubscriptionId":"subscription:…","subscriptionId":"subscription:…","effectiveSubscription":{"entities":["entity:p1-happy-cube"]},"activated":true}
{"n":4,"event":"entity.observed","session":1,"reason":"subscribed","entity":{"id":"entity:p1-happy-cube","components":{"hvtp.transform@1":{"revision":2,…},"hvtp.renderable@1":{"revision":1,…},"hvtp.material@1":{"revision":2,…}},"derived":{"assetUrl":"http://127.0.0.1:8787/assets/p1/unit-cube.gltf","visible":true}}}
{"n":5,"event":"asset.checked","url":"http://127.0.0.1:8787/assets/p1/unit-cube.gltf","ok":true,"bytes":…}
{"n":6,"event":"request.sent","session":1,"intent":0,"attempt":1,"requestId":"req:…","type":"component.set","component":"hvtp.material@1","baseRevision":2,"authorityEpoch":1,"state":{"baseColor":[1,0,0,1]}}
{"n":7,"event":"request.committed","requestId":"req:…","seq":4,"revision":3,"authorityEpoch":1}
{"n":8,"event":"entity.observed","session":1,"reason":"after-ack","entity":{…"hvtp.material@1":{"revision":3,…}…}}
{"n":9,"event":"intent.resolved","intent":0,"resolution":"committed","attempts":1}
{"n":10,"event":"session.closed","session":1,"code":1000,"reason":"client disconnect","uncertainRequestIds":[]}
{"n":11,"event":"result","outcome":"satisfied","exitCode":0}
```

### 4.3 Deterministic step sequence

```text
S1 start        emit agent.start
S2 connect      client.connect({ subscription: {} })            → session.live          (kind "agent")
S3 subscribe    client.setSubscription({ entities: [id] })      → subscription.applied
S4 observe      wait until entity id is in the canonical view    → entity.observed(subscribed)
S5 asset        fetch + inspect fixture (unless --no-asset-check) → asset.checked
S6 per intent   evaluate → (submit → terminal → confirm/re-evaluate)*  → intent.resolved
S7 close        client.disconnect()                              → session.closed
S8 result       emit result; exit code
```

### 4.4 Runner algorithm (`src/run.ts`)

```text
ensureObserved(reason):
  loop
    if fatal (protocol.violation seen): fail protocol-violation (7)            # never loop against a broken host
    if client.phase ≠ live:
       connectWithBudget()   # first try free; then hooks.beforeReconnect → delay(fixed) → budget-- ; exhausted → 6
       emit session.live; r = await setSubscription({entities:[id]}); emit subscription.applied
         (P1OutcomeUncertainError / P1ConnectionError here → continue loop)
    try   await until(() => entities.get(id) is a shared entity, timeoutMs)
          emit entity.observed(reason); return entity
    catch Disconnected → reason = "after-reconnect"; continue
    catch Timeout      → fail entity-not-visible (3)                          # see Q1

applyIntent(i, intent):
  attempts = 0; flags = {}
  loop
    e = ensureObserved(…)
    if intentSatisfied(e, intent): resolve(attempts == 0 && no flags ? "already-satisfied"
                                         : flags.uncertain ? "satisfied-after-uncertain" : "satisfied-after-conflict")
    if attempts == maxAttempts: fail exhausted (5)
    attempts++
    base = { revision, authorityEpoch } of e.components[c]          # captured at observation
    await hooks.beforeSubmit?.(…)                                    # test seam: opens a deterministic race window
    p = setComponent / patchComponent(id, c, value, base)            # explicit fencing; new ID every time
    emit request.sent (from wire tap)
    ack            → emit request.committed; confirm: until revision(c) ≥ ack.revision (Disconnected/Timeout → skip, outcome already known)
                     resolve("committed")
    P1RequestError → emit request.rejected
                     revision_mismatch | authority_epoch_mismatch → flags.conflict; until revision(c) ≥ currentRevision (best effort); continue
                     otherwise (entity_not_found, not_authorized, invalid_component_state, resource_limit, …) → fail rejected (4)
    P1OutcomeUncertainError → emit request.uncertain; flags.uncertain; continue    # never resend; next loop reconnects + fresh snapshot
    P1ClientStateError       → nothing was sent (e.g. closed between observe and submit); continue (bounded by reconnect budget)
```

Properties:

- **C12.** An uncertain request ID is never re-sent. Resolution reads only the fresh snapshot, because client-core
  wiped the old view at teardown. A new request always gets a new ID from `createId("req")` and the **current**
  revision from the new snapshot.
- **Bounded and deterministic.** There are no open-ended goal loops: `maxAttempts` applies per intent, the reconnect
  budget applies per run, every wait has a timeout, the delay is fixed, and there is no model, memory or planning.
  "Intent" means a fixed target value that is frozen at argument time.
- **ACK first.** The outcome comes from the ACK or error (Profile §11). The publication wait after an ACK only
  produces the confirming `entity.observed`; its absence never changes the outcome.

### 4.5 Exit codes

| Code | Outcome |
| --- | --- |
| 0 | `satisfied` (every intent committed or satisfied) or `observed` (observe-only) |
| 1 | `internal-error` |
| 2 | usage error (bad arguments) |
| 3 | `entity-not-visible`: not in view within `timeoutMs` after explicit subscription (absent, tombstoned, or unreadable) |
| 4 | `rejected`: terminal non-conflict host error |
| 5 | `exhausted`: conflicts or uncertainty still unresolved after `maxAttempts` |
| 6 | `connection-failed`: connect or reconnect budget exhausted, or join rejected |
| 7 | `protocol-violation`: host broke the P1 client contract (client-core closed with 4002) |

A local asset failure never changes the exit code (C34: local presentation failure only).

---

## 5. Test plan (`packages/agent-client`)

### 5.1 Fault-injection seams used

| Seam | Mechanism | Effect |
| --- | --- | --- |
| Lost reply after commit | `createReferenceHost({ afterDurableCommit: () => { if (armed) { armed = false; throw new Error("injected lost reply"); } } })`, armed in `hooks.beforeSubmit` | Host commits, admits publications to observers, and closes **only the requester** with 1011. No ACK and no own publication. Deterministic (`session.ts:507-516`). |
| Lost request (never reaches host) | Test socket wrapper around the global `WebSocket`: on the armed outbound `component.*` frame, swallow it and call `inner.close(4000, "injected request loss")` | client-core sees close 4000 and the request becomes uncertain. The host never saw it. |
| Conflict window | `hooks.beforeSubmit` awaits an observer `P1Client` commit before the agent sends with its captured base revision | Deterministic `revision_mismatch`. |
| Restart during uncertainty | `hooks.beforeReconnect` awaits `host1.close()` then `createReferenceHost({ databasePath, port })` | Deterministic C20 epoch change, with no retry-timing dependence. |
| Unit-level host | `ScriptedHost` (`src/test-support.ts`): subclasses client-core `FakeSocket` (`packages/client-core/src/test-support.ts:6-19`) and answers frames on a microtask using its message builders (l.30-97). Presence literal uses `kind: "agent"`. | No timing choreography in unit tests. |

### 5.2 Unit tests (scripted host / pure)

| ID | Test | Criterion / case |
| --- | --- | --- |
| U1 | `describeEntity` returns canonical envelopes verbatim plus `derived.assetUrl`. `https://realm.example/assets/p1/` → `https://realm.example/assets/p1/unit-cube.gltf`; deeper base paths resolve normally. The frozen input is untouched. | Structured state, C16, C34 resolution |
| U2 | `transformPoint({position:[0,0,0], rotation:[0,0,0.7071067811865475,0.7071067811865476], scale:[2,1,1]}, [0.5,0.5,0.5])` ≈ `[-0.5,1,0.5]` ±1e-6 | C17 without renderer logic |
| U3 | `intentSatisfied` uses exact equality per component and ignores other components | Intent semantics |
| U4 | Happy run: frames are `session.hello{participant.kind:"agent"}`, `realm.join{subscription:{}}`, `subscription.set{entities:[id]}`, `component.set{baseRevision, authorityEpoch from view}`. Event order matches §4.3; exit 0. | Negotiate as agent, explicit subscribe, current fencing |
| U5 | `revision_mismatch(currentRevision n+1)` → waits for `component.updated` → second request has a **different ID** and `baseRevision n+1` → exit 0 `satisfied-after-conflict`/`committed`. With `maxAttempts:1` → exit 5. | revision_mismatch handling, C02 client side |
| U6 | Mismatch where the other participant already set the target → no second request; `satisfied-after-conflict` | No redundant mutation |
| U7 | `hostClose(1006)` while pending → `request.uncertain` → new socket. (a) Snapshot shows the target: second-session frames are exactly hello/join/subscription.set and the resolution is `satisfied-after-uncertain`. (b) Snapshot does not: a new request with a new ID and the snapshot revision. In both cases the old ID appears in **one** frame overall. | C12 |
| U8 | Non-conflict errors (`entity_not_found`, `not_authorized`, `invalid_component_state`) → exit 4, no retry | Terminal error handling |
| U9 | Entity never enters → exit 3 after a short `timeoutMs`; no mutation frame | Absent entity |
| U10 | Host sends an invalid frame → `protocol.violation`, exit 7, **no reconnect** | Bounded behaviour |
| U11 | Connect refused (factory throws or closes pre-LIVE) N times → exit 6 after the budget; `delay` is injected as a no-op | Reconnect budget |
| U12 | Asset check failures (redirect, 404, media type, oversize, external buffer, missing node) → `asset.checked ok:false`; frame list unchanged; exit 0 | C34 local-only failure |
| U13 | `parseAgentArgs`: defaults, `--position=-2,…`, ambiguous `--position -2,…` → exit 2, out-of-range values → exit 2, `--help` | CLI |
| U14 | `package-boundary.test.ts`: `package.json` has no `three`/`@hvtp/three-client`/`vite` in any dependency field, and no `dist/*.js` imports `three` | "No Three.js" |

### 5.3 Real-host integration tests (`host-integration.test.ts`, in-process `createReferenceHost`)

Seed through a human `P1Client` observer B with `subscription: {entities:[id]}`. The agent uses Node's global
`WebSocket` wrapped by a recording factory.

| ID | Scenario | Assertions | Cases |
| --- | --- | --- | --- |
| I1 | Basic: agent sets the colour of an existing cube | `participantKind:"agent"` (own presence); snapshot count 1 (join `{}`); cube enters with reason `subscription` (trace); ACK revision 2; B observes revision 2; `asset.checked ok:true`, URL = `${origin}/assets/p1/unit-cube.gltf` | §16 13–16 core, C34 |
| I2 | Conflict: `beforeSubmit` lets B commit blue first | Agent R1 → `revision_mismatch currentRevision 2`; R2 ≠ R1 with base 2 → revision 3; final red. Variant: B sets red → no R2. | C02 (client handling) |
| I3 | Lost reply, committed (`afterDurableCommit` throw) | `session.closed` code 1011; session 2 is the **same epoch**; `entity.observed` shows revision 2 red; resolution `satisfied-after-uncertain`; R1 in exactly one frame across both sessions; session-2 frames = hello, join, subscription.set; `host.worldStore` revision 2 (one commit); B saw exactly one `component.updated` | **C12**, C19 post-commit variant |
| I4 | Lost request, not committed (socket-wrapper drop) | Uncertain; session 2 sees revision 1; R2 ≠ R1 with base 1 → revision 2; store revision 2; B saw one update | **C12** (re-issue branch) |
| I5 | Restart during uncertainty (file DB; `afterDurableCommit` throw + `beforeReconnect` restarts host on the same port) | Session 2 `realmEpoch` ≠ session 1 and = `host2.realmEpoch`; the durable red survives; no replay of R1; a new presence and subscription; the old participant ID is not reused | **C20**, C12 across restart |
| I6 | Unreachable host / restart with real backoff (`reconnect {attempts:20, delayMs:50}`, host restarted concurrently) | Reaches LIVE on host2 or exits 6 when stopped permanently | Reconnect robustness |
| I7 | Observe only on an absent ID | exit 3; outbound types = hello, join, subscription.set | Absent entity |
| I8 | Entity deleted inside the `beforeSubmit` window | `request.rejected entity_not_found` → exit 4 | Terminal error |

### 5.4 CLI tests (`cli.test.ts`)

These spawn `process.execPath dist/bin.js …` against an in-process host and parse the stdout lines.
Assertions: exit 0 and the event sequence for `--color`; `--trace-wire` shows the hello kind `agent`;
`--position=-2,0.5,0` exits 0; bad arguments exit 2 with empty stdout and usage on stderr; an unreachable `--url`
with a tiny budget exits 6.

---

## 6. Automated §16 happy-path test (Milestone 4)

### 6.1 Location and dependency graph

```text
protocol-types ← reference-host
protocol-types ← client-core ← three-client (three)
                 client-core ← agent-client (no three)
p1-acceptance (private, test-only) ──dev──▶ reference-host, client-core, three-client, agent-client, three
```

`packages/p1-acceptance` (`@hvtp/p1-acceptance`, private, no `exports`). Scripts: `build: tsc -p tsconfig.json`,
`test: npm run build && node --test dist/*.test.js`. Its tsconfig copies `packages/three-client/tsconfig.json`
(`lib: ES2022, DOM, DOM.Iterable`) because it compiles against `three` typings.

Rejected placements:

- **agent-client:** this would put `three` in the agent's dependency graph and break U14.
- **three-client:** this inverts ownership. A renderer package would own the cross-participant gate and pay for the
  vite build. The acceptance package is also the natural home for the later full conformance sweep.

### 6.2 Harness (`src/support.ts`)

- The test-only `ProgressEvent` shim (same as `three-adapter.test.ts:13-15`) is imported first.
- `tempDb()` creates a fresh `mkdtemp` directory with `world.sqlite`, so every run starts from a clean host (§16 step 1).
- `browser(name, url)` returns a `P1Client({participantKind:"human", clientName:`browser-${name}`, subscription:{spatial:{center:[0,0,0],radius:100}}})`.
  - It uses a recording socket factory over the global `WebSocket`.
  - `P1ThreeView({ fetch: recordingFetch(globalThis.fetch), onAssetFailure })` is attached to it.
  - It returns `{client, view, detach, framesOut, fetchCalls, assetFailures}`.
  - **Real `fetch` against the real host**, so the views load the real served fixture rather than a fake.
- `until(client, predicate, label, timeoutMs = 5000)` re-checks after each client event (pattern from
  `packages/client-core/src/host-integration.test.ts:27-38`).
- `runAgentCli(args)` spawns `process.execPath` with `fileURLToPath(import.meta.resolve("@hvtp/agent-client/bin"))`
  and collects JSON lines, stderr and the exit code. The agent therefore runs out-of-process and can only reach the
  host over HVTP/WS, which gives the strongest "no private channel" evidence.

### 6.3 Steps and assertions

| §16 | Action | Assertions |
| --- | --- | --- |
| 1 | `host1 = createReferenceHost({ databasePath: tempDb })` | `host1.worldStore.getRealmSeq() === 0`; no entities |
| 2–3 | `browser("A")`, `browser("B")`, `connect()` both | Both `live`; `realmEpoch === host1.realmEpoch`; own presence kind `human`; `effectiveSubscription` overlapping spatial; the views hold 0 objects (presence is not rendered) |
| 4 | A `createEntity({ id: "entity:p1-happy-cube", transform: pos [0,0.5,0], material: white })` | ACK committed; A's recorded `entity.create` frame carries the exact fixture renderable (C16) |
| 5 | — | B gains the entity via `entity.created` with no reload: B's outbound frames are still only hello/join and B stayed `live`. `viewB.whenIdle()` → `assetStatus === "loaded"`, `UnitCube` child present, no placeholder, one fetch to `${host1 assetBaseUri}unit-cube.gltf` with `redirect:"manual"`, `credentials:"omit"`. |
| 6 | A `patchComponent(id, transform, {position:[2,0.5,0]})` | ACK revision 2 |
| 7 | — | B transform revision 2, state position [2,0.5,0]; `viewB.object(id).position` = [2,0.5,0] |
| 8 | B `setComponent(id, material, {baseColor:[0.25,0.5,0.75,1]})` | ACK revision 2 |
| 9 | — | A material revision 2; A's view material colour RGB = 0.25/0.5/0.75 (linear, C18); A and B canonical records deep-equal |
| 10 | `host1.close()`; wait for both `disconnected`; `host2 = createReferenceHost({ databasePath, port: host1.port })` | Both views emptied (`size === 0`); `host2.realmEpoch !== host1.realmEpoch` |
| 11 | A, B `connect()` | Each session-2 outbound list is exactly hello/join (no replay); `realmEpoch === host2.realmEpoch` (C20) |
| 12 | — | The cube is back in both: transform revision 2 [2,0.5,0], material revision 2 [0.25,0.5,0.75,1], renderable revision 1. The views reload the asset (new per-session loader), are `loaded`, and show the same transform and colour. |
| 13 | `runAgentCli(["--url", url, "--entity", id, "--color", "1,0,0,1", "--position=-2,0.5,0", "--trace-wire"])` | Exit 0. `session.live.participantKind === "agent"`, `realmEpoch === host2.realmEpoch`. `wire.out` hello `participant.kind === "agent"`; join `subscription: {}`; `snapshotEntityCount === 1`. |
| 14 | — | `wire.out` `subscription.set` body deep-equals `{entities:[id]}`; `subscription.applied activated:true`; `wire.in view.entity.enter reason "subscription"`. The first `entity.observed.entity.components` **deep-equals A's canonical record** (revisions 2/1/2, authorityEpoch 1). `derived.assetUrl` equals the URL the browser views fetched (C34: the same URL for browser and headless). `asset.checked ok:true`. |
| 15 | — | `request.sent component.set material baseRevision 2 authorityEpoch 1` → committed revision 3. `request.sent component.patch transform baseRevision 2` → committed revision 3. Each request ID is distinct. |
| 16 | `until` A and B see material revision 3 and transform revision 3 | A and B canonical records deep-equal each other and `host2.worldStore.getEntity(id)`. Both views show colour [1,0,0] and position [-2,0.5,0]. A/B sent **no** frames during the agent step. All observed frame types are P1 message types. No asset failures in either view. |
| cleanup | Disconnect A and B; call `detach()` and `view.dispose()`; `host2.close()`; remove the temp dir | Runs in `finally` |

All waits are event predicates with timeouts; there are no sleeps. A second, optional test in the same package can
run steps 13–16 in-process with `runAgent` for easier debugging. The CLI variant stays the gate.

---

## 7. Risks, open questions, work breakdown

### 7.1 Risks

| Risk | Mitigation |
| --- | --- |
| M1 changes shift line references and touch `client-core/src/index.ts` and `three-client/src/asset-loader.ts` | WP1 starts only after M1 merges. WP2/WP3 depend only on published client-core APIs that M1 does not change (`connect`, `setSubscription`, `setComponent`/`patchComponent`, errors, events). |
| Rebinding the same port after host restart (Windows/Linux) | The existing restart test already relies on it. If it flakes, fall back to new `P1Client` instances on a new port; the views re-attach. |
| Global `WebSocket` on Node 22 CI | `engines >=22.13.0`; global is stable since 22.4. `platformSocketFactory` fails loudly otherwise. |
| A listener exception in client-core `#emit` crashes the CLI | All agent listeners are total; `onEvent` is wrapped. |
| Absent-entity detection uses a timeout | Documented exit 3; see Q1. |
| GLTFLoader in Node needs the `ProgressEvent` shim | Test-only shim in `p1-acceptance/src/support.ts`, as in three-client tests. |
| CI time (10-minute job) | Adds about 2–4 s, including one child process. |

### 7.2 Open questions

- **Q1.** P1 has no transition-complete marker after `subscription.set`, so "entity absent" is detected by timeout.
  A spec-grounded deterministic alternative exists: §10.1 serializes replacement batches per connection, so a second
  identical `subscription.set` proves that the first batch completed. It costs an extra request and generation per
  run. Recommendation: keep the timeout and record this as profile feedback, not a P1 change.
- **Q2.** Re-join on reconnect with `{}` plus explicit `subscription.set` (recommended, uniform evidence), or join
  directly with `{entities:[id]}` (one fewer round trip)?
- **Q3.** Intent semantics: skip submission when canonical state already equals the target (recommended,
  idempotent), or always submit once? The §16 test chooses targets that differ, so it is unaffected.
- **Q4.** Conflict policy defaults to a bounded retry (`--max-attempts 3`). Should the reference default fail fast
  (`1`) instead?
- **Q5.** Confirm the agent is **not** claimed for C23/C37 (it shares client-core). The README already states this.

### 7.3 Work breakdown

| WP | Scope | Owned files | Depends on | Done when |
| --- | --- | --- | --- | --- |
| **WP1: client-core asset policy** (small) | Extract the engine-neutral fixture URL/fetch/inspect policy. three-client delegates to it. | `packages/client-core/src/assets.ts` (new), `packages/client-core/src/assets.test.ts` (new), `packages/client-core/src/index.ts` (exports only), `packages/three-client/src/asset-loader.ts` (delegate; keep GLTF parse/dispose and the `P1FetchLike` re-export) | **M1 merged** | New client-core tests cover the failure matrix without `three`; the existing three-client C34 tests pass unchanged; root `npm test` is green. |
| **WP2: `@hvtp/agent-client`** (medium) | Runner, entity-state, wire tap, waits, args, CLI/bin, ScriptedHost, U1–U14, I1–I8, CLI tests. Root `agent` script plus build/test entries for agent-client. | `packages/agent-client/**`, root `package.json` (agent-client lines + `agent` script) | Can start immediately. Swap `src/asset-check.ts` to WP1's API once merged (until then a temporary local wrapper, or land after WP1). | `npm test --workspace @hvtp/agent-client` is green on Windows and the Node 22 CI. `npm run host` + `npm run agent -- --entity … --color …` works manually. |
| **WP3: `@hvtp/p1-acceptance` §16** (medium) | Harness plus the steps 1–16 test (CLI agent), and an optional in-process variant. Root build/test/`acceptance` entries. | `packages/p1-acceptance/**`, root `package.json` (acceptance lines, appended after WP2's) | Steps 1–12 can be scaffolded now; steps 13–16 need WP2's CLI contract (§4.2/§4.5) to be frozen. | The full §16 test passes in `npm test` locally and in CI, with no sleeps or renderer-private channels. |

Documentation obligations travel with each WP (per the repository `AGENTS.md` in the consolidated branch), not as a
separate package:

- **WP1:** CHANGELOG `Unreleased` bullet. DEVELOPMENT_JOURNAL entry for moving the asset policy into client-core.
- **WP2:** README "Reference implementation status" gains an agent section covering run commands, the output
  schema, exit codes, and C12/C20/C34 evidence. CHANGELOG bullet.
- **WP3:** README notes that the §16 happy path is automated, and the deferred-work list drops "headless agent and
  steps 13–16". CHANGELOG bullet. The status wording must keep saying this is **not** a claim of P1 conformance until
  the C01–C36 sweep passes.

Parallelism: WP2 and WP3 (steps 1–12) can run now in separate workers. WP1 starts after M1. Root `package.json` is
the only shared file; merge WP2's lines before WP3's.
