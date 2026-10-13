'use strict';
// Run Electron through its npm package, so scripts work even without node_modules/.bin links.
// VS Code terminals set ELECTRON_RUN_AS_NODE, which would start Electron as plain Node.
const { spawnSync } = require('child_process');
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const { status } = spawnSync(require('electron'), process.argv.slice(2), { stdio: 'inherit', env });
process.exit(status ?? 1);
