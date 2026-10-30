# Changesets

This directory holds pending release notes. Every PR that changes a published package adds a changeset with `pnpm changeset`; the files are consumed by `pnpm version-packages` on the release branch, which bumps each package independently and writes its `CHANGELOG.md`. See [CONTRIBUTING.md](../CONTRIBUTING.md#versioning-and-changelogs).
