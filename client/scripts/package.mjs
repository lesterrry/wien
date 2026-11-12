import path from "node:path";
import { build, Platform } from "electron-builder";

const applications = [];

await build({
  targets: Platform.current().createTarget("dir"),
  publish: "never",
  config: {
    afterPack(context) {
      applications.push(
        context.electronPlatformName === "darwin"
          ? path.join(
              context.appOutDir,
              `${context.packager.appInfo.productFilename}.app`,
            )
          : context.appOutDir,
      );
    },
  },
});

for (const application of applications) {
  console.log(`\nBuilt application: ${path.resolve(application)}`);
}
