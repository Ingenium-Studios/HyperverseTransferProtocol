# @hvtp/agent-client

Headless P1 reference agent for HVTP. It is a **deterministic step script, not an AI**: no inference, no memory
between runs, no goal loops. Every loop is bounded by an attempt limit, a reconnect budget, or a timeout.

It depends only on `@hvtp/client-core` and `@hvtp/protocol-types` (plus the Node 22+ global `WebSocket` and
`fetch`). It has no Three.js, `ws`, or bundler dependency, and a test asserts that.

## Usage

```bash
npm run build
npm run host                                                           # reference host on ws://127.0.0.1:8787/hvtp
node packages/agent-client/dist/bin.js --entity <id>                   # observe only
node packages/agent-client/dist/bin.js --entity <id> --color 1,0,0,1   # component.set hvtp.material@1
npm run --silent agent -- --entity <id> --position=-2,0.5,0 --trace-wire
node packages/agent-client/dist/bin.js --help
```

`<id>` must be the ID of an entity that already exists. The host starts empty and the agent never creates
entities. Create one first, for example with **Create cube** in the browser demo (`npm run client:dev`; the entity
list shows the generated ID), or from any client with `createEntity({ id: "entity:cube-01", ... })`. A missing
entity exits 3. `npm run agent` prints npm banner lines on stdout; use `npm run --silent agent -- ...` or call
`node packages/agent-client/dist/bin.js` directly when the output is piped, so stdout is pure JSON Lines.

| Argument | Default | Meaning |
| --- | --- | --- |
| `--url <ws-url>` | `ws://127.0.0.1:8787/hvtp` | Host endpoint (`ws:` or `wss:`). |
| `--entity <id>` | required | Shared entity to subscribe to explicitly. |
| `--color r,g,b,a` | none | Target `baseColor` (linear, each in [0,1]); sent as `component.set`. |
| `--position=x,y,z` | none | Target transform `position` (within +/-1e6); sent as `component.patch`. Negative values need `=`. |
| `--max-attempts <n>` | 3 | Submissions per intent across conflicts and uncertain outcomes. |
| `--reconnect-attempts <n>` / `--reconnect-delay-ms <n>` | 5 / 500 | Reconnect budget for the whole run and the fixed delay before each reconnect. |
| `--timeout-ms <n>` | 10000 | Bound for every network wait: connect and handshake, `subscription.set`, the entity entering the view, each mutation's terminal result, the post-ACK confirmation, and the fixture fetch (also an `AbortSignal`). |
| `--no-asset-check` | check on | Skip the local fixture fetch and inspection. |
| `--trace-wire` | off | Also emit every frame as `wire.out` / `wire.in`. |
| `--client-name <s>` | `hvtp-agent-client` | `session.hello` client name. |

With neither `--color` nor `--position` the agent only observes. With both, the material intent runs first. Argument
checks are a local UX check; the host stays authoritative. Bad arguments exit 2 before connecting.

Programmatic use: `runAgent(options)` returns `{ outcome, exitCode, events, finalEntity }`; `parseAgentArgs`,
`describeEntity`, `intentSatisfied`, and `transformPoint` are pure helpers.

## Steps

1. Connect, negotiate as `participant.kind: "agent"`, and join with the empty selector `{}`.
2. Send an explicit `subscription.set { entities: [id] }` (every session, including reconnects).
3. Wait, bounded by `--timeout-ms`, until the entity is in the canonical view. P1 has no "transition complete"
   marker, so absence is detected by timeout (exit 3).
4. Read the structured transform, renderable, and material components with their revision, authority, and
   `authorityEpoch` exactly as received.
5. Check the asset reference locally with the shared client-core policy (same URL resolution against the
   session's `assetBaseUri`, no redirects, HTTP 200, `model/gltf+json`, `maxAssetBytes`, embedded resources only).
   This never mutates shared state and never changes the exit code (C34).
6. For each intent: if the canonical state already equals the target, send nothing (`already-satisfied`).
   Otherwise send the mutation fenced with the observed `baseRevision` and `authorityEpoch`.
7. Resolve the outcome from the ACK or terminal error, disconnect, and print the result.

## Timeouts

Every step that waits on the network is bounded by `--timeout-ms`. When a connect, handshake, `subscription.set` or
mutation does not finish in time, the agent emits `step.timeout` and closes the session. A pending connect then
fails and counts against the reconnect budget; a pending request or subscription becomes outcome-uncertain and
follows the C12 path below (never re-sent). A stalled fixture fetch is aborted and reported as a local
`asset.checked ok:false` failure; the run continues. After an ACK the agent waits at most `--timeout-ms` for the
confirming publication. If it does not arrive, or the entity leaves the view, it emits `entity.unconfirmed`; the
outcome stays committed because the ACK is authoritative.

A `P1ClientStateError` while the session is still live (the client refused the request locally, for example
because of the advertised pending-request or message-size limits) is terminal: exit 4 with
`request refused locally` in the result `message`.

## Output: JSON Lines on stdout

One JSON object per line, `{"n":<ordinal>,"event":"<name>",...}`, with no timestamps. Human text (usage, internal
errors) goes to stderr only. Events: `agent.start`, `session.live`, `subscription.applied`, `entity.observed`
(`reason`: `subscribed`, `after-ack`, `after-conflict`, `after-reconnect`), `asset.checked`, `request.sent`,
`request.committed`, `request.rejected`, `request.uncertain`, `session.closed`, `host.error`, `protocol.violation`,
`intent.resolved` (`committed`, `already-satisfied`, `satisfied-after-uncertain`, `satisfied-after-conflict`),
`step.timeout`, `entity.unconfirmed`, `wire.out`/`wire.in` (only with `--trace-wire`), and a final `result { outcome, exitCode, message? }`.
`entity.observed` carries the canonical component envelopes verbatim plus a `derived` block with only what the
agent computed (`assetUrl`, `visible`); nothing is inferred from the entity ID. `baseColor` is reported as linear
factors without conversion.

IDs and epochs vary per run; the event sequence and fields are deterministic for a given host state.

## Exit codes

| Code | Outcome |
| --- | --- |
| 0 | `satisfied` (all intents committed or already met) or `observed` |
| 1 | `internal-error` |
| 2 | usage error |
| 3 | `entity-not-visible` within `--timeout-ms` of the explicit subscription (absent, deleted, or unreadable) |
| 4 | `rejected`: a terminal non-conflict host error (for example `entity_not_found`, `not_authorized`) |
| 5 | `exhausted`: conflicts or uncertain outcomes still unresolved after `--max-attempts` |
| 6 | `connection-failed`: connect or reconnect budget exhausted, or the join was rejected |
| 7 | `protocol-violation`: the host broke the P1 client contract (no reconnect is attempted) |

## Outcome-uncertain semantics (C12)

If the connection ends after a mutation was sent and before its ACK or error, the outcome is **uncertain**. The
agent never re-sends that request ID, in any session. It reconnects (bounded), takes a fresh snapshot, subscribes
explicitly again, and compares the canonical state with the frozen target:

- target already met (the commit happened): no mutation, resolution `satisfied-after-uncertain`;
- target not met (the request never arrived): a **new** request ID fenced with the **current** revision.

`revision_mismatch` is handled the same way after waiting for the newer revision: observe, re-evaluate, and retry
with a new request ID, at most `--max-attempts` submissions per intent. A host restart changes `realmEpoch` (C20);
the agent simply starts a new session and never carries state across.

## Limitations

A transient `entity-not-visible` cannot be told apart from an absent entity (P1 has no transition-complete
marker), and one reconnect budget is shared by the whole run.

## Scope

The agent shares `client-core` with the Three.js client, so it is **not** the independent second consumer required
for the C23/C37 interoperability gate. `transformPoint` is a renderer-free T x R x S interpretation (C17) for tests
and tooling only.

## Tests

`npm test --workspace @hvtp/agent-client` runs: pure and argument tests; scripted-host tests of every step and
failure path; real in-process reference host tests (second-client observation, conflict retry, lost reply after a
durable commit, request lost before the host, host restart on the same SQLite file, absent entity, deleted entity,
asset policy against the host-advertised `assetBaseUri` including real redirects and oversize bodies); and CLI tests
that spawn the built binary and assert JSON Lines and exit codes 0, 2, 3, and 6. Waits are event driven; the only
timers are failure-path timeouts.
