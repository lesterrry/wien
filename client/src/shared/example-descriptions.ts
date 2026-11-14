// Keep picker copy alongside each example without loading its music into the UI.
const metadata = import.meta.glob<{ description: string }>(
  "../../../examples/*/example.json",
  { import: "default", eager: true },
);

export const exampleDescriptions: Record<string, string> = Object.fromEntries(
  Object.entries(metadata).map(([path, { description }]) => [
    path.split("/").at(-2),
    description,
  ]),
);
