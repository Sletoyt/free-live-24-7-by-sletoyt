const socket = io();

let instances = [];
let cloudFiles = [];
let logsList = [];
let currentFileCategory = 'all';
let currentLogLevel = 'all';
let activeTab = 'instances';

let tunnelInfo = {
  active: false,
  status: 'connecting',
  publicRtmpUrl: null
};

let studioInstanceId = null;
let selectedSceneId = null;
let selectedSourceId = null;

let isBrowserDualLive = false;
let recorder169 = null;
let recorder916 = null;

const mediaCache = new Map();
let localCaptureVideoEl = null;
let localCaptureStream = null;
let flvPlayer = null;
let flvVideoEl = null;

let audioCtx = null;
let audioDest = null;
const connectedAudioNodes = new WeakSet();

const canvas169 = document.getElementById('canvas169');
const ctx169 = canvas169.getContext('2d');
const canvas916 = document.getElementById('canvas916');
const ctx916 = canvas916.getContext('2d');

const samplerCanvas = document.createElement('canvas');
samplerCanvas.width = 12;
samplerCanvas.height = 12;
const samplerCtx = samplerCanvas.getContext('2d', { willReadFrequently: true });

function initTheme() {
  const saved = localStorage.getItem('sleto_sky_theme') || 'dark';
  applyTheme(saved);
  const btn = document.getElementById('themeToggleBtn');
  if (btn) {
    btn.addEventListener('click', () => {
      const current = document.documentElement.getAttribute('data-theme') || 'dark';
      const next = current === 'dark' ? 'light' : 'dark';
      applyTheme(next);
      localStorage.setItem('sleto_sky_theme', next);
    });
  }
}

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  const icon = document.getElementById('themeToggleIcon');
  const label = document.getElementById('themeToggleLabel');
  if (icon && label) {
    if (theme === 'dark') {
      icon.textContent = '☀️';
      label.textContent = 'Light Sky';
    } else {
      icon.textContent = '🌙';
      label.textContent = 'Dark Sky';
    }
  }
}

initTheme();

function showToast(message, type = 'info') {
  const container = document.getElementById('toastContainer');
  if (!container) return;
  const el = document.createElement('div');
  el.className = 'toast';
  if (type === 'error') el.style.borderLeftColor = '#f43f5e';
  if (type === 'success') el.style.borderLeftColor = '#10b981';
  if (type === 'scene') el.style.borderLeftColor = '#f472b6';
  el.textContent = message;
  container.appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

function formatBytes(bytes) {
  if (!bytes || bytes < 1024) return `${bytes || 0} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function isCodespacesHost() {
  const h = window.location.hostname || '';
  return h.endsWith('.app.github.dev') || h.endsWith('.github.dev');
}

function isBotkeepHost() {
  const h = window.location.hostname || '';
  return h.includes('botkeep') || Boolean(tunnelInfo && tunnelInfo.isBotkeep);
}

function getRecommendedObsServerUrl() {
  if (tunnelInfo && tunnelInfo.publicRtmpUrl) {
    return tunnelInfo.publicRtmpUrl;
  }
  if (isCodespacesHost() || isBotkeepHost()) {
    return 'Connecting Tunnel... (Click Refresh Tunnel)';
  }
  const host = window.location.hostname || 'localhost';
  return `rtmp://${host}:1935/live`;
}

function updateTunnelUiBanner() {
  const serverUrl = getRecommendedObsServerUrl();
  const globalCode = document.getElementById('globalObsServerUrl');
  const guideCode = document.getElementById('guideObsServerUrl');
  const hint = document.getElementById('tunnelStatusHint');

  if (globalCode) globalCode.textContent = serverUrl;
  if (guideCode) guideCode.textContent = serverUrl;

  if (hint) {
    if (tunnelInfo && tunnelInfo.publicRtmpUrl) {
      hint.textContent = '✅ Public TCP Tunnel Active — Paste this exact Server URL in OBS Studio (works on Botkeep, Colab, Codespaces & VPS).';
    } else if (isBotkeepHost()) {
      hint.textContent = '⏳ Botkeep Ingest Tunnel Connecting — Paste this Server URL in OBS Studio when ready.';
    } else if (isCodespacesHost()) {
      hint.textContent = '⏳ Starting built-in SSH TCP Tunnel for GitHub Codespaces...';
    } else {
      hint.textContent = '✅ Direct VPS Port 1935 Ready — Paste this Server URL in OBS Studio.';
    }
  }
}

function copyTextToClipboard(text, label = 'Copied') {
  if (!text || text.startsWith('Connecting')) {
    showToast('Wait 2 seconds for tunnel URL or click Refresh Tunnel', 'error');
    return;
  }
  navigator.clipboard.writeText(text).then(() => {
    showToast(`📋 ${label}: ${text}`, 'success');
  }).catch(() => {
    showToast('Failed to copy text', 'error');
  });
}

document.getElementById('copyGlobalObsUrlBtn')?.addEventListener('click', () => {
  copyTextToClipboard(getRecommendedObsServerUrl(), 'OBS Server URL Copied');
});

document.getElementById('guideCopyServerBtn')?.addEventListener('click', () => {
  copyTextToClipboard(getRecommendedObsServerUrl(), 'OBS Server URL Copied');
});

document.getElementById('refreshTunnelBtn')?.addEventListener('click', async () => {
  showToast('🔄 Restarting Public RTMP TCP Tunnel...', 'info');
  try {
    await fetch('/api/tunnel/restart', { method: 'POST' });
  } catch (_) {}
});

document.querySelectorAll('.nav-tab').forEach((btn) => {
  btn.addEventListener('click', () => {
    const target = btn.dataset.tab;
    switchMainTab(target);
  });
});

function switchMainTab(tabName) {
  activeTab = tabName;
  document.querySelectorAll('.nav-tab').forEach((b) => {
    const active = b.dataset.tab === tabName;
    b.classList.toggle('active', active);
    b.setAttribute('aria-selected', String(active));
  });
  document.querySelectorAll('.tab-panel').forEach((p) => {
    p.classList.toggle('active', p.id === `tab-${tabName}`);
  });
  if (tabName === 'system') fetchSystemHealth();
  if (tabName === 'studio') syncStudioUI();
}

socket.on('connect', () => {
  document.getElementById('socketDot')?.classList.add('online');
  const txt = document.getElementById('socketText');
  if (txt) txt.textContent = 'Connected';
});

socket.on('disconnect', () => {
  document.getElementById('socketDot')?.classList.remove('online');
  const txt = document.getElementById('socketText');
  if (txt) txt.textContent = 'Reconnecting...';
});

socket.on('tunnel-update', (state) => {
  if (state) {
    tunnelInfo = state;
    updateTunnelUiBanner();
    renderInstancesGrid();
  }
});

socket.on('instances-update', (data) => {
  instances = Array.isArray(data) ? data : [];
  document.getElementById('navInstancesCount').textContent = instances.length;
  document.getElementById('statTotalChannels').textContent = instances.length;
  document.getElementById('statActiveStreams').textContent = instances.filter((i) => i.status === 'live').length;

  if (!studioInstanceId && instances.length > 0) {
    studioInstanceId = instances[0].id;
  } else if (studioInstanceId && !instances.some((i) => i.id === studioInstanceId)) {
    studioInstanceId = instances[0]?.id || null;
  }

  renderInstancesGrid();
  populateStudioChannelSelect();
  syncStudioUI();
});

socket.on('files-update', (data) => {
  cloudFiles = Array.isArray(data) ? data : [];
  document.getElementById('navFilesCount').textContent = cloudFiles.length;
  document.getElementById('statStoredFiles').textContent = cloudFiles.length;
  renderCloudFilesGrid();
  populateModalFileSelect();
});

socket.on('scene-switched', ({ instanceId, sceneName, reason }) => {
  if (instanceId === studioInstanceId) {
    showToast(`🎬 Scene -> "${sceneName}" (${reason})`, 'scene');
    syncStudioUI();
  }
});

socket.on('color-telemetry', ({ instanceId, detectedHex, uniformity }) => {
  if (instanceId === studioInstanceId && detectedHex) {
    const swatch = document.getElementById('studioDetectedSwatch');
    const txt = document.getElementById('studioDetectedHexText');
    if (swatch) swatch.style.background = detectedHex;
    if (txt) txt.textContent = `Screen: ${detectedHex} (${uniformity}%)`;
  }
});

socket.on('logs:history', (history) => {
  logsList = Array.isArray(history) ? history : [];
  renderLogsTerminal();
});

socket.on('log:entry', (entry) => {
  logsList.push(entry);
  if (logsList.length > 200) logsList.shift();
  if (activeTab === 'logs') {
    appendSingleLogLine(entry);
  }
});

socket.on('logs:cleared', () => {
  logsList = [];
  renderLogsTerminal();
});

function renderInstancesGrid() {
  const grid = document.getElementById('instancesGrid');
  if (!grid) return;

  if (instances.length === 0) {
    grid.innerHTML = `
      <div class="instance-card">
        <h3>🌸 No Dual Playout Channels Yet</h3>
        <p style="color:var(--text-sub);font-size:0.86rem;">Click <strong>＋ New Live Channel</strong> to create your 16:9 + 9:16 simultaneous live channel.</p>
      </div>
    `;
    return;
  }

  const rtmpServerUrl = getRecommendedObsServerUrl();

  grid.innerHTML = instances
    .map((inst) => {
      const isLive = inst.status === 'live';
      const activeScene = inst.scenes.find((s) => s.id === inst.activeSceneId) || inst.scenes[0];

      return `
        <div class="instance-card ${isLive ? 'is-live' : ''}">
          <div class="inst-card-top">
            <div class="inst-title-group">
              <h3>${escapeHtml(inst.name)}</h3>
              <div class="inst-badges">
                <span class="badge ${isLive ? 'badge-live' : 'badge-offline'}">
                  ${isLive ? '● ON AIR (16:9 + 9:16)' : '○ OFFLINE'}
                </span>
                <span class="badge badge-sky">
                  ${inst.obsConnected ? '🟢 OBS Connected' : '📡 Waiting for OBS'}
                </span>
                <span class="badge badge-sakura">
                  🤖 Auto Switch: ${inst.autoSceneSwitch ? 'ON' : 'OFF'}
                </span>
              </div>
            </div>
            <button class="btn-icon" onclick="openEditInstanceModal('${inst.id}')" title="Edit Stream Keys">⚙️</button>
          </div>

          <div class="inst-ingest-box">
            <div class="ingest-row">
              <span><strong>OBS Server:</strong> <code>${escapeHtml(rtmpServerUrl)}</code></span>
              <button class="btn btn-tonal btn-xs" onclick="copyTextToClipboard('${escapeHtml(rtmpServerUrl)}', 'OBS Server Copied')">Copy</button>
            </div>
            <div class="ingest-row">
              <span><strong>OBS Stream Key:</strong> <code>${escapeHtml(inst.rtmpIngestKey)}</code></span>
              <button class="btn btn-tonal btn-xs" onclick="copyTextToClipboard('${escapeHtml(inst.rtmpIngestKey)}', 'Stream Key Copied')">Copy</button>
            </div>
            <div class="ingest-row">
              <span><strong>Outputs:</strong> 16:9 ${inst.streamKey169 ? '✅' : '⚠️ No Key'} | 9:16 ${inst.streamKey916 ? '✅' : '⚠️ No Key'}</span>
              <span>${inst.fps || 30} FPS</span>
            </div>
          </div>

          <div>
            <span style="font-size:0.74rem;font-weight:700;color:var(--text-muted);display:block;margin-bottom:5px;">
              🎬 Quick Scene Switch (Syncs 16:9 &amp; 9:16):
            </span>
            <div class="inst-scenes-strip">
              ${inst.scenes
                .map(
                  (sc) => `
                  <button class="scene-chip ${sc.id === activeScene?.id ? 'active' : ''}"
                          onclick="quickSwitchScene('${inst.id}', '${sc.id}')">
                    ${sc.type === 'default' ? '🟢' : sc.type === 'color-detect' ? '🎨' : '📡'}
                    ${escapeHtml(sc.name)}
                  </button>
                `
                )
                .join('')}
            </div>
          </div>

          <div class="inst-card-actions">
            <button class="btn btn-primary btn-sm" onclick="openInstanceInStudio('${inst.id}')">
              🎬 Open Dual Studio
            </button>
            ${
              isLive
                ? `<button class="btn btn-danger btn-sm" onclick="stopChannelPlayout('${inst.id}')">⏹ Stop Live</button>`
                : `<button class="btn btn-sakura btn-sm" onclick="startBackendPlayout('${inst.id}')">▶ Start Dual Playout</button>`
            }
            <button class="btn btn-ghost btn-sm" onclick="openEditInstanceModal('${inst.id}')">
              🔑 Keys
            </button>
            <button class="btn btn-ghost btn-xs" style="margin-left:auto;color:var(--danger);" onclick="deleteInstance('${inst.id}')">
              🗑
            </button>
          </div>
        </div>
      `;
    })
    .join('');
}

window.openInstanceInStudio = function (id) {
  studioInstanceId = id;
  const inst = getStudioInstance();
  if (inst) {
    selectedSceneId = inst.activeSceneId || inst.scenes[0]?.id;
    selectedSourceId = null;
  }
  switchMainTab('studio');
};

window.quickSwitchScene = async function (instanceId, sceneId) {
  try {
    await fetch(`/api/instances/${instanceId}/scene-switch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sceneId, reason: 'Manual Quick Switch' })
    });
  } catch (_) {
    showToast('Failed to switch scene', 'error');
  }
};

window.startBackendPlayout = async function (instanceId) {
  try {
    const res = await fetch(`/api/instances/${instanceId}/start`, { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to start playout');
    showToast(`🚀 ${data.message}`, 'success');
  } catch (err) {
    showToast(err.message, 'error');
    openEditInstanceModal(instanceId);
  }
};

window.stopChannelPlayout = async function (instanceId) {
  if (isBrowserDualLive && studioInstanceId === instanceId) {
    stopBrowserDualStreaming();
  }
  try {
    await fetch(`/api/instances/${instanceId}/stop`, { method: 'POST' });
    showToast('⏹ Stopped Dual Broadcast', 'info');
  } catch (_) {
    showToast('Failed to stop broadcast', 'error');
  }
};

window.deleteInstance = async function (instanceId) {
  if (!confirm('Delete this Dual Playout channel?')) return;
  await fetch(`/api/instances/${instanceId}`, { method: 'DELETE' });
  showToast('Channel deleted', 'info');
};

const instanceModal = document.getElementById('instanceModal');
const instanceForm = document.getElementById('instanceForm');

document.getElementById('openNewInstanceModalBtn')?.addEventListener('click', () => {
  document.getElementById('instanceModalTitle').textContent = '🌸 New Dual Playout Channel (16:9 + 9:16)';
  document.getElementById('instIdInput').value = '';
  document.getElementById('instNameInput').value = '';
  document.getElementById('instIngestKeyInput').value = 'live_' + Math.random().toString(36).substr(2, 5);
  document.getElementById('instRtmp169Input').value = 'rtmp://a.rtmp.youtube.com/live2';
  document.getElementById('instKey169Input').value = '';
  document.getElementById('instEnable169Check').checked = true;
  document.getElementById('instRtmp916Input').value = 'rtmp://a.rtmp.youtube.com/live2';
  document.getElementById('instKey916Input').value = '';
  document.getElementById('instEnable916Check').checked = true;
  document.getElementById('instFpsSelect').value = '30';
  document.getElementById('instBitrateInput').value = '2500';
  instanceModal.classList.remove('hidden');
});

window.openEditInstanceModal = function (id) {
  const inst = instances.find((i) => i.id === id);
  if (!inst) return;
  document.getElementById('instanceModalTitle').textContent = `⚙️ Configure: ${inst.name}`;
  document.getElementById('instIdInput').value = inst.id;
  document.getElementById('instNameInput').value = inst.name;
  document.getElementById('instIngestKeyInput').value = inst.rtmpIngestKey || 'live_sleto';
  document.getElementById('instRtmp169Input').value = inst.rtmpUrl169 || 'rtmp://a.rtmp.youtube.com/live2';
  document.getElementById('instKey169Input').value = inst.streamKey169 || '';
  document.getElementById('instEnable169Check').checked = inst.enable169 !== false;
  document.getElementById('instRtmp916Input').value = inst.rtmpUrl916 || 'rtmp://a.rtmp.youtube.com/live2';
  document.getElementById('instKey916Input').value = inst.streamKey916 || '';
  document.getElementById('instEnable916Check').checked = inst.enable916 !== false;
  document.getElementById('instFpsSelect').value = String(inst.fps || 30);
  document.getElementById('instBitrateInput').value = String(inst.bitrate || 2500);
  instanceModal.classList.remove('hidden');
};

document.getElementById('closeInstanceModalBtn')?.addEventListener('click', () => instanceModal.classList.add('hidden'));
document.getElementById('cancelInstanceModalBtn')?.addEventListener('click', () => instanceModal.classList.add('hidden'));

instanceForm?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = document.getElementById('instIdInput').value;
  const payload = {
    name: document.getElementById('instNameInput').value.trim(),
    rtmpIngestKey: document.getElementById('instIngestKeyInput').value.trim(),
    rtmpUrl169: document.getElementById('instRtmp169Input').value.trim(),
    streamKey169: document.getElementById('instKey169Input').value.trim(),
    enable169: document.getElementById('instEnable169Check').checked,
    rtmpUrl916: document.getElementById('instRtmp916Input').value.trim(),
    streamKey916: document.getElementById('instKey916Input').value.trim(),
    enable916: document.getElementById('instEnable916Check').checked,
    fps: Number(document.getElementById('instFpsSelect').value),
    bitrate: Number(document.getElementById('instBitrateInput').value)
  };

  try {
    const url = id ? `/api/instances/${id}` : '/api/instances';
    const method = id ? 'PUT' : 'POST';
    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const saved = await res.json();
    if (!id && saved.id) studioInstanceId = saved.id;
    instanceModal.classList.add('hidden');
    showToast('💾 Channel configuration saved!', 'success');
  } catch (_) {
    showToast('Failed to save channel', 'error');
  }
});

const cloudFileInput = document.getElementById('cloudFileInput');
const triggerCloudUploadBtn = document.getElementById('triggerCloudUploadBtn');

triggerCloudUploadBtn?.addEventListener('click', () => cloudFileInput?.click());
document.getElementById('quickUploadInModalBtn')?.addEventListener('click', () => cloudFileInput?.click());

cloudFileInput?.addEventListener('change', async (e) => {
  const files = Array.from(e.target.files || []);
  if (files.length === 0) return;

  const progressText = document.getElementById('uploadProgressText');
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    if (progressText) progressText.textContent = `☁️ Uploading (${i + 1}/${files.length}): ${file.name}...`;
    const formData = new FormData();
    formData.append('file', file);
    try {
      const res = await fetch('/api/files/upload', {
        method: 'POST',
        body: formData
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Upload error');
      showToast(`✅ Uploaded: ${file.name}`, 'success');
    } catch (err) {
      showToast(`Upload failed (${file.name}): ${err.message}`, 'error');
    }
  }
  if (progressText) progressText.textContent = '';
  cloudFileInput.value = '';
});

document.querySelectorAll('.filter-pill').forEach((pill) => {
  pill.addEventListener('click', () => {
    document.querySelectorAll('.filter-pill').forEach((p) => p.classList.remove('active'));
    pill.classList.add('active');
    currentFileCategory = pill.dataset.fileCat;
    renderCloudFilesGrid();
  });
});

function renderCloudFilesGrid() {
  const grid = document.getElementById('cloudFilesGrid');
  if (!grid) return;

  const filtered =
    currentFileCategory === 'all'
      ? cloudFiles
      : cloudFiles.filter((f) => f.category === currentFileCategory);

  if (filtered.length === 0) {
    grid.innerHTML = `
      <div class="file-card">
        <h4>☁️ Cloud Folder is Empty</h4>
        <p style="font-size:0.8rem;color:var(--text-sub);">Upload your BG Music (<code>.mp3</code>), Logos (<code>.png</code>), or Standby Videos (<code>.mp4</code>) to use across all scenes.</p>
      </div>
    `;
    return;
  }

  grid.innerHTML = filtered
    .map((f) => {
      let previewHtml = `<div style="font-size:2.4rem;">📄</div>`;
      if (f.category === 'image') {
        previewHtml = `<img src="${f.url}" alt="${escapeHtml(f.displayName)}" loading="lazy" />`;
      } else if (f.category === 'video') {
        previewHtml = `<video src="${f.url}" muted loop playsinline onmouseover="this.play()" onmouseout="this.pause()"></video>`;
      } else if (f.category === 'audio') {
        previewHtml = `
          <div style="display:flex;flex-direction:column;align-items:center;gap:8px;padding:10px;width:100%;">
            <span style="font-size:2rem;">🎵</span>
            <audio src="${f.url}" controls style="width:95%;height:32px;"></audio>
          </div>
        `;
      }

      return `
        <div class="file-card">
          <div class="file-preview-box">${previewHtml}</div>
          <div class="file-meta">
            <h4>${escapeHtml(f.displayName)}</h4>
            <p>${f.category.toUpperCase()} • ${formatBytes(f.sizeBytes)}</p>
          </div>
          <div class="file-card-actions">
            <button class="btn btn-primary btn-xs" onclick="useCloudFileInCurrentScene('${encodeURIComponent(f.id)}')">
              ＋ Use in Scene
            </button>
            <a class="btn btn-tonal btn-xs" href="${f.downloadUrl}" download>
              ⬇ Download
            </a>
            <button class="btn btn-ghost btn-xs" onclick="renameCloudFile('${encodeURIComponent(f.id)}', '${escapeHtml(f.displayName)}')">
              ✏️
            </button>
            <button class="btn btn-ghost btn-xs" style="color:var(--danger);" onclick="deleteCloudFile('${encodeURIComponent(f.id)}')">
              🗑
            </button>
          </div>
        </div>
      `;
    })
    .join('');
}

window.useCloudFileInCurrentScene = function (encodedId) {
  const fileId = decodeURIComponent(encodedId);
  const fileObj = cloudFiles.find((f) => f.id === fileId);
  if (!fileObj) return;

  const inst = getStudioInstance();
  if (!inst) {
    showToast('Create a channel first!', 'error');
    return;
  }

  const scene = getSelectedScene(inst);
  if (!scene) return;

  let srcType = 'image';
  if (fileObj.category === 'audio') srcType = 'audio';
  if (fileObj.category === 'video') srcType = 'video';

  const newSource = {
    id: 'src_' + Date.now().toString(36),
    name: fileObj.displayName,
    type: srcType,
    fileId: fileObj.id,
    url: fileObj.url,
    text: '',
    color: '#38bdf8',
    volume: 1.0,
    muted: false,
    loop: true,
    visible: true,
    rect169: srcType === 'video' ? { x: 0, y: 0, w: 1920, h: 1080 } : { x: 80, y: 80, w: 320, h: 320 },
    rect916: srcType === 'video' ? { x: 0, y: 0, w: 1080, h: 1920 } : { x: 380, y: 120, w: 320, h: 320 }
  };

  scene.sources.push(newSource);
  selectedSourceId = newSource.id;
  persistStudioInstance();
  switchMainTab('studio');
  showToast(`🌸 Added "${fileObj.displayName}" to 16:9 & 9:16 in "${scene.name}"!`, 'success');
};

window.renameCloudFile = async function (encodedId, currentName) {
  const fileId = decodeURIComponent(encodedId);
  const newName = prompt('Enter new file name:', currentName);
  if (!newName || !newName.trim()) return;
  await fetch(`/api/files/${encodeURIComponent(fileId)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ newName: newName.trim() })
  });
  showToast('✏️ File renamed!', 'success');
};

window.deleteCloudFile = async function (encodedId) {
  const fileId = decodeURIComponent(encodedId);
  if (!confirm('Delete this file from Cloud File System?')) return;
  await fetch(`/api/files/${encodeURIComponent(fileId)}`, { method: 'DELETE' });
  showToast('🗑 File deleted', 'info');
};

function getStudioInstance() {
  return instances.find((i) => i.id === studioInstanceId) || instances[0] || null;
}

function getSelectedScene(inst) {
  if (!inst || !Array.isArray(inst.scenes)) return null;
  return (
    inst.scenes.find((s) => s.id === selectedSceneId) ||
    inst.scenes.find((s) => s.id === inst.activeSceneId) ||
    inst.scenes[0] ||
    null
  );
}

function populateStudioChannelSelect() {
  const sel = document.getElementById('studioInstanceSelect');
  if (!sel) return;
  sel.innerHTML = instances
    .map((inst) => `<option value="${inst.id}" ${inst.id === studioInstanceId ? 'selected' : ''}>${escapeHtml(inst.name)}</option>`)
    .join('');
}

document.getElementById('studioInstanceSelect')?.addEventListener('change', (e) => {
  studioInstanceId = e.target.value;
  const inst = getStudioInstance();
  selectedSceneId = inst?.activeSceneId || inst?.scenes[0]?.id || null;
  selectedSourceId = null;
  syncStudioUI();
});

function syncStudioUI() {
  const inst = getStudioInstance();
  if (!inst) return;

  if (!selectedSceneId || !inst.scenes.some((s) => s.id === selectedSceneId)) {
    selectedSceneId = inst.activeSceneId || inst.scenes[0]?.id;
  }

  const obsPill = document.getElementById('studioObsSignalPill');
  if (obsPill) {
    const connected = inst.obsConnected || Boolean(localCaptureStream);
    obsPill.textContent = connected ? '🟢 Signal Connected' : '📡 OBS Offline';
    obsPill.classList.toggle('connected', connected);
  }

  const autoToggle = document.getElementById('studioAutoSwitchToggle');
  if (autoToggle) autoToggle.checked = inst.autoSceneSwitch !== false;

  const activeScene = inst.scenes.find((s) => s.id === inst.activeSceneId) || inst.scenes[0];
  const bannerName = document.getElementById('activeSceneBannerName');
  if (bannerName) bannerName.textContent = activeScene ? activeScene.name : '--';

  const reasonBadge = document.getElementById('lastSwitchReasonBadge');
  if (reasonBadge) reasonBadge.textContent = inst.lastSwitchReason || 'Ready';

  const tag169 = document.getElementById('statusTag169');
  if (tag169) tag169.textContent = inst.streamKey169 ? '16:9 Key Ready ✅' : 'No 16:9 Key';

  const tag916 = document.getElementById('statusTag916');
  if (tag916) tag916.textContent = inst.streamKey916 ? '9:16 Key Ready ✅' : 'No 9:16 Key';

  const goLiveBtn = document.getElementById('studioGoLiveDualBtn');
  const stopLiveBtn = document.getElementById('studioStopLiveBtn');
  if (inst.status === 'live') {
    goLiveBtn?.classList.add('hidden');
    stopLiveBtn?.classList.remove('hidden');
  } else {
    goLiveBtn?.classList.remove('hidden');
    stopLiveBtn?.classList.add('hidden');
  }

  ensureFlvIngestPreview(inst);
  renderScenesList(inst);
  renderSceneConfigBox(inst);
  renderSourcesList(inst);
  renderSourceInspector(inst);
  syncHiddenMediaElements(inst);
}

function renderScenesList(inst) {
  const container = document.getElementById('scenesListContainer');
  if (!container) return;

  container.innerHTML = inst.scenes
    .map((sc) => {
      const isSelected = sc.id === selectedSceneId;
      const isLiveActive = sc.id === inst.activeSceneId;
      let typeLabel = '🟢 Default (Max 1)';
      if (sc.type === 'color-detect') {
        typeLabel = `<span class="mini-color-dot" style="background:${sc.triggerColor}"></span> Color: ${sc.triggerColor}`;
      } else if (sc.type === 'network-error') {
        typeLabel = '📡 Auto on OBS Loss';
      }

      return `
        <div class="scene-item ${isSelected ? 'active' : ''}" onclick="selectAndActivateScene('${sc.id}')">
          <div class="scene-item-left">
            <div class="scene-item-title">
              ${isLiveActive ? '🔴 ' : ''}${escapeHtml(sc.name)}
            </div>
            <div class="scene-item-sub">${typeLabel} • ${sc.sources.length} layers</div>
          </div>
          ${
            inst.scenes.length > 1
              ? `<button class="btn-icon" style="width:24px;height:24px;font-size:0.7rem;" onclick="event.stopPropagation();deleteSceneFromStudio('${sc.id}')">✕</button>`
              : ''
          }
        </div>
      `;
    })
    .join('');
}

window.selectAndActivateScene = async function (sceneId) {
  selectedSceneId = sceneId;
  const inst = getStudioInstance();
  if (!inst) return;
  inst.activeSceneId = sceneId;
  syncStudioUI();
  await window.quickSwitchScene(inst.id, sceneId);
};

window.deleteSceneFromStudio = function (sceneId) {
  const inst = getStudioInstance();
  if (!inst || inst.scenes.length <= 1) return;
  inst.scenes = inst.scenes.filter((s) => s.id !== sceneId);
  if (!inst.scenes.some((s) => s.type === 'default')) {
    inst.scenes[0].type = 'default';
  }
  if (inst.activeSceneId === sceneId) {
    inst.activeSceneId = inst.scenes[0].id;
  }
  selectedSceneId = inst.activeSceneId;
  persistStudioInstance();
};

function renderSceneConfigBox(inst) {
  const sc = getSelectedScene(inst);
  if (!sc) return;

  document.getElementById('sceneConfigNameLabel').textContent = sc.name;
  document.getElementById('sceneConfigTypeBadge').textContent = sc.type.toUpperCase();
  document.getElementById('editSceneNameInput').value = sc.name;
  document.getElementById('editSceneTypeSelect').value = sc.type;
  document.getElementById('editSceneTriggerColor').value = sc.triggerColor || '#000000';
  document.getElementById('editSceneTriggerHex').value = sc.triggerColor || '#000000';
  document.getElementById('editSceneTolerance').value = sc.colorTolerance || 32;
  document.getElementById('toleranceValLabel').textContent = sc.colorTolerance || 32;
  document.getElementById('editSceneBgColor').value = sc.bgColor || '#0f172a';
  document.getElementById('editSceneBgHex').value = sc.bgColor || '#0f172a';

  const colorGroup = document.getElementById('colorTriggerSettingsGroup');
  if (colorGroup) {
    colorGroup.classList.toggle('hidden', sc.type !== 'color-detect');
  }
}

document.getElementById('editSceneNameInput')?.addEventListener('input', (e) => {
  const inst = getStudioInstance();
  const sc = getSelectedScene(inst);
  if (!sc) return;
  sc.name = e.target.value;
  renderScenesList(inst);
});

document.getElementById('editSceneTypeSelect')?.addEventListener('change', (e) => {
  const inst = getStudioInstance();
  const sc = getSelectedScene(inst);
  if (!sc) return;
  const newType = e.target.value;

  if (newType === 'default') {
    inst.scenes.forEach((other) => {
      if (other.id !== sc.id && other.type === 'default') {
        other.type = 'color-detect';
      }
    });
  }
  sc.type = newType;
  persistStudioInstance();
});

document.getElementById('editSceneTriggerColor')?.addEventListener('input', (e) => {
  const inst = getStudioInstance();
  const sc = getSelectedScene(inst);
  if (!sc) return;
  sc.triggerColor = e.target.value;
  document.getElementById('editSceneTriggerHex').value = e.target.value;
  renderScenesList(inst);
});

document.getElementById('editSceneTriggerHex')?.addEventListener('change', (e) => {
  const inst = getStudioInstance();
  const sc = getSelectedScene(inst);
  if (!sc) return;
  const val = e.target.value.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(val)) {
    sc.triggerColor = val.toLowerCase();
    document.getElementById('editSceneTriggerColor').value = sc.triggerColor;
    persistStudioInstance();
  }
});

document.getElementById('editSceneTolerance')?.addEventListener('input', (e) => {
  const inst = getStudioInstance();
  const sc = getSelectedScene(inst);
  if (!sc) return;
  sc.colorTolerance = Number(e.target.value);
  document.getElementById('toleranceValLabel').textContent = sc.colorTolerance;
});

document.getElementById('editSceneBgColor')?.addEventListener('input', (e) => {
  const inst = getStudioInstance();
  const sc = getSelectedScene(inst);
  if (!sc) return;
  sc.bgColor = e.target.value;
  document.getElementById('editSceneBgHex').value = e.target.value;
});

document.getElementById('editSceneBgHex')?.addEventListener('change', (e) => {
  const inst = getStudioInstance();
  const sc = getSelectedScene(inst);
  if (!sc) return;
  const val = e.target.value.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(val)) {
    sc.bgColor = val.toLowerCase();
    document.getElementById('editSceneBgColor').value = sc.bgColor;
    persistStudioInstance();
  }
});

document.getElementById('pickCurrentScreenColorBtn')?.addEventListener('click', () => {
  const inst = getStudioInstance();
  const sc = getSelectedScene(inst);
  if (!sc) return;
  const sampled = sampleCurrentFeedHex();
  if (!sampled) {
    showToast('No incoming Window/OBS video frame available yet to sample!', 'error');
    return;
  }
  sc.triggerColor = sampled;
  document.getElementById('editSceneTriggerColor').value = sampled;
  document.getElementById('editSceneTriggerHex').value = sampled;
  persistStudioInstance();
  showToast(`🎯 Captured Screen Color: ${sampled}`, 'success');
});

document.getElementById('studioAutoSwitchToggle')?.addEventListener('change', (e) => {
  const inst = getStudioInstance();
  if (!inst) return;
  inst.autoSceneSwitch = e.target.checked;
  persistStudioInstance();
  showToast(`🤖 Auto Color & Signal Scene Switch: ${inst.autoSceneSwitch ? 'ENABLED' : 'DISABLED'}`, 'info');
});

const addSceneModal = document.getElementById('addSceneModal');
document.getElementById('openAddSceneModalBtn')?.addEventListener('click', () => {
  document.getElementById('newSceneNameInput').value = '';
  document.getElementById('newSceneTypeSelect').value = 'color-detect';
  document.getElementById('newSceneColorRow').classList.remove('hidden');
  addSceneModal.classList.remove('hidden');
});

document.getElementById('newSceneTypeSelect')?.addEventListener('change', (e) => {
  document.getElementById('newSceneColorRow').classList.toggle('hidden', e.target.value !== 'color-detect');
});

document.getElementById('newSceneColorPicker')?.addEventListener('input', (e) => {
  document.getElementById('newSceneColorHex').value = e.target.value;
});

document.getElementById('closeAddSceneModalBtn')?.addEventListener('click', () => addSceneModal.classList.add('hidden'));
document.getElementById('cancelAddSceneBtn')?.addEventListener('click', () => addSceneModal.classList.add('hidden'));

document.getElementById('addSceneForm')?.addEventListener('submit', (e) => {
  e.preventDefault();
  const inst = getStudioInstance();
  if (!inst) return;

  const name = document.getElementById('newSceneNameInput').value.trim();
  const type = document.getElementById('newSceneTypeSelect').value;
  const triggerColor = document.getElementById('newSceneColorHex').value.trim() || '#000000';

  if (type === 'default') {
    inst.scenes.forEach((s) => {
      if (s.type === 'default') s.type = 'color-detect';
    });
  }

  const newScene = {
    id: 'scene_' + Date.now().toString(36),
    name,
    type,
    triggerColor,
    colorTolerance: 32,
    bgColor: '#0f172a',
    sources: [
      {
        id: 'src_' + Date.now().toString(36),
        name: name + ' Banner',
        type: 'text',
        url: '',
        text: name.toUpperCase(),
        color: '#38bdf8',
        volume: 1.0,
        muted: true,
        loop: true,
        visible: true,
        rect169: { x: 420, y: 450, w: 1080, h: 160 },
        rect916: { x: 100, y: 820, w: 880, h: 200 }
      }
    ]
  };

  inst.scenes.push(newScene);
  selectedSceneId = newScene.id;
  inst.activeSceneId = newScene.id;
  addSceneModal.classList.add('hidden');
  persistStudioInstance();
  showToast(`🎬 Created Scene "${name}"!`, 'success');
});

function renderSourcesList(inst) {
  const container = document.getElementById('sourcesListContainer');
  if (!container) return;

  const sc = getSelectedScene(inst);
  if (!sc || !Array.isArray(sc.sources) || sc.sources.length === 0) {
    container.innerHTML = `<div style="font-size:0.78rem;color:var(--text-muted);padding:8px;">No sources in this scene. Click <strong>＋ Source</strong> to add one to both 16:9 &amp; 9:16!</div>`;
    return;
  }

  const icons = {
    'live-window': '🖥️',
    image: '🖼️',
    video: '🎞️',
    audio: '🎵',
    text: '🔤'
  };

  container.innerHTML = sc.sources
    .map((src) => {
      const active = src.id === selectedSourceId;
      return `
        <div class="source-item ${active ? 'active' : ''}" onclick="selectSourceLayer('${src.id}')">
          <div class="scene-item-left">
            <div class="scene-item-title">${icons[src.type] || '🧩'} ${escapeHtml(src.name)}</div>
            <div class="scene-item-sub">${src.type.toUpperCase()} • Shared 16:9 &amp; 9:16</div>
          </div>
          <button class="btn-icon" style="width:24px;height:24px;font-size:0.72rem;"
                  onclick="event.stopPropagation();toggleSourceVisibility('${src.id}')">
            ${src.visible === false ? '🙈' : '👁️'}
          </button>
        </div>
      `;
    })
    .join('');
}

window.selectSourceLayer = function (srcId) {
  selectedSourceId = srcId;
  const inst = getStudioInstance();
  if (!inst) return;
  renderSourcesList(inst);
  renderSourceInspector(inst);
};

window.toggleSourceVisibility = function (srcId) {
  const inst = getStudioInstance();
  const sc = getSelectedScene(inst);
  if (!sc) return;
  const src = sc.sources.find((s) => s.id === srcId);
  if (!src) return;
  src.visible = src.visible === false ? true : false;
  persistStudioInstance();
};

function getSelectedSource(inst) {
  const sc = getSelectedScene(inst);
  if (!sc) return null;
  return sc.sources.find((s) => s.id === selectedSourceId) || sc.sources[0] || null;
}

function renderSourceInspector(inst) {
  const box = document.getElementById('selectedSourceInspector');
  if (!box) return;

  const src = getSelectedSource(inst);
  if (!src) {
    box.classList.add('hidden');
    return;
  }

  selectedSourceId = src.id;
  box.classList.remove('hidden');

  document.getElementById('inspectorSourceName').textContent = src.name;
  document.getElementById('inspectSrcNameInput').value = src.name;

  const textGroup = document.getElementById('inspectTextGroup');
  if (textGroup) {
    textGroup.classList.toggle('hidden', src.type !== 'text');
    document.getElementById('inspectSrcTextInput').value = src.text || '';
    document.getElementById('inspectSrcColorInput').value = src.color || '#38bdf8';
  }

  const audioGroup = document.getElementById('inspectAudioGroup');
  if (audioGroup) {
    const hasAudio = ['live-window', 'video', 'audio'].includes(src.type);
    audioGroup.classList.toggle('hidden', !hasAudio);
    const volPct = Math.round((src.volume !== undefined ? src.volume : 1) * 100);
    document.getElementById('inspectVolLabel').textContent = `${volPct}%`;
    document.getElementById('inspectSrcVolumeRange').value = volPct;
    document.getElementById('inspectSrcMuteCheck').checked = Boolean(src.muted);
  }

  const r169 = src.rect169 || { x: 0, y: 0, w: 640, h: 360 };
  const r916 = src.rect916 || { x: 40, y: 400, w: 1000, h: 600 };

  document.getElementById('in169X').value = Math.round(r169.x);
  document.getElementById('in169Y').value = Math.round(r169.y);
  document.getElementById('in169W').value = Math.round(r169.w);
  document.getElementById('in169H').value = Math.round(r169.h);

  document.getElementById('in916X').value = Math.round(r916.x);
  document.getElementById('in916Y').value = Math.round(r916.y);
  document.getElementById('in916W').value = Math.round(r916.w);
  document.getElementById('in916H').value = Math.round(r916.h);

  updateCoordReadoutLabels(src);
}

function updateCoordReadoutLabels(src) {
  if (!src) return;
  const r169 = src.rect169 || { x: 0, y: 0, w: 0, h: 0 };
  const r916 = src.rect916 || { x: 0, y: 0, w: 0, h: 0 };
  const el169 = document.getElementById('coordReadout169');
  const el916 = document.getElementById('coordReadout916');
  if (el169) el169.textContent = `${src.name} (16:9): x:${Math.round(r169.x)} y:${Math.round(r169.y)} w:${Math.round(r169.w)} h:${Math.round(r169.h)}`;
  if (el916) el916.textContent = `${src.name} (9:16): x:${Math.round(r916.x)} y:${Math.round(r916.y)} w:${Math.round(r916.w)} h:${Math.round(r916.h)}`;
}

document.getElementById('inspectSrcNameInput')?.addEventListener('input', (e) => {
  const inst = getStudioInstance();
  const src = getSelectedSource(inst);
  if (!src) return;
  src.name = e.target.value;
  renderSourcesList(inst);
});

document.getElementById('inspectSrcTextInput')?.addEventListener('input', (e) => {
  const inst = getStudioInstance();
  const src = getSelectedSource(inst);
  if (!src) return;
  src.text = e.target.value;
});

document.getElementById('inspectSrcColorInput')?.addEventListener('input', (e) => {
  const inst = getStudioInstance();
  const src = getSelectedSource(inst);
  if (!src) return;
  src.color = e.target.value;
});

document.getElementById('inspectSrcVolumeRange')?.addEventListener('input', (e) => {
  const inst = getStudioInstance();
  const src = getSelectedSource(inst);
  if (!src) return;
  src.volume = Number(e.target.value) / 100;
  document.getElementById('inspectVolLabel').textContent = `${e.target.value}%`;
  syncHiddenMediaElements(inst);
});

document.getElementById('inspectSrcMuteCheck')?.addEventListener('change', (e) => {
  const inst = getStudioInstance();
  const src = getSelectedSource(inst);
  if (!src) return;
  src.muted = e.target.checked;
  syncHiddenMediaElements(inst);
});

['X', 'Y', 'W', 'H'].forEach((axis) => {
  const key = axis.toLowerCase();
  document.getElementById(`in169${axis}`)?.addEventListener('input', (e) => {
    const inst = getStudioInstance();
    const src = getSelectedSource(inst);
    if (!src) return;
    src.rect169[key] = Number(e.target.value) || 0;
    updateCoordReadoutLabels(src);
  });
  document.getElementById(`in916${axis}`)?.addEventListener('input', (e) => {
    const inst = getStudioInstance();
    const src = getSelectedSource(inst);
    if (!src) return;
    src.rect916[key] = Number(e.target.value) || 0;
    updateCoordReadoutLabels(src);
  });
});

document.getElementById('fit169FullBtn')?.addEventListener('click', () => {
  const src = getSelectedSource(getStudioInstance());
  if (!src) return;
  src.rect169 = { x: 0, y: 0, w: 1920, h: 1080 };
  renderSourceInspector(getStudioInstance());
});

document.getElementById('center169Btn')?.addEventListener('click', () => {
  const src = getSelectedSource(getStudioInstance());
  if (!src) return;
  src.rect169.x = Math.round((1920 - src.rect169.w) / 2);
  src.rect169.y = Math.round((1080 - src.rect169.h) / 2);
  renderSourceInspector(getStudioInstance());
});

document.getElementById('fit916FullBtn')?.addEventListener('click', () => {
  const src = getSelectedSource(getStudioInstance());
  if (!src) return;
  src.rect916 = { x: 0, y: 0, w: 1080, h: 1920 };
  renderSourceInspector(getStudioInstance());
});

document.getElementById('center916Btn')?.addEventListener('click', () => {
  const src = getSelectedSource(getStudioInstance());
  if (!src) return;
  src.rect916.x = Math.round((1080 - src.rect916.w) / 2);
  src.rect916.y = Math.round((1920 - src.rect916.h) / 2);
  renderSourceInspector(getStudioInstance());
});

document.getElementById('deleteSelectedSourceBtn')?.addEventListener('click', () => {
  const inst = getStudioInstance();
  const sc = getSelectedScene(inst);
  if (!sc || !selectedSourceId) return;
  sc.sources = sc.sources.filter((s) => s.id !== selectedSourceId);
  selectedSourceId = sc.sources[0]?.id || null;
  persistStudioInstance();
});

const addSourceModal = document.getElementById('addSourceModal');
const newSourceTypeSelect = document.getElementById('newSourceTypeSelect');

function populateModalFileSelect() {
  const sel = document.getElementById('newSourceCloudFileSelect');
  if (!sel) return;
  const type = newSourceTypeSelect?.value || 'image';
  const matching = cloudFiles.filter((f) => {
    if (type === 'image') return f.category === 'image';
    if (type === 'video') return f.category === 'video';
    if (type === 'audio') return f.category === 'audio';
    return true;
  });

  if (matching.length === 0) {
    sel.innerHTML = `<option value="">-- No ${type} files uploaded yet (Click Upload New) --</option>`;
  } else {
    sel.innerHTML = matching
      .map((f) => `<option value="${escapeHtml(f.id)}">${escapeHtml(f.displayName)} (${formatBytes(f.sizeBytes)})</option>`)
      .join('');
  }
}

function updateAddSourceModalFields() {
  const type = newSourceTypeSelect.value;
  const fileRow = document.getElementById('newSourceFileSelectRow');
  const textRow = document.getElementById('newSourceTextRow');

  fileRow.classList.toggle('hidden', !['image', 'video', 'audio'].includes(type));
  textRow.classList.toggle('hidden', type !== 'text');
  populateModalFileSelect();
}

newSourceTypeSelect?.addEventListener('change', updateAddSourceModalFields);

document.getElementById('openAddSourceModalBtn')?.addEventListener('click', () => {
  document.getElementById('newSourceNameInput').value = '';
  newSourceTypeSelect.value = 'image';
  updateAddSourceModalFields();
  addSourceModal.classList.remove('hidden');
});

document.getElementById('closeAddSourceModalBtn')?.addEventListener('click', () => addSourceModal.classList.add('hidden'));
document.getElementById('cancelAddSourceBtn')?.addEventListener('click', () => addSourceModal.classList.add('hidden'));

document.getElementById('addSourceForm')?.addEventListener('submit', (e) => {
  e.preventDefault();
  const inst = getStudioInstance();
  const sc = getSelectedScene(inst);
  if (!inst || !sc) return;

  const type = newSourceTypeSelect.value;
  const name = document.getElementById('newSourceNameInput').value.trim() || 'Layer';
  const fileId = document.getElementById('newSourceCloudFileSelect').value;
  const fileObj = cloudFiles.find((f) => f.id === fileId);

  if (['image', 'video', 'audio'].includes(type) && !fileObj) {
    showToast('Please upload or select a file from the Cloud File System first!', 'error');
    return;
  }

  let rect169 = { x: 120, y: 120, w: 600, h: 340 };
  let rect916 = { x: 90, y: 460, w: 900, h: 520 };

  if (type === 'live-window' || type === 'video') {
    rect169 = { x: 0, y: 0, w: 1920, h: 1080 };
    rect916 = { x: 40, y: 420, w: 1000, h: 600 };
  } else if (type === 'image') {
    rect169 = { x: 80, y: 60, w: 260, h: 260 };
    rect916 = { x: 410, y: 100, w: 260, h: 260 };
  } else if (type === 'text') {
    rect169 = { x: 360, y: 440, w: 1200, h: 140 };
    rect916 = { x: 80, y: 840, w: 920, h: 160 };
  }

  const newSrc = {
    id: 'src_' + Date.now().toString(36),
    name,
    type,
    fileId: fileObj ? fileObj.id : '',
    url: fileObj ? fileObj.url : '',
    text: document.getElementById('newSourceTextValue').value || name,
    color: document.getElementById('newSourceTextColor').value || '#38bdf8',
    volume: 1.0,
    muted: false,
    loop: true,
    visible: true,
    rect169,
    rect916
  };

  sc.sources.push(newSrc);
  selectedSourceId = newSrc.id;
  addSourceModal.classList.add('hidden');
  persistStudioInstance();
  showToast(`✨ Added "${name}" to both 16:9 & 9:16!`, 'success');
});

async function persistStudioInstance() {
  const inst = getStudioInstance();
  if (!inst) return;
  syncStudioUI();
  try {
    await fetch(`/api/instances/${inst.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(inst)
    });
  } catch (_) {}
}

document.getElementById('studioSaveLayoutBtn')?.addEventListener('click', () => {
  persistStudioInstance();
  showToast('💾 Saved all scenes & dual 16:9 + 9:16 coordinates!', 'success');
});

function ensureAudioMixer() {
  if (!audioCtx) {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    audioCtx = new AudioContextClass();
    audioDest = audioCtx.createMediaStreamDestination();
  }
  if (audioCtx.state === 'suspended') {
    audioCtx.resume().catch(() => {});
  }
}

function connectElementToAudioMixer(el) {
  if (!el || connectedAudioNodes.has(el)) return;
  try {
    ensureAudioMixer();
    const node = audioCtx.createMediaElementSource(el);
    const gain = audioCtx.createGain();
    node.connect(gain);
    gain.connect(audioDest);
    gain.connect(audioCtx.destination);
    el._gainNode = gain;
    connectedAudioNodes.add(el);
  } catch (_) {}
}

function syncHiddenMediaElements(inst) {
  const pool = document.getElementById('hiddenMediaPool');
  if (!pool || !inst) return;

  const activeScene = inst.scenes.find((s) => s.id === inst.activeSceneId) || inst.scenes[0];
  if (!activeScene) return;

  activeScene.sources.forEach((src) => {
    if (!src.url) return;
    let el = mediaCache.get(src.id);

    if (src.type === 'image') {
      if (!el || el.tagName !== 'IMG' || el.dataset.srcUrl !== src.url) {
        el = new Image();
        el.crossOrigin = 'anonymous';
        el.src = src.url;
        el.dataset.srcUrl = src.url;
        mediaCache.set(src.id, el);
      }
    } else if (src.type === 'video' || src.type === 'audio') {
      const tag = src.type === 'video' ? 'VIDEO' : 'AUDIO';
      if (!el || el.tagName !== tag || el.dataset.srcUrl !== src.url) {
        if (el && el.remove) el.remove();
        el = document.createElement(tag.toLowerCase());
        el.crossOrigin = 'anonymous';
        el.src = src.url;
        el.dataset.srcUrl = src.url;
        el.loop = src.loop !== false;
        el.playsInline = true;
        pool.appendChild(el);
        mediaCache.set(src.id, el);
      }
      el.loop = src.loop !== false;
      const vol = src.muted || src.visible === false ? 0 : (src.volume ?? 1);
      el.volume = Math.max(0, Math.min(1, vol));
      if (el._gainNode) el._gainNode.gain.value = el.volume;
      if (el.paused && src.visible !== false) {
        el.play().catch(() => {});
      }
    }
  });
}

document.getElementById('studioShareWindowBtn')?.addEventListener('click', async () => {
  try {
    ensureAudioMixer();
    const displayStream = await navigator.mediaDevices.getDisplayMedia({
      video: { width: 1280, height: 720, frameRate: 30 },
      audio: true
    });

    let micStream = null;
    try {
      micStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    } catch (_) {}

    if (displayStream.getAudioTracks().length > 0) {
      const sysSrc = audioCtx.createMediaStreamSource(displayStream);
      sysSrc.connect(audioDest);
    }
    if (micStream && micStream.getAudioTracks().length > 0) {
      const micSrc = audioCtx.createMediaStreamSource(micStream);
      micSrc.connect(audioDest);
    }

    localCaptureStream = displayStream;
    if (!localCaptureVideoEl) {
      localCaptureVideoEl = document.createElement('video');
      localCaptureVideoEl.muted = true;
      localCaptureVideoEl.playsInline = true;
    }
    localCaptureVideoEl.srcObject = displayStream;
    await localCaptureVideoEl.play();

    displayStream.getVideoTracks()[0].onended = () => {
      localCaptureStream = null;
      syncStudioUI();
    };

    syncStudioUI();
    showToast('🖥️ Direct Window + Voiceover connected to Dual Studio!', 'success');
  } catch (err) {
    showToast(`Window capture cancelled: ${err.message}`, 'error');
  }
});

let currentFlvKey = null;
function ensureFlvIngestPreview(inst) {
  if (!inst || !inst.obsConnected) {
    if (flvPlayer) {
      try {
        flvPlayer.destroy();
      } catch (_) {}
      flvPlayer = null;
      currentFlvKey = null;
    }
    return;
  }

  if (currentFlvKey === inst.rtmpIngestKey && flvPlayer) return;
  if (!window.mpegts || !mpegts.isSupported()) return;

  if (flvPlayer) {
    try {
      flvPlayer.destroy();
    } catch (_) {}
  }

  if (!flvVideoEl) {
    flvVideoEl = document.createElement('video');
    flvVideoEl.crossOrigin = 'anonymous';
    flvVideoEl.muted = true;
    flvVideoEl.playsInline = true;
    flvVideoEl.autoplay = true;
  }

  currentFlvKey = inst.rtmpIngestKey;
  flvPlayer = mpegts.createPlayer({
    type: 'flv',
    isLive: true,
    url: `/api/flv-proxy/${encodeURIComponent(inst.rtmpIngestKey)}`
  });
  flvPlayer.attachMediaElement(flvVideoEl);
  flvPlayer.load();
  flvPlayer.play().catch(() => {});
}

function getActiveIncomingVideoElement() {
  if (localCaptureStream && localCaptureVideoEl && localCaptureVideoEl.readyState >= 2) {
    return localCaptureVideoEl;
  }
  if (flvVideoEl && flvVideoEl.readyState >= 2) {
    return flvVideoEl;
  }
  return null;
}

function sampleCurrentFeedHex() {
  const feedEl = getActiveIncomingVideoElement();
  if (!feedEl) return null;
  try {
    samplerCtx.drawImage(feedEl, 0, 0, 12, 12);
    const data = samplerCtx.getImageData(0, 0, 12, 12).data;
    let r = 0, g = 0, b = 0, count = 0;
    for (let i = 0; i < data.length; i += 4) {
      r += data[i];
      g += data[i + 1];
      b += data[i + 2];
      count++;
    }
    r = Math.round(r / count);
    g = Math.round(g / count);
    b = Math.round(b / count);
    const toHex = (n) => n.toString(16).padStart(2, '0');
    return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
  } catch (_) {
    return null;
  }
}

setInterval(() => {
  const inst = getStudioInstance();
  if (!inst || !localCaptureStream) return;
  const feedEl = localCaptureVideoEl;
  if (!feedEl || feedEl.readyState < 2) return;

  try {
    samplerCtx.drawImage(feedEl, 0, 0, 12, 12);
    const data = samplerCtx.getImageData(0, 0, 12, 12).data;
    let sumR = 0, sumG = 0, sumB = 0;
    const total = 144;
    for (let i = 0; i < data.length; i += 4) {
      sumR += data[i];
      sumG += data[i + 1];
      sumB += data[i + 2];
    }
    const avg = { r: Math.round(sumR / total), g: Math.round(sumG / total), b: Math.round(sumB / total) };
    let uniform = 0;
    for (let i = 0; i < data.length; i += 4) {
      const dr = data[i] - avg.r;
      const dg = data[i + 1] - avg.g;
      const db = data[i + 2] - avg.b;
      if (Math.sqrt(dr * dr + dg * dg + db * db) <= 35) uniform++;
    }
    const ratio = uniform / total;
    const toHex = (n) => n.toString(16).padStart(2, '0');
    const hex = `#${toHex(avg.r)}${toHex(avg.g)}${toHex(avg.b)}`;

    const swatch = document.getElementById('studioDetectedSwatch');
    const txt = document.getElementById('studioDetectedHexText');
    if (swatch) swatch.style.background = hex;
    if (txt) txt.textContent = `Screen: ${hex} (${Math.round(ratio * 100)}%)`;

    if (!inst.autoSceneSwitch) return;

    const colorScenes = inst.scenes.filter((s) => s.type === 'color-detect');
    const defaultScene = inst.scenes.find((s) => s.type === 'default') || inst.scenes[0];

    if (ratio >= 0.80) {
      for (const cScene of colorScenes) {
        const clean = (cScene.triggerColor || '#000000').replace('#', '');
        const num = parseInt(clean, 16);
        const tr = (num >> 16) & 255;
        const tg = (num >> 8) & 255;
        const tb = num & 255;
        const dist = Math.sqrt((avg.r - tr) ** 2 + (avg.g - tg) ** 2 + (avg.b - tb) ** 2);
        if (dist <= (cScene.colorTolerance || 32) * 1.8) {
          if (inst.activeSceneId !== cScene.id) {
            selectedSceneId = cScene.id;
            socket.emit('client-color-switch', {
              instanceId: inst.id,
              targetSceneId: cScene.id,
              reason: `Screen Color Match (${hex})`
            });
          }
          return;
        }
      }
    }

    const activeScene = inst.scenes.find((s) => s.id === inst.activeSceneId);
    if (activeScene && activeScene.type === 'color-detect' && defaultScene) {
      selectedSceneId = defaultScene.id;
      socket.emit('client-color-switch', {
        instanceId: inst.id,
        targetSceneId: defaultScene.id,
        reason: `Color Cleared (${hex}) -> Default Scene`
      });
    }
  } catch (_) {}
}, 900);

function drawSceneOnCanvas(ctx, canvasW, canvasH, ratioKey, inst, scene) {
  ctx.fillStyle = scene?.bgColor || '#0f172a';
  ctx.fillRect(0, 0, canvasW, canvasH);

  ctx.strokeStyle = 'rgba(56, 189, 248, 0.12)';
  ctx.lineWidth = 2;
  ctx.strokeRect(12, 12, canvasW - 24, canvasH - 24);

  if (!scene || !Array.isArray(scene.sources)) return;

  const is916 = ratioKey === '916';

  scene.sources.forEach((src) => {
    if (src.visible === false) return;
    const rect = is916
      ? src.rect916 || { x: 60, y: 400, w: 960, h: 540 }
      : src.rect169 || { x: 0, y: 0, w: 1920, h: 1080 };

    if (src.type === 'live-window') {
      const feedEl = getActiveIncomingVideoElement();
      if (feedEl) {
        ctx.drawImage(feedEl, rect.x, rect.y, rect.w, rect.h);
      } else {
        ctx.fillStyle = 'rgba(15, 23, 42, 0.88)';
        ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
        ctx.strokeStyle = '#38bdf8';
        ctx.lineWidth = 4;
        ctx.strokeRect(rect.x, rect.y, rect.w, rect.h);
        ctx.fillStyle = '#38bdf8';
        ctx.font = 'bold 34px "Fredoka", sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('🖥️ INCOMING WINDOW + VOICEOVER', rect.x + rect.w / 2, rect.y + rect.h / 2 - 12);
        ctx.fillStyle = '#f472b6';
        ctx.font = '600 22px "Plus Jakarta Sans", sans-serif';
        ctx.fillText(`Stream from OBS (Key: ${inst.rtmpIngestKey}) or click "Capture Window + Mic"`, rect.x + rect.w / 2, rect.y + rect.h / 2 + 28);
      }
    } else if (src.type === 'video' || src.type === 'image') {
      const el = mediaCache.get(src.id);
      if (el) {
        try {
          ctx.drawImage(el, rect.x, rect.y, rect.w, rect.h);
        } catch (_) {}
      }
    } else if (src.type === 'text') {
      ctx.save();
      ctx.fillStyle = 'rgba(15, 23, 42, 0.82)';
      ctx.beginPath();
      ctx.roundRect(rect.x, rect.y, rect.w, rect.h, 24);
      ctx.fill();
      ctx.lineWidth = 4;
      ctx.strokeStyle = src.color || '#38bdf8';
      ctx.stroke();

      ctx.fillStyle = src.color || '#38bdf8';
      const fontSize = Math.max(24, Math.min(72, Math.round(rect.h * 0.42)));
      ctx.font = `700 ${fontSize}px "Fredoka", sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(src.text || src.name, rect.x + rect.w / 2, rect.y + rect.h / 2);
      ctx.restore();
    }

    if (src.id === selectedSourceId && src.type !== 'audio') {
      ctx.save();
      ctx.strokeStyle = is916 ? '#f472b6' : '#38bdf8';
      ctx.lineWidth = 5;
      ctx.setLineDash([12, 8]);
      ctx.strokeRect(rect.x, rect.y, rect.w, rect.h);
      ctx.setLineDash([]);

      ctx.fillStyle = is916 ? '#f472b6' : '#38bdf8';
      ctx.fillRect(rect.x + rect.w - 28, rect.y + rect.h - 28, 28, 28);
      ctx.restore();
    }
  });
}

setInterval(() => {
  if (activeTab !== 'studio' && !isBrowserDualLive) return;
  const inst = getStudioInstance();
  if (!inst) return;
  const scene = getSelectedScene(inst);
  drawSceneOnCanvas(ctx169, 1920, 1080, '169', inst, scene);
  drawSceneOnCanvas(ctx916, 1080, 1920, '916', inst, scene);
}, 40);

function attachCanvasDragInteraction(canvasEl, ratioKey, logicalW, logicalH) {
  let dragMode = null;
  let startMouse = { x: 0, y: 0 };
  let startRect = { x: 0, y: 0, w: 0, h: 0 };

  function toLogicalCoords(e) {
    const bounds = canvasEl.getBoundingClientRect();
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    return {
      x: ((clientX - bounds.left) / bounds.width) * logicalW,
      y: ((clientY - bounds.top) / bounds.height) * logicalH
    };
  }

  function onPointerDown(e) {
    const inst = getStudioInstance();
    const sc = getSelectedScene(inst);
    if (!sc) return;

    const pt = toLogicalCoords(e);
    const rectProp = ratioKey === '916' ? 'rect916' : 'rect169';

    for (let i = sc.sources.length - 1; i >= 0; i--) {
      const src = sc.sources[i];
      if (src.visible === false || src.type === 'audio') continue;
      const r = src[rectProp];
      if (!r) continue;

      if (pt.x >= r.x + r.w - 42 && pt.x <= r.x + r.w + 12 && pt.y >= r.y + r.h - 42 && pt.y <= r.y + r.h + 12) {
        selectedSourceId = src.id;
        dragMode = 'resize';
        startMouse = pt;
        startRect = { ...r };
        renderSourcesList(inst);
        renderSourceInspector(inst);
        e.preventDefault();
        return;
      }

      if (pt.x >= r.x && pt.x <= r.x + r.w && pt.y >= r.y && pt.y <= r.y + r.h) {
        selectedSourceId = src.id;
        dragMode = 'move';
        startMouse = pt;
        startRect = { ...r };
        renderSourcesList(inst);
        renderSourceInspector(inst);
        e.preventDefault();
        return;
      }
    }
  }

  function onPointerMove(e) {
    if (!dragMode) return;
    const inst = getStudioInstance();
    const src = getSelectedSource(inst);
    if (!src) return;

    const pt = toLogicalCoords(e);
    const dx = pt.x - startMouse.x;
    const dy = pt.y - startMouse.y;
    const rectProp = ratioKey === '916' ? 'rect916' : 'rect169';

    if (dragMode === 'move') {
      src[rectProp].x = Math.round(startRect.x + dx);
      src[rectProp].y = Math.round(startRect.y + dy);
    } else if (dragMode === 'resize') {
      src[rectProp].w = Math.max(60, Math.round(startRect.w + dx));
      src[rectProp].h = Math.max(40, Math.round(startRect.h + dy));
    }

    renderSourceInspector(inst);
  }

  function onPointerUp() {
    if (dragMode) {
      dragMode = null;
      persistStudioInstance();
    }
  }

  canvasEl.addEventListener('mousedown', onPointerDown);
  window.addEventListener('mousemove', onPointerMove);
  window.addEventListener('mouseup', onPointerUp);

  canvasEl.addEventListener('touchstart', onPointerDown, { passive: false });
  window.addEventListener('touchmove', onPointerMove, { passive: false });
  window.addEventListener('touchend', onPointerUp);
}

attachCanvasDragInteraction(canvas169, '169', 1920, 1080);
attachCanvasDragInteraction(canvas916, '916', 1080, 1920);

document.getElementById('studioGoLiveDualBtn')?.addEventListener('click', async () => {
  const inst = getStudioInstance();
  if (!inst) return;

  if (!inst.streamKey169 && !inst.streamKey916) {
    showToast('Please enter at least one Stream Key (16:9 or 9:16) first!', 'error');
    openEditInstanceModal(inst.id);
    return;
  }

  try {
    await persistStudioInstance();
    ensureAudioMixer();

    const activeScene = getSelectedScene(inst);
    activeScene?.sources.forEach((src) => {
      const el = mediaCache.get(src.id);
      if (el && (src.type === 'video' || src.type === 'audio')) {
        connectElementToAudioMixer(el);
        el.play().catch(() => {});
      }
    });

    const res = await fetch(`/api/instances/${inst.id}/start-dual-canvas`, { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not start dual live');

    const fps = Number(inst.fps) || 30;
    const mime = MediaRecorder.isTypeSupported('video/webm;codecs=h264,opus')
      ? 'video/webm;codecs=h264,opus'
      : 'video/webm';

    if (inst.enable169 && inst.streamKey169) {
      const stream169 = canvas169.captureStream(fps);
      if (audioDest && audioDest.stream.getAudioTracks().length > 0) {
        stream169.addTrack(audioDest.stream.getAudioTracks()[0].clone());
      }
      recorder169 = new MediaRecorder(stream169, { mimeType: mime, videoBitsPerSecond: (inst.bitrate || 2200) * 1000 });
      recorder169.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) {
          socket.emit('binary-chunk-169', { instanceId: inst.id, chunk: e.data });
        }
      };
      recorder169.start(400);
    }

    if (inst.enable916 && inst.streamKey916) {
      const stream916 = canvas916.captureStream(fps);
      if (audioDest && audioDest.stream.getAudioTracks().length > 0) {
        stream916.addTrack(audioDest.stream.getAudioTracks()[0].clone());
      }
      recorder916 = new MediaRecorder(stream916, { mimeType: mime, videoBitsPerSecond: (inst.bitrate || 2200) * 1000 });
      recorder916.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) {
          socket.emit('binary-chunk-916', { instanceId: inst.id, chunk: e.data });
        }
      };
      recorder916.start(400);
    }

    isBrowserDualLive = true;
    showToast('🚀 LIVE ON AIR: Streaming both 16:9 and 9:16 simultaneously!', 'success');
    syncStudioUI();
  } catch (err) {
    showToast(err.message, 'error');
  }
});

function stopBrowserDualStreaming() {
  if (recorder169 && recorder169.state !== 'inactive') {
    try { recorder169.stop(); } catch (_) {}
  }
  if (recorder916 && recorder916.state !== 'inactive') {
    try { recorder916.stop(); } catch (_) {}
  }
  recorder169 = null;
  recorder916 = null;
  isBrowserDualLive = false;
}

document.getElementById('studioStopLiveBtn')?.addEventListener('click', () => {
  const inst = getStudioInstance();
  if (!inst) return;
  window.stopChannelPlayout(inst.id);
});

document.querySelectorAll('.log-pill').forEach((pill) => {
  pill.addEventListener('click', () => {
    document.querySelectorAll('.log-pill').forEach((p) => p.classList.remove('active'));
    pill.classList.add('active');
    currentLogLevel = pill.dataset.level;
    renderLogsTerminal();
  });
});

document.getElementById('logSearchInput')?.addEventListener('input', () => renderLogsTerminal());

document.getElementById('clearLogsBtn')?.addEventListener('click', async () => {
  await fetch('/api/logs/clear', { method: 'POST' });
});

function renderLogsTerminal() {
  const term = document.getElementById('logsTerminalOutput');
  if (!term) return;

  const query = (document.getElementById('logSearchInput')?.value || '').trim().toLowerCase();
  const filtered = logsList.filter((l) => {
    if (currentLogLevel !== 'all' && l.level !== currentLogLevel) return false;
    if (query && !l.message.toLowerCase().includes(query) && !l.source.toLowerCase().includes(query)) return false;
    return true;
  });

  term.innerHTML = filtered
    .map(
      (l) => `
      <div class="log-line">
        <span class="log-time">${new Date(l.timestamp).toLocaleTimeString()}</span>
        <span class="log-badge log-${l.level}">${l.level}</span>
        <span>[${escapeHtml(l.source)}] ${escapeHtml(l.message)}</span>
      </div>
    `
    )
    .join('');

  if (document.getElementById('logAutoScrollCheck')?.checked) {
    term.scrollTop = term.scrollHeight;
  }
}

function appendSingleLogLine(l) {
  const term = document.getElementById('logsTerminalOutput');
  if (!term) return;
  if (currentLogLevel !== 'all' && l.level !== currentLogLevel) return;
  const query = (document.getElementById('logSearchInput')?.value || '').trim().toLowerCase();
  if (query && !l.message.toLowerCase().includes(query)) return;

  const div = document.createElement('div');
  div.className = 'log-line';
  div.innerHTML = `
    <span class="log-time">${new Date(l.timestamp).toLocaleTimeString()}</span>
    <span class="log-badge log-${l.level}">${l.level}</span>
    <span>[${escapeHtml(l.source)}] ${escapeHtml(l.message)}</span>
  `;
  term.appendChild(div);
  if (document.getElementById('logAutoScrollCheck')?.checked) {
    term.scrollTop = term.scrollHeight;
  }
}

async function fetchSystemHealth() {
  try {
    const res = await fetch('/api/system/status');
    const data = await res.json();
    document.getElementById('sysPlatformText').textContent = data.platform;
    document.getElementById('sysNodeText').textContent = `Node ${data.nodeVersion} • ${data.cpus} CPU Cores`;
    document.getElementById('sysMemoryText').textContent = `${data.memory.rssMb} MB App / ${data.memory.sysTotalMb} MB Total`;
    const pct = Math.min(100, Math.round(((data.memory.sysTotalMb - data.memory.sysFreeMb) / data.memory.sysTotalMb) * 100));
    document.getElementById('sysMemBar').style.width = `${pct}%`;

    const hrs = Math.floor(data.uptimeSeconds / 3600);
    const mins = Math.floor((data.uptimeSeconds % 3600) / 60);
    const secs = data.uptimeSeconds % 60;
    document.getElementById('sysUptimeText').textContent = `${hrs}h ${mins}m ${secs}s`;
    document.getElementById('sysPortsText').textContent = `HTTP: ${data.ports.http} | RTMP: ${data.ports.rtmp} | FLV: ${data.ports.httpFlv}`;

    if (data.tunnel) {
      tunnelInfo = data.tunnel;
      updateTunnelUiBanner();
    }
  } catch (_) {}
}

updateTunnelUiBanner();
fetchSystemHealth();
