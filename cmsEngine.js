const axios = require('axios');

class CmsEngine {
  static async request(url, params = {}) {
    try {
      const resp = await axios.get(url, {
        params,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'application/json, text/plain, */*'
        },
        timeout: 10000
      });
      return resp.data;
    } catch (e) {
      console.error(`CMS request failed: ${url}`, e.message);
      return null;
    }
  }

  // 1. 获取首页及分类
  static async getHome(site) {
    const url = site.api;
    
    // 同时请求分类和首页视频列表
    const [listData, videoData] = await Promise.all([
      this.request(url, { ac: 'list' }),
      this.request(url, { ac: 'videolist' })
    ]);

    const rawClasses = (listData && listData.class) || (videoData && videoData.class) || [];

    // 站点接口返回的分类 name -> type_id 映射
    const classMap = new Map();
    rawClasses.forEach(c => classMap.set(String(c.type_name).trim(), String(c.type_id)));

    // 严格按配置文件里的 categories 白名单顺序输出（FongMi 同款行为）
    let classes = [];
    const seen = new Set();
    if (Array.isArray(site.categories) && site.categories.length > 0) {
      for (const name of site.categories) {
        const key = String(name).trim();
        const id = classMap.get(key);
        if (id !== undefined && !seen.has(id)) {
          seen.add(id);
          classes.push({ type_id: id, type_name: key });
        }
      }
    }

    // 未配置白名单，或一个都没匹配上时，退回接口原始分类顺序
    if (classes.length === 0) {
      rawClasses.forEach(c => {
        const id = String(c.type_id);
        if (!seen.has(id)) {
          seen.add(id);
          classes.push({ type_id: id, type_name: c.type_name });
        }
      });
    }

    const rawVideos = (videoData && videoData.list) || (listData && listData.list) || [];
    const list = rawVideos.map(this.formatVideoItem);
    const meta = videoData || listData || {};

    return {
      classes,
      list,
      page: 1,
      pagecount: Number(meta.pagecount || 1),
      total: Number(meta.total || list.length)
    };
  }

  // 2. 获取分类视频列表
  static async getCategory(site, typeId, page = 1) {
    const url = site.api;
    // 优先尝试 videolist 获取完整海报与字段
    let data = await this.request(url, { ac: 'videolist', t: typeId, pg: page });
    if (!data || !data.list || data.list.length === 0) {
      data = await this.request(url, { ac: 'list', t: typeId, pg: page });
    }
    
    if (!data || !data.list) return { page: Number(page), pagecount: 1, total: 0, list: [] };

    return {
      page: Number(data.page || page),
      pagecount: Number(data.pagecount || 1),
      total: Number(data.total || data.list.length),
      list: data.list.map(this.formatVideoItem)
    };
  }

  // 3. 搜索
  static async search(site, keyword, page = 1) {
    const url = site.api;
    let data = await this.request(url, { ac: 'videolist', wd: keyword, pg: page });
    if (!data || !data.list || data.list.length === 0) {
      data = await this.request(url, { ac: 'list', wd: keyword, pg: page });
    }
    if (!data || !data.list) return { list: [] };
    return {
      list: data.list.map(this.formatVideoItem)
    };
  }

  // 4. 获取详情及选集播放列表
  static async getDetail(site, id) {
    const url = site.api;
    const data = await this.request(url, { ac: 'videolist', ids: id }) || await this.request(url, { ac: 'detail', ids: id });
    if (!data || !data.list || data.list.length === 0) return null;

    const raw = data.list[0];
    const item = this.formatVideoItem(raw);

    const playFlags = (raw.vod_play_from || '默认').split('$$$');
    const playUrls = (raw.vod_play_url || '').split('$$$');

    const episodesGroup = [];
    playFlags.forEach((flag, index) => {
      const urlStr = playUrls[index] || '';
      const episodes = urlStr.split('#').filter(Boolean).map(part => {
        const [title, link] = part.split('$');
        return {
          title: link ? title : `第 ${part} 集`,
          url: link || title
        };
      });

      if (episodes.length > 0) {
        episodesGroup.push({
          sourceName: flag,
          episodes: episodes
        });
      }
    });

    item.content = raw.vod_content ? raw.vod_content.replace(/<[^>]+>/g, '') : '';
    item.director = raw.vod_director || '';
    item.actor = raw.vod_actor || '';
    item.year = raw.vod_year || '';
    item.area = raw.vod_area || '';
    item.playSources = episodesGroup;

    return item;
  }

  static formatVideoItem(v) {
    return {
      vod_id: String(v.vod_id),
      vod_name: v.vod_name || '未知影片',
      vod_pic: v.vod_pic || '',
      vod_remarks: v.vod_remarks || '',
      type_name: v.type_name || ''
    };
  }
}

module.exports = CmsEngine;
