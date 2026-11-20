export type ArchivePin={url:string;sha256:string;metadataUrl:string;metadataSha256:string};
export type PackageRelease={ref?:string;minimumHarnessVersion?:string;memoryImportSkill?:boolean;continueSkill?:boolean;listingIcon?:boolean;harness:'claude-code'|'codex'|'cursor'|'antigravity';name:string;path:string;version:string;capabilities:string;captureAvailable:boolean;daemonHandoff:boolean;files?:Record<string,{sha:string;bytes:number}>;archives?:Record<string,ArchivePin>};
export type PluginRelease={repository:string;ref:string;schemaVersion:1;bindingSchemaVersion:1;packages:PackageRelease[]};

// Both guided setup and the Replicas installer consume this verified release.
export const pluginRelease:PluginRelease = {
  "repository": "getopencrawl/opencrawl-plugins",
  "ref": "d38e8de84a9e30750fc6e64250f3183e24ecfde6",
  "schemaVersion": 1,
  "bindingSchemaVersion": 1,
  "packages": [
    {
      "harness": "claude-code",
      "name": "opencrawl",
      "path": "plugins/claude-code",
      "version": "0.3.1",
      "capabilities": "capabilities.json",
      "captureAvailable": true,
      "daemonHandoff": true,
      "minimumHarnessVersion": "2.1.327",
      "archives": {
        "darwin-arm64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.1/opencrawl-claude-code-0.3.1-darwin-arm64.zip",
          "sha256": "db8ca0ac8d8ee98fc7fb7ebe16a4ed0a6bd00d556b6ab10dda74ead28981fb73",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.1/opencrawl-claude-code-0.3.1-darwin-arm64.json",
          "metadataSha256": "33186fccdbcf22e14d9b776f3b50eb2355ca105f50b4a5cb9a55fb6735a9d237"
        },
        "darwin-x64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.1/opencrawl-claude-code-0.3.1-darwin-x64.zip",
          "sha256": "3d412b2a68f52c1fb911e3a8eae2cae5971570d2bda51888117716126fcd8020",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.1/opencrawl-claude-code-0.3.1-darwin-x64.json",
          "metadataSha256": "cd862176fca5b9d05473af09e88cb3ff6c56c7f3f45a5499f55ba9105d705fb4"
        },
        "linux-arm64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.1/opencrawl-claude-code-0.3.1-linux-arm64.zip",
          "sha256": "45ef39e9596b50abfb27c5c26527a5f16b0b9dc2b9711e1045eabed4cbe92212",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.1/opencrawl-claude-code-0.3.1-linux-arm64.json",
          "metadataSha256": "61a97992a96e5bbbd834f546f8ab2e6b727f8567949aa6f12ff9233a432db822"
        },
        "linux-x64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.1/opencrawl-claude-code-0.3.1-linux-x64.zip",
          "sha256": "9b1f905bef1f7a14b66a80608003e77ca921b1d815d23a713f22f6b904b15839",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.1/opencrawl-claude-code-0.3.1-linux-x64.json",
          "metadataSha256": "290309f88a481a0532972bab243629a438fe05d97fe31f32c197f454d280bc1e"
        },
        "win32-x64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.1/opencrawl-claude-code-0.3.1-win32-x64.zip",
          "sha256": "a84fa7804add1409dc837d449ca7409c5c9fb2f8322d5f7c55e49d18c59732da",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.1/opencrawl-claude-code-0.3.1-win32-x64.json",
          "metadataSha256": "cc7f799d41eea802d31b8c20fd67be8060d0af6ac03c29ba6868b8345dfc7349"
        }
      },
      "memoryImportSkill": true,
      "listingIcon": true,
      "continueSkill": true
    },
    {
      "harness": "codex",
      "name": "opencrawl",
      "path": "plugins/codex",
      "version": "0.3.1",
      "capabilities": "capabilities.json",
      "captureAvailable": true,
      "daemonHandoff": true,
      "minimumHarnessVersion": "0.166.0",
      "archives": {
        "darwin-arm64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.1/opencrawl-codex-0.3.1-darwin-arm64.zip",
          "sha256": "20ffd62c7e2b2736eff4294761c6e36e99e9b7b1ff24a226f29d0e0bb0bb19d9",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.1/opencrawl-codex-0.3.1-darwin-arm64.json",
          "metadataSha256": "3ba78c9573e25d019b2c460f10c87e2943aac008f07f095a49125fc777f528dd"
        },
        "darwin-x64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.1/opencrawl-codex-0.3.1-darwin-x64.zip",
          "sha256": "fdb499c03c2bcfa0013fa790d23384ecb4090ea16a42b9e3a281b8854ab7fb07",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.1/opencrawl-codex-0.3.1-darwin-x64.json",
          "metadataSha256": "55211de47a5f343b1e6c9193604107af72dde9ac2257f36ce9d5160b89f5b2a8"
        },
        "linux-arm64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.1/opencrawl-codex-0.3.1-linux-arm64.zip",
          "sha256": "79209df01465ecbe258ad632d33699a3cf2d2c38b54c65ed5cd132e927726370",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.1/opencrawl-codex-0.3.1-linux-arm64.json",
          "metadataSha256": "8f8b83e108c2eb4d00b169c459f6e605e198c489a1b4987e07f0a4ad06e9bc63"
        },
        "linux-x64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.1/opencrawl-codex-0.3.1-linux-x64.zip",
          "sha256": "d6a5830715e4324469123a4e532c35af03cb39f41ac487cc4a5c02a73d67d862",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.1/opencrawl-codex-0.3.1-linux-x64.json",
          "metadataSha256": "d9d8af132eae70d1f5fd7c5b75cc3a31bfc2e6a9121605c0b5c80f2c86b0349f"
        },
        "win32-x64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.1/opencrawl-codex-0.3.1-win32-x64.zip",
          "sha256": "ed1fadd1e3dff37f892a0827b0f77b17fef76ebbc4ab534c36ddb340d854576c",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.1/opencrawl-codex-0.3.1-win32-x64.json",
          "metadataSha256": "33d4b921452be95619e325ba4c1e1dfa4c8fac761a48bc40d8187b23aaed5424"
        }
      },
      "memoryImportSkill": true,
      "listingIcon": true,
      "continueSkill": true
    },
    {
      "harness": "cursor",
      "name": "opencrawl",
      "path": "plugins/cursor",
      "version": "0.3.1",
      "capabilities": "capabilities.json",
      "captureAvailable": true,
      "daemonHandoff": true,
      "minimumHarnessVersion": "2026.11.17-f532c45",
      "archives": {
        "darwin-arm64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.1/opencrawl-cursor-0.3.1-darwin-arm64.zip",
          "sha256": "2da97f9bcdc13ba755940461050f9786b1f89e080289d66dd9561426755841e2",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.1/opencrawl-cursor-0.3.1-darwin-arm64.json",
          "metadataSha256": "4e4480cbad8d0ee2d1d7740301d3f76dc4e8533d47aef10c7fd837b3ffb2d7ca"
        },
        "darwin-x64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.1/opencrawl-cursor-0.3.1-darwin-x64.zip",
          "sha256": "935dd358c4e255b7871702fe81622b0d1a2b108d5ab4e6fc660c628431afdeb6",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.1/opencrawl-cursor-0.3.1-darwin-x64.json",
          "metadataSha256": "9069c35dc8dcdfa3b8f130901067b4c3fbddd58c9a94d2efe9ba328b5245599b"
        },
        "linux-arm64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.1/opencrawl-cursor-0.3.1-linux-arm64.zip",
          "sha256": "62195274ec01ab0ab79f69a86c2d2fa57228c6c547dc382066cf0bffe86a9b18",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.1/opencrawl-cursor-0.3.1-linux-arm64.json",
          "metadataSha256": "f52d206a10adca00d7bd1f0603d7b283e475f3425ab2318b71970d89572e6ca5"
        },
        "linux-x64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.1/opencrawl-cursor-0.3.1-linux-x64.zip",
          "sha256": "70d16b90afd8233ddc97551f7fb57d33f82342c7f702569377e83b077702f819",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.1/opencrawl-cursor-0.3.1-linux-x64.json",
          "metadataSha256": "6c170be950d759b3fc693a8d1f8fb73d0d873b7c2ce5196705bcb51804273e56"
        },
        "win32-x64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.1/opencrawl-cursor-0.3.1-win32-x64.zip",
          "sha256": "3317b27f17c8de637beeb7e6e446991c841cb9643c2b59ed6ad3184549229bbe",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.1/opencrawl-cursor-0.3.1-win32-x64.json",
          "metadataSha256": "8118fe64e99a2e8bac58d167da3f14a1402d6b2e34d95b07cdb549ba15073f9a"
        }
      },
      "memoryImportSkill": true,
      "listingIcon": true,
      "continueSkill": true
    },
    {
      "harness": "antigravity",
      "name": "opencrawl",
      "path": "plugins/antigravity",
      "version": "0.3.1",
      "capabilities": "capabilities.json",
      "captureAvailable": true,
      "daemonHandoff": true,
      "minimumHarnessVersion": "1.5.9",
      "archives": {
        "darwin-arm64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.1/opencrawl-antigravity-0.3.1-darwin-arm64.zip",
          "sha256": "72761741eec587df7e4e4f66fa7bde497d4a744a7236c53d150302ba71623850",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.1/opencrawl-antigravity-0.3.1-darwin-arm64.json",
          "metadataSha256": "84e57bc0ef47320837d4402402813101dd4f3abc942db1ce47f47164a75b1ed6"
        },
        "darwin-x64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.1/opencrawl-antigravity-0.3.1-darwin-x64.zip",
          "sha256": "724a26d3e1ecd07c482dee8c33fd95234e138656b7e58f250e7aa7e81997eb70",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.1/opencrawl-antigravity-0.3.1-darwin-x64.json",
          "metadataSha256": "3783790083c61466b99f11b8901b638b7a099991ac5fa1f84a6ae2ad80784299"
        },
        "linux-arm64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.1/opencrawl-antigravity-0.3.1-linux-arm64.zip",
          "sha256": "3295e5b7d51b8db640e32b456c9bd503e15aab7e5d61f643527df5f432c83eb1",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.1/opencrawl-antigravity-0.3.1-linux-arm64.json",
          "metadataSha256": "a6b956e8cc0d1599f12e6f2f02c5392b254677577eb456f1868ce258fb352dfb"
        },
        "linux-x64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.1/opencrawl-antigravity-0.3.1-linux-x64.zip",
          "sha256": "32ae990bf2fea75f15b59788b53ecf02bb242a51a7ea276b991bca65281405f2",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.1/opencrawl-antigravity-0.3.1-linux-x64.json",
          "metadataSha256": "0187b89d89714c4a9dd0e5aaa557e7362b5a36c12b830f057456e6e626288cde"
        },
        "win32-x64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.1/opencrawl-antigravity-0.3.1-win32-x64.zip",
          "sha256": "dbab57b092c7e7ef24d20340ac36014c56986248cdcb2e7df1c33a37c36de5b4",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.1/opencrawl-antigravity-0.3.1-win32-x64.json",
          "metadataSha256": "440379b0714801d9458f9b17fb4fbe7eed700827be5673e3109c076f632da642"
        }
      },
      "memoryImportSkill": true,
      "listingIcon": true,
      "continueSkill": true
    }
  ]
};

export const replicasPolicy = {
  "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.1/replicas-codex-policy.mjs",
  "sha256": "f360fdc73d91b506e369a325219719fc33fb3a96951b807f2f2ad7bda272bcc5"
};
