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
| M0-B | M0 | Inspect specs, host, client, guidance | Coordinator | active | — | — | — | — |
| M0-C | M0 | C01–C37 conformance evidence inventory | W2 (discovery) | active | read-only `6093344` | — | — | — |
| M0-D | M0 | Dependencies, work packages, integration strategy | Coordinator | validated | — | M0-A | this ledger | — |
| M1-R | M1 | Reconcile PR #6 with consolidated head | Coordinator | validated | `impl/p1-slice-7-three-client` | — | local 147/147; CI `37976850077` green | merge `d22ba57` |
| M1-B1 | M1 | Unmatched `subscription.applied` must not activate a generation | W1 (impl) | active | `impl/p1-slice-7-three-client` | M1-R | — | — |
| M1-I1 | M1 | Host-frame parser must not apply 128-byte client-ID rule | W1 | active | same | M1-R | — | — |
| M1-I2 | M1 | Leave reason `authorization` (leave only) in types + runtime | W1 | active | same | M1-R | — | — |
| M1-I3 | M1 | `P1ThreeView` / fixture-loader dispose lifecycle | W1 | active | same | M1-R | — | — |
| M1-DOC | M1 | History/doc impact for Slice 7 | Coordinator | planned | same | M1-B1..I3 | — | — |
| M1-REV | M1 | Independent review of corrected Slice 7 head | Reviewer | planned | — | M1-B1..I3 | — | — |
| M2-D | M2 | Headless agent design + §16 test design | W3 (design) | active | read-only `6093344` | — | — | — |
| M2-IMPL | M2 | Headless agent package, CLI, tests | TBD | planned | stacked on Slice 7 | M1-REV, M2-D | — | — |
| M3 | M3 | Close reference-applicable conformance gaps | TBD | planned | stacked | M0-C | — | — |
| M4 | M4 | §16 happy path, runbook, acceptance package | TBD | planned | stacked | M2, M3 | — | — |
| M5 | M5 | Independent consumer (C23/C37) | TBD | deferred | — | M4 gate | — | — |

---

## C. Decision log

| # | Date | Decision | Rationale / alternatives | Scope | Evidence | Human approval? |
| --- | --- | --- | --- | --- | --- | --- |
| D1 | 2026-10-09 | Reconcile PR #6 with the consolidated branch by a **non-destructive merge commit** into `impl/p1-slice-7-three-client`. | Rebase would rewrite reviewed history and require a force-push of a shared branch (rejected). Only overlapping file was `README.md`; it auto-merged. | M1 | merge `d22ba57`; local 147/147; CI `37976850077` | No (authorized branch sync) |
| D2 | 2026-10-09 | Keep this operational ledger at `docs/expeditions/P1-REFERENCE-EXPEDITION.md` on branch `expedition/p1-reference`. | AGENTS.md forbids a competing history artifact without explicit decision; the mission owner's mandate explicitly requested this ledger. It is operational only; lasting history moves to CHANGELOG/journal at completion. | All | this file | Mandated by mission owner |
| D3 | 2026-10-09 | B1 policy: an unknown-ref `subscription.applied` is **inert** (no state change, no close). A ref matching a pending non-`subscription.set` request is a host protocol violation handled by existing client conventions. A matching `subscription.set` whose `previousSubscriptionId` is no longer active settles the request but never reactivates. | A duplicate terminal response for an already-settled retransmission can legitimately arrive, so treating every unknown ref as fatal would be over-strict; correlation still gates all activation (Profile §10.1, C28). | M1 | PR #6 review B1 | No |
| D4 | 2026-10-09 | Tooling: GitHub MCP connector unavailable in this runtime; use authenticated `gh` CLI. Workers are in-session sub-agents; local worktrees live under `.worktrees/` (git-excluded). | Verified tool availability rather than assuming. | All | — | No |
| D5 | 2026-10-09 | Merge-gated work stacks: M2+ branches are cut from the reviewed Slice 7 head and their draft PRs target the branch below them, so each PR diff contains only its own work. | Avoids idling on merge approval; keeps provenance per slice. Alternative (wait for PR #6 merge) rejected as unnecessary blocking. | M2–M4 | — | No (merges themselves remain gated) |

---

## D. Artifact ledger

| Artifact | Ref | SHA | State | Evidence |
| --- | --- | --- | --- | --- |
| `main` | branch | `afd3563` | spec merged (PR #1) | — |
| Consolidated implementation | `impl/p1-reference-slice-1` / PR #2 (draft → `main`) | `ac754f5` | open, unmerged | CI `37647218352` green; local 92/92 (13 protocol-types + 79 host) on 2026-10-09 |
| Slice 7 original head | PR #6 | `6093344` | superseded by merge | CI `37304905397` green (147) ; Chief review `5414377372` — 1 blocker, 3 important |
| Slice 7 reconciled head | `impl/p1-slice-7-three-client` / PR #6 (draft → consolidated) | `d22ba57` | open, unmerged | local build + 147/147; CI `37976850077` green |
| Reporting system | PR #7 | merge `7114288` | merged into consolidated | — |
| Releases / tags | — | — | none exist | GitHub API 2026-10-09 |

---

## E. Blocker and approval register

| # | Item | Impact | Milestone | Owner | Resolution needed | External / approval? |
| --- | --- | --- | --- | --- | --- | --- |
| A1 | Merge PR #6 into `impl/p1-reference-slice-1` | Consolidated branch lacks browser client until merged | M1 → M4 | Human (mission owner) | Approval after M1-REV passes | **Approval required** — not yet requested |
| A2 | Merge PR #2 into `main` | Reference implementation absent from `main` | M4 | Human | Approval after M4 gate | **Approval required** — not yet requested |
| B1 | GitHub MCP connector failed to connect | None (mitigated) | — | Coordinator | `gh` CLI used instead | No |

---

## F. Continuation handoff

*Last updated: 2026-10-09 (M0/M1 in progress).*

**Verified state.** See Artifact ledger. Remote SHAs matched the mandate on 2026-10-09. PR #6 was reconciled with merge `d22ba57` and pushed (fast-forward, no force).

**Environment.** Node 24 locally (CI Node 22; `engines` ≥ 22.13); npm 11; TypeScript 7.0.2; `npm install && npm test` at repo root runs all workspace suites. Python 3.12 available (candidate for M5 independent consumer). Browser validation available through an in-app browser.

**Active work.** W1 Slice 7 corrections (commits locally on `impl/p1-slice-7-three-client`; Coordinator reviews and pushes). W2 conformance inventory (read-only). W3 headless-agent design (read-only).

**Unresolved findings.** PR #6 review `5414377372`: B1, I1, I2, I3 (in progress).

**Approvals pending.** None requested yet (A1/A2 will be requested once their gates pass).

**Next actions.**
1. Review W1 diff on the exact head; run full build/tests; independent review; push; record CI.
2. Slice 7 history-doc updates (CHANGELOG `Unreleased`, RELEASE_NOTES `Unreleased`, journal entry update).
3. Fold W2 inventory into the M3 matrix; cut M2 branch from reviewed Slice 7 head using W3 design.

**Commands.** `git fetch origin && git worktree list`; `npm install --no-audit --no-fund && npm run build && npm test`; `gh pr view 6 -R Ingenium-Studios/HyperverseTransferProtocol`; `gh run list -R Ingenium-Studios/HyperverseTransferProtocol --branch <branch>`.
