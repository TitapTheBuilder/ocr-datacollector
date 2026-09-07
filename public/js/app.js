(() => {
  // --- Safe UUID Generator for HTTP / Mobile contexts ---
  function generateUUID() {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
      const r = (Math.random() * 16) | 0;
      const v = c === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  // --- Contributor ID ---
  let contributorId = localStorage.getItem('contributor_id');
  if (!contributorId) {
    contributorId = generateUUID();
    localStorage.setItem('contributor_id', contributorId);
  }

  // Always register contributor (safe idempotent call)
  fetch('/api/contributors', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: contributorId }),
  }).catch(() => {});

  // --- Elements ---
  const promptText = document.getElementById('promptText');
  const promptCategory = document.getElementById('promptCategory');
  const btnNextPrompt = document.getElementById('btnNextPrompt');
  const cameraInput = document.getElementById('cameraInput');
  const fileInput = document.getElementById('fileInput');
  const btnPaste = document.getElementById('btnPaste');
  const previewContainer = document.getElementById('previewContainer');
  const previewImg = document.getElementById('previewImg');
  const previewLabelText = document.getElementById('previewLabelText');
  const btnSubmit = document.getElementById('btnSubmit');
  const btnRetake = document.getElementById('btnRetake');
  const statusMsg = document.getElementById('statusMsg');
  const customTextToggle = document.getElementById('customTextToggle');
  const customTextForm = document.getElementById('customTextForm');
  const customTextInput = document.getElementById('customTextInput');
  const statsBar = document.getElementById('statsBar');

  let currentPrompt = null;
  let selectedFile = null;
  let currentObjectUrl = null;
  let customMode = false;

  // --- Status messages ---
  function showStatus(msg, type) {
    statusMsg.textContent = msg;
    statusMsg.className = 'status-msg active ' + type;
    if (type === 'success') {
      setTimeout(() => { statusMsg.className = 'status-msg'; }, 3000);
    }
  }

  // --- Load prompt ---
  async function loadPrompt() {
    try {
      promptText.textContent = 'در حال بارگذاری متن...';
      const res = await fetch(`/api/prompts/next?contributor_id=${contributorId}`);
      if (!res.ok) {
        const data = await res.json();
        currentPrompt = null;
        promptText.textContent = data.error || 'متنی برای نمایش موجود نیست.';
        promptCategory.textContent = '';
        promptCategory.style.display = 'none';
        updatePreviewLabel();
        return;
      }
      currentPrompt = await res.json();
      promptText.textContent = currentPrompt.text;
      promptCategory.style.display = 'inline-block';

      const categoryLabels = {
        numbers: 'عدد',
        words: 'کلمه',
        sentences: 'جمله',
        custom: 'سفارشی',
      };
      promptCategory.textContent = categoryLabels[currentPrompt.category] || currentPrompt.category;
      updatePreviewLabel();
    } catch {
      promptText.textContent = 'خطا در بارگذاری متن';
      updatePreviewLabel();
    }
  }

  // --- Load contributor stats ---
  async function loadStats() {
    try {
      const res = await fetch(`/api/contributors/${contributorId}/count`);
      const data = await res.json();
      statsBar.textContent = `شما تاکنون ${data.count} تصویر ارسال کرده‌اید`;
    } catch {
      // silent
    }
  }

  // --- Update Preview Text Label ---
  function updatePreviewLabel() {
    if (!previewLabelText) return;
    if (customMode) {
      const text = customTextInput.value.trim();
      previewLabelText.textContent = text ? `«${text}» (متن دلخواه)` : '(متن دلخواهی تایپ نشده است)';
      previewLabelText.style.color = text ? 'var(--gray-900)' : 'var(--danger)';
    } else if (currentPrompt) {
      previewLabelText.textContent = `«${currentPrompt.text}»`;
      previewLabelText.style.color = 'var(--gray-900)';
    } else {
      previewLabelText.textContent = '(متنی برای برچسب انتخاب نشده است)';
      previewLabelText.style.color = 'var(--danger)';
    }
  }

  // --- Handle file selection ---
  // --- Client-Side Image Compression ---
  // Compresses phone camera photos (e.g. 5-15MB) to ~200KB before uploading to save storage & bandwidth
  function compressImage(file, maxDimension = 1600, quality = 0.85) {
    return new Promise((resolve) => {
      if (file.size <= 150 * 1024) {
        return resolve(file);
      }

      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => {
        URL.revokeObjectURL(url);
        let width = img.width;
        let height = img.height;

        if (width > maxDimension || height > maxDimension) {
          if (width > height) {
            height = Math.round((height * maxDimension) / width);
            width = maxDimension;
          } else {
            width = Math.round((width * maxDimension) / height);
            height = maxDimension;
          }
        }

        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, width, height);
        ctx.drawImage(img, 0, 0, width, height);

        canvas.toBlob((blob) => {
          if (blob && blob.size < file.size) {
            const compressedFile = new File([blob], file.name.replace(/\.[^/.]+$/, "") + ".jpg", {
              type: 'image/jpeg',
              lastModified: Date.now(),
            });
            resolve(compressedFile);
          } else {
            resolve(file);
          }
        }, 'image/jpeg', quality);
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        resolve(file);
      };
      img.src = url;
    });
  }

  async function handleFile(file) {
    if (!file) return;

    const allowed = ['image/jpeg', 'image/jpg', 'image/pjpeg', 'image/png', 'image/webp'];
    if (!allowed.includes(file.type)) {
      showStatus('فقط فایل‌های تصویری JPEG، PNG و WebP مجاز هستند.', 'error');
      return;
    }

    showStatus('در حال آماده‌سازی و بهینه‌سازی تصویر...', 'info');
    const processedFile = await compressImage(file);

    if (processedFile.size > 2 * 1024 * 1024) {
      showStatus('حجم فایل بیش از ۲ مگابایت است. لطفاً تصویر کوچک‌تری انتخاب کنید.', 'error');
      return;
    }

    if (currentObjectUrl) {
      URL.revokeObjectURL(currentObjectUrl);
    }

    selectedFile = processedFile;
    currentObjectUrl = URL.createObjectURL(processedFile);
    previewImg.src = currentObjectUrl;
    updatePreviewLabel();
    previewContainer.classList.add('active');
    statusMsg.className = 'status-msg';
  }

  cameraInput.addEventListener('change', () => handleFile(cameraInput.files[0]));
  fileInput.addEventListener('change', () => handleFile(fileInput.files[0]));

  // --- Clipboard Paste Support ---
  function handlePastedFile(file) {
    if (!file) return;
    handleFile(file);
    showStatus('تصویر با موفقیت از کلیپ‌بورد دریافت شد.', 'info');
  }

  window.addEventListener('paste', (e) => {
    const items = e.clipboardData?.items;
    if (!items) return;

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.type.startsWith('image/')) {
        const file = item.getAsFile();
        if (file) {
          e.preventDefault();
          handlePastedFile(file);
          return;
        }
      }
    }
  });

  if (btnPaste) {
    btnPaste.addEventListener('click', async () => {
      if (navigator.clipboard && navigator.clipboard.read) {
        try {
          const clipboardItems = await navigator.clipboard.read();
          for (const item of clipboardItems) {
            const imageType = item.types.find(type => type.startsWith('image/'));
            if (imageType) {
              const blob = await item.getType(imageType);
              const ext = imageType === 'image/png' ? 'png' : imageType === 'image/webp' ? 'webp' : 'jpg';
              const file = new File([blob], `clipboard_${Date.now()}.${ext}`, { type: imageType });
              handlePastedFile(file);
              return;
            }
          }
          showStatus('تصویری در کلیپ‌بورد یافت نشد. لطفاً ابتدا یک تصویر را کپی کنید یا کلیدهای Ctrl+V را بزنید.', 'error');
        } catch {
          showStatus('برای الصاق تصویر، کلیدهای Ctrl+V را در صفحه فشار دهید.', 'info');
        }
      } else {
        showStatus('برای الصاق تصویر، کلیدهای Ctrl+V را در صفحه فشار دهید.', 'info');
      }
    });
  }

  // --- Submit Upload ---
  btnSubmit.addEventListener('click', async () => {
    if (!selectedFile) {
      showStatus('لطفاً ابتدا یک تصویر انتخاب کنید یا عکس بگیرید.', 'error');
      return;
    }

    let promptId = null;
    let customText = null;

    if (customMode) {
      customText = customTextInput.value.trim();
      if (!customText) {
        showStatus('لطفاً ابتدا متن دست‌نویس خود را تایپ کنید.', 'error');
        customTextInput.focus();
        return;
      }
    } else {
      if (!currentPrompt) {
        showStatus('متن پیشنهادی فعالی وجود ندارد. لطفاً از گزینه «متن دلخواه» استفاده کنید.', 'error');
        return;
      }
      promptId = currentPrompt.id;
    }

    btnSubmit.disabled = true;
    btnSubmit.innerHTML = '<span class="spinner"></span> در حال ارسال...';

    try {
      const formData = new FormData();
      // CRITICAL: Append metadata BEFORE file so Multer parses contributor_id before file streaming
      formData.append('contributor_id', contributorId);
      const hpVal = document.getElementById('hpWebsite')?.value || '';
      if (hpVal) formData.append('hp_website', hpVal);
      if (promptId) formData.append('prompt_id', promptId);
      if (customText) formData.append('custom_text', customText);
      formData.append('image', selectedFile);

      const res = await fetch('/api/images', { method: 'POST', body: formData });
      const data = await res.json();

      if (data.success) {
        showStatus('تصویر شما با موفقیت ثبت شد! متشکریم.', 'success');
        resetCapture();
        if (customMode) {
          customTextInput.value = '';
          updatePreviewLabel();
        } else {
          loadPrompt();
        }
        loadStats();
      } else {
        showStatus(data.error || 'خطا در ارسال تصویر', 'error');
      }
    } catch {
      showStatus('خطا در ارسال تصویر به سرور. لطفاً اتصال اینترنت را بررسی کنید.', 'error');
    } finally {
      btnSubmit.disabled = false;
      btnSubmit.innerHTML = '<svg width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg> تایید و ارسال';
    }
  });

  // --- Reset ---
  function resetCapture() {
    selectedFile = null;
    if (currentObjectUrl) {
      URL.revokeObjectURL(currentObjectUrl);
      currentObjectUrl = null;
    }
    previewContainer.classList.remove('active');
    previewImg.src = '';
    cameraInput.value = '';
    fileInput.value = '';
  }

  btnRetake.addEventListener('click', resetCapture);

  // --- Whiteboard & Mode Switching ---
  const tabModeWhiteboard = document.getElementById('tabModeWhiteboard');
  const tabModeUpload = document.getElementById('tabModeUpload');
  const whiteboardSection = document.getElementById('whiteboardSection');
  const uploadSection = document.getElementById('uploadSection');
  const whiteboardCanvas = document.getElementById('whiteboardCanvas');
  const canvasPlaceholder = document.getElementById('canvasPlaceholder');
  const toolPen = document.getElementById('toolPen');
  const toolEraser = document.getElementById('toolEraser');
  const btnUndo = document.getElementById('btnUndo');
  const btnClear = document.getElementById('btnClear');
  const btnSubmitWhiteboard = document.getElementById('btnSubmitWhiteboard');
  const widthBtns = document.querySelectorAll('.width-btn');
  const colorBtns = document.querySelectorAll('.color-btn');

  // Mode switching
  function switchMode(mode) {
    if (mode === 'whiteboard') {
      tabModeWhiteboard.classList.add('active');
      tabModeUpload.classList.remove('active');
      whiteboardSection.style.display = 'block';
      uploadSection.style.display = 'none';
      initCanvasSize();
    } else {
      tabModeUpload.classList.add('active');
      tabModeWhiteboard.classList.remove('active');
      uploadSection.style.display = 'block';
      whiteboardSection.style.display = 'none';
    }
  }

  tabModeWhiteboard.addEventListener('click', () => switchMode('whiteboard'));
  tabModeUpload.addEventListener('click', () => switchMode('upload'));

  // Canvas state
  let ctx = null;
  let dpr = window.devicePixelRatio || 1;
  let isDrawing = false;
  let strokes = []; // Array of { tool, color, width, points: [{x, y}] }
  let currentStroke = null;
  let currentTool = 'pen'; // 'pen' | 'eraser'
  let currentWidth = 6;
  let currentColor = '#111827';
  let cssWidth = 0;
  let cssHeight = 280;

  function initCanvasSize() {
    if (!whiteboardCanvas) return;
    const rect = whiteboardCanvas.getBoundingClientRect();
    const newCssWidth = Math.floor(rect.width) || whiteboardCanvas.parentElement.clientWidth || 500;
    cssHeight = 280;

    // Only reinitialize if size actually changed or first load
    if (newCssWidth !== cssWidth || !ctx) {
      cssWidth = newCssWidth;
      dpr = window.devicePixelRatio || 1;
      whiteboardCanvas.width = Math.floor(cssWidth * dpr);
      whiteboardCanvas.height = Math.floor(cssHeight * dpr);
      ctx = whiteboardCanvas.getContext('2d');
      redrawAll();
    }
  }

  function redrawAll() {
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    // Fill clean white background
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, whiteboardCanvas.width, whiteboardCanvas.height);

    // Apply scale for High-DPI
    ctx.scale(dpr, dpr);

    // Draw all strokes
    for (const stroke of strokes) {
      drawStroke(stroke);
    }

    // Toggle placeholder
    if (strokes.length === 0 && !isDrawing) {
      canvasPlaceholder.classList.remove('hidden');
    } else {
      canvasPlaceholder.classList.add('hidden');
    }
  }

  function drawStroke(stroke) {
    if (!stroke.points || stroke.points.length === 0) return;

    ctx.save();
    ctx.beginPath();
    ctx.strokeStyle = stroke.tool === 'eraser' ? '#ffffff' : stroke.color;
    ctx.lineWidth = stroke.tool === 'eraser' ? stroke.width * 2.5 : stroke.width;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    const pts = stroke.points;
    if (pts.length === 1) {
      ctx.arc(pts[0].x, pts[0].y, (ctx.lineWidth) / 2, 0, Math.PI * 2);
      ctx.fillStyle = ctx.strokeStyle;
      ctx.fill();
    } else if (pts.length === 2) {
      ctx.moveTo(pts[0].x, pts[0].y);
      ctx.lineTo(pts[1].x, pts[1].y);
      ctx.stroke();
    } else {
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length - 1; i++) {
        const xc = (pts[i].x + pts[i + 1].x) / 2;
        const yc = (pts[i].y + pts[i + 1].y) / 2;
        ctx.quadraticCurveTo(pts[i].x, pts[i].y, xc, yc);
      }
      ctx.lineTo(pts[pts.length - 1].x, pts[pts.length - 1].y);
      ctx.stroke();
    }
    ctx.restore();
  }

  function getCanvasCoords(e) {
    const rect = whiteboardCanvas.getBoundingClientRect();
    return {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
    };
  }

  // Pointer event listeners
  whiteboardCanvas.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    whiteboardCanvas.setPointerCapture(e.pointerId);
    isDrawing = true;
    const pt = getCanvasCoords(e);
    currentStroke = {
      tool: currentTool,
      color: currentColor,
      width: currentWidth,
      points: [pt],
    };
    strokes.push(currentStroke);
    canvasPlaceholder.classList.add('hidden');
    redrawAll();
  });

  whiteboardCanvas.addEventListener('pointermove', (e) => {
    if (!isDrawing || !currentStroke) return;
    e.preventDefault();
    const pt = getCanvasCoords(e);
    currentStroke.points.push(pt);
    redrawAll();
  });

  function endDrawing(e) {
    if (!isDrawing) return;
    isDrawing = false;
    currentStroke = null;
    try {
      whiteboardCanvas.releasePointerCapture(e.pointerId);
    } catch {}
    redrawAll();
  }

  whiteboardCanvas.addEventListener('pointerup', endDrawing);
  whiteboardCanvas.addEventListener('pointercancel', endDrawing);

  // Tool buttons
  toolPen.addEventListener('click', () => {
    currentTool = 'pen';
    toolPen.classList.add('active');
    toolEraser.classList.remove('active');
  });

  toolEraser.addEventListener('click', () => {
    currentTool = 'eraser';
    toolEraser.classList.add('active');
    toolPen.classList.remove('active');
  });

  // Width buttons
  widthBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      widthBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentWidth = parseInt(btn.dataset.width, 10) || 6;
    });
  });

  // Color buttons
  colorBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      colorBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentColor = btn.dataset.color || '#111827';
      currentTool = 'pen';
      toolPen.classList.add('active');
      toolEraser.classList.remove('active');
    });
  });

  // Undo button
  btnUndo.addEventListener('click', () => {
    if (strokes.length > 0) {
      strokes.pop();
      redrawAll();
    }
  });

  // Clear button
  btnClear.addEventListener('click', () => {
    strokes = [];
    redrawAll();
  });

  // Resize listener
  window.addEventListener('resize', () => {
    initCanvasSize();
  });

  // Submit from whiteboard
  btnSubmitWhiteboard.addEventListener('click', async () => {
    if (strokes.length === 0) {
      showStatus('لطفاً ابتدا متنی روی تخته بنویسید.', 'error');
      return;
    }

    let promptId = null;
    let customText = null;

    if (customMode) {
      customText = customTextInput.value.trim();
      if (!customText) {
        showStatus('لطفاً ابتدا متن دست‌نویس خود را تایپ کنید.', 'error');
        customTextInput.focus();
        return;
      }
    } else {
      if (!currentPrompt) {
        showStatus('متن پیشنهادی فعالی وجود ندارد. لطفاً از گزینه «متن دلخواه» استفاده کنید.', 'error');
        return;
      }
      promptId = currentPrompt.id;
    }

    btnSubmitWhiteboard.disabled = true;
    btnSubmitWhiteboard.innerHTML = '<span class="spinner"></span> در حال ارسال...';

    // Convert canvas to JPEG blob
    whiteboardCanvas.toBlob(async (blob) => {
      if (!blob) {
        showStatus('خطا در تبدیل تصویر تخته.', 'error');
        btnSubmitWhiteboard.disabled = false;
        btnSubmitWhiteboard.innerHTML = '<svg width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg> تایید و ارسال دست‌نویس';
        return;
      }

      try {
        const formData = new FormData();
        formData.append('contributor_id', contributorId);
        const hpVal = document.getElementById('hpWebsite')?.value || '';
        if (hpVal) formData.append('hp_website', hpVal);
        if (promptId) formData.append('prompt_id', promptId);
        if (customText) formData.append('custom_text', customText);
        formData.append('image', blob, `whiteboard_${Date.now()}.jpg`);

        const res = await fetch('/api/images', { method: 'POST', body: formData });
        const data = await res.json();

        if (data.success) {
          showStatus('دست‌نوشته شما با موفقیت ثبت شد! متشکریم.', 'success');
          // Clear whiteboard for next entry
          strokes = [];
          redrawAll();

          if (customMode) {
            customTextInput.value = '';
            updatePreviewLabel();
          } else {
            loadPrompt();
          }
          loadStats();
        } else {
          showStatus(data.error || 'خطا در ارسال دست‌نوشته', 'error');
        }
      } catch {
        showStatus('خطا در ارسال دست‌نوشته به سرور. لطفاً اتصال اینترنت را بررسی کنید.', 'error');
      } finally {
        btnSubmitWhiteboard.disabled = false;
        btnSubmitWhiteboard.innerHTML = '<svg width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg> تایید و ارسال دست‌نویس';
      }
    }, 'image/jpeg', 0.92);
  });

  // --- Custom Text Toggle ---
  customTextToggle.addEventListener('click', () => {
    customMode = !customMode;
    customTextForm.classList.toggle('active', customMode);
    if (customMode) {
      customTextToggle.textContent = '↩️ بازگشت به متن پیشنهادی سیستم';
      customTextInput.focus();
    } else {
      customTextToggle.textContent = '✏️ نوشتن متن دلخواه به جای متن پیشنهادی';
      customTextInput.value = '';
    }
    updatePreviewLabel();
  });

  customTextInput.addEventListener('input', updatePreviewLabel);

  if (btnNextPrompt) {
    btnNextPrompt.addEventListener('click', () => {
      loadPrompt();
    });
  }

  // --- Init ---
  loadPrompt();
  loadStats();
  initCanvasSize();
})();
