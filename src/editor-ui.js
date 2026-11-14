// FILE: src/editor-ui.js
(function (global) {
  'use strict';

  var Core = global.HerosAdventureEditorCore;
  var RawCatalog = global.HerosAdventureCatalog || {};
  var Codec = global.HerosAdventureEs3Codec;

  var state = {
    session: Core ? Core.createSession(RawCatalog) : null,
    dirHandle: null,
    fileHandles: Object.create(null),
    fileHashes: Object.create(null),
    nativeSession: null,
    nativePending: Object.create(null),
    nativeLatePending: Object.create(null),
    nativeUncertain: false,
    nativeLateSettled: Object.create(null),
    dirSaveTainted: false,
    nativeSeq: 0,
    nativeTimeoutMs: 60000,
    nativeBridgeInitialized: false,
    localServerAvailable: false,
    selectedCharId: null,
    selectedPropGroup: 'core',
    activeTabId: 'tab-summary',
    busy: false
  };

  function sha1Hex(bytes) {
    var u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
    var digest = Codec.sha1(u8);
    var out = '';
    for (var i = 0; i < digest.length; i += 1) {
      var h = digest[i].toString(16);
      out += h.length === 1 ? '0' + h : h;
    }
    return out;
  }
  if (Codec && typeof Codec.sha1Hex !== 'function') Codec.sha1Hex = sha1Hex;

  function randomHex8() {
    var out = '';
    while (out.length < 8) out += Math.floor(Math.random() * 16).toString(16);
    return out.slice(0, 8);
  }

  function guardNotBusy(allowWhenUncertain) {
    if (state.busy) {
      setStatus('파일 저장/열기 작업이 진행 중입니다. 잠시 후 다시 시도하세요.', 'error');
      return false;
    }
    if (!allowWhenUncertain && state.nativeUncertain) {
      setStatus('이전 저장 결과 확인 전까지 추가 편집/저장이 잠겨 있습니다. 응답을 기다리거나 슬롯을 다시 열어 주세요.', 'error');
      return false;
    }
    return true;
  }

  function confirmDiscardUnsaved() {
    var dirty = !!(state.session && typeof state.session.hasUnsavedChanges === 'function' && state.session.hasUnsavedChanges());
    if (!dirty) return true;
    var ok = typeof global.confirm === 'function' ? !!global.confirm('저장하지 않은 변경 사항이 있습니다. 현재 변경을 버리고 새 세이브를 여시겠습니까?') : true;
    if (!ok) {
      setStatus('미저장 변경 보호로 열기를 취소했습니다.', 'ok');
      return false;
    }
    return true;
  }

  function assertUsableSession(sess) {
    var files = (sess && sess.files) || {};
    var keys = Object.keys(files);
    var usable = keys.some(function (k) {
      return files[k] && files[k].originalParseFailed !== true;
    });
    if (!usable) {
      throw new Error('유효한 세이브 파일을 읽지 못했습니다. 비밀번호나 파일을 확인하세요.');
    }
  }

  var ROLE_KO = {
    playerTeam: '파티·인벤토리·화폐',
    characters: '캐릭터·무공·인연',
    factions: '문파 우호도',
    game: '게임 진행·장원',
    global: '글로벌·공유장원',
    time: '게임 시간',
    pagoda: '통천탑',
    saveInfo: '슬롯 정보',
    other: '기타 파일'
  };

  var PRESET_DEFS = [
    { key: 'wealth_package', name: '재물 꾸러미', desc: '화폐와 기본 재화를 넉넉하게 채웁니다.' },
    { key: 'hero_core_max', name: '주인공 핵심 최대', desc: '주인공의 핵심 능력치를 최대치로 설정합니다.' },
    { key: 'hero_all_life_skills', name: '생활 기술 전부', desc: '모든 생활 기술을 습득하고 숙련도를 채웁니다.' },
    { key: 'hero_virtue_max', name: '주인공 덕망 최대', desc: '덕망과 명성을 최대치로 설정합니다.' },
    { key: 'party_kungfu_max', name: '파티 무공 최대', desc: '파티 전원의 무공 숙련도를 최대로 설정합니다.' },
    { key: 'fief_all_max', name: '장원 전부 최대', desc: '장원 시설과 자원을 모두 최대로 설정합니다.' }
  ];

  var KF_TYPE_KO = { 0: '외공·기본', 1: '내공·심법', 2: '절초·비기', 3: '보조·특수' };
  var MERIDIAN_KO = {
    dong: '독맥 (기민·속도)',
    jing: '임맥 (방어·막기)',
    gang: '양유맥 (치명타·공격)',
    rou: '음유맥 (회피·반사)',
    xu: '충맥 (반격·저항)',
    shi: '대맥 (명중·치명피해)'
  };
  var DHOUR_KO = ['자시(子時)', '축시(丑時)', '인시(寅時)', '묘시(卯時)', '진시(辰時)', '사시(巳時)', '오시(午時)', '미시(未時)', '신시(申時)', '유시(酉時)', '술시(戌時)', '해시(亥時)'];

  function $(id) { return document.getElementById(id); }

  function clearEl(node) {
    if (!node) return node;
    while (node.firstChild) node.removeChild(node.firstChild);
    return node;
  }

  function isNode(v) {
    return !!v && typeof v === 'object' && typeof v.nodeType === 'number';
  }

  function appendChildren(node, children) {
    if (children === null || children === undefined || children === false) return;
    if (Array.isArray(children)) {
      for (var i = 0; i < children.length; i += 1) appendChildren(node, children[i]);
      return;
    }
    if (isNode(children)) { node.appendChild(children); return; }
    node.appendChild(document.createTextNode(String(children)));
  }

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    attrs = attrs || {};
    var keys = Object.keys(attrs);
    for (var i = 0; i < keys.length; i += 1) {
      var k = keys[i];
      var v = attrs[k];
      if (v === null || v === undefined) continue;
      if (k === 'className' || k === 'class') { node.className = String(v); }
      else if (k === 'text' || k === 'textContent') { node.textContent = String(v); }
      else if (k === 'id') { node.id = String(v); }
      else if (k === 'type') { node.type = String(v); }
      else if (k === 'value') { node.value = String(v); }
      else if (k === 'min' || k === 'max' || k === 'step') { node.setAttribute(k, String(v)); }
      else if (k === 'placeholder') { node.placeholder = String(v); }
      else if (k === 'title') { node.title = String(v); }
      else if (k === 'disabled') { node.disabled = !!v; }
      else if (k === 'checked') { node.checked = !!v; }
      else if (k === 'readOnly') { node.readOnly = !!v; }
      else if (k === 'hidden') { node.hidden = !!v; }
      else if (k === 'tabIndex') { node.tabIndex = Number(v); }
      else if (k === 'role') { node.setAttribute('role', String(v)); }
      else if (k === 'for' || k === 'htmlFor') { node.htmlFor = String(v); }
      else if (k === 'dataset') {
        var dkeys = Object.keys(v);
        for (var d = 0; d < dkeys.length; d += 1) node.dataset[dkeys[d]] = String(v[dkeys[d]]);
      } else if (k === 'style') {
        var skeys = Object.keys(v);
        for (var s = 0; s < skeys.length; s += 1) node.style[skeys[s]] = v[skeys[s]];
      } else if (k === 'on') {
        var ekeys = Object.keys(v);
        for (var e = 0; e < ekeys.length; e += 1) {
          if (typeof v[ekeys[e]] === 'function') node.addEventListener(ekeys[e], v[ekeys[e]]);
        }
      } else if (k.indexOf('on') === 0 && typeof v === 'function') {
        node.addEventListener(k.slice(2).toLowerCase(), v);
      } else {
        node.setAttribute(k, String(v));
      }
    }
    appendChildren(node, children);
    return node;
  }

  function onEnterKey(inputEl, callback) {
    if (!inputEl) return;
    inputEl.addEventListener('keydown', function (e) {
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === 'Enter') { e.preventDefault(); callback(e); }
    });
  }

  function setStatus(msg, kind) {
    var bar = $('status-bar');
    if (!bar) return;
    bar.textContent = msg === null || msg === undefined ? '' : String(msg);
    if (kind === 'error') bar.style.color = 'var(--danger)';
    else if (kind === 'ok') bar.style.color = 'var(--ok)';
    else bar.style.color = 'var(--text-dim)';
  }

  function updateTopBadges() {
    if (!state.session || typeof state.session.getSummary !== 'function') return;
    var summary = state.session.getSummary() || {};
    var changes = summary.changeLog && summary.changeLog.length ? summary.changeLog.length : 0;
    var dirty = $('dirty-badge');
    if (dirty) dirty.textContent = '수정 ' + (summary.dirtyFileCount || 0) + '파일 · 변경 ' + changes + '건';
    var conn = $('connection-badge');
    if (conn) {
      if (state.dirHandle) conn.textContent = '폴더 연결됨';
      else if (state.nativeSession) conn.textContent = 'WebView2 세션';
      else if (state.localServerAvailable) conn.textContent = '로컬 서버';
      else conn.textContent = '오프라인 브라우저 모드';
    }
  }

  function syncAfterMutation() {
    renderSummaryTab();
    updateTopBadges();
    if (state.activeTabId && (state.activeTabId.indexOf('raw') >= 0 || state.activeTabId === 'tab-reference')) {
      renderRawViewer();
    }
  }

  function formatNum(n) { return Number(n || 0).toLocaleString('ko-KR'); }

  function formatCoinConversion(val) {
    var n = Math.max(0, Math.floor(Number(val) || 0));
    var gwan = Math.floor(n / 1000);
    var mun = n % 1000;
    return formatNum(n) + '문 = ' + formatNum(gwan) + '관 ' + formatNum(mun) + '문';
  }

  function findRarity(rarityId) {
    var rarities = state.session && state.session.catalog && state.session.catalog.rarities;
    if (!rarities) return null;
    if (Array.isArray(rarities)) {
      for (var i = 0; i < rarities.length; i += 1) {
        if (String(rarities[i].id) === String(rarityId)) return rarities[i];
      }
      if (Number(rarityId) >= 0 && rarities[Number(rarityId)]) return rarities[Number(rarityId)];
      return null;
    }
    return rarities[rarityId] || rarities[String(rarityId)] || null;
  }

  function makeRarityBadge(rarityId) {
    var info = findRarity(rarityId) || {};
    var badge = el('span', { className: 'badge badge-rarity' });
    badge.textContent = (info.badge ? '[' + info.badge + '] ' : '') + (info.ko || String(rarityId));
    if (info.color) {
      badge.style.color = info.color;
      badge.style.borderColor = info.color;
    }
    return badge;
  }

  function getCategoryKo(catKey) {
    var cats = (state.session && state.session.catalog && state.session.catalog.itemCategories) || {};
    return cats[catKey] || String(catKey || '');
  }

  function fillSelect(select, entries) {
    if (!select) return;
    clearEl(select);
    for (var i = 0; i < entries.length; i += 1) {
      var entry = entries[i];
      select.appendChild(el('option', { value: entry.value, text: entry.text }));
    }
  }

  function populateStaticSelects() {
    var catalog = (state.session && state.session.catalog) || {};
    var cats = catalog.itemCategories || {};
    var rarities = catalog.rarities || [];
    var catEntries = [{ value: 'all', text: '전체 분류' }].concat(
      Object.keys(cats).map(function (k) { return { value: k, text: cats[k] }; })
    );
    var rarityEntries = [{ value: '-1', text: '전체 등급' }].concat(
      rarities.map(function (r) { return { value: String(r.id), text: '[' + r.badge + '] ' + r.ko }; })
    );
    var kfEntries = [{ value: '-1', text: '전체 종류' }].concat(
      Object.keys(KF_TYPE_KO).map(function (k) { return { value: String(k), text: KF_TYPE_KO[k] }; })
    );
    fillSelect($('inv-cat-select'), catEntries);
    fillSelect($('cat-item-category'), catEntries);
    fillSelect($('cat-item-rarity'), rarityEntries);
    fillSelect($('cat-kf-rarity'), rarityEntries);
    fillSelect($('cat-trait-rarity'), rarityEntries);
    fillSelect($('cat-kf-type'), kfEntries);
    if ($('char-level')) $('char-level').max = '999';
    if ($('char-valueState')) $('char-valueState').type = 'number';
    if ($('cat-kf-level')) $('cat-kf-level').max = '15';
    if ($('new-rel-val')) {
      $('new-rel-val').min = '-100';
      $('new-rel-val').max = '100';
    }
    if ($('btn-connect-dir')) {
      $('btn-connect-dir').hidden = true;
    }
  }

  function getTabs() {
    var list = $('main-tablist');
    if (!list) return [];
    return Array.prototype.slice.call(list.querySelectorAll('[role="tab"]'));
  }

  function panelIdForTab(tab) {
    var controls = tab.getAttribute('aria-controls');
    return controls || (tab.id ? tab.id.replace(/-tab$/, '') : null);
  }

  function activateTab(tabId, shouldFocus) {
    var tabs = getTabs();
    if (!tabs.length) return;
    var selectedTab = null;
    var i;
    for (i = 0; i < tabs.length; i += 1) {
      var tab = tabs[i];
      var isSelected = tab.id === tabId;
      tab.setAttribute('aria-selected', isSelected ? 'true' : 'false');
      tab.tabIndex = isSelected ? 0 : -1;
      var panel = panelIdForTab(tab);
      var panelNode = panel ? $(panel) : null;
      if (panelNode) {
        if (isSelected) panelNode.removeAttribute('hidden');
        else panelNode.setAttribute('hidden', 'until-found');
      }
      if (isSelected) selectedTab = tab;
    }
    state.activeTabId = selectedTab ? selectedTab.id : tabId;
    var activePanel = selectedTab ? panelIdForTab(selectedTab) : null;
    if (state.session) {
      if (activePanel === 'panel-summary' || state.activeTabId === 'tab-summary') {
        renderSummaryTab();
      } else if (activePanel === 'panel-raw' || activePanel === 'panel-reference' || (state.activeTabId && state.activeTabId.indexOf('raw') >= 0)) {
        renderRawViewer();
      }
    }
    if (selectedTab && shouldFocus) {
      selectedTab.focus();
      if (typeof selectedTab.scrollIntoView === 'function') {
        selectedTab.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      }
    }
  }

  function initTabs() {
    var tabs = getTabs();
    if (!tabs.length) return;
    for (var i = 0; i < tabs.length; i += 1) {
      var tab = tabs[i];
      tab.addEventListener('click', function (e) { activateTab(e.currentTarget.id, false); });
      tab.addEventListener('keydown', function (e) {
        if (e.isComposing || e.keyCode === 229) return;
        var list = getTabs();
        var idx = list.indexOf(e.currentTarget);
        if (idx < 0) return;
        var next = null;
        if (e.key === 'ArrowRight') next = list[(idx + 1) % list.length];
        else if (e.key === 'ArrowLeft') next = list[(idx - 1 + list.length) % list.length];
        else if (e.key === 'Home') next = list[0];
        else if (e.key === 'End') next = list[list.length - 1];
        if (next) { e.preventDefault(); activateTab(next.id, true); }
      });
    }
    var panels = document.querySelectorAll('[role="tabpanel"]');
    for (var p = 0; p < panels.length; p += 1) {
      (function (panel) {
        panel.addEventListener('beforematch', function () {
          var tabsNow = getTabs();
          for (var t = 0; t < tabsNow.length; t += 1) {
            var pid = panelIdForTab(tabsNow[t]);
            if (pid && $(pid) === panel) { activateTab(tabsNow[t].id, false); return; }
            if (tabsNow[t].getAttribute('aria-controls') === panel.id) { activateTab(tabsNow[t].id, false); return; }
          }
        });
      })(panels[p]);
    }
    var initial = state.activeTabId || (tabs[0] && tabs[0].id);
    if (initial) activateTab(initial, false);
  }

  function getPassword() {
    var input = $('password-input');
    return (input && input.value) || 'Meow';
  }

  function getUpdateTimestamp() {
    var chk = $('chk-update-timestamp');
    return !!(chk && chk.checked);
  }

  function isNativeWebView() {
    return !!(global.chrome && global.chrome.webview && typeof global.chrome.webview.postMessage === 'function');
  }

  function canCheckBrowserGameStatus() {
    return !!(typeof global.HerosAdventureCheckGameStatus === 'function' ||
      (global.location && global.location.protocol === 'http:' &&
        (global.location.hostname === '127.0.0.1' || global.location.hostname === 'localhost' || global.location.hostname === '[::1]') &&
        typeof global.fetch === 'function'));
  }

  async function ensureBrowserGameNotRunning() {
    var status = 'UNKNOWN';
    if (typeof global.HerosAdventureCheckGameStatus === 'function') {
      try {
        var checked = await global.HerosAdventureCheckGameStatus();
        if (typeof checked === 'string') status = checked;
        else if (checked && typeof checked.status === 'string') status = checked.status;
      } catch (e) {
        status = 'UNKNOWN';
      }
    } else if (canCheckBrowserGameStatus()) {
      try {
        var response = await global.fetch('/api/game-status', { method: 'GET', cache: 'no-store' });
        if (response && response.ok) {
          var body = await response.json();
          status = body && typeof body.status === 'string' ? body.status : 'UNKNOWN';
        } else {
          status = 'UNKNOWN';
        }
      } catch (e) {
        status = 'UNKNOWN';
      }
    }
    if (status === 'RUNNING') {
      throw new Error('대협입지전(Wulin.exe)이 실행 중입니다. 게임을 종료하거나 파일 다운로드 저장을 이용하세요.');
    }
    if (status !== 'NOT_RUNNING') {
      throw new Error('현재 브라우저 모드에서는 게임(Wulin.exe) 실행 여부를 확인할 수 없어 폴더 직접 덮어쓰기가 차단됩니다. Windows 실행 파일(.exe), 로컬 서버(serve), 또는 파일 다운로드 저장을 이용하세요.');
    }
  }

  function bytesToBase64(bytes) {
    var arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    var chunk = 0x8000;
    var parts = [];
    for (var i = 0; i < arr.length; i += chunk) {
      var sub = arr.subarray(i, Math.min(arr.length, i + chunk));
      parts.push(String.fromCharCode.apply(null, sub));
    }
    return global.btoa(parts.join(''));
  }

  function base64ToBytes(b64) {
    var bin = global.atob(String(b64 || ''));
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
    return out;
  }

  function initNativeBridge() {
    if (isNativeWebView()) {
      if ($('btn-connect-dir')) $('btn-connect-dir').hidden = true;
      if ($('native-toolbar')) $('native-toolbar').hidden = false;
    } else {
      return;
    }
    if (!global.chrome || !global.chrome.webview) return;
    if (state.nativeBridgeInitialized) return;
    state.nativeBridgeInitialized = true;
    global.chrome.webview.addEventListener('message', function (ev) {
      var data = ev.data;
      if (typeof data === 'string') { try { data = JSON.parse(data); } catch (e) { return; } }
      if (!data || typeof data !== 'object') return;
      var key = data.seq !== undefined ? data.seq : data.id;
      var pending = state.nativePending && state.nativePending[key];
      if (!pending) {
        var late = state.nativeLatePending && state.nativeLatePending[key];
        if (late) {
          delete state.nativeLatePending[key];
          var ok = (data.ok !== false && !data.error);
          var errMsg = ok ? null : String(data.error || '네이티브 오류');
          if (late.kind === 'save-files') {
            if (ok) {
              state.nativeUncertain = false;
              if (data.session) state.nativeSession = data.session;
              if (late.savedList && state.session) state.session.markSaved(late.savedList);
              renderAll();
              setStatus('지연된 네이티브 저장 응답을 반영했습니다.', 'ok');
            } else {
              state.nativeUncertain = false;
              setStatus('지연된 네이티브 저장 실패 응답 확인: ' + errMsg, 'error');
            }
          } else if (late.kind === 'confirm-session') {
            if (ok) {
              commitOpenState(late.pendingNextSession, { nativeSession: data.session || late.pendingNativeSession });
              setStatus('지연된 세션 확정 응답을 반영했습니다.', 'ok');
            } else {
              state.nativeUncertain = false;
              setStatus('지연된 세션 확정 실패 응답 확인: ' + errMsg, 'error');
            }
          }
          state.nativeLateSettled = state.nativeLateSettled || Object.create(null);
          state.nativeLateSettled[key] = { ok: ok, data: data, error: errMsg };
        }
        return;
      }
      delete state.nativePending[key];
      if (pending.timer) clearTimeout(pending.timer);
      if (data.ok === false || data.error) pending.reject(new Error(String(data.error || '네이티브 오류')));
      else pending.resolve(data);
    });
  }

  function sendNativeRequest(reqObj, opts) {
    opts = opts || {};
    initNativeBridge();
    return new Promise(function (resolve, reject) {
      if (!isNativeWebView() || !global.chrome || !global.chrome.webview) {
        reject(new Error('네이티브 브리지를 사용할 수 없습니다.'));
        return;
      }
      var seq = ++state.nativeSeq;
      state.nativePending = state.nativePending || Object.create(null);
      var msg = { id: String(seq), seq: seq };
      var keys = Object.keys(reqObj || {});
      for (var i = 0; i < keys.length; i += 1) msg[keys[i]] = reqObj[keys[i]];
      var serialized = '';
      try {
        serialized = JSON.stringify(msg);
      } catch (e) {
        delete state.nativePending[seq];
        reject(new Error('네이티브 요청 데이터가 너무 큽니다.'));
        return;
      }
      if (serialized.length > 90 * 1024 * 1024) {
        delete state.nativePending[seq];
        reject(new Error('네이티브 요청 데이터가 너무 큽니다.'));
        return;
      }
      var timeoutMs = state.nativeTimeoutMs || 60000;
      var timer = null;
      if (!opts.noTimeout) {
        timer = setTimeout(function () {
          if (state.nativePending && state.nativePending[seq]) {
            state.nativeLatePending = state.nativeLatePending || Object.create(null);
            state.nativeLatePending[seq] = {
              id: msg.id,
              seq: seq,
              kind: msg.kind,
              savedList: opts.savedList || null,
              pendingNextSession: opts.pendingNextSession || null,
              pendingNativeSession: opts.pendingNativeSession || null,
              okLabel: opts.okLabel || '',
              entryCount: opts.entryCount || 0
            };
            delete state.nativePending[seq];
            var tErr = new Error('네이티브 요청 시간이 초과되었습니다.');
            tErr.isNativeTimeout = true;
            tErr.requestId = msg.id;
            tErr.requestSeq = seq;
            reject(tErr);
          }
        }, timeoutMs);
      }
      state.nativePending[seq] = { resolve: resolve, reject: reject, timer: timer };
      if (typeof opts.onSent === 'function') opts.onSent(msg);
      global.chrome.webview.postMessage(msg);
    });
  }

  function commitOpenState(nextSession, opts) {
    opts = opts || {};
    state.session = nextSession;
    state.nativeSession = opts.nativeSession || null;
    state.dirHandle = opts.dirHandle || null;
    state.fileHandles = opts.fileHandles || Object.create(null);
    state.fileHashes = opts.fileHashes || Object.create(null);
    state.nativeUncertain = false;
    state.dirSaveTainted = false;
    state.nativeLatePending = Object.create(null);
    renderAll();
  }

  function consumeLateSettled(seq) {
    if (seq === null || seq === undefined || !state.nativeLateSettled) return null;
    var s = state.nativeLateSettled[seq];
    if (!s) return null;
    delete state.nativeLateSettled[seq];
    state.nativeUncertain = false;
    return s;
  }

  function settleOrRethrowLate(seq) {
    var s = consumeLateSettled(seq);
    if (!s) return false;
    if (s.ok) return true;
    throw new Error(s.error);
  }

  async function nativeOpenCommon(kind, cancelMsg, okLabel, errPrefix) {
    if (!guardNotBusy(true)) return;
    if (!confirmDiscardUnsaved()) return;
    state.busy = true;
    try {
      var res = await sendNativeRequest({ kind: kind }, { noTimeout: true });
      if (res && res.cancelled) { setStatus(cancelMsg, 'ok'); return; }
      var files = (res && res.files) || [];
      var entries = files.map(function (f) {
        var rawB64 = f.base64 || f.data || '';
        return { name: f.name, relativePath: f.relativePath || f.name, bytes: rawB64 ? base64ToBytes(rawB64) : (f.bytes ? new Uint8Array(f.bytes) : new Uint8Array()) };
      });
      if (!entries.length) {
        if (res && res.session) {
          try { await sendNativeRequest({ kind: 'discard-pending-session', session: res.session }); } catch (_) {}
        }
        setStatus(errPrefix + ': 불러올 파일이 없습니다.', 'error');
        return;
      }
      var nextSession = new Core.SlotSession(RawCatalog);
      try {
        await nextSession.loadFiles(entries, getPassword());
        assertUsableSession(nextSession);
      } catch (parseErr) {
        if (res && res.session) {
          try { await sendNativeRequest({ kind: 'discard-pending-session', session: res.session }); } catch (_) {}
        }
        throw parseErr;
      }
      var confirmSentId = null;
      var confirmSentSeq = null;
      var confirmOpts = {
        onSent: function (msg) {
          confirmSentId = msg.id;
          confirmSentSeq = msg.seq;
        },
        pendingNextSession: nextSession,
        pendingNativeSession: res.session || null,
        okLabel: okLabel,
        entryCount: entries.length
      };
      try {
        var confirmed = await sendNativeRequest({ kind: 'confirm-session', session: res.session }, confirmOpts);
        commitOpenState(nextSession, { nativeSession: (confirmed && confirmed.session) || res.session || null });
        setStatus(okLabel + ' (' + entries.length + '개 파일)', 'ok');
      } catch (confirmErr) {
        if (confirmErr && confirmErr.isNativeTimeout) {
          var st = null;
          try {
            st = await sendNativeRequest({ kind: 'session-status' });
          } catch (statusErr) {
            if (settleOrRethrowLate(confirmSentSeq)) return;
            state.nativeUncertain = true;
            throw new Error('네이티브 세션 상태를 확인할 수 없어 폴더 직접 덮어쓰기가 차단됩니다. 잠시 후 다시 시도하거나 파일 다운로드 저장을 이용하세요.');
          }
          if (settleOrRethrowLate(confirmSentSeq)) return;
          if (st && (st.lastConfirmedSessionId === confirmSentId || (res && res.session && st.activeSession === res.session))) {
            delete state.nativeLatePending[confirmSentSeq];
            commitOpenState(nextSession, { nativeSession: st.activeSession || (res && res.session) || null });
            setStatus(okLabel + ' (' + entries.length + '개 파일)', 'ok');
            return;
          }
          if (st && !st.working && st.activeSession !== (res && res.session)) {
            delete state.nativeLatePending[confirmSentSeq];
            if (res && res.session && (st.pendingSession === undefined || st.pendingSession === res.session)) {
              try { await sendNativeRequest({ kind: 'discard-pending-session', session: res.session }); } catch (discardErr) {}
            }
            throw confirmErr;
          }
          state.nativeUncertain = true;
          throw new Error('네이티브 세션 확정 응답을 확인하지 못해 폴더 직접 덮어쓰기가 차단됩니다. 잠시 후 다시 시도하거나 파일 다운로드 저장을 이용하세요.');
        }
        throw confirmErr;
      }
    } catch (err) { setStatus(errPrefix + ': ' + (err && err.message ? err.message : err), 'error'); }
    finally { state.busy = false; }
  }

  async function nativeOpenSlot() {
    await nativeOpenCommon('open-slot', '슬롯 열기가 취소되었습니다.', '네이티브 슬롯을 불러왔습니다.', '네이티브 슬롯 열기 실패');
  }

  async function nativeOpenFiles() {
    await nativeOpenCommon('open-files', '파일 열기가 취소되었습니다.', '네이티브 파일을 불러왔습니다.', '네이티브 파일 열기 실패');
  }

  async function nativeSaveModified() {
    if (!guardNotBusy()) return;
    state.busy = true;
    try {
      var list = await state.session.exportModifiedFiles({ updateTimestamp: getUpdateTimestamp() });
      if (!list.length) { setStatus('저장할 변경 사항이 없습니다.', 'ok'); return; }
      var sentId = null;
      var sentSeq = null;
      try {
        var res = await sendNativeRequest({ kind: 'save-files', session: state.nativeSession, files: list.map(function (f) {
          return { name: f.name, relativePath: f.relativePath, base64: bytesToBase64(f.bytes) };
        }) }, {
          savedList: list,
          onSent: function (m) { sentId = m.id; sentSeq = m.seq; }
        });
        state.nativeSession = res.session || state.nativeSession;
        state.session.markSaved(list);
        renderAll();
        setStatus('자동 백업 후 변경된 파일을 저장했습니다.', 'ok');
      } catch (saveErr) {
        if (saveErr && saveErr.isNativeTimeout) {
          var st;
          try {
            st = await sendNativeRequest({ kind: 'session-status' });
          } catch (statusErr) {
            if (settleOrRethrowLate(sentSeq)) return;
            state.nativeUncertain = true;
            throw new Error('저장 시간 초과 후 세션 상태 조회에 실패했습니다. 슬롯을 다시 열기 전까지 잠깁니다.');
          }
          if (settleOrRethrowLate(sentSeq)) return;
          if (st && st.lastCompletedSaveId === sentId) {
            delete state.nativeLatePending[sentSeq];
            state.nativeUncertain = false;
            state.nativeSession = st.lastCompletedSaveSession || st.activeSession || state.nativeSession;
            state.session.markSaved(list);
            renderAll();
            setStatus('자동 백업 후 변경된 파일을 저장했습니다.', 'ok');
            return;
          }
          if (st && !st.working && st.activeSession === state.nativeSession && st.lastCompletedSaveId !== sentId) {
            delete state.nativeLatePending[sentSeq];
            throw saveErr;
          }
          state.nativeUncertain = true;
          throw new Error('저장 완료 여부를 확정할 수 없어 편집이 잠겼습니다. 슬롯을 다시 열어 주세요.');
        }
        throw saveErr;
      }
    } catch (err) { setStatus('네이티브 저장 실패: ' + (err && err.message ? err.message : err), 'error'); }
    finally { state.busy = false; }
  }

  async function readBrowserFileInputs(fileList) {
    var files = Array.prototype.slice.call(fileList || []);
    if (!guardNotBusy(true)) return;
    if (!confirmDiscardUnsaved()) return;
    state.busy = true;
    try {
      var entries = [];
      for (var i = 0; i < files.length; i++) {
        var file = files[i];
        if (!file) continue;
        var name = file.name || '';
        if (!/\.(save|es3|json)$/i.test(name)) continue;
        var bytes = new Uint8Array(await file.arrayBuffer());
        entries.push({ name: name, relativePath: file.webkitRelativePath || name, bytes: bytes });
      }
      if (!entries.length) {
        setStatus('불러올 수 있는 세이브 파일(.save/.es3)이 없습니다.', 'error');
        return;
      }
      var nextSession = new Core.SlotSession(RawCatalog);
      await nextSession.loadFiles(entries, getPassword());
      assertUsableSession(nextSession);
      commitOpenState(nextSession);
      setStatus(entries.length + '개 세이브 파일을 불러왔습니다.', 'ok');
    } catch (err) {
      setStatus('파일 읽기 실패: ' + (err && err.message ? err.message : err), 'error');
    } finally {
      state.busy = false;
    }
  }

  function connectDirectoryPicker() {
    if (isNativeWebView()) return;
    if (!guardNotBusy(true)) return;
    setStatus('브라우저 File System Access API는 검증과 커밋 사이의 외부 변경 충돌을 방지할 수 없어 폴더 직접 덮어쓰기가 차단되었습니다. Windows 실행 파일(.exe)의 네이티브 저장, Python CLI, 또는 [슬롯 폴더 열기] 후 파일 다운로드를 이용하세요.', 'error');
  }
  async function saveToConnectedDirCore(list) {
    var msg = '브라우저 File System Access API는 검증과 커밋 사이의 외부 변경 충돌을 방지할 수 없어 직접 덮어쓰기가 차단되었습니다. Windows 실행 파일(.exe)의 네이티브 저장, Python CLI, 또는 파일 다운로드를 이용하세요.';
    if (Array.isArray(list) && state.fileHandles) {
      for (var vf of list) {
        if (vf && vf.name && state.fileHandles[vf.name] && typeof state.fileHandles[vf.name].getFile === 'function') {
          try { await state.fileHandles[vf.name].getFile(); } catch (_) {}
        }
      }
    }
    setStatus(msg, 'error');
    throw new Error(msg);
  }
  async function saveToConnectedDir(list) {
    if (state.busy) {
      var m = '파일 저장/열기 작업이 진행 중입니다. 잠시 후 다시 시도하세요.';
      setStatus(m, 'error');
      throw new Error(m);
    }
    state.busy = true;
    try {
      await saveToConnectedDirCore(list);
    } finally {
      state.busy = false;
    }
  }

  async function loadDemoSlot() {
    if (!guardNotBusy(true)) return;
    if (!confirmDiscardUnsaved()) return;
    state.busy = true;
    try {
      var files = await Core.createDemoSlotFiles(RawCatalog, getPassword());
      var nextSession = new Core.SlotSession(RawCatalog);
      await nextSession.loadFiles(files, getPassword());
      commitOpenState(nextSession);
      setStatus('데모 세이브 슬롯(8개 파일)을 불러왔습니다.', 'ok');
    } catch (err) {
      setStatus('데모 로드 실패: ' + (err && err.message ? err.message : err), 'error');
    } finally {
      state.busy = false;
    }
  }

  function downloadBytes(bytes, fileName) {
    var blob = new Blob([bytes], { type: 'application/octet-stream' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  async function exportFilesFlow(exportAll) {
    if (!exportAll && isNativeWebView() && state.nativeSession) {
      await nativeSaveModified();
      return;
    }
    if (!guardNotBusy()) return;
    state.busy = true;
    try {
      var opts = { updateTimestamp: getUpdateTimestamp() };
      var list = exportAll
        ? await state.session.exportAllFiles(opts)
        : await state.session.exportModifiedFiles(opts);
      if (!list.length) { setStatus(exportAll ? '내보낼 파일이 없습니다.' : '수정된 파일이 없습니다.', 'ok'); return; }
      if (state.dirHandle) { await saveToConnectedDirCore(list); return; }
      list.forEach(function (f) { downloadBytes(f.bytes, f.name); });
      setStatus(list.length + '개 파일을 다운로드했습니다.', 'ok');
    } catch (err) {
      setStatus('내보내기 실패: ' + (err && err.message ? err.message : err), 'error');
    } finally {
      state.busy = false;
    }
  }

  function initBeforeUnload() {
    global.HerosAdventureUI = {
      isBusy: function () { return !!state.busy; },
      getSession: function () { return state.session; },
      getNativeSession: function () { return state.nativeSession; },
      getState: function () { return state; },
      connectDirectoryPicker: connectDirectoryPicker,
      saveToConnectedDir: saveToConnectedDir,
      nativeOpenSlot: nativeOpenSlot,
      nativeOpenFiles: nativeOpenFiles,
      nativeSaveModified: nativeSaveModified,
      sendNativeRequest: sendNativeRequest,
      readBrowserFileInputs: readBrowserFileInputs,
      loadDemoSlot: loadDemoSlot,
      exportFilesFlow: exportFilesFlow,
      initNativeBridge: initNativeBridge,
      populateStaticSelects: populateStaticSelects,
      guardNotBusy: guardNotBusy,
      confirmDiscardUnsaved: confirmDiscardUnsaved,
      canCheckBrowserGameStatus: canCheckBrowserGameStatus,
      ensureBrowserGameNotRunning: ensureBrowserGameNotRunning,
      renderAll: renderAll
    };
    global.hasUnsavedChanges = function () {
      return !!(state.session && typeof state.session.hasUnsavedChanges === 'function' && state.session.hasUnsavedChanges());
    };
    global.addEventListener('beforeunload', function (ev) {
      if (!global.hasUnsavedChanges()) return;
      ev.preventDefault();
      ev.returnValue = '';
    });
  }

  function renderSummaryTab() {
    const s = state.session.getSummary();
    const protagonist = $('summary-protagonist');
    clearEl(protagonist);
    if (!s.protagonist) {
      protagonist.appendChild(el('p', { className: 'muted' }, ['로드된 파일이 없습니다. 파일을 불러온 뒤 주인공 정보가 표시됩니다.']));
    } else {
      protagonist.appendChild(el('div', { className: 'summary-protagonist-card' }, [
        el('strong', {}, [s.protagonist.displayName]),
        el('span', {}, [' · Lv. ' + s.protagonist.level]),
        el('div', { className: 'muted' }, ['인스턴스 ID: ' + s.protagonist.instanceId]),
        el('div', {}, ['로드된 파일 수: ' + s.fileCount + ' / 수정된 파일 수: ' + s.dirtyFileCount])
      ]));
    }
    const grid = $('preset-cards-grid');
    clearEl(grid);
    PRESET_DEFS.forEach(function (p) {
      grid.appendChild(el('button', {
        type: 'button',
        className: 'preset-card',
        dataset: { preset: p.key },
        on: {
          click: function () {
            if (!guardNotBusy()) return;
            try {
              const result = state.session.applyPreset(p.key);
              renderAll();
              setStatus(p.name + ' 프리셋 적용 완료' + (result && result.length ? ' (' + result.length + ')' : ''), 'ok');
            } catch (err) { setStatus(err.message, 'error'); }
          }
        }
      }, [ el('strong', {}, [p.name]), el('span', {}, [p.desc || '']) ]));
    });
    const tbody = $('loaded-files-tbody');
    clearEl(tbody);
    state.session.listLoadedFiles().forEach(function (f) {
      tbody.appendChild(el('tr', {}, [
        el('td', {}, [f.fileName]),
        el('td', {}, [ROLE_KO[f.kind] || f.kind]),
        el('td', {}, [f.mode || '-']),
        el('td', {}, [f.dirty ? '수정됨' : '정상']),
        el('td', {}, [
          el('button', {
            type: 'button',
            on: {
              click: function () {
                if (!guardNotBusy()) return;
                if (state.session.resetFile(f.kind)) {
                  setStatus(f.fileName + ' 초기화 완료', 'ok');
                  renderAll();
                } else {
                  setStatus(f.fileName + ' 초기화 실패', 'error');
                }
              }
            }
          }, ['초기화']),
          el('button', {
            type: 'button',
            on: {
              click: function () {
                const rawText = state.session.getRawFileText(f.kind);
                Promise.resolve(global.HerosAdventureEs3Codec.encodeEs3Bytes(rawText, {
                  mode: f.mode || 'aes-gzip',
                  password: getPassword()
                })).then(function (bytes) {
                  downloadBytes(bytes, f.fileName);
                }).catch(function (err) {
                  setStatus(err.message, 'error');
                });
              }
            }
          }, ['다운로드'])
        ])
      ]));
    });
    const list = $('changelog-list');
    clearEl(list);
    s.changeLog.slice(-30).reverse().forEach(function (c) {
      list.appendChild(el('li', {}, [
        el('strong', {}, [c.action]),
        ' ',
        JSON.stringify(c.detail)
      ]));
    });
  }

  function renderCurrencyTab() {
    const grid = $('currency-grid');
    clearEl(grid);
    state.session.getCurrencies().forEach(function (c) {
      let input;
      let conversion;
      input = el('input', {
        type: 'number',
        value: c.value,
        on: {
          input: function () {
            if (c.id === 0 && conversion) conversion.textContent = formatCoinConversion(input.value);
          }
        }
      });
      if (c.id === 0) {
        conversion = el('div', { className: 'muted' }, [formatCoinConversion(c.value)]);
      }
      grid.appendChild(el('div', { className: 'currency-card' }, [
        el('strong', {}, [c.koName + ' (' + c.zhName + ')']),
        input,
        c.id === 0 ? conversion : null,
        el('button', {
          type: 'button',
          on: {
            click: function () {
              if (!guardNotBusy()) return;
              try {
                state.session.setCurrency(c.id, Number(input.value) || 0);
                syncAfterMutation();
                setStatus(c.koName + ' 적용 완료', 'ok');
              } catch (e) { setStatus(e.message, 'error'); }
            }
          }
        }, ['적용']),
        el('button', {
          type: 'button',
          on: {
            click: function () {
              if (!guardNotBusy()) return;
              try {
                const max = Math.min(c.max || 99999999, 99999999);
                input.value = max;
                state.session.setCurrency(c.id, max);
                if (c.id === 0 && conversion) conversion.textContent = formatCoinConversion(max);
                syncAfterMutation();
                setStatus(c.koName + ' 최대치 적용 완료', 'ok');
              } catch (e) { setStatus(e.message, 'error'); }
            }
          }
        }, ['최대치'])
      ]));
    });
    const propsGrid = $('team-props-grid');
    clearEl(propsGrid);
    const currentProps = state.session.getTeamProps();
    const catalogProps = state.session.catalog.teamProps || [];
    const seen = {};

    function appendTeamPropCard(key, label, initVal, maxVal) {
      const input = el('input', { type: 'number', value: initVal });
      const applyBtn = el('button', { type: 'button', onclick: function () {
        if (!guardNotBusy()) return;
        try {
          state.session.setTeamProp(key, Number(input.value) || 0);
          syncAfterMutation();
          setStatus(label + ' 적용 완료', 'ok');
        } catch (e) { setStatus(e.message, 'error'); }
      } }, '적용');
      const maxBtn = el('button', { type: 'button', onclick: function () {
        if (!guardNotBusy()) return;
        try {
          input.value = maxVal;
          state.session.setTeamProp(key, maxVal);
          syncAfterMutation();
          setStatus(label + ' 최대 적용 완료', 'ok');
        } catch (e) { setStatus(e.message, 'error'); }
      } }, '최대');
      propsGrid.appendChild(el('div', { className: 'team-prop-card' }, [el('strong', {}, [label]), input, applyBtn, maxBtn]));
    }

    catalogProps.forEach(function (p) {
      seen[p.key] = true;
      appendTeamPropCard(p.key, p.ko || p.key, currentProps[p.key] ?? p.min ?? 0, p.max ?? 99999999);
    });
    Object.keys(currentProps).forEach(function (key) {
      if (seen[key]) return;
      appendTeamPropCard(key, key, currentProps[key] ?? 0, 99999999);
    });
  }

  function renderOwnedInventory() {
    const query = $('inv-search-input').value || '';
    const category = $('inv-cat-select').value || '';
    const items = state.session.getInventoryItems({ query: query, category: category });
    $('inv-count-badge').textContent = items.length + '건';
    const tbody = $('inv-tbody');
    clearEl(tbody);
    if (items.length > 300) {
      tbody.appendChild(el('tr', {}, [
        el('td', { colSpan: 5, className: 'muted' }, ['최대 300행만 표시됩니다. 검색 조건을 좁혀 주세요.'])
      ]));
    }
    items.slice(0, 300).forEach(function (item) {
      const stackInput = el('input', { type: 'number', value: item.count });
      const forgeInput = item.hasModifyData ? el('input', { type: 'number', value: item.forgeLevel, min: 0, max: 30 }) : null;
      tbody.appendChild(el('tr', {}, [
        el('td', {}, [item.koName + ' (' + item.zhName + ') #' + item.uid]),
        el('td', {}, [makeRarityBadge(item.rarity), ' ', getCategoryKo(item.category)]),
        el('td', {}, [
          stackInput,
          el('button', {
            type: 'button',
            on: {
              click: function () {
                if (!guardNotBusy()) return;
                try {
                  const stack = Math.max(1, Math.min(99999, Number(stackInput.value) || 1));
                  stackInput.value = stack;
                  state.session.setInventoryItemStack(item.index, stack);
                  renderOwnedInventory();
                  syncAfterMutation();
                  setStatus('수량 적용 완료', 'ok');
                } catch (e) { setStatus(e.message, 'error'); }
              }
            }
          }, ['적용'])
        ]),
        el('td', {}, item.hasModifyData ? [
          forgeInput,
          el('button', {
            type: 'button',
            on: {
              click: function () {
                if (!guardNotBusy()) return;
                try {
                  const forge = Math.max(0, Math.min(30, Number(forgeInput.value) || 0));
                  forgeInput.value = forge;
                  state.session.setInventoryItemForgeLevel(item.index, forge);
                  renderOwnedInventory();
                  syncAfterMutation();
                  setStatus('단조 레벨 적용 완료', 'ok');
                } catch (e) { setStatus(e.message, 'error'); }
              }
            }
          }, ['적용'])
        ] : ['-']),
        el('td', {}, [
          el('button', {
            type: 'button',
            on: {
              click: function () {
                if (!guardNotBusy()) return;
                try {
                  state.session.removeInventoryItem(item.index);
                  renderOwnedInventory();
                  syncAfterMutation();
                  setStatus(item.koName + ' 삭제 완료', 'ok');
                } catch (e) { setStatus(e.message, 'error'); }
              }
            }
          }, ['삭제'])
        ])
      ]));
    });
  }

  function renderCatalogItems() {
    const query = $('cat-item-search').value || '';
    const category = $('cat-item-category').value || '';
    const rarity = Number($('cat-item-rarity').value);
    const items = state.session.searchCatalogItems(query, category, rarity, 100);
    const tbody = $('cat-item-tbody');
    clearEl(tbody);
    items.forEach(function (item) {
      tbody.appendChild(el('tr', {}, [
        el('td', {}, [item.uid]),
        el('td', {}, [item.koName + ' (' + item.zhName + ')']),
        el('td', {}, [makeRarityBadge(item.rarity), ' ', getCategoryKo(item.category)]),
        el('td', {}, [formatNum(item.price)]),
        el('td', {}, [
          el('button', {
            type: 'button',
            on: {
              click: function () {
                if (!guardNotBusy()) return;
                try {
                  const qty = Number($('cat-item-qty').value) || 1;
                  state.session.addInventoryItem(item.uid, qty);
                  renderOwnedInventory();
                  syncAfterMutation();
                  setStatus(item.koName + ' ' + qty + '개 추가 완료', 'ok');
                } catch (e) { setStatus(e.message, 'error'); }
              }
            }
          }, ['인벤토리에 추가'])
        ])
      ]));
    });
  }

  function renderInventoryTab() {
    renderOwnedInventory();
    renderCatalogItems();
  }

  function renderCharacterList() {
    try {
      const list = state.session.listCharacters({ filter: $('char-filter-select').value, query: $('char-search-input').value });
      $('char-count-badge').textContent = list.length + '명';
      if (!list.some(c => c.instanceId === state.selectedCharId)) state.selectedCharId = list.length ? list[0].instanceId : null;
      const box = $('char-list-box'); clearEl(box);
      box.appendChild(el('div', {}, list.slice(0, 250).map(c => {
        const isSel = c.instanceId === state.selectedCharId;
        return el('button', {
          type: 'button', className: 'char-item-btn', 'aria-current': isSel ? 'true' : 'false',
          onclick: () => { state.selectedCharId = c.instanceId; renderCharactersTab(); }
        }, `${c.displayName}${c.isProtagonist ? ' ★' : ''}${c.inParty ? ' [파티]' : ''} Lv.${c.level ?? ''}`);
      })));
    } catch (e) { setStatus(e.message, 'error'); }
  }

  function renderCharacterDetail() {
    try {
      if (!state.selectedCharId) {
        $('char-selected-title').textContent = '선택된 캐릭터 없음';
        clearEl($('char-props-tbody')); clearEl($('char-kungfu-tbody'));
        clearEl($('char-traits-list')); clearEl($('char-relations-tbody'));
        renderCatalogKungfu(); renderCatalogTraits();
        return;
      }
      const d = state.session.getCharacterDetail(state.selectedCharId);
      $('char-selected-title').textContent = d.displayName;
      $('char-surName').value = d.m_surName ?? '';
      $('char-givenName').value = d.m_givenName ?? '';
      $('char-overrideTitle').value = d.m_overrideTitle ?? '';
      $('char-level').value = d.m_level ?? 0;
      $('char-exp').value = d.m_exp ?? 0;
      $('char-curHp').value = d.curHp ?? 0;
      $('char-curEp').value = d.curEp ?? 0;
      $('char-egoState').value = d.m_egoState ?? 0;
      $('char-valueState').value = d.m_valueState ?? 0;
      $('char-isJoined').checked = !!d.isJoined;
      const propBar = $('char-prop-group-bar');
      if (propBar) {
        propBar.querySelectorAll('[data-prop-group]').forEach(btn => {
          const on = btn.dataset.propGroup === state.selectedPropGroup;
          btn.classList.toggle('active', on);
          btn.setAttribute('aria-pressed', on ? 'true' : 'false');
        });
      }
      const ptb = $('char-props-tbody'); clearEl(ptb);
      (state.session.catalog.characterProps[state.selectedPropGroup] || []).forEach(p => {
        const ov = d.originProps?.[p.key] ?? 0, av = d.additionProps?.[p.key] ?? 0;
        const oi = el('input', { type: 'number', min: p.min ?? 0, max: p.max ?? 9999, value: ov, className: 'char-prop-origin' });
        const ai = el('input', { type: 'number', min: 0, max: p.max ?? 9999, value: av, className: 'char-prop-addition' });
        const sum = el('span', {}, String(Number(ov) + Number(av)));
        const upd = () => { sum.textContent = String((Number(oi.value) || 0) + (Number(ai.value) || 0)); };
        oi.addEventListener('input', upd); ai.addEventListener('input', upd);
        const apply = el('button', { type: 'button', onclick: () => {
          if (!guardNotBusy()) return;
          try {
            state.session.setCharacterProp(d.instanceId, 'origin', p.key, Number(oi.value) || 0);
            state.session.setCharacterProp(d.instanceId, 'addition', p.key, Number(ai.value) || 0);
            syncAfterMutation();
            renderCharacterDetail(); setStatus('능력치 적용 완료', 'ok');
          } catch (e) { setStatus(e.message, 'error'); }
        } }, '적용');
        const max = el('button', { type: 'button', onclick: () => {
          if (!guardNotBusy()) return;
          try {
            state.session.setCharacterProp(d.instanceId, 'origin', p.key, p.max ?? 0);
            state.session.setCharacterProp(d.instanceId, 'addition', p.key, 0);
            syncAfterMutation();
            renderCharacterDetail(); setStatus('능력치 최대 적용 완료', 'ok');
          } catch (e) { setStatus(e.message, 'error'); }
        } }, '최대');
        ptb.appendChild(el('tr', {}, [el('td', {}, p.ko), el('td', {}, p.key), el('td', {}, oi), el('td', {}, ai), el('td', {}, sum), el('td', {}, [apply, ' ', max])]));
      });
      const ktb = $('char-kungfu-tbody'); clearEl(ktb);
      (d.kungfuList || []).forEach(kf => {
        const li = el('input', { type: 'number', min: 1, max: 15, value: kf.level });
        const apply = el('button', { type: 'button', onclick: () => {
          if (!guardNotBusy()) return;
          try {
            state.session.setCharacterKungfuLevel(d.instanceId, kf.index, Number(li.value) || 1);
            syncAfterMutation();
            renderCharacterDetail(); setStatus('무공 성급 적용 완료', 'ok');
          } catch (e) { setStatus(e.message, 'error'); }
        } }, '적용');
        const del = el('button', { type: 'button', onclick: () => {
          if (!guardNotBusy()) return;
          try {
            state.session.removeCharacterKungfu(d.instanceId, kf.index);
            syncAfterMutation();
            renderCharacterDetail(); setStatus('무공 제거 완료', 'ok');
          } catch (e) { setStatus(e.message, 'error'); }
        } }, '삭제');
        ktb.appendChild(el('tr', {}, [
          el('td', {}, `${kf.koName} (#${kf.templeteUid})`),
          el('td', {}, `최대 ${kf.maxLevel}`),
          el('td', {}, li),
          el('td', {}, [apply, ' ', del])
        ]));
      });
      const tl = $('char-traits-list'); clearEl(tl);
      (d.traits || []).forEach(t => {
        const info = state.session.lookups?.traits?.get?.(t.uid);
        const del = el('button', { type: 'button', onclick: () => {
          if (!guardNotBusy()) return;
          try {
            state.session.removeCharacterTrait(d.instanceId, t.uid);
            syncAfterMutation();
            renderCharacterDetail(); setStatus('특성 제거 완료', 'ok');
          } catch (e) { setStatus(e.message, 'error'); }
        } }, '× 제거');
        tl.appendChild(el('div', { className: 'char-trait-row' }, [el('span', { title: info?.desc || '' }, t.koName + (info?.desc ? ` — ${info.desc}` : '')), ' ', del]));
      });
      const rtb = $('char-relations-tbody'); clearEl(rtb);
      (d.relations || []).forEach(r => {
        const ai = el('input', { type: 'number', min: -100, max: 100, value: r.relationValue });
        const apply = el('button', { type: 'button', onclick: () => {
          if (!guardNotBusy()) return;
          try {
            state.session.setCharacterRelation(d.instanceId, r.targetId, Number(ai.value) || 0);
            syncAfterMutation();
            renderCharacterDetail(); setStatus('호감도 적용 완료', 'ok');
          } catch (e) { setStatus(e.message, 'error'); }
        } }, '적용');
        rtb.appendChild(el('tr', {}, [el('td', {}, r.targetId), el('td', {}, r.targetName), el('td', {}, ai), el('td', {}, apply)]));
      });
      renderCatalogKungfu(); renderCatalogTraits();
    } catch (e) { setStatus(e.message, 'error'); }
  }

  function renderCatalogKungfu() {
    try {
      const rows = state.session.searchCatalogKungfu($('cat-kf-search').value, Number($('cat-kf-type').value), Number($('cat-kf-rarity').value), 80);
      const tb = $('cat-kf-tbody'); clearEl(tb);
      rows.forEach(kf => {
        const learn = el('button', { type: 'button', onclick: () => {
          if (!guardNotBusy()) return;
          try {
            if (!state.selectedCharId) throw new Error('캐릭터를 먼저 선택하세요.');
            state.session.addCharacterKungfu(state.selectedCharId, kf.uid, Number($('cat-kf-level').value) || 10);
            syncAfterMutation();
            renderCharacterDetail(); setStatus('무공 습득 완료', 'ok');
          } catch (e) { setStatus(e.message, 'error'); }
        } }, '습득');
        tb.appendChild(el('tr', {}, [
          el('td', {}, `${kf.koName} (${kf.zhName}) #${kf.uid}`),
          el('td', {}, KF_TYPE_KO[kf.kungfuType] ?? ''),
          el('td', {}, [makeRarityBadge(kf.rarity)]),
          el('td', {}, learn)
        ]));
      });
    } catch (e) { setStatus(e.message, 'error'); }
  }

  function renderCatalogTraits() {
    try {
      const rows = state.session.searchCatalogTraits($('cat-trait-search').value, Number($('cat-trait-rarity').value), 80);
      const tb = $('cat-trait-tbody'); clearEl(tb);
      rows.forEach(tr => {
        const add = el('button', { type: 'button', onclick: () => {
          if (!guardNotBusy()) return;
          try {
            if (!state.selectedCharId) throw new Error('캐릭터를 먼저 선택하세요.');
            state.session.addCharacterTrait(state.selectedCharId, tr.uid);
            syncAfterMutation();
            renderCharacterDetail(); setStatus('특성 추가 완료', 'ok');
          } catch (e) { setStatus(e.message, 'error'); }
        } }, '추가');
        tb.appendChild(el('tr', {}, [
          el('td', {}, `${tr.koName} (${tr.zhName}) #${tr.uid}`),
          el('td', {}, [makeRarityBadge(tr.rarity)]),
          el('td', {}, tr.desc || ''),
          el('td', {}, add)
        ]));
      });
    } catch (e) { setStatus(e.message, 'error'); }
  }

  function applyCharacterBasic() {
    if (!guardNotBusy()) return;
    try {
      if (!state.selectedCharId) throw new Error('캐릭터를 먼저 선택하세요.');
      state.session.setCharacterBasic(state.selectedCharId, {
        m_surName: $('char-surName').value,
        m_givenName: $('char-givenName').value,
        m_overrideTitle: $('char-overrideTitle').value,
        m_level: Number($('char-level').value) || 0,
        m_exp: Number($('char-exp').value) || 0,
        curHp: Number($('char-curHp').value) || 0,
        curEp: Number($('char-curEp').value) || 0,
        m_egoState: Number($('char-egoState').value) || 0,
        m_valueState: Number($('char-valueState').value) || 0,
        isJoined: !!$('char-isJoined').checked
      });
      syncAfterMutation();
      renderCharactersTab(); setStatus('기본 정보 적용 완료', 'ok');
    } catch (e) { setStatus(e.message, 'error'); }
  }

  function maxSelectedCharKungfu() {
    if (!guardNotBusy()) return;
    try {
      if (!state.selectedCharId) throw new Error('캐릭터를 먼저 선택하세요.');
      state.session.maxAllCharacterKungfu(state.selectedCharId);
      syncAfterMutation();
      renderCharacterDetail(); setStatus('모든 무공 최대 성급 적용 완료', 'ok');
    } catch (e) { setStatus(e.message, 'error'); }
  }

  function maxSelectedCharRelations() {
    if (!guardNotBusy()) return;
    try {
      if (!state.selectedCharId) throw new Error('캐릭터를 먼저 선택하세요.');
      state.session.maxAllCharacterRelations(state.selectedCharId, 100);
      syncAfterMutation();
      renderCharacterDetail(); setStatus('모든 인연 호감도 최대 적용 완료', 'ok');
    } catch (e) { setStatus(e.message, 'error'); }
  }

  function addNewCharacterRelation() {
    if (!guardNotBusy()) return;
    var uidEl = $('new-rel-uid'), valEl = $('new-rel-val');
    var targetId = Number(uidEl && uidEl.value);
    var aff = Number(valEl && valEl.value);
    if (!state.selectedCharId || !Number.isFinite(targetId) || !Number.isFinite(aff)) return;
    aff = Math.max(-100, Math.min(100, aff));
    try {
      state.session.setCharacterRelation(state.selectedCharId, targetId, aff);
      syncAfterMutation();
      renderCharactersTab();
      setStatus('새 인연 추가 완료', 'ok');
    } catch (e) { setStatus(e.message, 'error'); }
  }

  function renderCharactersTab() {
    try {
      renderCharacterList();
      renderCharacterDetail();
      updateTopBadges();
    } catch (e) { setStatus(e.message, 'error'); }
  }

  function cell(tag, value, attrs) {
    return el(tag, attrs || {}, [value == null ? '' : String(value)]);
  }

  function renderWorldTab() {
    var rows = [];
    state.session.getFactions({ query: $('faction-search-input').value }).forEach(function (f) {
      var cb = el('input', { type: 'checkbox' });
      cb.checked = !!f.IsDiscovered;
      var fame = el('input', { type: 'number', min: '-100', max: '100', step: '1', value: String(f.playerFame) });
      var btn = el('button', { type: 'button', class: 'btn' }, ['적용']);
      btn.addEventListener('click', function () {
        if (!guardNotBusy()) return;
        try {
          state.session.setFactionFame(f.uid, Number(fame.value) || 0, !!cb.checked);
          renderWorldTab(); syncAfterMutation(); setStatus('문파 우호도 적용 완료', 'ok');
        } catch (e) { setStatus(e.message, 'error'); }
      });
      rows.push(el('tr', null, [
        cell('td', f.koName + ' (' + f.zhName + ') #' + f.uid),
        el('td', null, [cb, fame]),
        el('td', null, [btn])
      ]));
    });
    var ftb = $('factions-tbody');
    clearEl(ftb);
    rows.forEach(function (r) { ftb.appendChild(r); });

    var cards = state.session.getFiefBuildings().map(function (b) {
      var lv = el('input', { type: 'number', min: '0', max: String(b.maxLevel || 5), step: '1', value: String(b.level) });
      var btn = el('button', { type: 'button', class: 'btn' }, ['적용']);
      btn.addEventListener('click', function () {
        if (!guardNotBusy()) return;
        try {
          state.session.setFiefBuildingLevel(b.saveId, Number(lv.value) || 0);
          renderWorldTab(); syncAfterMutation(); setStatus('가원 건물 레벨 적용 완료', 'ok');
        } catch (e) { setStatus(e.message, 'error'); }
      });
      return el('div', { class: 'card' }, [
        cell('div', b.koName + ' (' + b.zhName + ')'),
        el('label', null, ['레벨 ', lv]),
        btn
      ]);
    });
    var fg = $('fief-buildings-grid');
    clearEl(fg);
    cards.forEach(function (c) { fg.appendChild(c); });

    var p = state.session.getPagoda();
    $('pagoda-cur-stage').value = String(p.CurStage || 0);
    $('pagoda-cur-score').value = String(p.CurScore || 0);
    $('pagoda-best-stage').value = String(p.HistoryBestStage || 0);
    $('pagoda-best-score').value = String(p.HistoryBestScore || 0);

    var g = state.session.getGameTime();
    $('time-year').value = String(g.Year || 0);
    $('time-month').value = String(g.Month || 0);
    $('time-day').value = String(g.Day || 0);
    $('time-dhour').value = String(g.Dhour || 0);
    $('time-quarter').value = String(g.Quarter || 0);
  }

  function maxDiscoveredFactions() {
    if (!guardNotBusy()) return;
    try {
      state.session.getFactions({}).forEach(function (f) {
        if (f.IsDiscovered) state.session.setFactionFame(f.uid, 100, true);
      });
      renderWorldTab(); syncAfterMutation(); setStatus('발견 문파 우호도 100 적용 완료', 'ok');
    } catch (e) { setStatus(e.message, 'error'); }
  }

  function maxAllFiefBuildings() {
    if (!guardNotBusy()) return;
    try {
      state.session.getFiefBuildings().forEach(function (b) {
        state.session.setFiefBuildingLevel(b.saveId, b.maxLevel || 5);
      });
      renderWorldTab(); syncAfterMutation(); setStatus('가원 7대 건물 5레벨 적용 완료', 'ok');
    } catch (e) { setStatus(e.message, 'error'); }
  }

  function renderReferenceTab() {
    var rea = (state.session.catalog && state.session.catalog.reaReference) || {};
    function kvCard(title, obj) {
      var rows = Object.keys(obj || {}).map(function (k) {
        var v = obj[k];
        return el('div', { class: 'rea-row' }, [
          el('code', null, [k]),
          ' : ',
          cell('span', typeof v === 'object' ? JSON.stringify(v) : v)
        ]);
      });
      return el('div', { class: 'card' }, [cell('h3', title)].concat(rows));
    }
    var rc = $('rea-reference-cards');
    clearEl(rc);
    rc.appendChild(kvCard('전투/피해 공식', rea.combat_and_damage && rea.combat_and_damage.formulas));
    rc.appendChild(kvCard('사회/관계 임계값', rea.social_and_relation_thresholds));
    renderAcupoints();
    renderRawViewer();
  }

  function renderAcupoints() {
    var list = state.session.searchAcupoints($('acupoint-search-input').value, $('acupoint-meridian-select').value);
    var rows = list.map(function (a) {
      var copy = el('button', { type: 'button', class: 'btn' }, ['복사']);
      copy.addEventListener('click', function () {
        try { if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(a.uName); } catch (e) {}
      });
      var mk = (typeof MERIDIAN_KO !== 'undefined' && MERIDIAN_KO[a.meridianKey]) || a.meridianKo;
      return el('tr', null, [
        cell('td', a.uName),
        cell('td', mk),
        cell('td', a.acupointType === 'big' ? '대혈' : '소혈'),
        cell('td', a.effectKo),
        el('td', null, [copy])
      ]);
    });
    var atb = $('acupoint-tbody');
    clearEl(atb);
    rows.forEach(function (r) { atb.appendChild(r); });
  }

  function renderRawViewer() {
    var sel = $('raw-file-select'), prev = sel.value;
    var files = state.session.listLoadedFiles() || [];
    var opts = [el('option', { value: '' }, ['파일 선택'])];
    files.forEach(function (f) {
      var kind = typeof f === 'string' ? f : f.kind;
      var label = typeof f === 'string' ? f : (f.fileName || f.kind);
      opts.push(el('option', { value: kind }, [label]));
    });
    clearEl(sel);
    opts.forEach(function (o) { sel.appendChild(o); });
    if (prev && files.some(function (f) { return (typeof f === 'string' ? f : f.kind) === prev; })) sel.value = prev;
    else if (files.length) sel.value = typeof files[0] === 'string' ? files[0] : files[0].kind;
    var ta = $('raw-json-textarea');
    if (!sel.value) { ta.value = 'Raw 파일을 선택하세요.'; return; }
    try { ta.value = state.session.getRawFileText(sel.value) || ''; }
    catch (e) { ta.value = 'Raw 파일을 읽을 수 없습니다.'; }
  }

  function renderAll() {
    renderSummaryTab();
    renderCurrencyTab();
    renderInventoryTab();
    renderCharactersTab();
    renderWorldTab();
    renderReferenceTab();
    updateTopBadges();
  }

  function bind(id, ev, fn) { var n = $(id); if (n) n.addEventListener(ev, fn); }
  function bindSearch(id, fn) {
    var n = $(id); if (!n) return;
    ['input', 'change'].forEach(function (ev) {
      n.addEventListener(ev, function (e) { if (!e.isComposing) fn(); });
    });
    if (typeof onEnterKey === 'function') onEnterKey(n, function (e) { if (!e || !e.isComposing) fn(); });
  }

  function init() {
    populateStaticSelects(); initTabs(); initNativeBridge(); initBeforeUnload();
    bind('btn-connect-dir', 'click', connectDirectoryPicker);
    bind('btn-open-folder', 'click', function () { $('folder-input').click(); });
    function onFileInputChange(e) {
      var picked = Array.prototype.slice.call((e && e.target && e.target.files) || []);
      if (e && e.target) e.target.value = '';
      if (picked.length) readBrowserFileInputs(picked);
    }
    bind('folder-input', 'change', onFileInputChange);
    bind('btn-open-files', 'click', function () { $('file-input').click(); });
    bind('file-input', 'change', onFileInputChange);
    bind('btn-load-demo', 'click', loadDemoSlot);
    bind('btn-native-open-slot', 'click', nativeOpenSlot);
    bind('btn-native-open-files', 'click', nativeOpenFiles);
    bind('btn-native-save', 'click', nativeSaveModified);
    bind('btn-export-modified', 'click', function () { exportFilesFlow(false); });
    bind('btn-export-all', 'click', function () { exportFilesFlow(true); });
    bind('btn-reset-all', 'click', function () { if (!guardNotBusy()) return; state.session.resetAll(); renderAll(); });
    bind('btn-toggle-password', 'click', function () {
      var p = $('password-input');
      if (!p) return;
      var show = p.type === 'password';
      p.type = show ? 'text' : 'password';
      $('btn-toggle-password').setAttribute('aria-pressed', show ? 'true' : 'false');
    });

    ['dragenter', 'dragover'].forEach(function (ev) {
      document.addEventListener(ev, function (e) { e.preventDefault(); document.body.classList.add('dragging'); });
    });
    ['dragleave', 'drop'].forEach(function (ev) {
      document.addEventListener(ev, function (e) { e.preventDefault(); document.body.classList.remove('dragging'); });
    });
    document.addEventListener('drop', function (e) {
      if (e.dataTransfer && e.dataTransfer.files) readBrowserFileInputs(e.dataTransfer.files);
    });

    bindSearch('inv-search-input', renderOwnedInventory);
    bind('inv-cat-select', 'change', renderOwnedInventory);
    bindSearch('cat-item-search', renderCatalogItems);
    bind('cat-item-category', 'change', renderCatalogItems);
    bind('cat-item-rarity', 'change', renderCatalogItems);
    bind('char-filter-select', 'change', renderCharactersTab);
    bindSearch('char-search-input', renderCharactersTab);
    var bar = $('char-prop-group-bar');
    if (bar) bar.addEventListener('click', function (e) {
      var t = e.target.closest && e.target.closest('[data-prop-group]');
      if (!t) return;
      Array.prototype.forEach.call(bar.querySelectorAll('[data-prop-group]'), function (x) {
        x.classList.toggle('active', x === t);
      });
      state.selectedPropGroup = t.dataset.propGroup;
      renderCharacterDetail();
    });
    bind('btn-apply-char-basic', 'click', applyCharacterBasic);
    bind('btn-max-all-kungfu', 'click', maxSelectedCharKungfu);
    bindSearch('cat-kf-search', renderCatalogKungfu);
    bind('cat-kf-type', 'change', renderCatalogKungfu);
    bind('cat-kf-rarity', 'change', renderCatalogKungfu);
    bindSearch('cat-trait-search', renderCatalogTraits);
    bind('cat-trait-rarity', 'change', renderCatalogTraits);
    bind('btn-max-all-relations', 'click', maxSelectedCharRelations);
    bind('btn-add-relation', 'click', addNewCharacterRelation);
    bindSearch('faction-search-input', renderWorldTab);
    bind('btn-max-factions', 'click', maxDiscoveredFactions);
    bind('btn-fief-max-all', 'click', maxAllFiefBuildings);
    bind('btn-apply-pagoda', 'click', function () {
      if (!guardNotBusy()) return;
      try {
        state.session.setPagoda({
          CurStage: Number($('pagoda-cur-stage').value) || 0,
          CurScore: Number($('pagoda-cur-score').value) || 0,
          HistoryBestStage: Number($('pagoda-best-stage').value) || 0,
          HistoryBestScore: Number($('pagoda-best-score').value) || 0
        });
        renderWorldTab(); syncAfterMutation();
        setStatus('적용 완료', 'ok');
      } catch (e) {
        setStatus(e.message, 'error');
      }
    });
    bind('btn-apply-time', 'click', function () {
      if (!guardNotBusy()) return;
      try {
        state.session.setGameTime({
          Year: Number($('time-year').value) || 0,
          Month: Number($('time-month').value) || 0,
          Day: Number($('time-day').value) || 0,
          Dhour: Number($('time-dhour').value) || 0,
          Quarter: Number($('time-quarter').value) || 0
        });
        renderWorldTab(); syncAfterMutation();
        setStatus('적용 완료', 'ok');
      } catch (e) {
        setStatus(e.message, 'error');
      }
    });
    bindSearch('acupoint-search-input', renderAcupoints);
    bind('acupoint-meridian-select', 'change', renderAcupoints);
    bind('raw-file-select', 'change', renderRawViewer);
    bind('btn-raw-refresh', 'click', renderRawViewer);
    bind('btn-raw-copy', 'click', function () {
      try { if (navigator.clipboard) navigator.clipboard.writeText($('raw-json-textarea').value); } catch (e) {}
    });
    bind('btn-raw-download', 'click', function () {
      var kind = $('raw-file-select').value || 'raw.json';
      if (kind.slice(-5) !== '.json') kind += '.json';
      downloadBytes(new TextEncoder().encode($('raw-json-textarea').value), kind);
    });

    renderAll();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})(typeof globalThis !== 'undefined' ? globalThis : window);
