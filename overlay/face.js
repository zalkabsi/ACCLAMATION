/**
 * Acclamation overlay.
 *
 * 1,800 glyphs, each one a chat message. Idle they drift as a loose cloud; when
 * the streamer asks, they collapse into a face in under a second. When chat is
 * split, the face breaks into two faces that argue in different colours.
 *
 * No framework, no build step, no network fonts — OBS just loads the page.
 */

const canvas = document.getElementById('stage');
const ctx = canvas.getContext('2d', { alpha: true });
const hud = document.getElementById('hud');

const els = {
  answer: document.getElementById('answer'),
  question: document.getElementById('question'),
  stance: document.getElementById('stance'),
  dissent: document.getElementById('dissent'),
  receipts: document.getElementById('receipts'),
  confidence: document.getElementById('confidence'),
  sample: document.getElementById('sample'),
  hint: document.getElementById('hint'),
  roomStatus: document.getElementById('room-status'),
  roomCount: document.getElementById('room-count'),
  raid: document.getElementById('raid'),
  raidText: document.getElementById('raid-text'),
  scoreStreamer: document.getElementById('score-streamer'),
  scoreChat: document.getElementById('score-chat'),
  voiceLabel: [document.getElementById('voice-label-a'), document.getElementById('voice-label-b')],
  voiceStance: [document.getElementById('voice-stance-a'), document.getElementById('voice-stance-b')],
  voiceReceipts: [document.getElementById('voice-receipts-a'), document.getElementById('voice-receipts-b')],
};

const GLYPHS = ['·', '∙', '•', '◦', '▫', '▪', '▴', '▾', '╱', '╲', '⌁', '✕', '+', '■', '□', '▬', '∴', '∷'];
const COLORS = {
  idle: [206, 216, 236],
  consensus: [124, 231, 255],
  a: [124, 231, 255],
  b: [255, 179, 107],
  unclear: [255, 128, 128],
};

const state = {
  mode: 'idle',
  targetMode: 'cloud',
  answer: null,
  particles: [],
  facePoints: [],
  amplitude: 0,
  speechUntil: 0,
  burst: 0,
  time: 0,
  mute: new URLSearchParams(location.search).has('mute'),
  muted: false,
  ttsProvider: 'client',
  hideTimer: null,
  raidTimer: null,
  color: [...COLORS.idle],
  targetColor: [...COLORS.idle],
  analyser: null,
  audioContext: null,
  pulses: [],
  raf: 0,
};

const view = { w: 0, h: 0, dpr: 1 };

/* ── geometry ────────────────────────────────────────────────────────────── */

function resize() {
  view.dpr = Math.min(2, window.devicePixelRatio || 1);
  view.w = window.innerWidth;
  view.h = window.innerHeight;
  canvas.width = Math.round(view.w * view.dpr);
  canvas.height = Math.round(view.h * view.dpr);
  canvas.style.width = `${view.w}px`;
  canvas.style.height = `${view.h}px`;
  ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
  buildParticles();
  buildFacePoints();
}

function particleCount() {
  const area = view.w * view.h;
  return Math.max(800, Math.min(2000, Math.round(area / 950)));
}

function buildParticles() {
  const count = particleCount();
  const particles = [];
  for (let i = 0; i < count; i += 1) {
    const seed = Math.random();
    particles.push({
      i,
      x: view.w / 2 + (Math.random() - 0.5) * view.w * 0.6,
      y: view.h * 0.42 + (Math.random() - 0.5) * view.h * 0.4,
      vx: 0,
      vy: 0,
      glyph: GLYPHS[Math.floor(Math.random() * GLYPHS.length)],
      phase: seed * Math.PI * 2,
      speed: 0.5 + Math.random() * 1.4,
      size: 9 + Math.random() * 7,
      alpha: 0.25 + Math.random() * 0.5,
      group: i % 2,
      cloudRadius: 0.2 + Math.random() * 0.8,
      color: [...COLORS.idle],
    });
  }
  state.particles = particles;
}

/** Sample a drawn mask into particles, so the face is literally made of glyphs. */
function buildFacePoints() {
  const W = 280;
  const H = 320;
  const off = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(W, H) : document.createElement('canvas');
  off.width = W;
  off.height = H;
  const g = off.getContext('2d');
  g.clearRect(0, 0, W, H);
  g.strokeStyle = '#fff';
  g.fillStyle = '#fff';
  g.lineWidth = 5;
  g.lineCap = 'round';

  // head
  g.beginPath();
  g.ellipse(W / 2, H / 2 - 8, 88, 112, 0, 0, Math.PI * 2);
  g.stroke();
  // eyes
  g.beginPath();
  g.ellipse(W / 2 - 36, H / 2 - 34, 12, 17, -0.08, 0, Math.PI * 2);
  g.fill();
  g.beginPath();
  g.ellipse(W / 2 + 36, H / 2 - 34, 12, 17, 0.08, 0, Math.PI * 2);
  g.fill();
  // nose
  g.beginPath();
  g.moveTo(W / 2, H / 2 - 22);
  g.lineTo(W / 2 - 5, H / 2 + 16);
  g.lineTo(W / 2 + 5, H / 2 + 16);
  g.stroke();
  // mouth: a flat, unimpressed line — this is a crowd, not a mascot
  g.beginPath();
  g.moveTo(W / 2 - 32, H / 2 + 56);
  g.quadraticCurveTo(W / 2, H / 2 + 44, W / 2 + 32, H / 2 + 56);
  g.stroke();
  // jaw
  g.beginPath();
  g.moveTo(W / 2 - 66, H / 2 + 54);
  g.quadraticCurveTo(W / 2, H / 2 + 104, W / 2 + 66, H / 2 + 54);
  g.stroke();

  const data = g.getImageData(0, 0, W, H).data;
  const points = [];
  const step = 2;
  for (let y = 0; y < H; y += step) {
    for (let x = 0; x < W; x += step) {
      if (data[(y * W + x) * 4 + 3] > 90) {
        points.push({ nx: (x - W / 2) / (W / 2), ny: (y - H / 2) / (H / 2) });
      }
    }
  }

  // Shuffle so a particle count smaller than the sampled point count still
  // covers the whole face. Without this, particles index row-by-row and small
  // viewports only ever render the top half of the mask.
  for (let i = points.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [points[i], points[j]] = [points[j], points[i]];
  }
  state.facePoints = points;
}

function faceLayout() {
  const cx = view.w / 2;
  const cy = view.h * 0.37;
  const R = Math.min(view.w, view.h) * 0.2;
  if (state.mode === 'dissent' || state.targetMode === 'dissent') {
    const spread = R * 1.24;
    return {
      split: true,
      faces: [
        { cx: cx - spread / 2, cy, w: R * 0.58, h: R * 0.74 },
        { cx: cx + spread / 2, cy, w: R * 0.58, h: R * 0.74 },
      ],
    };
  }
  return { split: false, faces: [{ cx, cy, w: R * 0.84, h: R * 1.08 }] };
}

/* ── animation ───────────────────────────────────────────────────────────── */

function frame(now) {
  const dt = Math.min(0.05, (now - (state.lastFrame || now)) / 1000);
  state.lastFrame = now;
  state.time += dt;

  updateAudioLevel(now);
  draw(dt);
  state.raf = requestAnimationFrame(frame);
}

function updateAudioLevel(now) {
  if (state.analyser) {
    const data = new Uint8Array(state.analyser.frequencyBinCount);
    state.analyser.getByteTimeDomainData(data);
    let sum = 0;
    for (const value of data) {
      const centered = (value - 128) / 128;
      sum += centered * centered;
    }
    const rms = Math.sqrt(sum / data.length);
    state.amplitude += (Math.min(1, rms * 4.4) - state.amplitude) * 0.35;
  } else if (now < state.speechUntil) {
    const t = (state.speechUntil - now) / 1000;
    state.amplitude = Math.min(1, 0.35 + 0.55 * Math.abs(Math.sin(state.time * 9))) * Math.min(1, t);
  } else {
    state.amplitude *= 1 - 0.12;
  }
  state.burst *= 1 - 0.025;
}

function draw(dt) {
  const { w, h } = view;
  ctx.clearRect(0, 0, w, h);

  drawPulses(dt);

  const layout = faceLayout();
  const facing = state.targetMode === 'face' || state.targetMode === 'dissent';
  const stiffness = facing ? 7.5 : 1.6;
  const cx = w / 2;
  const cy = h * 0.44;
  const baseR = Math.min(w, h) * 0.2;
  const points = state.facePoints;
  const t = state.time;

  ctx.font = '12px ui-monospace, "SF Mono", Menlo, monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  for (const p of state.particles) {
    let tx;
    let ty;
    if (facing && points.length) {
      const pt = points[p.i % points.length];
      const face = layout.split ? layout.faces[p.group % 2] : layout.faces[0];
      tx = face.cx + pt.nx * face.w;
      ty = face.cy + pt.ny * face.h;
      const jitter = 1.1 + state.amplitude * 4.5 + state.burst * 6;
      tx += Math.sin(t * (1.3 + p.speed) + p.phase) * jitter;
      ty += Math.cos(t * (1.1 + p.speed) + p.phase * 1.7) * jitter;
    } else {
      const angle = p.phase + t * 0.16 * p.speed;
      const radius = baseR * (0.16 + Math.pow(p.cloudRadius, 1.5) * 1.08) * (1 + 0.06 * Math.sin(t * 0.4 + p.phase * 2));
      tx = cx + Math.cos(angle) * radius * 1.35;
      ty = cy + Math.sin(angle) * radius * 0.8 + Math.sin(t * 0.5 + p.phase * 3) * 10;
    }

    const spring = 1 - Math.exp(-dt * stiffness);
    p.vx += (tx - p.x) * spring;
    p.vy += (ty - p.y) * spring;
    p.vx *= 0.86;
    p.vy *= 0.86;
    p.x += p.vx * dt * 60;
    p.y += p.vy * dt * 60;

    const targetColor =
      state.targetMode === 'dissent' ? (p.group ? COLORS.b : COLORS.a) : COLORS[state.targetColorKey] || COLORS.idle;
    const colorK = 1 - Math.exp(-dt * 4);
    for (let c = 0; c < 3; c += 1) p.color[c] += (targetColor[c] - p.color[c]) * colorK;
    const [r, g, b] = p.color;
    const hot = state.amplitude * 0.25;
    const alpha = Math.min(0.95, p.alpha * (facing ? 1.35 : 0.8) + hot * p.alpha);
    ctx.fillStyle = `rgba(${Math.min(255, r + hot * 120)}, ${Math.min(255, g + hot * 110)}, ${Math.min(255, b + hot * 90)}, ${alpha})`;
    const size = p.size * (1 + state.amplitude * 0.14 + state.burst * 0.25);
    ctx.font = `${size.toFixed(0)}px ui-monospace, "SF Mono", Menlo, monospace`;
    ctx.fillText(p.glyph, p.x, p.y);
  }

  if (state.targetMode === 'dissent') drawCrack(layout);
}

function drawPulses(dt) {
  for (let i = state.pulses.length - 1; i >= 0; i -= 1) {
    const pulse = state.pulses[i];
    pulse.life += dt;
    if (pulse.life > 1.6) {
      state.pulses.splice(i, 1);
      continue;
    }
    const k = pulse.life / 1.6;
    ctx.beginPath();
    ctx.arc(pulse.x, pulse.y, 8 + k * 46, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(124, 231, 255, ${0.28 * (1 - k)})`;
    ctx.lineWidth = 1;
    ctx.stroke();
  }
}

function drawCrack(layout) {
  const [left, right] = layout.faces;
  const x = (left.cx + right.cx) / 2;
  const top = left.cy - left.h * 1.05;
  const bottom = left.cy + left.h * 1.05;
  const steps = 11;
  const jitterAt = (i) => Math.sin(i * 2.7 + state.time * 1.6) * 8 + (i % 2 ? 5 : -5);
  for (const [color, offset] of [
    ['rgba(124, 231, 255, 0.5)', -1.6],
    ['rgba(255, 179, 107, 0.5)', 1.6],
  ]) {
    ctx.beginPath();
    for (let i = 0; i <= steps; i += 1) {
      const y = top + ((bottom - top) * i) / steps;
      if (i === 0) ctx.moveTo(x + jitterAt(i) + offset, y);
      else ctx.lineTo(x + jitterAt(i) + offset, y);
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.3;
    ctx.stroke();
  }
}

function pulseAt(x, y) {
  state.pulses.push({ x, y, life: 0 });
  if (state.pulses.length > 40) state.pulses.shift();
}

/* ── HUD ─────────────────────────────────────────────────────────────────── */

function setRoom({ chatters = 0, status = 'LISTENING' } = {}) {
  els.roomStatus.textContent = status;
  els.roomCount.textContent = `${chatters} ${chatters === 1 ? 'chatter' : 'chatters'}`;
}

function updateScore(scoreboard) {
  if (!scoreboard) return;
  els.scoreChat.textContent = String(scoreboard.chat ?? 0);
  els.scoreStreamer.textContent = String(scoreboard.streamer ?? 0);
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
  node.style.animationDelay = `${(receipt.delay ?? 0) * 140}ms`;
  return node;
}

function renderReceipts(container, receipts) {
  container.replaceChildren();
  receipts.forEach((receipt, index) => container.append(receiptNode({ ...receipt, delay: index })));
}

function showAnswer(answer) {
  state.answer = answer;
  state.mode = answer.mode;
  clearTimeout(state.hideTimer);

  els.answer.hidden = false;
  els.question.textContent = answer.question || '';
  hud.classList.add('showing');

  const isDissent = answer.mode === 'dissent' && Array.isArray(answer.voices);
  state.targetMode = isDissent ? 'dissent' : answer.mode === 'consensus' ? 'face' : 'cloud';
  state.targetColorKey = isDissent ? 'a' : answer.mode === 'consensus' ? 'consensus' : 'unclear';

  if (isDissent) {
    els.stance.hidden = true;
    els.dissent.hidden = false;
    els.receipts.replaceChildren();
    answer.voices.forEach((voice, index) => {
      els.voiceLabel[index].textContent = voice.label;
      els.voiceStance[index].textContent = voice.stance;
      renderReceipts(els.voiceReceipts[index], voice.receipts);
    });
    els.confidence.textContent = `${answer.split?.a ?? '?'}% vs ${answer.split?.b ?? '?'}%`;
    els.confidence.classList.remove('muted');
    els.hint.textContent = 'the room is split';
  } else {
    els.dissent.hidden = true;
    els.stance.hidden = false;
    els.stance.textContent = answer.stance || '';
    renderReceipts(els.receipts, answer.receipts || []);
    if (answer.confidence == null) {
      els.confidence.textContent = answer.mode === 'insufficient' ? 'not enough signal' : 'no consensus';
      els.confidence.classList.add('muted');
    } else {
      els.confidence.textContent = `${answer.confidence}% confidence`;
      els.confidence.classList.remove('muted');
    }
    els.hint.textContent = answer.provider === 'local' ? 'measured · local voice' : 'measured · model voice';
  }

  els.sample.textContent = `${answer.chatters} chatters · ${answer.basis?.messages ?? 0} messages${
    answer.basis?.removed ? ` · ${answer.basis.removed} scrubbed` : ''
  }`;

  speak(answer);

  state.hideTimer = setTimeout(() => {
    hud.classList.remove('showing');
    els.answer.hidden = true;
    state.mode = 'idle';
    state.targetMode = 'cloud';
    state.targetColorKey = 'idle';
    els.hint.textContent = 'waiting for the streamer';
  }, 24000);
}

function startForming(event) {
  clearTimeout(state.hideTimer);
  state.mode = 'forming';
  state.targetMode = 'face';
  state.targetColorKey = 'consensus';
  els.answer.hidden = true;
  els.hint.textContent = 'listening…';
  hud.classList.add('showing');
  for (let i = 0; i < 14; i += 1) {
    pulseAt(view.w / 2 + (Math.random() - 0.5) * view.w * 0.5, view.h * 0.36 + (Math.random() - 0.5) * view.h * 0.25);
  }
  if (event?.question) els.question.textContent = event.question;
}

function showRaid(event) {
  const label = event.kind === 'raid' ? `RAID · ${event.viewers} from @${event.from}` : `NEW SUB · @${event.from}`;
  els.raidText.textContent = label;
  els.raid.hidden = false;
  state.burst = 1;
  clearTimeout(state.raidTimer);
  state.raidTimer = setTimeout(() => {
    els.raid.hidden = true;
  }, 5200);
  for (let i = 0; i < 20; i += 1) {
    pulseAt(view.w / 2 + (Math.random() - 0.5) * view.w * 0.7, view.h * 0.3 + (Math.random() - 0.5) * view.h * 0.2);
  }
}

/* ── voice ───────────────────────────────────────────────────────────────── */

async function speak(answer) {
  if (state.muted || state.mute) return;
  const text =
    answer.mode === 'dissent' && answer.voices
      ? answer.voices.map((voice) => voice.stance).join(' … ')
      : answer.stance || '';
  if (!text) return;

  state.speechUntil = Date.now() + Math.min(9000, Math.max(1800, text.length * 62));

  if (state.ttsProvider === 'openai') {
    try {
      const response = await fetch(`/api/tts?text=${encodeURIComponent(text)}`);
      if (!response.ok) throw new Error(`tts ${response.status}`);
      const blob = await response.blob();
      const audio = new Audio(URL.createObjectURL(blob));
      await playWithAnalyser(audio);
      return;
    } catch {
      /* fall through to the browser voice */
    }
  }
  speakBrowser(text);
}

function speakBrowser(text) {
  if (!('speechSynthesis' in window)) return;
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.rate = 1.02;
  utterance.pitch = 0.82;
  utterance.volume = 0.9;
  const voice = window.speechSynthesis
    .getVoices()
    .find((candidate) => /en[-_](US|GB)/i.test(candidate.lang) && /male|daniel|alex|google uk english male/i.test(candidate.name));
  if (voice) utterance.voice = voice;
  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(utterance);
}

async function playWithAnalyser(audio) {
  if (!state.audioContext) state.audioContext = new AudioContext();
  await state.audioContext.resume();
  const source = state.audioContext.createMediaElementSource(audio);
  const analyser = state.audioContext.createAnalyser();
  analyser.fftSize = 512;
  source.connect(analyser);
  analyser.connect(state.audioContext.destination);
  state.analyser = analyser;
  audio.onended = () => {
    state.analyser = null;
  };
  await audio.play();
}

/* ── live data ───────────────────────────────────────────────────────────── */

async function refreshState() {
  try {
    const response = await fetch('/api/state', { cache: 'no-store' });
    const data = await response.json();
    const last = data.session?.lastAnswer;
    if (last && !state.answer && Date.now() - Date.parse(last.at) < 30000) {
      // OBS reconnects and page reloads should not lose the current answer.
      showAnswer(last);
    }
    setRoom({
      chatters: data.session?.stats?.chatters ?? 0,
      status:
        data.connection?.status === 'connected'
          ? 'LIVE'
          : data.connection?.status === 'replay'
            ? 'REPLAY'
            : data.connection?.status === 'sample'
              ? 'SAMPLE'
              : 'LISTENING',
    });
    updateScore(data.session?.scoreboard);
    state.ttsProvider = data.tts?.provider ?? 'client';
  } catch {
    /* the overlay keeps animating even if the server blips */
  }
}

async function connect() {
  await refreshState();
  setInterval(refreshState, 6000);

  const source = new EventSource('/api/events');
  source.addEventListener('hello', (event) => {
    const data = JSON.parse(event.data);
    updateScore(data.state?.scoreboard);
    state.ttsProvider = data.config?.tts ?? 'client';
    setRoom({
      chatters: data.state?.stats?.chatters ?? 0,
      status: data.connection?.status === 'sample' ? 'SAMPLE' : data.connection?.status === 'replay' ? 'REPLAY' : 'LIVE',
    });
  });
  source.addEventListener('trigger:start', (event) => startForming(JSON.parse(event.data)));
  source.addEventListener('answer', (event) => showAnswer(JSON.parse(event.data)));
  source.addEventListener('chat', () => {
    pulseAt(view.w / 2 + (Math.random() - 0.5) * view.w * 0.55, view.h * 0.34 + (Math.random() - 0.5) * view.h * 0.3);
  });
  source.addEventListener('hype', (event) => showRaid(JSON.parse(event.data)));
  source.addEventListener('score', (event) => updateScore(JSON.parse(event.data)));
  source.onerror = () => {
    /* EventSource retries on its own */
  };
}

/* ── boot ────────────────────────────────────────────────────────────────── */

window.addEventListener('resize', resize);
window.addEventListener('keydown', (event) => {
  if (event.key.toLowerCase() === 'm') state.muted = !state.muted;
});
window.addEventListener('pointerdown', () => {
  if (state.audioContext?.state === 'suspended') state.audioContext.resume();
});

if (new URLSearchParams(location.search).has('stage')) {
  document.body.classList.add('stage');
}

resize();
state.raf = requestAnimationFrame(frame);
connect();

// Expose a tiny handle for OBS/Stream Deck browser-source testing.
window.acclamation = {
  show: (answer) => showAnswer(answer),
  raid: (event) => showRaid(event),
  mute: (value) => {
    state.muted = Boolean(value);
  },
};
