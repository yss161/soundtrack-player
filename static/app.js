/* ════════════════════════════════════════════════════════════════
   声轨 Soundtrack · 前端逻辑
   流式搜索(SSE) / 播放队列 / 收藏 / 歌词 / 下载 / 频谱 / 媒体键
   ════════════════════════════════════════════════════════════════ */
'use strict';

/* ------------------------------------------------------------------ */
/* 工具                                                                */
/* ------------------------------------------------------------------ */
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmtTime = (s) => {
  if (!isFinite(s) || s < 0) return '0:00';
  s = Math.floor(s);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
const mb = (b) => ((b || 0) / 1048576).toFixed(1) + ' MB';
const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};
const norm = (s) => String(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();

/* ------------------------------------------------------------------ */
/* 全局状态                                                             */
/* ------------------------------------------------------------------ */
const audio = $('#audio');
const state = {
  sources: [],                  // [{id,label,short,default,color}]
  srcColors: {},                // short -> 品牌色
  tracks: new Map(),            // token -> payload
  queue: [],                    // 播放队列 (token 数组)
  queueIndex: -1,
  loopMode: store.get('st-loop', 'list'),   // list | one | shuffle
  favorites: store.get('st-favs', []),      // payload 数组
  history: store.get('st-history', []),     // 关键词数组
  keyword: '',
  searchES: null,
  searchSeq: 0,
  view: 'search',
  consecutiveErrors: 0,
};

/* ------------------------------------------------------------------ */
/* 提示气泡                                                             */
/* ------------------------------------------------------------------ */
function toast(msg, isErr = false) {
  const box = $('#toast-box');
  const el = document.createElement('div');
  el.className = 'toast' + (isErr ? ' err' : '');
  el.textContent = msg;
  box.appendChild(el);
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 320); }, 2600);
  while (box.children.length > 3) box.firstChild.remove();
}

/* ------------------------------------------------------------------ */
/* 音源芯片                                                             */
/* ------------------------------------------------------------------ */
async function loadSources() {
  try {
    state.sources = await fetch('/api/sources').then((r) => r.json());
  } catch {
    toast('无法加载音源列表', true);
    return;
  }
  // short -> 品牌色 映射，行内来源标签着色用
  state.srcColors = Object.fromEntries(state.sources.map((s) => [s.short, s.color || '#7c6cff']));
  // 恢复上次保存的音源选择（无记录时用默认配置）
  const saved = store.get('st-sources', null);
  const savedSet = Array.isArray(saved) && saved.length ? new Set(saved) : null;
  const wrap = $('#source-chips');
  wrap.innerHTML = '';
  state.sources.forEach((src) => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip' + ((savedSet ? savedSet.has(src.id) : src.default) ? ' on' : '');
    chip.dataset.id = src.id;
    chip.style.setProperty('--src', src.color || '#7c6cff');
    chip.style.setProperty('--src-soft', (src.color || '#7c6cff') + '2b');
    chip.innerHTML = `<span class="dot"></span>${esc(src.label)}`;
    chip.onclick = () => {
      chip.classList.toggle('on');
      if (!$$('.chip.on').length) { chip.classList.add('on'); toast('至少启用一个音源'); }
      persistSources();
    };
    wrap.appendChild(chip);
  });
  // 兜底: 一条记录都没匹配上时启用默认源
  if (!$$('.chip.on').length) {
    const def = state.sources.find((s) => s.default);
    if (def) wrap.querySelector(`[data-id="${def.id}"]`)?.classList.add('on');
  }
  persistSources();
}
function persistSources() {
  store.set('st-sources', $$('.chip.on').map((c) => c.dataset.id));
}
const srcColor = (short) => state.srcColors?.[short] || '#7c6cff';
const activeSources = () => $$('.chip.on').map((c) => c.dataset.id);

/* ------------------------------------------------------------------ */
/* 搜索（SSE 流式）                                                      */
/* ------------------------------------------------------------------ */
$('#search-form').addEventListener('submit', (e) => { e.preventDefault(); runSearch($('#search-input').value.trim()); });

function pushHistory(kw) {
  state.history = [kw, ...state.history.filter((k) => k !== kw)].slice(0, 10);
  store.set('st-history', state.history);
}

function runSearch(kw, opts = {}) {
  if (!kw) return;
  $('#search-input').value = kw;
  $('#history-panel').classList.add('hidden');
  if (state.searchES) { state.searchES.close(); state.searchES = null; }
  if (!opts.silent) pushHistory(kw);
  switchView('search');

  state.keyword = kw;
  state.searchSeq += 1;
  const mySeq = state.searchSeq;

  $('#welcome').classList.add('hidden');
  $('#results').classList.remove('hidden');
  $('#results-kw').textContent = `“${kw}”`;
  $('#track-list').innerHTML = '';
  $('#results-empty').classList.add('hidden');
  $('#results-count').textContent = '';
  $('#btn-playall').disabled = true;
  $('#searching-indicator').classList.remove('hidden');
  $('#search-btn').disabled = true;

  const srcs = activeSources();
  const statusBox = $('#source-status');
  statusBox.innerHTML = '';
  const statusMap = {};
  srcs.forEach((sid) => {
    const label = state.sources.find((s) => s.id === sid)?.label || sid;
    const el = document.createElement('span');
    el.className = 'src-status searching';
    el.style.setProperty('--src', srcColor(state.sources.find((s) => s.id === sid)?.short));
    el.innerHTML = `<span class="st-dot"></span>${esc(label)} <span class="st-cnt">…</span>`;
    statusBox.appendChild(el);
    statusMap[sid] = el;
  });

  let count = 0;
  let finished = false;
  const es = new EventSource(`/api/search?q=${encodeURIComponent(kw)}&sources=${srcs.join(',')}`);
  state.searchES = es;

  es.addEventListener('result', (ev) => {
    if (mySeq !== state.searchSeq) { es.close(); return; }
    const t = JSON.parse(ev.data);
    state.tracks.set(t.token, t);
    appendTrackRow($('#track-list'), t);
    count++;
    $('#results-count').textContent = `已找到 ${count} 首`;
    if (count === 1) $('#btn-playall').disabled = false;
  });
  es.addEventListener('source_done', (ev) => {
    if (mySeq !== state.searchSeq) return;
    const d = JSON.parse(ev.data);
    const el = statusMap[d.source];
    if (!el) return;
    el.classList.remove('searching');
    el.classList.add(d.timed_out ? 'timeout' : 'done');
    el.querySelector('.st-cnt').textContent = d.timed_out ? `超时 ${d.count} 首` : `${d.count} 首`;
  });
  es.addEventListener('source_error', (ev) => {
    if (mySeq !== state.searchSeq) return;
    const d = JSON.parse(ev.data);
    const el = statusMap[d.source];
    if (!el) return;
    el.classList.remove('searching');
    el.classList.add('error');
    el.querySelector('.st-cnt').textContent = '出错';
  });
  es.addEventListener('done', () => {
    if (mySeq !== state.searchSeq) return;
    finished = true;
    es.close(); state.searchES = null;
    endSearchUI(count);
  });
  es.onerror = () => {
    if (mySeq !== state.searchSeq || finished) return;
    es.close(); state.searchES = null;
    endSearchUI(count);
    if (!count) toast('搜索连接中断，请重试', true);
  };
}

function endSearchUI(count) {
  $('#search-btn').disabled = false;
  $('#searching-indicator').classList.add('hidden');
  $('#results-count').textContent = count ? `共 ${count} 首` : '';
  if (!count) $('#results-empty').classList.remove('hidden');
}

/* ------------------------------------------------------------------ */
/* 曲目行渲染（搜索 / 收藏共用）                                          */
/* ------------------------------------------------------------------ */
function isFaved(t) {
  return state.favorites.some((f) => f.song_name === t.song_name && f.singers === t.singers);
}

function trackRowHTML(t, idx) {
  const cover = t.cover_url
    ? `<img src="/api/cover/${t.token}" loading="lazy" onerror="this.remove()">`
    : '';
  const sc = srcColor(t.source);
  return `
    <span class="t-idx"><span class="idx-num">${idx}</span><span class="row-eq"><i></i><i></i><i></i></span></span>
    <span class="t-song">
      <span class="t-cover">${cover}♪</span>
      <span class="t-meta">
        <span class="t-name">${esc(t.song_name)}
          ${t.lossless ? '<span class="badge lossless">无损</span>' : ''}
          ${t.ext && !t.lossless ? `<span class="badge ext">${esc(t.ext.toUpperCase())}</span>` : ''}
          <span class="src-tag" style="--src:${sc};--src-soft:${sc}2b">${esc(t.source)}</span>
        </span>
        <span class="t-artists">${esc(t.singers)}</span>
      </span>
    </span>
    <span class="t-album" title="${esc(t.album)}">${esc(t.album) || '—'}</span>
    <span class="t-dur">${esc(t.duration) || '—'}</span>
    <span class="t-size ${t.lossless ? 'lossless' : ''}">${esc(t.file_size) || '—'}</span>
    <span class="t-act-box">
      <button class="act-btn a-fav ${isFaved(t) ? 'faved' : ''}" title="收藏">♥</button>
      <button class="act-btn a-dl" title="下载">⭳</button>
      <button class="act-btn a-play" title="播放">▶</button>
    </span>`;
}

function appendTrackRow(listEl, t, opts = {}) {
  const li = document.createElement('li');
  li.className = 'track-row';
  li.dataset.token = t.token;
  li.innerHTML = trackRowHTML(t, opts.index ?? listEl.children.length + 1);
  li.querySelector('.a-play').onclick = (e) => { e.stopPropagation(); playToken(t.token, { fromFavorites: opts.fromFavorites }); };
  li.querySelector('.a-dl').onclick = (e) => { e.stopPropagation(); startDownload(t.token); };
  li.querySelector('.a-fav').onclick = (e) => { e.stopPropagation(); toggleFavorite(t, e.currentTarget, opts.listKind); };
  li.ondblclick = () => playToken(t.token, { fromFavorites: opts.fromFavorites });
  listEl.appendChild(li);
  syncPlayingRow();
}

function syncPlayingRow() {
  const cur = currentToken();
  $$('.track-row').forEach((r) => r.classList.toggle('playing', r.dataset.token === cur));
}

/* ------------------------------------------------------------------ */
/* 收藏                                                                 */
/* ------------------------------------------------------------------ */
function toggleFavorite(t, btn, listKind) {
  const i = state.favorites.findIndex((f) => f.song_name === t.song_name && f.singers === t.singers);
  if (i >= 0) {
    state.favorites.splice(i, 1);
    toast('已取消收藏');
  } else {
    state.favorites.unshift({ ...t });
    toast('♥ 已加入收藏');
  }
  store.set('st-favs', state.favorites);
  if (btn) btn.classList.toggle('faved', i < 0);
  refreshFavBadge();
  if (listKind === 'favorites') renderFavorites();
}

function refreshFavBadge() {
  const b = $('#fav-badge');
  b.textContent = state.favorites.length;
  b.classList.toggle('hidden', !state.favorites.length);
  b.classList.toggle('on', !!state.favorites.length);
}

function renderFavorites() {
  const list = $('#fav-list');
  list.innerHTML = '';
  $('#fav-empty').classList.toggle('hidden', !!state.favorites.length);
  $('#fav-count').textContent = state.favorites.length ? `共 ${state.favorites.length} 首` : '';
  // 把收藏的曲目重新登记进 tracks Map（token 可能过期，播放时会自动续期）
  state.favorites.forEach((t) => { state.tracks.set(t.token, t); });
  state.favorites.forEach((t, i) => appendTrackRow(list, t, { index: i + 1, fromFavorites: true, listKind: 'favorites' }));
}

$('#fav-playall').onclick = () => {
  if (!state.favorites.length) return toast('收藏夹是空的');
  state.queue = state.favorites.map((t) => t.token);
  refreshQueueBadge();
  playQueueIndex(0, { fromFavorites: true });
};

/* ------------------------------------------------------------------ */
/* 搜索历史                                                             */
/* ------------------------------------------------------------------ */
function renderHistory() {
  const list = $('#history-list');
  list.innerHTML = '';
  if (!state.history.length) {
    list.innerHTML = '<li style="color:var(--text-3);cursor:default">暂无搜索记录</li>';
    return;
  }
  state.history.forEach((kw) => {
    const li = document.createElement('li');
    li.textContent = kw;
    li.onclick = () => runSearch(kw);
    list.appendChild(li);
  });
}
$('#search-input').addEventListener('focus', () => {
  renderHistory();
  $('#history-panel').classList.remove('hidden');
});
$('#search-input').addEventListener('blur', () => setTimeout(() => $('#history-panel').classList.add('hidden'), 180));
$('#history-clear').onclick = () => { state.history = []; store.set('st-history', []); renderHistory(); };

/* ════════════════════════════════════════════════════════════════ */
/* 播放器核心                                                          */
/* ════════════════════════════════════════════════════════════════ */
const currentToken = () => (state.queueIndex >= 0 ? state.queue[state.queueIndex] : null);
const currentTrack = () => state.tracks.get(currentToken());

function playToken(token, opts = {}) {
  const i = state.queue.indexOf(token);
  if (i >= 0) state.queueIndex = i;
  else { state.queue.push(token); state.queueIndex = state.queue.length - 1; }
  playQueueIndex(state.queueIndex, opts);
}

function playQueueIndex(i, opts = {}) {
  if (i < 0 || i >= state.queue.length) return;
  state.queueIndex = i;
  const token = state.queue[i];
  const t = state.tracks.get(token);
  if (!t) { toast('曲目信息已失效', true); return; }
  ensureAudioGraph();
  if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
  audio.src = `/api/stream/${token}`;
  audio.play().catch(() => {
    // 直链可能过期（收藏等场景），尝试自动重新搜索续期
    if (opts.retried !== true) reviveAndPlay(t);
    else toast('无法播放该曲目', true);
  });
  applyNowPlaying(t);
  refreshQueueView();
}

function applyNowPlaying(t) {
  $('#player').dataset.empty = 'false';
  $('#player-title').textContent = t.song_name;
  $('#player-artist').textContent = `${t.singers} · ${t.source_label || t.source}`;
  $('#now-mini-text').textContent = `${t.song_name} - ${t.singers}`;
  const cv = $('#player-cover');
  cv.innerHTML = t.cover_url
    ? `<img src="/api/cover/${t.token}" onerror="this.style.display='none';this.nextElementSibling.style.display='grid'"><span class="cover-fallback" style="display:none">♪</span>`
    : '<span class="cover-fallback">♪</span>';
  syncPlayingRow();
  updateMediaSession(t);
  loadLyrics(t.token);
  // 歌词面板同步
  $('#lyrics-cover').src = t.cover_url ? `/api/cover/${t.token}` : '';
  $('#lyrics-cover').style.display = t.cover_url ? '' : 'none';
  $('#lyrics-song').textContent = t.song_name;
  $('#lyrics-artist').textContent = t.singers;
}

function step(dir) {
  if (!state.queue.length) return;
  if (state.loopMode === 'shuffle' && dir === 1) {
    if (state.queue.length === 1) { replay(); return; }
    let j = state.queueIndex;
    while (j === state.queueIndex) j = Math.floor(Math.random() * state.queue.length);
    playQueueIndex(j);
    return;
  }
  let next = state.queueIndex + dir;
  if (next < 0) next = state.queue.length - 1;
  if (next >= state.queue.length) next = 0;
  playQueueIndex(next);
}
const replay = () => { audio.currentTime = 0; audio.play().catch(() => {}); };

/* 过期曲目自动续期: 用歌名+歌手重新搜索并自动匹配 */
function reviveAndPlay(t) {
  toast('链接已过期，正在重新搜索…');
  const kw = `${t.song_name} ${t.singers}`;
  return new Promise((resolve) => {
    const found = [];
    let done = false;
    const es = new EventSource(`/api/search?q=${encodeURIComponent(kw)}&sources=${activeSources().join(',')}`);
    const timer = setTimeout(() => { done = true; es.close(); finish(); }, 18000);
    const finish = () => {
      clearTimeout(timer);
      const match = found.find((r) => norm(r.song_name) === norm(t.song_name))
        || found.find((r) => norm(r.song_name).includes(norm(t.song_name)) || norm(t.song_name).includes(norm(r.song_name)))
        || found[0];
      if (match) {
        state.tracks.set(match.token, match);
        const i = state.queue.indexOf(t.token);
        if (i >= 0) state.queue[i] = match.token;
        else { state.queue.push(match.token); state.queueIndex = state.queue.length - 1; }
        // 更新收藏里的 token
        const fi = state.favorites.findIndex((f) => f.song_name === t.song_name && f.singers === t.singers);
        if (fi >= 0) { state.favorites[fi] = { ...state.favorites[fi], ...match }; store.set('st-favs', state.favorites); }
        if (state.view === 'search') appendOrUpdateRow(match);
        playQueueIndex(state.queueIndex, { retried: true });
      } else {
        toast('自动续期失败，请手动重新搜索', true);
      }
      resolve();
    };
    es.addEventListener('result', (ev) => found.push(JSON.parse(ev.data)));
    es.addEventListener('done', () => { if (!done) { done = true; es.close(); setTimeout(finish, 300); } });
    es.onerror = () => { if (!done) { done = true; es.close(); finish(); } };
  });
}
function appendOrUpdateRow(t) {
  // 简单处理: 追加新行即可（重复由后端 identifier 去重兜底）
  if (!$(`.track-row[data-token="${t.token}"]`)) appendTrackRow($('#track-list'), t);
}

/* 播放/暂停按钮 */
$('#btn-play').onclick = () => {
  if (!currentToken()) {
    if (state.queue.length) playQueueIndex(0);
    else if ($('#track-list').children.length) $('#btn-playall').click();
    return;
  }
  if (audio.paused) { if (audioCtx?.state === 'suspended') audioCtx.resume(); audio.play().catch(() => {}); }
  else audio.pause();
};
$('#btn-prev').onclick = () => step(-1);
$('#btn-next').onclick = () => step(1);
$('#btn-playall').onclick = () => {
  const tokens = $$('#track-list .track-row').map((r) => r.dataset.token);
  if (!tokens.length) return;
  state.queue = tokens;
  refreshQueueBadge();
  playQueueIndex(0);
};

/* audio 事件 */
audio.addEventListener('play', () => { syncPlayIcon(true); document.body.classList.add('playing'); document.body.classList.remove('paused'); updateMediaSessionPlayback(); });
audio.addEventListener('pause', () => { syncPlayIcon(false); document.body.classList.remove('playing'); document.body.classList.add('paused'); updateMediaSessionPlayback(); });
audio.addEventListener('ended', () => {
  if (state.loopMode === 'one') { replay(); return; }
  step(1);
});
audio.addEventListener('loadedmetadata', () => { $('#time-total').textContent = fmtTime(audio.duration); });
audio.addEventListener('timeupdate', () => {
  if (scrubbing) return;
  const d = audio.duration || 0, c = audio.currentTime || 0;
  $('#time-cur').textContent = fmtTime(c);
  const p = d ? (c / d) * 100 : 0;
  $('#seek-fill').style.width = p + '%';
  $('#seek-thumb').style.left = p + '%';
  syncLyric(c);
});
audio.addEventListener('progress', () => {
  try {
    if (audio.buffered.length && audio.duration) {
      const end = audio.buffered.end(audio.buffered.length - 1);
      $('#seek-buffer').style.width = ((end / audio.duration) * 100) + '%';
    }
  } catch {}
});
audio.addEventListener('error', () => {
  if (!audio.src) return;
  state.consecutiveErrors++;
  if (state.consecutiveErrors >= 5) { toast('连续播放失败，已停止自动切歌', true); state.consecutiveErrors = 0; return; }
  toast('播放出错，尝试下一首…', true);
  setTimeout(() => step(1), 600);
});
audio.addEventListener('playing', () => { state.consecutiveErrors = 0; });

function syncPlayIcon(playing) {
  // SVG 元素不支持 hidden 属性，改用类切换（CSS 控制两图标互斥显示）
  $('#btn-play').classList.toggle('playing', playing);
  const mini = $('.now-mini');
  if (mini) mini.classList.toggle('paused', !playing);
}

/* ── 播放模式 ── */
const LOOP_META = {
  list: { icon: '🔁', title: '播放模式：列表循环' },
  one: { icon: '🔂', title: '播放模式：单曲循环' },
  shuffle: { icon: '🔀', title: '播放模式：随机播放' },
};
function applyLoopMode() {
  const m = LOOP_META[state.loopMode];
  $('#btn-loop').textContent = m.icon;
  $('#btn-loop').title = m.title;
  $('#btn-loop').classList.toggle('active', state.loopMode !== 'list');
}
$('#btn-loop').onclick = () => {
  state.loopMode = { list: 'one', one: 'shuffle', shuffle: 'list' }[state.loopMode];
  store.set('st-loop', state.loopMode);
  applyLoopMode();
  toast($('#btn-loop').title);
};

/* ── 进度条 / 音量条（指针拖动） ── */
let scrubbing = false;
function bindSlider(barEl, { onRatio, onPreview, onEnd }) {
  const ratioFromEvent = (e) => {
    const rect = barEl.getBoundingClientRect();
    return Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
  };
  barEl.addEventListener('pointerdown', (e) => {
    barEl.setPointerCapture(e.pointerId);
    const move = (ev) => { const r = ratioFromEvent(ev); onRatio(r); onPreview && onPreview(r); };
    move(e);
    const up = (ev) => {
      barEl.removeEventListener('pointermove', move);
      barEl.removeEventListener('pointerup', up);
      barEl.removeEventListener('pointercancel', up);
      onEnd && onEnd(ratioFromEvent(ev));
    };
    barEl.addEventListener('pointermove', move);
    barEl.addEventListener('pointerup', up);
    barEl.addEventListener('pointercancel', up);
  });
}
bindSlider($('#seek-bar'), {
  onRatio: (r) => {
    scrubbing = true;
    const p = r * 100;
    $('#seek-fill').style.width = p + '%';
    $('#seek-thumb').style.left = p + '%';
    if (audio.duration) $('#time-cur').textContent = fmtTime(r * audio.duration);
  },
  onEnd: (r) => {
    scrubbing = false;
    if (audio.duration) audio.currentTime = r * audio.duration;
  },
});

/* ── 音量 ── */
let lastVolume = store.get('st-volume', 0.8);
let muted = false;
function applyVolume() {
  audio.volume = muted ? 0 : lastVolume;
  $('#volume-fill').style.width = ((muted ? 0 : lastVolume) * 100) + '%';
  $('#volume-thumb').style.left = ((muted ? 0 : lastVolume) * 100) + '%';
  $('#btn-mute').classList.toggle('muted', muted || lastVolume === 0);
}
bindSlider($('#volume-bar'), {
  onRatio: (r) => { muted = false; lastVolume = Math.round(r * 100) / 100; store.set('st-volume', lastVolume); applyVolume(); },
});
$('#btn-mute').onclick = () => { muted = !muted; applyVolume(); };
applyVolume();

/* ------------------------------------------------------------------ */
/* Web Audio 频谱                                                       */
/* ------------------------------------------------------------------ */
let audioCtx = null, analyser = null, freqData = null;
function ensureAudioGraph() {
  if (audioCtx) return;
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    audioCtx = new AC();
    const srcNode = audioCtx.createMediaElementSource(audio);
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 128;
    analyser.smoothingTimeConstant = 0.82;
    srcNode.connect(analyser);
    analyser.connect(audioCtx.destination);
    freqData = new Uint8Array(analyser.frequencyBinCount);
    drawSpectrum();
  } catch {
    audioCtx = null; // 频谱失败不影响播放
  }
}
function drawSpectrum() {
  const canvas = $('#spectrum');
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const W = canvas.width = 150 * dpr, H = canvas.height = 36 * dpr;
  const grad = ctx.createLinearGradient(0, 0, W, 0);
  grad.addColorStop(0, '#7c6cff');
  grad.addColorStop(1, '#22d3ee');
  const bars = 26, gap = 2 * dpr, bw = (W - gap * (bars - 1)) / bars;
  // 平滑数组: 播放/暂停切换时柱形缓入缓出（上升快、衰减慢）
  const smoothed = new Array(bars).fill(0);
  const render = () => {
    requestAnimationFrame(render);
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = grad;
    let data = null;
    if (analyser && !audio.paused) { analyser.getByteFrequencyData(freqData); data = freqData; }
    for (let i = 0; i < bars; i++) {
      const raw = data
        ? (data[Math.floor(i * data.length * 0.72 / bars)] / 255)
        : 0.05 + 0.04 * Math.abs(Math.sin(Date.now() / 700 + i * 0.7));
      const k = raw > smoothed[i] ? 0.4 : 0.09;   // 攻击快、释放慢
      smoothed[i] += (raw - smoothed[i]) * k;
      const bh = Math.max(2 * dpr, smoothed[i] * H);
      const x = i * (bw + gap), y = (H - bh) / 2;
      ctx.beginPath();
      const r = Math.min(bw / 2, 1.6 * dpr);
      ctx.roundRect ? ctx.roundRect(x, y, bw, bh, r) : ctx.rect(x, y, bw, bh);
      ctx.fill();
    }
  };
  render();
}

/* ------------------------------------------------------------------ */
/* 歌词                                                                 */
/* ------------------------------------------------------------------ */
let lyricLines = [], lyricActive = -1;
async function loadLyrics(token) {
  lyricLines = []; lyricActive = -1;
  const box = $('#lyrics-container');
  box.innerHTML = '<div class="lr-empty">加载歌词…</div>';
  try {
    const { lyric } = await fetch(`/api/lyric/${token}`).then((r) => r.json());
    lyricLines = parseLRC(lyric);
    if (!lyricLines.length) { box.innerHTML = '<div class="lr-empty">暂无歌词</div>'; return; }
    box.innerHTML = '';
    lyricLines.forEach((l, i) => {
      const d = document.createElement('div');
      d.className = 'lr';
      d.dataset.i = i;
      d.textContent = l.text;
      d.onclick = () => { if (audio.duration) { audio.currentTime = l.t; if (audio.paused) audio.play().catch(() => {}); } };
      box.appendChild(d);
    });
    // 歌词就绪后立即定位到当前播放行（音频暂停时不会有 timeupdate 触发 syncLyric）
    syncLyric(audio.currentTime || 0);
  } catch {
    box.innerHTML = '<div class="lr-empty">暂无歌词</div>';
  }
}
function parseLRC(text) {
  if (!text) return [];
  const out = [];
  for (const line of String(text).split('\n')) {
    const times = [...line.matchAll(/\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\]/g)];
    const content = line.replace(/\[[^\]]*\]/g, '').trim();
    if (!content) continue;
    for (const m of times) {
      out.push({ t: (+m[1]) * 60 + (+m[2]) + (m[3] ? +('0.' + m[3]) : 0), text: content });
    }
  }
  return out.sort((a, b) => a.t - b.t);
}
function syncLyric(c) {
  if (!lyricLines.length) return;
  let idx = -1;
  for (let i = 0; i < lyricLines.length; i++) { if (lyricLines[i].t <= c + 0.25) idx = i; else break; }
  if (idx === lyricActive) return;
  lyricActive = idx;
  const box = $('#lyrics-container');
  box.querySelectorAll('.lr.active').forEach((e) => e.classList.remove('active'));
  const el = box.querySelector(`.lr[data-i="${idx}"]`);
  if (el) {
    el.classList.add('active');
    if ($('#lyrics-panel').classList.contains('open')) {
      const scroll = $('#lyrics-scroll');
      const top = el.offsetTop - scroll.clientHeight / 2 + el.clientHeight / 2;
      scroll.scrollTo({ top, behavior: 'smooth' });
    }
  }
}
function toggleLyricsPanel(force) {
  const p = $('#lyrics-panel');
  const open = force !== undefined ? force : !p.classList.contains('open');
  p.classList.toggle('open', open);
  $('#btn-lyrics').classList.toggle('active', open);
  if (open) {
    const el = $('#lyrics-container .lr.active');
    if (el) $('#lyrics-scroll').scrollTo({ top: el.offsetTop - $('#lyrics-scroll').clientHeight / 2, behavior: 'smooth' });
  }
}
$('#btn-lyrics').onclick = () => toggleLyricsPanel();
$('#lyrics-close').onclick = () => toggleLyricsPanel(false);
$('#player-left').onclick = () => toggleLyricsPanel();

/* ------------------------------------------------------------------ */
/* 播放队列                                                             */
/* ------------------------------------------------------------------ */
function refreshQueueBadge() {
  const b = $('#queue-badge');
  b.textContent = state.queue.length;
  b.classList.toggle('hidden', !state.queue.length);
  if (state.view === 'queue') refreshQueueView();
}
function refreshQueueView() {
  const list = $('#queue-list');
  const cur = currentToken();
  list.innerHTML = '';
  $('#queue-empty').classList.toggle('hidden', !!state.queue.length);
  $('#queue-count').textContent = state.queue.length ? `${state.queueIndex + 1} / ${state.queue.length}` : '';
  state.queue.forEach((token, i) => {
    const t = state.tracks.get(token);
    if (!t) return;
    const li = document.createElement('li');
    li.className = 'queue-item' + (token === cur ? ' current' : '');
    li.innerHTML = `
      <span class="q-idx">${token === cur ? '<span class="row-eq"><i></i><i></i><i></i></span>' : i + 1}</span>
      <span class="q-meta">
        <span class="q-name">${esc(t.song_name)}</span>
        <span class="q-sub">${esc(t.singers)} · ${esc(t.source)}${t.duration ? ' · ' + esc(t.duration) : ''}</span>
      </span>
      <button class="q-remove" title="从队列移除">✕</button>`;
    li.onclick = () => playQueueIndex(i);
    li.querySelector('.q-remove').onclick = (e) => {
      e.stopPropagation();
      const wasCurrent = token === currentToken();
      state.queue.splice(i, 1);
      if (wasCurrent) state.queueIndex = Math.min(i, state.queue.length - 1);
      else if (i < state.queueIndex) state.queueIndex--;
      refreshQueueView(); refreshQueueBadge();
    };
    list.appendChild(li);
  });
}
$('#queue-clear').onclick = () => {
  state.queue = []; state.queueIndex = -1;
  audio.pause(); audio.removeAttribute('src');
  $('#player').dataset.empty = 'true';
  $('#player-title').textContent = '未在播放';
  $('#player-artist').textContent = '搜索一首歌开始吧';
  $('#now-mini-text').textContent = '未在播放';
  refreshQueueView(); refreshQueueBadge(); syncPlayingRow();
};

/* ------------------------------------------------------------------ */
/* 下载                                                                 */
/* ------------------------------------------------------------------ */
const dlItems = new Map(); // download_id -> {li, payload}
function refreshDlBadge() {
  const b = $('#dl-nav-badge');
  const active = [...dlItems.values()].filter((d) => !['done', 'error', 'cancelled'].includes(d.lastStatus)).length;
  b.textContent = active;
  b.classList.toggle('hidden', !active);
  b.classList.toggle('on', !!active);
  $('#downloads-empty').classList.toggle('hidden', !!dlItems.size);
}
async function startDownload(token) {
  const t = state.tracks.get(token);
  if (!t) return toast('曲目信息已失效', true);
  try {
    const res = await fetch('/api/download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    }).then((r) => r.json());
    if (res.error) { toast(res.error, true); return; }
    addDlCard(res.download_id, t);
    trackDownloadProgress(res.download_id);
    toast('已加入下载列表');
  } catch {
    toast('下载启动失败', true);
  }
}
function addDlCard(id, t) {
  const li = document.createElement('li');
  li.className = 'dl-card';
  li.dataset.id = id;
  li.innerHTML = `
    <div class="dl-top">
      <span class="dl-name" title="${esc(t.song_name)} - ${esc(t.singers)}">${esc(t.song_name)} · ${esc(t.singers)}</span>
      <span class="dl-state starting">准备中</span>
    </div>
    <div class="dl-bar"><i></i></div>
    <div class="dl-foot">
      <span class="dl-prog">排队中…</span><span class="dl-speed"></span>
      <span class="dl-actions"><button class="dl-btn dl-cancel" title="终止下载">终止</button></span>
    </div>`;
  $('#download-list').prepend(li);
  dlItems.set(id, { li, lastStatus: 'starting' });
  li.querySelector('.dl-cancel').onclick = async () => {
    try { await fetch(`/api/download/${id}/cancel`, { method: 'POST' }); } catch { toast('终止失败', true); }
  };
  refreshDlBadge();
}
function trackDownloadProgress(id) {
  const es = new EventSource(`/api/download/${id}/progress`);
  es.addEventListener('progress', (ev) => {
    const d = JSON.parse(ev.data);
    const item = dlItems.get(id);
    if (!item) { es.close(); return; }
    const { li } = item;
    item.lastStatus = d.status;
    const stateEl = li.querySelector('.dl-state');
    const bar = li.querySelector('.dl-bar i');
    const prog = li.querySelector('.dl-prog');
    const speed = li.querySelector('.dl-speed');
    if (d.status === 'error') {
      li.classList.add('error');
      stateEl.textContent = '失败'; stateEl.className = 'dl-state error';
      bar.style.width = '100%';
      prog.textContent = '';
      speed.textContent = '';
      const act = li.querySelector('.dl-actions');
      if (act) act.innerHTML = '';
      const err = document.createElement('div');
      err.className = 'dl-errmsg';
      err.textContent = `错误: ${d.message || '未知错误'}`;
      li.querySelector('.dl-foot').after(err);
      es.close(); refreshDlBadge();
      return;
    }
    if (d.status === 'cancelled') {
      li.classList.add('cancelled');
      stateEl.textContent = '已终止'; stateEl.className = 'dl-state cancelled';
      bar.style.width = '0%';
      prog.textContent = '已终止，临时文件已清理';
      speed.textContent = '';
      const act = li.querySelector('.dl-actions');
      if (act) act.innerHTML = '';
      es.close(); refreshDlBadge();
      return;
    }
    const total = d.total || 0, done = d.downloaded || 0;
    const pct = total ? Math.min(100, (done / total) * 100) : 4;
    bar.style.width = pct + '%';
    prog.textContent = mb(done) + (total ? ' / ' + mb(total) : '');
    if (d.status === 'downloading') {
      stateEl.textContent = '下载中'; stateEl.className = 'dl-state downloading';
      speed.textContent = d.speed ? mb(d.speed) + '/s' : '';
    }
    if (d.status === 'done') {
      li.classList.add('done');
      stateEl.textContent = '完成'; stateEl.className = 'dl-state done';
      bar.style.width = '100%';
      speed.textContent = '';
      // 完成态操作: 打开文件夹 / 删除文件 / 保存到本地
      const act = li.querySelector('.dl-actions');
      if (act) {
        act.innerHTML = '';
        const reveal = document.createElement('button');
        reveal.className = 'dl-btn';
        reveal.title = '在文件管理器中打开下载目录';
        reveal.textContent = '📂 打开文件夹';
        reveal.onclick = async () => {
          try {
            const r = await fetch(`/api/download/${id}/reveal`, { method: 'POST' }).then((x) => x.json());
            if (r.error) toast(r.error, true);
          } catch { toast('打开文件夹失败', true); }
        };
        const del = document.createElement('button');
        del.className = 'dl-btn dl-danger';
        del.title = '从磁盘删除已下载的文件';
        del.textContent = '删除文件';
        del.onclick = async () => {
          try {
            const r = await fetch(`/api/download/${id}/delete`, { method: 'POST' }).then((x) => x.json());
            if (r.ok) { item.li.remove(); dlItems.delete(id); refreshDlBadge(); toast('已删除下载文件'); }
            else toast(r.error || '删除失败', true);
          } catch { toast('删除失败', true); }
        };
        const a = document.createElement('a');
        a.className = 'dl-save';
        a.href = `/api/file/${id}`;
        a.setAttribute('download', '');
        a.textContent = '↓ 保存到本地';
        act.append(reveal, del, a);
      }
      es.close(); refreshDlBadge();
      toast('下载完成：' + (d.name || ''));
    }
  });
  es.addEventListener('error', () => { es.close(); });
  es.onerror = () => { es.close(); };
}
$('#dl-clear-finished').onclick = () => {
  for (const [id, item] of [...dlItems.entries()]) {
    if (['done', 'error', 'cancelled'].includes(item.lastStatus)) { item.li.remove(); dlItems.delete(id); }
  }
  refreshDlBadge();
};

/* ------------------------------------------------------------------ */
/* 视图切换                                                             */
/* ------------------------------------------------------------------ */
function switchView(view) {
  state.view = view;
  $$('.nav-item').forEach((n) => n.classList.toggle('active', n.dataset.view === view));
  $$('.view').forEach((v) => v.classList.toggle('hidden', v.id !== `view-${view}`));
  if (view === 'favorites') renderFavorites();
  if (view === 'queue') refreshQueueView();
}
$$('.nav-item').forEach((n) => n.onclick = () => switchView(n.dataset.view));

/* 试搜芯片 */
$$('.try-chips button').forEach((b) => b.onclick = () => runSearch(b.dataset.kw));

/* ------------------------------------------------------------------ */
/* MediaSession（系统媒体键 / 锁屏控制）                                  */
/* ------------------------------------------------------------------ */
function updateMediaSession(t) {
  if (!('mediaSession' in navigator)) return;
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: t.song_name,
      artist: t.singers,
      album: t.album || '声轨 Soundtrack',
      artwork: t.cover_url ? [{ src: new URL(`/api/cover/${t.token}`, location.href).href, sizes: '512x512' }] : [],
    });
  } catch {}
}
function updateMediaSessionPlayback() {
  if (!('mediaSession' in navigator)) return;
  navigator.mediaSession.playbackState = audio.paused ? 'paused' : 'playing';
}
if ('mediaSession' in navigator) {
  try {
    navigator.mediaSession.setActionHandler('play', () => audio.play().catch(() => {}));
    navigator.mediaSession.setActionHandler('pause', () => audio.pause());
    navigator.mediaSession.setActionHandler('previoustrack', () => step(-1));
    navigator.mediaSession.setActionHandler('nexttrack', () => step(1));
    navigator.mediaSession.setActionHandler('seekto', (d) => { if (d.seekTime != null && audio.duration) audio.currentTime = d.seekTime; });
  } catch {}
}

/* ------------------------------------------------------------------ */
/* 快捷键                                                               */
/* ------------------------------------------------------------------ */
document.addEventListener('keydown', (e) => {
  const typing = e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA';
  if (e.code === 'Escape') { toggleLyricsPanel(false); $('#history-panel').classList.add('hidden'); return; }
  if (typing) return;
  if (e.code === 'Space') { e.preventDefault(); $('#btn-play').click(); }
  else if (e.code === 'ArrowRight' && e.altKey) step(1);
  else if (e.code === 'ArrowLeft' && e.altKey) step(-1);
  else if (e.key.toLowerCase() === 'm') { muted = !muted; applyVolume(); }
  else if (e.key.toLowerCase() === 'l') toggleLyricsPanel();
});

/* ------------------------------------------------------------------ */
/* 启动                                                                 */
/* ------------------------------------------------------------------ */
loadSources();
applyLoopMode();
refreshFavBadge();
refreshQueueBadge();
refreshDlBadge();
document.body.classList.add('paused');
