import {renderOnboardingShell} from './onboarding-shell.mjs';

export function renderInviteOnboarding({canInvite=true}={}){
 return renderOnboardingShell(`<section aria-labelledby="invite-title">
 <h1 id="invite-title" tabindex="-1">Invite your teammates</h1>
 <p class="focus-description">Share this workspace with your team. You can also invite them later.</p>
 ${canInvite?`<div class="invite-editor">
 <ul id="invitation-list" class="invitation-list" aria-label="Invitations" hidden></ul>
 <form id="invite-form" class="invite-form" novalidate>
 <label for="invite-emails" class="sr-only">Email address</label>
 <div class="invite-entry">
 <input id="invite-emails" type="email" inputmode="email" autocomplete="off" autocapitalize="none" spellcheck="false" maxlength="254" placeholder="teammate@company.com" aria-describedby="invite-error" required>
 <button type="submit" class="primary" id="send-invites" disabled>Invite</button>
 </div>
 <p id="invite-error" class="invite-error" role="alert" hidden></p>
 </form>
 <p id="invite-feedback" class="invite-feedback" role="status" hidden></p>
 </div>
 <div id="invite-load-error" class="invite-load-error" hidden><p role="alert">We couldn’t load existing invitations.</p><button type="button" class="text-button" id="retry-invites">Try again</button></div>
`:'<p class="focus-description">Your workspace admin can invite teammates. You can continue now.</p>'}
 </section>`,{step:'invite',backUrl:'/onboarding/sources',nextUrl:'/',nextLabel:'Skip for now',nextPrimary:false,nextHidden:false});
}
