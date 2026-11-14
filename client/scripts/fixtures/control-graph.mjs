import { writeFiles } from "./workspace.mjs";

// Seven-node diamond dependency graph with synthetic test tones.
const files = {
  "playground.strudel":
    "import rhythm from './playground/rhythm.strudel'\nimport bass from './playground/bass.strudel'\nimport lead from './playground/lead.strudel'\n\nconst tempo = 108 // @slider 70..150\nconst enabled = true\n\nsetcpm(tempo / 4)\n\nenabled ? stack(rhythm, bass, lead) : silence\n",
  "playground/hats.strudel":
    'const hatGain = 0.045\nconst brightness = 7000 // @slider 1500..12000\nconst enabled = true\n\nexport default s("white*4")\n  .hpf(brightness).decay(0.035).sustain(0).release(0.015)\n  .gain(enabled ? Math.max(0, hatGain) : 0)\n',
  "playground/bass.strudel":
    "import { waveform, voiceDecay } from './tone.strudel'\n\nconst bassGain = 0.16\nconst bassCutoff = 600 // @slider 100..4000\nconst enabled = true\n\nexport default note(\"c2*4\")\n  .s(waveform)\n  .lpf(bassCutoff).attack(0.005).decay(voiceDecay).sustain(0.05).release(0.04)\n  .gain(enabled ? Math.max(0, bassGain) : 0)\n",
  "playground/tone.strudel":
    "const Wave = Object.freeze({\n  Sine: 'sine',\n  Triangle: 'triangle',\n  Saw: 'sawtooth',\n})\n\nexport const waveform = Wave.Triangle\nexport const voiceDecay = 0.18 // @slider 0.05..0.6\n\nconst tone = {waveform, voiceDecay}\n",
  "playground/rhythm.strudel":
    "import kick from './kick.strudel'\nimport hats from './hats.strudel'\n\nconst Bank = Object.freeze({\n  Synth: 'synth',\n  TR909: 'tr909',\n  TR808: 'tr808',\n  Linn: 'linn',\n})\n\nconst drumBank = Bank.Synth\nconst enabled = true\n\nconst drums = drumBank === Bank.Synth\n  ? stack(kick, hats)\n  : stack(kick.s(\"bd\"), hats.s(\"hh\")).bank(drumBank)\n\nexport default enabled ? drums : silence\n",
  "playground/kick.strudel":
    'const kickGain = 0.28 // @knob step=0.01\nconst kickDecay = 0.16 // @slider 0.05..0.4\nconst enabled = true\n\nconst kickVoice = {kickGain, kickDecay}\n\nexport default s("sbd*4")\n  .attack(0.001).decay(kickDecay).sustain(0).release(0.02)\n  .gain(enabled ? Math.max(0, kickGain) : 0)\n',
  "playground/lead.strudel":
    "import { waveform, voiceDecay } from './tone.strudel'\n\nconst Fx = Object.freeze({\n  Crush: 'crush',\n  Lowpass: 'lowpass',\n  Drive: 'drive',\n  Echo: 'echo',\n})\n\nconst effects = [Fx.Crush, Fx.Lowpass]\nconst leadGain = 0.1\nconst leadPan = 0.2 // @slider -1..1\nconst enabled = true\nconst leadVoice = {leadGain, leadPan, enabled, effects}\n\nconst lead = note(\"c4*4\")\n  .s(waveform)\n  .attack(0.01).decay(voiceDecay).sustain(0.1).release(0.08)\n  .pan(leadPan)\n  .gain(enabled ? Math.max(0, leadGain) : 0)\n\nconst stages = effects.map(effect => {\n  switch (effect) {\n    case Fx.Crush: return crush(3)\n    case Fx.Lowpass: return lpf(900).lpq(1.2)\n    case Fx.Drive: return distort(2).distortvol(0.5)\n    case Fx.Echo: return delay(0.45).delaytime(0.16).delayfeedback(0.35)\n  }\n})\n\nexport default effects.length ? lead.FX(...stages).fxr(0.6) : lead\n",
};

export async function seedControlGraph(root) {
  await writeFiles(root, files);
}
