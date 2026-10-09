# Technical Changelog

This file records meaningful technical changes associated with HVTP software releases and the current unreleased development line. It is intentionally curated: pull requests and issues remain the granular evidence of work.

This project has **not published a GitHub Release yet**. The `0.1.0` values currently present in package metadata are development metadata and are not evidence that version `v0.1.0` was released.

Release versions use Semantic Versioning when a real software release boundary is approved. HVTP protocol/profile versions (for example, HVTP 0.2 / P1) are protocol identifiers and are not automatically the same as software release versions.

## [Unreleased]

> **Reconstructed baseline — 2026-10-06.** This section was backfilled from reviewed pull-request history and the consolidated implementation branch. It describes development work that is merged into the implementation line or otherwise explicitly noted below; it does **not** mean a version has been released or deployed.

### Protocol and compatibility

- Reworked HVTP 0.2 around an engine-neutral entity/component world model, explicit authority and presence, durable/view lifecycle semantics, and the P1 interoperability profile. The normative P1 conformance suite now defines C01–C37 and distinct Reference Implementation Complete / Interoperability Accepted gates. ([#1](https://github.com/Ingenium-Studios/HyperverseTransferProtocol/pull/1))
- Defined exact P1 transform, material, snapshot, request-deduplication, subscription-generation, persistence, resource-limit, malformed-wire, and asset behavior, including the checked-in one-metre unit-cube glTF fixture. ([#1](https://github.com/Ingenium-Studios/HyperverseTransferProtocol/pull/1))

### Reference host

- Added the TypeScript P1 reference-host foundation: HVTP negotiation, realm join, private session presence, ordered initial snapshots, and the checked-in asset endpoint. The consolidated implementation is tracked in draft PR [#2](https://github.com/Ingenium-Studios/HyperverseTransferProtocol/pull/2).
- Added SQLite-backed durable shared state, component revisions, permanent tombstones, restart recovery, and current-epoch realm sequence handling. ([#2](https://github.com/Ingenium-Studios/HyperverseTransferProtocol/pull/2))
- Added durable wire mutations (`entity.create`, `entity.delete`, `component.set`, `component.patch`), request-ID deduplication/conflict handling, terminal ACK/error behavior, canonical publications, presence protections, and ordered visibility projection. ([#3](https://github.com/Ingenium-Studios/HyperverseTransferProtocol/pull/3))
- Added post-join `subscription.set`, serialized subscription generations, atomic snapshot/live handoff, view tracking, exact replacement boundaries, bounded catch-up buffers, and explicit live-view overflow behavior. ([#4](https://github.com/Ingenium-Studios/HyperverseTransferProtocol/pull/4))
- Added request/mutation rate limits, unified per-connection outbound-byte accounting, complete fragmented WebSocket size/UTF-8 handling, safe-integer overflow protection, persistent-record limits, asset-origin/size hardening, and exact-response-or-close behavior under outbound exhaustion. ([#5](https://github.com/Ingenium-Studios/HyperverseTransferProtocol/pull/5))

### Reliability, tests, and operations

- Expanded deterministic unit and real-WebSocket integration coverage across persistence, revision conflicts, request retries, snapshot boundaries, publication ordering, subscription generations, resource exhaustion, malformed input, restart behavior, and failure-after-commit uncertainty. ([#2](https://github.com/Ingenium-Studios/HyperverseTransferProtocol/pull/2), [#3](https://github.com/Ingenium-Studios/HyperverseTransferProtocol/pull/3), [#4](https://github.com/Ingenium-Studios/HyperverseTransferProtocol/pull/4), [#5](https://github.com/Ingenium-Studios/HyperverseTransferProtocol/pull/5))
- Enforced the advertised `maxAssetUriCharacters` limit on entity creation: an over-long asset URI (counted in Unicode code points) is rejected with `resource_limit` before the exact-fixture check; other non-fixture URIs remain `invalid_component_state`. Added real-WebSocket host conformance coverage for C02/C03/C10/C14/C15/C16/C17/C18/C20/C24/C25/C26/C27/C29/C32/C34/C35, and strengthened the C19/C24 no-extra-publication assertions. ([#8](https://github.com/Ingenium-Studios/HyperverseTransferProtocol/pull/8))
- Hardened host failure paths so invalid/oversized WebSocket frames and asset open/read failures do not become process-level unhandled errors. ([#5](https://github.com/Ingenium-Studios/HyperverseTransferProtocol/pull/5))

### Release status

- No software version in this changelog has been released yet.
- GitHub Releases is currently unused.
- Draft PR [#2](https://github.com/Ingenium-Studios/HyperverseTransferProtocol/pull/2) remains the consolidated implementation line targeting `main`.
