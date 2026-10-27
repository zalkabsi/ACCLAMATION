/**
 * Control room. Vanilla JS, no build step: poll for room stats, ask the
 * backend, render the measured answer. SSE keeps it in sync when the trigger
 * comes from somewhere else (Stream Deck, curl, the overlay).
 */

const els = {
  status: document.getElementById('status-pill'),
  channel: document.getElementById('channel'),
  provider: document.getElementById('provider'),
  windowNote: document.getElementById('window-note'),
  question: document.getElementById('question'),
  ask: document.getElementById('ask'),
  dissent: document.getElementById('dissent'),
  thinking: document.getElementById('thinking'),
  answer: document.getElementById('answer'),
  empty: document.getElementById('empty'),
  mode: document.getElementById('answer-mode'),
  confidence: document.getElementById('answer-confidence'),
  meta: document.getElementById('answer-meta'),
  stance: document.getElementById('answer-stance'),
  voices: document.getElementById('answer-voices'),
  receipts: document.getElementById('answer-receipts'),
  basis: document.getElementById('answer-basis'),
  voiceLabel: [document.getElementById('voice-a-label'), document.getElementById('voice-b-label')],
  voiceStance: [document.getElementById('voice-a-stance'), document.getElementById('voice-b-stance')],
  voiceReceipts: [document.getElementById('voice-a-receipts'), document.getElementById('voice-b-receipts')],
  chatters: document.getElementById('stat-chatters'),
  messages: document.getElementById('stat-messages'),
  window: document.getElementById('stat-window'),
  roomStatus: document.getElementById('room-status'),
  scoreChat: document.getElementById('score-chat'),
  scoreStreamer: document.getElementById('score-streamer'),
  scoreChatButton: document.getElementById('score-chat-button'),
  scoreStreamerButton: document.getElementById('score-streamer-button'),
  trust: document.getElementById('trust-list'),
  lore: document.getElementById('lore-list'),
  loreInput: document.getElementById('lore-input'),
  loreAdd: document.getElementById('lore-add'),
};

const REASON_LABELS = {
  deleted: 'deleted messages',
  blocked_user: 'blocked users',
  banned_user: 'timed-out users',
  bot: 'bots',
  command: 'commands',
  link: 'links',
  pii_email: 'emails',
  pii_phone: 'phone numbers',
  pii_digits: 'long numbers',
  duplicate: 'duplicates',
  flood: 'floods',
  wall: 'walls of text',
  non_text: 'non-text messages',
  empty: 'empty messages',
  duplicate_id: 'replayed ids',
};

let current = null;
let busy = false;

async function refresh() {
  try {
    const response = await fetch('/api/state', { cache: 'no-store' });
    if (!response.ok) throw new Error(`state ${response.status}`);
    const data = await response.json();
    current = data;
    renderChrome(data);
    renderStats(data);
    if (!els.answer.dataset.filled && data.session?.lastAnswer) renderAnswer(data.session.lastAnswer);
  } catch {
    els.roomStatus.textContent = 'offline';
  }
}

function renderChrome(data) {
  const { config, connection } = data;
  const live = connection?.status === 'connected';
  const replay = connection?.status === 'replay';
  els.status.textContent = live ? 'LIVE' : replay ? 'REPLAY' : config.liveEnabled ? 'CONNECTING' : 'SAMPLE';
  els.status.className = `pill ${live ? 'live' : replay ? 'replay' : 'sample'}`;
  els.channel.textContent = config.channel ? `#${config.channel}` : 'no channel';
  els.provider.textContent = config.provider === 'local' ? 'local voice' : config.model;
  els.windowNote.textContent = `rolling ${config.windowSeconds}s`;
  els.window.textContent = String(config.windowSeconds);
}

function renderStats(data) {
  const stats = data.session?.stats ?? {};
  els.chatters.textContent = String(stats.chatters ?? 0);
  els.messages.textContent = String(stats.activeMessages ?? 0);

  const modeLabel = {
    connected: 'live',
    replay: 'replay',
    sample: 'sample mode',
    connecting: 'connecting',
    reconnecting: 'reconnecting',
  }[data.connection?.status] ?? 'offline';
  els.roomStatus.textContent = modeLabel;

  const score = data.session?.scoreboard ?? {};
  els.scoreChat.textContent = String(score.chat ?? 0);
  els.scoreStreamer.textContent = String(score.streamer ?? 0);

  renderTrust(stats);
  renderLore(data.session?.lore ?? []);
}

function renderTrust(stats) {
  const reasons = Object.entries(stats.filteredByReason ?? {}).sort((a, b) => b[1] - a[1]);
  els.trust.replaceChildren();
  if (!reasons.length) {
    const li = document.createElement('li');
    li.className = 'muted';
    li.textContent = 'nothing filtered yet';
    els.trust.append(li);
  } else {
    for (const [reason, count] of reasons) {
      const li = document.createElement('li');
      const name = document.createElement('span');
      name.textContent = REASON_LABELS[reason] ?? reason.replace(/_/g, ' ');
      const value = document.createElement('span');
      value.className = 'count';
      value.textContent = String(count);
      li.append(name, value);
      els.trust.append(li);
    }
    const total = document.createElement('li');
    total.innerHTML = '<span>scrubbed before quoting</span>';
    const value = document.createElement('span');
    value.className = 'count';
    value.textContent = String(stats.filtered ?? 0);
    total.append(value);
    els.trust.append(total);
  }
}

function renderLore(lore) {
  els.lore.replaceChildren();
  if (!lore.length) {
    const li = document.createElement('li');
    li.className = 'muted';
    li.textContent = 'no lore yet';
    els.lore.append(li);
    return;
  }
  for (const entry of lore) {
    const li = document.createElement('li');
    const text = document.createElement('span');
    text.textContent = entry.text;
    const button = document.createElement('button');
    button.textContent = 'remove';
    button.addEventListener('click', async () => {
      await fetch(`/api/lore/${entry.id}`, { method: 'DELETE' });
      refresh();
    });
    li.append(text, button);
    els.lore.append(li);
  }
}

function receiptNode(receipt) {
  const node = document.createElement('div');
  node.className = 'receipt';
  const user = document.createElement('span');
  user.className = 'user';
  user.textContent = `@${receipt.user}`;
  const text = document.createElement('span');
  text.className = 'text';
  text.textContent = receipt.text;
  node.append(user, text);
  if (receipt.voice) {
    const tag = document.createElement('span');
    tag.className = 'user';
    tag.style.marginLeft = 'auto';
    tag.style.opacity = '0.6';
    tag.textContent = receipt.voice;
    node.append(tag);
  }
  return node;
}

function renderAnswer(answer) {
  els.answer.dataset.filled = '1';
  els.answer.classList.remove('hidden');
  els.empty.classList.add('hidden');

  els.mode.textContent = answer.mode.toUpperCase();
  els.mode.className = `mode ${
    answer.mode === 'dissent' ? 'dissent' : answer.mode === 'consensus' ? '' : 'muted'
  }`;

  if (answer.mode === 'dissent') {
    els.confidence.textContent = `split ${answer.split?.a ?? '?'}% / ${answer.split?.b ?? '?'}%`;
  } else if (answer.confidence == null) {
    els.confidence.textContent = answer.mode === 'insufficient' ? 'not enough signal' : 'no consensus';
  } else {
    els.confidence.textContent = `${answer.confidence}% confidence`;
  }

  els.meta.textContent = `${answer.provider} · ${answer.timings?.totalMs ?? 0}ms${
    answer.timings?.modelMs ? ` (${answer.timings.modelMs}ms model)` : ''
  }`;
  els.stance.textContent = answer.stance ?? '';

  const isDissent = answer.mode === 'dissent' && Array.isArray(answer.voices);
  els.voices.classList.toggle('hidden', !isDissent);
  els.stance.classList.toggle('hidden', isDissent);
  els.receipts.replaceChildren();

  if (isDissent) {
    answer.voices.forEach((voice, index) => {
      els.voiceLabel[index].textContent = voice.label;
      els.voiceStance[index].textContent = voice.stance;
      els.voiceReceipts[index].replaceChildren(...voice.receipts.map(receiptNode));
    });
  } else {
    els.receipts.replaceChildren(...(answer.receipts ?? []).map(receiptNode));
  }

  const basis = answer.basis ?? {};
  const filtered = Object.entries(basis.filtered ?? {})
    .map(([reason, count]) => `${count} ${REASON_LABELS[reason] ?? reason}`)
    .join(', ');
  els.basis.textContent = [
    `${basis.chatters ?? answer.chatters ?? 0} chatters`,
    `${basis.messages ?? 0} messages in window`,
    `top share ${Math.round((answer.share ?? 0) * 100)}%`,
    filtered ? `held back: ${filtered}` : 'nothing held back',
    'confidence measured from clustering, not asserted by the model',
  ].join(' · ');
}

function setBusy(value) {
  busy = value;
  els.ask.disabled = value;
  els.dissent.disabled = value;
  els.thinking.classList.toggle('hidden', !value);
}

async function ask(forceMode) {
  if (busy) return;
  setBusy(true);
  try {
    const response = await fetch('/api/trigger', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        question: els.question.value.trim() || undefined,
        mode: forceMode ? 'dissent' : undefined,
      }),
    });
    const data = await response.json();
    if (!response.ok) {
      if (response.status === 409) return;
      throw new Error(data.error || `request failed (${response.status})`);
    }
    renderAnswer(data.answer);
    refresh();
  } catch (error) {
    els.basis.textContent = error.message;
  } finally {
    setBusy(false);
  }
}

async function score(winner) {
  await fetch('/api/score', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ winner }),
  });
  refresh();
}

async function addLore() {
  const text = els.loreInput.value.trim();
  if (!text) return;
  els.loreAdd.disabled = true;
  try {
    await fetch('/api/lore', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    els.loreInput.value = '';
    refresh();
  } finally {
    els.loreAdd.disabled = false;
  }
}

function wire() {
  els.ask.addEventListener('click', () => ask(false));
  els.dissent.addEventListener('click', () => ask(true));
  els.question.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') ask(false);
  });
  els.scoreChatButton?.addEventListener('click', () => score('chat'));
  els.scoreStreamerButton?.addEventListener('click', () => score('streamer'));
  els.loreAdd.addEventListener('click', addLore);
  els.loreInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') addLore();
  });

  const source = new EventSource('/api/events');
  source.addEventListener('trigger:start', (event) => {
    const data = JSON.parse(event.data);
    setBusy(true);
    if (data.question) els.question.value = data.question;
  });
  source.addEventListener('answer', (event) => {
    renderAnswer(JSON.parse(event.data));
    setBusy(false);
    refresh();
  });
  source.addEventListener('provider:error', () => {
    /* the answer already fell back to the local voice */
  });
  source.addEventListener('score', (event) => {
    const data = JSON.parse(event.data);
    els.scoreChat.textContent = String(data.chat ?? 0);
    els.scoreStreamer.textContent = String(data.streamer ?? 0);
  });
}

wire();
refresh();
setInterval(refresh, 2000);
