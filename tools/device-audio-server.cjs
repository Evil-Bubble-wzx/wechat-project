// A fixed single-file endpoint for the authorized temporary audio test.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const file = path.resolve(__dirname, '../preview/audio/peter-rabbit-librivox.mp3');
const size = fs.statSync(file).size;
http.createServer((req, res) => {
  if (req.url !== '/peter-rabbit.mp3') { res.writeHead(404); res.end(); return; }
  if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405, { Allow: 'GET, HEAD' }); res.end(); return; }
  const headers = { 'Content-Type': 'audio/mpeg', 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' };
  let start = 0, end = size - 1, status = 200;
  if (req.headers.range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
    let valid = match && (match[1] || match[2]);
    if (valid) {
      if (!match[1]) {
        const suffix = Number(match[2]);
        valid = Number.isSafeInteger(suffix) && suffix > 0;
        start = Math.max(0, size - suffix);
      } else {
        start = Number(match[1]);
        end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
        valid = Number.isSafeInteger(start) && Number.isSafeInteger(end) && start <= end && start < size;
      }
    }
    if (!valid) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }); res.end(); return; }
    status = 206;
    headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
  }
  headers['Content-Length'] = end - start + 1;
  res.writeHead(status, headers);
  if (req.method === 'HEAD') { res.end(); return; }
  const stream = fs.createReadStream(file, { start, end });
  stream.on('error', () => res.destroy());
  res.on('close', () => stream.destroy());
  stream.pipe(res);
}).listen(4180, '127.0.0.1', () => console.log('Single MP3 endpoint ready on localhost:4180'));
