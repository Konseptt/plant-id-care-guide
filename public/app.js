(function () {
  'use strict';

  // DOM elements
  const uploadZone = document.getElementById('upload-zone');
  const fileInput = document.getElementById('file-input');
  const previewArea = document.getElementById('preview-area');
  const previewImg = document.getElementById('preview-img');
  const previewCaption = document.getElementById('preview-caption');
  const removePhoto = document.getElementById('remove-photo');
  const organPicker = document.getElementById('organ-picker');
  const identifyBtn = document.getElementById('identify-btn');
  const loadingArea = document.getElementById('loading-area');
  const loadingText = document.getElementById('loading-text');
  const errorArea = document.getElementById('error-area');
  const errorMsg = document.getElementById('error-msg');
  const errorDetail = document.getElementById('error-detail');
  const tryAgainBtn = document.getElementById('try-again-btn');
  const resultsArea = document.getElementById('results-area');
  const speciesList = document.getElementById('species-list');
  const careGuideArea = document.getElementById('care-guide-area');
  const careGuideContent = document.getElementById('care-guide-content');

  // App state
  let currentFile = null;
  let selectedOrgan = 'auto';
  let identificationResults = null;

  // Simple HTML escaping helper for safe rendering
  function esc(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = String(str);
    return div.innerHTML;
  }

  // Only allow HTTPS and trusted Pl@ntNet image domains
  function isTrustedImageUrl(url) {
    if (!url || typeof url !== 'string') return false;
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'https:') return false;
      return parsed.hostname.endsWith('.plantnet.org');
    } catch {
      return false;
    }
  }

  // Messages shown during identification
  const loadingMessages = [
    'Consulting the botanical archives...',
    'Leafing through the herbarium...',
    'Cross-referencing with field notes...',
    'Comparing petal morphology...',
    'Checking the root structure index...',
    'Deciphering phyllotaxis patterns...',
    'Pressing the specimen into memory...',
  ];

  // Helper utility functions
  function show(el) { el.classList.add('visible'); }
  function hide(el) { el.classList.remove('visible'); }
  function showError(msg, detail) {
    errorMsg.textContent = msg;
    errorDetail.textContent = detail || '';
    show(errorArea);
  }

  function cycleLoadingText(messages) {
    let idx = 0;
    return setInterval(() => {
      idx = (idx + 1) % messages.length;
      loadingText.textContent = messages[idx];
    }, 2500);
  }

  // Set CSRF cookie on demand before secure operations
  async function setCsrfCookie() {
    try {
      const res = await fetch('/api/csrf-token', { credentials: 'same-origin' });
      if (!res.ok) return null;
      const data = await res.json();
      return data.token || null;
    } catch (err) {
      console.error('CSRF cookie error:', err);
      return null;
    }
  }

  // Setup drag and drop events
  uploadZone.addEventListener('click', () => fileInput.click());
  uploadZone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); }
  });

  uploadZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    uploadZone.classList.add('drag-over');
  });
  uploadZone.addEventListener('dragleave', () => {
    uploadZone.classList.remove('drag-over');
  });
  uploadZone.addEventListener('drop', (e) => {
    e.preventDefault();
    uploadZone.classList.remove('drag-over');
    const files = e.dataTransfer.files;
    if (files.length > 0 && (files[0].type === 'image/jpeg' || files[0].type === 'image/png')) {
      handleFile(files[0]);
    }
  });

  fileInput.addEventListener('change', () => {
    if (fileInput.files.length > 0) handleFile(fileInput.files[0]);
  });

  function handleFile(file) {
    currentFile = file;

    const reader = new FileReader();
    reader.onload = (e) => {
      previewImg.src = e.target.result;
      previewCaption.textContent = file.name.replace(/\.[^.]+$/, '');
      show(previewArea);
      show(organPicker);
      identifyBtn.classList.add('visible');
      uploadZone.classList.add('has-image');
      previewArea.scrollIntoView({ behavior: 'smooth', block: 'center' });
    };
    reader.readAsDataURL(file);

    hide(resultsArea);
    hide(careGuideArea);
    hide(errorArea);
    speciesList.innerHTML = '';
    careGuideContent.innerHTML = '';
  }

  removePhoto.addEventListener('click', () => {
    currentFile = null;
    fileInput.value = '';
    previewImg.src = '';
    hide(previewArea);
    hide(organPicker);
    identifyBtn.classList.remove('visible');
    uploadZone.classList.remove('has-image');
    hide(resultsArea);
    hide(careGuideArea);
    hide(errorArea);
    speciesList.innerHTML = '';
    careGuideContent.innerHTML = '';
  });

  organPicker.addEventListener('click', (e) => {
    const tag = e.target.closest('.organ-tag');
    if (!tag) return;
    organPicker.querySelectorAll('.organ-tag').forEach(t => {
      t.classList.remove('active');
      t.setAttribute('aria-pressed', 'false');
    });
    tag.classList.add('active');
    tag.setAttribute('aria-pressed', 'true');
    selectedOrgan = tag.dataset.organ;
  });

  // Handle identification request
  identifyBtn.addEventListener('click', identify);

  async function identify() {
    if (!currentFile) return;

    hide(resultsArea);
    hide(careGuideArea);
    hide(errorArea);
    speciesList.innerHTML = '';
    careGuideContent.innerHTML = '';
    show(loadingArea);
    identifyBtn.disabled = true;

    const msgInterval = cycleLoadingText(loadingMessages);

    try {
      const formData = new FormData();
      formData.append('images', currentFile);
      formData.append('organs', selectedOrgan);

      const res = await fetch('/api/identify', { method: 'POST', body: formData });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Unknown error' }));
        throw new Error(err.error || `Server error (${res.status})`);
      }

      identificationResults = await res.json();
      renderResults(identificationResults);
    } catch (err) {
      showError('Hmm, the field guide came up blank.', err.message);
    } finally {
      clearInterval(msgInterval);
      hide(loadingArea);
      identifyBtn.disabled = false;
    }
  }

  // Render matched species results list
  function renderResults(data) {
    if (!data.results || data.results.length === 0) {
      showError('No species matched your photograph.', 'Try a clearer image or a different angle.');
      return;
    }

    show(resultsArea);
    speciesList.innerHTML = '';

    // Pl@ntNet returns a probability per match; when even the best result is
    // weak the identification is unreliable, so surface a caution instead of
    // letting the user trust a shaky top hit.
    const topScore = data.results[0] && typeof data.results[0].score === 'number'
      ? data.results[0].score : 0;
    if (topScore < 0.25) {
      const warn = document.createElement('div');
      warn.className = 'low-confidence-warning';
      warn.setAttribute('role', 'status');
      warn.textContent = `Low confidence — best match only ${(topScore * 100).toFixed(1)}%. `
        + 'Try a sharper photo, fill the frame, or shoot a single leaf or flower close-up.';
      speciesList.appendChild(warn);
    }

    data.results.forEach((result, idx) => {
      const sp = result.species;
      const score = (result.score * 100).toFixed(1);

      const entry = document.createElement('div');
      entry.className = `species-entry animate-in stagger-${Math.min(idx + 1, 5)}`;
      entry.dataset.index = idx;

      // Build DOM nodes safely to prevent XSS
      const rankSpan = document.createElement('span');
      rankSpan.className = 'species-rank';
      rankSpan.textContent = `#${idx + 1}`;
      entry.appendChild(rankSpan);

      const nameDiv = document.createElement('div');
      nameDiv.className = 'species-name';
      nameDiv.textContent = sp.scientificNameWithoutAuthor || '';
      if (sp.scientificNameAuthorship) {
        const authSpan = document.createElement('span');
        authSpan.style.cssText = 'font-size:0.8rem;font-style:normal;color:var(--ink-faded)';
        authSpan.textContent = ' ' + sp.scientificNameAuthorship;
        nameDiv.appendChild(authSpan);
      }
      entry.appendChild(nameDiv);

      if (sp.commonNames && sp.commonNames.length > 0) {
        const commonDiv = document.createElement('div');
        commonDiv.className = 'species-common';
        commonDiv.textContent = sp.commonNames.slice(0, 3).join(' · ');
        entry.appendChild(commonDiv);
      }

      const familyDiv = document.createElement('div');
      familyDiv.className = 'species-family';
      familyDiv.textContent = `${sp.family?.scientificNameWithoutAuthor || ''} · ${sp.genus?.scientificNameWithoutAuthor || ''}`;
      entry.appendChild(familyDiv);

      const confDiv = document.createElement('div');
      confDiv.className = 'species-confidence';
      confDiv.innerHTML = `
        <div class="confidence-bar-track">
          <div class="confidence-bar-fill" style="width: 0%;" data-target="${esc(score)}"></div>
        </div>
        <span class="confidence-label">${esc(score)}%</span>
      `;
      entry.appendChild(confDiv);

      if (result.images && result.images.length > 0) {
        const imgsDiv = document.createElement('div');
        imgsDiv.className = 'species-images';
        result.images.slice(0, 6).forEach(img => {
          const src = img.url?.s || img.url?.m || '';
          if (isTrustedImageUrl(src)) {
            const imgEl = document.createElement('img');
            imgEl.alt = sp.scientificNameWithoutAuthor || 'Plant';
            imgEl.loading = 'lazy';
            imgEl.referrerPolicy = 'no-referrer';
            // Route through our same-origin proxy so CSP, hotlink, and referer
            // checks cannot block the thumbnail; drop it if it still fails.
            imgEl.onerror = () => imgEl.remove();
            imgEl.src = '/api/ref-image?u=' + encodeURIComponent(src);
            imgsDiv.appendChild(imgEl);
          }
        });
        if (imgsDiv.children.length > 0) entry.appendChild(imgsDiv);
      }

      const careBtn = document.createElement('button');
      careBtn.className = 'care-btn';
      careBtn.dataset.index = idx;
      careBtn.textContent = '📓 Write care guide';
      careBtn.setAttribute('aria-label', `Write care guide for ${sp.scientificNameWithoutAuthor || 'this plant'}`);
      entry.appendChild(careBtn);

      speciesList.appendChild(entry);
    });

    requestAnimationFrame(() => {
      document.querySelectorAll('.confidence-bar-fill').forEach(bar => {
        bar.style.width = bar.dataset.target + '%';
      });
    });

    resultsArea.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  // Handle write care guide clicks
  speciesList.addEventListener('click', (e) => {
    const btn = e.target.closest('.care-btn');
    if (!btn) return;

    const idx = parseInt(btn.dataset.index);
    const result = identificationResults.results[idx];

    document.querySelectorAll('.species-entry').forEach(el => el.classList.remove('selected'));
    btn.closest('.species-entry').classList.add('selected');

    generateCareGuide(result.species, btn);
  });

  async function generateCareGuide(species, btn) {
    hide(errorArea);
    hide(loadingArea);
    careGuideContent.innerHTML = '<p style="color:var(--ink-faded);font-family:Caveat,cursive;font-size:1.3rem;">✍️ Writing...</p>';
    show(careGuideArea);
    btn.disabled = true;
    btn.textContent = '✍️ Writing...';

    // Set CSRF cookie before making SSE request
    const csrfToken = await setCsrfCookie();
    if (!csrfToken) {
      careGuideContent.innerHTML = '<p style="color:var(--wine);">Session error. Please refresh the page.</p>';
      btn.disabled = false;
      btn.textContent = '📓 Write care guide';
      return;
    }

    const params = new URLSearchParams({
      scientificName: species.scientificNameWithoutAuthor,
      csrf: csrfToken,
    });
    if (species.commonNames && species.commonNames.length > 0) {
      params.set('commonNames', species.commonNames.join(','));
    }
    if (species.family?.scientificNameWithoutAuthor) {
      params.set('family', species.family.scientificNameWithoutAuthor);
    }

    careGuideArea.scrollIntoView({ behavior: 'smooth', block: 'start' });

    let rawMarkdown = '';
    const evtSource = new EventSource(`/api/care-guide?${params.toString()}`);

    evtSource.onmessage = (event) => {
      if (event.data === '[DONE]') {
        evtSource.close();
        careGuideContent.innerHTML = markdownToHtml(rawMarkdown);
        btn.disabled = false;
        btn.textContent = '📓 Write care guide';
        return;
      }

      try {
        const data = JSON.parse(event.data);
        if (data.error) {
          evtSource.close();
          careGuideContent.innerHTML = `<p style="color:var(--wine);">Error: ${esc(data.error)}</p>`;
          btn.disabled = false;
          btn.textContent = '📓 Write care guide';
          return;
        }
        if (data.text) {
          rawMarkdown += data.text;
          careGuideContent.innerHTML = markdownToHtml(rawMarkdown) + '<span class="typing-cursor">▌</span>';
        }
      } catch (e) { /* skip */ }
    };

    evtSource.onerror = () => {
      evtSource.close();
      if (rawMarkdown) {
        careGuideContent.innerHTML = markdownToHtml(rawMarkdown);
      } else {
        careGuideContent.innerHTML = '<p style="color:var(--wine);">Connection lost. Try again.</p>';
      }
      btn.disabled = false;
      btn.textContent = '📓 Write care guide';
    };
  }

  // Simple markdown parser with HTML escaping
  function markdownToHtml(md) {
    if (!md) return '<p>No care guide available.</p>';

    let html = md
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/^### (.+)$/gm, '<h3>$1</h3>')
      .replace(/^## (.+)$/gm, '<h2>$1</h2>')
      .replace(/^# (.+)$/gm, '<h2>$1</h2>')
      .replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>')
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.+?)\*/g, '<em>$1</em>')
      .replace(/`(.+?)`/g, '<code style="background:var(--parchment-dark);padding:0.1rem 0.3rem;border-radius:2px;font-size:0.8rem;">$1</code>')
      .replace(/^---$/gm, '<hr class="divider" style="margin:1.5rem 0;" />')
      .replace(/^[\-\*] (.+)$/gm, '<li>$1</li>')
      .replace(/^\d+\. (.+)$/gm, '<li>$1</li>');

    html = html.replace(/((?:<li>.*<\/li>\n?)+)/g, '<ul>$1</ul>');

    html = html
      .split('\n\n')
      .map(block => {
        block = block.trim();
        if (!block) return '';
        if (block.startsWith('<')) return block;
        return `<p>${block.replace(/\n/g, '<br>')}</p>`;
      })
      .join('\n');

    return html;
  }

  // Error recovery handler
  tryAgainBtn.addEventListener('click', () => {
    hide(errorArea);
    if (currentFile) {
      identifyBtn.classList.add('visible');
    }
  });

})();
