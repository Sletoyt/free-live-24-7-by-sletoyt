const NodeMediaServer = require('node-media-server');
const path = require('path');

function initializeRtmpServer(customConfig = {}) {
  const rtmpPort = parseInt(process.env.RTMP_PORT, 10) || customConfig.rtmpPort || 1935;
  const httpPort = parseInt(process.env.HTTP_PORT, 10) || customConfig.httpPort || 8000;
  const mediaRoot = customConfig.mediaRoot || path.join(__dirname, 'media');

  const config = {
    logType: 1,
    rtmp: {
      port: rtmpPort,
      chunk_size: 40960,
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
