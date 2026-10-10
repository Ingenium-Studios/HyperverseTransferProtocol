# Release Notes

This is the **client/user-facing** history for HVTP releases. It describes visible capabilities, improvements, and fixes in clear language. Technical implementation detail belongs in [CHANGELOG.md](./CHANGELOG.md), while important non-release engineering context belongs in [docs/DEVELOPMENT_JOURNAL.md](./docs/DEVELOPMENT_JOURNAL.md).

A section appearing under **Unreleased** is not a claim that it has shipped. GitHub Releases and an approved version boundary are the evidence that a version was actually released.

## Unreleased

> **Development preview only.** HVTP has not published a GitHub Release yet. These notes summarize the user-visible direction already present in the consolidated development line.

### New capabilities

- HVTP now has an experimental P1 reference host that lets multiple clients join the same spatial realm and observe shared entities.
- Shared entities can be created, moved, recolored, and deleted through the protocol, with durable state preserved across host restarts.
- Clients can change what part of the realm they are interested in without confusing “leaving my view” with deleting an entity for everyone.
- The host advertises and serves a portable one-metre glTF cube fixture for interoperability testing.

- An experimental browser reference client shows the shared P1 realm in 3D, and a reusable engine-neutral client core lets other participants (such as headless agents) join the same realm without a renderer. *(In review; not merged.)*

- A headless reference agent can join the shared realm from the command line, read a shared object's structured state, and change it safely; browser users see its changes live. *(In review; not merged.)*

### Reliability and behavior

- Concurrent edits use explicit revision checks instead of silent last-writer-wins behavior.
- Reconnects take a fresh snapshot so clients recover from uncertain or interrupted operations without blindly replaying them.
- Subscription changes and snapshot catch-up are ordered so clients do not see later world changes overtake earlier ones.
- Resource limits now protect the reference host from oversized messages, excessive request rates, overly broad views, outbound backlogs, and persistent-record exhaustion.
- Invalid UTF-8, malformed JSON, and other invalid protocol messages are handled explicitly rather than becoming undefined behavior.

### Release status

- No client-facing version has been released yet.
- The first GitHub Release should be created only when an explicitly approved SemVer version is actually ready to ship; its description should be derived from this file and link to the matching technical section in [CHANGELOG.md](./CHANGELOG.md).
