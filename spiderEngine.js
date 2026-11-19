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

/** 加载站点（幂等；桥内按 siteKey 缓存） */
async function ensureLoaded(site, jar) {
  return bridge.loadSite(Object.assign(basePayload(site, jar), { timeoutMs: 180000 }));
}

async function search(site, wd, page = 1, jar) {
  await ensureLoaded(site, jar);
  try {
    const data = parseJson(await bridge.callSpider(Object.assign(basePayload(site, jar), {
      method: 'searchContent',
      params: { wd: String(wd), quick: 'false', pg: String(page) },
      timeoutMs: 60000
    })));
    const list = (data && Array.isArray(data.list)) ? data.list : [];
    return { list: list.map(toVideoItem) };
  } catch (e) { throw wrapError(e); }
}

async function getDetail(site, id, jar) {
  await ensureLoaded(site, jar);
  let data;
  try {
    data = parseJson(await bridge.callSpider(Object.assign(basePayload(site, jar), {
      method: 'detailContent',
      params: { id: String(id) },
      timeoutMs: 60000
    })));
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
    data = parseJson(await bridge.callSpider(Object.assign(basePayload(site, jar), {
      method: 'playerContent',
      params: { flag: String(flag || ''), id: String(id || '') },
      timeoutMs: 60000
    })));
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
    const data = parseJson(await bridge.callSpider(Object.assign(basePayload(site, jar), {
      method: 'homeContent', params: {}, timeoutMs: 60000
    })));
    return {
      classes: (data && Array.isArray(data.class) ? data.class : []).map(c => ({ type_id: String(c.type_id), type_name: cleanTitle(c.type_name) })),
      list: (data && Array.isArray(data.list) ? data.list : []).map(toVideoItem),
      filters: (data && data.filters) || {}
    };
  } catch (e) { throw wrapError(e); }
}

async function category(site, tid, page = 1, extend, jar) {
  await ensureLoaded(site, jar);
  try {
    const data = parseJson(await bridge.callSpider(Object.assign(basePayload(site, jar), {
      method: 'categoryContent',
      params: { tid: String(tid), pg: String(page), filter: 'true', extend: extend ? JSON.stringify(extend) : '' },
      timeoutMs: 60000
    })));
    const list = (data && Array.isArray(data.list)) ? data.list : [];
    return {
      list: list.map(toVideoItem),
      page: Number(data && data.page) || page,
      pagecount: Number(data && data.pagecount) || 1,
      total: Number(data && data.total) || list.length
    };
  } catch (e) { throw wrapError(e); }
}

module.exports = { search, getDetail, play, home, category, ensureLoaded, stageText };
