import { createHash } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { BACKGROUND_CONTEXT as C } from '@earendil-works/chord/context';
import { createModels, Type, type Models } from '@earendil-works/pi-ai';
import { getAgentDir, type ExtensionAPI, type ExtensionToolContext, type ModelRegistry } from '@earendil-works/pi-coding-agent';
import { Harness, createRegistry, defineExtension, defineTool, type ToolRegistration } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { loadAgents, selectTools } from './agents.js';
import { resolveAgentDirectories } from './definition-config.js';
import { loadModelConfig, resolveModel } from './models.js';
import { parseModelRef } from './request.js';
import { Jobs, JobRuntime, admit, status, wait, cancel } from './jobs.js';
export function bridgeModels(registry:Pick<ModelRegistry,'find'|'getAll'|'streamSimple'>):Models {
 const models=createModels();
 models.getModel=(provider,id)=>registry.find(provider,id);
 models.getModels=provider=>registry.getAll().filter(m=>!provider||m.provider===provider);
 // Retain durable's per-conversation provider identity, not the parent Pi identity.
 models.streamSimple=(model,context,options)=>registry.streamSimple(model,context,{...options,deferred:false});
 models.completeSimple=(model,context,options)=>models.streamSimple(model,context,options).result();
 return models;
}
export function databaseDirectory(base:string,sessionId:string,cwd:string){
 return join(resolve(base),createHash('sha256').update(JSON.stringify([sessionId,resolve(cwd)])).digest('hex'));
}
export default function adapter(pi:ExtensionAPI){
 const configPath=process.env.PI_SUBAGENT_CONFIG??join(getAgentDir(),'durable-subagents.json');
 const storageBase=process.env.PI_DURABLE_SUBAGENT_STORAGE??join(getAgentDir(),'sessions','pi-durable-subagent');
 let hostTools:ToolRegistration[]=[]; let hostExtension=defineExtension({name:'cli.host-tools'});
 let opened:Promise<Harness>|undefined; let key:string|undefined; let close:()=>Promise<void>=async()=>{};
 async function get(ctx:ExtensionToolContext){
  const directory=databaseDirectory(storageBase,ctx.sessionManager.getSessionId(),ctx.cwd);
  if(key && key!==directory) {await close();opened=undefined;key=undefined;}
  if(!opened){
   key=directory;
   opened=(async()=>{
    await mkdir(directory,{recursive:true,mode:0o700});
    const lock=join(directory,'owner.lock');
    try {await mkdir(lock);} catch {throw Error(`Database already owned or stale lock: ${lock}. Do not remove while any owning Pi process is alive.`);}
    try {
     await writeFile(join(lock,'pid'),String(process.pid));
     const registry=createRegistry(); registry.install(JobRuntime);
     const tools:ToolRegistration[]=ctx.tools.filter(t=>!['subagent','codemode','tool_search'].includes(t.name)&&!t.name.startsWith('subagent_')).map(source=>defineTool({
      name:source.name,description:source.description,parameters:source.parameters,replay:'unsafe',executionMode:'sequential',
      execute:async(args,_api,callContext)=>{
       const result=await ctx.executeTool(source.name,args,{signal:callContext.abortSignal});
       return {content:result.result.content,isError:result.isError};
      },
     }));
     hostTools=tools;hostExtension=defineExtension({name:'cli.host-tools',tools});registry.install(hostExtension);
     const h=await Harness.open(await openNodeSqliteStorage(join(directory,'session.sqlite')),{models:bridgeModels(ctx.modelRegistry),registry},C);
     close=async()=>{await h.close(C);await rm(lock,{recursive:true,force:true});};
     const root=await h.root(C);
     const persisted=await h.snapshot(Jobs,root.id,C);
     const missing=[...new Set(Object.values(persisted?.jobs??{}).filter(j=>j.status==='running').flatMap(j=>j.requiredTools).filter(name=>!tools.some(t=>t.name===name)))];
     if(missing.length){await h.close(C);throw Error(`Recovery blocked: required host tools unavailable: ${missing.join(', ')}`);}
     // No scheduler on open: only an explicit tool operation resumes persisted work.
     return h;
    } catch(e){await rm(lock,{recursive:true,force:true});throw e;}
   })();
   opened.catch(()=>{opened=undefined;key=undefined;});
  }
  return opened;
 }
 pi.on('session_shutdown',async()=>{if(opened){await opened;await close();opened=undefined;key=undefined;}});
 const handle={run:Type.String({minLength:1,maxLength:200})};
 const reply=(run:string,job:Awaited<ReturnType<typeof status>>)=>({content:[{type:'text' as const,text:`Run ${run} · ${job.status}\n${job.output.slice(0,30000)}${job.output.length>30000?'\n[Truncated; full output is stored in SQLite.]':''}`}],details:{run,...job},isError:job.status==='failed'});
 pi.registerTool({name:'subagent',label:'Durable subagent',exposure:'model-only',description:'Delegate one task to a named agent using Pi credentials and persistent SQLite. Default returns a background handle; nonblocking:false waits up to 60s, never cancels on wait timeout. No automatic reports. Use status/wait. No batches, worktrees, nesting, or old-run migration.',parameters:Type.Object({agent:Type.String(),task:Type.String({minLength:1}),model:Type.Optional(Type.String()),role:Type.Optional(Type.String()),nonblocking:Type.Optional(Type.Boolean()),timeoutMinutes:Type.Optional(Type.Null({description:'Only null supported: explicitly waive definition execution deadline.'}))},{additionalProperties:false}),
  async execute(id,args,signal,_update,ctx){
   const dirs=await resolveAgentDirectories({configPath,defaultDirectory:join(getAgentDir(),'agents'),envValue:process.env.PI_SUBAGENT_AGENTS});
   const loaded=await loadAgents(dirs.directories); const agent=loaded.agents.find(a=>a.name===args.agent);
   if(!agent) throw Error(`Unknown agent ${args.agent}. ${[...dirs.errors,...loaded.errors.map(e=>e.message)].join('; ')}`);
   if(agent.timeoutMinutes!==undefined&&args.timeoutMinutes!==null) throw Error('Definition timeoutMinutes is unsupported; refusing to silently ignore its execution limit');
   const {config,errors}=await loadModelConfig(configPath); if(errors.length) throw Error(errors.join('; '));
   const pool=args.role??(args.model?.startsWith('task:')?args.model.slice(5):undefined);
   const chosen=resolveModel({agentName:agent.name,agentModel:agent.model,parent:ctx.model?{provider:ctx.model.provider,modelId:ctx.model.id}:undefined,inherit:args.model==='inherit-parent',model:args.model&&!args.model.startsWith('task:')&&args.model!=='inherit-parent'?parseModelRef(args.model):undefined,pool,config,settings:()=>pi.getSettings()});
   if(!chosen || (pool&&!chosen.poolResolved)) throw Error('No model selected or pool not configured');
   if(!ctx.modelRegistry.find(chosen.model.provider,chosen.model.modelId)) throw Error('Selected model unavailable in Pi registry');
   const selected=selectTools(agent,ctx.tools.map(t=>t.name));
   // Fail closed instead of running an agent with a silently reduced loadout.
   if(selected.unavailable.length) throw Error(`Unsupported/unavailable declared tools: ${selected.unavailable.join(', ')}`);
   const h=await get(ctx); const run=`spawn:${id}`;
   await admit(h,run,args.task,{model:chosen.model,thinkingLevel:agent.thinking??ctx.thinkingLevel,cwd:ctx.cwd,instructions:agent.instructions+`\n\nWorkspace: ${ctx.cwd}. Definition source: ${agent.definitionPath??'unknown'}. Relative definition resources resolve against the definition directory; ordinary tool paths resolve against the workspace.`,extensions:[hostExtension],tools:hostTools.filter(t=>selected.tools.includes(t.name))});
   return reply(run,args.nonblocking===false?await wait(h,run,60,signal):await status(h,run));
  },
 });
 for(const operation of ['status','wait','cancel'] as const) pi.registerTool({name:`subagent_${operation}`,label:`Subagent ${operation}`,exposure:'model-only',description:`${operation} a run belonging to this Pi session/workspace. Wait does not abort work. Cancel stops the conversation, including queued follow-ups. Status and wait explicitly resume unfinished durable jobs.`,parameters:Type.Object({...handle,...(operation==='wait'?{waitSeconds:Type.Optional(Type.Number({minimum:0,maximum:3600}))}:{})}),
  async execute(_id,args,signal,_update,ctx){const h=await get(ctx);await status(h,args.run);h.resume();return reply(args.run,operation==='cancel'?await cancel(h,args.run):operation==='wait'?await wait(h,args.run,(args as {waitSeconds?:number}).waitSeconds??60,signal):await status(h,args.run));},
 });
 pi.registerTool({name:'subagent_steer',label:'Subagent steer',exposure:'model-only',description:'Queue guidance at a tool-round boundary. Accepted is not proof of consumption or obedience. Requires active run.',parameters:Type.Object({...handle,guidance:Type.String({minLength:1,maxLength:8000})}),async execute(id,args,_signal,_update,ctx){
  if(!args.guidance.trim()) throw Error('Guidance must not be blank');
  const h=await get(ctx);const job=await status(h,args.run);if(job.status!=='running') throw Error('Completed work requires followup');
  await (await h.conversation(job.conversationId,C))!.submit({type:'input',content:args.guidance,whenBusy:'steer',requestId:`steer:${id}`},C);
  return {content:[{type:'text',text:'Guidance accepted; boundary insertion is not proof of obedience.'}],details:{run:args.run}};
 }});
 pi.registerTool({name:'subagent_followup',label:'Subagent follow-up',exposure:'model-only',description:'Assign a new task to a completed child in its retained conversation, with frozen model/prompt/tools/workspace. Returns a distinct background run. Fresh context requires a new subagent call.',parameters:Type.Object({...handle,task:Type.String({minLength:1})},{additionalProperties:false}),async execute(id,args,_signal,_update,ctx){const h=await get(ctx);const previous=await status(h,args.run);const missing=previous.requiredTools.filter(name=>!hostTools.some(t=>t.name===name));if(missing.length) throw Error(`Follow-up tools unavailable: ${missing.join(', ')}`);const run=`followup:${id}`;return reply(run,await admit(h,run,args.task,undefined,args.run));}});
 pi.registerTool({name:'subagents_list',label:'List agents',exposure:'model-only',description:'List configured agent definitions and declared loadouts.',parameters:Type.Object({}),async execute(){const dirs=await resolveAgentDirectories({configPath,defaultDirectory:join(getAgentDir(),'agents'),envValue:process.env.PI_SUBAGENT_AGENTS});const loaded=await loadAgents(dirs.directories);return {content:[{type:'text',text:JSON.stringify({agents:loaded.agents,errors:[...dirs.errors,...loaded.errors]},null,2)}],details:undefined};}});
}
