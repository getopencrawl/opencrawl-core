import {createHash} from 'node:crypto';

const skill='(?:oc-incognito|oc-private|opencrawl-private|oc-readonly)';
const namespace='(?:opencrawl(?:-[a-f0-9]{12})?:)?';
const skillLink=new RegExp('^\\[\\$'+namespace+skill+'\\]\\([^\\r\\n)]*/SKILL\\.md\\)(?=\\s|$)');
const invoke=new RegExp('^(?:(?:please )?(?:use|activate|enable) )?[/$]'+namespace+skill+'(?=\\s|$)');
const selectedSkill=new RegExp('^'+namespace+skill+'$');

function matchesDeployment(invocation: string, api?: string) {
  const qualification = /opencrawl-([a-f0-9]{12}):/.exec(invocation);
  return !qualification || Boolean(api && createHash('sha256').update(api).digest('hex').slice(0, 12) === qualification[1]);
}

export function privateSkill(name: string, api?: string) {
  return selectedSkill.test(name) && matchesDeployment(name, api);
}

export function privatePrompt(text: string, api?: string) {
  const prompt = text.trimStart();
  const match = invoke.exec(prompt) ?? skillLink.exec(prompt);
  return Boolean(match && matchesDeployment(match[0], api));
}
