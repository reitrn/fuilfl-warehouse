// Which brand this build is: reitrn (default) or fuilfl. Baked at build time by `node brand.mjs <brand>`, which
// writes brand.json and points package.json's build block at the right name, appId, icons and installer name.
// Runtime reads brand.json; without one it is reitrn, so `npm start` from a clean checkout behaves as before.
const fs = require('fs');
const path = require('path');

const BRANDS = {
  reitrn: {
    key: 'reitrn', name: 'reitrn Warehouse', pkgName: 'reitrn-warehouse', word: 'reitrn', appId: 'com.reitrn.warehouse', uaToken: 'reitrnWarehouse',
    portalUrl: 'https://portal.reitrn.com', assets: 'assets', livingGradient: true, fixedGradient: null, artifact: 'reitrn-warehouse-setup.exe', pingApp: 'reitrn-warehouse',
  },
  fuilfl: {
    key: 'fuilfl', name: 'fuilfl Warehouse', pkgName: 'fuilfl-warehouse', word: 'fuilfl', appId: 'com.fuilfl.warehouse', uaToken: 'fuilflWarehouse',
    portalUrl: 'https://portal.fuilfl.com', assets: 'assets/fuilfl', livingGradient: false, fixedGradient: { start: '#00C4A7', end: '#2F7BFF' }, artifact: 'fuilfl-warehouse-setup.exe', pingApp: 'fuilfl-warehouse',
  },
};

let key = 'reitrn';
try { key = JSON.parse(fs.readFileSync(path.join(__dirname, 'brand.json'), 'utf8')).brand || 'reitrn'; } catch { /* no brand.json = reitrn */ }
if (process.env.APP_BRAND && BRANDS[process.env.APP_BRAND]) key = process.env.APP_BRAND;   // dev override: APP_BRAND=fuilfl npm start

module.exports = { ...BRANDS[key], BRANDS, asset: (f) => path.join(__dirname, BRANDS[key].assets, f) };
