import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxProvider, fauxAssistantMessage, fauxText, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { AssistantEntry, Harness, MemoryStorage, createRegistry, LiveDoc } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { ForegroundSubagent, BackgroundSubagents, Subagents, validateSubagentName } from '../src/index.js';
const model = { provider: 'faux', modelId: 'faux-1' };
const text = (s: string) => fauxAssistantMessage([fauxText(s)]);
test('foreground returns child answer', async () => {
 const models = createModels(); const faux = fauxProvider(); models.setProvider(faux.provider);
 faux.setResponses([fauxAssistantMessage([fauxToolCall('subagent', {task:'Primes'})], {stopReason:'toolUse'}), text('2, 3, 5'), text('Child answered 2, 3, 5')]);
 const registry = createRegistry(); registry.install(ForegroundSubagent);
 const h = await Harness.open(new MemoryStorage(), {models, registry}, ctx);
 try { const root = await h.root(ctx, {agent:{model}}); const s = await (await root.submit({type:'input',content:'Delegate'},ctx)).wait(ctx);
 assert.equal(s.status,'done'); if(s.status !== 'done' || s.type !== 'input') throw Error('No answer');
 const e = await root.commit(tx => tx.entry(AssistantEntry,s.answer),ctx);
 assert.match(JSON.stringify(e?.model), /Child answered 2, 3, 5/);
 } finally {await h.close(ctx);}
});
test('reserved and malformed registry names rejected', () => {
 for(const n of ['__proto__','constructor','toString','hasOwnProperty','','a b','x'.repeat(65)]) assert.throws(()=>validateSubagentName(n));
 validateSubagentName('reader-1');
});
test('SQLite restart recovers pending reporter and deduplicates submission/report', async () => {
 const directory = await mkdtemp(join(tmpdir(),'durable-test-'));
 const models = createModels(); const faux = fauxProvider({tokensPerSecond:20}); models.setProvider(faux.provider);
 faux.setResponses(Array.from({length:30},()=> request => {
 const last = request.messages.findLast(m=>m.role !== 'system')!;
 const s = typeof last.content === 'string' ? last.content : JSON.stringify(last.content);
 if(last.role === 'toolResult') return text('Started.');
 if(s.includes('[subagent')) return text('Noted.');
 if(s.includes('Launch')) return fauxAssistantMessage([fauxToolCall('subagent',{action:'spawn',name:'reader',message:'Answer slowly'})],{stopReason:'toolUse'});
 return text('Recovered child answer.');
 }));
 const registry = createRegistry(); registry.install(BackgroundSubagents);
 const open = () => openNodeSqliteStorage(join(directory,'session.sqlite')).then(storage=>Harness.open(storage,{models,registry},ctx));
 let h = await open();
 try {
 let root = await h.root(ctx,{agent:{model}});
 const submission = await root.submit({type:'input',content:'Launch',requestId:'launch'},ctx);
 const deadline=Date.now()+10000;
 while(true){
 const doc=await h.snapshot(Subagents,root.id,ctx); const child=doc?.agents.reader;
 if(child && (await h.snapshot(LiveDoc,child.conversationId,ctx))?.run) break;
 if(Date.now()>deadline) throw Error('child did not start');
 await new Promise(r=>setTimeout(r,10));
 }
 await h.close(ctx); h=await open(); root=await h.root(ctx);
 const again=await root.submit({type:'input',content:'Launch',requestId:'launch'},ctx);
 assert.equal(again.id,submission.id);
 const doc=await h.snapshot(Subagents,root.id,ctx);
 for(const id of Object.values(doc!.reporters)) await h.waitForTask(id,ctx);
 await root.waitForIdle(ctx);
 const state=await h.snapshot(Subagents,root.id,ctx);
 assert.equal(Object.keys(state!.agents).length,1); assert.equal(state!.agents.reader!.reported.length,1);
 const view=await root.viewState(ctx);
 try {assert.equal(JSON.stringify(view.value.entries).split('[subagent reader answered').length-1,1);} finally {view.dispose();}
 } finally {await h.close(ctx); await rm(directory,{recursive:true,force:true});}
});
