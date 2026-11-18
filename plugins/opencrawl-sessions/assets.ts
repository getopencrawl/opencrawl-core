import memorySkill from './shared/skills/oc-import-memories/SKILL.md' with {type:'text'};
import privacyPolicy from './shared/skills/oc-incognito/agents/openai.yaml' with {type:'text'};
import privacySkill0 from './shared/skills/oc-incognito/SKILL.md' with {type:'text'};
import privacySkill1 from './shared/skills/oc-private/SKILL.md' with {type:'text'};
import privacySkill2 from './shared/skills/opencrawl-private/SKILL.md' with {type:'text'};
import privacySkill3 from './shared/skills/oc-readonly/SKILL.md' with {type:'text'};
import readme from './shared/README.md' with {type:'text'};
import cursorRule from './cursor/rules/opencrawl.mdc' with {type:'text'};
import devinGuide from './devin/AGENTS.md' with {type:'text'};
import manifest4 from './devin/.devin-plugin/plugin.json';
import manifest3 from './antigravity/plugin.json';
import manifest2 from './cursor/.cursor-plugin/plugin.json';
import manifest1 from './codex/.codex-plugin/plugin.json';
import manifest0 from './claude-code/.claude-plugin/plugin.json';
import sh from './shared/scripts/opencrawl-hook.sh' with {type:'text'};
import cmd from './shared/scripts/opencrawl-hook.cmd' with {type:'text'};
import ps1 from './shared/scripts/opencrawl-hook.ps1' with {type:'text'};
import setupSkill from './shared/skills/opencrawl-setup/SKILL.md' with {type:'text'};
import asset0 from "./codex/posix/hooks/hooks.json" with {type:'text'};
import asset1 from "./codex/windows/hooks/hooks.json" with {type:'text'};
import asset2 from "./claude-code/posix/hooks/hooks.json" with {type:'text'};
import asset3 from "./claude-code/windows/hooks/hooks.json" with {type:'text'};
import asset4 from "./cursor/posix/hooks/hooks.json" with {type:'text'};
import asset5 from "./cursor/windows/hooks/hooks.json" with {type:'text'};
import asset6 from "./antigravity/posix/hooks.json" with {type:'text'};
import asset7 from "./antigravity/windows/hooks.json" with {type:'text'};
import asset8 from "./devin/posix/hooks.json" with {type:'text'};
import asset9 from "./shared/skills/opencrawl/SKILL.md" with {type:'text'};

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
  "devin:linux":{"hooks.json":text(asset8)},
};
export const knowledgeSkill=asset9;

export const importMemorySkill=memorySkill;
export const sharedAssets={'skills/oc-import-memories/SKILL.md':memorySkill,'skills/oc-incognito/agents/openai.yaml':privacyPolicy,'skills/oc-private/agents/openai.yaml':privacyPolicy,'skills/opencrawl-private/agents/openai.yaml':privacyPolicy,'skills/oc-readonly/agents/openai.yaml':privacyPolicy,'skills/oc-incognito/SKILL.md':privacySkill0,'skills/oc-private/SKILL.md':privacySkill1,'skills/opencrawl-private/SKILL.md':privacySkill2,'skills/oc-readonly/SKILL.md':privacySkill3,'scripts/opencrawl-hook.sh':sh,'scripts/opencrawl-hook.cmd':cmd,'scripts/opencrawl-hook.ps1':ps1,'skills/opencrawl/SKILL.md':knowledgeSkill,'skills/opencrawl-setup/SKILL.md':setupSkill};

export const manifests={"claude-code":{path:".claude-plugin/plugin.json",value:manifest0},"codex":{path:".codex-plugin/plugin.json",value:manifest1},"cursor":{path:".cursor-plugin/plugin.json",value:manifest2},"antigravity":{path:"plugin.json",value:manifest3},"devin":{path:".devin-plugin/plugin.json",value:manifest4}};
export const extraAssets={readme,cursorRule,devinGuide};
