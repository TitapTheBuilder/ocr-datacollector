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

  // Prompts
  const promptsList = document.getElementById('promptsList');
  const promptsEmpty = document.getElementById('promptsEmpty');
  const csvInput = document.getElementById('csvInput');
  const csvCategory = document.getElementById('csvCategory');

  // Sync
  const syncGrid = document.getElementById('syncGrid');
  const syncEmpty = document.getElementById('syncEmpty');
  const btnSyncAll = document.getElementById('btnSyncAll');

  // Modal
  const imageModal = document.getElementById('imageModal');
  const modalImg = document.getElementById('modalImg');
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
    } catch {
      // silent
    }
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
    const data = await fetchImages('pending', currentPage.pending);
    renderImageGrid(pendingGrid, pendingEmpty, data.images);
    renderPagination(pendingPagination, data, 'pending');
  }

  async function loadAll() {
    const status = filterStatus.value;
    const data = await fetchImages(status, currentPage.all);
    renderImageGrid(allGrid, allEmpty, data.images);
    renderPagination(allPagination, data, 'all');
  }

  async function fetchImages(status, page) {
    const params = new URLSearchParams({ page, limit: 20 });
    if (status) params.set('status', status);
    const res = await fetch(`/api/admin/images?${params}`);
    return res.json();
  }

  function renderImageGrid(grid, empty, images) {
    if (!images || images.length === 0) {
      grid.innerHTML = '';
      empty.style.display = 'block';
      return;
    }
    empty.style.display = 'none';
    grid.innerHTML = images.map(img => {
      const folder = img.status === 'approved' ? 'approved' : 'pending';
      return `
      <div class="image-card" data-id="${img.id}">
        <img src="/uploads/${folder}/${img.filename}" alt="" loading="lazy">
        <div class="image-card-info">
          <div class="prompt-text">${escapeHtml(img.prompt_text || img.custom_text || '—')}</div>
          <div class="meta">
            <div>مشارکت‌کننده: ${img.contributor_id.substring(0, 8)}...</div>
            <div>${formatDate(img.created_at)}</div>
          </div>
          <span class="status-badge ${img.status}">${statusLabel(img.status)}</span>
        </div>
      </div>
      `;
    }).join('');

    grid.querySelectorAll('.image-card').forEach(card => {
      card.addEventListener('click', () => openModal(parseInt(card.dataset.id)));
    });
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
        if (tab === 'pending') loadPending();
        else loadAll();
      });
    });
  }

  // --- Modal ---
  async function openModal(imageId) {
    try {
      const res = await fetch(`/api/admin/images/${imageId}`);
      if (!res.ok) return;
      const img = await res.json();
      if (!img) return;

      const folder = img.status === 'approved' ? 'approved' : 'pending';

      modalTitle.textContent = `تصویر #${img.id}`;
      modalImg.src = `/uploads/${folder}/${img.filename}`;

      modalInfo.innerHTML = `
        <p><strong>متن:</strong> ${escapeHtml(img.prompt_text || img.custom_text || '—')}</p>
        <p><strong>دسته:</strong> ${img.prompt_category || '—'}</p>
        <p><strong>مشارکت‌کننده:</strong> ${img.contributor_id.substring(0, 12)}...</p>
        <p><strong>تاریخ:</strong> ${formatDate(img.created_at)}</p>
        <p><strong>وضعیت:</strong> <span class="status-badge ${img.status}">${statusLabel(img.status)}</span></p>
        ${img.rejection_reason ? `<p><strong>دلیل رد:</strong> ${escapeHtml(img.rejection_reason)}</p>` : ''}
        ${img.drive_file_id ? `<p><strong>Drive ID:</strong> ${img.drive_file_id}</p>` : ''}
      `;

      let actionsHtml = '';
      if (img.status === 'pending') {
        actionsHtml = `
          <button class="btn btn-success" onclick="adminAction(${img.id}, 'approved')">تایید</button>
          <button class="btn btn-danger" onclick="adminAction(${img.id}, 'rejected')">رد کردن</button>
        `;
      } else if (img.status === 'approved' && !img.drive_file_id) {
        actionsHtml = `
          <button class="btn btn-primary" onclick="syncSingle(${img.id})">همگام‌سازی با درایو</button>
        `;
      }
      modalActions.innerHTML = actionsHtml;

      imageModal.classList.add('active');
    } catch (err) {
      console.error('Error opening image modal:', err);
    }
  }

  modalClose.addEventListener('click', () => imageModal.classList.remove('active'));
  imageModal.addEventListener('click', (e) => {
    if (e.target === imageModal) imageModal.classList.remove('active');
  });

  // --- Admin actions (global for onclick) ---
  window.adminAction = async function(imageId, status) {
    let rejectionReason = null;
    if (status === 'rejected') {
      rejectionReason = prompt('دلیل رد (اختیاری):');
    }

    try {
      const res = await fetch(`/api/admin/images/${imageId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status, rejection_reason: rejectionReason }),
      });
      const data = await res.json();
      if (data.success) {
        imageModal.classList.remove('active');
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
        imageModal.classList.remove('active');
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
  async function loadPrompts() {
    try {
      const res = await fetch('/api/admin/prompts');
      const prompts = await res.json();
      if (!prompts || prompts.length === 0) {
        promptsList.innerHTML = '';
        promptsEmpty.style.display = 'block';
        return;
      }
      promptsEmpty.style.display = 'none';
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
    } catch {
      // silent
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
        alert(`${data.imported} متن با موفقیت اضافه شد.`);
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
  async function loadSync() {
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
          <img src="/uploads/approved/${img.filename}" alt="" loading="lazy">
          <div class="image-card-info">
            <div class="prompt-text">${escapeHtml(img.prompt_text || img.custom_text || '—')}</div>
            <div class="meta">
              <div>مشارکت‌کننده: ${img.contributor_id.substring(0, 8)}...</div>
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
    loadAll();
  });

  // --- Helpers ---
  function escapeHtml(s) {
    if (!s) return '';
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
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
