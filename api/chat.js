export const config = { runtime: 'edge' };

// The page and this endpoint share one origin, so no CORS headers are sent: other
// sites can't call this from a browser, and the Origin check below stops the rest of
// the casual abuse (curl, scripts). Keep these limits above what the frontend sends.
const MAX_BODY_BYTES = 5_000_000;   // chat history + base64 attachments (jpeg/png/webp/pdf)
const MAX_MESSAGES = 60;            // frontend trims history to 50
const MAX_SYSTEM_CHARS = 60_000;    // SYSTEM_PROMPT is ~28k chars + a language instruction

const json = (status, message) =>
  new Response(JSON.stringify({ error: { message } }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

function isAllowedOrigin(origin) {
  if (!origin) return false;
  let host;
  try { host = new URL(origin).hostname; } catch { return false; }
  // Production + local dev only. Preview deployments (hai-project-<hash>-<team>.vercel.app)
  // are intentionally not matched: anyone can register a *.vercel.app name with that prefix.
  return host === 'hai-project.vercel.app' || host === 'localhost' || host === '127.0.0.1';
}

export default async function handler(req) {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  if (!isAllowedOrigin(req.headers.get('origin'))) {
    return json(403, 'Forbidden');
  }

  if (Number(req.headers.get('content-length') || 0) > MAX_BODY_BYTES) {
    return json(413, 'Request too large');
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return json(500, 'API key not configured');
  }

  let messages, system;
  try {
    ({ messages, system } = await req.json());
  } catch {
    return json(400, 'Invalid request body');
  }

  if (!Array.isArray(messages) || messages.length === 0 || messages.length > MAX_MESSAGES ||
      (system !== undefined && (typeof system !== 'string' || system.length > MAX_SYSTEM_CHARS))) {
    return json(400, 'Invalid request body');
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
      max_tokens: 2048,
      stream: true,
      system,
      messages,
    }),
  });

  if (!upstream.ok) {
    const err = await upstream.text();
    return new Response(err, {
      status: upstream.status,
      headers: { 'Content-Type': 'application/json' },
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
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Transfer-Encoding': 'chunked',
      'X-Accel-Buffering': 'no',
    },
  });
}
