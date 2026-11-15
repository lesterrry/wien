import audioBufferToWav from "audiobuffer-to-wav";
import { t } from "./i18n";

export const assistSampleRate = 24000;
export const maxAudioSeconds = 10;
export interface AudioSelection {
  buffer: AudioBuffer;
  start: number;
  end: number;
}

// Only the chosen samples enter the request; the original MP3 stays on this device.
export async function prepareAssistAudio({
  buffer,
  start,
  end,
}: AudioSelection) {
  if (
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    start < 0 ||
    end > buffer.duration ||
    end - start < 0.1 ||
    end - start > maxAudioSeconds + 1e-6
  ) {
    throw new Error(t("Select between 0.1 and 10 seconds of audio."));
  }
  const length = Math.min(
    assistSampleRate * maxAudioSeconds,
    Math.round((end - start) * assistSampleRate),
  );
  const context = new OfflineAudioContext(1, length, assistSampleRate);
  const source = context.createBufferSource();
  source.buffer = buffer;
  source.connect(context.destination);
  source.start(0, start, end - start);
  const wav = audioBufferToWav(await context.startRendering());
  const bytes = new Uint8Array(wav);
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  }
  return { wav_base64: btoa(binary) };
}
