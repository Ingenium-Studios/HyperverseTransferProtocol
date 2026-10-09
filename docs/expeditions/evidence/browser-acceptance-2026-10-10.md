# Browser acceptance run — Prototype Profile §16 happy path

**Date:** 2026-10-10. **Builds:** host + Three.js demo from `impl/p1-slice-7-three-client` @ `8cca804`; headless agent CLI from `impl/p1-slice-8-headless-agent` @ `c5b71fe`. **Browser:** the in-app Chromium-based browser, two tabs (A, B) on the Vite dev server (`http://127.0.0.1:5173/`), host `ws://127.0.0.1:8787/hvtp` with a file-backed SQLite store. State was read from each tab's `P1Client` canonical view and `P1ThreeView` objects (demo debug handle), plus screenshots; the agent ran as a separate OS process speaking only the P1 wire.

| §16 step | Observation | Result |
| --- | --- | --- |
| 1–3 clean host; A and B connect, negotiate, join with overlapping subscriptions (radius 100 at origin) | both `phase: live`, same `realmEpoch` `epoch:270c2dd0…` | pass |
| 4–5 A creates cube; B materializes without reload | B: entity `entity:6c1dac3c…` t#1 m#1, `P1ThreeView.assetStatus = loaded`; fixture `GET /assets/p1/unit-cube.gltf → 200` | pass |
| 6–7 A moves (+X patch) → B canonical transform | both: transform rev 2, position `[1.3,0.5,-2.9]`; Three object position equal | pass |
| 8–9 B random color (set) → A canonical material | both: material rev 2, baseColor `[0.27,0.34,0.21,1]`; Three material color (linear) equal | pass |
| 10 stop and restart host on same DB | both tabs `disconnected`, scene size 0 | pass |
| 11–12 reconnect, fresh snapshots | new epoch `epoch:8503c209…`; cube t#2 `[1.3,0.5,-2.9]`, m#2 `[0.27,0.34,0.21,1]`, asset `loaded` in both | pass |
| 13–14 agent connects (`kind: agent`), explicitly subscribes, reads structured state | JSONL: `session.live participantKind=agent`, `subscription.applied {entities:[cube]}`, `entity.observed` with revisions (t#2, m#2), `asset.checked ok` (resolved against advertised `assetBaseUri`) | pass |
| 15 agent requests permitted mutations | `component.set material baseRevision 2 → committed seq 1 rev 3`; `component.patch transform baseRevision 2 → committed seq 2 rev 3`; exit 0 | pass |
| 16 both browsers observe canonical result | A and B: t#3 `[-2,0.5,1]`, m#3 `[0.1,0.6,0.9,1]`; Three position and material color equal canonical values | pass |

**Side channels:** none — the agent is a separate process; the browsers only consume `P1Client` events.

**Finding (minor, demo UI only):** the demo's entity list label kept showing `[loading]` after the fixture loaded (`P1ThreeView.assetStatus` was `loaded`); the list is not re-rendered on asset-load completion. Presentation-only; no protocol or state impact.

## Agent JSONL (abridged to the first 200 characters per line)

```text
{"n":1,"event":"agent.start","url":"ws://127.0.0.1:8787/hvtp","entityId":"entity:6c1dac3c-e4b8-4588-880a-e550cb6cfd0d","intents":[{"kind":"material","baseColor":[0.1,0.6,0.9,1]},{"kind":"position","po
{"n":2,"event":"session.live","session":1,"participantId":"participant:ce23e31b-12d0-4b52-830e-020bc34e72de","participantKind":"agent","realmEpoch":"epoch:8503c209-1440-4e35-b988-850eea2a412b","assetB
{"n":3,"event":"subscription.applied","session":1,"previousSubscriptionId":"subscription:b37551e3-3610-4d73-bdf5-88e719d9255b","subscriptionId":"subscription:730f41cc-f474-4573-b6ab-ff62efb3b657","eff
{"n":4,"event":"entity.observed","session":1,"reason":"subscribed","entity":{"id":"entity:6c1dac3c-e4b8-4588-880a-e550cb6cfd0d","components":{"hvtp.transform@1":{"revision":2,"authority":"host","autho
{"n":5,"event":"asset.checked","url":"http://127.0.0.1:8787/assets/p1/unit-cube.gltf","ok":true,"bytes":1577}
{"n":6,"event":"request.sent","session":1,"intent":0,"attempt":1,"requestId":"req:909444bb-0c79-4f28-8a22-65d7c4acaa25","type":"component.set","component":"hvtp.material@1","baseRevision":2,"authority
{"n":7,"event":"request.committed","requestId":"req:909444bb-0c79-4f28-8a22-65d7c4acaa25","seq":1,"revision":3,"authorityEpoch":1}
{"n":8,"event":"entity.observed","session":1,"reason":"after-ack","entity":{"id":"entity:6c1dac3c-e4b8-4588-880a-e550cb6cfd0d","components":{"hvtp.transform@1":{"revision":2,"authority":"host","author
{"n":9,"event":"intent.resolved","intent":0,"resolution":"committed","attempts":1}
{"n":10,"event":"request.sent","session":1,"intent":1,"attempt":1,"requestId":"req:56d96cd1-1563-4660-861f-244b0b3d39f7","type":"component.patch","component":"hvtp.transform@1","baseRevision":2,"autho
{"n":11,"event":"request.committed","requestId":"req:56d96cd1-1563-4660-861f-244b0b3d39f7","seq":2,"revision":3,"authorityEpoch":1}
{"n":12,"event":"entity.observed","session":1,"reason":"after-ack","entity":{"id":"entity:6c1dac3c-e4b8-4588-880a-e550cb6cfd0d","components":{"hvtp.transform@1":{"revision":3,"authority":"host","autho
{"n":13,"event":"intent.resolved","intent":1,"resolution":"committed","attempts":1}
{"n":14,"event":"session.closed","session":1,"code":1000,"reason":"client disconnect","uncertainRequestIds":[]}
{"n":15,"event":"result","outcome":"satisfied","exitCode":0}
```
