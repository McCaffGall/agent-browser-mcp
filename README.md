# Agent Browser MCP

A standalone, zero-dependency Chrome/Brave MV3 browser extension and universal MCP server that lets **any** AI coding agent (Claude Code, Claude Desktop, Codex, Cursor, Windsurf, Copilot, Antigravity) drive your real browser inside **isolated, colored tab groups** using your existing sign-ins — without stealing your mouse, keyboard, active tab, or window focus.

## Why This Exists

Desktop/computer-use automation hijacks your OS cursor and keyboard, so you cannot work while your agent clicks around. **Agent Browser** dispatches every action directly into a specific background tab via Chrome DevTools Protocol (`chrome.debugger` / `Input.dispatch*` / `Page.captureScreenshot`) inside that agent's own colored tab group.

- **Zero OS-input interference:** Background tabs (`active: false`), no focus stealing.
- **Per-agent isolation:** Every agent gets its own named, colored tab group (`claude` = orange, `codex` = green, `cursor` = blue, `agy` = purple, `copilot`/`windsurf` = cyan).
- **Drag-out revocation:** Dragging a tab out of an agent's group immediately revokes its access and detaches the debugger.
- **Real browser profile:** Reuses your signed-in sessions in Chrome, Brave (including Flatpak), or Edge.
- **Zero dependencies:** Pure Node.js ESM (`>=18.18.0`) + vanilla MV3 JavaScript. No `npm install`, no build step, no native messaging host binary.
- **Safety built in:** Loopback-only server with 256-bit pairing token, CSWSH origin checks, hard-blocked `chrome://`/`file://`/`javascript:` schemes, configurable domain allow/deny rules, redaction of passwords/cookies/tokens, and a 1-click **Kill Switch** in the extension popup and local dashboard (`http://127.0.0.1:17788`).

---

## 3-Step Quickstart

### 1. Clone the repo
```bash
git clone https://github.com/McCaffGall/agent-browser-mcp.git
cd agent-browser-mcp
```

### 2. Load the extension in Chrome or Brave
1. Open `chrome://extensions` or `brave://extensions`.
2. Enable **Developer mode** (top right).
3. Click **Load unpacked** and select the `extension/` folder inside this repository.

### 3. Pair & reload once
```bash
node bin/agent-browser-mcp.mjs pair --write-local
```
Then click the **Reload (`↻`)** button on the **Agent Browser** extension card in `chrome://extensions` / `brave://extensions`.

---

## Connect Your AI Agent (Universal MCP)

The `stdio` bridge automatically starts one shared background broker on `http://127.0.0.1:17788` (if not already running) and detects the client name (`claude`, `codex`, `cursor`, etc.) so multiple agents can work in parallel in separate colored tab groups against the same browser session.

### Claude Code
```bash
claude mcp add agent-browser -- node /ABS/PATH/TO/agent-browser-mcp/bin/agent-browser-mcp.mjs stdio --seat claude
```
Or via Streamable HTTP (after running `node bin/agent-browser-mcp.mjs serve`):
```bash
claude mcp add --transport http agent-browser http://127.0.0.1:17788/mcp
```

### Claude Desktop (`claude_desktop_config.json`)
```json
{
  "mcpServers": {
    "agent-browser": {
      "command": "node",
      "args": ["/ABS/PATH/TO/agent-browser-mcp/bin/agent-browser-mcp.mjs", "stdio", "--seat", "claude"]
    }
  }
}
```

### Codex CLI (`~/.codex/config.toml`)
```toml
[mcp_servers.agent_browser]
command = "node"
args = ["/ABS/PATH/TO/agent-browser-mcp/bin/agent-browser-mcp.mjs", "stdio", "--seat", "codex"]
```
Or over HTTP (`http://127.0.0.1:17788/mcp` with header `X-Agent-Seat: codex`).

### Cursor (`.cursor/mcp.json`)
```json
{
  "mcpServers": {
    "agent-browser": {
      "command": "node",
      "args": ["/ABS/PATH/TO/agent-browser-mcp/bin/agent-browser-mcp.mjs", "stdio", "--seat", "cursor"]
    }
  }
}
```

### Windsurf / VS Code Copilot / Antigravity
Point any MCP client at the stdio command:
```text
node /ABS/PATH/TO/agent-browser-mcp/bin/agent-browser-mcp.mjs stdio
```
or Streamable HTTP endpoint:
```text
http://127.0.0.1:17788/mcp
```

---

## MCP Tools (14)

- `browser_tabs_list` — List tabs in your own group (plus owner-shared tabs)
- `browser_tab_open` — Open a background tab (`active: false`) in your named, colored group
- `browser_tab_close` — Close an agent tab (or unshare an owner-shared tab without closing it)
- `browser_navigate` — Navigate an owned tab to an `http://` or `https://` URL
- `browser_read_page` — Read compact text + indexed interactive refs (`e1`, `e2`, ...)
- `browser_find` — Search elements by text, role, aria-label, or CSS selector
- `browser_click` — Click via ref, CSS selector, or `(x, y)` using CDP mouse events
- `browser_type` — Type via CDP `Input.insertText` (supports `clear` and `pressEnter`)
- `browser_fill` — Fill multiple form inputs/selects/checkboxes in one call
- `browser_scroll` — Scroll via CDP `mouseWheel` or element selector/ref
- `browser_screenshot` — Capture PNG via `Page.captureScreenshot` without focusing the tab
- `browser_console` — Read redacted console logs and page errors
- `browser_network` — Read redacted network metadata (cookies/auth headers stripped)
- `browser_group_close` — Close your tab group and detach debuggers

## Safety & Configuration

Runtime state lives under `~/.config/agent-browser-mcp/` (override with `AGENT_BROWSER_HOME`):
- `vault.json` (`0600`) — 256-bit pairing token
- `config.json` (`0600`) — `enabled`, `killSwitch`, `defaultPolicy` (`allow` or `deny`), `allowDomains`, `denyDomains`, `actionTimeoutMs`, `maxGroups`
- `audit.jsonl` (`0600`) — Redacted action audit log

Open `http://127.0.0.1:17788` while `serve` is running (or click the **Agent Browser** extension icon) to inspect active groups, stop a single group, share your current tab with an agent, or trigger the global **Kill Switch**.

## Testing

```bash
npm test
```
