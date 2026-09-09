(() => {
  // A volunteer writes TWO sheets: one page of sentences/words and one page of
  // numbers, each written line by line and photographed as a single image. The
  // server owns the line counts; these are only used before the first response.
  const CATEGORIES = ['sentences', 'numbers'];
  const CATEGORY_LABELS = {
    sentences: 'جملات و کلمات',
    numbers: 'اعداد',
  };

  // --- Contributor Identity & HMAC Token ---
  let contributorId = localStorage.getItem('contributor_id');
  let contributorName = localStorage.getItem('contributor_name');
  let contributorToken = localStorage.getItem('contributor_token');

  // --- DOM ---
  const contributorBar = document.getElementById('contributorBar');
  const contributorNameDisplay = document.getElementById('contributorNameDisplay');
  const btnChangeName = document.getElementById('btnChangeName');
  const nameModal = document.getElementById('nameModal');
  const nameForm = document.getElementById('nameForm');
  const nameInput = document.getElementById('nameInput');
  const nameError = document.getElementById('nameError');
  const btnSubmitName = document.getElementById('btnSubmitName');

  const statusMsg = document.getElementById('statusMsg');
  const statsBar = document.getElementById('statsBar');

  const goalSummary = document.getElementById('goalSummary');
  const remainingBadge = document.getElementById('remainingBadge');
  const goalProgressFill = document.getElementById('goalProgressFill');
  const goalCountText = document.getElementById('goalCountText');
  const goalPercentText = document.getElementById('goalPercentText');

  const sheetTabs = document.querySelectorAll('.sheet-tab');
  const tabStates = {
    sentences: document.getElementById('tabSentencesState'),
    numbers: document.getElementById('tabNumbersState'),
  };

  const sheetLoading = document.getElementById('sheetLoading');
  const sheetContent = document.getElementById('sheetContent');
  const sheetHowto = document.getElementById('sheetHowto');
  const sheetLines = document.getElementById('sheetLines');
  const sheetLinesTitle = document.getElementById('sheetLinesTitle');
  const sheetLinesCount = document.getElementById('sheetLinesCount');
  const sheetUpload = document.getElementById('sheetUpload');
  const sheetSubmitted = document.getElementById('sheetSubmitted');
  const sheetSubmittedText = document.getElementById('sheetSubmittedText');

  const cameraInput = document.getElementById('cameraInput');
  const fileInput = document.getElementById('fileInput');
  const btnPaste = document.getElementById('btnPaste');
  const btnSubmit = document.getElementById('btnSubmit');
  const btnRetake = document.getElementById('btnRetake');

  const editorContainer = document.getElementById('editorContainer');
  const editorCanvas = document.getElementById('editorCanvas');
  const editorMeta = document.getElementById('editorMeta');
  const btnRotateLeft = document.getElementById('btnRotateLeft');
  const btnRotateRight = document.getElementById('btnRotateRight');
  const btnResetCrop = document.getElementById('btnResetCrop');

  const completionCard = document.getElementById('completionCard');
  const btnNewSet = document.getElementById('btnNewSet');

  // --- State ---
  let sheetState = null;      // last /api/sheets payload
  let activeCategory = 'sentences';

  // The static Persian copy on this page uses ۰-۹, so counts rendered from JS have
  // to match or the same sentence mixes two digit systems.
  const FA_DIGITS = ['۰', '۱', '۲', '۳', '۴', '۵', '۶', '۷', '۸', '۹'];
  function fa(value) {
    return String(value).replace(/[0-9]/g, d => FA_DIGITS[Number(d)]);
  }

  function showStatus(msg, type = 'info') {
    statusMsg.textContent = msg;
    statusMsg.className = 'status-msg active ' + type;
    if (type === 'success') {
      setTimeout(() => { statusMsg.className = 'status-msg'; }, 5000);
    }
  }

  function authHeaders(extra = {}) {
    return contributorToken
      ? { 'X-Contributor-Token': contributorToken, ...extra }
      : { ...extra };
  }

  // ==========================================================================
  // Contributor identity
  // ==========================================================================

  function showNameModal(prefill = '') {
    if (nameInput) nameInput.value = prefill || contributorName || '';
    if (nameError) nameError.style.display = 'none';
    if (nameModal) nameModal.style.display = 'flex';
    setTimeout(() => { if (nameInput) nameInput.focus(); }, 100);
  }

  function hideNameModal() {
    if (nameModal) nameModal.style.display = 'none';
  }

  function updateContributorBar() {
    if (contributorName) {
      contributorNameDisplay.textContent = contributorName;
      contributorBar.style.display = 'flex';
    } else {
      contributorBar.style.display = 'none';
    }
  }

  async function registerContributor(name) {
    btnSubmitName.disabled = true;
    btnSubmitName.textContent = 'در حال ثبت...';
    try {
      const res = await fetch('/api/contributors/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim() }),
      });
      const data = await res.json();
      if (data.success && data.contributor_id && data.token) {
        contributorId = data.contributor_id;
        contributorName = data.name || name.trim();
        contributorToken = data.token;
        localStorage.setItem('contributor_id', contributorId);
        localStorage.setItem('contributor_name', contributorName);
        localStorage.setItem('contributor_token', contributorToken);

        updateContributorBar();
        hideNameModal();
        resetEditor();
        loadSheets();
        return true;
      }
      if (nameError) {
        nameError.textContent = data.error || 'خطا در ثبت نام. لطفاً مجدداً تلاش کنید.';
        nameError.style.display = 'block';
      }
    } catch (err) {
      console.error('Registration error:', err);
      if (nameError) {
        nameError.textContent = 'خطای اتصال به سرور. لطفاً اتصال اینترنت خود را بررسی کنید.';
        nameError.style.display = 'block';
      }
    } finally {
      btnSubmitName.disabled = false;
      btnSubmitName.textContent = 'ثبت و شروع نوشتن';
    }
    return false;
  }

  if (nameForm) {
    nameForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const val = nameInput.value.trim();
      if (!val || val.length < 3) {
        nameError.textContent = 'لطفاً نام و نام خانوادگی خود را کامل وارد کنید (حداقل ۳ حرف).';
        nameError.style.display = 'block';
        return;
      }
      await registerContributor(val);
    });
  }

  if (btnChangeName) {
    btnChangeName.addEventListener('click', () => showNameModal(contributorName));
  }

  // ==========================================================================
  // Sheets
  // ==========================================================================

  async function loadSheets() {
    if (!contributorId || !contributorToken) return;
    sheetLoading.style.display = 'block';
    sheetContent.style.display = 'none';
    try {
      const res = await fetch('/api/sheets', { headers: authHeaders() });
      const data = await res.json();
      if (!res.ok || !data.success) {
        sheetLoading.textContent = data.error || 'خطا در دریافت برگه‌ها.';
        return;
      }
      applySheetState(data);
    } catch (err) {
      console.error('loadSheets error:', err);
      sheetLoading.textContent = 'خطا در ارتباط با سرور.';
    }
  }

  function applySheetState(data) {
    sheetState = data;

    // Land the volunteer on the first sheet that still needs writing.
    const firstOpen = CATEGORIES.find(c => data.sheets[c] && data.sheets[c].status === 'open');
    if (!sheetState.userPickedTab) {
      activeCategory = firstOpen || activeCategory;
    }

    renderTabs();
    renderProgress();
    renderActiveSheet();
  }

  function renderTabs() {
    sheetTabs.forEach(tab => {
      const category = tab.dataset.sheet;
      const sheet = sheetState.sheets[category];
      tab.classList.toggle('active', category === activeCategory);

      const stateEl = tabStates[category];
      if (!stateEl) return;
      if (!sheet || !sheet.available) {
        stateEl.textContent = 'آماده نیست';
        stateEl.className = 'sheet-tab-state waiting';
      } else if (sheet.status === 'submitted') {
        stateEl.textContent = 'ارسال شد ✓';
        stateEl.className = 'sheet-tab-state done';
      } else {
        stateEl.textContent = `${fa(sheet.items.length)} مورد`;
        stateEl.className = 'sheet-tab-state open';
      }
    });
  }

  function renderProgress() {
    const sentences = sheetState.sheets.sentences;
    const numbers = sheetState.sheets.numbers;
    const sentenceSize = sentences && sentences.available ? sentences.items.length : (sentences ? sentences.size : 10);
    const numberSize = numbers && numbers.available ? numbers.items.length : (numbers ? numbers.size : 10);

    goalSummary.textContent = `${fa(sentenceSize)} جمله/کلمه + ${fa(numberSize)} عدد (دو عکس)`;

    const submitted = CATEGORIES.filter(c => sheetState.sheets[c] && sheetState.sheets[c].status === 'submitted').length;
    const percent = Math.round((submitted / CATEGORIES.length) * 100);

    goalProgressFill.style.width = `${percent}%`;
    goalPercentText.textContent = `${fa(percent)}٪`;
    goalCountText.textContent = `${fa(submitted)} از ۲ برگه این مجموعه ارسال شده است`;

    if (submitted === CATEGORIES.length) {
      remainingBadge.textContent = 'هر دو برگه ارسال شد 🎉';
      remainingBadge.className = 'remaining-badge completed';
    } else {
      remainingBadge.textContent = `${fa(CATEGORIES.length - submitted)} برگه باقی‌مانده`;
      remainingBadge.className = 'remaining-badge';
    }

    statsBar.textContent = `مجموع برگه‌های ارسالی شما تا کنون: ${fa(sheetState.completedSheets)}`;

    const bothDone = submitted === CATEGORIES.length;
    completionCard.style.display = bothDone ? 'block' : 'none';
  }

  function renderActiveSheet() {
    const sheet = sheetState.sheets[activeCategory];
    sheetLoading.style.display = 'none';
    sheetContent.style.display = 'block';

    if (!sheet || !sheet.available) {
      sheetLines.innerHTML = '';
      sheetLinesCount.textContent = '';
      sheetHowto.innerHTML = 'هنوز متنی برای این برگه توسط مدیر سامانه اضافه نشده است. لطفاً بعداً مراجعه کنید.';
      sheetHowto.className = 'sheet-howto empty';
      sheetUpload.style.display = 'none';
      editorContainer.classList.remove('active');
      sheetSubmitted.style.display = 'none';
      return;
    }

    const isNumbers = activeCategory === 'numbers';
    sheetHowto.className = 'sheet-howto ' + (isNumbers ? 'numbers' : 'sentences');
    sheetHowto.innerHTML = isNumbers
      ? `روی یک برگه سفید، <strong>${fa(sheet.items.length)} عدد زیر</strong> را به ترتیب و هرکدام در یک سطر جداگانه با <strong>ارقام فارسی</strong> بنویسید (مانند ۱۲۳۴۵ نه 12345)، سپس از کل برگه <strong>یک عکس</strong> بگیرید.`
      : `روی یک برگه سفید، <strong>${fa(sheet.items.length)} مورد زیر</strong> را به ترتیب و هرکدام در یک سطر جداگانه بنویسید، سپس از کل برگه <strong>یک عکس</strong> بگیرید.`;

    sheetLinesTitle.textContent = isNumbers ? 'اعداد این برگه' : 'جملات و کلمات این برگه';
    sheetLinesCount.textContent = `${fa(sheet.items.length)} سطر`;

    sheetLines.className = 'sheet-lines' + (isNumbers ? ' numbers' : '');
    sheetLines.innerHTML = '';
    sheet.items.forEach(item => {
      const li = document.createElement('li');
      const no = document.createElement('span');
      no.className = 'line-no';
      no.textContent = fa(item.line_no);
      const text = document.createElement('span');
      text.className = 'line-text';
      text.textContent = item.text;
      li.appendChild(no);
      li.appendChild(text);
      sheetLines.appendChild(li);
    });

    if (sheet.status === 'submitted') {
      sheetUpload.style.display = 'none';
      editorContainer.classList.remove('active');
      sheetSubmitted.style.display = 'block';
      const status = sheet.image ? sheet.image.status : 'pending';
      sheetSubmittedText.textContent = status === 'approved'
        ? 'این برگه توسط مدیر تایید شده است. سپاسگزاریم!'
        : 'این برگه ارسال شده و در انتظار بررسی مدیر است.';
    } else {
      sheetSubmitted.style.display = 'none';
      sheetUpload.style.display = 'block';
      editorContainer.classList.toggle('active', !!editor.image);
    }
  }

  sheetTabs.forEach(tab => {
    tab.addEventListener('click', () => {
      if (!sheetState) return;
      activeCategory = tab.dataset.sheet;
      sheetState.userPickedTab = true;
      resetEditor();
      renderTabs();
      renderActiveSheet();
    });
  });

  if (btnNewSet) {
    btnNewSet.addEventListener('click', async () => {
      btnNewSet.disabled = true;
      btnNewSet.textContent = 'در حال آماده‌سازی...';
      try {
        const res = await fetch('/api/sheets/new', { method: 'POST', headers: authHeaders() });
        const data = await res.json();
        if (data.success) {
          showStatus('مجموعه جدید آماده شد. لطفاً برگه اول را بنویسید.', 'success');
          data.userPickedTab = false;
          applySheetState(data);
          window.scrollTo({ top: 0, behavior: 'smooth' });
        } else {
          showStatus(data.error || 'خطا در دریافت مجموعه جدید.', 'error');
        }
      } catch {
        showStatus('خطا در ارتباط با سرور.', 'error');
      } finally {
        btnNewSet.disabled = false;
        btnNewSet.textContent = 'دریافت مجموعه جدید (۱۰ جمله + ۱۰ عدد)';
      }
    });
  }

  // ==========================================================================
  // Rotate & crop editor
  //
  // `base` is an offscreen canvas holding the image at its current rotation, at
  // full resolution. The visible canvas is the same picture scaled to fit, with a
  // dimming overlay and handles painted on top. The crop rectangle is stored in
  // BASE pixels so it survives a resize of the visible canvas; only pointer input
  // is converted through `scale`.
  // ==========================================================================

  const HANDLE_HIT = 18;   // px in display space
  const MIN_CROP = 24;     // px in base space
  const MAX_OUTPUT = 2400; // longest edge of the submitted image

  const editor = {
    image: null,
    rotation: 0,
    base: null,
    baseCtx: null,
    crop: null,       // {x, y, w, h} in base pixels, or null for "whole image"
    scale: 1,
    drag: null,
  };

  function resetEditor() {
    editor.image = null;
    editor.rotation = 0;
    editor.base = null;
    editor.crop = null;
    editor.drag = null;
    editorContainer.classList.remove('active');
    if (cameraInput) cameraInput.value = '';
    if (fileInput) fileInput.value = '';
  }

  function buildBase() {
    const img = editor.image;
    if (!img) return;
    const swap = editor.rotation === 90 || editor.rotation === 270;
    const w = swap ? img.naturalHeight : img.naturalWidth;
    const h = swap ? img.naturalWidth : img.naturalHeight;

    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);
    ctx.translate(w / 2, h / 2);
    ctx.rotate((editor.rotation * Math.PI) / 180);
    ctx.drawImage(img, -img.naturalWidth / 2, -img.naturalHeight / 2);

    editor.base = canvas;
    editor.baseCtx = ctx;
    editor.crop = null;
  }

  function layoutCanvas() {
    if (!editor.base) return;
    const wrapWidth = editorCanvas.parentElement.clientWidth || 320;
    const maxHeight = Math.max(260, Math.round(window.innerHeight * 0.6));
    let scale = wrapWidth / editor.base.width;
    if (editor.base.height * scale > maxHeight) {
      scale = maxHeight / editor.base.height;
    }
    editor.scale = scale;
    editorCanvas.width = Math.max(1, Math.round(editor.base.width * scale));
    editorCanvas.height = Math.max(1, Math.round(editor.base.height * scale));
  }

  function cropOrFull() {
    if (editor.crop) return editor.crop;
    return { x: 0, y: 0, w: editor.base.width, h: editor.base.height };
  }

  function drawEditor() {
    if (!editor.base) return;
    const ctx = editorCanvas.getContext('2d');
    const s = editor.scale;
    ctx.clearRect(0, 0, editorCanvas.width, editorCanvas.height);
    ctx.drawImage(editor.base, 0, 0, editorCanvas.width, editorCanvas.height);

    if (editor.crop) {
      const c = editor.crop;
      const x = c.x * s, y = c.y * s, w = c.w * s, h = c.h * s;

      // Dim everything outside the crop so the kept area reads instantly.
      ctx.fillStyle = 'rgba(17, 24, 39, 0.55)';
      ctx.fillRect(0, 0, editorCanvas.width, y);
      ctx.fillRect(0, y + h, editorCanvas.width, editorCanvas.height - (y + h));
      ctx.fillRect(0, y, x, h);
      ctx.fillRect(x + w, y, editorCanvas.width - (x + w), h);

      ctx.strokeStyle = '#2563eb';
      ctx.lineWidth = 2;
      ctx.strokeRect(x, y, w, h);

      // Rule-of-thirds guides help line up rows of handwriting.
      ctx.strokeStyle = 'rgba(255,255,255,0.5)';
      ctx.lineWidth = 1;
      for (let i = 1; i < 3; i++) {
        ctx.beginPath();
        ctx.moveTo(x, y + (h * i) / 3);
        ctx.lineTo(x + w, y + (h * i) / 3);
        ctx.moveTo(x + (w * i) / 3, y);
        ctx.lineTo(x + (w * i) / 3, y + h);
        ctx.stroke();
      }

      ctx.fillStyle = '#2563eb';
      for (const [hx, hy] of handlePoints(x, y, w, h)) {
        ctx.fillRect(hx - 5, hy - 5, 10, 10);
      }
    }

    const c = cropOrFull();
    editorMeta.textContent = `اندازه خروجی: ${fa(Math.round(c.w))} × ${fa(Math.round(c.h))} پیکسل`
      + (editor.rotation ? ` — چرخش: ${fa(editor.rotation)}°` : '')
      + (editor.crop ? '' : ' — بدون برش (کل تصویر)');
  }

  function handlePoints(x, y, w, h) {
    return [
      [x, y], [x + w / 2, y], [x + w, y],
      [x, y + h / 2], [x + w, y + h / 2],
      [x, y + h], [x + w / 2, y + h], [x + w, y + h],
    ];
  }

  const HANDLE_NAMES = ['nw', 'n', 'ne', 'w', 'e', 'sw', 's', 'se'];

  function canvasPoint(e) {
    const rect = editorCanvas.getBoundingClientRect();
    return {
      x: (e.clientX - rect.left) * (editorCanvas.width / rect.width),
      y: (e.clientY - rect.top) * (editorCanvas.height / rect.height),
    };
  }

  function hitHandle(p) {
    if (!editor.crop) return null;
    const s = editor.scale;
    const c = editor.crop;
    const pts = handlePoints(c.x * s, c.y * s, c.w * s, c.h * s);
    for (let i = 0; i < pts.length; i++) {
      const [hx, hy] = pts[i];
      if (Math.abs(p.x - hx) <= HANDLE_HIT / 2 && Math.abs(p.y - hy) <= HANDLE_HIT / 2) {
        return HANDLE_NAMES[i];
      }
    }
    return null;
  }

  function insideCrop(p) {
    if (!editor.crop) return false;
    const s = editor.scale;
    const c = editor.crop;
    return p.x >= c.x * s && p.x <= (c.x + c.w) * s && p.y >= c.y * s && p.y <= (c.y + c.h) * s;
  }

  function clampCrop() {
    const c = editor.crop;
    if (!c) return;
    c.w = Math.max(MIN_CROP, c.w);
    c.h = Math.max(MIN_CROP, c.h);
    c.x = Math.max(0, Math.min(c.x, editor.base.width - MIN_CROP));
    c.y = Math.max(0, Math.min(c.y, editor.base.height - MIN_CROP));
    c.w = Math.min(c.w, editor.base.width - c.x);
    c.h = Math.min(c.h, editor.base.height - c.y);
  }

  editorCanvas.addEventListener('pointerdown', (e) => {
    if (!editor.base) return;
    editorCanvas.setPointerCapture(e.pointerId);
    const p = canvasPoint(e);
    const handle = hitHandle(p);

    if (handle) {
      editor.drag = { mode: 'resize', handle, start: p, orig: { ...editor.crop } };
    } else if (insideCrop(p)) {
      editor.drag = { mode: 'move', start: p, orig: { ...editor.crop } };
    } else {
      const bx = p.x / editor.scale;
      const by = p.y / editor.scale;
      editor.drag = { mode: 'new', anchor: { x: bx, y: by } };
      editor.crop = { x: bx, y: by, w: MIN_CROP, h: MIN_CROP };
    }
    drawEditor();
  });

  editorCanvas.addEventListener('pointermove', (e) => {
    if (!editor.drag || !editor.base) return;
    const p = canvasPoint(e);
    const s = editor.scale;
    const d = editor.drag;

    if (d.mode === 'new') {
      const bx = p.x / s;
      const by = p.y / s;
      editor.crop = {
        x: Math.min(d.anchor.x, bx),
        y: Math.min(d.anchor.y, by),
        w: Math.abs(bx - d.anchor.x),
        h: Math.abs(by - d.anchor.y),
      };
    } else if (d.mode === 'move') {
      const dx = (p.x - d.start.x) / s;
      const dy = (p.y - d.start.y) / s;
      editor.crop = {
        x: d.orig.x + dx,
        y: d.orig.y + dy,
        w: d.orig.w,
        h: d.orig.h,
      };
    } else if (d.mode === 'resize') {
      const dx = (p.x - d.start.x) / s;
      const dy = (p.y - d.start.y) / s;
      const o = d.orig;
      let { x, y, w, h } = o;
      if (d.handle.includes('n')) { y = o.y + dy; h = o.h - dy; }
      if (d.handle.includes('s')) { h = o.h + dy; }
      if (d.handle.includes('w')) { x = o.x + dx; w = o.w - dx; }
      if (d.handle.includes('e')) { w = o.w + dx; }
      // A drag past the opposite edge would invert the rectangle; pin instead.
      if (w < MIN_CROP) { w = MIN_CROP; if (d.handle.includes('w')) x = o.x + o.w - MIN_CROP; }
      if (h < MIN_CROP) { h = MIN_CROP; if (d.handle.includes('n')) y = o.y + o.h - MIN_CROP; }
      editor.crop = { x, y, w, h };
    }

    clampCrop();
    drawEditor();
  });

  function endDrag(e) {
    if (!editor.drag) return;
    // A stray tap with no real drag should not leave a tiny useless crop.
    if (editor.drag.mode === 'new' && editor.crop && (editor.crop.w <= MIN_CROP || editor.crop.h <= MIN_CROP)) {
      editor.crop = null;
    }
    editor.drag = null;
    if (e && e.pointerId !== undefined && editorCanvas.hasPointerCapture(e.pointerId)) {
      editorCanvas.releasePointerCapture(e.pointerId);
    }
    drawEditor();
  }

  editorCanvas.addEventListener('pointerup', endDrag);
  editorCanvas.addEventListener('pointercancel', endDrag);

  function rotate(delta) {
    if (!editor.image) return;
    editor.rotation = (editor.rotation + delta + 360) % 360;
    buildBase();
    layoutCanvas();
    drawEditor();
  }

  if (btnRotateLeft) btnRotateLeft.addEventListener('click', () => rotate(-90));
  if (btnRotateRight) btnRotateRight.addEventListener('click', () => rotate(90));
  if (btnResetCrop) {
    btnResetCrop.addEventListener('click', () => {
      editor.crop = null;
      drawEditor();
    });
  }

  window.addEventListener('resize', () => {
    if (!editor.base) return;
    layoutCanvas();
    drawEditor();
  });

  // Turn the current rotation + crop into the JPEG that actually gets uploaded.
  function exportEditedImage() {
    return new Promise((resolve, reject) => {
      if (!editor.base) return reject(new Error('no image'));
      const c = cropOrFull();
      const sx = Math.round(c.x);
      const sy = Math.round(c.y);
      const sw = Math.max(1, Math.round(c.w));
      const sh = Math.max(1, Math.round(c.h));

      let outW = sw;
      let outH = sh;
      const longest = Math.max(sw, sh);
      if (longest > MAX_OUTPUT) {
        const k = MAX_OUTPUT / longest;
        outW = Math.round(sw * k);
        outH = Math.round(sh * k);
      }

      const out = document.createElement('canvas');
      out.width = outW;
      out.height = outH;
      const ctx = out.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, outW, outH);
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(editor.base, sx, sy, sw, sh, 0, 0, outW, outH);

      out.toBlob((blob) => {
        if (!blob) return reject(new Error('encode failed'));
        resolve(new File([blob], `sheet_${Date.now()}.jpg`, { type: 'image/jpeg', lastModified: Date.now() }));
      }, 'image/jpeg', 0.92);
    });
  }

  // ==========================================================================
  // File selection
  // ==========================================================================

  function handleFile(file) {
    if (!file) return;

    const allowed = ['image/jpeg', 'image/jpg', 'image/pjpeg', 'image/png', 'image/webp'];
    if (!allowed.includes(file.type)) {
      showStatus('فقط فایل‌های تصویری JPEG، PNG و WebP مجاز هستند.', 'error');
      return;
    }
    if (file.size > 30 * 1024 * 1024) {
      showStatus('حجم تصویر بیش از حد مجاز است (حداکثر ۳۰ مگابایت).', 'error');
      return;
    }

    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      editor.image = img;
      editor.rotation = 0;
      buildBase();
      // The container must be visible BEFORE the canvas is sized: layoutCanvas
      // measures its parent, and a display:none parent reports clientWidth 0,
      // which would pin the editor to its small fallback width.
      editorContainer.classList.add('active');
      layoutCanvas();
      drawEditor();
      editorContainer.scrollIntoView({ behavior: 'smooth', block: 'center' });
      statusMsg.className = 'status-msg';
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      showStatus('تصویر انتخابی قابل خواندن نیست.', 'error');
    };
    img.src = url;
  }

  if (cameraInput) {
    cameraInput.addEventListener('change', (e) => {
      if (e.target.files?.[0]) handleFile(e.target.files[0]);
    });
  }
  if (fileInput) {
    fileInput.addEventListener('change', (e) => {
      if (e.target.files?.[0]) handleFile(e.target.files[0]);
    });
  }

  if (btnPaste) {
    btnPaste.addEventListener('click', async () => {
      try {
        const clipboardItems = await navigator.clipboard.read();
        for (const item of clipboardItems) {
          const imgType = item.types.find(t => t.startsWith('image/'));
          if (imgType) {
            const blob = await item.getType(imgType);
            handleFile(new File([blob], `paste_${Date.now()}.png`, { type: imgType }));
            return;
          }
        }
        showStatus('تصویری در کلیپ‌بورد یافت نشد. لطفاً ابتدا عکس را کپی کنید.', 'error');
      } catch {
        showStatus('مرورگر اجازه دسترسی به کلیپ‌بورد را نداد. می‌توانید از کلیدهای Ctrl+V استفاده کنید.', 'error');
      }
    });
  }

  window.addEventListener('paste', (e) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        const file = item.getAsFile();
        if (file) {
          e.preventDefault();
          handleFile(file);
          return;
        }
      }
    }
  });

  if (btnRetake) {
    btnRetake.addEventListener('click', () => {
      resetEditor();
      renderActiveSheet();
    });
  }

  // ==========================================================================
  // Submit
  // ==========================================================================

  function restoreSubmitButton() {
    btnSubmit.disabled = false;
    btnSubmit.innerHTML = `
      <svg width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg>
      تایید و ارسال برگه
    `;
  }

  if (btnSubmit) {
    btnSubmit.addEventListener('click', async () => {
      if (!editor.base) {
        showStatus('لطفاً ابتدا عکس برگه را انتخاب کنید.', 'error');
        return;
      }
      if (!contributorId || !contributorToken) {
        showNameModal();
        return;
      }

      const sheet = sheetState?.sheets?.[activeCategory];
      if (!sheet || !sheet.available || sheet.status !== 'open') {
        showStatus('این برگه دیگر باز نیست. لطفاً صفحه را تازه‌سازی کنید.', 'error');
        return;
      }

      btnSubmit.disabled = true;
      btnSubmit.innerHTML = '<span class="spinner"></span> در حال ارسال و پردازش...';

      try {
        const file = await exportEditedImage();

        const formData = new FormData();
        formData.append('contributor_id', contributorId);
        formData.append('contributor_name', contributorName || '');
        formData.append('contributor_token', contributorToken);
        formData.append('assignment_id', sheet.assignment_id);
        const hpVal = document.getElementById('hpWebsite')?.value || '';
        if (hpVal) formData.append('hp_website', hpVal);
        formData.append('image', file);

        const res = await fetch('/api/images', {
          method: 'POST',
          headers: authHeaders(),
          body: formData,
        });
        const data = await res.json();

        if (data.success) {
          resetEditor();
          data.userPickedTab = false;
          applySheetState(data);

          const remaining = CATEGORIES.filter(c => data.sheets[c] && data.sheets[c].status === 'open');
          if (remaining.length === 0) {
            showStatus('هر دو برگه ارسال شد. از همکاری شما بسیار سپاسگزاریم! 🎉', 'success');
          } else {
            showStatus(`برگه با موفقیت ارسال شد. اکنون برگه «${CATEGORY_LABELS[remaining[0]]}» باقی مانده است.`, 'success');
          }
          window.scrollTo({ top: 0, behavior: 'smooth' });
        } else {
          showStatus(data.error || 'خطا در ارسال تصویر.', 'error');
        }
      } catch (err) {
        console.error('Upload error:', err);
        showStatus('خطا در برقراری ارتباط با سرور.', 'error');
      } finally {
        restoreSubmitButton();
      }
    });
  }

  // ==========================================================================
  // Boot
  // ==========================================================================

  if (!contributorId || !contributorToken || !contributorName) {
    showNameModal();
  } else {
    updateContributorBar();
    loadSheets();
  }
})();
