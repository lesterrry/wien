import { validateWav, wavFilename } from "./audio-export";

export async function downloadAudio(name: string, data: ArrayBuffer) {
  validateWav(data);
  const url = URL.createObjectURL(new Blob([data], { type: "audio/wav" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = wavFilename(name);
  document.body.append(link);
  try {
    link.click();
  } finally {
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }
  return true;
}
