export const config = { runtime: 'edge' };

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export default async function handler(req) {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }

  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405, headers: CORS });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return new Response(JSON.stringify({ error: { message: 'API key not configured' } }), {
      status: 500,
      headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  }

  let messages, system;
  try {
    ({ messages, system } = await req.json());
  } catch {
    return new Response(JSON.stringify({ error: { message: 'Invalid request body' } }), {
      status: 400,
      headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  }

  const upstream = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 1000,
      stream: true,
      system,
      messages,
    }),
  });

  if (!upstream.ok) {
    const err = await upstream.text();
    return new Response(err, {
      status: upstream.status,
      headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  }

  // ── Thinking-block filter ─────────────────────────────────────────────────
  // Strip content blocks of type "thinking" from the SSE stream before it
  // reaches the client, so internal model reasoning never appears in the UI.
  const thinkingIndices = new Set();
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  let sseBuffer = '';

  const filterStream = new TransformStream({
    transform(chunk, controller) {
      sseBuffer += dec.decode(chunk, { stream: true });
      // SSE events are delimited by double newlines
      const events = sseBuffer.split('\n\n');
      sseBuffer = events.pop(); // last element may be an incomplete event

      for (const event of events) {
        let skip = false;
        const dataLine = event.split('\n').find(l => l.startsWith('data: '));
        if (dataLine) {
          try {
            const d = JSON.parse(dataLine.slice(6));
            // Mark and skip thinking content_block_start events
            if (d.type === 'content_block_start' && d.content_block?.type === 'thinking') {
              thinkingIndices.add(d.index);
              skip = true;
            }
            // Skip thinking_delta or any delta on a known thinking index
            if (d.type === 'content_block_delta' &&
                (d.delta?.type === 'thinking_delta' || thinkingIndices.has(d.index))) {
              skip = true;
            }
            // Skip content_block_stop for thinking blocks, then clear the index
            if (d.type === 'content_block_stop' && thinkingIndices.has(d.index)) {
              thinkingIndices.delete(d.index);
              skip = true;
            }
          } catch { /* non-JSON line (e.g. event: ping) — pass through */ }
        }
        if (!skip) {
          controller.enqueue(enc.encode(event + '\n\n'));
        }
      }
    },
    flush(controller) {
      // Flush any remaining buffered data
      if (sseBuffer.trim()) {
        controller.enqueue(enc.encode(sseBuffer));
      }
    },
  });

  return new Response(upstream.body.pipeThrough(filterStream), {
    status: 200,
    headers: {
      ...CORS,
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Transfer-Encoding': 'chunked',
      'X-Accel-Buffering': 'no',
    },
  });
}
