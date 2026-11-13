// Named exports + shared dependency. Controls occur only once in the master panel.
const Wave = Object.freeze({ Sine: 'sine', Triangle: 'triangle', Square: 'square' })
export const waveform = Wave.Sine // @default Wave.Sine
// @default 0.7
export const decay = 0.7 // @slider 0.1..1.4
// @default 0.24
export const wet = 0.24 // @slider vertical 0..0.5
const prism = {waveform, decay, wet}
export const voice = (notes, pan, orbit) => note(notes).s(waveform)
  .fm(0.65).fmh(2).decay(decay).sustain(0).release(0.1)
  .lpf(3200).hpf(300).pan(pan).room(wet).roomsize(3).orbit(orbit)
