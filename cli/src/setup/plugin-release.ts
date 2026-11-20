export type ArchivePin={url:string;sha256:string;metadataUrl:string;metadataSha256:string};
export type PackageRelease={ref?:string;minimumHarnessVersion?:string;memoryImportSkill?:boolean;continueSkill?:boolean;listingIcon?:boolean;harness:'claude-code'|'codex'|'cursor'|'antigravity';name:string;path:string;version:string;capabilities:string;captureAvailable:boolean;daemonHandoff:boolean;files?:Record<string,{sha:string;bytes:number}>;archives?:Record<string,ArchivePin>};
export type PluginRelease={repository:string;ref:string;schemaVersion:1;bindingSchemaVersion:1;packages:PackageRelease[]};

// Reviewed immutable package inventory from the public plugins repository.
// Update this pin only with matching capability and native acceptance evidence.
export const pluginRelease:PluginRelease = {
  "repository": "getopencrawl/opencrawl-plugins",
  "ref": "39a41863a8efccdf1d3c457fe328a1e0d9d15e98",
  "schemaVersion": 1,
  "bindingSchemaVersion": 1,
  "packages": [
    {
      "harness": "claude-code",
      "name": "opencrawl-local-claude-code",
      "path": "local/claude-code",
      "version": "0.2.4",
      "capabilities": "capabilities.json",
      "captureAvailable": true,
      "daemonHandoff": true,
      "minimumHarnessVersion": "2.1.327",
      "archives": {
        "darwin-arm64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/local-claude-code-v0.2.4/opencrawl-local-claude-code-0.2.4-darwin-arm64.zip",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/local-claude-code-v0.2.4/opencrawl-local-claude-code-0.2.4-darwin-arm64.json",
          "sha256": "36d0476325b0f57df32a5f9514a217c97c7e49ab09760bf011b2beea5625fbda",
          "metadataSha256": "8eb3c9e26e447bb7155a903479e25add5f1adb6f85ca21005d7a9a1c9fe434b3"
        },
        "darwin-x64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/local-claude-code-v0.2.4/opencrawl-local-claude-code-0.2.4-darwin-x64.zip",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/local-claude-code-v0.2.4/opencrawl-local-claude-code-0.2.4-darwin-x64.json",
          "sha256": "ee1498738f6938416d600a8c1ed9a0626ff732311e417c94450fdc77f8e22e0b",
          "metadataSha256": "682f97f6f893d67b80ebfd2d5c862f4627fc161012c3107a28223d84343cb2c7"
        },
        "linux-arm64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/local-claude-code-v0.2.4/opencrawl-local-claude-code-0.2.4-linux-arm64.zip",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/local-claude-code-v0.2.4/opencrawl-local-claude-code-0.2.4-linux-arm64.json",
          "sha256": "7d5bbec8a8393ae4abd1a609c43b5d54bc9ec6de9be069f312812dddbf625ad0",
          "metadataSha256": "f646b4d4696a064cd2bc51c5695d7ff3c3270d61e0f3417ace6d9f336af758b1"
        },
        "linux-x64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/local-claude-code-v0.2.4/opencrawl-local-claude-code-0.2.4-linux-x64.zip",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/local-claude-code-v0.2.4/opencrawl-local-claude-code-0.2.4-linux-x64.json",
          "sha256": "ab6cebb526b92dc47e1da307d90e33382ff00632e35e0c3c78d84edc8ca2b2fb",
          "metadataSha256": "deb67c2312dcf795018625c7e6d1f8075a6ee992f80d9f6663aab24c570d2ebb"
        },
        "win32-x64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/local-claude-code-v0.2.4/opencrawl-local-claude-code-0.2.4-win32-x64.zip",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/local-claude-code-v0.2.4/opencrawl-local-claude-code-0.2.4-win32-x64.json",
          "sha256": "2d87933569fbc1ca29010e7801c8d2bcc66709ba1b03514d7758b4d504ccc125",
          "metadataSha256": "5602cb572dd1a4bafb694a9af0151b0359a067a98f895cdf30047f9db9e42d87"
        }
      },
      "ref": "39a41863a8efccdf1d3c457fe328a1e0d9d15e98",
      "memoryImportSkill": true,
      "listingIcon": true,
      "continueSkill": true
    },
    {
      "harness": "codex",
      "name": "opencrawl-local-codex",
      "path": "local/codex",
      "version": "0.2.4",
      "capabilities": "capabilities.json",
      "captureAvailable": true,
      "daemonHandoff": true,
      "minimumHarnessVersion": "0.166.0",
      "archives": {
        "darwin-arm64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/local-codex-v0.2.4/opencrawl-local-codex-0.2.4-darwin-arm64.zip",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/local-codex-v0.2.4/opencrawl-local-codex-0.2.4-darwin-arm64.json",
          "sha256": "368dedc567b2301d590810324359bf9da3af84d4d8e4049ba58fbd321b6c77ec",
          "metadataSha256": "71f6b71f330c051474c92a33b6b491753546abd197b5e7beb46c3e787313b57d"
        },
        "darwin-x64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/local-codex-v0.2.4/opencrawl-local-codex-0.2.4-darwin-x64.zip",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/local-codex-v0.2.4/opencrawl-local-codex-0.2.4-darwin-x64.json",
          "sha256": "0b62e98f79c3d35979c41eb77f56bcdec545cdbdcc81ac57ba6a5fe28af5bfa3",
          "metadataSha256": "f902160a77e517b06b942cdd1e5dcbb16604475af8f1d375aa32450905177b19"
        },
        "linux-arm64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/local-codex-v0.2.4/opencrawl-local-codex-0.2.4-linux-arm64.zip",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/local-codex-v0.2.4/opencrawl-local-codex-0.2.4-linux-arm64.json",
          "sha256": "5444c547c8824d627c22a04728f1be9295350477a8bf81426ae5751dffac15e0",
          "metadataSha256": "3a215ae64060c23dc3fc1d575df07a731d30667514c728a5f8835c5c6eba4e8b"
        },
        "linux-x64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/local-codex-v0.2.4/opencrawl-local-codex-0.2.4-linux-x64.zip",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/local-codex-v0.2.4/opencrawl-local-codex-0.2.4-linux-x64.json",
          "sha256": "a77e424c7a50d1726f15eec8d0e9ee34e2307529a674ea2acd91e38417d98d16",
          "metadataSha256": "36f67c8a57639e4d9998d956e90481ce8015b91f4065428f4da755776f774d47"
        },
        "win32-x64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/local-codex-v0.2.4/opencrawl-local-codex-0.2.4-win32-x64.zip",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/local-codex-v0.2.4/opencrawl-local-codex-0.2.4-win32-x64.json",
          "sha256": "23ad536e329619535c7c3c40df9b8b23f934f190a7de86fc2498ab3c1158354e",
          "metadataSha256": "792365544ba1b9b2594f2c2960859192950ea76bd96e5fd05e6dd71fdc05a953"
        }
      },
      "ref": "39a41863a8efccdf1d3c457fe328a1e0d9d15e98",
      "memoryImportSkill": true,
      "listingIcon": true,
      "continueSkill": true
    },
    {
      "harness": "cursor",
      "name": "opencrawl-local-cursor",
      "path": "local/cursor",
      "version": "0.2.4",
      "capabilities": "capabilities.json",
      "captureAvailable": true,
      "daemonHandoff": true,
      "minimumHarnessVersion": "2026.11.17-f532c45",
      "archives": {
        "darwin-arm64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/local-cursor-v0.2.4/opencrawl-local-cursor-0.2.4-darwin-arm64.zip",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/local-cursor-v0.2.4/opencrawl-local-cursor-0.2.4-darwin-arm64.json",
          "sha256": "59717f995211c61fd9c9897dff5c63c249318f16c84313d88aab15b5d634ddde",
          "metadataSha256": "cd6dac35cdf8b00b67dbf17ab15e92bef0dfb552233d47806cf51392b63dc14c"
        },
        "darwin-x64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/local-cursor-v0.2.4/opencrawl-local-cursor-0.2.4-darwin-x64.zip",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/local-cursor-v0.2.4/opencrawl-local-cursor-0.2.4-darwin-x64.json",
          "sha256": "e0e0e460d759baa6a8c01e71157ebeb738b94abebe1c58714a3e9b1ca8c74bd3",
          "metadataSha256": "58b80c519f1d2a82562b705b1f8d2be89c5f7575d9ac17ec89c4b6517d7e3dee"
        },
        "linux-arm64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/local-cursor-v0.2.4/opencrawl-local-cursor-0.2.4-linux-arm64.zip",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/local-cursor-v0.2.4/opencrawl-local-cursor-0.2.4-linux-arm64.json",
          "sha256": "0c3a196404354eadf105cc602560ede64072f392997c87a334ab72667419583c",
          "metadataSha256": "76c6dc3f81989bc292fef21768d086f18998ea54237cfac34b8f548210928179"
        },
        "linux-x64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/local-cursor-v0.2.4/opencrawl-local-cursor-0.2.4-linux-x64.zip",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/local-cursor-v0.2.4/opencrawl-local-cursor-0.2.4-linux-x64.json",
          "sha256": "818b1d2f1e963ec80a38ee2ad55bf5169eb417db03eac099238c6ef932ef8152",
          "metadataSha256": "744d146402b95fec266968a30bfe145261640babee14237b4da13eea242aec93"
        },
        "win32-x64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/local-cursor-v0.2.4/opencrawl-local-cursor-0.2.4-win32-x64.zip",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/local-cursor-v0.2.4/opencrawl-local-cursor-0.2.4-win32-x64.json",
          "sha256": "f74273af4537fec05f0a7598ecde0c9ec1098c745cfca44042a2e6723ad75513",
          "metadataSha256": "6debd0495e0f7e4a86871d8a3a5bbaf4b8062eef6dee59e908a0a0f7335040e2"
        }
      },
      "ref": "39a41863a8efccdf1d3c457fe328a1e0d9d15e98",
      "memoryImportSkill": true,
      "listingIcon": true,
      "continueSkill": true
    },
    {
      "harness": "antigravity",
      "name": "opencrawl-local-antigravity",
      "path": "local/antigravity",
      "version": "0.2.4",
      "capabilities": "capabilities.json",
      "captureAvailable": true,
      "daemonHandoff": true,
      "minimumHarnessVersion": "1.5.9",
      "archives": {
        "darwin-arm64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/local-antigravity-v0.2.4/opencrawl-local-antigravity-0.2.4-darwin-arm64.zip",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/local-antigravity-v0.2.4/opencrawl-local-antigravity-0.2.4-darwin-arm64.json",
          "sha256": "b35232e184e423ea9b634961097a6116fb9c49c6f4bcf37b2200af4ee25f1d18",
          "metadataSha256": "3092d14895b34066fc0f2a8e3bf8305a23e80cc08e95256d54b9567936e21553"
        },
        "darwin-x64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/local-antigravity-v0.2.4/opencrawl-local-antigravity-0.2.4-darwin-x64.zip",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/local-antigravity-v0.2.4/opencrawl-local-antigravity-0.2.4-darwin-x64.json",
          "sha256": "c02847a372d2cf08b571282174b005162908256948fb44e2ae40e9fd7530c976",
          "metadataSha256": "6291b00d120d0a6571654035bed82ed560054bccab0e9efa4e582b8b83f939ec"
        },
        "linux-arm64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/local-antigravity-v0.2.4/opencrawl-local-antigravity-0.2.4-linux-arm64.zip",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/local-antigravity-v0.2.4/opencrawl-local-antigravity-0.2.4-linux-arm64.json",
          "sha256": "19ec286e14967e4a35d54ccd4e5f34bb1054856cd28d6be0b86369afb3ff1d0e",
          "metadataSha256": "4481ec600aceda0747944a5d6a85e8155cf4d978506477dfa9a838954a0029eb"
        },
        "linux-x64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/local-antigravity-v0.2.4/opencrawl-local-antigravity-0.2.4-linux-x64.zip",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/local-antigravity-v0.2.4/opencrawl-local-antigravity-0.2.4-linux-x64.json",
          "sha256": "3aff00c4d74069b84ccf1c692d62aa0940655838455bea06f775280897f53960",
          "metadataSha256": "92a0a7c207c80287f467f2b1b8334fd9b6f319e24167afd7d673403dc63cf93d"
        },
        "win32-x64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/local-antigravity-v0.2.4/opencrawl-local-antigravity-0.2.4-win32-x64.zip",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/local-antigravity-v0.2.4/opencrawl-local-antigravity-0.2.4-win32-x64.json",
          "sha256": "2ee1640099b32fbd625404160be8df8265d3d4dc108587ad78f4bf9647c36296",
          "metadataSha256": "367bb3072090553a6cc41eb7560f4172df45169dd99e3642fa54d3c1ea299e1a"
        }
      },
      "ref": "39a41863a8efccdf1d3c457fe328a1e0d9d15e98",
      "memoryImportSkill": true,
      "listingIcon": true,
      "continueSkill": true
    }
  ]
};
