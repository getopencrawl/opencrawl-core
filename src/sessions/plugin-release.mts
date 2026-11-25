export type ArchivePin={url:string;sha256:string;metadataUrl:string;metadataSha256:string};
export type PackageRelease={ref?:string;minimumHarnessVersion?:string;memoryImportSkill?:boolean;continueSkill?:boolean;shareSkill?:boolean;listingIcon?:boolean;harness:'claude-code'|'codex'|'cursor'|'antigravity';name:string;path:string;version:string;capabilities:string;captureAvailable:boolean;daemonHandoff:boolean;files?:Record<string,{sha:string;bytes:number}>;archives?:Record<string,ArchivePin>};
export type PluginRelease={repository:string;ref:string;schemaVersion:1;bindingSchemaVersion:1;packages:PackageRelease[]};

// Both guided setup and the Replicas installer consume this verified release.
export const pluginRelease:PluginRelease = {
  "repository": "getopencrawl/opencrawl-plugins",
  "ref": "92dd7b4f9bdc6c7477f73a1642a3fdf306226c5f",
  "schemaVersion": 1,
  "bindingSchemaVersion": 1,
  "packages": [
    {
      "harness": "claude-code",
      "name": "opencrawl",
      "path": "plugins/claude-code",
      "version": "0.3.7",
      "capabilities": "capabilities.json",
      "captureAvailable": true,
      "daemonHandoff": true,
      "minimumHarnessVersion": "2.1.327",
      "archives": {
        "darwin-arm64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.7/opencrawl-claude-code-0.3.7-darwin-arm64.zip",
          "sha256": "6a65e5a0651a81f3ffa385c007d8a6338158d18a2274b2d54710cc136c1d2145",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.7/opencrawl-claude-code-0.3.7-darwin-arm64.json",
          "metadataSha256": "cff569ceb45d6a814eb0d01a0670d1696d1714c8a62bcd61283912d217855f42"
        },
        "darwin-x64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.7/opencrawl-claude-code-0.3.7-darwin-x64.zip",
          "sha256": "cfb93cd20d41d3a2d734af39b70f254e213c7426187cb05c00e546eefbf81504",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.7/opencrawl-claude-code-0.3.7-darwin-x64.json",
          "metadataSha256": "292194205ab591dd9aa2e3a32f00e67c54c0ec67fd30beeeb0e9729455823e85"
        },
        "linux-arm64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.7/opencrawl-claude-code-0.3.7-linux-arm64.zip",
          "sha256": "fb9a9d51f600b20802e7aef125e853550ec55a2866f3f5f899c3f3129ab222ab",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.7/opencrawl-claude-code-0.3.7-linux-arm64.json",
          "metadataSha256": "1afe265406679efb4571d0757e6ab13a7cedde4bfa502ad15b0bd2b56518fcfa"
        },
        "linux-x64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.7/opencrawl-claude-code-0.3.7-linux-x64.zip",
          "sha256": "8ac16c2b923c23a87086bd36cc0b9e83b74e22ea1b1f70878090b40aafab47c7",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.7/opencrawl-claude-code-0.3.7-linux-x64.json",
          "metadataSha256": "a5a9ee5a6b9f820f430645b2aba4be395c5f166785494589a3347f3d0eda9629"
        },
        "win32-x64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.7/opencrawl-claude-code-0.3.7-win32-x64.zip",
          "sha256": "236cc672e824ff7dcf6d1a0c12b765dc8eaa300ca814a4f0fc4291a83c6942d1",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.7/opencrawl-claude-code-0.3.7-win32-x64.json",
          "metadataSha256": "fec374e1ecddbd42bddffb00c989ebc25ecef599767dcc663689752fd4c2cf01"
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
      "version": "0.3.7",
      "capabilities": "capabilities.json",
      "captureAvailable": true,
      "daemonHandoff": true,
      "minimumHarnessVersion": "0.166.0",
      "archives": {
        "darwin-arm64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.7/opencrawl-codex-0.3.7-darwin-arm64.zip",
          "sha256": "d5ff2a1e72110b095b0cc79a942777eee43afa3f8cbd238d344492ba37b11d85",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.7/opencrawl-codex-0.3.7-darwin-arm64.json",
          "metadataSha256": "14f2c636a798f7cbb9eaf8d30715fe0171b309b396e0c8469817c8fbec9a5bec"
        },
        "darwin-x64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.7/opencrawl-codex-0.3.7-darwin-x64.zip",
          "sha256": "bc3f93e323e85fd45c77f460a2c1251b1979132d3ddf916ee21d6d45df53f371",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.7/opencrawl-codex-0.3.7-darwin-x64.json",
          "metadataSha256": "757b8ab4348850bd621f30e48ed23176b3314e5cfe7accf762fd3c0545651331"
        },
        "linux-arm64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.7/opencrawl-codex-0.3.7-linux-arm64.zip",
          "sha256": "5896875efae621e8d72a3d055701e51026ef056f9c12a7abcb707d7df8f3bf98",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.7/opencrawl-codex-0.3.7-linux-arm64.json",
          "metadataSha256": "005b946eb01ad9eab80fd8d9d924f88598971babce3dd64653cb34880ec863c1"
        },
        "linux-x64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.7/opencrawl-codex-0.3.7-linux-x64.zip",
          "sha256": "17bda810516f4b5488a0e4bac0ab7462d9099dfb65832235cefbf34f13d47e61",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.7/opencrawl-codex-0.3.7-linux-x64.json",
          "metadataSha256": "c311e4b29facb99730ed4838fa0c89f0395ed995300083fef00e387b79a060ea"
        },
        "win32-x64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.7/opencrawl-codex-0.3.7-win32-x64.zip",
          "sha256": "fe11862415a5b13e2c8effc82f1d7b9bc8b44cf8e47ebd1df2a1637a9c1bdf8c",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.7/opencrawl-codex-0.3.7-win32-x64.json",
          "metadataSha256": "2afc820d94cee69886e6945588e60d9431dcbae9d71f3b486c24f65b13946099"
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
      "version": "0.3.7",
      "capabilities": "capabilities.json",
      "captureAvailable": true,
      "daemonHandoff": true,
      "minimumHarnessVersion": "2026.11.17-f532c45",
      "archives": {
        "darwin-arm64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.7/opencrawl-cursor-0.3.7-darwin-arm64.zip",
          "sha256": "32e6d0db12c56eda9e3d8225a6e2f6d4823d06c30c55ac1c5150585eb46883ab",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.7/opencrawl-cursor-0.3.7-darwin-arm64.json",
          "metadataSha256": "2dfdbe60ebd724e38aaf6b46395e9f24b46f3f93322316ca6eb0942b63a0580a"
        },
        "darwin-x64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.7/opencrawl-cursor-0.3.7-darwin-x64.zip",
          "sha256": "4ede9938cabdf331528aba02cc9d33b6a6313385180adc1b2111802fc7b7cb52",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.7/opencrawl-cursor-0.3.7-darwin-x64.json",
          "metadataSha256": "b5e9ae15246effcafe68534ea2bc889f130455af219c7b26c739f2ccdd8f521e"
        },
        "linux-arm64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.7/opencrawl-cursor-0.3.7-linux-arm64.zip",
          "sha256": "88bf1f1f92157a93997a767117e27f2eff2feeb72507000fdd895b32109fd4cf",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.7/opencrawl-cursor-0.3.7-linux-arm64.json",
          "metadataSha256": "cd1a9bb1fef5880fd2d7ee218cb2f2ce9fab95b72050272d4291b7fde3111254"
        },
        "linux-x64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.7/opencrawl-cursor-0.3.7-linux-x64.zip",
          "sha256": "c3e958388f267e7e0c73f3d7eeef1639cdc80777bafd50cacb2aac775cfe78e7",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.7/opencrawl-cursor-0.3.7-linux-x64.json",
          "metadataSha256": "0425f30ec24e7fa71a14a5093fa6bb1bc7e5108a09d8c98be713d9c20c823ecb"
        },
        "win32-x64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.7/opencrawl-cursor-0.3.7-win32-x64.zip",
          "sha256": "f17ee5eef25d87784536c370c0e1c4d3acdde0b853648f394300c8e0c862a216",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.7/opencrawl-cursor-0.3.7-win32-x64.json",
          "metadataSha256": "1bf41e9d889714747b5bfbaed96b317f2774342bf5cdacefa1d3735ab437fe1a"
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
      "version": "0.3.7",
      "capabilities": "capabilities.json",
      "captureAvailable": true,
      "daemonHandoff": true,
      "minimumHarnessVersion": "1.5.9",
      "archives": {
        "darwin-arm64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.7/opencrawl-antigravity-0.3.7-darwin-arm64.zip",
          "sha256": "9931b1775199a28f05ee25f1f18215d6236aaf564e3a366d3d6894ce3748a31f",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.7/opencrawl-antigravity-0.3.7-darwin-arm64.json",
          "metadataSha256": "9ba6beb969220d9e5b86f171127087ba47ec093e914661b576ecf12aced8cc41"
        },
        "darwin-x64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.7/opencrawl-antigravity-0.3.7-darwin-x64.zip",
          "sha256": "e4f434953aa9b6621bbe81ca8f6c3adefedf47e9322189369ed10a0075dd23cd",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.7/opencrawl-antigravity-0.3.7-darwin-x64.json",
          "metadataSha256": "1d56c5d734794833b9b47b0c4784505205a1e18436f77b500ab0c4b78888a711"
        },
        "linux-arm64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.7/opencrawl-antigravity-0.3.7-linux-arm64.zip",
          "sha256": "25756991f1c4996b4b0be32ffc597d96f6bc8e28f0b3ef97fc4219bb451e27fc",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.7/opencrawl-antigravity-0.3.7-linux-arm64.json",
          "metadataSha256": "e542926379580ff0d93a1f884538cae4ef4ad7401dba405b61321e7101cc182d"
        },
        "linux-x64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.7/opencrawl-antigravity-0.3.7-linux-x64.zip",
          "sha256": "7f8b0b6aa0b8e1963a2c5d39e109d76acbbde05ecbb1768ab28792f2c40cd850",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.7/opencrawl-antigravity-0.3.7-linux-x64.json",
          "metadataSha256": "9736e70f6797b8f1a002eaee0ea33b7aeecda617c1bb59386ee67311676765b6"
        },
        "win32-x64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.7/opencrawl-antigravity-0.3.7-win32-x64.zip",
          "sha256": "a4865366a6ea5b4884cda3396a7aa4a38874f79771fcccfe631e738740e24bcf",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.7/opencrawl-antigravity-0.3.7-win32-x64.json",
          "metadataSha256": "8e9c28aff2909beaa3086d3a519f1b563c332f5c5d401fcc1b89396f9c162b00"
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
  "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.7/replicas-codex-policy.mjs",
  "sha256": "f360fdc73d91b506e369a325219719fc33fb3a96951b807f2f2ad7bda272bcc5"
};
