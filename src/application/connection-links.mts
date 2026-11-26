export const integrationIdPattern = /^int_[a-f0-9]{26}$/;

export function connectionPath(workspace: string, integrationId: string) {
  return '/integrations/' + workspace + '/' + integrationId;
}
export function connectionPage(path: string) {
  const match=/^\/integrations\/([A-Za-z0-9_-]{12})\/(int_[a-f0-9]{26})$/.exec(path);
  return match ? {workspace:match[1]!, integrationId:match[2]!} : null;
}
