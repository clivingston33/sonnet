/**
 * Puts the bundled server (desktop/server) into the packaged app's resources. Done here and not
 * with `extraResources`, which leaves out every node_modules folder, and the server needs its own.
 */
const fs = require("node:fs");
const path = require("node:path");

exports.default = async ({ appOutDir, packager }) => {
  const resources =
    packager.platform.name === "mac"
      ? path.join(appOutDir, `${packager.appInfo.productFilename}.app`, "Contents", "Resources")
      : path.join(appOutDir, "resources");
  fs.cpSync(path.join(__dirname, "server"), path.join(resources, "server"), { recursive: true });
};
