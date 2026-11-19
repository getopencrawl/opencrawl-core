export type ArchivePin={url:string;sha256:string;metadataUrl:string;metadataSha256:string};
export type PackageRelease={ref?:string;minimumHarnessVersion?:string;memoryImportSkill?:boolean;listingIcon?:boolean;harness:'claude-code'|'codex'|'cursor'|'antigravity';name:string;path:string;version:string;capabilities:string;captureAvailable:boolean;daemonHandoff:boolean;files?:Record<string,{sha:string;bytes:number}>;archives?:Record<string,ArchivePin>};
export type PluginRelease={repository:string;ref:string;schemaVersion:1;bindingSchemaVersion:1;packages:PackageRelease[]};

// Reviewed immutable package inventory from the public plugins repository.
// Update this pin only with matching capability and native acceptance evidence.
export const pluginRelease:PluginRelease = {
  "repository": "getopencrawl/opencrawl-plugins",
  "ref": "51004a8e68644af00ecf4cf56ec8bbea9fd15ee3",
  "schemaVersion": 1,
  "bindingSchemaVersion": 1,
  "packages": [
    {
      "harness": "claude-code",
      "name": "opencrawl-local-claude-code",
      "path": "local/claude-code",
      "version": "0.2.2",
      "capabilities": "capabilities.json",
      "captureAvailable": true,
      "daemonHandoff": true,
      "minimumHarnessVersion": "2.1.327",
      "archives": {
        "darwin-arm64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/local-claude-code-v0.2.2/opencrawl-local-claude-code-0.2.2-darwin-arm64.zip",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/local-claude-code-v0.2.2/opencrawl-local-claude-code-0.2.2-darwin-arm64.json",
          "sha256": "88016ac882ef2a20d2db3477e3950db009073ddaf72b1dd58554faa5a34611c1",
          "metadataSha256": "55fc89a3dc820834ff1512f6255ca6fc65f44f9ffc139cd783fbbd2315a4eefa"
        },
        "darwin-x64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/local-claude-code-v0.2.2/opencrawl-local-claude-code-0.2.2-darwin-x64.zip",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/local-claude-code-v0.2.2/opencrawl-local-claude-code-0.2.2-darwin-x64.json",
          "sha256": "b1710e5e4c7eaa3af5724eb71fc1825a1b45651b9b225169650589b387136cb0",
          "metadataSha256": "65d0b123639c61752febe44fbe21d051fd15489320146d917e6f8b83e070e0f3"
        },
        "linux-arm64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/local-claude-code-v0.2.2/opencrawl-local-claude-code-0.2.2-linux-arm64.zip",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/local-claude-code-v0.2.2/opencrawl-local-claude-code-0.2.2-linux-arm64.json",
          "sha256": "9da8b47ce69279fc92f3d9c4b00f3eb7f07a9ede744f2130eb898ad2afc6e83a",
          "metadataSha256": "62729878f8786a98dfc5de9394bc3c90131d99bcdb2e6fbe592ad0a38eba3fc7"
        },
        "linux-x64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/local-claude-code-v0.2.2/opencrawl-local-claude-code-0.2.2-linux-x64.zip",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/local-claude-code-v0.2.2/opencrawl-local-claude-code-0.2.2-linux-x64.json",
          "sha256": "36fb232ad9f23bcdf5232d8fd58f997dd6da4ecf76b261a4b4e799e853205e21",
          "metadataSha256": "26a45dcaefa865e6e314b307db7debc14aabc52d1665acaba376a4757818173d"
        },
        "win32-x64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/local-claude-code-v0.2.2/opencrawl-local-claude-code-0.2.2-win32-x64.zip",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/local-claude-code-v0.2.2/opencrawl-local-claude-code-0.2.2-win32-x64.json",
          "sha256": "e5187e716917d9a5b479b5f0b6fda148aec540428b6a5e1454d0d4534c0ffb73",
          "metadataSha256": "ac8a0e7d9c3ca6e94ff7dbdc937f0921014ab46cbe0e34df6f12b07bf5ad25a9"
        }
      },
      "ref": "51004a8e68644af00ecf4cf56ec8bbea9fd15ee3",
      "memoryImportSkill": true,
      "listingIcon": true
    },
    {
      "harness": "codex",
      "name": "opencrawl-local-codex",
      "path": "local/codex",
      "version": "0.2.2",
      "capabilities": "capabilities.json",
      "captureAvailable": true,
      "daemonHandoff": true,
      "minimumHarnessVersion": "0.166.0",
      "archives": {
        "darwin-arm64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/local-codex-v0.2.2/opencrawl-local-codex-0.2.2-darwin-arm64.zip",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/local-codex-v0.2.2/opencrawl-local-codex-0.2.2-darwin-arm64.json",
          "sha256": "f39b8ef3acf606105e4e841ff87048ffd2a17b79e7cb143037bfc71ca12da56b",
          "metadataSha256": "5b7d7cc970a58a069cb53a89518ac1f6d1ab969b342a97621e7bf4bf0bf30506"
        },
        "darwin-x64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/local-codex-v0.2.2/opencrawl-local-codex-0.2.2-darwin-x64.zip",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/local-codex-v0.2.2/opencrawl-local-codex-0.2.2-darwin-x64.json",
          "sha256": "f87ed309a6e2a48431f43b332064666783edd327ba75cabfda12f111d6de6c1c",
          "metadataSha256": "c9a1aa0843bab4fe9748818ddf70f50d879661957cd92f9da6e42c536c2026e9"
        },
        "linux-arm64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/local-codex-v0.2.2/opencrawl-local-codex-0.2.2-linux-arm64.zip",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/local-codex-v0.2.2/opencrawl-local-codex-0.2.2-linux-arm64.json",
          "sha256": "122d70f81f9ce8cd200e61db772b7675b16d632c203c65448f32a9705068cf46",
          "metadataSha256": "6b63ad9ee84008d232ff1515a9cc17bfe880256e5af1218813249ca1946a5c81"
        },
        "linux-x64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/local-codex-v0.2.2/opencrawl-local-codex-0.2.2-linux-x64.zip",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/local-codex-v0.2.2/opencrawl-local-codex-0.2.2-linux-x64.json",
          "sha256": "0f06ea6e7fb4aab4b478f30e05e8648f5bef180819365d3c6b1dac7fa1c0c94e",
          "metadataSha256": "0546c6de14e78d388c3fac10c2a6d2167122bddc391e3d00699bf100661ff29b"
        },
        "win32-x64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/local-codex-v0.2.2/opencrawl-local-codex-0.2.2-win32-x64.zip",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/local-codex-v0.2.2/opencrawl-local-codex-0.2.2-win32-x64.json",
          "sha256": "a9a1c68908799a6e989975f5977f0ba87ec39a2ce919b5eb166d6c1dc50d0539",
          "metadataSha256": "0ad40e8d6ce555b8574ae057d486b5c95c5a9ed7e07cd7b58099a3ae54072288"
        }
      },
      "ref": "51004a8e68644af00ecf4cf56ec8bbea9fd15ee3",
      "memoryImportSkill": true,
      "listingIcon": true
    },
    {
      "harness": "cursor",
      "name": "opencrawl-local-cursor",
      "path": "local/cursor",
      "version": "0.2.2",
      "capabilities": "capabilities.json",
      "captureAvailable": true,
      "daemonHandoff": true,
      "minimumHarnessVersion": "2026.11.17-f532c45",
      "archives": {
        "darwin-arm64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/local-cursor-v0.2.2/opencrawl-local-cursor-0.2.2-darwin-arm64.zip",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/local-cursor-v0.2.2/opencrawl-local-cursor-0.2.2-darwin-arm64.json",
          "sha256": "c7ec0918cec9d2dd7ba9baba9d015245e5ab12c5425153e714b2f78732821df5",
          "metadataSha256": "af6f8ee2abf8699eebb948690e8befbd40aa5d9b6e153b0a4150525702b6a65d"
        },
        "darwin-x64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/local-cursor-v0.2.2/opencrawl-local-cursor-0.2.2-darwin-x64.zip",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/local-cursor-v0.2.2/opencrawl-local-cursor-0.2.2-darwin-x64.json",
          "sha256": "be18c1fed01447c2e3460ebcd225b878a6f973bec92375b72f31356f8cdd563a",
          "metadataSha256": "2be1cc615d38e130822fa867381f020c2efe4f295464e18ff1007d4732ef40ae"
        },
        "linux-arm64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/local-cursor-v0.2.2/opencrawl-local-cursor-0.2.2-linux-arm64.zip",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/local-cursor-v0.2.2/opencrawl-local-cursor-0.2.2-linux-arm64.json",
          "sha256": "5ea783d8d757446564f1adf052f21f927f7e6564db827643c3978216c3916f6c",
          "metadataSha256": "cecd8971e4893df8edeb8f95aa81a708fb74befecc72e97e9f7c06ff24424d8e"
        },
        "linux-x64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/local-cursor-v0.2.2/opencrawl-local-cursor-0.2.2-linux-x64.zip",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/local-cursor-v0.2.2/opencrawl-local-cursor-0.2.2-linux-x64.json",
          "sha256": "8eee1def29336087cc87130e8b3929d6b5cdfd9bd44be4e66943d5d5da3e9b45",
          "metadataSha256": "84b9575cd854c344a6587d257bd41185a07e870cd9b2a0680684814050a75714"
        },
        "win32-x64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/local-cursor-v0.2.2/opencrawl-local-cursor-0.2.2-win32-x64.zip",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/local-cursor-v0.2.2/opencrawl-local-cursor-0.2.2-win32-x64.json",
          "sha256": "a285f42cb4154efc5a47fff313a0759b9c0d0053b4b5eda2ef2309b915138abb",
          "metadataSha256": "509cf6d761343b9a9351a1d4dcde755581bc0cebd6f8c5e417a178bd9a4abdc6"
        }
      },
      "ref": "51004a8e68644af00ecf4cf56ec8bbea9fd15ee3",
      "memoryImportSkill": true,
      "listingIcon": true
    },
    {
      "harness": "antigravity",
      "name": "opencrawl-local-antigravity",
      "path": "local/antigravity",
      "version": "0.2.2",
      "capabilities": "capabilities.json",
      "captureAvailable": true,
      "daemonHandoff": true,
      "minimumHarnessVersion": "1.5.9",
      "archives": {
        "darwin-arm64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/local-antigravity-v0.2.2/opencrawl-local-antigravity-0.2.2-darwin-arm64.zip",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/local-antigravity-v0.2.2/opencrawl-local-antigravity-0.2.2-darwin-arm64.json",
          "sha256": "cd4c7655519a8177055454ccb4f7f869066e44273932df11b9a5c827859791a5",
          "metadataSha256": "7ec378f64611f3d2fa93b9a8f0a1705c478bb664e2a1e265c8111143201677d2"
        },
        "darwin-x64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/local-antigravity-v0.2.2/opencrawl-local-antigravity-0.2.2-darwin-x64.zip",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/local-antigravity-v0.2.2/opencrawl-local-antigravity-0.2.2-darwin-x64.json",
          "sha256": "b825c19558644449fdc89e0dc9eee1f07dad0bffb462a9dfda9db90e90133fbb",
          "metadataSha256": "92f669579b6740b4335823ed6c981fa1d2017dfbae6b0fec0bb5dee68b930cae"
        },
        "linux-arm64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/local-antigravity-v0.2.2/opencrawl-local-antigravity-0.2.2-linux-arm64.zip",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/local-antigravity-v0.2.2/opencrawl-local-antigravity-0.2.2-linux-arm64.json",
          "sha256": "fc992c26d1cb220037e9edca7f73db4f85dd665499dc2483057fca15dfb2ede8",
          "metadataSha256": "9d44d5818b00061b4c91b4653762c7c4169ac49f843705803152aecbd42ee0f3"
        },
        "linux-x64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/local-antigravity-v0.2.2/opencrawl-local-antigravity-0.2.2-linux-x64.zip",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/local-antigravity-v0.2.2/opencrawl-local-antigravity-0.2.2-linux-x64.json",
          "sha256": "6c12ba5658eb0919113c79898071dc4795b5770fbafe504f3cacbd38635d294f",
          "metadataSha256": "f9617277ac116e80dd08fe57bcfee271c805a91db439599f66fbe9d9381215f8"
        },
        "win32-x64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/local-antigravity-v0.2.2/opencrawl-local-antigravity-0.2.2-win32-x64.zip",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/local-antigravity-v0.2.2/opencrawl-local-antigravity-0.2.2-win32-x64.json",
          "sha256": "a47049a03bc86f2366756bd7add52ee56bbafee59dc27ccf3eabd4ac607cb3eb",
          "metadataSha256": "4657512f959ceb6946f8ec4efa89f1042dbe2a23c57d31ce832db1bb1a64d1fe"
        }
      },
      "ref": "51004a8e68644af00ecf4cf56ec8bbea9fd15ee3",
      "memoryImportSkill": true,
      "listingIcon": true
    }
  ]
};
