export const starterFiles: Record<string, string> = {
  "controls-demo.strudel": `// Playground · drum groove, bass and a lead with stackable effects.
// Press Play. Toggle effects or drag their handles to change the chain.
// All effects can be switched off; the panel remembers the enum and row order.
const Wave = Object.freeze({
  Sine: "sine",
  Triangle: "triangle",
  Saw: "sawtooth",
})

const Fx = Object.freeze({
  Echo: "echo",
  Chorus: "chorus",
  Crush: "crush",
})

const waveform = Wave.Triangle
const effects = [Fx.Echo, Fx.Chorus]
const enabled = true
const gain = 0.2
const repeats = 1

const cutoff = 1200 // @slider fire 20..20000
const pan = 0       // @slider vertical -1..1
const speed = 1     // @slider 0.25..4
const wet = 0.15    // @slider vertical 0..1

const tempo = 108 // @ignore
setcpm(tempo / 4)

const volume = Math.max(0, gain)
const level = enabled ? 0.8 * (volume / (1 + volume)) : 0

// Kick, backbeat and alternating closed/open hats. All sounds are synthesized.
const drums = stack(
  s("<[sbd ~ ~ sbd ~ ~ sbd ~] [sbd ~ sbd ~ ~ sbd ~ sbd]>")
    .decay(0.22).pdecay(0.065).gain(level * 1.5),
  s("~ white ~ [white ~]")
    .bpf(1900).bpq(1.6).decay(0.09).sustain(0).gain(level * 0.58),
  s("[~ white]*4")
    .hpf(7000).decay("<0.03 0.075>").sustain(0).gain(level * 0.28),
  s("~ ~ ~ [~ white*3]")
    .hpf(9300).decay(0.028).sustain(0).pan(0.4).gain(level * 0.13)
)

const bass = note("<[c2 ~ c2 g2 ~ c2 bb1 ~] [ab1 ~ ab1 eb2 ~ g1 bb1 ~]>")
  .s("sawtooth").lpf(420).decay(0.13).sustain(0.1).gain(level * 0.72)

const lead = note("<[~ eb4 g4 ~ bb4 ~ g4 ~] [~ eb4 ~ f4 g4 [~ c5] bb4 ~]>")
  .s(waveform).orbit(1)
  .decay(0.14).sustain(0.12).release(0.12)
  .fast(Math.max(1, repeats) * speed)
  .lpf(cutoff).pan(pan).room(wet).gain(level)

const effectedLead = effects.reduce((voice, effect) => {
  switch (effect) {
    case Fx.Echo: return voice.delay(0.38).delaytime(30 / tempo).delayfeedback(0.42)
    case Fx.Chorus: return voice.chorus(0.55)
    case Fx.Crush: return voice.crush(5)
    default: return voice
  }
}, lead)

stack(drums, bass, effectedLead)
`,
  "first-light.strudel": `// First light
// A composition made from reusable snippets.
// Press ⌘ Enter to play or update. ⌘ . to stop.

import glass from './instruments/glass.strudel'

// Adjust these in the Controls panel while playing.
const tempo = 108
let bassGain = 0.45
var brightness = 800

setcpm(tempo / 4)

stack(
  // Open instruments/glass.strudel to change this voice.
  // Return here and press Update to hear your changes.
  glass,

  // Something to hold it together
  note("<c2 a1 f1 g1>*4")
    .s("sine")
    .decay(0.18).sustain(0)
    .lpf(brightness)
    .gain(bassGain)
)
`,
  "sketches/soft-steps.strudel": `// Soft steps · a little movement
setcpm(120 / 4)

note("c3 [e3 g3] b3 [a3 g3]")
  .s("triangle")
  .decay(0.2).sustain(0)
  .delay(0.25).delaytime(0.375)
  .gain(0.35)
`,
  "sketches/low-tide.strudel": `// Low tide · let it breathe
setcpm(80 / 4)

note("<c2 f2 a1 g1>")
  .s("sawtooth")
  .lpf(450)
  .attack(0.1).release(0.8)
  .gain(0.2)
`,
  "instruments/glass.strudel": `// Glass · a simple bell
// Exported to first-light.strudel. You can also play this file on its own.

export default note("c5 ~ [g5 e5] ~")
  .s("sine")
  .fm(2).fmh(2)
  .decay(0.3).sustain(0)
  .delay(0.4)
  .gain(0.25)
`,
};
