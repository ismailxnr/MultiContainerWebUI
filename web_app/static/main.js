document.addEventListener('DOMContentLoaded', () => {
    // ─── Elements ───
    const dropZone        = document.getElementById('drop-zone');
    const fileInput       = document.getElementById('file-input');
    const uploadPH        = document.getElementById('upload-placeholder');
    const imagePreview    = document.getElementById('image-preview');
    const removeImageBtn  = document.getElementById('remove-image');
    const compareBtn      = document.getElementById('compare-btn');
    const promptInput     = document.getElementById('prompt-input');
    const modelGroups     = document.getElementById('model-groups');
    const resultsEmpty    = document.getElementById('results-empty');
    const progressWrap    = document.getElementById('progress-container');
    const progressText    = document.getElementById('progress-text');
    const progressCount   = document.getElementById('progress-count');
    const progressFill    = document.getElementById('progress-fill');
    const resultCards     = document.getElementById('result-cards');

    let currentFile    = null;
    let selectedModels = new Set();
    let isComparing    = false;
    let familiesCache  = {};
    let completedCount = 0;
    let totalCount     = 0;

    // ─── Families ───
    async function loadFamilies() {
        try {
            const res = await fetch('/api/families');
            familiesCache = await res.json();
            populateFamilyDropdown('custom-family');
            populateFamilyDropdown('edit-family');
            renderCustomFamiliesList();
        } catch (e) { console.error(e); }
    }

    function populateFamilyDropdown(id) {
        const sel = document.getElementById(id);
        if (!sel) return;
        const prev = sel.value;
        sel.innerHTML = '';
        for (const [key, info] of Object.entries(familiesCache)) {
            const opt = document.createElement('option');
            opt.value = key;
            opt.textContent = info.name;
            sel.appendChild(opt);
        }
        if (prev && sel.querySelector(`option[value="${prev}"]`)) sel.value = prev;
        if (id === 'custom-family') updateFamilyHint();
    }

    function updateFamilyHint() {
        const info = familiesCache[document.getElementById('custom-family').value];
        const hint = document.getElementById('family-desc-hint');
        if (info) {
            const r = info.requirements?.length ? ` — ${info.requirements.join(', ')}` : '';
            hint.textContent = info.description + r;
        } else hint.textContent = '';
    }
    document.getElementById('custom-family').addEventListener('change', updateFamilyHint);

    function renderCustomFamiliesList() {
        const container = document.getElementById('custom-families-list');
        const custom = Object.entries(familiesCache).filter(([, v]) => !v.builtin);
        container.innerHTML = '';
        if (!custom.length) return;
        container.innerHTML = `<p class="hint" style="margin-bottom:0.5rem;font-weight:600;color:var(--text-sec)">Kayıtlı Özel Aileler</p>`;
        custom.forEach(([key, info]) => {
            const row = document.createElement('div');
            row.className = 'family-row';
            row.innerHTML = `
                <div>
                    <div class="family-row-name">${info.name}</div>
                    <div class="family-row-meta">${info.strategy}${info.requirements?.length ? ' · ' + info.requirements.join(', ') : ''}</div>
                </div>
                <button class="action-btn del" data-key="${key}" title="Sil"><i class="fa-solid fa-trash"></i></button>`;
            row.querySelector('button').addEventListener('click', async () => {
                if (!confirm(`"${info.name}" ailesini silmek istiyor musunuz?`)) return;
                const fd = new FormData();
                fd.append('key', key);
                await fetch('/api/families/remove', { method: 'DELETE', body: fd });
                await loadFamilies();
            });
            container.appendChild(row);
        });
    }

    // ─── Models ───
    async function loadModels() {
        try {
            const res = await fetch('/api/models');
            const grouped = await res.json();
            modelGroups.innerHTML = '';

            if (!Object.keys(grouped).length) {
                modelGroups.innerHTML = '<p class="hint">Henüz model eklenmemiş.</p>';
                return;
            }

            for (const [groupName, models] of Object.entries(grouped)) {
                const titleEl = document.createElement('div');
                titleEl.className = 'model-group-title';
                titleEl.textContent = groupName;
                modelGroups.appendChild(titleEl);

                models.forEach(m => {
                    const row = document.createElement('label');
                    row.className = 'model-row' + (selectedModels.has(m.key) ? ' selected' : '');
                    row.innerHTML = `
                        <input type="checkbox" value="${m.key}" ${selectedModels.has(m.key) ? 'checked' : ''}>
                        <span class="model-check"><i class="fa-solid fa-check"></i></span>
                        <span class="model-name">${m.name}</span>
                        <div class="model-actions">
                            <button class="action-btn edit-btn" title="Düzenle" onclick="event.preventDefault()">
                                <i class="fa-solid fa-pen"></i>
                            </button>
                            <button class="action-btn del del-btn" title="Sil" onclick="event.preventDefault()">
                                <i class="fa-solid fa-trash"></i>
                            </button>
                        </div>`;

                    const cb = row.querySelector('input');
                    cb.addEventListener('change', () => {
                        if (cb.checked) { selectedModels.add(m.key); row.classList.add('selected'); }
                        else { selectedModels.delete(m.key); row.classList.remove('selected'); }
                        updateCompareBtn();
                    });

                    row.querySelector('.edit-btn').addEventListener('click', (e) => {
                        e.preventDefault(); e.stopPropagation();
                        openEditModal(m.key, m.name);
                    });

                    row.querySelector('.del-btn').addEventListener('click', async (e) => {
                        e.preventDefault(); e.stopPropagation();
                        if (!confirm(`"${m.name}" modelini kaldırmak istiyor musunuz?`)) return;
                        const fd = new FormData();
                        fd.append('key', m.key);
                        await fetch('/api/models/remove', { method: 'DELETE', body: fd });
                        selectedModels.delete(m.key);
                        updateCompareBtn();
                        await loadModels();
                    });

                    modelGroups.appendChild(row);
                });
            }
        } catch (e) {
            modelGroups.innerHTML = '<p style="color:var(--red);font-size:0.8rem">Model listesi yüklenemedi.</p>';
        }
    }

    loadFamilies();
    loadModels();

    // ─── Edit Modal ───
    function openEditModal(key, name) {
        const models = getModelsFlat();
        const m = models.find(x => x.key === key);
        if (!m) return;

        document.getElementById('edit-key').value = key;
        document.getElementById('edit-name').value = m.name;
        document.getElementById('edit-path').value = m.path || '';

        populateFamilyDropdown('edit-family');
        const editFamilySel = document.getElementById('edit-family');
        if (m.family && editFamilySel.querySelector(`option[value="${m.family}"]`)) {
            editFamilySel.value = m.family;
        }

        document.getElementById('edit-status').textContent = '';
        document.getElementById('edit-status').style.color = '';
        document.getElementById('edit-modal-overlay').classList.remove('hidden');
        document.getElementById('edit-name').focus();
    }

    let modelsFlat = [];
    function getModelsFlat() { return modelsFlat; }

    async function refreshModelsFlat() {
        try {
            const res = await fetch('/api/models');
            const grouped = await res.json();
            modelsFlat = [];
            for (const [, models] of Object.entries(grouped)) {
                models.forEach(m => modelsFlat.push(m));
            }
        } catch (e) {}
    }
    refreshModelsFlat();

    const origLoadModels = loadModels;
    async function loadModelsAndRefresh() {
        await origLoadModels.apply(this, arguments);
        await refreshModelsFlat();
    }

    document.getElementById('modal-close').addEventListener('click', closeModal);
    document.getElementById('modal-cancel').addEventListener('click', closeModal);
    document.getElementById('edit-modal-overlay').addEventListener('click', (e) => {
        if (e.target === document.getElementById('edit-modal-overlay')) closeModal();
    });

    function closeModal() {
        document.getElementById('edit-modal-overlay').classList.add('hidden');
    }

    document.getElementById('modal-save').addEventListener('click', async () => {
        const key    = document.getElementById('edit-key').value;
        const name   = document.getElementById('edit-name').value.trim();
        const path   = document.getElementById('edit-path').value.trim();
        const family = document.getElementById('edit-family').value;
        const status = document.getElementById('edit-status');

        if (!name || !path) {
            status.textContent = 'İsim ve yol boş bırakılamaz.';
            status.style.color = 'var(--yellow)';
            return;
        }

        const saveBtn = document.getElementById('modal-save');
        saveBtn.disabled = true;
        saveBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Kaydediliyor...';

        const fd = new FormData();
        fd.append('key', key);
        fd.append('name', name);
        fd.append('path', path);
        fd.append('family', family);

        try {
            const res = await fetch('/api/models/update', { method: 'PUT', body: fd });
            const data = await res.json();
            if (data.status === 'success') {
                closeModal();
                await loadModels();
                await refreshModelsFlat();
            } else {
                status.textContent = 'Hata: ' + data.message;
                status.style.color = 'var(--red)';
            }
        } catch (e) {
            status.textContent = 'Bağlantı hatası.';
            status.style.color = 'var(--red)';
        } finally {
            saveBtn.disabled = false;
            saveBtn.innerHTML = '<i class="fa-solid fa-floppy-disk"></i> Kaydet';
        }
    });

    // ─── Upload ───
    function updateCompareBtn() {
        compareBtn.disabled = !(currentFile && selectedModels.size > 0 && !isComparing);
    }

    ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(ev =>
        dropZone.addEventListener(ev, e => { e.preventDefault(); e.stopPropagation(); }));
    ['dragenter', 'dragover'].forEach(ev =>
        dropZone.addEventListener(ev, () => dropZone.classList.add('dragover')));
    ['dragleave', 'drop'].forEach(ev =>
        dropZone.addEventListener(ev, () => dropZone.classList.remove('dragover')));

    dropZone.addEventListener('drop', e => handleFiles(e.dataTransfer.files));
    dropZone.addEventListener('click', () => { if (!currentFile) fileInput.click(); });
    fileInput.addEventListener('change', function () { handleFiles(this.files); });

    function handleFiles(files) {
        if (files.length > 0 && files[0].type.startsWith('image/')) {
            currentFile = files[0];
            const reader = new FileReader();
            reader.readAsDataURL(files[0]);
            reader.onloadend = () => {
                imagePreview.src = reader.result;
                uploadPH.classList.add('hidden');
                imagePreview.classList.remove('hidden');
                removeImageBtn.classList.remove('hidden');
                updateCompareBtn();
            };
        }
    }

    removeImageBtn.addEventListener('click', e => {
        e.stopPropagation();
        currentFile = null;
        fileInput.value = '';
        imagePreview.src = '';
        uploadPH.classList.remove('hidden');
        imagePreview.classList.add('hidden');
        removeImageBtn.classList.add('hidden');
        updateCompareBtn();
    });

    // ─── Compare ───
    compareBtn.addEventListener('click', runComparison);

    async function runComparison() {
        if (!currentFile || selectedModels.size === 0 || isComparing) return;

        isComparing = true;
        compareBtn.disabled = true;
        compareBtn.querySelector('span').textContent = 'İşleniyor...';
        compareBtn.querySelector('i').className = 'fa-solid fa-spinner fa-spin';

        resultsEmpty.classList.add('hidden');
        progressWrap.classList.remove('hidden');
        resultCards.innerHTML = '';
        progressFill.style.width = '0%';
        completedCount = 0;
        totalCount = selectedModels.size;

        const fd = new FormData();
        fd.append('image', currentFile);
        fd.append('models', JSON.stringify(Array.from(selectedModels)));
        if (promptInput.value.trim()) fd.append('prompt', promptInput.value.trim());

        try {
            const response = await fetch('/api/compare', { method: 'POST', body: fd });
            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop();
                for (const line of lines) {
                    if (line.startsWith('data: ')) {
                        try { handleSSE(JSON.parse(line.slice(6))); } catch (_) {}
                    }
                }
            }
        } catch (err) {
            resultCards.innerHTML += `
                <div class="result-card error">
                    <div class="result-card-header">
                        <div class="result-model-name"><i class="fa-solid fa-triangle-exclamation" style="color:var(--red)"></i> Bağlantı Hatası</div>
                    </div>
                    <div class="result-body"><div class="result-caption">${err.message}</div></div>
                </div>`;
        } finally {
            isComparing = false;
            compareBtn.querySelector('span').textContent = 'Karşılaştır';
            compareBtn.querySelector('i').className = 'fa-solid fa-code-compare';
            updateCompareBtn();
        }
    }

    function handleSSE(data) {
        if (data.type === 'loading') {
            // All loading events arrive upfront — create all cards at once
            if (data.index === 0) {
                progressText.textContent = 'Tüm modeller paralel olarak yükleniyor...';
                progressCount.textContent = `0 / ${data.total}`;
            }

            const card = document.createElement('div');
            card.className = 'result-card loading';
            card.id = `card-${data.index}`;
            card.innerHTML = `
                <div class="result-card-header">
                    <div class="result-model-name">
                        <i class="fa-solid fa-brain" style="color:var(--blue)"></i>
                        ${data.model_name}
                    </div>
                </div>
                <div class="result-body">
                    <div class="pulse-dot"></div>
                    Yükleniyor ve çıktı üretiliyor...
                </div>`;
            resultCards.appendChild(card);

        } else if (data.type === 'result') {
            completedCount++;
            const pct = (completedCount / data.total * 100).toFixed(0);
            progressFill.style.width = pct + '%';
            progressText.textContent = `Tamamlandı: ${data.model_name}`;
            progressCount.textContent = `${completedCount} / ${data.total}`;

            const card = document.getElementById(`card-${data.index}`);
            if (card) {
                card.className = 'result-card';
                card.innerHTML = `
                    <div class="result-card-header">
                        <div class="result-model-name">
                            <i class="fa-solid fa-check-circle" style="color:var(--green)"></i>
                            ${data.model_name}
                            <span class="model-badge">${data.model_key.split('/').pop()}</span>
                        </div>
                        <div class="result-times">
                            <span><i class="fa-solid fa-download"></i> ${data.load_time}s</span>
                            <span><i class="fa-solid fa-bolt"></i> ${data.infer_time}s</span>
                        </div>
                    </div>
                    <div class="result-body">
                        <div class="result-caption">${data.caption}</div>
                    </div>`;
            }

        } else if (data.type === 'error') {
            completedCount++;
            const pct = (completedCount / data.total * 100).toFixed(0);
            progressFill.style.width = pct + '%';
            progressCount.textContent = `${completedCount} / ${data.total}`;

            const card = document.getElementById(`card-${data.index}`);
            if (card) {
                card.className = 'result-card error';
                card.innerHTML = `
                    <div class="result-card-header">
                        <div class="result-model-name">
                            <i class="fa-solid fa-triangle-exclamation" style="color:var(--red)"></i>
                            ${data.model_name}
                        </div>
                    </div>
                    <div class="result-body"><div class="result-caption">${data.error}</div></div>`;
            }

        } else if (data.type === 'done') {
            progressText.textContent = 'Tüm modeller tamamlandı';
            progressFill.style.width = '100%';
        }
    }

    // ─── Add Model Toggle ───
    document.getElementById('toggle-add-model').addEventListener('click', () => {
        document.getElementById('add-model-body').classList.toggle('hidden');
    });

    document.getElementById('add-model-btn').addEventListener('click', async () => {
        const name   = document.getElementById('custom-name').value.trim();
        const path   = document.getElementById('custom-path').value.trim();
        const family = document.getElementById('custom-family').value;
        const status = document.getElementById('add-model-status');

        if (!name || !path) {
            status.textContent = 'Lütfen isim ve yol girin.';
            status.style.color = 'var(--yellow)';
            return;
        }

        const btn = document.getElementById('add-model-btn');
        btn.disabled = true;
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Ekleniyor...';
        status.textContent = '';

        const fd = new FormData();
        fd.append('name', name); fd.append('path', path); fd.append('family', family);

        try {
            const res = await fetch('/api/models/add', { method: 'POST', body: fd });
            const data = await res.json();
            if (data.status === 'success') {
                status.textContent = 'Model eklendi!';
                status.style.color = 'var(--green)';
                document.getElementById('custom-name').value = '';
                document.getElementById('custom-path').value = '';
                await loadModels();
                await refreshModelsFlat();
            } else {
                status.textContent = 'Hata: ' + data.message;
                status.style.color = 'var(--red)';
            }
        } catch (e) {
            status.textContent = 'Bağlantı hatası.';
            status.style.color = 'var(--red)';
        } finally {
            btn.disabled = false;
            btn.innerHTML = '<i class="fa-solid fa-plus"></i> Kütüphaneye Ekle';
        }
    });

    // ─── Add Family Toggle ───
    document.getElementById('toggle-add-family').addEventListener('click', () => {
        document.getElementById('add-family-body').classList.toggle('hidden');
    });

    document.getElementById('add-family-btn').addEventListener('click', async () => {
        const name     = document.getElementById('family-name').value.trim();
        const desc     = document.getElementById('family-description').value.trim();
        const strategy = document.getElementById('family-strategy').value;
        const reqs     = document.getElementById('family-requirements').value.trim();
        const status   = document.getElementById('add-family-status');

        if (!name) {
            status.textContent = 'Lütfen aile adı girin.';
            status.style.color = 'var(--yellow)';
            return;
        }

        const btn = document.getElementById('add-family-btn');
        btn.disabled = true;
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Kaydediliyor...';

        const fd = new FormData();
        fd.append('name', name); fd.append('description', desc);
        fd.append('strategy', strategy); fd.append('requirements', reqs);

        try {
            const res = await fetch('/api/families/add', { method: 'POST', body: fd });
            const data = await res.json();
            if (data.status === 'success') {
                status.textContent = `"${name}" eklendi!`;
                status.style.color = 'var(--green)';
                document.getElementById('family-name').value = '';
                document.getElementById('family-description').value = '';
                document.getElementById('family-requirements').value = '';
                await loadFamilies();
            } else {
                status.textContent = 'Hata: ' + data.message;
                status.style.color = 'var(--red)';
            }
        } catch (e) {
            status.textContent = 'Bağlantı hatası.';
            status.style.color = 'var(--red)';
        } finally {
            btn.disabled = false;
            btn.innerHTML = '<i class="fa-solid fa-floppy-disk"></i> Kaydet';
        }
    });

    // ─── Keyboard shortcuts ───
    document.addEventListener('keydown', e => {
        if (e.key === 'Escape') closeModal();
    });
});
