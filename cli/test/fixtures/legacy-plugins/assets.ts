import codexIcon from './codex/assets/icon.svg' with {type:'text'};
import cursorRule from './cursor/rules/opencrawl.mdc' with {type:'text'};
import manifest3 from './antigravity/plugin.json';
import manifest2 from './cursor/.cursor-plugin/plugin.json';
import manifest1 from './codex/.codex-plugin/plugin.json';
import manifest0 from './claude-code/.claude-plugin/plugin.json';
import asset0 from "./codex/posix/hooks/hooks.json" with {type:'text'};
import asset1 from "./codex/windows/hooks/hooks.json" with {type:'text'};
import asset2 from "./claude-code/posix/hooks/hooks.json" with {type:'text'};
import asset3 from "./claude-code/windows/hooks/hooks.json" with {type:'text'};
import asset4 from "./cursor/posix/hooks/hooks.json" with {type:'text'};
import asset5 from "./cursor/windows/hooks/hooks.json" with {type:'text'};
import asset6 from "./antigravity/posix/hooks.json" with {type:'text'};
import asset7 from "./antigravity/windows/hooks.json" with {type:'text'};
function text(value:unknown):string {if(typeof value!=='string')throw Error('Plugin asset loader must preserve source bytes');return value;}
export const hookAssets:Record<string,Record<string,string>>={
  "codex:linux":{"hooks/hooks.json":text(asset0)},
  "codex:win32":{"hooks/hooks.json":text(asset1)},
  "claude-code:linux":{"hooks/hooks.json":text(asset2)},
  "claude-code:win32":{"hooks/hooks.json":text(asset3)},
  "cursor:linux":{"hooks/hooks.json":text(asset4)},
  "cursor:win32":{"hooks/hooks.json":text(asset5)},
  "antigravity:linux":{"hooks.json":text(asset6)},
  "antigravity:win32":{"hooks.json":text(asset7)},
};
export const manifests={"claude-code":{path:".claude-plugin/plugin.json",value:manifest0},"codex":{path:".codex-plugin/plugin.json",value:manifest1},"cursor":{path:".cursor-plugin/plugin.json",value:manifest2},"antigravity":{path:"plugin.json",value:manifest3}};
export {codexIcon,cursorRule};
