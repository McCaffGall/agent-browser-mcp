const connStatus = document.getElementById('conn-status');
const groupsList = document.getElementById('groups-list');
const wsUrlInput = document.getElementById('ws-url');
const tokenInput = document.getElementById('token-input');
const pairBtn = document.getElementById('pair-btn');
const unpairBtn = document.getElementById('unpair-btn');
const killBtn = document.getElementById('kill-btn');
const msgEl = document.getElementById('msg');

function showMsg(text) {
  msgEl.textContent = text || '';
}

function send(message) {
  return new Promise(resolve => chrome.runtime.sendMessage(message, resolve));
}

function renderGroups(state) {
  groupsList.replaceChildren();
  if (!state.groups || state.groups.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'group-sub';
    empty.textContent = 'No active agent tab groups.';
    groupsList.appendChild(empty);
    return;
  }

  for (const g of state.groups) {
    const row = document.createElement('div');
    row.className = 'group-row';

    const meta = document.createElement('div');
    meta.className = 'group-meta';
    const title = document.createElement('div');
    title.className = 'group-title';
    title.textContent = `${g.title} (${g.color})`;
    const sub = document.createElement('div');
    sub.className = 'group-sub';
    sub.textContent = `${g.tabs.length} tab(s) · ${g.seat}`;
    meta.append(title, sub);

    const actions = document.createElement('div');
    actions.className = 'group-actions';

    if (state.activeTab?.id && !g.tabs.some(t => t.tabId === state.activeTab.id)) {
      const shareBtn = document.createElement('button');
      shareBtn.type = 'button';
      shareBtn.className = 'btn small';
      shareBtn.textContent = 'Share tab';
      shareBtn.addEventListener('click', async () => {
        await send({ type: 'share_tab', ownerKey: g.ownerKey, tabId: state.activeTab.id });
        await refresh();
      });
      actions.appendChild(shareBtn);
    }

    const stopBtn = document.createElement('button');
    stopBtn.type = 'button';
    stopBtn.className = 'btn danger small';
    stopBtn.textContent = 'Stop';
    stopBtn.addEventListener('click', async () => {
      await send({ type: 'stop_group', ownerKey: g.ownerKey });
      await refresh();
    });
    actions.appendChild(stopBtn);

    row.append(meta, actions);
    groupsList.appendChild(row);
  }
}

async function refresh() {
  const state = await send({ type: 'get_state' });
  if (!state) return;
  wsUrlInput.value = wsUrlInput.value || state.wsUrl;
  if (state.killSwitch) {
    connStatus.textContent = 'Kill Switch active (agents blocked)';
    connStatus.className = 'status bad';
  } else if (state.connected) {
    let label = 'Connected';
    try {
      if (state.wsUrl) label = `Connected · ${new URL(state.wsUrl).host}`;
    } catch {
      label = 'Connected';
    }
    connStatus.textContent = label;
    connStatus.className = 'status ok';
  } else if (state.paired) {
    connStatus.textContent = 'Paired · waiting for broker';
    connStatus.className = 'status';
  } else {
    connStatus.textContent = 'Not paired';
    connStatus.className = 'status bad';
  }
  renderGroups(state);
}

pairBtn.addEventListener('click', async () => {
  let wsUrl = wsUrlInput.value.trim();
  let token = tokenInput.value.trim();
  if (token.startsWith('{')) {
    try {
      const parsed = JSON.parse(token);
      if (parsed.wsUrl) wsUrl = String(parsed.wsUrl);
      if (parsed.token) token = String(parsed.token);
      wsUrlInput.value = wsUrl;
    } catch {
      showMsg('Invalid JSON payload.');
      return;
    }
  }
  const res = await send({ type: 'pair', wsUrl, token });
  if (!res?.ok) {
    showMsg(res?.error || 'Failed to save pairing.');
    return;
  }
  tokenInput.value = '';
  showMsg('Saved. Connecting...');
  setTimeout(refresh, 400);
});

unpairBtn.addEventListener('click', async () => {
  await send({ type: 'disconnect' });
  showMsg('Unpaired.');
  await refresh();
});

killBtn.addEventListener('click', async () => {
  await send({ type: 'kill_all', closeTabs: false });
  showMsg('Stopped all active agent groups.');
  await refresh();
});

void refresh();
