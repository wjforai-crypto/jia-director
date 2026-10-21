// Shared by the browser and renderer: one cut clock, one subtitle owner.
export function invariant(ok, message) { if (!ok) throw new Error(message); }
export const cleanText = value => String(value ?? '').replace(/\uFEFF/g, '').trim();
const comparable = value => cleanText(value).replace(/[\p{P}\s]/gu, '');

export function normalizeTranscript(raw, duration) {
  invariant(Number.isFinite(duration) && duration > 0, '无效素材时长');
  const core = Array.isArray(raw.words) && Array.isArray(raw.segments);
  invariant(core || Array.isArray(raw.transcription), '需要核心 transcript.json 或 Whisper 完整 JSON');
  const inputSegments = core ? raw.segments : raw.transcription.map((s, i) => ({
    id: `s${i}`, start: s.offsets?.from / 1000, end: s.offsets?.to / 1000, text: s.text,
    wordIds: (s.tokens ?? []).filter(t => !/^\[.*\]$/.test(cleanText(t.text))).map((_, j) => `s${i}w${j}`)
  }));
  const words = core ? raw.words : raw.transcription.flatMap((s, i) => (s.tokens ?? [])
    .filter(t => !/^\[.*\]$/.test(cleanText(t.text)))
    .map((t, j) => ({ id: `s${i}w${j}`, text: t.text, start: t.offsets?.from / 1000,
      end: t.offsets?.to / 1000, confidence: t.p })));
  const byId = new Map(words.map(w => [w.id, w]));
  invariant(byId.size === words.length, '重复转写词 ID');
  const units = [], segments = [], warnings = [], assigned = new Set();
  for (const s of inputSegments) {
    invariant(typeof s.id === 'string' && !segments.some(x => x.id === s.id), '重复或无效句 ID');
    invariant(Number.isFinite(s.start) && Number.isFinite(s.end) && s.start >= 0 && s.end > s.start && s.start < duration, '句子时间码无效');
    let pending = [], grouped = [];
    for (const id of s.wordIds ?? []) {
      const w = byId.get(id);
      invariant(w && !assigned.has(id), '词与句子绑定无效'); assigned.add(id);
      invariant(Number.isFinite(w.start) && Number.isFinite(w.end) && w.start >= 0 && w.end >= w.start && w.end <= duration + .15, '词时间码无效');
      if (!cleanText(w.text)) continue;
      const row = { ...w, end: Math.min(w.end, duration) };
      if (row.end <= row.start) { pending.push(row); continue; }
      const group = [...pending, row]; pending = [];
      const current = { start: Math.min(...group.map(x => x.start)), end: row.end, words: group };
      const previous = grouped.at(-1);
      if (previous && current.start < previous.end) {
        previous.end = Math.max(previous.end, current.end); previous.words.push(...group);
      } else grouped.push(current);
    }
    if (pending.length && grouped.length) { grouped.at(-1).words.push(...pending); grouped.at(-1).end = Math.min(duration, Math.max(grouped.at(-1).end, ...pending.map(w => w.end))); }
    if (!grouped.length) {
      // Whole-segment fallback is explicit; it never invents individual word offsets.
      grouped = [{ start: s.start, end: Math.min(duration, s.end), words: [{ id: `${s.id}:span`, text: s.asrText ?? s.text, confidence: null }] }];
      warnings.push(`${s.id}: 无可靠词时码，只能整句操作`);
    }
    const ids = [];
    for (const g of grouped) {
      const id = `u:${s.id}:${ids.length}`; ids.push(id);
      const merged = g.words.length > 1;
      units.push({ id, segmentId: s.id, start: g.start, end: g.end,
        text: g.words.map(w => w.text).join('').trim(), wordIds: g.words.map(w => w.id),
        confidence: Math.min(...g.words.map(w => w.confidence ?? 1)),
        timingKind: merged ? 'merged-ASR-span' : 'ASR-token-offsets', timingReviewRequired: merged });
    }
    segments.push({ id: s.id, start: s.start, end: Math.min(s.end, duration),
      rawText: cleanText(s.asrText ?? (core ? grouped.flatMap(g => g.words).map(w => w.text).join('') : s.text)),
      text: cleanText(s.text), unitIds: ids });
  }
  invariant(units.length > 0, '没有可审查的转写');
  invariant(words.every(w => !cleanText(w.text) || assigned.has(w.id)), '存在未绑定句子的词，不能静默漏掉转写');
  invariant(units.every((u, i) => !i || u.start >= units[i - 1].end - .001), '跨句词时码重叠，请先核查原始转写');
  return { units, segments, warnings, timingKind: 'ASR-offsets-not-forced-alignment' };
}

export function validateEdits(input, transcript, duration) {
  invariant(input && Array.isArray(input.cuts) && input.cuts.length <= 500, '剪辑记录格式无效或超过500个切段');
  const ids = new Set(), cuts = input.cuts.map(c => {
    invariant(typeof c.id === 'string' && c.id.length <= 128 && !ids.has(c.id), '剪辑 ID 无效'); ids.add(c.id);
    invariant(Number.isFinite(c.start) && Number.isFinite(c.end) && c.start >= 0 && c.end > c.start && c.end <= duration, '删除范围越界');
    invariant(typeof c.reason === 'string' && c.reason.trim() && c.reason.length < 1000, '删除必须说明理由');
    invariant(['manual', 'suggestion'].includes(c.origin), '删除来源无效');
    return { id: c.id, start: c.start, end: c.end, reason: c.reason.trim(), origin: c.origin };
  });
  const corrections = {};
  invariant(input.corrections && typeof input.corrections === 'object' && !Array.isArray(input.corrections), '校字格式无效');
  for (const [id, value] of Object.entries(input.corrections)) {
    invariant(transcript.units.some(u => u.id === id) && typeof value === 'string' && value.trim() && value.length <= 200, '校字必须绑定真实词组，不能用空文字删除发言');
    corrections[id] = value.trim();
  }
  const subtitleOverrides = {};
  invariant(input.subtitleOverrides && typeof input.subtitleOverrides === 'object' && !Array.isArray(input.subtitleOverrides), '字幕校对格式无效');
  for (const [id, value] of Object.entries(input.subtitleOverrides)) {
    invariant(typeof value === 'string' && value.trim() && value.length <= 1000 && transcript.segments.some(s => id.startsWith(`${s.id}@`)), '字幕校对绑定无效');
    subtitleOverrides[id] = value.trim();
  }
  return { cuts, corrections, subtitleOverrides };
}

export function mergedCuts(cuts) {
  const out = [];
  for (const c of [...cuts].sort((a, b) => a.start - b.start)) {
    const previous = out.at(-1);
    if (previous && c.start <= previous.end + .000001) { previous.end = Math.max(previous.end, c.end); previous.ids.push(c.id); }
    else out.push({ start: c.start, end: c.end, ids: [c.id] });
  }
  return out;
}
export function makeTimeline(cuts, duration, fps) {
  invariant(Number.isFinite(fps) && fps >= 1 && fps <= 60, '输出帧率无效');
  // Floor source duration to complete CFR frames; a fractional last frame is not padded silently.
  const totalFrames = Math.floor(duration * fps + .00001);
  // Quantize deletions outward: a selected word must not leave a sliver of its syllable behind.
  const dropped = mergedCuts(cuts).map(c => ({ start: Math.max(0, Math.floor(c.start * fps + .000001)), end: Math.min(totalFrames, Math.ceil(c.end * fps - .000001)) })).filter(c => c.end > c.start);
  const union = mergedCuts(dropped), keeps = []; let sourceCursor = 0, outputCursor = 0;
  for (const cut of [...union, { start: totalFrames, end: totalFrames }]) {
    if (cut.start > sourceCursor) {
      keeps.push({ sourceStartFrame: sourceCursor, sourceEndFrame: cut.start, outputStartFrame: outputCursor,
        outputEndFrame: outputCursor + cut.start - sourceCursor,
        sourceStart: sourceCursor / fps, sourceEnd: cut.start / fps, outputStart: outputCursor / fps, outputEnd: (outputCursor + cut.start - sourceCursor) / fps });
      outputCursor += cut.start - sourceCursor;
    }
    sourceCursor = Math.max(sourceCursor, cut.end);
  }
  invariant(outputCursor > 0, '不能删除全部素材');
  return { fps, sourceFrames: totalFrames, outputFrames: outputCursor, outputDuration: outputCursor / fps, keeps,
    droppedFrames: totalFrames - outputCursor, tailRemainderSeconds: duration - totalFrames / fps };
}

export function buildCues(transcript, edits, timeline) {
  const cues = [];
  for (const s of transcript.segments) {
    const words = transcript.units.filter(u => u.segmentId === s.id);
    for (const k of timeline.keeps) {
      const part = words.filter(w => w.start < k.sourceEnd - .0001 && w.end > k.sourceStart + .0001);
      if (!part.length) continue;
      const key = `${s.id}@${k.sourceStartFrame}-${k.sourceEndFrame}`;
      const whole = part.length === words.length && part.every(w => w.start >= k.sourceStart - .001 && w.end <= k.sourceEnd + .001);
      const hasWordCorrection = words.some(w => Object.hasOwn(edits.corrections, w.id) && edits.corrections[w.id] !== w.text);
      const fallback = part.map(w => edits.corrections[w.id] ?? w.text).join('');
      const override = edits.subtitleOverrides[key];
      const text = override ?? (whole && !hasWordCorrection ? s.text : fallback);
      const first = Math.max(k.sourceStart, part[0].start), last = Math.min(k.sourceEnd, part.at(-1).end);
      const startFrame = Math.max(k.outputStartFrame, Math.floor((first - k.sourceStart) * timeline.fps + k.outputStartFrame));
      const endFrame = Math.min(k.outputEndFrame, Math.max(startFrame + 1, Math.ceil((last - k.sourceStart) * timeline.fps + k.outputStartFrame)));
      cues.push({ key, segmentId: s.id, text, startFrame, endFrame, start: startFrame / timeline.fps, end: endFrame / timeline.fps,
        sourceStart: first, sourceEnd: last,
        requiresCorrection: !override && (!whole || hasWordCorrection) && comparable(s.text) !== comparable(s.rawText),
        wordIds: part.flatMap(u => u.wordIds), isFragment: !whole });
    }
  }
  return cues.sort((a, b) => a.startFrame - b.startFrame);
}

export function toSrt(cues) {
  const stamp = s => { const n = Math.round(s * 1000); return `${String(Math.floor(n / 3600000)).padStart(2, '0')}:${String(Math.floor(n / 60000) % 60).padStart(2, '0')}:${String(Math.floor(n / 1000) % 60).padStart(2, '0')},${String(n % 1000).padStart(3, '0')}`; };
  return cues.map((c, i) => `${i + 1}\n${stamp(c.start)} --> ${stamp(c.end)}\n${c.text.replace(/\r?\n/g, ' ')}\n`).join('\n');
}
