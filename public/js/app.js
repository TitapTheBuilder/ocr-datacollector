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
  function handleFile(file) {
    if (!file) return;

    const allowed = ['image/jpeg', 'image/jpg', 'image/pjpeg', 'image/png', 'image/webp'];
    if (!allowed.includes(file.type)) {
      showStatus('فقط فایل‌های تصویری JPEG، PNG و WebP مجاز هستند.', 'error');
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      showStatus('حجم فایل نباید بیشتر از ۱۰ مگابایت باشد.', 'error');
      return;
    }

    if (currentObjectUrl) {
      URL.revokeObjectURL(currentObjectUrl);
    }

    selectedFile = file;
    currentObjectUrl = URL.createObjectURL(file);
    previewImg.src = currentObjectUrl;
    updatePreviewLabel();
    previewContainer.classList.add('active');
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
})();
