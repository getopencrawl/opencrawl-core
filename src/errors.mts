/** Read typed error details without granting an unknown thrown value authority. */
export function errorInfo(value: unknown): {name: string; message: string; code?: string; status?: number; expose?: boolean; permanent?: boolean; type?: string} {
  const object = typeof value === 'object' && value !== null ? value as Record<string, unknown> : {};
  return {
    type: typeof object.type === 'string' ? object.type : undefined,
    name: typeof object.name === 'string' ? object.name : 'Error',
    message: typeof object.message === 'string' ? object.message : String(value),
    code: typeof object.code === 'string' ? object.code : undefined,
    status: typeof object.status === 'number' ? object.status : undefined,
    expose: object.expose === true,
    permanent: object.permanent === true,
  };
}

export function required(value: string | undefined, name: string): string {
  if (!value) throw new Error(`${name} is required`);
  return value;
}
