export type ArchivePin={url:string;sha256:string;metadataUrl:string;metadataSha256:string};
export type PackageRelease={ref?:string;minimumHarnessVersion?:string;memoryImportSkill?:boolean;continueSkill?:boolean;listingIcon?:boolean;harness:'claude-code'|'codex'|'cursor'|'antigravity';name:string;path:string;version:string;capabilities:string;captureAvailable:boolean;daemonHandoff:boolean;files?:Record<string,{sha:string;bytes:number}>;archives?:Record<string,ArchivePin>};
export type PluginRelease={repository:string;ref:string;schemaVersion:1;bindingSchemaVersion:1;packages:PackageRelease[]};

// Both guided setup and the Replicas installer consume this verified release.
export const pluginRelease:PluginRelease = {
  "repository": "getopencrawl/opencrawl-plugins",
  "ref": "52d818ac9a2020c86bd9cec8bfe32d8370bc00dd",
  "schemaVersion": 1,
  "bindingSchemaVersion": 1,
  "packages": [
    {
      "harness": "claude-code",
      "name": "opencrawl",
      "path": "plugins/claude-code",
      "version": "0.3.6",
      "capabilities": "capabilities.json",
      "captureAvailable": true,
      "daemonHandoff": true,
      "minimumHarnessVersion": "2.1.327",
      "archives": {
        "darwin-arm64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.6/opencrawl-claude-code-0.3.6-darwin-arm64.zip",
          "sha256": "80568671f70b4c1545991980e8da44817db986c1cd3c47d578a6ba7f7e4cf3e4",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.6/opencrawl-claude-code-0.3.6-darwin-arm64.json",
          "metadataSha256": "409d788d8c8330eabef4e73889d833508bee46563388fd6ed69c2d1f8382eebd"
        },
        "darwin-x64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.6/opencrawl-claude-code-0.3.6-darwin-x64.zip",
          "sha256": "5dc4d3f785e134e6d1706a1287dac43262c5980ebb9088ade68b53e2d2eac227",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.6/opencrawl-claude-code-0.3.6-darwin-x64.json",
          "metadataSha256": "b86b9eb5f32ba7389b57d1f56237bd3a18e0294a202bb99d4a67a5e4393c1f90"
        },
        "linux-arm64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.6/opencrawl-claude-code-0.3.6-linux-arm64.zip",
          "sha256": "4ac8b888520e8cfa102f3b82756b6a3fc0d699f209cba0eadb5c78679283d8b7",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.6/opencrawl-claude-code-0.3.6-linux-arm64.json",
          "metadataSha256": "bd62529bcba6eaaf209d479e19f660753321fb6442396cf2c4f62899daf341e8"
        },
        "linux-x64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.6/opencrawl-claude-code-0.3.6-linux-x64.zip",
          "sha256": "6082940b038a63aaf4816a6804aed9945ad2ddda628d083daa2e0e3e9efb655e",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.6/opencrawl-claude-code-0.3.6-linux-x64.json",
          "metadataSha256": "c608585592538ac5631f713b69c88fe606b38b91b0a654b00d25eb2843530f06"
        },
        "win32-x64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.6/opencrawl-claude-code-0.3.6-win32-x64.zip",
          "sha256": "cf67c3ad4da6b9090f8f4a0d9b0ec09a957fe7741b3ffb867264b5d68850e278",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.6/opencrawl-claude-code-0.3.6-win32-x64.json",
          "metadataSha256": "6475c935127e4c1515ffa989c2bf41f2136106364f7e36f68fc02b20bb842985"
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
      "version": "0.3.6",
      "capabilities": "capabilities.json",
      "captureAvailable": true,
      "daemonHandoff": true,
      "minimumHarnessVersion": "0.166.0",
      "archives": {
        "darwin-arm64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.6/opencrawl-codex-0.3.6-darwin-arm64.zip",
          "sha256": "9c093ca02e3b123a3846586c821e9ff7315279016e6473b38ef99323a016c892",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.6/opencrawl-codex-0.3.6-darwin-arm64.json",
          "metadataSha256": "2743c74ac99b957bb86699039bcdc6cfd0e7d5f62810b4a786e3a41038cd4efc"
        },
        "darwin-x64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.6/opencrawl-codex-0.3.6-darwin-x64.zip",
          "sha256": "3ef124f89a874747788f4c5dbc2eeef78cfca136296f7d4f99758b6b70a0c51b",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.6/opencrawl-codex-0.3.6-darwin-x64.json",
          "metadataSha256": "19a903aad5b891c22c501c5c1e9b4fe463d51608411d9776fb5240d334d2f257"
        },
        "linux-arm64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.6/opencrawl-codex-0.3.6-linux-arm64.zip",
          "sha256": "3455db729134ec1e5ceaf23f3f23dff0d6bc13263900190844f6807487f4d466",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.6/opencrawl-codex-0.3.6-linux-arm64.json",
          "metadataSha256": "de1021a0c2aa37fab65837ae0627e219a4ade3478d6e50ac883bb24e19e04dbe"
        },
        "linux-x64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.6/opencrawl-codex-0.3.6-linux-x64.zip",
          "sha256": "cb440df8169a43f52b5a2a29748604ab35d2c1b26725a3ed6a285369c6d8250c",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.6/opencrawl-codex-0.3.6-linux-x64.json",
          "metadataSha256": "35e93d6e558f3b33e6637e0764c6780a99f72d3ac57f4f81ca21efe002b833c7"
        },
        "win32-x64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.6/opencrawl-codex-0.3.6-win32-x64.zip",
          "sha256": "0a7162d5447c90e8d06278a0be790dc3d70af31a1a08d434b510b122717fd07c",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.6/opencrawl-codex-0.3.6-win32-x64.json",
          "metadataSha256": "fda0c536e9d72e5b7b035e09565c15d4e38e007f23bb14d33627392cd836bc50"
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
      "version": "0.3.6",
      "capabilities": "capabilities.json",
      "captureAvailable": true,
      "daemonHandoff": true,
      "minimumHarnessVersion": "2026.11.17-f532c45",
      "archives": {
        "darwin-arm64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.6/opencrawl-cursor-0.3.6-darwin-arm64.zip",
          "sha256": "f233541b0cf74f753aa6e6b9acebe1234eb14353c6aa2b08038e5c9df39c540c",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.6/opencrawl-cursor-0.3.6-darwin-arm64.json",
          "metadataSha256": "0ba44c06b91c6e8319e67346f15b3a50325749b0eac4d196881a53f549e1662d"
        },
        "darwin-x64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.6/opencrawl-cursor-0.3.6-darwin-x64.zip",
          "sha256": "9c9442c290a71f1bd3effeb2c4890f46aa073eeb804698bf3ec120fce4fff799",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.6/opencrawl-cursor-0.3.6-darwin-x64.json",
          "metadataSha256": "7086230002422a73a7022c4f0fbd6667708a79803e67084a9807ebfb25155675"
        },
        "linux-arm64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.6/opencrawl-cursor-0.3.6-linux-arm64.zip",
          "sha256": "10a7448be5847dcc68d93d2be1cbaf9e55a2c57ade60ddff3aad96983d22b8f0",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.6/opencrawl-cursor-0.3.6-linux-arm64.json",
          "metadataSha256": "cfa4c3b866fa9520f6460907a12c145a4552274860057f4ca662bf415cdc9fdd"
        },
        "linux-x64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.6/opencrawl-cursor-0.3.6-linux-x64.zip",
          "sha256": "4652d2a458211c27e493b9e85e59dcaa1c61e7bacc3340c9257bf578eda05279",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.6/opencrawl-cursor-0.3.6-linux-x64.json",
          "metadataSha256": "b7c7b9d391936812d080295f23309b53bd30c3d3f43ae4f7e60660039f370f5b"
        },
        "win32-x64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.6/opencrawl-cursor-0.3.6-win32-x64.zip",
          "sha256": "2908d274415c59089137f0c2f206adc56fa3ce8389ae2d90bb8b46f4a61bb153",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.6/opencrawl-cursor-0.3.6-win32-x64.json",
          "metadataSha256": "e796be424d43b13680d4a9f849aa62a59711d3c2569066dabe60b5b126510554"
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
      "version": "0.3.6",
      "capabilities": "capabilities.json",
      "captureAvailable": true,
      "daemonHandoff": true,
      "minimumHarnessVersion": "1.5.9",
      "archives": {
        "darwin-arm64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.6/opencrawl-antigravity-0.3.6-darwin-arm64.zip",
          "sha256": "4705c15d4b3e5ba52ff6264127bb9c2651a822f0911ffeb2901ce8c6d17de357",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.6/opencrawl-antigravity-0.3.6-darwin-arm64.json",
          "metadataSha256": "ab14c85f8e20a5944ddd8994f79e94d3b94bdb41a55a18a394fcb7c6fb34ce58"
        },
        "darwin-x64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.6/opencrawl-antigravity-0.3.6-darwin-x64.zip",
          "sha256": "048d95a525309ee3513c6c1272d8cb605caf84864eebff44c77332e1c4e44500",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.6/opencrawl-antigravity-0.3.6-darwin-x64.json",
          "metadataSha256": "0f6545c0fc3d36d1acd6d08f65c03adf4bed73c0d609b65cd724d422117b82e6"
        },
        "linux-arm64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.6/opencrawl-antigravity-0.3.6-linux-arm64.zip",
          "sha256": "b3303fa821416dd8e381ac28f45a9c88c42280f82d90be2e0914e0e541e5413b",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.6/opencrawl-antigravity-0.3.6-linux-arm64.json",
          "metadataSha256": "0707732e0df76ffcb1606fea50ec625a83665ab5aac3e8e06f0c24d02e74540b"
        },
        "linux-x64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.6/opencrawl-antigravity-0.3.6-linux-x64.zip",
          "sha256": "50529f90e20673d9a7b5c31b77307bd8ed591011f10d74a497f8e72eddce4af6",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.6/opencrawl-antigravity-0.3.6-linux-x64.json",
          "metadataSha256": "c2b2ba2b08dedca6cd3d4005f7ee55963838258884a8b480b40f9bccb519a169"
        },
        "win32-x64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.6/opencrawl-antigravity-0.3.6-win32-x64.zip",
          "sha256": "4b21dd97376b10f7b99cdb7be48c6ea263c16c3dba5ce001af11508b126b3e14",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.6/opencrawl-antigravity-0.3.6-win32-x64.json",
          "metadataSha256": "90182c97d595f8a09e70f16c9359e98ba4af75f5b8cdeb80bc330e2a2df537cb"
        }
      },
      "memoryImportSkill": true,
      "listingIcon": true,
      "continueSkill": true
    }
  ]
};

export const replicasPolicy = {
  "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.6/replicas-codex-policy.mjs",
  "sha256": "f360fdc73d91b506e369a325219719fc33fb3a96951b807f2f2ad7bda272bcc5"
};
