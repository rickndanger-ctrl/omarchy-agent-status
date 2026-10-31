import test from 'node:test';
import assert from 'node:assert/strict';
import { InputMapper, RemoteInput, touchInput, type ListenAction } from '../src/input';
import type { ListenHubPort, InputReply } from '../src/hub';
const turn=()=>new Promise<void>(r=>setImmediate(r));
test('phone/touch map identically; separated downs navigate, double-down newest',()=>{
  let now=1000;const actions:ListenAction[]=[];const mapper=new InputMapper(a=>actions.push(a),()=>now);mapper.press('select');mapper.touch('SCROLL_TOP_EVENT');mapper.press('down');now+=500;mapper.press('down');assert.deepEqual(actions,['toggle','previous','next','next']);now+=200;mapper.press('down');assert.equal(actions.at(-1),'newest');mapper.touch('DOUBLE_CLICK_EVENT');assert.equal(actions.at(-1),'newest');assert.equal(touchInput('AUDIO_EVENT'),null);mapper.touch('AUDIO_EVENT');assert.equal(actions.length,6);
});
function rig(script:InputReply[]){const calls:{after:number;signal?:AbortSignal}[]=[],applied:[string,number][]=[];const hub={waitInput:async(after:number,signal?:AbortSignal)=>{calls.push({after,signal});const next=script.shift();if(next)return next;return new Promise<InputReply>((_,reject)=>signal?.addEventListener('abort',()=>reject(new Error('aborted')),{once:true}));}} as ListenHubPort;const remote=new RemoteInput({hub:()=>hub,active:()=>true,apply:(i,s)=>applied.push([i,s])});return{calls,applied,remote};}
test('single wait dedups and ignores unknown inputs; stop aborts, restart from now',async()=>{
  const h=rig([{seq:2,inputs:[{seq:1,input:'down'},{seq:2,input:'select'},{seq:2,input:'select'}]},{seq:3,inputs:[{seq:3,input:'settings'}]}]);h.remote.start();h.remote.start();await turn();assert.deepEqual(h.applied,[['down',1],['select',2]]);assert.deepEqual(h.calls.map(c=>c.after),[0,2,3]);h.remote.stop();assert.equal(h.calls.at(-1)?.signal?.aborted,true);h.remote.start();await turn();assert.equal(h.calls.at(-1)?.after,0);h.remote.close();
});
test('same hub restart lowers seq; fresh lower inputs accepted once',async()=>{
  const h=rig([{seq:10,inputs:[{seq:10,input:'up'}]},{seq:1,inputs:[{seq:1,input:'down'}]},{seq:1,inputs:[{seq:1,input:'down'}]}]);h.remote.start();await turn();assert.deepEqual(h.applied,[['up',10],['down',1]]);h.remote.stop();
});
test('late wait response after close cannot apply a toggle',async()=>{
  let resolve!:(r:InputReply)=>void;let applied=0;const remote=new RemoteInput({hub:()=>({waitInput:()=>new Promise<InputReply>(r=>{resolve=r;})}) as unknown as ListenHubPort,active:()=>true,apply:()=>applied++});remote.start();remote.stop();resolve({seq:1,inputs:[{seq:1,input:'select'}]});await turn();assert.equal(applied,0);
});
