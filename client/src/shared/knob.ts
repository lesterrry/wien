export interface KnobSettings {
  step: number;
  min?: number;
  max?: number;
  split: number;
}

export function boundedKnob(
  settings: KnobSettings,
): settings is KnobSettings & {
  min: number;
  max: number;
} {
  return settings.min !== undefined && settings.max !== undefined;
}

export function clampKnobValue(value: number, settings: KnobSettings) {
  return boundedKnob(settings)
    ? Math.max(settings.min, Math.min(settings.max, value))
    : value;
}

export function knobIncrement(settings: KnobSettings) {
  if (settings.split === 0) return settings.step;
  return boundedKnob(settings)
    ? (settings.max - settings.min) / settings.split
    : settings.step * (12 / settings.split);
}

export function normalizeKnobValue(value: number, settings: KnobSettings) {
  const clamped = clampKnobValue(value, settings);
  if (settings.split === 0) return clamped;
  const increment = knobIncrement(settings);
  const origin = settings.min ?? 0;
  const index = Math.round((clamped - origin) / increment);
  if (!Number.isFinite(index)) return clamped;
  if (boundedKnob(settings)) {
    if (index <= 0) return settings.min;
    if (index >= settings.split) return settings.max;
  }
  // Round relative to the interval without losing precision around large bounds.
  const decimals = Math.max(
    0,
    Math.min(100, 12 - Math.floor(Math.log10(knobIncrement(settings)))),
  );
  return clampKnobValue(
    Number((origin + index * increment).toFixed(decimals)),
    settings,
  );
}

export function knobAngle(value: number, settings: KnobSettings) {
  if (boundedKnob(settings)) {
    const progress =
      (clampKnobValue(value, settings) - settings.min) /
      (settings.max - settings.min);
    return -150 + progress * 300;
  }
  return Number.isFinite(value / settings.step)
    ? ((value / settings.step) % 12) * 30
    : 0;
}
