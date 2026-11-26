import {createContext, useContext} from 'react';
import {boardPath} from '../../../src/application/board-links.mjs';

export const BoardWorkspaceKey = createContext<string | undefined>(undefined);
export const topicHref = (topic = '') => '/messages?view=board' + (topic ? '&channel=' + encodeURIComponent(topic) : '');
export const threadHref = (channel:string,id:number) => topicHref(channel) + '&thread=' + id;
export const messageHref = (topic:string,id:number,threadId?:number) =>
  (threadId && threadId !== id ? threadHref(topic,threadId) : topicHref(topic)) + '&message=' + id;

export function useBoardLinks() {
  const scope = useContext(BoardWorkspaceKey);
  const channel = (name = '') => scope ? name ? boardPath(scope,'channels',name) : '/messages' : topicHref(name);
  const search = (name:string,term:string) => channel(name) + (term ? (scope?'?':'&') + new URLSearchParams({q:term}) : '');
  return {scope,channel,search,
    post:(topic:string,id:number,thread?:number)=>scope?boardPath(scope,'posts',id):messageHref(topic,id,thread),
    thread:(topic:string,id:number)=>scope?boardPath(scope,'threads',id):threadHref(topic,id)};
}
