export type ArchivePin={url:string;sha256:string;metadataUrl:string;metadataSha256:string};
export type PackageRelease={ref?:string;minimumHarnessVersion?:string;memoryImportSkill?:boolean;harness:'claude-code'|'codex'|'cursor'|'antigravity';name:string;path:string;version:string;capabilities:string;captureAvailable:boolean;daemonHandoff:boolean;files?:Record<string,{sha:string;bytes:number}>;archives?:Record<string,ArchivePin>};
export type PluginRelease={repository:string;ref:string;schemaVersion:1;bindingSchemaVersion:1;packages:PackageRelease[]};

// Reviewed immutable package inventory from the public plugins repository.
// Update this pin only with matching capability and native acceptance evidence.
export const pluginRelease:PluginRelease = {
  "repository": "getopencrawl/opencrawl-plugins",
  "ref": "17eb03892a2ae4fdf6a91c5b4f94ac7c27842cd6",
  "schemaVersion": 1,
  "bindingSchemaVersion": 1,
  "packages": [
    {
      "harness": "claude-code",
      "name": "opencrawl-local-claude-code",
      "path": "local/claude-code",
      "version": "0.2.1",
      "capabilities": "capabilities.json",
      "captureAvailable": true,
      "daemonHandoff": true,
      "minimumHarnessVersion": "2.1.327",
      "archives": {
        "darwin-arm64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/local-claude-code-v0.2.1/opencrawl-local-claude-code-0.2.1-darwin-arm64.zip",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/local-claude-code-v0.2.1/opencrawl-local-claude-code-0.2.1-darwin-arm64.json",
          "sha256": "58b14ea58cb2da4acd58c269fdfbf4faacd86974b0fd826fb7dc458fabb87d43",
          "metadataSha256": "929cd7a111476eae3db3b7bb22d44e555cb05c71e850a348ec1ff7747aed1a38"
        },
        "darwin-x64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/local-claude-code-v0.2.1/opencrawl-local-claude-code-0.2.1-darwin-x64.zip",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/local-claude-code-v0.2.1/opencrawl-local-claude-code-0.2.1-darwin-x64.json",
          "sha256": "dd0ca263f65f07689586d40c487a112320561e6c84a48ded7d21a233478ac774",
          "metadataSha256": "8767e8e167a0470e68e64179bfc8471fb632188e5e22520f9d4a3f3194db577a"
        },
        "linux-arm64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/local-claude-code-v0.2.1/opencrawl-local-claude-code-0.2.1-linux-arm64.zip",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/local-claude-code-v0.2.1/opencrawl-local-claude-code-0.2.1-linux-arm64.json",
          "sha256": "eedd57b9521f7b98d42433e86a774a21da467ebb1c77366ac7819c8b04482263",
          "metadataSha256": "1520b0baf479ed632a2d44bbbf01ecd5475cbf42ad2b5d5590a897cba0c84214"
        },
        "linux-x64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/local-claude-code-v0.2.1/opencrawl-local-claude-code-0.2.1-linux-x64.zip",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/local-claude-code-v0.2.1/opencrawl-local-claude-code-0.2.1-linux-x64.json",
          "sha256": "022cbf12eb7c89fbf88e62e7574afbf3232ad1c0b5b8ee77896e9b6d238b9da9",
          "metadataSha256": "95ae1943dae5699dd6897942103812af8d7056a3282fe8a56353dee15682db38"
        },
        "win32-x64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/local-claude-code-v0.2.1/opencrawl-local-claude-code-0.2.1-win32-x64.zip",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/local-claude-code-v0.2.1/opencrawl-local-claude-code-0.2.1-win32-x64.json",
          "sha256": "3e0b2bd2c736ffe7667f10d96bfae3d733a18c9a4865fd6d239880cc3b74b6b3",
          "metadataSha256": "babfca9b20a735e2601a32aa05606f19de8297ea227a0f9e6adeec57f3d12b2f"
        }
      },
      "ref": "17eb03892a2ae4fdf6a91c5b4f94ac7c27842cd6",
      "memoryImportSkill": true
    },
    {
      "harness": "codex",
      "name": "opencrawl-local-codex",
      "path": "local/codex",
      "version": "0.2.1",
      "capabilities": "capabilities.json",
      "captureAvailable": true,
      "daemonHandoff": true,
      "minimumHarnessVersion": "0.166.0",
      "archives": {
        "darwin-arm64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/local-codex-v0.2.1/opencrawl-local-codex-0.2.1-darwin-arm64.zip",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/local-codex-v0.2.1/opencrawl-local-codex-0.2.1-darwin-arm64.json",
          "sha256": "dd380c4f2e7b343e58ad0e11a84be327db8f4c7298715eb0c43f312be6ac158f",
          "metadataSha256": "fc07e874a767603952585ade4d7b2b449aeba0f33a991dcbd8ac0e01bc97fe58"
        },
        "darwin-x64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/local-codex-v0.2.1/opencrawl-local-codex-0.2.1-darwin-x64.zip",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/local-codex-v0.2.1/opencrawl-local-codex-0.2.1-darwin-x64.json",
          "sha256": "60c0de556b5fb3af1763d43bba2e0b997ced8ea45e70f56b43b230f6fac82817",
          "metadataSha256": "33e46c08ba47111a1ab8671903ba683ed0687454b7bfe1732611a2c477d1423b"
        },
        "linux-arm64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/local-codex-v0.2.1/opencrawl-local-codex-0.2.1-linux-arm64.zip",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/local-codex-v0.2.1/opencrawl-local-codex-0.2.1-linux-arm64.json",
          "sha256": "06efc3d99303cc1d3533b27013ac376a4be0a20cf5598d396f8b4c6a19cd9b50",
          "metadataSha256": "578cca47151eb622aed611d75f6eea20f5378ae74ca50a9ea62dc172d63fc653"
        },
        "linux-x64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/local-codex-v0.2.1/opencrawl-local-codex-0.2.1-linux-x64.zip",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/local-codex-v0.2.1/opencrawl-local-codex-0.2.1-linux-x64.json",
          "sha256": "ceacb824b2e82c0eb6c9ab2761fb17e7a530285b7e400cd393d6a4a9cedf53cb",
          "metadataSha256": "e7f4c9f7637fce940eb1026cea8224e13de062b8be91a987519e1f17b7cd71d8"
        },
        "win32-x64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/local-codex-v0.2.1/opencrawl-local-codex-0.2.1-win32-x64.zip",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/local-codex-v0.2.1/opencrawl-local-codex-0.2.1-win32-x64.json",
          "sha256": "f88a41dcbbfa42324f7951e8226ac0e77d7aa94f01d9dd9b1f68c934d25419d0",
          "metadataSha256": "fc77b2359131a4cb917e3f5d9d24014d6f68b2ba3de853035033a0fa2279aa5e"
        }
      },
      "ref": "17eb03892a2ae4fdf6a91c5b4f94ac7c27842cd6",
      "memoryImportSkill": true
    },
    {
      "harness": "cursor",
      "name": "opencrawl-local-cursor",
      "path": "local/cursor",
      "version": "0.2.1",
      "capabilities": "capabilities.json",
      "captureAvailable": true,
      "daemonHandoff": true,
      "minimumHarnessVersion": "2026.11.17-f532c45",
      "archives": {
        "darwin-arm64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/local-cursor-v0.2.1/opencrawl-local-cursor-0.2.1-darwin-arm64.zip",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/local-cursor-v0.2.1/opencrawl-local-cursor-0.2.1-darwin-arm64.json",
          "sha256": "f8277d66f5999d5d26f55ee8227157c879b4943b13ad2db5b30af0749276d41d",
          "metadataSha256": "4da9668b98196897fa4592c9f7977be317e6e30cb0b16790d6dd27f4caaf2496"
        },
        "darwin-x64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/local-cursor-v0.2.1/opencrawl-local-cursor-0.2.1-darwin-x64.zip",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/local-cursor-v0.2.1/opencrawl-local-cursor-0.2.1-darwin-x64.json",
          "sha256": "6aed162a75da2f3a690e79dc1ca41fa202a1835a3b8bbb172919936610be707a",
          "metadataSha256": "2fe390d56b96da31c5d7c261bbf55e0afb21b1fd7104b3e22c6e656ece7051d2"
        },
        "linux-arm64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/local-cursor-v0.2.1/opencrawl-local-cursor-0.2.1-linux-arm64.zip",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/local-cursor-v0.2.1/opencrawl-local-cursor-0.2.1-linux-arm64.json",
          "sha256": "116947f7d2cf2e7d5da62ba21b0be4a215bc61867d1caf0cb2c2a11ece92b9f9",
          "metadataSha256": "7c384db29d88287921f459ac2b5ae5752871525d71ad1da6ab43fd2afed54930"
        },
        "linux-x64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/local-cursor-v0.2.1/opencrawl-local-cursor-0.2.1-linux-x64.zip",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/local-cursor-v0.2.1/opencrawl-local-cursor-0.2.1-linux-x64.json",
          "sha256": "d85707b2b393143c80452db20a7fed7406a995a66bc960eb74350385e19be7a8",
          "metadataSha256": "7004f17a3e19ebbbe8b10d8ca27cc874c0e2fde37d02877aa62814678c167336"
        },
        "win32-x64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/local-cursor-v0.2.1/opencrawl-local-cursor-0.2.1-win32-x64.zip",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/local-cursor-v0.2.1/opencrawl-local-cursor-0.2.1-win32-x64.json",
          "sha256": "4deaf74b932c224dd747bf5855c75522101d9bb6e0311ed040a2a2e52a6fb133",
          "metadataSha256": "891360e1eca65cfd08b92dec922e0931565a4f3695ac8f948fe7330d7b8cad9d"
        }
      },
      "ref": "17eb03892a2ae4fdf6a91c5b4f94ac7c27842cd6",
      "memoryImportSkill": true
    },
    {
      "harness": "antigravity",
      "name": "opencrawl-local-antigravity",
      "path": "local/antigravity",
      "version": "0.2.1",
      "capabilities": "capabilities.json",
      "captureAvailable": true,
      "daemonHandoff": true,
      "minimumHarnessVersion": "1.5.9",
      "archives": {
        "darwin-arm64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/local-antigravity-v0.2.1/opencrawl-local-antigravity-0.2.1-darwin-arm64.zip",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/local-antigravity-v0.2.1/opencrawl-local-antigravity-0.2.1-darwin-arm64.json",
          "sha256": "6816f0b51db99447229b4e192e9cdec2ae9726956496ec3e2d5bf1294d7e4e26",
          "metadataSha256": "fc8ca3d9cd816a89386c2e8f29f458d23d32913a1b4d9594e4495d2ade834310"
        },
        "darwin-x64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/local-antigravity-v0.2.1/opencrawl-local-antigravity-0.2.1-darwin-x64.zip",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/local-antigravity-v0.2.1/opencrawl-local-antigravity-0.2.1-darwin-x64.json",
          "sha256": "3a7cbaa9e0d647685f9b1fd838167e63143dbf584f6cd392b0dafd747b36f802",
          "metadataSha256": "5bd9bdf68e119d0c22e20998d93a3f08950771b73e490a6b0b79660cecd612e7"
        },
        "linux-arm64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/local-antigravity-v0.2.1/opencrawl-local-antigravity-0.2.1-linux-arm64.zip",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/local-antigravity-v0.2.1/opencrawl-local-antigravity-0.2.1-linux-arm64.json",
          "sha256": "d1a3206deaf7981fe9bd228bbfcf85b6cf9695edceada13bed49476a7dfc2e9c",
          "metadataSha256": "bc3c3279ac3bcb162ef89267f521f0686d1386c89a2740e636eaeebaa2a0fdd6"
        },
        "linux-x64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/local-antigravity-v0.2.1/opencrawl-local-antigravity-0.2.1-linux-x64.zip",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/local-antigravity-v0.2.1/opencrawl-local-antigravity-0.2.1-linux-x64.json",
          "sha256": "1c9f0a4ab48a0509e2fc699f399c724db32a012efbf37937a12e2dadc54b21ff",
          "metadataSha256": "08c3d2482b50cafbe65f9ef1702f9719d0ee36e6f56b9730300adbe00bf4dc46"
        },
        "win32-x64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/local-antigravity-v0.2.1/opencrawl-local-antigravity-0.2.1-win32-x64.zip",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/local-antigravity-v0.2.1/opencrawl-local-antigravity-0.2.1-win32-x64.json",
          "sha256": "e514ac20516e9ff8bdc8913cf6f88284df271938347632afc02951eedbc367be",
          "metadataSha256": "82c82e26b0297e2710f06deaadd989663b05a53fd0ac9661b62f557f49869299"
        }
      },
      "ref": "17eb03892a2ae4fdf6a91c5b4f94ac7c27842cd6",
      "memoryImportSkill": true
    }
  ]
};
