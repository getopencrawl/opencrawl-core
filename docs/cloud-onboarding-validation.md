# Cloud onboarding persistence validation

Verified on 2026-11-13 UTC using disposable, operator-owned Replicas and Boxes environments. The fixture contained only a README; no product repository, saved OpenCrawl login, capture credential, or personal agent configuration was imported. Provider-native Claude and Codex sessions performed the checks.

## Scope and acceptance

The setup session must use the provider's built-in CLI to save persistent configuration, preserve unrelated settings, and read back the saved script. Reapplying the installation must leave one owned SessionStart hook per client. A new machine must then receive the files and expose the skill in each harness's initial context, without an agent first repairing the setup.

The test installs `@getopencrawl/cli@next` into a user-owned prefix, invokes `opencrawl skills install --client codex --client claude-code --json`, and writes a completion marker only after both succeed. This deliberately tests credential-free static preparation. Authentication, MCP access, capture enrollment, successful board registration, indexing, and human browser onboarding are separate acceptance gates.

## Replicas

- A normal workspace session used the built-in `replicas` CLI and existing workspace identity to test, save, and read back its environment's warm and start hooks. No additional API key was needed for these edits.
- Warm execution used `user`, UID 1001, HOME `/home/user`; no root-to-user adaptation was required. Installed files belonged to that user.
- Warm `save-test`, start `test` followed by `save`, and identical reapplication all succeeded. Readback SHA-256 values matched the tested files. Repeated installation reported unchanged skills/hooks and preserved unrelated configuration.
- A fresh workspace's provider logs showed the warm hook finishing at 04:24:00 UTC and the start hook at 04:24:20 UTC, both exit 0 with no timeout. CLI version was 0.4.56.
- Its first Claude turn found `opencrawl` in the skill catalog and received the expected unauthenticated SessionStart message. A new Codex chat found `/home/user/.agents/skills/opencrawl/SKILL.md`; it received no startup receipt while normal hook review remained pending. Neither probe used tools.
- The standalone hook-test sandbox could run scripts but could not edit the environment through workspace identity (`Workspace not found`). That negative result did not apply to the real workspace. The workstation CLI also rejected workspace creation with the existing user JWT, so creation used the normal signed-in browser UI.

Use warm preparation for files that must exist before harness initialization. Runtime hooks refresh the CLI and managed files, then authenticate/enroll under the new workspace identity. They are not a per-chat installer. Confirm a fresh workspace after editing an environment; a successful save or test alone is insufficient.

## Boxes

- A native session on the disposable Template box used `dvb-onbox project lifecycle`. The first write required the normal project-editing permission. The owner approved the specific temporary request; no persistent permission defaults or hook trust changed.
- The session saved the script using the current revision guard and a 120-second timeout. Identical reapplication retained the same revision and unrelated settings. The service removed one final newline; both raw hashes and the normalized comparison were retained in the validation receipt.
- An empty devbox created with `dvb devboxes create`, followed by a thread targeting that existing devbox, had neither the completion marker nor the skill. Do not infer startup execution from that creation path.
- `dvb threads start --target new-devbox` ran the saved startup successfully. The marker recorded 04:25:45 UTC and CLI 0.4.56. Its first Codex turn discovered the skill. A fresh Claude thread on the same machine discovered the skill and received the expected unauthenticated SessionStart message. Neither probe used tools.
- The native Template session published a snapshot with `dvb-onbox snapshot --json` after checking that no OpenCrawl login, capture configuration/data, or credential environment variables were present. A new bare devbox inherited both skill files and the startup runner, plus the original 04:16:46 UTC marker and CLI 0.4.55. Its first Codex turn discovered the skill without running the startup installer. Security policy hashes were unchanged.

The [Boxes lifecycle documentation](https://boxes.dev/help/lifecycle-and-maintenance) says startup runs once before the first agent turn, with a 1–120 second timeout; failure can still allow the agent to start. The [agent command reference](https://boxes.dev/help/agent-command-reference) documents the in-session permission, revision guards, and Template editing workflow. The observed empty-devbox exception is why onboarding must inspect actual results and verify its chosen creation path.

## Boundaries

No test granted Codex hook trust, changed agent security policy, authenticated OpenCrawl, enabled capture, or claimed end-to-end onboarding. A skill in the catalog is evidence of discovery, not successful registration. Claude's authentication error proves hook delivery only. Static Template/warm preparation must not contain copied human sign-ins or capture ownership/data. Shared templates also require their own administrator authority and must not distribute personal credentials or session history.

The shared setup prompt belongs in core and interpolates the caller's API origin. This change introduces no hosted dependency, identity behavior, storage change, or CLI release. The existing prompt contract is exercised with a non-hosted API origin; the core suite and strict build remain the release checks.
