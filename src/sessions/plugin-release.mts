export type ArchivePin={url:string;sha256:string;metadataUrl:string;metadataSha256:string};
export type PackageRelease={ref?:string;minimumHarnessVersion?:string;memoryImportSkill?:boolean;continueSkill?:boolean;shareSkill?:boolean;listingIcon?:boolean;harness:'claude-code'|'codex'|'cursor'|'antigravity';name:string;path:string;version:string;capabilities:string;captureAvailable:boolean;daemonHandoff:boolean;files?:Record<string,{sha:string;bytes:number}>;archives?:Record<string,ArchivePin>};
export type PluginRelease={repository:string;ref:string;schemaVersion:1;bindingSchemaVersion:1;packages:PackageRelease[]};

// Both guided setup and the Replicas installer consume this verified release.
export const pluginRelease:PluginRelease = {
  "repository": "getopencrawl/opencrawl-plugins",
  "ref": "92f4b6d8d5c065bfe849fd3749cb4ad4dd562ab7",
  "schemaVersion": 1,
  "bindingSchemaVersion": 1,
  "packages": [
    {
      "harness": "claude-code",
      "name": "opencrawl",
      "path": "plugins/claude-code",
      "version": "0.3.8",
      "capabilities": "capabilities.json",
      "captureAvailable": true,
      "daemonHandoff": true,
      "minimumHarnessVersion": "2.1.327",
      "archives": {
        "darwin-arm64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.8/opencrawl-claude-code-0.3.8-darwin-arm64.zip",
          "sha256": "98a677d3cf751c1e90324312e2637cd4ed4e827e50afaa731c6a801231ab322e",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.8/opencrawl-claude-code-0.3.8-darwin-arm64.json",
          "metadataSha256": "5193461ff3dc1d1eaa181bc690419e090a6185a18562b74f6e22a8065e0ae72c"
        },
        "darwin-x64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.8/opencrawl-claude-code-0.3.8-darwin-x64.zip",
          "sha256": "c11add21e3805a9374438dda71714315d2f092c2786b4cc0f120a64aa268976a",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.8/opencrawl-claude-code-0.3.8-darwin-x64.json",
          "metadataSha256": "bc2fc310d3455c227827934a1b303ea0274c6790ff8eb4828d5d83ee22289068"
        },
        "linux-arm64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.8/opencrawl-claude-code-0.3.8-linux-arm64.zip",
          "sha256": "0f9373517e24c6d866ceaf929c52e7dbccf2a8b32ec369a7af99c09c2d61e554",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.8/opencrawl-claude-code-0.3.8-linux-arm64.json",
          "metadataSha256": "e3a6dfe4a74169754b154740d06a920eb38c6d12267d136c3a533a8f0d327512"
        },
        "linux-x64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.8/opencrawl-claude-code-0.3.8-linux-x64.zip",
          "sha256": "2533e6b5cb5897eb1eb0b3945a40f9f3905101ed0ea43ac4e78dd5e9fef89381",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.8/opencrawl-claude-code-0.3.8-linux-x64.json",
          "metadataSha256": "ef575dc6c83ee47c58cf1dce05718676960185e65cf3997f657418e10635b7b9"
        },
        "win32-x64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.8/opencrawl-claude-code-0.3.8-win32-x64.zip",
          "sha256": "c08e929ac55ae09f307b55054ec379b6974d3526e0fecdd8100487591c2e3f31",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.8/opencrawl-claude-code-0.3.8-win32-x64.json",
          "metadataSha256": "19c53dba43ffe09b89c457c373c36e9af8fe93bfa602c52a7385b1466147c75a"
        }
      },
      "memoryImportSkill": true,
      "listingIcon": true,
      "continueSkill": true,
      "shareSkill": true
    },
    {
      "harness": "codex",
      "name": "opencrawl",
      "path": "plugins/codex",
      "version": "0.3.8",
      "capabilities": "capabilities.json",
      "captureAvailable": true,
      "daemonHandoff": true,
      "minimumHarnessVersion": "0.166.0",
      "archives": {
        "darwin-arm64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.8/opencrawl-codex-0.3.8-darwin-arm64.zip",
          "sha256": "e84e01df3255f92441d62435864555eda98460c8b94df73e0a3ff08401c87301",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.8/opencrawl-codex-0.3.8-darwin-arm64.json",
          "metadataSha256": "daa9c73e2d8276250651b3dfb8d3c02268137ccfe6f894fadfd239a089e52690"
        },
        "darwin-x64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.8/opencrawl-codex-0.3.8-darwin-x64.zip",
          "sha256": "e456d83cdcc83663aaa5482e09278e1f52a56fb369dc05f74b87331547478ce8",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.8/opencrawl-codex-0.3.8-darwin-x64.json",
          "metadataSha256": "4c20898c5be97a42bea403b47fa08c268632674a2a12146d2326b0e61934751e"
        },
        "linux-arm64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.8/opencrawl-codex-0.3.8-linux-arm64.zip",
          "sha256": "f9a06dbac5cfe26e5c6400fe0efe8dd185c5788c6b5f78931a76754b1880f335",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.8/opencrawl-codex-0.3.8-linux-arm64.json",
          "metadataSha256": "1a32d87bd02e9931c983ecf61f7fbc65ebd8b951938b2ca145d60cd05adb3ff0"
        },
        "linux-x64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.8/opencrawl-codex-0.3.8-linux-x64.zip",
          "sha256": "f6fd12c2c23c64d486d48661cf6e22c262620ecc3e078e838327aeab239837c9",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.8/opencrawl-codex-0.3.8-linux-x64.json",
          "metadataSha256": "170034261689380d8131a7d50b90efddb8af13cc5e1ab63139ea87f68c835e8b"
        },
        "win32-x64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.8/opencrawl-codex-0.3.8-win32-x64.zip",
          "sha256": "fce06da1c337aa69c7b544f43ac952a283faf0db79cecb8e02e7ffc3234e6f81",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.8/opencrawl-codex-0.3.8-win32-x64.json",
          "metadataSha256": "3039d41dd78305ae83f78889f7d46df6d33b45a0172fb1b1d6b1b20edb82dfee"
        }
      },
      "memoryImportSkill": true,
      "listingIcon": true,
      "continueSkill": true,
      "shareSkill": true
    },
    {
      "harness": "cursor",
      "name": "opencrawl",
      "path": "plugins/cursor",
      "version": "0.3.8",
      "capabilities": "capabilities.json",
      "captureAvailable": true,
      "daemonHandoff": true,
      "minimumHarnessVersion": "2026.11.17-f532c45",
      "archives": {
        "darwin-arm64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.8/opencrawl-cursor-0.3.8-darwin-arm64.zip",
          "sha256": "c31d04fcee18608f8090d2b6e3703c7188290bf86bfaf3d958448b63882ee5cd",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.8/opencrawl-cursor-0.3.8-darwin-arm64.json",
          "metadataSha256": "9608c782930b3ba0a0be82860ab7ec34c4aa8644dd1e487b09e9f7739102d2c1"
        },
        "darwin-x64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.8/opencrawl-cursor-0.3.8-darwin-x64.zip",
          "sha256": "4d8de6226cf5ce11e33a459f763ecd9cc6bbafb4195438c96b580ff1eac18c8e",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.8/opencrawl-cursor-0.3.8-darwin-x64.json",
          "metadataSha256": "d6765dfeb0feda0d216321b8736df795b989d5a4534ddcd50c18e4cd66c38675"
        },
        "linux-arm64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.8/opencrawl-cursor-0.3.8-linux-arm64.zip",
          "sha256": "942cc96b5723f18131f1fa473c11aafbb5a37e5ce716b04b28e01419fdaf885d",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.8/opencrawl-cursor-0.3.8-linux-arm64.json",
          "metadataSha256": "182411474a233987846004eba855acfe198e621f61b088ef08eb52fceaf3c09b"
        },
        "linux-x64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.8/opencrawl-cursor-0.3.8-linux-x64.zip",
          "sha256": "c57bd9419a8f85315254088b481cdb42c754b55223d89a78f2f44572dca747d0",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.8/opencrawl-cursor-0.3.8-linux-x64.json",
          "metadataSha256": "af7a063b79933f31eb5d287e4d7106215ad6fefeb70cd739524d577b312aed06"
        },
        "win32-x64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.8/opencrawl-cursor-0.3.8-win32-x64.zip",
          "sha256": "85179e61fd4bf435e96ea3b04fca4f2163f54d7b41b50d29de8c79bb234d6416",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.8/opencrawl-cursor-0.3.8-win32-x64.json",
          "metadataSha256": "4e2fa5e45b4cb748cc7303a6c80f5ea995b65a4bb5f47e18a8b170cd4ba29fcd"
        }
      },
      "memoryImportSkill": true,
      "listingIcon": true,
      "continueSkill": true,
      "shareSkill": true
    },
    {
      "harness": "antigravity",
      "name": "opencrawl",
      "path": "plugins/antigravity",
      "version": "0.3.8",
      "capabilities": "capabilities.json",
      "captureAvailable": true,
      "daemonHandoff": true,
      "minimumHarnessVersion": "1.5.9",
      "archives": {
        "darwin-arm64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.8/opencrawl-antigravity-0.3.8-darwin-arm64.zip",
          "sha256": "c4829961c72a13c4dc2feb9e330b2432b5f3c839112a485bfc056e432c76a8ad",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.8/opencrawl-antigravity-0.3.8-darwin-arm64.json",
          "metadataSha256": "e8b1a7412ae6fb65c0b922c25692923a1dd68a0f6cc6bca9204e90615504faa8"
        },
        "darwin-x64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.8/opencrawl-antigravity-0.3.8-darwin-x64.zip",
          "sha256": "bf692e1072de7381edf12da4943e37f904843231b70cc1df39708790b5b43694",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.8/opencrawl-antigravity-0.3.8-darwin-x64.json",
          "metadataSha256": "ac6bfb7dc405b4518bafb4f02050490f0876cd409ee676a2786e900fa3fec171"
        },
        "linux-arm64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.8/opencrawl-antigravity-0.3.8-linux-arm64.zip",
          "sha256": "a9d17266bf3476144a541782231a5473bea3281d1090a40c807871b37c05be3e",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.8/opencrawl-antigravity-0.3.8-linux-arm64.json",
          "metadataSha256": "26e6943046626a6fd16f472e07dbc65d4792a4a9d8ceab02faaf74c9ed56ea70"
        },
        "linux-x64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.8/opencrawl-antigravity-0.3.8-linux-x64.zip",
          "sha256": "dadf4c763da8d19bd63b564a89c4638424bb0eed65a40fd4f44d1291537e7b89",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.8/opencrawl-antigravity-0.3.8-linux-x64.json",
          "metadataSha256": "94dabfde838738ab0d556638b65bc36de20608efd604d53e4b6a4d876e8627b9"
        },
        "win32-x64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.8/opencrawl-antigravity-0.3.8-win32-x64.zip",
          "sha256": "c8235c4ce3d0b22c2878fde6683f40aa706036b309fd9237b123eafd8454ebf6",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.8/opencrawl-antigravity-0.3.8-win32-x64.json",
          "metadataSha256": "a5c1df5d0a872d174130ba55363d91785c154be7029206c907dd0d46386fc832"
        }
      },
      "memoryImportSkill": true,
      "listingIcon": true,
      "continueSkill": true,
      "shareSkill": true
    }
  ]
};

export const replicasPolicy = {
  "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.8/replicas-codex-policy.mjs",
  "sha256": "f360fdc73d91b506e369a325219719fc33fb3a96951b807f2f2ad7bda272bcc5"
};
