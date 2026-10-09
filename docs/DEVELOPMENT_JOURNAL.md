# Development Journal

This journal preserves **significant non-release engineering context** that would otherwise disappear between pull-request history and release notes. It is event-based, concise, and evidence-driven.

Use it for architectural evolution, meaningful refactors, investigations, migrations, infrastructure work, testing improvements, important debugging discoveries, abandoned approaches, and technical-debt reduction. Do not log routine edits or duplicate every commit.

Each entry should state status clearly (for example: investigated, implemented locally, merged to a development branch, released) and reference PRs/issues/commits/ADRs when useful.

## 2026-10-06 — Project history/reporting baseline introduced

**Status:** merged into the consolidated implementation branch via [#7](https://github.com/Ingenium-Studios/HyperverseTransferProtocol/pull/7); not released.

A lightweight project-history system was introduced so future Chiefs can reconstruct internal progress separately from public release notes. The repository now distinguishes granular evidence (PRs/issues), technical release history, client-facing release notes, and non-release engineering context. Evidence: [#7](https://github.com/Ingenium-Studios/HyperverseTransferProtocol/pull/7).

The initial history below is explicitly reconstructed from existing PR evidence rather than presented as contemporaneous diary entries.

## 2026-10-03 to 2026-10-05 — P1 protocol and reference-host foundation

**Status:** reconstructed; protocol PR merged to `main`; host Slices 1–6 merged into the consolidated implementation branch; no software release published.

- HVTP 0.2 was redesigned from a glTF-centric shared scene model into an engine-neutral entity/component protocol with explicit authority, presence, subscription/view lifecycle, persistence, and interoperability acceptance gates. ([#1](https://github.com/Ingenium-Studios/HyperverseTransferProtocol/pull/1))
- The reference implementation was intentionally built in bounded slices instead of one large merge. Slices 1–3 established negotiation, snapshots, SQLite persistence, restart recovery, and the TypeScript workspace under consolidated PR [#2](https://github.com/Ingenium-Studios/HyperverseTransferProtocol/pull/2).
- Slice 4 established durable mutation semantics and ordered canonical publication, including fixes discovered through adversarial Chief review around presence identity, post-commit convergence, revision metadata, and validation precedence. ([#3](https://github.com/Ingenium-Studios/HyperverseTransferProtocol/pull/3))
- Slice 5 introduced a planned-tail per-connection view model for exact snapshot/subscription boundaries, serialized generations, and bounded catch-up. This was a deliberate architecture choice so delayed transport delivery cannot change the canonical cut used for subscription transitions. ([#4](https://github.com/Ingenium-Studios/HyperverseTransferProtocol/pull/4))
- Slice 6 unified coordinator and transport-pending output under one per-connection byte budget and added deterministic rate/resource tests. Review found and corrected an unsafe “substitute a smaller terminal response” behavior and an asset-stream error path before merge. ([#5](https://github.com/Ingenium-Studios/HyperverseTransferProtocol/pull/5))

**Important project state:** these changes are development progress, not a published version. GitHub Releases remains empty.

## 2026-10-05 — Browser reference client work opened for review

**Status:** in review; draft PR open; not merged and not released.

Draft PR [#6](https://github.com/Ingenium-Studios/HyperverseTransferProtocol/pull/6) introduces an engine-neutral client core plus a Three.js browser adapter. Its first reviewed head passed 147 automated tests, but Chief review requested a bounded correction pass before merge, including tighter `subscription.applied` correlation, host-frame ID parsing, transition-reason type alignment, and renderer/asset disposal lifecycle fixes.

This work must not be reported as completed/merged until the PR evidence changes.

**Update 2026-10-10 — correction pass completed on branch; still in review, not merged.** The branch was first reconciled with the consolidated line by a non-destructive merge (no history rewrite). All four review findings were then fixed with regression tests that fail on the previous code: correlated-only subscription activation (an unknown-ref `subscription.applied` is treated as inert terminal noise rather than a protocol violation, because a duplicate terminal response for an already-settled retransmission can legitimately arrive), a host-frame JSON parser that no longer applies client request-ID admission rules, split enter/leave reason sets, and an explicit detach-before-dispose renderer lifecycle with exactly-once template release and a deterministic resource-leak test. Suite grew from 147 to 174 tests.
