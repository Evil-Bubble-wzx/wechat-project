const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const file = path.resolve(__dirname, '../.cache/device-local/gateway.json');
fs.mkdirSync(path.dirname(file), { recursive: true });
if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify({ accounts: ['primary', 'isolation'].map(name => ({ name, identity: `device-restricted-${name}`, key: randomBytes(32).toString('hex') })) }, null, 2), { flag: 'wx', mode: 0o600 });
console.log('Private gateway configuration ready; existing credentials preserved.');
