document.addEventListener('DOMContentLoaded', () => {

    const dropZone         = document.getElementById('vlm-drop-zone');
    const fileInput        = document.getElementById('vlm-file-input');
    const uploadPH         = document.getElementById('vlm-upload-placeholder');
    const previewWrap      = document.getElementById('vlm-upload-preview-wrap');
    const imagePreview     = document.getElementById('vlm-image-preview');
    const removeImageBtn   = document.getElementById('vlm-remove-image');
    const btnPickImage     = document.getElementById('vlm-btn-pick-image');
    const compareBtn       = document.getElementById('vlm-compare-btn');
    const promptInput      = document.getElementById('vlm-prompt-input');
    const modelGroups      = document.getElementById('vlm-model-groups');
    const conversationArea = document.getElementById('vlm-conversation-area');
    const conversationFeed = document.getElementById('vlm-conversation-feed');
    const chatHistory      = document.getElementById('vlm-chat-history');
    const btnNewChat       = document.getElementById('vlm-btn-new-chat');
    const btnSettings      = document.getElementById('vlm-btn-settings');
    const settingsModal    = document.getElementById('vlm-settings-modal');
    const settingsClose    = document.getElementById('vlm-settings-modal-close');
    const editModal        = document.getElementById('vlm-edit-modal');

    let currentFile    = null;
    let selectedModels = new Set();
    let isComparing    = false;
    let familiesCache  = {};
    let currentSessionId = null;
    let sessions = [];

    // ─── Typewriter ─────────────────────────────────────────
    function typewriterEffect(el, text, wpm = 420) {
        return new Promise(resolve => {
            el.textContent = '';

            const cursor = document.createElement('span');
            cursor.className = 'tw-cursor';
            el.appendChild(cursor);

            const words = text.split(' ');
            const msPerWord = Math.round(60000 / wpm);
            let i = 0;

            function next() {
                if (i >= words.length) {
                    el.removeChild(cursor);
                    resolve();
                    return;
                }
                const word = document.createTextNode((i === 0 ? '' : ' ') + words[i]);
                el.insertBefore(word, cursor);
                i++;
                const jitter = msPerWord * (0.85 + Math.random() * 0.30);
                setTimeout(next, jitter);
            }

            setTimeout(next, 120);
        });
    }

    // ─── Skeleton ───────────────────────────────────────────
    function skeletonHTML() {
        return `
        <div class="result-body">
            <span class="skeleton skel-title"></span>
            <span class="skeleton skel-line"></span>
            <span class="skeleton skel-line"></span>
            <span class="skeleton skel-line"></span>
            <span class="skeleton skel-line"></span>
        </div>`;
    }

    // ─── Session Management ──────────────────────────────────
    function dataURLtoFile(dataUrl, filename) {
        const parts = dataUrl.split(',');
        const mime = (parts[0].match(/:(.*?);/) || [, 'image/png'])[1];
        const bin = atob(parts[1]);
        const len = bin.length;
        const arr = new Uint8Array(len);
        for (let i = 0; i < len; i++) arr[i] = bin.charCodeAt(i);
        return new File([arr], filename || 'image.png', { type: mime });
    }

    function clearImageUI() {
        currentFile = null;
        fileInput.value = '';
        imagePreview.removeAttribute('src');
        uploadPH.classList.remove('hidden');
        previewWrap.classList.add('hidden');
        removeImageBtn.classList.add('hidden');
    }

    function showImageUI(dataUrl, file) {
        imagePreview.src = dataUrl;
        uploadPH.classList.add('hidden');
        previewWrap.classList.remove('hidden');
        removeImageBtn.classList.remove('hidden');
        currentFile = file;
        updateCompareBtn();
    }

    function persistSessionImage(dataUrl, fileName) {
        const session = sessions.find(s => s.id === currentSessionId);
        if (session) {
            session.imageDataUrl = dataUrl;
            session.imageFileName = fileName || 'image.png';
        }
    }

    function persistSessionModelSelection() {
        const session = sessions.find(s => s.id === currentSessionId);
        if (session) session.selectedModelKeys = Array.from(selectedModels);
    }

    /** DOM’daki tikleri `selectedModels` ile eşitler; listede olmayan anahtarları Set’ten atar. */
    function applySelectionToModelList() {
        const validKeys = new Set();
        modelGroups.querySelectorAll('.model-row').forEach(row => {
            const cb = row.querySelector('input[type="checkbox"]');
            if (!cb) return;
            validKeys.add(cb.value);
        });
        for (const k of selectedModels) {
            if (!validKeys.has(k)) selectedModels.delete(k);
        }
        modelGroups.querySelectorAll('.model-row').forEach(row => {
            const cb = row.querySelector('input[type="checkbox"]');
            if (!cb) return;
            const on = selectedModels.has(cb.value);
            cb.checked = on;
            row.classList.toggle('selected', on);
        });
    }

    function restoreSessionModelSelection(session) {
        selectedModels.clear();
        const fromSaved = session.selectedModelKeys?.length
            ? session.selectedModelKeys
            : (session.results || []).map(r => r.model_key);
        const seen = new Set();
        for (const k of fromSaved) {
            if (k && !seen.has(k)) {
                seen.add(k);
                selectedModels.add(k);
            }
        }
    }

    function createNewSession() {
        const sessionId = Date.now().toString();
        const session = {
            id: sessionId,
            timestamp: new Date().toLocaleString('tr-TR'),
            results: [],
            imageDataUrl: null,
            imageFileName: null,
            selectedModelKeys: []
        };
        sessions.unshift(session);
        currentSessionId = sessionId;

        clearImageUI();
        promptInput.value = '';
        conversationFeed.innerHTML = '';
        selectedModels.clear();
        applySelectionToModelList();
        updateCompareBtn();

        renderChatHistory();
    }

    function renderChatHistory() {
        chatHistory.innerHTML = '';
        if (!sessions.length) {
            chatHistory.innerHTML = '<p class="history-empty">Henüz karşılaştırma yok</p>';
            return;
        }
        sessions.forEach(session => {
            const item = document.createElement('div');
            item.className = `history-item ${session.id === currentSessionId ? 'active' : ''}`;
            item.innerHTML = `<i class="fa-solid fa-image"></i> <span>${session.timestamp}</span><button class="history-delete" title="Sil"><i class="fa-solid fa-xmark"></i></button>`;
            item.querySelector('span').addEventListener('click', e => {
                e.stopPropagation();
                loadSession(session.id);
            });
            item.querySelector('.history-delete').addEventListener('click', e => {
                e.stopPropagation();
                const idx = sessions.findIndex(s => s.id === session.id);
                if (idx > -1) {
                    sessions.splice(idx, 1);
                    if (session.id === currentSessionId) {
                        if (sessions.length > 0) {
                            loadSession(sessions[0].id);
                        } else {
                            createNewSession();
                        }
                    } else {
                        renderChatHistory();
                    }
                }
            });
            chatHistory.appendChild(item);
        });
    }

    function loadSession(sessionId) {
        const session = sessions.find(s => s.id === sessionId);
        if (!session) return;

        currentSessionId = sessionId;
        fileInput.value = '';
        promptInput.value = '';

        restoreSessionModelSelection(session);
        applySelectionToModelList();

        if (session.imageDataUrl) {
            const name = session.imageFileName || 'image.png';
            try {
                const file = dataURLtoFile(session.imageDataUrl, name);
                showImageUI(session.imageDataUrl, file);
            } catch (_) {
                clearImageUI();
            }
        } else {
            clearImageUI();
        }

        updateCompareBtn();

        conversationFeed.innerHTML = '';
        if (session.results.length > 0) {
            const block = document.createElement('div');
            block.className = 'comparison-block';
            session.results.forEach(result => {
                const card = createResultCard(result.model_name, result.model_key, result.caption, result.load_time, result.infer_time);
                block.appendChild(card);
            });
            conversationFeed.appendChild(block);
        }

        renderChatHistory();
    }

    // ─── Families ───────────────────────────────────────────
    async function loadFamilies() {
        try {
            const res = await fetch('/api/families');
            familiesCache = await res.json();
            populateFamilyDropdown('vlm-custom-family');
            populateFamilyDropdown('vlm-edit-family');
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
        if (id === 'vlm-custom-family') updateFamilyHint();
    }

    function updateFamilyHint() {
        const info = familiesCache[document.getElementById('vlm-custom-family').value];
        const hint = document.getElementById('vlm-family-desc-hint');
        if (info) {
            const r = info.requirements?.length ? ` — ${info.requirements.join(', ')}` : '';
            hint.textContent = info.description + r;
        } else hint.textContent = '';
    }
    document.getElementById('vlm-custom-family').addEventListener('change', updateFamilyHint);

    function renderCustomFamiliesList() {
        const container = document.getElementById('vlm-custom-families-list');
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

    // ─── Models ─────────────────────────────────────────────
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
                    const row = document.createElement('div');
                    row.className = 'model-row';
                    row.innerHTML = `
                        <input type="checkbox" value="${m.key}" />
                        <div class="model-check"><i class="fa-solid fa-check model-check-tick" aria-hidden="true"></i></div>
                        <div class="model-name">${m.name}</div>
                        <div class="model-actions">
                            <button type="button" class="action-btn action-btn-edit" title="Düzenle"><i class="fa-solid fa-pen-to-square"></i></button>
                            <button type="button" class="action-btn del action-btn-del" title="Sil"><i class="fa-solid fa-trash"></i></button>
                        </div>`;
                    
                    const checkbox = row.querySelector('input');
                    
                    // Row'u tıklayınca checkbox'u toggle et
                    row.addEventListener('click', (e) => {
                        if (e.target.closest('button')) return; // Button'lardan geçme
                        checkbox.checked = !checkbox.checked;
                        checkbox.dispatchEvent(new Event('change', { bubbles: true }));
                    });
                    
                    checkbox.addEventListener('change', () => {
                        if (checkbox.checked) {
                            selectedModels.add(m.key);
                            row.classList.add('selected');
                        } else {
                            selectedModels.delete(m.key);
                            row.classList.remove('selected');
                        }
                        persistSessionModelSelection();
                        updateCompareBtn();
                    });

                    row.querySelector('.action-btn-edit').addEventListener('click', () => openEditModal(m.key));
                    row.querySelector('.action-btn-del').addEventListener('click', async () => {
                        if (!confirm(`"${m.name}" silinsin mi?`)) return;
                        const fd = new FormData();
                        fd.append('key', m.key);
                        await fetch('/api/models/delete', { method: 'DELETE', body: fd });
                        await loadModels();
                        await refreshModelsFlat();
                    });

                    modelGroups.appendChild(row);
                });
            }
            applySelectionToModelList();
        } catch (e) {
            modelGroups.innerHTML = '<p style="color:var(--red);font-size:0.8rem">Model listesi yüklenemedi.</p>';
        }
    }

    loadFamilies();
    loadModels();
    createNewSession();

    // ─── Edit Modal ─────────────────────────────────────────
    let modelsFlat = [];

    async function refreshModelsFlat() {
        try {
            const res = await fetch('/api/models');
            const grouped = await res.json();
            modelsFlat = [];
            for (const [, models] of Object.entries(grouped)) models.forEach(m => modelsFlat.push(m));
        } catch (_) {}
    }
    refreshModelsFlat();

    function openEditModal(key) {
        const m = modelsFlat.find(x => x.key === key);
        if (!m) return;
        document.getElementById('vlm-edit-model-key').value = key;
        document.getElementById('vlm-edit-name').value = m.name;
        document.getElementById('vlm-edit-path').value = m.path || '';
        populateFamilyDropdown('vlm-edit-family');
        const sel = document.getElementById('vlm-edit-family');
        if (m.family && sel.querySelector(`option[value="${m.family}"]`)) sel.value = m.family;
        document.getElementById('vlm-edit-status').textContent = '';
        editModal.classList.remove('hidden');
        document.getElementById('vlm-edit-name').focus();
    }

    document.getElementById('vlm-edit-modal-close').addEventListener('click', closeModal);
    document.getElementById('vlm-edit-modal-cancel').addEventListener('click', closeModal);
    editModal.addEventListener('click', e => {
        if (e.target === editModal) closeModal();
    });

    function closeModal() {
        editModal.classList.add('hidden');
    }

    document.getElementById('vlm-edit-modal-save').addEventListener('click', async () => {
        const key    = document.getElementById('vlm-edit-model-key').value;
        const name   = document.getElementById('vlm-edit-name').value.trim();
        const path   = document.getElementById('vlm-edit-path').value.trim();
        const family = document.getElementById('vlm-edit-family').value;
        const status = document.getElementById('vlm-edit-status');

        if (!name || !path) {
            status.textContent = 'İsim ve yol boş bırakılamaz.';
            status.style.color = 'var(--amber)';
            return;
        }

        const saveBtn = document.getElementById('vlm-edit-modal-save');
        saveBtn.disabled = true;
        saveBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Kaydediliyor...';

        const fd = new FormData();
        fd.append('key', key); fd.append('name', name);
        fd.append('path', path); fd.append('family', family);

        try {
            const res  = await fetch('/api/models/update', { method: 'PUT', body: fd });
            const data = await res.json();
            if (data.status === 'success') {
                closeModal();
                await loadModels();
                await refreshModelsFlat();
            } else {
                status.textContent = 'Hata: ' + data.message;
                status.style.color = 'var(--red)';
            }
        } catch (_) {
            status.textContent = 'Bağlantı hatası.';
            status.style.color = 'var(--red)';
        } finally {
            saveBtn.disabled = false;
            saveBtn.innerHTML = '<i class="fa-solid fa-floppy-disk"></i> Kaydet';
        }
    });

    // ─── Settings Modal ──────────────────────────────────────
    btnSettings.addEventListener('click', () => {
        settingsModal.classList.remove('hidden');
    });

    settingsClose.addEventListener('click', () => {
        settingsModal.classList.add('hidden');
    });

    settingsModal.addEventListener('click', e => {
        if (e.target === settingsModal) settingsModal.classList.add('hidden');
    });

    // ─── New Chat ────────────────────────────────────────────
    btnNewChat.addEventListener('click', createNewSession);

    // ─── Upload ─────────────────────────────────────────────
    function updateCompareBtn() {
        compareBtn.disabled = !(currentFile && selectedModels.size > 0 && !isComparing);
    }

    ['dragenter','dragover','dragleave','drop'].forEach(ev =>
        dropZone.addEventListener(ev, e => { e.preventDefault(); e.stopPropagation(); }));
    ['dragenter','dragover'].forEach(ev =>
        dropZone.addEventListener(ev, () => dropZone.classList.add('dragover')));
    ['dragleave','drop'].forEach(ev =>
        dropZone.addEventListener(ev, () => dropZone.classList.remove('dragover')));

    dropZone.addEventListener('drop', e => handleFiles(e.dataTransfer.files));
    dropZone.addEventListener('click', () => fileInput.click());
    dropZone.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            fileInput.click();
        }
    });
    btnPickImage.addEventListener('click', e => {
        e.stopPropagation();
        fileInput.click();
    });
    fileInput.addEventListener('change', function () { handleFiles(this.files); });

    function handleFiles(files) {
        if (!files.length || !files[0].type.startsWith('image/')) return;
        const file = files[0];
        const reader = new FileReader();
        reader.readAsDataURL(file);
        reader.onloadend = () => {
            showImageUI(reader.result, file);
            persistSessionImage(reader.result, file.name);
        };
    }

    removeImageBtn.addEventListener('click', e => {
        e.stopPropagation();
        clearImageUI();
        const session = sessions.find(s => s.id === currentSessionId);
        if (session) {
            session.imageDataUrl = null;
            session.imageFileName = null;
        }
        updateCompareBtn();
    });

    // ─── Result Card Creator ────────────────────────────────
    function createResultCard(modelName, modelKey, caption, loadTime, inferTime) {
        const card = document.createElement('div');
        card.className = 'result-card';
        card.innerHTML = `
            <div class="result-card-header">
                <div class="result-model-name">
                    <i class="fa-solid fa-check-circle icon-success" style="font-size:0.78rem"></i>
                    ${modelName}
                    <span class="model-badge">${modelKey.split('/').pop()}</span>
                </div>
                <div class="result-times">
                    <span class="t-load"><i class="fa-solid fa-download"></i> ${loadTime}s</span>
                    <span class="t-infer"><i class="fa-solid fa-bolt"></i> ${inferTime}s</span>
                </div>
            </div>
            <div class="result-body">
                <div class="result-caption">${caption}</div>
            </div>`;
        return card;
    }

    // ─── Compare ────────────────────────────────────────────
    compareBtn.addEventListener('click', runComparison);

    async function runComparison() {
        if (!currentFile || selectedModels.size === 0 || isComparing) return;

        isComparing = true;
        compareBtn.disabled = true;
        compareBtn.querySelector('span').textContent = 'İşleniyor...';
        compareBtn.querySelector('i').className = 'fa-solid fa-spinner fa-spin';

        conversationFeed.querySelectorAll('.comparison-block').forEach(el => el.remove());

        const block = document.createElement('div');
        block.className = 'comparison-block';
        conversationFeed.appendChild(block);
        conversationArea.scrollTop = conversationArea.scrollHeight;

        const modelsRequested = Array.from(selectedModels);
        const fd = new FormData();
        fd.append('image', currentFile);
        fd.append('models', JSON.stringify(modelsRequested));
        if (promptInput.value.trim()) fd.append('prompt', promptInput.value.trim());

        const cardMap = {};

        try {
            const response = await fetch('/api/compare', { method: 'POST', body: fd });
            const reader   = response.body.getReader();
            const decoder  = new TextDecoder();
            let buffer = '';

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop();
                for (const line of lines) {
                    if (line.startsWith('data: ')) {
                        const data = JSON.parse(line.slice(6));
                        handleSSE(data, block, cardMap);
                    }
                }
            }

            // Save session results
            if (currentSessionId) {
                const session = sessions.find(s => s.id === currentSessionId);
                if (session) {
                    session.results = Object.values(cardMap).map(c => ({
                        model_name: c.model_name,
                        model_key: c.model_key,
                        caption: c.caption,
                        load_time: c.load_time,
                        infer_time: c.infer_time
                    }));
                    session.selectedModelKeys = modelsRequested;
                    if (currentFile && imagePreview.src && imagePreview.src.startsWith('data:')) {
                        session.imageDataUrl = imagePreview.src;
                        session.imageFileName = currentFile.name;
                    }
                }
            }

        } catch (err) {
            const errCard = document.createElement('div');
            errCard.className = 'result-card error';
            errCard.innerHTML = `
                <div class="result-card-header">
                    <div class="result-model-name">
                        <i class="fa-solid fa-triangle-exclamation icon-error"></i> Bağlantı Hatası
                    </div>
                </div>
                <div class="result-body"><div class="result-caption">${err.message}</div></div>`;
            block.appendChild(errCard);
        } finally {
            isComparing = false;
            compareBtn.querySelector('span').textContent = 'Karşılaştır';
            compareBtn.querySelector('i').className = 'fa-solid fa-code-compare';
            updateCompareBtn();
        }
    }

    function resultCardEl(block, index) {
        return block.querySelector(`.result-card[data-result-index="${index}"]`);
    }

    // ─── SSE Handler ────────────────────────────────────────
    function handleSSE(data, block, cardMap) {

        if (data.type === 'loading') {
            const card = document.createElement('div');
            card.className = 'result-card loading';
            card.dataset.resultIndex = String(data.index);
            card.innerHTML = `
                <div class="result-card-header">
                    <div class="result-model-name">
                        <i class="fa-solid fa-circle-notch fa-spin icon-loading" style="font-size:0.78rem"></i>
                        ${data.model_name}
                    </div>
                </div>
                ${skeletonHTML()}`;
            block.appendChild(card);
            conversationArea.scrollTop = conversationArea.scrollHeight;
            cardMap[data.index] = { model_name: data.model_name, model_key: data.model_key };

        } else if (data.type === 'result') {
            const card = resultCardEl(block, data.index);
            if (!card) return;

            card.className = 'result-card';
            card.innerHTML = `
                <div class="result-card-header">
                    <div class="result-model-name">
                        <i class="fa-solid fa-check-circle icon-success" style="font-size:0.78rem"></i>
                        ${data.model_name}
                        <span class="model-badge">${data.model_key.split('/').pop()}</span>
                    </div>
                    <div class="result-times">
                        <span class="t-load"><i class="fa-solid fa-download"></i> ${data.load_time}s</span>
                        <span class="t-infer"><i class="fa-solid fa-bolt"></i> ${data.infer_time}s</span>
                    </div>
                </div>
                <div class="result-body">
                    <div class="result-caption"></div>
                </div>`;

            const captionEl = card.querySelector('.result-caption');
            typewriterEffect(captionEl, data.caption, 400);

            cardMap[data.index] = {
                model_name: data.model_name,
                model_key: data.model_key,
                caption: data.caption,
                load_time: data.load_time,
                infer_time: data.infer_time
            };

        } else if (data.type === 'error') {
            const card = resultCardEl(block, data.index);
            if (card) {
                card.className = 'result-card error';
                card.innerHTML = `
                    <div class="result-card-header">
                        <div class="result-model-name">
                            <i class="fa-solid fa-triangle-exclamation icon-error"></i> ${data.model_name}
                        </div>
                    </div>
                    <div class="result-body"><div class="result-caption">${data.error}</div></div>`;
            }
        }
    }

    // ─── Add Model ──────────────────────────────────────────
    document.getElementById('vlm-add-model-btn').addEventListener('click', async () => {
        const name   = document.getElementById('vlm-custom-name').value.trim();
        const path   = document.getElementById('vlm-custom-path').value.trim();
        const family = document.getElementById('vlm-custom-family').value;
        const status = document.getElementById('vlm-add-model-status');

        if (!name || !path) {
            status.textContent = 'Lütfen isim ve yol girin.';
            status.style.color = 'var(--amber)';
            return;
        }

        const btn = document.getElementById('vlm-add-model-btn');
        btn.disabled = true;
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Ekleniyor...';
        status.textContent = '';

        const fd = new FormData();
        fd.append('name', name); fd.append('path', path); fd.append('family', family);

        try {
            const res  = await fetch('/api/models/add', { method: 'POST', body: fd });
            const data = await res.json();
            if (data.status === 'success') {
                status.textContent = 'Model eklendi!';
                status.style.color = 'var(--green)';
                document.getElementById('vlm-custom-name').value = '';
                document.getElementById('vlm-custom-path').value = '';
                await loadModels();
                await refreshModelsFlat();
            } else {
                status.textContent = 'Hata: ' + data.message;
                status.style.color = 'var(--red)';
            }
        } catch (_) {
            status.textContent = 'Bağlantı hatası.';
            status.style.color = 'var(--red)';
        } finally {
            btn.disabled = false;
            btn.innerHTML = '<i class="fa-solid fa-plus"></i> Kütüphaneye Ekle';
        }
    });

    // ─── Add Family ─────────────────────────────────────────
    document.getElementById('vlm-add-family-btn').addEventListener('click', async () => {
        const name     = document.getElementById('vlm-family-name').value.trim();
        const desc     = document.getElementById('vlm-family-description').value.trim();
        const strategy = document.getElementById('vlm-family-strategy').value;
        const reqs     = document.getElementById('vlm-family-requirements').value.trim();
        const status   = document.getElementById('vlm-add-family-status');

        if (!name) {
            status.textContent = 'Lütfen aile adı girin.';
            status.style.color = 'var(--amber)';
            return;
        }

        const btn = document.getElementById('vlm-add-family-btn');
        btn.disabled = true;
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Kaydediliyor...';

        const fd = new FormData();
        fd.append('name', name); fd.append('description', desc);
        fd.append('strategy', strategy); fd.append('requirements', reqs);

        try {
            const res  = await fetch('/api/families/add', { method: 'POST', body: fd });
            const data = await res.json();
            if (data.status === 'success') {
                status.textContent = `"${name}" eklendi!`;
                status.style.color = 'var(--green)';
                document.getElementById('vlm-family-name').value = '';
                document.getElementById('vlm-family-description').value = '';
                document.getElementById('vlm-family-requirements').value = '';
                await loadFamilies();
            } else {
                status.textContent = 'Hata: ' + data.message;
                status.style.color = 'var(--red)';
            }
        } catch (_) {
            status.textContent = 'Bağlantı hatası.';
            status.style.color = 'var(--red)';
        } finally {
            btn.disabled = false;
            btn.innerHTML = '<i class="fa-solid fa-floppy-disk"></i> Kaydet';
        }
    });

    // ─── Keyboard shortcuts ─────────────────────────────────
    document.addEventListener('keydown', e => {
        if (e.key === 'Escape') {
            closeModal();
            settingsModal.classList.add('hidden');
        }
    });
});
