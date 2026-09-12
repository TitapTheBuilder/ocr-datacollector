#!/usr/bin/env node
//
// Put recovered segment boxes back in the right place on their sheet.
//
//   node scripts/locate-segments.js            # locate every segment sitting at 0,0
//   node scripts/locate-segments.js --all      # re-locate every segment
//   node scripts/locate-segments.js --dry-run  # report matches, change nothing
//
// STOP THE SERVER FIRST.
//
// Why this is possible at all: a dataset export records each line's quad relative to
// the CROP, not to the sheet, so recovery has no idea where on the page the crop came
// from and parks everything at 0,0. But the crop IS a picture of part of the sheet —
// so its position can simply be found again by looking for it.
//
// The match is scored on the crop's INK pixels only. That matters for two reasons:
// ink is what carries the structure that makes a match unambiguous, and the areas an
// admin masked or erased are paper-coloured fill that does not appear in the sheet —
// scoring those would penalise the correct position. Ignoring them makes masked
// crops locate just as well as clean ones.
//
// The search runs at FULL resolution over the whole sheet, scored on a small sample
// of ink points, then re-scores the winner with many more points to get a trustworthy
// confidence number. An earlier version searched a 4x-downscaled pyramid level first;
// that was faster but lost the correlation peak entirely on large sheets (1800x2400),
// where downscaling blurs handwriting strokes into mush — 47 of 437 crops could not be
// found that way, yet an exhaustive full-resolution search located them at a score of
// 1.6. Sampling few points is what makes the exhaustive pass affordable.
//
// Confidence is the mean absolute pixel difference at the winning offset; anything
// worse than the threshold is left alone and reported rather than guessed.

const fs = require('fs');
const path = require('path');
const net = require('net');
const sharp = require('sharp');
const config = require('../config');

const COARSE_POINTS = 200;  // sampled ink points for the whole-sheet sweep
const REFINE = 3;           // radius re-scored with the full point set
const MAX_INK_POINTS = 1200;
// Measured on 27 crops cut from real sheets at known offsets: every correct match
// scored <= 2.5 mean absolute difference, while wrong ones scored 16 or worse. 12
// sits in that gap, so a doubtful match is reported instead of silently guessed.
const MAX_MEAN_DIFF = 12;

function portInUse(port) {
  return new Promise(resolve => {
    const sock = net.connect({ port, host: '127.0.0.1' });
    const done = v => { sock.destroy(); resolve(v); };
    sock.setTimeout(1200);
    sock.on('connect', () => done(true));
    sock.on('timeout', () => done(false));
    sock.on('error', () => done(false));
  });
}

async function grey(file) {
  const { data, info } = await sharp(file).greyscale().raw().toBuffer({ resolveWithObject: true });
  return { data, w: info.width, h: info.height };
}

// Ink threshold from the image's own histogram, so a dim photo or a light pencil
// still yields a sensible set of points.
function inkThreshold(img) {
  const hist = new Uint32Array(256);
  for (let i = 0; i < img.data.length; i++) hist[img.data[i]]++;
  const pct = p => {
    let acc = 0;
    const want = img.data.length * p;
    for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= want) return v; }
    return 255;
  };
  const paper = pct(0.90);
  const dark = pct(0.02);
  if (paper - dark < 20) return null;
  return paper - 0.45 * (paper - dark);
}

function inkPoints(img, threshold, limit) {
  const all = [];
  for (let y = 0; y < img.h; y++) {
    for (let x = 0; x < img.w; x++) {
      if (img.data[y * img.w + x] < threshold) all.push([x, y, img.data[y * img.w + x]]);
    }
  }
  if (all.length <= limit) return all;
  // Even stride rather than a random sample: keeps the points spread across the whole
  // line instead of clustering in the darkest word.
  const step = all.length / limit;
  const out = [];
  for (let i = 0; i < limit; i++) out.push(all[Math.floor(i * step)]);
  return out;
}

function scoreAt(sheet, points, ox, oy) {
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const px = ox + points[i][0];
    const py = oy + points[i][1];
    sum += Math.abs(sheet.data[py * sheet.w + px] - points[i][2]);
  }
  return sum / points.length;
}

function search(sheet, points, cropW, cropH, x0, y0, x1, y1, step) {
  let best = { score: Infinity, x: 0, y: 0 };
  const maxX = Math.min(x1, sheet.w - cropW);
  const maxY = Math.min(y1, sheet.h - cropH);
  for (let y = Math.max(0, y0); y <= maxY; y += step) {
    for (let x = Math.max(0, x0); x <= maxX; x += step) {
      const s = scoreAt(sheet, points, x, y);
      if (s < best.score) best = { score: s, x, y };
    }
  }
  return best;
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const all = process.argv.includes('--all');

  if (await portInUse(config.PORT)) {
    console.error(`\nSomething is listening on port ${config.PORT} — stop the server first,`);
    console.error('or anything written here is discarded when it next saves.\n');
    process.exit(1);
  }

  const db = require('../database');
  await db.initDatabase();
  const raw = db.db.get();

  const many = (sql, params = []) => {
    const st = raw.prepare(sql);
    st.bind(params);
    const out = [];
    while (st.step()) out.push(st.getAsObject());
    st.free();
    return out;
  };

  const where = all ? '' : 'AND s.x = 0 AND s.y = 0';
  const rows = many(`
    SELECT s.id, s.image_id, s.line_no, s.filename, s.x, s.y, s.w, s.h, s.quad, s.text,
           i.filename AS sheet_filename, i.status
    FROM segments s JOIN images i ON i.id = s.image_id
    WHERE s.filename IS NOT NULL ${where}
    ORDER BY s.image_id, s.line_no
  `);

  console.log(`segments to locate: ${rows.length}${all ? ' (--all)' : ' (sitting at 0,0)'}`);
  if (!rows.length) { console.log('Nothing to do.'); process.exit(0); }

  if (!dryRun) {
    const backup = `${config.DB_PATH}.${new Date().toISOString().replace(/[:.]/g, '-')}.pre-locate.bak`;
    fs.copyFileSync(config.DB_PATH, backup);
    console.log(`Backup written: ${backup}`);
  } else {
    console.log('*** DRY RUN — nothing will be written ***');
  }

  const sheetPath = (name, status) => {
    for (const dir of [config.APPROVED_DIR, config.PENDING_DIR, path.join(config.UPLOAD_DIR, 'legacy')]) {
      const p = path.join(dir, name);
      if (fs.existsSync(p)) return p;
    }
    return null;
  };

  let located = 0;
  let lowConfidence = 0;
  let missing = 0;
  const failures = [];
  const cache = new Map();

  for (const row of rows) {
    const sPath = sheetPath(row.sheet_filename, row.status);
    const cPath = path.join(config.SEGMENTS_DIR, row.filename);
    if (!sPath || !fs.existsSync(cPath)) { missing++; continue; }

    if (!cache.has(sPath)) cache.set(sPath, { full: await grey(sPath) });
    const sheet = cache.get(sPath);

    const cropFull = await grey(cPath);
    if (cropFull.w > sheet.full.w || cropFull.h > sheet.full.h) {
      lowConfidence++; failures.push([row, 'crop larger than sheet']); continue;
    }

    const tFull = inkThreshold(cropFull);
    if (tFull === null) { lowConfidence++; failures.push([row, 'no ink contrast']); continue; }

    const ptsCoarse = inkPoints(cropFull, tFull, COARSE_POINTS);
    const ptsFull = inkPoints(cropFull, tFull, MAX_INK_POINTS);
    if (ptsCoarse.length < 12 || ptsFull.length < 20) { lowConfidence++; failures.push([row, 'too few ink pixels']); continue; }

    // Sweep the whole sheet cheaply, then re-score the winner properly.
    const coarse = search(sheet.full, ptsCoarse, cropFull.w, cropFull.h, 0, 0, sheet.full.w, sheet.full.h, 1);
    const fine = search(sheet.full, ptsFull, cropFull.w, cropFull.h,
      coarse.x - REFINE, coarse.y - REFINE, coarse.x + REFINE, coarse.y + REFINE, 1);

    if (!Number.isFinite(fine.score) || fine.score > MAX_MEAN_DIFF) {
      lowConfidence++;
      failures.push([row, `mean diff ${fine.score.toFixed(1)}`]);
      continue;
    }

    // Move the quad into sheet coordinates. The stored quad is already relative to
    // whatever origin the row currently claims, so subtract that before adding the
    // new one — otherwise a second run shifts an already-shifted quad again and the
    // export silently drifts. Exports subtract x/y back out, so labels.csv stays
    // byte-identical either way.
    let quad = null;
    try { quad = row.quad ? JSON.parse(row.quad) : null; } catch (_) {}
    const originX = Number(row.x) || 0;
    const originY = Number(row.y) || 0;
    const shifted = Array.isArray(quad) && quad.length === 4
      ? quad.map(([qx, qy]) => [qx - originX + fine.x, qy - originY + fine.y])
      : null;
    if (shifted && shifted.some(pt => !pt.every(Number.isFinite))) {
      lowConfidence++; failures.push([row, 'quad arithmetic produced a non-number']); continue;
    }

    if (!dryRun) {
      raw.run(
        `UPDATE segments SET x = ?, y = ?, quad = ?, updated_at = datetime('now') WHERE id = ?`,
        [fine.x, fine.y, shifted ? JSON.stringify(shifted) : row.quad, row.id]
      );
    }
    located++;
    if ((located + lowConfidence) % 25 === 0) console.log(`  ${located + lowConfidence}/${rows.length} processed (${located} located)...`);
  }

  if (!dryRun) db.saveDatabase();

  const line = '-'.repeat(60);
  console.log(`\n${line}`);
  console.log(`located            : ${located}/${rows.length}`);
  console.log(`low confidence     : ${lowConfidence}  (left untouched)`);
  console.log(`files missing      : ${missing}`);
  if (failures.length) {
    console.log('\nnot located:');
    for (const [r, why] of failures.slice(0, 25)) {
      console.log(`   image ${r.image_id} line ${r.line_no} — ${why}`);
    }
    if (failures.length > 25) console.log(`   ... and ${failures.length - 25} more`);
  }
  console.log(line);
  console.log(dryRun ? 'DRY RUN complete.' : 'Done. You can start the server again.');
  process.exit(0);
}

main().catch(err => {
  console.error('\nlocate-segments failed:', err.message);
  console.error(err.stack);
  process.exit(1);
});
