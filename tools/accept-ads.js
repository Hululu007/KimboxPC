/**
 * 去广告功能「全源验收」脚本
 *
 * 做真事：对每个收录指定剧集的站点取一条线路的首集 → 走 /api/hls 代理拿区间 →
 * 用 libmpv 实际起播，分别跳到「第一段广告前 6 秒」和「片尾广告前 6 秒」，
 * 复刻前端跳过逻辑，验证：是否触发、跳到哪、跳后是否继续播/到结尾。
 *
 * 用法（需要 App 或 
ode server.js 在运行）：
 *   node tools\accept-ads.js 尚公主                # 全源
 *   node tools\accept-ads.js 尚公主 猫眼            # 只测站点名含「猫眼」的
 *   set ACCEPT_API=http://127.0.0.1:3988           # 指定服务地址（默认 3980）
 *
 * 输出：每个场景 PASS/FAIL + 按站点汇总；明细写入 _accept.json（不入库）
 */const path = require('path');
const ROOT = path.join(__dirname, '..');   // 本脚本在 tools/ 下，项目根在上一级
process.env.PATH = path.join(ROOT, 'native', 'lib') + ';' + process.env.PATH;
const native = require(path.join(ROOT, 'native', 'build', 'Release', 'mpv_native.node'));
native.init(path.join(ROOT, 'native', 'lib', 'libmpv-2.dll'));
const axios = require(path.join(ROOT, 'node_modules', 'axios'));
const CmsEngine = require(path.join(ROOT, 'cmsEngine.js'));

const API = process.env.ACCEPT_API || 'http://127.0.0.1:3980';
const TITLE = process.argv[2] || '尚公主';
const CONC = 2;              // 同时播几个
const PRE = Number(process.env.ACCEPT_PRE || 6);   // 提前几秒起播（尾部卡顿的源可加大）
const normName = (s) => String(s || '').replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/[\u0000-\u001F\u007F-\u009F]/g, '')
  .replace(/[\s·・,，.。:：!！?？'"“”()（）\[\]【】\-_]/g, '').toLowerCase();

const fmt = (t) => { const v = Math.max(0, t); const m = Math.floor(v / 60); const s = v - m * 60; return `${m}:${s < 10 ? '0' : ''}${s.toFixed(1)}`; };

/** 一次「起播 → 命中断言」验证。返回 { ok, reason, detail } */
function runOne(proxyUrl, ranges, idx, duration, pre = PRE, maxMs = 25000) {
  return new Promise((resolve) => {
    const r = ranges[idx];
    const startAt = Math.max(0, r[0] - pre);
    const inst = native.create({ vo: 'null', ao: 'null', idle: 'yes', cache: 'yes', 'cache-secs': '30' });
    native.setProp(inst, 'start', String(startAt));
    native.command(inst, ['loadfile', proxyUrl, 'replace']);
    native.setProp(inst, 'pause', false);

    const t0 = Date.now();
    let offset = 0, lastRaw = 0, selfSeekUntil = 0, guard = 0, locked = -1;
    let hitAt = null, target = null, skipped = false, maxAfter = 0, reason = '', posHint = 0;
    const done = (ok, why) => {
      clearInterval(timer);
      try { native.destroy(inst); } catch (e) {}
      resolve({ ok, reason: why, hitAt, target, maxAfter, idx });
    };

    const timer = setInterval(() => {
      const raw = Number(native.getProp(inst, 'time-pos'));
      const dur = Number(native.getProp(inst, 'duration')) || duration || 0;
      const idle = String(native.getProp(inst, 'idle-active')) === 'yes';
      if (Number.isFinite(raw)) {
        if (Math.abs(raw - lastRaw) > 15 && lastRaw > 0 && Date.now() > selfSeekUntil) offset = (lastRaw + offset) - raw;
        lastRaw = raw;
      }
      const pos = Number.isFinite(raw) ? raw + offset : NaN;

      if (!skipped && Number.isFinite(pos)) {
        if (locked >= 0) { const l = ranges[locked]; if (!l || pos >= l[1] - 0.2 || pos < l[0] - 2) locked = -1; }
        if (locked < 0 && Date.now() - guard >= 1200) {
          for (let i = 0; i < ranges.length; i++) {
            const [s, e, tt] = ranges[i];
            if (!(pos >= s - 1.2 && pos < e - 0.2)) continue;
            let tgt = Number(tt); if (!(tgt > e + 0.1)) tgt = e + 0.4;
            if (dur > 0 && (ranges[i][3] === 1 || tgt > dur - 1)) tgt = Math.max(0, dur - 0.5);
            hitAt = pos; target = tgt; skipped = true;
            // 复刻 electron/main.js 的修复：跳到片尾附近时把目标位置记进「最远位置」
            if (dur > 0 && tgt >= dur - 3) posHint = tgt;
            guard = Date.now(); locked = i;
            native.command(inst, ['seek', String(tgt), 'absolute']);
            offset = 0; lastRaw = tgt; selfSeekUntil = Date.now() + 5000;
            return;
          }
        }
      }

      if (skipped) {
        if (Number.isFinite(pos) && pos > maxAfter) maxAfter = pos;
        if (posHint > maxAfter) maxAfter = posHint;
        const expect = (r[3] === 1) ? (dur - 2) : (r[1] + 0.2);
        if (maxAfter >= expect) return done(true, '');
        if (idle) return done(false, dur > 0 && maxAfter >= dur - 3 ? '到达结尾' : '跳后进入 idle');
        if (Date.now() - t0 > maxMs) return done(false, `跳后位置未超过区间（${fmt(maxAfter)} < ${fmt(expect)}）`);
      } else {
        if (idle) return done(false, '起播失败/提前结束');
        if (Date.now() - t0 > maxMs) return done(false, `未触发（当前位置 ${Number.isFinite(pos) ? fmt(pos) : '?'}，区间 ${fmt(r[0])}-${fmt(r[1])}）`);
      }
    }, 500);
  });
}

async function pool(items, worker, limit) {
  const out = []; let i = 0;
  await Promise.all(new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    while (i < items.length) { const k = i++; out[k] = await worker(items[k], k); }
  }));
  return out;
}

(async () => {
  const cfg = JSON.parse(require('fs').readFileSync(path.join(ROOT, 'data', 'cache', 'config_14.json'), 'utf8'));
  const sites = (cfg.sites || []).filter(s => !s.isDexSpider && s.searchable !== 0);
  console.log(`【验收】剧集 ${TITLE}　站点 ${sites.length}　${new Date().toLocaleTimeString()}`);

  // 1) 找到收录该剧的站点
  const hits = [];
  await pool(sites, async (site) => {
    try {
      const r = await CmsEngine.search(site, TITLE, 1);
      const t = normName(TITLE);
      const m = (r.list || []).find(v => normName(v.vod_name) === t)
        || (r.list || []).find(v => normName(v.vod_name).includes(t) || t.includes(normName(v.vod_name)));
      if (m) hits.push({ site, vod: m });
    } catch (e) {}
  }, 6);
  console.log(`收录该剧：${hits.length} 站\n`);

  // 2) 取每条线路首集，走代理拿区间
  const jobs = [];
  await pool(hits, async ({ site, vod }) => {
    try {
      const d = await CmsEngine.getDetail(site, vod.vod_id);
      const lines = (d.playSources || []).filter(l => l.episodes && l.episodes.length);
      if (!lines.length) { jobs.push({ site: site.name, err: '无线路' }); return; }
      // 优先选「首集就是 m3u8」的线路；否则对首个网页地址走 /api/resolve 解析
      const line = lines.find(l => /\.m3u8/i.test(l.episodes[0].url)) || lines[0];
      const ep = line.episodes[0];
      let mediaUrl = ep.url;
      if (!/\.m3u8/i.test(mediaUrl)) {
        try {
          const rr = (await axios.get(`${API}/api/resolve`, { params: { url: mediaUrl }, timeout: 40000 })).data;
          if (rr && rr.url && /\.m3u8/i.test(rr.url)) mediaUrl = rr.url;
        } catch (e) {}
        if (!/\.m3u8/i.test(mediaUrl)) { jobs.push({ site: site.name, line: line.sourceName, ep: ep.title, err: '非 m3u8' }); return; }
      }
      const prep = (await axios.get(`${API}/api/hls`, { params: { url: mediaUrl }, timeout: 60000 })).data;
      jobs.push({
        site: site.name, line: line.sourceName, ep: ep.title,
        url: prep.absoluteUrl, ranges: prep.ranges || [], duration: prep.duration || 0, chunks: (prep.chunks || []).length
      });
    } catch (e) {
      jobs.push({ site: site.name, err: '取列表失败: ' + String(e.message).slice(0, 40) });
    }
  }, 4);

  // 3) 每条列表选「第一段」和「片尾段」两个场景
  const tasks = [];
  const only = process.argv[3] || '';
  for (const j of jobs) {
    if (only && !String(j.site).includes(only)) continue;
    if (j.err || !j.ranges.length) continue;
    const picks = [];
    picks.push(j.ranges.findIndex(r => r[3] !== 1));
    const tailIdx = j.ranges.findIndex(r => r[3] === 1);
    if (tailIdx >= 0) picks.push(tailIdx);
    else {
      const mids = j.ranges.map((r, i) => (r[3] === 1 ? -1 : i)).filter(i => i >= 0);
      if (mids.length > 1) picks.push(mids[mids.length - 1]);
    }
    for (const idx of [...new Set(picks)].filter(i => i >= 0)) tasks.push({ j, idx });
  }
  console.log(`待播验证场景：${tasks.length} 个（${jobs.filter(j => !j.err && j.ranges.length).length} 条含广告列表）\n`);

  // 4) 实播验证
  const results = await pool(tasks, async ({ j, idx }) => {
    const r = j.ranges[idx];
    let res = await runOne(j.url, j.ranges, idx, j.duration);
    // 尾部区域直接 seek 进去可能不被源支持（会卡住）→ 改成提前 90 秒起播、一路播过去再跳
    if (!res.ok && res.reason === '起播失败/提前结束') {
      console.log(`  （${j.site} ${r[3] === 1 ? '片尾' : '#' + (idx + 1)}：直接跳转失败，改用 90 秒预播重试）`);
      res = await runOne(j.url, j.ranges, idx, j.duration, 90, 150000);
      res.retried = true;
    }
    const kind = r[3] === 1 ? '片尾' : `#${idx + 1}`;
    console.log(`${res.ok ? 'PASS' : 'FAIL'}  ${j.site} / ${j.line} / ${j.ep} · ${kind} [${fmt(r[0])}-${fmt(r[1])}]`
      + (res.ok ? `  命中 ${fmt(res.hitAt || 0)} → ${fmt(res.target || 0)}` : `  ${res.reason}`));
    return { ...j, idx, ...res, kind };
  }, CONC);

  // 5) 汇总
  const tested = new Set(results.map(r => r.site));
  const pass = results.filter(r => r.ok).length;
  console.log('\n================ 汇总 ================');
  console.log(`场景通过 ${pass}/${results.length}`);
  const bySite = {};
  for (const r of results) {
    bySite[r.site] = bySite[r.site] || { total: 0, pass: 0, note: '' };
    bySite[r.site].total++; if (r.ok) bySite[r.site].pass++;
    if (!r.ok) bySite[r.site].note = r.reason;
  }
  for (const [s, v] of Object.entries(bySite)) console.log(`  ${v.pass === v.total ? '✔' : '✘'} ${s.padEnd(14)} ${v.pass}/${v.total}  ${v.note || ''}`);
  const noAd = jobs.filter(j => !j.err && !j.ranges.length).map(j => j.site);
  const errs = jobs.filter(j => j.err).map(j => `${j.site}(${j.err})`);
  console.log(`\n无广告列表: ${noAd.length ? noAd.join('、') : '无'}`);
  console.log(`取列表失败: ${errs.length ? errs.join('、') : '无'}`);
  require('fs').writeFileSync(path.join(ROOT, '_accept.json'), JSON.stringify({ jobs, results }, null, 2), 'utf8');
  console.log(`\n完成 ${new Date().toLocaleTimeString()}（明细 _accept.json）`);
  process.exit(0);
})().catch(e => { console.error('FAILED', e); process.exit(1); });




