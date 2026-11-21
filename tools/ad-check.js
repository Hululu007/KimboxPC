// 广告过滤自检：合成播放列表（确定性逻辑验证）+ 全站点真实源（回归）
// 用法（由 tools\广告过滤自检.ps1 调用，也可直接 node tools/ad-check.js）：
//   KIMBOX_PORT=3980 KIMBOX_TITLE=两京十五日 KIMBOX_TIMEOUT=30000 node tools/ad-check.js
// 退出码：0=全部通过  1=发现问题  2=连不上服务

const http = require('http');
const axios = require('axios');

const PORT = Number(process.env.KIMBOX_PORT || 3980);
const TITLE = process.env.KIMBOX_TITLE || '两京十五日';
const B = 'http://127.0.0.1:' + PORT;
const T = Number(process.env.KIMBOX_TIMEOUT || 30000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const enc = encodeURIComponent;
const jget = async (p, t = T) => (await axios.get(B + p, { timeout: t, validateStatus: () => true })).data;
const jpost = async (p, body, t = T) => (await axios.post(B + p, body || {}, { timeout: t, validateStatus: () => true })).data;

let fails = 0;
const fail = (msg) => { fails++; console.log('  [FAIL] ' + msg); };

async function txt(u) {
  const r = await axios.get(u, { timeout: 20000, validateStatus: () => true });
  return typeof r.data === 'string' ? r.data : '';
}

async function firstSegOk(listText, base) {
  const segs = listText.split('\n').map((s) => s.trim()).filter((s) => s && !s.startsWith('#'));
  if (!segs.length) return '';
  const first = /^https?:/i.test(segs[0]) ? segs[0] : new URL(segs[0], base).href;
  const r = await axios.get(first, {
    timeout: 20000, validateStatus: () => true, responseType: 'arraybuffer',
    headers: { 'User-Agent': 'Mozilla/5.0' }
  });
  return r.status + '/' + (r.data || []).length + 'B';
}

// ---------- 1) 合成播放列表：45 分钟正片 + 2 段各 30s 广告 ----------
function buildList(withAds, port) {
  const L = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:10', '#EXT-X-MEDIA-SEQUENCE:0'];
  let n = 0;
  const part = (count, d) => {
    for (let i = 0; i < count; i++) {
      L.push('#EXTINF:' + d + ',');
      L.push('http://127.0.0.1:' + port + '/seg' + (n++) + '.ts');
    }
  };
  part(90, 10);
  if (withAds) { L.push('#EXT-X-DISCONTINUITY'); part(3, 10); L.push('#EXT-X-DISCONTINUITY'); }
  part(90, 10);
  if (withAds) { L.push('#EXT-X-DISCONTINUITY'); part(3, 10); L.push('#EXT-X-DISCONTINUITY'); }
  part(90, 10);
  L.push('#EXT-X-ENDLIST');
  return L.join('\n');
}

function startSynth() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const port = srv.address().port;
      if (req.url.startsWith('/ads.m3u8')) {
        res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
        return res.end(buildList(true, port));
      }
      if (req.url.startsWith('/clean.m3u8')) {
        res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
        return res.end(buildList(false, port));
      }
      res.writeHead(200, { 'Content-Type': 'video/mp2t' });
      res.end(Buffer.alloc(188, 0x47));
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

async function synthTest() {
  console.log('[1/2] 合成播放列表（带 2 段 30s 广告 / 干净流）');
  const srv = await startSynth();
  const port = srv.address().port;
  try {
    const cases = [['带广告', '/ads.m3u8', true], ['干净流', '/clean.m3u8', false]];
    for (const [name, path, wantAds] of cases) {
      const U = 'http://127.0.0.1:' + port + path;
      const probe = await jget('/api/probe?url=' + enc(U), 20000);
      const ads = await jget('/api/ads?url=' + enc(U), 20000);
      const ranges = (ads && ads.ranges) || [];
      const badTargets = ranges.filter((r) => !(r[2] > r[1] && r[2] > r[0] && r[2] - r[0] < 60)).length;
      const cut = await jget('/api/hls?url=' + enc(U) + '&mode=cut', 20000);
      let segCount = 0;
      let firstOk = '';
      if (cut && cut.path) {
        const pl = await txt(B + cut.path);
        segCount = (pl.match(/#EXTINF/g) || []).length;
        firstOk = await firstSegOk(pl, B + cut.path);
      }
      const adSecs = Math.round(ranges.reduce((a, r) => a + (r[1] - r[0]), 0));
      const cutCuts = ((cut && cut.cuts) || []).length;
      const removed = Math.round((cut && cut.removedSeconds) || 0);
      console.log('  ' + name + ': 时长 ' + Math.round((probe && probe.duration) || 0) + 's / disc ' + (probe && probe.disc) +
        ' / 分片 ' + (probe && probe.segments) + ' | 区间 ' + ranges.length + ' (' + adSecs + 's)' +
        ' | 剪辑 ' + cutCuts + ' 段 / ' + removed + 's | 列表分片 ' + segCount + ' | 首片 ' + (firstOk || '-'));

      if (!probe || !probe.duration) fail(name + '：探测不到时长');
      if (badTargets) fail(name + '：有 ' + badTargets + ' 个目标点非法');
      if (wantAds) {
        if (ranges.length !== 2) fail(name + '：应检出 2 段，实际 ' + ranges.length);
        if (cutCuts !== 2) fail(name + '：剪辑段数应为 2，实际 ' + cutCuts);
        if (Math.abs(removed - 60) > 2) fail(name + '：剪辑时长应约 60s，实际 ' + removed + 's');
        if (!(segCount < (probe.segments || 0))) fail(name + '：剪辑后分片未减少');
      } else {
        if (ranges.length !== 0) fail(name + '：干净流不应检出广告');
        if (cutCuts !== 0) fail(name + '：干净流不应剪辑');
      }
      if (!/^20[06]\//.test(firstOk)) fail(name + '：剪辑后首片不可取（' + firstOk + '）');
    }
  } finally {
    srv.close();
  }
}

// ---------- 2) 全站点真实源 ----------
async function sweep() {
  console.log('');
  console.log('[2/2] 全站点真实源（片名：' + TITLE + '）');
  const sitesRes = await jget('/api/sites');
  const sites = (sitesRes.sites || []).filter((s) => !s.disabled);
  const originalKey = sitesRes.activeKey || (sites[0] || {}).key;
  const rows = [];

  for (const s of sites) {
    const rec = { site: s.name, kind: 'm3u8', ok: true, note: '' };
    try {
      await jpost('/api/site/select', { siteKey: s.key });
      let list = ((await jget('/api/search?wd=' + enc(TITLE))) || {}).list || [];
      if (!list.length) list = ((await jget('/api/home')) || {}).list || [];
      if (!list.length) { rec.kind = 'skip'; rec.note = '无内容'; rows.push(rec); continue; }

      const d = await jget('/api/detail?id=' + enc(list[0].vod_id));
      const src = ((d && d.playSources) || [])[0];
      if (!src || !src.episodes || !src.episodes.length) { rec.kind = 'skip'; rec.note = '无线路'; rows.push(rec); continue; }

      const ep = src.episodes[0];
      const play = s.isDexSpider
        ? await jget('/api/spider/play?siteKey=' + enc(s.key) + '&flag=' + enc(src.flag) + '&id=' + enc(ep.url), 40000)
        : { url: ep.url, header: '' };
      let url = (play && play.url) || '';
      const hdr = (play && play.header) || '';
      if (!url) { rec.kind = 'skip'; rec.note = '取流失败'; rows.push(rec); continue; }
      if (!/\.m3u8/i.test(url)) {
        const rv = await jget('/api/resolve?url=' + enc(url));
        if (rv && rv.url) url = rv.url;
      }
      if (!/\.m3u8/i.test(url)) { rec.kind = 'direct'; rec.note = '直链（非 m3u8，广告代理不适用）'; rows.push(rec); continue; }

      const probe = await jget('/api/probe?url=' + enc(url) + '&headers=' + enc(hdr), 40000);
      const ads = await jget('/api/ads?url=' + enc(url) + '&headers=' + enc(hdr), 40000);
      const ranges = (ads && ads.ranges) || [];
      const cut = await jget('/api/hls?url=' + enc(url) + '&mode=cut&headers=' + enc(hdr), 40000);

      let segCount = 0;
      let firstOk = '';
      if (cut && cut.path) {
        const pl = await txt(B + cut.path);
        segCount = (pl.match(/#EXTINF/g) || []).length;
        firstOk = await firstSegOk(pl, B + cut.path);
      }
      rec.dur = Math.round((probe && probe.duration) || 0);
      rec.disc = probe && probe.disc;
      rec.segments = probe && probe.segments;
      rec.ranges = ranges.length;
      rec.adSecs = Math.round(ranges.reduce((a, r) => a + Math.max(0, r[1] - r[0]), 0));
      rec.badTargets = ranges.filter((r) => !(r[2] > r[1])).length;
      rec.cutCuts = ((cut && cut.cuts) || []).length;
      rec.segCount = segCount;
      rows.push(rec);

      console.log('  ' + s.name + ' | 时长 ' + rec.dur + 's / 分片 ' + rec.segments + ' / disc ' + rec.disc +
        ' | 区间 ' + rec.ranges + ' (' + rec.adSecs + 's) | 剪辑 ' + rec.cutCuts + ' 段 | 列表分片 ' + segCount + ' | 首片 ' + (firstOk || '-'));

      if (!rec.dur) fail(s.name + '：探测不到时长（列表可能失效）');
      if (rec.badTargets) fail(s.name + '：有 ' + rec.badTargets + ' 个广告目标点非法（target <= end）');
      if (rec.ranges && rec.cutCuts !== rec.ranges) fail(s.name + '：区间 ' + rec.ranges + ' 段但剪辑 ' + rec.cutCuts + ' 段，不一致');
      if (rec.ranges && !(segCount < rec.segments)) fail(s.name + '：剪辑后分片未减少');
      if (rec.ranges && !/^20[06]\//.test(firstOk)) fail(s.name + '：剪辑后首片不可取（' + firstOk + '）');
      if (!cut || !cut.path) fail(s.name + '：广告代理失败 ' + ((cut && cut.error) || ''));
    } catch (e) {
      rec.kind = 'skip';
      rec.note = '异常:' + e.message.slice(0, 40);
      rows.push(rec);
      console.log('  ' + s.name + ' | 异常 ' + rec.note);
    }
    await sleep(200);
  }

  if (originalKey) { try { await jpost('/api/site/select', { siteKey: originalKey }); } catch (e) {} }

  const tested = rows.filter((r) => r.kind === 'm3u8');
  const withAds = tested.filter((r) => r.ranges > 0);
  const dirty = tested.filter((r) => r.disc > 0);
  console.log('');
  console.log('  站点合计 ' + rows.length + ' | 可测 m3u8 ' + tested.length +
    ' | 直链 ' + rows.filter((r) => r.kind === 'direct').length +
    ' | 跳过 ' + rows.filter((r) => r.kind === 'skip').length);
  console.log('  检出广告 ' + withAds.length + ' 个源：' +
    (withAds.map((r) => r.site + '(' + r.ranges + '段/' + r.adSecs + 's)').join(', ') || '无'));
  console.log('  脏流(disc>0) ' + dirty.length + ' 个：' +
    (dirty.map((r) => r.site + '(disc' + r.disc + ')').join(', ') || '无'));
  for (const r of rows.filter((x) => x.kind !== 'm3u8')) console.log('  - ' + r.site + '：' + r.note);
}

(async () => {
  try {
    const v = await jget('/api/version', 8000);
    if (!v || !v.version) throw new Error('接口无响应');
    console.log('KimBoxPC 广告过滤自检  版本 ' + v.version + '  服务 ' + B);
    console.log('');
    await synthTest();
    await sweep();
    console.log('');
    if (fails) {
      console.log('结果：发现 ' + fails + ' 个问题，请检查上面 [FAIL] 行');
      process.exit(1);
    }
    console.log('结果：全部通过');
    process.exit(0);
  } catch (e) {
    console.error('自检启动失败：' + e.message + '（请先启动 KimBoxPC，或用 -Port 指定实际端口）');
    process.exit(2);
  }
})();
