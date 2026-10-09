# @hvtp/p1-acceptance

Test-only package (private; nothing depends on it) holding the automated **P1 acceptance** evidence: the Prototype
Profile section 16 happy path and a few cross-component cases that need a real host, a real client, and a real
renderer adapter at the same time. It has no production code; `src/support.ts` is test support only.

## What it proves

- **Real components, real wires.** A reference host process instance with a temporary SQLite file, two simulated
  browsers (`@hvtp/client-core` `P1Client` plus `@hvtp/three-client` `P1ThreeView`, running in Node with the real
  `WebSocket` and `fetch` against the host's asset endpoint), and the headless agent as a **separate OS process**
  started from the built `hvtp-agent` CLI. The only test shim is the browser-only `ProgressEvent` global, exactly as
  in the `three-client` tests.
- **Every section 16 step is asserted** (canonical client state, revisions, Three objects, asset status, host store).
- **No renderer-private channel.** Browsers consume only `P1Client` events (the Three view has no request surface);
  they send only P1 frames and make HTTP requests only to the advertised asset URL; the agent shares no memory with
  them (child process, own session and participant ID).
- **Cross-component cases** (C08/C30, C28, C12, Three lifecycle) against the real host, using only the host's existing
  test seams (`realmCoordinatorOptions.beforeSnapshotEnqueue`, `afterDurableCommit`); no production hook was added.

Waits are event driven. The only timers are failure-path bounds (10 s per wait, 30 s for the agent process) and the
bounded `EADDRINUSE` retry when the restarted host rebinds the same port.

## Running

```bash
npm run acceptance                                   # build everything, then run this package's tests
npm test --workspace @hvtp/p1-acceptance             # needs the other packages already built
```

The package is also part of the root `npm run build` and `npm test`.

## Mapping

| Spec item | Test (file) | Test name |
| --- | --- | --- |
| Section 16 steps 1-16 | `src/happy-path.test.ts` | Prototype Profile section 16 happy path: steps 1-16 ... |
| Step 1 clean host | same | comment `Step 1`: empty temp store, realm sequence 0 |
| Steps 2-3 two browsers negotiate 0.2, overlapping spatial joins | same | `Steps 2-3` |
| Steps 4-5 create on A, B materializes without reload (`loaded`, not placeholder) | same | `Step 4`, `Step 5` |
| Steps 6-7 A moves, B canonical state + Three transform | same | `Step 6`, `Step 7` |
| Steps 8-9 B recolors, A canonical state + Three linear color | same | `Step 8`, `Step 9` |
| Steps 10-12 restart same SQLite file and port, reconnect, new epoch, last durable state and revisions | same | `Step 10`, `Step 11`, `Step 12` |
| Steps 13-15 agent process: explicit `subscription.set`, structured read with revisions, material and position change | same | `Step 13` to `Step 15` (JSONL and wire trace) |
| Step 16 both browsers observe state, revision, Three objects | same | `Step 16` |
| "No renderer-specific private channel" | same | final assertions of the happy-path test |
| C08 / C30 post-cut update, create, delete, membership crossing, each applied exactly once | `src/cross-component.test.ts` | `C08/C30 real host: ... committed after the snapshot cut ...` (four generated tests) |
| C28 rapid S1/S2, active generation S2, stale S1 publication ignored | same | `C28 real host: rapid S1 ...` |
| C12 browser client, lost reply after durable commit, no replay | same | `C12 real host: connection lost after the durable commit ...` |
| Three leave without tombstone, re-enter rebuild, global delete | same | `Three on a real host: subscription leave ...` |

## Notes

- C08/C30 use the host's `beforeSnapshotEnqueue` barrier: the joiner's snapshot is cut, delivery is parked, another
  client commits, then delivery is released. The joiner must end with the host's canonical records and see the
  post-cut publication exactly once and after `realm.snapshot.end`.
- The C28 stale frame is injected by wrapping the client's socket and handing an S1-tagged frame to the client's
  `onmessage` after S2 is active.
- This suite does not make the agent an independent consumer; `@hvtp/agent-client` shares `client-core` and does not
  count towards the C23/C37 interoperability gate.
