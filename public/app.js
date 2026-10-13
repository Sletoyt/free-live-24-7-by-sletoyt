/**
 * Cute Sky Dual-Ratio Cloud Playout & Auto Color-Detect Web-OBS Client
 * Project: free-live-24-7-by-sletoyt
 * Features:
 *  - Side-by-Side Simultaneous 16:9 & 9:16 Live Scene Editor
 *  - Shared Scene Sources with Independent 16:9 (rect169) & 9:16 (rect916) Placement
 *  - 3 Scene Types: Default (Max 1), Color-Detect (Full-Screen Auto Trigger), Network-Error (Auto Fallback)
 *  - Real-Time Full-Screen Color Detector (Auto switches scene on color match & reverts to Default)
 *  - Simultaneous Dual Live Streaming (16:9 Stream Key + 9:16 Shorts Stream Key)
 *  - Cloud File System (Upload, Download, Preview & Pick BG Music, Logos, Videos)
 */

(function () {
  'use strict';

  const socket = io();

  // ---------------------------------------------------------------------------
  // 1. State Management
  // ---------------------------------------------------------------------------
  let instancesData = [];
  let cloudFilesList = [];
  let currentFileCategory = 'all';
  let fileSearchQuery = '';

  // Active Studio State
  let activeInstanceId = null;
  let studioScenes = [];
  let activeSceneId = null;
  let selectedSourceId = null;
  let autoSceneSwitch = true;
  let saveDebounceTimer = null;

  // Incoming Live Window + Voiceover Feed (OBS RTMP FLV or Browser DisplayMedia)
  let incomingFlvPlayer = null;
  const incomingVideoEl = document.createElement('video');
  incomingVideoEl.autoplay = true;
  incomingVideoEl.muted = false;
  incomingVideoEl.playsInline = true;
  incomingVideoEl.crossOrigin = 'anonymous';
  let browserDisplayStream = null;
  let hasIncomingSignal = false;

  // Media Element Cache for Sources (id -> HTMLImageElement | HTMLVideoElement | HTMLAudioElement)
  const mediaElementsMap = new Map();

  // Dual Canvas Dragging State
  let activeDragCanvas = null; // '16:9' | '9:16'
  let isDragging = false;
  let isResizing = false;
  let dragStartPos = { x: 0, y: 0 };
  let initialRect = null;

  // Dual Broadcast MediaRecorders & Web Audio Mixer
  let isDualLive = false;
  let recorder169 = null;
  let recorder916 = null;
  let audioCtx = null;
  let audioDestNode = null;
  let micStream = null;
  let isMicEnabled = false;
  let micGainNode = null;
  let incomingAudioGain = null;
  const connectedMediaNodes = new WeakMap();

  // Offscreen 16x16 Canvas for Client-Side Full-Screen Color Detection
  const colorSampleCanvas = document.createElement('canvas');
  colorSampleCanvas.width = 16;
  colorSampleCanvas.height = 16;
  const colorSampleCtx = colorSampleCanvas.getContext('2d', { willReadFrequently: true });
  let noColorMatchCount = 0;

  // Logs State
  let logsList = [];
  let autoScrollLogs = true;
  let currentLogLevel = 'ALL';
  let logSearchQuery = '';

  // DOM Elements
  const vpsIpDisplay = document.getElementById('vpsIpDisplay');
  const activeStreamsCounter = document.getElementById('activeStreamsCounter');
  const filesCounterBadge = document.getElementById('filesCounterBadge');
  const instancesGrid = document.getElementById('instancesGrid');

  // Studio DOM Elements
  const studioModal = document.getElementById('studioModal');
  const studioInstanceName = document.getElementById('studioInstanceName');
  const chkAutoSceneSwitch = document.getElementById('chkAutoSceneSwitch');
  const detectedColorSwatch = document.getElementById('detectedColorSwatch');
  const detectedColorCode = document.getElementById('detectedColorCode');
  const studioObsSignalPill = document.getElementById('studioObsSignalPill');
  const saveStatusTag = document.getElementById('saveStatusTag');
  const studioScenesList = document.getElementById('studioScenesList');
  const activeSceneConfigBox = document.getElementById('activeSceneConfigBox');
  const studioSourcesList = document.getElementById('studioSourcesList');
  const studioPropertiesForm = document.getElementById('studioPropertiesForm');
  const bottomActiveSceneName = document.getElementById('bottomActiveSceneName');

  const canvas169 = document.getElementById('canvas169');
  const canvas916 = document.getElementById('canvas916');
  const viewport169 = document.getElementById('viewport169');
  const viewport916 = document.getElementById('viewport916');
  const ctx169 = canvas169.getContext('2d');
  const ctx916 = canvas916.getContext('2d');

  const studioGoLiveBtn = document.getElementById('studioGoLiveBtn');
  const studioGoLiveText = document.getElementById('studioGoLiveText');
  const studioMicToggle = document.getElementById('studioMicToggle');

  const currentHost = window.location.hostname || '127.0.0.1';
  if (vpsIpDisplay) vpsIpDisplay.textContent = currentHost;

  // ---------------------------------------------------------------------------
  // 2. Navigation Tabs & Mobile Studio Switcher
  // ---------------------------------------------------------------------------
  function switchMainTab(tabId) {
    document.querySelectorAll('.tab-pane').forEach((p) => p.classList.remove('active'));
    document.querySelectorAll('.nav-tab').forEach((t) => t.classList.remove('active'));
    document.querySelectorAll('.mobile-tab-btn').forEach((b) => b.classList.remove('active'));

    const pane = document.getElementById(tabId);
    if (pane) pane.classList.add('active');

    const nav = document.querySelector(`.nav-tab[data-tab="${tabId}"]`);
    if (nav) nav.classList.add('active');

    const mob = document.querySelector(`.mobile-tab-btn[data-tab="${tabId}"]`);
    if (mob) mob.classList.add('active');

    if (tabId === 'tab-files') fetchCloudFiles();
    if (tabId === 'tab-system') fetchSystemStatus();
  }

  document.querySelectorAll('.nav-tab, .mobile-tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => switchMainTab(btn.getAttribute('data-tab')));
  });

  document.querySelectorAll('.studio-mob-tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.studio-mob-tab').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      const panel = btn.getAttribute('data-panel');
      const workArea = document.getElementById('studioWorkArea');
      workArea.className = 'studio-work-area';
      if (panel === 'panel-scenes') workArea.classList.add('mob-scenes');
      if (panel === 'panel-props') workArea.classList.add('mob-props');
      setTimeout(fitDualCanvases, 30);
    });
  });

  // ---------------------------------------------------------------------------
  // 3. Dual Side-by-Side Canvas Auto-Fit Engine (16:9 + 9:16 Together!)
  // ---------------------------------------------------------------------------
  function fitSingleCanvas(viewport, canvas, targetRatio) {
    if (!viewport || !canvas) return;
    const pad = 16;
    const availW = Math.max(80, viewport.clientWidth - pad);
    const availH = Math.max(80, viewport.clientHeight - pad);

    let dispW, dispH;
    if (availW / availH > targetRatio) {
      dispH = availH;
      dispW = Math.round(dispH * targetRatio);
    } else {
      dispW = availW;
      dispH = Math.round(dispW / targetRatio);
    }

    canvas.style.width = `${dispW}px`;
    canvas.style.height = `${dispH}px`;
  }

  function fitDualCanvases() {
    fitSingleCanvas(viewport169, canvas169, 16 / 9);
    fitSingleCanvas(viewport916, canvas916, 9 / 16);
  }

  window.addEventListener('resize', fitDualCanvases);
  if (typeof ResizeObserver !== 'undefined') {
    const ro = new ResizeObserver(() => fitDualCanvases());
    if (viewport169) ro.observe(viewport169);
    if (viewport916) ro.observe(viewport916);
  }

  // ---------------------------------------------------------------------------
  // 4. Cloud File System (Upload, Download, Rename, Delete, Studio Picker)
  // ---------------------------------------------------------------------------
  const globalFileInput = document.getElementById('globalFileInput');
  const uploadDropzone = document.getElementById('uploadDropzone');
  const uploadProgressWrap = document.getElementById('uploadProgressWrap');
  const uploadProgressBar = document.getElementById('uploadProgressBar');
  const uploadProgressText = document.getElementById('uploadProgressText');
  const filesGrid = document.getElementById('filesGrid');

  async function fetchCloudFiles() {
    try {
      const res = await fetch('/api/files');
      const data = await res.json();
      cloudFilesList = data.files || [];
      if (filesCounterBadge) filesCounterBadge.textContent = cloudFilesList.length;
      renderCloudFilesGrid();
      renderPickerFilesList();
    } catch (_) {}
  }

  socket.on('files-update', (files) => {
    cloudFilesList = files || [];
    if (filesCounterBadge) filesCounterBadge.textContent = cloudFilesList.length;
    renderCloudFilesGrid();
    renderPickerFilesList();
  });

  async function uploadFilesToServer(fileList) {
    if (!fileList || fileList.length === 0) return null;
    const formData = new FormData();
    Array.from(fileList).forEach((f) => formData.append('files', f));

    if (uploadProgressWrap) {
      uploadProgressWrap.style.display = 'block';
      uploadProgressBar.style.width = '35%';
      uploadProgressText.textContent = `Uploading ${fileList.length} file(s)...`;
    }

    try {
      const res = await fetch('/api/files/upload', {
        method: 'POST',
        body: formData
      });
      const data = await res.json();
      if (uploadProgressBar) uploadProgressBar.style.width = '100%';
      setTimeout(() => {
        if (uploadProgressWrap) uploadProgressWrap.style.display = 'none';
      }, 800);
      await fetchCloudFiles();
      return data;
    } catch (err) {
      if (uploadProgressWrap) uploadProgressWrap.style.display = 'none';
      alert('File upload failed: ' + err.message);
      return null;
    }
  }

  document.getElementById('btnTriggerFileUpload').addEventListener('click', () => globalFileInput.click());
  uploadDropzone.addEventListener('click', () => globalFileInput.click());

  globalFileInput.addEventListener('change', async (e) => {
    if (e.target.files.length > 0) {
      await uploadFilesToServer(e.target.files);
      globalFileInput.value = '';
    }
  });

  uploadDropzone.addEventListener('dragover', (e) => {
    e.preventDefault();
    uploadDropzone.classList.add('dragover');
  });
  uploadDropzone.addEventListener('dragleave', () => uploadDropzone.classList.remove('dragover'));
  uploadDropzone.addEventListener('drop', async (e) => {
    e.preventDefault();
    uploadDropzone.classList.remove('dragover');
    if (e.dataTransfer.files.length > 0) {
      await uploadFilesToServer(e.dataTransfer.files);
    }
  });

  document.querySelectorAll('.pill-filter').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.pill-filter').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      currentFileCategory = btn.getAttribute('data-cat');
      renderCloudFilesGrid();
    });
  });

  document.getElementById('fileSearchInput').addEventListener('input', (e) => {
    fileSearchQuery = e.target.value.trim().toLowerCase();
    renderCloudFilesGrid();
  });

  function formatBytes(bytes) {
    if (!bytes) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  }

  function renderCloudFilesGrid() {
    if (!filesGrid) return;
    const filtered = cloudFilesList.filter((f) => {
      if (currentFileCategory !== 'all' && f.category !== currentFileCategory) return false;
      if (fileSearchQuery && !f.name.toLowerCase().includes(fileSearchQuery)) return false;
      return true;
    });

    if (filtered.length === 0) {
      filesGrid.innerHTML = `
        <div style="grid-column: 1/-1; text-align:center; padding: 36px; background: rgba(255,255,255,0.75); border-radius: 18px; border: 2px dashed var(--sky-border);">
          <h3>☁️ No Media Files Found</h3>
          <p style="color: var(--text-slate); font-size: 13px; margin-top: 4px;">Upload your BG Music (.mp3), Logos (.png), or Video Loops (.mp4) above!</p>
        </div>
      `;
      return;
    }

    filesGrid.innerHTML = '';
    filtered.forEach((f) => {
      const card = document.createElement('div');
      card.className = 'file-card';

      let previewHtml = `<div style="font-size:36px;">📄</div>`;
      if (f.category === 'image') {
        previewHtml = `<img src="${f.url}" alt="${escapeHtml(f.name)}">`;
      } else if (f.category === 'video') {
        previewHtml = `<video src="${f.url}" muted loop controls preload="metadata"></video>`;
      } else if (f.category === 'audio') {
        previewHtml = `
          <div style="display:flex;flex-direction:column;align-items:center;gap:8px;width:90%;">
            <span style="font-size:28px;">🎵</span>
            <audio src="${f.url}" controls style="width:100%;height:32px;"></audio>
          </div>
        `;
      }

      card.innerHTML = `
        <div class="file-preview-box">${previewHtml}</div>
        <div class="file-meta-title" title="${escapeHtml(f.name)}">${escapeHtml(f.name)}</div>
        <div class="file-meta-sub">
          <span>${f.category.toUpperCase()}</span>
          <span>${formatBytes(f.size)}</span>
        </div>
        <div class="file-actions">
          <a href="${f.downloadUrl}" download class="btn btn-xs btn-sky-soft" style="flex:1;">⬇ Download</a>
          <button class="btn btn-xs btn-sky-soft" onclick="window.renameCloudFile('${escapeHtml(f.name)}')">✏️</button>
          <button class="btn btn-xs btn-danger-soft" onclick="window.deleteCloudFile('${escapeHtml(f.name)}')">🗑</button>
        </div>
      `;
      filesGrid.appendChild(card);
    });
  }

  window.renameCloudFile = async function (oldName) {
    const newName = prompt('Enter new file name (keep extension):', oldName);
    if (!newName || newName.trim() === oldName) return;
    await fetch(`/api/files/${encodeURIComponent(oldName)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ newName: newName.trim() })
    });
  };

  window.deleteCloudFile = async function (name) {
    if (!confirm(`Delete "${name}" from Cloud File System?`)) return;
    await fetch(`/api/files/${encodeURIComponent(name)}`, { method: 'DELETE' });
  };

  // Studio File Picker Modal
  const filePickerModal = document.getElementById('filePickerModal');
  const pickerFilesList = document.getElementById('pickerFilesList');
  const pickerSearchInput = document.getElementById('pickerSearchInput');

  function renderPickerFilesList() {
    if (!pickerFilesList) return;
    const q = (pickerSearchInput?.value || '').trim().toLowerCase();
    const list = cloudFilesList.filter((f) => !q || f.name.toLowerCase().includes(q));

    if (list.length === 0) {
      pickerFilesList.innerHTML = `<p class="empty-panel-hint">No uploaded files yet. Click "☁️ + Upload New" above!</p>`;
      return;
    }

    pickerFilesList.innerHTML = '';
    list.forEach((f) => {
      const icon = f.category === 'audio' ? '🎵 BG Music' : f.category === 'image' ? '🖼️ Logo/Image' : '🎬 Video';
      const row = document.createElement('div');
      row.className = 'picker-file-item';
      row.innerHTML = `
        <div>
          <strong>${escapeHtml(f.name)}</strong>
          <div style="font-size:11px;color:var(--text-muted);">${icon} • ${formatBytes(f.size)}</div>
        </div>
        <button class="btn btn-xs btn-sakura">➕ Add to Scene (16:9 & 9:16)</button>
      `;
      row.querySelector('button').addEventListener('click', () => {
        addFileSourceToActiveScene(f);
        filePickerModal.style.display = 'none';
      });
      pickerFilesList.appendChild(row);
    });
  }

  if (pickerSearchInput) {
    pickerSearchInput.addEventListener('input', renderPickerFilesList);
  }

  document.getElementById('btnAddFileSource').addEventListener('click', () => {
    fetchCloudFiles();
    filePickerModal.style.display = 'flex';
  });

  document.getElementById('btnCloseFilePicker').addEventListener('click', () => {
    filePickerModal.style.display = 'none';
  });

  document.getElementById('btnPickerUploadNew').addEventListener('click', () => {
    const tempInput = document.createElement('input');
    tempInput.type = 'file';
    tempInput.multiple = true;
    tempInput.accept = 'audio/*,video/*,image/*';
    tempInput.onchange = async (e) => {
      const res = await uploadFilesToServer(e.target.files);
      if (res && res.files && res.files.length > 0) {
        renderPickerFilesList();
      }
    };
    tempInput.click();
  });

  document.getElementById('btnQuickUploadSource').addEventListener('click', () => {
    const tempInput = document.createElement('input');
    tempInput.type = 'file';
    tempInput.accept = 'audio/*,video/*,image/*';
    tempInput.onchange = async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const res = await uploadFilesToServer([file]);
      if (res && res.uploaded && res.uploaded[0]) {
        const uploadedName = res.uploaded[0];
        const found = cloudFilesList.find((f) => f.name === uploadedName);
        if (found) addFileSourceToActiveScene(found);
      }
    };
    tempInput.click();
  });

  // ---------------------------------------------------------------------------
  // 5. Dual Scene Studio & 3 Scene Types (Default, Color-Detect, Network-Error)
  // ---------------------------------------------------------------------------
  function getActiveSceneObj() {
    return studioScenes.find((s) => s.id === activeSceneId) || studioScenes[0];
  }

  function openDualStudio(inst) {
    activeInstanceId = inst.id;
    studioInstanceName.textContent = `☁️ Dual Studio: ${inst.name}`;
    studioScenes = JSON.parse(JSON.stringify(inst.scenes || []));
    activeSceneId = inst.activeSceneId || (studioScenes[0] && studioScenes[0].id);
    autoSceneSwitch = inst.autoSceneSwitch !== false;
    chkAutoSceneSwitch.checked = autoSceneSwitch;

    const currentScene = getActiveSceneObj();
    selectedSourceId = currentScene && currentScene.sources[0] ? currentScene.sources[0].id : null;

    rehydrateAllSceneMedia();
    connectIncomingObsStream(inst);
    syncSceneAudioPlayback();

    renderStudioScenesList();
    renderActiveSceneConfig();
    renderStudioSourcesList();
    renderSourceProperties();
    syncStudioLiveButton(inst);
    updateObsSignalUI(inst);

    studioModal.style.display = 'flex';
    setTimeout(fitDualCanvases, 50);
  }

  function updateObsSignalUI(inst) {
    if (!studioObsSignalPill) return;
    if (browserDisplayStream || (inst && inst.isPublishing)) {
      hasIncomingSignal = true;
      studioObsSignalPill.textContent = browserDisplayStream
        ? '🖥️ Browser Window + Mic Active'
        : '📡 OBS Stream Connected (Live)';
      studioObsSignalPill.className = 'obs-signal-pill online';
    } else {
      hasIncomingSignal = false;
      studioObsSignalPill.textContent = '⚠️ No OBS Signal (Network Error Standby)';
      studioObsSignalPill.className = 'obs-signal-pill error';
    }
  }

  function connectIncomingObsStream(inst) {
    if (browserDisplayStream) return; // Using direct browser screen capture
    if (incomingFlvPlayer) {
      try {
        incomingFlvPlayer.destroy();
      } catch (_) {}
      incomingFlvPlayer = null;
    }

    if (flvjs.isSupported() && inst && inst.streamKey) {
      const proxyFlvUrl = `/api/flv-proxy/${inst.streamKey}.flv`;
      incomingFlvPlayer = flvjs.createPlayer({
        type: 'flv',
        isLive: true,
        hasAudio: true,
        hasVideo: true,
        url: proxyFlvUrl
      });
      incomingFlvPlayer.attachMediaElement(incomingVideoEl);
      incomingFlvPlayer.load();
      incomingFlvPlayer.play().catch(() => {});
    }
  }

  // Optional Direct Browser Window + Voiceover Share
  document.getElementById('btnShareBrowserWindow').addEventListener('click', async () => {
    try {
      browserDisplayStream = await navigator.mediaDevices.getDisplayMedia({
        video: { width: 1920, height: 1080, frameRate: 30 },
        audio: true
      });
      incomingVideoEl.srcObject = browserDisplayStream;
      incomingVideoEl.muted = true; // Avoid local speaker echo; routed to WebAudio
      await incomingVideoEl.play();
      hasIncomingSignal = true;

      const inst = instancesData.find((i) => i.id === activeInstanceId);
      updateObsSignalUI(inst);

      // If autoSceneSwitch is on and we were on network-error scene, switch to default!
      if (autoSceneSwitch) {
        const defScene = studioScenes.find((s) => s.type === 'default');
        if (defScene) selectActiveScene(defScene.id, 'WINDOW SHARE STARTED -> DEFAULT');
      }

      browserDisplayStream.getVideoTracks()[0].addEventListener('ended', () => {
        browserDisplayStream = null;
        incomingVideoEl.srcObject = null;
        const currInst = instancesData.find((i) => i.id === activeInstanceId);
        updateObsSignalUI(currInst);
        if (autoSceneSwitch && (!currInst || !currInst.isPublishing)) {
          const netScene = studioScenes.find((s) => s.type === 'network-error');
          if (netScene) selectActiveScene(netScene.id, 'WINDOW SHARE ENDED -> NETWORK ERROR');
        }
      });
    } catch (err) {
      alert('Window share cancelled: ' + err.message);
    }
  });

  function rehydrateAllSceneMedia() {
    studioScenes.forEach((sc) => {
      (sc.sources || []).forEach((src) => {
        if ((src.type === 'image' || src.type === 'video' || src.type === 'audio') && src.fileUrl) {
          ensureMediaElement(src);
        }
      });
    });
  }

  function ensureMediaElement(src) {
    if (!src.fileUrl) return null;
    const existing = mediaElementsMap.get(src.id);
    if (existing && existing.dataset.srcUrl === src.fileUrl) {
      return existing;
    }

    if (src.type === 'image') {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.src = src.fileUrl;
      img.dataset.srcUrl = src.fileUrl;
      mediaElementsMap.set(src.id, img);
      return img;
    }

    if (src.type === 'video') {
      const vid = document.createElement('video');
      vid.crossOrigin = 'anonymous';
      vid.src = src.fileUrl;
      vid.loop = src.loop !== false;
      vid.muted = false;
      vid.volume = src.volume !== undefined ? src.volume : 1.0;
      vid.playsInline = true;
      vid.dataset.srcUrl = src.fileUrl;
      mediaElementsMap.set(src.id, vid);
      return vid;
    }

    if (src.type === 'audio') {
      const aud = new Audio();
      aud.crossOrigin = 'anonymous';
      aud.src = src.fileUrl;
      aud.loop = src.loop !== false;
      aud.volume = src.volume !== undefined ? src.volume : 0.8;
      aud.dataset.srcUrl = src.fileUrl;
      mediaElementsMap.set(src.id, aud);
      return aud;
    }
    return null;
  }

  function syncSceneAudioPlayback() {
    const activeScene = getActiveSceneObj();
    studioScenes.forEach((sc) => {
      const isCurrent = activeScene && sc.id === activeScene.id;
      (sc.sources || []).forEach((src) => {
        const el = mediaElementsMap.get(src.id);
        if (!el) return;
        if (src.type === 'audio' || src.type === 'video') {
          el.volume = src.volume !== undefined ? src.volume : 1.0;
          el.loop = src.loop !== false;
          if (isCurrent && src.visible !== false) {
            el.play().catch(() => {});
          } else {
            try {
              el.pause();
            } catch (_) {}
          }
        }
      });
    });

    // Mute/unmute incoming live audio based on scene setting
    if (incomingAudioGain && audioCtx) {
      const muteLive = activeScene && activeScene.muteIncomingAudio;
      incomingAudioGain.gain.setValueAtTime(muteLive ? 0.0 : 1.0, audioCtx.currentTime);
    }
  }

  // Switch Active Scene (Updates BOTH 16:9 and 9:16 simultaneously!)
  async function selectActiveScene(sceneId, reason = 'MANUAL') {
    const target = studioScenes.find((s) => s.id === sceneId);
    if (!target) return;

    activeSceneId = target.id;
    if (bottomActiveSceneName) bottomActiveSceneName.textContent = target.name;

    if (!target.sources.some((s) => s.id === selectedSourceId)) {
      selectedSourceId = target.sources[0] ? target.sources[0].id : null;
    }

    syncSceneAudioPlayback();
    renderStudioScenesList();
    renderActiveSceneConfig();
    renderStudioSourcesList();
    renderSourceProperties();

    if (activeInstanceId) {
      fetch(`/api/instances/${activeInstanceId}/switch-scene`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sceneId: activeSceneId, reason, autoSceneSwitch })
      }).catch(() => {});
    }
  }

  // Listen for Backend Auto-Scene Switches (Color Detect or Network Drop)
  socket.on('scene-switched', ({ instanceId, activeSceneId: newSceneId }) => {
    if (instanceId === activeInstanceId && newSceneId !== activeSceneId) {
      activeSceneId = newSceneId;
      syncSceneAudioPlayback();
      renderStudioScenesList();
      renderActiveSceneConfig();
      renderStudioSourcesList();
      renderSourceProperties();
    }
  });

  socket.on('color-telemetry', ({ instanceId, detectedColorHex }) => {
    if (instanceId === activeInstanceId && detectedColorHex) {
      if (detectedColorSwatch) detectedColorSwatch.style.background = detectedColorHex;
      if (detectedColorCode) detectedColorCode.textContent = detectedColorHex.toUpperCase();
    }
  });

  // ---------------------------------------------------------------------------
  // 6. Client-Side Full-Screen Color Detector Loop (Runs every 250ms)
  // ---------------------------------------------------------------------------
  function hexToRgb(hex) {
    const clean = String(hex || '#000000').replace('#', '').trim();
    if (clean.length !== 6) return { r: 0, g: 0, b: 0 };
    return {
      r: parseInt(clean.substring(0, 2), 16) || 0,
      g: parseInt(clean.substring(2, 4), 16) || 0,
      b: parseInt(clean.substring(4, 6), 16) || 0
    };
  }

  function rgbToHex(r, g, b) {
    const h = (n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
    return `#${h(r)}${h(g)}${h(b)}`;
  }

  setInterval(() => {
    if (!activeInstanceId || incomingVideoEl.readyState < 2 || incomingVideoEl.paused) return;

    try {
      colorSampleCtx.drawImage(incomingVideoEl, 0, 0, 16, 16);
      const data = colorSampleCtx.getImageData(0, 0, 16, 16).data;
      const totalPixels = 256;

      let sumR = 0, sumG = 0, sumB = 0;
      for (let i = 0; i < data.length; i += 4) {
        sumR += data[i];
        sumG += data[i + 1];
        sumB += data[i + 2];
      }

      const avgHex = rgbToHex(sumR / totalPixels, sumG / totalPixels, sumB / totalPixels);
      if (detectedColorSwatch) detectedColorSwatch.style.background = avgHex;
      if (detectedColorCode) detectedColorCode.textContent = avgHex.toUpperCase();

      if (!autoSceneSwitch) return;

      // Check all 'color-detect' scenes
      const colorScenes = studioScenes.filter((s) => s.type === 'color-detect');
      let matchedScene = null;

      for (const sc of colorScenes) {
        const target = hexToRgb(sc.triggerColor);
        const tol = Number(sc.tolerance) || 35;
        let matches = 0;

        for (let i = 0; i < data.length; i += 4) {
          const dist = Math.max(
            Math.abs(data[i] - target.r),
            Math.abs(data[i + 1] - target.g),
            Math.abs(data[i + 2] - target.b)
          );
          if (dist <= tol) matches++;
        }

        if (matches / totalPixels >= 0.80) {
          matchedScene = sc;
          break;
        }
      }

      if (matchedScene) {
        noColorMatchCount = 0;
        if (activeSceneId !== matchedScene.id) {
          selectActiveScene(matchedScene.id, `AUTO COLOR DETECT (${matchedScene.triggerColor})`);
        }
      } else {
        noColorMatchCount++;
        const curr = getActiveSceneObj();
        if (curr && curr.type === 'color-detect' && noColorMatchCount >= 3) {
          const defScene = studioScenes.find((s) => s.type === 'default');
          if (defScene && activeSceneId !== defScene.id) {
            selectActiveScene(defScene.id, 'SCREEN COLOR CLEARED -> DEFAULT');
          }
        }
      }
    } catch (_) {}
  }, 250);

  chkAutoSceneSwitch.addEventListener('change', (e) => {
    autoSceneSwitch = e.target.checked;
    triggerSaveScenes();
  });

  // ---------------------------------------------------------------------------
  // 7. Scene UI Rendering & Scene Creation (3 Scene Types)
  // ---------------------------------------------------------------------------
  const addSceneBox = document.getElementById('addSceneBox');
  const newSceneName = document.getElementById('newSceneName');
  const newSceneType = document.getElementById('newSceneType');
  const newSceneColorGroup = document.getElementById('newSceneColorGroup');
  const newSceneTriggerColor = document.getElementById('newSceneTriggerColor');
  const newSceneTriggerHex = document.getElementById('newSceneTriggerHex');

  document.getElementById('btnOpenAddScene').addEventListener('click', () => {
    addSceneBox.style.display = addSceneBox.style.display === 'none' ? 'flex' : 'none';
  });

  document.getElementById('btnCancelAddScene').addEventListener('click', () => {
    addSceneBox.style.display = 'none';
  });

  newSceneType.addEventListener('change', (e) => {
    newSceneColorGroup.style.display = e.target.value === 'color-detect' ? 'flex' : 'none';
  });

  newSceneTriggerColor.addEventListener('input', (e) => {
    newSceneTriggerHex.value = e.target.value;
  });
  newSceneTriggerHex.addEventListener('input', (e) => {
    if (/^#[0-9a-fA-F]{6}$/.test(e.target.value)) {
      newSceneTriggerColor.value = e.target.value;
    }
  });

  document.getElementById('btnPickCurrentScreenColor').addEventListener('click', () => {
    const hex = detectedColorCode.textContent;
    if (hex && hex.startsWith('#')) {
      newSceneTriggerColor.value = hex.toLowerCase();
      newSceneTriggerHex.value = hex.toLowerCase();
    }
  });

  document.getElementById('btnConfirmAddScene').addEventListener('click', () => {
    const name = newSceneName.value.trim() || `Scene ${studioScenes.length + 1}`;
    let type = newSceneType.value;

    // Enforce Max 1 Default Scene rule
    if (type === 'default' && studioScenes.some((s) => s.type === 'default')) {
      alert('Maximum 1 Default Scene is allowed! Converting existing Default Scene or setting this as Color-Detect.');
      return;
    }

    const newScene = {
      id: 'scene_' + Date.now(),
      name,
      type,
      triggerColor: newSceneTriggerHex.value || '#000000',
      tolerance: 35,
      muteIncomingAudio: type !== 'default',
      sources: []
    };

    studioScenes.push(newScene);
    addSceneBox.style.display = 'none';
    newSceneName.value = '';
    selectActiveScene(newScene.id, 'NEW SCENE CREATED');
    triggerSaveScenes();
  });

  function renderStudioScenesList() {
    if (!studioScenesList) return;
    studioScenesList.innerHTML = '';

    studioScenes.forEach((sc) => {
      const isCurrent = sc.id === activeSceneId;
      const card = document.createElement('div');
      card.className = `scene-item-card ${isCurrent ? 'active' : ''}`;

      let typeBadge = `<span class="scene-type-tag type-default">🟢 DEFAULT</span>`;
      if (sc.type === 'color-detect') {
        typeBadge = `<span class="scene-type-tag type-color-detect"><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${sc.triggerColor};margin-right:4px;border:1px solid #fff;"></span>COLOR: ${sc.triggerColor}</span>`;
      } else if (sc.type === 'network-error') {
        typeBadge = `<span class="scene-type-tag type-network-error">📡 NET ERROR</span>`;
      }

      card.innerHTML = `
        <div class="scene-card-top">
          <span>${isCurrent ? '▶ ' : ''}${escapeHtml(sc.name)}</span>
          ${typeBadge}
        </div>
        <div style="display:flex;justify-content:space-between;align-items:center;font-size:11px;color:var(--text-muted);">
          <span>${(sc.sources || []).length} shared source(s)</span>
          ${
            studioScenes.length > 1
              ? `<button class="btn-del-scene" style="background:none;border:none;color:var(--coral-red);cursor:pointer;font-size:11px;font-weight:700;">Delete</button>`
              : ''
          }
        </div>
      `;

      card.addEventListener('click', (e) => {
        if (!e.target.classList.contains('btn-del-scene')) {
          selectActiveScene(sc.id, 'MANUAL STUDIO CLICK');
        }
      });

      const delBtn = card.querySelector('.btn-del-scene');
      if (delBtn) {
        delBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          if (confirm(`Delete scene "${sc.name}"?`)) {
            studioScenes = studioScenes.filter((item) => item.id !== sc.id);
            selectActiveScene(studioScenes[0].id, 'SCENE DELETED');
            triggerSaveScenes();
          }
        });
      }

      studioScenesList.appendChild(card);
    });

    const curr = getActiveSceneObj();
    if (curr && bottomActiveSceneName) {
      bottomActiveSceneName.textContent = curr.name;
    }
  }

  function renderActiveSceneConfig() {
    const sc = getActiveSceneObj();
    if (!sc || !activeSceneConfigBox) return;

    activeSceneConfigBox.innerHTML = `
      <div style="font-weight:700;color:var(--text-navy);margin-bottom:6px;">⚙ Scene Settings: ${escapeHtml(sc.name)}</div>
      <div class="form-group">
        <label>Scene Role / Type</label>
        <select id="editSceneType" class="sky-input-sm">
          <option value="default" ${sc.type === 'default' ? 'selected' : ''}>🟢 1. Default Scene (Max 1 - Normal Live)</option>
          <option value="color-detect" ${sc.type === 'color-detect' ? 'selected' : ''}>🎨 2. Color-Detect Scene (Auto Switch on Color)</option>
          <option value="network-error" ${sc.type === 'network-error' ? 'selected' : ''}>📡 3. Network Error Scene (No OBS Signal)</option>
        </select>
      </div>
      ${
        sc.type === 'color-detect'
          ? `
        <div class="form-group" style="margin-top:6px;">
          <label>Trigger Screen Color & Tolerance (±${sc.tolerance || 35})</label>
          <div class="color-picker-row">
            <input type="color" id="editSceneColor" value="${sc.triggerColor || '#000000'}">
            <input type="text" id="editSceneHex" class="sky-input-sm" value="${sc.triggerColor || '#000000'}" style="width:85px;">
            <input type="range" id="editSceneTol" min="10" max="80" value="${sc.tolerance || 35}" style="flex:1;" title="Color matching tolerance">
          </div>
          <button type="button" class="btn btn-xs btn-sky-soft" id="btnUseDetectedForScene" style="margin-top:4px;">🎯 Grab Current Screen Color</button>
        </div>
      `
          : ''
      }
      <label style="display:flex;align-items:center;gap:6px;margin-top:8px;cursor:pointer;font-weight:600;">
        <input type="checkbox" id="editSceneMuteLive" ${sc.muteIncomingAudio ? 'checked' : ''}>
        <span>🔇 Mute Incoming Window Voiceover on this Scene</span>
      </label>
    `;

    document.getElementById('editSceneType').addEventListener('change', (e) => {
      const targetType = e.target.value;
      if (targetType === 'default' && studioScenes.some((other) => other.id !== sc.id && other.type === 'default')) {
        alert('Only 1 Default Scene is allowed! Change or remove the other Default Scene first.');
        e.target.value = sc.type;
        return;
      }
      sc.type = targetType;
      renderStudioScenesList();
      renderActiveSceneConfig();
      triggerSaveScenes();
    });

    document.getElementById('editSceneMuteLive').addEventListener('change', (e) => {
      sc.muteIncomingAudio = e.target.checked;
      syncSceneAudioPlayback();
      triggerSaveScenes();
    });

    if (sc.type === 'color-detect') {
      const colInp = document.getElementById('editSceneColor');
      const hexInp = document.getElementById('editSceneHex');
      const tolInp = document.getElementById('editSceneTol');

      colInp.addEventListener('input', (e) => {
        sc.triggerColor = e.target.value;
        hexInp.value = e.target.value;
        renderStudioScenesList();
        triggerSaveScenes();
      });

      hexInp.addEventListener('input', (e) => {
        if (/^#[0-9a-fA-F]{6}$/.test(e.target.value)) {
          sc.triggerColor = e.target.value;
          colInp.value = e.target.value;
          renderStudioScenesList();
          triggerSaveScenes();
        }
      });

      tolInp.addEventListener('input', (e) => {
        sc.tolerance = parseInt(e.target.value, 10) || 35;
        renderActiveSceneConfig();
        triggerSaveScenes();
      });

      document.getElementById('btnUseDetectedForScene').addEventListener('click', () => {
        const curHex = detectedColorCode.textContent;
        if (curHex && curHex.startsWith('#')) {
          sc.triggerColor = curHex.toLowerCase();
          renderStudioScenesList();
          renderActiveSceneConfig();
          triggerSaveScenes();
        }
      });
    }
  }

  // ---------------------------------------------------------------------------
  // 8. Shared Scene Sources & Independent 16:9 / 9:16 Coordinates
  // ---------------------------------------------------------------------------
  function addSharedSourceToScene(type, options = {}) {
    const sc = getActiveSceneObj();
    if (!sc) return;

    const id = 'src_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4);
    const newSource = {
      id,
      name: options.name || `${type.toUpperCase()} Source`,
      type, // 'live-window' | 'video' | 'image' | 'audio' | 'text'
      fileUrl: options.fileUrl || '',
      text: options.text || '🌸 CUTE SKY LIVE ☁️',
      color: options.color || '#ffffff',
      bgColor: options.bgColor || 'rgba(43, 142, 255, 0.88)',
      fontSize: options.fontSize || 46,
      volume: options.volume !== undefined ? options.volume : 1.0,
      loop: true,
      visible: true,
      // Independent 16:9 Landscape Coordinates (1920x1080)
      rect169: options.rect169 || {
        x: type === 'live-window' || type === 'video' ? 0 : 120,
        y: type === 'live-window' || type === 'video' ? 0 : 100,
        width: type === 'live-window' || type === 'video' ? 1920 : 650,
        height: type === 'live-window' || type === 'video' ? 1080 : 140,
        visible: true
      },
      // Independent 9:16 Vertical Shorts Coordinates (1080x1920)
      rect916: options.rect916 || {
        x: type === 'live-window' || type === 'video' ? 0 : 90,
        y: type === 'live-window' || type === 'video' ? 300 : 220,
        width: type === 'live-window' || type === 'video' ? 1080 : 900,
        height: type === 'live-window' || type === 'video' ? 1320 : 160,
        visible: true
      }
    };

    sc.sources.push(newSource);
    ensureMediaElement(newSource);
    selectedSourceId = newSource.id;

    syncSceneAudioPlayback();
    renderStudioSourcesList();
    renderSourceProperties();
    renderStudioScenesList();
    triggerSaveScenes();
  }

  function addFileSourceToActiveScene(fileObj) {
    if (!fileObj) return;
    if (fileObj.category === 'audio') {
      addSharedSourceToScene('audio', {
        name: `🎵 ${fileObj.name}`,
        fileUrl: fileObj.url,
        volume: 0.85
      });
    } else if (fileObj.category === 'image') {
      addSharedSourceToScene('image', {
        name: `🖼️ ${fileObj.name}`,
        fileUrl: fileObj.url,
        rect169: { x: 80, y: 60, width: 320, height: 320, visible: true },
        rect916: { x: 380, y: 120, width: 320, height: 320, visible: true }
      });
    } else {
      addSharedSourceToScene('video', {
        name: `🎬 ${fileObj.name}`,
        fileUrl: fileObj.url,
        rect169: { x: 0, y: 0, width: 1920, height: 1080, visible: true },
        rect916: { x: 0, y: 0, width: 1080, height: 1920, visible: true }
      });
    }
  }

  document.getElementById('btnAddLiveWindowSource').addEventListener('click', () => {
    addSharedSourceToScene('live-window', {
      name: '🖥️ Window + Voiceover (Live)',
      rect169: { x: 0, y: 0, width: 1920, height: 1080, visible: true },
      rect916: { x: 0, y: 350, width: 1080, height: 1220, visible: true }
    });
  });

  document.getElementById('btnAddTextSource').addEventListener('click', () => {
    addSharedSourceToScene('text', {
      name: '🔤 Cute Sky Banner',
      text: '🌸 PAUSE // BE RIGHT BACK ☁️',
      rect169: { x: 400, y: 460, width: 1120, height: 140, visible: true },
      rect916: { x: 80, y: 860, width: 920, height: 180, visible: true }
    });
  });

  function renderStudioSourcesList() {
    const sc = getActiveSceneObj();
    if (!studioSourcesList || !sc) return;
    studioSourcesList.innerHTML = '';

    for (let i = sc.sources.length - 1; i >= 0; i--) {
      const src = sc.sources[i];
      const isSel = src.id === selectedSourceId;

      const row = document.createElement('div');
      row.style.padding = '8px 10px';
      row.style.borderRadius = '10px';
      row.style.background = isSel ? 'var(--sky-light)' : 'var(--cloud-soft)';
      row.style.border = isSel ? '2px solid var(--sky-primary)' : '2px solid var(--sky-border)';
      row.style.display = 'flex';
      row.style.justifyContent = 'space-between';
      row.style.alignItems = 'center';
      row.style.cursor = 'pointer';

      row.innerHTML = `
        <span style="font-size:12px;font-weight:700;color:var(--text-navy);">${escapeHtml(src.name)}</span>
        <div style="display:flex;gap:6px;">
          <button class="btn-vis" style="background:none;border:none;cursor:pointer;">${src.visible !== false ? '👁' : '🚫'}</button>
        </div>
      `;

      row.addEventListener('click', (e) => {
        if (!e.target.classList.contains('btn-vis')) {
          selectedSourceId = src.id;
          renderStudioSourcesList();
          renderSourceProperties();
        }
      });

      row.querySelector('.btn-vis').addEventListener('click', (e) => {
        e.stopPropagation();
        src.visible = src.visible === false ? true : false;
        syncSceneAudioPlayback();
        renderStudioSourcesList();
        triggerSaveScenes();
      });

      studioSourcesList.appendChild(row);
    }
  }

  function getSelectedSource() {
    const sc = getActiveSceneObj();
    if (!sc) return null;
    return (sc.sources || []).find((s) => s.id === selectedSourceId) || null;
  }

  function renderSourceProperties() {
    const src = getSelectedSource();
    if (!src) {
      studioPropertiesForm.innerHTML = `<p class="empty-panel-hint">Select a source to set its 16:9 and 9:16 coordinates.</p>`;
      return;
    }

    if (!src.rect169) src.rect169 = { x: 0, y: 0, width: 600, height: 300, visible: true };
    if (!src.rect916) src.rect916 = { x: 0, y: 0, width: 600, height: 300, visible: true };

    studioPropertiesForm.innerHTML = `
      <div class="form-group">
        <label>Source Name</label>
        <input type="text" id="propSrcName" class="sky-input-sm" value="${escapeHtml(src.name)}">
      </div>

      ${
        src.type === 'audio' || src.type === 'video'
          ? `
        <div class="form-group" style="margin-top:8px;">
          <label>🎵 Audio Volume (${Math.round((src.volume ?? 1) * 100)}%)</label>
          <input type="range" id="propSrcVol" min="0" max="1" step="0.05" value="${src.volume ?? 1}">
        </div>
      `
          : ''
      }

      ${
        src.type === 'text'
          ? `
        <div class="form-group" style="margin-top:8px;">
          <label>Banner Text</label>
          <input type="text" id="propSrcText" class="sky-input-sm" value="${escapeHtml(src.text || '')}">
        </div>
        <div class="form-row" style="margin-top:6px;">
          <div class="form-group">
            <label>Font Size</label>
            <input type="number" id="propSrcFont" class="sky-input-sm" value="${src.fontSize || 46}">
          </div>
          <div class="form-group">
            <label>Text Color</label>
            <input type="color" id="propSrcColor" class="sky-input-sm" value="${src.color || '#ffffff'}">
          </div>
        </div>
      `
          : ''
      }

      ${
        src.type !== 'audio'
          ? `
        <!-- 16:9 INDEPENDENT COORDINATES -->
        <div class="coord-box">
          <div class="coord-box-title">
            <span>📺 16:9 Landscape Position</span>
            <label><input type="checkbox" id="propVis169" ${src.rect169.visible !== false ? 'checked' : ''}> Show</label>
          </div>
          <div class="form-row">
            <div class="form-group"><label>X</label><input type="number" id="p169X" class="sky-input-sm" value="${src.rect169.x}"></div>
            <div class="form-group"><label>Y</label><input type="number" id="p169Y" class="sky-input-sm" value="${src.rect169.y}"></div>
          </div>
          <div class="form-row" style="margin-top:4px;">
            <div class="form-group"><label>W</label><input type="number" id="p169W" class="sky-input-sm" value="${src.rect169.width}"></div>
            <div class="form-group"><label>H</label><input type="number" id="p169H" class="sky-input-sm" value="${src.rect169.height}"></div>
          </div>
        </div>

        <!-- 9:16 INDEPENDENT COORDINATES -->
        <div class="coord-box box-916">
          <div class="coord-box-title">
            <span>📱 9:16 Vertical Shorts Position</span>
            <label><input type="checkbox" id="propVis916" ${src.rect916.visible !== false ? 'checked' : ''}> Show</label>
          </div>
          <div class="form-row">
            <div class="form-group"><label>X</label><input type="number" id="p916X" class="sky-input-sm" value="${src.rect916.x}"></div>
            <div class="form-group"><label>Y</label><input type="number" id="p916Y" class="sky-input-sm" value="${src.rect916.y}"></div>
          </div>
          <div class="form-row" style="margin-top:4px;">
            <div class="form-group"><label>W</label><input type="number" id="p916W" class="sky-input-sm" value="${src.rect916.width}"></div>
            <div class="form-group"><label>H</label><input type="number" id="p916H" class="sky-input-sm" value="${src.rect916.height}"></div>
          </div>
        </div>
      `
          : `<p class="tiny-hint" style="margin-top:10px;">🎵 Background music plays automatically whenever this scene is active on both 16:9 and 9:16!</p>`
      }

      <button class="btn btn-xs btn-danger-soft" id="btnDeleteSource" style="width:100%;margin-top:12px;">🗑 Remove Source from Scene</button>
    `;

    document.getElementById('propSrcName').addEventListener('input', (e) => {
      src.name = e.target.value;
      renderStudioSourcesList();
      triggerSaveScenes();
    });

    const volInp = document.getElementById('propSrcVol');
    if (volInp) {
      volInp.addEventListener('input', (e) => {
        src.volume = parseFloat(e.target.value) || 0;
        syncSceneAudioPlayback();
        renderSourceProperties();
        triggerSaveScenes();
      });
    }

    if (src.type === 'text') {
      document.getElementById('propSrcText').addEventListener('input', (e) => {
        src.text = e.target.value;
        triggerSaveScenes();
      });
      document.getElementById('propSrcFont').addEventListener('input', (e) => {
        src.fontSize = parseInt(e.target.value, 10) || 32;
        triggerSaveScenes();
      });
      document.getElementById('propSrcColor').addEventListener('input', (e) => {
        src.color = e.target.value;
        triggerSaveScenes();
      });
    }

    if (src.type !== 'audio') {
      const bindCoord = (id, rectObj, prop) => {
        const el = document.getElementById(id);
        if (el) {
          el.addEventListener('input', (e) => {
            rectObj[prop] = parseInt(e.target.value, 10) || 0;
            triggerSaveScenes();
          });
        }
      };
      bindCoord('p169X', src.rect169, 'x');
      bindCoord('p169Y', src.rect169, 'y');
      bindCoord('p169W', src.rect169, 'width');
      bindCoord('p169H', src.rect169, 'height');
      bindCoord('p916X', src.rect916, 'x');
      bindCoord('p916Y', src.rect916, 'y');
      bindCoord('p916W', src.rect916, 'width');
      bindCoord('p916H', src.rect916, 'height');

      document.getElementById('propVis169').addEventListener('change', (e) => {
        src.rect169.visible = e.target.checked;
        triggerSaveScenes();
      });
      document.getElementById('propVis916').addEventListener('change', (e) => {
        src.rect916.visible = e.target.checked;
        triggerSaveScenes();
      });
    }

    document.getElementById('btnDeleteSource').addEventListener('click', () => {
      const sc = getActiveSceneObj();
      if (!sc) return;
      sc.sources = sc.sources.filter((s) => s.id !== src.id);
      selectedSourceId = sc.sources[0] ? sc.sources[0].id : null;
      syncSceneAudioPlayback();
      renderStudioSourcesList();
      renderSourceProperties();
      triggerSaveScenes();
    });
  }

  // Quick Fit & Center Buttons for 16:9 and 9:16 Monitors
  document.getElementById('btnFitSource169').addEventListener('click', () => {
    const src = getSelectedSource();
    if (!src || !src.rect169) return;
    src.rect169 = { x: 0, y: 0, width: 1920, height: 1080, visible: true };
    renderSourceProperties();
    triggerSaveScenes();
  });

  document.getElementById('btnCenterSource169').addEventListener('click', () => {
    const src = getSelectedSource();
    if (!src || !src.rect169) return;
    src.rect169.x = Math.round((1920 - src.rect169.width) / 2);
    src.rect169.y = Math.round((1080 - src.rect169.height) / 2);
    renderSourceProperties();
    triggerSaveScenes();
  });

  document.getElementById('btnFitSource916').addEventListener('click', () => {
    const src = getSelectedSource();
    if (!src || !src.rect916) return;
    src.rect916 = { x: 0, y: 0, width: 1080, height: 1920, visible: true };
    renderSourceProperties();
    triggerSaveScenes();
  });

  document.getElementById('btnCenterSource916').addEventListener('click', () => {
    const src = getSelectedSource();
    if (!src || !src.rect916) return;
    src.rect916.x = Math.round((1080 - src.rect916.width) / 2);
    src.rect916.y = Math.round((1920 - src.rect916.height) / 2);
    renderSourceProperties();
    triggerSaveScenes();
  });

  // ---------------------------------------------------------------------------
  // 9. Dual Canvas Render Loop & Independent Drag/Resize on Both Screens
  // ---------------------------------------------------------------------------
  function drawSceneOnCanvas(context, W, H, rectKey) {
    // Cute Sky Pastel Canvas Backdrop
    const grad = context.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, '#8fd3fe');
    grad.addColorStop(1, '#dff2ff');
    context.fillStyle = grad;
    context.fillRect(0, 0, W, H);

    const sc = getActiveSceneObj();
    if (!sc) return;

    (sc.sources || []).forEach((src) => {
      if (src.visible === false || src.type === 'audio') return;
      const r = src[rectKey];
      if (!r || r.visible === false) return;

      if (src.type === 'live-window') {
        if (incomingVideoEl.readyState >= 2) {
          context.drawImage(incomingVideoEl, r.x, r.y, r.width, r.height);
        } else {
          context.fillStyle = 'rgba(22, 50, 92, 0.78)';
          context.fillRect(r.x, r.y, r.width, r.height);
          context.fillStyle = '#ffffff';
          context.font = '700 34px Fredoka, sans-serif';
          context.textAlign = 'center';
          context.fillText('🖥️ Waiting for OBS / Window Stream...', r.x + r.width / 2, r.y + r.height / 2);
          context.textAlign = 'left';
        }
      } else if (src.type === 'image') {
        const img = ensureMediaElement(src);
        if (img && img.complete && img.naturalWidth > 0) {
          context.drawImage(img, r.x, r.y, r.width, r.height);
        }
      } else if (src.type === 'video') {
        const vid = ensureMediaElement(src);
        if (vid && vid.readyState >= 2) {
          context.drawImage(vid, r.x, r.y, r.width, r.height);
        } else {
          context.fillStyle = 'rgba(43, 142, 255, 0.35)';
          context.fillRect(r.x, r.y, r.width, r.height);
        }
      } else if (src.type === 'text') {
        context.fillStyle = src.bgColor || 'rgba(43, 142, 255, 0.88)';
        context.beginPath();
        context.roundRect(r.x, r.y, r.width, r.height, 24);
        context.fill();
        context.lineWidth = 4;
        context.strokeStyle = '#ffffff';
        context.stroke();

        context.fillStyle = src.color || '#ffffff';
        context.font = `700 ${src.fontSize || 46}px 'Fredoka', sans-serif`;
        context.textBaseline = 'middle';
        context.textAlign = 'center';
        context.fillText(src.text || '', r.x + r.width / 2, r.y + r.height / 2);
        context.textAlign = 'left';
      }

      // Draw selection frame & resize handle if selected
      if (src.id === selectedSourceId) {
        context.strokeStyle = '#ff7aa2';
        context.lineWidth = 5;
        context.strokeRect(r.x, r.y, r.width, r.height);

        context.fillStyle = '#ffffff';
        context.fillRect(r.x + r.width - 16, r.y + r.height - 16, 32, 32);
        context.strokeStyle = '#ff7aa2';
        context.strokeRect(r.x + r.width - 16, r.y + r.height - 16, 32, 32);
      }
    });
  }

  function renderDualCanvasesLoop() {
    drawSceneOnCanvas(ctx169, 1920, 1080, 'rect169');
    drawSceneOnCanvas(ctx916, 1080, 1920, 'rect916');
    requestAnimationFrame(renderDualCanvasesLoop);
  }
  renderDualCanvasesLoop();

  function getCanvasCoords(e, canvasEl) {
    const rect = canvasEl.getBoundingClientRect();
    const scaleX = canvasEl.width / rect.width;
    const scaleY = canvasEl.height / rect.height;
    let cx = e.clientX;
    let cy = e.clientY;
    if (e.touches && e.touches.length > 0) {
      cx = e.touches[0].clientX;
      cy = e.touches[0].clientY;
    }
    return {
      x: (cx - rect.left) * scaleX,
      y: (cy - rect.top) * scaleY
    };
  }

  function onCanvasDown(e, ratioKey, canvasEl) {
    const rectProp = ratioKey === '9:16' ? 'rect916' : 'rect169';
    const { x, y } = getCanvasCoords(e, canvasEl);
    const sc = getActiveSceneObj();
    if (!sc) return;

    const sel = getSelectedSource();
    if (sel && sel[rectProp] && sel.type !== 'audio') {
      const r = sel[rectProp];
      if (Math.abs(x - (r.x + r.width)) < 45 && Math.abs(y - (r.y + r.height)) < 45) {
        activeDragCanvas = ratioKey;
        isResizing = true;
        dragStartPos = { x, y };
        initialRect = { ...r };
        return;
      }
    }

    for (let i = sc.sources.length - 1; i >= 0; i--) {
      const s = sc.sources[i];
      if (s.type === 'audio' || s.visible === false) continue;
      const r = s[rectProp];
      if (r && r.visible !== false && x >= r.x && x <= r.x + r.width && y >= r.y && y <= r.y + r.height) {
        selectedSourceId = s.id;
        activeDragCanvas = ratioKey;
        isDragging = true;
        dragStartPos = { x, y };
        initialRect = { ...r };
        renderStudioSourcesList();
        renderSourceProperties();
        return;
      }
    }
  }

  function onWindowMove(e) {
    if (!isDragging && !isResizing) return;
    const canvasEl = activeDragCanvas === '9:16' ? canvas916 : canvas169;
    const rectProp = activeDragCanvas === '9:16' ? 'rect916' : 'rect169';
    const { x, y } = getCanvasCoords(e, canvasEl);
    const sel = getSelectedSource();
    if (!sel || !sel[rectProp]) return;

    if (isDragging) {
      sel[rectProp].x = Math.round(initialRect.x + (x - dragStartPos.x));
      sel[rectProp].y = Math.round(initialRect.y + (y - dragStartPos.y));
    } else if (isResizing) {
      sel[rectProp].width = Math.max(60, Math.round(initialRect.width + (x - dragStartPos.x)));
      sel[rectProp].height = Math.max(40, Math.round(initialRect.height + (y - dragStartPos.y)));
    }
    renderSourceProperties();
  }

  function onWindowUp() {
    if (isDragging || isResizing) {
      isDragging = false;
      isResizing = false;
      activeDragCanvas = null;
      triggerSaveScenes();
    }
  }

  canvas169.addEventListener('mousedown', (e) => onCanvasDown(e, '16:9', canvas169));
  canvas916.addEventListener('mousedown', (e) => onCanvasDown(e, '9:16', canvas916));
  window.addEventListener('mousemove', onWindowMove);
  window.addEventListener('mouseup', onWindowUp);

  canvas169.addEventListener('touchstart', (e) => { e.preventDefault(); onCanvasDown(e, '16:9', canvas169); }, { passive: false });
  canvas916.addEventListener('touchstart', (e) => { e.preventDefault(); onCanvasDown(e, '9:16', canvas916); }, { passive: false });
  window.addEventListener('touchmove', (e) => { if (isDragging || isResizing) { e.preventDefault(); onWindowMove(e); } }, { passive: false });
  window.addEventListener('touchend', onWindowUp);

  // ---------------------------------------------------------------------------
  // 10. Save Scenes & Simultaneous Dual Live Streaming (16:9 + 9:16)
  // ---------------------------------------------------------------------------
  async function saveScenesToServer(showAlert = false) {
    if (!activeInstanceId) return;
    if (saveStatusTag) saveStatusTag.textContent = 'Saving...';

    try {
      await fetch(`/api/instances/${activeInstanceId}/scenes`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scenes: studioScenes,
          activeSceneId,
          autoSceneSwitch
        })
      });
      if (saveStatusTag) saveStatusTag.textContent = '✓ Saved';
      if (showAlert) alert('☁️ All Scenes & 16:9 + 9:16 Layouts Saved!');
    } catch (_) {
      if (saveStatusTag) saveStatusTag.textContent = 'Saved Locally';
    }
  }

  function triggerSaveScenes() {
    clearTimeout(saveDebounceTimer);
    saveDebounceTimer = setTimeout(() => saveScenesToServer(false), 900);
  }

  document.getElementById('btnSaveScenes').addEventListener('click', () => saveScenesToServer(true));
  document.getElementById('btnCloseStudioModal').addEventListener('click', () => {
    saveScenesToServer(false);
    studioModal.style.display = 'none';
  });

  // Web Audio Mixer (Carrier + Incoming Window Audio + Scene BG Music + Optional Mic)
  function getMixedAudioTrack() {
    if (!audioCtx) {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      audioCtx = new AudioContextClass();
      audioDestNode = audioCtx.createMediaStreamDestination();

      // Inaudible carrier oscillator so RTMP never drops during silent transitions
      const osc = audioCtx.createOscillator();
      const oscGain = audioCtx.createGain();
      oscGain.gain.setValueAtTime(0.0001, audioCtx.currentTime);
      osc.connect(oscGain);
      oscGain.connect(audioDestNode);
      osc.start();

      // Incoming Window/OBS audio node
      incomingAudioGain = audioCtx.createGain();
      incomingAudioGain.connect(audioDestNode);
      try {
        const incNode = audioCtx.createMediaElementSource(incomingVideoEl);
        incNode.connect(incomingAudioGain);
        incNode.connect(audioCtx.destination);
      } catch (_) {}

      // Mic gain node
      micGainNode = audioCtx.createGain();
      micGainNode.gain.setValueAtTime(isMicEnabled ? 1.0 : 0.0, audioCtx.currentTime);
      micGainNode.connect(audioDestNode);
    }

    if (audioCtx.state === 'suspended') audioCtx.resume();

    // Connect all scene audio/video elements into the WebAudio mixer
    mediaElementsMap.forEach((el) => {
      if ((el.tagName === 'AUDIO' || el.tagName === 'VIDEO') && !connectedMediaNodes.has(el)) {
        try {
          const node = audioCtx.createMediaElementSource(el);
          node.connect(audioDestNode);
          node.connect(audioCtx.destination);
          connectedMediaNodes.set(el, node);
        } catch (_) {}
      }
    });

    return audioDestNode.stream.getAudioTracks()[0];
  }

  studioMicToggle.addEventListener('click', async () => {
    if (!isMicEnabled) {
      try {
        if (!micStream) {
          micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        }
        getMixedAudioTrack();
        const src = audioCtx.createMediaStreamSource(micStream);
        src.connect(micGainNode);
        micGainNode.gain.setValueAtTime(1.0, audioCtx.currentTime);
        isMicEnabled = true;
        studioMicToggle.textContent = '🎙 Browser Mic: ON';
      } catch (err) {
        alert('Mic error: ' + err.message);
      }
    } else {
      if (micGainNode && audioCtx) micGainNode.gain.setValueAtTime(0.0, audioCtx.currentTime);
      isMicEnabled = false;
      studioMicToggle.textContent = '🎙 Browser Mic: OFF';
    }
  });

  // Start / Stop Simultaneous Dual 16:9 + 9:16 Live Stream
  studioGoLiveBtn.addEventListener('click', async () => {
    if (!activeInstanceId) return;

    if (!isDualLive) {
      try {
        await saveScenesToServer(false);
        const mixedAudioTrack = getMixedAudioTrack();

        const stream169 = canvas169.captureStream(30);
        const stream916 = canvas916.captureStream(30);

        if (mixedAudioTrack) {
          stream169.addTrack(mixedAudioTrack.clone());
          stream916.addTrack(mixedAudioTrack.clone());
        }

        const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=h264,opus')
          ? 'video/webm;codecs=h264,opus'
          : 'video/webm';

        await fetch(`/api/instances/${activeInstanceId}/start-dual-canvas`, { method: 'POST' });

        recorder169 = new MediaRecorder(stream169, { mimeType, videoBitsPerSecond: 3500000 });
        recorder916 = new MediaRecorder(stream916, { mimeType, videoBitsPerSecond: 3200000 });

        recorder169.ondataavailable = async (e) => {
          if (e.data && e.data.size > 0) {
            socket.emit('binary-chunk-169', {
              instanceId: activeInstanceId,
              chunk: await e.data.arrayBuffer()
            });
          }
        };

        recorder916.ondataavailable = async (e) => {
          if (e.data && e.data.size > 0) {
            socket.emit('binary-chunk-916', {
              instanceId: activeInstanceId,
              chunk: await e.data.arrayBuffer()
            });
          }
        };

        recorder169.start(400);
        recorder916.start(400);
        isDualLive = true;
        studioGoLiveText.textContent = '⏹ STOP DUAL LIVE (16:9 + 9:16)';
      } catch (err) {
        alert('Could not start Dual Live: ' + err.message);
      }
    } else {
      if (recorder169 && recorder169.state !== 'inactive') recorder169.stop();
      if (recorder916 && recorder916.state !== 'inactive') recorder916.stop();
      isDualLive = false;
      studioGoLiveText.textContent = '🚀 START DUAL LIVE (16:9 + 9:16 SIMULTANEOUS)';
      await fetch(`/api/instances/${activeInstanceId}/stop`, { method: 'POST' });
    }
  });

  function syncStudioLiveButton(inst) {
    if (inst && inst.status === 'live') {
      isDualLive = true;
      studioGoLiveText.textContent = '⏹ STOP DUAL LIVE (16:9 + 9:16)';
    } else {
      isDualLive = false;
      studioGoLiveText.textContent = '🚀 START DUAL LIVE (16:9 + 9:16 SIMULTANEOUS)';
    }
  }

  // ---------------------------------------------------------------------------
  // 11. Dashboard Cards & Quick Live Scene Switcher
  // ---------------------------------------------------------------------------
  socket.on('instances-update', (list) => {
    instancesData = list || [];
    if (activeStreamsCounter) {
      activeStreamsCounter.textContent = instancesData.filter((i) => i.status === 'live').length;
    }
    const currInst = instancesData.find((i) => i.id === activeInstanceId);
    if (currInst) updateObsSignalUI(currInst);
    renderInstancesGrid();
  });

  function renderInstancesGrid() {
    if (!instancesGrid) return;
    instancesGrid.innerHTML = '';

    instancesData.forEach((inst) => {
      const card = document.createElement('div');
      card.className = 'instance-card';

      const isLive = inst.status === 'live';
      const rtmpIngest = `rtmp://${currentHost}:1935/live`;
      const preview169Url = `/api/flv-proxy/${inst.streamKey}_169_preview.flv`;
      const preview916Url = `/api/flv-proxy/${inst.streamKey}_916_preview.flv`;

      const sceneButtonsHtml = (inst.scenes || [])
        .map((sc) => {
          const activeCls = sc.id === inst.activeSceneId ? 'active' : '';
          const icon = sc.type === 'default' ? '🟢' : sc.type === 'color-detect' ? '🎨' : '📡';
          return `<button class="scene-mini-pill ${activeCls}" onclick="window.quickSwitchScene('${inst.id}', '${sc.id}')">${icon} ${escapeHtml(sc.name)}</button>`;
        })
        .join('');

      card.innerHTML = `
        <div class="card-header-row">
          <div>
            <h3 class="card-inst-name">☁️ ${escapeHtml(inst.name)}</h3>
            <div class="card-tags">
              <span class="tag tag-dual">📺 16:9 + 📱 9:16 Dual Live</span>
              <span class="tag tag-pink">${inst.mode === 'playlist-loop' ? '🔁 24/7 Playlist' : '🖥️ Window + Voiceover Auto'}</span>
            </div>
          </div>
          <div class="status-pill ${isLive ? 'status-live' : 'status-offline'}">
            <span>${isLive ? '🟢 DUAL LIVE' : '⚪ OFFLINE'}</span>
          </div>
        </div>

        <div class="ingest-box">
          <div class="ingest-box-header">
            <span>🖥️ SEND WINDOW + VOICEOVER FROM OBS TO:</span>
            <span>${inst.isPublishing ? '🟢 OBS CONNECTED' : '🟠 WAITING FOR OBS'}</span>
          </div>
          <div class="field-value-row">
            <span class="field-value">Server: ${rtmpIngest}</span>
            <button class="btn btn-xs btn-sky-soft" onclick="navigator.clipboard.writeText('${rtmpIngest}');alert('Copied RTMP Server URL!');">Copy</button>
          </div>
          <div class="field-value-row">
            <span class="field-value">Stream Key: ${inst.streamKey}</span>
            <button class="btn btn-xs btn-sky-soft" onclick="navigator.clipboard.writeText('${inst.streamKey}');alert('Copied Stream Key!');">Copy</button>
          </div>
        </div>

        <!-- Live Scene Switcher right on the Card -->
        <div class="card-scenes-strip">
          <div class="strip-label">
            <span>🎬 Live Scenes (Click to Switch 16:9 & 9:16 Together):</span>
            <span>${inst.autoSceneSwitch ? '🤖 Auto-Color: ON' : 'Manual'}</span>
          </div>
          <div class="scene-pills-wrap">${sceneButtonsHtml}</div>
        </div>

        <div class="card-actions-grid">
          ${
            !isLive
              ? `<button class="btn btn-sakura btn-sm" onclick="window.startPlayout('${inst.id}')">🚀 Start Dual Live (16:9 + 9:16)</button>`
              : `<button class="btn btn-danger-soft btn-sm" onclick="window.stopPlayout('${inst.id}')">⏹ Stop Dual Broadcast</button>`
          }
          <button class="btn btn-sky btn-sm" onclick="window.openStudioById('${inst.id}')">🎨 Dual 16:9 & 9:16 Scene Studio</button>
        </div>

        <div class="card-actions-row">
          <button class="btn btn-xs btn-sky-soft" style="flex:1;" onclick="window.openPreviewPlayer('${preview169Url}', '16:9 Monitor')">👁 16:9 Monitor</button>
          <button class="btn btn-xs btn-sky-soft" style="flex:1;" onclick="window.openPreviewPlayer('${preview916Url}', '9:16 Shorts Monitor')">👁 9:16 Monitor</button>
          <button class="btn btn-xs btn-sky-soft" onclick="window.editInstance('${inst.id}')">⚙ Keys</button>
          <button class="btn btn-xs btn-danger-soft" onclick="window.deleteInstance('${inst.id}')">🗑</button>
        </div>
      `;

      instancesGrid.appendChild(card);
    });
  }

  window.quickSwitchScene = async function (instId, sceneId) {
    await fetch(`/api/instances/${instId}/switch-scene`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sceneId, reason: 'DASHBOARD QUICK SWITCH' })
    });
  };

  window.startPlayout = async function (id) {
    await fetch(`/api/instances/${id}/start`, { method: 'POST' });
  };

  window.stopPlayout = async function (id) {
    await fetch(`/api/instances/${id}/stop`, { method: 'POST' });
  };

  window.openStudioById = function (id) {
    const inst = instancesData.find((i) => i.id === id);
    if (inst) openDualStudio(inst);
  };

  window.deleteInstance = async function (id) {
    if (confirm('Delete this dual stream instance?')) {
      await fetch(`/api/instances/${id}`, { method: 'DELETE' });
    }
  };

  // Create / Edit Instance Modal
  const instanceModal = document.getElementById('instanceModal');
  const instFormId = document.getElementById('instFormId');
  const instFormName = document.getElementById('instFormName');
  const instFormMode = document.getElementById('instFormMode');
  const instForm169Primary = document.getElementById('instForm169Primary');
  const instForm169Backup = document.getElementById('instForm169Backup');
  const instForm916Primary = document.getElementById('instForm916Primary');
  const instForm916Backup = document.getElementById('instForm916Backup');
  const playlistGroup = document.getElementById('playlistGroup');
  const urlListContainer = document.getElementById('urlListContainer');

  document.getElementById('btnCreateInstanceModal').addEventListener('click', () => {
    instFormId.value = '';
    instFormName.value = '';
    instFormMode.value = 'window-voiceover-dual';
    instForm169Primary.value = '';
    instForm169Backup.value = '';
    instForm916Primary.value = '';
    instForm916Backup.value = '';
    urlListContainer.innerHTML = '';
    playlistGroup.style.display = 'none';
    instanceModal.style.display = 'flex';
  });

  window.editInstance = function (id) {
    const inst = instancesData.find((i) => i.id === id);
    if (!inst) return;
    instFormId.value = inst.id;
    instFormName.value = inst.name;
    instFormMode.value = inst.mode || 'window-voiceover-dual';
    instForm169Primary.value = inst.rtmp169Primary || '';
    instForm169Backup.value = inst.rtmp169Backup || '';
    instForm916Primary.value = inst.rtmp916Primary || '';
    instForm916Backup.value = inst.rtmp916Backup || '';
    playlistGroup.style.display = inst.mode === 'playlist-loop' ? 'flex' : 'none';
    urlListContainer.innerHTML = '';
    (inst.playlistUrls || []).forEach((u) => addUrlRow(u));
    instanceModal.style.display = 'flex';
  };

  instFormMode.addEventListener('change', (e) => {
    playlistGroup.style.display = e.target.value === 'playlist-loop' ? 'flex' : 'none';
  });

  function addUrlRow(val = '') {
    const div = document.createElement('div');
    div.style.display = 'flex';
    div.style.gap = '6px';
    div.style.marginTop = '6px';
    div.innerHTML = `
      <input type="text" class="sky-input playlist-url-inp" value="${escapeHtml(val)}" placeholder="https://example.com/video.mp4 or /uploads/video.mp4">
      <button type="button" class="btn btn-xs btn-danger-soft">&times;</button>
    `;
    div.querySelector('button').addEventListener('click', () => div.remove());
    urlListContainer.appendChild(div);
  }

  document.getElementById('btnAddUrlRow').addEventListener('click', () => addUrlRow());
  document.getElementById('btnCloseInstanceModal').addEventListener('click', () => (instanceModal.style.display = 'none'));
  document.getElementById('btnCancelInstanceModal').addEventListener('click', () => (instanceModal.style.display = 'none'));

  document.getElementById('btnSaveInstance').addEventListener('click', async () => {
    const id = instFormId.value;
    const playlistUrls = [];
    document.querySelectorAll('.playlist-url-inp').forEach((inp) => {
      if (inp.value.trim()) playlistUrls.push(inp.value.trim());
    });

    const payload = {
      name: instFormName.value.trim() || 'Dual Sky Stream',
      mode: instFormMode.value,
      rtmp169Primary: instForm169Primary.value.trim(),
      rtmp169Backup: instForm169Backup.value.trim(),
      rtmp916Primary: instForm916Primary.value.trim(),
      rtmp916Backup: instForm916Backup.value.trim(),
      playlistUrls
    };

    if (id) {
      await fetch(`/api/instances/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
    } else {
      await fetch('/api/instances', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
    }
    instanceModal.style.display = 'none';
  });

  // ---------------------------------------------------------------------------
  // 12. Preview Monitor, Live Logs & System Health
  // ---------------------------------------------------------------------------
  const previewModal = document.getElementById('previewModal');
  const flvPreviewPlayer = document.getElementById('flvPreviewPlayer');
  let monitorPlayer = null;
  let lastPreviewUrl = '';

  window.openPreviewPlayer = function (url, title) {
    lastPreviewUrl = url;
    document.getElementById('previewTitle').textContent = `👁 ${title || 'Live Monitor'}`;
    document.getElementById('previewStatusText').textContent = `Playing: ${url}`;
    previewModal.style.display = 'flex';

    if (flvjs.isSupported()) {
      if (monitorPlayer) monitorPlayer.destroy();
      monitorPlayer = flvjs.createPlayer({ type: 'flv', isLive: true, url });
      monitorPlayer.attachMediaElement(flvPreviewPlayer);
      monitorPlayer.load();
      monitorPlayer.play().catch(() => {});
    }
  };

  document.getElementById('btnClosePreviewModal').addEventListener('click', () => {
    if (monitorPlayer) {
      monitorPlayer.destroy();
      monitorPlayer = null;
    }
    previewModal.style.display = 'none';
  });

  document.getElementById('btnReloadPreview').addEventListener('click', () => {
    if (lastPreviewUrl) window.openPreviewPlayer(lastPreviewUrl);
  });

  // Logs Engine
  const terminalLines = document.getElementById('terminalLines');
  const logsTerminal = document.getElementById('logsTerminal');

  function renderLogs() {
    if (!terminalLines) return;
    terminalLines.innerHTML = '';
    logsList.forEach((entry) => {
      if (currentLogLevel !== 'ALL' && entry.level !== currentLogLevel) return;
      if (logSearchQuery && !entry.message.toLowerCase().includes(logSearchQuery)) return;
      const div = document.createElement('div');
      div.className = 'log-line';
      const time = entry.timestamp ? entry.timestamp.split('T')[1].replace('Z', '') : '';
      div.innerHTML = `
        <span class="log-timestamp">${time}</span>
        <span class="log-badge log-badge-${entry.level}">${entry.level}</span>
        <span class="log-source">[${entry.source}]</span>
        <span class="log-msg">${escapeHtml(entry.message)}</span>
      `;
      terminalLines.appendChild(div);
    });
    if (autoScrollLogs && logsTerminal) logsTerminal.scrollTop = logsTerminal.scrollHeight;
  }

  socket.on('logs:history', (h) => {
    logsList = h || [];
    renderLogs();
  });
  socket.on('log:entry', (e) => {
    logsList.push(e);
    if (logsList.length > 600) logsList.shift();
    renderLogs();
  });
  socket.on('logs:cleared', () => {
    logsList = [];
    renderLogs();
  });

  document.getElementById('logLevelSelect').addEventListener('change', (e) => {
    currentLogLevel = e.target.value;
    renderLogs();
  });
  document.getElementById('logSearchInput').addEventListener('input', (e) => {
    logSearchQuery = e.target.value.trim().toLowerCase();
    renderLogs();
  });
  document.getElementById('btnToggleAutoScroll').addEventListener('click', () => {
    autoScrollLogs = !autoScrollLogs;
    document.getElementById('autoScrollStatus').textContent = `Auto-Scroll: ${autoScrollLogs ? 'ON' : 'OFF'}`;
  });
  document.getElementById('btnCopyLogs').addEventListener('click', () => {
    const txt = logsList.map((l) => `${l.timestamp} [${l.level}] ${l.message}`).join('\n');
    navigator.clipboard.writeText(txt).then(() => alert('Logs copied!'));
  });
  document.getElementById('btnDownloadLogs').addEventListener('click', () => {
    const txt = logsList.map((l) => `${l.timestamp} [${l.level}] ${l.message}`).join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([txt], { type: 'text/plain' }));
    a.download = `free-live-24-7-by-sletoyt-logs.log`;
    a.click();
  });
  document.getElementById('btnClearLogs').addEventListener('click', () => {
    fetch('/api/logs/clear', { method: 'POST' });
  });

  async function fetchSystemStatus() {
    try {
      const res = await fetch('/api/system/status');
      const d = await res.json();
      document.getElementById('sysPlatform').textContent = d.platform;
      document.getElementById('sysNodeVer').textContent = d.nodeVersion;
      document.getElementById('sysHeapUsed').textContent = d.memory.heapUsedMb;
      document.getElementById('sysRss').textContent = d.memory.rssMb;
      document.getElementById('sysTotalRam').textContent = d.memory.sysTotalMb;
      document.getElementById('sysActivePlayouts').textContent = d.activePlayouts;
      document.getElementById('sysStoredFiles').textContent = d.storedFilesCount || 0;
      document.getElementById('sysUptime').textContent = `${Math.floor(d.uptimeSeconds / 3600)}h ${Math.floor((d.uptimeSeconds % 3600) / 60)}m`;
      document.getElementById('sysSystemUptime').textContent = `${Math.floor(d.systemUptime / 3600)}h ${Math.floor((d.systemUptime % 3600) / 60)}m`;
    } catch (_) {}
  }

  function escapeHtml(str) {
    const d = document.createElement('div');
    d.textContent = str || '';
    return d.innerHTML;
  }

  // Initial Load
  fetch('/api/instances').then((r) => r.json()).then((d) => {
    instancesData = d || [];
    renderInstancesGrid();
  });
  fetchCloudFiles();
  fetchSystemStatus();
})();
