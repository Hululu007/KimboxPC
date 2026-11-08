/**
 * 全站广告插入方式体检
 * 对当前配置源里的每个站点取 1~2 部片，探测其播放列表，分类：
 *   clean     : 没有 discontinuity，干净流
 *   insert    : 少量「孤立的短块」，典型插播广告（可被过滤）
 *   chopped   : 整集被切成大量短块（不能过滤，属正常切片）
 *   multi     : 多音轨 / master 列表
 *   nom3u8    : 首集不是 m3u8（需网页解析或非 HLS）
 *   error     : 探测失败
 *
 * 用法：electron.exe tools\adsurvey.js
 * 输出：控制台表格 + 广告检测报告.md
 */
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const API = 'http://127.0.0.1:3980';
const OUT = path.join(__dirname, '..', '广告检测报告.md');
const CONCURRENCY = 2;

async function api(p, params = {}) {
  const r = await axios.get(`${API}${p}`, { params, timeout: 60000 });
  return r.data;
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function classify(p, errMsg) {
  if (!p || (p.error && p.error !== undefined && p.duration === undefined)) {
    const m = String(errMsg || (p && p.error) || '');
    if (/40[34]|ENOTFOUND|ECONNREFUSED|timeout|aborted/i.test(m)) return 'blocked';
    return 'error';
  }
  const chunks = p.totalChunks || 0;
  const removed = p.adRemoved || 0;
  if (p.adRemoved === undefined && p.disc === 0) return 'clean';
  if (removed > 0) return 'insert';
  if (chunks >= 20 && (p.disc || 0) >= 20) return 'chopped';
  if ((p.disc || 0) === 0) return 'clean';
  return 'other';
}

async function surveySite(site) {
  const row = { site: site.name, key: site.key, type: '', note: '', sample: '' };
  try {
    // 首页取一部片（再退一步用「搜索」兜底）
    let vodId = null, siteKey = site.key;
    try {
      const home = await api('/api/site/select', {});
    } catch (e) { /* 忽略 */ }
    // 切到该站点后取首页
    await axios.post(`${API}/api/site/select`, { siteKey: site.key }, { timeout: 30000 }).catch(() => {});
    let list = [];
    try {
      const home = await api('/api/home');
      list = home.list || [];
    } catch (e) {}
    if (!list.length) {
      for (const kw of ['2024', '电视剧', '电影']) {
        try {
          const s = await api('/api/search', { wd: kw, pg: 1 });
          if (s.list && s.list.length) { list = s.list; break; }
        } catch (e) {}
      }
    }
    const pick = list.find(v => v.vod_id) || list[0];
    if (!pick) { row.type = 'nodata'; return row; }
    vodId = pick.vod_id;
    row.sample = pick.vod_name;

    const detail = await api('/api/detail', { id: vodId, siteKey });
    const sources = (detail && detail.playSources) || [];
    if (!sources.length) { row.type = 'nodata'; return row; }

    // 每条线路都看一眼：优先取直接就是 m3u8 的那条（很多站的第 1 条是网页壳）
    let url = '';
    let picked = '';
    const flat = [];
    for (const s of sources) {
      for (const ep of (s.episodes || []).slice(0, 2)) {
        if (ep && ep.url) flat.push({ line: s.sourceName, url: ep.url });
      }
    }
    const direct = flat.find(x => /\.m3u8/i.test(x.url));
    if (direct) { url = direct.url; picked = direct.line; }
    else if (flat.length) { url = flat[0].url; picked = flat[0].line; }
    if (!url) { row.type = 'nodata'; return row; }
    row.line = picked;
    let resolvedFrom = '';
    if (!/\.m3u8/i.test(url)) {
      // 网页地址：先解析出真实播放地址
      try {
        const r = await api('/api/resolve', { url });
        if (r && r.url && /\.m3u8/i.test(r.url)) { resolvedFrom = url; url = r.url; }
      } catch (e) {}
      if (!/\.m3u8/i.test(url)) { row.type = 'nom3u8'; row.note = url.slice(0, 50); return row; }
    }

    let p = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      p = await api('/api/probe', { url, filter: 1 });
      if (p && p.duration !== undefined) break;
      await sleep(2000);
    }
    if (resolvedFrom) row.resolved = true;
    row.type = classify(p, p && p.error);
    row.note = `duration=${p.duration}s chunks=${p.totalChunks} disc=${p.disc} ad=${p.adRemoved}`;
    return row;
  } catch (e) {
    row.type = 'error';
    row.note = e.message.slice(0, 60);
    return row;
  }
}

async function runPool(items, worker, limit) {
  const out = [];
  let idx = 0;
  const runners = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    while (idx < items.length) {
      const i = idx++;
      out[i] = await worker(items[i]);
    }
  });
  await Promise.all(runners);
  return out;
}

(async () => {
  const t0 = Date.now();
  const sitesResp = await api('/api/sites');
  const sites = (sitesResp.sites || []).filter(s => !s.isDexSpider);
  console.log(`待检测站点: ${sites.length} 个\n`);

  const rows = await runPool(sites, surveySite, CONCURRENCY);

  const order = { insert: 0, clean: 1, chopped: 2, other: 3, nom3u8: 4, blocked: 5, nodata: 6, error: 7 };
  rows.sort((a, b) => (order[a.type] ?? 9) - (order[b.type] ?? 9));

  const label = {
    insert: '插播广告（可过滤）',
    clean: '干净流',
    chopped: '整集切片',
    other: '其它',
    nom3u8: '非 HLS（需解析）',
    blocked: '媒体域名被拦',
    nodata: '无数据',
    error: '探测失败'
  };

  console.log('站点'.padEnd(20) + '类型'.padEnd(22) + '详情');
  console.log('-'.repeat(96));
  for (const r of rows) {
    console.log(String(r.site).padEnd(20) + String(label[r.type] || r.type).padEnd(18) + String(r.note || '').slice(0, 56));
  }

  const counts = {};
  for (const r of rows) counts[r.type] = (counts[r.type] || 0) + 1;

  const md = [];
  md.push('# 广告插入方式检测报告');
  md.push('');
  md.push(`生成时间：${new Date().toLocaleString()}　耗时 ${Math.round((Date.now() - t0) / 1000)} 秒`);
  md.push('');
  md.push('| 类型 | 站点数 | 说明 |');
  md.push('|---|---|---|');
  md.push(`| 插播广告（可过滤） | ${counts.insert || 0} | 少量孤立短块，已被播放列表过滤器剔除 |`);
  md.push(`| 干净流 | ${counts.clean || 0} | 无 discontinuity |`);
  md.push(`| 整集切片 | ${counts.chopped || 0} | 每集切几十块，属正常封装，**不能过滤** |`);
  md.push(`| 其它 | ${counts.other || 0} | 有 discontinuity 但不构成插播形态 |`);
  md.push(`| 非 HLS | ${counts.nom3u8 || 0} | 首集是网页地址，需先解析 |`);
  md.push(`| 无数据/失败 | ${(counts.nodata || 0) + (counts.error || 0)} | 站点无内容或网络失败 |`);
  md.push('');
  md.push('| 站点 | 类型 | 样本 | 详情 |');
  md.push('|---|---|---|---|');
  for (const r of rows) {
    md.push(`| ${r.site} | ${label[r.type] || r.type} | ${r.sample || '-'} | ${r.note || ''} |`);
  }
  md.push('');
  fs.writeFileSync(OUT, md.join('\n'), 'utf8');
  console.log(`\n汇总: ${JSON.stringify(counts)}`);
  console.log(`报告已写入: ${OUT}`);
})();
