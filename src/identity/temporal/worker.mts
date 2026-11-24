import {bundleWorkflowCode} from '@temporalio/worker';
import {fileURLToPath} from 'node:url';
import {writeFile} from 'node:fs/promises';
export async function buildTeamWorkflows(path:string) {
  const {code}=await bundleWorkflowCode({workflowsPath:fileURLToPath(new URL('./workflows.cjs',import.meta.url))});
  await writeFile(path,code);
}
