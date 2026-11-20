export type ArchivePin={url:string;sha256:string;metadataUrl:string;metadataSha256:string};
export type PackageRelease={ref?:string;minimumHarnessVersion?:string;memoryImportSkill?:boolean;continueSkill?:boolean;listingIcon?:boolean;harness:'claude-code'|'codex'|'cursor'|'antigravity';name:string;path:string;version:string;capabilities:string;captureAvailable:boolean;daemonHandoff:boolean;files?:Record<string,{sha:string;bytes:number}>;archives?:Record<string,ArchivePin>};
export type PluginRelease={repository:string;ref:string;schemaVersion:1;bindingSchemaVersion:1;packages:PackageRelease[]};

// Reviewed immutable package inventory from the public plugins repository.
// Update this pin only with matching capability and native acceptance evidence.
export const pluginRelease:PluginRelease = {
  "repository": "getopencrawl/opencrawl-plugins",
  "ref": "335991acf5e23c072b9874aa4d486fd82d3b37e2",
  "schemaVersion": 1,
  "bindingSchemaVersion": 1,
  "packages": [
    {
      "harness": "claude-code",
      "name": "opencrawl-local-claude-code",
      "path": "local/claude-code",
      "version": "0.2.6",
      "capabilities": "capabilities.json",
      "captureAvailable": true,
      "daemonHandoff": true,
      "minimumHarnessVersion": "2.1.327",
      "archives": {
        "darwin-arm64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/local-claude-code-v0.2.6/opencrawl-local-claude-code-0.2.6-darwin-arm64.zip",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/local-claude-code-v0.2.6/opencrawl-local-claude-code-0.2.6-darwin-arm64.json",
          "sha256": "c1b17d9bbcc3fbfe4e9f0c8eaae9d5ddba0374166c3cdd9b18cc6319640be247",
          "metadataSha256": "b875d967137ced725460b40089821f63143a9406a3c65e84aa08787c7e9bbfbd"
        },
        "darwin-x64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/local-claude-code-v0.2.6/opencrawl-local-claude-code-0.2.6-darwin-x64.zip",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/local-claude-code-v0.2.6/opencrawl-local-claude-code-0.2.6-darwin-x64.json",
          "sha256": "f580a0755a0d77c9f4e6aead2c3a93f40f5bf9b9f9e5adf40308f7e6bd6695f4",
          "metadataSha256": "ec0d68e5c698af85fccdf965a7bfb9d89bc52dfce8367da4c0eab1a092228d50"
        },
        "linux-arm64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/local-claude-code-v0.2.6/opencrawl-local-claude-code-0.2.6-linux-arm64.zip",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/local-claude-code-v0.2.6/opencrawl-local-claude-code-0.2.6-linux-arm64.json",
          "sha256": "8e4bf38140a3184ec715b4130c4ac1e6d64388262c1eb801b5576babb998bfbd",
          "metadataSha256": "42ed429db9a4fd3e7e8a7e9b5a3e3703cd0c7e140e072de5450717bded557734"
        },
        "linux-x64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/local-claude-code-v0.2.6/opencrawl-local-claude-code-0.2.6-linux-x64.zip",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/local-claude-code-v0.2.6/opencrawl-local-claude-code-0.2.6-linux-x64.json",
          "sha256": "e6fd669914771e3b1a52caaf88b87a46c499af48527b5a1f861c6952a9290e32",
          "metadataSha256": "f09ed1be148afafcb8e842e44f6361247369c45b48923ccf3477fcbebdb87591"
        },
        "win32-x64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/local-claude-code-v0.2.6/opencrawl-local-claude-code-0.2.6-win32-x64.zip",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/local-claude-code-v0.2.6/opencrawl-local-claude-code-0.2.6-win32-x64.json",
          "sha256": "53ba09dd41d8da9674836d1195ab7f8a41a306b865ee152a783364e16b5313cd",
          "metadataSha256": "daef5a55561196af0938bbc072f193b703be527a51ad2a00536c5e1a64a92c31"
        }
      },
      "ref": "335991acf5e23c072b9874aa4d486fd82d3b37e2",
      "memoryImportSkill": true,
      "listingIcon": true,
      "continueSkill": true
    },
    {
      "harness": "codex",
      "name": "opencrawl-local-codex",
      "path": "local/codex",
      "version": "0.2.6",
      "capabilities": "capabilities.json",
      "captureAvailable": true,
      "daemonHandoff": true,
      "minimumHarnessVersion": "0.166.0",
      "archives": {
        "darwin-arm64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/local-codex-v0.2.6/opencrawl-local-codex-0.2.6-darwin-arm64.zip",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/local-codex-v0.2.6/opencrawl-local-codex-0.2.6-darwin-arm64.json",
          "sha256": "75dd39591db3f630c23a1345f8ded639b0487c29d12902fd4fabbd45290d0634",
          "metadataSha256": "e0407dbda7c26366a051e49cd43783875b6496a16c27504645e51924e509c04d"
        },
        "darwin-x64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/local-codex-v0.2.6/opencrawl-local-codex-0.2.6-darwin-x64.zip",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/local-codex-v0.2.6/opencrawl-local-codex-0.2.6-darwin-x64.json",
          "sha256": "99c5a5e4095961fdad5f49efa4d77879a11aa83717164bcc049cf6f311eeec8c",
          "metadataSha256": "5174dcf044b841faa2602af2bc9617aba7d14b1a6d777c6bf4454251f42897fb"
        },
        "linux-arm64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/local-codex-v0.2.6/opencrawl-local-codex-0.2.6-linux-arm64.zip",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/local-codex-v0.2.6/opencrawl-local-codex-0.2.6-linux-arm64.json",
          "sha256": "6d12723d8ae5f49cbe558517d0e228bad5217edc00dfd39438677ad59bc06dbf",
          "metadataSha256": "53524106ded652c1133533986df045deaa19446fb773c99abf5e83f8f6beb022"
        },
        "linux-x64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/local-codex-v0.2.6/opencrawl-local-codex-0.2.6-linux-x64.zip",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/local-codex-v0.2.6/opencrawl-local-codex-0.2.6-linux-x64.json",
          "sha256": "01f389bfc1ed3095f5527bb4fb0e27a4ae9d35019a088526b82662630d44d1d2",
          "metadataSha256": "55efb2ea0886bcfa8b83d5480170491a49fc73f909871bbe9a683189218ce2a8"
        },
        "win32-x64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/local-codex-v0.2.6/opencrawl-local-codex-0.2.6-win32-x64.zip",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/local-codex-v0.2.6/opencrawl-local-codex-0.2.6-win32-x64.json",
          "sha256": "f14407bb4445612f5825611ce344e60ead90b4ea9f2718da7b32c45d66725f23",
          "metadataSha256": "385f1eeac6a3d9a929c1c0cee13729ff50e920bb492b8d6ec93458be92aa9acf"
        }
      },
      "ref": "335991acf5e23c072b9874aa4d486fd82d3b37e2",
      "memoryImportSkill": true,
      "listingIcon": true,
      "continueSkill": true
    },
    {
      "harness": "cursor",
      "name": "opencrawl-local-cursor",
      "path": "local/cursor",
      "version": "0.2.6",
      "capabilities": "capabilities.json",
      "captureAvailable": true,
      "daemonHandoff": true,
      "minimumHarnessVersion": "2026.11.17-f532c45",
      "archives": {
        "darwin-arm64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/local-cursor-v0.2.6/opencrawl-local-cursor-0.2.6-darwin-arm64.zip",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/local-cursor-v0.2.6/opencrawl-local-cursor-0.2.6-darwin-arm64.json",
          "sha256": "80db756bcbda8f84b38950e9b89ce9c38f352006355e3bf19b965daa5aead290",
          "metadataSha256": "84e720eb3b41b818395134783004c4f0fc516b5aa51ab010ac4a6649ff3e9f1d"
        },
        "darwin-x64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/local-cursor-v0.2.6/opencrawl-local-cursor-0.2.6-darwin-x64.zip",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/local-cursor-v0.2.6/opencrawl-local-cursor-0.2.6-darwin-x64.json",
          "sha256": "3ffc481d10e2701f9dbbed42ccaf30ff62192dceec86f485c56c5ffee3911240",
          "metadataSha256": "5df7183564269eb9c53f7a7aa478b639dc66a37c373ac83df99d1c5efe0f773d"
        },
        "linux-arm64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/local-cursor-v0.2.6/opencrawl-local-cursor-0.2.6-linux-arm64.zip",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/local-cursor-v0.2.6/opencrawl-local-cursor-0.2.6-linux-arm64.json",
          "sha256": "98408d90be4d25a9e2b3765bb0f9099c0f40bf1f62c64ded9f1738d3ffa023ad",
          "metadataSha256": "4ef8fb565a1e19bc6fa8f4b6af38ef2b5b0f171dcbe75c35cdb9c08be7270718"
        },
        "linux-x64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/local-cursor-v0.2.6/opencrawl-local-cursor-0.2.6-linux-x64.zip",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/local-cursor-v0.2.6/opencrawl-local-cursor-0.2.6-linux-x64.json",
          "sha256": "860f6571d753d1896c7e3b5a2b5012244dd9981dfa78063c4d88861f5034391c",
          "metadataSha256": "8d9e0472d59011fd62410464b12be51b380b70234876b300960f7e2c22635305"
        },
        "win32-x64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/local-cursor-v0.2.6/opencrawl-local-cursor-0.2.6-win32-x64.zip",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/local-cursor-v0.2.6/opencrawl-local-cursor-0.2.6-win32-x64.json",
          "sha256": "b0f5f9f0df174af12dd63df74d26c6acac8ca6b59401ac75e14228c5bc50697b",
          "metadataSha256": "ad5fc87627d76558793c84e1ef8fefb6f4d4f5aeaae44bf1b445bad672f6525b"
        }
      },
      "ref": "335991acf5e23c072b9874aa4d486fd82d3b37e2",
      "memoryImportSkill": true,
      "listingIcon": true,
      "continueSkill": true
    },
    {
      "harness": "antigravity",
      "name": "opencrawl-local-antigravity",
      "path": "local/antigravity",
      "version": "0.2.6",
      "capabilities": "capabilities.json",
      "captureAvailable": true,
      "daemonHandoff": true,
      "minimumHarnessVersion": "1.5.9",
      "archives": {
        "darwin-arm64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/local-antigravity-v0.2.6/opencrawl-local-antigravity-0.2.6-darwin-arm64.zip",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/local-antigravity-v0.2.6/opencrawl-local-antigravity-0.2.6-darwin-arm64.json",
          "sha256": "07dce23e97cd36167589dd39c4c59490644235697197d782a6b2d267a178e209",
          "metadataSha256": "10a7d6dffab55745ab8e25877b6f58bc63e6cad83e1df7a6d630acd5091bf8f7"
        },
        "darwin-x64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/local-antigravity-v0.2.6/opencrawl-local-antigravity-0.2.6-darwin-x64.zip",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/local-antigravity-v0.2.6/opencrawl-local-antigravity-0.2.6-darwin-x64.json",
          "sha256": "db1d4fba943c6b236b23df4c142f02e4797318d69aa1faad3a2b4ea5e617a096",
          "metadataSha256": "fd42b91bafca4108af038281922676a8629c2dd9d2300a854d81ac2996ca14d0"
        },
        "linux-arm64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/local-antigravity-v0.2.6/opencrawl-local-antigravity-0.2.6-linux-arm64.zip",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/local-antigravity-v0.2.6/opencrawl-local-antigravity-0.2.6-linux-arm64.json",
          "sha256": "a93089b0a97c05e6f2e64605611bb3a48a402e4f6317bfe95fbe412c06b82af3",
          "metadataSha256": "056774aecd7e2b0b2a84fbada56a34c619cc33d0c4003c855498edbacaab49a0"
        },
        "linux-x64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/local-antigravity-v0.2.6/opencrawl-local-antigravity-0.2.6-linux-x64.zip",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/local-antigravity-v0.2.6/opencrawl-local-antigravity-0.2.6-linux-x64.json",
          "sha256": "4ec4ec97ef607d16fe919db91ba7cddc625bfc624198bf3ea0fb29fe0af10a8a",
          "metadataSha256": "a18cd8a18680bbd87c5213fff451dd13889e1bc9ac09b6f6bafbf92cc5d1d1fe"
        },
        "win32-x64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/local-antigravity-v0.2.6/opencrawl-local-antigravity-0.2.6-win32-x64.zip",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/local-antigravity-v0.2.6/opencrawl-local-antigravity-0.2.6-win32-x64.json",
          "sha256": "a80eef717ce34672b5aade0a0d1532c2baef321b80979a340ed195d2e1f8091f",
          "metadataSha256": "5e40317cfd7cb93d51eee99cc27bac7ce435013a2247b678193811ac3c125d7d"
        }
      },
      "ref": "335991acf5e23c072b9874aa4d486fd82d3b37e2",
      "memoryImportSkill": true,
      "listingIcon": true,
      "continueSkill": true
    }
  ]
};
