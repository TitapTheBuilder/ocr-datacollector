(() => {
  // --- Elements ---
  const loginSection = document.getElementById('loginSection');
  const dashboardSection = document.getElementById('dashboardSection');
  const loginForm = document.getElementById('loginForm');
  const loginError = document.getElementById('loginError');
  const btnLogout = document.getElementById('btnLogout');

  // Stats
  const statTotal = document.getElementById('statTotal');
  const statPending = document.getElementById('statPending');
  const statApproved = document.getElementById('statApproved');
  const statRejected = document.getElementById('statRejected');
  const statSynced = document.getElementById('statSynced');
  const statContributors = document.getElementById('statContributors');
  const statSegments = document.getElementById('statSegments');

  // Tabs
  const tabs = document.querySelectorAll('.tab');
  const tabContents = document.querySelectorAll('.tab-content');

  // Image grids
  const pendingGrid = document.getElementById('pendingGrid');
  const pendingEmpty = document.getElementById('pendingEmpty');
  const pendingPagination = document.getElementById('pendingPagination');
  const allGrid = document.getElementById('allGrid');
  const allEmpty = document.getElementById('allEmpty');
  const allPagination = document.getElementById('allPagination');
  const filterStatus = document.getElementById('filterStatus');

  // Bulk actions elements
  const selectAllPending = document.getElementById('selectAllPending');
  const selectedCountPending = document.getElementById('selectedCountPending');
  const btnBulkApprovePending = document.getElementById('btnBulkApprovePending');
  const btnBulkRejectPending = document.getElementById('btnBulkRejectPending');

  const selectAllAll = document.getElementById('selectAllAll');
  const selectedCountAll = document.getElementById('selectedCountAll');
  const btnBulkApproveAll = document.getElementById('btnBulkApproveAll');
  const btnBulkRejectAll = document.getElementById('btnBulkRejectAll');

  const selectedPending = new Set();
  const selectedAll = new Set();
  const currentImagesMap = { pending: [], all: [] };

  // Prompts
  const promptsList = document.getElementById('promptsList');
  const promptsEmpty = document.getElementById('promptsEmpty');
  const csvInput = document.getElementById('csvInput');
  const csvCategory = document.getElementById('csvCategory');

  // Sync - Google Drive
  const syncGrid = document.getElementById('syncGrid');
  const syncEmpty = document.getElementById('syncEmpty');
  const btnSyncAll = document.getElementById('btnSyncAll');
  const driveConfigForm = document.getElementById('driveConfigForm');
  const driveStatusBadge = document.getElementById('driveStatusBadge');
  const driveFolderId = document.getElementById('driveFolderId');
  const driveClientEmail = document.getElementById('driveClientEmail');
  const drivePrivateKey = document.getElementById('drivePrivateKey');
  const btnSaveDrive = document.getElementById('btnSaveDrive');
  const btnTestDrive = document.getElementById('btnTestDrive');
  const driveMsg = document.getElementById('driveMsg');

  // Sync - GitHub
  const githubConfigForm = document.getElementById('githubConfigForm');
  const githubStatusBadge = document.getElementById('githubStatusBadge');
  const githubToken = document.getElementById('githubToken');
  const githubRepo = document.getElementById('githubRepo');
  const githubBranch = document.getElementById('githubBranch');
  const githubPath = document.getElementById('githubPath');
  const btnSaveGitHub = document.getElementById('btnSaveGitHub');
  const btnTestGitHub = document.getElementById('btnTestGitHub');
  const btnCommitGitHub = document.getElementById('btnCommitGitHub');
  const githubMsg = document.getElementById('githubMsg');

  // Modal
  const imageModal = document.getElementById('imageModal');
  const modalTitle = document.getElementById('modalTitle');
  const modalInfo = document.getElementById('modalInfo');
  const modalActions = document.getElementById('modalActions');
  const modalClose = document.getElementById('modalClose');

  let currentPage = { pending: 1, all: 1 };

  // --- Auth ---
  async function checkAuth() {
    try {
      const res = await fetch('/api/admin/me');
      const data = await res.json();
      if (data.authenticated) {
        showDashboard();
      }
    } catch {
      // not logged in
    }
  }

  function showDashboard() {
    loginSection.style.display = 'none';
    dashboardSection.style.display = 'block';
    btnLogout.style.display = 'inline-flex';
    loadStats();
    loadPending();
  }

  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    loginError.style.display = 'none';
    try {
      const res = await fetch('/api/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: document.getElementById('loginUsername').value,
          password: document.getElementById('loginPassword').value,
        }),
      });
      const data = await res.json();
      if (data.success) {
        showDashboard();
      } else {
        loginError.textContent = data.error || 'خطا در ورود';
        loginError.style.display = 'block';
      }
    } catch {
      loginError.textContent = 'خطا در اتصال به سرور';
      loginError.style.display = 'block';
    }
  });

  btnLogout.addEventListener('click', async () => {
    await fetch('/api/admin/logout', { method: 'POST' });
    loginSection.style.display = 'block';
    dashboardSection.style.display = 'none';
    btnLogout.style.display = 'none';
  });

  // Storage elements
  const storageProgressBar = document.getElementById('storageProgressBar');
  const storageStatsText = document.getElementById('storageStatsText');
  const btnPurgeRejected = document.getElementById('btnPurgeRejected');

  // --- Stats ---
  async function loadStats() {
    try {
      const res = await fetch('/api/admin/stats');
      const s = await res.json();
      statTotal.textContent = s.total;
      statPending.textContent = s.pending;
      statApproved.textContent = s.approved;
      statRejected.textContent = s.rejected;
      statSynced.textContent = s.synced;
      statContributors.textContent = s.contributors;
      if (statSegments) statSegments.textContent = s.segmentsApproved ?? 0;

      loadStorageStats();
    } catch {
      // silent
    }
  }

  async function loadStorageStats() {
    try {
      const res = await fetch('/api/admin/storage-stats');
      if (!res.ok) return;
      const data = await res.json();
      if (storageProgressBar && storageStatsText) {
        storageProgressBar.style.width = Math.min(100, data.percent) + '%';
        if (data.percent > 85) {
          storageProgressBar.style.background = 'var(--danger)';
        } else if (data.percent > 65) {
          storageProgressBar.style.background = '#f59e0b';
        } else {
          storageProgressBar.style.background = 'var(--primary)';
        }
        storageStatsText.textContent = `${data.usedMB} MB از ${data.maxMB} MB (${data.percent}%)`;
      }
    } catch {
      // silent
    }
  }

  if (btnPurgeRejected) {
    btnPurgeRejected.addEventListener('click', async () => {
      if (!confirm('آیا از حذف کامل و فوری تمام فایل‌های تصاویر رد شده از روی دیسک اطمینان دارید؟')) return;
      btnPurgeRejected.disabled = true;
      try {
        const res = await fetch('/api/admin/purge-rejected', { method: 'POST' });
        const data = await res.json();
        alert(`پاک‌سازی فوری انجام شد. ${data.purgedCount || 0} تصویر رد شده از روی دیسک و دیتابیس حذف شدند.`);
        loadStats();
        refreshActiveGrid();
        loadStorageStats();
      } catch (err) {
        alert('خطا در پاک‌سازی تصاویر: ' + err.message);
      } finally {
        btnPurgeRejected.disabled = false;
      }
    });
  }

  // --- Tabs ---
  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      tabs.forEach(t => t.classList.remove('active'));
      tabContents.forEach(c => c.classList.remove('active'));
      tab.classList.add('active');
      document.getElementById('tab' + capitalize(tab.dataset.tab)).classList.add('active');

      if (tab.dataset.tab === 'pending') loadPending();
      else if (tab.dataset.tab === 'all') loadAll();
      else if (tab.dataset.tab === 'prompts') loadPrompts();
      else if (tab.dataset.tab === 'sync') loadSync();
    });
  });

  function capitalize(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

  // --- Image loading ---
  async function loadPending() {
    try {
      const data = await fetchImages('pending', currentPage.pending);
      currentImagesMap.pending = data.images || [];
      renderImageGrid(pendingGrid, pendingEmpty, currentImagesMap.pending, 'pending');
      renderPagination(pendingPagination, data, 'pending');
      updateBulkBar('pending');
    } catch (err) {
      showGridError(pendingGrid, pendingEmpty, err);
    }
  }

  async function loadAll() {
    try {
      const status = filterStatus.value;
      const data = await fetchImages(status, currentPage.all);
      currentImagesMap.all = data.images || [];
      renderImageGrid(allGrid, allEmpty, currentImagesMap.all, 'all');
      renderPagination(allPagination, data, 'all');
      updateBulkBar('all');
    } catch (err) {
      showGridError(allGrid, allEmpty, err);
    }
  }

  // A thrown render/fetch error used to leave a blank grid that looked exactly like
  // "no images". Show it instead, so a broken panel is never mistaken for an empty one.
  function showGridError(grid, empty, err) {
    console.error('Error loading images:', err);
    if (empty) empty.style.display = 'none';
    if (grid) {
      grid.innerHTML = `<div class="grid-error">خطا در بارگذاری تصاویر: ${escapeHtml(err && err.message)}</div>`;
    }
  }

  async function fetchImages(status, page) {
    const params = new URLSearchParams({ page, limit: 20 });
    if (status) params.set('status', status);
    const res = await fetch(`/api/admin/images?${params}`);
    if (res.status === 401) {
      // Session expired: send the admin back to the login form rather than
      // rendering an empty gallery that looks like there is nothing to review.
      loginSection.style.display = 'block';
      dashboardSection.style.display = 'none';
      btnLogout.style.display = 'none';
      throw new Error('نشست شما منقضی شده است. لطفاً دوباره وارد شوید.');
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  function renderImageGrid(grid, empty, images, tab = 'pending') {
    if (!images || images.length === 0) {
      grid.innerHTML = '';
      empty.style.display = 'block';
      return;
    }
    empty.style.display = 'none';
    const selectedSet = tab === 'pending' ? selectedPending : selectedAll;

    grid.innerHTML = images.map(img => {
      const authorName = escapeHtml(img.contributor_name || 'ثبت نشده');
      const authorId = escapeHtml(img.contributor_id || '');
      const isSelected = selectedSet.has(img.id);
      return `
      <div class="image-card ${isSelected ? 'selected' : ''}" data-id="${img.id}">
        <div class="card-select-wrap" onclick="event.stopPropagation()">
          <input type="checkbox" class="card-select" data-id="${img.id}" ${isSelected ? 'checked' : ''}>
        </div>
        <img src="${imageUrl(img)}" alt="" loading="lazy" onerror="imgFallback(this)">
        <div class="image-card-info">
          <div class="prompt-text">${sheetLabel(img)}</div>
          <div class="meta">
            <div>${segmentBadge(img)}</div>
            <div>نویسنده: <strong style="color:var(--gray-900);">${authorName}</strong></div>
            <div style="font-size:0.75rem; color:var(--gray-500); overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="شناسه: ${authorId}">شناسه: ${authorId}</div>
            <div>${formatDate(img.created_at)}</div>
          </div>
          <span class="status-badge ${escapeHtml(img.status)}">${statusLabel(img.status)}</span>
        </div>
      </div>
      `;
    }).join('');

    // Open detail modal on card click
    grid.querySelectorAll('.image-card').forEach(card => {
      card.addEventListener('click', () => openModal(parseInt(card.dataset.id, 10)));
    });

    // Checkbox toggling
    grid.querySelectorAll('.card-select').forEach(cb => {
      cb.addEventListener('change', (e) => {
        e.stopPropagation();
        const id = parseInt(cb.dataset.id, 10);
        const card = cb.closest('.image-card');
        if (cb.checked) {
          selectedSet.add(id);
          card.classList.add('selected');
        } else {
          selectedSet.delete(id);
          card.classList.remove('selected');
        }
        updateBulkBar(tab);
      });
    });
  }

  // --- Bulk Selection & Operations ---
  function updateBulkBar(tab) {
    const selectedSet = tab === 'pending' ? selectedPending : selectedAll;
    const images = currentImagesMap[tab] || [];
    const countSpan = tab === 'pending' ? selectedCountPending : selectedCountAll;
    const selectAllCb = tab === 'pending' ? selectAllPending : selectAllAll;
    const btnApprove = tab === 'pending' ? btnBulkApprovePending : btnBulkApproveAll;
    const btnReject = tab === 'pending' ? btnBulkRejectPending : btnBulkRejectAll;

    if (countSpan) {
      countSpan.textContent = `(${selectedSet.size} مورد انتخاب شده)`;
    }

    const hasSelection = selectedSet.size > 0;
    if (btnApprove) btnApprove.disabled = !hasSelection;
    if (btnReject) btnReject.disabled = !hasSelection;

    if (selectAllCb) {
      selectAllCb.checked = images.length > 0 && images.every(img => selectedSet.has(img.id));
      selectAllCb.indeterminate = hasSelection && !selectAllCb.checked;
    }
  }

  function setupBulkListeners(tab) {
    const selectAllCb = tab === 'pending' ? selectAllPending : selectAllAll;
    const btnApprove = tab === 'pending' ? btnBulkApprovePending : btnBulkApproveAll;
    const btnReject = tab === 'pending' ? btnBulkRejectPending : btnBulkRejectAll;
    const selectedSet = tab === 'pending' ? selectedPending : selectedAll;

    if (selectAllCb) {
      selectAllCb.addEventListener('change', () => {
        const images = currentImagesMap[tab] || [];
        const grid = tab === 'pending' ? pendingGrid : allGrid;
        if (selectAllCb.checked) {
          images.forEach(img => selectedSet.add(img.id));
          grid.querySelectorAll('.card-select').forEach(cb => { cb.checked = true; });
          grid.querySelectorAll('.image-card').forEach(card => { card.classList.add('selected'); });
        } else {
          images.forEach(img => selectedSet.delete(img.id));
          grid.querySelectorAll('.card-select').forEach(cb => { cb.checked = false; });
          grid.querySelectorAll('.image-card').forEach(card => { card.classList.remove('selected'); });
        }
        updateBulkBar(tab);
      });
    }

    if (btnApprove) {
      btnApprove.addEventListener('click', () => executeBulkAction(tab, 'approved'));
    }
    if (btnReject) {
      btnReject.addEventListener('click', () => executeBulkAction(tab, 'rejected'));
    }
  }

  setupBulkListeners('pending');
  setupBulkListeners('all');

  async function executeBulkAction(tab, status) {
    const selectedSet = tab === 'pending' ? selectedPending : selectedAll;
    const ids = Array.from(selectedSet);
    if (ids.length === 0) return;

    const actionText = status === 'approved' ? 'تایید' : 'رد';
    if (!confirm(`آیا از ${actionText} همزمان ${ids.length} تصویر انتخاب شده اطمینان دارید؟`)) return;

    let reason = null;
    if (status === 'rejected') {
      const input = prompt('دلیل رد تصاویر (اختیاری):', '');
      if (input === null) return; // Admin clicked Cancel — abort
      reason = input || null;
    }

    try {
      const res = await fetch('/api/admin/images/batch-status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids, status, rejection_reason: reason }),
      });
      const data = await res.json();
      if (data.success) {
        alert(`${data.updatedCount} تصویر با موفقیت ${actionText} شدند.`);
        selectedSet.clear();
        updateBulkBar(tab);
        loadStats();
        if (tab === 'pending') loadPending();
        else loadAll();
        loadStorageStats();
      } else {
        alert('خطا در انجام عملیات گروهی: ' + (data.error || 'ناشناخته'));
      }
    } catch (err) {
      alert('خطا در ارتباط با سرور: ' + err.message);
    }
  }

  function renderPagination(container, data, tab) {
    if (data.pages <= 1) { container.innerHTML = ''; return; }
    container.innerHTML = `
      <button class="btn btn-sm btn-outline" ${data.page <= 1 ? 'disabled' : ''} data-page="${data.page - 1}">قبلی</button>
      <span class="page-info">صفحه ${data.page} از ${data.pages}</span>
      <button class="btn btn-sm btn-outline" ${data.page >= data.pages ? 'disabled' : ''} data-page="${data.page + 1}">بعدی</button>
    `;
    container.querySelectorAll('button[data-page]').forEach(btn => {
      btn.addEventListener('click', () => {
        currentPage[tab] = parseInt(btn.dataset.page);
        // Drop the selection: it refers to cards leaving the screen, and a bulk
        // action would otherwise silently apply to images the admin can't see.
        (tab === 'pending' ? selectedPending : selectedAll).clear();
        if (tab === 'pending') loadPending();
        else loadAll();
      });
    });
  }
  // --- Review & manual segmentation workspace ---
  //
  // A volunteer uploads ONE page holding ten handwritten lines. The dataset needs
  // one tight crop per line, labelled with the exact text that line was meant to be.
  //
  // Nobody writes ten perfectly straight, well-spaced lines, so a line's shape is
  // FOUR DRAGGABLE CORNERS rather than an axis-aligned box, and the admin can paint
  // over whatever still leaked in from the lines above and below. Both are stored as
  // instructions, never baked into the upload: the crop is re-cut from the original
  // sheet on every save, and the mask is painted on that copy in the paper colour.
  //
  // All geometry is kept in ORIGINAL image pixels, so zoom and window size never
  // leak into the saved data.

  const segCanvas = document.getElementById('segCanvas');
  const segCanvasWrap = document.getElementById('segCanvasWrap');
  const segList = document.getElementById('segList');
  const segProgress = document.getElementById('segProgress');
  const segCurrentNo = document.getElementById('segCurrentNo');
  const segCurrentText = document.getElementById('segCurrentText');
  const segShowBoxes = document.getElementById('segShowBoxes');
  const segZoomIn = document.getElementById('segZoomIn');
  const segZoomOut = document.getElementById('segZoomOut');
  const segZoomFit = document.getElementById('segZoomFit');
  const segToolButtons = document.querySelectorAll('.seg-tool');
  const segBrushSizeWrap = document.getElementById('segBrushSizeWrap');
  const segBrushSize = document.getElementById('segBrushSize');
  const segBrushSizeVal = document.getElementById('segBrushSizeVal');
  const segBgColor = document.getElementById('segBgColor');
  const segBgAuto = document.getElementById('segBgAuto');
  const segUndoErase = document.getElementById('segUndoErase');
  const segClearErase = document.getElementById('segClearErase');
  const segNextLine = document.getElementById('segNextLine');
  const segSaveState = document.getElementById('segSaveState');

  const SEG_MIN_DRAG = 8;      // display px below which a drag is a stray tap
  const SEG_HANDLE_HIT = 20;   // display px radius for grabbing a corner
  const SEG_SAVE_DELAY = 450;  // ms of quiet before an edit is pushed to the server

  const seg = {
    image: null,      // the current sheet as an HTMLImageElement
    data: null,       // { image, lines } from /lines
    activeLine: null,
    scale: 1,
    fitScale: 1,
    tool: 'select',
    drag: null,
    preview: null,    // rectangle being dragged, in image pixels
    stroke: null,     // erase stroke in progress
    busy: false,
    saveTimer: null,
    pending: false,
  };

  function segReset() {
    if (seg.saveTimer) clearTimeout(seg.saveTimer);
    seg.image = null;
    seg.data = null;
    seg.activeLine = null;
    seg.drag = null;
    seg.preview = null;
    seg.stroke = null;
    seg.busy = false;
    seg.saveTimer = null;
    seg.pending = false;
    setSaveState('');
  }

  function setSaveState(text, kind) {
    if (!segSaveState) return;
    segSaveState.textContent = text;
    segSaveState.className = 'seg-save-state' + (kind ? ' ' + kind : '');
  }

  function activeLineObj() {
    if (!seg.data || seg.activeLine === null) return null;
    return seg.data.lines.find(l => l.line_no === seg.activeLine) || null;
  }

  // The shape being edited. A line with no segment yet has nothing to edit.
  function activeShape() {
    const line = activeLineObj();
    return line && line.segment ? line.segment : null;
  }

  async function openModal(imageId) {
    try {
      const res = await fetch(`/api/admin/images/${imageId}/lines`);
      if (!res.ok) {
        alert('خطا در دریافت اطلاعات برگه.');
        return;
      }
      const data = await res.json();
      if (!data.success) return;

      segReset();
      seg.data = data;
      seg.tool = 'select';
      syncToolButtons();

      const img = data.image;
      const categoryLabel = img.sheet_category === 'numbers'
        ? 'برگه اعداد'
        : (img.sheet_category ? 'برگه جملات و کلمات' : 'ارسال قدیمی');

      modalTitle.textContent = `برگه #${img.id} — ${categoryLabel}`;
      modalInfo.innerHTML = `
        <div><strong>نویسنده:</strong> <span style="color:var(--primary);">${escapeHtml(img.contributor_name || 'ثبت نشده')}</span>
             <code style="font-size:0.78rem; color:var(--gray-500);">${escapeHtml(img.contributor_id || '—')}</code></div>
        <div><strong>تاریخ:</strong> ${escapeHtml(formatDate(img.created_at))}</div>
        <div><strong>وضعیت:</strong> <span class="status-badge ${escapeHtml(img.status)}">${statusLabel(img.status)}</span></div>
        ${img.rejection_reason ? `<div><strong>دلیل رد:</strong> ${escapeHtml(img.rejection_reason)}</div>` : ''}
        ${img.drive_file_id ? `<div><strong>Drive ID:</strong> ${escapeHtml(img.drive_file_id)}</div>` : ''}
        ${img.file_missing ? `<div style="color:var(--danger); font-weight:600;">⚠️ فایل تصویر روی سرور یافت نشد.</div>` : ''}
      `;

      renderModalActions(img);
      renderSegList();
      imageModal.classList.add('active');

      if (!img.file_missing) {
        loadSegImage(img);
      }
    } catch (err) {
      console.error('Error opening review modal:', err);
    }
  }

  function loadSegImage(img) {
    const folder = img.status === 'approved' ? 'approved' : 'pending';
    const el = new Image();
    el.onload = () => {
      seg.image = el;
      segFit();
      segDraw();
    };
    // Status and folder can drift if a file move ever failed; try the other folder
    // once before giving up, so review is never blocked by that drift.
    el.onerror = () => {
      if (el.dataset.retried) return;
      el.dataset.retried = '1';
      el.src = `/uploads/${folder === 'approved' ? 'pending' : 'approved'}/${encodeURIComponent(img.filename)}`;
    };
    el.src = `/uploads/${folder}/${encodeURIComponent(img.filename)}`;
  }

  function segFit() {
    if (!seg.image) return;
    const available = (segCanvasWrap.clientWidth || 640) - 16;
    seg.fitScale = Math.min(1, available / seg.image.naturalWidth);
    seg.scale = seg.fitScale;
    segResizeCanvas();
  }

  function segResizeCanvas() {
    if (!seg.image) return;
    segCanvas.width = Math.max(1, Math.round(seg.image.naturalWidth * seg.scale));
    segCanvas.height = Math.max(1, Math.round(seg.image.naturalHeight * seg.scale));
  }

  function segZoom(factor) {
    if (!seg.image) return;
    seg.scale = Math.max(0.05, Math.min(4, seg.scale * factor));
    segResizeCanvas();
    segDraw();
  }

  if (segZoomIn) segZoomIn.addEventListener('click', () => segZoom(1.25));
  if (segZoomOut) segZoomOut.addEventListener('click', () => segZoom(0.8));
  if (segZoomFit) segZoomFit.addEventListener('click', () => { segFit(); segDraw(); });
  if (segShowBoxes) segShowBoxes.addEventListener('change', segDraw);

  // --- Paper colour -------------------------------------------------------
  //
  // The eraser paints the paper colour so a blanked patch is invisible in the crop.
  // Handwriting is a minority of the pixels in a line's box, so the per-channel
  // MEDIAN of that box is the paper — robust to ink, ruling and a stray shadow in a
  // way a mean or a corner sample is not.
  function detectPaperColor(box) {
    if (!seg.image || !box) return '#ffffff';
    const sw = Math.max(1, Math.min(160, Math.round(box.w)));
    const sh = Math.max(1, Math.min(160, Math.round(box.h)));
    const tmp = document.createElement('canvas');
    tmp.width = sw;
    tmp.height = sh;
    const ctx = tmp.getContext('2d', { willReadFrequently: true });
    try {
      ctx.drawImage(seg.image, box.x, box.y, box.w, box.h, 0, 0, sw, sh);
      const { data } = ctx.getImageData(0, 0, sw, sh);
      const channels = [[], [], []];
      for (let i = 0; i < data.length; i += 4) {
        channels[0].push(data[i]);
        channels[1].push(data[i + 1]);
        channels[2].push(data[i + 2]);
      }
      const median = arr => {
        arr.sort((a, b) => a - b);
        return arr[Math.floor(arr.length / 2)] || 255;
      };
      const rgb = channels.map(median);
      return '#' + rgb.map(v => v.toString(16).padStart(2, '0')).join('');
    } catch (err) {
      console.warn('paper colour detection failed:', err.message);
      return '#ffffff';
    }
  }

  function currentBgColor() {
    const shape = activeShape();
    if (shape && shape.bg_color) return shape.bg_color;
    return segBgColor ? segBgColor.value : '#ffffff';
  }

  // --- Geometry helpers ---------------------------------------------------

  function quadBBox(quad) {
    const xs = quad.map(p => p[0]);
    const ys = quad.map(p => p[1]);
    const x = Math.min(...xs);
    const y = Math.min(...ys);
    return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
  }

  function rectToQuad(x, y, w, h) {
    return [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
  }

  function pointInQuad(px, py, quad) {
    let inside = false;
    for (let i = 0, j = quad.length - 1; i < quad.length; j = i++) {
      const [xi, yi] = quad[i];
      const [xj, yj] = quad[j];
      const hit = (yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi + Number.EPSILON) + xi;
      if (hit) inside = !inside;
    }
    return inside;
  }

  function segPoint(e) {
    const rect = segCanvas.getBoundingClientRect();
    return {
      x: (e.clientX - rect.left) * (segCanvas.width / rect.width),
      y: (e.clientY - rect.top) * (segCanvas.height / rect.height),
    };
  }

  // Display point -> original-image point.
  function toImagePoint(p) {
    return [p.x / seg.scale, p.y / seg.scale];
  }

  function clampToImage(point) {
    return [
      Math.max(0, Math.min(point[0], seg.image ? seg.image.naturalWidth : point[0])),
      Math.max(0, Math.min(point[1], seg.image ? seg.image.naturalHeight : point[1])),
    ];
  }

  // Which corner (if any) is under the pointer, in display space.
  function hitCorner(p) {
    const shape = activeShape();
    if (!shape) return -1;
    for (let i = 0; i < shape.quad.length; i++) {
      const cx = shape.quad[i][0] * seg.scale;
      const cy = shape.quad[i][1] * seg.scale;
      if (Math.abs(p.x - cx) <= SEG_HANDLE_HIT / 2 && Math.abs(p.y - cy) <= SEG_HANDLE_HIT / 2) return i;
    }
    return -1;
  }

  // --- Drawing ------------------------------------------------------------

  function segDraw() {
    if (!seg.image || !segCanvas.width) return;
    const ctx = segCanvas.getContext('2d');
    const s = seg.scale;
    ctx.clearRect(0, 0, segCanvas.width, segCanvas.height);
    ctx.drawImage(seg.image, 0, 0, segCanvas.width, segCanvas.height);

    const active = activeLineObj();

    if (segShowBoxes && segShowBoxes.checked && seg.data) {
      for (const line of seg.data.lines) {
        if (!line.segment) continue;
        if (active && line.line_no === active.line_no) continue; // drawn last, in full
        drawShapeOutline(ctx, line.segment.quad, line.line_no, '#16a34a', 'rgba(22,163,74,0.10)');
      }
    }

    // The active line is rendered as the crop will actually look: everything outside
    // the four corners, and everything erased, painted in the paper colour. What the
    // admin sees here is what the saved crop contains.
    if (active && active.segment) {
      paintActiveShape(ctx, active.segment);
    }

    if (seg.preview) {
      const p = seg.preview;
      ctx.setLineDash([6, 4]);
      ctx.strokeStyle = seg.tool === 'erasebox' ? '#dc2626' : '#2563eb';
      ctx.lineWidth = 2;
      ctx.strokeRect(p.x * s, p.y * s, p.w * s, p.h * s);
      ctx.setLineDash([]);
      ctx.fillStyle = seg.tool === 'erasebox' ? 'rgba(220,38,38,0.18)' : 'rgba(37,99,235,0.14)';
      ctx.fillRect(p.x * s, p.y * s, p.w * s, p.h * s);
    }
  }

  function drawShapeOutline(ctx, quad, lineNo, stroke, fill) {
    const s = seg.scale;
    ctx.beginPath();
    quad.forEach(([x, y], i) => {
      if (i === 0) ctx.moveTo(x * s, y * s);
      else ctx.lineTo(x * s, y * s);
    });
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 2;
    ctx.stroke();

    const box = quadBBox(quad);
    const bx = box.x * s;
    const by = box.y * s;
    const badgeY = by < 20 ? by + 4 : by - 18;
    ctx.fillStyle = stroke;
    ctx.fillRect(bx, badgeY, 26, 16);
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 11px sans-serif';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';
    ctx.fillText(String(lineNo), bx + 13, badgeY + 8);
  }

  function paintActiveShape(ctx, shape) {
    const s = seg.scale;
    const quad = shape.quad;
    const box = quadBBox(quad);
    const bg = currentBgColor();

    ctx.save();

    // 1. Blank the ring between the bounding box and the quad, exactly as the server
    //    will, using even-odd so only the outside is filled.
    ctx.beginPath();
    ctx.rect(box.x * s, box.y * s, box.w * s, box.h * s);
    quad.forEach(([x, y], i) => {
      if (i === 0) ctx.moveTo(x * s, y * s);
      else ctx.lineTo(x * s, y * s);
    });
    ctx.closePath();
    ctx.fillStyle = bg;
    ctx.fill('evenodd');

    // 2. Erase strokes, clipped to the crop so a stroke dragged outside the box does
    //    not paint over the rest of the page in the preview.
    const strokes = (shape.erase || []).concat(seg.stroke ? [seg.stroke] : []);
    if (strokes.length) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(box.x * s, box.y * s, box.w * s, box.h * s);
      ctx.clip();
      ctx.fillStyle = bg;
      ctx.strokeStyle = bg;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      for (const stroke of strokes) {
        if (stroke.type === 'box') {
          ctx.fillRect(stroke.x * s, stroke.y * s, stroke.w * s, stroke.h * s);
        } else if (stroke.points && stroke.points.length === 1) {
          ctx.beginPath();
          ctx.arc(stroke.points[0][0] * s, stroke.points[0][1] * s, (stroke.size * s) / 2, 0, Math.PI * 2);
          ctx.fill();
        } else if (stroke.points && stroke.points.length > 1) {
          ctx.lineWidth = stroke.size * s;
          ctx.beginPath();
          stroke.points.forEach(([x, y], i) => {
            if (i === 0) ctx.moveTo(x * s, y * s);
            else ctx.lineTo(x * s, y * s);
          });
          ctx.stroke();
        }
      }
      ctx.restore();
    }

    ctx.restore();

    // 3. Outline plus the draggable corners on top of the finished preview.
    ctx.beginPath();
    quad.forEach(([x, y], i) => {
      if (i === 0) ctx.moveTo(x * s, y * s);
      else ctx.lineTo(x * s, y * s);
    });
    ctx.closePath();
    ctx.strokeStyle = '#dc2626';
    ctx.lineWidth = 2;
    ctx.stroke();

    if (seg.tool === 'select') {
      for (const [x, y] of quad) {
        const cx = x * s;
        const cy = y * s;
        ctx.beginPath();
        ctx.arc(cx, cy, 6, 0, Math.PI * 2);
        ctx.fillStyle = '#ffffff';
        ctx.fill();
        ctx.lineWidth = 2.5;
        ctx.strokeStyle = '#dc2626';
        ctx.stroke();
      }
    }
  }

  // --- Tools --------------------------------------------------------------

  function syncToolButtons() {
    segToolButtons.forEach(btn => btn.classList.toggle('active', btn.dataset.tool === seg.tool));
    if (segBrushSizeWrap) segBrushSizeWrap.style.display = seg.tool === 'brush' ? 'inline-flex' : 'none';
    segCanvas.classList.toggle('erasing', seg.tool !== 'select');
    updateEraseButtons();
  }

  function updateEraseButtons() {
    const shape = activeShape();
    const count = shape && shape.erase ? shape.erase.length : 0;
    if (segUndoErase) segUndoErase.disabled = count === 0;
    if (segClearErase) segClearErase.disabled = count === 0;
  }

  segToolButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      seg.tool = btn.dataset.tool;
      syncToolButtons();
      segDraw();
    });
  });

  if (segBrushSize) {
    segBrushSize.addEventListener('input', () => {
      if (segBrushSizeVal) segBrushSizeVal.textContent = faDigits(segBrushSize.value);
    });
  }

  if (segBgColor) {
    segBgColor.addEventListener('input', () => {
      const shape = activeShape();
      if (!shape) return;
      shape.bg_color = segBgColor.value;
      segDraw();
      queueSegmentSave();
    });
  }

  if (segBgAuto) {
    segBgAuto.addEventListener('click', () => {
      const shape = activeShape();
      if (!shape) return;
      const colour = detectPaperColor(quadBBox(shape.quad));
      shape.bg_color = colour;
      if (segBgColor) segBgColor.value = colour;
      segDraw();
      queueSegmentSave();
    });
  }

  if (segUndoErase) {
    segUndoErase.addEventListener('click', () => {
      const shape = activeShape();
      if (!shape || !shape.erase.length) return;
      shape.erase.pop();
      updateEraseButtons();
      segDraw();
      queueSegmentSave();
    });
  }

  if (segClearErase) {
    segClearErase.addEventListener('click', () => {
      const shape = activeShape();
      if (!shape || !shape.erase.length) return;
      shape.erase = [];
      updateEraseButtons();
      segDraw();
      queueSegmentSave();
    });
  }

  // --- Pointer interaction -------------------------------------------------

  segCanvas.addEventListener('pointerdown', (e) => {
    if (!seg.image || seg.busy || seg.activeLine === null) return;
    segCanvas.setPointerCapture(e.pointerId);
    const p = segPoint(e);
    const imgPoint = toImagePoint(p);
    const shape = activeShape();

    if (seg.tool === 'brush') {
      if (!shape) return;
      seg.stroke = { type: 'brush', points: [clampToImage(imgPoint)], size: Number(segBrushSize?.value) || 24 };
      seg.drag = { mode: 'brush' };
      segDraw();
      return;
    }

    if (seg.tool === 'erasebox') {
      if (!shape) return;
      seg.drag = { mode: 'erasebox', anchor: imgPoint };
      seg.preview = { x: imgPoint[0], y: imgPoint[1], w: 0, h: 0 };
      return;
    }

    // Select tool: grab a corner, move the whole shape, or start a new box.
    const corner = hitCorner(p);
    if (corner !== -1) {
      seg.drag = { mode: 'corner', index: corner };
      return;
    }
    if (shape && pointInQuad(imgPoint[0], imgPoint[1], shape.quad)) {
      seg.drag = { mode: 'move', start: imgPoint, orig: shape.quad.map(pt => pt.slice()) };
      return;
    }
    seg.drag = { mode: 'new', anchor: imgPoint };
    seg.preview = { x: imgPoint[0], y: imgPoint[1], w: 0, h: 0 };
  });

  segCanvas.addEventListener('pointermove', (e) => {
    if (!seg.drag) return;
    const p = segPoint(e);
    const imgPoint = toImagePoint(p);
    const shape = activeShape();

    if (seg.drag.mode === 'brush' && seg.stroke) {
      // pointermove fires far denser than the stroke needs. Drop points that land
      // within a couple of image pixels of the last one, so a long drag stays a
      // small payload and a light redraw instead of thousands of duplicates.
      const next = clampToImage(imgPoint);
      const last = seg.stroke.points[seg.stroke.points.length - 1];
      if (Math.abs(next[0] - last[0]) >= 2 || Math.abs(next[1] - last[1]) >= 2) {
        seg.stroke.points.push(next);
        segDraw();
      }
      return;
    }

    if (seg.drag.mode === 'corner' && shape) {
      shape.quad[seg.drag.index] = clampToImage(imgPoint);
      segDraw();
      return;
    }

    if (seg.drag.mode === 'move' && shape) {
      const dx = imgPoint[0] - seg.drag.start[0];
      const dy = imgPoint[1] - seg.drag.start[1];
      shape.quad = seg.drag.orig.map(([x, y]) => clampToImage([x + dx, y + dy]));
      segDraw();
      return;
    }

    if (seg.drag.mode === 'new' || seg.drag.mode === 'erasebox') {
      const a = seg.drag.anchor;
      seg.preview = {
        x: Math.min(a[0], imgPoint[0]),
        y: Math.min(a[1], imgPoint[1]),
        w: Math.abs(imgPoint[0] - a[0]),
        h: Math.abs(imgPoint[1] - a[1]),
      };
      segDraw();
    }
  });

  async function segEndDrag(e) {
    if (!seg.drag) return;
    const mode = seg.drag.mode;
    seg.drag = null;
    if (e && e.pointerId !== undefined && segCanvas.hasPointerCapture(e.pointerId)) {
      segCanvas.releasePointerCapture(e.pointerId);
    }

    const shape = activeShape();

    if (mode === 'brush') {
      if (seg.stroke && shape) {
        shape.erase.push(seg.stroke);
        updateEraseButtons();
        queueSegmentSave();
      }
      seg.stroke = null;
      segDraw();
      return;
    }

    if (mode === 'erasebox') {
      const box = seg.preview;
      seg.preview = null;
      // A selection box needs real width AND height, but the commonest erase is a
      // thin horizontal strip over the line above — so require one long side and
      // only a couple of pixels on the other, or that strip is silently discarded.
      const longSide = Math.max(box ? box.w : 0, box ? box.h : 0) * seg.scale;
      const shortSide = Math.min(box ? box.w : 0, box ? box.h : 0) * seg.scale;
      if (shape && box && longSide >= SEG_MIN_DRAG && shortSide >= 2) {
        shape.erase.push({
          type: 'box',
          x: Math.round(box.x), y: Math.round(box.y),
          w: Math.round(box.w), h: Math.round(box.h),
        });
        updateEraseButtons();
        queueSegmentSave();
      }
      segDraw();
      return;
    }

    if (mode === 'corner' || mode === 'move') {
      queueSegmentSave();
      segDraw();
      return;
    }

    if (mode === 'new') {
      const box = seg.preview;
      seg.preview = null;
      // A click without a real drag should not save a one-pixel crop.
      if (!box || box.w * seg.scale < SEG_MIN_DRAG || box.h * seg.scale < SEG_MIN_DRAG) {
        segDraw();
        return;
      }
      const quad = rectToQuad(Math.round(box.x), Math.round(box.y), Math.round(box.w), Math.round(box.h));
      const line = activeLineObj();
      if (!line) return;
      const colour = detectPaperColor(quadBBox(quad));
      if (segBgColor) segBgColor.value = colour;
      line.segment = { line_no: line.line_no, text: line.text, quad, erase: [], bg_color: colour };
      updateEraseButtons();
      segDraw();
      await saveSegment();
    }
  }

  segCanvas.addEventListener('pointerup', segEndDrag);
  segCanvas.addEventListener('pointercancel', () => {
    seg.drag = null;
    seg.preview = null;
    seg.stroke = null;
    segDraw();
  });

  // --- Saving --------------------------------------------------------------
  //
  // Corner drags and erase strokes come in bursts, and each save re-cuts the crop
  // server-side. Coalesce them so a fiddly adjustment is one request, not thirty.
  function queueSegmentSave() {
    seg.pending = true;
    setSaveState('در حال ذخیره...', 'saving');
    if (seg.saveTimer) clearTimeout(seg.saveTimer);
    seg.saveTimer = setTimeout(() => {
      seg.saveTimer = null;
      saveSegment();
    }, SEG_SAVE_DELAY);
  }

  async function flushSegmentSave() {
    if (seg.saveTimer) {
      clearTimeout(seg.saveTimer);
      seg.saveTimer = null;
      await saveSegment();
    }
  }

  async function saveSegment() {
    const line = activeLineObj();
    if (!seg.data || !line || !line.segment) return;
    const shape = line.segment;

    seg.busy = true;
    segCanvas.classList.add('busy');
    setSaveState('در حال ذخیره...', 'saving');
    try {
      const res = await fetch(`/api/admin/images/${seg.data.image.id}/segments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          line_no: line.line_no,
          quad: shape.quad.map(([x, y]) => [Math.round(x), Math.round(y)]),
          erase: shape.erase || [],
          bg_color: shape.bg_color || '#ffffff',
        }),
      });
      const data = await res.json();
      if (!data.success) {
        setSaveState(data.error || 'خطا در ذخیره', 'error');
        return;
      }

      // Keep the locally edited geometry (the admin may have moved on already) but
      // adopt the server's filename so the thumbnail points at the new crop.
      shape.filename = data.segment.filename;
      shape.x = data.segment.x;
      shape.y = data.segment.y;
      shape.w = data.segment.w;
      shape.h = data.segment.h;

      seg.pending = false;
      setSaveState('ذخیره شد ✓', 'saved');
      renderSegList();
      renderModalActions(seg.data.image);
      updateCachedSegmentCount(seg.data.image.id, data.segmentCount, data.totalLines);
      loadStats();
    } catch (err) {
      setSaveState('خطا در ارتباط با سرور', 'error');
    } finally {
      seg.busy = false;
      segCanvas.classList.remove('busy');
    }
  }

  async function deleteSegmentLine(lineNo) {
    if (!seg.data) return;
    if (seg.saveTimer) { clearTimeout(seg.saveTimer); seg.saveTimer = null; }
    try {
      const res = await fetch(`/api/admin/images/${seg.data.image.id}/segments/${lineNo}`, { method: 'DELETE' });
      const data = await res.json();
      if (!data.success) {
        alert(data.error || 'خطا در حذف برش.');
        return;
      }
      const line = seg.data.lines.find(l => l.line_no === lineNo);
      if (line) line.segment = null;
      seg.activeLine = lineNo;
      setSaveState('');
      renderSegList();
      renderModalActions(seg.data.image);
      updateCachedSegmentCount(seg.data.image.id, data.segmentCount, seg.data.lines.length);
      updateEraseButtons();
      segDraw();
      loadStats();
    } catch (err) {
      alert('خطا در ارتباط با سرور: ' + err.message);
    }
  }

  // --- Line navigation -----------------------------------------------------
  //
  // The admin now STAYS on a line after drawing it, so corners and erasing can be
  // adjusted in place; moving on is deliberate (button or Enter).
  async function goToNextLine() {
    await flushSegmentSave();
    selectNextUnsegmentedLine();
    seg.tool = 'select';
    seg.stroke = null;
    seg.preview = null;
    setSaveState('');
    const next = activeShape();
    if (next && next.bg_color && segBgColor) segBgColor.value = next.bg_color;
    syncToolButtons();
    renderSegList();
    segDraw();
  }

  if (segNextLine) segNextLine.addEventListener('click', goToNextLine);

  document.addEventListener('keydown', (e) => {
    if (!imageModal.classList.contains('active')) return;
    const tag = (e.target && e.target.tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if (e.key === 'Enter') {
      e.preventDefault();
      goToNextLine();
    } else if (e.key === 'Escape') {
      closeReviewModal();
    }
  });

  function selectNextUnsegmentedLine() {
    if (!seg.data) return;
    const lines = seg.data.lines;
    const startIndex = lines.findIndex(l => l.line_no === seg.activeLine);
    // Look forward from the current line first, then wrap, so the admin walks the
    // page top to bottom instead of jumping back to an earlier gap every time.
    for (let i = 1; i <= lines.length; i++) {
      const line = lines[(startIndex + i + lines.length) % lines.length];
      if (!line.segment) {
        seg.activeLine = line.line_no;
        return;
      }
    }
    seg.activeLine = null; // everything is segmented
  }

  async function setActiveLine(lineNo) {
    if (lineNo === seg.activeLine) return;
    // Never let a queued edit land on the line the admin just switched away from.
    await flushSegmentSave();
    seg.activeLine = lineNo;
    seg.stroke = null;
    seg.preview = null;
    seg.tool = 'select';
    setSaveState('');
    // The colour picker follows the selected line's own detected paper colour.
    const shape = activeShape();
    if (shape && shape.bg_color && segBgColor) segBgColor.value = shape.bg_color;
    syncToolButtons();
    renderSegList();
    segDraw();
  }

  // The admin panel writes counts in Persian digits; the brush-size readout has to
  // match the ۲۴ it starts out showing.
  const ADMIN_FA_DIGITS = ['۰', '۱', '۲', '۳', '۴', '۵', '۶', '۷', '۸', '۹'];
  function faDigits(value) {
    return String(value).replace(/[0-9]/g, d => ADMIN_FA_DIGITS[Number(d)]);
  }

  function renderSegList() {
    if (!seg.data) {
      segList.innerHTML = '';
      return;
    }
    const lines = seg.data.lines;
    const done = lines.filter(l => l.segment).length;

    if (seg.activeLine === null && done < lines.length) {
      const firstOpen = lines.find(l => !l.segment);
      if (firstOpen) seg.activeLine = firstOpen.line_no;
    }

    segProgress.textContent = `${done} از ${lines.length}`;
    segProgress.className = 'seg-progress' + (done === lines.length && lines.length > 0 ? ' complete' : '');

    const activeLine = lines.find(l => l.line_no === seg.activeLine);
    segCurrentNo.textContent = activeLine ? activeLine.line_no : '—';
    segCurrentText.textContent = activeLine ? activeLine.text : 'همه سطرها کادرکشی شده‌اند ✓';
    segCurrentText.classList.toggle('done', !activeLine);

    segList.innerHTML = '';
    for (const line of lines) {
      const li = document.createElement('li');
      li.className = 'seg-line'
        + (line.segment ? ' done' : '')
        + (line.line_no === seg.activeLine ? ' active' : '');

      const no = document.createElement('span');
      no.className = 'seg-line-no';
      no.textContent = line.line_no;

      const body = document.createElement('div');
      body.className = 'seg-line-body';

      const text = document.createElement('div');
      text.className = 'seg-line-text';
      text.textContent = line.text;
      body.appendChild(text);

      if (line.segment && line.segment.filename) {
        const thumb = document.createElement('img');
        thumb.className = 'seg-line-thumb';
        thumb.loading = 'lazy';
        thumb.alt = '';
        thumb.src = `/uploads/segments/${encodeURIComponent(line.segment.filename)}`;
        body.appendChild(thumb);
      }

      const actions = document.createElement('div');
      actions.className = 'seg-line-actions';

      if (line.segment) {
        const del = document.createElement('button');
        del.type = 'button';
        del.className = 'seg-line-btn danger';
        del.textContent = 'حذف کادر';
        del.addEventListener('click', (e) => {
          e.stopPropagation();
          deleteSegmentLine(line.line_no);
        });
        actions.appendChild(del);
      } else {
        const mark = document.createElement('span');
        mark.className = 'seg-line-pending';
        mark.textContent = 'کادرکشی نشده';
        actions.appendChild(mark);
      }

      li.appendChild(no);
      li.appendChild(body);
      li.appendChild(actions);
      li.addEventListener('click', () => setActiveLine(line.line_no));
      segList.appendChild(li);
    }
  }

  function renderModalActions(img) {
    const lines = seg.data ? seg.data.lines : [];
    const done = lines.filter(l => l.segment).length;
    const total = lines.length;

    let html = '';
    if (img.status === 'pending') {
      html += `<button class="btn btn-success" onclick="adminAction(${img.id}, 'approved')">تایید برگه</button>
               <button class="btn btn-danger" onclick="adminAction(${img.id}, 'rejected')">رد کردن</button>`;
    } else if (img.status === 'approved') {
      html += `<button class="btn btn-danger" onclick="adminAction(${img.id}, 'rejected')">رد کردن</button>`;
      if (!img.drive_file_id) {
        html += `<button class="btn btn-primary" onclick="syncSingle(${img.id})">همگام‌سازی با درایو</button>`;
      }
    } else if (img.status === 'rejected') {
      html += `<button class="btn btn-success" onclick="adminAction(${img.id}, 'approved')">تایید برگه</button>`;
    }

    // Segmentation is deliberately not a gate on approval, but an approved sheet
    // with unsegmented lines contributes nothing to the dataset, so say so.
    if (total > 0 && done < total) {
      html += `<span class="seg-warn">⚠️ ${total - done} سطر هنوز کادرکشی نشده است — این سطرها وارد دیتاست نمی‌شوند.</span>`;
    } else if (total > 0) {
      html += `<span class="seg-ok">✓ هر ${total} سطر کادرکشی شد.</span>`;
    }

    modalActions.innerHTML = html;
  }

  window.addEventListener('resize', () => {
    if (imageModal.classList.contains('active') && seg.image) {
      segFit();
      segDraw();
    }
  });

  function closeReviewModal() {
    // A queued corner drag or erase stroke must reach the server before the modal
    // state is thrown away, or the admin's last edit is silently lost.
    flushSegmentSave().finally(() => {
      imageModal.classList.remove('active');
      segReset();
      refreshActiveGrid();
    });
  }

  modalClose.addEventListener('click', closeReviewModal);
  imageModal.addEventListener('click', (e) => {
    if (e.target === imageModal) closeReviewModal();
  });

  // --- Admin actions (global for onclick) ---
  window.adminAction = async function(imageId, status) {
    let rejectionReason = null;
    if (status === 'rejected') {
      rejectionReason = prompt('دلیل رد (اختیاری):');
      if (rejectionReason === null) return; // Admin clicked Cancel — abort
    }

    try {
      const res = await fetch(`/api/admin/images/${imageId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status, rejection_reason: rejectionReason }),
      });
      const data = await res.json();
      if (data.success) {
        closeReviewModal();
        loadStats();
        loadPending();
        loadAll();
      }
    } catch {
      alert('خطا در انجام عملیات');
    }
  };

  window.syncSingle = async function(imageId) {
    try {
      const res = await fetch(`/api/admin/images/${imageId}/sync`, { method: 'POST' });
      const data = await res.json();
      if (data.success) {
        alert('همگام‌سازی موفقیت‌آمیز بود!');
        closeReviewModal();
        loadStats();
        loadSync();
      } else {
        alert('خطا: ' + (data.error || 'نامشخص'));
      }
    } catch {
      alert('خطا در هگام‌سازی');
    }
  };

  // --- Prompts ---
  const promptCounts = document.getElementById('promptCounts');
  const btnActivateAllPrompts = document.getElementById('btnActivateAllPrompts');
  const btnDeactivateAllPrompts = document.getElementById('btnDeactivateAllPrompts');

  // An all-inactive bank is indistinguishable from an empty one on the volunteer
  // side, so the admin needs to see the split without opening the table.
  function renderPromptCounts(prompts) {
    if (!promptCounts) return;
    const total = prompts.length;
    const active = prompts.filter(p => p.active).length;
    const inactive = total - active;

    const byCat = {};
    for (const p of prompts) {
      const key = p.category || 'custom';
      if (!byCat[key]) byCat[key] = { total: 0, active: 0 };
      byCat[key].total++;
      if (p.active) byCat[key].active++;
    }
    const catText = Object.entries(byCat)
      .map(([cat, c]) => `${escapeHtml(cat)}: ${c.active}/${c.total}`)
      .join(' · ');

    const warn = total > 0 && active === 0
      ? '<div class="prompt-counts-warn">⚠️ هیچ متن فعالی وجود ندارد — برای مشارکت‌کنندگان هیچ برگه‌ای ساخته نمی‌شود.</div>'
      : (inactive > 0 ? `<div class="prompt-counts-warn">⚠️ ${inactive} متن غیرفعال است.</div>` : '');

    promptCounts.innerHTML =
      `<strong>${active}</strong> فعال از <strong>${total}</strong> متن`
      + (catText ? ` <span class="prompt-counts-cat">(${catText})</span>` : '')
      + warn;
  }

  async function setAllPromptsActive(active) {
    const label = active ? 'فعال' : 'غیرفعال';
    if (!confirm(`آیا از ${label} کردن «همه» متن‌ها اطمینان دارید؟`)) return;
    const btn = active ? btnActivateAllPrompts : btnDeactivateAllPrompts;
    if (btn) btn.disabled = true;
    try {
      const res = await fetch('/api/admin/prompts/bulk-active', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ active: active ? 1 : 0 }),
      });
      const data = await res.json();
      if (data.success) {
        alert(`${data.changed} متن ${label} شد. اکنون ${data.stats.active} از ${data.stats.total} متن فعال است.`);
        loadPrompts();
        loadStats();
      } else {
        alert('خطا: ' + (data.error || 'نامشخص'));
      }
    } catch (err) {
      alert('خطا در ارتباط با سرور: ' + err.message);
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  if (btnActivateAllPrompts) btnActivateAllPrompts.addEventListener('click', () => setAllPromptsActive(true));
  if (btnDeactivateAllPrompts) btnDeactivateAllPrompts.addEventListener('click', () => setAllPromptsActive(false));

  async function loadPrompts() {
    try {
      const res = await fetch('/api/admin/prompts');
      // An expired session returns 401 and used to land in the silent catch below,
      // leaving an empty table that looks exactly like "all my prompts are gone".
      if (res.status === 401) {
        loginSection.style.display = 'block';
        dashboardSection.style.display = 'none';
        btnLogout.style.display = 'none';
        throw new Error('نشست شما منقضی شده است. لطفاً دوباره وارد شوید.');
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const prompts = await res.json();
      if (!prompts || prompts.length === 0) {
        promptsList.innerHTML = '';
        promptsEmpty.style.display = 'block';
        renderPromptCounts([]);
        return;
      }
      promptsEmpty.style.display = 'none';
      renderPromptCounts(prompts);
      promptsList.innerHTML = prompts.map(p => `
        <tr>
          <td>${escapeHtml(p.text)}</td>
          <td>${escapeHtml(p.category)}</td>
          <td>${p.active ? 'فعال' : 'غیرفعال'}</td>
          <td>
            <button class="btn btn-sm btn-outline" onclick="togglePrompt(${p.id}, ${p.active ? 0 : 1})">
              ${p.active ? 'غیرفعال' : 'فعال'}
            </button>
            <button class="btn btn-sm btn-danger" onclick="deletePrompt(${p.id})">حذف</button>
          </td>
        </tr>
      `).join('');
    } catch (err) {
      // Never fail silently here: an empty prompt table is indistinguishable from a
      // lost prompt bank, and that ambiguity costs far more than a visible error.
      promptsList.innerHTML = '';
      promptsEmpty.style.display = 'none';
      if (promptCounts) {
        promptCounts.innerHTML =
          `<span style="color:var(--danger); font-weight:600;">خطا در بارگذاری متن‌ها: ${escapeHtml(err && err.message)}</span>`;
      }
      console.error('loadPrompts failed:', err);
    }
  }

  window.togglePrompt = async function(id, active) {
    await fetch(`/api/admin/prompts/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ active: !!active }),
    });
    loadPrompts();
  };

  window.deletePrompt = async function(id) {
    if (!confirm('آیا از حذف این متن مطمئن هستید؟')) return;
    try {
      const res = await fetch(`/api/admin/prompts/${id}`, { method: 'DELETE' });
      const data = await res.json();
      if (data.success) {
        loadPrompts();
      } else {
        alert('خطا: ' + (data.error || 'امکان حذف متن وجود ندارد.'));
      }
    } catch {
      alert('خطا در حذف متن');
    }
  };

  // Add manual prompt form
  const addPromptForm = document.getElementById('addPromptForm');
  const manualPromptText = document.getElementById('manualPromptText');
  const manualPromptCategory = document.getElementById('manualPromptCategory');

  if (addPromptForm) {
    addPromptForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const text = manualPromptText.value.trim();
      const category = manualPromptCategory.value;
      if (!text) return;

      try {
        const res = await fetch('/api/admin/prompts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text, category }),
        });
        const data = await res.json();
        if (data.success) {
          manualPromptText.value = '';
          loadPrompts();
        } else {
          alert('خطا: ' + (data.error || 'نامشخص'));
        }
      } catch {
        alert('خطا در افزودن متن');
      }
    });
  }

  csvInput.addEventListener('change', async () => {
    const file = csvInput.files[0];
    if (!file) return;

    const formData = new FormData();
    // Append category before file
    formData.append('category', csvCategory.value);
    formData.append('csv', file);

    try {
      const res = await fetch('/api/admin/prompts/upload', { method: 'POST', body: formData });
      const data = await res.json();
      if (data.success) {
        let msg = `${data.imported} متن با موفقیت اضافه شد.`;
        if (data.skipped) {
          msg += `
${data.skipped} مورد تکراری بود و اضافه نشد (از ${data.received} سطر فایل).`;
        }
        if (data.stats) {
          msg += `
مجموع متن‌ها: ${data.stats.active} فعال از ${data.stats.total}.`;
        }
        alert(msg);
        csvInput.value = '';
        loadPrompts();
      } else {
        alert('خطا: ' + (data.error || 'نامشخص'));
      }
    } catch {
      alert('خطا در آپلود فایل');
    }
  });

  // --- Sync ---
  function showDriveMsg(msg, type) {
    if (!driveMsg) return;
    driveMsg.textContent = msg;
    driveMsg.className = 'status-msg active ' + type;
  }

  async function loadDriveConfig() {
    try {
      const res = await fetch('/api/admin/drive/config');
      const data = await res.json();

      if (data.configured) {
        driveStatusBadge.textContent = 'متصل و فعال 🟢';
        driveStatusBadge.style.background = '#dcfce7';
        driveStatusBadge.style.color = '#166534';
      } else {
        driveStatusBadge.textContent = 'غیرفعال ⚪';
        driveStatusBadge.style.background = '#fee2e2';
        driveStatusBadge.style.color = '#991b1b';
      }

      if (data.folder_id && !driveFolderId.value) {
        driveFolderId.value = data.folder_id;
      }
      if (data.client_email && !driveClientEmail.value) {
        driveClientEmail.value = data.client_email;
      }
      if (data.has_private_key) {
        drivePrivateKey.placeholder = 'کلید اختصاصی در سیستم ذخیره شده است. (برای تغییر، کلید جدید را وارد کنید)';
      }
    } catch (err) {
      console.error('Error loading drive config:', err);
    }
  }

  if (btnTestDrive) {
    btnTestDrive.addEventListener('click', async () => {
      const folder_id = driveFolderId.value.trim();
      const client_email = driveClientEmail.value.trim();
      const private_key = drivePrivateKey.value.trim();

      if (!folder_id || !client_email) {
        showDriveMsg('لطفاً شناسه پوشه و ایمیل سرویس را وارد کنید.', 'error');
        return;
      }

      btnTestDrive.disabled = true;
      btnTestDrive.innerHTML = '<span class="spinner"></span> در حال بررسی...';

      try {
        const res = await fetch('/api/admin/drive/test', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ folder_id, client_email, private_key }),
        });
        const data = await res.json();
        if (data.success) {
          showDriveMsg(`اتصال موفقیت‌آمیز بود! دسترسی به پوشه «${data.folderName}» در گوگل درایو تایید شد.`, 'success');
        } else {
          showDriveMsg(data.error || 'خطا در تست اتصال.', 'error');
        }
      } catch (err) {
        showDriveMsg('خطا در برقراری ارتباط با سرور.', 'error');
      } finally {
        btnTestDrive.disabled = false;
        btnTestDrive.innerHTML = '<svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg> تست اتصال و بررسی دسترسی پوشه';
      }
    });
  }

  if (driveConfigForm) {
    driveConfigForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const folder_id = driveFolderId.value.trim();
      const client_email = driveClientEmail.value.trim();
      const private_key = drivePrivateKey.value.trim();

      if (!folder_id || !client_email || !private_key) {
        showDriveMsg('لطفاً تمام فیلدهای شناسه پوشه، ایمیل و کلید اختصاصی را تکمیل کنید.', 'error');
        return;
      }

      btnSaveDrive.disabled = true;
      btnSaveDrive.innerHTML = '<span class="spinner"></span> در حال ذخیره...';

      try {
        const res = await fetch('/api/admin/drive/config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ folder_id, client_email, private_key }),
        });
        const data = await res.json();
        if (data.success) {
          showDriveMsg(`تنظیمات ذخیره شد! اتصال به پوشه «${data.folderName || ''}» فعال گردید.`, 'success');
          loadDriveConfig();
          loadStats();
        } else {
          showDriveMsg(data.error || 'خطا در ذخیره تنظیمات.', 'error');
        }
      } catch (err) {
        showDriveMsg('خطا در ذخیره تنظیمات در سرور.', 'error');
      } finally {
        btnSaveDrive.disabled = false;
        btnSaveDrive.innerHTML = '<svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg> ذخیره تنظیمات';
      }
    });
  }

  // --- GitHub Sync ---
  function showGitHubMsg(msg, type) {
    if (!githubMsg) return;
    githubMsg.textContent = msg;
    githubMsg.className = 'status-msg active ' + type;
  }

  async function loadGitHubConfig() {
    try {
      const res = await fetch('/api/admin/github/config');
      const data = await res.json();

      if (data.isConfigured) {
        githubStatusBadge.textContent = 'تنظیم شده 🟢';
        githubStatusBadge.style.background = '#dcfce7';
        githubStatusBadge.style.color = '#166534';
      } else {
        githubStatusBadge.textContent = 'تنظیم نشده ⚪';
        githubStatusBadge.style.background = '#fee2e2';
        githubStatusBadge.style.color = '#991b1b';
      }

      if (data.repo && !githubRepo.value) {
        githubRepo.value = data.repo;
      }
      if (data.branch && !githubBranch.value) {
        githubBranch.value = data.branch;
      }
      if (data.path !== undefined && !githubPath.value) {
        githubPath.value = data.path;
      }
      if (data.hasToken) {
        githubToken.placeholder = `توکن در سیستم ذخیره شده است (${data.maskedToken})`;
      }
    } catch (err) {
      console.error('Error loading GitHub config:', err);
    }
  }

  if (btnTestGitHub) {
    btnTestGitHub.addEventListener('click', async () => {
      const token = githubToken.value.trim();
      const repo = githubRepo.value.trim();
      const branch = githubBranch.value.trim();

      if (!repo) {
        showGitHubMsg('لطفاً نام ریپازیتوری را وارد کنید.', 'error');
        return;
      }

      btnTestGitHub.disabled = true;
      btnTestGitHub.innerHTML = '<span class="spinner"></span> در حال بررسی اتصال...';

      try {
        const res = await fetch('/api/admin/github/test', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token, repo, branch }),
        });
        const data = await res.json();
        if (data.success) {
          showGitHubMsg(`اتصال به ریپازیتوری «${data.repoFullName}» تایید شد! شاخه: ${data.targetBranch} (${data.branchExists ? 'موجود' : 'شاخه جدید ایجاد خواهد شد'})`, 'success');
        } else {
          showGitHubMsg(data.error || 'خطا در برقراری ارتباط با گیت‌هاب.', 'error');
        }
      } catch (err) {
        showGitHubMsg('خطا در برقراری ارتباط با سرور.', 'error');
      } finally {
        btnTestGitHub.disabled = false;
        btnTestGitHub.innerHTML = '<svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg> تست اتصال به گیت‌هاب';
      }
    });
  }

  if (githubConfigForm) {
    githubConfigForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const token = githubToken.value.trim();
      const repo = githubRepo.value.trim();
      const branch = githubBranch.value.trim() || 'main';
      const path = githubPath.value.trim();

      if (!repo) {
        showGitHubMsg('لطفاً نام ریپازیتوری را وارد کنید.', 'error');
        return;
      }

      btnSaveGitHub.disabled = true;
      btnSaveGitHub.innerHTML = '<span class="spinner"></span> در حال ذخیره و بررسی...';

      try {
        const res = await fetch('/api/admin/github/config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token, repo, branch, path }),
        });
        const data = await res.json();
        if (data.success) {
          showGitHubMsg('تنظیمات گیت‌هاب با موفقیت ذخیره شد و دسترسی به ریپازیتوری تایید گردید.', 'success');
          githubToken.value = '';
          loadGitHubConfig();
        } else {
          showGitHubMsg(data.error || 'خطا در ذخیره تنظیمات.', 'error');
        }
      } catch (err) {
        showGitHubMsg('خطا در ذخیره تنظیمات در سرور.', 'error');
      } finally {
        btnSaveGitHub.disabled = false;
        btnSaveGitHub.innerHTML = '<svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg> ذخیره تنظیمات گیت‌هاب';
      }
    });
  }

  if (btnCommitGitHub) {
    btnCommitGitHub.addEventListener('click', async () => {
      if (!confirm('آیا از ارسال و کامیت تمام تصاویر تایید شده به همراه فایل labels.csv و README.md در ریپازیتوری گیت‌هاب اطمینان دارید؟')) {
        return;
      }

      btnCommitGitHub.disabled = true;
      btnCommitGitHub.innerHTML = '<span class="spinner"></span> در حال بارگذاری و کامیت در گیت‌هاب...';
      showGitHubMsg('در حال بارگذاری تصاویر و ساخت کامیت روی گیت‌هاب، لطفاً منتظر بمانید...', 'info');

      try {
        const res = await fetch('/api/admin/github/sync', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        });
        const data = await res.json();
        if (data.success) {
          const commitLink = data.commitUrl
            ? `<a href="${data.commitUrl}" target="_blank" style="color:var(--primary); font-weight:bold; text-decoration:underline;">[مشاهده کامیت در GitHub ↗]</a>`
            : '';
          if (githubMsg) {
            githubMsg.innerHTML = `✅ کامیت با موفقیت ثبت شد! تعداد ${data.imageCount} تصویر تایید شده روی شاخه «${data.branch}» قرار گرفت. ${commitLink}`;
            githubMsg.className = 'status-msg active success';
          }
          loadStats();
        } else {
          showGitHubMsg(data.error || 'خطا در ارسال به گیت‌هاب.', 'error');
        }
      } catch (err) {
        showGitHubMsg('خطا در ارسال درخواست به سرور.', 'error');
      } finally {
        btnCommitGitHub.disabled = false;
        btnCommitGitHub.innerHTML = '<svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><line x1="1.05" y1="12" x2="7" y2="12"/><line x1="17.01" y1="12" x2="22.96" y2="12"/></svg> 🚀 کامیت کل دیتاست در گیت‌هاب';
      }
    });
  }

  async function loadSync() {
    loadDriveConfig();
    loadGitHubConfig();
    try {
      const res = await fetch('/api/admin/images/unsynced');
      const unsynced = await res.json();

      if (!unsynced || unsynced.length === 0) {
        syncGrid.innerHTML = '';
        syncEmpty.style.display = 'block';
        return;
      }
      syncEmpty.style.display = 'none';
      syncGrid.innerHTML = unsynced.map(img => `
        <div class="image-card" data-id="${img.id}">
          <img src="${imageUrl(img)}" alt="" loading="lazy" onerror="imgFallback(this)">
          <div class="image-card-info">
            <div class="prompt-text">${sheetLabel(img)}</div>
            <div class="meta">
              <div>نویسنده: <strong>${escapeHtml(img.contributor_name || 'ثبت نشده')}</strong> <span style="font-size:0.75rem; color:var(--gray-500);">(${escapeHtml(img.contributor_id || '')})</span></div>
              <div>${formatDate(img.created_at)}</div>
            </div>
            <button class="btn btn-sm btn-primary" style="margin-top:8px;" onclick="event.stopPropagation(); syncSingle(${img.id})">همگام‌سازی</button>
          </div>
        </div>
      `).join('');
    } catch {
      // silent
    }
  }

  btnSyncAll.addEventListener('click', async () => {
    if (!confirm('همه تصاویر تایید شده همگام‌سازی شوند؟')) return;
    btnSyncAll.disabled = true;
    btnSyncAll.textContent = 'در حال همگام‌سازی...';
    try {
      const res = await fetch('/api/admin/images/sync-all', { method: 'POST' });
      const data = await res.json();
      if (data.success) {
        alert(`${data.synced} تصویر همگام‌سازی شد. ${data.failed} خطا.`);
      } else {
        alert('خطا: ' + (data.error || 'نامشخص'));
      }
      loadStats();
      loadSync();
    } catch {
      alert('خطا در همگام‌سازی');
    } finally {
      btnSyncAll.disabled = false;
      btnSyncAll.textContent = 'همگام‌سازی همه تصاویر تایید شده';
    }
  });

  // --- Filters ---
  filterStatus.addEventListener('change', () => {
    currentPage.all = 1;
    selectedAll.clear();
    loadAll();
  });

  // A card no longer shows one prompt: a sheet holds many lines, so it shows what
  // kind of sheet it is and how much of it the admin has already cropped.
  function sheetLabel(img) {
    if (img.sheet_category === 'numbers') return '🔢 برگه اعداد';
    if (img.sheet_category) return '📝 برگه جملات و کلمات';
    return escapeHtml(img.prompt_text || img.custom_text || 'ارسال قدیمی');
  }

  // The card grid is only refetched on tab switch, pagination and approve/reject.
  // Segmenting now happens without leaving the modal, so the cached row for the
  // sheet being worked on has to be updated as crops are saved — otherwise the
  // "برش سطرها" badge keeps showing whatever it said when the grid last loaded.
  function updateCachedSegmentCount(imageId, segmentCount, totalLines) {
    for (const tab of ['pending', 'all']) {
      for (const img of currentImagesMap[tab] || []) {
        if (img.id !== imageId) continue;
        if (typeof segmentCount === 'number') img.segment_count = segmentCount;
        if (typeof totalLines === 'number') img.line_count = totalLines;
        const card = document.querySelector(`.image-card[data-id="${imageId}"]`);
        const badge = card && card.querySelector('.seg-badge');
        if (badge) badge.outerHTML = segmentBadge(img);
      }
    }
  }

  function refreshActiveGrid() {
    const activeTabEl = document.querySelector('.tab.active');
    const activeTab = activeTabEl ? activeTabEl.dataset.tab : 'pending';
    if (activeTab === 'pending') loadPending();
    else if (activeTab === 'all') loadAll();
  }

  function segmentBadge(img) {
    const total = img.line_count || 0;
    const done = img.segment_count || 0;
    if (!total) return '';
    const cls = done >= total ? 'seg-badge complete' : (done > 0 ? 'seg-badge partial' : 'seg-badge none');
    return `<span class="${cls}">برش سطرها: ${done} از ${total}</span>`;
  }

  // --- Helpers ---

  // Build the URL for an image, given that approved files live in uploads/approved
  // and pending/rejected ones in uploads/pending.
  function imageUrl(img) {
    const folder = img.status === 'approved' ? 'approved' : 'pending';
    return `/uploads/${folder}/${encodeURIComponent(img.filename)}`;
  }

  // A status change moves the file between folders; if that move ever failed the DB
  // and disk disagree. Retry once against the other folder before showing a broken
  // image, so review is never blocked by drift.
  window.imgFallback = function(el) {
    if (!el.dataset.fallbackTried) {
      el.dataset.fallbackTried = '1';
      el.src = el.src.includes('/uploads/approved/')
        ? el.src.replace('/uploads/approved/', '/uploads/pending/')
        : el.src.replace('/uploads/pending/', '/uploads/approved/');
      return;
    }
    // Not in either folder: the row outlived its file. Label it, so an orphaned
    // record is obvious instead of showing an unexplained broken-image icon.
    if (el.dataset.missingShown) return;
    el.dataset.missingShown = '1';
    el.removeAttribute('src');
    el.classList.add('img-missing');
    el.insertAdjacentHTML('afterend', '<div class="img-missing-note">فایل تصویر روی سرور یافت نشد</div>');
  };

  function escapeHtml(s) {
    if (s === null || s === undefined) return '';
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function formatDate(s) {
    if (!s) return '—';
    try {
      // Fix ISO parsing for Safari / WebKit by ensuring 'T' separator
      const iso = s.includes('T') ? s : s.replace(' ', 'T') + 'Z';
      return new Date(iso).toLocaleDateString('fa-IR');
    } catch {
      return s;
    }
  }

  function statusLabel(s) {
    const labels = { pending: 'در انتظار', approved: 'تایید شده', rejected: 'رد شده' };
    return labels[s] || s;
  }

  // --- Init ---
  checkAuth();
})();
