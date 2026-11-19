/**
 * 虫包（JVM 站源）验收：逐个 type:3 站点走一遍 load → search → detail → playerContent
 *
 * 用法：node tools\accept-spider.js [关键词] [站点过滤]
 *   node tools\accept-spider.js 尚公主
 *
 * 判定：
 *   PASS  搜索有结果且拿到播放地址
 *   WARN  能加载，但搜索无结果 / 播放地址为空（多为源本身问题）
 *   FAIL  加载失败（jar/解壳/转换/类加载）
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const bridge = require(path.join(ROOT, 'jvmBridge.js'));
const spider = require(path.join(ROOT, 'spiderEngine.js'));

const KEYWORD = process.argv[2] || '尚公主';
const FILTER = process.argv[3] || '';

function latestConfig() {
  const dir = path.join(ROOT, 'data', 'cache');
  const f = fs.readdirSync(dir).filter(x => /^config_\d+\.json$/.test(x)).sort().pop();
  return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
}

(async () => {
  if (!bridge.installed()) {
    console.error('[错误] JVM 运行时缺失，先运行 tools\\fetch-jvm.ps1');
    process.exit(1);
  }
  const cfg = latestConfig();
  if (!cfg.spider) {
    console.error('[错误] 当前配置没有 spider（.jar）字段，无法测试虫包');
    process.exit(1);
  }
  const sites = (cfg.sites || []).filter(s => s.type === 3 && (!FILTER || String(s.name).includes(FILTER)));
  console.log(`【虫包验收】关键词「${KEYWORD}」　站点 ${sites.length} 个　${new Date().toLocaleTimeString()}\n`);

  const t0 = Date.now();
  await bridge.ensureStarted();
  console.log(`JVM 启动 ${Date.now() - t0}ms　端口 ${bridge.status().port}\n`);

  const rows = [];
  for (const site of sites) {
    const row = { site: site.name, key: site.key, ok: false, warn: false, note: '' };
    const tLoad = Date.now();
    try {
      const loaded = await bridge.loadSite({ siteKey: site.key, api: site.api, ext: site.ext || '', jar: cfg.spider, timeoutMs: 180000 });
      row.loadMs = Date.now() - tLoad;
      if (!loaded) throw new Error('load 返回 false');
    } catch (e) {
      row.note = `加载失败：${e.message}${e.stage ? '（' + e.stage + '）' : ''}`;
      rows.push(row);
      console.log(`FAIL  ${site.name}  ${row.note}`);
      continue;
    }

    const tSearch = Date.now();
    let list = [];
    try {
      const r = await spider.search(site, KEYWORD, 1, cfg.spider);
      list = r.list || [];
      row.searchMs = Date.now() - tSearch;
    } catch (e) {
      row.note = `搜索失败：${e.message}`;
      rows.push(row);
      console.log(`WARN  ${site.name}  ${row.note}`);
      continue;
    }
    if (!list.length) {
      row.warn = true; row.note = '搜索无结果（源内容或关键词不匹配）';
      rows.push(row); console.log(`WARN  ${site.name}  ${row.note}`);
      continue;
    }

    try {
      const d = await spider.getDetail(site, list[0].vod_id, cfg.spider);
      if (!d || !d.playSources.length) {
        row.warn = true; row.note = '详情无线路';
        rows.push(row); console.log(`WARN  ${site.name}  ${row.note}`);
        continue;
      }
      const line = d.playSources[0];
      row.lines = d.playSources.length;
      row.episodes = line.episodes.length;
      const tPlay = Date.now();
      const p = await spider.play(site, line.flag, line.episodes[0].url, cfg.spider);
      row.playMs = Date.now() - tPlay;
      if (!p || !p.url) {
        row.warn = true; row.note = '播放地址为空';
        rows.push(row); console.log(`WARN  ${site.name}  ${row.note}`);
        continue;
      }
      row.ok = true;
      const kind = /\.m3u8/i.test(p.url) ? 'm3u8' : (/\.mp4/i.test(p.url) ? 'mp4' : '其他');
      row.note = `${list[0].vod_name}｜${d.playSources.length} 线路/${line.episodes.length} 集｜${kind}｜parse=${p.parse}｜${p.header ? '带 header' : '无 header'}`;
      rows.push(row);
      console.log(`PASS  ${site.name}  ${row.note}  （加载 ${row.loadMs}ms / 搜索 ${row.searchMs}ms / 起播 ${row.playMs}ms）`);
    } catch (e) {
      row.warn = true; row.note = `详情/起播失败：${e.message}`;
      rows.push(row); console.log(`WARN  ${site.name}  ${row.note}`);
    }
  }

  const pass = rows.filter(r => r.ok).length;
  const warn = rows.filter(r => r.warn).length;
  const fail = rows.length - pass - warn;
  console.log('\n================ 汇总 ================');
  console.log(`站点 ${rows.length}：通过 ${pass}，警告 ${warn}，失败 ${fail}`);
  for (const r of rows.filter(x => !x.ok)) console.log(`  · ${r.site}：${r.note}`);
  fs.writeFileSync(path.join(ROOT, '_spider_accept.json'), JSON.stringify(rows, null, 2), 'utf8');
  bridge.stop();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FATAL', e.message); try { bridge.stop(); } catch (_) {} process.exit(1); });
