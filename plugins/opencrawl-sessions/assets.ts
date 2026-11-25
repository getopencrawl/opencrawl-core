import shareSkill from './shared/skills/oc-share/SKILL.md' with {type:'text'};
import continueSkill from './shared/skills/oc-continue/SKILL.md' with {type:'text'};
import memorySkill from './shared/skills/oc-import-memories/SKILL.md' with {type:'text'};
import privacyPolicy from './shared/skills/oc-incognito/agents/openai.yaml' with {type:'text'};
import privacySkill0 from './shared/skills/oc-incognito/SKILL.md' with {type:'text'};
import privacySkill1 from './shared/skills/oc-private/SKILL.md' with {type:'text'};
import privacySkill2 from './shared/skills/opencrawl-private/SKILL.md' with {type:'text'};
import privacySkill3 from './shared/skills/oc-readonly/SKILL.md' with {type:'text'};
import readme from './shared/README.md' with {type:'text'};
import devinGuide from './devin/AGENTS.md' with {type:'text'};
import manifest4 from './devin/.devin-plugin/plugin.json';
import sh from './shared/scripts/opencrawl-hook.sh' with {type:'text'};
import cmd from './shared/scripts/opencrawl-hook.cmd' with {type:'text'};
import ps1 from './shared/scripts/opencrawl-hook.ps1' with {type:'text'};
import setupSkill from './shared/skills/opencrawl-setup/SKILL.md' with {type:'text'};
import asset8 from "./devin/posix/hooks.json" with {type:'text'};
import asset9 from "./shared/skills/opencrawl/SKILL.md" with {type:'text'};

function text(value:unknown):string {if(typeof value!=='string')throw Error('Plugin asset loader must preserve source bytes');return value;}
export const hookAssets:Record<string,Record<string,string>>={
  "devin:linux":{"hooks.json":text(asset8)},
};
export const knowledgeSkill=asset9;

export const companionSkills = {'oc-import-memories': memorySkill, 'oc-continue': continueSkill, 'oc-share': shareSkill};
export const sharedAssets={'skills/oc-share/SKILL.md':shareSkill,'skills/oc-continue/SKILL.md':continueSkill,'skills/oc-import-memories/SKILL.md':memorySkill,'skills/oc-incognito/agents/openai.yaml':privacyPolicy,'skills/oc-private/agents/openai.yaml':privacyPolicy,'skills/opencrawl-private/agents/openai.yaml':privacyPolicy,'skills/oc-readonly/agents/openai.yaml':privacyPolicy,'skills/oc-incognito/SKILL.md':privacySkill0,'skills/oc-private/SKILL.md':privacySkill1,'skills/opencrawl-private/SKILL.md':privacySkill2,'skills/oc-readonly/SKILL.md':privacySkill3,'scripts/opencrawl-hook.sh':sh,'scripts/opencrawl-hook.cmd':cmd,'scripts/opencrawl-hook.ps1':ps1,'skills/opencrawl/SKILL.md':knowledgeSkill,'skills/opencrawl-setup/SKILL.md':setupSkill};

export const devinManifest={path:".devin-plugin/plugin.json",value:manifest4};
export {readme, devinGuide};
