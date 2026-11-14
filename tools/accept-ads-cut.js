/**
 * 剪辑模式（mode=cut）全源验收
 * 对每个收录指定剧集的站点：取首集 → /api/hls（skip 与 cut 各一次）→
 *  1) 结构校验：删除段数 = 广告块数、每段时长 5~120s、片长 = 原片长 - 删除秒数、ENDLIST 未丢、分片数正确
 *  2) 播放器校验：mpv 报告时长与预期一致（防「当直播流/时长错乱」）
 *  3) 连续性校验：从第一段被删广告位置起播，跨过拼接处不跳变
 *
 * 用法：node tools\accept-ads-cut.js 尚公主 [站点关键字]
 */
const path = require('path');
const fs = require('fs');
const ROOT = path.join(__dirname, '..');
process.env.PATH = path.join(ROOT, 'native', 'lib') + ';' + process.env.PATH;
const native = require(path.join(ROOT, 'native', 'build', 'Release', 'mpv_native.node'));
native.init(path.join(ROOT, 'native', 'lib', 'libmpv-2.dll'));
const axios = require(path.join(ROOT, 'node_modules', 'axios'));
const CmsEngine = require(path.join(ROOT, 'cmsEngine.js'));

const API = process.env.ACCEPT_API || 'http://127.0.0.1:3980';
const TITLE = process.argv[2] || '尚公主';
const ONLY = process.argv[3] || '';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const norm = s => String(s || '').replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/[\u0000-\u001F\u007F-\u009F]/g, '')
  .replace(/[\s·・,，.。:：!！?？'"“”()（）\[\]【】\-_]/g, '').toLowerCase();
const fmt = t => { const v = Math.max(0, t); const m = Math.floor(v / 60); const s = v - m * 60; return `${m}:${s < 10 ? '0' : ''}${s.toFixed(1)}`; };

/** 用 mpv 读播放列表时长，并从 from 起播观察是否连续 */
function probePlaylist(url, from, needContinuity) {
  return new Promise((resolve) => {
    const inst = native.create({ vo: 'null', ao: 'null', idle: 'yes', cache: 'yes', 'cache-secs': '30' });
    if (from > 0) native.setProp(inst, 'start', String(Math.floor(from)));
    native.command(inst, ['loadfile', url, 'replace']);
    native.setProp(inst, 'pause', false);
    const t0 = Date.now();
    let dur = 0, maxPos = 0, samples = [];
    const timer = setInterval(() => {
      const d = Number(native.getProp(inst, 'duration'));
      const p = Number(native.getProp(inst, 'time-pos'));
      if (d > 0) dur = d;
      if (Number.isFinite(p)) { maxPos = Math.max(maxPos, p); samples.push(p); }
      const elapsed = (Date.now() - t0) / 1000;
      const done = dur > 0 && (needContinuity ? (maxPos > from + 10 || elapsed > 25) : elapsed > 4);
      if (done || elapsed > 40) {
        clearInterval(timer);
        try { native.destroy(inst); } catch (e) {}
        const back = samples.filter((v, i) => i > 0 && v < samples[i - 1] - 30).length;
        resolve({ dur, maxPos, back });
      }
    }, 500);
  });
}

(async () => {
  const cacheFile = fs.readdirSync(path.join(ROOT, 'data', 'cache')).filter(f => /^config_\d+\.json$/.test(f)).sort().pop();
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'cache', cacheFile), 'utf8'));
  const sites = (cfg.sites || []).filter(s => !s.isDexSpider && s.searchable !== 0 && (!ONLY || String(s.name).includes(ONLY)));
  console.log(`【剪辑模式验收】${TITLE}　候选站点 ${sites.length}　${new Date().toLocaleTimeString()}`);

  // 各站找片
  const hits = [];
  let cursor = 0;
  await Promise.all(new Array(Math.min(6, sites.length)).fill(0).map(async () => {
    while (cursor < sites.length) {
      const site = sites[cursor++];
      try {
        const r = await CmsEngine.search(site, TITLE, 1);
        const t = norm(TITLE);
        const m = (r.list || []).find(v => norm(v.vod_name) === t) || (r.list || []).find(v => norm(v.vod_name).includes(t));
        if (m) hits.push({ site, vodId: m.vod_id });
      } catch (e) {}
    }
  }));
  console.log(`收录该剧：${hits.length} 站\n`);

  const rows = [];
  for (const { site, vodId } of hits) {
    const row = { site: site.name, ok: false, note: '' };
    try {
      const d = await CmsEngine.getDetail(site, vodId);
      const lines = (d.playSources || []).filter(l => l.episodes && l.episodes.length);
      if (!lines.length) { row.note = '无线路'; rows.push(row); console.log(`FAIL  ${row.site}  ${row.note}`); continue; }
      const line = lines.find(l => /\.m3u8/i.test(l.episodes[0].url)) || lines[0];
      let epUrl = line.episodes[0].url;
      if (!/\.m3u8/i.test(epUrl)) {
        // 首集是网页壳：先走 /api/resolve（和 App 里的处理一致）
        try {
          const rr = (await axios.get(`${API}/api/resolve`, { params: { url: epUrl }, timeout: 40000 })).data;
          if (rr && rr.url && /\.m3u8/i.test(rr.url)) epUrl = rr.url;
        } catch (e) {}
        if (!/\.m3u8/i.test(epUrl)) { row.note = '非 m3u8（且解析失败）'; row.notApplicable = true; rows.push(row); console.log(`SKIP  ${row.site}  ${row.note}`); continue; }
      }

      const skip = (await axios.get(`${API}/api/hls`, { params: { url: epUrl }, timeout: 60000 })).data;
      const cut = (await axios.get(`${API}/api/hls`, { params: { url: epUrl, mode: 'cut' }, timeout: 60000 })).data;
      if (!skip.duration || !cut.duration) { row.note = '源返回的列表没有分片（无法分析，与剪辑无关）'; row.notApplicable = true; rows.push(row); console.log(`SKIP  ${row.site}  ${row.note}`); continue; }

      const adChunks = (skip.chunks || []).filter(c => c.ad);
      row.ads = adChunks.length;
      row.removed = cut.removedSeconds;
      row.dur0 = skip.duration;
      row.dur1 = cut.duration;

      if (!adChunks.length) { row.ok = true; row.note = '无广告（不剪辑）'; rows.push(row); continue; }

      // 结构校验
      if (!cut.cut) { row.note = '未生成剪辑列表'; rows.push(row); continue; }
      const sumAd = adChunks.reduce((a, c) => a + Number(c.d), 0);
      if (Math.abs(sumAd - cut.removedSeconds) > 1.5) { row.note = `删除秒数不符（块和 ${sumAd.toFixed(1)} vs ${cut.removedSeconds}）`; rows.push(row); continue; }
      if ((cut.cuts || []).length !== adChunks.length) { row.note = `删除段数不符（${cut.cuts.length} vs ${adChunks.length}）`; rows.push(row); continue; }
      if ((cut.cuts || []).some(c => (c[1] - c[0]) < 5 || (c[1] - c[0]) > 120)) { row.note = '删除了异常时长的块'; rows.push(row); continue; }
      if (Math.abs((skip.duration - cut.removedSeconds) - cut.duration) > 1.5) { row.note = `片长计算不符（${skip.duration}-${cut.removedSeconds}≠${cut.duration}）`; rows.push(row); continue; }

      // 播放列表文本校验
      const text = String((await axios.get(cut.absoluteUrl, { timeout: 20000, responseType: 'text' })).data);
      if (!/#EXTM3U/.test(text)) { row.note = '列表缺 #EXTM3U'; rows.push(row); continue; }
      if (/#EXT-X-ENDLIST/.test(text) === false && skip.totalChunks > 1) {
        // 原列表若有 ENDLIST 而剪辑后丢了，视为错误
        const srcText = String((await axios.get(skip.absoluteUrl, { timeout: 20000, responseType: 'text' })).data);
        if (/#EXT-X-ENDLIST/.test(srcText)) { row.note = '剪辑后丢了 #EXT-X-ENDLIST'; rows.push(row); continue; }
      }
      const nSeg = (text.match(/#EXTINF/g) || []).length;
      const expectSeg = skip.chunks.reduce((a, c) => a + Number(c.n), 0) - adChunks.reduce((a, c) => a + Number(c.n), 0);
      if (nSeg !== expectSeg) { row.note = `分片数不符（${nSeg} vs ${expectSeg}）`; rows.push(row); continue; }

      // 播放器校验：时长 + 连续性
      const firstCut = cut.cuts[0];
      const cleanStart = Math.max(0, firstCut[0] - 5);   // 第一段广告前 5 秒（剪辑时间轴上位置相同，因为之前没删过）
      const pr = await probePlaylist(cut.absoluteUrl, cleanStart, true);
      row.playerDur = pr.dur;
      row.maxPos = pr.maxPos;
      if (Math.abs(pr.dur - cut.duration) > 3) { row.note = `播放器时长不符（${pr.dur.toFixed(0)} vs ${cut.duration}）`; rows.push(row); continue; }
      if (pr.back > 0) { row.note = `拼接处回退了 ${pr.back} 次`; rows.push(row); continue; }
      if (!(pr.maxPos > cleanStart + 8)) { row.note = `跨过拼接处没继续播（到 ${pr.maxPos.toFixed(0)}s）`; rows.push(row); continue; }

      row.ok = true;
      row.note = `删 ${cut.cuts.length} 段/${cut.removedSeconds}s，${fmt(skip.duration)}→${fmt(cut.duration)}`;
    } catch (e) {
      row.note = '失败: ' + String(e.message).slice(0, 40);
    }
    rows.push(row);
    console.log(`${row.ok ? 'PASS' : 'FAIL'}  ${row.site}  ${row.note}`);
  }

  console.log('\n================ 汇总 ================');
  const tested = rows.filter(r => r.ads !== undefined);
  const pass = rows.filter(r => r.ok).length;
  const na = rows.filter(r => r.notApplicable).length;
  const fail = rows.filter(r => !r.ok && !r.notApplicable);
  console.log(`站点 ${rows.length}，通过 ${pass}，不适用 ${na}，失败 ${fail.length}`);
  for (const r of fail) console.log(`  ✘ ${r.site}：${r.note}`);
  const withAds = tested.filter(r => r.ads > 0);
  if (withAds.length) {
    const totalRemoved = withAds.reduce((a, r) => a + (r.removed || 0), 0);
    console.log(`含广告列表 ${withAds.length} 个，共删除 ${Math.round(totalRemoved)} 秒`);
  }
  fs.writeFileSync(path.join(ROOT, '_cut_accept.json'), JSON.stringify(rows, null, 2), 'utf8');
  process.exit(fail.length === 0 ? 0 : 1);
})();



