const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const { Server } = require('socket.io');
const cors = require('cors');
const multer = require('multer');
const { initializeRtmpServer } = require('./rtmp-config');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  maxHttpBufferSize: 5e7
});

const PORT = parseInt(process.env.SERVER_PORT || process.env.PORT || 3000, 10);

function ensureWritableDir(dirPath, fallbackName) {
  try {
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true, mode: 0o777 });
    }
    fs.accessSync(dirPath, fs.constants.W_OK);
    return dirPath;
  } catch (_) {
    const fallbackDir = path.join(os.tmpdir(), 'sletoyt_' + fallbackName);
    if (!fs.existsSync(fallbackDir)) {
      fs.mkdirSync(fallbackDir, { recursive: true, mode: 0o777 });
    }
    return fallbackDir;
  }
}

const DATA_DIR = ensureWritableDir(path.join(__dirname, 'data'), 'data');
const ASSETS_DIR = ensureWritableDir(path.join(__dirname, 'assets'), 'assets');
const MEDIA_DIR = ensureWritableDir(path.join(__dirname, 'media'), 'media');
const UPLOADS_DIR = ensureWritableDir(path.join(__dirname, 'uploads'), 'uploads');
const INSTANCES_FILE = path.join(DATA_DIR, 'instances.json');

const FALLBACK_16_9 = path.join(ASSETS_DIR, 'fallback_16_9.mp4');
const FALLBACK_9_16 = path.join(ASSETS_DIR, 'fallback_9_16.mp4');

const LOGS_BUFFER = [];
const MAX_LOGS = 200;

function addLog(level, message, source = 'SYSTEM') {
  if (!message) return;
  const entry = {
    id: Date.now() + '_' + Math.random().toString(36).substr(2, 4),
    timestamp: new Date().toISOString(),
    level: String(level).toUpperCase(),
    source: String(source).toUpperCase(),
    message: typeof message === 'object' ? JSON.stringify(message) : String(message)
  };

  LOGS_BUFFER.push(entry);
  if (LOGS_BUFFER.length > MAX_LOGS) {
    LOGS_BUFFER.shift();
  }

  try {
    io.emit('log:entry', entry);
  } catch (_) {}

  return entry;
}

const origLog = console.log;
const origWarn = console.warn;
const origError = console.error;

console.log = function (...args) {
  origLog.apply(console, args);
  addLog('INFO', args.join(' '), 'SERVER');
};
console.warn = function (...args) {
  origWarn.apply(console, args);
  addLog('WARN', args.join(' '), 'SERVER');
};
console.error = function (...args) {
  origError.apply(console, args);
  addLog('ERROR', args.join(' '), 'SERVER');
};

app.use(cors());
app.use(express.json({ limit: '25mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(UPLOADS_DIR));
app.use('/assets', express.static(ASSETS_DIR));

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const cleanName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    cb(null, `${Date.now()}_${cleanName}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 300 * 1024 * 1024 }
});

function detectFileCategory(filename) {
  const ext = path.extname(filename).toLowerCase();
  if (['.mp3', '.wav', '.ogg', '.aac', '.m4a', '.flac'].includes(ext)) return 'audio';
  if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'].includes(ext)) return 'image';
  if (['.mp4', '.webm', '.mkv', '.mov', '.flv'].includes(ext)) return 'video';
  return 'other';
}

function listUploadedFiles() {
  if (!fs.existsSync(UPLOADS_DIR)) return [];
  const files = fs.readdirSync(UPLOADS_DIR);
  return files
    .map((filename) => {
      const fullPath = path.join(UPLOADS_DIR, filename);
      try {
        const stat = fs.statSync(fullPath);
        if (!stat.isFile()) return null;
        const displayName = filename.replace(/^\d+_/, '');
        return {
          id: filename,
          filename,
          displayName,
          category: detectFileCategory(filename),
          sizeBytes: stat.size,
          url: `/uploads/${encodeURIComponent(filename)}`,
          downloadUrl: `/api/files/${encodeURIComponent(filename)}/download`,
          uploadedAt: stat.mtime.toISOString()
        };
      } catch (_) {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));
}

function generateFallbackVideo(filePath, resolution, titleText) {
  return new Promise((resolve) => {
    if (fs.existsSync(filePath) && fs.statSync(filePath).size > 1000) {
      return resolve();
    }
    const [w, h] = resolution.split('x');
    const args = [
      '-y',
      '-f', 'lavfi',
      '-i', `color=c=#0f172a:s=${resolution}:r=15:d=4`,
      '-f', 'lavfi',
      '-i', 'anullsrc=r=44100:cl=stereo',
      '-vf',
      `drawbox=x=20:y=20:w=${w}-40:h=${h}-40:color=#38bdf8@0.6:t=3,` +
      `drawtext=text='${titleText}':fontcolor=#f8fafc:fontsize=26:x=(w-text_w)/2:y=(h-text_h)/2-15,` +
      `drawtext=text='Waiting for OBS Stream...':fontcolor=#f472b6:fontsize=16:x=(w-text_w)/2:y=(h-text_h)/2+20`,
      '-c:v', 'libx264',
      '-preset', 'ultrafast',
      '-crf', '30',
      '-pix_fmt', 'yuv420p',
      '-c:a', 'aac',
      '-b:a', '64k',
      '-shortest',
      filePath
    ];

    const proc = spawn('ffmpeg', args);
    proc.on('close', () => resolve());
    proc.on('error', () => resolve());
  });
}

async function ensureFallbackAssets() {
  await generateFallbackVideo(FALLBACK_16_9, '640x360', 'SLETO SKY 16-9 STANDBY');
  await generateFallbackVideo(FALLBACK_9_16, '360x640', 'SLETO SKY 9-16 STANDBY');
}
ensureFallbackAssets();

function createDefaultScenes() {
  return [
    {
      id: 'scene_default_main',
      name: '🎮 Main Gameplay (Default)',
      type: 'default',
      triggerColor: '#00ff00',
      colorTolerance: 38,
      bgColor: '#0f172a',
      sources: [
        {
          id: 'src_live_win_1',
          name: 'Incoming Window + Voiceover',
          type: 'live-window',
          url: '',
          text: 'LIVE WINDOW FEED',
          color: '#38bdf8',
          volume: 1.0,
          muted: false,
          loop: true,
          visible: true,
          rect169: { x: 0, y: 0, w: 1920, h: 1080 },
          rect916: { x: 40, y: 420, w: 1000, h: 600 }
        },
        {
          id: 'src_title_1',
          name: 'Stream Tag Banner',
          type: 'text',
          url: '',
          text: '☁️ SLETO LIVE 24/7',
          color: '#f472b6',
          volume: 1.0,
          muted: true,
          loop: true,
          visible: true,
          rect169: { x: 40, y: 36, w: 480, h: 72 },
          rect916: { x: 140, y: 120, w: 800, h: 110 }
        }
      ]
    },
    {
      id: 'scene_color_pause',
      name: '🌸 Sky Pause Screen (Color Auto)',
      type: 'color-detect',
      triggerColor: '#000000',
      colorTolerance: 28,
      bgColor: '#1e1b4b',
      sources: [
        {
          id: 'src_pause_banner',
          name: 'Pause Heading',
          type: 'text',
          url: '',
          text: '✨ STREAM IS PAUSED ✨',
          color: '#38bdf8',
          volume: 1.0,
          muted: true,
          loop: true,
          visible: true,
          rect169: { x: 360, y: 420, w: 1200, h: 160 },
          rect916: { x: 80, y: 780, w: 920, h: 200 }
        },
        {
          id: 'src_pause_sub',
          name: 'Pause Subtitle',
          type: 'text',
          url: '',
          text: 'Wait For Few Sec • Starting Soon!',
          color: '#f472b6',
          volume: 1.0,
          muted: true,
          loop: true,
          visible: true,
          rect169: { x: 460, y: 600, w: 1000, h: 90 },
          rect916: { x: 120, y: 1010, w: 840, h: 110 }
        }
      ]
    },
    {
      id: 'scene_net_error',
      name: '📡 Network Error Fallback',
      type: 'network-error',
      triggerColor: '#ff0055',
      colorTolerance: 30,
      bgColor: '#172554',
      sources: [
        {
          id: 'src_net_err_txt',
          name: 'Reconnecting Notice',
          type: 'text',
          url: '',
          text: '☁️ SIGNAL LOST — RECONNECTING OBS...',
          color: '#38bdf8',
          volume: 1.0,
          muted: true,
          loop: true,
          visible: true,
          rect169: { x: 310, y: 450, w: 1300, h: 160 },
          rect916: { x: 70, y: 820, w: 940, h: 220 }
        }
      ]
    }
  ];
}

const instances = new Map();

function normalizeScenes(scenes) {
  if (!Array.isArray(scenes) || scenes.length === 0) {
    return createDefaultScenes();
  }
  let hasDefault = false;
  const normalized = scenes.map((sc, idx) => {
    let type = sc.type || (idx === 0 ? 'default' : 'color-detect');
    if (type === 'default') {
      if (hasDefault) {
        type = 'color-detect';
      } else {
        hasDefault = true;
      }
    }
    const sources = Array.isArray(sc.sources)
      ? sc.sources.map((src) => ({
          id: src.id || 'src_' + Math.random().toString(36).substr(2, 6),
          name: src.name || 'Source Layer',
          type: src.type || 'text',
          url: src.url || '',
          fileId: src.fileId || '',
          text: src.text || '',
          color: src.color || '#38bdf8',
          volume: typeof src.volume === 'number' ? src.volume : 1.0,
          muted: Boolean(src.muted),
          loop: src.loop !== undefined ? Boolean(src.loop) : true,
          visible: src.visible !== undefined ? Boolean(src.visible) : true,
          rect169: src.rect169 || { x: 100, y: 100, w: 640, h: 360 },
          rect916: src.rect916 || { x: 80, y: 400, w: 920, h: 520 }
        }))
      : [];

    return {
      id: sc.id || 'scene_' + Math.random().toString(36).substr(2, 6),
      name: sc.name || `Scene ${idx + 1}`,
      type,
      triggerColor: sc.triggerColor || '#000000',
      colorTolerance: Number(sc.colorTolerance) || 32,
      bgColor: sc.bgColor || '#0f172a',
      sources
    };
  });

  if (!hasDefault && normalized.length > 0) {
    normalized[0].type = 'default';
  }
  return normalized;
}

function serializeInstance(inst) {
  return {
    id: inst.id,
    name: inst.name,
    mode: 'window-voiceover-dual',
    rtmpIngestKey: inst.rtmpIngestKey,
    rtmpUrl169: inst.rtmpUrl169 || 'rtmp://a.rtmp.youtube.com/live2',
    streamKey169: inst.streamKey169 || '',
    enable169: inst.enable169 !== undefined ? Boolean(inst.enable169) : true,
    rtmpUrl916: inst.rtmpUrl916 || 'rtmp://a.rtmp.youtube.com/live2',
    streamKey916: inst.streamKey916 || '',
    enable916: inst.enable916 !== undefined ? Boolean(inst.enable916) : true,
    fps: Number(inst.fps) || 30,
    bitrate: Number(inst.bitrate) || 2500,
    autoSceneSwitch: inst.autoSceneSwitch !== undefined ? Boolean(inst.autoSceneSwitch) : true,
    activeSceneId: inst.activeSceneId,
    scenes: normalizeScenes(inst.scenes),
    status: inst.status || 'offline',
    obsConnected: Boolean(inst.obsConnected),
    detectedScreenColor: inst.detectedScreenColor || null,
    lastSwitchReason: inst.lastSwitchReason || 'Manual / Initial',
    uptimeStart: inst.uptimeStart || null
  };
}

function saveInstancesToDisk() {
  try {
    const list = Array.from(instances.values()).map(serializeInstance);
    fs.writeFileSync(INSTANCES_FILE, JSON.stringify(list, null, 2), 'utf8');
  } catch (err) {
    origError('[Storage Error]', err.message);
  }
}

function loadInstancesFromDisk() {
  try {
    if (!fs.existsSync(INSTANCES_FILE)) {
      const defaultScenes = createDefaultScenes();
      const demoId = 'inst_main_1';
      instances.set(demoId, {
        id: demoId,
        name: 'Sleto 24/7 Dual Playout (16:9 + 9:16)',
        mode: 'window-voiceover-dual',
        rtmpIngestKey: 'live_sleto',
        rtmpUrl169: 'rtmp://a.rtmp.youtube.com/live2',
        streamKey169: '',
        enable169: true,
        rtmpUrl916: 'rtmp://a.rtmp.youtube.com/live2',
        streamKey916: '',
        enable916: true,
        fps: 30,
        bitrate: 2500,
        autoSceneSwitch: true,
        activeSceneId: defaultScenes[0].id,
        scenes: defaultScenes,
        status: 'offline',
        obsConnected: false,
        detectedScreenColor: null,
        lastSwitchReason: 'Default Startup',
        uptimeStart: null,
        proc169: null,
        proc916: null,
        colorDetectorProc: null
      });
      saveInstancesToDisk();
      return;
    }
    const raw = fs.readFileSync(INSTANCES_FILE, 'utf8');
    const list = JSON.parse(raw);
    list.forEach((item) => {
      const scenes = normalizeScenes(item.scenes);
      const defaultScene = scenes.find((s) => s.type === 'default') || scenes[0];
      instances.set(item.id, {
        ...item,
        mode: 'window-voiceover-dual',
        scenes,
        activeSceneId: scenes.some((s) => s.id === item.activeSceneId)
          ? item.activeSceneId
          : defaultScene.id,
        status: 'offline',
        obsConnected: false,
        detectedScreenColor: null,
        lastSwitchReason: 'Ready',
        uptimeStart: null,
        proc169: null,
        proc916: null,
        colorDetectorProc: null
      });
    });
  } catch (err) {
    origError('[Storage Load Error]', err.message);
  }
}

loadInstancesFromDisk();

function broadcastInstanceStatus() {
  const payload = Array.from(instances.values()).map(serializeInstance);
  io.emit('instances-update', payload);
}

function hexToRgb(hex) {
  const clean = String(hex || '#000000').replace('#', '').trim();
  if (clean.length !== 6) return { r: 0, g: 0, b: 0 };
  const num = parseInt(clean, 16);
  if (Number.isNaN(num)) return { r: 0, g: 0, b: 0 };
  return {
    r: (num >> 16) & 255,
    g: (num >> 8) & 255,
    b: num & 255
  };
}

function rgbToHex(r, g, b) {
  const toHex = (n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

function colorDistance(rgb1, rgb2) {
  const dr = rgb1.r - rgb2.r;
  const dg = rgb1.g - rgb2.g;
  const db = rgb1.b - rgb2.b;
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

function switchInstanceScene(inst, targetSceneId, reason = 'Manual Switch') {
  if (!inst) return false;
  const targetScene = inst.scenes.find((s) => s.id === targetSceneId);
  if (!targetScene) return false;
  if (inst.activeSceneId === targetSceneId) return false;

  inst.activeSceneId = targetSceneId;
  inst.lastSwitchReason = reason;
  addLog(
    'SCENE',
    `[${inst.name}] Switched to "${targetScene.name}" (${targetScene.type.toUpperCase()}) — Reason: ${reason}`,
    'SCENE-ENGINE'
  );

  saveInstancesToDisk();
  broadcastInstanceStatus();
  io.emit('scene-switched', {
    instanceId: inst.id,
    activeSceneId: inst.activeSceneId,
    sceneName: targetScene.name,
    sceneType: targetScene.type,
    reason
  });

  if (inst.status === 'live' && inst.playoutDriver === 'backend') {
    restartBackendDualPlayoutOnSceneChange(inst);
  }
  return true;
}

function startBackendColorDetector(inst) {
  stopBackendColorDetector(inst);
  if (!inst.obsConnected) return;

  const localRtmpInput = `rtmp://127.0.0.1:${rtmpPort}/live/${inst.rtmpIngestKey}`;
  const cleanArgs = [
    '-loglevel', 'quiet',
    '-threads', '1',
    '-i', localRtmpInput,
    '-vf', 'fps=1,scale=8:8',
    '-f', 'rawvideo',
    '-pix_fmt', 'rgb24',
    'pipe:1'
  ];

  const proc = spawn('ffmpeg', cleanArgs);
  inst.colorDetectorProc = proc;

  const FRAME_BYTES = 8 * 8 * 3;
  let buffer = Buffer.alloc(0);

  proc.stdout.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= FRAME_BYTES) {
      const frame = buffer.subarray(0, FRAME_BYTES);
      buffer = buffer.subarray(FRAME_BYTES);
      evaluateFullScreenColorFrame(inst, frame);
    }
  });

  proc.on('close', () => {
    if (inst.colorDetectorProc === proc) {
      inst.colorDetectorProc = null;
    }
  });
  proc.on('error', () => {});
}

function stopBackendColorDetector(inst) {
  if (inst && inst.colorDetectorProc) {
    try {
      inst.colorDetectorProc.kill('SIGKILL');
    } catch (_) {}
    inst.colorDetectorProc = null;
  }
}

function evaluateFullScreenColorFrame(inst, frameBuffer) {
  const totalPixels = 64;
  let sumR = 0;
  let sumG = 0;
  let sumB = 0;

  for (let i = 0; i < frameBuffer.length; i += 3) {
    sumR += frameBuffer[i];
    sumG += frameBuffer[i + 1];
    sumB += frameBuffer[i + 2];
  }

  const avgRgb = {
    r: Math.round(sumR / totalPixels),
    g: Math.round(sumG / totalPixels),
    b: Math.round(sumB / totalPixels)
  };

  let uniformCount = 0;
  for (let i = 0; i < frameBuffer.length; i += 3) {
    const px = { r: frameBuffer[i], g: frameBuffer[i + 1], b: frameBuffer[i + 2] };
    if (colorDistance(px, avgRgb) <= 35) {
      uniformCount++;
    }
  }

  const uniformityRatio = uniformCount / totalPixels;
  const currentHex = rgbToHex(avgRgb.r, avgRgb.g, avgRgb.b);
  inst.detectedScreenColor = currentHex;

  io.emit('color-telemetry', {
    instanceId: inst.id,
    detectedHex: currentHex,
    uniformity: Math.round(uniformityRatio * 100)
  });

  if (!inst.autoSceneSwitch || !inst.obsConnected) return;

  const colorScenes = inst.scenes.filter((s) => s.type === 'color-detect');
  const defaultScene = inst.scenes.find((s) => s.type === 'default') || inst.scenes[0];

  if (uniformityRatio >= 0.80) {
    for (const cScene of colorScenes) {
      const targetRgb = hexToRgb(cScene.triggerColor);
      const dist = colorDistance(avgRgb, targetRgb);
      const maxDist = (Number(cScene.colorTolerance) || 32) * 1.8;
      if (dist <= maxDist) {
        if (inst.activeSceneId !== cScene.id) {
          switchInstanceScene(
            inst,
            cScene.id,
            `Full-Screen Color Match (${currentHex} ≈ ${cScene.triggerColor})`
          );
        }
        return;
      }
    }
  }

  const activeScene = inst.scenes.find((s) => s.id === inst.activeSceneId);
  if (activeScene && activeScene.type === 'color-detect' && defaultScene) {
    switchInstanceScene(
      inst,
      defaultScene.id,
      `Trigger Color Cleared (${currentHex}) -> Reverted to Default Scene`
    );
  }
}

function resolveLocalFilePath(src) {
  if (src.fileId) {
    const candidate = path.join(UPLOADS_DIR, path.basename(src.fileId));
    if (fs.existsSync(candidate)) return candidate;
  }
  if (src.url && src.url.startsWith('/uploads/')) {
    const decoded = decodeURIComponent(src.url.replace('/uploads/', ''));
    const candidate = path.join(UPLOADS_DIR, path.basename(decoded));
    if (fs.existsSync(candidate)) return candidate;
  }
  if (src.url && /^https?:\/\//i.test(src.url)) {
    return src.url;
  }
  return null;
}

function spawnScenePlayoutProcess(inst, ratioKey, rtmpTargetUrl, streamKey) {
  const cleanUrl = (rtmpTargetUrl || '').trim().replace(/\/$/, '');
  const cleanKey = (streamKey || '').trim();
  if (!cleanUrl || !cleanKey) return null;

  const destination = `${cleanUrl}/${cleanKey}`;
  const is916 = ratioKey === '916';
  const outW = is916 ? 720 : 1280;
  const outH = is916 ? 1280 : 720;
  const scaleFactorX = is916 ? 720 / 1080 : 1280 / 1920;
  const scaleFactorY = is916 ? 1280 / 1920 : 720 / 1080;

  const fps = Number(inst.fps) || 30;
  const bitrate = Number(inst.bitrate) || 2200;

  const activeScene =
    inst.scenes.find((s) => s.id === inst.activeSceneId) ||
    inst.scenes.find((s) => s.type === 'default') ||
    inst.scenes[0];

  const bgHex = (activeScene?.bgColor || '#0f172a').replace('#', '0x');
  const sources = (activeScene?.sources || []).filter((s) => s.visible !== false);

  const liveWindowSrc = sources.find((s) => s.type === 'live-window');
  const videoSrc = sources.find((s) => s.type === 'video' && resolveLocalFilePath(s));
  const audioSrc = sources.find((s) => s.type === 'audio' && resolveLocalFilePath(s) && !s.muted);
  const textSources = sources.filter((s) => s.type === 'text' && s.text);

  const args = ['-y', '-loglevel', 'warning', '-threads', '2'];

  let mainVideoInputIndex = -1;
  let mainAudioInputIndex = -1;

  if (liveWindowSrc && inst.obsConnected && activeScene.type !== 'network-error') {
    args.push('-i', `rtmp://127.0.0.1:${rtmpPort}/live/${inst.rtmpIngestKey}`);
    mainVideoInputIndex = 0;
    if (!liveWindowSrc.muted) {
      mainAudioInputIndex = 0;
    }
  } else if (videoSrc) {
    const vPath = resolveLocalFilePath(videoSrc);
    if (videoSrc.loop !== false) {
      args.push('-stream_loop', '-1');
    }
    args.push('-re', '-i', vPath);
    mainVideoInputIndex = 0;
    if (!videoSrc.muted) {
      mainAudioInputIndex = 0;
    }
  } else {
    args.push('-f', 'lavfi', '-i', `color=c=${bgHex}:s=${outW}x${outH}:r=${fps}`);
    mainVideoInputIndex = 0;
  }

  let bgAudioInputIndex = -1;
  if (audioSrc) {
    const aPath = resolveLocalFilePath(audioSrc);
    if (audioSrc.loop !== false) {
      args.push('-stream_loop', '-1');
    }
    args.push('-i', aPath);
    bgAudioInputIndex = 1;
  } else if (mainAudioInputIndex === -1) {
    args.push('-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo');
    bgAudioInputIndex = 1;
  }

  const vfParts = [`scale=${outW}:${outH}:force_original_aspect_ratio=decrease,pad=${outW}:${outH}:(ow-iw)/2:(oh-ih)/2:${bgHex},format=yuv420p`];

  textSources.forEach((tSrc) => {
    const rect = is916 ? (tSrc.rect916 || { x: 80, y: 400, w: 800, h: 100 }) : (tSrc.rect169 || { x: 80, y: 80, w: 800, h: 100 });
    const safeText = String(tSrc.text || '')
      .replace(/[^\x20-\x7E]/g, '')
      .replace(/:/g, '\\:')
      .replace(/'/g, '')
      .trim();
    if (safeText) {
      const fColor = (tSrc.color || '#38bdf8').replace('#', '0x');
      const xPos = Math.max(10, Math.min(outW - 40, Math.round(rect.x * scaleFactorX) || 40));
      const yPos = Math.max(20, Math.min(outH - 40, Math.round(rect.y * scaleFactorY) || 60));
      vfParts.push(`drawtext=text='${safeText}':fontcolor=${fColor}:fontsize=28:x=${xPos}:y=${yPos}:box=1:boxcolor=0x0f172a@0.75:boxborderw=10`);
    }
  });

  args.push('-vf', vfParts.join(','));

  if (mainAudioInputIndex !== -1 && bgAudioInputIndex === -1) {
    args.push('-map', `${mainVideoInputIndex}:v:0`, '-map', `${mainAudioInputIndex}:a:0?`);
  } else if (bgAudioInputIndex !== -1) {
    args.push('-map', `${mainVideoInputIndex}:v:0`, '-map', `${bgAudioInputIndex}:a:0`);
  }

  args.push(
    '-c:v', 'libx264',
    '-preset', 'ultrafast',
    '-tune', 'zerolatency',
    '-b:v', `${bitrate}k`,
    '-maxrate', `${bitrate}k`,
    '-bufsize', `${bitrate * 2}k`,
    '-pix_fmt', 'yuv420p',
    '-g', String(fps * 2),
    '-r', String(fps),
    '-c:a', 'aac',
    '-b:a', '128k',
    '-ar', '44100',
    '-f', 'flv',
    destination
  );

  addLog('FFMPEG', `Starting ${ratioKey === '916' ? '9:16 Vertical' : '16:9 Landscape'} stream for "${inst.name}" [Scene: ${activeScene?.name}]`, 'FFMPEG');

  const proc = spawn('ffmpeg', args);

  proc.stderr.on('data', (data) => {
    const msg = data.toString().trim();
    if (msg && !msg.includes('frame=')) {
      addLog('FFMPEG', `[${inst.name} ${ratioKey}] ${msg.slice(0, 220)}`, 'FFMPEG');
    }
  });

  proc.on('close', (code) => {
    addLog('WARN', `[${inst.name} ${ratioKey}] FFmpeg exited with code ${code}`, 'FFMPEG');
  });

  proc.on('error', (err) => {
    addLog('ERROR', `[${inst.name} ${ratioKey}] FFmpeg spawn error: ${err.message}`, 'FFMPEG');
  });

  return proc;
}

function stopInstanceProcesses(inst) {
  if (!inst) return;
  if (inst.proc169) {
    try {
      if (inst.proc169.stdin) inst.proc169.stdin.end();
      inst.proc169.kill('SIGKILL');
    } catch (_) {}
    inst.proc169 = null;
  }
  if (inst.proc916) {
    try {
      if (inst.proc916.stdin) inst.proc916.stdin.end();
      inst.proc916.kill('SIGKILL');
    } catch (_) {}
    inst.proc916 = null;
  }
}

function startDualBackendPlayout(inst) {
  stopInstanceProcesses(inst);

  const has169 = inst.enable169 && inst.rtmpUrl169 && inst.streamKey169;
  const has916 = inst.enable916 && inst.rtmpUrl916 && inst.streamKey916;

  if (!has169 && !has916) {
    throw new Error('Please configure at least one Stream Key (16:9 or 9:16) before going live.');
  }

  inst.playoutDriver = 'backend';
  inst.status = 'live';
  if (!inst.uptimeStart) inst.uptimeStart = Date.now();

  if (has169) {
    inst.proc169 = spawnScenePlayoutProcess(inst, '169', inst.rtmpUrl169, inst.streamKey169);
  }
  if (has916) {
    inst.proc916 = spawnScenePlayoutProcess(inst, '916', inst.rtmpUrl916, inst.streamKey916);
  }

  broadcastInstanceStatus();
}

function restartBackendDualPlayoutOnSceneChange(inst) {
  if (inst.status !== 'live' || inst.playoutDriver !== 'backend') return;
  try {
    startDualBackendPlayout(inst);
  } catch (err) {
    addLog('ERROR', `Scene switch restart error: ${err.message}`, 'SCENE-ENGINE');
  }
}

function startDualBrowserPipePlayout(inst) {
  stopInstanceProcesses(inst);

  const has169 = inst.enable169 && inst.rtmpUrl169 && inst.streamKey169;
  const has916 = inst.enable916 && inst.rtmpUrl916 && inst.streamKey916;

  if (!has169 && !has916) {
    throw new Error('Please configure at least one Stream Key (16:9 or 9:16) before starting Dual Live.');
  }

  const fps = Number(inst.fps) || 30;
  const bitrate = Number(inst.bitrate) || 2200;

  inst.playoutDriver = 'browser-dual';
  inst.status = 'live';
  inst.uptimeStart = Date.now();

  const buildPipeArgs = (dest) => [
    '-loglevel', 'warning',
    '-threads', '2',
    '-i', 'pipe:0',
    '-c:v', 'libx264',
    '-preset', 'ultrafast',
    '-tune', 'zerolatency',
    '-b:v', `${bitrate}k`,
    '-maxrate', `${bitrate}k`,
    '-bufsize', `${bitrate * 2}k`,
    '-pix_fmt', 'yuv420p',
    '-g', String(fps * 2),
    '-r', String(fps),
    '-c:a', 'aac',
    '-b:a', '128k',
    '-ar', '44100',
    '-f', 'flv',
    dest
  ];

  if (has169) {
    const dest169 = `${inst.rtmpUrl169.replace(/\/$/, '')}/${inst.streamKey169.trim()}`;
    inst.proc169 = spawn('ffmpeg', buildPipeArgs(dest169));
    inst.proc169.stdin.on('error', () => {});
    inst.proc169.stderr.on('data', (d) => {
      const m = d.toString().trim();
      if (m && !m.includes('frame=')) addLog('FFMPEG', `[16:9 Pipe] ${m.slice(0, 180)}`, 'FFMPEG');
    });
  }

  if (has916) {
    const dest916 = `${inst.rtmpUrl916.replace(/\/$/, '')}/${inst.streamKey916.trim()}`;
    inst.proc916 = spawn('ffmpeg', buildPipeArgs(dest916));
    inst.proc916.stdin.on('error', () => {});
    inst.proc916.stderr.on('data', (d) => {
      const m = d.toString().trim();
      if (m && !m.includes('frame=')) addLog('FFMPEG', `[9:16 Pipe] ${m.slice(0, 180)}`, 'FFMPEG');
    });
  }

  broadcastInstanceStatus();
}

const { nms, rtmpPort, httpPort } = initializeRtmpServer({ mediaRoot: MEDIA_DIR });

function extractStreamKeyFromPath(StreamPath = '') {
  const parts = String(StreamPath).split('/').filter(Boolean);
  return parts[parts.length - 1] || '';
}

nms.on('postPublish', (id, StreamPath) => {
  const streamKey = typeof id === 'string' ? extractStreamKeyFromPath(StreamPath) : extractStreamKeyFromPath(id?.streamPath || StreamPath);
  addLog('RTMP', `Incoming OBS stream connected on key: "${streamKey}"`, 'RTMP');

  for (const inst of instances.values()) {
    if (inst.rtmpIngestKey === streamKey) {
      inst.obsConnected = true;
      const defaultScene = inst.scenes.find((s) => s.type === 'default') || inst.scenes[0];

      if (inst.autoSceneSwitch && defaultScene) {
        switchInstanceScene(inst, defaultScene.id, 'OBS Live Signal Connected -> Default Scene');
      } else {
        broadcastInstanceStatus();
        if (inst.status === 'live' && inst.playoutDriver === 'backend') {
          restartBackendDualPlayoutOnSceneChange(inst);
        }
      }

      setTimeout(() => {
        if (inst.obsConnected) startBackendColorDetector(inst);
      }, 1500);
    }
  }
});

nms.on('donePublish', (id, StreamPath) => {
  const streamKey = typeof id === 'string' ? extractStreamKeyFromPath(StreamPath) : extractStreamKeyFromPath(id?.streamPath || StreamPath);
  addLog('WARN', `OBS stream disconnected on key: "${streamKey}"`, 'RTMP');

  for (const inst of instances.values()) {
    if (inst.rtmpIngestKey === streamKey) {
      inst.obsConnected = false;
      inst.detectedScreenColor = null;
      stopBackendColorDetector(inst);

      const netErrScene = inst.scenes.find((s) => s.type === 'network-error');
      if (inst.autoSceneSwitch && netErrScene) {
        switchInstanceScene(inst, netErrScene.id, 'No OBS Live Signal -> Auto Network Error Scene');
      } else {
        broadcastInstanceStatus();
        if (inst.status === 'live' && inst.playoutDriver === 'backend') {
          restartBackendDualPlayoutOnSceneChange(inst);
        }
      }
    }
  }
});

nms.run();

const tunnelState = {
  active: false,
  status: 'starting',
  publicRtmpUrl: null,
  publicWebUrl: null,
  botkeepUrl: process.env.SERVER_PORT ? `http://node7.botkeep.cloud:${PORT}` : null,
  codespacesUrl: process.env.CODESPACE_NAME ? `https://${process.env.CODESPACE_NAME}-${PORT}.${process.env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN || 'app.github.dev'}` : null,
  hostPort: null,
  provider: 'pinggy-tcp',
  updatedAt: null
};

let tunnelProc = null;
let tunnelRetryTimer = null;
let webTunnelProc = null;
let webTunnelRetryTimer = null;

let localtunnelModule = null;
try {
  localtunnelModule = require('localtunnel');
} catch (_) {}

function stripAnsi(str) {
  return String(str || '').replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '');
}

async function startWebTunnel() {
  if (localtunnelModule) {
    try {
      const lt = await localtunnelModule({ port: PORT });
      if (lt && lt.url) {
        tunnelState.publicWebUrl = lt.url;
        tunnelState.updatedAt = new Date().toISOString();
        addLog('INFO', `Public Web Dashboard Ready: ${lt.url}`, 'TUNNEL');
        origLog(`  🌐 Public Web Dashboard:  ${lt.url}`);
        io.emit('tunnel-update', tunnelState);
        lt.on('close', () => setTimeout(startWebTunnel, 5000));
        lt.on('error', () => setTimeout(startWebTunnel, 5000));
        return;
      }
    } catch (_) {}
  }

  if (webTunnelRetryTimer) clearTimeout(webTunnelRetryTimer);
  if (webTunnelProc) {
    try { webTunnelProc.kill('SIGKILL'); } catch (_) {}
    webTunnelProc = null;
  }

  const sshArgs = [
    '-p', '443',
    '-o', 'StrictHostKeyChecking=no',
    '-o', 'UserKnownHostsFile=/dev/null',
    '-o', 'ServerAliveInterval=30',
    '-o', 'ConnectTimeout=12',
    '-T',
    `-R0:127.0.0.1:${PORT}`,
    'a.pinggy.io'
  ];

  try {
    const proc = spawn('ssh', sshArgs);
    webTunnelProc = proc;

    const handleWebOutput = (chunk) => {
      const text = stripAnsi(chunk.toString());
      const match = text.match(/(https?:\/\/[a-zA-Z0-9.-]+\.pinggy\.(?:link|io|online)(?::\d+)?)/i);
      if (match && match[1]) {
        const url = match[1].trim();
        if (tunnelState.publicWebUrl !== url) {
          tunnelState.publicWebUrl = url;
          tunnelState.updatedAt = new Date().toISOString();
          addLog('INFO', `Public Web Dashboard Ready: ${url}`, 'TUNNEL');
          origLog(`  🌐 Public Web Dashboard:  ${url}`);
          io.emit('tunnel-update', tunnelState);
        }
      }
    };

    proc.stdout.on('data', handleWebOutput);
    proc.stderr.on('data', handleWebOutput);

    proc.on('close', () => {
      if (webTunnelProc === proc) {
        webTunnelProc = null;
        webTunnelRetryTimer = setTimeout(startWebTunnel, 5000);
      }
    });
    proc.on('error', () => {});
  } catch (_) {}
}

function startRtmpTunnel() {
  if (tunnelRetryTimer) {
    clearTimeout(tunnelRetryTimer);
    tunnelRetryTimer = null;
  }
  if (tunnelProc) {
    try {
      tunnelProc.kill('SIGKILL');
    } catch (_) {}
    tunnelProc = null;
  }

  tunnelState.status = 'connecting';
  io.emit('tunnel-update', tunnelState);

  const sshArgs = [
    '-p', '443',
    '-o', 'StrictHostKeyChecking=no',
    '-o', 'UserKnownHostsFile=/dev/null',
    '-o', 'ServerAliveInterval=30',
    '-o', 'ConnectTimeout=12',
    '-T',
    `-R0:127.0.0.1:${rtmpPort}`,
    'tcp@a.pinggy.io'
  ];

  try {
    const proc = spawn('ssh', sshArgs);
    tunnelProc = proc;

    const handleTunnelOutput = (chunk) => {
      const text = stripAnsi(chunk.toString());
      const match = text.match(/(?:tcp:\/\/)?([a-zA-Z0-9.-]+\.pinggy\.(?:link|io|online):\d+)/i);
      if (match && match[1]) {
        const hostPort = match[1].trim();
        const rtmpUrl = `rtmp://${hostPort}/live`;
        if (tunnelState.publicRtmpUrl !== rtmpUrl) {
          tunnelState.active = true;
          tunnelState.status = 'connected';
          tunnelState.hostPort = hostPort;
          tunnelState.publicRtmpUrl = rtmpUrl;
          tunnelState.updatedAt = new Date().toISOString();
          addLog('RTMP', `Public OBS RTMP Tunnel Ready: ${rtmpUrl}`, 'TUNNEL');
          origLog(`  🔗 Public OBS RTMP Server: ${rtmpUrl}`);
          io.emit('tunnel-update', tunnelState);
        }
      }
    };

    proc.stdout.on('data', handleTunnelOutput);
    proc.stderr.on('data', handleTunnelOutput);

    proc.on('close', () => {
      if (tunnelProc === proc) {
        tunnelProc = null;
        tunnelState.active = false;
        tunnelState.status = 'reconnecting';
        io.emit('tunnel-update', tunnelState);
        tunnelRetryTimer = setTimeout(() => startRtmpTunnel(), 5000);
      }
    });

    proc.on('error', (err) => {
      tunnelState.active = false;
      tunnelState.status = 'unavailable';
      addLog('WARN', `SSH tunnel unavailable (${err.message}). Direct VPS IP port ${rtmpPort} remains active.`, 'TUNNEL');
      io.emit('tunnel-update', tunnelState);
    });
  } catch (_) {
    tunnelState.status = 'unavailable';
  }
}

startRtmpTunnel();
startWebTunnel();

app.get('/api/tunnel', (req, res) => {
  res.json({
    ...tunnelState,
    port: PORT,
    isBotkeep: Boolean(process.env.SERVER_PORT),
    botkeepUrl: process.env.SERVER_PORT ? `http://node7.botkeep.cloud:${PORT}` : null
  });
});

app.post('/api/tunnel/restart', (req, res) => {
  startRtmpTunnel();
  startWebTunnel();
  res.json({ success: true, tunnelState });
});

app.get('/api/flv-proxy/:streamName', (req, res) => {
  const { streamName } = req.params;
  const targetUrl = `http://127.0.0.1:${httpPort}/live/${streamName}.flv`;

  const proxyReq = http.get(targetUrl, (proxyRes) => {
    if (proxyRes.statusCode !== 200) {
      res.status(proxyRes.statusCode || 404).end();
      return;
    }
    res.setHeader('Content-Type', 'video/x-flv');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Access-Control-Allow-Origin', '*');
    proxyRes.pipe(res);
  });

  proxyReq.on('error', () => {
    if (!res.headersSent) res.status(502).end();
  });

  req.on('close', () => {
    proxyReq.destroy();
  });
});

app.get('/api/files', (req, res) => {
  res.json(listUploadedFiles());
});

app.post('/api/files/upload', upload.single('file'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file selected for upload' });
  }
  addLog('INFO', `Uploaded file "${req.file.originalname}" (${Math.round(req.file.size / 1024)} KB)`, 'FILES');
  const files = listUploadedFiles();
  io.emit('files-update', files);
  const created = files.find((f) => f.filename === req.file.filename);
  res.json({ success: true, file: created, files });
});

app.get('/api/files/:id/download', (req, res) => {
  const safeName = path.basename(req.params.id);
  const fullPath = path.join(UPLOADS_DIR, safeName);
  if (!fs.existsSync(fullPath)) {
    return res.status(404).json({ error: 'File not found' });
  }
  const downloadName = safeName.replace(/^\d+_/, '');
  res.download(fullPath, downloadName);
});

app.put('/api/files/:id', (req, res) => {
  const safeName = path.basename(req.params.id);
  const fullPath = path.join(UPLOADS_DIR, safeName);
  if (!fs.existsSync(fullPath)) {
    return res.status(404).json({ error: 'File not found' });
  }
  const ext = path.extname(safeName);
  const cleanTitle = String(req.body.newName || 'file').replace(/[^a-zA-Z0-9._-]/g, '_');
  const prefix = (safeName.match(/^\d+_/) || [`${Date.now()}_`])[0];
  const finalFilename = cleanTitle.endsWith(ext) ? `${prefix}${cleanTitle}` : `${prefix}${cleanTitle}${ext}`;
  const newFullPath = path.join(UPLOADS_DIR, finalFilename);

  fs.renameSync(fullPath, newFullPath);

  for (const inst of instances.values()) {
    inst.scenes.forEach((sc) => {
      sc.sources.forEach((src) => {
        if (src.fileId === safeName) {
          src.fileId = finalFilename;
          src.url = `/uploads/${encodeURIComponent(finalFilename)}`;
        }
      });
    });
  }
  saveInstancesToDisk();
  const files = listUploadedFiles();
  io.emit('files-update', files);
  broadcastInstanceStatus();
  res.json({ success: true, files });
});

app.delete('/api/files/:id', (req, res) => {
  const safeName = path.basename(req.params.id);
  const fullPath = path.join(UPLOADS_DIR, safeName);
  if (fs.existsSync(fullPath)) {
    fs.unlinkSync(fullPath);
    addLog('WARN', `Deleted cloud file: ${safeName}`, 'FILES');
  }
  const files = listUploadedFiles();
  io.emit('files-update', files);
  res.json({ success: true, files });
});

app.get('/api/instances', (req, res) => {
  res.json(Array.from(instances.values()).map(serializeInstance));
});

app.post('/api/instances', (req, res) => {
  const {
    name,
    rtmpIngestKey,
    rtmpUrl169,
    streamKey169,
    enable169,
    rtmpUrl916,
    streamKey916,
    enable916,
    fps,
    bitrate,
    autoSceneSwitch
  } = req.body;

  const id = 'inst_' + Date.now().toString(36);
  const defaultScenes = createDefaultScenes();

  const newInst = {
    id,
    name: name || 'Dual Live Channel (16:9 + 9:16)',
    mode: 'window-voiceover-dual',
    rtmpIngestKey: (rtmpIngestKey || 'live_' + Math.random().toString(36).substr(2, 5)).trim(),
    rtmpUrl169: rtmpUrl169 || 'rtmp://a.rtmp.youtube.com/live2',
    streamKey169: streamKey169 || '',
    enable169: enable169 !== undefined ? Boolean(enable169) : true,
    rtmpUrl916: rtmpUrl916 || 'rtmp://a.rtmp.youtube.com/live2',
    streamKey916: streamKey916 || '',
    enable916: enable916 !== undefined ? Boolean(enable916) : true,
    fps: Number(fps) || 30,
    bitrate: Number(bitrate) || 2500,
    autoSceneSwitch: autoSceneSwitch !== undefined ? Boolean(autoSceneSwitch) : true,
    activeSceneId: defaultScenes[0].id,
    scenes: defaultScenes,
    status: 'offline',
    obsConnected: false,
    detectedScreenColor: null,
    lastSwitchReason: 'Created',
    uptimeStart: null,
    proc169: null,
    proc916: null,
    colorDetectorProc: null
  };

  instances.set(id, newInst);
  saveInstancesToDisk();
  broadcastInstanceStatus();
  addLog('INFO', `Created Dual Playout Instance: "${newInst.name}"`, 'API');
  res.json(serializeInstance(newInst));
});

app.put('/api/instances/:id', (req, res) => {
  const inst = instances.get(req.params.id);
  if (!inst) return res.status(404).json({ error: 'Instance not found' });

  const {
    name,
    rtmpIngestKey,
    rtmpUrl169,
    streamKey169,
    enable169,
    rtmpUrl916,
    streamKey916,
    enable916,
    fps,
    bitrate,
    autoSceneSwitch,
    activeSceneId,
    scenes
  } = req.body;

  if (name !== undefined) inst.name = name;
  if (rtmpIngestKey !== undefined) inst.rtmpIngestKey = rtmpIngestKey.trim();
  if (rtmpUrl169 !== undefined) inst.rtmpUrl169 = rtmpUrl169.trim();
  if (streamKey169 !== undefined) inst.streamKey169 = streamKey169.trim();
  if (enable169 !== undefined) inst.enable169 = Boolean(enable169);
  if (rtmpUrl916 !== undefined) inst.rtmpUrl916 = rtmpUrl916.trim();
  if (streamKey916 !== undefined) inst.streamKey916 = streamKey916.trim();
  if (enable916 !== undefined) inst.enable916 = Boolean(enable916);
  if (fps !== undefined) inst.fps = Number(fps);
  if (bitrate !== undefined) inst.bitrate = Number(bitrate);
  if (autoSceneSwitch !== undefined) inst.autoSceneSwitch = Boolean(autoSceneSwitch);

  if (Array.isArray(scenes)) {
    inst.scenes = normalizeScenes(scenes);
  }
  if (activeSceneId && inst.scenes.some((s) => s.id === activeSceneId)) {
    inst.activeSceneId = activeSceneId;
  } else if (!inst.scenes.some((s) => s.id === inst.activeSceneId)) {
    inst.activeSceneId = inst.scenes[0].id;
  }

  saveInstancesToDisk();
  broadcastInstanceStatus();
  res.json(serializeInstance(inst));
});

app.post('/api/instances/:id/scene-switch', (req, res) => {
  const inst = instances.get(req.params.id);
  if (!inst) return res.status(404).json({ error: 'Instance not found' });

  const { sceneId, reason } = req.body;
  const switched = switchInstanceScene(inst, sceneId, reason || 'Manual User Switch');
  res.json({
    success: switched,
    activeSceneId: inst.activeSceneId,
    instance: serializeInstance(inst)
  });
});

app.delete('/api/instances/:id', (req, res) => {
  const inst = instances.get(req.params.id);
  if (!inst) return res.status(404).json({ error: 'Instance not found' });

  stopInstanceProcesses(inst);
  stopBackendColorDetector(inst);
  instances.delete(req.params.id);
  saveInstancesToDisk();
  broadcastInstanceStatus();
  addLog('WARN', `Deleted instance "${inst.name}"`, 'API');
  res.json({ success: true });
});

app.post('/api/instances/:id/start', (req, res) => {
  const inst = instances.get(req.params.id);
  if (!inst) return res.status(404).json({ error: 'Instance not found' });

  try {
    startDualBackendPlayout(inst);
    res.json({ success: true, message: `Started Dual Playout (16:9 + 9:16) for ${inst.name}` });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/instances/:id/start-dual-canvas', (req, res) => {
  const inst = instances.get(req.params.id);
  if (!inst) return res.status(404).json({ error: 'Instance not found' });

  try {
    startDualBrowserPipePlayout(inst);
    res.json({ success: true, message: `Started Dual Studio Live (16:9 + 9:16) for ${inst.name}` });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/instances/:id/stop', (req, res) => {
  const inst = instances.get(req.params.id);
  if (!inst) return res.status(404).json({ error: 'Instance not found' });

  stopInstanceProcesses(inst);
  inst.status = 'offline';
  inst.uptimeStart = null;
  broadcastInstanceStatus();
  addLog('INFO', `Stopped Dual Broadcast for "${inst.name}"`, 'API');
  res.json({ success: true });
});

app.get('/api/logs', (req, res) => {
  const { level, search, limit } = req.query;
  let filtered = [...LOGS_BUFFER];

  if (level && level.toLowerCase() !== 'all') {
    filtered = filtered.filter((l) => l.level.toLowerCase() === level.toLowerCase());
  }

  if (search && search.trim()) {
    const q = search.trim().toLowerCase();
    filtered = filtered.filter(
      (l) => l.message.toLowerCase().includes(q) || l.source.toLowerCase().includes(q)
    );
  }

  const max = parseInt(limit, 10) || 150;
  res.json({
    total: LOGS_BUFFER.length,
    returned: Math.min(filtered.length, max),
    logs: filtered.slice(-max)
  });
});

app.post('/api/logs/clear', (req, res) => {
  LOGS_BUFFER.length = 0;
  io.emit('logs:cleared');
  addLog('INFO', 'Logs buffer cleared by user', 'SYSTEM');
  res.json({ success: true });
});

app.get('/api/system/status', (req, res) => {
  const mem = process.memoryUsage();
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const activeProcesses = Array.from(instances.values()).filter((i) => i.status === 'live').length;

  res.json({
    platform: `${os.type()} ${os.release()} (${os.arch()})`,
    nodeVersion: process.version,
    uptimeSeconds: Math.floor(process.uptime()),
    systemUptime: Math.floor(os.uptime()),
    cpus: os.cpus().length,
    memory: {
      heapUsedMb: Math.round(mem.heapUsed / 1024 / 1024),
      heapTotalMb: Math.round(mem.heapTotal / 1024 / 1024),
      rssMb: Math.round(mem.rss / 1024 / 1024),
      sysTotalMb: Math.round(totalMem / 1024 / 1024),
      sysFreeMb: Math.round(freeMem / 1024 / 1024)
    },
    activeInstances: instances.size,
    activePlayouts: activeProcesses,
    storedFilesCount: listUploadedFiles().length,
    tunnel: tunnelState,
    ports: {
      http: PORT,
      rtmp: rtmpPort,
      httpFlv: httpPort
    }
  });
});

io.on('connection', (socket) => {
  socket.emit('instances-update', Array.from(instances.values()).map(serializeInstance));
  socket.emit('logs:history', LOGS_BUFFER.slice(-100));
  socket.emit('files-update', listUploadedFiles());
  socket.emit('tunnel-update', tunnelState);

  socket.on('binary-chunk-169', ({ instanceId, chunk }) => {
    const inst = instances.get(instanceId);
    if (inst && inst.proc169 && inst.proc169.stdin && inst.proc169.stdin.writable) {
      try {
        inst.proc169.stdin.write(Buffer.from(chunk));
      } catch (_) {}
    }
  });

  socket.on('binary-chunk-916', ({ instanceId, chunk }) => {
    const inst = instances.get(instanceId);
    if (inst && inst.proc916 && inst.proc916.stdin && inst.proc916.stdin.writable) {
      try {
        inst.proc916.stdin.write(Buffer.from(chunk));
      } catch (_) {}
    }
  });

  socket.on('client-color-switch', ({ instanceId, targetSceneId, reason }) => {
    const inst = instances.get(instanceId);
    if (inst && inst.autoSceneSwitch) {
      switchInstanceScene(inst, targetSceneId, reason || 'CLIENT COLOR DETECT');
    }
  });
});

server.listen(PORT, '0.0.0.0', () => {
  addLog('INFO', `Sky Playout Server listening on port ${PORT}`, 'BOOT');
  addLog('INFO', `RTMP Ingest Server listening on port ${rtmpPort}`, 'BOOT');
  addLog('INFO', `HTTP-FLV Preview Server on port ${httpPort}`, 'BOOT');

  const isBotkeep = Boolean(process.env.SERVER_PORT);
  const codespaceName = process.env.CODESPACE_NAME;
  const forwardingDomain = process.env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN || 'app.github.dev';
  const codespaceUrl = codespaceName ? `https://${codespaceName}-${PORT}.${forwardingDomain}` : null;

  origLog('================================================================');
  origLog('  ☁️ FREE-LIVE-24-7-BY-SLETOYT SKY CLOUD SERVER READY 🌸');
  origLog(`  Local Container URL: http://0.0.0.0:${PORT} (or http://localhost:${PORT})`);
  if (isBotkeep) {
    origLog(`  🌐 Botkeep Assigned: http://node7.botkeep.cloud:${PORT}`);
    origLog(`  🌐 Botkeep Domain:   https://free-live.bot-keep.xyz (or your attached domain)`);
  }
  if (codespaceUrl) {
    origLog(`  🌐 Codespaces Web:   ${codespaceUrl}`);
  }
  origLog(`  📡 RTMP Ingest Port: ${rtmpPort}`);
  origLog(`  🎥 HTTP-FLV Port:    ${httpPort}`);
  origLog('================================================================');
});
