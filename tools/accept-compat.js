/**
 * 兼容模式（ffmpeg 转封装 + mpegts.js）全源验收
 * 通过 CDP 驱动真实 App 窗口：逐站点打开详情→用兼容内核起播→校验
 *   cut  模式：播放器时长 == 剪辑后片长、跳过区间为空
 *   skip 模式：跳到首段广告前 → 触发跳过（base 变为目标点）并越过区间
 *
 * 用法：node tools\accept-compat.js 尚公主 [站点关键字] [cut|skip|both]
 */
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const ROOT = path.join(__dirname, '..');
const CmsEngine = require(path.join(ROOT, 'cmsEngine.js'));

const APP = ROOT;
const EXE = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const API = 'http://127.0.0.1:3980';
const CDP = 'http://127.0.0.1:9222';
const TITLE = process.argv[2] || '尚公主';
const ONLY = process.argv[3] || '';
const MODE = process.argv[4] || 'both';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const norm = s => String(s || '').replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/[\s·・,，.。:：!！?？'"“”()（）\[\]【】\-_]/g, '').toLowerCase();

let ws = null, id = 0; const pending = new Map();
function send(m, p) {
  return new Promise((res, rej) => {
    const i = ++id; pending.set(i, { res, rej });
    ws.send(JSON.stringify({ id: i, method: m, params: p || {} }));
    setTimeout(() => { if (pending.has(i)) { pending.delete(i); rej(new Error('CDP timeout: ' + m)); } }, 90000);
  });
}
async function ev(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || 'eval error');
  return r.result.value;
}
async function waitFor(expr, ms, label) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { if (await ev(expr)) return true; } catch (e) {}
    await sleep(1500);
  }
  throw new Error(`等待超时（${Math.round(ms / 1000)}s）：${label}`);
}

(async () => {
  // 1) 起 App（带调试端口）
  try { require('child_process').execSync('taskkill /IM electron.exe /F', { stdio: 'ignore' }); } catch (e) {}
  await sleep(1500);
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const proc = spawn(EXE, ['--remote-debugging-port=9222', APP], { stdio: ['ignore', fs.openSync(path.join(ROOT, '_c_out.log'), 'w'), fs.openSync(path.join(ROOT, '_c_err.log'), 'w')], env });
  proc.on('exit', c => console.log(`*** App 退出 code=${c}`));
  let page = null;
  for (let i = 0; i < 40 && !page; i++) {
    await sleep(700);
    try { const j = (await axios.get(`${CDP}/json/list`, { timeout: 1000 })).data; page = (j || []).find(t => t.type === 'page' && String(t.url).includes('3980')); } catch (e) {}
  }
  if (!page) throw new Error('调试端口没起来');
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = m => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { const p = pending.get(d.id); pending.delete(d.id); d.error ? p.rej(new Error(d.error.message)) : p.res(d.result); } };
  await sleep(4000);

  // 2) 找片
  const cacheFile = fs.readdirSync(path.join(ROOT, 'data', 'cache')).filter(f => /^config_\d+\.json$/.test(f)).sort().pop();
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'cache', cacheFile), 'utf8'));
  const sites = (cfg.sites || []).filter(s => !s.isDexSpider && s.searchable !== 0 && (!ONLY || String(s.name).includes(ONLY)));
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
  console.log(`【兼容模式验收】${TITLE}　收录 ${hits.length} 站　模式 ${MODE}　${new Date().toLocaleTimeString()}\n`);

  const modes = MODE === 'both' ? ['cut', 'skip'] : [MODE];
  const rows = [];

  for (const mode of modes) {
    // 固定初始状态：浏览器内核 + 兼容模式 + 指定广告方式
    await ev(`localStorage.setItem('tvbox_engine','browser');localStorage.setItem('tvbox_compat','1');localStorage.setItem('tvbox_admode','${mode}');localStorage.setItem('tvbox_adfilter','1');'ok'`);
    await ev('location.reload()');
    await sleep(6000);

    for (const { site, vodId } of hits) {
      const row = { site: site.name, mode, ok: false, note: '' };
      try {
        await ev(`closePlayer()`).catch(() => {});
        await ev(`openDetail(${JSON.stringify(vodId)}, ${JSON.stringify(site.key)})`);
        // 兼容内核只在「探测到 discontinuity」时启用；干净流会自动回退 hls.js，属于正常行为
        const started = await waitFor('!!(typeof pvVideo !== "undefined" && pvVideo.currentTime > 1.5)', 90000, `${site.name} 起播`).then(() => true).catch(() => false);
        if (!started) { row.note = '起播超时'; rows.push(row); console.log(`FAIL  ${site.name}  ${row.note}`); continue; }
        // 时长要等元数据就绪（部分源起播 1~2 秒内 duration 还是 0/NaN）
        await waitFor('(typeof seekDuration === "function" && seekDuration() > 0)', 20000, '时长就绪').catch(() => {});

        const st = JSON.parse(await ev(`JSON.stringify({
          engine: compat.on ? 'compat' : 'mse',
          mode: (window.__adDebug||{}).mode, cut: !!(window.__adDebug||{}).cut,
          wantDur: Number((window.__adDebug||{}).duration||0),
          removed: Number((window.__adDebug||{}).removed||0),
          ranges: (window.__adRanges||[]), cuts: (window.__adDebug||{}).cuts || [],
          playerDur: Number(pvVideo.duration||0), uiDur: Number((typeof seekDuration === 'function' ? seekDuration() : 0) || 0),
          base: compat.base, ct: Number(pvVideo.currentTime||0)
        })`));

        if (mode === 'cut') {
          if (!st.cut) { row.ok = true; row.note = `无广告可剪（${st.engine}）`; rows.push(row); console.log(`PASS  ${site.name}  ${row.note}`); continue; }
          if (!(st.uiDur > 0)) { row.note = '拿不到时长'; rows.push(row); console.log(`FAIL  ${site.name}  ${row.note}`); continue; }
          if (Math.abs(st.uiDur - st.wantDur) > 3) { row.note = `界面时长不符（${st.uiDur.toFixed(0)} vs 期望 ${st.wantDur.toFixed(0)}）`; rows.push(row); console.log(`FAIL  ${site.name}  ${row.note}`); continue; }
          if (st.ranges.length) { row.note = '剪辑模式下仍有跳过区间'; rows.push(row); console.log(`FAIL  ${site.name}  ${row.note}`); continue; }
          row.ok = true;
          row.note = `${st.engine}｜时长 ${st.uiDur.toFixed(0)}s（删 ${st.cuts.length} 段/${st.removed}s）`;
          rows.push(row);
          console.log(`PASS  ${site.name}  ${row.note}`);
          await sleep(500);
          continue;
        }

        if (!st.ranges.length) { row.ok = true; row.note = `无广告区间（${st.engine}）`; rows.push(row); console.log(`PASS  ${site.name}  ${row.note}`); continue; }
        if (st.engine !== 'compat') { row.ok = true; row.note = '干净流自动回退 hls.js，无广告'; rows.push(row); console.log(`PASS  ${site.name}  ${row.note}`); continue; }
        {
          const r = st.ranges.find(x => x[3] !== 1) || st.ranges[0];
          await ev(`seekTo(${Math.max(0, r[0] - 3)})`);
          const ok = await waitFor(`compat.base >= ${Math.floor(r[2]) - 1} && pvVideo.currentTime > 0.5`, 45000, '触发跳过').then(() => true).catch(() => false);
          const after = JSON.parse(await ev(`JSON.stringify({ base: compat.base, ct: Number(pvVideo.currentTime||0) })`));
          if (!ok) { row.note = `未触发跳过（base=${after.base}）`; rows.push(row); console.log(`FAIL  ${site.name}  ${row.note}`); continue; }
          row.ok = true;
          row.note = `区间 ${Math.round(r[0])}-${Math.round(r[1])}s → base ${after.base}（目标 ${Math.round(r[2])}）`;
          rows.push(row);
          console.log(`PASS  ${site.name}  ${row.note}`);
        }
        await sleep(800);
      } catch (e) {
        row.note = String(e.message).slice(0, 60);
        rows.push(row);
        console.log(`FAIL  ${site.name}  ${row.note}`);
      }
    }
  }

  console.log('\n================ 汇总 ================');
  for (const mode of modes) {
    const sub = rows.filter(r => r.mode === mode);
    console.log(`${mode}: 通过 ${sub.filter(r => r.ok).length}/${sub.length}`);
    for (const r of sub.filter(x => !x.ok)) console.log(`  ✘ ${r.site}：${r.note}`);
  }
  fs.writeFileSync(path.join(ROOT, '_compat_accept.json'), JSON.stringify(rows, null, 2), 'utf8');
  try { proc.kill(); } catch (e) {}
  process.exit(rows.every(r => r.ok) ? 0 : 1);
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
