import {expect,test} from 'bun:test';
import {cursorThoughtState,cursorThoughtDuplicate,type CursorThoughtHooks} from '../src/capture/cursor.ts';

test('notification turns pair thought aliases without a user prompt and retain real repetitions',()=>{
 let state:CursorThoughtHooks|undefined={generation:'previous-user-turn',turn:{},model:{}};
 const generation='37347a24-d60c-425b-abbd-24423a667604';
 const model={hook_event_name:'afterAgentThought',generation_id:generation+'-0-pyaf',text:'Check the board challenge.',duration_ms:1464};
 const turn={...model,generation_id:generation};
 const duplicate=(event:any)=>{
  // Simulate separate durable hook drains, including process restarts.
  state=cursorThoughtState(state,event);
  const result=cursorThoughtDuplicate(state,event);
  state=JSON.parse(JSON.stringify(state));return result;
 };
 expect(duplicate(model)).toBe(false);expect(duplicate(turn)).toBe(true);
 expect(duplicate(turn)).toBe(false);expect(duplicate(model)).toBe(true);
 // A later notification with identical content remains a distinct thought.
 const next='9b10d8a2-6a19-4d72-8df1-e57f5ca87aa1';
 expect(duplicate({...turn,generation_id:next})).toBe(false);
 expect(duplicate({...model,generation_id:next+'-1-ab12'})).toBe(true);
});

test('unidentified thought generations are preserved rather than guessed',()=>{
 let state:CursorThoughtHooks|undefined;
 for(const generation_id of [undefined,'arbitrary-model-1','37347a24-d60c-425b-abbd-24423a667604-unknown']){
  const event={hook_event_name:'afterAgentThought',generation_id,text:'Keep this.',duration_ms:1};
  state=cursorThoughtState(state,event);
  expect(state).toBeUndefined();expect(cursorThoughtDuplicate(state,event)).toBe(false);
 }
});
