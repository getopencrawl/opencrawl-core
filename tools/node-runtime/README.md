# Portable patched Node runtime

This directory builds an operator-owned Node 24.22.2 runtime from public upstream
inputs. It needs no OpenCrawl cloud account, WorkOS, private package registry or
proprietary repository. The repository and its existing license remain private;
this is not an announcement of an open-source release.

The exact upstream zlib fix
[df84af25dc1942490e1d1c899a07619152a46148](https://github.com/madler/zlib/commit/df84af25dc1942490e1d1c899a07619152a46148)
clears a caller-buffer reference after a failed native `gz_write`. The Node
source, patch and original affected file are SHA256-pinned in the Dockerfile.
This is a maintained backport, not an official Node release. Keep it until an
official supported Node release includes the verified fix.

## Build on the target architecture

Use a native Linux x64 or arm64 builder with at least two CPUs, 6 GiB of RAM and
10 GiB of free disk. The optimized V8 build can take several hours. Build each
architecture separately; emulation and a successful x64 build do not establish
arm64 acceptance. Do not start this build on a machine without that capacity.

From the repository root:

```sh
docker buildx build --target runtime --load \
  --tag opencrawl-node-runtime:24.22.2-opencrawl-zlib1-local tools/node-runtime
docker image inspect opencrawl-node-runtime:24.22.2-opencrawl-zlib1-local \
  --format '{{.Id}}'
```

Record that immutable image ID with the build receipts. For distribution through
your own registry, push it there and pin the resulting repository digest in your
deployment. No hosted OpenCrawl artifact is required. To export just the runtime
binary, original Node license, patch and proof files instead:

```sh
docker buildx build --target artifact --output type=local,dest=./node-runtime-artifact \
  tools/node-runtime
```

The binary targets GNU/Linux glibc, with the official Node ABI floor checked by
`abi.py`: GLIBC 2.28, GLIBCXX 3.4.25 and CXXABI 1.3.11. Do not copy it into Alpine
or another musl environment. The optional agent-session Compose receiver builds
the `runtime` target locally and uses its glibc base; its health check uses Node
rather than an Alpine-specific utility. Its Node process runs as the nonroot
`node` user. The image omits npm, Corepack and Yarn because this receiver uses no
runtime-installed dependencies. This does not change that legacy adapter's
protocol or authentication defaults; follow ARCHITECTURE.md before exposing it.

## Acceptance and scope

The native N-API probe deliberately does not link system libz. It exercises the
actual Node executable's exported gzwrite functions with a bounded write to
Linux `/dev/full`. The official binary must reproduce the vulnerable buffer
retention; the rebuilt binary must clear it and safely handle the follow-up.
Both receipts are retained, along with the exact patch and license. Node's
upstream zlib tests run against the rebuilt executable. An ELF check rejects
newer or unknown ABI requirements, extra linked libraries and runtime paths.
The same binary also runs the native probe, DNS and verified loopback TLS checks
in a second public AL2023 glibc userland. The final image verifies its executable
hash against the successful patched receipt.

The `prepared` target only verifies pinned inputs and the failing upstream
baseline. It is not a patched runtime. Pull-request CI deliberately labels that
limited check; complete native builds use the manual workflow. A successful
source build does not prove an operator's complete deployment, storage, workload
or rollback behavior. Validate those with the exact immutable runtime image.
Keep previous verified artifacts and data backups for recovery, and do not
silently fall back to the unpatched image on build failure.

Core's npm package uses the operator's supplied Node runtime; adding this recipe
does not replace an already-installed system Node. Compiled CLI releases bundle
Bun and require separate runtime review. This recipe does not certify them.
Build repositories can update packages, so installed RPM inventory is retained;
bit-for-bit reproducibility across future repository updates is not claimed.

For an upstream update, review whether the fix is present, refresh source and
image pins, repeat the native red/green and ABI checks on both architectures,
and validate the consuming application. Never use scanner suppression, hiding
symbols or replacing system libz as evidence that Node's bundled zlib was fixed.
