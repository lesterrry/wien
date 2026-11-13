import assert from "node:assert/strict";
import test from "node:test";
import {
  commandMenus,
  commands,
  matchCommand,
  primaryModifier,
  type ShortcutEnvironment,
  shortcutLabel,
} from "./commands";

function key(code: string, modifier: string, shiftKey = false) {
  return {
    code,
    metaKey: modifier === "Meta",
    ctrlKey: modifier === "Control",
    altKey: modifier === "Alt",
    shiftKey,
    isComposing: false,
    getModifierState: () => false,
  };
}

for (const [platform, os, expected] of [
  ["desktop", "mac", "Meta"],
  ["desktop", "windows", "Control"],
  ["desktop", "linux", "Control"],
  ["web", "mac", "Control"],
  ["web", "windows", "Alt"],
  ["web", "linux", "Control"],
] as const) {
  test(`${platform} on ${os}: exact ${expected} shortcuts`, () => {
    const environment: ShortcutEnvironment = { platform, os };
    assert.equal(primaryModifier(environment), expected);
    for (const command of commands) {
      if (!command.code || !command.key || command.alt) continue;
      assert.equal(
        matchCommand(key(command.code, expected, command.shift), environment)
          ?.id,
        command.id,
      );
      for (const other of ["Meta", "Control", "Alt"].filter(
        (modifier) => modifier !== expected,
      )) {
        assert.equal(
          matchCommand(key(command.code, other, command.shift), environment),
          undefined,
        );
      }
      assert(shortcutLabel(command, environment).includes(command.key));
    }
    const controlsKey = {
      ...key("KeyB", expected),
      altKey: true,
      ctrlKey: expected !== "Meta",
    };
    assert.equal(matchCommand(controlsKey, environment)?.id, "controls");
    assert.equal(
      matchCommand(key("KeyB", expected), environment)?.id,
      "sidebar",
    );
    assert.equal(
      matchCommand({ ...controlsKey, shiftKey: true }, environment),
      undefined,
    );
    assert.equal(
      matchCommand(
        { ...controlsKey, getModifierState: () => true },
        environment,
      ),
      undefined,
    );
    assert.equal(
      matchCommand(key("KeyW", expected, true), environment),
      undefined,
    );
    assert.equal(
      matchCommand(
        { ...key("Comma", expected), isComposing: true },
        environment,
      ),
      undefined,
    );
    assert.equal(
      matchCommand(
        { ...key("KeyS", expected), getModifierState: () => true },
        environment,
      ),
      undefined,
    );
  });
}

test("top-level menus exclude Controls and Navigate", () => {
  assert(
    !commandMenus.some((menu) => ["Controls", "Navigate"].includes(menu.label)),
  );
  assert(
    commandMenus
      .find((menu) => menu.label === "View")
      ?.commands.some((command) => command.id === "controls"),
  );
});
