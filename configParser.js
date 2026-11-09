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
      try {
        const b64Decoded = Buffer.from(jsonStr, 'base64').toString('utf-8');
        const obj = JSON.parse(b64Decoded);
        return this.formatConfig(obj, baseUrl);
      } catch (e2) {
        throw new Error('无法解析配置源，格式可能加密或不兼容: ' + e.message);
      }
    }
  }

  static formatConfig(obj, baseUrl) {
    const sites = (obj.sites || []).map(site => {
      if (!site || typeof site !== 'object') site = {};
      const apiStr = typeof site.api === 'string' ? site.api : '';
      const isDexSpider = site.type === 3 && (apiStr.startsWith('csp_') || !apiStr.endsWith('.js'));
      return {
        key: site.key || site.name,
        name: site.name || site.key,
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
