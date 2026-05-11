document.addEventListener('DOMContentLoaded', () => {

    // ════════════════════════════════════════
    //  STATE
    // ════════════════════════════════════════
    const state = {
        mode: 'landing',          // 'landing' | 'chat'
        landingFile: null,
        landingImageDataUrl: null,
        barFile: null,
        barImageDataUrl: null,
        landingModels: new Set(),
        barModels: new Set(),
        isRunning: false,
        familiesCache: {},
        history: [],              // [{id, ts, thumb, prompt, modelNames, results:[]}]
        activeId: null,
    };

    const HISTORY_KEY = 'vlm_studio_history_v2';

    // ════════════════════════════════════════
    //  HISTORY (localStorage)
    // ════════════════════════════════════════
    function loadHistory() {
        try { state.history = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]'); }
        catch { state.history = []; }
    }

    function saveHistory() {
        try { localStorage.setItem(HISTORY_KEY, JSON.stringify(state.history.slice(0, 50))); }
        catch { /* quota exceeded — trim older */ }
    }


    async function resizeForStorage(dataUrl, maxPx = 180) {
        return new Promise(resolve => {
            const img = new Image();
            img.onload = () => {
                const ratio = Math.min(maxPx / img.width, maxPx / img.height, 1);
                const c = document.createElement('canvas');
                c.width  = Math.round(img.width  * ratio);
                c.height = Math.round(img.height * ratio);
                c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
                resolve(c.toDataURL('image/jpeg', 0.65));
            };
            img.onerror = () => resolve(dataUrl);
            img.src = dataUrl;
        });
    }

    // ════════════════════════════════════════
    //  FAMILIES & MODELS
    // ════════════════════════════════════════
    async function loadFamilies() {
        try {
            const res = await fetch('/api/families');
            state.familiesCache = await res.json();
            populateFamilyDropdown();
            renderCustomFamiliesList();
        } catch (e) { console.error('Aile yüklenemedi:', e); }
    }

    function populateFamilyDropdown() {
        const sel = document.getElementById('custom-family');
        sel.innerHTML = '';
        for (const [key, info] of Object.entries(state.familiesCache)) {
            const o = document.createElement('option');
            o.value = key; o.textContent = info.name;
            sel.appendChild(o);
        }
        updateFamilyHint();
    }

    function updateFamilyHint() {
        const sel  = document.getElementById('custom-family');
        const hint = document.getElementById('family-desc-hint');
        const info = state.familiesCache[sel.value];
        hint.textContent = info
            ? info.description + (info.requirements?.length ? ` — ${info.requirements.join(', ')}` : '')
            : '';
    }
    document.getElementById('custom-family').addEventListener('change', updateFamilyHint);

    function renderCustomFamiliesList() {
        const c = document.getElementById('custom-families-list');
        const custom = Object.entries(state.familiesCache).filter(([, v]) => !v.builtin);
        c.innerHTML = '';
        if (!custom.length) return;
        custom.forEach(([key, info]) => {
            const row = document.createElement('div');
            row.className = 'family-row';
            row.innerHTML = `
                <div>
                    <span class="family-row-name">${info.name}</span>
                    <span class="family-row-meta">${info.strategy}${info.requirements.length ? ' · ' + info.requirements.join(', ') : ''}</span>
                </div>
                <button class="del-btn" title="Sil"><i class="fa-solid fa-trash"></i></button>`;
            row.querySelector('button').addEventListener('click', async () => {
                if (!confirm(`"${info.name}" ailesini silmek istiyor musunuz?`)) return;
                const fd = new FormData(); fd.append('key', key);
                await fetch('/api/families/remove', { method: 'DELETE', body: fd });
                await loadFamilies();
            });
            c.appendChild(row);
        });
    }

    async function loadModels() {
        try {
            const res     = await fetch('/api/models');
            const grouped = await res.json();

            renderModelFlat('landing-model-flat', state.landingModels);
            renderModelFlat('bar-model-flat',     state.barModels);
            renderDrawerModelList(grouped);
        } catch {
            document.getElementById('landing-model-flat').innerHTML =
                '<p style="font-size:.75rem;color:var(--err)">Model listesi yüklenemedi.</p>';
        }

        async function renderModelFlat(containerId, selectedSet) {
            const res2    = await fetch('/api/models');
            const grouped = await res2.json();
            const container = document.getElementById(containerId);
            container.innerHTML = '';

            if (Object.keys(grouped).length === 0) {
                container.innerHTML = '<p style="font-size:.75rem;color:var(--t3)">Henüz model eklenmemiş.</p>';
                return;
            }

            for (const [groupName, models] of Object.entries(grouped)) {
                const block = document.createElement('div');
                block.className = 'model-group-block';

                const title = document.createElement('div');
                title.className = 'model-group-title';
                title.textContent = groupName;
                block.appendChild(title);

                const chips = document.createElement('div');
                chips.className = 'model-chips';

                models.forEach(m => {
                    const chip = document.createElement('label');
                    chip.className = 'chip' + (selectedSet.has(m.key) ? ' on' : '');
                    chip.innerHTML = `
                        <input type="checkbox" value="${m.key}" ${selectedSet.has(m.key) ? 'checked' : ''}>
                        <span class="chip-box"><i class="fa-solid fa-check"></i></span>
                        <span>${m.name}</span>`;

                    const cb = chip.querySelector('input');
                    cb.addEventListener('change', () => {
                        if (cb.checked) { selectedSet.add(m.key); chip.classList.add('on'); }
                        else            { selectedSet.delete(m.key); chip.classList.remove('on'); }
                        updateSendBtns();
                        updateBarLabel();
                        updateLandingBadge();
                    });
                    chips.appendChild(chip);
                });

                block.appendChild(chips);
                container.appendChild(block);
            }
        }
    }

    function escapeHtml(s) {
        return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    }

    function renderDrawerModelList(grouped) {
        const c = document.getElementById('drawer-model-list');
        c.innerHTML = '';
        let count = 0;
        for (const [, models] of Object.entries(grouped)) {
            models.forEach(m => {
                count++;
                const row = document.createElement('div');
                row.className = 'drawer-model-row';
                const isCustom = m.key.startsWith('custom/');

                function renderView() {
                    row.className = 'drawer-model-row';
                    row.innerHTML = `
                        <div class="drawer-model-row-info">
                            <span class="drawer-model-name">${escapeHtml(m.name)}</span>
                            <span class="drawer-model-path">${escapeHtml(m.path || m.key)}</span>
                        </div>
                        ${isCustom ? `
                        <div class="row-btns">
                            <button class="row-icon-btn edit-btn" title="Düzenle"><i class="fa-solid fa-pen"></i></button>
                            <button class="row-icon-btn del-btn" title="Kaldır"><i class="fa-solid fa-trash"></i></button>
                        </div>` : ''}`;
                    if (isCustom) {
                        row.querySelector('.edit-btn').addEventListener('click', renderEdit);
                        row.querySelector('.del-btn').addEventListener('click', async () => {
                            if (!confirm(`"${m.name}" modelini kaldırmak istiyor musunuz?`)) return;
                            const fd = new FormData(); fd.append('key', m.key);
                            await fetch('/api/models/remove', { method: 'DELETE', body: fd });
                            state.landingModels.delete(m.key);
                            state.barModels.delete(m.key);
                            await loadModels();
                            updateSendBtns(); updateBarLabel(); updateLandingBadge();
                        });
                    }
                }

                function renderEdit() {
                    const famOptions = Object.entries(state.familiesCache)
                        .map(([k, v]) => `<option value="${escapeHtml(k)}" ${m.family === k ? 'selected' : ''}>${escapeHtml(v.name)}</option>`)
                        .join('');
                    row.className = 'drawer-model-row editing';
                    row.innerHTML = `
                        <div class="edit-form">
                            <input class="fi edit-fi" type="text" placeholder="İsim" value="${escapeHtml(m.name)}">
                            <input class="fi edit-fi" type="text" placeholder="Model Yolu / HF ID" value="${escapeHtml(m.path || '')}">
                            <select class="fi fs edit-fi">${famOptions}</select>
                            <div class="edit-form-btns">
                                <button class="btn-ghost save-edit-btn"><i class="fa-solid fa-check"></i> Kaydet</button>
                                <button class="btn-ghost cancel-edit-btn"><i class="fa-solid fa-xmark"></i> İptal</button>
                            </div>
                        </div>`;

                    const [nameIn, pathIn, famIn] = row.querySelectorAll('.edit-fi');
                    row.querySelector('.cancel-edit-btn').addEventListener('click', renderView);
                    row.querySelector('.save-edit-btn').addEventListener('click', async () => {
                        const newName = nameIn.value.trim();
                        const newPath = pathIn.value.trim();
                        const newFamily = famIn.value;
                        if (!newName || !newPath) { nameIn.focus(); return; }

                        const saveBtn = row.querySelector('.save-edit-btn');
                        saveBtn.disabled = true;
                        saveBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';

                        const fd = new FormData();
                        fd.append('key', m.key); fd.append('name', newName);
                        fd.append('path', newPath); fd.append('family', newFamily);

                        try {
                            const res = await fetch('/api/models/update', { method: 'PUT', body: fd });
                            const data = await res.json();
                            if (data.status === 'success') {
                                m.name = newName; m.path = newPath; m.family = newFamily;
                                renderView();
                                await loadModels();
                            } else {
                                saveBtn.disabled = false;
                                saveBtn.innerHTML = '<i class="fa-solid fa-check"></i> Kaydet';
                            }
                        } catch {
                            saveBtn.disabled = false;
                            saveBtn.innerHTML = '<i class="fa-solid fa-check"></i> Kaydet';
                        }
                    });
                }

                renderView();
                c.appendChild(row);
            });
        }
        if (!count) c.innerHTML = '<p style="font-size:.75rem;color:var(--t3)">Model eklenmemiş.</p>';
    }

    // ════════════════════════════════════════
    //  UI HELPERS
    // ════════════════════════════════════════
    function updateSendBtns() {
        document.getElementById('landing-send').disabled =
            !(state.landingFile && state.landingModels.size > 0 && !state.isRunning);
        document.getElementById('bar-send').disabled =
            !(state.barFile && state.barModels.size > 0 && !state.isRunning);
    }

    function updateLandingBadge() {
        const badge = document.getElementById('landing-sel-badge');
        if (state.landingModels.size > 0) {
            badge.textContent = state.landingModels.size + ' seçili';
            badge.classList.remove('hidden');
        } else {
            badge.classList.add('hidden');
        }
    }

    function updateBarLabel() {
        const label = document.getElementById('bar-models-label');
        label.textContent = state.barModels.size > 0
            ? state.barModels.size + ' model'
            : 'Model Seç';
    }

    function autoResize(el) {
        el.style.height = 'auto';
        el.style.height = Math.min(el.scrollHeight, 120) + 'px';
    }

    function formatTime(ts) {
        const d = new Date(ts);
        return d.getHours().toString().padStart(2, '0') + ':' +
               d.getMinutes().toString().padStart(2, '0');
    }

    // ════════════════════════════════════════
    //  LANDING — IMAGE UPLOAD
    // ════════════════════════════════════════
    const landingDrop    = document.getElementById('landing-drop');
    const landingFile    = document.getElementById('landing-file');
    const landingIdle    = document.getElementById('landing-idle');
    const landingDone    = document.getElementById('landing-done');
    const landingPreview = document.getElementById('landing-preview');
    const landingClear   = document.getElementById('landing-clear');

    ['dragenter','dragover','dragleave','drop'].forEach(ev =>
        landingDrop.addEventListener(ev, e => { e.preventDefault(); e.stopPropagation(); })
    );
    ['dragenter','dragover'].forEach(ev =>
        landingDrop.addEventListener(ev, () => landingDrop.classList.add('over'))
    );
    ['dragleave','drop'].forEach(ev =>
        landingDrop.addEventListener(ev, () => landingDrop.classList.remove('over'))
    );
    landingDrop.addEventListener('drop', e => handleLandingFile(e.dataTransfer.files));
    landingDrop.addEventListener('click', () => landingFile.click());
    landingFile.addEventListener('change', function() { handleLandingFile(this.files); });

    function handleLandingFile(files) {
        if (!files.length || !files[0].type.startsWith('image/')) return;
        state.landingFile = files[0];
        const reader = new FileReader();
        reader.onloadend = () => {
            state.landingImageDataUrl = reader.result;
            landingPreview.src = reader.result;
            landingIdle.classList.add('hidden');
            landingDone.classList.remove('hidden');
            updateSendBtns();
        };
        reader.readAsDataURL(files[0]);
    }

    landingClear.addEventListener('click', e => {
        e.stopPropagation();
        state.landingFile = null;
        state.landingImageDataUrl = null;
        landingFile.value = '';
        landingPreview.src = '';
        landingIdle.classList.remove('hidden');
        landingDone.classList.add('hidden');
        updateSendBtns();
    });

    // Auto-resize prompt textarea
    const landingPrompt = document.getElementById('landing-prompt');
    landingPrompt.addEventListener('input', () => autoResize(landingPrompt));

    // ════════════════════════════════════════
    //  LANDING — SEND
    // ════════════════════════════════════════
    document.getElementById('landing-send').addEventListener('click', () => {
        if (!state.landingFile || state.landingModels.size === 0 || state.isRunning) return;
        switchToChat();
    });

    // ════════════════════════════════════════
    //  SCREEN TRANSITION: landing → chat
    // ════════════════════════════════════════
    function switchToChat() {
        const landing = document.getElementById('landing-screen');
        const chat    = document.getElementById('chat-screen');

        landing.classList.add('exiting');
        setTimeout(() => {
            landing.classList.add('hidden');
            landing.classList.remove('exiting');
            chat.classList.remove('hidden');
            state.mode = 'chat';

            // Sync selected models to bar
            state.barModels = new Set(state.landingModels);
            loadModels();  // re-render bar chips with synced selection
            updateBarLabel();
            updateSendBtns();
            renderHistoryList();

            // Transfer file to bar
            state.barFile = state.landingFile;
            state.barImageDataUrl = state.landingImageDataUrl;
            if (state.barImageDataUrl) {
                document.getElementById('bar-thumb-img').src = state.barImageDataUrl;
                document.getElementById('bar-thumb').classList.remove('hidden');
                document.getElementById('bar-img-btn').classList.add('has-img');
            }
            // Copy prompt to bar
            document.getElementById('bar-prompt').value = landingPrompt.value;

            // Run first analysis
            runAnalysis(
                state.landingFile,
                state.landingImageDataUrl,
                landingPrompt.value.trim(),
                new Set(state.landingModels)
            );
        }, 300);
    }

    // ════════════════════════════════════════
    //  HISTORY SIDEBAR
    // ════════════════════════════════════════
    function renderHistoryList() {
        const list = document.getElementById('history-list');
        list.innerHTML = '';
        if (state.history.length === 0) {
            list.innerHTML = '<p style="font-size:.7rem;color:var(--t3);padding:.4rem .5rem">Geçmiş yok</p>';
            return;
        }
        state.history.forEach(item => {
            const el = document.createElement('div');
            el.className = 'history-item' + (item.id === state.activeId ? ' active' : '');
            el.dataset.id = item.id;
            el.innerHTML = `
                <img class="hist-thumb" src="${item.thumb}" alt="">
                <div class="hist-meta">
                    <div class="hist-models">${item.modelNames.join(' · ')}</div>
                    <div class="hist-prompt">${item.prompt || '(soru yok)'}</div>
                </div>
                <span class="hist-time">${formatTime(item.ts)}</span>
                <button class="hist-del" title="Sil"><i class="fa-solid fa-xmark"></i></button>`;

            el.addEventListener('click', () => viewSession(item.id));
            el.querySelector('.hist-del').addEventListener('click', e => {
                e.stopPropagation();
                deleteHistoryItem(item.id);
            });
            list.appendChild(el);
        });
    }

    function viewSession(id) {
        state.activeId = id;
        renderHistoryList();
        const item = state.history.find(h => h.id === id);
        if (!item) return;
        const feed = document.getElementById('chat-feed');
        const existing = document.getElementById('session-' + id);
        if (existing) { existing.scrollIntoView({ behavior: 'smooth', block: 'start' }); return; }
        const el = buildSessionElement(item);
        feed.appendChild(el);
        el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    function deleteHistoryItem(id) {
        state.history = state.history.filter(h => h.id !== id);
        saveHistory();
        const el = document.getElementById('session-' + id);
        if (el) el.remove();
        if (state.activeId === id) state.activeId = null;
        renderHistoryList();
    }

    function buildSessionElement(item) {
        const el = document.createElement('div');
        el.className = 'session';
        el.id = 'session-' + item.id;

        const ctx = document.createElement('div');
        ctx.className = 'session-ctx';
        ctx.innerHTML = `
            <img class="session-thumb" src="${item.thumb}" alt="">
            <div class="session-meta">
                <div class="session-models">${item.modelNames.join(' · ')}</div>
                <div class="session-prompt">${item.prompt || '(soru yok)'}</div>
            </div>
            <span class="session-time">${formatTime(item.ts)}</span>`;
        el.appendChild(ctx);

        const cards = document.createElement('div');
        cards.className = 'session-cards';
        item.results.forEach(r => {
            const card = document.createElement('div');
            card.className = 'result-card ' + (r.error ? 'error' : 'done');
            card.innerHTML = `
                <div class="card-head">
                    <div class="card-model">
                        <div class="card-ico ${r.error ? 'ico-err' : 'ico-done'}">
                            <i class="fa-solid ${r.error ? 'fa-triangle-exclamation' : 'fa-check'}"></i>
                        </div>
                        ${r.modelName}
                        <span class="card-badge">${r.modelKey.split('/').pop()}</span>
                    </div>
                    ${!r.error ? `<div class="card-times">
                        <span class="time-chip"><i class="fa-solid fa-download"></i>${r.loadTime}s</span>
                        <span class="time-chip"><i class="fa-solid fa-bolt"></i>${r.inferTime}s</span>
                    </div>` : ''}
                </div>
                <div class="card-body ${r.error ? 'error-body' : ''}">${r.error ? 'Hata: ' + r.error : r.caption}</div>`;
            cards.appendChild(card);
        });
        el.appendChild(cards);
        return el;
    }

    // ════════════════════════════════════════
    //  NEW ANALYSIS BUTTON
    // ════════════════════════════════════════
    document.getElementById('btn-new').addEventListener('click', () => {
        // Back to landing
        const landing = document.getElementById('landing-screen');
        const chat    = document.getElementById('chat-screen');

        // Reset landing state
        state.landingFile = null;
        state.landingImageDataUrl = null;
        document.getElementById('landing-file').value = '';
        document.getElementById('landing-preview').src = '';
        document.getElementById('landing-idle').classList.remove('hidden');
        document.getElementById('landing-done').classList.add('hidden');
        landingPrompt.value = '';
        autoResize(landingPrompt);

        chat.classList.add('hidden');
        landing.classList.remove('hidden');
        state.mode = 'landing';
        updateSendBtns();
    });

    // ════════════════════════════════════════
    //  BAR — IMAGE UPLOAD
    // ════════════════════════════════════════
    const barImgBtn     = document.getElementById('bar-img-btn');
    const barFile       = document.getElementById('bar-file');
    const barThumb      = document.getElementById('bar-thumb');
    const barThumbImg   = document.getElementById('bar-thumb-img');
    const barThumbClear = document.getElementById('bar-thumb-clear');

    barImgBtn.addEventListener('click', () => barFile.click());
    barFile.addEventListener('change', function() { handleBarFile(this.files); });

    function handleBarFile(files) {
        if (!files.length || !files[0].type.startsWith('image/')) return;
        state.barFile = files[0];
        const reader = new FileReader();
        reader.onloadend = () => {
            state.barImageDataUrl = reader.result;
            barThumbImg.src = reader.result;
            barThumb.classList.remove('hidden');
            barImgBtn.classList.add('has-img');
            updateSendBtns();
        };
        reader.readAsDataURL(files[0]);
    }

    barThumbClear.addEventListener('click', () => {
        state.barFile = null; state.barImageDataUrl = null;
        barFile.value = ''; barThumbImg.src = '';
        barThumb.classList.add('hidden');
        barImgBtn.classList.remove('has-img');
        updateSendBtns();
    });

    // ════════════════════════════════════════
    //  BAR — MODELS POPOVER
    // ════════════════════════════════════════
    const btnBarModels = document.getElementById('btn-bar-models');
    const modelsPop    = document.getElementById('models-pop');
    const barChevron   = document.getElementById('bar-chevron');

    btnBarModels.addEventListener('click', () => {
        const open = !modelsPop.classList.contains('hidden');
        modelsPop.classList.toggle('hidden', open);
        btnBarModels.classList.toggle('open', !open);
        barChevron.classList.toggle('flipped', !open);
    });

    document.addEventListener('click', e => {
        if (!btnBarModels.contains(e.target) && !modelsPop.contains(e.target)) {
            modelsPop.classList.add('hidden');
            btnBarModels.classList.remove('open');
            barChevron.classList.remove('flipped');
        }
    });

    // ════════════════════════════════════════
    //  BAR — PROMPT & SEND
    // ════════════════════════════════════════
    const barPrompt = document.getElementById('bar-prompt');
    barPrompt.addEventListener('input', () => autoResize(barPrompt));

    document.getElementById('bar-send').addEventListener('click', () => {
        if (!state.barFile || state.barModels.size === 0 || state.isRunning) return;
        const file         = state.barFile;
        const imageDataUrl = state.barImageDataUrl;
        const prompt       = barPrompt.value.trim();
        const models       = new Set(state.barModels);
        runAnalysis(file, imageDataUrl, prompt, models);
    });

    // ════════════════════════════════════════
    //  ANALYSIS RUNNER
    // ════════════════════════════════════════
    async function runAnalysis(file, imageDataUrl, prompt, models) {
        state.isRunning = true;
        updateSendBtns();

        const id      = Date.now().toString();
        const keys    = Array.from(models);
        const names   = await getModelNames(keys);
        const thumb   = await resizeForStorage(imageDataUrl);
        const session = { id, ts: Date.now(), thumb, prompt, modelNames: names, results: [] };

        // Add to history (pending)
        state.history.unshift(session);
        state.activeId = id;
        renderHistoryList();

        // Build session element in feed
        const feed = document.getElementById('chat-feed');
        const sessionEl = document.createElement('div');
        sessionEl.className = 'session';
        sessionEl.id = 'session-' + id;

        const ctx = document.createElement('div');
        ctx.className = 'session-ctx';
        ctx.innerHTML = `
            <img class="session-thumb" src="${thumb}" alt="">
            <div class="session-meta">
                <div class="session-models">${names.join(' · ')}</div>
                <div class="session-prompt">${prompt || '(soru yok)'}</div>
            </div>
            <span class="session-time">${formatTime(Date.now())}</span>`;
        sessionEl.appendChild(ctx);

        const progEl = document.createElement('div');
        progEl.className = 'session-progress';
        progEl.innerHTML = `
            <div class="prog-header">
                <div class="prog-status"><div class="prog-dot"></div><span id="prog-text-${id}">Hazırlanıyor...</span></div>
                <span class="prog-count" id="prog-count-${id}">0/${keys.length}</span>
            </div>
            <div class="prog-track"><div class="prog-fill" id="prog-fill-${id}"></div></div>`;
        sessionEl.appendChild(progEl);

        const cardsEl = document.createElement('div');
        cardsEl.className = 'session-cards';
        cardsEl.id = 'cards-' + id;
        sessionEl.appendChild(cardsEl);

        feed.appendChild(sessionEl);
        sessionEl.scrollIntoView({ behavior: 'smooth', block: 'start' });

        // SSE
        const formData = new FormData();
        formData.append('image', file);
        formData.append('models', JSON.stringify(keys));
        if (prompt) formData.append('prompt', prompt);

        try {
            const resp   = await fetch('/api/compare', { method: 'POST', body: formData });
            const reader = resp.body.getReader();
            const dec    = new TextDecoder();
            let buf = '';

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                buf += dec.decode(value, { stream: true });
                const lines = buf.split('\n');
                buf = lines.pop();
                for (const line of lines) {
                    if (line.startsWith('data: ')) {
                        try { handleEvent(JSON.parse(line.slice(6)), id, keys.length, cardsEl, progEl, session); }
                        catch { /* skip */ }
                    }
                }
            }
        } catch (err) {
            cardsEl.innerHTML += `
                <div class="result-card error">
                    <div class="card-body error-body"><i class="fa-solid fa-triangle-exclamation"></i> Bağlantı hatası: ${err.message}</div>
                </div>`;
        } finally {
            state.isRunning = false;
            updateSendBtns();
            saveHistory();
        }
    }

    async function getModelNames(keys) {
        try {
            const res = await fetch('/api/models');
            const grouped = await res.json();
            const map = {};
            for (const models of Object.values(grouped)) {
                models.forEach(m => { map[m.key] = m.name; });
            }
            return keys.map(k => map[k] || k.split('/').pop());
        } catch { return keys.map(k => k.split('/').pop()); }
    }

    function handleEvent(data, sessionId, total, cardsEl, progEl, session) {
        const progText  = document.getElementById('prog-text-'  + sessionId);
        const progCount = document.getElementById('prog-count-' + sessionId);
        const progFill  = document.getElementById('prog-fill-'  + sessionId);

        if (data.type === 'loading') {
            if (progText)  progText.textContent  = `Yükleniyor: ${data.model_name}`;
            if (progCount) progCount.textContent  = `${data.index + 1}/${total}`;

            const card = document.createElement('div');
            card.className = 'result-card loading';
            card.id = `card-${sessionId}-${data.index}`;
            card.innerHTML = `
                <div class="card-head">
                    <div class="card-model">
                        <div class="card-ico ico-load"><i class="fa-solid fa-brain"></i></div>
                        ${data.model_name}
                    </div>
                </div>
                <div class="card-body loading-body">
                    <div class="typing-dots"><span></span><span></span><span></span></div>
                    Model yükleniyor, çıktı üretiliyor...
                </div>`;
            cardsEl.appendChild(card);
            card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

        } else if (data.type === 'result') {
            const pct = ((data.index + 1) / total * 100).toFixed(0);
            if (progFill)  progFill.style.width   = pct + '%';
            if (progText)  progText.textContent   = `Tamamlandı: ${data.model_name}`;
            if (progCount) progCount.textContent   = `${data.index + 1}/${total}`;

            const card = document.getElementById(`card-${sessionId}-${data.index}`);
            if (card) {
                card.className = 'result-card done';
                card.innerHTML = `
                    <div class="card-head">
                        <div class="card-model">
                            <div class="card-ico ico-done"><i class="fa-solid fa-check"></i></div>
                            ${data.model_name}
                            <span class="card-badge">${data.model_key.split('/').pop()}</span>
                        </div>
                        <div class="card-times">
                            <span class="time-chip"><i class="fa-solid fa-download"></i>${data.load_time}s</span>
                            <span class="time-chip"><i class="fa-solid fa-bolt"></i>${data.infer_time}s</span>
                        </div>
                    </div>
                    <div class="card-body"></div>`;
                typewrite(card.querySelector('.card-body'), data.caption, 10);
            }
            session.results.push({
                modelKey: data.model_key, modelName: data.model_name,
                caption: data.caption, loadTime: data.load_time, inferTime: data.infer_time,
                error: null,
            });

        } else if (data.type === 'error') {
            const card = document.getElementById(`card-${sessionId}-${data.index}`);
            if (card) {
                card.className = 'result-card error';
                card.innerHTML = `
                    <div class="card-head">
                        <div class="card-model">
                            <div class="card-ico ico-err"><i class="fa-solid fa-triangle-exclamation"></i></div>
                            ${data.model_name}
                        </div>
                    </div>
                    <div class="card-body error-body">Hata: ${data.error}</div>`;
            }
            session.results.push({
                modelKey: data.model_key, modelName: data.model_name,
                caption: null, loadTime: null, inferTime: null, error: data.error,
            });

        } else if (data.type === 'done') {
            if (progText) progText.textContent = 'Tüm modeller tamamlandı!';
            if (progFill) progFill.style.width  = '100%';
            setTimeout(() => progEl?.remove(), 2500);
            saveHistory();
            renderHistoryList();
        }
    }

    // ════════════════════════════════════════
    //  TYPEWRITER
    // ════════════════════════════════════════
    function typewrite(el, text, speed = 40) {
        el.textContent = '';
        const cursor = document.createElement('span');
        cursor.className = 'tw-cursor';
        el.appendChild(cursor);
        const words = text.split(/(\s+)/);
        let i = 0;
        const tick = setInterval(() => {
            if (i < words.length) {
                const tok = document.createElement('span');
                tok.className = 'tw-token';
                tok.style.animationDelay = '0ms';
                tok.textContent = words[i++];
                cursor.insertAdjacentElement('beforebegin', tok);
            } else {
                clearInterval(tick);
                setTimeout(() => cursor.remove(), 600);
            }
        }, speed);
    }

    // ════════════════════════════════════════
    //  SETTINGS DRAWER
    // ════════════════════════════════════════
    function openDrawer() {
        document.getElementById('overlay').classList.remove('hidden');
        document.getElementById('drawer').classList.remove('hidden');
    }
    function closeDrawer() {
        document.getElementById('overlay').classList.add('hidden');
        document.getElementById('drawer').classList.add('hidden');
    }

    document.getElementById('btn-landing-settings').addEventListener('click', openDrawer);
    document.getElementById('btn-chat-settings').addEventListener('click', openDrawer);
    document.getElementById('btn-close-drawer').addEventListener('click', closeDrawer);
    document.getElementById('overlay').addEventListener('click', closeDrawer);

    // ════════════════════════════════════════
    //  ADD MODEL
    // ════════════════════════════════════════
    document.getElementById('add-model-btn').addEventListener('click', async () => {
        const nameVal   = document.getElementById('custom-name').value.trim();
        const pathVal   = document.getElementById('custom-path').value.trim();
        const familyVal = document.getElementById('custom-family').value;
        const statusEl  = document.getElementById('add-model-status');
        const btn       = document.getElementById('add-model-btn');

        if (!nameVal || !pathVal) {
            statusEl.textContent = 'Lütfen isim ve yol/ID girin.';
            statusEl.style.color = 'var(--warn)';
            return;
        }
        btn.disabled = true;
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Ekleniyor...';
        statusEl.textContent = '';

        const fd = new FormData();
        fd.append('name', nameVal); fd.append('path', pathVal); fd.append('family', familyVal);

        try {
            const res  = await fetch('/api/models/add', { method: 'POST', body: fd });
            const data = await res.json();
            if (data.status === 'success') {
                statusEl.textContent = 'Model eklendi!';
                statusEl.style.color = 'var(--ok)';
                document.getElementById('custom-name').value = '';
                document.getElementById('custom-path').value = '';
                await loadModels();
            } else {
                statusEl.textContent = 'Hata: ' + data.message;
                statusEl.style.color = 'var(--err)';
            }
        } catch {
            statusEl.textContent = 'Bağlantı hatası.';
            statusEl.style.color = 'var(--err)';
        } finally {
            btn.disabled = false;
            btn.innerHTML = '<i class="fa-solid fa-download"></i> Kütüphaneye Ekle';
        }
    });

    // ════════════════════════════════════════
    //  ADD FAMILY
    // ════════════════════════════════════════
    document.getElementById('add-family-btn').addEventListener('click', async () => {
        const nameVal     = document.getElementById('family-name').value.trim();
        const descVal     = document.getElementById('family-description').value.trim();
        const strategyVal = document.getElementById('family-strategy').value;
        const reqsVal     = document.getElementById('family-requirements').value.trim();
        const statusEl    = document.getElementById('add-family-status');
        const btn         = document.getElementById('add-family-btn');

        if (!nameVal) {
            statusEl.textContent = 'Lütfen aile adı girin.';
            statusEl.style.color = 'var(--warn)';
            return;
        }
        btn.disabled = true;
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Kaydediliyor...';
        statusEl.textContent = '';

        const fd = new FormData();
        fd.append('name', nameVal); fd.append('description', descVal);
        fd.append('strategy', strategyVal); fd.append('requirements', reqsVal);

        try {
            const res  = await fetch('/api/families/add', { method: 'POST', body: fd });
            const data = await res.json();
            if (data.status === 'success') {
                statusEl.textContent = `"${nameVal}" ailesi kaydedildi!`;
                statusEl.style.color = 'var(--ok)';
                document.getElementById('family-name').value         = '';
                document.getElementById('family-description').value  = '';
                document.getElementById('family-requirements').value = '';
                await loadFamilies();
            } else {
                statusEl.textContent = 'Hata: ' + data.message;
                statusEl.style.color = 'var(--err)';
            }
        } catch {
            statusEl.textContent = 'Bağlantı hatası.';
            statusEl.style.color = 'var(--err)';
        } finally {
            btn.disabled = false;
            btn.innerHTML = '<i class="fa-solid fa-floppy-disk"></i> Aileyi Kaydet';
        }
    });

    // ════════════════════════════════════════
    //  HERO CYCLING TYPEWRITER
    // ════════════════════════════════════════
    function startHeroTypewriter() {
        const el = document.querySelector('.grad-text');
        if (!el) return;
        const phrases = [
            'VLM ile Analiz Edin',
            'Modelleri Karşılaştırın',
            'Fine-Tune\'ları Test Edin',
        ];
        let pi = 0, ci = 0, deleting = false;

        function tick() {
            const phrase = phrases[pi];
            if (!deleting) {
                ci++;
                el.textContent = phrase.slice(0, ci);
                if (ci === phrase.length) {
                    deleting = true;
                    setTimeout(tick, 3200);
                } else {
                    setTimeout(tick, 65);
                }
            } else {
                ci--;
                el.textContent = phrase.slice(0, ci);
                if (ci === 0) {
                    deleting = false;
                    pi = (pi + 1) % phrases.length;
                    setTimeout(tick, 380);
                } else {
                    setTimeout(tick, 28);
                }
            }
        }
        setTimeout(tick, 900);
    }

    // ════════════════════════════════════════
    //  INIT
    // ════════════════════════════════════════
    loadHistory();
    loadFamilies();
    loadModels();
    startHeroTypewriter();
});
