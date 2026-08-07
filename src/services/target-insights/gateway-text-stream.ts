type GatewayStreamState = { terminal: boolean; text: string };

function applyLine(line: string, state: GatewayStreamState): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new Error('llm-gateway emitted malformed stream data');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('llm-gateway emitted malformed stream data');
  }
  const event = parsed as { type?: string; text?: string; code?: string; message?: string };
  if (state.terminal) {
    throw new Error('llm-gateway emitted data after the terminal stream event');
  }
  if (event.type === 'delta') {
    if (typeof event.text !== 'string') {
      throw new Error('llm-gateway emitted malformed stream data');
    }
    state.text += event.text;
    return;
  }
  if (event.type === 'error') {
    throw new Error(event.message || event.code || 'llm-gateway stream error');
  }
  if (event.type === 'final') {
    state.terminal = true;
  }
}

export async function readGatewayTextStream(body: ReadableStream<Uint8Array>): Promise<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const state: GatewayStreamState = { terminal: false, text: '' };
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (line.trim()) applyLine(line, state);
      }
    }

    buffer += decoder.decode();
    if (buffer.trim()) applyLine(buffer, state);
    if (!state.terminal) {
      throw new Error('llm-gateway stream ended before a terminal event');
    }
    return state.text;
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
}
