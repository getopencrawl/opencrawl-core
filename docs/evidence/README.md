# Application-state verification evidence

`app-state-source-rehearsal.json` records the successful November 15, 2026
source-level migration rehearsal. Its candidate was the working implementation,
not a published release. The compiled-runtime fingerprint hashes a JSON array of
`[relativePath, sha256(fileBytes)]` for every `dist/src/**/*.mjs` file, ordered by
relative path using byte-compatible string comparison.

The unchanged v0.4.1 source created real Better Auth SQLite identity and registry
data. The fixture seeded 31 mutable objects in 18 state domains, and the old
PostgreSQL event repository retained a failed-upload reservation and its v2
source marker. The candidate imported 34 source entries, including the two
SQLite files and 32 mutable objects. An injected failure left the installation
unready; repeating the migration resumed the same source snapshot. Typed
repository readbacks, the old password, browser cookie and signing keys all
passed. Source SQLite and object bytes stayed identical, and the old runtime
passed its retained-source readbacks. The disposable namespace and source
scratch were removed after the test.

The source fixture is `deploy/test-full-app-state.mjs`. The reusable domain
regressions are `test/state-object-migration.test.mjs`,
`test/state-sqlite-migration.test.mjs` and `test/state-slack-capture.test.mjs`.
The source rehearsal does not replace the required full application acceptance
in `.github/workflows/self-host.yml`. That gate boots exact old images, exercises
the ordinary upgrade, failures, restart and next upgrade, restores matched
stores and old images, and verifies a retained Airbyte connector. Its final
artifact identifies the exact old and new revisions and recovery-manifest hash.
