# syntax=docker/dockerfile:1
# Portable source build using public upstream inputs; see README.md for capacity requirements.
FROM node:24.22.2-bookworm-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9 AS baseline
# Node's official Linux release toolchain is RHEL8 + GCC-toolset12. UBI8 keeps
# that glibc2.28/libstdc++ compatibility floor; Debian12 can exceed AL2023's ABI.
FROM registry.access.redhat.com/ubi8/ubi:8.10@sha256:c322aa68f2d630b36b9faab64094357f62720be2f56f7099376ca2d6c4fe389b AS prepared
RUN dnf -y --enablerepo=ubi-8-codeready-builder-rpms install \
      gcc-toolset-12-gcc-12.2.1-7.8.el8_10 gcc-toolset-12-gcc-c++-12.2.1-7.8.el8_10 \
      gcc-toolset-12-binutils make ninja-build python39 curl ca-certificates tar xz patch openssl \
    && dnf clean all \
    && ln -s /usr/bin/python3.9 /usr/local/bin/python3
ENV PATH="/opt/rh/gcc-toolset-12/root/usr/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
    PYTHON=/usr/bin/python3.9
COPY --from=baseline /usr/local/bin/node /usr/local/bin/node
WORKDIR /src
RUN curl --fail --show-error --location --proto '=https' --proto-redir '=https' \
      https://nodejs.org/dist/v24.22.2/node-v24.22.2.tar.xz -o node.tar.xz \
    && echo '8fe2ec1723bb9f8d0b683907c82708debbeda64af21cb2aa214c4241eed0a061  node.tar.xz' | sha256sum --check --strict \
    && tar -xJf node.tar.xz && mv node-v24.22.2 node && rm node.tar.xz
WORKDIR /src/node
COPY node-gzwrite.patch /proof/node-gzwrite.patch
COPY gzwrite-probe.c verify.mjs compatibility.mjs abi.py /proof/
# Pin the upstream source AND the exact unmodified upstream patch before apply.
RUN echo '2ce783294c688330c716bfe106f43167d3dae5be84994176bc304d205d4f5b04  deps/zlib/gzwrite.c' | sha256sum --check --strict \
    && echo '110ff14375733173d8aa54574473424fbd7dfe4b81f1ca34a759c6fe14b15b14  /proof/node-gzwrite.patch' | sha256sum --check --strict \
    && curl --fail --show-error --location --proto '=https' --proto-redir '=https' \
      https://github.com/madler/zlib/commit/df84af25dc1942490e1d1c899a07619152a46148.patch -o /proof/vendor.patch \
    && cmp /proof/vendor.patch /proof/node-gzwrite.patch \
    && gcc -shared -fPIC -O2 -Wall -Wextra -Werror -Isrc -Ideps/zlib /proof/gzwrite-probe.c -o /proof/gzwrite-probe.node \
    && readelf -d /proof/gzwrite-probe.node > /proof/addon-dynamic.txt \
    && ! grep -q 'libz.so' /proof/addon-dynamic.txt \
    && /usr/local/bin/node /proof/verify.mjs baseline /proof/baseline.json \
    && patch --directory=deps/zlib --strip=1 --fuzz=0 --forward < /proof/node-gzwrite.patch
# Cache the verified source/baseline independently of the long compilation.
FROM prepared AS build
# Ninja is an upstream-supported build driver. Keep the same optimized release
# features, native architecture, and two-job memory bound; allow a six-hour job.
RUN python3 configure --ninja --prefix=/opt/patched-node --without-npm --without-corepack \
    && ninja -C out/Release -j2 \
    && ln -s out/Release/node node \
    && out/Release/node /proof/verify.mjs patched /proof/patched.json \
    && python3 tools/test.py --mode=release -j2 'parallel/test-zlib*' \
    && mkdir -p /artifact/usr/local/bin /artifact/usr/share/opencrawl-node-runtime \
    && cp out/Release/node /artifact/usr/local/bin/node \
    && cp LICENSE /artifact/usr/share/opencrawl-node-runtime/LICENSE \
    && cp /proof/baseline.json /proof/patched.json /proof/node-gzwrite.patch /artifact/usr/share/opencrawl-node-runtime/ \
    && python3 /proof/abi.py out/Release/node /proof/gzwrite-probe.node /artifact/usr/share/opencrawl-node-runtime/elf-abi.json \
    && rpm -qa --qf '%{NAME}-%{VERSION}-%{RELEASE}.%{ARCH}\n' > /proof/build-packages.txt \
    && sort /proof/build-packages.txt > /artifact/usr/share/opencrawl-node-runtime/build-packages.txt \
    && openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj /CN=localhost \
      -addext subjectAltName=DNS:localhost -keyout /proof/localhost.key -out /proof/localhost.crt

# Exercise a second public glibc userland. This proves binary compatibility,
# not the operator's host kernel, systemd or deployment configuration.
FROM amazonlinux:2023@sha256:3ccfbe800f864982b0a4e124a614b2382518cbd04b3c1cd35202bd46f392675b AS al2023
RUN dnf -y install libstdc++ ca-certificates && dnf clean all
COPY --from=build /artifact/ /candidate/
COPY --from=build /proof/ /proof/
RUN /candidate/usr/local/bin/node /proof/verify.mjs patched /proof/al2023-native.json \
    && /candidate/usr/local/bin/node /proof/compatibility.mjs /candidate/usr/share/opencrawl-node-runtime/al2023.json

# No builder, addon or temporary TLS private key enters the final artifact.
FROM scratch AS artifact
COPY --from=al2023 /candidate/ /

# A locally built glibc runtime for optional Node-only integrations. Its source,
# patch and acceptance are the same public recipe as the exported artifact.
FROM baseline AS runtime
COPY --from=artifact /usr/ /usr/
RUN rm -rf /usr/local/lib/node_modules /opt/yarn-* \
    && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg \
    && node -e "const fs=require('node:fs'),crypto=require('node:crypto');const p=JSON.parse(fs.readFileSync('/usr/share/opencrawl-node-runtime/patched.json'));if(p.expectation!=='patched'||p.result.inputReset!==true||p.result.externalBufferRetained!==false||p.binarySha256!==crypto.createHash('sha256').update(fs.readFileSync(process.execPath)).digest('hex'))process.exit(1)"
USER node
CMD ["node"]
