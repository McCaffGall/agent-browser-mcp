// Shared protocol constants, tool schemas, tab-group naming, and redaction
// helpers for Agent Browser MCP.

export const SEAT_GROUP_COLORS = {
  claude: 'orange',
  codex: 'green',
  agy: 'purple',
  antigravity: 'purple',
  cursor: 'blue',
  copilot: 'cyan',
  windsurf: 'cyan',
};

export function colorForSeat(seat) {
  const base = String(seat || '').trim().toLowerCase().replace(/-\d+$/, '');
  return SEAT_GROUP_COLORS[base] ?? 'pink';
}

export function makeOwnerKey(sessionId, seat) {
  const cleanSession = String(sessionId || '').trim() || 'adhoc';
  const cleanSeat = String(seat || '').trim() || 'agent';
  return `${cleanSession}::${cleanSeat}`;
}

export function makeGroupTitle(sessionId, seat, prefix = 'Agent') {
  const cleanPrefix = (String(prefix || 'Agent').trim() || 'Agent').slice(0, 10);
  const cleanSeat = (String(seat || '').trim() || 'agent').slice(0, 12);
  const cleanSession = String(sessionId || '').trim() || 'adhoc';
  const overhead = cleanPrefix.length + 6 + cleanSeat.length; // "<prefix> · <session> · <seat>"
  const maxSession = Math.max(4, 36 - overhead);
  const shortSession =
    cleanSession.length > maxSession ? `${cleanSession.slice(0, maxSession - 1)}…` : cleanSession;
  return `${cleanPrefix} · ${shortSession} · ${cleanSeat}`.slice(0, 36);
}

/** Scrub bearer tokens, cookies, auth headers, and secret query/key-value pairs. */
export function redactSensitiveText(text) {
  return String(text ?? '')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/Basic\s+[A-Za-z0-9._~+/=-]+/gi, 'Basic [redacted]')
    .replace(/\b(authorization|cookie|set-cookie|x-api-key)\s*:\s*[^\r\n]+/gi, '$1: [redacted]')
    .replace(
      /\b(access_token|refresh_token|api[_-]?key|token|password|passwd|secret|auth)(["']?\s*[:=]\s*["']?)[^\s"',}&]+/gi,
      '$1$2[redacted]',
    )
    .replace(/eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]*/g, '[redacted]');
}

export const BROWSER_TOOLS = [
  {
    name: 'browser_tabs_list',
    description: 'List tabs inside your own agent tab group (and any tabs the owner explicitly shared with you).',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'browser_tab_open',
    description: 'Open a new background tab inside your own named, colored tab group without stealing focus or switching the owner active tab.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Target http:// or https:// URL (optional, defaults to about:blank).' },
        wait: { type: 'string', enum: ['load', 'domcontentloaded', 'none'], description: 'Wait mode after navigation (default load).' },
      },
    },
  },
  {
    name: 'browser_tab_close',
    description: 'Close a tab in your own tab group (owner-shared tabs are unshared rather than closed).',
    inputSchema: {
      type: 'object',
      required: ['tabId'],
      properties: { tabId: { type: 'integer' } },
    },
  },
  {
    name: 'browser_navigate',
    description: 'Navigate an owned tab to an http:// or https:// URL.',
    inputSchema: {
      type: 'object',
      required: ['tabId', 'url'],
      properties: {
        tabId: { type: 'integer' },
        url: { type: 'string' },
        wait: { type: 'string', enum: ['load', 'domcontentloaded', 'none'] },
      },
    },
  },
  {
    name: 'browser_read_page',
    description: 'Read page metadata, compact visible text, and indexed interactive elements (ref e1, e2, ...) from an owned tab. Password values are always redacted.',
    inputSchema: {
      type: 'object',
      required: ['tabId'],
      properties: {
        tabId: { type: 'integer' },
        maxTextChars: { type: 'integer', description: 'Optional max visible text chars (default 8000).' },
      },
    },
  },
  {
    name: 'browser_find',
    description: 'Find matching elements inside an owned tab by text, aria-label, role, or CSS selector and return their refs.',
    inputSchema: {
      type: 'object',
      required: ['tabId', 'query'],
      properties: {
        tabId: { type: 'integer' },
        query: { type: 'string' },
        limit: { type: 'integer' },
      },
    },
  },
  {
    name: 'browser_click',
    description: 'Click an element by ref (from browser_read_page / browser_find), CSS selector, or viewport coordinates (x, y) via CDP mouse events.',
    inputSchema: {
      type: 'object',
      required: ['tabId'],
      properties: {
        tabId: { type: 'integer' },
        ref: { type: 'string' },
        selector: { type: 'string' },
        x: { type: 'number' },
        y: { type: 'number' },
        button: { type: 'string', enum: ['left', 'right', 'middle'] },
        clickCount: { type: 'integer' },
      },
    },
  },
  {
    name: 'browser_type',
    description: 'Type text into an input/textarea/contenteditable element inside an owned tab via CDP Input.insertText (no OS keyboard events).',
    inputSchema: {
      type: 'object',
      required: ['tabId', 'text'],
      properties: {
        tabId: { type: 'integer' },
        ref: { type: 'string' },
        selector: { type: 'string' },
        text: { type: 'string' },
        clear: { type: 'boolean' },
        pressEnter: { type: 'boolean' },
      },
    },
  },
  {
    name: 'browser_fill',
    description: 'Fill multiple form fields (inputs, textareas, selects, checkboxes) in an owned tab in one step.',
    inputSchema: {
      type: 'object',
      required: ['tabId', 'fields'],
      properties: {
        tabId: { type: 'integer' },
        fields: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              ref: { type: 'string' },
              selector: { type: 'string' },
              value: { type: ['string', 'boolean', 'number'] },
            },
          },
        },
      },
    },
  },
  {
    name: 'browser_scroll',
    description: 'Scroll inside an owned tab using CDP mouseWheel events or an element selector.',
    inputSchema: {
      type: 'object',
      required: ['tabId'],
      properties: {
        tabId: { type: 'integer' },
        deltaX: { type: 'number' },
        deltaY: { type: 'number' },
        selector: { type: 'string' },
        ref: { type: 'string' },
      },
    },
  },
  {
    name: 'browser_screenshot',
    description: 'Capture a PNG screenshot of an owned tab via CDP Page.captureScreenshot without activating or focusing it.',
    inputSchema: {
      type: 'object',
      required: ['tabId'],
      properties: {
        tabId: { type: 'integer' },
        fullPage: { type: 'boolean' },
      },
    },
  },
  {
    name: 'browser_console',
    description: 'Read buffered console logs and page errors from an owned tab (tokens/secrets redacted).',
    inputSchema: {
      type: 'object',
      required: ['tabId'],
      properties: {
        tabId: { type: 'integer' },
        clear: { type: 'boolean' },
        limit: { type: 'integer' },
      },
    },
  },
  {
    name: 'browser_network',
    description: 'Read buffered network requests/responses from an owned tab (headers/query secrets redacted, no cookies/tokens).',
    inputSchema: {
      type: 'object',
      required: ['tabId'],
      properties: {
        tabId: { type: 'integer' },
        clear: { type: 'boolean' },
        limit: { type: 'integer' },
      },
    },
  },
  {
    name: 'browser_group_close',
    description: 'Close all agent-created tabs in your tab group, unshare owner-shared tabs, and detach debuggers.',
    inputSchema: { type: 'object', properties: {} },
  },
];
