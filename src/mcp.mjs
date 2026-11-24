// Stateless Streamable HTTP / JSON-RPC 2.0 MCP handler for Agent Browser MCP.

export const PROTOCOL_VERSION = '2025-03-26';
const SUPPORTED = new Set(['2024-11-05', '2025-03-26', '2025-06-18']);

const ok = (id, result) => ({ jsonrpc: '2.0', id, result });
const fail = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

export async function handleMessage(broker, msg, who) {
  if (typeof msg !== 'object' || msg === null || Array.isArray(msg)) {
    return fail(null, -32600, 'Invalid request');
  }
  const hasId = msg.id !== undefined && msg.id !== null;
  const id = hasId ? msg.id : null;
  if (msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    return hasId ? fail(id, -32600, 'Invalid request') : null;
  }
  if (!hasId) return null;

  switch (msg.method) {
    case 'initialize': {
      const asked = typeof msg.params?.protocolVersion === 'string' ? msg.params.protocolVersion : '';
      return ok(id, {
        protocolVersion: SUPPORTED.has(asked) ? asked : PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'agent-browser-mcp', version: '0.2.0' },
        instructions:
          'Drive the owner real browser inside your own isolated, colored tab group via Chrome DevTools Protocol (never steals focus or OS input). Start with browser_tab_open or browser_tabs_list; use browser_read_page to get element refs (e1, e2...), then browser_click / browser_type / browser_fill / browser_screenshot.',
      });
    }
    case 'ping':
      return ok(id, {});
    case 'tools/list':
      return ok(id, {
        tools: broker.tools().map(t => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        })),
      });
    case 'tools/call': {
      const name = msg.params?.name;
      const args = msg.params?.arguments ?? {};
      const res = await broker.call({
        tool: name,
        args,
        sessionId: who?.sessionId ?? null,
        seat: who?.seat ?? null,
        via: 'mcp',
      });
      if (res.ok) return ok(id, res.result);
      if (res.error?.code === 'bad_request') return fail(id, -32602, res.error.message);
      return ok(id, {
        isError: true,
        content: [{ type: 'text', text: `${res.error?.code ?? 'error'}: ${res.error?.message ?? 'Browser tool failed.'}` }],
      });
    }
    default:
      return fail(id, -32601, `Method not found: ${msg.method}`);
  }
}

export async function handleBody(broker, body, who) {
  if (Array.isArray(body)) {
    if (body.length === 0) return fail(null, -32600, 'Invalid request');
    const out = (await Promise.all(body.map(m => handleMessage(broker, m, who)))).filter(r => r !== null);
    return out.length ? out : null;
  }
  return handleMessage(broker, body, who);
}
