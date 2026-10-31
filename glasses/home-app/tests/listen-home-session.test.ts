import test from 'node:test';
import assert from 'node:assert/strict';
import { ListenSession, CHUNK_BYTES, MAX_QUEUED_CHUNKS, MIC_WARNING } from '../src/listen/session';
import type { ListenHubPort } from '../src/listen/hub';
import type { ListenSnapshot, Session } from '../src/listen/model';
const turn = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred<T>() { let resolve!: (x:T)=>void; let reject!: (x:unknown)=>void; const promise = new Promise<T>((a,b)=>{resolve=a;reject=b;}); return {promise,resolve,reject}; }
function rig(timeoutMs=100) {
  const log:string[]=[], snapshots:ListenSnapshot[]=[], chunks:{seq:number;pcm:Uint8Array}[]=[];
  const hub:ListenHubPort={start:async()=>({id:'fixture',startedAt:1000}),chunk:async(_id,seq,pcm)=>{chunks.push({seq,pcm});return {ok:true,lines:[]};},stop:async id=>{log.push('stop:'+id);},poll:async id=>({id,startedAt:1000,state:'listening',now_t:1000,lines:[],notes:[],muse:{state:'idle'}}),waitInput:async()=>({seq:0,inputs:[]})};
  const mic={on:async()=>{log.push('on');return true;},off:async()=>{log.push('off');return true;}};
  let chosen=hub;
  const session=new ListenSession({hub:()=>chosen,mic,publish:s=>snapshots.push(s),changed:()=>{},now:()=>2000,timeoutMs,diag:s=>log.push(s)});
  return {session,hub,mic,log,snapshots,chunks,choose:(h:ListenHubPort)=>{chosen=h;}};
}
test('explicit start uses server clock; stop publishes stopped with confirmed mic off',async()=>{
  const h=rig(); assert.equal(h.session.view().phase,'idle');assert.deepEqual(h.log,[]);
  await h.session.start();assert.equal(h.session.view().startedAt,1000);assert.equal(h.session.view().micOn,true);
  await h.session.stop();assert.equal(h.session.view().micOn,false);assert.equal(h.session.view().phase,'stopped');assert.equal(h.snapshots.at(-1)?.state,'stopped');
});
test('PCM16 chunks ordered, SDK buffer copied, final tail flushed',async()=>{
  const h=rig();await h.session.start();const pcm=new Uint8Array(CHUNK_BYTES+4).fill(7);h.session.onAudio(pcm);pcm.fill(99);await h.session.stop();
  assert.deepEqual(h.chunks.map(c=>[c.seq,c.pcm.length]),[[0,CHUNK_BYTES],[1,4]]);assert.ok(h.chunks.every(c=>c.pcm[0]===7));
});
test('cancel pending start never enables mic and closes late session',async()=>{
  const h=rig();const pending=deferred<Session>();h.hub.start=()=>pending.promise;
  const start=h.session.start(),stop=h.session.stop();await turn();assert.ok(h.log.includes('off'));assert.ok(!h.log.includes('on'));
  pending.resolve({id:'late',startedAt:1000});await Promise.all([start,stop]);assert.ok(h.log.includes('stop:late'));assert.ok(!h.log.includes('on'));assert.equal(h.session.view().micOn,false);
});
test('timed-out hub start is cleaned up if it later returns',async()=>{
  const h=rig(5);const pending=deferred<Session>();h.hub.start=()=>pending.promise;await h.session.start();assert.equal(h.session.view().phase,'error');
  pending.resolve({id:'late',startedAt:1000});await turn();assert.ok(h.log.includes('stop:late'));assert.ok(!h.log.includes('on'));await h.session.close();
});
test('late mic start keeps warning until compensating off; restart blocked meanwhile',async()=>{
  const h=rig(5);const pending=deferred<boolean>();let physical=false;
  h.mic.on=async()=>{h.log.push('on');physical=await pending.promise;return physical;};h.mic.off=async()=>{physical=false;return true;};
  await h.session.start();assert.equal(h.session.view().micOn,true);assert.equal(h.session.view().warning,MIC_WARNING);
  await h.session.start();assert.equal(h.log.filter(x=>x==='on').length,1);pending.resolve(true);await turn();await turn();assert.equal(physical,false);assert.equal(h.session.view().micOn,false);await h.session.close();
});
test('off refusal remains visible and recoverable by Stop',async()=>{
  const h=rig();await h.session.start();h.mic.off=async()=>false;await h.session.stop();assert.equal(h.session.view().micOn,true);assert.equal(h.session.view().warning,MIC_WARNING);
  await h.session.start();assert.equal(h.log.filter(x=>x==='on').length,1);h.mic.off=async()=>true;await h.session.stop();assert.equal(h.session.view().micOn,false);
});
test('invalid hub factory and rejected mic start recover rather than stick starting',async()=>{
  const h=rig();const bad=new ListenSession({hub:()=>{throw new Error('PRIVATE');},mic:h.mic,publish:()=>{},changed:()=>{}});await bad.start();assert.equal(bad.view().phase,'error');assert.ok(!bad.view().error.includes('PRIVATE'));
  h.mic.on=async()=>{throw new Error('PRIVATE');};await h.session.start();assert.equal(h.session.view().phase,'error');assert.equal(h.session.view().micOn,false);
});
test('changing hub selection does not redirect an existing session',async()=>{
  const h=rig();await h.session.start();let other=0;h.choose({...h.hub,poll:async()=>{other++;throw new Error();},stop:async()=>{other++;}});await h.session.poll();await h.session.stop();assert.equal(other,0);assert.ok(h.log.includes('stop:fixture'));
});
test('audio failures and overflow visible; no upload retries and bounded queue',async()=>{
  const h=rig();await h.session.start();const pending=deferred<{ok:boolean;lines:[]}>();let calls=0;h.hub.chunk=async()=>{calls++;return pending.promise;};
  for(let i=0;i<MAX_QUEUED_CHUNKS+3;i++)h.session.onAudio(new Uint8Array(CHUNK_BYTES));assert.ok(h.session.view().droppedChunks>=2);
  pending.reject(new Error('PRIVATE'));await turn();assert.equal(calls,MAX_QUEUED_CHUNKS+1);assert.ok(h.session.view().error.includes('audio'));assert.ok(!h.session.view().error.includes('PRIVATE'));await h.session.close();
});
test('wrong session poll ignored; late poll after close cannot repaint or restart',async()=>{
  const h=rig();await h.session.start();let before=h.snapshots.length;h.hub.poll=async()=>({id:'wrong',startedAt:1000,state:'listening',now_t:1,lines:[],notes:[],muse:{state:'idle'}});await h.session.poll();assert.equal(h.snapshots.length,before);
  const pending=deferred<ListenSnapshot>();h.hub.poll=()=>pending.promise;const p=h.session.poll();await h.session.close();before=h.snapshots.length;pending.resolve({id:'fixture',startedAt:1000,state:'listening',now_t:2,lines:[],notes:[],muse:{state:'idle'}});await p;assert.equal(h.snapshots.length,before);await h.session.start();assert.equal(h.log.filter(x=>x==='on').length,1);
});
test('concurrent poll coalesces; stopped hub cleans mic up',async()=>{
  const h=rig();await h.session.start();let calls=0;const pending=deferred<ListenSnapshot>();h.hub.poll=async()=>{calls++;return pending.promise;};const a=h.session.poll(),b=h.session.poll();assert.equal(calls,1);
  pending.resolve({id:'fixture',startedAt:1000,state:'stopped',now_t:10,lines:[],notes:[],muse:{state:'idle'}});await Promise.all([a,b]);assert.equal(h.session.view().micOn,false);assert.equal(h.session.view().phase,'stopped');
});
