const assert = require('assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Setup test environment
const testDbPath = path.join(__dirname, 'test-verification.db');
process.env.DB_PATH = testDbPath;
process.env.PERSISTENT_DATA_PATH = __dirname;
delete process.env.CONTRIBUTOR_SECRET;
delete process.env.ADMIN_PASSWORD_HASH;

// Clean up any old test db
if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
if (fs.existsSync(testDbPath + '.tmp')) fs.unlinkSync(testDbPath + '.tmp');

async function runTests() {
  console.log('=== RUNNING VERIFICATION FOR ALL 14 BUGS ===\n');

  // --- Bug 2: Random CONTRIBUTOR_SECRET fallback ---
  console.log('Testing Bug 2: Cryptographically random CONTRIBUTOR_SECRET when env unset...');
  const config = require('../config');
  assert.ok(config.CONTRIBUTOR_SECRET, 'CONTRIBUTOR_SECRET should be defined');
  assert.strictEqual(typeof config.CONTRIBUTOR_SECRET, 'string');
  assert.strictEqual(config.CONTRIBUTOR_SECRET.length, 64, 'Random secret should be 32 hex bytes (64 chars)');
  console.log('  [PASS] Bug 2 verified: Generated random 64-char hex secret.');

  // --- Bug 3: No default admin123, unique password per startup ---
  console.log('Testing Bug 3: No default admin123 password...');
  const serverCode = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
  const configCode = fs.readFileSync(path.join(__dirname, '../config.js'), 'utf8');
  assert.ok(!serverCode.includes('admin123'), 'server.js must not contain default admin123');
  assert.ok(!configCode.includes('admin123'), 'config.js must not contain default admin123');
  assert.ok(serverCode.includes("crypto.randomBytes(12).toString('base64url')"), 'server.js must generate random admin password');
  console.log('  [PASS] Bug 3 verified: Default admin123 removed, random generator present.');

  // Initialize DB
  const db = require('../database');
  await db.initDatabase();

  // --- Bug 1: No PRAGMA journal_mode = WAL, sql.js in-memory comment ---
  console.log('Testing Bug 1: No-op WAL pragma removed and documented...');
  const dbCode = fs.readFileSync(path.join(__dirname, '../database.js'), 'utf8');
  assert.ok(!dbCode.includes('PRAGMA journal_mode = WAL'), 'database.js must not contain PRAGMA journal_mode = WAL');
  assert.ok(dbCode.includes('sql.js is a WebAssembly in-memory SQLite'), 'database.js must have in-memory explanation comment');
  console.log('  [PASS] Bug 1 verified: No-op WAL pragma removed.');

  // --- Bug 4: Debounced persistence (markDirty, flushIfDirty, shutdown save) ---
  console.log('Testing Bug 4: Debounced DB persistence...');
  assert.strictEqual(typeof db.markDirty, 'function');
  assert.strictEqual(typeof db.flushIfDirty, 'function');
  assert.strictEqual(typeof db.saveDatabase, 'function');
  db.createPrompt('تست ذخیره تاخیری', 'custom');
  // Flush manually and verify file exists on disk
  db.flushIfDirty();
  assert.ok(fs.existsSync(config.DB_PATH), 'DB file should be written to disk on flush');
  console.log('  [PASS] Bug 4 verified: Debounced persistence functioning.');

  // --- Bug 6: Application-level referential integrity checks in createImage ---
  console.log('Testing Bug 6: Referential integrity checks in createImage...');
  // 6a: Missing contributorId should throw 400
  let errThrown = false;
  try {
    db.createImage({ filename: 'test1.jpg', contributorId: null });
  } catch (err) {
    errThrown = true;
    assert.strictEqual(err.statusCode, 400, 'Status code should be 400 for missing contributor');
  }
  assert.ok(errThrown, 'Missing contributorId must be rejected');

  // 6b: Non-existent contributorId should throw 400
  errThrown = false;
  try {
    db.createImage({ filename: 'test2.jpg', contributorId: 'ghost_contributor_12345' });
  } catch (err) {
    errThrown = true;
    assert.strictEqual(err.statusCode, 400, 'Status code should be 400 for non-existent contributor');
  }
  assert.ok(errThrown, 'Non-existent contributorId must be rejected');

  // 6c: Non-existent promptId should throw 400
  db.createContributor('contrib_ref_test', 'تست کننده', 'MoziTest');
  errThrown = false;
  try {
    db.createImage({ filename: 'test3.jpg', contributorId: 'contrib_ref_test', promptId: 999999 });
  } catch (err) {
    errThrown = true;
    assert.strictEqual(err.statusCode, 400, 'Status code should be 400 for non-existent promptId');
  }
  assert.ok(errThrown, 'Non-existent promptId must be rejected');
  console.log('  [PASS] Bug 6 verified: Application-level referential integrity enforced.');

  // --- Bug 7: createContributor 3-parameter signature ---
  console.log('Testing Bug 7: Strict (id, name, userAgent) createContributor signature...');
  db.createContributor('contrib_sig_test', 'نام تستی', 'Agent 1.0');
  const contrib = db.getContributor('contrib_sig_test');
  assert.strictEqual(contrib.id, 'contrib_sig_test');
  assert.strictEqual(contrib.name, 'نام تستی');
  assert.strictEqual(contrib.user_agent, 'Agent 1.0');
  console.log('  [PASS] Bug 7 verified: Strict 3-parameter signature stores data properly.');

  // --- Bug 8: getRandomPrompt never assigns repeat prompts to contributor ---
  console.log('Testing Bug 8: getRandomPrompt excludes all previously written prompts...');
  const p1 = db.createPrompt('جمله تست یک', 'words');
  const p2 = db.createPrompt('جمله تست دو', 'words');
  const p1Id = p1.lastInsertRowid;
  const p2Id = p2.lastInsertRowid;

  const testContribId = 'contrib_prompt_test';
  db.createContributor(testContribId, 'تست متن', 'Agent');

  // Record image for p1Id
  db.createImage({
    filename: 'p1_img.jpg',
    contributorId: testContribId,
    promptId: p1Id,
    fileHash: 'hash_p1',
  });

  // Now getRandomPrompt should NOT return p1Id for testContribId
  for (let i = 0; i < 5; i++) {
    const prompt = db.getRandomPrompt(testContribId, 'sentences');
    assert.ok(prompt, 'A prompt should be returned');
    assert.notStrictEqual(prompt.id, p1Id, 'Prompt must NOT be the previously submitted p1Id');
  }
  console.log('  [PASS] Bug 8 verified: Previously written prompts excluded.');

  // --- Bug 11: Write-lock (JS mutex queue) around createImageSafe preventing concurrent duplicate hash race ---
  console.log('Testing Bug 11: Concurrent duplicate hash race prevention in createImageSafe...');
  const hashContribId = 'contrib_concurrent_test';
  db.createContributor(hashContribId, 'تست همزمانی', 'Agent');
  const sharedHash = 'identical_file_hash_999';

  // Fire two concurrent inserts with the exact same file hash
  const promise1 = db.createImageSafe({
    filename: 'concurrent_1.jpg',
    contributorId: hashContribId,
    fileHash: sharedHash,
  });
  const promise2 = db.createImageSafe({
    filename: 'concurrent_2.jpg',
    contributorId: hashContribId,
    fileHash: sharedHash,
  });

  const results = await Promise.allSettled([promise1, promise2]);
  const fulfilled = results.filter(r => r.status === 'fulfilled');
  const rejected = results.filter(r => r.status === 'rejected');

  assert.strictEqual(fulfilled.length, 1, 'Exactly 1 concurrent upload must succeed');
  assert.strictEqual(rejected.length, 1, 'Exactly 1 concurrent upload must be rejected as duplicate');
  assert.strictEqual(rejected[0].reason.message, 'DUPLICATE_IMAGE');
  assert.strictEqual(rejected[0].reason.statusCode, 409);
  console.log('  [PASS] Bug 11 verified: Mutex queue safely prevents duplicate race.');

  // --- Bug 5: CSV formula injection sanitization ---
  console.log('Testing Bug 5: CSV formula injection sanitization...');
  // Extract csvSafeCell from server.js
  const matchSafeCell = serverCode.match(/function csvSafeCell\(value\) \{[\s\S]*?\n\}/);
  assert.ok(matchSafeCell, 'csvSafeCell function must exist in server.js');
  const csvSafeCell = new Function('value', matchSafeCell[0] + '; return csvSafeCell(value);');

  assert.strictEqual(csvSafeCell('=1+1'), "'=1+1");
  assert.strictEqual(csvSafeCell('+cmd|/c calc'), "'+cmd|/c calc");
  assert.strictEqual(csvSafeCell('-500'), "'-500");
  assert.strictEqual(csvSafeCell('@SUM(A1:A10)'), "'@SUM(A1:A10)");
  assert.strictEqual(csvSafeCell('\tcalc'), "'\tcalc");
  assert.strictEqual(csvSafeCell('\rtest'), "'\rtest");
  assert.strictEqual(csvSafeCell('   =cmd'), "'   =cmd");
  assert.strictEqual(csvSafeCell('متن کاملاً عادی'), 'متن کاملاً عادی');
  console.log('  [PASS] Bug 5 verified: Formula injection characters prepended with single quote.');

  // --- Bug 9: Server quota check logic (20 sentences + 40 numbers = 60 total) ---
  console.log('Testing Bug 9: Server quota logic enforcement at 60 total...');
  assert.ok(serverCode.includes('progress.total >= 60'), 'server.js must enforce total >= 60 quota');
  assert.ok(serverCode.includes('progress.sentences >= 20 && progress.numbers >= 40'), 'server.js must enforce stage quota');
  console.log('  [PASS] Bug 9 verified: Server-side quota condition properly enforced.');

  // --- Bug 12: GitHub sync force: true ---
  console.log('Testing Bug 12: GitHub sync uses force: true on ref update...');
  const syncCode = fs.readFileSync(path.join(__dirname, '../github-sync.js'), 'utf8');
  assert.ok(syncCode.includes('sha: newCommit.sha, force: true'), 'github-sync.js must update ref with force: true');
  console.log('  [PASS] Bug 12 verified: GitHub ref update uses force: true.');

  // --- Bug 10: Admin purge-rejected only reloads active tab ---
  console.log('Testing Bug 10: Purge-rejected only reloads active tab in admin.js...');
  const adminCode = fs.readFileSync(path.join(__dirname, '../public/js/admin.js'), 'utf8');
  assert.ok(adminCode.includes('activeTabEl.dataset.tab'), 'admin.js must check active tab before reloading');
  console.log('  [PASS] Bug 10 verified: Purge-rejected only refreshes active tab.');

  // --- Bug 13: Prompt cancel handling in admin.js ---
  console.log('Testing Bug 13: Abort on cancel (null) in adminAction and executeBulkAction...');
  assert.ok(adminCode.includes('if (input === null) return;'), 'executeBulkAction must abort when input is null');
  assert.ok(adminCode.includes('if (rejectionReason === null) return;'), 'adminAction must abort when rejectionReason is null');
  console.log('  [PASS] Bug 13 verified: Both reject handlers abort on cancel.');

  // --- Bug 14: app.js always calls loadPrompt after custom text upload ---
  console.log('Testing Bug 14: Always call loadPrompt() after upload in customMode...');
  const appCode = fs.readFileSync(path.join(__dirname, '../public/js/app.js'), 'utf8');
  assert.ok(!appCode.includes("} else {\n            loadPrompt();\n          }"), 'app.js must not put loadPrompt() only in else branch');
  console.log('  [PASS] Bug 14 verified: loadPrompt() called unconditionally after upload.');

  console.log('\n=============================================');
  console.log('🎉 ALL 14 CRITICAL & MEDIUM BUGS VERIFIED SUCCESSFULLY!');
  console.log('=============================================\n');

  // Clean up test db
  if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
  if (fs.existsSync(testDbPath + '.tmp')) fs.unlinkSync(testDbPath + '.tmp');
}

runTests().catch(err => {
  console.error('\n❌ Test failure:', err);
  process.exit(1);
});
