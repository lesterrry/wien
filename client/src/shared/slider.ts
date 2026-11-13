export function validateSliderBounds(start: number, end: number) {
  if (![start, end].every(Number.isFinite))
    throw new Error("Slider expects finite numbers: min, max, value.");
  if (start >= end || !Number.isFinite(end - start))
    throw new Error("Slider min must be less than max, with a finite span.");
}

export function validateSliderRange(start: number, end: number, value: number) {
  validateSliderBounds(start, end);
  if (!Number.isFinite(value)) throw new Error("Slider value must be finite.");
  if (value < start || value > end)
    throw new Error("Slider value must be within min and max.");
}

export function clampSliderValue(start: number, end: number, value: number) {
  const clamped = Math.min(end, Math.max(start, value));
  if (clamped === start || clamped === end) return clamped;
  // Round relative to the span so a narrow range around a large value stays usable.
  const decimals = Math.max(
    0,
    Math.min(100, 8 - Math.floor(Math.log10(end - start))),
  );
  return Math.min(end, Math.max(start, Number(clamped.toFixed(decimals))));
}
