# AGENTS.md

These instructions apply to the entire repository.

## Project history and evidence

Use a small hierarchy of sources instead of duplicating the same history everywhere:

1. **Pull requests and issues** are the primary granular evidence of work, review, decisions, status, and provenance.
2. **[CHANGELOG.md](./CHANGELOG.md)** is the authoritative curated technical history for released versions plus the current `Unreleased` technical delta.
3. **[RELEASE_NOTES.md](./RELEASE_NOTES.md)** is the authoritative client/user-facing release history.
4. **[docs/DEVELOPMENT_JOURNAL.md](./docs/DEVELOPMENT_JOURNAL.md)** preserves significant non-release engineering context.
5. **GitHub Releases** are explicit shipped-version milestones and are created only for real approved releases.

Commit history is supporting evidence when PR/issue history is incomplete; it is not, by itself, proof that work was completed, merged, deployed, or released.

Do not create another overlapping changelog, journal, release ledger, or progress database without an explicit decision to replace one of the canonical artifacts above.

## Status language

Reports and documentation must distinguish these states:

- **Started / investigated:** work exists or was explored, but completion is not established.
- **Completed locally / on branch:** implementation or investigation reached its stated definition of done, but is not necessarily merged.
- **Merged:** a PR or equivalent change is merged into the stated target branch. Name the branch when it matters (for example, the consolidated implementation branch versus `main`).
- **Released:** an explicitly approved version boundary has been published as a GitHub Release/tag or other documented release mechanism.
- **Deployed:** runtime deployment evidence exists. Release and deployment are not synonyms.

Never infer “released” or “deployed” from commits, package version strings, or merged PRs alone.

## Documentation-impact checks

Every meaningful behavioral, architectural, configuration, API/protocol, deployment, testing, device, or workflow change requires a documentation-impact check.

Update the affected canonical documentation in the same PR when behavior or project truth changes. Documentation is part of implementation completion.

Routine typo/style-only edits do not require unrelated history updates.

## Changelog-impact checks

For every meaningful change, decide whether [CHANGELOG.md](./CHANGELOG.md) should change.

Update `Unreleased` when a merged/development change is technically meaningful to future developers/operators, including:

- protocol/API/compatibility changes;
- architecture or persistence behavior;
- migrations/configuration requirements;
- reliability/security/resource-limit fixes;
- important operational caveats;
- substantial testing or deployment changes that affect confidence or operation.

Do not dump every commit. Group related implementation work into meaningful bullets and reference the strongest PR/issue evidence.

Any release/version PR must include a changelog-impact check.

## Client release-note checks

Update [RELEASE_NOTES.md](./RELEASE_NOTES.md) only for changes that are user/client-visible or materially explain the effect of a release.

Prefer outcomes over implementation detail. Do not copy technical changelog bullets mechanically.

An internal refactor, test-harness rewrite, dependency cleanup, or architecture migration usually does not belong in client-facing notes unless it changes reliability, compatibility, performance, workflows, or another user-visible property.

## Development-journal checks

For significant internal engineering work, decide whether [docs/DEVELOPMENT_JOURNAL.md](./docs/DEVELOPMENT_JOURNAL.md) should change.

Add a concise entry when future progress reporting would otherwise lose useful context, for example:

- architectural evolution or a major refactor;
- investigation or experiment with a consequential result;
- abandoned approach and why it was abandoned;
- migration/infrastructure work;
- substantial test-strategy improvement;
- important debugging/root-cause discovery;
- technical-debt reduction that changes future maintenance;
- a decision that materially redirects subsequent work.

Do **not** add journal entries for routine fixes, formatting, trivial dependency bumps, or ordinary implementation details already well represented by a PR.

Entries should be event-based, not a daily diary, and should state evidence/status.

## Pull request checklist

The repository PR template contains three history-impact checks:

- documentation impact;
- changelog/release-note impact;
- development-journal impact.

“N/A” is valid when justified. The purpose is conscious review, not forcing every PR into every history file.

## Versioning and releases

Use Semantic Versioning for actual software release versions when appropriate.

Keep software release versions separate from protocol/profile identifiers: HVTP 0.2 / P1 does not automatically imply software release `v0.2.0`.

The current `0.1.0` package metadata is not historical proof of a released `v0.1.0`. As of the reporting-system baseline, this repository has no GitHub Releases.

When a real release is approved:

1. determine the SemVer version from the compatibility/user impact;
2. move the applicable `Unreleased` technical bullets into a dated version section in `CHANGELOG.md`;
3. move the applicable user-visible `Unreleased` notes into the same version/date in `RELEASE_NOTES.md`;
4. update package/version metadata only for artifacts actually included in that release;
5. merge the release/version PR;
6. create the version tag and GitHub Release only after the release boundary is real;
7. derive the GitHub Release body from the matching `RELEASE_NOTES.md` section and link to the corresponding `CHANGELOG.md` technical details rather than writing a third competing history.

Do not create a GitHub Release merely because development work occurred.

Preserve old release sections. Correct factual errors explicitly rather than rewriting historical truth for style.

## Reconstructing an internal progress report

For “since the last report,” “since version X,” or a date range:

1. establish the baseline anchor first: prior report date/SHA, release tag/version, or explicit start date;
2. collect merged PRs in the range and relevant closed/open issues;
3. use commit history only to fill evidence gaps or identify work not captured by PRs;
4. read the matching `CHANGELOG.md` sections for technically meaningful release/development changes;
5. read the development journal for refactors, investigations, architectural decisions, abandoned work, debugging, infrastructure, and test improvements;
6. check canonical protocol/docs for changed project truth;
7. check GitHub Releases/tags and deployment evidence separately;
8. classify each item as investigated, completed on branch, merged (and where), released, and/or deployed;
9. explicitly call out meaningful in-progress or abandoned work when the report asks about internal activity.

A good internal report should normally contain: period/baseline, completed+merged work, released/deployed work, significant internal engineering, in-progress/investigated work, risks/debt/follow-ups, and evidence links.

## Generating client-facing release notes

For a specific released version:

1. start from the matching version section in `RELEASE_NOTES.md`;
2. verify that the version has a real release boundary (tag/GitHub Release and any relevant deployment evidence);
3. cross-check merged PRs/issues and `CHANGELOG.md` for omissions;
4. include only user-visible capabilities, improvements, fixes, compatibility notes, and operational actions relevant to the client;
5. exclude journal-only implementation detail unless it materially explains user impact;
6. never promote an `Unreleased` item to “shipped” without release evidence.

## Repository scope

HVTP currently keeps the protocol specification and reference implementation in this repository, so this repository owns the unified project history.

If implementation components move to separate repositories later, each satellite repository may maintain its own technical changelog, but the project-level client release notes and cross-repository release milestone should remain in the repository designated as the HVTP project-history authority.
