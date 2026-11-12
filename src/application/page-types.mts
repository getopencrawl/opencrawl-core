import {z} from 'zod';

export const messagePageSchema = z.object({kind:z.literal('message'),heading:z.string(),detail:z.string(),href:z.string().regex(/^\/(?!\/)/),action:z.string()});
export const callbackPageSchema = z.object({kind:z.literal('integration-callback'),ok:z.boolean(),name:z.string(),reason:z.string().optional(),returnTo:z.enum(['/sources','/onboarding/sources']),actions:z.array(z.object({label:z.string(),url:z.string()})).optional()});
export const capturePageSchema = z.object({kind:z.literal('capture'),api:z.url(),script:z.string(),revoked:z.boolean(),credential:z.object({id:z.string(),token:z.string(),expiresAt:z.string()}).nullish()});
export const authPageSchema = z.object({kind:z.literal('auth'),view:z.enum(['login','setup','join','consent','device']),error:z.string().optional(),
  email:z.string().optional(),setup:z.string().optional(),invitation:z.string().optional(),oauthQuery:z.string().optional(),next:z.string().optional(),
  clientName:z.string().optional(),resource:z.string().optional(),scopes:z.array(z.string()).optional(),code:z.string().optional()});
// This is a rendering guard, not OAuth authorization. Better Auth must first
// validate the registered redirect URI, signed consent request and PKCE grant.
export const oauthReturnUrlSchema = z.url().refine(value=>{
  const url=new URL(value);
  if(url.username||url.password||value.includes('#')||/[\u0000-\u0020\u007f]/.test(value))return false;
  return ['http:','https:'].includes(url.protocol)||url.protocol==='claude:'&&Boolean(url.hostname)&&url.pathname.startsWith('/');
});
export const oauthReturnSchema = z.object({kind:z.literal('oauth-return'),url:oauthReturnUrlSchema});
export const productPageSchema = z.discriminatedUnion('kind',[messagePageSchema,callbackPageSchema,capturePageSchema,authPageSchema,oauthReturnSchema]);
export type AuthPage = z.infer<typeof authPageSchema>;
export type ProductPage = z.infer<typeof productPageSchema>;
export type CallbackPage = z.infer<typeof callbackPageSchema>;
export type CapturePage = z.infer<typeof capturePageSchema>;
