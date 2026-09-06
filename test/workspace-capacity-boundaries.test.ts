import assert from 'node:assert/strict';
import { afterEach, test, mock } from 'node:test';
import express, { type Request, type Response } from 'express';
import type { AddressInfo } from 'node:net';
import { config } from '../src/config.js';
import { db } from '../src/infra/db.js';
import { registerRunCapacityRoutes } from '../src/controllers/internal-run-capacity-controller.js';
import { requireExecutionAccess } from '../src/services/workspace-execution-access.js';
import { withInsightsCapacity } from '../src/services/insights-capacity.js';
import { installInsightsCapacityFixture } from './helpers/insights-capacity-fixture.js';
const original = { enabled:config.WORKSPACE_CAPACITY_ENABLED, dispatch:config.WORKSPACE_DISPATCH_ENABLED };
afterEach(()=>{ mock.restoreAll(); config.WORKSPACE_CAPACITY_ENABLED=original.enabled; config.WORKSPACE_DISPATCH_ENABLED=original.dispatch; });

test('Insights defers model work when dispatch is closed with capacity enforcement disabled', async()=>{
  config.WORKSPACE_CAPACITY_ENABLED=false;
  config.WORKSPACE_DISPATCH_ENABLED=false;
  installInsightsCapacityFixture();
  let calls=0;
  await withInsightsCapacity({workspaceId:'workspace-1',targetId:'target-1',sessionId:'session-1',leaseOwner:'owner',lastActivityAt:'2026-09-06T00:00:00Z'},async()=>{calls++;});
  assert.equal(calls,0);
});

test('execution middleware returns retryable bounded authority failure without calling downstream',async()=>{
  mock.method(db,'query',async()=>{throw new Error('secret SQL host details');});
  let code=0;
  let body: unknown;
  let downstream=0;
  const req={params:{runId:'run-1'},body:{},query:{},path:'/tools',method:'POST',header:()=>undefined} as unknown as Request;
  const res={locals:{},status(value:number){code=value;return this;},json(value:unknown){body=value;return this;}} as unknown as Response;
  await requireExecutionAccess(req,res,()=>{downstream++;});
  assert.equal(code,503);
  assert.equal(downstream,0);
  assert.deepEqual(body,{error:{code:'WORKSPACE_CAPACITY_UNAVAILABLE',message:'Workspace execution authority is temporarily unavailable',retryable:true}});
});

for (const stage of ['identity','transaction'] as const) {
  test(`capacity acquire, renew and operation begin fail closed on ${stage} failure`,async()=>{
    config.WORKSPACE_CAPACITY_ENABLED=true;
    mock.method(db,'query',async(sql:string)=>{
      if(stage==='identity') throw new Error('private SQL diagnostic');
      if(sql.includes('UNION ALL')) return {rowCount:1,rows:[{workspace_id:'workspace-1',requested_at:'2026-09-06 00:00:00.123456+00'}]};
      if(sql.includes('SELECT lifecycle_status')) return {rowCount:1,rows:[{lifecycle_status:'active'}]};
      return {rowCount:0,rows:[]};
    });
    mock.method(db,'connect',async()=>{throw new Error('private connection details');});
    const app=express(); app.use(express.json()); const router=express.Router(); registerRunCapacityRoutes(router); app.use(router);
    const server=app.listen(0,'127.0.0.1'); await new Promise<void>(resolve=>server.once('listening',resolve));
    try {
      for(const action of ['acquire','renew','operations/begin']) {
        const body=action==='acquire'?{ownerId:'owner'}:action==='renew'?{ownerId:'owner',generation:1}:{ownerId:'owner',generation:1,operationId:'op',timeoutMs:1000};
        const result=await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/runs/run-1/capacity/${action}`,{method:'POST',headers:{authorization:`Bearer ${config.ORCH_SERVICE_TOKEN}`,'content-type':'application/json'},body:JSON.stringify(body)});
        assert.equal(result.status,503);
        assert.deepEqual(await result.json(),{error:{code:'WORKSPACE_CAPACITY_UNAVAILABLE',message:'Workspace execution authority is temporarily unavailable',retryable:true}});
      }
    } finally { await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve())); }
  });
}
