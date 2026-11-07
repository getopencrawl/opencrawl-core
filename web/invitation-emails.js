/** Shared form/API validation; invitation delivery belongs to the runtime adapter. */
export function parseInvitationEmails(value){
 if(typeof value!=='string'||value.length>3000)return {emails:[],error:'Enter up to 10 email addresses.'};
 const emails=[...new Set(value.split(/[,;\r\n]+/).map(email=>email.trim().toLowerCase()).filter(Boolean))];
 if(!emails.length)return {emails:[],error:'Enter at least one email address.'};
 if(emails.length>10)return {emails:[],error:'Invite up to 10 teammates at a time.'};
 const invalid=emails.find(email=>email.length>254||!/^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(email));
 if(invalid)return {emails:[],error:`Check this email address: ${invalid}`};
 return {emails,error:null};
}
