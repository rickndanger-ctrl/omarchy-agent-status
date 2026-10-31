import test from 'node:test';
import assert from 'node:assert/strict';
import { ListenHub, ListenHubError } from '../src/hub';
const reply=(x:unknown,status=200)=>new Response(JSON.stringify(x),{status});
const snapshot={id:'fixture',startedAt:1000,state:'listening',now_t:42,lines:[{t:1,text:'Fixture line'}],notes:[{t:20,at_t:1,text:'Fixture note'}],muse:{state:'idle'}};
test('new endpoints preserve /hud/ prefix, auth, binary PCM16 and cursors',async()=>{
  const calls:{url:URL;init:RequestInit}[]=[];
  const hub=new ListenHub({url:'https://hub.example/hud/',token:'fixture-token',fetch:(async(url,init)=>{const u=new URL(String(url));calls.push({url:u,init:init!});return reply(u.pathname.endsWith('start')?{id:'fixture',startedAt:1000}:u.pathname.endsWith('chunk')?{ok:true,lines:[]}:u.pathname.endsWith('stop')?{ok:true}:u.pathname.endsWith('wait')?{seq:1,inputs:[]}:snapshot);}) as typeof fetch});
  await hub.start();await hub.chunk('fixture',0,new Uint8Array([1,2]));await hub.poll('fixture',0);await hub.stop('fixture');await hub.waitInput(0);
  assert.deepEqual(calls.map(c=>c.url.pathname),['/hud/api/listen/start','/hud/api/listen/chunk','/hud/api/listen','/hud/api/listen/stop','/hud/api/input/wait']);assert.ok(calls.every(c=>new Headers(c.init.headers).get('Authorization')==='Bearer fixture-token'));
  assert.deepEqual([...new Uint8Array(calls[1].init.body as ArrayBuffer)],[1,2]);assert.equal(calls[1].url.searchParams.get('seq'),'0');assert.equal(calls[2].url.searchParams.get('since'),'0');
});
test('relay bodies never exposed and wrong-session snapshot rejected',async()=>{
  const bad=new ListenHub({url:'http://hub.example/',token:'',fetch:(async()=>new Response('PRIVATE',{status:502})) as typeof fetch});await assert.rejects(bad.start(),(e:ListenHubError)=>e.status===502&&!e.message.includes('PRIVATE'));
  const wrong=new ListenHub({url:'http://hub.example/',token:'',fetch:(async()=>reply({...snapshot,id:'other'})) as typeof fetch});await assert.rejects(wrong.poll('fixture'),/Invalid listen snapshot/);
});
test('invalid PCM16 rejected before request',async()=>{
  let calls=0;const hub=new ListenHub({url:'http://hub.example/',token:'',fetch:(async()=>{calls++;return reply({});}) as typeof fetch});await assert.rejects(hub.chunk('fixture',0,new Uint8Array(1)));await assert.rejects(hub.chunk('fixture',0,new Uint8Array(320002)));assert.equal(calls,0);
});
test('bounded deadline aborts hanging fetch; already-cancelled call does not request',async()=>{
  let signal:AbortSignal|undefined;const hub=new ListenHub({url:'http://hub.example/',token:'',timeoutMs:5,fetch:(async(_url,init)=>{signal=init?.signal as AbortSignal;return new Promise<Response>(()=>{});}) as typeof fetch});await assert.rejects(hub.start(),/timed out/);assert.equal(signal?.aborted,true);const ctl=new AbortController();ctl.abort();await assert.rejects(hub.start(ctl.signal),/cancelled/);
});
