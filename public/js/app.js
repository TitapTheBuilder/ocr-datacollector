(() => {
  // --- Contributor ID ---
  let contributorId = localStorage.getItem('contributor_id');
  if (!contributorId) {
    contributorId = crypto.randomUUID();
    localStorage.setItem('contributor_id', contributorId);
    fetch('/api/contributors', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: contributorId }),
    });
  }

  // --- Elements ---
  const promptText = document.getElementById('promptText');
  const promptCategory = document.getElementById('promptCategory');
  const cameraInput = document.getElementById('cameraInput');
  const fileInput = document.getElementById('fileInput');
  const previewContainer = document.getElementById('previewContainer');
  const previewImg = document.getElementById('previewImg');
  const btnSubmit = document.getElementById('btnSubmit');
  const btnRetake = document.getElementById('btnRetake');
  const statusMsg = document.getElementById('statusMsg');
  const customTextToggle = document.getElementById('customTextToggle');
  const customTextForm = document.getElementById('customTextForm');
  const customTextInput = document.getElementById('customTextInput');
  const btnCustomSubmit = document.getElementById('btnCustomSubmit');
  const statsBar = document.getElementById('statsBar');

  let currentPrompt = null;
  let selectedFile = null;
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
      const res = await fetch(`/api/prompts/next?contributor_id=${contributorId}`);
      if (!res.ok) {
        const data = await res.json();
        promptText.textContent = data.error || 'متنی موجود نیست';
        promptCategory.textContent = '';
        promptCategory.style.display = 'none';
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
    } catch {
      promptText.textContent = 'خطا در بارگذاری متن';
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

  // --- Handle file selection ---
  function handleFile(file) {
    if (!file) return;

    const allowed = ['image/jpeg', 'image/png', 'image/webp'];
    if (!allowed.includes(file.type)) {
      showStatus('فقط فایل‌های JPEG، PNG و WebP مجاز هستند.', 'error');
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      showStatus('حجم فایل نباید بیشتر از ۱۰ مگابایت باشد.', 'error');
      return;
    }

    selectedFile = file;
    const url = URL.createObjectURL(file);
    previewImg.src = url;
    previewContainer.classList.add('active');
    customTextForm.classList.remove('active');
    customMode = false;
  }

  cameraInput.addEventListener('change', () => handleFile(cameraInput.files[0]));
  fileInput.addEventListener('change', () => handleFile(fileInput.files[0]));

  // --- Upload ---
  async function uploadImage(promptId, customText) {
    if (!selectedFile) return;

    btnSubmit.disabled = true;
    btnSubmit.innerHTML = '<span class="spinner"></span>';

    try {
      const formData = new FormData();
      formData.append('image', selectedFile);
      formData.append('contributor_id', contributorId);
      if (promptId) formData.append('prompt_id', promptId);
      if (customText) formData.append('custom_text', customText);

      const res = await fetch('/api/images', { method: 'POST', body: formData });
      const data = await res.json();

      if (data.success) {
        showStatus('تصویر شما ثبت شد! متشکریم', 'success');
        resetCapture();
        loadPrompt();
        loadStats();
      } else {
        showStatus(data.error || 'خطا در ارسال تصویر', 'error');
      }
    } catch {
      showStatus('خطا در ارسال. لطفاً دوباره تلاش کنید.', 'error');
    } finally {
      btnSubmit.disabled = false;
      btnSubmit.innerHTML = '<svg width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg> تایید و ارسال';
    }
  }

  // --- Custom text submit ---
  async function uploadCustomText() {
    const text = customTextInput.value.trim();
    if (!text || !selectedFile) return;

    btnCustomSubmit.disabled = true;
    btnCustomSubmit.innerHTML = '<span class="spinner"></span>';

    try {
      const formData = new FormData();
      formData.append('image', selectedFile);
      formData.append('contributor_id', contributorId);
      formData.append('custom_text', text);

      const res = await fetch('/api/images', { method: 'POST', body: formData });
      const data = await res.json();

      if (data.success) {
        showStatus('تصویر شما ثبت شد! متشکریم', 'success');
        customTextInput.value = '';
        resetCapture();
        loadStats();
      } else {
        showStatus(data.error || 'خطا در ارسال تصویر', 'error');
      }
    } catch {
      showStatus('خطا در ارسال. لطفاً دوباره تلاش کنید.', 'error');
    } finally {
      btnCustomSubmit.disabled = false;
      btnCustomSubmit.innerHTML = '<svg width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg> تایید و ارسال';
    }
  }

  // --- Reset ---
  function resetCapture() {
    selectedFile = null;
    previewContainer.classList.remove('active');
    previewImg.src = '';
    cameraInput.value = '';
    fileInput.value = '';
  }

  // --- Events ---
  btnSubmit.addEventListener('click', () => {
    if (currentPrompt) {
      uploadImage(currentPrompt.id, null);
    }
  });

  btnRetake.addEventListener('click', resetCapture);

  customTextToggle.addEventListener('click', () => {
    customMode = !customMode;
    customTextForm.classList.toggle('active', customMode);
    if (!customMode) {
      customTextInput.value = '';
    }
  });

  customTextInput.addEventListener('input', () => {
    btnCustomSubmit.disabled = !customTextInput.value.trim() || !selectedFile;
  });

  btnCustomSubmit.addEventListener('click', uploadCustomText);

  // --- Init ---
  loadPrompt();
  loadStats();
})();
