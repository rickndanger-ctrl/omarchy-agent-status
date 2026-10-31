/** Read-only review regressions: real app wiring, injected SDK/hub/mic only. */
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { StartUpPageCreateResult, OsEventTypeList, type EvenAppBridge, type EvenHubEvent } from '@evenrealities/even_hub_sdk';
import { createListenApp } from '../src/main';
import type { InputReply, ListenHubPort } from '../src/hub';
const turn=()=>new Promise<void>(resolve=>setImmediate(resolve));
function fakeHub(id:string){
  const waits:{after:number;signal?:AbortSignal;resolve:(reply:InputReply)=>void}[]=[],log:string[]=[];
  const hub:ListenHubPort={start:async()=>{log.push('start');return{id,startedAt:1000};},stop:async()=>{log.push('stop');},chunk:async()=>({ok:true,lines:[]}),poll:async()=>({id,startedAt:1000,state:'listening',now_t:2000,lines:[{t:100,text:'First fixture line'},{t:900,text:'Second fixture line'}],notes:[{t:1000,at_t:100,text:'Note one'},{t:1500,at_t:900,text:'Note two'}],muse:{state:'idle'}}),waitInput:(after,signal)=>new Promise(resolve=>waits.push({after,signal,resolve}))};
  return{hub,waits,log};
}
function rig(t:TestContext){
  const a=fakeHub('fixture-a'),b=fakeHub('fixture-b');let selected=a.hub,physical=false,ons=0,offs=0,offOK=true;
  const callbacks=new Set<(event:EvenHubEvent)=>void>();const frames:{left:string;right:string}[]=[];let latest={left:'',right:''};
  const page=(value:{textObject:{content:string}[]})=>{latest={left:value.textObject[0].content,right:value.textObject[1].content};frames.push({...latest});};
  const sdk={onEvenHubEvent:(cb:(e:EvenHubEvent)=>void)=>{callbacks.add(cb);return()=>callbacks.delete(cb);},createStartUpPageContainer:async(value:{textObject:{content:string}[]})=>{page(value);return StartUpPageCreateResult.success;},rebuildPageContainer:async(value:{textObject:{content:string}[]})=>{page(value);return true;},textContainerUpgrade:async(value:{containerID:number;content:string})=>{latest={...latest,[value.containerID===1?'left':'right']:value.content};frames.push({...latest});return true;},audioControl:async()=>{throw new Error('Fixture must never invoke actual SDK microphone');}};
  const app=createListenApp({hub:()=>selected,bridge:async()=>sdk as unknown as EvenAppBridge,now:()=>3000,mic:{on:async()=>{ons++;physical=true;return true;},off:async()=>{offs++;if(offOK)physical=false;return offOK;}}});
  t.after(async()=>{offOK=true;await app.close();});
  return{app,a,b,frames,chooseB:()=>{selected=b.hub;},mic:()=>({physical,ons,offs}),offResult:(ok:boolean)=>{offOK=ok;},emit:(type:OsEventTypeList)=>{for(const cb of callbacks)cb({sysEvent:{eventType:type}} as EvenHubEvent);}};
}

test('reconnect idle binds remote to new hub and invalidates old delayed toggle',async t=>{
  const h=rig(t);assert.equal(await h.app.connect(),true);await turn();assert.equal(h.a.waits.length,1);assert.equal(h.mic().ons,0);
  h.chooseB();await h.app.connect();await turn();
  assert.equal(h.a.waits[0].signal?.aborted,true,'saving a new hub must abort the old wait');
  assert.equal(h.b.waits.length,1,'only new hub receives the replacement wait');
  h.a.waits[0].resolve({seq:1,inputs:[{seq:1,input:'select'}]});await turn();assert.equal(h.mic().ons,0,'old hub cannot opt into recording');
  h.b.waits[0].resolve({seq:1,inputs:[{seq:1,input:'select'}]});await turn();await turn();assert.equal(h.mic().ons,1);assert.deepEqual(h.a.log,[]);assert.deepEqual(h.b.log,['start']);
});

test('startup remains opt-in; background stops mic and foreground never auto-restarts',async t=>{
  const h=rig(t);await h.app.connect();assert.equal(h.mic().ons,0);await h.app.action('toggle');assert.equal(h.mic().physical,true);
  h.emit(OsEventTypeList.FOREGROUND_EXIT_EVENT);await turn();await turn();assert.equal(h.mic().physical,false);assert.equal(h.app.view().remoteWaiting,false);
  h.emit(OsEventTypeList.FOREGROUND_ENTER_EVENT);await turn();assert.equal(h.mic().ons,1);assert.equal(h.app.view().phase,'stopped');
});

test('uncertain off keeps listening warning even when hub/model is stopped',async t=>{
  const h=rig(t);await h.app.connect();await h.app.action('toggle');h.offResult(false);await h.app.action('toggle');
  assert.equal(h.app.view().micOn,true);assert.match(h.app.view().warning,/Microphone may still be on/);assert.match(h.app.view().layout.left,/Listening\?/);
});

test('close drains confirmed mic-off frame to SDK before disposing display',async t=>{
  const h=rig(t);await h.app.connect();await h.app.action('toggle');await h.app.settled();assert.ok(h.frames.some(f=>/Listening|●/.test(f.left)));
  await h.app.close();assert.equal(h.mic().physical,false);assert.match(h.frames.at(-1)!.left,/Mic off|Stopped/,'last acknowledged glasses frame must reflect confirmed off');
});
