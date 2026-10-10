# P1 Reference Expedition — Operational Ledger

> **What this file is.** An operational coordination record for the bounded engineering expedition that takes the HVTP 0.2 / Prototype Profile P1 reference implementation to an independently verified *Reference Implementation Complete* candidate. It is **not** a changelog, release ledger, or journal. Lasting engineering history is transferred into [CHANGELOG.md](../../CHANGELOG.md) and [docs/DEVELOPMENT_JOURNAL.md](../DEVELOPMENT_JOURNAL.md) at milestone/expedition completion, per [AGENTS.md](../../AGENTS.md).
>
> **Status language** follows AGENTS.md: *investigated*, *completed on branch*, *merged (into named branch)*, *released*, *deployed*. Nothing in this file is released or deployed.

Ledger branch: `expedition/p1-reference` (based on the consolidated implementation branch head `ac754f5`).

---

## A. Mission charter

| Item | Value |
| --- | --- |
| Mandate date | 2026-10-09 |
| Mission owner | Ingenium Studios |
| Primary objective | P1 reference implementation (host + Three.js browser client + headless agent) reaching an independently verified **P1 Reference Implementation Complete — candidate for approved integration** |
| Stretch objective | P1 independent-consumer interoperability evidence (C23, C37) — only after the primary gate passes |
| Normative baseline | `protocol-spec/hvtp.md`, `protocol-spec/prototype-profile.md`, `protocol-spec/p1-conformance.md`, `protocol-spec/fixtures/unit-cube.gltf` (merged to `main` at `afd3563`, PR #1) |
| Implementation baseline | consolidated branch `impl/p1-reference-slice-1` @ `ac754f5` (draft PR #2 → `main`); Slice 7 branch `impl/p1-slice-7-three-client` @ `6093344` (draft PR #6 → consolidated) |

**Scope (in):** Slice 7 corrections; headless reference agent; reference-applicable conformance C01–C22 + C24–C36; §16 happy path; runbook/docs; review-ready integration branches. **Scope (out):** federation, P2P, WebTransport, scripting/behaviours, physics, authority delegation, generalized assets, platform features, unrelated products.

**Authority boundaries.** Autonomous: discovery, branches/worktrees, implementation, tests, reviews, pushes to mission branches, draft PRs, non-destructive branch synchronization. **Human approval required:** merging any PR into its target branch (PR #6, PR #2, and stacked PRs), tags/GitHub Releases, protocol freeze, P1 scope or normative-semantics changes, destructive repository/data operations, production deployment, paid services, security-policy changes.

**Mandatory milestones.**

- **M0** Baseline reconstruction & plan.
- **M1** Slice 7 corrections (B1, I1, I2, I3) + branch reconciliation + independent review.
- **M2** Headless reference agent (+ CLI, real-host tests).
- **M3** Reference-applicable conformance matrix complete with evidence; gaps closed.
- **M4** Integrated §16 happy path + acceptance package.
- **M5 (stretch)** Independent consumer, C23 + C37.

**Success criteria.** Reference host, Three.js client, headless agent pass; C01–C22 + C24–C36 have reviewed evidence; §16 happy path passes over the P1 wire only; full regression suite + exact-head CI green; documentation matches behavior; independent review has no unresolved blockers; exact integration SHA recorded.

---

## B. Execution ledger

Statuses: `planned`, `active`, `blocked`, `in review`, `correction required`, `validated`, `merged`, `rejected`, `deferred`.

| ID | Milestone | Objective | Owner | Status | Branch / worktree | Depends on | Validation | PR / commit |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| M0-A | M0 | Verify repository state vs. mandate | Coordinator | validated | — | — | GitHub API: PR/branch SHAs match mandate; no issues/releases/tags | — |
| M0-B | M0 | Inspect specs, host, client, guidance | Coordinator | validated | — | — | — | — |
| M0-C | M0 | C01–C37 conformance evidence inventory | W2 (discovery) | validated | read-only `6093344` | — | 35 ref-applicable: 14 covered / 19 partial / 2 gap | [evidence/conformance-inventory-baseline.md](evidence/conformance-inventory-baseline.md) |
| M0-D | M0 | Dependencies, work packages, integration strategy | Coordinator | validated | — | M0-A | this ledger | — |
| M1-R | M1 | Reconcile PR #6 with consolidated head | Coordinator | validated | `impl/p1-slice-7-three-client` | — | local 147/147; CI `37976850077` green | merge `d22ba57` |
| M1-B1 | M1 | Unmatched `subscription.applied` must not activate a generation | W1 (impl) | validated | `impl/p1-slice-7-three-client` | M1-R | R1 approve; CI `38004772113` | `a9baace` |
| M1-I1 | M1 | Host-frame parser must not apply 128-byte client-ID rule | W1 | validated | same | M1-R | R1 approve; CI `38004772113` | `4f1c859` |
| M1-I2 | M1 | Leave reason `authorization` (leave only) in types + runtime | W1 | validated | same | M1-R | R1 approve; CI `38004772113` | `2838817` |
| M1-I3 | M1 | `P1ThreeView` / fixture-loader dispose lifecycle | W1 | validated | same | M1-R | R1 approve; CI `38004772113` | `be2e5ed`, nits `8cca804` |
| M1-DOC | M1 | History/doc impact for Slice 7 | Coordinator | validated | same | M1-B1..I3 | — | `fd60fd6` |
| M1-REV | M1 | Independent review of corrected Slice 7 head | R1 (Opus reviewer) | validated | — | M1-B1..I3 | APPROVE WITH NITS (0 blocker/important); M1+M4 fixed; M2/M5/D1/D2 deferred | PR #6 comment 6091028188 |
| M2-D | M2 | Headless agent design + §16 test design | W3 (design) | validated | read-only `6093344` | — | Coordinator review | [evidence/headless-agent-design.md](evidence/headless-agent-design.md) |
| M2-IMPL | M2 | Headless agent package, CLI, tests (+ client-core asset policy) | W5 (impl) | validated | `impl/p1-slice-8-headless-agent` (from `fd60fd6`) | M1-REV, M2-D | — | — |
| M3-HOST | M3 | Close host-side conformance gaps (C02/03/10/14/15/16/17/18/20/24/25/26/27/29/32/34/35) | W4 (impl) | in review | `impl/p1-conformance-host` (from `ac754f5`) | M0-C | Coordinator review; local 114/114 | PR #8 @ `9904792` |
| M3-CLIENT | M3 | Client-side/cross-component gaps (C08/C30 real-host cut, C28 real-host stale, C12, Three on real host) | W6 (impl) | validated | `impl/p1-acceptance` | M2-IMPL | 8 acceptance tests, 30× stable; CI `38056634725` | PR #10 @ `bd54736` |
| M3-MATRIX | M3 | Final reviewed conformance matrix on integration head | W7 + W4 + Coordinator | validated | `integration/p1-reference-candidate` @ `d41cd38` | all M3 | 31 pass / 4 pass-with-adaptation / 0 incomplete | [evidence/conformance-matrix-final.md](evidence/conformance-matrix-final.md) |
| M4-AUTO | M4 | Automated §16 happy path | W6 | validated | `impl/p1-acceptance` | M2 | `happy-path.test.ts`; CI `38056634725` | PR #10 |
| M4-BROWSER | M4 | Real-browser §16 run | Coordinator | validated | PR #6 `8cca804` + agent `c5b71fe` | M2 | [evidence](evidence/browser-acceptance-2026-10-10.md) | `831de1a` |
| M4-INT | M4 | Integration candidate, combined review, runbook | Coordinator / R3 | validated | `integration/p1-reference-candidate` | M1–M3 | R3 approve-with-nits (doc fixes applied); local 326/326; CI `38057370967` @ `d41cd38` | PR #11 |
| M4-GATE | M4 | **P1 Reference Implementation Complete — candidate for approved integration** | Coordinator | validated | — | all | see section F | — |
| M5 | M5 | Independent consumer (C23/C37) | TBD | planned | — | M4 gate (passed) | — | — |

---

## C. Decision log

| # | Date | Decision | Rationale / alternatives | Scope | Evidence | Human approval? |
| --- | --- | --- | --- | --- | --- | --- |
| D1 | 2026-10-09 | Reconcile PR #6 with the consolidated branch by a **non-destructive merge commit** into `impl/p1-slice-7-three-client`. | Rebase would rewrite reviewed history and require a force-push of a shared branch (rejected). Only overlapping file was `README.md`; it auto-merged. | M1 | merge `d22ba57`; local 147/147; CI `37976850077` | No (authorized branch sync) |
| D2 | 2026-10-09 | Keep this operational ledger at `docs/expeditions/P1-REFERENCE-EXPEDITION.md` on branch `expedition/p1-reference`. | AGENTS.md forbids a competing history artifact without explicit decision; the mission owner's mandate explicitly requested this ledger. It is operational only; lasting history moves to CHANGELOG/journal at completion. | All | this file | Mandated by mission owner |
| D3 | 2026-10-09 | B1 policy: an unknown-ref `subscription.applied` is **inert** (no state change, no close). A ref matching a pending non-`subscription.set` request is a host protocol violation handled by existing client conventions. A matching `subscription.set` whose `previousSubscriptionId` is no longer active settles the request but never reactivates. | A duplicate terminal response for an already-settled retransmission can legitimately arrive, so treating every unknown ref as fatal would be over-strict; correlation still gates all activation (Profile §10.1, C28). | M1 | PR #6 review B1 | No |
| D4 | 2026-10-09 | Tooling: GitHub MCP connector unavailable in this runtime; use authenticated `gh` CLI. Workers are in-session sub-agents; local worktrees live under `.worktrees/` (git-excluded). | Verified tool availability rather than assuming. | All | — | No |
| D5 | 2026-10-09 | Merge-gated work stacks: M2+ branches are cut from the reviewed Slice 7 head and their draft PRs target the branch below them, so each PR diff contains only its own work. | Avoids idling on merge approval; keeps provenance per slice. Alternative (wait for PR #6 merge) rejected as unnecessary blocking. | M2–M4 | — | No (merges themselves remain gated) |
| D6 | 2026-10-10 | Enforce advertised `maxAssetUriCharacters` on create: over-length asset URI → `resource_limit` (checked before exact-fixture match); other non-fixture URI → `invalid_component_state`. | C16 says URI size violations use `resource_limit`; the limit was advertised but unenforced (Profile §12: host MUST NOT silently accept values above advertised limits). | M3 | inventory gap 4 | No (implements existing normative text) |
| D7 | 2026-10-10 | C10 Variant A evidence: host durable-mutation processing completes synchronously within one message dispatch, so no observable pending window exists; tested by two structurally-equal frames (reordered keys) written in one burst → one mutation, identical terminal results. No async commit seam added for tests. | Adding an async seam would change commit-path structure only to manufacture a window. Spec intent (one logical op, bounded waiters) is still asserted. Pending-duplicate behavior for `subscription.set` remains directly tested. | M3 | inventory C10 | No — flagged for reviewer attention |
| D8 | 2026-10-10 | Accept W3 headless-agent design: package `@hvtp/agent-client` (deps client-core + protocol-types only), CLI `hvtp-agent`, JSONL output; rejoin with `{}` then explicit `subscription.set`; skip mutation if target already met; ≤3 conflict attempts; agent does NOT count as independent consumer for C23/C37. Engine-neutral asset policy moves into client-core after M1. Acceptance test in test-only package `@hvtp/p1-acceptance`. | See design doc. | M2/M4 | [design](evidence/headless-agent-design.md) | No |

---

## D. Artifact ledger

| Artifact | Ref | SHA | State | Evidence |
| --- | --- | --- | --- | --- |
| `main` | branch | `afd3563` | spec merged (PR #1) | — |
| Consolidated implementation | `impl/p1-reference-slice-1` / PR #2 (draft → `main`) | `ac754f5` | open, unmerged | CI `37647218352` green; local 92/92 (13 protocol-types + 79 host) on 2026-10-09 |
| Slice 7 original head | PR #6 | `6093344` | superseded by merge | CI `37304905397` green (147) ; Chief review `5414377372` — 1 blocker, 3 important |
| Slice 7 reconciled head | `impl/p1-slice-7-three-client` / PR #6 (draft → consolidated) | `d22ba57` | superseded | local build + 147/147; CI `37976850077` green |
| Slice 7 corrected head | `impl/p1-slice-7-three-client` / PR #6 (draft → consolidated) | `8cca804` | open, unmerged; awaiting Chief re-review | local 176/176 (13+79+54+30); CI `38004772113` green; R1 independent review approve-with-nits |
| Reporting system | PR #7 | merge `7114288` | merged into consolidated | — |
| Host conformance | `impl/p1-conformance-host` / PR #8 (draft → consolidated) | `9904792` | open, unmerged | local 114/114 (13+101); one host fix (D6) |
| Headless agent | `impl/p1-slice-8-headless-agent` / PR #9 (draft → Slice 7 branch) | `7a03bc4` | open, unmerged | 271/271; CI `38056529570` green; R2 review: changes required → fixed → approve-with-nits |
| Acceptance suite | `impl/p1-acceptance` / PR #10 (draft → agent branch) | `bd54736` | open, unmerged | 279/279; CI `38056634725` green (Linux/Node 22) |
| Integration candidate | `integration/p1-reference-candidate` / PR #11 (draft → consolidated; not for merge) | `7bf1613` | open | local 314/314 |
| Slice 7 demo fix | PR #6 | `51ea66d` | open | CI `38005995928` green |
| **Final heads (2026-10-10)** | PR #6 `8bac544` (CI `38057287536`) · PR #8 `212425b` (CI `38057341063`) · PR #9 `c72fe7e` (CI `38057345997`) · PR #10 `50d54e3` (docs-only after `5a58a0c`, CI `38057347643`) · PR #11 `077b222` (docs-only after `d41cd38`, CI `38057370967`) | | all open, draft, unmerged | integration 326/326 |
| Releases / tags | — | — | none exist | GitHub API 2026-10-09 |

---

## E. Blocker and approval register

| # | Item | Impact | Milestone | Owner | Resolution needed | External / approval? |
| --- | --- | --- | --- | --- | --- | --- |
| A1 | Merge PR #6 into `impl/p1-reference-slice-1` | Consolidated branch lacks browser client until merged | M1 → M4 | Human (mission owner) | Chief re-review of `8cca804`, then merge approval | **Approval required** — requested 2026-10-10 |
| A2 | Merge PR #2 into `main` | Reference implementation absent from `main` | M4 | Human | Approval after M4 gate | **Approval required** — not yet requested |
| A4 | Spec rulings from M3-HOST: (a) client→host host-publication type: `unsupported_message` vs `invalid_message` (C25); (b) error code for empty/non-object patch (§14.10) | Tests tolerate/pin current behavior | M3 | Human | Ruling or accept current | Approval only if spec text changes |
| A3 | Normative clarification: §14.14 should state enter reasons are `subscription`/`interest` only | Spec text ambiguity (R1 M3); implementation already follows review instruction | M1/M5 | Human | Approve or reject one-line spec edit | **Approval required** (normative text) |
| B1 | GitHub MCP connector failed to connect | None (mitigated) | — | Coordinator | `gh` CLI used instead | No |

---

## F. Continuation handoff

*Last updated: 2026-10-10 — primary gate passed; stretch (M5) next.*

**Engineering result:** **P1 Reference Implementation Complete — candidate for approved integration.** Not merged, not released, not deployed, not formally accepted.

**Evidence.** Integration head `d41cd38` (PR #11): build incl. Vite bundle; 326/326 tests (protocol-types 13, reference-host 119, client-core 90, three-client 32, agent-client 64, p1-acceptance 8); CI `38057370967` green on Linux/Node 22. Conformance: 35 reference-applicable cases = 31 pass + 4 pass-with-documented-adaptation (C10, C15, C21, C25), 0 incomplete ([matrix](evidence/conformance-matrix-final.md)). §16 happy path: automated (`packages/p1-acceptance/src/happy-path.test.ts`) and real-browser ([run](evidence/browser-acceptance-2026-10-10.md); performed on `8cca804`/`c5b71fe`, later changes were tests/docs/demo-label/robustness). Reviews: R1 (Slice 7 corrections) approve-with-nits; R2 (agent) changes-required → fixed → approve-with-nits; R3 (combined diff) approve-with-nits, doc items fixed.

**Recommended approved-merge order into `impl/p1-reference-slice-1`:** #6 → #9 → #10, and #8 (independent; only `CHANGELOG.md` overlaps, merges cleanly). Close #11 afterwards. Then PR #2 → `main` is a separate approval.

**Approvals pending:** A1 (merge #6), A2 (merge #2), A3 (§14.14 enter-reason wording), A4 (C25 / §14.10 error-code rulings); merges of #8/#9/#10 likewise require approval.

**Known non-blocking caveats / debt:** single shared duplicate-key scanner for host+client (R1 M2); client does not bound inbound frame size / view size against advertised limits (R1 D2, R3); `package-lock.json` untracked and CI uses `npm install` (recommend committing a lockfile + `npm ci`); `hvtp-agent` bin lacks exec bit (documented invocation uses `node`); Node `fetch` keep-alive reuse after same-port restart (test-only mitigation); P1ThreeView attached to an already-LIVE client renders nothing until the next reset (R1 D1); browser loader has no fetch timeout (optional in shared policy); demo exposes `window.hvtpDemo` (use `.client` for any future browser E2E protocol assertions).

**Next actions.** (1) Await human merge decisions. (2) M5 stretch: independent consumer in a different runtime (Python) over captured P1 wire traces for C23/C37; must not reuse client-core, the Three.js adapter, or reducer code.

**Commands.** `git fetch origin && git worktree list`; in a checkout of `integration/p1-reference-candidate`: `npm install --no-audit --no-fund && npm run build && npm test`; `npm run acceptance`; `gh pr list -R Ingenium-Studios/HyperverseTransferProtocol`.
