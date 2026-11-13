import assert from "node:assert/strict";
import { test } from "node:test";
import {
  encodeWav,
  exportDuration,
  validateWav,
  wavFilename,
} from "./audio-export";

test("WAV contains stereo PCM16 with correct lengths and signed samples", () => {
  const wav = encodeWav(
    [new Float32Array([0, 0.5, -0.5]), new Float32Array([0.25, 0, -1])],
    false,
  );
  validateWav(wav);
  const view = new DataView(wav);
  assert.equal(wav.byteLength, 56);
  assert.equal(view.getUint16(22, true), 2);
  assert.equal(view.getUint32(24, true), 44100);
  assert.equal(view.getUint16(34, true), 16);
  assert.equal(view.getUint32(40, true), 12);
  assert.deepEqual(
    Array.from({ length: 6 }, (_, i) => view.getInt16(44 + i * 2, true)),
    [0, 8192, 16384, 0, -16384, -32768],
  );
});
test("normalization and overload protection preserve stereo balance", () => {
  for (const [level, normalize] of [
    [0.1, true],
    [2, false],
  ] as const) {
    const view = new DataView(
      encodeWav(
        [new Float32Array([level]), new Float32Array([level / 2])],
        normalize,
      ),
    );
    assert(
      Math.abs(view.getInt16(44, true) / 32767 - 10 ** (-1 / 20)) < 0.0001,
    );
    assert(
      Math.abs(view.getInt16(46, true) / view.getInt16(44, true) - 0.5) <
        0.0001,
    );
  }
  assert.doesNotThrow(() =>
    encodeWav([new Float32Array(4), new Float32Array(4)], true),
  );
  assert.throws(
    () => encodeWav([new Float32Array([NaN]), new Float32Array(1)], false),
    /invalid audio/,
  );
  assert.throws(() => validateWav(new ArrayBuffer(100)), /header/);
});
test("duration uses cycles and effect tail, with bounded allocation", () => {
  const options = { cycles: 96, tail: 2, normalize: false };
  assert.equal(exportDuration(options, 0.5), 194);
  for (const cps of [0, -1, NaN, Infinity, 0.001])
    assert.throws(() => exportDuration(options, cps));
  for (const cycles of [0, 1.5, 513, NaN])
    assert.throws(() => exportDuration({ ...options, cycles }, 0.5));
  assert.throws(() => exportDuration({ ...options, tail: -1 }, 0.5));
  assert.equal(wavFilename("voices/мелодия.strudel"), "мелодия.wav");
  assert.equal(wavFilename("../../a?b.wav"), "a_b.wav");
});
