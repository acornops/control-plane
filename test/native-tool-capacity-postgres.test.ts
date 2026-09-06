import { withTransaction } from '../src/store/repository-transaction.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import dns from 'node:dns/promises';
import https from 'node:https';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { after, afterEach, beforeEach, mock, test } from 'node:test';
import { config } from '../src/config.js';
import { db } from '../src/infra/db.js';
import { repo } from '../src/store/repository.js';
import { callPlatformNativeTool } from '../src/controllers/internal-platform-native-tool-controller.js';
import { callMcpTool } from '../src/controllers/internal-mcp-bridge-controller.js';
import { requireExecutionAccess } from '../src/services/workspace-execution-access.js';
import { executeWorkspaceNativeTool } from '../src/services/workspace-native-tool-executor.js';
import { acquireRunCapacity, settleRunCapacity, reserveRunCapacity } from '../src/store/repository-run-capacity.js';
import { addAgentConversationSession } from '../src/store/repository-agent-conversations.js';
import { getAgentDefinition } from '../src/store/repository-agents.js';
import { compileAgentConversationRunScope } from '../src/services/agent-chat.js';
import { getWorkspacePermissions } from '../src/auth/authorization.js';
import { resetAutomationDatabaseFixtures, installAutomationTemplateFixtures } from './helpers/automation-database-fixtures.js';

const originalEnabled = config.WORKSPACE_CAPACITY_ENABLED;
beforeEach(async()=>{ config.WORKSPACE_CAPACITY_ENABLED=true; await resetAutomationDatabaseFixtures(); await installAutomationTemplateFixtures(); });
afterEach(()=>{ mock.restoreAll(); config.WORKSPACE_CAPACITY_ENABLED=originalEnabled; });
after(async()=>{await db.end();});

async function createRun(agent = false) {
  const specialist = (await getAgentDefinition('workspace-1','agent-incident-reporter'))!;
  const scope = await compileAgentConversationRunScope({agent:specialist,actor:{userId:'user-1',role:'admin',permissions:getWorkspacePermissions('admin')},accessMode:'read_only'});
  const compiledAccessScope={...scope,tools:[...scope.tools,'http.fetch.get'],nativeToolConfigs:{'http.fetch.get':{allowedUrlPatterns:['https://example.com/*']}}};
  const session=agent
    ? await addAgentConversationSession({workspaceId:'workspace-1',agentId:specialist.id,createdBy:'user-1',title:'Native authority',preferredAccessMode:'read_only'})
    : await repo.addSession('workspace-1','cluster-1','user-1','Native authority');
  const message=await repo.addMessage(session.id,'user','Run native tool');
  const runId=randomUUID();
  await repo.addRun({id:runId,workspaceId:'workspace-1',sessionId:session.id,messageId:message.id,
    ...(agent?{conversationKind:'agent_chat' as const,agentId:specialist.id,agentSnapshot:specialist,compiledAccessScope}:{targetId:'cluster-1',targetType:'kubernetes' as const}),
    llmProvider:'openai',llmModel:'gpt-5-nano',llmReasoningSummaryMode:'off',llmReasoningEffort:'low',toolAccessMode:'read_only',status:'running',requestedAt:new Date().toISOString()});
  await withTransaction(client=>reserveRunCapacity(client,{workspaceId:'workspace-1',runId,pool:agent?'agent':'chat'}));
  const grant=await acquireRunCapacity(runId,'native-owner');
  assert.equal(grant.status,'granted');
  return {run:(await repo.getRun(runId))!,authority:Object.freeze({ownerId:'native-owner',generation:grant.generation!})};
}
async function revoke(runId:string, reason:'suspend'|'expire'|'restore') {
  if(reason==='expire') await db.query("UPDATE workspace_run_reservations SET lease_expires_at=clock_timestamp()-INTERVAL '1 second' WHERE run_id=$1",[runId]);
  else {
    await db.query("UPDATE workspaces SET lifecycle_status='suspended',suspended_at=clock_timestamp() WHERE id='workspace-1'");
    if(reason==='restore') await db.query("UPDATE workspaces SET lifecycle_status='active',suspended_at=NULL WHERE id='workspace-1'");
  }
}
function responseStub(run:Awaited<ReturnType<typeof createRun>>['run']) {
  return {statusCode:200,body:undefined as unknown,locals:{gatewayRunClaims:{runId:run.id,workspaceId:run.workspaceId,sessionId:run.sessionId,scopeType:'target',targetId:run.targetId,targetType:run.targetType,allowedTools:['documents.create']}},
    status(code:number){this.statusCode=code;return this;},json(body:unknown){this.body=body;return this;}};
}
for(const entry of ['native','builtin'] as const) for(const reason of ['suspend','expire','restore'] as const) {
  test(`${entry} document insertion rejects ${reason} after route authorization`,async()=>{
    const {run,authority}=await createRun();
    const req={params:{runId:run.id,toolId:'documents.create'},body:{name:'documents.create',toolCallId:'document-1',arguments:{title:'Report',markdown:'# Report',format:'markdown'}},query:{},path:'/runs/r/native-tools/documents.create/call',method:'POST',header:(key:string)=>key==='x-acornops-execution-owner'?authority.ownerId:String(authority.generation)};
    const res=responseStub(run);
    let authorized=false;
    await requireExecutionAccess(req as never,res as never,()=>{authorized=true;});
    assert.equal(authorized,true);
    const getRun=repo.getRun.bind(repo);
    mock.method(repo,'getRun',async(id:string)=>{const found=await getRun(id);await revoke(id,reason);return found;});
    await (entry==='native'?callPlatformNativeTool:callMcpTool)(req as never,res as never,(error?:unknown)=>{if(error)throw error;});
    assert.equal((await db.query('SELECT count(*)::int AS count FROM generated_documents WHERE conversation_run_id=$1',[run.id])).rows[0].count,0);
    assert.equal(res.statusCode,reason==='suspend'?403:409);
  });
}
for(const reason of ['suspend','expire','restore'] as const) {
  test(`Fetch denies ${reason} occurring during DNS before opening a socket`,async()=>{
    const {run,authority}=await createRun(true);
    let requests=0;
    mock.method(dns,'lookup',async()=>{await revoke(run.id,reason);return [{address:'93.184.216.34',family:4}];});
    mock.method(https,'request',()=>{requests++;throw new Error('Socket must not open');});
    await assert.rejects(executeWorkspaceNativeTool({run,authority,toolId:'http.fetch.get',toolCallId:'fetch-1',arguments:{url:'https://example.com/status'}}));
    assert.equal(requests,0);
    assert.equal((await db.query('SELECT count(*)::int AS count FROM workspace_run_operations WHERE run_id=$1',[run.id])).rows[0].count,0);
  });
}
test('Fetch retains bounded operation capacity after lease expiry until response cleanup',async()=>{
  const {run,authority}=await createRun(true);
  mock.method(dns,'lookup',async()=>[{address:'93.184.216.34',family:4}]);
  let started=false;
  let respond:(()=>void)|undefined;
  let destroyed=false;
  mock.method(https,'request',(_options:unknown, callback:(response:unknown)=>void)=>{
    const request=Object.assign(new EventEmitter(),{end(){started=true;},destroy(){destroyed=true;return this;}});
    respond=()=>callback(Object.assign(Readable.from(['ok']),{statusCode:200,headers:{'content-type':'text/plain'}}));
    return request;
  });
  const pending=executeWorkspaceNativeTool({run,authority,toolId:'http.fetch.get',toolCallId:'fetch-1',arguments:{url:'https://example.com/status'}});
  try {
    for(let i=0;i<100&&!started;i++)await delay(10);
    assert.equal(started,true);
    const operation=(await db.query('SELECT deadline>clock_timestamp() AS alive,finished_at FROM workspace_run_operations WHERE run_id=$1',[run.id])).rows[0];
    assert.ok(operation);assert.equal(operation.alive,true);assert.equal(operation.finished_at,null);
    await revoke(run.id,'expire');
    await settleRunCapacity(run.id);
    assert.equal((await db.query('SELECT settled_at FROM workspace_run_reservations WHERE run_id=$1',[run.id])).rows[0].settled_at,null);
  } finally {respond?.();await pending;}
  assert.equal(destroyed,true);
  assert.ok((await db.query('SELECT finished_at FROM workspace_run_operations WHERE run_id=$1',[run.id])).rows[0].finished_at);
  await settleRunCapacity(run.id);
  assert.ok((await db.query('SELECT settled_at FROM workspace_run_reservations WHERE run_id=$1',[run.id])).rows[0].settled_at);
});

for(const entry of ['native','builtin'] as const) {
  test(`${entry} captures immutable execution identity before awaited run lookup`,async()=>{
    const {run,authority}=await createRun();
    let owner=authority.ownerId;
    let generation=authority.generation;
    const req={params:{runId:run.id,toolId:'documents.create'},body:{name:'documents.create',toolCallId:'document-identity',arguments:{title:'Report',markdown:'# Report',format:'markdown'}},header:(key:string)=>key==='x-acornops-execution-owner'?owner:String(generation)};
    const getRun=repo.getRun.bind(repo);
    mock.method(repo,'getRun',async(id:string)=>{
      const found=await getRun(id);
      owner='replacement';generation++;
      await db.query('UPDATE workspace_run_reservations SET owner_id=$2,generation=$3 WHERE run_id=$1',[id,owner,generation]);
      return found;
    });
    const res=responseStub(run);
    await (entry==='native'?callPlatformNativeTool:callMcpTool)(req as never,res as never,(error?:unknown)=>{if(error)throw error;});
    assert.equal(res.statusCode,409);
    assert.equal((await db.query('SELECT count(*)::int AS count FROM generated_documents WHERE conversation_run_id=$1',[run.id])).rows[0].count,0);
  });
}
for(const reason of ['suspend','restore'] as const) {
  test(`disabled capacity still fences document ${reason}`,async()=>{
    const {run}=await createRun();
    config.WORKSPACE_CAPACITY_ENABLED=false;
    const getRun=repo.getRun.bind(repo);
    mock.method(repo,'getRun',async(id:string)=>{const found=await getRun(id);await revoke(id,reason);return found;});
    const res=responseStub(run);
    await callPlatformNativeTool({params:{runId:run.id,toolId:'documents.create'},body:{toolCallId:'disabled-document',arguments:{title:'Report',markdown:'# Report',format:'markdown'}}} as never,res as never,(error?:unknown)=>{if(error)throw error;});
    assert.equal(res.statusCode,reason==='suspend'?403:409);
    assert.equal((await db.query('SELECT count(*)::int AS count FROM generated_documents WHERE conversation_run_id=$1',[run.id])).rows[0].count,0);
  });
  test(`disabled capacity still fences Fetch ${reason} during DNS`,async()=>{
    const {run,authority}=await createRun(true);
    config.WORKSPACE_CAPACITY_ENABLED=false;
    let requests=0;
    mock.method(dns,'lookup',async()=>{await revoke(run.id,reason);return [{address:'93.184.216.34',family:4}];});
    mock.method(https,'request',()=>{requests++;throw new Error('Socket must not open');});
    await assert.rejects(executeWorkspaceNativeTool({run,authority,toolId:'http.fetch.get',toolCallId:'fetch-disabled',arguments:{url:'https://example.com/status'}}));
    assert.equal(requests,0);
  });
}

test('Fetch request-construction failure completes its bounded operation',async()=>{
  const {run,authority}=await createRun(true);
  mock.method(dns,'lookup',async()=>[{address:'93.184.216.34',family:4}]);
  mock.method(https,'request',()=>{throw new Error('Connection construction failed');});
  await assert.rejects(executeWorkspaceNativeTool({run,authority,toolId:'http.fetch.get',toolCallId:'fetch-failed',arguments:{url:'https://example.com/status'}}));
  const operation=(await db.query('SELECT finished_at FROM workspace_run_operations WHERE run_id=$1',[run.id])).rows[0];
  assert.ok(operation?.finished_at);
});
