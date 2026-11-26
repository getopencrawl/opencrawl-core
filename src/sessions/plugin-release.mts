export type ArchivePin={url:string;sha256:string;metadataUrl:string;metadataSha256:string};
export type PackageRelease={ref?:string;minimumHarnessVersion?:string;memoryImportSkill?:boolean;continueSkill?:boolean;shareSkill?:boolean;listingIcon?:boolean;harness:'claude-code'|'codex'|'cursor'|'antigravity';name:string;path:string;version:string;capabilities:string;captureAvailable:boolean;daemonHandoff:boolean;files?:Record<string,{sha:string;bytes:number}>;archives?:Record<string,ArchivePin>};
export type PluginRelease={repository:string;ref:string;schemaVersion:1;bindingSchemaVersion:1;packages:PackageRelease[]};

// Both guided setup and the Replicas installer consume this verified release.
export const pluginRelease:PluginRelease = {
  "repository": "getopencrawl/opencrawl-plugins",
  "ref": "e193703a0e60b003ad1edf349e0b3ea753167d5f",
  "schemaVersion": 1,
  "bindingSchemaVersion": 1,
  "packages": [
    {
      "harness": "claude-code",
      "name": "opencrawl",
      "path": "plugins/claude-code",
      "version": "0.3.9",
      "capabilities": "capabilities.json",
      "captureAvailable": true,
      "daemonHandoff": true,
      "minimumHarnessVersion": "2.1.327",
      "archives": {
        "darwin-arm64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.9/opencrawl-claude-code-0.3.9-darwin-arm64.zip",
          "sha256": "f9c04fddeda30e28dd15b5ae5f21e7d0cec69a70ffc128b610695110707daf1d",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.9/opencrawl-claude-code-0.3.9-darwin-arm64.json",
          "metadataSha256": "e0e40c64d327e6872d4f1a57e10eaa69dcfe64ff515b441f6e439d42fafbd5d8"
        },
        "darwin-x64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.9/opencrawl-claude-code-0.3.9-darwin-x64.zip",
          "sha256": "0bb1dc92e93db54ee73ca9366434f220927055679642bd322a0c5a321d950601",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.9/opencrawl-claude-code-0.3.9-darwin-x64.json",
          "metadataSha256": "fc38b89947d676fba4f685de8c4c9b189f0d6a5d8033209fcf1884d3d8986653"
        },
        "linux-arm64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.9/opencrawl-claude-code-0.3.9-linux-arm64.zip",
          "sha256": "e1fb5e908baa75c28af01c45a2e2ce38a7d304efff192fa4c42b18cc4cdc5f36",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.9/opencrawl-claude-code-0.3.9-linux-arm64.json",
          "metadataSha256": "03d219e88d929a57dcff9e110a44bba4a64871132514f06535a0d7c3696d61c3"
        },
        "linux-x64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.9/opencrawl-claude-code-0.3.9-linux-x64.zip",
          "sha256": "e017aefaa38681bcaa24d8b632ba5f094b9dc781afe68c47b29d085e3f3eabaf",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.9/opencrawl-claude-code-0.3.9-linux-x64.json",
          "metadataSha256": "1a8ac15adbfb614794f65d392c212ad7241b4bf0fcb3acad793950b38c34fd33"
        },
        "win32-x64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.9/opencrawl-claude-code-0.3.9-win32-x64.zip",
          "sha256": "b3bcaa51454b3afd4cb962acd1dd7afa4415fb72da1dee64c19ab6da9b3b46d9",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.9/opencrawl-claude-code-0.3.9-win32-x64.json",
          "metadataSha256": "5964124ab49996fb02be5f3a9c4833a1005c28197507c708c240378853829692"
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
      "version": "0.3.9",
      "capabilities": "capabilities.json",
      "captureAvailable": true,
      "daemonHandoff": true,
      "minimumHarnessVersion": "0.166.0",
      "archives": {
        "darwin-arm64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.9/opencrawl-codex-0.3.9-darwin-arm64.zip",
          "sha256": "c503f126be2250295fc691d382367281d62e90a41733d13e7240f23e079c97df",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.9/opencrawl-codex-0.3.9-darwin-arm64.json",
          "metadataSha256": "87f3eb6b19b857eaf8dce11d9f0322e73c5c3c3ad7e1081448c14d092978aeff"
        },
        "darwin-x64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.9/opencrawl-codex-0.3.9-darwin-x64.zip",
          "sha256": "3322a28ac76d4ca6c6560dd90942ddeedbc914f93d386e2d343ba79362b7daa1",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.9/opencrawl-codex-0.3.9-darwin-x64.json",
          "metadataSha256": "dcc20d4b6dd435929994a11b50d3bf4870c42e1e98f9e70fad0a63492e8527a1"
        },
        "linux-arm64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.9/opencrawl-codex-0.3.9-linux-arm64.zip",
          "sha256": "9834946464cdde2da74d4705af93a741ef1fb88e380549bd3e6e2693280977a2",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.9/opencrawl-codex-0.3.9-linux-arm64.json",
          "metadataSha256": "af36ab55b626408daf096ee5d9549fe809c3e7b12d04f382ba398e56b21ceec2"
        },
        "linux-x64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.9/opencrawl-codex-0.3.9-linux-x64.zip",
          "sha256": "db7ea734f3b60c5a67aeb9dd1269199031ce0ae50848bb16b73f8ac32e88fd2c",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.9/opencrawl-codex-0.3.9-linux-x64.json",
          "metadataSha256": "2f9dbaeb9c4929f19a2a0ce6e12175f956e10b2ee1a8eb6612eb0a56882ce032"
        },
        "win32-x64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.9/opencrawl-codex-0.3.9-win32-x64.zip",
          "sha256": "eee088d48ea4e3b8efecd33ba98750b4b3924b170db20e9b9e2ed340ae4c380a",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.9/opencrawl-codex-0.3.9-win32-x64.json",
          "metadataSha256": "f54eed7bdc26ae86d6ed526bae4c673f0398450fd2606410570bfcfde110e528"
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
      "version": "0.3.9",
      "capabilities": "capabilities.json",
      "captureAvailable": true,
      "daemonHandoff": true,
      "minimumHarnessVersion": "2026.11.17-f532c45",
      "archives": {
        "darwin-arm64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.9/opencrawl-cursor-0.3.9-darwin-arm64.zip",
          "sha256": "330592a71b19c6fa08f3775822e14c0fd3b1e92cc09109b7683d817af854231b",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.9/opencrawl-cursor-0.3.9-darwin-arm64.json",
          "metadataSha256": "6cb090e20a78684cf47c93a1b40cb1814eaae47925c3afa5d27ee7b9d1fc68aa"
        },
        "darwin-x64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.9/opencrawl-cursor-0.3.9-darwin-x64.zip",
          "sha256": "db3c29e0f0ec35a6879e62000c70b9b98761ba5d91c4d08d919fac22f3ca2521",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.9/opencrawl-cursor-0.3.9-darwin-x64.json",
          "metadataSha256": "b504c2e30a78b4322a1f9c461b8c146a6042f5a37dbdaed31d1496a6fff3c4d0"
        },
        "linux-arm64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.9/opencrawl-cursor-0.3.9-linux-arm64.zip",
          "sha256": "14f2edac4ce99c12617c260e1057366cf6ab61f94f09e343bb5cdea9761f2eaa",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.9/opencrawl-cursor-0.3.9-linux-arm64.json",
          "metadataSha256": "07cd878411bfb8bc81bc9c36e470b74b18c3350c6a752d886a0ac4c359289333"
        },
        "linux-x64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.9/opencrawl-cursor-0.3.9-linux-x64.zip",
          "sha256": "cb2cdad25d87ff9f05c02839d854a6797f281c528e148df0ddc4b4820b3eb324",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.9/opencrawl-cursor-0.3.9-linux-x64.json",
          "metadataSha256": "365b7ea97004d6e4e38119e7bf29b01632fccf2fbcf53256744155c0b5a7ba25"
        },
        "win32-x64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.9/opencrawl-cursor-0.3.9-win32-x64.zip",
          "sha256": "8a80fe909a4844b20b2d374e33aeaba1001ff0a1b84c5d92ce2496a765db065c",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.9/opencrawl-cursor-0.3.9-win32-x64.json",
          "metadataSha256": "7a6c8c65378f1659b1fbf22de70b64f8952c1e2909e99b3744773348452806c7"
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
      "version": "0.3.9",
      "capabilities": "capabilities.json",
      "captureAvailable": true,
      "daemonHandoff": true,
      "minimumHarnessVersion": "1.5.9",
      "archives": {
        "darwin-arm64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.9/opencrawl-antigravity-0.3.9-darwin-arm64.zip",
          "sha256": "41e9798ab5557e7e978eb49422fcbdbe2211bd7b61e22786d443e571e9f26ace",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.9/opencrawl-antigravity-0.3.9-darwin-arm64.json",
          "metadataSha256": "7ec64c5c07a640fbeb687002bc025fd0db4833c3f397aadc7cba31cb66fccaed"
        },
        "darwin-x64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.9/opencrawl-antigravity-0.3.9-darwin-x64.zip",
          "sha256": "854b101c6f20be094241b71d1a0249c4f672ae672900e3a9ca983fff3ba10858",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.9/opencrawl-antigravity-0.3.9-darwin-x64.json",
          "metadataSha256": "62601f2893636f9aa4dd022aa90ca52eb6554527518f805be942850e24ad6e4f"
        },
        "linux-arm64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.9/opencrawl-antigravity-0.3.9-linux-arm64.zip",
          "sha256": "43e26061ab1c5421a47207434fe8c17ba0bce83c9334158107f83419a5666a93",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.9/opencrawl-antigravity-0.3.9-linux-arm64.json",
          "metadataSha256": "6b4341bd48002517cb30d1e6dcea5fe69330bd2fb116778111e077a7f454aa99"
        },
        "linux-x64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.9/opencrawl-antigravity-0.3.9-linux-x64.zip",
          "sha256": "25f4593fc1b399d9f9bbfa905efbf3b07fff191db7eabfe268280c3e8ab76d90",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.9/opencrawl-antigravity-0.3.9-linux-x64.json",
          "metadataSha256": "9caf5c4a6da0b45e66ede330fea7d3137c636db975933a6ee54a302c1f1b2d38"
        },
        "win32-x64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.9/opencrawl-antigravity-0.3.9-win32-x64.zip",
          "sha256": "cedcb369214f967b5dbf6d6482f8558f939854108941b761a29602669fac9afb",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.9/opencrawl-antigravity-0.3.9-win32-x64.json",
          "metadataSha256": "930712c4f5582a638b006633473cab96c9c149491e345b80a4b35996d82d6fca"
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
  "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.9/replicas-codex-policy.mjs",
  "sha256": "a39609cac410804d63bbf0dc0f429925ea593b666edeae38dbcfba78bbd98dcf"
};
