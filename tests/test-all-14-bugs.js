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

// config.js derives DB_PATH from PERSISTENT_DATA_PATH and ignores process.env.DB_PATH,
// so the database this run actually writes is tests/data/ocr-data.db. Clearing only
// testDbPath left that file behind and every run started on top of the previous run's
// contributors, hashes and sheets — which makes the duplicate-hash and prompt-exclusion
// checks pass or fail depending on run order. Clear both.
const realDbPath = path.join(__dirname, 'data', 'ocr-data.db');
for (const p of [testDbPath, testDbPath + '.tmp', realDbPath, realDbPath + '.tmp']) {
  if (fs.existsSync(p)) fs.unlinkSync(p);
}

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

  // 6c: An image now belongs to a SHEET (assignment), not a single prompt.
  db.createContributor('contrib_ref_test', 'تست کننده', 'MoziTest');
  errThrown = false;
  try {
    db.createImage({ filename: 'test3.jpg', contributorId: 'contrib_ref_test', assignmentId: 999999 });
  } catch (err) {
    errThrown = true;
    assert.strictEqual(err.statusCode, 400, 'Status code should be 400 for non-existent assignmentId');
  }
  assert.ok(errThrown, 'Non-existent assignmentId must be rejected');

  // 6d: A sheet belonging to someone else must be refused.
  db.createPromptsBatch(Array.from({ length: 40 }, (_, i) => `متن مرجع ${i}`), 'words');
  db.createContributor('contrib_ref_owner', 'صاحب برگه', 'MoziTest');
  const foreignSheet = db.createAssignment('contrib_ref_owner', 'sentences');
  errThrown = false;
  try {
    db.createImage({ filename: 'test4.jpg', contributorId: 'contrib_ref_test', assignmentId: foreignSheet.id });
  } catch (err) {
    errThrown = true;
    assert.strictEqual(err.statusCode, 403, 'Status code should be 403 for a sheet owned by someone else');
  }
  assert.ok(errThrown, "Another contributor's sheet must be rejected");
  console.log('  [PASS] Bug 6 verified: Application-level referential integrity enforced.');

  // --- Bug 7: createContributor 3-parameter signature ---
  console.log('Testing Bug 7: Strict (id, name, userAgent) createContributor signature...');
  db.createContributor('contrib_sig_test', 'نام تستی', 'Agent 1.0');
  const contrib = db.getContributor('contrib_sig_test');
  assert.strictEqual(contrib.id, 'contrib_sig_test');
  assert.strictEqual(contrib.name, 'نام تستی');
  assert.strictEqual(contrib.user_agent, 'Agent 1.0');
  console.log('  [PASS] Bug 7 verified: Strict 3-parameter signature stores data properly.');

  // --- Bug 8: a contributor is never handed the same prompt twice ---
  // Exclusion moved from per-request prompt draws to sheet construction: every
  // prompt already placed on any of this contributor's sheets is skipped.
  console.log('Testing Bug 8: sheet construction excludes prompts already assigned to the contributor...');
  const testContribId = 'contrib_prompt_test';
  db.createContributor(testContribId, 'تست متن', 'Agent');

  const sheetA = db.createAssignment(testContribId, 'sentences');
  const sheetB = db.createAssignment(testContribId, 'sentences');
  const idsA = db.getAssignmentItems(sheetA.id).map(i => i.prompt_id);
  const idsB = db.getAssignmentItems(sheetB.id).map(i => i.prompt_id);

  assert.strictEqual(idsA.length, 10, 'A sheet must hold exactly 10 lines');
  assert.strictEqual(new Set(idsA).size, 10, 'A sheet must not repeat a prompt within itself');
  assert.ok(idsB.every(id => !idsA.includes(id)), 'A second sheet must not reuse prompts from the first');
  console.log('  [PASS] Bug 8 verified: Previously assigned prompts excluded.');

  // --- Bug 11: Write-lock (JS mutex queue) around createImageSafe preventing concurrent duplicate hash race ---
  console.log('Testing Bug 11: Concurrent duplicate hash race prevention in createImageSafe...');
  const hashContribId = 'contrib_concurrent_test';
  db.createContributor(hashContribId, 'تست همزمانی', 'Agent');
  const sharedHash = 'identical_file_hash_999';

  // Two DIFFERENT sheets, so the race is decided by the hash guard rather than by
  // the one-image-per-sheet rule.
  const raceSheet1 = db.createAssignment(hashContribId, 'sentences');
  db.createPromptsBatch(Array.from({ length: 15 }, (_, i) => `${5000 + i}`), 'numbers');
  const raceSheet2 = db.createAssignment(hashContribId, 'numbers');

  // Fire two concurrent inserts with the exact same file hash
  const promise1 = db.createImageSafe({
    filename: 'concurrent_1.jpg',
    contributorId: hashContribId,
    assignmentId: raceSheet1.id,
    fileHash: sharedHash,
  });
  const promise2 = db.createImageSafe({
    filename: 'concurrent_2.jpg',
    contributorId: hashContribId,
    assignmentId: raceSheet2.id,
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

  // --- Bug 9: quota is now the sheet itself (one image per open sheet) ---
  console.log('Testing Bug 9: Server enforces one upload per open sheet...');
  assert.ok(serverCode.includes("assignment.status !== 'open'"), 'server.js must refuse an upload to a sheet that is not open');
  assert.ok(serverCode.includes('assignment.contributor_id !== verifiedContributorId'), 'server.js must refuse a sheet owned by someone else');
  assert.ok(dbCode.includes("assignment.status !== 'open'"), 'database.js must re-check the open state inside the insert mutex');
  console.log('  [PASS] Bug 9 verified: One-image-per-sheet quota enforced at both layers.');

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

  // --- Bug 14: the crop canvas must be sized while its container is visible ---
  // layoutCanvas() measures the parent's clientWidth; a display:none parent reports
  // 0 and would pin the editor to its small fallback width.
  console.log('Testing Bug 14: editor container is shown before the canvas is measured...');
  const appCode = fs.readFileSync(path.join(__dirname, '../public/js/app.js'), 'utf8');
  const activateAt = appCode.indexOf("editorContainer.classList.add('active')");
  assert.ok(activateAt !== -1, 'app.js must activate the editor container');
  const layoutAt = appCode.indexOf('layoutCanvas();', activateAt);
  assert.ok(layoutAt > activateAt, 'layoutCanvas() must run AFTER the container is made visible');
  console.log('  [PASS] Bug 14 verified: Canvas is measured only once the editor is visible.');

  console.log('\n=============================================');
  console.log('🎉 ALL 14 CRITICAL & MEDIUM BUGS VERIFIED SUCCESSFULLY!');
  console.log('=============================================\n');

  // Clean up test db (both the nominal path and the one config actually writes)
  db.flushIfDirty();
  for (const p of [testDbPath, testDbPath + '.tmp', realDbPath, realDbPath + '.tmp']) {
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
}

runTests().catch(err => {
  console.error('\n❌ Test failure:', err);
  process.exit(1);
});
