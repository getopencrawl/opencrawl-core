# Published CLI runtime inspection

The standalone CLI embeds Bun, independently of the operator-provided Node
runtime used by the core package. This bounded diagnostic inspects the published
Linux CLI 0.4.13 on native x64 and ARM64 GitHub runners, with pinned npm integrity
values. It downloads three expected archive members without installing them,
runs a fixed script with a replacement environment, and removes its temporary
binary before writing the observation. It does not authenticate, load capture
configuration, invoke gzip-file functions, or publish a package.

`BUN_BE_BUN=1` allows locally controlled diagnostic JavaScript before the embedded
application's command parser. This is a runtime feature, not evidence of a remote
application exploit. The script checks the Linux default export namespace and
attributes resolved symbols to their owning executable or library. Known libc
symbols must resolve as positive controls.

A negative symbol lookup does not prove that code was removed, that internal
callers are absent, or that the library was patched. A positive result requires
provider attribution and a separate bounded native failure-path test before
claiming the bundled implementation is affected. Results deliberately retain
`runtimeRemediationProven: false` and `remoteExploitabilityProven: false`.

Use the **Published CLI runtime inspection** workflow. This is core-owned release
verification and has no hosted account, private shell, or cloud credential
dependency. The existing CLI release workflow and shipped binary are unchanged.
