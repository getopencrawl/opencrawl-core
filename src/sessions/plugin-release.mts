export type ArchivePin={url:string;sha256:string;metadataUrl:string;metadataSha256:string};
export type PackageRelease={ref?:string;minimumHarnessVersion?:string;memoryImportSkill?:boolean;continueSkill?:boolean;listingIcon?:boolean;harness:'claude-code'|'codex'|'cursor'|'antigravity';name:string;path:string;version:string;capabilities:string;captureAvailable:boolean;daemonHandoff:boolean;files?:Record<string,{sha:string;bytes:number}>;archives?:Record<string,ArchivePin>};
export type PluginRelease={repository:string;ref:string;schemaVersion:1;bindingSchemaVersion:1;packages:PackageRelease[]};

// Both guided setup and the Replicas installer consume this verified release.
export const pluginRelease:PluginRelease = {
  "repository": "getopencrawl/opencrawl-plugins",
  "ref": "7074078b2dd94d00b5b352962525e0e626e0a33c",
  "schemaVersion": 1,
  "bindingSchemaVersion": 1,
  "packages": [
    {
      "harness": "claude-code",
      "name": "opencrawl",
      "path": "plugins/claude-code",
      "version": "0.3.0",
      "capabilities": "capabilities.json",
      "captureAvailable": true,
      "daemonHandoff": true,
      "minimumHarnessVersion": "2.1.327",
      "archives": {
        "darwin-arm64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.0/opencrawl-claude-code-0.3.0-darwin-arm64.zip",
          "sha256": "8d73ca7099fd072dba50d5b0fd353a65eb7ef1e8a0c8f9c39783b0708a816a20",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.0/opencrawl-claude-code-0.3.0-darwin-arm64.json",
          "metadataSha256": "b9d01f1d23ec7e3c341844366272d018016de82008932afc70ff27e5c27d4951"
        },
        "darwin-x64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.0/opencrawl-claude-code-0.3.0-darwin-x64.zip",
          "sha256": "9213401a7d0a4e33aeda2be8e656ac80b008fe13d556ce913f8cc90f7f6e0a6f",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.0/opencrawl-claude-code-0.3.0-darwin-x64.json",
          "metadataSha256": "2a8a9b60717b5e5366a3b3850ddddcb57f30d6519b84e100129082b697b1270a"
        },
        "linux-arm64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.0/opencrawl-claude-code-0.3.0-linux-arm64.zip",
          "sha256": "c8f9e05c96e0fc8d78ede6e2414ee80ec970e311299d7831cbc6f569eab8f0cd",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.0/opencrawl-claude-code-0.3.0-linux-arm64.json",
          "metadataSha256": "6beacd9d8691e88383dd5c20ef0f39c1321373a734100e580fd3c35b5a1b0d94"
        },
        "linux-x64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.0/opencrawl-claude-code-0.3.0-linux-x64.zip",
          "sha256": "7b26213df25418c34a891be411d74352c5ab50df9bbb3d7350377d76d2daec99",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.0/opencrawl-claude-code-0.3.0-linux-x64.json",
          "metadataSha256": "0c2b775f23f800ae0a81077907320b9a81b8debd0d6b1ae63f3ecbd6ab42611a"
        },
        "win32-x64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.0/opencrawl-claude-code-0.3.0-win32-x64.zip",
          "sha256": "52f21131843c1b89b3bffba7d7f31e862fc07f6de49dfa400759e9c926d70447",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.0/opencrawl-claude-code-0.3.0-win32-x64.json",
          "metadataSha256": "271003a009911c6892f1b581759152ae7ada10d1966cd5ea862e2848fa37c3f7"
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
      "version": "0.3.0",
      "capabilities": "capabilities.json",
      "captureAvailable": true,
      "daemonHandoff": true,
      "minimumHarnessVersion": "0.166.0",
      "archives": {
        "darwin-arm64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.0/opencrawl-codex-0.3.0-darwin-arm64.zip",
          "sha256": "62dc7096911de99d257f1b9c95f36e38fb55205e075db6ede6b66afc3ea79715",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.0/opencrawl-codex-0.3.0-darwin-arm64.json",
          "metadataSha256": "8d093f376e945f75b16a98a078823f50a61213bd311e7e3d6ee60eb4b3127e25"
        },
        "darwin-x64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.0/opencrawl-codex-0.3.0-darwin-x64.zip",
          "sha256": "ea4a7b0c6ebd3c25e31edd107fd5998a2a38ebd32546b36036a6d3360c5c5128",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.0/opencrawl-codex-0.3.0-darwin-x64.json",
          "metadataSha256": "992f5b706760928fa0b873f249eaa6d063e5811d8c656ba8f6ba5188fe893bf2"
        },
        "linux-arm64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.0/opencrawl-codex-0.3.0-linux-arm64.zip",
          "sha256": "d3d45d9481e097ca87755c33dbfa57a1da99511f5dc1dc9ff20c7d57413238c3",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.0/opencrawl-codex-0.3.0-linux-arm64.json",
          "metadataSha256": "c138324539a1f2accdb21e151d0955dcc15a293914e29fcda63f2ecaca0b24d6"
        },
        "linux-x64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.0/opencrawl-codex-0.3.0-linux-x64.zip",
          "sha256": "aef943a5221e03bbfa8dc51f4e3de32b27ee090034e49f935dadce877eb5e35b",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.0/opencrawl-codex-0.3.0-linux-x64.json",
          "metadataSha256": "8434a8374e8c9bc61bfeca051c0f9619d3a83651f6d24ef187ecc476821227ba"
        },
        "win32-x64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.0/opencrawl-codex-0.3.0-win32-x64.zip",
          "sha256": "f9626d8675b03b5fd20695c1ec893ea6f8f750550388589d601d42422a146729",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.0/opencrawl-codex-0.3.0-win32-x64.json",
          "metadataSha256": "be2c7a1ffb9663fe1f08393e8e028f99f03c26f4fb7018eb528c5f18b9206f22"
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
      "version": "0.3.0",
      "capabilities": "capabilities.json",
      "captureAvailable": true,
      "daemonHandoff": true,
      "minimumHarnessVersion": "2026.11.17-f532c45",
      "archives": {
        "darwin-arm64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.0/opencrawl-cursor-0.3.0-darwin-arm64.zip",
          "sha256": "3091741cce9c2eba95a344ff805d648291b7b327fb275ec774efe40a2f3bb6c9",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.0/opencrawl-cursor-0.3.0-darwin-arm64.json",
          "metadataSha256": "0980971fe69530e46a2d1a517a7166575aaf879b6607cdbd49b161acb4348713"
        },
        "darwin-x64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.0/opencrawl-cursor-0.3.0-darwin-x64.zip",
          "sha256": "092a9bb5e5cd3e5d20bb8576d010ab20e26ca4d707a3b22d31953bc03edaf00b",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.0/opencrawl-cursor-0.3.0-darwin-x64.json",
          "metadataSha256": "598568d8e7597b1391a5879d5e87a63c6b214fcf8e0fcb66328d331e7821456f"
        },
        "linux-arm64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.0/opencrawl-cursor-0.3.0-linux-arm64.zip",
          "sha256": "f3a23b48988e89c8a92102faa75557a9ef6e9d2fc0bf420b23b0f5d51808d186",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.0/opencrawl-cursor-0.3.0-linux-arm64.json",
          "metadataSha256": "fd758098f945886a32906ee1ccb8a028cea5ab1ddacc6e62345c85c73772d7a7"
        },
        "linux-x64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.0/opencrawl-cursor-0.3.0-linux-x64.zip",
          "sha256": "4bc7dffba58c04125279675a28db2b471c596001d2ff4a0fcfc0cc363039a755",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.0/opencrawl-cursor-0.3.0-linux-x64.json",
          "metadataSha256": "ddf419ca8a7789d64cc4055c05c3ef514261ca916e8f8c2cb0a9bce677082ff1"
        },
        "win32-x64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.0/opencrawl-cursor-0.3.0-win32-x64.zip",
          "sha256": "1911d935d0cd5dfdb5a0e7cb931e76ace6a881fefa779b8e307ed3050ac4d511",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.0/opencrawl-cursor-0.3.0-win32-x64.json",
          "metadataSha256": "66a0e14d4f8fe716947ed333559e80b833d4cb8215934d181089eb8890bd0bcb"
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
      "version": "0.3.0",
      "capabilities": "capabilities.json",
      "captureAvailable": true,
      "daemonHandoff": true,
      "minimumHarnessVersion": "1.5.9",
      "archives": {
        "darwin-arm64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.0/opencrawl-antigravity-0.3.0-darwin-arm64.zip",
          "sha256": "5dbf5602b9d39c6ff518d726d416fa50528fd5a30fdb807b66d925bf7905d3d5",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.0/opencrawl-antigravity-0.3.0-darwin-arm64.json",
          "metadataSha256": "e702fd6367473dfdda3e0b257ce73724cf5c35835d278aca90cfb16f3290eda3"
        },
        "darwin-x64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.0/opencrawl-antigravity-0.3.0-darwin-x64.zip",
          "sha256": "9193bc48e50dd45e5c864d579e1f36f63ad2df9a7564488f25a3f3bc346e973b",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.0/opencrawl-antigravity-0.3.0-darwin-x64.json",
          "metadataSha256": "03625b006668be066d5aea84a111ece30fbba98d597a29abbbf500d73d3a7fee"
        },
        "linux-arm64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.0/opencrawl-antigravity-0.3.0-linux-arm64.zip",
          "sha256": "d4288f72fc155620b1e6696cb927329e8f2b3652940746bf24e9d1001451b136",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.0/opencrawl-antigravity-0.3.0-linux-arm64.json",
          "metadataSha256": "e84468b2a231ab9ec4759c636f4ad9a23b11075810342ad7d9dfa38af0cc34ab"
        },
        "linux-x64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.0/opencrawl-antigravity-0.3.0-linux-x64.zip",
          "sha256": "617639ef52a42610f6551000c88e3895d09b02470f03972cf48bbfc76ef25766",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.0/opencrawl-antigravity-0.3.0-linux-x64.json",
          "metadataSha256": "9156a4d2832e52577cc709887d87b76f6314b40fd2f850662012e3559db19694"
        },
        "win32-x64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.0/opencrawl-antigravity-0.3.0-win32-x64.zip",
          "sha256": "4b66c76f1a186793cd07e2fb5203f54fe717e17b970830b54fa97d86a897757d",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.0/opencrawl-antigravity-0.3.0-win32-x64.json",
          "metadataSha256": "a734c216fee9a1be0871e9202f119a20631db8bb23f9f547fc4763b0d554b678"
        }
      },
      "memoryImportSkill": true,
      "listingIcon": true,
      "continueSkill": true
    }
  ]
};

export const replicasPolicy = {
  "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.0/replicas-codex-policy.mjs",
  "sha256": "f360fdc73d91b506e369a325219719fc33fb3a96951b807f2f2ad7bda272bcc5"
};
