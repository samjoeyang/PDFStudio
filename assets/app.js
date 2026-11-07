// 官网下载区逻辑：
// 1) 优先读取仓库内 docs/latest.json（由 publish-site 工作流在发布时生成）
// 2) 若失败，回退到 GitHub Releases API 动态获取最新版本
// 3) 按访客操作系统/芯片高亮推荐下载项
(function () {
  'use strict';

  var REPO = 'samjoeyang/PDFStudio';

  function fmtSize(bytes) {
    if (!bytes) return '';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + ' KB';
    return (bytes / 1024 / 1024).toFixed(1) + ' MB';
  }

  function setText(id, text) {
    var el = document.getElementById(id);
    if (el) el.textContent = text;
  }

  // 平台中文标签（用于“已根据你的系统”提示）
  var PLAT_LABEL = {
    'macos-apple': 'Apple 芯片 macOS',
    'macos-intel': 'Intel 芯片 macOS',
    'windows-x64': 'Windows 64 位',
    'windows-x86': 'Windows 32 位',
    'linux': 'Linux 64 位'
  };

  // 同步基础识别（基于 UA / platform）
  function detectPlatform() {
    var ua = navigator.userAgent || '';
    var uaPlatform = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || '';
    if (/Mac|iPhone|iPad/.test(uaPlatform) || (/Macintosh/.test(ua) && !/Windows/.test(ua))) {
      return 'macos-apple'; // 默认推荐 Apple 芯片；Intel Mac 用户可手动选择
    }
    if (/Win/.test(uaPlatform) || /Win/.test(ua)) {
      var is64 = /x64|Win64|WOW64/.test(ua);
      return is64 ? 'windows-x64' : 'windows-x86';
    }
    if (/Linux/.test(uaPlatform) || /Linux/.test(ua)) return 'linux';
    return null;
  }

  // 标记推荐卡片 + 设置系统提示文案
  function applyRecommendation(plat) {
    document.querySelectorAll('.dl-card').forEach(function (card) {
      card.classList.toggle('is-recommended', card.getAttribute('data-plat') === plat);
    });
    var hint = document.getElementById('dl-hint');
    if (hint) {
      hint.textContent = plat ? '已根据你的系统（' + (PLAT_LABEL[plat] || '') + '）为你推荐 ↓' : '';
    }
  }

  // 用 Client Hints 异步精修芯片/位数（支持的浏览器更准确）
  function refinePlatform(plat) {
    var uad = navigator.userAgentData;
    if (!uad || !uad.getHighEntropyValues) return;
    try {
      uad.getHighEntropyValues(['architecture', 'bitness']).then(function (v) {
        var next = plat;
        if (plat === 'macos-apple' && v.architecture === 'x86') next = 'macos-intel';
        if (plat === 'windows-x64' && v.bitness === '32') next = 'windows-x86';
        if (plat === 'windows-x86' && v.bitness === '64') next = 'windows-x64';
        if (next !== plat) applyRecommendation(next);
      }).catch(function () {});
    } catch (e) { /* 不支持则保持基础识别结果 */ }
  }

  function render(data) {
    if (!data || !data.version) {
      showFallback();
      return;
    }
    setText('dl-version', 'v' + data.version);
    if (data.publishedAt) {
      var d = new Date(data.publishedAt);
      if (!isNaN(d)) setText('dl-date', ' · ' + d.toISOString().slice(0, 10));
    }

    var assets = data.assets || {};
    var recommended = detectPlatform();
    var hasAny = false;

    document.querySelectorAll('.dl-card').forEach(function (card) {
      var plat = card.getAttribute('data-plat');
      var info = assets[plat];
      var primary = card.querySelector('[data-role="primary"]');
      var alt = card.querySelector('[data-role="alt"]');
      if (info && info.url) {
        hasAny = true;
        primary.setAttribute('href', info.url);
        primary.classList.remove('is-disabled');
        primary.textContent = '下载 ' + (primary.textContent.match(/\.\w+$/) || ['.dmg'])[0];
        if (info.size) {
          var meta = card.querySelector('.dl-meta');
          if (meta && !/·/.test(meta.textContent)) meta.textContent += ' · ' + fmtSize(info.size);
        }
        if (info.altUrl && info.altLabel) {
          alt.setAttribute('href', info.altUrl);
          alt.textContent = info.altLabel;
        } else {
          alt.removeAttribute('href');
          alt.textContent = '';
        }
      } else {
        primary.setAttribute('href', '#');
        primary.classList.add('is-disabled');
        alt.removeAttribute('href');
        alt.textContent = '';
      }
    });

    applyRecommendation(recommended);
    refinePlatform(recommended);

    if (!hasAny) showFallback();
  }

  function showFallback() {
    setText('dl-version', '暂无发布');
    var fb = document.getElementById('dl-fallback');
    if (fb) fb.hidden = false;
  }

  // 回退：latest.json 不可用时，仅从 GitHub API 获取版本号并引导到 Releases 页。
  // （逐平台下载链接以 latest.json 为准，因其文件名含平台标识，API 原生命名无法直接对应。）
  function fallbackFromApi() {
    fetch('https://api.github.com/repos/' + REPO + '/releases/latest')
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (rel) {
        if (rel && rel.tag_name) {
          setText('dl-version', 'v' + rel.tag_name.replace(/^v/, ''));
          if (rel.published_at) {
            var d = new Date(rel.published_at);
            if (!isNaN(d)) setText('dl-date', ' · ' + d.toISOString().slice(0, 10));
          }
        }
        showFallback();
      })
      .catch(showFallback);
  }

  function init() {
    var yr = document.getElementById('year');
    if (yr) yr.textContent = new Date().getFullYear();
    fetch('latest.json', { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        if (data && data.version && Object.keys(data.assets || {}).length) render(data);
        else fallbackFromApi();
      })
      .catch(fallbackFromApi);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
