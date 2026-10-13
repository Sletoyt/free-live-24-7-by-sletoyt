/**
 * RTMP Server Configuration Module (Node-Media-Server)
 * Project: free-live-24-7-by-sletoyt
 * Handles high-concurrency RTMP ingestion and HTTP-FLV preview endpoints.
 */

const NodeMediaServer = require('node-media-server');
const path = require('path');

function initializeRtmpServer(customConfig = {}) {
  const rtmpPort = parseInt(process.env.RTMP_PORT, 10) || customConfig.rtmpPort || 1935;
  const httpPort = parseInt(process.env.HTTP_PORT, 10) || customConfig.httpPort || 8000;
  const mediaRoot = customConfig.mediaRoot || path.join(__dirname, 'media');

  const config = {
    rtmp: {
      port: rtmpPort,
      chunk_size: 60000,
      gop_cache: true,
      ping: 30,
      ping_timeout: 60
    },
    http: {
      port: httpPort,
      allow_origin: '*',
      mediaroot: mediaRoot
    }
  };

  const nms = new NodeMediaServer(config);
  return { nms, rtmpPort, httpPort };
}

module.exports = { initializeRtmpServer };
