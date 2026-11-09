export const starterFiles: Record<string, string> = {
  "first-light.strudel": `// First light
// A small loop. A place to begin.
// Press ⌘ Enter to play or update. ⌘ . to stop.

setcpm(108 / 4)

stack(
  // A warm, wandering melody
  note("<c4 e4 g4 b4> [e4 g4] ~ g4")
    .s("triangle")
    .attack(0.02).release(0.4)
    .delay(0.3).delaytime(0.25)
    .gain(0.3),

  // Something to hold it together
  note("<c2 a1 f1 g1>*4")
    .s("sine")
    .decay(0.18).sustain(0)
    .gain(0.45)
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
setcpm(100 / 4)

note("c5 ~ [g5 e5] ~")
  .s("sine")
  .fm(2).fmh(2)
  .decay(0.3).sustain(0)
  .delay(0.4)
  .gain(0.25)
`,
};
