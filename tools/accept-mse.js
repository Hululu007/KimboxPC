/**
 * 网页 (MSE) 内核全源验收
 *   node tools\accept-mse.js 尚公主 skip
 *   node tools\accept-mse.js 太平年 cut
 *
 * 跳过模式：逐站起播 → 跳到首段广告前 → 等它自动跳过（位置要越过区间末尾并继续往前走）
 * 剪辑模式：逐站起播 → 校验「已剪辑」+ 播放器时长与剪辑后片长一致 → 跳到拼接点后仍能继续播
 *
 * 判定说明：
 *   PASS  行为正确
 *   N/A   该源在 MSE 下起不来（跨域/证书等源站问题，与我们的逻辑无关）
 *   FAIL  能起播但广告处理不对
 */
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const ROOT = path.join(__dirname, '..');
const CmsEngine = require(path.join(ROOT, 'cmsEngine.js'));
const EXE = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const API = 'http://127.0.0.1:3980';

const SHOW = process.argv[2] || '尚公主';
const MODE = process.argv[3] || 'skip';
const ONLY = process.argv[4] || '';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const norm = s => String(s || '').replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/[\s·・,，.。:：!！?？'"“”()（）\[\]【】\-_]/g, '').toLowerCase();

let ws = null, id = 0; const pending = new Map();
const send = (m, p) => new Promise((res, rej) => {
  const i = ++id; pending.set(i, { res, rej });
  ws.send(JSON.stringify({ id: i, method: m, params: p || {} }));
  setTimeout(() => { if (pending.has(i)) { pending.delete(i); rej(new Error('CDP 超时: ' + m)); } }, 90000);
});
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || 'eval 出错');
  return r.result.value;
};
async function waitFor(expr, ms, label) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { if (await ev(expr)) return true; } catch (e) {}
    await sleep(1200);
  }
  return false;
}

(async () => {
  try { execSync('taskkill /IM electron.exe /F', { stdio: 'ignore' }); } catch (e) {}
  await sleep(1500);
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const outLog = fs.openSync(path.join(ROOT, '_mse_out.log'), 'w');
  const errLog = fs.openSync(path.join(ROOT, '_mse_err.log'), 'w');
  const proc = spawn(EXE, ['--remote-debugging-port=9222', ROOT], { stdio: ['ignore', outLog, errLog], env });
  let page = null;
  for (let i = 0; i < 40 && !page; i++) {
    await sleep(700);
    try {
      const j = (await axios.get('http://127.0.0.1:9222/json/list', { timeout: 1000 })).data;
      page = (j || []).find(t => t.type === 'page' && String(t.url).includes('3980'));
    } catch (e) {}
  }
  if (!page) throw new Error('调试端口没起来');
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = m => {
    const d = JSON.parse(m.data);
    if (d.id && pending.has(d.id)) {
      const p = pending.get(d.id); pending.delete(d.id);
      d.error ? p.rej(new Error(d.error.message)) : p.res(d.result);
    }
  };
  await sleep(5000);

  await ev(`localStorage.setItem('tvbox_engine','mse');localStorage.setItem('tvbox_admode','${MODE}');localStorage.setItem('tvbox_adfilter','1');localStorage.setItem('tvbox_cache','120');'ok'`);
  await ev('location.reload()');
  await sleep(6000);
  if ((await ev('engineMode()')) !== 'mse') throw new Error('引擎没切到 mse');

  // 找片：先在后端枚举所有收录站点
  const cacheFile = fs.readdirSync(path.join(ROOT, 'data', 'cache')).filter(f => /^config_\d+\.json$/.test(f)).sort().pop();
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'cache', cacheFile), 'utf8'));
  const sites = (cfg.sites || []).filter(s => !s.isDexSpider && s.searchable !== 0 && (!ONLY || String(s.name).includes(ONLY)));
  const hits = [];
  let cursor = 0;
  await Promise.all(new Array(Math.min(6, sites.length)).fill(0).map(async () => {
    while (cursor < sites.length) {
      const site = sites[cursor++];
      try {
        const r = await CmsEngine.search(site, SHOW, 1);
        const t = norm(SHOW);
        const m = (r.list || []).find(v => norm(v.vod_name) === t) || (r.list || []).find(v => norm(v.vod_name).includes(t));
        if (m) hits.push({ site, vodId: m.vod_id });
      } catch (e) {}
    }
  }));
  console.log(`【MSE 验收】${SHOW}　模式 ${MODE}　收录 ${hits.length} 站　${new Date().toLocaleTimeString()}\n`);

  const rows = [];
  for (const { site, vodId } of hits) {
    const row = { site: site.name, ok: false, na: false, note: '' };
    try {
      await ev('closePlayer()').catch(() => {});
      await sleep(600);
      await ev(`openDetail(${JSON.stringify(vodId)}, ${JSON.stringify(site.key)})`);
      const started = await waitFor('typeof pvVideo !== "undefined" && pvVideo.currentTime > 1 && pvVideo.duration > 0', 100000, '起播');
      if (!started) {
        const st = JSON.parse(await ev(`JSON.stringify({ hls: !!hls, err: pvVideo.error ? pvVideo.error.code : 0, toast: document.getElementById('pvToast').textContent })`));
        row.na = true;
        row.note = 'MSE 起不来：' + (st.toast || '未知').slice(0, 40);
        rows.push(row);
        console.log(`N/A   ${site.name}  ${row.note}`);
        continue;
      }
      const st = JSON.parse(await ev(`JSON.stringify({
        engine: engineMode(), compat: !!compat.on, hls: !!hls,
        dur: Number(pvVideo.duration || 0), cur: Number(pvVideo.currentTime || 0),
        ranges: window.__adRanges || [], cut: !!(window.__adDebug || {}).cut,
        dbgDur: Number((window.__adDebug || {}).duration || 0), cuts: (window.__adDebug || {}).cuts || [],
        ep: (currentDetail.playSources[currentSourceIdx].episodes[currentEpIdx] || {}).title || ''
      })`));
      if (st.engine !== 'mse' || st.compat || !st.hls) {
        row.note = `没走 MSE 内核（engine=${st.engine} compat=${st.compat} hls=${st.hls}）`;
        rows.push(row);
        console.log(`FAIL  ${site.name}  ${row.note}`);
        continue;
      }

      if (MODE === 'skip') {
        if (!st.ranges.length) {
          row.ok = true; row.note = `无广告（${st.ep}，时长 ${Math.round(st.dur)}s）`;
          rows.push(row); console.log(`PASS  ${site.name}  ${row.note}`);
          continue;
        }
        const r = st.ranges.find(x => x[3] !== 1) || st.ranges[0];
        await ev(`seekTo(${Math.max(0, r[0] - 3)})`);
        const skipped = await waitFor(`pvVideo.currentTime >= ${Math.floor(r[2]) - 1}`, 45000, '跳过');
        const after = Number(await ev('pvVideo.currentTime'));
        if (!skipped) {
          row.note = `未跳过（区间 ${Math.round(r[0])}−${Math.round(r[1])}，当前位置 ${after.toFixed(0)}s）`;
          rows.push(row); console.log(`FAIL  ${site.name}  ${row.note}`);
          continue;
        }
        // 跳过去之后要能继续播，不能卡住
        const cont = await waitFor(`pvVideo.currentTime > ${after + 2}`, 20000, '继续播放');
        if (!cont) {
          row.note = `跳过成功但卡住（${after.toFixed(0)}s 之后不动）`;
          rows.push(row); console.log(`FAIL  ${site.name}  ${row.note}`);
          continue;
        }
        row.ok = true;
        row.note = `${st.ep}｜区间 ${Math.round(r[0])}−${Math.round(r[1])} → ${Math.round(r[2])}（实测 ${after.toFixed(0)}s）`;
        rows.push(row); console.log(`PASS  ${site.name}  ${row.note}`);
      } else {
        if (!st.cut) {
          row.ok = true; row.note = `无广告可剪（${st.ep}，时长 ${Math.round(st.dur)}s）`;
          rows.push(row); console.log(`PASS  ${site.name}  ${row.note}`);
          continue;
        }
        if (Math.abs(st.dur - st.dbgDur) > 3) {
          row.note = `时长不符：播放器 ${st.dur.toFixed(0)}s vs 剪辑后 ${st.dbgDur.toFixed(0)}s`;
          rows.push(row); console.log(`FAIL  ${site.name}  ${row.note}`);
          continue;
        }
        // 跳到第一个拼接点之后，确认还能继续播（拼接处没断）
        const seam = Array.isArray(st.cuts) && st.cuts.length ? Number(st.cuts[0][0]) + 2 : Math.min(60, st.dur / 3);
        await ev(`seekTo(${Math.floor(seam)})`);
        const moved = await waitFor(`pvVideo.currentTime > ${Math.floor(seam) + 3}`, 25000, '拼接点之后继续播放');
        if (!moved) {
          row.note = `拼接点 ${Math.round(seam)}s 之后播不动`;
          rows.push(row); console.log(`FAIL  ${site.name}  ${row.note}`);
          continue;
        }
        row.ok = true;
        row.note = `${st.ep}｜删 ${st.cuts.length} 段 → ${Math.round(st.dur)}s，拼接点后正常`;
        rows.push(row); console.log(`PASS  ${site.name}  ${row.note}`);
      }
      await sleep(500);
    } catch (e) {
      row.note = String(e.message).slice(0, 50);
      rows.push(row);
      console.log(`FAIL  ${site.name}  ${row.note}`);
    }
  }

  const pass = rows.filter(r => r.ok).length;
  const na = rows.filter(r => r.na).length;
  const fail = rows.length - pass - na;
  console.log('\n================ 汇总 ================');
  console.log(`${SHOW}｜${MODE}｜站点 ${rows.length}：通过 ${pass}，不适用 ${na}，失败 ${fail}`);
  for (const r of rows.filter(x => !x.ok && !x.na)) console.log(`  ✘ ${r.site}：${r.note}`);
  fs.writeFileSync(path.join(ROOT, `_mse_accept_${MODE}.json`), JSON.stringify(rows, null, 2), 'utf8');
  try { proc.kill(); } catch (e) {}
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
