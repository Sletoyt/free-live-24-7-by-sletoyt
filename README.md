# ☁️ free-live-24-7-by-sletoyt 🌸

> **Ultra-Lightweight 24/7 Cloud Streaming Studio • Dual 16:9 & 9:16 Playout • Master Password Security • Free Random Public HTTPS Domain • 5 Theme System**

[![GitHub Repository](https://img.shields.io/badge/GitHub-free--live--24--7--by--sletoyt-38bdf8?style=for-the-badge&logo=github)](https://github.com/sletoyt/free-live-24-7-by-sletoyt)
[![Dual Stream](https://img.shields.io/badge/Dual_Playout-16%3A9_%2B_9%3A16_Live-f472b6?style=for-the-badge)](#)
[![Themes](https://img.shields.io/badge/Themes-5_Unique_Styles-10b981?style=for-the-badge)](#)
[![Security](https://img.shields.io/badge/Master_Password-VPS_Reset_Only-amber?style=for-the-badge)](#)
[![License](https://img.shields.io/badge/License-MIT-0ea5e9?style=for-the-badge)](LICENSE)

Send your **Window Feed + Voiceover** from OBS Studio once — **`free-live-24-7-by-sletoyt`** handles the rest in the cloud! It automatically triggers scene transitions based on screen color detection or network dropouts and streams to both **YouTube Landscape (16:9)** and **YouTube Shorts / TikTok (9:16)** simultaneously.

---

## 🌟 Key Highlights

- **🔒 Master Admin Password Security:** First-run web wizard lets you set your master password. No unauthorized visitor can modify your stream keys or tamper with your live broadcast.
- **🛡️ VPS-Only Password Reset:** Web password recovery is deliberately disabled on public links to prevent hijacking. The password can **ONLY** be reset via direct VPS terminal access (`node reset-password.js`).
- **🌐 Free Random Public HTTPS Domain:** Built-in web tunnel generates an instant, public HTTPS address (`https://...loca.lt` / `https://...a.pinggy.link`) allowing you to control your studio from any phone or browser worldwide.
- **🎨 5 Beautiful Themes with Adaptive Icons:**
  - 🌸 **Cute Sky (Sakura):** Soft dark sky aesthetic with sakura accents (Icons: ☁️ / 🌸)
  - 🖤 **Modern Black (Simple):** Clean pitch-black minimalist design (Icons: ⚡ / 🖤)
  - 💎 **Glass Effect (Clear):** Frosted glassmorphism with crystal violet glow (Icons: 💎 / 🔮)
  - 🌿 **Emerald Nature:** Deep forest green and calming botanical tones (Icons: 🌿 / 🍃)
  - ☀️ **Pure White (Minimal):** Crisp high-contrast clean white layout (Icons: ☀️ / 🕊️)
- **📺📱 Dual 16:9 & 9:16 Playout:** Broadcast to horizontal YouTube and vertical Shorts/TikTok concurrently with synchronized scene switching.
- **🤖 Smart Auto Color & Signal Switcher:**
  - `🟢 Default Scene:` Active gameplay or main screen feed.
  - `🎨 Color-Detect Scene:` Automatically switches when the screen matches a specified HEX color (e.g., game pause, loading screen).
  - `📡 Network Error Scene:` Automatically takes over if your local OBS crashes or disconnects, preserving your 24/7 stream uptime.
- **📁 Cloud File Manager:** Upload and manage background music, brand logos, video loops, and overlay graphics directly from the web panel.

---

## 🚀 Installation & Setup

### Method 1: Docker (Recommended)

Run the entire studio with one command using Docker:

```bash
# 1. Clone the repository
git clone https://github.com/sletoyt/free-live-24-7-by-sletoyt.git
cd free-live-24-7-by-sletoyt

# 2. Build and start the container
docker compose up -d --build
```

- **Open in Browser:** Open `http://YOUR_VPS_IP:3000` (or check the container logs for your free public HTTPS domain).
- **View Container Logs:**
  ```bash
  docker compose logs -f
  ```
- **Stop the Studio:**
  ```bash
  docker compose down
  ```

---

### Method 2: Non-Docker Installation (Node.js)

To run natively on your Linux VPS (Ubuntu / Debian), Mac, or Windows server:

```bash
# 1. Update system packages & install FFmpeg, Node.js and Git
sudo apt-get update && sudo apt-get install -y nodejs npm ffmpeg openssh-client git

# 2. Clone the repository
git clone https://github.com/sletoyt/free-live-24-7-by-sletoyt.git
cd free-live-24-7-by-sletoyt

# 3. Install dependencies
npm install

# 4. Start the studio
npm start
```

### Running 24/7 in Background (via PM2)

To keep your studio running continuously 24/7 without terminal interruptions:

```bash
sudo npm install -g pm2
pm2 start server.js --name "sleto-live-24-7"
pm2 save
pm2 startup
```

---

## 🔐 Master Password & Security Setup

1. **First-Run Web Setup:**
   - When you open the web dashboard for the first time, the **Master Security Gate** setup wizard will appear.
   - Enter your desired Master Admin Password and click **Set Master Password & Enter Studio**.
   - Your password is protected with salt-hashed PBKDF2 (SHA-512, 100,000 iterations).

2. **How to Reset Master Password from VPS Terminal:**
   If you ever forget your password, you can securely reset or clear it from your VPS terminal:

   ```bash
   # Option A: Interactive prompt
   node reset-password.js

   # Option B: Pass new password directly
   node reset-password.js "MyNewSecurePassword123"

   # Option C: Clear password to trigger setup wizard again
   node reset-password.js --clear

   # Option D: Using npm script
   npm run reset-password
   ```

   > **Note:** For security on public domains, password recovery is intentionally not provided over the web.

---

## 📡 Connecting Local OBS Studio

1. Open **OBS Studio** on your PC.
2. Go to **Settings &rarr; Stream**:
   - **Service:** `Custom...`
   - **Server:** Copy the **OBS Server URL** (`rtmp://...a.pinggy.link:PORT/live` or `rtmp://YOUR_VPS_IP:1935/live`) from your studio dashboard.
   - **Stream Key:** Enter your channel ingest key (default: `live_sleto`).
3. Click **Start Streaming** in OBS.
4. Your incoming video and audio are received by the cloud studio and automatically routed to your 16:9 and 9:16 outputs!

---

## 🎬 Scene System Overview

```text
                           ┌───► 🟢 Default Scene (Active gameplay / main feed)
                           │
Incoming Video Stream ────┼───► 🎨 Color-Detect Scene (Matches HEX color -> Pause / Overlay)
                           │
                           └───► 📡 Network Error Scene (Activates if OBS signal drops)
```

1. **🟢 Default Scene (Normal State):** Displays incoming OBS gameplay with customized overlays and layout.
2. **🎨 Color-Detect Scene (Pause / Break):** Continuously monitors the stream frame. When the screen matches the designated HEX color code (e.g., `#000000`), it automatically transitions to this scene. Once normal screen content returns, it shifts back to Default.
3. **📡 Network Error Scene (Fail-Safe):** If your local PC loses connection or OBS stops, this scene automatically takes over to keep your 24/7 live streams running smoothly on YouTube.

---

## 🎨 5 Themes Showcase

| Theme | Icon | Look & Feel |
| :--- | :---: | :--- |
| **Cute Sky** | 🌸 | Soft midnight blue and sakura pink accents with cozy typography. |
| **Modern Black** | ⚡ | Deep pitch black minimalist theme with sleek dark cards and amber highlights. |
| **Glass Effect** | 💎 | Crystal glassmorphism with blurred translucent layers and neon violet glows. |
| **Emerald Nature** | 🌿 | Calming forest greens, jade elements, and organic botanical hues. |
| **Pure White** | ☀️ | Clean high-contrast minimalist white with crisp borders and slate accents. |

---

## 🤝 Credits & Collaboration

This project (**`free-live-24-7-by-sletoyt`**) was envisioned, designed, and developed through pair-programming collaboration between **SletoYT** and **Antigravity**.

The system architecture—featuring automated color-detection scene switching, network fail-safe fallback, dual 16:9 + 9:16 simultaneous playout, and public web tunneling—was conceived by **SletoYT** to provide a lightweight, accessible, and robust 24/7 cloud live-streaming solution.

---

## 📄 License

This project is licensed under the [MIT License](LICENSE).
