import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveModel } from '../src/pi/models.js';
const parent={provider:'parent',modelId:'p'};
const config={agents:{},pools:{}};
const choose=(settings:unknown,extra:Record<string,unknown>={})=>resolveModel({agentName:'worker',parent,config,settings:()=>settings,...extra});
test('Pi qualified and bare defaults and provider fallback',()=>{
 assert.deepEqual(choose({subagents:{defaultModel:'opencode-go/deepseek-v4.1-flash',defaultProvider:'other'}})?.model,{provider:'opencode-go',modelId:'deepseek-v4.1-flash'});
 assert.deepEqual(choose({subagents:{defaultModel:'flash',defaultProvider:'go'}})?.model,{provider:'go',modelId:'flash'});
 assert.deepEqual(choose({subagents:{defaultModel:'flash'}})?.model,{provider:'parent',modelId:'flash'});
 assert.deepEqual(choose({})?.model,parent);
 assert.throws(()=>choose({subagents:{defaultModel:'flash'}},{parent:undefined}),/provider/);
});
test('precedence avoids reading defaults for explicit choices, pools and pins',()=>{
 const settings=()=>{throw Error('must not read');};
 for(const extra of [{inherit:true},{model:parent},{pool:'review',config:{agents:{},pools:{review:['go/flash']}}},{config:{agents:{worker:'go/pin'},pools:{}}},{agentModel:'go/definition'}] as Partial<Parameters<typeof resolveModel>[0]>[]) assert.ok(resolveModel({agentName:'worker',parent,config,settings,...extra}));
 assert.throws(()=>choose({}, {pool:'unknown'}),/pool/);
});
test('malformed defaults fail closed and settings are read anew',()=>{
 for(const subagents of [null,[],false,{defaultModel:''},{defaultModel:42},{defaultModel:' /bad'},{defaultModel:'go/'},{defaultProvider:42},{defaultProvider:''}]) assert.throws(()=>choose({subagents}),/subagents|provider\/model/);
 let current:unknown={subagents:{defaultModel:'go/one'}};
 const input={agentName:'worker',parent,config,settings:()=>current};
 assert.equal(resolveModel(input)?.model.modelId,'one');current={subagents:{defaultModel:'go/two'}};
 assert.equal(resolveModel(input)?.model.modelId,'two');
});
test('installed Pi merges project defaults and reloads changes for new selections',async()=>{
 const {SettingsManager}=await import('@earendil-works/pi-coding-agent');
 const {mkdtemp,mkdir,writeFile,rm}=await import('node:fs/promises');
 const {tmpdir}=await import('node:os');const {join}=await import('node:path');
 const dir=await mkdtemp(join(tmpdir(),'pi-defaults-'));
 try {
  const global=join(dir,'agent');const cwd=join(dir,'workspace');
  await mkdir(global);await mkdir(join(cwd,'.pi'),{recursive:true});
  await writeFile(join(global,'settings.json'),JSON.stringify({subagents:{defaultModel:'global/one',defaultProvider:'global'}}));
  await writeFile(join(cwd,'.pi/settings.json'),JSON.stringify({subagents:{defaultModel:'two',defaultProvider:'project'}}));
  const manager=SettingsManager.create(cwd,global);
  const input={agentName:'worker',parent,config,settings:()=>manager.getSettings()};
  assert.deepEqual(resolveModel(input)?.model,{provider:'project',modelId:'two'});
  await writeFile(join(cwd,'.pi/settings.json'),JSON.stringify({subagents:{defaultModel:'embedded/three'}}));
  await manager.reload();
  assert.deepEqual(resolveModel(input)?.model,{provider:'embedded',modelId:'three'});
 } finally {await rm(dir,{recursive:true,force:true});}
});
