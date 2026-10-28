/**
 * Launch Electron with a clean environment.
 * VS Code sets ELECTRON_RUN_AS_NODE=1 which prevents Electron
 * from initializing its main process. This launcher removes that.
 */
const cp = require("child_process");
const electronPath = require("electron");

const env = Object.assign({}, process.env);
delete env.ELECTRON_RUN_AS_NODE;

const child = cp.spawn(electronPath, ["."], {
  stdio: "inherit",
  env,
});

child.on("close", (code) => {
  process.exit(code || 0);
});
