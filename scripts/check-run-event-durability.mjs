import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';

const root = process.cwd();

function read(relativePath) {
  return readFileSync(resolve(root, relativePath), 'utf8');
}

const config = read('src/config.ts');
const repository = [
  read('src/store/repository-sessions.ts'),
  read('src/store/repository-run-events.ts')
].join('\n');
const runsController = read('src/controllers/runs-controller.ts');
const reliability = read('docs/RELIABILITY.md');

assert(
  config.includes('PERSIST_RUN_EVENTS: optionalEnvBoolean()'),
  'PERSIST_RUN_EVENTS must be optional so production can default to durable storage'
);
assert(
  config.includes("PERSIST_RUN_EVENTS: value.PERSIST_RUN_EVENTS ?? value.NODE_ENV === 'production'"),
  'PERSIST_RUN_EVENTS must default to true when NODE_ENV=production'
);
assert(
  repository.includes('ON CONFLICT (run_id, seq) DO NOTHING'),
  'run event inserts must stay idempotent by (run_id, seq)'
);
assert(
  repository.includes('SELECT * FROM run_events WHERE run_id = $1 ORDER BY seq ASC'),
  'persisted run event replay must be ordered by seq'
);

const streamRunStart = runsController.indexOf('export async function streamRun');
const listenerRegistration = runsController.indexOf('runtime.runStreams.on(`run:${run.id}`, listener);', streamRunStart);
const replayFetch = runsController.indexOf('const existing = await getReplayRunEvents(run.id);', streamRunStart);
assert(listenerRegistration > streamRunStart, 'streamRun must register the live listener');
assert(replayFetch > streamRunStart, 'streamRun must fetch replay events');
assert(
  listenerRegistration < replayFetch,
  'SSE stream must subscribe before replay fetch to avoid losing events created during replay setup'
);
assert(
  runsController.includes('bufferedLiveEvents') && runsController.includes('event.seq <= lastReplayedSeq'),
  'SSE replay must buffer live events and de-duplicate by sequence'
);
assert(
  reliability.includes('Retention follows conversation retention'),
  'Reliability docs must explain run event retention'
);

console.log('Run event durability checks passed.');
