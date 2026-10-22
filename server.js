import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = Number(process.env.PORT) || 3000;

function getBaseUrl(req) {
  if (process.env.APP_URL) {
    return process.env.APP_URL.replace(/\/+$/, '');
  }
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
  const host = req.headers['x-forwarded-host'] || req.get('host') || `localhost:${PORT}`;
  return `${proto}://${host}`;
}

app.get('/robots.txt', (req, res) => {
  const baseUrl = getBaseUrl(req);
  res.type('text/plain').send(
    [
      'User-agent: *',
      'Allow: /',
      '',
      `Sitemap: ${baseUrl}/sitemap.xml`,
    ].join('\n')
  );
});

app.get('/sitemap.xml', (req, res) => {
  const baseUrl = getBaseUrl(req);
  const lastMod = new Date().toISOString().split('T')[0];
  res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>${baseUrl}/</loc>
    <lastmod>${lastMod}</lastmod>
    <changefreq>hourly</changefreq>
    <priority>1.0</priority>
  </url>
</urlset>`);
});

function serveApkFile(req, res) {
  const rootApk = path.join(__dirname, 'Paper-Flow.apk');
  const publicApk = path.join(__dirname, 'public', 'Paper-Flow.apk');
  const targetApk = fs.existsSync(rootApk) ? rootApk : publicApk;

  if (!fs.existsSync(targetApk)) {
    res.status(404).type('text/plain').send('APK not found');
    return;
  }

  res.sendFile(targetApk, {
    acceptRanges: true,
    etag: true,
    lastModified: true,
    headers: {
      'Content-Type': 'application/vnd.android.package-archive',
      'Content-Disposition': 'attachment; filename="Paper-Flow.apk"',
      'Cache-Control': 'public, max-age=60, must-revalidate',
      'X-Content-Type-Options': 'nosniff',
      'Access-Control-Allow-Origin': '*'
    }
  });
}

app.get('/Paper-Flow.apk', serveApkFile);
app.get('/public/Paper-Flow.apk', serveApkFile);
app.get('/download/Paper-Flow.apk', serveApkFile);
app.get('/api/download-apk', serveApkFile);

app.get('/api/app-version', (req, res) => {
  res.json({
    latestVersionCode: 2,
    latestVersionName: '1.0.1',
    apkUrl: '/download/Paper-Flow.apk',
    title: 'Paper Flow Update Available',
    releaseNotes: 'Performance improvements, fixed badge layout, suppressed persistent popups, and disabled pinch zooming.'
  });
});

app.use(express.static(__dirname));
app.use(express.static(path.join(__dirname, 'public')));

app.use((req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on http://0.0.0.0:${PORT}`);
});
