const axios = require('axios');

class ConfigParser {
  static async load(url) {
    let rawText = '';
    if (url.startsWith('http://') || url.startsWith('https://')) {
      const resp = await axios.get(url, {
        headers: {
          'User-Agent': 'okhttp/4.12.0 FongMi/5.8.7'
        },
        timeout: 10000,
        responseType: 'text'
      });
      rawText = resp.data;
    } else {
      const fs = require('fs');
      rawText = fs.readFileSync(url, 'utf-8');
    }

    if (typeof rawText !== 'string') {
      rawText = JSON.stringify(rawText);
    }

    rawText = rawText.trim();
    return this.parseText(rawText, url);
  }

  static parseText(data, baseUrl = '') {
    if (data.charCodeAt(0) === 0xFEFF) {
      data = data.slice(1);
    }

    let jsonStr = data;

    // 处理带 ** 的 base64 加密
    if (data.includes('**')) {
      const parts = data.split('**');
      const b64 = parts[parts.length - 1].trim();
      try {
        const decoded = Buffer.from(b64, 'base64').toString('utf-8');
        if (decoded.startsWith('{') || decoded.startsWith('[')) {
          jsonStr = decoded;
        }
      } catch (e) {}
    }

    try {
      const obj = JSON.parse(jsonStr);
      return this.formatConfig(obj, baseUrl);
    } catch (e) {
      // 很多 TVBox 配置带 // 与 /* */ 注释，JSON.parse 会直接失败；去掉注释后再试一次
      try {
        const obj = JSON.parse(this.stripJsonComments(jsonStr));
        return this.formatConfig(obj, baseUrl);
      } catch (e1) {}
      try {
        const b64Decoded = Buffer.from(jsonStr, 'base64').toString('utf-8');
        const obj = JSON.parse(this.stripJsonComments(b64Decoded));
        return this.formatConfig(obj, baseUrl);
      } catch (e2) {
        throw new Error('无法解析配置源，格式可能加密或不兼容: ' + e.message);
      }
    }
  }

  /**
   * 去掉 JSON 里的 // 与 /* *\/ 注释（字符串内的 // 与 /* 不动，避免把 https:// 当注释）。
   * 只处理注释，不改动换行位置以外的东西。
   */
  static stripJsonComments(text) {
    if (typeof text !== 'string' || (!text.includes('//') && !text.includes('/*'))) return text;
    let out = '';
    let inStr = false;
    let quote = '';
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      const next = text[i + 1];
      if (inStr) {
        out += ch;
        if (ch === '\\') { out += next || ''; i++; continue; }
        if (ch === quote) { inStr = false; quote = ''; }
        continue;
      }
      if (ch === '"' || ch === "'") { inStr = true; quote = ch; out += ch; continue; }
      if (ch === '/' && next === '/') {
        while (i < text.length && text[i] !== '\n') i++;
        out += '\n';
        continue;
      }
      if (ch === '/' && next === '*') {
        i += 2;
        while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
        i++;
        continue;
      }
      out += ch;
    }
    return out;
  }

  static formatConfig(obj, baseUrl) {
    const seenKeys = new Set();
    const sites = (obj.sites || []).map((site, idx) => {
      if (!site || typeof site !== 'object') site = {};
      const rawName = String(site.name || site.key || `站点 ${idx + 1}`).trim();
      let rawKey = String(site.key || site.name || `site_${idx + 1}`).trim();
      if (!rawKey) rawKey = `site_${idx + 1}`;
      if (seenKeys.has(rawKey)) {
        // 不能直接拼一次 `_序号`：可能和后面本来就叫这个名字的 key 撞上，循环到不冲突为止
        let n = idx + 1;
        while (seenKeys.has(`${rawKey}_${n}`)) n++;
        rawKey = `${rawKey}_${n}`;
      }
      seenKeys.add(rawKey);

      const apiStr = typeof site.api === 'string' ? site.api : '';
      const isDexSpider = site.type === 3 && (apiStr.startsWith('csp_') || !apiStr.endsWith('.js'));
      return {
        key: rawKey,
        name: rawName,
        type: typeof site.type === 'number' ? site.type : 0, // 0: xml/json cms, 1: json cms, 3: spider
        api: apiStr,
        ext: site.ext || '',
        isDexSpider: isDexSpider,
        supportStatus: isDexSpider ? 'dex_arm_locked' : 'supported',
        searchable: site.searchable !== undefined ? site.searchable : 1,
        changeable: site.changeable !== undefined ? site.changeable : 1,
        categories: Array.isArray(site.categories) ? site.categories : []
      };
    });

    return {
      spider: obj.spider || '',
      wallpaper: obj.wallpaper || '',
      logo: obj.logo || '',
      sites: sites,
      parses: obj.parses || [],
      rules: obj.rules || []
    };
  }
}

module.exports = ConfigParser;
