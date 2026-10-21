import { makeTimeline, buildCues, mergedCuts } from '/model.mjs';
import { initStages } from '/stages.mjs';
const $ = id => document.getElementById(id), video = $('video');
let state, wave, edits, undo = [], selected = [], dirty = false, mode = 'rough', exportPlayback = false, auditionEnd = null, previousWord, toastTimer, editingCutId = null, cachedClock, cachedCues;
const time = s => `${String(Math.floor(s / 60)).padStart(2, '0')}:${(s % 60).toFixed(2).padStart(5, '0')}`;
const node = (tag, text, cls) => { const el = document.createElement(tag); if (text !== undefined) el.textContent = text; if (cls) el.className = cls; return el; };
function toast(message, error = false) { $('message').textContent = message; $('message').className = error ? 'error' : ''; $('message').style.display = 'block'; clearTimeout(toastTimer); toastTimer = setTimeout(() => $('message').style.display = 'none', error ? 10000 : 4000); }
window.addEventListener('review-message', e => toast(e.detail.text, e.detail.error));
async function api(path, data) { const r = await fetch(path, data ? { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Review-Token': state.token }, body: JSON.stringify(data) } : {}); const result = await r.json(); if (!r.ok) throw new Error(result.error); return result; }
function snapshot() { undo.push(structuredClone(edits)); if (undo.length > 100) undo.shift(); }
function changed() { dirty = true; $('saveStatus').textContent = '有未保存修改'; renderEdits(); }
function clock() { return cachedClock ?? makeTimeline(edits.cuts, state.project.source.duration, state.project.outputClock.fps); }
function cues() { return cachedCues ?? buildCues(state.transcript, edits, clock()); }
function seek(s) { if (exportPlayback) sourceMode(); video.currentTime = Math.max(0, Math.min(state.project.source.duration - .01, s)); }
function setRange(start, end) { $('rangeStart').value = start.toFixed(3); $('rangeEnd').value = end.toFixed(3); }
function range() { const start = Number($('rangeStart').value), end = Number($('rangeEnd').value); if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || end > state.project.source.duration) throw new Error('请选择有效的原片时间范围'); return { start, end }; }
function sourceMode() { exportPlayback = false; video.src = '/media'; mode = 'rough'; $('roughMode').classList.add('selected'); $('originalMode').classList.remove('selected'); $('previewNote').textContent = '即时预览按原片跳转；精确切点以导出的 MP4 为准。'; }
function selectUnit(id, extend) {
  editingCutId = null; $('cutSelection').textContent = '删除这段';
  const units = state.transcript.units, index = units.findIndex(u => u.id === id);
  if (extend && selected.length) { const anchor = units.findIndex(u => u.id === selected[0]); selected = units.slice(Math.min(anchor, index), Math.max(anchor, index) + 1).map(u => u.id); }
  else selected = [id];
  const chosen = units.filter(u => selected.includes(u.id)); setRange(chosen[0].start, chosen.at(-1).end);
  $('selectionLabel').textContent = `${chosen.length} 个词组 · ${chosen.map(w => edits.corrections[w.id] ?? w.text).join('')}`;
  $('wordCorrection').disabled = $('correctWord').disabled = chosen.length !== 1;
  $('wordCorrection').value = chosen.length === 1 ? edits.corrections[id] ?? chosen[0].text : '';
  renderWordStates(); drawWave();
}
function renderTranscript() {
  const container = $('transcript'); container.replaceChildren();
  for (const s of state.transcript.segments) {
    const row = node('div', undefined, 'segment'); row.dataset.segment = s.id;
    const stamp = node('time', time(s.start)); stamp.addEventListener('click', () => seek(s.start)); row.append(stamp);
    const body = node('div'), words = node('div', undefined, 'words');
    for (const u of state.transcript.units.filter(u => u.segmentId === s.id)) {
      const button = node('button', edits.corrections[u.id] ?? u.text, 'word'); button.dataset.unit = u.id;
      button.title = `${time(u.start)}–${time(u.end)}${u.timingReviewRequired ? ' · 合并 ASR 时码' : ''} · 双击定位`;
      button.addEventListener('click', e => selectUnit(u.id, e.shiftKey)); button.addEventListener('dblclick', () => seek(u.start)); words.append(button);
    }
    body.append(words);
    if (s.text.replace(/[\p{P}\s]/gu, '') !== s.rawText.replace(/[\p{P}\s]/gu, '')) body.append(node('div', `已校对句子：${s.text}`, 'segment-note'));
    row.append(body); container.append(row);
  }
  filterTranscript(); renderWordStates();
}
function filterTranscript() { const q = $('search').value.trim(); for (const el of $('transcript').children) el.hidden = q && !el.textContent.includes(q); }
function renderWordStates() {
  for (const u of state.transcript.units) {
    const el = document.querySelector(`[data-unit="${CSS.escape(u.id)}"]`); if (!el) continue;
    el.textContent = edits.corrections[u.id] ?? u.text;
    el.classList.toggle('selected', selected.includes(u.id));
    el.classList.toggle('dropped', edits.cuts.some(c => c.start < u.end && c.end > u.start));
    el.classList.toggle('uncertain', u.confidence < .5 || u.timingReviewRequired);
  }
}
function listenAround(start, end, rough = false) { if (exportPlayback) sourceMode(); mode = rough ? 'rough' : 'original'; setModeButtons(); seek(Math.max(0, start - .8)); auditionEnd = Math.min(state.project.source.duration, end + .8); video.play().catch(e => toast(e.message, true)); }
function renderSuggestions() {
  const out = $('suggestions'); out.replaceChildren(); let pending = 0;
  for (const s of state.suggestions) {
    const applied = edits.cuts.some(c => c.id === `suggestion:${s.id}`); if (!applied) pending++;
    const row = node('article', undefined, `suggestion${applied ? ' applied' : ''}`), head = node('div', undefined, 'suggestion-head');
    head.append(node('span', `${s.category} · ${s.confidence}`, 'suggestion-tag'), node('span', `${time(s.start)} → ${time(s.end)}`, 'suggestion-time')); row.append(head, node('p', s.reason));
    const actions = node('div', undefined, 'suggestion-actions'), listen = node('button', '听上下文'); listen.addEventListener('click', () => { setRange(s.start, s.end); listenAround(s.start, s.end); });
    const apply = node('button', applied ? '恢复这段' : '采纳删除', applied ? '' : 'danger-outline');
    apply.addEventListener('click', () => { snapshot(); if (applied) edits.cuts = edits.cuts.filter(c => c.id !== `suggestion:${s.id}`); else edits.cuts.push({ id: `suggestion:${s.id}`, start: s.start, end: s.end, reason: s.reason, origin: 'suggestion' }); changed(); });
    actions.append(listen, apply); row.append(actions); out.append(row);
  }
  if (!state.suggestions.length) out.append(node('p', '暂无剪辑建议。Skill 可结合录音与脚本生成建议；不确定的内容默认保留。', 'empty'));
  $('pendingBadge').textContent = pending; $('suggestionCount').textContent = state.suggestions.length;
}
function renderCaptions() {
  const out = $('captions'); out.replaceChildren(); const list = cues(), pending = list.filter(c => c.requiresCorrection).length;
  $('captionWarning').textContent = `${pending} 个待核查`; if (pending) $('captionsDetails').open = true;
  for (const c of list) {
    const row = node('div', undefined, `caption-row${c.requiresCorrection ? ' needs' : ''}`), label = node('label', `${time(c.start)} → ${time(c.end)}${c.requiresCorrection ? ' · 裁剪后需校对' : ''}`);
    const input = node('input'); input.value = c.text; input.dataset.cue = c.key; input.setAttribute('aria-label', `字幕 ${time(c.start)}`);
    input.addEventListener('change', () => { if (!input.value.trim()) { input.value = c.text; return toast('校字不能用空文字替代删除发言', true); } snapshot(); edits.subtitleOverrides[c.key] = input.value.trim(); changed(); }); row.append(label, input); out.append(row);
  }
}
function renderEdits() {
  cachedClock = makeTimeline(edits.cuts, state.project.source.duration, state.project.outputClock.fps);
  cachedCues = buildCues(state.transcript, edits, cachedClock);
  const t = clock(); $('durationStats').textContent = `原片 ${time(state.project.source.duration)} → 粗剪 ${time(t.outputDuration)} · 移除 ${time(t.droppedFrames / t.fps)}`;
  $('cutCount').textContent = edits.cuts.length; const out = $('cuts'); out.replaceChildren();
  for (const c of [...edits.cuts].sort((a, b) => a.start - b.start)) {
    const row = node('div', undefined, 'cut-row'), stamp = node('time', `${time(c.start)}–${time(c.end)}`), p = node('p', c.reason), restore = node('button', '恢复'), adjust = node('button', '调边界');
    stamp.addEventListener('click', () => { setRange(c.start, c.end); listenAround(c.start, c.end); });
    restore.addEventListener('click', () => { snapshot(); edits.cuts = edits.cuts.filter(x => x.id !== c.id); changed(); });
    adjust.addEventListener('click', () => { editingCutId = c.id; setRange(c.start, c.end); $('cutSelection').textContent = '更新边界'; $('selectionLabel').textContent = '调整已删除片段 · 改起点/终点后更新'; });
    adjust.title = '先载入此片段边界，再修改起点/终点并更新'; row.append(stamp, p, adjust, restore); out.append(row);
  }
  renderWordStates(); renderSuggestions(); renderCaptions(); drawWave();
}
function renderExports() {
  const out = $('exports'); out.replaceChildren(); $('exportCount').textContent = state.exports.length;
  for (const e of state.exports) {
    const row = node('div', undefined, 'export-row'), play = node('button', `播放真实粗剪 · r${e.revision} · ${time(e.duration)}`);
    play.addEventListener('click', () => { video.pause(); exportPlayback = true; video.src = `/exports/${e.id}/rough.mp4`; $('previewNote').textContent = `正在播放已导出的 MP4 · r${e.revision}。返回原片/粗剪预览可继续修改。`; video.play().catch(err => toast(err.message, true)); });
    row.append(play, node('br'));
    for (const [name, label] of [['rough.mp4', 'MP4'], ['rough.srt', '字幕'], ['mapping.json', '原片→粗剪'], ['fine-cut.handoff.json', '精剪交接'], ['qa.json', '检查']]) { const a = node('a', label); a.href = `/exports/${e.id}/${name}`; a.target = '_blank'; row.append(a); }
    out.append(row);
  }
  if (!state.exports.length) out.append(node('p', '保存后导出真实 MP4、SRT 与时间映射，再继续精剪。', 'empty'));
}
function setModeButtons() { $('originalMode').classList.toggle('selected', mode === 'original'); $('roughMode').classList.toggle('selected', mode === 'rough'); }
async function save() { if (!dirty) return; const result = await api('/api/save', { ...edits, revision: state.edits.revision }); state.edits.revision = result.revision; edits.revision = result.revision; dirty = false; $('saveStatus').textContent = `已保存 · r${result.revision}`; toast('修改已保存，可随时恢复；尚未记录定稿确认。'); }
function deleteRange() { const r = range(); snapshot();
  if (editingCutId) { const cut = edits.cuts.find(c => c.id === editingCutId); if (!cut) throw new Error('该片段已恢复，请重新选择'); Object.assign(cut, r); }
  else edits.cuts.push({ id: `manual:${crypto.randomUUID()}`, ...r, reason: '审片中手动删除；切点需核听', origin: 'manual' });
  try { changed(); editingCutId = null; $('cutSelection').textContent = '删除这段'; } catch (e) { edits = undo.pop(); renderEdits(); throw e; }
}
function undoLast() { if (!undo.length) return; edits = undo.pop(); changed(); }
function protectAction(fn) { return async () => { try { await fn(); } catch (e) { toast(e.message, true); } }; }
const waveCanvas = $('waveform'), ctx = waveCanvas.getContext('2d');
function viewRange() { const length = state.project.source.duration / Number($('zoom').value); return { start: Number($('pan').value) / 1000 * (state.project.source.duration - length), length }; }
function drawWave() {
  if (!state || !wave) return; const dpr = window.devicePixelRatio || 1, w = waveCanvas.clientWidth, h = waveCanvas.clientHeight;
  if (waveCanvas.width !== w * dpr || waveCanvas.height !== h * dpr) { waveCanvas.width = w * dpr; waveCanvas.height = h * dpr; }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, w, h); const v = viewRange(), x = s => (s - v.start) / v.length * w;
  ctx.strokeStyle = '#3c5445'; ctx.beginPath(); ctx.moveTo(0, h / 2); ctx.lineTo(w, h / 2); ctx.stroke();
  ctx.strokeStyle = '#99bb9f'; ctx.lineWidth = 1;
  const stride = Math.max(1, Math.floor(wave.peaks.length * v.length / wave.duration / w));
  for (let i = Math.floor(v.start / wave.duration * wave.peaks.length); i < wave.peaks.length && i / wave.peaks.length * wave.duration < v.start + v.length; i += stride) { const pos = x(i / wave.peaks.length * wave.duration), amplitude = Math.max(1, Math.sqrt(wave.peaks[i]) * (h - 28) / 2); ctx.beginPath(); ctx.moveTo(pos, h / 2 - amplitude); ctx.lineTo(pos, h / 2 + amplitude); ctx.stroke(); }
  for (const c of mergedCuts(edits.cuts)) { ctx.fillStyle = '#b2645855'; ctx.fillRect(x(c.start), 0, x(c.end) - x(c.start), h); }
  if (selected.length) { const us = state.transcript.units.filter(u => selected.includes(u.id)); ctx.fillStyle = '#b8f2d325'; ctx.fillRect(x(us[0].start), 0, x(us.at(-1).end) - x(us[0].start), h); }
  ctx.font = '9px Consolas'; ctx.fillStyle = '#90a597'; const step = v.length > 30 ? 10 : v.length > 10 ? 5 : 1;
  for (let s = Math.ceil(v.start / step) * step; s < v.start + v.length; s += step) ctx.fillText(time(s), x(s) + 3, 12);
  if (!exportPlayback) { const pos = x(video.currentTime); ctx.strokeStyle = '#e5f9ec'; ctx.beginPath(); ctx.moveTo(pos, 0); ctx.lineTo(pos, h); ctx.stroke(); }
}
function sourceToOutput(s, t) { const k = t.keeps.find(k => s >= k.sourceStart && s < k.sourceEnd); if (k) return k.outputStart + s - k.sourceStart; return t.keeps.find(k => k.sourceStart > s)?.outputStart ?? t.outputDuration; }
function tick() {
  if (state && video.readyState >= 1) {
    const t = clock(), s = video.currentTime;
    if (!exportPlayback && mode === 'rough' && !video.paused && !video.seeking) {
      const k = t.keeps.find(k => s >= k.sourceStart && s < k.sourceEnd - .005);
      if (!k) { const next = t.keeps.find(k => k.sourceStart > s); if (next) video.currentTime = next.sourceStart; else video.pause(); }
    }
    if (auditionEnd !== null && s >= auditionEnd) { video.pause(); auditionEnd = null; }
    $('outputTime').textContent = time(exportPlayback || mode === 'original' ? s : sourceToOutput(s, t)); $('sourceTime').textContent = exportPlayback ? '导出视频时间' : `原片 ${time(s)}`; $('play').textContent = video.paused ? '▶' : 'Ⅱ';
    const current = state.transcript.units.find(u => s >= u.start && s < u.end)?.id;
    if (current !== previousWord) { if (previousWord) document.querySelector(`[data-unit="${CSS.escape(previousWord)}"]`)?.classList.remove('playing'); if (current && !exportPlayback) document.querySelector(`[data-unit="${CSS.escape(current)}"]`)?.classList.add('playing'); previousWord = current; }
    const currentCue = cues().find(c => exportPlayback ? false : s >= c.sourceStart && s < c.sourceEnd);
    $('previewCaption').textContent = !exportPlayback ? currentCue?.text ?? '' : '';
    drawWave();
  }
  requestAnimationFrame(tick);
}
async function init() {
  [state, wave] = await Promise.all([api('/api/state'), api('/api/waveform')]); edits = structuredClone(state.edits);
  $('projectName').textContent = state.project.title; $('unitCount').textContent = state.transcript.units.length; $('saveStatus').textContent = `已保存 · r${state.edits.revision}`;
  $('script').textContent = state.scriptText ?? '未提供参考脚本。可按实际录音校字；脚本用于检查，不补造未说出的台词。';
  setRange(0, Math.min(1, state.project.source.duration)); renderTranscript(); renderEdits(); renderExports();
  $('save').addEventListener('click', protectAction(save)); $('undo').addEventListener('click', undoLast);
  $('cutSelection').addEventListener('click', protectAction(deleteRange)); $('audition').addEventListener('click', protectAction(() => { const r = range(); listenAround(r.start, r.end, true); }));
  $('play').addEventListener('click', protectAction(() => video.paused ? video.play() : video.pause())); $('rate').addEventListener('change', () => video.playbackRate = Number($('rate').value));
  video.addEventListener('error', () => toast('浏览器无法播放此素材。请先用本地 FFmpeg 转为 H.264/AAC 新副本，并保留原文件和时间依据。', true));
  $('originalMode').addEventListener('click', () => { if (exportPlayback) sourceMode(); mode = 'original'; auditionEnd = null; setModeButtons(); });
  $('roughMode').addEventListener('click', () => { if (exportPlayback) sourceMode(); mode = 'rough'; auditionEnd = null; setModeButtons(); });
  $('correctWord').addEventListener('click', protectAction(() => { if (selected.length !== 1 || !$('wordCorrection').value.trim()) throw new Error('选择一个词组，输入听到的文字'); snapshot(); edits.corrections[selected[0]] = $('wordCorrection').value.trim(); changed(); }));
  $('search').addEventListener('input', filterTranscript);
  document.querySelectorAll('[data-tab]').forEach(b => b.addEventListener('click', () => { for (const pane of ['transcript', 'suggestions', 'script']) $(pane).hidden = pane !== b.dataset.tab; document.querySelectorAll('[data-tab]').forEach(x => x.classList.toggle('active', x === b)); }));
  $('export').addEventListener('click', protectAction(async () => {
    await save(); if (cues().some(c => c.requiresCorrection)) { $('captionsDetails').open = true; throw new Error('先校对字幕区标黄的保留片段，再导出'); }
    await api('/api/export', { revision: state.edits.revision }); $('export').disabled = true; $('export').textContent = '正在导出…'; pollExport();
  }));
  $('zoom').addEventListener('input', drawWave); $('pan').addEventListener('input', drawWave); window.addEventListener('resize', drawWave);
  waveCanvas.addEventListener('wheel', e => { e.preventDefault(); $('zoom').value = Math.max(1, Math.min(12, Number($('zoom').value) + (e.deltaY < 0 ? 1 : -1))); drawWave(); }, { passive: false });
  let drag;
  const waveTime = e => { const r = waveCanvas.getBoundingClientRect(), v = viewRange(); return Math.max(0, Math.min(state.project.source.duration, v.start + (e.clientX - r.left) / r.width * v.length)); };
  waveCanvas.addEventListener('pointerdown', e => { const s = waveTime(e); if (e.shiftKey) { drag = s; waveCanvas.setPointerCapture(e.pointerId); } else seek(s); });
  waveCanvas.addEventListener('pointermove', e => { if (drag !== undefined) { const s = waveTime(e); setRange(Math.min(s, drag), Math.max(s, drag)); } });
  waveCanvas.addEventListener('pointerup', () => { if (drag !== undefined) { selected = []; $('selectionLabel').textContent = '波形选段 · 原片时间'; $('wordCorrection').disabled = $('correctWord').disabled = true; renderWordStates(); } drag = undefined; });
  document.addEventListener('keydown', e => { if (document.body.dataset.stage && document.body.dataset.stage !== 'rough') return; if (e.ctrlKey && e.key.toLowerCase() === 's') { e.preventDefault(); protectAction(save)(); } else if (!['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) { if (e.ctrlKey && e.key.toLowerCase() === 'z') { e.preventDefault(); undoLast(); } else if (e.code === 'Space') { e.preventDefault(); $('play').click(); } else if (e.key === 'Delete' && selected.length) protectAction(deleteRange)(); } });
  window.addEventListener('beforeunload', e => { if (dirty) { e.preventDefault(); e.returnValue = ''; } });
  tick();
}
async function pollExport() {
  let running = false;
  try { const job = await api('/api/job'); if (job.status === 'running') { running = true; setTimeout(pollExport, 1000); return; }
    if (job.status === 'failed') throw new Error(job.error);
    const fresh = await api('/api/state'); state.exports = fresh.exports; renderExports(); toast('真实粗剪已导出。可播放 MP4，并从交接文件继续精剪。');
  } catch (e) { toast(e.message, true); }
  finally { if (!running) { $('export').disabled = false; $('export').textContent = '导出粗剪 ↗'; } }
}
init().then(initStages).catch(e => toast(e.message, true));
