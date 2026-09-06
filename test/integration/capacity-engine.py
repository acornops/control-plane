"""Real engine HTTP/Redis/Worker fixture with a deterministic bounded operation body."""
import asyncio
from datetime import UTC, datetime
import os
import uuid

import uvicorn
from execution_engine.app import app, worker, registry
from execution_engine.capacity import current_authority
from execution_engine.models import Event, CommitRequest, Usage, Timing
from execution_engine.run_registry import RunStatus


async def bounded_work(state):
    authority = current_authority.get()
    state.status = RunStatus.RUNNING
    state.started_at = datetime.now(UTC)
    registry.persist_state(state)
    await worker.orchestrator_client.post_events(state.run_id, [Event(
        run_id=state.run_id, seq=1, type="run_started", payload={})])
    operation = {"ownerId": authority.owner_id, "generation": authority.generation,
                 "operationId": f"{os.getpid()}-{uuid.uuid4()}", "timeoutMs": 5000}
    await worker.orchestrator_client.capacity(state.run_id, "operations/begin", operation)
    await asyncio.sleep(0.8)
    operation.pop("timeoutMs")
    await worker.orchestrator_client.capacity(state.run_id, "operations/finish", operation)
    state.status = RunStatus.COMPLETED
    state.ended_at = datetime.now(UTC)
    registry.persist_state(state)
    await worker.orchestrator_client.commit(state.run_id, CommitRequest(
        status="completed", assistant_message={"content": "Replica probe completed", "format": "markdown"},
        usage=Usage(input_tokens=0, output_tokens=0),
        timing=Timing(started_at=state.started_at, ended_at=state.ended_at)))


worker._do_execute_run = bounded_work
uvicorn.run(app, host="127.0.0.1", port=int(os.environ["PROBE_PORT"]), log_level="warning")
