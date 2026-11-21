export type ArchivePin={url:string;sha256:string;metadataUrl:string;metadataSha256:string};
export type PackageRelease={ref?:string;minimumHarnessVersion?:string;memoryImportSkill?:boolean;continueSkill?:boolean;listingIcon?:boolean;harness:'claude-code'|'codex'|'cursor'|'antigravity';name:string;path:string;version:string;capabilities:string;captureAvailable:boolean;daemonHandoff:boolean;files?:Record<string,{sha:string;bytes:number}>;archives?:Record<string,ArchivePin>};
export type PluginRelease={repository:string;ref:string;schemaVersion:1;bindingSchemaVersion:1;packages:PackageRelease[]};

// Both guided setup and the Replicas installer consume this verified release.
export const pluginRelease:PluginRelease = {
  "repository": "getopencrawl/opencrawl-plugins",
  "ref": "51f57f2138581f76634910321f858b640a848a11",
  "schemaVersion": 1,
  "bindingSchemaVersion": 1,
  "packages": [
    {
      "harness": "claude-code",
      "name": "opencrawl",
      "path": "plugins/claude-code",
      "version": "0.3.2",
      "capabilities": "capabilities.json",
      "captureAvailable": true,
      "daemonHandoff": true,
      "minimumHarnessVersion": "2.1.327",
      "archives": {
        "darwin-arm64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.2/opencrawl-claude-code-0.3.2-darwin-arm64.zip",
          "sha256": "7e2a9f2e85fa854b1053d0f8353b8393c3db7515a4440a77c2db9c118d859acf",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.2/opencrawl-claude-code-0.3.2-darwin-arm64.json",
          "metadataSha256": "fd3467e45256a36c757a3fdadfdfd8db198fcb5bb17d0011786e9c83c37a8c10"
        },
        "darwin-x64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.2/opencrawl-claude-code-0.3.2-darwin-x64.zip",
          "sha256": "87797d01a4743c2c0644377a8dbc669faae3dbfb5c624c403f07833fadcbb836",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.2/opencrawl-claude-code-0.3.2-darwin-x64.json",
          "metadataSha256": "03b68f4d0b96681eaa1639be7a2ddc59cc589ee58695b205023a1494a5c68504"
        },
        "linux-arm64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.2/opencrawl-claude-code-0.3.2-linux-arm64.zip",
          "sha256": "882d79a2c1b707bb8cace872151763217fc3fe232de21cff89348072ab4a795f",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.2/opencrawl-claude-code-0.3.2-linux-arm64.json",
          "metadataSha256": "3ea3be0b8e1534aad3124170f1d0a63c6f32c64d91f4c753f48567a3b310d9a9"
        },
        "linux-x64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.2/opencrawl-claude-code-0.3.2-linux-x64.zip",
          "sha256": "ebe5f865bb01a9fd7b9ae4151a44596a1a6cbba57b7fec52503b3053569eaf9f",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.2/opencrawl-claude-code-0.3.2-linux-x64.json",
          "metadataSha256": "b49c74ffa538500ba00d9f977c249601e2d02aa54b1cdd885688693f1225dbd8"
        },
        "win32-x64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.2/opencrawl-claude-code-0.3.2-win32-x64.zip",
          "sha256": "3d26cc408a73f037c5e0fb6cc1eddfd0aec1044c80d3a4b4771a93b2ed750798",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.2/opencrawl-claude-code-0.3.2-win32-x64.json",
          "metadataSha256": "c7c8e4147685d059d685e81fa924f5490774bf05eb59d2f0c5bb2be46c959de1"
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
      "version": "0.3.2",
      "capabilities": "capabilities.json",
      "captureAvailable": true,
      "daemonHandoff": true,
      "minimumHarnessVersion": "0.166.0",
      "archives": {
        "darwin-arm64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.2/opencrawl-codex-0.3.2-darwin-arm64.zip",
          "sha256": "6b97a127782b735b43d2806f81cf98a1fade57fd57c8836b36a098ab096aae91",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.2/opencrawl-codex-0.3.2-darwin-arm64.json",
          "metadataSha256": "33231f952943482aafdb8ce2a8bdff4df7aa49c922a87441df8a625e8b766e87"
        },
        "darwin-x64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.2/opencrawl-codex-0.3.2-darwin-x64.zip",
          "sha256": "cee47067bfecceae26f13a1462445a420378e8cb309af817420fc3928ae51803",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.2/opencrawl-codex-0.3.2-darwin-x64.json",
          "metadataSha256": "a57d8789dbe84377db507a52e13d9dee38354bc5707d2d272a367e0b9b846cd1"
        },
        "linux-arm64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.2/opencrawl-codex-0.3.2-linux-arm64.zip",
          "sha256": "dbf859c31e61c5492591d8b61b2caa40551cd2af30febbf44fc29dbf6056de13",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.2/opencrawl-codex-0.3.2-linux-arm64.json",
          "metadataSha256": "c272a9b9e95df5cfc8f0a2d695ca96a1ad9037285bd67fa8a056f43355a1b238"
        },
        "linux-x64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.2/opencrawl-codex-0.3.2-linux-x64.zip",
          "sha256": "6ea0d2fdec1d7969df50cf6dba4041affacf6f4bdc3869d85a44ce609c8e8f7b",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.2/opencrawl-codex-0.3.2-linux-x64.json",
          "metadataSha256": "cd7b0c8ff9287c4ae80caf9b20fd1a0a27257a27112f7061ecba84d3affce894"
        },
        "win32-x64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.2/opencrawl-codex-0.3.2-win32-x64.zip",
          "sha256": "f753198afc390a89ccf8f2c359739d6de284150059eb051514e03bba439252b5",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.2/opencrawl-codex-0.3.2-win32-x64.json",
          "metadataSha256": "07925df68d40b4127295126c2cd1845113613160fba7f23852f6a44ef8b55fcd"
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
      "version": "0.3.2",
      "capabilities": "capabilities.json",
      "captureAvailable": true,
      "daemonHandoff": true,
      "minimumHarnessVersion": "2026.11.17-f532c45",
      "archives": {
        "darwin-arm64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.2/opencrawl-cursor-0.3.2-darwin-arm64.zip",
          "sha256": "c54c8be60caf1aa04a22981e29253ef78dce51df169ecfcefbe702439844829b",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.2/opencrawl-cursor-0.3.2-darwin-arm64.json",
          "metadataSha256": "1478571ff836c17081354fd4460e1ae8ea41979075296e904169619f6fe15afd"
        },
        "darwin-x64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.2/opencrawl-cursor-0.3.2-darwin-x64.zip",
          "sha256": "d2acbf7ba845f34745fd42a079d4c5d341bd1fd3776913ed6e456791b8ef4f37",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.2/opencrawl-cursor-0.3.2-darwin-x64.json",
          "metadataSha256": "eb85021d62a3a9d82bfc13627250deaeaa8937f8f8b8d02e65393f0516fa78c5"
        },
        "linux-arm64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.2/opencrawl-cursor-0.3.2-linux-arm64.zip",
          "sha256": "33170144a9efca863cd6fc01604c357f13608c2d89e88c0f7d1016fad48ba5d0",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.2/opencrawl-cursor-0.3.2-linux-arm64.json",
          "metadataSha256": "72907c27780b3376697e661e864803b745f87f607040d5798c7c7f51284d2752"
        },
        "linux-x64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.2/opencrawl-cursor-0.3.2-linux-x64.zip",
          "sha256": "f94e9d1bafa5acb9374f1d485495f268d2a8ef66701523f4f587e523c54694ed",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.2/opencrawl-cursor-0.3.2-linux-x64.json",
          "metadataSha256": "5f769e127b14762a17d0bd7a170ba16cec92f5057ad7a2623cbb3a1b4fa2b734"
        },
        "win32-x64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.2/opencrawl-cursor-0.3.2-win32-x64.zip",
          "sha256": "4ddec6c8a60558232df005d54db2f66a2dff6159ff39013949ccfba6c84a9ca8",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.2/opencrawl-cursor-0.3.2-win32-x64.json",
          "metadataSha256": "99f8d644f54b6391b8827a8cd2fb2f4a360529b3fdf243e2cedc8e6f1cd2109f"
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
      "version": "0.3.2",
      "capabilities": "capabilities.json",
      "captureAvailable": true,
      "daemonHandoff": true,
      "minimumHarnessVersion": "1.5.9",
      "archives": {
        "darwin-arm64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.2/opencrawl-antigravity-0.3.2-darwin-arm64.zip",
          "sha256": "f30c9213dd1e97e8704536fec6f66339703b31185f6a6043da40864c253afb24",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.2/opencrawl-antigravity-0.3.2-darwin-arm64.json",
          "metadataSha256": "208b9fb8250d132a4b7f2eb52d440718b232d5326b847cf2943e5f66df2e632b"
        },
        "darwin-x64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.2/opencrawl-antigravity-0.3.2-darwin-x64.zip",
          "sha256": "ca8df2082d0f8121e48a970c256298780b45a97beeaea59885f49e85651186bb",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.2/opencrawl-antigravity-0.3.2-darwin-x64.json",
          "metadataSha256": "c2d6494a3e8bfcca6d3874811a432af9682f2dbae7cafbf58ac943ee4bfb0f9b"
        },
        "linux-arm64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.2/opencrawl-antigravity-0.3.2-linux-arm64.zip",
          "sha256": "3f60ca2ca431932b292e10bc0bcdb89649f0cdc66ca4709470014d47ea5f77f3",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.2/opencrawl-antigravity-0.3.2-linux-arm64.json",
          "metadataSha256": "81aac10ec1625354ad8d5813a9342694444a2c921e6aa27ed2d978a11c145f3e"
        },
        "linux-x64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.2/opencrawl-antigravity-0.3.2-linux-x64.zip",
          "sha256": "c95bfe203c2b19b4d4cd4b1941ad2d8f0d6757c0de25f42fb7e8f8af40c6ff87",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.2/opencrawl-antigravity-0.3.2-linux-x64.json",
          "metadataSha256": "a09052b56201bdf098fcdc9deaa389f175c37dd21d1a44442d7293f1daf7cfe9"
        },
        "win32-x64": {
          "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.2/opencrawl-antigravity-0.3.2-win32-x64.zip",
          "sha256": "4085602c2887cdc365f903f26ce0d66517c0c3bf2a58391b5a06fcf18764944b",
          "metadataUrl": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.2/opencrawl-antigravity-0.3.2-win32-x64.json",
          "metadataSha256": "b2c2787d922641a462117535af763bfca2597e07239d166f5d3d884deed61bcd"
        }
      },
      "memoryImportSkill": true,
      "listingIcon": true,
      "continueSkill": true
    }
  ]
};

export const replicasPolicy = {
  "url": "https://github.com/getopencrawl/opencrawl-plugins/releases/download/v0.3.2/replicas-codex-policy.mjs",
  "sha256": "f360fdc73d91b506e369a325219719fc33fb3a96951b807f2f2ad7bda272bcc5"
};
