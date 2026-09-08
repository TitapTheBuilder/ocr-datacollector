(() => {
  const SENTENCE_GOAL = 20;
  const NUMBER_GOAL = 40;
  const TOTAL_GOAL = SENTENCE_GOAL + NUMBER_GOAL; // 60 total

  // --- Contributor Identity & HMAC Token ---
  let contributorId = localStorage.getItem('contributor_id');
  let contributorName = localStorage.getItem('contributor_name');
  let contributorToken = localStorage.getItem('contributor_token');

  // --- DOM Elements ---
  const contributorBar = document.getElementById('contributorBar');
  const contributorNameDisplay = document.getElementById('contributorNameDisplay');
  const btnChangeName = document.getElementById('btnChangeName');
  const nameModal = document.getElementById('nameModal');
  const nameForm = document.getElementById('nameForm');
  const nameInput = document.getElementById('nameInput');
  const nameError = document.getElementById('nameError');
  const btnSubmitName = document.getElementById('btnSubmitName');

  const statusMsg = document.getElementById('statusMsg');
  const promptCard = document.getElementById('promptCard');
  const promptText = document.getElementById('promptText');
  const promptCategory = document.getElementById('promptCategory');
  const btnNextPrompt = document.getElementById('btnNextPrompt');
  const numberGuidanceReminder = document.getElementById('numberGuidanceReminder');

  const remainingBadge = document.getElementById('remainingBadge');
  const goalProgressFill = document.getElementById('goalProgressFill');
  const goalCountText = document.getElementById('goalCountText');
  const goalPercentText = document.getElementById('goalPercentText');
  const sentenceStagePill = document.getElementById('sentenceStagePill');
  const numberStagePill = document.getElementById('numberStagePill');

  const customTextToggle = document.getElementById('customTextToggle');
  const customTextForm = document.getElementById('customTextForm');
  const customTextInput = document.getElementById('customTextInput');

  const cameraInput = document.getElementById('cameraInput');
  const fileInput = document.getElementById('fileInput');
  const btnPaste = document.getElementById('btnPaste');
  const previewContainer = document.getElementById('previewContainer');
  const previewImg = document.getElementById('previewImg');
  const previewLabelText = document.getElementById('previewLabelText');
  const btnSubmit = document.getElementById('btnSubmit');
  const btnRetake = document.getElementById('btnRetake');
  const statsBar = document.getElementById('statsBar');

  let currentPrompt = null;
  let selectedFile = null;
  let currentObjectUrl = null;
  let customMode = false;
  let currentSentencesCount = 0;
  let currentNumbersCount = 0;
  let currentUploadCount = 0;

  // --- Status Messages (Toasts) ---
  function showStatus(msg, type = 'info') {
    statusMsg.textContent = msg;
    statusMsg.className = 'status-msg active ' + type;
    if (type === 'success') {
      setTimeout(() => { statusMsg.className = 'status-msg'; }, 4000);
    }
  }

  // --- Name Modal & Contributor Identity ---
  function showNameModal(prefill = '') {
    if (nameInput) {
      nameInput.value = prefill || contributorName || '';
    }
    if (nameError) nameError.style.display = 'none';
    if (nameModal) nameModal.style.display = 'flex';
    setTimeout(() => { if (nameInput) nameInput.focus(); }, 100);
  }

  function hideNameModal() {
    if (nameModal) nameModal.style.display = 'none';
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
        loadPrompt();
        loadStats();
        return true;
      } else {
        if (nameError) {
          nameError.textContent = data.error || 'خطا در ثبت نام. لطفاً مجدداً تلاش کنید.';
          nameError.style.display = 'block';
        }
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

  function updateContributorBar() {
    if (contributorName) {
      contributorNameDisplay.textContent = contributorName;
      contributorBar.style.display = 'flex';
    } else {
      contributorBar.style.display = 'none';
    }
  }

  // Handle Name Form Submit
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

  // Handle Edit Name Click
  if (btnChangeName) {
    btnChangeName.addEventListener('click', () => {
      showNameModal(contributorName);
    });
  }

  // Initial check: if no contributor info, show modal
  if (!contributorId || !contributorToken || !contributorName) {
    showNameModal();
  } else {
    updateContributorBar();
    loadPrompt();
    loadStats();
  }

  // --- Goal & Progress Display ---
  function updateGoalProgress(sentencesCount, numbersCount, totalCount) {
    if (typeof sentencesCount === 'number') {
      currentSentencesCount = sentencesCount;
      currentNumbersCount = typeof numbersCount === 'number' ? numbersCount : 0;
      currentUploadCount = typeof totalCount === 'number' ? totalCount : (currentSentencesCount + currentNumbersCount);
    } else if (typeof sentencesCount === 'object' && sentencesCount !== null) {
      currentSentencesCount = sentencesCount.sentencesCount || 0;
      currentNumbersCount = sentencesCount.numbersCount || 0;
      currentUploadCount = sentencesCount.count || (currentSentencesCount + currentNumbersCount);
    } else {
      currentUploadCount = typeof sentencesCount === 'number' ? sentencesCount : 0;
    }

    const totalPercent = Math.min(100, Math.round((currentUploadCount / TOTAL_GOAL) * 100));

    if (goalProgressFill) {
      goalProgressFill.style.width = `${totalPercent}%`;
    }

    if (goalPercentText) {
      goalPercentText.textContent = `${totalPercent}٪`;
    }

    const isSentenceStage = currentSentencesCount < SENTENCE_GOAL;
    const isCompleted = currentSentencesCount >= SENTENCE_GOAL && currentNumbersCount >= NUMBER_GOAL;

    if (remainingBadge) {
      if (isCompleted) {
        remainingBadge.textContent = 'سهمیه کامل تکمیل شد! 🎉';
        remainingBadge.className = 'remaining-badge completed';
      } else if (isSentenceStage) {
        const remainingSentences = Math.max(0, SENTENCE_GOAL - currentSentencesCount);
        remainingBadge.textContent = `${remainingSentences} جمله باقی‌مانده (مرحله ۱)`;
        remainingBadge.className = 'remaining-badge';
        remainingBadge.style.background = '#eff6ff';
        remainingBadge.style.color = '#1d4ed8';
        remainingBadge.style.borderColor = '#bfdbfe';
      } else {
        const remainingNumbers = Math.max(0, NUMBER_GOAL - currentNumbersCount);
        remainingBadge.textContent = `${remainingNumbers} عدد باقی‌مانده (مرحله ۲)`;
        remainingBadge.className = 'remaining-badge';
        remainingBadge.style.background = '#fef3c7';
        remainingBadge.style.color = '#92400e';
        remainingBadge.style.borderColor = '#fde68a';
      }
    }

    if (goalCountText) {
      if (isCompleted) {
        goalCountText.textContent = `کل سهمیه (${TOTAL_GOAL} مورد: ۲۰ جمله و ۴۰ عدد) تکمیل شد!`;
      } else if (isSentenceStage) {
        goalCountText.textContent = `مرحله ۱: ${currentSentencesCount} از ${SENTENCE_GOAL} جمله (سپس ۴۰ عدد)`;
      } else {
        goalCountText.textContent = `مرحله ۲: ${currentNumbersCount} از ${NUMBER_GOAL} عدد (۲۰ جمله تکمیل شده)`;
      }
    }

    if (sentenceStagePill) {
      if (currentSentencesCount >= SENTENCE_GOAL) {
        sentenceStagePill.innerHTML = `✅ مرحله ۱: جملات (${SENTENCE_GOAL} از ${SENTENCE_GOAL} تکمیل شد)`;
        sentenceStagePill.style.background = '#dcfce7';
        sentenceStagePill.style.color = '#166534';
        sentenceStagePill.style.borderColor = '#bbf7d0';
      } else {
        sentenceStagePill.innerHTML = `📝 مرحله ۱: جملات (${currentSentencesCount} از ${SENTENCE_GOAL}) ◀`;
        sentenceStagePill.style.background = '#eff6ff';
        sentenceStagePill.style.color = '#1d4ed8';
        sentenceStagePill.style.borderColor = '#bfdbfe';
      }
    }

    if (numberStagePill) {
      if (currentNumbersCount >= NUMBER_GOAL) {
        numberStagePill.innerHTML = `✅ مرحله ۲: اعداد (${NUMBER_GOAL} از ${NUMBER_GOAL} تکمیل شد)`;
        numberStagePill.style.background = '#dcfce7';
        numberStagePill.style.color = '#166534';
        numberStagePill.style.borderColor = '#bbf7d0';
      } else if (!isSentenceStage) {
        numberStagePill.innerHTML = `🔢 مرحله ۲: اعداد (${currentNumbersCount} از ${NUMBER_GOAL}) ◀`;
        numberStagePill.style.background = '#fef3c7';
        numberStagePill.style.color = '#92400e';
        numberStagePill.style.borderColor = '#fde68a';
      } else {
        numberStagePill.innerHTML = `🔢 مرحله ۲: اعداد (۰ از ${NUMBER_GOAL}) [بعد از جملات]`;
        numberStagePill.style.background = '#f3f4f6';
        numberStagePill.style.color = '#6b7280';
        numberStagePill.style.borderColor = '#e5e7eb';
      }
    }

    if (statsBar) {
      statsBar.textContent = `مجموع ارسالی‌های شما: ${currentUploadCount} تصویر (${currentSentencesCount} جمله + ${currentNumbersCount} عدد)`;
    }

    // Dynamic placeholder for custom text input according to active stage
    if (customTextInput) {
      if (!isSentenceStage) {
        customTextInput.placeholder = 'عدد مورد نظر خود را با ارقام فارسی بنویسید (مثال: ۴۸۱۵)...';
      } else {
        customTextInput.placeholder = 'متن دست‌نویس دلخواه خود را اینجا بنویسید...';
      }
    }
  }

  // --- Load Stats ---
  async function loadStats() {
    if (!contributorId || !contributorToken) return;
    try {
      const res = await fetch(`/api/contributors/${encodeURIComponent(contributorId)}/count`, {
        headers: { 'X-Contributor-Token': contributorToken },
      });
      const data = await res.json();
      if (data.count !== undefined) {
        updateGoalProgress(data.sentencesCount || 0, data.numbersCount || 0, data.count);
      }
    } catch {
      // silent
    }
  }

  // --- Load Prompt ---
  async function loadPrompt() {
    if (!contributorId) return;
    try {
      promptText.textContent = 'در حال بارگذاری...';
      const headers = contributorToken ? { 'X-Contributor-Token': contributorToken } : {};
      const res = await fetch(`/api/prompts/next?contributor_id=${encodeURIComponent(contributorId || '')}`, { headers });
      if (!res.ok) {
        const data = await res.json();
        currentPrompt = null;
        promptText.textContent = data.error || 'متنی برای نمایش موجود نیست.';
        promptCategory.textContent = '';
        promptCategory.style.display = 'none';
        if (numberGuidanceReminder) numberGuidanceReminder.style.display = 'none';
        updatePreviewLabel();
        return;
      }
      currentPrompt = await res.json();
      promptText.textContent = currentPrompt.text;
      promptCategory.style.display = 'inline-block';

      if (currentPrompt.category === 'numbers') {
        promptCategory.textContent = 'عدد';
        promptCategory.style.background = '#fef3c7';
        promptCategory.style.color = '#92400e';
        if (numberGuidanceReminder) numberGuidanceReminder.style.display = 'flex';
      } else {
        const categoryLabels = {
          words: 'کلمه',
          sentences: 'جمله',
          custom: 'سفارشی',
        };
        promptCategory.textContent = categoryLabels[currentPrompt.category] || 'جمله';
        promptCategory.style.background = '#eff6ff';
        promptCategory.style.color = '#1d4ed8';
        if (numberGuidanceReminder) numberGuidanceReminder.style.display = 'none';
      }
      updatePreviewLabel();
    } catch {
      promptText.textContent = 'خطا در بارگذاری متن';
      if (numberGuidanceReminder) numberGuidanceReminder.style.display = 'none';
      updatePreviewLabel();
    }
  }

  // Next prompt button
  if (btnNextPrompt) {
    btnNextPrompt.addEventListener('click', () => {
      loadPrompt();
    });
  }

  // Custom text toggle
  if (customTextToggle) {
    customTextToggle.addEventListener('click', () => {
      customMode = !customMode;
      customTextForm.classList.toggle('active', customMode);
      customTextToggle.textContent = customMode
        ? '📋 بازگشت به متن پیشنهادی سامانه'
        : '✏️ نوشتن متن دلخواه به جای متن پیشنهادی';
      promptCard.style.opacity = customMode ? '0.45' : '1';
      updatePreviewLabel();
      if (customMode) {
        customTextInput.focus();
      }
    });
  }

  if (customTextInput) {
    customTextInput.addEventListener('input', () => {
      updatePreviewLabel();
    });
  }

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

  // --- Client-Side Photo Compression ---
  function compressImage(file, maxDimension = 1600, quality = 0.88) {
    return new Promise((resolve) => {
      if (file.size <= 200 * 1024) {
        return resolve(file);
      }

      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => {
        URL.revokeObjectURL(url);
        let { width, height } = img;

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

  // --- File Selection & Preview ---
  async function handleFile(file) {
    if (!file) return;

    const allowed = ['image/jpeg', 'image/jpg', 'image/pjpeg', 'image/png', 'image/webp'];
    if (!allowed.includes(file.type)) {
      showStatus('فقط فایل‌های تصویری JPEG، PNG و WebP مجاز هستند.', 'error');
      return;
    }

    if (file.size > 20 * 1024 * 1024) {
      showStatus('حجم تصویر بیش از حد مجاز است (حداکثر ۲۰ مگابایت).', 'error');
      return;
    }

    try {
      showStatus('در حال بهینه‌سازی تصویر...', 'info');
      selectedFile = await compressImage(file);
      statusMsg.className = 'status-msg'; // clear toast
    } catch {
      selectedFile = file;
    }

    if (currentObjectUrl) {
      URL.revokeObjectURL(currentObjectUrl);
    }
    currentObjectUrl = URL.createObjectURL(selectedFile);
    previewImg.src = currentObjectUrl;
    updatePreviewLabel();
    previewContainer.classList.add('active');
    previewContainer.scrollIntoView({ behavior: 'smooth', block: 'center' });
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

  // Clipboard Paste Support
  if (btnPaste) {
    btnPaste.addEventListener('click', async () => {
      try {
        const clipboardItems = await navigator.clipboard.read();
        for (const item of clipboardItems) {
          const imgType = item.types.find(t => t.startsWith('image/'));
          if (imgType) {
            const blob = await item.getType(imgType);
            const file = new File([blob], `paste_${Date.now()}.png`, { type: imgType });
            handleFile(file);
            return;
          }
        }
        showStatus('تصویری در کلیپ‌بورد یافت نشد. لطفاً ابتدا عکس را کپی کنید.', 'error');
      } catch (err) {
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

  // Retake / Cancel Preview
  if (btnRetake) {
    btnRetake.addEventListener('click', () => {
      selectedFile = null;
      if (currentObjectUrl) URL.revokeObjectURL(currentObjectUrl);
      currentObjectUrl = null;
      previewContainer.classList.remove('active');
      if (cameraInput) cameraInput.value = '';
      if (fileInput) fileInput.value = '';
    });
  }

  // --- Submit Image ---
  if (btnSubmit) {
    btnSubmit.addEventListener('click', async () => {
      if (!selectedFile) {
        showStatus('لطفاً ابتدا یک تصویر انتخاب کنید.', 'error');
        return;
      }

      if (!contributorId || !contributorToken) {
        showNameModal();
        return;
      }

      let promptId = null;
      let customText = null;

      if (customMode) {
        customText = customTextInput.value.trim();
        if (!customText) {
          showStatus('لطفاً متن دست‌نویس دلخواه خود را وارد کنید.', 'error');
          customTextInput.focus();
          return;
        }
        if (!/[\u0600-\u06FF]/.test(customText)) {
          showStatus('متن یا عدد دلخواه باید با حروف یا ارقام فارسی باشد.', 'error');
          customTextInput.focus();
          return;
        }
      } else {
        if (!currentPrompt) {
          showStatus('متن پیشنهادی فعالی وجود ندارد. لطفاً متن دیگر را بزنید یا از گزینه «متن دلخواه» استفاده کنید.', 'error');
          return;
        }
        promptId = currentPrompt.id;
      }

      btnSubmit.disabled = true;
      btnSubmit.innerHTML = '<span class="spinner"></span> در حال ارسال و پردازش...';

      try {
        const formData = new FormData();
        formData.append('contributor_id', contributorId);
        formData.append('contributor_name', contributorName || '');
        if (contributorToken) formData.append('contributor_token', contributorToken);
        const hpVal = document.getElementById('hpWebsite')?.value || '';
        if (hpVal) formData.append('hp_website', hpVal);
        if (promptId) formData.append('prompt_id', promptId);
        if (customText) formData.append('custom_text', customText);
        formData.append('image', selectedFile);

        const res = await fetch('/api/images', {
          method: 'POST',
          headers: contributorToken ? { 'X-Contributor-Token': contributorToken } : {},
          body: formData,
        });
        const data = await res.json();

        if (data.success) {
          const wasSentenceStage = currentSentencesCount < SENTENCE_GOAL;
          await loadStats();
          const nowSentenceStage = currentSentencesCount < SENTENCE_GOAL;

          if (wasSentenceStage && !nowSentenceStage) {
            // Milestone: Finished 20 sentences!
            showStatus('🎉 تبریک! مرحله ۲۰ جمله تکمیل شد. اکنون وارد مرحله نگارش ۴۰ عدد شدید. لطفاً اعداد را حتماً به فارسی بنویسید.', 'success');
          } else if (currentSentencesCount >= SENTENCE_GOAL && currentNumbersCount >= NUMBER_GOAL) {
            // Finished full quota!
            showStatus('تبریک و سپاس فراوان! سهمیه کامل شما (۲۰ جمله و ۴۰ عدد) با موفقیت تکمیل شد 🎉', 'success');
          } else if (nowSentenceStage) {
            const rem = Math.max(0, SENTENCE_GOAL - currentSentencesCount);
            showStatus(`دست‌نوشته با موفقیت ثبت شد! ${rem} جمله دیگر تا شروع مرحله اعداد باقی‌مانده است.`, 'success');
          } else {
            const rem = Math.max(0, NUMBER_GOAL - currentNumbersCount);
            showStatus(`عدد با موفقیت ثبت شد! ${rem} عدد دیگر باقی‌مانده است (حتماً با ارقام فارسی).`, 'success');
          }

          // Reset preview
          selectedFile = null;
          if (currentObjectUrl) URL.revokeObjectURL(currentObjectUrl);
          currentObjectUrl = null;
          previewContainer.classList.remove('active');
          if (cameraInput) cameraInput.value = '';
          if (fileInput) fileInput.value = '';

          // Reset custom text if active
          if (customMode) {
            customTextInput.value = '';
            updatePreviewLabel();
          }
          loadPrompt();
        } else {
          showStatus(data.error || 'خطا در ارسال تصویر.', 'error');
        }
      } catch (err) {
        console.error('Upload error:', err);
        showStatus('خطا در برقراری ارتباط با سرور.', 'error');
      } finally {
        btnSubmit.disabled = false;
        btnSubmit.innerHTML = `
          <svg width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg>
          تایید و ارسال تصویر
        `;
      }
    });
  }
})();
