// Build-time brand switch: `node brand.mjs fuilfl` (or reitrn). Writes brand.json for the runtime and sets the
// electron-builder fields that must be baked into the installer: product name, appId, icons, installer file name.
// The GitHub workflow runs this once per brand before `npm run build`, so one tag releases both installers.
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { BRANDS } = require('./brand.js');

const key = process.argv[2] || 'reitrn';
const b = BRANDS[key];
if (!b) { console.error(`unknown brand "${key}" — one of ${Object.keys(BRANDS).join(', ')}`); process.exit(1); }

writeFileSync('brand.json', JSON.stringify({ brand: key }, null, 2) + '\n');
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
pkg.build.appId = b.appId;
pkg.build.productName = b.name;
pkg.build.nsis.installerIcon = `${b.assets}/icon.ico`;
pkg.build.nsis.uninstallerIcon = `${b.assets}/icon.ico`;
pkg.build.nsis.artifactName = b.artifact;
pkg.build.win.icon = `${b.assets}/icon.png`;
pkg.build.win.artifactName = b.artifact;
writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
console.log(`brand → ${key}: ${b.name}, ${b.appId}, ${b.artifact}`);
