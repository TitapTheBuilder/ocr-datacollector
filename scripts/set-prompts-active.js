#!/usr/bin/env node
//
// Break-glass: flip every prompt's active flag directly in the database file.
//
//   node scripts/set-prompts-active.js 1      # reactivate every prompt
//   node scripts/set-prompts-active.js 0      # deactivate every prompt
//   node scripts/set-prompts-active.js 1 words   # only one category
//
// STOP THE SERVER FIRST. sql.js keeps the whole database in memory and rewrites the
// file on its own schedule, so any edit made to the file while the server is running
// is silently overwritten the next time it saves. That is the trap behind
// "I ran an UPDATE and nothing changed" — and the reason the admin panel now has a
// button for this, which is the safer way to do it on a live server.
//
// A timestamped copy of the database is written next to it before anything changes.

const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');
const config = require('../config');

async function main() {
  const raw = process.argv[2];
  const category = process.argv[3] || null;

  if (raw !== '0' && raw !== '1') {
    console.error('Usage: node scripts/set-prompts-active.js <0|1> [category]');
    process.exit(1);
  }
  const flag = Number(raw);

  if (!fs.existsSync(config.DB_PATH)) {
    console.error(`Database not found at ${config.DB_PATH}`);
    console.error('Set PERSISTENT_DATA_PATH to the volume the server uses, then retry.');
    process.exit(1);
  }

  const backup = `${config.DB_PATH}.${new Date().toISOString().replace(/[:.]/g, '-')}.bak`;
  fs.copyFileSync(config.DB_PATH, backup);
  console.log(`Backup written: ${backup}`);

  const SQL = await initSqlJs();
  const db = new SQL.Database(fs.readFileSync(config.DB_PATH));

  const count = (sql) => {
    const res = db.exec(sql);
    return res[0] ? res[0].values[0][0] : 0;
  };

  const total = count('SELECT COUNT(*) FROM prompts');
  const before = count('SELECT COUNT(*) FROM prompts WHERE active = 1');

  if (category) {
    db.run('UPDATE prompts SET active = ? WHERE category = ?', [flag, category]);
  } else {
    db.run('UPDATE prompts SET active = ?', [flag]);
  }

  const after = count('SELECT COUNT(*) FROM prompts WHERE active = 1');

  // Write via a temp file and rename, so an interrupted run cannot truncate the
  // database it was asked to repair.
  const tmp = `${config.DB_PATH}.tmp`;
  fs.writeFileSync(tmp, Buffer.from(db.export()));
  fs.renameSync(tmp, config.DB_PATH);
  db.close();

  console.log(`Prompts total : ${total}`);
  console.log(`Active before : ${before}`);
  console.log(`Active after  : ${after}`);
  console.log('Done. Start the server again.');
}

main().catch(err => {
  console.error('Failed:', err.message);
  process.exit(1);
});
