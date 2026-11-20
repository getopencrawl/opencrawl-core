export type ArchivePin={url:string;sha256:string;metadataUrl:string;metadataSha256:string};
export type PackageRelease={ref?:string;minimumHarnessVersion?:string;memoryImportSkill?:boolean;continueSkill?:boolean;listingIcon?:boolean;harness:'claude-code'|'codex'|'cursor'|'antigravity';name:string;path:string;version:string;capabilities:string;captureAvailable:boolean;daemonHandoff:boolean;files?:Record<string,{sha:string;bytes:number}>;archives?:Record<string,ArchivePin>};
export type PluginRelease={repository:string;ref:string;schemaVersion:1;bindingSchemaVersion:1;packages:PackageRelease[]};

// Reviewed immutable package inventory from the public plugins repository.
// Update this pin only with matching capability and native acceptance evidence.
export const pluginRelease:PluginRelease = {
  "repository": "getopencrawl/opencrawl-plugins",
  "ref": "329d1c996a40e8ddb1a1cc5752560797a6971076",
  "schemaVersion": 1,
  "bindingSchemaVersion": 1,
  "packages": [
    {
      "harness": "claude-code",
      "name": "opencrawl-local-claude-code",
      "path": "local/claude-code",
      "version": "0.2.5",
      "capabilities": "capabilities.json",
      "captureAvailable": true,
      "daemonHandoff": true,
      "minimumHarnessVersion": "2.1.327",
      "archives": {
        "darwin-arm64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/local-claude-code-v0.2.5/opencrawl-local-claude-code-0.2.5-darwin-arm64.zip",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/local-claude-code-v0.2.5/opencrawl-local-claude-code-0.2.5-darwin-arm64.json",
          "sha256": "f5b6d22a1d5427b652d05512012d79c7f4a75ee6817c5cdd58f35023b49420ed",
          "metadataSha256": "d286c774ee1b8cb0071275aebdcb99d305a4d2e08a12e59ee64d56db929c257c"
        },
        "darwin-x64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/local-claude-code-v0.2.5/opencrawl-local-claude-code-0.2.5-darwin-x64.zip",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/local-claude-code-v0.2.5/opencrawl-local-claude-code-0.2.5-darwin-x64.json",
          "sha256": "834f424649fbfe3e31ee513414e7e040fba2141891059c78a42bd6046413b25d",
          "metadataSha256": "c557ffcf05871c471b1eb149c03c746c620e3437823b164c842cc6379603ca2a"
        },
        "linux-arm64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/local-claude-code-v0.2.5/opencrawl-local-claude-code-0.2.5-linux-arm64.zip",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/local-claude-code-v0.2.5/opencrawl-local-claude-code-0.2.5-linux-arm64.json",
          "sha256": "05da63d92683c948ea4b24345e16dc9fcee421c640045ef93e32fb555e8f4f3d",
          "metadataSha256": "97fb76d577d233be61a8cbe1a1a74782f21dc0e9ae9c6dc6d304bf96b33f379e"
        },
        "linux-x64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/local-claude-code-v0.2.5/opencrawl-local-claude-code-0.2.5-linux-x64.zip",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/local-claude-code-v0.2.5/opencrawl-local-claude-code-0.2.5-linux-x64.json",
          "sha256": "aaa8811c39ffb361eac190316e15504d322479a26e5dabe7e657c4d8ba020782",
          "metadataSha256": "e8f341b2121a4af4c960fd8cca680de56ad11cbee1f4531f9da0d525fa927f88"
        },
        "win32-x64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/local-claude-code-v0.2.5/opencrawl-local-claude-code-0.2.5-win32-x64.zip",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/local-claude-code-v0.2.5/opencrawl-local-claude-code-0.2.5-win32-x64.json",
          "sha256": "4d5ff36cba62a4d110e983ea56e0a7df1993d7dd66906e92b85b70d73ddf0dc0",
          "metadataSha256": "714e6aba6b73e2cb2c0c7746d0eae441ade1f01739c8e64739fd30dde185591b"
        }
      },
      "ref": "329d1c996a40e8ddb1a1cc5752560797a6971076",
      "memoryImportSkill": true,
      "listingIcon": true,
      "continueSkill": true
    },
    {
      "harness": "codex",
      "name": "opencrawl-local-codex",
      "path": "local/codex",
      "version": "0.2.5",
      "capabilities": "capabilities.json",
      "captureAvailable": true,
      "daemonHandoff": true,
      "minimumHarnessVersion": "0.166.0",
      "archives": {
        "darwin-arm64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/local-codex-v0.2.5/opencrawl-local-codex-0.2.5-darwin-arm64.zip",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/local-codex-v0.2.5/opencrawl-local-codex-0.2.5-darwin-arm64.json",
          "sha256": "c5404cc10f2979d1e7398e55854cd81edf25b2cd978506f8205905995ce3e163",
          "metadataSha256": "7b485426828ee1d8051d4d1ac5ac4641164de2ba8455c0154c12e63deb48a9ee"
        },
        "darwin-x64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/local-codex-v0.2.5/opencrawl-local-codex-0.2.5-darwin-x64.zip",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/local-codex-v0.2.5/opencrawl-local-codex-0.2.5-darwin-x64.json",
          "sha256": "f9fd546c6e35c57f627930f3cf5df9659942574a9e9e2351aa4f2ff3abb8e838",
          "metadataSha256": "ac33a9517183fc35ce7f5d5ee23c696ee9bffe771f0319fad11e3d8f5689ac5e"
        },
        "linux-arm64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/local-codex-v0.2.5/opencrawl-local-codex-0.2.5-linux-arm64.zip",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/local-codex-v0.2.5/opencrawl-local-codex-0.2.5-linux-arm64.json",
          "sha256": "18d9c31fa55992b38ea61e17912ffcf7550f8a44cf0bf5e0c5d9a41d4cdd842b",
          "metadataSha256": "9dc6fdf107a26f11543a31acfad6e2549107e436e7286b2fd4e437a00020d06a"
        },
        "linux-x64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/local-codex-v0.2.5/opencrawl-local-codex-0.2.5-linux-x64.zip",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/local-codex-v0.2.5/opencrawl-local-codex-0.2.5-linux-x64.json",
          "sha256": "a3e295cd395ceabbcc7f8dd66d3dec55dec48c7ec43c1623dfcbf11cd30fd16c",
          "metadataSha256": "18cde2b575c0e6bd37873deb59c8df7cd102e3b65304121b5770ca3274ba73b2"
        },
        "win32-x64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/local-codex-v0.2.5/opencrawl-local-codex-0.2.5-win32-x64.zip",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/local-codex-v0.2.5/opencrawl-local-codex-0.2.5-win32-x64.json",
          "sha256": "2af43de90ed1772b764941dc42c621ea243d1b2a4fdaff0fb8254f5402695e78",
          "metadataSha256": "196bf3c7f532e3e061b15254bbe598626441a28e1d204c3bec3f1f3acd165ede"
        }
      },
      "ref": "329d1c996a40e8ddb1a1cc5752560797a6971076",
      "memoryImportSkill": true,
      "listingIcon": true,
      "continueSkill": true
    },
    {
      "harness": "cursor",
      "name": "opencrawl-local-cursor",
      "path": "local/cursor",
      "version": "0.2.5",
      "capabilities": "capabilities.json",
      "captureAvailable": true,
      "daemonHandoff": true,
      "minimumHarnessVersion": "2026.11.17-f532c45",
      "archives": {
        "darwin-arm64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/local-cursor-v0.2.5/opencrawl-local-cursor-0.2.5-darwin-arm64.zip",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/local-cursor-v0.2.5/opencrawl-local-cursor-0.2.5-darwin-arm64.json",
          "sha256": "c022c0dc400d740635d0fab44a22a772143ddc38ffe5257a2e5a1be1fff07305",
          "metadataSha256": "cf8423f1d3b2b94f7b31a4239b14817ed4ca9a57f14b4d898f2ccbabf456492f"
        },
        "darwin-x64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/local-cursor-v0.2.5/opencrawl-local-cursor-0.2.5-darwin-x64.zip",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/local-cursor-v0.2.5/opencrawl-local-cursor-0.2.5-darwin-x64.json",
          "sha256": "b314b1b0af8324ccb72325506c03846c8b1009b329ee2869548c2241c92d0bdc",
          "metadataSha256": "0523ab5607e09717f13b56b2a80de7d69537fae163ebd267e921bed7c31a044c"
        },
        "linux-arm64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/local-cursor-v0.2.5/opencrawl-local-cursor-0.2.5-linux-arm64.zip",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/local-cursor-v0.2.5/opencrawl-local-cursor-0.2.5-linux-arm64.json",
          "sha256": "f3fffbc2e763c11687c83699985415b9d99ef4893e548fdc920528476fcac8c9",
          "metadataSha256": "0448beab422432f1ca85aaf5375caba1bc1b1b0f884a5e9efe6ab76f7b59db15"
        },
        "linux-x64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/local-cursor-v0.2.5/opencrawl-local-cursor-0.2.5-linux-x64.zip",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/local-cursor-v0.2.5/opencrawl-local-cursor-0.2.5-linux-x64.json",
          "sha256": "d851181be5ae09cee62f342306d9c1b3f724d01ce2277824b303976e40317674",
          "metadataSha256": "df1fffc8c762085970c52cf20dd0036ee1058751ba459af9ec8e2f81e9b5556d"
        },
        "win32-x64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/local-cursor-v0.2.5/opencrawl-local-cursor-0.2.5-win32-x64.zip",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/local-cursor-v0.2.5/opencrawl-local-cursor-0.2.5-win32-x64.json",
          "sha256": "6ca17712d55b970e434302577663bedefe57f4024269fc225aa90e3a01edc597",
          "metadataSha256": "e2014516dc83c03de116f68b0fc0fba4e7c2d0e780a07e928cd80ba98b7adf7f"
        }
      },
      "ref": "329d1c996a40e8ddb1a1cc5752560797a6971076",
      "memoryImportSkill": true,
      "listingIcon": true,
      "continueSkill": true
    },
    {
      "harness": "antigravity",
      "name": "opencrawl-local-antigravity",
      "path": "local/antigravity",
      "version": "0.2.5",
      "capabilities": "capabilities.json",
      "captureAvailable": true,
      "daemonHandoff": true,
      "minimumHarnessVersion": "1.5.9",
      "archives": {
        "darwin-arm64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/local-antigravity-v0.2.5/opencrawl-local-antigravity-0.2.5-darwin-arm64.zip",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/local-antigravity-v0.2.5/opencrawl-local-antigravity-0.2.5-darwin-arm64.json",
          "sha256": "63d6b2956f2e7f7d884daa67ebd1611e55748420f2f75b0dd378dafa6f807491",
          "metadataSha256": "1ff9fb5bc6efd1f7959d69d9110a57302e7606c3a10ea8498012577ca3337c83"
        },
        "darwin-x64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/local-antigravity-v0.2.5/opencrawl-local-antigravity-0.2.5-darwin-x64.zip",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/local-antigravity-v0.2.5/opencrawl-local-antigravity-0.2.5-darwin-x64.json",
          "sha256": "a0b9ef26c83a602eb2dc41aacdbd21d1b067a1c1752ec8fdd3f897ae11df88b0",
          "metadataSha256": "1d770690efb4b0eab2253b75c46beb3cb729f04c9b8bf1854d1d9dbfb53aa962"
        },
        "linux-arm64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/local-antigravity-v0.2.5/opencrawl-local-antigravity-0.2.5-linux-arm64.zip",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/local-antigravity-v0.2.5/opencrawl-local-antigravity-0.2.5-linux-arm64.json",
          "sha256": "3ce31241c5607040fedec884d76e4b0a01d16dda99eff87f6df1aaa687d5841d",
          "metadataSha256": "36d638d483b1671696790649f93975706987fd54fba33ea88708d16385b59a87"
        },
        "linux-x64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/local-antigravity-v0.2.5/opencrawl-local-antigravity-0.2.5-linux-x64.zip",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/local-antigravity-v0.2.5/opencrawl-local-antigravity-0.2.5-linux-x64.json",
          "sha256": "9c3db54c69661d6ed1b6762a2d05e6073dbe9a398eaf472f92211948c1cf0461",
          "metadataSha256": "e32b90778721accb66f381999bf73d19f22380e82129a0f82d01fab7c030b54e"
        },
        "win32-x64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/local-antigravity-v0.2.5/opencrawl-local-antigravity-0.2.5-win32-x64.zip",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/local-antigravity-v0.2.5/opencrawl-local-antigravity-0.2.5-win32-x64.json",
          "sha256": "99b72da970de472cf3ea6b91aadd0befbf92eb9469d50cbf16193f37208d21f3",
          "metadataSha256": "d8f3a932ce2bb049e353cc8ee6653640ed7f9b265880b92942081d9873e17fb7"
        }
      },
      "ref": "329d1c996a40e8ddb1a1cc5752560797a6971076",
      "memoryImportSkill": true,
      "listingIcon": true,
      "continueSkill": true
    }
  ]
};
