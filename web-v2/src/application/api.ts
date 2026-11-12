import type {Bootstrap, SourceCard, TeamReport, WorkspaceRole} from '../../../src/application/types.mjs';
import type {ConsoleDataAdapter} from '../pages/types.ts';
import type {LibraryAdapter} from '../pages/library-types.ts';
import type {OnboardingAdapter, OnboardingStatus} from '../onboarding/types.ts';
export type {Bootstrap, SourceCard, TeamReport, WorkspaceRole} from '../../../src/application/types.mjs';

export interface SourcesAdapter {
  sources(signal?: AbortSignal): Promise<{items: SourceCard[]}>;
  connect(provider: string, apiKey?: string, signal?: AbortSignal): Promise<{ok?: boolean; redirectUrl?: string}>;
  retry(provider: string, signal?: AbortSignal): Promise<{ok: true}>;
  disconnect(provider: string, signal?: AbortSignal): Promise<{ok: true}>;
  /** Admin only: store an operator credential named by a source's setup. */
  saveCredential?(credential: string, value: string, signal?: AbortSignal): Promise<{ok: true}>;
}
export interface TeamAdapter {
  team(signal?: AbortSignal): Promise<TeamReport>;
  invite(email: string, signal?: AbortSignal): Promise<{ok: true; inviteUrl?: string}>;
  changeRole(userId: string, role: WorkspaceRole, signal?: AbortSignal): Promise<{ok: true; userId: string; role: WorkspaceRole}>;
  removeMember(userId: string, signal?: AbortSignal): Promise<{ok: true; userId: string}>;
  renameOrganization(name: string, signal?: AbortSignal): Promise<{ok: true; name: string}>;
}
/** The application depends on product operations; runtimes supply authorized transports. */
export interface ProductApi<B extends Bootstrap = Bootstrap> extends SourcesAdapter, TeamAdapter, ConsoleDataAdapter {
  bootstrap(signal?: AbortSignal): Promise<B>;
  library: LibraryAdapter;
  onboardingStatus(signal?: AbortSignal): Promise<{data: OnboardingStatus}>;
  onboardingSources: OnboardingAdapter['sources'];
  onboardingInvitations: OnboardingAdapter['invitations'];
  onboardingInvite: OnboardingAdapter['invite'];
  finishOnboarding: OnboardingAdapter['finish'];
}
