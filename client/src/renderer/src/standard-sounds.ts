import { registerSoundfonts } from "@strudel/soundfonts";
import {
  aliasBank,
  registerSynthSounds,
  registerZZFXSounds,
  samples,
} from "@strudel/webaudio";
import catalog from "./standard-samples.json";

// Sample maps from Strudel's website prebake, bundled to keep startup offline.
// Audio files and GM soundfonts are fetched only when a sound is first played.
export async function registerStandardSounds() {
  await Promise.all([
    registerSynthSounds(),
    registerZZFXSounds(),
    registerSoundfonts(),
    ...catalog.banks.map(({ name, base, sounds }) =>
      samples(sounds, base, {
        prebake: true,
        ...(name === "tidal-drum-machines" ||
        name === "uzu-drumkit" ||
        name === "mridangam"
          ? { tag: "drum-machines" }
          : {}),
      }),
    ),
  ]);
  // Aliases must be installed after their source banks are registered.
  await aliasBank(catalog.aliases);
}
