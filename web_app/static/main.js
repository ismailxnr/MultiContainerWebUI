document.addEventListener('DOMContentLoaded', () => {

    // ─── Toast notifications ───
    function showToast(msg, type = '', duration = 2400) {
        const container = document.getElementById('toast-container');
        const el = document.createElement('div');
        el.className = 'toast' + (type ? ' ' + type : '');
        const icons = { success: 'fa-check', error: 'fa-triangle-exclamation', '': 'fa-circle-info' };
        el.innerHTML = `<i class="fa-solid ${icons[type] || icons['']}"></i>${msg}`;
        container.appendChild(el);
        setTimeout(() => {
            el.style.animation = 'toast-out 0.28s ease forwards';
            setTimeout(() => el.remove(), 300);
        }, duration);
    }

    // ─── Copy to clipboard ───
    function copyToClipboard(text, btn) {
        navigator.clipboard.writeText(text).then(() => {
            showToast('Panoya kopyalandı', 'success');
            if (btn) {
                const orig = btn.innerHTML;
                btn.innerHTML = '<i class="fa-solid fa-check"></i> Kopyalandı';
                btn.classList.add('copied');
                setTimeout(() => { btn.innerHTML = orig; btn.classList.remove('copied'); }, 2000);
            }
        }).catch(() => showToast('Kopyalama başarısız', 'error'));
    }

    // ─── Typewriter text reveal ───
    function typewriterReveal(el, text) {
        const tokens = text.split(/(\s+)/);
        const delay = Math.max(8, Math.min(38, 1600 / tokens.length));
        let i = 0;
        el.textContent = '';
        el.classList.add('typing-active');
        function step() {
            if (i < tokens.length) {
                el.textContent += tokens[i++];
                setTimeout(step, delay);
            } else {
                el.classList.remove('typing-active');
            }
        }
        setTimeout(step, 60);
    }

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

    // pending data for history capture
    let pendingResults       = [];
    let pendingImageDataUrl  = null;
    let pendingPrompt        = '';
    let activeHistoryId      = null;

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
        activeHistoryId = null;
        pendingResults = [];
        pendingImageDataUrl = imagePreview.src || null;
        pendingPrompt = promptInput.value.trim();
        compareBtn.disabled = true;
        compareBtn.querySelector('span').textContent = 'İşleniyor...';
        compareBtn.querySelector('i').className = 'fa-solid fa-spinner fa-spin';
        document.querySelectorAll('.history-item').forEach(el => el.classList.remove('active'));

        resultsEmpty.classList.add('hidden');
        progressWrap.classList.remove('hidden');
        resultCards.innerHTML = '';
        progressFill.style.width = '0%';

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
            progressText.textContent = `Yükleniyor: ${data.model_name}`;
            progressCount.textContent = `${data.index + 1} / ${data.total}`;

            const card = document.createElement('div');
            card.className = 'result-card loading';
            card.id = `card-${data.index}`;
            card.style.animationDelay = `${data.index * 0.06}s`;
            card.innerHTML = `
                <div class="result-card-header">
                    <div class="result-model-name">
                        <div class="model-status-dot loading"></div>
                        ${data.model_name}
                    </div>
                </div>
                <div class="result-body">
                    <div class="typing-indicator">
                        <div class="typing-dots"><span></span><span></span><span></span></div>
                        <span class="typing-label">Model yükleniyor ve çıktı üretiliyor...</span>
                    </div>
                </div>`;
            resultCards.appendChild(card);
            card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

        } else if (data.type === 'result') {
            const pct = ((data.index + 1) / data.total * 100).toFixed(0);
            progressFill.style.width = pct + '%';
            progressText.textContent = `Tamamlandı: ${data.model_name}`;
            progressCount.textContent = `${data.index + 1} / ${data.total}`;

            const card = document.getElementById(`card-${data.index}`);
            if (card) {
                const wordCount = data.caption.trim().split(/\s+/).filter(Boolean).length;
                card.className = 'result-card success';
                card.innerHTML = `
                    <div class="result-card-header">
                        <div class="result-model-name">
                            <div class="model-status-dot done"></div>
                            ${data.model_name}
                            <span class="model-badge">${data.model_key.split('/').pop()}</span>
                        </div>
                        <div class="result-meta-right">
                            <span class="word-count-badge">${wordCount} kelime</span>
                            <div class="result-times">
                                <span><i class="fa-solid fa-download"></i> ${data.load_time}s</span>
                                <span><i class="fa-solid fa-bolt"></i> ${data.infer_time}s</span>
                            </div>
                        </div>
                    </div>
                    <div class="result-body">
                        <div class="result-caption"></div>
                        <div class="result-actions">
                            <button class="copy-btn" title="Metni kopyala">
                                <i class="fa-regular fa-copy"></i> Kopyala
                            </button>
                        </div>
                    </div>`;
                typewriterReveal(card.querySelector('.result-caption'), data.caption);
                card.querySelector('.copy-btn').addEventListener('click', function () {
                    copyToClipboard(data.caption, this);
                });
            }
            pendingResults.push({ type: 'result', index: data.index, model_key: data.model_key, model_name: data.model_name, caption: data.caption, load_time: data.load_time, infer_time: data.infer_time });

        } else if (data.type === 'error') {
            const card = document.getElementById(`card-${data.index}`);
            if (card) {
                card.className = 'result-card error';
                card.innerHTML = `
                    <div class="result-card-header">
                        <div class="result-model-name">
                            <div class="model-status-dot error"></div>
                            ${data.model_name}
                        </div>
                    </div>
                    <div class="result-body"><div class="result-caption">${data.error}</div></div>`;
            }
            pendingResults.push({ type: 'error', index: data.index, model_key: data.model_key || '', model_name: data.model_name, error: data.error });

        } else if (data.type === 'done') {
            progressText.textContent = 'Tüm modeller tamamlandı';
            progressFill.style.width = '100%';
            if (pendingImageDataUrl && pendingResults.length > 0) {
                createThumbnail(pendingImageDataUrl).then(thumb => {
                    const id = Date.now().toString(36) + Math.random().toString(36).slice(2);
                    addToHistory({
                        id,
                        timestamp: Date.now(),
                        imageDataUrl: thumb,
                        models: Array.from(selectedModels),
                        modelNames: pendingResults.map(r => r.model_name).filter(Boolean),
                        prompt: pendingPrompt,
                        results: pendingResults.slice()
                    });
                    activeHistoryId = id;
                    document.querySelectorAll('.history-item').forEach(el =>
                        el.classList.toggle('active', el.dataset.id === id));
                });
            }
        }
    }

    // ─── Add Model Toggle ───
    document.getElementById('toggle-add-model').addEventListener('click', () => {
        document.getElementById('add-model-body').classList.toggle('open');
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
        document.getElementById('add-family-body').classList.toggle('open');
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
        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
            e.preventDefault();
            if (!compareBtn.disabled) compareBtn.click();
            else if (!landingCompareBtn.disabled) landingCompareBtn.click();
        }
    });

    // ─── Typewriter Effect ───
    const twPhrases = [
        'modelleri karşılaştır',
        'görselleri analiz et',
        'en iyi modeli bul'
    ];
    const twTarget = document.getElementById('typewriter-text');
    let twPhrase = 0, twChar = 0, twDeleting = false;

    function typeStep() {
        const phrase = twPhrases[twPhrase];
        if (!twDeleting) {
            twTarget.textContent = phrase.slice(0, ++twChar);
            if (twChar === phrase.length) { twDeleting = true; setTimeout(typeStep, 1800); return; }
            setTimeout(typeStep, 75 + Math.random() * 35);
        } else {
            twTarget.textContent = phrase.slice(0, --twChar);
            if (twChar === 0) {
                twDeleting = false;
                twPhrase = (twPhrase + 1) % twPhrases.length;
                setTimeout(typeStep, 380);
                return;
            }
            setTimeout(typeStep, 38 + Math.random() * 20);
        }
    }
    setTimeout(typeStep, 600);

    // ─── Landing Screen ───
    const landingScreen      = document.getElementById('landing-screen');
    const landingDrop        = document.getElementById('landing-drop-zone');
    const landingInput       = document.getElementById('landing-file-input');
    const landingUploadInner = document.getElementById('landing-upload-inner');
    const landingPreview     = document.getElementById('landing-preview');
    const landingRemoveImg   = document.getElementById('landing-remove-img');
    const landingChips       = document.getElementById('landing-model-chips');
    const landingPrompt      = document.getElementById('landing-prompt');
    const landingCompareBtn  = document.getElementById('landing-compare-btn');
    const appShell           = document.getElementById('app-shell');

    function updateLandingCompareBtn() {
        landingCompareBtn.disabled = !(currentFile && selectedModels.size > 0);
    }

    function setLandingFile(file) {
        handleFiles([file]);
        const reader = new FileReader();
        reader.readAsDataURL(file);
        reader.onloadend = () => {
            landingPreview.src = reader.result;
            landingUploadInner.classList.add('hidden');
            landingPreview.classList.remove('hidden');
            landingRemoveImg.classList.remove('hidden');
            updateLandingCompareBtn();
        };
    }

    function clearLandingFile() {
        currentFile = null;
        fileInput.value = '';
        landingInput.value = '';
        landingPreview.src = '';
        landingUploadInner.classList.remove('hidden');
        landingPreview.classList.add('hidden');
        landingRemoveImg.classList.add('hidden');
        imagePreview.src = '';
        uploadPH.classList.remove('hidden');
        imagePreview.classList.add('hidden');
        removeImageBtn.classList.add('hidden');
        updateLandingCompareBtn();
        updateCompareBtn();
    }

    function exitLanding() {
        landingScreen.classList.add('exit');
        appShell.classList.add('visible');
        setTimeout(() => { landingScreen.style.display = 'none'; }, 480);
    }

    function showLanding() {
        landingScreen.style.display = '';
        requestAnimationFrame(() => {
            landingScreen.classList.remove('exit');
            appShell.classList.remove('visible');
        });
        clearLandingFile();
        selectedModels.clear();
        document.querySelectorAll('.landing-chip').forEach(c => c.classList.remove('selected'));
        document.querySelectorAll('.model-row').forEach(r => { r.classList.remove('selected'); r.querySelector('input').checked = false; });
        landingPrompt.value = '';
        promptInput.value = '';
        resultCards.innerHTML = '';
        resultsEmpty.classList.remove('hidden');
        progressWrap.classList.add('hidden');
        activeHistoryId = null;
        document.querySelectorAll('.history-item').forEach(el => el.classList.remove('active'));
        updateCompareBtn();
    }

    async function loadLandingModels() {
        try {
            const res = await fetch('/api/models');
            const grouped = await res.json();
            landingChips.innerHTML = '';
            if (!Object.keys(grouped).length) {
                landingChips.innerHTML = '<span class="landing-no-models">Henüz model eklenmemiş.</span>';
                return;
            }
            for (const [, models] of Object.entries(grouped)) {
                models.forEach(m => {
                    const chip = document.createElement('div');
                    chip.className = 'landing-chip';
                    chip.dataset.key = m.key;
                    chip.innerHTML = `<span class="chip-check"><i class="fa-solid fa-check"></i></span>${m.name}`;
                    chip.addEventListener('click', () => {
                        const active = chip.classList.toggle('selected');
                        if (active) selectedModels.add(m.key);
                        else        selectedModels.delete(m.key);
                        const cb = document.querySelector(`input[value="${m.key}"]`);
                        if (cb) { cb.checked = active; cb.closest('.model-row').classList.toggle('selected', active); }
                        updateLandingCompareBtn();
                        updateCompareBtn();
                    });
                    landingChips.appendChild(chip);
                });
            }
        } catch(e) {
            landingChips.innerHTML = '<span class="landing-no-models">Modeller yüklenemedi.</span>';
        }
    }
    loadLandingModels();

    ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(ev =>
        landingDrop.addEventListener(ev, e => { e.preventDefault(); e.stopPropagation(); }));
    ['dragenter', 'dragover'].forEach(ev =>
        landingDrop.addEventListener(ev, () => landingDrop.classList.add('dragover')));
    ['dragleave', 'drop'].forEach(ev =>
        landingDrop.addEventListener(ev, () => landingDrop.classList.remove('dragover')));
    landingDrop.addEventListener('drop', e => { const f = e.dataTransfer.files; if (f.length > 0) setLandingFile(f[0]); });
    landingDrop.addEventListener('click', () => { if (!currentFile) landingInput.click(); });
    landingInput.addEventListener('change', function () { if (this.files.length > 0) setLandingFile(this.files[0]); });
    landingRemoveImg.addEventListener('click', e => { e.stopPropagation(); clearLandingFile(); });

    landingCompareBtn.addEventListener('click', () => {
        if (!currentFile || selectedModels.size === 0) return;
        promptInput.value = landingPrompt.value.trim();
        exitLanding();
        setTimeout(() => runComparison(), 180);
    });

    // ─── History Management ───
    const HISTORY_KEY = 'vlm-studio-history';
    const MAX_HISTORY = 60;

    const histSidebar    = document.getElementById('history-sidebar');
    const histList       = document.getElementById('history-list');
    const histSearch     = document.getElementById('history-search');
    const histCollapseBtn = document.getElementById('history-collapse-btn');
    const histExpandBtn  = document.getElementById('history-expand-btn');
    const histNewBtn     = document.getElementById('history-new-btn');
    const histClearBtn   = document.getElementById('history-clear-btn');

    function getHistory() {
        try { return JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]'); }
        catch { return []; }
    }

    function saveHistoryStore(items) {
        try { localStorage.setItem(HISTORY_KEY, JSON.stringify(items)); }
        catch(e) {
            // If quota exceeded, trim oldest half
            const half = items.slice(0, Math.floor(items.length / 2));
            try { localStorage.setItem(HISTORY_KEY, JSON.stringify(half)); } catch(_) {}
        }
    }

    function addToHistory(item) {
        const history = getHistory();
        history.unshift(item);
        if (history.length > MAX_HISTORY) history.length = MAX_HISTORY;
        saveHistoryStore(history);
        renderHistory(histSearch.value.trim().toLowerCase());
    }

    function deleteHistoryItem(id) {
        const history = getHistory().filter(h => h.id !== id);
        saveHistoryStore(history);
        if (activeHistoryId === id) {
            activeHistoryId = null;
            resultCards.innerHTML = '';
            resultsEmpty.classList.remove('hidden');
            document.getElementById('page-title').textContent = 'Sonuçlar';
            document.getElementById('page-sub').textContent = 'Modellerin çıktıları burada görünecek';
        }
        renderHistory(histSearch.value.trim().toLowerCase());
    }

    function getDateLabel(ts) {
        const now = new Date(), d = new Date(ts);
        const diff = now - d;
        const DAY = 86400000;
        if (diff < DAY && d.getDate() === now.getDate()) return 'Bugün';
        if (diff < 2 * DAY) return 'Dün';
        if (diff < 7 * DAY) return 'Bu Hafta';
        if (diff < 30 * DAY) return 'Bu Ay';
        return 'Daha Önce';
    }

    function formatRelTime(ts) {
        const diff = Date.now() - ts;
        const m = Math.floor(diff / 60000);
        if (m < 1) return 'Az önce';
        if (m < 60) return `${m} dk önce`;
        const h = Math.floor(m / 60);
        if (h < 24) return `${h} sa önce`;
        const day = Math.floor(h / 24);
        return `${day} gün önce`;
    }

    function buildResultCard(result, index) {
        const card = document.createElement('div');
        card.style.animationDelay = `${index * 0.05}s`;
        if (result.type === 'error') {
            card.className = 'result-card error';
            card.innerHTML = `
                <div class="result-card-header">
                    <div class="result-model-name"><div class="model-status-dot error"></div>${result.model_name}</div>
                </div>
                <div class="result-body"><div class="result-caption">${result.error}</div></div>`;
        } else {
            const wordCount = (result.caption || '').trim().split(/\s+/).filter(Boolean).length;
            card.className = 'result-card success';
            card.innerHTML = `
                <div class="result-card-header">
                    <div class="result-model-name">
                        <div class="model-status-dot done"></div>
                        ${result.model_name}
                        <span class="model-badge">${(result.model_key || '').split('/').pop()}</span>
                    </div>
                    <div class="result-meta-right">
                        <span class="word-count-badge">${wordCount} kelime</span>
                        <div class="result-times">
                            <span><i class="fa-solid fa-download"></i> ${result.load_time}s</span>
                            <span><i class="fa-solid fa-bolt"></i> ${result.infer_time}s</span>
                        </div>
                    </div>
                </div>
                <div class="result-body">
                    <div class="result-caption">${result.caption}</div>
                    <div class="result-actions">
                        <button class="copy-btn" title="Metni kopyala">
                            <i class="fa-regular fa-copy"></i> Kopyala
                        </button>
                    </div>
                </div>`;
            card.querySelector('.copy-btn').addEventListener('click', function () {
                copyToClipboard(result.caption, this);
            });
        }
        return card;
    }

    function loadHistoryItem(item) {
        exitLanding();
        activeHistoryId = item.id;
        document.querySelectorAll('.history-item').forEach(el =>
            el.classList.toggle('active', el.dataset.id === item.id));

        imagePreview.src = item.imageDataUrl;
        uploadPH.classList.add('hidden');
        imagePreview.classList.remove('hidden');
        removeImageBtn.classList.remove('hidden');
        promptInput.value = item.prompt || '';

        const title = item.prompt || item.modelNames?.join(', ') || 'Karşılaştırma';
        document.getElementById('page-title').textContent = title.length > 60 ? title.slice(0, 60) + '…' : title;
        document.getElementById('page-sub').textContent =
            `${item.modelNames?.length || item.models?.length || 0} model · ${formatRelTime(item.timestamp)}`;

        progressWrap.classList.add('hidden');
        resultsEmpty.classList.add('hidden');
        resultCards.innerHTML = '';
        item.results.forEach((r, i) => resultCards.appendChild(buildResultCard(r, i)));
    }

    function renderHistoryItem(item) {
        const el = document.createElement('div');
        el.className = 'history-item' + (item.id === activeHistoryId ? ' active' : '');
        el.dataset.id = item.id;
        const title = item.prompt || item.modelNames?.join(', ') || 'Karşılaştırma';
        const meta  = `${item.modelNames?.length || item.models?.length || 0} model · ${formatRelTime(item.timestamp)}`;
        el.innerHTML = `
            <div class="history-thumb"><img src="${item.imageDataUrl}" alt=""></div>
            <div class="history-item-info">
                <div class="history-item-title">${title}</div>
                <div class="history-item-meta">${meta}</div>
            </div>
            <button class="history-item-del" title="Sil"><i class="fa-solid fa-trash"></i></button>`;
        el.addEventListener('click', e => {
            if (e.target.closest('.history-item-del')) return;
            loadHistoryItem(item);
        });
        el.querySelector('.history-item-del').addEventListener('click', e => {
            e.stopPropagation();
            deleteHistoryItem(item.id);
        });
        return el;
    }

    function renderHistory(query = '') {
        const all = getHistory();
        const items = query
            ? all.filter(h => (h.prompt || '').toLowerCase().includes(query) ||
                              (h.modelNames || []).some(n => n.toLowerCase().includes(query)))
            : all;

        histList.innerHTML = '';
        if (!items.length) {
            histList.innerHTML = `<div class="history-empty-state">
                <i class="fa-regular fa-clock"></i>
                <span>${query ? 'Eşleşme bulunamadı' : 'Henüz karşılaştırma yok'}</span>
            </div>`;
            return;
        }
        const groups = {};
        items.forEach(h => {
            const label = getDateLabel(h.timestamp);
            if (!groups[label]) groups[label] = [];
            groups[label].push(h);
        });
        const ORDER = ['Bugün', 'Dün', 'Bu Hafta', 'Bu Ay', 'Daha Önce'];
        ORDER.filter(k => groups[k]).forEach(label => {
            const g = document.createElement('div');
            g.innerHTML = `<div class="history-group-label">${label}</div>`;
            groups[label].forEach(h => g.appendChild(renderHistoryItem(h)));
            histList.appendChild(g);
        });
    }

    function createThumbnail(dataUrl, maxSize = 160) {
        return new Promise(resolve => {
            const img = new Image();
            img.onload = () => {
                const ratio = Math.min(maxSize / img.width, maxSize / img.height, 1);
                const c = document.createElement('canvas');
                c.width = Math.round(img.width * ratio);
                c.height = Math.round(img.height * ratio);
                c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
                resolve(c.toDataURL('image/jpeg', 0.75));
            };
            img.onerror = () => resolve(dataUrl);
            img.src = dataUrl;
        });
    }

    // History sidebar toggle
    histCollapseBtn.addEventListener('click', () => histSidebar.classList.add('collapsed'));
    histExpandBtn.addEventListener('click',   () => histSidebar.classList.remove('collapsed'));

    histNewBtn.addEventListener('click', showLanding);

    histClearBtn.addEventListener('click', () => {
        if (!confirm('Tüm geçmiş silinecek. Emin misiniz?')) return;
        saveHistoryStore([]);
        renderHistory();
        activeHistoryId = null;
        resultCards.innerHTML = '';
        resultsEmpty.classList.remove('hidden');
        document.getElementById('page-title').textContent = 'Sonuçlar';
        document.getElementById('page-sub').textContent = 'Modellerin çıktıları burada görünecek';
    });

    histSearch.addEventListener('input', () => renderHistory(histSearch.value.trim().toLowerCase()));

    renderHistory();
});
