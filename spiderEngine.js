/**
 * 虫包（TVBox dex spider，type:3）站点的协议适配层。
 *
 * 桥（jvm/companion-service.jar）的 RPC 返回的是 TVBox/CatVod 原始 JSON 文本：
 *   searchContent   { list: [{ vod_id, vod_name, vod_pic, vod_remarks }] }
 *   detailContent   { list: [{ ..., vod_play_from: "a$$$b", vod_play_url: "第1集$id1#第2集$id2$$$..." }] }
 *   playerContent   { parse: 0|1, url: "...", header: "..." }
 *
 * 这里的职责只有一件：把它翻译成 KimBoxPC 现有的数据结构（和 cmsEngine 输出保持一致），
 * 让 server.js / 前端不需要知道后面是 JVM。
 *
 * 注意：虫包剧集里的 vod_play_url 存的是 **播放 id**，不是媒体地址；真正地址要再调
 * playerContent(flag, id)。所以详情里给每个线路带上 flag，前端起播时据此请求 /api/spider/play。
 */
const bridge = require('./jvmBridge');

/** 把 RPC 的失败按阶段翻译成人话 */
function stageText(stage) {
  switch (stage) {
    case 'download':
    case 'resolve':
    case 'md5': return '站源资源加载失败（jar 下载/校验失败）';
    case 'decrypt':
    case 'dex2jar':
    case 'init':
    case 'instantiate':
    case 'class': return '站点插件加载失败（解壳/转换异常）';
    case 'timeout': return '站源请求超时';
    case 'empty':
    case 'upstream': return '站源未返回内容';
    default: return '站源调用失败';
  }
}

function wrapError(e) {
  const err = new Error(stageText(e && e.stage) + (e && e.stage ? `（${e.stage}）` : ''));
  err.stage = e && e.stage;
  err.detail = e && e.message;
  err.httpStatus = e && e.status;
  return err;
}

/** 解析 catvod 的 JSON 文本（部分实现返回对象，部分返回字符串） */
function parseJson(data) {
  if (!data) return null;
  if (typeof data === 'object') return data;
  try { return JSON.parse(String(data)); } catch (e) { return null; }
}

// 有些站源把 total 写成 2147483647（INT32_MAX 哨兵）或负数，直接透传会让界面显示「共 2147483647 部」
function sanitizeTotal(v, listLen) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0 || n >= 1e7) return 0;   // 0 = 未知，前端不显示总数
  return n;
}

function cleanTitle(s) {
  return String(s || '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, '')
    .trim();
}

function toVideoItem(v) {
  if (!v || typeof v !== 'object') return { vod_id: '', vod_name: '未知影片', vod_pic: '', vod_remarks: '', type_name: '' };
  return {
    vod_id: String(v.vod_id !== undefined ? v.vod_id : ''),
    vod_name: cleanTitle(v.vod_name) || '未知影片',
    vod_pic: v.vod_pic || '',
    vod_remarks: cleanTitle(v.vod_remarks) || '',
    type_name: cleanTitle(v.type_name) || ''
  };
}

function basePayload(site, jar) {
  return { siteKey: site.key, api: site.api, ext: site.ext || '', jar: jar || '' };
}

/** 需要重试的阶段：站源自身偶发失败（超时/上游 5xx/临时拒绝），换个时机大概率能成；
 *  下载/解壳/转换失败重试也没用，直接抛给用户。 */
const RETRY_STAGES = ['', 'call', 'upstream', 'timeout', 'empty'];

async function callWithRetry(site, jar, opts, attempts = 2) {
  let last;
  for (let i = 0; i < attempts; i++) {
    try {
      return await bridge.callSpider(Object.assign(basePayload(site, jar), opts));
    } catch (e) {
      last = e;
      if (!RETRY_STAGES.includes(e && e.stage)) throw e;
      if (i + 1 < attempts) await new Promise(r => setTimeout(r, 700 + i * 500));
    }
  }
  throw last;
}

/** 加载站点（幂等；桥内按 siteKey 缓存） */
async function ensureLoaded(site, jar) {
  return bridge.loadSite(Object.assign(basePayload(site, jar), { timeoutMs: 180000 }));
}

async function search(site, wd, page = 1, jar) {
  await ensureLoaded(site, jar);
  try {
    const data = parseJson(await callWithRetry(site, jar, {
      method: 'searchContent',
      params: { wd: String(wd), quick: 'false', pg: String(page) },
      timeoutMs: 60000
    }));
    const list = (data && Array.isArray(data.list)) ? data.list : [];
    return { list: list.map(toVideoItem) };
  } catch (e) { throw wrapError(e); }
}

async function getDetail(site, id, jar) {
  await ensureLoaded(site, jar);
  let data;
  try {
    data = parseJson(await callWithRetry(site, jar, {
      method: 'detailContent',
      params: { id: String(id) },
      timeoutMs: 60000
    }));
  } catch (e) { throw wrapError(e); }
  const raw = data && Array.isArray(data.list) ? data.list[0] : null;
  if (!raw) return null;

  const item = toVideoItem(raw);
  const flags = String(raw.vod_play_from || '默认').split('$$$');
  const urls = String(raw.vod_play_url || '').split('$$$');
  const playSources = [];
  const maxLen = Math.max(flags.length, urls.length);
  for (let i = 0; i < maxLen; i++) {
    const flag = cleanTitle(flags[i]) || `线路 ${i + 1}`;
    const parts = String(urls[i] || '').split('#').filter(Boolean);
    const episodes = parts.map((part, epIdx) => {
      const s = part.trim();
      const d = s.indexOf('$');
      const title = d >= 0 ? s.slice(0, d).trim() : `第 ${epIdx + 1} 集`;
      const link = d >= 0 ? s.slice(d + 1).trim() : s;
      return { title: title || `第 ${epIdx + 1} 集`, url: link || s };
    }).filter(e => e.url);
    if (episodes.length) playSources.push({ sourceName: flag, flag, episodes });
  }

  item.content = raw.vod_content ? String(raw.vod_content).replace(/<[^>]+>/g, '') : '';
  item.director = raw.vod_director || '';
  item.actor = raw.vod_actor || '';
  item.year = raw.vod_year || '';
  item.area = raw.vod_area || '';
  item.playSources = playSources;
  item.spider = true;
  return item;
}

/** playerContent：返回 { parse, url, header }；parse=1 表示需要外部解析 */
async function play(site, flag, id, jar) {
  await ensureLoaded(site, jar);
  let data;
  try {
    data = parseJson(await callWithRetry(site, jar, {
      method: 'playerContent',
      params: { flag: String(flag || ''), id: String(id || '') },
      timeoutMs: 60000
    }));
  } catch (e) { throw wrapError(e); }
  if (!data || !data.url) return null;
  return {
    parse: Number(data.parse) === 1 ? 1 : 0,
    url: String(data.url),
    header: data.header ? String(data.header) : ''
  };
}

async function home(site, jar) {
  await ensureLoaded(site, jar);
  try {
    const data = parseJson(await callWithRetry(site, jar, {
      method: 'homeContent', params: {}, timeoutMs: 60000
    }));
    // String(undefined) 会得到 "undefined"，后面 !c.type_id 拦不住它 → 前端会多出一个点进去没内容的分类
    const rawClasses = (data && Array.isArray(data.class) ? data.class : [])
      .map(c => ({
        type_id: c && c.type_id !== undefined && c.type_id !== null ? String(c.type_id).trim() : '',
        type_name: cleanTitle(c && c.type_name)
      }))
      .filter(c => c.type_id && c.type_id !== 'undefined' && c.type_id !== 'null' && c.type_name);
    // 与 CmsEngine 一致：配置里写了 categories 白名单就按白名单顺序输出
    let classes = [];
    const seen = new Set();
    if (Array.isArray(site.categories) && site.categories.length > 0) {
      const byName = new Map(rawClasses.map(c => [c.type_name, c.type_id]));
      for (const name of site.categories) {
        const key = cleanTitle(name);
        const id = byName.get(key);
        if (id !== undefined && !seen.has(id)) { seen.add(id); classes.push({ type_id: id, type_name: key }); }
      }
    }
    if (classes.length === 0) {
      for (const c of rawClasses) {
        if (!c.type_id || seen.has(c.type_id)) continue;
        seen.add(c.type_id);
        classes.push(c);
      }
    }
    const list = (data && Array.isArray(data.list) ? data.list : []).map(toVideoItem);
    return {
      classes,
      list,
      filters: (data && data.filters) || {},
      page: 1,
      pagecount: Number(data && data.pagecount) || 1,
      total: sanitizeTotal(data && data.total, list.length)
    };
  } catch (e) { throw wrapError(e); }
}

async function category(site, tid, page = 1, extend, jar) {
  await ensureLoaded(site, jar);
  try {
    const data = parseJson(await callWithRetry(site, jar, {
      method: 'categoryContent',
      params: { tid: String(tid), pg: String(page), filter: 'true', extend: extend ? (typeof extend === 'string' ? extend : JSON.stringify(extend)) : '' },
      timeoutMs: 60000
    }));
    const list = (data && Array.isArray(data.list)) ? data.list : [];
    return {
      list: list.map(toVideoItem),
      page: Number(data && data.page) || Number(page) || 1,
      pagecount: Number(data && data.pagecount) || 1,
      total: sanitizeTotal(data && data.total, list.length)
    };
  } catch (e) { throw wrapError(e); }
}

/** 归一化片名（与 server.js 的 normName 等价） */
function normTitle(s) {
  return String(s || '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, '')
    .replace(/[\s·・,，.。:：!！?？'"“”()（）\[\]【】\-_]/g, '')
    .toLowerCase();
}

/**
 * 按片名回退：部分站源（实测 AppV7 系）的 searchContent 返回的 vod_id 与
 * detailContent 能解开的 id 不是同一套命名空间 —— 搜索能出结果，但点进去
 * 「video_detail decrypt empty」。这类站点用分类列表里的 id 就能正常取详情，
 * 所以搜索无果时按片名在本站分类里找一遍，找到就用它的 id 重新取详情。
 */
async function resolveByTitle(site, title, jar) {
  const want = normTitle(title);
  if (!want) return null;
  let classes = [];
  try { classes = (await home(site, jar)).classes || []; } catch (e) { return null; }
  for (const c of classes.slice(0, 6)) {
    let page1;
    try { page1 = await category(site, c.type_id, 1, '', jar); } catch (e) { continue; }
    const hit = (page1.list || []).find(v => normTitle(v.vod_name) === want);
    if (hit) {
      try {
        const d = await getDetail(site, hit.vod_id, jar);
        if (d) return d;
      } catch (e) {}
    }
  }
  return null;
}

module.exports = { search, getDetail, play, home, category, resolveByTitle, ensureLoaded, stageText };
