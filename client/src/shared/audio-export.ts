export interface AudioExportOptions {
  cycles: number;
  tail: number;
  normalize: boolean;
}

export interface AudioExportProgress {
  phase: string;
  fraction: number;
}

export const exportSampleRate = 44100;
export const maxExportSeconds = 600;

export function exportDuration(options: AudioExportOptions, cps: number) {
  if (
    !Number.isInteger(options.cycles) ||
    options.cycles < 1 ||
    options.cycles > 512
  )
    throw new Error("Choose between 1 and 512 cycles.");
  if (!Number.isFinite(options.tail) || options.tail < 0 || options.tail > 30)
    throw new Error("Choose an effect tail between 0 and 30 seconds.");
  if (!Number.isFinite(cps) || cps <= 0)
    throw new Error("The pattern must have a positive, constant tempo.");
  const duration = options.cycles / cps + options.tail;
  if (duration > maxExportSeconds)
    throw new Error(
      "The export is longer than 10 minutes. Choose fewer cycles.",
    );
  return duration;
}

export function wavFilename(path: string) {
  const name =
    path
      .split(/[\\/]/)
      .at(-1)
      ?.replace(/\.[^.]+$/, "") ?? "audio";
  return `${[...name].map((char) => (char.charCodeAt(0) < 32 || /[<>:"|?*]/.test(char) ? "_" : char)).join("") || "audio"}.wav`;
}

// Interleaved stereo PCM16. Leave headroom when normalizing; otherwise preserve
// the mix level, reducing only overloads rather than silently clipping samples.
export function encodeWav(
  channels: Float32Array[],
  normalize: boolean,
): ArrayBuffer {
  const frames = channels[0]?.length;
  if (
    !frames ||
    channels.length !== 2 ||
    channels[1].length !== frames ||
    frames > exportSampleRate * maxExportSeconds
  )
    throw new Error("Invalid audio buffer.");
  let peak = 0;
  for (const channel of channels) {
    for (const value of channel) {
      if (!Number.isFinite(value))
        throw new Error("The pattern produced invalid audio samples.");
      peak = Math.max(peak, Math.abs(value));
    }
  }
  const gain = peak > 0 && (normalize || peak > 1) ? 10 ** (-1 / 20) / peak : 1;
  const buffer = new ArrayBuffer(44 + frames * 4);
  const view = new DataView(buffer);
  const text = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i++)
      view.setUint8(offset + i, value.charCodeAt(i));
  };
  text(0, "RIFF");
  view.setUint32(4, buffer.byteLength - 8, true);
  text(8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 2, true);
  view.setUint32(24, exportSampleRate, true);
  view.setUint32(28, exportSampleRate * 4, true);
  view.setUint16(32, 4, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, frames * 4, true);
  for (let frame = 0; frame < frames; frame++) {
    for (let channel = 0; channel < 2; channel++) {
      const value = channels[channel][frame] * gain;
      view.setInt16(
        44 + (frame * 2 + channel) * 2,
        Math.round(value * (value < 0 ? 32768 : 32767)),
        true,
      );
    }
  }
  return buffer;
}

export function validateWav(data: ArrayBuffer) {
  if (
    !(data instanceof ArrayBuffer) ||
    data.byteLength < 48 ||
    data.byteLength > 44 + maxExportSeconds * exportSampleRate * 4
  )
    throw new Error("Invalid WAV file.");
  const view = new DataView(data);
  if (
    view.getUint32(0) !== 0x52494646 ||
    view.getUint32(8) !== 0x57415645 ||
    view.getUint32(4, true) !== data.byteLength - 8
  )
    throw new Error("Invalid WAV header.");
}
