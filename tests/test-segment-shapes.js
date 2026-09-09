// Pixel-level check of the free-form segment shape and the eraser.
//
// Uploads a sheet made of flat colour bands — a red band standing in for the line
// above, a black band for the line being cropped, a blue band for the line below —
// so every assertion can name an exact pixel and say what colour it must be. Then:
//   * a plain rectangle still crops as before
//   * dragging the corners into a slanted quad blanks what falls outside it
//   * the brush and the box eraser blank what they cover
//   * the blanking uses the requested paper colour
//   * NONE of it touches the uploaded sheet on disk

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(os.tmpdir(), `ocr-shape-test-${Date.now()}`);
fs.mkdirSync(ROOT, { recursive: true });

process.env.PERSISTENT_DATA_PATH = ROOT;
process.env.CONTRIBUTOR_SECRET = 'test-secret-for-segment-shapes';
process.env.ADMIN_USERNAME = 'admin';
process.env.PORT = '4141';
process.env.MAX_UPLOADS_PER_IP_PER_MINUTE = '500';
process.env.MAX_UPLOADS_PER_IP_PER_HOUR = '500';

const ADMIN_PASSWORD = 'shape-test-password';
{
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(ADMIN_PASSWORD, salt, 64).toString('hex');
  process.env.ADMIN_PASSWORD_HASH = `${salt}:${hash}`;
}

const BASE = `http://127.0.0.1:${process.env.PORT}`;
const SEGMENTS_DIR = path.join(ROOT, 'uploads', 'segments');

const PAPER = [232, 226, 208];   // #e8e2d0
const RED = [255, 0, 0];         // the line above
const BLACK = [0, 0, 0];         // the line we want
const BLUE = [0, 0, 255];        // the line below

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

// JPEG at quality 92 shifts a flat colour by a couple of levels; sample well inside
// a region and allow a small tolerance rather than demanding an exact match.
function near(actual, expected, tol = 26) {
  return actual.every((v, i) => Math.abs(v - expected[i]) <= tol);
}

const sharp = require('sharp');

async function loadPixels(file) {
  const { data, info } = await sharp(file).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return {
    width: info.width,
    height: info.height,
    at(x, y) {
      const i = (y * info.width + x) * info.channels;
      return [data[i], data[i + 1], data[i + 2]];
    },
  };
}

// The same bands, but with real per-pixel grain, so the fill-noise matching has
// something to match. A perfectly flat synthetic sheet cannot test it: matching
// zero grain correctly produces a flat fill.
async function makeGrainyBandedSheet(sigma = 6) {
  const flat = await sharp(await makeBandedSheet()).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const { data, info } = flat;
  let seed = 12345;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  for (let i = 0; i < info.width * info.height; i++) {
    const u = Math.max(1e-9, rand());
    const g = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand()) * sigma;
    for (let c = 0; c < 3; c++) {
      const o = i * 3 + c;
      data[o] = Math.max(0, Math.min(255, Math.round(data[o] + g)));
    }
  }
  return sharp(data, { raw: { width: info.width, height: info.height, channels: 3 } }).png().toBuffer();
}

async function makeBandedSheet() {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="300">
    <rect width="600" height="300" fill="rgb(232,226,208)"/>
    <rect x="0" y="40"  width="600" height="30" fill="rgb(255,0,0)"/>
    <rect x="0" y="130" width="600" height="30" fill="rgb(0,0,0)"/>
    <rect x="0" y="220" width="600" height="30" fill="rgb(0,0,255)"/>
  </svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

async function main() {
  require('../server.js');
  await new Promise(r => setTimeout(r, 2500));

  const db = require('../database');
  db.createPromptsBatch(Array.from({ length: 20 }, (_, i) => `خط آزمایشی ${i + 1}`), 'sentences');
  db.createPromptsBatch(Array.from({ length: 20 }, (_, i) => `${2000 + i}`), 'numbers');
  db.flushIfDirty();

  // --- Volunteer uploads the banded sheet ----------------------------------
  const reg = await (await fetch(`${BASE}/api/contributors/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'تست شکل' }),
  })).json();
  const contributorHeaders = { 'X-Contributor-Token': reg.token };

  const sheets = await (await fetch(`${BASE}/api/sheets`, { headers: contributorHeaders })).json();

  const form = new FormData();
  form.append('assignment_id', String(sheets.sheets.sentences.assignment_id));
  form.append('image', new Blob([await makeBandedSheet()], { type: 'image/png' }), 'bands.png');
  const upload = await (await fetch(`${BASE}/api/images`, {
    method: 'POST', headers: contributorHeaders, body: form,
  })).json();
  check('banded sheet uploads', upload.success, JSON.stringify(upload).slice(0, 200));
  const imageId = upload.image_id;

  // --- Admin logs in --------------------------------------------------------
  const loginRes = await fetch(`${BASE}/api/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: ADMIN_PASSWORD }),
  });
  const cookie = (loginRes.headers.get('set-cookie') || '').split(';')[0];
  const adminHeaders = { Cookie: cookie, 'Content-Type': 'application/json' };
  check('admin login succeeds', !!cookie);

  // The sheet as stored, so we can prove later that erasing never touched it.
  const sheetOnDisk = fs.readdirSync(path.join(ROOT, 'uploads', 'pending'))[0];
  const sheetPath = path.join(ROOT, 'uploads', 'pending', sheetOnDisk);
  const sheetHashBefore = crypto.createHash('sha256').update(fs.readFileSync(sheetPath)).digest('hex');

  const postSegment = async (body) => {
    const res = await fetch(`${BASE}/api/admin/images/${imageId}/segments`, {
      method: 'POST', headers: adminHeaders, body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  };

  // --- 1. A plain rectangle still behaves exactly as before -----------------
  // Box y=100..200 around the black band; the red and blue bands are outside it.
  {
    const r = await postSegment({ line_no: 1, x: 50, y: 100, w: 400, h: 100 });
    check('plain x/y/w/h box is still accepted', r.body.success, JSON.stringify(r.body).slice(0, 200));
    const px = await loadPixels(path.join(SEGMENTS_DIR, r.body.segment.filename));
    check('plain box crop has the expected size', px.width === 400 && px.height === 100, `${px.width}x${px.height}`);
    check('plain box keeps the black line', near(px.at(200, 45), BLACK), px.at(200, 45).join(','));
    check('plain box keeps the paper above the line', near(px.at(200, 10), PAPER), px.at(200, 10).join(','));
    check('a box with no quad reports square corners',
      JSON.stringify(r.body.segment.quad) === JSON.stringify([[50, 100], [450, 100], [450, 200], [50, 200]]),
      JSON.stringify(r.body.segment.quad));
  }

  // --- 2. A slanted quad blanks what falls outside it ----------------------
  // The volunteer's line drifts downward, so the admin drags the right-hand corners
  // down. The bounding box is y=100..240 and now includes the blue band on the left,
  // which must be blanked because it is outside the quad.
  {
    const quad = [[50, 100], [450, 140], [450, 240], [50, 200]];
    const r = await postSegment({ line_no: 2, quad, bg_color: '#e8e2d0' });
    check('slanted quad is accepted', r.body.success, JSON.stringify(r.body).slice(0, 200));
    check('quad bounding box is stored', r.body.segment.w === 400 && r.body.segment.h === 140,
      `${r.body.segment.w}x${r.body.segment.h}`);

    const px = await loadPixels(path.join(SEGMENTS_DIR, r.body.segment.filename));
    // Crop-local coords: bbox origin is (50,100).
    // Top-right of the bbox is outside the quad (the quad's right edge starts at y=140).
    check('area above the slanted top edge is blanked to paper',
      near(px.at(390, 8), PAPER), px.at(390, 8).join(','));
    // Bottom-left is outside too (the quad's bottom edge ends at y=200 on the left).
    check('area below the slanted bottom edge is blanked to paper',
      near(px.at(10, 132), PAPER), px.at(10, 132).join(','));
    // The blue band at y=220..250 sits inside the bbox but outside the quad on the left.
    check('the next line that leaked into the box is blanked',
      near(px.at(20, 125), PAPER), px.at(20, 125).join(','));
    // ...while the middle of the black band, inside the quad, survives untouched.
    check('the line itself is kept inside the quad',
      near(px.at(200, 40), BLACK), px.at(200, 40).join(','));
  }

  // --- 3. Brush eraser ------------------------------------------------------
  {
    const quad = [[50, 100], [450, 100], [450, 200], [50, 200]];
    const erase = [{ type: 'brush', points: [[80, 145], [200, 145]], size: 40 }];
    const r = await postSegment({ line_no: 3, quad, erase, bg_color: '#e8e2d0' });
    check('brush stroke is accepted', r.body.success, JSON.stringify(r.body).slice(0, 200));

    const px = await loadPixels(path.join(SEGMENTS_DIR, r.body.segment.filename));
    check('brush stroke blanks the pixels it covers',
      near(px.at(100, 45), PAPER), px.at(100, 45).join(','));
    check('black line survives where the brush did not reach',
      near(px.at(350, 45), BLACK), px.at(350, 45).join(','));
    check('brush strokes are echoed back for re-editing',
      r.body.segment.erase.length === 1 && r.body.segment.erase[0].size === 40,
      JSON.stringify(r.body.segment.erase));
  }

  // --- 4. Box eraser --------------------------------------------------------
  {
    const quad = [[50, 100], [450, 100], [450, 260], [50, 260]];
    const erase = [{ type: 'box', x: 60, y: 215, w: 380, h: 40 }];
    const r = await postSegment({ line_no: 4, quad, erase, bg_color: '#e8e2d0' });
    check('box erase is accepted', r.body.success, JSON.stringify(r.body).slice(0, 200));

    const px = await loadPixels(path.join(SEGMENTS_DIR, r.body.segment.filename));
    check('box erase blanks the whole strip it covers',
      near(px.at(200, 130), PAPER), px.at(200, 130).join(','));
    check('box erase leaves the wanted line alone',
      near(px.at(200, 45), BLACK), px.at(200, 45).join(','));
  }

  // --- 5. The blanking colour is the one that was asked for -----------------
  {
    const quad = [[50, 100], [450, 100], [450, 200], [50, 200]];
    const erase = [{ type: 'box', x: 60, y: 110, w: 100, h: 40 }];
    const r = await postSegment({ line_no: 5, quad, erase, bg_color: '#00ff00' });
    const px = await loadPixels(path.join(SEGMENTS_DIR, r.body.segment.filename));
    check('erasing paints the requested colour', near(px.at(100, 25), [0, 255, 0]), px.at(100, 25).join(','));
  }

  // --- 6. Rubbish geometry is refused, not crashed on ----------------------
  {
    const bad = await postSegment({ line_no: 6, quad: [[0, 0], [10, 0], ['x', 5]] });
    check('a quad without four corners is refused', bad.status === 400, `status ${bad.status}`);

    const nan = await postSegment({ line_no: 6, quad: [[0, 0], [Infinity, 0], [10, 10], [0, 10]] });
    check('a non-finite corner is refused', nan.status === 400, `status ${nan.status}`);

    const tiny = await postSegment({ line_no: 6, quad: [[10, 10], [12, 10], [12, 12], [10, 12]] });
    check('a shape smaller than the minimum is refused', tiny.status === 400, `status ${tiny.status}`);
  }

  // --- 7. The uploaded sheet is never modified -----------------------------
  {
    const sheetHashAfter = crypto.createHash('sha256').update(fs.readFileSync(sheetPath)).digest('hex');
    check('erasing never touches the original uploaded sheet',
      sheetHashAfter === sheetHashBefore,
      'the sheet file changed on disk');

    const sheetPx = await loadPixels(sheetPath);
    check('the original sheet still has its red line above', near(sheetPx.at(200, 55), RED), sheetPx.at(200, 55).join(','));
    check('the original sheet still has its blue line below', near(sheetPx.at(200, 235), BLUE), sheetPx.at(200, 235).join(','));
    check('the original sheet still has its black line', near(sheetPx.at(200, 145), BLACK), sheetPx.at(200, 145).join(','));
  }

  // --- 8. Edits round-trip so the admin can reopen and adjust --------------
  {
    const lines = await (await fetch(`${BASE}/api/admin/images/${imageId}/lines`, { headers: { Cookie: cookie } })).json();
    const line3 = lines.lines.find(l => l.line_no === 3);
    check('a saved quad is returned on reload',
      line3 && Array.isArray(line3.segment.quad) && line3.segment.quad.length === 4,
      JSON.stringify(line3 && line3.segment && line3.segment.quad));
    check('saved erase strokes are returned on reload',
      line3 && Array.isArray(line3.segment.erase) && line3.segment.erase.length === 1,
      JSON.stringify(line3 && line3.segment && line3.segment.erase));

    const line1 = lines.lines.find(l => l.line_no === 1);
    check('a legacy rectangle reloads as four corners',
      line1 && line1.segment.quad.length === 4,
      JSON.stringify(line1 && line1.segment && line1.segment.quad));
  }

  // --- 9. Re-editing replaces the crop rather than piling up files ---------
  {
    const before = fs.readdirSync(SEGMENTS_DIR).length;
    await postSegment({ line_no: 3, quad: [[60, 110], [440, 110], [440, 190], [60, 190]], erase: [], bg_color: '#e8e2d0' });
    const after = fs.readdirSync(SEGMENTS_DIR).length;
    check('re-editing a line does not leak crop files', after === before, `${before} -> ${after}`);
  }

  // --- 10. Export geometry: quad, baseline angle, masked fraction ----------
  {
    // Approve the sheet so it reaches the export, then read labels.csv back.
    await fetch(`${BASE}/api/admin/images/${imageId}`, {
      method: 'PATCH', headers: adminHeaders, body: JSON.stringify({ status: 'approved' }),
    });
    const csv = await (await fetch(`${BASE}/api/admin/export`, { headers: { Cookie: cookie } })).text();
    const rows = csv.trim().split('\n');
    const header = rows[0].replace(/^﻿/, '');
    check('labels.csv carries the geometry columns',
      header.includes('quad') && header.includes('baseline_angle_deg') && header.includes('masked_fraction'),
      header);

    const cols = header.split(',');
    // Numeric columns are emitted unquoted, so a quoted-cell regex would skip them
    // and misalign every field after. Parse properly.
    const cells = (line) => {
      const out = [];
      let cur = '';
      let inQuotes = false;
      for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (inQuotes) {
          if (ch !== '"') { cur += ch; }
          else if (line[i + 1] === '"') { cur += '"'; i++; }
          else { inQuotes = false; }
        } else if (ch === '"') {
          inQuotes = true;
        } else if (ch === ',') {
          out.push(cur);
          cur = '';
        } else {
          cur += ch;
        }
      }
      out.push(cur);
      return out;
    };
    const byLine = {};
    for (const row of rows.slice(1)) {
      const v = cells(row);
      const obj = {};
      cols.forEach((c, i) => { obj[c] = v[i]; });
      byLine[obj.line_no] = obj;
    }

    // Line 1 was a plain level rectangle: four corners, zero angle, nothing masked.
    const l1 = byLine['1'];
    check('a level rectangle exports eight integers for quad',
      /^\d+( \d+){7}$/.test(l1.quad), l1.quad);
    check('the exported quad is relative to the crop, not the sheet',
      l1.quad.startsWith('0 0 '), l1.quad);
    check('a level rectangle has a baseline angle of zero',
      Math.abs(Number(l1.baseline_angle_deg)) < 0.01, l1.baseline_angle_deg);
    check('a level rectangle masks nothing',
      Number(l1.masked_fraction) === 0, l1.masked_fraction);

    // Line 2's right-hand corners were dragged DOWN, so in image coordinates the
    // line falls to the right and the reported angle must be NEGATIVE.
    // quad [[50,100],[450,140],[450,240],[50,200]]: top edge drops 40 over 400 and
    // the bottom edge drops 40 over 400 — both atan(40/400) = 5.71 degrees.
    const angle2 = Number(byLine['2'].baseline_angle_deg);
    check('a line falling to the right reports a negative baseline angle', angle2 < -1, String(angle2));
    check('the baseline angle matches the corners that were dragged',
      Math.abs(angle2 + 5.71) < 0.1, `${angle2} vs -5.71`);
    check('a slanted quad reports a real masked fraction',
      Number(byLine['2'].masked_fraction) > 0.1 && Number(byLine['2'].masked_fraction) < 0.9,
      byLine['2'].masked_fraction);

    check('erasing increases the masked fraction',
      Number(byLine['4'].masked_fraction) > Number(l1.masked_fraction), byLine['4'].masked_fraction);
  }

  // --- 11. The fill carries paper grain matched to the sheet ---------------
  {
    // On the FLAT synthetic sheet, matching the paper means producing a flat fill.
    const flatRes = await postSegment({
      line_no: 7,
      quad: [[50, 100], [450, 100], [450, 200], [50, 200]],
      erase: [{ type: 'box', x: 60, y: 105, w: 380, h: 60 }],
      bg_color: '#e8e2d0',
    });
    const flatPx = await loadPixels(path.join(SEGMENTS_DIR, flatRes.body.segment.filename));
    const flatVals = [];
    for (let y = 12; y < 55; y++) for (let x = 20; x < 380; x++) flatVals.push(flatPx.at(x, y)[0]);
    const flatMean = flatVals.reduce((a, b) => a + b, 0) / flatVals.length;
    check('on a grainless sheet the fill stays flat', Math.abs(flatMean - PAPER[0]) <= 12, `mean ${flatMean.toFixed(1)}`);

    // Now a sheet that really does have grain, uploaded as the numbers sheet.
    const numForm = new FormData();
    numForm.append('assignment_id', String(sheets.sheets.numbers.assignment_id));
    numForm.append('image', new Blob([await makeGrainyBandedSheet()], { type: 'image/png' }), 'grain.png');
    const grainUpload = await (await fetch(`${BASE}/api/images`, {
      method: 'POST', headers: contributorHeaders, body: numForm,
    })).json();
    check('grainy sheet uploads', grainUpload.success, JSON.stringify(grainUpload).slice(0, 200));

    const res = await fetch(`${BASE}/api/admin/images/${grainUpload.image_id}/segments`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({
        line_no: 1,
        quad: [[50, 90], [450, 90], [450, 200], [50, 200]],
        erase: [{ type: 'box', x: 60, y: 100, w: 380, h: 40 }],
        bg_color: '#e8e2d0',
      }),
    });
    const body = await res.json();
    check('grainy sheet segments', body.success, JSON.stringify(body).slice(0, 200));

    const px = await loadPixels(path.join(SEGMENTS_DIR, body.segment.filename));
    const varianceOf = (x0, x1, y0, y1) => {
      const v = [];
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) v.push(px.at(x, y)[0]);
      const m = v.reduce((a, b) => a + b, 0) / v.length;
      return v.reduce((a, b) => a + (b - m) ** 2, 0) / v.length;
    };
    // Crop origin is (50,90). The erase box covers y=100..140 -> local y=10..50.
    const filledVar = varianceOf(30, 370, 14, 46);
    // Untouched paper inside the quad, below the black band: y=170..195 -> local 80..105.
    const paperVar = varianceOf(30, 370, 82, 104);

    check('the filled area is not perfectly flat when the paper has grain',
      filledVar > 1, `filled variance ${filledVar.toFixed(2)}`);
    check('the fill grain is in the same range as the real paper grain',
      filledVar > paperVar * 0.2 && filledVar < paperVar * 5,
      `filled ${filledVar.toFixed(2)} vs paper ${paperVar.toFixed(2)}`);
  }

  // --- 12. Identical geometry re-renders identically (seeded noise) --------
  {
    const body = {
      line_no: 8,
      quad: [[50, 100], [450, 100], [450, 200], [50, 200]],
      erase: [{ type: 'box', x: 60, y: 110, w: 300, h: 50 }],
      bg_color: '#e8e2d0',
    };
    const a = await postSegment(body);
    const bufA = fs.readFileSync(path.join(SEGMENTS_DIR, a.body.segment.filename));
    const b = await postSegment(body);
    const bufB = fs.readFileSync(path.join(SEGMENTS_DIR, b.body.segment.filename));
    check('re-saving unchanged geometry reproduces byte-identical pixels',
      bufA.equals(bufB), `${bufA.length} vs ${bufB.length} bytes`);
  }

  // --- 13. Both segmentation techniques must report the SAME angle ---------
  //
  // An admin can follow a crooked line two ways: drag the corners to match it, or
  // draw a plain rectangle and erase what leaked in. The second leaves an
  // axis-aligned quad with no angle in it, so the exported angle has to come from
  // the ink instead. If these two disagree, the dataset's geometry would depend on
  // which technique the admin happened to use.
  {
    // A sheet with ONE line of text at a known slant, so there is a right answer.
    const KNOWN_DEG = 7;
    const slantSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="400">
      <rect width="900" height="400" fill="rgb(232,226,208)"/>
      <text x="70" y="230" font-size="46" fill="rgb(10,10,10)"
            transform="rotate(${-KNOWN_DEG} 70 230)">slanted handwriting line</text>
    </svg>`;
    const slantPng = await sharp(Buffer.from(slantSvg)).png().toBuffer();

    // Fresh contributor so this gets its own sheet.
    const reg2 = await (await fetch(`${BASE}/api/contributors/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'تست زاویه' }),
    })).json();
    const h2 = { 'X-Contributor-Token': reg2.token };
    const sh2 = await (await fetch(`${BASE}/api/sheets`, { headers: h2 })).json();
    const f2 = new FormData();
    f2.append('assignment_id', String(sh2.sheets.sentences.assignment_id));
    f2.append('image', new Blob([slantPng], { type: 'image/png' }), 'slant.png');
    const up2 = await (await fetch(`${BASE}/api/images`, { method: 'POST', headers: h2, body: f2 })).json();
    check('slanted sheet uploads', up2.success, JSON.stringify(up2).slice(0, 200));

    const post2 = async (body) => {
      const res = await fetch(`${BASE}/api/admin/images/${up2.image_id}/segments`, {
        method: 'POST', headers: adminHeaders, body: JSON.stringify(body),
      });
      return res.json();
    };

    // Technique A: plain axis-aligned rectangle over the whole slanted line.
    await post2({ line_no: 1, x: 60, y: 120, w: 700, h: 160 });
    // Technique B: corners dragged to follow the same line. The text rises to the
    // right, so the right-hand corners go UP.
    const rise = Math.round(700 * Math.tan((KNOWN_DEG * Math.PI) / 180));
    await post2({
      line_no: 2,
      quad: [[60, 200], [760, 200 - rise], [760, 260 - rise], [60, 260]],
      bg_color: '#e8e2d0',
    });

    await fetch(`${BASE}/api/admin/images/${up2.image_id}`, {
      method: 'PATCH', headers: adminHeaders, body: JSON.stringify({ status: 'approved' }),
    });

    const csv2 = await (await fetch(`${BASE}/api/admin/export`, { headers: { Cookie: cookie } })).text();
    const rows2 = csv2.trim().split('\n');
    const head2 = rows2[0].replace(/^﻿/, '').split(',');
    const parse = (line) => {
      const out = [];
      let cur = '';
      let q = false;
      for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (q) {
          if (ch !== '"') cur += ch;
          else if (line[i + 1] === '"') { cur += '"'; i++; }
          else q = false;
        } else if (ch === '"') q = true;
        else if (ch === ',') { out.push(cur); cur = ''; }
        else cur += ch;
      }
      out.push(cur);
      return out;
    };
    const byLine2 = {};
    for (const r of rows2.slice(1).map(parse).map(v => Object.fromEntries(head2.map((c, i) => [c, v[i]])))) {
      // Only rows from THIS sheet (the earlier banded sheet has its own lines).
      if (r.contributor_id === reg2.contributor_id) byLine2[r.line_no] = r;
    }

    const rect = byLine2['1'];
    const quadRow = byLine2['2'];

    check('the rectangle workflow falls back to the ink angle',
      rect && rect.angle_source === 'ink', rect && rect.angle_source);
    check('the corner workflow uses the drawn quad',
      quadRow && quadRow.angle_source === 'quad', quadRow && quadRow.angle_source);

    const rectAngle = Number(rect.baseline_angle_deg);
    const quadAngle = Number(quadRow.baseline_angle_deg);

    check('the rectangle workflow no longer reports a level line for slanted text',
      Math.abs(rectAngle) > 3, `${rectAngle}`);
    check('the ink-measured angle recovers the real slant',
      Math.abs(rectAngle - KNOWN_DEG) < 1.5, `${rectAngle} vs ${KNOWN_DEG}`);
    check('the quad-derived angle matches the real slant',
      Math.abs(quadAngle - KNOWN_DEG) < 1.5, `${quadAngle} vs ${KNOWN_DEG}`);
    check('both segmentation techniques agree on the angle',
      Math.abs(rectAngle - quadAngle) < 1.5, `rect ${rectAngle} vs quad ${quadAngle}`);

    check('masked_fraction is still correct for the eraser-only workflow',
      Number(rect.masked_fraction) === 0, rect.masked_fraction);
    console.log(`        (known slant ${KNOWN_DEG}deg -> ink ${rectAngle}deg, quad ${quadAngle}deg)`);
  }

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(err => {
  console.error('Test run crashed:', err);
  process.exit(1);
});
