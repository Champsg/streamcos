'use strict';

/**
 * Clears the Owner Studio PIN and prints a fresh first-run setup code.
 *
 * This is the supported recovery path for a forgotten PIN (the old in-app
 * "Reset PIN" button called an endpoint that ignored the request). Having
 * shell access to the machine that hosts StreamCos is already equivalent to
 * owning it, so a local CLI is the honest place for this.
 *
 * Usage: node backend/reset-pin.js --yes
 */

const path = require('path');
const store = require('./store');
const { createSetupRecord } = require('./owner');

const DATA_FILE = process.env.STREAMCOS_DATA_FILE
  ? path.resolve(process.env.STREAMCOS_DATA_FILE)
  : path.join(__dirname, 'data.json');

function main() {
  if (!process.argv.includes('--yes')) {
    console.log('This clears the Owner Studio PIN for:');
    console.log('  ' + DATA_FILE);
    console.log('Re-run with --yes to confirm: node backend/reset-pin.js --yes');
    return 1;
  }

  const loaded = store.load(DATA_FILE);
  if (!loaded.data) {
    console.error('Could not read the store at ' + DATA_FILE + ' — nothing changed.');
    return 1;
  }

  const db = loaded.data;
  const hadPin = Boolean(db.ownerPinHash);
  delete db.ownerPinHash;
  delete db.ownerPinSalt;

  const { record, code } = createSetupRecord(process.env.STREAMCOS_SETUP_CODE || null);
  db.ownerSetup = record;

  store.save(DATA_FILE, db);

  console.log(hadPin ? 'Owner PIN cleared.' : 'No PIN was set; generated a setup code anyway.');
  console.log('');
  console.log('  Setup code: ' + code);
  console.log('');
  console.log('Open StreamCos → Account → Owner Studio and enter this code with a new PIN.');
  console.log('Store: ' + DATA_FILE);
  return 0;
}

process.exitCode = main();
