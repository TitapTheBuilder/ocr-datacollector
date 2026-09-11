// Recovery and import behaviour for the prompt bank.
//
// Reproduces the incident exactly — `UPDATE prompts SET active = 0` with no WHERE
// clause, which hides every prompt without deleting anything — and proves the admin
// panel can put it back in one request. Then checks that a large import behaves:
// 1000 rows in one upload, duplicates skipped and counted, existing rows untouched.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(os.tmpdir(), `ocr-prompts-test-${Date.now()}`);
fs.mkdirSync(ROOT, { recursive: true });

process.env.PERSISTENT_DATA_PATH = ROOT;
process.env.CONTRIBUTOR_SECRET = 'test-secret-for-prompt-bank';
process.env.ADMIN_USERNAME = 'admin';
process.env.PORT = '4143';

const ADMIN_PASSWORD = 'prompt-bank-password';
{
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(ADMIN_PASSWORD, salt, 64).toString('hex');
  process.env.ADMIN_PASSWORD_HASH = `${salt}:${hash}`;
}

const BASE = `http://127.0.0.1:${process.env.PORT}`;

let passed = 0;
let failed = 0;

function check(name, condition, detail) {
  if (condition) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function main() {
  require('../server.js');
  await new Promise(r => setTimeout(r, 2500));
  const db = require('../database');

  // --- Seed a bank shaped like the real one --------------------------------
  db.createPromptsBatch(Array.from({ length: 600 }, (_, i) => `جمله پایه شماره ${i + 1}`), 'words');
  db.createPromptsBatch(Array.from({ length: 40 }, (_, i) => `${3000 + i}`), 'numbers');
  db.flushIfDirty();

  const stats0 = db.getPromptStats();
  check('bank seeded', stats0.total === 640 && stats0.active === 640, JSON.stringify(stats0));

  const loginRes = await fetch(`${BASE}/api/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: ADMIN_PASSWORD }),
  });
  const cookie = (loginRes.headers.get('set-cookie') || '').split(';')[0];
  const adminHeaders = { Cookie: cookie, 'Content-Type': 'application/json' };
  check('admin login succeeds', !!cookie);

  // --- The incident --------------------------------------------------------
  db.db.get().run('UPDATE prompts SET active = 0');
  db.markDirty();
  db.flushIfDirty();

  const broken = db.getPromptStats();
  check('the WHERE-less UPDATE deactivates every prompt', broken.active === 0, JSON.stringify(broken));
  check('...but deletes nothing — every row is still there', broken.total === 640, JSON.stringify(broken));

  // With nothing active, a volunteer gets no sheet at all: this is what "everything
  // is gone" looks like from the outside.
  {
    const reg = await (await fetch(`${BASE}/api/contributors/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'قربانی' }),
    })).json();
    const sheets = await (await fetch(`${BASE}/api/sheets`, {
      headers: { 'X-Contributor-Token': reg.token },
    })).json();
    check('with every prompt inactive, no sheet can be built',
      sheets.sheets.sentences.available === false && sheets.sheets.numbers.available === false,
      JSON.stringify(sheets.sheets).slice(0, 200));
  }

  // --- The one-request recovery -------------------------------------------
  {
    const res = await fetch(`${BASE}/api/admin/prompts/bulk-active`, {
      method: 'POST', headers: adminHeaders, body: JSON.stringify({ active: 1 }),
    });
    const data = await res.json();
    check('bulk-active restores every prompt in one request',
      data.success && data.stats.active === 640, JSON.stringify(data).slice(0, 200));
    check('the restore reports how many rows it changed', data.changed === 640, `${data.changed}`);
  }

  // A fresh volunteer gets a full sheet again.
  {
    const reg = await (await fetch(`${BASE}/api/contributors/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'بعد از بازیابی' }),
    })).json();
    const sheets = await (await fetch(`${BASE}/api/sheets`, {
      headers: { 'X-Contributor-Token': reg.token },
    })).json();
    check('volunteers can be served sheets again',
      sheets.sheets.sentences.items.length === 10 && sheets.sheets.numbers.items.length === 10,
      JSON.stringify(sheets.sheets.sentences.items.length));
  }

  // --- Scoped deactivation still works ------------------------------------
  {
    const res = await fetch(`${BASE}/api/admin/prompts/bulk-active`, {
      method: 'POST', headers: adminHeaders, body: JSON.stringify({ active: 0, category: 'numbers' }),
    });
    const data = await res.json();
    check('a category-scoped flip touches only that category',
      data.changed === 40 && data.stats.active === 600, JSON.stringify(data.stats));
    await fetch(`${BASE}/api/admin/prompts/bulk-active`, {
      method: 'POST', headers: adminHeaders, body: JSON.stringify({ active: 1 }),
    });
  }

  {
    const res = await fetch(`${BASE}/api/admin/prompts/bulk-active`, {
      method: 'POST', headers: adminHeaders, body: JSON.stringify({ active: 'yes' }),
    });
    check('a nonsense active value is refused', res.status === 400, `status ${res.status}`);
  }

  // --- Importing 1000 more sentences --------------------------------------
  const uploadTxt = async (lines, category) => {
    const form = new FormData();
    form.append('category', category);
    form.append('csv', new Blob([lines.join('\n')], { type: 'text/plain' }), 'sentences.txt');
    const res = await fetch(`${BASE}/api/admin/prompts/upload`, {
      method: 'POST', headers: { Cookie: cookie }, body: form,
    });
    return res.json();
  };

  {
    const fresh = Array.from({ length: 1000 }, (_, i) => `جمله تازه برای تعادل شماره ${i + 1}`);
    const data = await uploadTxt(fresh, 'sentences');
    check('a 1000-line import goes through in one upload',
      data.success && data.imported === 1000, JSON.stringify(data).slice(0, 200));
    check('nothing was skipped on a clean import', data.skipped === 0, `${data.skipped}`);

    const stats = db.getPromptStats();
    check('the bank grew by exactly 1000', stats.total === 1640, JSON.stringify(stats));
    check('the original prompts are untouched and still active',
      stats.active === 1640, JSON.stringify(stats));
    check('new rows land in the category that was picked',
      (stats.byCategory.find(c => c.category === 'sentences') || {}).total === 1000,
      JSON.stringify(stats.byCategory));
  }

  // --- Re-uploading the same file must not double the bank -----------------
  {
    const same = Array.from({ length: 1000 }, (_, i) => `جمله تازه برای تعادل شماره ${i + 1}`);
    const data = await uploadTxt(same, 'sentences');
    check('re-uploading the same file imports nothing', data.imported === 0, `${data.imported}`);
    check('...and reports every row as a skipped duplicate', data.skipped === 1000, `${data.skipped}`);
    check('the bank size is unchanged', db.getPromptStats().total === 1640);
  }

  // --- Duplicates within one file, and Persian codepoint variants ----------
  {
    // Same sentence three ways: plain, with Arabic ye/kaf, and with a ZWNJ. All one
    // line as far as coverage is concerned.
    const data = await uploadTxt([
      'سلام دنیای کوچک',
      'سلام دنياي كوچك',
      'سلام دنیای کوچک',
      'یک جمله کاملا تازه',
    ], 'sentences');
    check('Arabic/Persian codepoint variants count as one prompt',
      data.imported === 2 && data.skipped === 2,
      `imported ${data.imported}, skipped ${data.skipped}`);
  }

  {
    const data = await uploadTxt(['   ', '', 'یک جمله دیگر'], 'sentences');
    check('blank lines are ignored rather than imported', data.imported === 1, `${data.imported}`);
  }

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(err => {
  console.error('Test run crashed:', err);
  process.exit(1);
});
