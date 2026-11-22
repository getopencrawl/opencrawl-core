export type ArchivePin={url:string;sha256:string;metadataUrl:string;metadataSha256:string};
export type PackageRelease={ref?:string;minimumHarnessVersion?:string;memoryImportSkill?:boolean;continueSkill?:boolean;listingIcon?:boolean;harness:'claude-code'|'codex'|'cursor'|'antigravity';name:string;path:string;version:string;capabilities:string;captureAvailable:boolean;daemonHandoff:boolean;files?:Record<string,{sha:string;bytes:number}>;archives?:Record<string,ArchivePin>};
export type PluginRelease={repository:string;ref:string;schemaVersion:1;bindingSchemaVersion:1;packages:PackageRelease[]};

// Both guided setup and the Replicas installer consume this verified release.
export const pluginRelease:PluginRelease = {
  "repository": "getopencrawl/opencrawl-plugins",
  "ref": "daeaa95055ec6638f7d841478abd43bac1702afd",
  "schemaVersion": 1,
  "bindingSchemaVersion": 1,
  "packages": [
    {
      "harness": "claude-code",
      "name": "opencrawl",
      "path": "plugins/claude-code",
      "version": "0.3.5",
      "capabilities": "capabilities.json",
      "captureAvailable": true,
      "daemonHandoff": true,
      "minimumHarnessVersion": "2.1.327",
      "archives": {
        "darwin-arm64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.5/opencrawl-claude-code-0.3.5-darwin-arm64.zip",
          "sha256": "ad8411cf4f481c54e5ac102b21cbd63eeab19fac55f9fc1d7e45521ce9c9527d",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.5/opencrawl-claude-code-0.3.5-darwin-arm64.json",
          "metadataSha256": "0400807c5f56ca4d44e6d0780459c6af221696f5fc83ed76affa719ab56d46c7"
        },
        "darwin-x64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.5/opencrawl-claude-code-0.3.5-darwin-x64.zip",
          "sha256": "7d0903653b22fd8dd2d6742acf8da1980a3888e081816e686039d0316eec8a5d",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.5/opencrawl-claude-code-0.3.5-darwin-x64.json",
          "metadataSha256": "a5198d571c151e96342f1be2a95c413ac68dbd9318119b2fdf1c271c3b1b58ac"
        },
        "linux-arm64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.5/opencrawl-claude-code-0.3.5-linux-arm64.zip",
          "sha256": "88e71dee40803bce9419f4d10fe1af42262aa696eced0b3e2016f7fae229d7d4",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.5/opencrawl-claude-code-0.3.5-linux-arm64.json",
          "metadataSha256": "d0ba65e8cb5c6af9fc83bb2e7cf66a9d9b4a047775eea83fd07e0d8870430623"
        },
        "linux-x64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.5/opencrawl-claude-code-0.3.5-linux-x64.zip",
          "sha256": "d82e755e584ebc168d73d651fde3c52a3db1bd75265697f79190dc1c474c7cb4",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.5/opencrawl-claude-code-0.3.5-linux-x64.json",
          "metadataSha256": "e4f90fb7b70ae408b4c755c2bde99a7c1ffc018da13b0ef43c2cee133f69cf76"
        },
        "win32-x64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.5/opencrawl-claude-code-0.3.5-win32-x64.zip",
          "sha256": "2b581ac2ff27e312a254653d5c60eb407430b8428c715d50ac1bfdc7251de59d",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.5/opencrawl-claude-code-0.3.5-win32-x64.json",
          "metadataSha256": "6e65654ceea4b98b9cb515cfd491178020498cbec22e39f99224aef159061274"
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
      "version": "0.3.5",
      "capabilities": "capabilities.json",
      "captureAvailable": true,
      "daemonHandoff": true,
      "minimumHarnessVersion": "0.166.0",
      "archives": {
        "darwin-arm64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.5/opencrawl-codex-0.3.5-darwin-arm64.zip",
          "sha256": "23d50182b090a5a10c178e349e07ab33b49bd786a6a12892158fd10ef4023687",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.5/opencrawl-codex-0.3.5-darwin-arm64.json",
          "metadataSha256": "ae4ac7e5dfabd19e380c46542770eed1162058faafd90f00840d6092d71c66d3"
        },
        "darwin-x64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.5/opencrawl-codex-0.3.5-darwin-x64.zip",
          "sha256": "49ae4f6f38e12e830b10b7b79da1d3dd4883cc58a5dc44f217fd5c6af8cc93a2",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.5/opencrawl-codex-0.3.5-darwin-x64.json",
          "metadataSha256": "e845ff28d00b1fff785660b50606d7b34f4ec2b22bb708205a1675208f372782"
        },
        "linux-arm64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.5/opencrawl-codex-0.3.5-linux-arm64.zip",
          "sha256": "97287de47d3496849e55191219a6c961bf31fa536eb6fa7661a412d041583c1d",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.5/opencrawl-codex-0.3.5-linux-arm64.json",
          "metadataSha256": "d6deb11f3bfa05496a7e7ade3777338e3764183365ce86fef40f3ae58db1147c"
        },
        "linux-x64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.5/opencrawl-codex-0.3.5-linux-x64.zip",
          "sha256": "85f76534f8dd6d02dab2f921c421e5306e56f932595c8dd25d05f44d3b5bf486",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.5/opencrawl-codex-0.3.5-linux-x64.json",
          "metadataSha256": "788ce1a5b69e0d01af25d6daf8c5852c241291e6b55fe02694c9ee1bd4e68c0a"
        },
        "win32-x64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.5/opencrawl-codex-0.3.5-win32-x64.zip",
          "sha256": "b8270d85a3b4a376839408f0415e149c84d283a42cbb509ce9c0b60284f6bed4",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.5/opencrawl-codex-0.3.5-win32-x64.json",
          "metadataSha256": "903cb16255631ac0dda5497a24a8677603e69fbd7b47fb424d7f97b74b475e66"
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
      "version": "0.3.5",
      "capabilities": "capabilities.json",
      "captureAvailable": true,
      "daemonHandoff": true,
      "minimumHarnessVersion": "2026.11.17-f532c45",
      "archives": {
        "darwin-arm64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.5/opencrawl-cursor-0.3.5-darwin-arm64.zip",
          "sha256": "30c4bb38ee2fa0682a3238c3a445c05bb811ab35cf77439c11b88cabc77b2510",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.5/opencrawl-cursor-0.3.5-darwin-arm64.json",
          "metadataSha256": "d32318f51f1cdc6066baad2cd4bc7d3793f4a950aef83c17efca43a4cfc524e3"
        },
        "darwin-x64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.5/opencrawl-cursor-0.3.5-darwin-x64.zip",
          "sha256": "2d54cd2ed79e9ce3c456f7f226f5d9b127023871cb3ae1320f4417d38544d7be",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.5/opencrawl-cursor-0.3.5-darwin-x64.json",
          "metadataSha256": "960873a0e62e7f7c2ed9607aa8966b7f49d48b6a5bcf85100f97bef7fdaa8c3f"
        },
        "linux-arm64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.5/opencrawl-cursor-0.3.5-linux-arm64.zip",
          "sha256": "7159dd68a4120dd44301fd30f5d2e36bc8edb00a3887560862ee37b28524722e",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.5/opencrawl-cursor-0.3.5-linux-arm64.json",
          "metadataSha256": "1ade2cdcd3d6ca29135e910207d1e476f82e7ab5840ca1b3eb53045983459c6f"
        },
        "linux-x64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.5/opencrawl-cursor-0.3.5-linux-x64.zip",
          "sha256": "474363295b7117c95fc5e777e17bc7fc492ba24ab18b33489c9916fe933a3537",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.5/opencrawl-cursor-0.3.5-linux-x64.json",
          "metadataSha256": "f248da115702e83f4f53105770a5b01f27e728971989491644ab5188a9005a76"
        },
        "win32-x64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.5/opencrawl-cursor-0.3.5-win32-x64.zip",
          "sha256": "8cdf3a7590a541e6343d765da16ec0bc669f60465aeb11379de41f54af69c17f",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.5/opencrawl-cursor-0.3.5-win32-x64.json",
          "metadataSha256": "afbdffbbc2f93b4cede46c94037e346e13fc3bbbc5bdb5b4918f5207ac8dba17"
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
      "version": "0.3.5",
      "capabilities": "capabilities.json",
      "captureAvailable": true,
      "daemonHandoff": true,
      "minimumHarnessVersion": "1.5.9",
      "archives": {
        "darwin-arm64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.5/opencrawl-antigravity-0.3.5-darwin-arm64.zip",
          "sha256": "723bc1b4501a14dd3d7fa24de3ae57d0be78aa3b66587e0147bb15eecbbcc67c",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.5/opencrawl-antigravity-0.3.5-darwin-arm64.json",
          "metadataSha256": "916d7c465de1112d65c460a1b3381cc4639516bddda3c0fe5b324136323aa27c"
        },
        "darwin-x64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.5/opencrawl-antigravity-0.3.5-darwin-x64.zip",
          "sha256": "95523b150ba24fe0cd28be00abf6df1d05158d5144479f2d7549fd853ca08494",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.5/opencrawl-antigravity-0.3.5-darwin-x64.json",
          "metadataSha256": "3bf4730b5b1d2a7d81f0eec5a5685e1f879be53a2fbbe0cbea8f39eaa6b69963"
        },
        "linux-arm64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.5/opencrawl-antigravity-0.3.5-linux-arm64.zip",
          "sha256": "3246e1135775395a179c8f8185475e0b2859999195de894996f26205a3ab7248",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.5/opencrawl-antigravity-0.3.5-linux-arm64.json",
          "metadataSha256": "89183b429b42c2857d245ac26c91dff6c422d69396b5c96968b884240f4cb414"
        },
        "linux-x64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.5/opencrawl-antigravity-0.3.5-linux-x64.zip",
          "sha256": "db5df7c69d0b90bd4a98a04aca909d10ed96a694801292f1256542bcea6d05be",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.5/opencrawl-antigravity-0.3.5-linux-x64.json",
          "metadataSha256": "fb52336e6e0e3801dfda37d54a1274cf65c8f2c99759a5a1c592526d58d8007e"
        },
        "win32-x64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.5/opencrawl-antigravity-0.3.5-win32-x64.zip",
          "sha256": "c07b7c371d1a5ba92d3206af5969972da280597c69da7113d227572ec440697e",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.5/opencrawl-antigravity-0.3.5-win32-x64.json",
          "metadataSha256": "c75095bbe2b7cce812a9c07748f36af16421aa80425e6cd1bbcb15d8ae9e3bb9"
        }
      },
      "memoryImportSkill": true,
      "listingIcon": true,
      "continueSkill": true
    }
  ]
};

export const replicasPolicy = {
  "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.5/replicas-codex-policy.mjs",
  "sha256": "f360fdc73d91b506e369a325219719fc33fb3a96951b807f2f2ad7bda272bcc5"
};
