export interface SliderSettings {
  presentation: "horizontal" | "vertical";
  min: number;
  max: number;
  integer: boolean;
  style?: string;
}

export function isControlAnnotation(text: string) {
  return /^@(ignore|slider|multi)\b/.test(text);
}

export function sliderSettings(annotations: string[]): SliderSettings {
  let slider = false;
  let orientation: "horizontal" | "vertical" | undefined;
  let style: string | undefined;
  let range: [number, number] | undefined;
  let integerBounds = true;
  const setOrientation = (next: "horizontal" | "vertical") => {
    if (orientation !== undefined)
      throw new Error("Specify direction only once.");
    orientation = next;
  };
  const setRange = (min: number | undefined, max: number | undefined) => {
    if (range) throw new Error("Specify the range only once.");
    if (min === undefined || max === undefined)
      throw new Error("Use a numeric range, e.g. 100..8000.");
    range = [min, max];
  };
  const setStyle = (next: string) => {
    if (!/^[a-zA-Z][\w-]*$/.test(next))
      throw new Error("Slider style must be a name, e.g. fire.");
    if (style !== undefined) throw new Error("Specify the style only once.");
    style = next;
  };
  for (const annotation of annotations) {
    const match = /^@slider(?:\s+(.*))?$/.exec(annotation);
    if (!match) throw new Error(`Invalid annotation: //${annotation}`);
    if (slider) throw new Error("Specify @slider only once.");
    slider = true;
    for (const token of match[1]?.trim().split(/\s+/) ?? []) {
      if (token === "vertical") setOrientation("vertical");
      else if (token === "horizontal" || token === "default")
        setOrientation("horizontal");
      else if (token.includes("..")) {
        const parts = token.split("..");
        if (parts.length !== 2) throw new Error("Use min..max for the range.");
        const number = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i;
        setRange(
          number.test(parts[0]) ? Number(parts[0]) : undefined,
          number.test(parts[1]) ? Number(parts[1]) : undefined,
        );
        integerBounds = parts.every((part) => !part.includes("."));
      } else setStyle(token);
    }
  }
  if (orientation && !slider) throw new Error("Direction requires @slider.");
  const [min, max] = range ?? [0, 1];
  return {
    presentation: orientation ?? "horizontal",
    min,
    max,
    integer: integerBounds && Number.isInteger(min) && Number.isInteger(max),
    ...(style ? { style } : {}),
  };
}
