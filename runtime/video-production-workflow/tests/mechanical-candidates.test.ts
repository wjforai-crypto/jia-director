import assert from "node:assert/strict";
import test from "node:test";
import { buildMechanicalCandidates, selectCurrentSourceAsset } from "../src/mechanical-candidates.js";

const base = {
  sourcePath: "C:\\fixtures\\source.mp4",
  sourceSha256: "a".repeat(64),
  sourceDurationSeconds: 9,
  executableSha256: "b".repeat(64),
  parameters: { edit: "audio:-35dB", margin: "0", smooth: "0" },
};

test("auto-editor v3 timeline becomes deterministic candidate-only intervals", () => {
  const timeline = {
    version: "3",
    timebase: "30/1",
    v: [[
      { src: base.sourcePath, start: 0, dur: 90, offset: 0, stream: 0 },
      { src: base.sourcePath, start: 90, dur: 90, offset: 180, stream: 0 },
    ]],
    a: [[
      { src: base.sourcePath, start: 0, dur: 90, offset: 0, stream: 0 },
      { src: base.sourcePath, start: 90, dur: 90, offset: 180, stream: 0 },
    ]],
  };
  const first = buildMechanicalCandidates({ ...base, timeline });
  const second = buildMechanicalCandidates({ ...base, timeline });
  assert.deepEqual(first, second);
  assert.deepEqual(first.candidates.map(({ kind, sourceStartFrame, sourceEndFrameExclusive }) => ({
    kind,
    sourceStartFrame,
    sourceEndFrameExclusive,
  })), [
    { kind: "keep_candidate", sourceStartFrame: 0, sourceEndFrameExclusive: 90 },
    { kind: "cut_candidate", sourceStartFrame: 90, sourceEndFrameExclusive: 180 },
    { kind: "keep_candidate", sourceStartFrame: 180, sourceEndFrameExclusive: 270 },
  ]);
  assert.match(first.candidates[1]?.candidateId ?? "", /^mechanical_[a-f0-9]{24}$/);
  assert.equal(first.candidates[1]?.sourceStartMs, 3000);
  assert.equal(first.candidates[1]?.sourceEndMs, 6000);
});

test("adapter rejects mismatched audio/video maps and unexpected sources", () => {
  const timeline = {
    version: "3",
    timebase: "30/1",
    v: [[{ src: base.sourcePath, start: 0, dur: 270, offset: 0, stream: 0 }]],
    a: [[{ src: base.sourcePath, start: 0, dur: 269, offset: 0, stream: 0 }]],
  };
  assert.throws(() => buildMechanicalCandidates({ ...base, timeline }), /audio\/video candidate maps differ/);
  timeline.a = [[{ src: "C:\\fixtures\\other.mp4", start: 0, dur: 270, offset: 0, stream: 0 }]];
  timeline.v = [[{ src: "C:\\fixtures\\other.mp4", start: 0, dur: 270, offset: 0, stream: 0 }]];
  assert.throws(() => buildMechanicalCandidates({ ...base, timeline }), /unexpected source/);
});

test("adapter selects the a-roll bound by project.source.path rather than the oldest a-roll", () => {
  const assets = [
    { assetId: "old", path: "C:\\fixtures\\old.mp4", role: "a-roll", sha256: "1".repeat(64) },
    { assetId: "current", path: "C:\\fixtures\\current.mp4", role: "a-roll", sha256: "2".repeat(64) },
  ];
  assert.equal(selectCurrentSourceAsset(assets, "C:\\fixtures\\current.mp4").assetId, "current");
  assert.throws(() => selectCurrentSourceAsset(assets, "C:\\fixtures\\missing.mp4"), /found 0/);
});

test("adapter fails closed on effects, transitions, extra tracks, and nonlinear output", () => {
  const plainClip = { src: base.sourcePath, start: 0, dur: 270, offset: 0, stream: 0 };
  const plainTimeline = { version: "3", timebase: "30/1", v: [[plainClip]], a: [[plainClip]] };
  assert.throws(
    () => buildMechanicalCandidates({
      ...base,
      timeline: { ...plainTimeline, v: [[{ ...plainClip, effects: ["cut"] }]], a: [[{ ...plainClip, effects: ["cut"] }]] },
    }),
    /rejects v3 clip effects/,
  );
  assert.throws(
    () => buildMechanicalCandidates({ ...base, timeline: { ...plainTimeline, transitions: { v: [[]], a: [[]] } } }),
    /rejects v3 transitions/,
  );
  assert.throws(
    () => buildMechanicalCandidates({ ...base, timeline: { ...plainTimeline, a: [[plainClip], [plainClip]] } }),
    /exactly one non-empty audio track/,
  );
  const lateClip = { ...plainClip, start: 1 };
  assert.throws(
    () => buildMechanicalCandidates({ ...base, timeline: { ...plainTimeline, v: [[lateClip]], a: [[lateClip]] } }),
    /not contiguous from frame zero/,
  );
  const otherAudio = { ...plainClip, src: "C:\\fixtures\\other.mp4" };
  assert.throws(
    () => buildMechanicalCandidates({ ...base, timeline: { ...plainTimeline, a: [[otherAudio]] } }),
    /unexpected source/,
  );
});
