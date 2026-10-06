import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BACKGROUND_CONTEXT as C } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai';
import { fauxProvider,fauxAssistantMessage,fauxText } from '@earendil-works/pi-ai/providers/faux';
import { Harness,createRegistry } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { JobRuntime,admit,status,wait,cancel } from '../src/pi/jobs.js';
import { bridgeModels,databaseDirectory } from '../src/pi/adapter.js';
test('Pi bridge preserves durable session identity and uses configured registry',()=>{
 const base=createModels();const faux=fauxProvider();base.setProvider(faux.provider);
 let received:unknown; const models=bridgeModels({find:(p,id)=>base.getModel(p,id),getAll:()=>[...base.getModels()],streamSimple:(m,c,o)=>{received=o;return base.streamSimple(m,c,o);}});
 const model=models.getModel('faux','faux-1')!;
 models.streamSimple(model,{messages:[]},{sessionId:'child-id'});
 assert.equal((received as {sessionId:string}).sessionId,'child-id');
 assert.equal((received as {deferred:boolean}).deferred,false);
 assert.notEqual(databaseDirectory('/tmp/store','s','/a'),databaseDirectory('/tmp/store','s','/b'));
});
test('SQLite jobs recover without parent reports; wait cancellation leaves work; followup retains child',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'pi-adapter-'));const models=createModels();const faux=fauxProvider({tokensPerSecond:20});models.setProvider(faux.provider);
 faux.setResponses(Array.from({length:30},()=>fauxAssistantMessage([fauxText('A retained answer.')])));
 const registry=createRegistry();registry.install(JobRuntime);
 const open=async()=>Harness.open(await openNodeSqliteStorage(join(dir,'session.sqlite')),{models,registry},C);
 let h=await open();
 try {
  const root=await h.root(C);const first=await admit(h,'run1','task',{model:{provider:'faux',modelId:'faux-1'},tools:[],extensions:[]});
  assert.equal((await wait(h,'run1',0)).status,'running');
  const controller=new AbortController();controller.abort();assert.equal((await wait(h,'run1',10,controller.signal)).status,'running');
  await root.abort(C);assert.equal((await status(h,'run1')).status,'running');
  await h.close(C);h=await open();h.resume();
  assert.equal((await wait(h,'run1',10)).status,'succeeded');
  const duplicate=await admit(h,'run1','task',{model:{provider:'faux',modelId:'faux-1'}});assert.equal(duplicate.conversationId,first.conversationId);
  const next=await admit(h,'run2','next',undefined,'run1');assert.equal(next.conversationId,first.conversationId);
  assert.equal((await wait(h,'run2',10)).status,'succeeded');
  await admit(h,'run3','cancel',{model:{provider:'faux',modelId:'faux-1'},tools:[],extensions:[]});
  assert.equal((await cancel(h,'run3')).status,'cancelled');
  const view=await (await h.root(C)).viewState(C);try{assert.equal(view.value.entries.length,0);}finally{view.dispose();}
 } finally {await h.close(C);await rm(dir,{recursive:true,force:true});}
});
test('installed Pi SDK loads actual TypeScript extension without registration errors',async()=>{
 const {DefaultResourceLoader,SettingsManager,getAgentDir}=await import('@earendil-works/pi-coding-agent');
 const loader=new DefaultResourceLoader({cwd:process.cwd(),agentDir:getAgentDir(),settingsManager:SettingsManager.inMemory(),noExtensions:true,additionalExtensionPaths:[join(process.cwd(),'index.ts')],noSkills:true,noPromptTemplates:true,noThemes:true});
 await loader.reload();const result=loader.getExtensions();assert.deepEqual(result.errors,[]);assert.equal(result.extensions.length,1);
});
