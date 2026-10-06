import { BACKGROUND_CONTEXT as C } from '@earendil-works/chord/context';
import { AssistantEntry, Harness, configure, defineDoc, defineExtension, defineTask, type AgentChange, type ConversationId, type TaskId } from '@earendil-works/pi-durable';
import type { AssistantMessage } from '@earendil-works/pi-ai';
export type Job = { conversationId: ConversationId; taskId: TaskId; status: string; output: string; task: string; requiredTools: string[] };
export const Jobs = defineDoc<{jobs: Record<string, Job>; cwd: string}>({kind:'cli.subagent-jobs',version:1,scope:'conversation',history:'latest',fork:'initial',initial:()=>({jobs:{},cwd:''})});
const Deliver = defineTask<{run:string; child:ConversationId; message:string}, {phase:'deliver'}, null>({
 name:'cli.subagent-delivery',version:1,initial:()=>({phase:'deliver'}),
 phases:{deliver:async (task,runtime,ctx)=>{
  const child=(await runtime.conversation(task.input.child,ctx))!;
  const result=await (await child.submit({type:'input',content:task.input.message,requestId:`delivery:${task.id}`,whenBusy:'followUp'},ctx)).wait(ctx);
  await runtime.commit(async tx=>{
   const job=(await tx.doc(Jobs,runtime.conversationId)).jobs[task.input.run]!;
   job.status=result.status==='done'?'succeeded':'failed';
   if(result.status==='done' && result.type==='input') {
    const answer=(await tx.entry(AssistantEntry,result.answer))?.model?.[0] as AssistantMessage | undefined;
    job.output=(answer?.content??[]).flatMap(p=>p.type==='text'?[p.text]:[]).join('');
   } else job.output=JSON.stringify(result);
   return {status:'terminal',outcome:{status:'completed',result:null}};
  },ctx);
 }},
 abort:async (task,runtime,ctx)=>runtime.commit(async tx=>{
  const job=(await tx.doc(Jobs,runtime.conversationId)).jobs[task.input.run];
  if(job) job.status='cancelled';
  return {status:'terminal',outcome:{status:'aborted'}};
 },ctx),
});
export const JobRuntime=defineExtension({name:'cli.subagent-runtime',tasks:[Deliver]});
export async function admit(h:Harness, run:string, message:string, agent?:AgentChange, previous?:string) {
 if(!message.trim()) throw Error('Task must not be blank');
 const root=await h.root(C);
 await root.commit(async tx=>{
  const doc=await tx.doc(Jobs,root.id);
  if(Object.hasOwn(doc.jobs,run)) return;
  let child:ConversationId;
  if(previous){
   const prior=doc.jobs[previous]; if(!prior) throw Error('Unknown run');
   if(prior.status==='running') throw Error('Active work requires steer');
   child=prior.conversationId;
   if(Object.values(doc.jobs).some(j=>j.conversationId===child&&j.status==='running')) throw Error('Conversation already has active work');
  } else {
   const created=await tx.createConversation({ownership:{kind:'ownerless'}});
   child=created.id; await configure(tx,child,agent!);
  }
  const taskId=await tx.createTask(Deliver,{run,child,message},{ownership:{kind:'conversation'},background:true});
  const requiredTools=previous?doc.jobs[previous]!.requiredTools:Array.isArray(agent?.tools)?agent.tools.map(t=>t.name):[];
  doc.jobs[run]={conversationId:child,taskId,status:'running',output:'',task:message,requiredTools};
 },C);
 h.resume();
 return status(h,run);
}
export async function status(h:Harness,run:string):Promise<Job>{
 const root=await h.root(C); const job=(await h.snapshot(Jobs,root.id,C))?.jobs[run];
 if(!job || !Object.hasOwn((await h.snapshot(Jobs,root.id,C))!.jobs,run)) throw Error('Unknown run in this Pi session'); return job;
}
export async function cancel(h:Harness,run:string){
 const job=await status(h,run);
 if(job.status!=='running') return job;
 // Abort delivery first, preventing a pending delivery from starting work after cancellation.
 await h.abortTask(job.taskId,C); await h.waitForTask(job.taskId,C);
 await (await h.conversation(job.conversationId,C))!.abort(C);
 return status(h,run);
}
export async function wait(h:Harness,run:string,seconds:number,signal?:AbortSignal){
 const deadline=Date.now()+seconds*1000;
 while(true){ const job=await status(h,run); if(job.status!=='running'||Date.now()>=deadline||signal?.aborted) return job;
  await new Promise(r=>setTimeout(r,Math.min(50,Math.max(1,deadline-Date.now()))));
 }
}
