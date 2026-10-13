/**
 * Enterprise Dual-Ratio Cloud Playout Server & Auto Color-Detect Web-OBS
 * Project: free-live-24-7-by-sletoyt
 * Features:
 *  - Simultaneous Dual Live Playout (16:9 Landscape + 9:16 Vertical Shorts)
 *  - Multi-Scene System with 3 Scene Types:
 *      1. Default Scene (Max 1 - runs when live & no trigger color on screen)
 *      2. Color-Detect Scene (Auto-switches when full screen matches trigger color; reverts to Default when color clears)
 *      3. Network-Error Scene (Auto-switches when OBS ingest disconnects; reverts to Default on reconnect)
 *  - Shared Scene Sources with Independent 16:9 & 9:16 Coordinates (rect169 & rect916)
 *  - Built-in Cloud File System (Upload, Download, Manage BG Music, Logos, Videos)
 *  - Real-Time Live Logs Console & System Health Diagnostics
 */

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
  maxHttpBufferSize: 1e8 // 100MB chunk buffer
});

const PORT = parseInt(process.env.PORT, 10) || 3000;
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

// ---------------------------------------------------------------------------
// 1. Centralized Real-Time Logger & Log Buffer
// ---------------------------------------------------------------------------
const LOGS_BUFFER = [];
const MAX_LOGS = 600;

function addLog(level, message, source = 'SYSTEM') {
  if (!message) return;
  const entry = {
    id: Date.now() + '_' + Math.random().toString(36).substr(2, 4),
    timestamp: new Date().toISOString(),
    level: String(level).toUpperCase(), // 'INFO', 'WARN', 'ERROR', 'FFMPEG', 'RTMP', 'SCENE'
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
  const text = args.map((a) => (typeof a === 'object' ? JSON.stringify(a) : a)).join(' ');
  addLog('INFO', text, 'SERVER');
};

console.warn = function (...args) {
  origWarn.apply(console, args);
  const text = args.map((a) => (typeof a === 'object' ? JSON.stringify(a) : a)).join(' ');
  addLog('WARN', text, 'SERVER');
};

console.error = function (...args) {
  origError.apply(console, args);
  const text = args.map((a) => (typeof a === 'object' ? JSON.stringify(a) : a)).join(' ');
  addLog('ERROR', text, 'SERVER');
};

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/assets', express.static(ASSETS_DIR));
app.use('/uploads', express.static(UPLOADS_DIR));

// ---------------------------------------------------------------------------
// 2. Cloud File System (Multer Storage for BG Music, Logos, Videos)
// ---------------------------------------------------------------------------
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, UPLOADS_DIR);
  },
  filename: (req, file, cb) => {
    const safeOriginal = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    const finalName = fs.existsSync(path.join(UPLOADS_DIR, safeOriginal))
      ? `${Date.now()}_${safeOriginal}`
      : safeOriginal;
    cb(null, finalName);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 1024 * 1024 * 1024 } // 1GB limit
});

function getFileCategory(filename) {
  const ext = path.extname(filename).toLowerCase();
  if (['.mp3', '.wav', '.ogg', '.m4a', '.aac', '.flac'].includes(ext)) return 'audio';
  if (['.mp4', '.webm', '.mkv', '.mov', '.avi'].includes(ext)) return 'video';
  if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'].includes(ext)) return 'image';
  return 'other';
}

function listUploadedFiles() {
  try {
    const names = fs.readdirSync(UPLOADS_DIR);
    return names
      .filter((n) => !n.startsWith('.'))
      .map((name) => {
        const fullPath = path.join(UPLOADS_DIR, name);
        const stat = fs.statSync(fullPath);
        return {
          name,
          size: stat.size,
          category: getFileCategory(name),
          url: `/uploads/${encodeURIComponent(name)}`,
          downloadUrl: `/api/files/download/${encodeURIComponent(name)}`,
          updatedAt: stat.mtime.toISOString()
        };
      })
      .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  } catch (err) {
    return [];
  }
}

app.get('/api/files', (req, res) => {
  res.json({ files: listUploadedFiles() });
});

app.post('/api/files/upload', upload.array('files', 20), (req, res) => {
  const uploaded = (req.files || []).map((f) => f.filename);
  addLog('INFO', `Uploaded ${uploaded.length} file(s) to Cloud File System: ${uploaded.join(', ')}`, 'FILES');
  const allFiles = listUploadedFiles();
  io.emit('files-update', allFiles);
  res.json({ success: true, uploaded, files: allFiles });
});

app.get('/api/files/download/:filename', (req, res) => {
  const safeName = path.basename(req.params.filename);
  const target = path.join(UPLOADS_DIR, safeName);
  if (!fs.existsSync(target)) {
    return res.status(404).json({ error: 'File not found' });
  }
  res.download(target, safeName);
});

app.put('/api/files/:filename', (req, res) => {
  const oldName = path.basename(req.params.filename);
  const newRaw = (req.body.newName || '').trim();
  if (!newRaw) return res.status(400).json({ error: 'New filename required' });

  const safeNew = newRaw.replace(/[^a-zA-Z0-9._-]/g, '_');
  const oldPath = path.join(UPLOADS_DIR, oldName);
  const newPath = path.join(UPLOADS_DIR, safeNew);

  if (!fs.existsSync(oldPath)) return res.status(404).json({ error: 'File not found' });
  fs.renameSync(oldPath, newPath);
  addLog('INFO', `Renamed file "${oldName}" -> "${safeNew}"`, 'FILES');
  const allFiles = listUploadedFiles();
  io.emit('files-update', allFiles);
  res.json({ success: true, files: allFiles });
});

app.delete('/api/files/:filename', (req, res) => {
  const safeName = path.basename(req.params.filename);
  const target = path.join(UPLOADS_DIR, safeName);
  if (fs.existsSync(target)) {
    fs.unlinkSync(target);
    addLog('WARN', `Deleted file "${safeName}" from Cloud File System`, 'FILES');
  }
  const allFiles = listUploadedFiles();
  io.emit('files-update', allFiles);
  res.json({ success: true, files: allFiles });
});

// ---------------------------------------------------------------------------
// 3. Cute Sky Fallback Video Assets Generator (16:9 & 9:16)
// ---------------------------------------------------------------------------
function generateFallbackAssets() {
  if (!fs.existsSync(FALLBACK_16_9)) {
    addLog('INFO', 'Generating Sky-Themed 16:9 Standby Scene (fallback_16_9.mp4)...', 'ASSET');
    const f16 = spawn('ffmpeg', [
      '-y',
      '-f', 'lavfi', '-i', 'color=c=#8fd3fe:s=1920x1080:d=8:r=30',
      '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo',
      '-vf', "drawtext=text='PAUSE // STREAM STANDBY':fontcolor=white:fontsize=64:box=1:boxcolor=#2b7de9@0.85:boxborderw=26:x=(w-text_w)/2:y=(h-text_h)/2-40,drawtext=text='free-live-24-7-by-sletoyt Sky Cloud Playout':fontcolor=#1e3a5f:fontsize=34:x=(w-text_w)/2:y=(h-text_h)/2+60",
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', '-t', '8',
      FALLBACK_16_9
    ]);
    f16.on('close', (c) => addLog('INFO', `16:9 Sky Fallback asset rendered (exit ${c})`, 'ASSET'));
  }

  if (!fs.existsSync(FALLBACK_9_16)) {
    addLog('INFO', 'Generating Sky-Themed 9:16 Vertical Standby Scene (fallback_9_16.mp4)...', 'ASSET');
    const f9 = spawn('ffmpeg', [
      '-y',
      '-f', 'lavfi', '-i', 'color=c=#8fd3fe:s=1080x1920:d=8:r=30',
      '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo',
      '-vf', "drawtext=text='PAUSE // STANDBY':fontcolor=white:fontsize=62:box=1:boxcolor=#2b7de9@0.85:boxborderw=22:x=(w-text_w)/2:y=(h-text_h)/2-70,drawtext=text='Waiting for Live Signal...':fontcolor=#1e3a5f:fontsize=36:x=(w-text_w)/2:y=(h-text_h)/2+30",
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', '-t', '8',
      FALLBACK_9_16
    ]);
    f9.on('close', (c) => addLog('INFO', `9:16 Sky Fallback asset rendered (exit ${c})`, 'ASSET'));
  }
}
generateFallbackAssets();

// ---------------------------------------------------------------------------
// 4. Multi-Scene Data Structure (Shared Sources + Dual 16:9 & 9:16 Rects)
// ---------------------------------------------------------------------------
const instances = new Map();

function createDefaultScenes() {
  return [
    {
      id: 'scene_default',
      name: '1. Default Live (Window + Voiceover)',
      type: 'default', // Max 1 allowed! Plays when incoming live has no trigger color
      triggerColor: '#00ff00',
      tolerance: 35,
      muteIncomingAudio: false,
      sources: [
        {
          id: 'src_live_win',
          name: 'Incoming Window + Voiceover (OBS)',
          type: 'live-window',
          fileUrl: '',
          text: '',
          color: '#ffffff',
          bgColor: 'rgba(43, 125, 233, 0.85)',
          fontSize: 44,
          volume: 1.0,
          loop: true,
          visible: true,
          rect169: { x: 0, y: 0, width: 1920, height: 1080, visible: true },
          rect916: { x: 0, y: 350, width: 1080, height: 1220, visible: true }
        },
        {
          id: 'src_default_tag',
          name: 'Live Sky Badge',
          type: 'text',
          fileUrl: '',
          text: '☁️ LIVE // SLETOYT',
          color: '#ffffff',
          bgColor: 'rgba(59, 158, 255, 0.88)',
          fontSize: 38,
          volume: 1.0,
          loop: true,
          visible: true,
          rect169: { x: 60, y: 50, width: 460, height: 74, visible: true },
          rect916: { x: 100, y: 120, width: 880, height: 90, visible: true }
        }
      ]
    },
    {
      id: 'scene_pause_color',
      name: '2. Pause Scene (Auto Color Detect)',
      type: 'color-detect', // Activates automatically when screen turns triggerColor!
      triggerColor: '#000000', // Default black fade-to-color in OBS (customizable!)
      tolerance: 32,
      muteIncomingAudio: true,
      sources: [
        {
          id: 'src_pause_banner',
          name: 'Cute Pause Cloud Banner',
          type: 'text',
          fileUrl: '',
          text: '🌸 PAUSE // BE RIGHT BACK ☁️',
          color: '#ffffff',
          bgColor: 'rgba(255, 143, 171, 0.92)',
          fontSize: 58,
          volume: 1.0,
          loop: true,
          visible: true,
          rect169: { x: 360, y: 440, width: 1200, height: 160, visible: true },
          rect916: { x: 80, y: 820, width: 920, height: 220, visible: true }
        }
      ]
    },
    {
      id: 'scene_network_error',
      name: '3. Network Error Scene (No OBS Signal)',
      type: 'network-error', // Activates automatically when OBS stream drops!
      triggerColor: '#ff0000',
      tolerance: 35,
      muteIncomingAudio: true,
      sources: [
        {
          id: 'src_net_err_banner',
          name: 'Network Reconnecting Banner',
          type: 'text',
          fileUrl: '',
          text: '☁️ NETWORK STANDBY // RECONNECTING...',
          color: '#ffffff',
          bgColor: 'rgba(43, 125, 233, 0.92)',
          fontSize: 52,
          volume: 1.0,
          loop: true,
          visible: true,
          rect169: { x: 310, y: 450, width: 1300, height: 150, visible: true },
          rect916: { x: 70, y: 830, width: 940, height: 220, visible: true }
        }
      ]
    }
  ];
}

function saveInstancesToDisk() {
  try {
    const dataToSave = Array.from(instances.values()).map((inst) => ({
      id: inst.id,
      name: inst.name,
      streamKey: inst.streamKey,
      mode: inst.mode || 'window-voiceover-dual',
      rtmp169Primary: inst.rtmp169Primary || '',
      rtmp169Backup: inst.rtmp169Backup || '',
      rtmp916Primary: inst.rtmp916Primary || '',
      rtmp916Backup: inst.rtmp916Backup || '',
      playlistUrls: inst.playlistUrls || [],
      scenes: inst.scenes || createDefaultScenes(),
      activeSceneId: inst.activeSceneId || 'scene_default',
      autoSceneSwitch: inst.autoSceneSwitch !== false
    }));
    fs.writeFileSync(INSTANCES_FILE, JSON.stringify(dataToSave, null, 2), 'utf-8');
  } catch (err) {
    addLog('ERROR', `Error saving instances to disk: ${err.message}`, 'STORAGE');
  }
}

function loadInstancesFromDisk() {
  try {
    if (fs.existsSync(INSTANCES_FILE)) {
      const raw = fs.readFileSync(INSTANCES_FILE, 'utf-8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        parsed.forEach((item) => {
          const scenes = Array.isArray(item.scenes) && item.scenes.length > 0
            ? item.scenes
            : createDefaultScenes();
          instances.set(item.id, {
            id: item.id,
            name: item.name || 'Dual Sky Stream',
            streamKey: item.streamKey || 'live_stream_sletoyt',
            mode: item.mode === 'playlist-loop' ? 'playlist-loop' : 'window-voiceover-dual',
            rtmp169Primary: item.rtmp169Primary || item.primaryRtmp || '',
            rtmp169Backup: item.rtmp169Backup || item.backupRtmp || '',
            rtmp916Primary: item.rtmp916Primary || '',
            rtmp916Backup: item.rtmp916Backup || '',
            playlistUrls: item.playlistUrls || [],
            scenes,
            activeSceneId: item.activeSceneId || scenes[0].id,
            autoSceneSwitch: item.autoSceneSwitch !== false,
            status: 'offline',
            uptimeStart: null,
            isPublishing: false,
            detectedColorHex: null,
            proc169: null,
            proc916: null,
            colorProbeProc: null,
            usingBrowserPipe: false
          });
        });
        addLog('INFO', `Loaded ${instances.size} instance(s) from disk store`, 'STORAGE');
      }
    }
  } catch (err) {
    addLog('ERROR', `Error loading instances from disk: ${err.message}`, 'STORAGE');
  }

  if (instances.size === 0) {
    const defaultId = 'inst_' + Date.now();
    const scenes = createDefaultScenes();
    instances.set(defaultId, {
      id: defaultId,
      name: 'Main Dual Live (16:9 + 9:16)',
      streamKey: 'live_stream_sletoyt',
      mode: 'window-voiceover-dual',
      rtmp169Primary: '',
      rtmp169Backup: '',
      rtmp916Primary: '',
      rtmp916Backup: '',
      playlistUrls: [],
      scenes,
      activeSceneId: 'scene_default',
      autoSceneSwitch: true,
      status: 'offline',
      uptimeStart: null,
      isPublishing: false,
      detectedColorHex: null,
      proc169: null,
      proc916: null,
      colorProbeProc: null,
      usingBrowserPipe: false
    });
    saveInstancesToDisk();
  }
}
loadInstancesFromDisk();

// ---------------------------------------------------------------------------
// 5. Scene Helper & Automatic Color Detection Engine
// ---------------------------------------------------------------------------
function getSceneByType(inst, type) {
  return (inst.scenes || []).find((s) => s.type === type);
}

function getActiveScene(inst) {
  return (
    (inst.scenes || []).find((s) => s.id === inst.activeSceneId) ||
    getSceneByType(inst, 'default') ||
    inst.scenes[0]
  );
}

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
  const toHex = (n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

function colorDistance(c1, c2) {
  // Max Chebyshev channel distance (0..255)
  return Math.max(Math.abs(c1.r - c2.r), Math.abs(c1.g - c2.g), Math.abs(c1.b - c2.b));
}

function switchInstanceScene(inst, targetSceneId, reason = 'MANUAL') {
  if (!inst || !targetSceneId || inst.activeSceneId === targetSceneId) return false;
  const target = (inst.scenes || []).find((s) => s.id === targetSceneId);
  if (!target) return false;

  inst.activeSceneId = target.id;
  addLog(
    'SCENE',
    `[${inst.name}] Scene switched -> "${target.name}" (${target.type.toUpperCase()}) [Reason: ${reason}]`,
    'SCENE'
  );

  // If running headless backend FFmpeg composition (not browser canvas pipe), restart scene compositor
  if (inst.status === 'live' && !inst.usingBrowserPipe && inst.mode === 'window-voiceover-dual') {
    startDualBackendPlayout(inst);
  }

  broadcastInstanceStatus();
  io.emit('scene-switched', {
    instanceId: inst.id,
    activeSceneId: inst.activeSceneId,
    sceneName: target.name,
    sceneType: target.type,
    reason
  });
  return true;
}

function stopColorProbe(inst) {
  if (inst.colorProbeProc) {
    try {
      inst.colorProbeProc.kill('SIGTERM');
    } catch (_) {}
    inst.colorProbeProc = null;
  }
}

function startBackendColorDetector(inst) {
  stopColorProbe(inst);
  if (!inst.isPublishing) return;

  const localRtmpUrl = `rtmp://127.0.0.1:${rtmpPort}/live/${inst.streamKey}`;
  const FRAME_W = 16;
  const FRAME_H = 16;
  const BYTES_PER_FRAME = FRAME_W * FRAME_H * 3; // 768 bytes per frame (rgb24)

  const probe = spawn('ffmpeg', [
    '-i', localRtmpUrl,
    '-vf', `fps=2,scale=${FRAME_W}:${FRAME_H}`,
    '-f', 'rawvideo',
    '-pix_fmt', 'rgb24',
    'pipe:1'
  ]);

  inst.colorProbeProc = probe;
  let frameBuffer = Buffer.alloc(0);
  let noMatchStreak = 0;

  probe.stdout.on('data', (chunk) => {
    frameBuffer = Buffer.concat([frameBuffer, chunk]);

    while (frameBuffer.length >= BYTES_PER_FRAME) {
      const frame = frameBuffer.slice(0, BYTES_PER_FRAME);
      frameBuffer = frameBuffer.slice(BYTES_PER_FRAME);

      // Compute average screen color
      let sumR = 0, sumG = 0, sumB = 0;
      const totalPixels = FRAME_W * FRAME_H;
      for (let i = 0; i < BYTES_PER_FRAME; i += 3) {
        sumR += frame[i];
        sumG += frame[i + 1];
        sumB += frame[i + 2];
      }
      const avgRgb = {
        r: Math.round(sumR / totalPixels),
        g: Math.round(sumG / totalPixels),
        b: Math.round(sumB / totalPixels)
      };
      inst.detectedColorHex = rgbToHex(avgRgb.r, avgRgb.g, avgRgb.b);

      if (!inst.autoSceneSwitch) continue;

      // Check all 'color-detect' scenes
      const colorScenes = (inst.scenes || []).filter((s) => s.type === 'color-detect');
      let matchedScene = null;

      for (const sc of colorScenes) {
        const targetRgb = hexToRgb(sc.triggerColor);
        const tol = Number(sc.tolerance) || 35;
        let matchingPixels = 0;

        for (let i = 0; i < BYTES_PER_FRAME; i += 3) {
          const px = { r: frame[i], g: frame[i + 1], b: frame[i + 2] };
          if (colorDistance(px, targetRgb) <= tol) {
            matchingPixels++;
          }
        }

        const matchRatio = matchingPixels / totalPixels;
        if (matchRatio >= 0.80) {
          matchedScene = sc;
          break;
        }
      }

      if (matchedScene) {
        noMatchStreak = 0;
        if (inst.activeSceneId !== matchedScene.id) {
          switchInstanceScene(
            inst,
            matchedScene.id,
            `AUTO COLOR DETECT (${matchedScene.triggerColor})`
          );
        }
      } else {
        noMatchStreak++;
        // If currently on a color-detect scene and the trigger color is gone from screen -> revert to Default scene!
        const currentScene = getActiveScene(inst);
        if (currentScene && currentScene.type === 'color-detect' && noMatchStreak >= 2) {
          const defScene = getSceneByType(inst, 'default');
          if (defScene && inst.activeSceneId !== defScene.id) {
            switchInstanceScene(inst, defScene.id, 'COLOR CLEARED -> DEFAULT');
          }
        }
      }

      io.emit('color-telemetry', {
        instanceId: inst.id,
        detectedColorHex: inst.detectedColorHex,
        activeSceneId: inst.activeSceneId
      });
    }
  });

  probe.stderr.on('data', () => {});
  probe.on('close', () => {
    if (inst.colorProbeProc === probe) {
      inst.colorProbeProc = null;
    }
  });
}

// ---------------------------------------------------------------------------
// 6. RTMP Server Engine (NodeMediaServer) & Network Error Watchdog
// ---------------------------------------------------------------------------
const { nms, rtmpPort, httpPort } = initializeRtmpServer({ mediaRoot: MEDIA_DIR });

nms.on('prePublish', (id, StreamPath) => {
  const streamKey = StreamPath.split('/')[2];
  addLog('RTMP', `[Connect] Incoming RTMP feed connected on ${StreamPath}`, 'RTMP');

  for (const inst of instances.values()) {
    if (inst.streamKey === streamKey) {
      inst.isPublishing = true;
      addLog('INFO', `[${inst.name}] OBS Window+Voiceover feed online!`, 'SUPERVISOR');

      // Automatically switch from Network-Error scene back to Default scene!
      if (inst.autoSceneSwitch) {
        const defScene = getSceneByType(inst, 'default');
        if (defScene) {
          switchInstanceScene(inst, defScene.id, 'OBS STREAM CONNECTED -> DEFAULT');
        }
      }

      // Start real-time full-screen color detector on incoming RTMP stream
      startBackendColorDetector(inst);

      if (inst.status === 'live' && !inst.usingBrowserPipe) {
        startDualBackendPlayout(inst);
      }
      broadcastInstanceStatus();
      break;
    }
  }
});

nms.on('donePublish', (id, StreamPath) => {
  const streamKey = StreamPath.split('/')[2];
  addLog('WARN', `[Disconnect] Incoming RTMP feed ended on ${StreamPath}`, 'RTMP');

  for (const inst of instances.values()) {
    if (inst.streamKey === streamKey) {
      inst.isPublishing = false;
      inst.detectedColorHex = null;
      stopColorProbe(inst);

      addLog('WARN', `[${inst.name}] OBS signal lost! Switching to Network-Error Scene...`, 'SUPERVISOR');

      if (inst.autoSceneSwitch) {
        const netErrScene = getSceneByType(inst, 'network-error');
        if (netErrScene) {
          switchInstanceScene(inst, netErrScene.id, 'NO OBS SIGNAL -> NETWORK ERROR SCENE');
        }
      }

      if (inst.status === 'live' && !inst.usingBrowserPipe) {
        startDualBackendPlayout(inst);
      }
      broadcastInstanceStatus();
      break;
    }
  }
});

nms.run();

// Proxy HTTP-FLV streams through Express port 3000 so browser players work anywhere
app.get('/api/flv-proxy/:streamName', (req, res) => {
  const rawName = req.params.streamName.replace(/\.flv$/i, '');
  const flvUrl = `http://127.0.0.1:${httpPort}/live/${rawName}.flv`;

  const proxyReq = http.get(flvUrl, (proxyRes) => {
    res.writeHead(proxyRes.statusCode || 200, {
      'Content-Type': 'video/x-flv',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*'
    });
    proxyRes.pipe(res);
  });

  proxyReq.on('error', () => {
    if (!res.headersSent) res.status(502).end();
  });

  req.on('close', () => {
    proxyReq.destroy();
  });
});

// ---------------------------------------------------------------------------
// 7. Simultaneous Dual 16:9 & 9:16 Playout Engine
// ---------------------------------------------------------------------------
function buildRatioOutputArgs(inst, ratio) {
  const destinations = [];
  const suffix = ratio === '9:16' ? '916_preview' : '169_preview';

  // Internal low-latency preview stream
  destinations.push(`[f=flv:onfail=ignore]rtmp://127.0.0.1:${rtmpPort}/live/${inst.streamKey}_${suffix}`);

  if (ratio === '16:9') {
    if (inst.rtmp169Primary && inst.rtmp169Primary.trim().startsWith('rtmp')) {
      destinations.push(`[f=flv:onfail=ignore]${inst.rtmp169Primary.trim()}`);
    }
    if (inst.rtmp169Backup && inst.rtmp169Backup.trim().startsWith('rtmp')) {
      destinations.push(`[f=flv:onfail=ignore]${inst.rtmp169Backup.trim()}`);
    }
  } else {
    if (inst.rtmp916Primary && inst.rtmp916Primary.trim().startsWith('rtmp')) {
      destinations.push(`[f=flv:onfail=ignore]${inst.rtmp916Primary.trim()}`);
    }
    if (inst.rtmp916Backup && inst.rtmp916Backup.trim().startsWith('rtmp')) {
      destinations.push(`[f=flv:onfail=ignore]${inst.rtmp916Backup.trim()}`);
    }
  }

  return ['-f', 'tee', '-map', '0:v', '-map', '0:a?', destinations.join('|')];
}

function stopInstanceProcesses(inst) {
  ['proc169', 'proc916'].forEach((key) => {
    if (inst[key]) {
      try {
        if (inst[key].stdin) inst[key].stdin.end();
      } catch (_) {}
      try {
        inst[key].kill('SIGTERM');
      } catch (_) {}
      inst[key] = null;
    }
  });
  inst.usingBrowserPipe = false;
}

function attachProcessLogger(proc, label) {
  let lastStatTime = 0;
  proc.stderr.on('data', (d) => {
    const lines = d.toString().split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (trimmed.includes('frame=') || trimmed.includes('fps=') || trimmed.includes('bitrate=')) {
        const now = Date.now();
        if (now - lastStatTime > 5000) {
          lastStatTime = now;
          addLog('FFMPEG', `[${label}] ${trimmed}`, 'FFMPEG');
        }
      } else if (
        trimmed.toLowerCase().includes('error') ||
        trimmed.toLowerCase().includes('failed')
      ) {
        addLog('ERROR', `[${label}] ${trimmed}`, 'FFMPEG');
      }
    }
  });
}

function spawnRatioBackendProcess(inst, ratio) {
  const is916 = ratio === '9:16';
  const W = is916 ? 1080 : 1920;
  const H = is916 ? 1920 : 1080;
  const fallbackVideo = is916 ? FALLBACK_9_16 : FALLBACK_16_9;
  const outArgs = buildRatioOutputArgs(inst, ratio);

  if (inst.mode === 'playlist-loop') {
    const playlistFile = path.join(MEDIA_DIR, `playlist_${inst.id}.txt`);
    const validUrls = (inst.playlistUrls || []).filter((u) => u && u.trim());
    if (validUrls.length === 0) validUrls.push(fallbackVideo);

    const content = validUrls
      .map((u) => {
        const clean = u.trim();
        if (clean.startsWith('/uploads/')) {
          return `file '${path.join(UPLOADS_DIR, decodeURIComponent(clean.replace('/uploads/', '')))}'`;
        }
        return `file '${clean}'`;
      })
      .join('\n');
    fs.writeFileSync(playlistFile, content, 'utf-8');

    const scaleFilter = `scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:#8fd3fe,setsar=1`;

    return spawn('ffmpeg', [
      '-re',
      '-protocol_whitelist', 'file,http,https,tcp,tls,crypto',
      '-f', 'concat',
      '-safe', '0',
      '-stream_loop', '-1',
      '-i', playlistFile,
      '-vf', scaleFilter,
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-b:v', '3200k',
      '-maxrate', '3800k',
      '-bufsize', '7000k',
      '-pix_fmt', 'yuv420p',
      '-g', '60',
      '-c:a', 'aac',
      '-b:a', '128k',
      '-ar', '44100',
      ...outArgs
    ]);
  }

  // Mode: 'window-voiceover-dual'
  const activeScene = getActiveScene(inst);
  const sources = (activeScene && activeScene.sources) || [];
  const rectKey = is916 ? 'rect916' : 'rect169';

  // Determine primary visual input for this scene
  const liveWinSrc = sources.find((s) => s.type === 'live-window' && s.visible !== false && (!s[rectKey] || s[rectKey].visible !== false));
  const videoSrc = sources.find((s) => s.type === 'video' && s.fileUrl && s.visible !== false);
  const audioSrc = sources.find((s) => s.type === 'audio' && s.fileUrl && s.visible !== false);
  const textSrc = sources.find((s) => s.type === 'text' && s.text && s.visible !== false);

  let videoInputArgs = [];
  if (activeScene && activeScene.type !== 'network-error' && liveWinSrc && inst.isPublishing) {
    const localRtmpUrl = `rtmp://127.0.0.1:${rtmpPort}/live/${inst.streamKey}`;
    videoInputArgs = ['-re', '-i', localRtmpUrl];
  } else if (videoSrc && videoSrc.fileUrl) {
    const resolvedVideo = videoSrc.fileUrl.startsWith('/uploads/')
      ? path.join(UPLOADS_DIR, decodeURIComponent(videoSrc.fileUrl.replace('/uploads/', '')))
      : videoSrc.fileUrl;
    if (fs.existsSync(resolvedVideo) || resolvedVideo.startsWith('http')) {
      videoInputArgs = ['-re', '-stream_loop', '-1', '-i', resolvedVideo];
    }
  }

  if (videoInputArgs.length === 0) {
    videoInputArgs = ['-re', '-stream_loop', '-1', '-i', fallbackVideo];
  }

  // Optional Scene Background Music input from Cloud File System
  let audioInputArgs = [];
  let hasExternalAudio = false;
  if (audioSrc && audioSrc.fileUrl) {
    const resolvedAudio = audioSrc.fileUrl.startsWith('/uploads/')
      ? path.join(UPLOADS_DIR, decodeURIComponent(audioSrc.fileUrl.replace('/uploads/', '')))
      : audioSrc.fileUrl;
    if (fs.existsSync(resolvedAudio)) {
      audioInputArgs = ['-stream_loop', '-1', '-i', resolvedAudio];
      hasExternalAudio = true;
    }
  }

  // Video filter with aspect scaling & optional text banner
  let vf = `scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:#8fd3fe,setsar=1`;
  if (textSrc && textSrc.text) {
    const safeText = String(textSrc.text).replace(/[:']/g, '');
    const r = textSrc[rectKey] || { x: 80, y: 80 };
    vf += `,drawtext=text='${safeText}':fontcolor=white:fontsize=${textSrc.fontSize || 44}:box=1:boxcolor=#2b7de9@0.8:boxborderw=16:x=${Math.max(10, r.x || 60)}:y=${Math.max(10, r.y || 60)}`;
  }

  const mapArgs = hasExternalAudio
    ? ['-map', '0:v', '-map', '1:a']
    : ['-map', '0:v', '-map', '0:a?'];

  const teeDest = buildRatioOutputArgs(inst, ratio).slice(-1)[0];

  return spawn('ffmpeg', [
    ...videoInputArgs,
    ...audioInputArgs,
    '-vf', vf,
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-tune', 'zerolatency',
    '-b:v', '3200k',
    '-maxrate', '3800k',
    '-bufsize', '7000k',
    '-pix_fmt', 'yuv420p',
    '-g', '60',
    '-c:a', 'aac',
    '-b:a', '128k',
    '-ar', '44100',
    '-f', 'tee',
    ...mapArgs,
    teeDest
  ]);
}

function startDualBackendPlayout(inst) {
  stopInstanceProcesses(inst);
  inst.status = 'live';
  inst.usingBrowserPipe = false;
  if (!inst.uptimeStart) inst.uptimeStart = Date.now();

  // If in window-voiceover-dual mode and OBS is not yet publishing, auto-select network-error scene
  if (inst.mode === 'window-voiceover-dual' && inst.autoSceneSwitch && !inst.isPublishing) {
    const netScene = getSceneByType(inst, 'network-error');
    if (netScene) inst.activeSceneId = netScene.id;
  }

  addLog(
    'INFO',
    `[${inst.name}] Starting Simultaneous Dual Playout (16:9 + 9:16) | Active Scene: "${getActiveScene(inst)?.name}"`,
    'PLAYOUT'
  );

  inst.proc169 = spawnRatioBackendProcess(inst, '16:9');
  inst.proc916 = spawnRatioBackendProcess(inst, '9:16');

  if (inst.proc169) attachProcessLogger(inst.proc169, `${inst.name} 16:9`);
  if (inst.proc916) attachProcessLogger(inst.proc916, `${inst.name} 9:16`);

  broadcastInstanceStatus();
}

function startDualBrowserPipePlayout(inst) {
  stopInstanceProcesses(inst);
  inst.status = 'live';
  inst.usingBrowserPipe = true;
  if (!inst.uptimeStart) inst.uptimeStart = Date.now();

  addLog('INFO', `[${inst.name}] Starting Dual Studio Live Pipe (16:9 + 9:16 Simultaneous)...`, 'STUDIO');

  const out169 = buildRatioOutputArgs(inst, '16:9');
  const out916 = buildRatioOutputArgs(inst, '9:16');

  inst.proc169 = spawn('ffmpeg', [
    '-re',
    '-f', 'webm',
    '-probesize', '5M',
    '-analyzeduration', '3M',
    '-i', 'pipe:0',
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-tune', 'zerolatency',
    '-b:v', '3500k',
    '-maxrate', '4000k',
    '-bufsize', '8000k',
    '-pix_fmt', 'yuv420p',
    '-g', '60',
    '-c:a', 'aac',
    '-b:a', '128k',
    '-ar', '44100',
    ...out169
  ]);

  inst.proc916 = spawn('ffmpeg', [
    '-re',
    '-f', 'webm',
    '-probesize', '5M',
    '-analyzeduration', '3M',
    '-i', 'pipe:0',
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-tune', 'zerolatency',
    '-b:v', '3200k',
    '-maxrate', '3800k',
    '-bufsize', '7000k',
    '-pix_fmt', 'yuv420p',
    '-g', '60',
    '-c:a', 'aac',
    '-b:a', '128k',
    '-ar', '44100',
    ...out916
  ]);

  if (inst.proc169) {
    inst.proc169.stdin.on('error', () => {});
    attachProcessLogger(inst.proc169, `${inst.name} Studio 16:9`);
  }
  if (inst.proc916) {
    inst.proc916.stdin.on('error', () => {});
    attachProcessLogger(inst.proc916, `${inst.name} Studio 9:16`);
  }

  broadcastInstanceStatus();
}

function serializeInstance(inst) {
  const uptime = inst.uptimeStart ? Math.floor((Date.now() - inst.uptimeStart) / 1000) : 0;
  return {
    id: inst.id,
    name: inst.name,
    streamKey: inst.streamKey,
    mode: inst.mode,
    rtmp169Primary: inst.rtmp169Primary,
    rtmp169Backup: inst.rtmp169Backup,
    rtmp916Primary: inst.rtmp916Primary,
    rtmp916Backup: inst.rtmp916Backup,
    playlistUrls: inst.playlistUrls,
    scenes: inst.scenes,
    activeSceneId: inst.activeSceneId,
    autoSceneSwitch: inst.autoSceneSwitch,
    status: inst.status,
    isPublishing: inst.isPublishing,
    detectedColorHex: inst.detectedColorHex,
    usingBrowserPipe: inst.usingBrowserPipe,
    uptime
  };
}

function broadcastInstanceStatus() {
  const payload = Array.from(instances.values()).map(serializeInstance);
  io.emit('instances-update', payload);
}

// ---------------------------------------------------------------------------
// 8. REST API Endpoints
// ---------------------------------------------------------------------------
app.get('/api/instances', (req, res) => {
  res.json(Array.from(instances.values()).map(serializeInstance));
});

app.post('/api/instances', (req, res) => {
  const {
    name,
    mode,
    rtmp169Primary,
    rtmp169Backup,
    rtmp916Primary,
    rtmp916Backup,
    playlistUrls
  } = req.body;

  const id = 'inst_' + Date.now();
  const streamKey = 'live_' + Math.random().toString(36).substring(2, 8);
  const scenes = createDefaultScenes();

  const newInst = {
    id,
    name: name || 'Sky Dual Stream ' + (instances.size + 1),
    streamKey,
    mode: mode === 'playlist-loop' ? 'playlist-loop' : 'window-voiceover-dual',
    rtmp169Primary: rtmp169Primary || '',
    rtmp169Backup: rtmp169Backup || '',
    rtmp916Primary: rtmp916Primary || '',
    rtmp916Backup: rtmp916Backup || '',
    playlistUrls: playlistUrls || [],
    scenes,
    activeSceneId: scenes[0].id,
    autoSceneSwitch: true,
    status: 'offline',
    uptimeStart: null,
    isPublishing: false,
    detectedColorHex: null,
    proc169: null,
    proc916: null,
    colorProbeProc: null,
    usingBrowserPipe: false
  };

  instances.set(id, newInst);
  saveInstancesToDisk();
  broadcastInstanceStatus();
  addLog('INFO', `Created Dual Playout instance: "${newInst.name}"`, 'API');
  res.status(201).json(serializeInstance(newInst));
});

app.put('/api/instances/:id', (req, res) => {
  const inst = instances.get(req.params.id);
  if (!inst) return res.status(404).json({ error: 'Instance not found' });

  const {
    name,
    mode,
    rtmp169Primary,
    rtmp169Backup,
    rtmp916Primary,
    rtmp916Backup,
    playlistUrls,
    scenes,
    activeSceneId,
    autoSceneSwitch
  } = req.body;

  if (name !== undefined) inst.name = name;
  if (mode !== undefined) inst.mode = mode;
  if (rtmp169Primary !== undefined) inst.rtmp169Primary = rtmp169Primary;
  if (rtmp169Backup !== undefined) inst.rtmp169Backup = rtmp169Backup;
  if (rtmp916Primary !== undefined) inst.rtmp916Primary = rtmp916Primary;
  if (rtmp916Backup !== undefined) inst.rtmp916Backup = rtmp916Backup;
  if (playlistUrls !== undefined) inst.playlistUrls = playlistUrls;
  if (scenes !== undefined) inst.scenes = scenes;
  if (activeSceneId !== undefined) inst.activeSceneId = activeSceneId;
  if (autoSceneSwitch !== undefined) inst.autoSceneSwitch = Boolean(autoSceneSwitch);

  saveInstancesToDisk();
  broadcastInstanceStatus();
  res.json(serializeInstance(inst));
});

// Save Scenes & Dual Ratio Sources Layout
app.put('/api/instances/:id/scenes', (req, res) => {
  const inst = instances.get(req.params.id);
  if (!inst) return res.status(404).json({ error: 'Instance not found' });

  const { scenes, activeSceneId, autoSceneSwitch } = req.body;
  if (!Array.isArray(scenes)) {
    return res.status(400).json({ error: 'Scenes array is required' });
  }

  // Enforce maximum 1 'default' scene rule
  let seenDefault = false;
  scenes.forEach((sc) => {
    if (sc.type === 'default') {
      if (seenDefault) {
        sc.type = 'color-detect';
      } else {
        seenDefault = true;
      }
    }
  });

  inst.scenes = scenes;
  if (activeSceneId) inst.activeSceneId = activeSceneId;
  if (autoSceneSwitch !== undefined) inst.autoSceneSwitch = Boolean(autoSceneSwitch);

  saveInstancesToDisk();
  broadcastInstanceStatus();
  res.json({ success: true, scenes: inst.scenes, activeSceneId: inst.activeSceneId });
});

// Switch Active Scene (Live or Offline)
app.post('/api/instances/:id/switch-scene', (req, res) => {
  const inst = instances.get(req.params.id);
  if (!inst) return res.status(404).json({ error: 'Instance not found' });

  const { sceneId, reason, autoSceneSwitch } = req.body;
  if (autoSceneSwitch !== undefined) {
    inst.autoSceneSwitch = Boolean(autoSceneSwitch);
  }
  if (sceneId) {
    switchInstanceScene(inst, sceneId, reason || 'MANUAL USER SWITCH');
  }
  saveInstancesToDisk();
  broadcastInstanceStatus();
  res.json({
    success: true,
    activeSceneId: inst.activeSceneId,
    autoSceneSwitch: inst.autoSceneSwitch
  });
});

app.delete('/api/instances/:id', (req, res) => {
  const inst = instances.get(req.params.id);
  if (!inst) return res.status(404).json({ error: 'Instance not found' });

  stopInstanceProcesses(inst);
  stopColorProbe(inst);
  instances.delete(req.params.id);
  saveInstancesToDisk();
  broadcastInstanceStatus();
  addLog('WARN', `Deleted instance "${inst.name}"`, 'API');
  res.json({ success: true });
});

// Start Autonomous Backend Dual Playout
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

// Start Dual Studio Browser Pipe (16:9 + 9:16 Simultaneous Canvas Stream)
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

// ---------------------------------------------------------------------------
// 9. Real-Time Logs & System Status Endpoints
// ---------------------------------------------------------------------------
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

  const max = parseInt(limit, 10) || 300;
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
    ports: {
      http: PORT,
      rtmp: rtmpPort,
      httpFlv: httpPort
    }
  });
});

// ---------------------------------------------------------------------------
// 10. WebSocket Handlers (Dual 16:9 + 9:16 Binary Chunks & Color Auto-Switch)
// ---------------------------------------------------------------------------
io.on('connection', (socket) => {
  socket.emit('instances-update', Array.from(instances.values()).map(serializeInstance));
  socket.emit('logs:history', LOGS_BUFFER.slice(-150));
  socket.emit('files-update', listUploadedFiles());

  // 16:9 Canvas Live Stream Chunk
  socket.on('binary-chunk-169', ({ instanceId, chunk }) => {
    const inst = instances.get(instanceId);
    if (inst && inst.proc169 && inst.proc169.stdin && inst.proc169.stdin.writable) {
      try {
        inst.proc169.stdin.write(Buffer.from(chunk));
      } catch (_) {}
    }
  });

  // 9:16 Vertical Canvas Live Stream Chunk
  socket.on('binary-chunk-916', ({ instanceId, chunk }) => {
    const inst = instances.get(instanceId);
    if (inst && inst.proc916 && inst.proc916.stdin && inst.proc916.stdin.writable) {
      try {
        inst.proc916.stdin.write(Buffer.from(chunk));
      } catch (_) {}
    }
  });

  // Client-Side Color Detector Auto-Switch Trigger
  socket.on('client-color-switch', ({ instanceId, targetSceneId, reason }) => {
    const inst = instances.get(instanceId);
    if (inst && inst.autoSceneSwitch) {
      switchInstanceScene(inst, targetSceneId, reason || 'CLIENT COLOR DETECT');
    }
  });
});

// ---------------------------------------------------------------------------
// 11. Server Boot
// ---------------------------------------------------------------------------
server.listen(PORT, '0.0.0.0', () => {
  addLog('INFO', `Sky Playout Server listening on port ${PORT}`, 'BOOT');
  addLog('INFO', `RTMP Ingest Server listening on port ${rtmpPort}`, 'BOOT');
  addLog('INFO', `HTTP-FLV Preview Server on port ${httpPort}`, 'BOOT');

  const codespaceName = process.env.CODESPACE_NAME;
  const forwardingDomain = process.env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN || 'app.github.dev';
  const codespaceUrl = codespaceName ? `https://${codespaceName}-${PORT}.${forwardingDomain}` : null;

  origLog('================================================================');
  origLog('  ☁️ FREE-LIVE-24-7-BY-SLETOYT SKY CLOUD SERVER READY 🌸');
  origLog(`  Local Web UI:       http://localhost:${PORT}`);
  if (codespaceUrl) {
    origLog(`  Codespaces Web UI:  ${codespaceUrl}`);
  }
  origLog(`  RTMP Ingest Port:   ${rtmpPort} (rtmp://<vps-ip>:${rtmpPort}/live)`);
  origLog(`  HTTP-FLV Port:      ${httpPort}`);
  origLog('================================================================');
});
