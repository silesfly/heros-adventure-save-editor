// FILE: src/editor-core.js
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(
      require('./es3-codec.js'),
      (function () { try { return require('./catalog-data.js'); } catch (e) { return null; } })()
    );
  } else {
    root.HerosAdventureEditorCore = factory(
      root.HerosAdventureEs3Codec,
      root.HerosAdventureCatalog || null
    );
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (Codec, DefaultCatalog) {
  'use strict';
  if (!Codec) throw new Error('HerosAdventureEs3Codec is required');

  var C = Codec;
  var isObj = C.isEs3Object;
  var isNum = C.isEs3Number;
  var makeObj = C.makeObj;
  var makeNum = C.makeNum;
  var objGet = C.objGet;
  var objHas = C.objHas;
  var objSet = C.objSet;
  var objDelete = C.objDelete;
  var objEntries = C.objEntries;
  var numToFloat = C.numToFloat;
  var numToIntString = C.numToIntString;
  var parseEs3Json = C.parseEs3Json;
  var stringifyEs3Json = C.stringifyEs3Json;

  var CATALOG_CACHE = (typeof WeakMap !== 'undefined') ? new WeakMap() : null;

  function isCatalogObject(v) {
    return v !== null && (typeof v === 'object' || typeof v === 'function');
  }
  function isCatalogArray(v) {
    return Object.prototype.toString.call(v) === '[object Array]';
  }
  function asArray(v) {
    if (!v) return [];
    if (isCatalogArray(v)) return v;
    if (typeof v === 'object') {
      var arr = [];
      var keys = Object.keys(v);
      for (var i = 0; i < keys.length; i++) arr.push(v[keys[i]]);
      return arr;
    }
    return [];
  }
  function asNumber(v, fallback) {
    if (v === null || v === undefined || v === '') return fallback;
    var n = Number(v);
    return isFinite(n) ? n : fallback;
  }
  function asString(v, fallback) {
    if (v === null || v === undefined) return fallback;
    return String(v);
  }
  function pickName(ko, zh) {
    var k = asString(ko, '');
    var z = asString(zh, '');
    if ((k === '없음' || k === '') && z) return z;
    return k;
  }

  function currencyFallback() {
    return [
      { id: 0, key: 'Coin', ko: '동전 (문, 1000문=1관)', zh: '铜钱', max: 999999999 },
      { id: 1, key: 'Gold', ko: '금원보', zh: '金元宝', max: 99999999 },
      { id: 2, key: 'FTributePoint', ko: '문파 공헌도', zh: '门派贡献', max: 99999999 },
      { id: 3, key: 'PagodaCoin', ko: '통천탑 화폐', zh: '通天塔币', max: 99999999 },
      { id: 4, key: 'SLGCoin', ko: '화외지경 군자금 (DLC1)', zh: 'SLG资金', max: 99999999 },
      { id: 5, key: 'SLGTribute', ko: '화외지경 공적 (DLC1)', zh: 'SLG功绩', max: 99999999 },
      { id: 6, key: 'SLGFood', ko: '화외지경 군량 (DLC1)', zh: 'SLG粮草', max: 99999999 },
      { id: 7, key: 'SLGMine', ko: '화외지경 광석 (DLC1)', zh: 'SLG矿石', max: 99999999 },
      { id: 8, key: 'SLGDrug', ko: '화외지경 약재 (DLC1)', zh: 'SLG药材', max: 99999999 },
      { id: 9, key: 'SLGWood', ko: '화외지경 목재 (DLC1)', zh: 'SLG木材', max: 99999999 }
    ];
  }

  function fiefBuildingFallback() {
    return [
      { saveId: 112, uid: 0, ko: '화청천', zh: '华清泉', maxLevel: 5 },
      { saveId: 104, uid: 1, ko: '천공방', zh: '天工坊', maxLevel: 5 },
      { saveId: 110, uid: 2, ko: '약선방', zh: '药膳坊', maxLevel: 5 },
      { saveId: 113, uid: 3, ko: '뒷산', zh: '后山', maxLevel: 5 },
      { saveId: 114, uid: 4, ko: '오도비', zh: '悟道碑', maxLevel: 5 },
      { saveId: 102, uid: 5, ko: '진보각', zh: '珍宝阁', maxLevel: 5 },
      { saveId: 98, uid: 6, ko: '정방', zh: '正房', maxLevel: 5 }
    ];
  }

  function normalizeCurrencies(raw) {
    var arr = asArray(raw);
    if (!arr.length) arr = currencyFallback();
    var out = [];
    for (var i = 0; i < arr.length; i++) {
      var c = arr[i] || {};
      out.push({
        id: asNumber(c.id !== undefined ? c.id : i, i),
        key: asString(c.key, ''),
        ko: asString(c.ko, ''),
        zh: asString(c.zh, ''),
        koName: asString(c.koName || c.ko || '', ''),
        zhName: asString(c.zhName || c.zh || '', ''),
        max: asNumber(c.max, 999999999)
      });
    }
    return out;
  }

  function normalizeFiefBuildings(raw) {
    var arr = asArray(raw);
    if (!arr.length) arr = fiefBuildingFallback();
    var out = [];
    for (var i = 0; i < arr.length; i++) {
      var b = arr[i] || {};
      out.push({
        saveId: asNumber(b.saveId, 0),
        uid: asNumber(b.uid, 0),
        ko: asString(b.ko, ''),
        zh: asString(b.zh, ''),
        koName: asString(b.koName || b.ko || '', ''),
        zhName: asString(b.zhName || b.zh || '', ''),
        maxLevel: asNumber(b.maxLevel, 5)
      });
    }
    return out;
  }

  function normalizeItems(raw) {
    var arr = asArray(raw);
    if (raw && typeof raw === 'object' && !isCatalogArray(raw) && raw.itemList && isCatalogArray(raw.itemList)) arr = raw.itemList;
    var out = [];
    for (var i = 0; i < arr.length; i++) {
      var it = arr[i];
      if (isCatalogArray(it)) {
        out.push({
          uid: asNumber(it[0], 0),
          koName: asString(it[1], ''),
          zhName: asString(it[2], ''),
          rarity: asNumber(it[3], 0),
          category: asString(it[4], 'misc') || 'misc',
          stackable: asNumber(it[5], 0),
          price: asNumber(it[6], 0)
        });
      } else if (it && typeof it === 'object') {
        var uid = it.uid !== undefined ? it.uid : it.id;
        out.push({
          uid: asNumber(uid, 0),
          koName: asString(it.koName || it.ko || '', ''),
          zhName: asString(it.zhName || it.zh || '', ''),
          rarity: asNumber(it.rarity, 0),
          category: asString(it.category || it.categoryKey || 'misc', 'misc') || 'misc',
          stackable: asNumber(it.stackable, 0),
          price: asNumber(it.price, 0)
        });
      }
    }
    return out;
  }

  function normalizeKungfu(raw) {
    var arr = asArray(raw);
    if (raw && typeof raw === 'object' && !isCatalogArray(raw) && raw.kungfuList && isCatalogArray(raw.kungfuList)) arr = raw.kungfuList;
    var out = [];
    for (var i = 0; i < arr.length; i++) {
      var k = arr[i];
      if (isCatalogArray(k)) {
        out.push({
          uid: asNumber(k[0], 0),
          koName: asString(k[1], ''),
          zhName: asString(k[2], ''),
          rarity: asNumber(k[3], 0),
          kungfuType: asNumber(k[4], 0),
          maxLevel: asNumber(k[5], 10),
          displayed: k[6] !== undefined ? asNumber(k[6], 1) : 1
        });
      } else if (k && typeof k === 'object') {
        out.push({
          uid: asNumber(k.uid !== undefined ? k.uid : k.id, 0),
          koName: asString(k.koName || k.ko || '', ''),
          zhName: asString(k.zhName || k.zh || '', ''),
          rarity: asNumber(k.rarity, 0),
          kungfuType: asNumber(k.kungfuType, 0),
          maxLevel: asNumber(k.maxLevel, 10),
          displayed: k.displayed !== undefined ? asNumber(k.displayed, 1) : 1
        });
      }
    }
    return out;
  }

  function normalizeTraits(raw) {
    var arr = asArray(raw);
    if (raw && typeof raw === 'object' && !isCatalogArray(raw) && raw.traitList && isCatalogArray(raw.traitList)) arr = raw.traitList;
    var out = [];
    for (var i = 0; i < arr.length; i++) {
      var t = arr[i];
      if (isCatalogArray(t)) {
        out.push({
          uid: asNumber(t[0], 0),
          koName: asString(t[1], ''),
          zhName: asString(t[2], ''),
          rarity: asNumber(t[3], 0),
          traitType: asNumber(t[4], 0),
          desc: asString(t[5], '')
        });
      } else if (t && typeof t === 'object') {
        out.push({
          uid: asNumber(t.uid !== undefined ? t.uid : t.id, 0),
          koName: asString(t.koName || t.ko || '', ''),
          zhName: asString(t.zhName || t.zh || '', ''),
          rarity: asNumber(t.rarity, 0),
          traitType: asNumber(t.traitType, 0),
          desc: asString(t.desc, '')
        });
      }
    }
    return out;
  }

  function normalizeFactions(raw) {
    var arr = asArray(raw);
    if (raw && typeof raw === 'object' && !isCatalogArray(raw) && raw.factionList && isCatalogArray(raw.factionList)) arr = raw.factionList;
    var out = [];
    for (var i = 0; i < arr.length; i++) {
      var f = arr[i];
      if (isCatalogArray(f)) {
        var ko = asString(f[1], '');
        var zh = asString(f[2], '');
        out.push({
          uid: asNumber(f[0], 0),
          koName: pickName(ko, zh),
          zhName: zh,
          canRest: asNumber(f[3], 0)
        });
      } else if (f && typeof f === 'object') {
        var ko2 = asString(f.koName || f.ko || '', '');
        var zh2 = asString(f.zhName || f.zh || '', '');
        out.push({
          uid: asNumber(f.uid !== undefined ? f.uid : f.id, 0),
          koName: pickName(ko2, zh2),
          zhName: zh2,
          canRest: asNumber(f.canRest, 0)
        });
      }
    }
    return out;
  }

  function normalizeCharacters(raw) {
    var out = [];
    if (!raw) return out;

    if (isCatalogArray(raw)) {
      for (var i = 0; i < raw.length; i++) {
        var c = raw[i];
        if (isCatalogArray(c)) {
          var ko = asString(c[1], '');
          var zh = asString(c[2], '');
          out.push({
            uid: asNumber(c[0], 0),
            koName: pickName(ko, zh),
            zhName: zh
          });
        } else if (c && typeof c === 'object') {
          var ko2 = asString(c.koName || c.ko || '', '');
          var zh2 = asString(c.zhName || c.zh || '', '');
          out.push({
            uid: asNumber(c.uid !== undefined ? c.uid : c.id, 0),
            koName: pickName(ko2, zh2),
            zhName: zh2
          });
        }
      }
      return out;
    }

    if (typeof raw === 'object') {
      if (raw.characterList && isCatalogArray(raw.characterList)) {
        return normalizeCharacters(raw.characterList);
      }
      var keys = Object.keys(raw);
      for (var j = 0; j < keys.length; j++) {
        var key = keys[j];
        var v = raw[key];
        if (isCatalogArray(v)) {
          var ko3 = asString(v[0], '');
          var zh3 = asString(v[1], '');
          out.push({
            uid: asNumber(key, 0),
            koName: pickName(ko3, zh3),
            zhName: zh3
          });
        } else if (v && typeof v === 'object') {
          var ko4 = asString(v.koName || v.ko || '', '');
          var zh4 = asString(v.zhName || v.zh || '', '');
          out.push({
            uid: asNumber(key, 0),
            koName: pickName(ko4, zh4),
            zhName: zh4
          });
        }
      }
    }
    return out;
  }

  function normalizeAcupoints(raw) {
    var arr = asArray(raw);
    if (raw && typeof raw === 'object' && !isCatalogArray(raw) && raw.acupointList && isCatalogArray(raw.acupointList)) arr = raw.acupointList;
    var out = [];
    for (var i = 0; i < arr.length; i++) {
      var a = arr[i];
      if (isCatalogArray(a)) {
        out.push({
          idx: asNumber(a[0], 0),
          uName: asString(a[1], ''),
          meridianKey: asString(a[2], ''),
          meridianKo: asString(a[3], ''),
          acupointType: asString(a[4], ''),
          effectKo: asString(a[5], '')
        });
      } else if (a && typeof a === 'object') {
        out.push({
          idx: asNumber(a.idx, 0),
          uName: asString(a.uName, ''),
          meridianKey: asString(a.meridianKey, ''),
          meridianKo: asString(a.meridianKo, ''),
          acupointType: asString(a.acupointType, ''),
          effectKo: asString(a.effectKo, '')
        });
      }
    }
    return out;
  }

  var DEFAULT_LIFE_SKILL_PROPS = [
    ['能力_采集_采矿', '채광 (채집)'],
    ['能力_采集_伐木', '벌목 (채집)'],
    ['能力_采集_采药', '채약 (채집)'],
    ['能力_采集_钓鱼', '낚시 (채집)'],
    ['能力_采集_捉虫', '곤충 채집 (채집)'],
    ['能力_制造_兵器', '병기 단조 (제조)'],
    ['能力_制造_护甲', '갑옷 재봉 (제조)'],
    ['能力_制造_饰品', '장신구 세공 (제조)'],
    ['能力_制造_食物', '조리 (제조)'],
    ['能力_制造_丹药', '연단 (제조)'],
    ['能力_制造_合成', '조합·합성 (제조)'],
    ['能力_鉴定_字画', '서화 감정'],
    ['能力_鉴定_书籍', '서적 감정'],
    ['能力_鉴定_古董', '골동품 감정'],
    ['能力_鉴定_饰品', '장신구 감정'],
    ['能力_鉴定_丹药', '단약 감정'],
    ['能力_市井_暗取', '암취·소매치기 (시정)'],
    ['能力_市井_点穴', '점혈 (시정)'],
    ['能力_市井_下毒', '하독 (시정)'],
    ['能力_市井_机关', '기관 해체 (시정)'],
    ['能力_市井_突袭', '기습 (시정)'],
    ['能力_生存_口才', '구변·화술 (생존)'],
    ['能力_生存_经商', '상술·경상 (생존)'],
    ['能力_生存_探索', '탐색 (생존)'],
    ['能力_生存_识图', '지도 해독·식도 (생존)'],
    ['能力_生存_驯兽', '영수 조련 (생존)']
  ];
  var DEFAULT_LIFE_SKILL_KEYS = DEFAULT_LIFE_SKILL_PROPS.map(function (p) { return p[0]; });

  function propFallback(key, ko, min, max) {
    return { key: key, ko: ko, min: min, max: max };
  }

  function normalizeCharacterProps(raw) {
    var r = (raw && typeof raw === 'object') ? raw : {};
    var out = {};

    function normPropList(list, fallback) {
      var arr = asArray(list);
      if (!arr.length) arr = fallback;
      var res = [];
      for (var i = 0; i < arr.length; i++) {
        var p = arr[i] || {};
        res.push({
          key: asString(p.key, ''),
          ko: asString(p.ko, ''),
          min: asNumber(p.min, 0),
          max: asNumber(p.max, 0)
        });
      }
      return res;
    }

    out.core = normPropList(r.core, [
      propFallback('臂力', '비력 (근력)', -50, 999),
      propFallback('体质', '체질', -50, 999),
      propFallback('敏捷', '민첩', -50, 999),
      propFallback('悟性', '오성 (깨달음)', -50, 999),
      propFallback('福缘', '복원 (행운)', -50, 999)
    ]);

    out.combat = normPropList(r.combat, [
      propFallback('生命', '기본 생명력', 1, 999999),
      propFallback('内力', '기본 내력', 0, 999999),
      propFallback('攻击', '기본 공격', 0, 99999),
      propFallback('防御', '기본 방어', 0, 99999),
      propFallback('轻功', '경공', 0, 99999),
      propFallback('实战能力', '실전 능력', 0, 99999),
      propFallback('武学常识', '무학 상식', 0, 99999),
      propFallback('冲穴点数', '경맥 충혈 점수', 0, 9999),
      propFallback('资质点数', '자질 분배 점수', 0, 9999),
      propFallback('江湖历练', '강호 역련 (무공 수련 경험)', 0, 99999999),
      propFallback('名声级别', '명성 등급', 0, 20),
      propFallback('名声经验', '명성 경험치', 0, 9999999)
    ]);

    out.weapons = normPropList(r.weapons, [
      propFallback('拳掌', '권장 (맨손)', 0, 9999),
      propFallback('御剑', '어검 (검법)', 0, 9999),
      propFallback('耍刀', '도법', 0, 9999),
      propFallback('长兵', '장병 (창·곤)', 0, 9999),
      propFallback('短兵', '단병 (단검·부채·필)', 0, 9999),
      propFallback('乐器', '음률 (금·소·비파)', 0, 9999),
      propFallback('暗器', '암기', 0, 9999),
      propFallback('医术', '의술', 0, 9999),
      propFallback('毒术', '독술', 0, 9999)
    ]);

    out.moral = normPropList(r.moral, [
      propFallback('仁德', '인덕', -100, 999),
      propFallback('义气', '의기', -100, 999),
      propFallback('礼节', '예절', -100, 999),
      propFallback('智慧', '지혜', -100, 999),
      propFallback('信用', '신용', -100, 999),
      propFallback('勇气', '용기', -100, 999)
    ]);

    var abilityFallback = [];
    for (var ai = 0; ai < DEFAULT_LIFE_SKILL_PROPS.length; ai++) {
      abilityFallback.push(propFallback(DEFAULT_LIFE_SKILL_PROPS[ai][0], DEFAULT_LIFE_SKILL_PROPS[ai][1], 0, 5));
    }
    out.abilities = normPropList(r.abilities, abilityFallback);

    return out;
  }

  function normalizeCatalog(rawCatalog) {
    var raw = rawCatalog;
    if (raw === undefined || raw === null) raw = DefaultCatalog || {};

    if (isCatalogObject(raw) && raw.__normalized === true) return raw;

    if (CATALOG_CACHE && isCatalogObject(raw)) {
      var cached = CATALOG_CACHE.get(raw);
      if (cached) return cached;
    }

    var src = (raw && typeof raw === 'object') ? raw : {};
    var n = {};

    n.currencies = normalizeCurrencies(src.currencies);
    n.fiefBuildings = normalizeFiefBuildings(src.fiefBuildings);

    n.itemList = normalizeItems(src.itemList || src.items);
    n.kungfuList = normalizeKungfu(src.kungfuList || src.kungfu);
    n.traitList = normalizeTraits(src.traitList || src.traits);
    n.factionList = normalizeFactions(src.factionList || src.factions);
    n.characterList = normalizeCharacters(src.characterList || src.characters);
    n.acupointList = normalizeAcupoints(src.acupointList || src.acupoints);

    n.items = n.itemList;
    n.kungfu = n.kungfuList;
    n.traits = n.traitList;
    n.factions = n.factionList;
    n.characters = n.characterList;
    n.acupoints = n.acupointList;

    n.characterProps = normalizeCharacterProps(src.characterProps);

    n.game = src.game || {};
    n.rarities = src.rarities || [];
    n.itemCategories = src.itemCategories || [];
    n.teamProps = ((Array.isArray(src.teamProps) && src.teamProps.length > 0) ||
      (src.teamProps !== null && typeof src.teamProps === 'object' && !Array.isArray(src.teamProps) && Object.keys(src.teamProps).length > 0))
      ? src.teamProps
      : [
        { key: '队伍体力', ko: '파티 행동 체력', min: 0, max: 999 },
        { key: '队伍心情', ko: '파티 기분', min: 0, max: 100 }
      ];
    n.reaReference = src.reaReference || {};

    n.__normalized = true;

    if (CATALOG_CACHE && isCatalogObject(raw)) CATALOG_CACHE.set(raw, n);
    return n;
  }

  function validateSafeInteger(input, min, max, label) {
    var lbl = label || '값';
    if (input === null || input === undefined) throw new Error(lbl + ': 값이 없습니다.');
    if (typeof input === 'string') {
      var s = input.trim();
      if (s === '') throw new Error(lbl + ': 빈 문자열은 허용되지 않습니다.');
      if (/[eE]/.test(s)) throw new Error(lbl + ': 지수 표기는 허용되지 않습니다. (' + s + ')');
      if (!/^-?[0-9]+$/.test(s)) throw new Error(lbl + ': 정수만 허용됩니다. (' + s + ')');
      input = Number(s);
    } else if (typeof input === 'number') {
      if (typeof input === 'bigint') input = Number(input);
    } else {
      throw new Error(lbl + ': 숫자 또는 숫자 문자열이어야 합니다. (' + String(input) + ')');
    }
    if (typeof input !== 'number' || !isFinite(input) || Math.floor(input) !== input || !Number.isSafeInteger(input)) {
      throw new Error(lbl + ': 유한한 정수여야 합니다. (' + String(input) + ')');
    }
    if (input < min || input > max) {
      throw new RangeError(lbl + ': 범위를 벗어났습니다. (' + min + ' ~ ' + max + '), 입력=' + input);
    }
    return input;
  }

  function idToStr(v) {
    if (v === null || v === undefined) return '';
    if (isNum(v)) return v.raw;
    if (typeof v === 'string') return v;
    if (typeof v === 'number') return String(v);
    return String(v);
  }
  function readNumField(obj, key, fallback) {
    if (!isObj(obj)) return fallback === undefined ? 0 : fallback;
    var v = objGet(obj, key);
    if (v === undefined) return fallback === undefined ? 0 : fallback;
    if (isNum(v)) {
      var f = parseFloat(v.raw);
      return isFinite(f) ? f : (fallback === undefined ? 0 : fallback);
    }
    if (typeof v === 'number') return v;
    if (typeof v === 'string') { var f2 = parseFloat(v); return isFinite(f2) ? f2 : (fallback === undefined ? 0 : fallback); }
    return fallback === undefined ? 0 : fallback;
  }
  function readStrField(obj, key, fallback) {
    if (!isObj(obj)) return fallback === undefined ? '' : fallback;
    var v = objGet(obj, key);
    if (typeof v === 'string') return v;
    return fallback === undefined ? '' : fallback;
  }
  function readBoolField(obj, key, fallback) {
    if (!isObj(obj)) return !!fallback;
    var v = objGet(obj, key);
    if (typeof v === 'boolean') return v;
    return !!fallback;
  }

  var CANONICAL_ROLE_FILENAMES = {
    saveInfo: 'saveinfo.save',
    playerTeam: 'saveobjectplayerteam.save',
    characters: 'saveobjectgamecharacter.save',
    factions: 'saveobjectfaction.save',
    global: 'saveobjectgameglobal.save',
    time: 'saveobjectgametime.save',
    pagoda: 'saveobjectpagoda.save',
    game: 'saveobjectgame.save'
  };

  var CANONICAL_BASENAME_TO_ROLE = Object.create(null);
  (function () {
    var roles = Object.keys(CANONICAL_ROLE_FILENAMES);
    for (var i = 0; i < roles.length; i++) {
      var role = roles[i];
      CANONICAL_BASENAME_TO_ROLE[String(CANONICAL_ROLE_FILENAMES[role]).toLowerCase()] = role;
    }
  }());

  function basenameLower(nameOrPath) {
    var s = String(nameOrPath || '');
    var i = s.lastIndexOf('/');
    var j = s.lastIndexOf('\\');
    if (j > i) i = j;
    return (i >= 0 ? s.slice(i + 1) : s).toLowerCase();
  }

  function canonicalRoleFromPath(nameOrPath) {
    return CANONICAL_BASENAME_TO_ROLE[basenameLower(nameOrPath)] || null;
  }

  function cloneBytes(b) {
    if (b === null || b === undefined) return new Uint8Array(0);
    var tag = Object.prototype.toString.call(b);
    if (tag === '[object ArrayBuffer]' || tag === '[object SharedArrayBuffer]') {
      var out = new Uint8Array(b.byteLength); out.set(new Uint8Array(b)); return out;
    }
    if (ArrayBuffer.isView(b)) {
      var viewOut = new Uint8Array(b.byteLength); viewOut.set(new Uint8Array(b.buffer, b.byteOffset, b.byteLength)); return viewOut;
    }
    if (Array.isArray(b)) {
      for (var i = 0; i < b.length; i++) if (typeof b[i] !== 'number' || !isFinite(b[i])) throw new TypeError('지원하지 않는 바이트 입력 형식입니다.');
      return new Uint8Array(b);
    }
    throw new TypeError('지원하지 않는 바이트 입력 형식입니다.');
  }

  var NEXT_SESSION_SEQ = 0;

  function SlotSession(catalog) {
    this.catalog = normalizeCatalog(catalog === undefined || catalog === null ? (DefaultCatalog || {}) : catalog);
    this.files = Object.create(null);
    this.roleOrder = ['playerTeam', 'characters', 'factions', 'game', 'global', 'time', 'pagoda', 'saveInfo'];
    this.changeLog = [];
    this._undoStack = [];
    this.password = 'Meow';
    this._sessionId = 'sess-' + (++NEXT_SESSION_SEQ);
    this._loadGeneration = 0;
    this._loadToken = null;
    this.ambiguousRoles = Object.create(null);
    this.brokenRoles = Object.create(null);
    this._buildLookups();
  }

  SlotSession.prototype._log = function (action, detail) {
    this.changeLog.push({ action: action, detail: detail || {}, at: Date.now() });
  };

  SlotSession.prototype._assertRoleWritable = function (role) {
    if (role && this.ambiguousRoles && this.ambiguousRoles[role]) {
      throw new Error('동일 역할(' + role + ')의 중복 세이브 파일이 모호하여 수정할 수 없습니다.');
    }
    if (role && this.files && this.files[role] && this.files[role].typeMismatchError) {
      throw new Error('역할(' + role + ')의 정식 세이브 파일이 손상되어 수정할 수 없습니다: ' + this.files[role].typeMismatchError);
    }
    if (role && ((this.brokenRoles && this.brokenRoles[role]) || (this.files && this.files[role] && this.files[role].originalParseFailed))) {
      throw new Error('역할(' + role + ')의 정식 세이브 파일이 손상되어 수정할 수 없습니다.');
    }
  };

  SlotSession.prototype._assertCharactersWritable = function () {
    this._assertRoleWritable('characters');
    var r = this._charactersFileRole();
    this._assertRoleWritable(r);
    return r;
  };

  SlotSession.prototype._markDirty = function (role) {
    this._assertRoleWritable(role);
    var f = this.files[role];
    if (f) {
      f.dirty = true;
      f.revision = (f.revision || 0) + 1;
    }
  };

  SlotSession.prototype._fileKeyOf = function (name, role) {
    if (role && role !== 'other' && role !== 'saveInfo') return role;
    if (role === 'saveInfo') return 'saveInfo';
    return 'file:' + name;
  };

  SlotSession.prototype._findFileEntry = function (kind) {
    var keys = Object.keys(this.files);
    for (var i = 0; i < keys.length; i++) {
      var f = this.files[keys[i]];
      if (!f) continue;
      if (f.kind === kind || f.role === kind) return f;
    }
    return null;
  };

  SlotSession.prototype._buildLookups = function () {
    var cat = this.catalog || {};
    var maps = {
      items: new Map(),
      kungfu: new Map(),
      traits: new Map(),
      factions: new Map(),
      characters: new Map(),
      currencies: new Map(),
      fiefBuildings: new Map(),
      acupoints: new Map()
    };

    function addToMap(map, key, value) {
      if (key === undefined || key === null) return;
      var s = String(key);
      map.set(s, value);
      map.set(Number(key), value);
    }

    var arr = cat.itemList || cat.items || [];
    for (var i = 0; i < arr.length; i++) addToMap(maps.items, arr[i].uid, arr[i]);

    arr = cat.kungfuList || cat.kungfu || [];
    for (var j = 0; j < arr.length; j++) addToMap(maps.kungfu, arr[j].uid, arr[j]);

    arr = cat.traitList || cat.traits || [];
    for (var k = 0; k < arr.length; k++) addToMap(maps.traits, arr[k].uid, arr[k]);

    arr = cat.factionList || cat.factions || [];
    for (var m = 0; m < arr.length; m++) addToMap(maps.factions, arr[m].uid, arr[m]);

    arr = cat.characterList || cat.characters || [];
    for (var n = 0; n < arr.length; n++) addToMap(maps.characters, arr[n].uid, arr[n]);

    arr = cat.currencies || [];
    for (var p = 0; p < arr.length; p++) {
      addToMap(maps.currencies, arr[p].id, arr[p]);
      if (arr[p].key !== undefined && arr[p].key !== null) maps.currencies.set(String(arr[p].key), arr[p]);
    }

    arr = cat.fiefBuildings || [];
    for (var q = 0; q < arr.length; q++) addToMap(maps.fiefBuildings, arr[q].saveId !== undefined ? arr[q].saveId : arr[q].uid, arr[q]);

    arr = cat.acupointList || cat.acupoints || [];
    for (var r = 0; r < arr.length; r++) {
      addToMap(maps.acupoints, arr[r].idx, arr[r]);
      if (arr[r].uName !== undefined && arr[r].uName !== null) maps.acupoints.set(String(arr[r].uName), arr[r]);
    }

    this._maps = maps;
    this.lookups = {
      items: maps.items,
      kungfu: maps.kungfu,
      traits: maps.traits,
      factions: maps.factions,
      characters: maps.characters,
      currencies: maps.currencies,
      fiefBuildings: maps.fiefBuildings,
      acupoints: maps.acupoints,
      item: maps.items,
      trait: maps.traits,
      faction: maps.factions,
      character: maps.characters
    };
  };

  function detectRoleFromType(typeStr) {
    if (!typeStr) return null;
    var clsName = String(typeStr).split(',')[0].trim();
    if (clsName === 'WuLin.SaveObjectPlayerTeam') return 'playerTeam';
    if (clsName === 'WuLin.SaveObjectGameCharacter') return 'characters';
    if (clsName === 'WuLin.SaveObjectFaction') return 'factions';
    if (clsName === 'WuLin.SaveObjectGameGlobal') return 'global';
    if (clsName === 'WuLin.SaveObjectGameTime') return 'time';
    if (clsName === 'WuLin.SaveObjectPagoda') return 'pagoda';
    if (clsName === 'WuLin.SaveInfo') return 'saveInfo';
    if (clsName === 'WuLin.SaveObjectGame') return 'game';
    return null;
  }
  function detectRoleFromFilename(name) {
    if (!name) return null;
    var lower = String(name).toLowerCase();
    if (lower.indexOf('saveinf') >= 0) return 'saveInfo';
    if (lower.indexOf('playerteam') >= 0) return 'playerTeam';
    if (lower.indexOf('gamecharacter') >= 0) return 'characters';
    if (lower.indexOf('faction') >= 0) return 'factions';
    if (lower.indexOf('gameglobal') >= 0) return 'global';
    if (lower.indexOf('gametime') >= 0) return 'time';
    if (lower.indexOf('pagoda') >= 0) return 'pagoda';
    if (lower.indexOf('saveobjectgame.save') >= 0 || lower === 'saveobjectgame.save') return 'game';
    return null;
  }

  SlotSession.prototype._resolveAST = function (root) {
    if (!isObj(root)) return null;
    if (objHas(root, 'Data')) {
      var data = objGet(root, 'Data');
      if (!isObj(data) || !objHas(data, 'value')) return null;
      var value = objGet(data, 'value');
      return isObj(value) ? value : null;
    }
    return root;
  };

  function checkCanonicalTypeConflict(parsed, expectedRole) {
    function validWrap(t) { return typeof t === 'string' && !!t.trim() && (t.split(',')[0].trim() === 'WuLin.SaveObjectBase' || detectRoleFromType(t) === expectedRole); }
    function validInner(t) { return typeof t === 'string' && !!t.trim() && detectRoleFromType(t) === expectedRole; }
    if (!isObj(parsed)) return '루트 객체 형식이 올바르지 않습니다.';
    if (objHas(parsed, 'Data')) {
      if (objHas(parsed, '__type') && !validWrap(objGet(parsed, '__type'))) return '역할(' + expectedRole + ')과 래퍼 __type이 충돌합니다.';
      var data = objGet(parsed, 'Data');
      if (!isObj(data)) return '세이브 Data 래퍼 형식이 올바르지 않습니다.';
      if (objHas(data, '__type') && !validWrap(objGet(data, '__type'))) return '역할(' + expectedRole + ')과 Data 래퍼 __type이 충돌합니다.';
      if (!objHas(data, 'value') || !isObj(objGet(data, 'value'))) return '세이브 Data.value 객체 형식이 올바르지 않습니다.';
      var val = objGet(data, 'value');
      if (objHas(val, '__type') && !validInner(objGet(val, '__type'))) return '역할(' + expectedRole + ')과 내부 __type이 충돌합니다.';
      return null;
    }
    if (objHas(parsed, '__type') && !validInner(objGet(parsed, '__type'))) return '역할(' + expectedRole + ')과 __type이 충돌합니다.';
    return null;
  }

  function detectExplicitRole(parsed) {
    if (!isObj(parsed)) return null;
    var data = objGet(parsed, 'Data');
    if (isObj(data)) {
      var v = objGet(data, 'value'), r = (isObj(v) && detectRoleFromType(readStrField(v, '__type', ''))) || detectRoleFromType(readStrField(data, '__type', ''));
      if (r) return r;
    }
    return detectRoleFromType(readStrField(parsed, '__type', ''));
  }

  SlotSession.prototype._detectRole = function (parsed, name) {
    var fromName = canonicalRoleFromPath(name) || detectRoleFromFilename(name);
    return detectExplicitRole(parsed) || fromName || 'other';
  };

  SlotSession.prototype.loadFiles = async function (fileList, password) {
    if (password === undefined) password = 'Meow'; var self = this;
    var myGen = (this._loadSeq = (this._loadSeq || 0) + 1), myToken = this._sessionId + ':' + myGen;
    var stagedFiles = Object.create(null), stagedAmbiguous = Object.create(null), stagedBrokenRoles = Object.create(null), records = [];
    if (!Array.isArray(fileList)) fileList = [];
    var uniqueKey = function (base) { var key = base, n = 2; while (stagedFiles[key]) { key = base + '#' + n; n++; } return key; };
    var inferRoleFromName = function (fObj) { var nm = (fObj && (fObj.name || fObj.relativePath)) || ''; return canonicalRoleFromPath(nm) || detectRoleFromFilename(nm) || 'other'; };
    for (var i = 0; i < fileList.length; i++) {
      var f = fileList[i];
      if (!f || !f.bytes) continue;
      var bytes = cloneBytes(f.bytes);
      var origBytes = cloneBytes(bytes), decoded;
      try {
        decoded = await C.decodeEs3Bytes(bytes, password);
        if (this._loadSeq !== myGen) return { superseded: true, loadedCount: 0 };
      } catch (e) {
        if (e && e.code === 'ES3_DECOMPRESS_LIMIT') throw e;
        records.push({
          key: null, name: f.name, fileName: f.name, kind: null,
          relativePath: f.relativePath || f.name || ('file_' + i), bytes: cloneBytes(origBytes),
          originalBytes: cloneBytes(origBytes), originalText: null, originalParseFailed: true, revision: 0,
          dirty: false, parsed: null, ast: null, role: inferRoleFromName(f), mode: null, passwordUsed: null,
          loadError: e.message, loadToken: myToken
        });
        continue;
      }
      var parsed = null, parseError = null; try { parsed = parseEs3Json(decoded.text); } catch (pe) { parseError = pe.message; }
      var canonicalRole = canonicalRoleFromPath(f.name || f.relativePath), typeMismatchError = null, role;
      if (canonicalRole) {
        role = canonicalRole;
        if (!parseError) {
          typeMismatchError = checkCanonicalTypeConflict(parsed, canonicalRole);
          if (typeMismatchError || !isObj(this._resolveAST(parsed))) stagedBrokenRoles[canonicalRole] = true;
        } else {
          stagedBrokenRoles[canonicalRole] = true;
        }
      } else {
        role = parseError ? inferRoleFromName(f) : this._detectRole(parsed, f.name || f.relativePath);
        if (!parseError && CANONICAL_ROLE_FILENAMES[role]) typeMismatchError = checkCanonicalTypeConflict(parsed, role);
      }
      records.push({
        key: null, kind: null, name: f.name, fileName: f.name,
        relativePath: f.relativePath || f.name, bytes: cloneBytes(origBytes), originalBytes: cloneBytes(origBytes),
        originalText: decoded.text, originalParseFailed: !!parseError, revision: 0, dirty: false,
        parsed: parsed, ast: parsed, role: role, mode: decoded.mode,
        passwordUsed: (decoded.mode && decoded.mode.indexOf('aes') === 0) ? password : null,
        parseError: parseError, typeMismatchError: typeMismatchError, loadToken: myToken
      });
    }
    if (this._loadSeq !== myGen) return { superseded: true, loadedCount: 0 };
    var groups = Object.create(null);
    for (var r = 0; r < records.length; r++) {
      var rec = records[r];
      if (rec.role === 'other' || !CANONICAL_ROLE_FILENAMES[rec.role]) {
        rec.key = uniqueKey(rec.originalParseFailed ? ('file:' + (rec.name || ('file_' + r))) : this._fileKeyOf(rec.name, rec.role));
        rec.kind = rec.role !== 'other' ? rec.role : (rec.originalParseFailed ? 'other' : rec.key);
        stagedFiles[rec.key] = rec;
      } else {
        if (!groups[rec.role]) groups[rec.role] = [];
        groups[rec.role].push(rec);
      }
    }
    var groupRoles = Object.keys(groups);
    var isEntryBroken = function (entry) {
      return !!(entry.originalParseFailed || entry.typeMismatchError || !isObj(self._resolveAST(entry.parsed)));
    };
    for (var gi = 0; gi < groupRoles.length; gi++) {
      var role = groupRoles[gi], group = groups[role];
      if (group.length === 1) {
        group[0].key = role; group[0].kind = role; stagedFiles[role] = group[0];
        if (isEntryBroken(group[0])) stagedBrokenRoles[role] = true;
      } else if (group.length >= 2) {
        var matchCount = 0, matchIdx = -1;
        for (var g = 0; g < group.length; g++) {
          if (basenameLower(group[g].name || group[g].relativePath) === CANONICAL_ROLE_FILENAMES[role]) {
            matchCount++; matchIdx = g;
          }
        }
        if (matchCount === 1) {
          var canonical = group[matchIdx];
          canonical.key = role; canonical.kind = role; stagedFiles[role] = canonical;
          if (isEntryBroken(canonical)) stagedBrokenRoles[role] = true;
          for (var n = 0; n < group.length; n++) {
            if (n === matchIdx) continue;
            var k2 = uniqueKey(role);
            group[n].key = k2; group[n].kind = role; stagedFiles[k2] = group[n];
          }
        } else {
          stagedAmbiguous[role] = true;
          for (var m = 0; m < group.length; m++) {
            var k3 = uniqueKey(role);
            group[m].key = k3; group[m].kind = role; stagedFiles[k3] = group[m];
          }
        }
      }
    }
    this.password = password;
    this._loadGeneration = myGen;
    this._loadToken = myToken;
    this.files = stagedFiles;
    this.ambiguousRoles = stagedAmbiguous;
    this.brokenRoles = stagedBrokenRoles;
    this.changeLog = [];
    this._undoStack = [];
    return this.getSummary();
  };

  SlotSession.prototype._entriesOf = function (fileKey) {
    var f = this.files[fileKey];
    if (!f) return null;
    return f;
  };

  SlotSession.prototype._dataValue = function (fileKey) {
    var f = this.files[fileKey];
    if (!f || !isObj(f.parsed)) return null;
    return this._resolveAST(f.parsed);
  };

  SlotSession.prototype.getSummary = function () {
    var loadedRoles = [];
    var fileCount = 0;
    var dirtyCount = 0;
    var keys = Object.keys(this.files);
    for (var i = 0; i < keys.length; i++) {
      var f = this.files[keys[i]];
      fileCount++;
      if (f.dirty) dirtyCount++;
      if (loadedRoles.indexOf(f.role) < 0) loadedRoles.push(f.role);
    }
    var proto = null;
    try { proto = this._getProtagonist(); } catch (e) { proto = null; }
    return {
      loadedRoles: loadedRoles,
      fileCount: fileCount,
      dirtyFileCount: dirtyCount,
      protagonist: proto ? {
        instanceId: proto.instanceId,
        displayName: proto.displayName,
        level: proto.level
      } : null,
      changeLog: this.changeLog.slice()
    };
  };

  // ============================================================
  // PlayerTeam: currencies & team props & inventory
  // ============================================================
  SlotSession.prototype._playerTeamNode = function () {
    return this._dataValue('playerTeam');
  };

  SlotSession.prototype.getCurrencies = function () {
    var pt = this._playerTeamNode();
    var out = [];
    for (var i = 0; i < this.catalog.currencies.length; i++) {
      var def = this.catalog.currencies[i];
      var value = 0;
      if (isObj(pt)) {
        var inv = objGet(pt, 'playerTeamInventory');
        if (isObj(inv)) {
          var cur = objGet(inv, 'currencies');
          if (isObj(cur)) {
            var v = objGet(cur, String(def.id));
            if (v !== undefined) value = numToFloat(v, 0);
          }
        }
      }
      out.push({ id: def.id, koName: def.koName, zhName: def.zhName, value: value, max: def.max });
    }
    return out;
  };

  SlotSession.prototype.setCurrency = function (currencyId, value) {
    this._assertRoleWritable('playerTeam');
    var id = validateSafeInteger(currencyId, 0, 9999, 'currencyId');
    var def = null;
    for (var i = 0; i < this.catalog.currencies.length; i++) {
      if (this.catalog.currencies[i].id === id) { def = this.catalog.currencies[i]; break; }
    }
    var max = def ? def.max : 2000000000;
    var val = validateSafeInteger(value, 0, max, 'currency value');
    var pt = this._playerTeamNode();
    if (!isObj(pt)) throw new Error('playerTeam 세이브가 로드되지 않았습니다.');
    var inv = objGet(pt, 'playerTeamInventory');
    if (!isObj(inv)) {
      inv = makeObj([]);
      objSet(pt, 'playerTeamInventory', inv);
    }
    var cur = objGet(inv, 'currencies');
    if (!isObj(cur)) {
      cur = makeObj([]);
      objSet(inv, 'currencies', cur);
    }
    objSet(cur, String(id), makeNum(val), false);
    this._markDirty('playerTeam');
    this._log('setCurrency', { id: id, value: val });
    return val;
  };

  SlotSession.prototype.getTeamProps = function () {
    var pt = this._playerTeamNode();
    var out = {};
    if (isObj(pt)) {
      var tp = objGet(pt, 'teamProps');
      if (isObj(tp)) {
        for (var i = 0; i < tp.entries.length; i++) {
          var e = tp.entries[i];
          out[e.key] = isNum(e.value) ? numToFloat(e.value, 0) : (typeof e.value === 'number' ? e.value : (isObj(e.value) || Array.isArray(e.value) ? C.es3ToPlainJs(e.value) : e.value));
        }
      }
    }
    return out;
  };

  SlotSession.prototype.setTeamProp = function (key, value) {
    this._assertRoleWritable('playerTeam');
    if (!(typeof key === 'string' && key.trim().length > 0)) throw new Error('team prop key must be a non-empty string');
    var tps = this.catalog && this.catalog.teamProps;
    var def = null;
    if (Array.isArray(tps)) {
      for (var i = 0; i < tps.length; i++) {
        if (tps[i] && typeof tps[i] === 'object' && tps[i].key === key) {
          def = tps[i];
          break;
        }
      }
    } else if (tps && typeof tps === 'object') {
      def = Object.prototype.hasOwnProperty.call(tps, key) ? tps[key] : null;
    }
    var min = (def && typeof def === 'object' && typeof def.min === 'number' && isFinite(def.min)) ? def.min : -2147483648;
    var max = (def && typeof def === 'object' && typeof def.max === 'number' && isFinite(def.max)) ? def.max : 2147483647;
    var val = validateSafeInteger(value, min, max, 'teamProp(' + key + ')');
    var pt = this._playerTeamNode();
    if (!isObj(pt)) throw new Error('playerTeam 세이브가 로드되지 않았습니다.');
    var tp = objGet(pt, 'teamProps');
    if (!isObj(tp)) {
      tp = makeObj([]);
      objSet(pt, 'teamProps', tp);
    }
    objSet(tp, key, makeNum(val), true);
    this._markDirty('playerTeam');
    this._log('setTeamProp', { key: key, value: val });
    return val;
  };

  SlotSession.prototype._inventoryContents = function () {
    var pt = this._playerTeamNode();
    if (!isObj(pt)) return null;
    var inv = objGet(pt, 'playerTeamInventory');
    if (!isObj(inv)) return null;
    var contents = objGet(inv, 'contents');
    return Array.isArray(contents) ? contents : null;
  };

  SlotSession.prototype.getInventoryItems = function (opts) {
    opts = opts || {};
    var query = (opts.query || '').toString().trim().toLowerCase();
    var category = opts.category || 'all';
    var contents = this._inventoryContents() || [];
    var out = [];
    var qTokens = query ? query.split(/\s+/).filter(Boolean) : [];
    for (var i = 0; i < contents.length; i++) {
      var it = contents[i];
      if (!isObj(it)) continue;
      var uid = readNumField(it, 'm_templeteId', 0);
      var uidKey = numToIntString(objGet(it, 'm_templeteId'));
      var itemCatalog = this.lookups.item.get(uidKey) || this.lookups.item.get(String(uid)) || null;
      var koName = itemCatalog ? (itemCatalog.koName || itemCatalog.name || '') : ('알 수 없음 #' + uidKey);
      var zhName = itemCatalog ? (itemCatalog.zhName || '') : '';
      var cat = itemCatalog ? (itemCatalog.category || 'other') : 'other';
      var stackable = itemCatalog ? (itemCatalog.stackable || 0) : 0;
      var price = itemCatalog ? (itemCatalog.price || 0) : 0;
      var rarity = itemCatalog ? (itemCatalog.rarity || 0) : 0;
      var count = readNumField(it, 'm_stack', 1);
      var isNew = readBoolField(it, 'IsNew', false);
      var isForbidden = readBoolField(it, 'IsForbidden', false);
      var md = objGet(it, 'modifyData');
      var hasModifyData = isObj(md);
      var forgeLevel = hasModifyData ? readNumField(md, 'forgeLevel', 0) : 0;
      if (category !== 'all' && category !== cat) continue;
      if (qTokens.length) {
        var hay = (String(uidKey) + ' ' + koName + ' ' + zhName + ' ' + String(uid)).toLowerCase();
        var ok = true;
        for (var t = 0; t < qTokens.length; t++) {
          if (hay.indexOf(qTokens[t]) < 0) { ok = false; break; }
        }
        if (!ok) continue;
      }
      out.push({
        index: i,
        uid: uidKey,
        count: count,
        isNew: isNew,
        isForbidden: isForbidden,
        hasModifyData: hasModifyData,
        forgeLevel: forgeLevel,
        koName: koName,
        zhName: zhName,
        rarity: rarity,
        category: cat,
        stackable: stackable,
        price: price
      });
    }
    return out;
  };

  SlotSession.prototype.setInventoryItemStack = function (index, newStack) {
    this._assertRoleWritable('playerTeam');
    var contents = this._inventoryContents();
    if (!contents) throw new Error('playerTeam 인벤토리를 찾을 수 없습니다.');
    var idx = validateSafeInteger(index, 0, contents.length - 1, 'inventory index');
    var stack = validateSafeInteger(newStack, 1, 99999, 'stack');
    var it = contents[idx];
    if (!isObj(it)) throw new Error('인벤토리 항목이 올바르지 않습니다.');
    objSet(it, 'm_stack', makeNum(stack), true);
    this._markDirty('playerTeam');
    this._log('setInventoryItemStack', { index: idx, stack: stack });
    return stack;
  };

  SlotSession.prototype.setInventoryItemForgeLevel = function (index, forgeLevel) {
    this._assertRoleWritable('playerTeam');
    var contents = this._inventoryContents();
    if (!contents) throw new Error('playerTeam 인벤토리를 찾을 수 없습니다.');
    var idx = validateSafeInteger(index, 0, contents.length - 1, 'inventory index');
    var it = contents[idx];
    if (!isObj(it)) throw new Error('인벤토리 항목이 올바르지 않습니다.');
    var md = objGet(it, 'modifyData');
    if (!isObj(md)) throw new Error('이 항목은 modifyData가 없어 단조 등급을 설정할 수 없습니다.');
    var lvl = validateSafeInteger(forgeLevel, 0, 30, 'forgeLevel');
    objSet(md, 'forgeLevel', makeNum(lvl), true);
    this._markDirty('playerTeam');
    this._log('setInventoryItemForgeLevel', { index: idx, forgeLevel: lvl });
    return lvl;
  };

  SlotSession.prototype.removeInventoryItem = function (index) {
    this._assertRoleWritable('playerTeam');
    var contents = this._inventoryContents();
    if (!contents) throw new Error('playerTeam 인벤토리를 찾을 수 없습니다.');
    var idx = validateSafeInteger(index, 0, contents.length - 1, 'inventory index');
    contents.splice(idx, 1);
    this._markDirty('playerTeam');
    this._log('removeInventoryItem', { index: idx });
    return true;
  };

  SlotSession.prototype.addInventoryItem = function (uid, count, options) {
    this._assertRoleWritable('playerTeam');
    count = count === undefined ? 1 : count;
    options = options || {};
    var allowUnknown = !!options.allowUnknownUid;
    var uidNum = validateSafeInteger(uid, 1, 2147483647, 'UID');
    var cnt = validateSafeInteger(count, 1, 99999, 'count');
    var cat = this.lookups.item.get(String(uidNum)) || null;
    if (!cat && !allowUnknown) {
      throw new Error('알 수 없는 아이템 UID입니다: ' + uidNum + ' (allowUnknownUid=true 옵션으로 강제 추가 가능)');
    }
    var stackable = cat ? (cat.stackable || 0) : 1;
    var contents = this._inventoryContents();
    if (!contents) {
      // Create inventory
      var pt = this._playerTeamNode();
      if (!isObj(pt)) throw new Error('playerTeam 세이브가 로드되지 않았습니다.');
      var inv = objGet(pt, 'playerTeamInventory');
      if (!isObj(inv)) { inv = makeObj([]); objSet(pt, 'playerTeamInventory', inv); }
      var c = makeObj([]);
      objSet(inv, 'contents', c);
      // Insert as array-like by wrapping: Actually ES3 contents is Array.
      // Fallback: replace with array
      objSet(inv, 'contents', []);
      contents = objGet(inv, 'contents');
    }
    var added = 0;
    if (stackable && cnt > 0) {
      for (var i = 0; i < contents.length; i++) {
        var it = contents[i];
        if (!isObj(it)) continue;
        var tuid = numToIntString(objGet(it, 'm_templeteId'));
        if (tuid !== String(uidNum)) continue;
        var md = objGet(it, 'modifyData');
        if (md !== null && md !== undefined) continue;
        var cur = readNumField(it, 'm_stack', 0);
        var add = Math.min(cnt - added, 999999 - cur);
        if (add <= 0) continue;
        objSet(it, 'm_stack', makeNum(cur + add), true);
        added += add;
        if (added >= cnt) break;
      }
    }
    while (added < cnt) {
      var remaining = cnt - added;
      if (stackable) {
        var newIt = makeObj([
          ['m_templeteId', makeNum(uidNum), true],
          ['m_stack', makeNum(remaining), true],
          ['modifyData', null, true],
          ['IsNew', true, true],
          ['IsForbidden', false, true]
        ]);
        contents.push(newIt);
        added += remaining;
      } else {
        var perAdd = Math.min(remaining, 20);
        for (var k = 0; k < perAdd; k++) {
          var single = makeObj([
            ['m_templeteId', makeNum(uidNum), true],
            ['m_stack', makeNum(1), true],
            ['modifyData', null, true],
            ['IsNew', true, true],
            ['IsForbidden', false, true]
          ]);
          contents.push(single);
        }
        added += perAdd;
        if (cnt > perAdd && cnt - added > 0) {
          // User asked for count but non-stackable capped at 20 per call
          break;
        }
      }
    }
    this._markDirty('playerTeam');
    this._log('addInventoryItem', { uid: uidNum, count: added });
    return added;
  };

  // ============================================================
  // Characters
  // ============================================================
  SlotSession.prototype._charactersRoot = function () {
    var chars = this._dataValue('characters');
    if (isObj(chars) && isObj(objGet(chars, 'createdCharacter'))) return chars;
    var game = this._dataValue('game');
    if (isObj(game) && isObj(objGet(game, 'createdCharacter'))) return game;
    return chars;
  };

  SlotSession.prototype._charactersFileRole = function () {
    var chars = this._dataValue('characters');
    if (isObj(chars) && isObj(objGet(chars, 'createdCharacter'))) return 'characters';
    var game = this._dataValue('game');
    if (isObj(game) && isObj(objGet(game, 'createdCharacter'))) return 'game';
    return 'characters';
  };

  SlotSession.prototype._createdCharacters = function () {
    var root = this._charactersRoot();
    if (!isObj(root)) return null;
    var cc = objGet(root, 'createdCharacter');
    return isObj(cc) ? cc : null;
  };

  SlotSession.prototype._getTeamMemberState = function (charNode) {
    var tms = objGet(charNode, 'm_TeamMemberState');
    if (isObj(tms) && objHas(tms, 'value')) {
      var inner = objGet(tms, 'value');
      return isObj(inner) ? inner : null;
    }
    return isObj(tms) ? tms : null;
  };

  SlotSession.prototype._ensureTeamMemberState = function (charNode) {
    var existing = this._getTeamMemberState(charNode);
    if (isObj(existing)) return existing;
    var team = makeObj([
      ['isJoined', false, true],
      ['curHp', makeNum(readNumField(charNode, 'curHp', readNumField(charNode, 'm_curHp', 0))), true],
      ['curEp', makeNum(readNumField(charNode, 'curEp', readNumField(charNode, 'm_curEp', 0))), true]
    ]);
    var rawTms = objGet(charNode, 'm_TeamMemberState');
    if (objHas(charNode, 'm_TeamMemberState')) {
      if (rawTms !== null && rawTms !== undefined && !isObj(rawTms)) {
        throw new Error('m_TeamMemberState 객체 형식이 올바르지 않습니다.');
      }
      if (isObj(rawTms) && objHas(rawTms, 'value')) {
        var innerVal = objGet(rawTms, 'value');
        if (innerVal !== null && !isObj(innerVal)) {
          throw new Error('m_TeamMemberState.value 객체 형식이 올바르지 않습니다.');
        }
      }
    }
    if (isObj(rawTms) && objHas(rawTms, 'value')) {
      objSet(rawTms, 'value', team, true);
    } else {
      objSet(charNode, 'm_TeamMemberState', team, true);
    }
    return team;
  };

  SlotSession.prototype._playerTeamIds = function () {
    var pt = this._playerTeamNode();
    if (!isObj(pt)) return [];
    var ptNode = objGet(pt, 'playerTeam');
    if (!Array.isArray(ptNode) || ptNode.length === 0) {
      ptNode = objGet(pt, 'teamMembers');
    }
    if (!Array.isArray(ptNode)) return [];
    var out = [];
    for (var i = 0; i < ptNode.length; i++) {
      var v = ptNode[i];
      if (isNum(v)) out.push(v.raw);
      else if (typeof v === 'number') out.push(String(v));
      else if (typeof v === 'string') out.push(v);
    }
    return out;
  };

  SlotSession.prototype._charEntryByInstanceId = function (charUid) {
    var cc = this._createdCharacters();
    if (!cc) return null;
    var idStr = typeof charUid === 'string' ? charUid : numToIntString(charUid);
    var e = cc.index.get(idStr);
    if (e) return e;
    if (Array.isArray(cc.entries)) {
      for (var i = 0; i < cc.entries.length; i++) {
        var entry = cc.entries[i];
        if (!entry || !isObj(entry.value)) continue;
        var templateId = numToIntString(objGet(entry.value, 'm_templeteUid'));
        if (templateId === idStr) return entry;
      }
    }
    return null;
  };

  SlotSession.prototype._characterDisplayName = function (charNode, templeteUid) {
    var sur = readStrField(charNode, 'm_surName', '');
    var given = readStrField(charNode, 'm_givenName', '');
    var full = (sur || '') + (given || '');
    var cat = this.lookups.characters.get(String(templeteUid));
    var koCat = cat ? (cat.koName || '') : '';
    if (full) {
      if (koCat && full !== koCat) return full + ' (' + koCat + ')';
      return full;
    }
    if (koCat) return koCat;
    return '#' + templeteUid;
  };

  SlotSession.prototype._resolveProtagonistId = function () {
    var ids = this._playerTeamIds();
    if (ids.length > 0) return ids[0];

    var cc = this._createdCharacters();
    if (!cc || !Array.isArray(cc.entries) || cc.entries.length === 0) return null;

    var matches = [];
    for (var i = 0; i < cc.entries.length; i++) {
      var entry = cc.entries[i];
      if (!entry || !isObj(entry.value)) continue;
      if (numToIntString(objGet(entry.value, 'm_templeteUid')) === '100401') {
        matches.push(entry.key);
      }
    }

    return matches.length === 1 ? matches[0] : null;
  };

  SlotSession.prototype._getProtagonist = function () {
    var pid = this._resolveProtagonistId();
    return pid !== null ? this.getCharacterDetail(pid) : null;
  };

  SlotSession.prototype.listCharacters = function (opts) {
    opts = opts || {};
    var filter = opts.filter || 'party_and_named';
    var query = (opts.query || '').toString().toLowerCase().trim();
    var cc = this._createdCharacters();
    if (!cc) return [];
    var partyIds = this._playerTeamIds();
    var partySet = new Set(partyIds);
    var protagonistId = partyIds.length > 0 ? partyIds[0] : this._resolveProtagonistId();
    var results = [];

    for (var i = 0; i < cc.entries.length; i++) {
      var entry = cc.entries[i];
      var instanceId = entry.key;
      var node = entry.value;
      if (!isObj(node)) continue;

      var templeteUid = numToIntString(objGet(node, 'm_templeteUid'));
      var displayName = this._characterDisplayName(node, templeteUid);
      var isProt = protagonistId !== null && instanceId === protagonistId;
      var inParty = partySet.has(instanceId);

      var tms = this._getTeamMemberState(node);
      var isJoined = isObj(tms) ? readBoolField(tms, 'isJoined', false) : false;
      var curHp = isObj(tms) && objHas(tms, 'curHp') ? readNumField(tms, 'curHp', 0) :
        readNumField(node, 'curHp', readNumField(node, 'm_curHp', 0));
      var curEp = isObj(tms) && objHas(tms, 'curEp') ? readNumField(tms, 'curEp', 0) :
        readNumField(node, 'curEp', readNumField(node, 'm_curEp', 0));

      var level = readNumField(node, 'm_level', readNumField(node, 'level', 1));
      var exp = readNumField(node, 'm_exp', readNumField(node, 'exp', 0));
      var egoState = readNumField(node, 'm_egoState', readNumField(node, 'egoState', 0));
      var valueState = readNumField(node, 'm_valueState', readNumField(node, 'valueState', 0));
      var surName = readStrField(node, 'm_surName', '');
      var givenName = readStrField(node, 'm_givenName', '');
      var overrideTitle = readStrField(node, 'm_overrideTitle', '');

      var hasName = (surName || givenName) !== '' || !!this.lookups.characters.get(templeteUid);
      var pass = false;
      if (filter === 'all') pass = true;
      else if (filter === 'party') pass = inParty;
      else if (filter === 'named') pass = !!hasName;
      else pass = isProt || inParty || isJoined || !!hasName;
      if (!pass) continue;

      if (query) {
        var hay = (displayName + ' ' + templeteUid + ' ' + instanceId).toLowerCase();
        if (hay.indexOf(query) < 0) continue;
      }

      var cat = this.lookups.characters.get(templeteUid);
      var koName = cat ? (cat.koName || '') : '';
      results.push({
        instanceId: instanceId,
        templeteUid: templeteUid,
        displayName: displayName,
        koName: koName,
        isProtagonist: isProt,
        inParty: inParty,
        level: level,
        m_level: level,
        exp: exp,
        m_exp: exp,
        egoState: egoState,
        m_egoState: egoState,
        valueState: valueState,
        m_valueState: valueState,
        surName: surName,
        m_surName: surName,
        givenName: givenName,
        m_givenName: givenName,
        overrideTitle: overrideTitle,
        m_overrideTitle: overrideTitle,
        isJoined: isJoined,
        curHp: curHp,
        curEp: curEp,
        m_TeamMemberState: {
          isJoined: isJoined,
          curHp: curHp,
          curEp: curEp
        },
        sortKey: (isProt ? 0 : 1) * 1e12 + (inParty ? 0 : 1) * 1e9 + (isJoined ? 0 : 1) * 1e6 + i
      });
    }

    results.sort(function (a, b) { return a.sortKey - b.sortKey; });
    for (var r = 0; r < results.length; r++) delete results[r].sortKey;
    return results;
  };

  SlotSession.prototype.getCharacterDetail = function (charUid) {
    var entry = this._charEntryByInstanceId(charUid);
    if (!entry) throw new Error('캐릭터를 찾을 수 없습니다: ' + charUid);
    var node = entry.value;
    if (!isObj(node)) throw new Error('캐릭터 노드가 올바르지 않습니다.');

    var templeteUid = numToIntString(objGet(node, 'm_templeteUid'));
    var partyIds = this._playerTeamIds();
    var protId = partyIds.length > 0 ? partyIds[0] : this._resolveProtagonistId();
    var isProt = protId !== null && protId === entry.key;
    var inParty = partyIds.indexOf(entry.key) >= 0;
    var displayName = this._characterDisplayName(node, templeteUid);

    var level = readNumField(node, 'm_level', readNumField(node, 'level', 1));
    var exp = readNumField(node, 'm_exp', readNumField(node, 'exp', 0));
    var egoState = readNumField(node, 'm_egoState', readNumField(node, 'egoState', 0));
    var valueState = readNumField(node, 'm_valueState', readNumField(node, 'valueState', 0));
    var surName = readStrField(node, 'm_surName', '');
    var givenName = readStrField(node, 'm_givenName', '');
    var overrideTitle = readStrField(node, 'm_overrideTitle', '');

    var tms = this._getTeamMemberState(node);
    var isJoined = isObj(tms) ? readBoolField(tms, 'isJoined', false) : false;
    var curHp = isObj(tms) && objHas(tms, 'curHp') ? readNumField(tms, 'curHp', 0) :
      readNumField(node, 'curHp', readNumField(node, 'm_curHp', 0));
    var curEp = isObj(tms) && objHas(tms, 'curEp') ? readNumField(tms, 'curEp', 0) :
      readNumField(node, 'curEp', readNumField(node, 'm_curEp', 0));

    var kungfuList = [];
    var kfArr = objGet(node, 'kungfuInstances');
    if (Array.isArray(kfArr)) {
      for (var i = 0; i < kfArr.length; i++) {
        var ki = kfArr[i];
        if (!isObj(ki)) continue;
        var kuid = numToIntString(objGet(ki, 'm_templeteUid'));
        var kcat = this.lookups.kungfu.get(kuid);
        kungfuList.push({
          index: i,
          templeteUid: kuid,
          level: readNumField(ki, 'm_level', 0),
          exp: readNumField(ki, 'm_exp', 0),
          koName: kcat ? (kcat.koName || kcat.name || '') : '',
          maxLevel: kcat ? (kcat.maxLevel || 10) : 10
        });
      }
    }

    var traits = [];
    var trArr = objGet(node, 'Traits');
    if (Array.isArray(trArr)) {
      for (var t = 0; t < trArr.length; t++) {
        var tv = numToIntString(trArr[t]);
        var tcat = this.lookups.trait.get(tv);
        traits.push({ uid: tv, koName: tcat ? (tcat.koName || tcat.name || '') : ('#' + tv) });
      }
    }

    var relations = [];
    var rel = objGet(node, 'relationShip');
    if (isObj(rel)) {
      for (var r = 0; r < rel.entries.length; r++) {
        var re = rel.entries[r];
        var targetId = re.key;
        var relationValue = numToFloat(re.value, 0);
        var targetCat = this.lookups.characters.get(String(targetId));
        var targetName = targetCat && targetCat.koName ? targetCat.koName : ('NPC #' + targetId);
        relations.push({
          targetId: targetId,
          relationValue: relationValue,
          targetName: targetName,
          target: targetId,
          affinity: relationValue
        });
      }
    }

    function bucketToPlain(bucketObj) {
      var out = {};
      if (isObj(bucketObj)) {
        for (var bi = 0; bi < bucketObj.entries.length; bi++) {
          var be = bucketObj.entries[bi];
          out[be.key] = numToFloat(be.value, 0);
        }
      }
      return out;
    }

    var originProps = bucketToPlain(objGet(node, 'm_originProps'));
    var additionProps = bucketToPlain(objGet(node, 'm_additionProps'));
    var cat = this.lookups.characters.get(templeteUid);
    var koName = cat ? (cat.koName || '') : '';

    return {
      instanceId: entry.key,
      templeteUid: templeteUid,
      displayName: displayName,
      koName: koName,
      isProtagonist: isProt,
      inParty: inParty,
      level: level,
      m_level: level,
      exp: exp,
      m_exp: exp,
      egoState: egoState,
      m_egoState: egoState,
      valueState: valueState,
      m_valueState: valueState,
      surName: surName,
      m_surName: surName,
      givenName: givenName,
      m_givenName: givenName,
      overrideTitle: overrideTitle,
      m_overrideTitle: overrideTitle,
      isJoined: isJoined,
      curHp: curHp,
      curEp: curEp,
      m_TeamMemberState: {
        isJoined: isJoined,
        curHp: curHp,
        curEp: curEp
      },
      originProps: originProps,
      additionProps: additionProps,
      kungfuList: kungfuList,
      traits: traits,
      relations: relations
    };
  };

  SlotSession.prototype._charNodeByInstance = function (instanceId) {
    var entry = this._charEntryByInstanceId(instanceId);
    if (!entry) throw new Error('캐릭터를 찾을 수 없습니다: ' + instanceId);
    if (!isObj(entry.value)) throw new Error('캐릭터 노드가 올바르지 않습니다.');
    return entry.value;
  };

  SlotSession.prototype._charNodeForWrite = function (instanceId) {
    this._assertCharactersWritable();
    return this._charNodeByInstance(instanceId);
  };

  SlotSession.prototype.setCharacterBasic = function (instanceId, patch) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new TypeError('patch must be an object');
    var node = this._charNodeForWrite(instanceId);
    var changed = {};
    var hasOwn = Object.prototype.hasOwnProperty;

    function pick(obj, primary, legacy) {
      if (hasOwn.call(obj, primary)) return obj[primary];
      if (legacy && hasOwn.call(obj, legacy)) return obj[legacy];
      return undefined;
    }

    var v, lv, ex, ego, valueState, surName, givenName, title;
    var wroteLevel = false, wroteExp = false, wroteEgo = false, wroteValue = false;
    if ((v = pick(patch, 'm_level', 'level')) !== undefined) {
      lv = validateSafeInteger(v, 1, 999, 'm_level');
      wroteLevel = true;
    }
    if ((v = pick(patch, 'm_exp', 'exp')) !== undefined) {
      ex = validateSafeInteger(v, 0, 999999999, 'm_exp');
      wroteExp = true;
    }
    if ((v = pick(patch, 'm_egoState', 'egoState')) !== undefined) {
      ego = validateSafeInteger(v, -1000, 100000, 'm_egoState');
      wroteEgo = true;
    }
    if ((v = pick(patch, 'm_valueState', 'valueState')) !== undefined) {
      valueState = validateSafeInteger(v, -1000, 100000, 'm_valueState');
      wroteValue = true;
    }
    if ((v = pick(patch, 'm_surName', 'surName')) !== undefined) {
      if (typeof v !== 'string') throw new TypeError('m_surName must be a string');
      surName = v;
    }
    if ((v = pick(patch, 'm_givenName', 'givenName')) !== undefined) {
      if (typeof v !== 'string') throw new TypeError('m_givenName must be a string');
      givenName = v;
    }
    if ((v = pick(patch, 'm_overrideTitle', 'overrideTitle')) !== undefined) {
      if (typeof v !== 'string') throw new TypeError('m_overrideTitle must be a string');
      title = v;
    }

    var teamPatch = patch.m_TeamMemberState;
    var hasTeamPatch = teamPatch && typeof teamPatch === 'object';
    var isJoined, curHp, curEp;
    var hasJoined = false, hasHp = false, hasEp = false;
    if (hasTeamPatch && hasOwn.call(teamPatch, 'isJoined')) {
      isJoined = teamPatch.isJoined; hasJoined = true;
    } else if (hasOwn.call(patch, 'isJoined')) {
      isJoined = patch.isJoined; hasJoined = true;
    }
    if (hasTeamPatch && hasOwn.call(teamPatch, 'curHp')) {
      curHp = teamPatch.curHp; hasHp = true;
    } else if (hasOwn.call(patch, 'curHp')) {
      curHp = patch.curHp; hasHp = true;
    }
    if (hasTeamPatch && hasOwn.call(teamPatch, 'curEp')) {
      curEp = teamPatch.curEp; hasEp = true;
    } else if (hasOwn.call(patch, 'curEp')) {
      curEp = patch.curEp; hasEp = true;
    }

    if (hasJoined && typeof isJoined !== 'boolean') throw new TypeError('isJoined must be a boolean');
    if (hasHp) curHp = validateSafeInteger(curHp, 0, 99999999, 'curHp');
    if (hasEp) curEp = validateSafeInteger(curEp, 0, 99999999, 'curEp');

    var team = (hasJoined || hasHp || hasEp) ? this._ensureTeamMemberState(node) : null;
    if (wroteLevel) { objSet(node, 'm_level', makeNum(lv), true); changed.m_level = lv; }
    if (wroteExp) { objSet(node, 'm_exp', makeNum(ex), true); changed.m_exp = ex; }
    if (wroteEgo) { objSet(node, 'm_egoState', makeNum(ego), true); changed.m_egoState = ego; }
    if (wroteValue) { objSet(node, 'm_valueState', makeNum(valueState), true); changed.m_valueState = valueState; }
    if (surName !== undefined) { objSet(node, 'm_surName', surName, true); changed.m_surName = surName; }
    if (givenName !== undefined) { objSet(node, 'm_givenName', givenName, true); changed.m_givenName = givenName; }
    if (title !== undefined) { objSet(node, 'm_overrideTitle', title, true); changed.m_overrideTitle = title; }

    if (hasJoined || hasHp || hasEp) {
      if (hasJoined) { objSet(team, 'isJoined', isJoined, true); changed['m_TeamMemberState.isJoined'] = isJoined; }
      if (hasHp) { objSet(team, 'curHp', makeNum(curHp), true); changed['m_TeamMemberState.curHp'] = curHp; }
      if (hasEp) { objSet(team, 'curEp', makeNum(curEp), true); changed['m_TeamMemberState.curEp'] = curEp; }
    }

    if (Object.keys(changed).length === 0) return {};
    if (wroteLevel) objDelete(node, 'level');
    if (wroteExp) objDelete(node, 'exp');
    if (wroteEgo) objDelete(node, 'egoState');
    if (wroteValue) objDelete(node, 'valueState');
    if (hasHp) { objDelete(node, 'curHp'); objDelete(node, 'm_curHp'); }
    if (hasEp) { objDelete(node, 'curEp'); objDelete(node, 'm_curEp'); }

    this._markDirty(this._charactersFileRole());
    this._log('setCharacterBasic', { instanceId: String(instanceId), changed: changed });
    return changed;
  };

  SlotSession.prototype.setCharacterProp = function (instanceId, bucket, propKey, value) {
    var node = this._charNodeForWrite(instanceId);
    var key = bucket === 'origin' ? 'm_originProps' : (bucket === 'addition' ? 'm_additionProps' : null);
    if (!key) throw new Error("bucket must be 'origin' or 'addition'");
    var val = validateSafeInteger(value, -999, 99999999, 'prop value');
    var container = objGet(node, key);
    if (!isObj(container)) {
      container = makeObj([]);
      objSet(node, key, container);
    }
    objSet(container, String(propKey), makeNum(val), true);
    this._markDirty(this._charactersFileRole());
    this._log('setCharacterProp', { instanceId: String(instanceId), bucket: bucket, key: propKey, value: val });
    return val;
  };

  SlotSession.prototype.setCharacterKungfuLevel = function (instanceId, kungfuIndex, level, exp) {
    var node = this._charNodeForWrite(instanceId);
    var arr = objGet(node, 'kungfuInstances');
    if (!Array.isArray(arr)) throw new Error('kungfuInstances 배열이 없습니다.');
    var idx = validateSafeInteger(kungfuIndex, 0, arr.length - 1, 'kungfuIndex');
    var lv = validateSafeInteger(level, 1, 15, 'kungfu level');
    var ex = (exp !== null && exp !== undefined) ? validateSafeInteger(exp, 0, 99999999, 'kungfu exp') : null;
    var ki = arr[idx];
    if (!isObj(ki)) throw new Error('무공 인스턴스가 올바르지 않습니다.');
    objSet(ki, 'm_level', makeNum(lv), true);
    if (ex !== null) objSet(ki, 'm_exp', makeNum(ex), true);
    this._markDirty(this._charactersFileRole());
    this._log('setCharacterKungfuLevel', { instanceId: String(instanceId), index: idx, level: lv });
    return lv;
  };

  SlotSession.prototype.maxAllCharacterKungfu = function (instanceId) {
    var node = this._charNodeForWrite(instanceId);
    var arr = objGet(node, 'kungfuInstances');
    if (!Array.isArray(arr)) return 0;
    var count = 0;
    for (var i = 0; i < arr.length; i++) {
      var ki = arr[i];
      if (!isObj(ki)) continue;
      var kuid = numToIntString(objGet(ki, 'm_templeteUid'));
      var cat = this.lookups.kungfu.get(kuid);
      var maxLevel = cat && cat.maxLevel ? cat.maxLevel : 10;
      if (maxLevel > 15) maxLevel = 15;
      objSet(ki, 'm_level', makeNum(maxLevel), true);
      count++;
    }
    this._markDirty(this._charactersFileRole());
    this._log('maxAllCharacterKungfu', { instanceId: String(instanceId), count: count });
    return count;
  };

  SlotSession.prototype.addCharacterKungfu = function (instanceId, kungfuUid, level) {
    level = level === undefined ? 10 : level;
    var node = this._charNodeForWrite(instanceId);
    var uidNum = validateSafeInteger(kungfuUid, 1, 2147483647, 'kungfuUid');
    var uidStr = String(uidNum);
    var lv = validateSafeInteger(level, 1, 15, 'kungfu level');
    var arr = objGet(node, 'kungfuInstances');
    if (Array.isArray(arr)) {
      for (var i = 0; i < arr.length; i++) {
        if (isObj(arr[i]) && numToIntString(objGet(arr[i], 'm_templeteUid')) === uidStr) {
          throw new Error('이미 습득한 무공입니다: ' + uidStr);
        }
      }
    } else {
      arr = [];
      objSet(node, 'kungfuInstances', arr);
    }
    var entry = makeObj([
      ['IsNew', false, true],
      ['m_templeteUid', makeNum(uidNum), true],
      ['m_level', makeNum(lv), true],
      ['m_exp', makeNum(0), true]
    ]);
    arr.push(entry);
    this._markDirty(this._charactersFileRole());
    this._log('addCharacterKungfu', { instanceId: String(instanceId), uid: uidStr, level: lv });
    return true;
  };

  SlotSession.prototype.removeCharacterKungfu = function (instanceId, kungfuIndex) {
    var node = this._charNodeForWrite(instanceId);
    var arr = objGet(node, 'kungfuInstances');
    if (!Array.isArray(arr)) throw new Error('kungfuInstances 배열이 없습니다.');
    var idx = validateSafeInteger(kungfuIndex, 0, arr.length - 1, 'kungfuIndex');
    arr.splice(idx, 1);
    this._markDirty(this._charactersFileRole());
    this._log('removeCharacterKungfu', { instanceId: String(instanceId), index: idx });
    return true;
  };

  SlotSession.prototype.addCharacterTrait = function (instanceId, traitUid) {
    var node = this._charNodeForWrite(instanceId);
    var uidNum = validateSafeInteger(traitUid, 0, 2147483647, 'traitUid');
    var arr = objGet(node, 'Traits');
    if (!Array.isArray(arr)) {
      arr = [];
      objSet(node, 'Traits', arr);
    }
    var uidStr = String(uidNum);
    for (var i = 0; i < arr.length; i++) {
      if (numToIntString(arr[i]) === uidStr) return false;
    }
    arr.push(makeNum(uidNum));
    this._markDirty(this._charactersFileRole());
    this._log('addCharacterTrait', { instanceId: String(instanceId), uid: uidNum });
    return true;
  };

  SlotSession.prototype.removeCharacterTrait = function (instanceId, traitUid) {
    var node = this._charNodeForWrite(instanceId);
    var arr = objGet(node, 'Traits');
    if (!Array.isArray(arr)) return false;
    var uidStr = String(validateSafeInteger(traitUid, 0, 2147483647, 'traitUid'));
    for (var i = 0; i < arr.length; i++) {
      if (numToIntString(arr[i]) === uidStr) {
        arr.splice(i, 1);
        this._markDirty(this._charactersFileRole());
        this._log('removeCharacterTrait', { instanceId: String(instanceId), uid: uidStr });
        return true;
      }
    }
    return false;
  };

  SlotSession.prototype.setCharacterRelation = function (instanceId, targetNpcId, affinity) {
    var node = this._charNodeForWrite(instanceId);
    var aff = validateSafeInteger(affinity, -100, 100, 'affinity');
    var tid = validateSafeInteger(targetNpcId, 0, 2147483647, 'targetNpcId');
    var rel = objGet(node, 'relationShip');
    if (!isObj(rel)) {
      rel = makeObj([]);
      objSet(node, 'relationShip', rel);
    }
    objSet(rel, String(tid), makeNum(aff), false);
    this._markDirty(this._charactersFileRole());
    this._log('setCharacterRelation', { instanceId: String(instanceId), target: tid, affinity: aff });
    return aff;
  };

  SlotSession.prototype.maxAllCharacterRelations = function (instanceId, value) {
    if (value === undefined) value = 100;
    var aff = validateSafeInteger(value, -100, 100, 'affinity');
    var node = this._charNodeForWrite(instanceId);
    var rel = objGet(node, 'relationShip');
    if (!isObj(rel)) return 0;
    var count = 0;
    for (var i = 0; i < rel.entries.length; i++) {
      rel.entries[i].value = makeNum(aff);
      count++;
    }
    this._markDirty(this._charactersFileRole());
    this._log('maxAllCharacterRelations', { instanceId: String(instanceId), value: aff, count: count });
    return count;
  };

  // ============================================================
  // Factions
  // ============================================================
  SlotSession.prototype._factionsMap = function () {
    var root = this._dataValue('factions');
    if (!isObj(root)) return null;
    var f = objGet(root, 'factions');
    return isObj(f) ? f : null;
  };

  SlotSession.prototype.getFactions = function (opts) {
    opts = opts || {};
    var query = (opts.query || '').toString().toLowerCase().trim();
    var map = this._factionsMap();
    if (!map) return [];
    var out = [];
    for (var i = 0; i < map.entries.length; i++) {
      var e = map.entries[i];
      var uid = e.key;
      var node = e.value;
      var templeteId = parseInt(uid, 10) || 0;
      var playerFame = 0;
      var IsDiscovered = false;
      if (isObj(node)) {
        templeteId = readNumField(node, 'templeteId', templeteId);
        playerFame = readNumField(node, 'playerFame', readNumField(node, 'fame', readNumField(node, 'Fame', 0)));
        IsDiscovered = readBoolField(node, 'IsDiscovered', readBoolField(node, 'isDiscovered', false));
      } else if (isNum(node)) {
        playerFame = numToFloat(node, 0);
      }
      var cat = this.lookups.factions.get(String(templeteId)) || this.lookups.factions.get(uid);
      var koName = cat ? (cat.koName || cat.name || '') : ('#' + uid);
      var zhName = cat ? (cat.zhName || '') : '';
      if (query) {
        var hay = (koName + ' ' + zhName + ' ' + uid + ' ' + templeteId).toLowerCase();
        if (hay.indexOf(query) < 0) continue;
      }
      out.push({
        uid: String(uid),
        templeteId: templeteId,
        koName: koName,
        zhName: zhName,
        canRest: cat ? (cat.canRest || 0) : 0,
        playerFame: playerFame,
        fame: playerFame,
        IsDiscovered: IsDiscovered,
        isDiscovered: IsDiscovered
      });
    }
    return out;
  };

  SlotSession.prototype.setFactionFame = function (factionId, fame, isDiscovered) {
    this._assertRoleWritable('factions');
    var fid = validateSafeInteger(factionId, 0, 2147483647, 'factionUid');
    var f = validateSafeInteger(fame, -100, 100, 'fame');
    var map = this._factionsMap();
    if (!map) throw new Error('factions 세이브가 로드되지 않았습니다.');
    var uidStr = String(fid);
    var existingVal = objGet(map, uidStr);
    var node = null;
    var created = false;

    if (isObj(existingVal)) {
      node = existingVal;
    } else if (isNum(existingVal)) {
      node = makeObj([['templeteId', makeNum(fid), true]]);
      objSet(map, uidStr, node, false);
    } else {
      for (var i = 0; i < map.entries.length; i++) {
        var ent = map.entries[i];
        if (isObj(ent.value) && readNumField(ent.value, 'templeteId', NaN) === fid) {
          node = ent.value;
          uidStr = String(ent.key);
          break;
        }
      }
    }

    if (!isObj(node)) {
      node = makeObj([['templeteId', makeNum(fid), true]]);
      objSet(map, uidStr, node, false);
      created = true;
    }

    var existingTid = readNumField(node, 'templeteId', NaN);
    if (created || !isFinite(existingTid)) objSet(node, 'templeteId', makeNum(fid), true);
    objSet(node, 'playerFame', makeNum(f), true);
    objDelete(node, 'fame');

    if (isDiscovered !== undefined || created) {
      objSet(node, 'IsDiscovered', isDiscovered !== undefined ? !!isDiscovered : true, true);
      objDelete(node, 'isDiscovered');
    }

    this._markDirty('factions');
    this._log('setFactionFame', {
      uid: uidStr,
      templeteId: isFinite(existingTid) ? existingTid : fid,
      playerFame: f,
      IsDiscovered: isDiscovered !== undefined ? !!isDiscovered : (created ? true : undefined)
    });
    return f;
  };

  // ============================================================
  // Fief / Homestead
  // ============================================================
  SlotSession.prototype._resolveFiefNode = function (role, propName, createIfMissing, allowCreateEntry) {
    var dv = this._dataValue(role);
    if (!isObj(dv)) return null;

    if (!objHas(dv, propName)) {
      if (!createIfMissing || !allowCreateEntry) return null;
      var created = makeObj([
        ['buildingLevelDict', makeObj([]), true]
      ]);
      objSet(dv, propName, created, true);
      return created;
    }

    var node = objGet(dv, propName);
    if (!isObj(node)) {
      if (!createIfMissing) return null;
      node = makeObj([
        ['buildingLevelDict', makeObj([]), true]
      ]);
      objSet(dv, propName, node, true);
      return node;
    }

    if (objHas(node, 'value')) {
      var inner = objGet(node, 'value');
      if (!isObj(inner)) {
        if (!createIfMissing) return null;
        if (inner !== null) {
          throw new Error(propName + '.value 객체 형식이 올바르지 않습니다.');
        }
        inner = makeObj([
          ['buildingLevelDict', makeObj([]), true]
        ]);
        objSet(node, 'value', inner, true);
        return inner;
      }
      node = inner;
    }

    if (createIfMissing && !isObj(objGet(node, 'buildingLevelDict'))) {
      objSet(node, 'buildingLevelDict', makeObj([]), true);
    }
    return node;
  };

  SlotSession.prototype._getGlobalFiefData = function (createIfMissing) {
    return this._resolveFiefNode('global', 'fiefSharedData', !!createIfMissing, true);
  };

  SlotSession.prototype._getPrivateFiefData = function (createIfMissing, allowCreateEntry) {
    return this._resolveFiefNode('game', 'privateFiefSharedData', !!createIfMissing, !!allowCreateEntry);
  };

  SlotSession.prototype.getFiefBuildings = function () {
    var globalData = this._getGlobalFiefData(false);
    var dict = null;
    if (isObj(globalData)) {
      dict = objGet(globalData, 'buildingLevelDict');
    }
    if (!isObj(dict)) {
      var privateData = this._getPrivateFiefData(false, false);
      if (isObj(privateData)) {
        dict = objGet(privateData, 'buildingLevelDict');
      }
    }

    var result = [];
    for (var i = 0; i < this.catalog.fiefBuildings.length; i++) {
      var def = this.catalog.fiefBuildings[i];
      var level = 0;
      if (isObj(dict)) {
        var v = objGet(dict, String(def.saveId));
        if (v !== undefined) level = numToFloat(v, 0);
      }
      result.push({
        saveId: def.saveId,
        uid: def.uid,
        koName: def.koName || '',
        zhName: def.zhName || '',
        level: level,
        maxLevel: def.maxLevel || 5
      });
    }
    return result;
  };

  SlotSession.prototype.setFiefBuildingLevel = function (saveId, level) {
    var sid = validateSafeInteger(saveId, 0, 1000000, 'saveId');
    var def = null;
    for (var i = 0; i < this.catalog.fiefBuildings.length; i++) {
      if (this.catalog.fiefBuildings[i].saveId === sid) {
        def = this.catalog.fiefBuildings[i];
        break;
      }
    }
    var maxLevel = def && def.maxLevel ? def.maxLevel : 5;
    var lv = validateSafeInteger(level, 0, maxLevel, 'level');

    var writeLevelToFief = function (fiefData) {
      var dict = objGet(fiefData, 'buildingLevelDict');
      if (!isObj(dict)) {
        dict = makeObj([]);
        objSet(fiefData, 'buildingLevelDict', dict, true);
      }
      objSet(dict, String(sid), makeNum(lv), false);
    };

    var hasGlobal = !!(this.files && this.files['global']);
    var hasGame = !!(this.files && this.files['game']);
    if (hasGlobal) this._assertRoleWritable('global');
    if (hasGame) this._assertRoleWritable('game');
    if (!hasGlobal && !hasGame) {
      throw new Error('가원 세이브(Global 또는 Game)가 로드되지 않았습니다.');
    }
    if (hasGlobal && !isObj(this._dataValue('global'))) {
      throw new Error('Global 세이브의 Data 래퍼가 유효하지 않습니다.');
    }
    if (hasGame && !isObj(this._dataValue('game'))) {
      throw new Error('Game 세이브의 Data 래퍼가 유효하지 않습니다.');
    }

    var fiefWrapperSpecs = [
      ['global', 'fiefSharedData', hasGlobal],
      ['game', 'privateFiefSharedData', hasGame]
    ];
    var fiefWrapperIndex;
    for (fiefWrapperIndex = 0; fiefWrapperIndex < fiefWrapperSpecs.length; fiefWrapperIndex++) {
      if (!fiefWrapperSpecs[fiefWrapperIndex][2]) continue;
      var dv = this._dataValue(fiefWrapperSpecs[fiefWrapperIndex][0]);
      var propName = fiefWrapperSpecs[fiefWrapperIndex][1];
      if (objHas(dv, propName)) {
        var fNode = objGet(dv, propName);
        if (fNode !== null && fNode !== undefined && !isObj(fNode)) {
          throw new Error(propName + ' 객체 형식이 올바르지 않습니다.');
        }
        if (isObj(fNode) && objHas(fNode, 'value')) {
          var fInner = objGet(fNode, 'value');
          if (fInner !== null && !isObj(fInner)) {
            throw new Error(propName + '.value 객체 형식이 올바르지 않습니다.');
          }
        }
      }
    }

    var updated = false;
    if (hasGlobal) {
      var gData = this._getGlobalFiefData(true);
      if (isObj(gData)) {
        writeLevelToFief(gData);
        this._markDirty('global');
        updated = true;
      }
    }

    if (hasGame) {
      var pData = this._getPrivateFiefData(true, !hasGlobal);
      if (isObj(pData)) {
        writeLevelToFief(pData);
        this._markDirty('game');
        updated = true;
      }
    }

    if (!updated) {
      throw new Error('가원 세이브(Global 또는 Game)가 로드되지 않았습니다.');
    }

    this._log('setFiefBuildingLevel', { saveId: sid, level: lv, maxLevel: maxLevel });
    return lv;
  };

  // ============================================================
  // Pagoda / Time
  // ============================================================
  SlotSession.prototype._applyIntPatch = function (role, errMsg, actionName, patch, rules) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      throw new TypeError('patch must be an object');
    }
    this._assertRoleWritable(role);

    var node = this._dataValue(role);
    if (!isObj(node)) throw new Error(errMsg);

    var ops = [];
    var changed = {};
    for (var i = 0; i < rules.length; i++) {
      var k = rules[i][0];
      if (Object.prototype.hasOwnProperty.call(patch, k)) {
        var v = validateSafeInteger(patch[k], rules[i][1], rules[i][2], k);
        ops.push([k, v]);
        changed[k] = v;
      }
    }

    if (ops.length > 0) {
      for (var j = 0; j < ops.length; j++) {
        objSet(node, ops[j][0], makeNum(ops[j][1]), true);
      }
      this._markDirty(role);
      this._log(actionName, changed);
    }
    return changed;
  };

  SlotSession.prototype.getPagoda = function () {
    var p = this._dataValue('pagoda');
    return {
      CurStage: p ? readNumField(p, 'CurStage', 0) : 0,
      CurScore: p ? readNumField(p, 'CurScore', 0) : 0,
      HistoryBestStage: p ? readNumField(p, 'HistoryBestStage', 0) : 0,
      HistoryBestScore: p ? readNumField(p, 'HistoryBestScore', 0) : 0
    };
  };

  SlotSession.prototype.setPagoda = function (patch) {
    var rules = [
      ['CurStage', 0, 99999999],
      ['CurScore', 0, 99999999],
      ['HistoryBestStage', 0, 99999999],
      ['HistoryBestScore', 0, 99999999]
    ];
    return this._applyIntPatch('pagoda', 'pagoda 세이브가 로드되지 않았습니다.', 'setPagoda', patch, rules);
  };

  SlotSession.prototype.getGameTime = function () {
    var t = this._dataValue('time');
    return {
      Year: t ? readNumField(t, 'Year', 1) : 1,
      Month: t ? readNumField(t, 'Month', 1) : 1,
      Day: t ? readNumField(t, 'Day', 1) : 1,
      Dhour: t ? readNumField(t, 'Dhour', 0) : 0,
      Quarter: t ? readNumField(t, 'Quarter', 0) : 0
    };
  };

  SlotSession.prototype.setGameTime = function (patch) {
    var rules = [
      ['Year', 1, 9999],
      ['Month', 1, 12],
      ['Day', 1, 30],
      ['Dhour', 0, 11],
      ['Quarter', 0, 7]
    ];
    return this._applyIntPatch('time', 'time 세이브가 로드되지 않았습니다.', 'setGameTime', patch, rules);
  };

  // ============================================================
  // One-click presets
  // ============================================================
  SlotSession.prototype._findCurrencyIdByName = function (nameMatch) {
    for (var i = 0; i < this.catalog.currencies.length; i++) {
      var c = this.catalog.currencies[i];
      var hay = ((c.koName || '') + ' ' + (c.zhName || '')).toLowerCase();
      if (hay.indexOf(String(nameMatch).toLowerCase()) >= 0) return c.id;
    }
    return null;
  };

  SlotSession.prototype.applyPreset = function (presetId) {
    var applied = [];
    var self = this;
    function done() {
      self._log('applyPreset', { presetId: presetId, applied: applied });
      return applied;
    }
    var fileSnaps = Object.create(null);
    var fileKeys = Object.keys(this.files);
    for (var fsi = 0; fsi < fileKeys.length; fsi++) {
      var k = fileKeys[fsi], f = this.files[k];
      fileSnaps[k] = {
        parsedText: (f.parsed && !f.originalParseFailed) ? stringifyEs3Json(f.parsed) : null,
        dirty: f.dirty, revision: f.revision,
        bytes: f.bytes ? cloneBytes(f.bytes) : null
      };
    }
    var prevChangeLogLen = this.changeLog.length;
    var prevUndoLen = this._undoStack ? this._undoStack.length : 0;
    try {
      if (presetId === 'wealth_package' || presetId === 'hero_core_max' || presetId === 'hero_all_life_skills' || presetId === 'all_life_skills_max' || presetId === 'hero_virtue_max' || presetId === 'party_kungfu_max' || presetId === 'diplomacy_max') {
        this._assertRoleWritable('playerTeam');
      }

      var proto = null;
      try { proto = this._getProtagonist(); } catch (e) { proto = null; }

      if (presetId === 'wealth_package') {
        this._assertRoleWritable('characters');
        if (proto) this._assertCharactersWritable();
        var currencies = this.getCurrencies() || [];
        var curMap = {};
        for (var ci = 0; ci < currencies.length; ci++) {
          var cc = currencies[ci] || {};
          curMap[cc.id] = cc;
        }
        var up = [
          { id: 0, value: 99999999 },
          { id: 1, value: 99999 },
          { id: 2, value: 999999 },
          { id: 3, value: 999999 }
        ];
        for (var ui = 0; ui < up.length; ui++) {
          var uid = up[ui].id;
          var oldVal = curMap[uid] ? (Number(curMap[uid].value) || 0) : 0;
          var newVal = Math.max(oldVal, up[ui].value);
          this.setCurrency(uid, newVal);
          applied.push('currency.' + uid + '=' + newVal);
        }
        if (proto) {
          var wOrigin = proto.originProps || {};
          var acupointVal = Math.max(Number(wOrigin['冲穴点数']) || 0, 999);
          var expVal = Math.max(Number(wOrigin['江湖历练']) || 0, 999999);
          this.setCharacterProp(proto.instanceId, 'origin', '冲穴点数', acupointVal);
          this.setCharacterProp(proto.instanceId, 'origin', '江湖历练', expVal);
          applied.push('origin.冲穴点数=' + acupointVal);
          applied.push('origin.江湖历练=' + expVal);
        }
        return done();
      }

      if (presetId === 'hero_core_max') {
        if (!proto) throw new Error('주인공 캐릭터를 찾을 수 없습니다.');
        var cOrigin = proto.originProps || {};
        var coreStats = ['臂力', '体质', '敏捷', '悟性', '福缘'];
        for (var cs = 0; cs < coreStats.length; cs++) {
          var ck = coreStats[cs];
          var cv = Math.max(Number(cOrigin[ck]) || 0, 25);
          this.setCharacterProp(proto.instanceId, 'origin', ck, cv);
          applied.push('origin.' + ck + '=' + cv);
        }
        var extra = [
          { key: '冲穴点数', value: 999 },
          { key: '江湖历练', value: 999999 },
          { key: '武学常识', value: 500 },
          { key: '实战能力', value: 500 }
        ];
        for (var ex = 0; ex < extra.length; ex++) {
          var ek = extra[ex].key;
          var ev = Math.max(Number(cOrigin[ek]) || 0, extra[ex].value);
          this.setCharacterProp(proto.instanceId, 'origin', ek, ev);
          applied.push('origin.' + ek + '=' + ev);
        }
        return done();
      }

      if (presetId === 'hero_all_life_skills' || presetId === 'all_life_skills_max') {
        if (!proto) throw new Error('주인공 캐릭터를 찾을 수 없습니다.');
        var skillKeys = DEFAULT_LIFE_SKILL_KEYS.slice();
        var abilities = this.catalog && this.catalog.characterProps && this.catalog.characterProps.abilities;
        if (abilities && abilities.length === 26) {
          var tmpSkills = [];
          for (var ai = 0; ai < abilities.length; ai++) {
            var a = abilities[ai];
            var ak = typeof a === 'string' ? a : (a && (a.key || a.name || a.zhName || a.value));
            if (typeof ak !== 'string' || ak.indexOf('能力_') !== 0) { tmpSkills = null; break; }
            tmpSkills.push(ak);
          }
          if (tmpSkills && tmpSkills.length === 26) skillKeys = tmpSkills;
        }
        var addProps = proto.additionProps || {};
        for (var si = 0; si < skillKeys.length; si++) {
          var sk = skillKeys[si];
          var sv = Math.max(Number(addProps[sk]) || 0, 5);
          this.setCharacterProp(proto.instanceId, 'addition', sk, sv);
          applied.push('addition.' + sk + '=' + sv);
        }
        return done();
      }

      if (presetId === 'hero_virtue_max') {
        if (!proto) throw new Error('주인공 캐릭터를 찾을 수 없습니다.');
        var virtues = ['仁德', '义气', '礼节', '智慧', '信用', '勇气'];
        for (var vi = 0; vi < virtues.length; vi++) {
          var vk = virtues[vi];
          this.setCharacterProp(proto.instanceId, 'origin', vk, 100);
          applied.push('origin.' + vk + '=100');
        }
        return done();
      }

      if (presetId === 'party_kungfu_max') {
        var ids = this._playerTeamIds() || [];
        if (!ids.length) ids = proto ? [proto.instanceId] : [];
        if (!ids.length) throw new Error('대상 캐릭터를 찾을 수 없습니다.');
        var details = [];
        for (var pi = 0; pi < ids.length; pi++) {
          var d = this.getCharacterDetail(ids[pi]);
          if (!d) throw new Error('캐릭터를 찾을 수 없습니다: ' + ids[pi]);
          details.push(d);
        }
        for (var pj = 0; pj < details.length; pj++) {
          var detail = details[pj], kfs = detail.kungfuList || [];
          for (var ki = 0; ki < kfs.length; ki++) {
            var kf = kfs[ki] || {};
            var targetLv = Math.max(Number(kf.level) || 0, Number(kf.maxLevel) || 10);
            this.setCharacterKungfuLevel(detail.instanceId, kf.index, targetLv);
            applied.push('kungfu.' + detail.instanceId + '.' + kf.index + '=' + targetLv);
          }
          var dOrigin = detail.originProps || {};
          var curHp = Math.max(Number(detail.curHp) || 0, Number(dOrigin['生命']) || 0, 9999);
          var curEp = Math.max(Number(detail.curEp) || 0, Number(dOrigin['内力']) || 0, 9999);
          this.setCharacterBasic(detail.instanceId, { curHp: curHp, curEp: curEp });
          applied.push('hp.' + detail.instanceId + '=' + curHp);
          applied.push('ep.' + detail.instanceId + '=' + curEp);
        }
        return done();
      }

      if (presetId === 'fief_all_max' || presetId === 'homestead_max') {
        var buildings = this.catalog && this.catalog.fiefBuildings || [];
        for (var fi = 0; fi < buildings.length; fi++) {
          var b = buildings[fi] || {};
          var lv = b.maxLevel || 5;
          this.setFiefBuildingLevel(b.saveId, lv);
          applied.push('fief.' + b.saveId + '=' + lv);
        }
        return done();
      }

      if (presetId === 'diplomacy_max') {
        this._assertRoleWritable('characters');
        this._assertRoleWritable('factions');
        var ccDip = this._createdCharacters();
        if (ccDip && Array.isArray(ccDip.entries) && ccDip.entries.length > 0 && !proto) throw new Error('주인공 캐릭터를 찾을 수 없습니다.');
        if (proto) this._assertCharactersWritable();
        if (proto) {
          var relations = proto.relations || [];
          if (relations.length !== undefined) {
            for (var ri = 0; ri < relations.length; ri++) {
              var rel = relations[ri] || {};
              var targetId = rel.targetId !== undefined ? rel.targetId :
                (rel.targetNpcId !== undefined ? rel.targetNpcId : rel.id);
              if (targetId === undefined || targetId === null) continue;
              this.setCharacterRelation(proto.instanceId, targetId, 100);
              applied.push('relation.' + targetId + '=100');
            }
          } else {
            for (var rk in relations) {
              if (!Object.prototype.hasOwnProperty.call(relations, rk)) continue;
              var rel2 = relations[rk] || {};
              var targetId2 = rel2.targetId !== undefined ? rel2.targetId :
                (rel2.targetNpcId !== undefined ? rel2.targetNpcId : rk);
              this.setCharacterRelation(proto.instanceId, targetId2, 100);
              applied.push('relation.' + targetId2 + '=100');
            }
          }
        }
        var factions = this.getFactions() || [];
        for (var f0 = 0; f0 < factions.length; f0++) {
          var fac = factions[f0] || {};
          if (fac.IsDiscovered === true) {
            var fid = fac.uid !== undefined ? fac.uid : fac.templeteId;
            this.setFactionFame(fid, 100, fac.IsDiscovered);
            applied.push('faction.' + fid + '=100');
          }
        }
        return done();
      }

      throw new Error('알 수 없는 프리셋입니다: ' + presetId);
    } catch (err) {
      var snapKeys = Object.keys(fileSnaps);
      for (var sri = 0; sri < snapKeys.length; sri++) {
        var sk = snapKeys[sri], snap = fileSnaps[sk], sf = this.files[sk];
        if (!sf) continue;
        if (snap.parsedText !== null) {
          var restored = parseEs3Json(snap.parsedText);
          sf.parsed = restored; sf.ast = restored;
        }
        sf.dirty = snap.dirty; sf.revision = snap.revision;
        sf.bytes = snap.bytes ? cloneBytes(snap.bytes) : null;
      }
      this.changeLog.length = prevChangeLogLen;
      if (this._undoStack) this._undoStack.length = prevUndoLen;
      throw err;
    }
  };

  // ============================================================
  // UI Catalog Search & Raw Viewer helpers
  // ============================================================
  SlotSession.prototype.searchCatalogItems = function (query, category, rarity, limit) {
    if (query && typeof query === 'object') {
      var o = query;
      query = o.query; category = o.category; rarity = o.rarity; limit = o.limit;
    }
    if (query === undefined || query === null) query = '';
    if (category === undefined || category === null) category = 'all';
    if (rarity === undefined || rarity === null) rarity = -1;
    if (limit === undefined || limit === null) limit = 100;
    query = String(query).toLowerCase();
    category = String(category);
    rarity = Number(rarity);
    limit = Number(limit);
    if (!isFinite(limit) || limit < 0) limit = 100;

    var out = [];
    var list = (this.catalog && this.catalog.itemList) || [];
    for (var i = 0; i < list.length && out.length < limit; i++) {
      var it = list[i] || {};
      if (category !== 'all') {
        var itemCat = it.category !== undefined ? it.category : it.type;
        if (String(itemCat) !== category) continue;
      }
      if (rarity >= 0 && Number(it.rarity) !== rarity) continue;
      var hay = ((it.koName || '') + ' ' + (it.zhName || '') + ' ' + String(it.uid)).toLowerCase();
      if (query && hay.indexOf(query) < 0) continue;
      out.push(it);
    }
    return out;
  };

  SlotSession.prototype.searchCatalogKungfu = function (query, kungfuType, rarity, limit) {
    if (query && typeof query === 'object') {
      var o = query;
      query = o.query; kungfuType = o.kungfuType; rarity = o.rarity; limit = o.limit;
    }
    if (query === undefined || query === null) query = '';
    if (kungfuType === undefined || kungfuType === null) kungfuType = -1;
    if (rarity === undefined || rarity === null) rarity = -1;
    if (limit === undefined || limit === null) limit = 100;
    query = String(query).toLowerCase();
    kungfuType = Number(kungfuType);
    rarity = Number(rarity);
    limit = Number(limit);
    if (!isFinite(limit) || limit < 0) limit = 100;

    var out = [];
    var list = (this.catalog && this.catalog.kungfuList) || [];
    for (var i = 0; i < list.length && out.length < limit; i++) {
      var it = list[i] || {};
      if (kungfuType >= 0 && Number(it.kungfuType) !== kungfuType) continue;
      if (rarity >= 0 && Number(it.rarity) !== rarity) continue;
      var hay = ((it.koName || '') + ' ' + (it.zhName || '') + ' ' + String(it.uid)).toLowerCase();
      if (query && hay.indexOf(query) < 0) continue;
      out.push(it);
    }
    return out;
  };

  SlotSession.prototype.searchCatalogTraits = function (query, rarity, limit) {
    if (query && typeof query === 'object') {
      var o = query;
      query = o.query; rarity = o.rarity; limit = o.limit;
    }
    if (query === undefined || query === null) query = '';
    if (rarity === undefined || rarity === null) rarity = -1;
    if (limit === undefined || limit === null) limit = 100;
    query = String(query).toLowerCase();
    rarity = Number(rarity);
    limit = Number(limit);
    if (!isFinite(limit) || limit < 0) limit = 100;

    var out = [];
    var list = (this.catalog && this.catalog.traitList) || [];
    for (var i = 0; i < list.length && out.length < limit; i++) {
      var it = list[i] || {};
      if (rarity >= 0 && Number(it.rarity) !== rarity) continue;
      var hay = ((it.koName || '') + ' ' + (it.zhName || '') + ' ' +
        (it.desc || '') + ' ' + String(it.uid)).toLowerCase();
      if (query && hay.indexOf(query) < 0) continue;
      out.push(it);
    }
    return out;
  };

  SlotSession.prototype.searchAcupoints = function (query, meridianKey) {
    if (query && typeof query === 'object') {
      var o = query;
      query = o.query; meridianKey = o.meridianKey;
    }
    if (query === undefined || query === null) query = '';
    if (meridianKey === undefined || meridianKey === null) meridianKey = 'all';
    query = String(query).toLowerCase();
    meridianKey = String(meridianKey);

    var out = [];
    var list = (this.catalog && this.catalog.acupointList) || [];
    for (var i = 0; i < list.length; i++) {
      var it = list[i] || {};
      if (meridianKey && meridianKey !== 'all' && String(it.meridianKey) !== meridianKey) continue;
      var idx = it.idx !== undefined ? it.idx : i;
      var hay = ((it.uName || '') + ' ' + (it.meridianKo || '') + ' ' + (it.meridianKey || '') +
        ' ' + (it.acupointType || '') + ' ' + (it.effectKo || '') + ' ' + String(idx)).toLowerCase();
      if (query && hay.indexOf(query) < 0) continue;
      out.push(it);
    }
    return out;
  };

  SlotSession.prototype.listLoadedFiles = function () {
    var keys = [];
    var seen = {};
    var order = this.roleOrder || [];
    for (var i = 0; i < order.length; i++) {
      var ok = order[i];
      if (this.files[ok] && !seen[ok]) { keys.push(ok); seen[ok] = true; }
    }
    var allKeys = Object.keys(this.files);
    for (var j = 0; j < allKeys.length; j++) {
      var k = allKeys[j];
      if (!seen[k]) { keys.push(k); seen[k] = true; }
    }
    var out = [];
    for (var n = 0; n < keys.length; n++) {
      var key = keys[n];
      var f = this.files[key];
      if (!f) continue;
      out.push({
        kind: f.kind || f.role || key,
        fileName: f.fileName || f.name,
        mode: f.mode,
        passwordUsed: f.passwordUsed !== undefined ? f.passwordUsed : null,
        dirty: !!f.dirty
      });
    }
    return out;
  };

  SlotSession.prototype.getRawFileText = function (kind) {
    var entry = this.files[kind];
    if (!entry) {
      var found = null;
      try { found = this._findFileEntry(kind); } catch (e) { found = null; }
      if (typeof found === 'string') entry = this.files[found];
      else entry = found;
    }
    if (!entry) {
      var keys = Object.keys(this.files);
      for (var i = 0; i < keys.length; i++) {
        var f = this.files[keys[i]];
        if (f && (f.fileName === kind || f.name === kind)) { entry = f; break; }
      }
    }
    if (!entry) throw new Error('로드되지 않은 파일입니다: ' + kind);
    var astNode = entry.ast || entry.parsed;
    var serialize = C.serializeEs3Json || C.stringifyEs3Json;
    return astNode ? serialize(astNode) : (entry.originalText || '');
  };

  // ============================================================
  // Export / Reset
  // ============================================================
  SlotSession.prototype._serializeEntryText = function (f, updateTimestamp) {
    var text;
    if (updateTimestamp && f.parsed && isObj(f.parsed)) {
      var ts = objGet(f.parsed, 'TimeStamp');
      if (isObj(ts)) {
        var hadValue = objHas(ts, 'value');
        var prevEntry = ts.index ? ts.index.get('value') : null;
        var prevVal = hadValue ? objGet(ts, 'value') : undefined;
        var prevQuoted = prevEntry ? !!prevEntry.quoted : true;
        try {
          objSet(ts, 'value', makeNum(Math.floor(Date.now() / 1000)), prevQuoted);
          text = stringifyEs3Json(f.parsed);
        } finally {
          if (hadValue) objSet(ts, 'value', prevVal, prevQuoted);
          else objDelete(ts, 'value');
        }
        return text;
      }
    }
    text = stringifyEs3Json(f.parsed);
    return text;
  };

  function assertDecompressedLimit(text, mode, label) {
    if (mode === 'gzip' || mode === 'aes-gzip') {
      var byteLen = C.utf8Encode(text).byteLength;
      var limit = typeof C.getMaxDecompressedBytes === 'function' ? C.getMaxDecompressedBytes() : C.MAX_DECOMPRESSED_BYTES;
      if (byteLen > limit) {
        var err = new Error('세이브 직렬화 크기(' + byteLen + ' 바이트)가 허용 한도(' + limit + ' 바이트)를 초과하여 내보낼 수 없습니다: ' + (label || ''));
        err.code = 'ES3_DECOMPRESS_LIMIT';
        throw err;
      }
    }
  }

  SlotSession.prototype._encodeSnapshots = async function (snaps, capturedToken, capturedPassword) {
    var out = [];
    for (var i = 0; i < snaps.length; i++) {
      var snap = snaps[i];
      var bytes;
      if (snap.parsed) {
        assertDecompressedLimit(snap.text, snap.mode, snap.name);
        bytes = cloneBytes(await C.encodeEs3Bytes(snap.text, { mode: snap.mode, password: capturedPassword }));
      } else {
        bytes = cloneBytes(snap.rawBytes);
      }
      out.push({
        key: snap.key,
        kind: snap.kind,
        name: snap.name,
        relativePath: snap.relativePath,
        bytes: bytes,
        text: snap.text,
        mode: snap.mode,
        revision: snap.revision,
        loadToken: capturedToken
      });
    }
    return out;
  };

  SlotSession.prototype._collectExportSnapshots = function (onlyDirty, options) {
    options = options || {};
    var updateTimestamp = !!options.updateTimestamp;
    var capturedToken = this._loadToken;
    var capturedPassword = this.password;
    var snaps = [];
    var keys = Object.keys(this.files);
    for (var i = 0; i < keys.length; i++) {
      var f = this.files[keys[i]];
      if (!f) continue;
      if (onlyDirty && (!f.dirty || !f.parsed)) continue;
      if (!f.parsed) {
        snaps.push({
          parsed: false,
          key: f.key,
          kind: f.kind || f.role || f.key,
          name: f.name,
          relativePath: f.relativePath,
          rawBytes: f.bytes ? cloneBytes(f.bytes) : new Uint8Array(0),
          text: f.originalText || '',
          mode: f.mode || 'plain',
          revision: f.revision || 0
        });
        continue;
      }
      var mode = f.mode || 'aes-gzip';
      var snapText = this._serializeEntryText(f, onlyDirty ? updateTimestamp : (updateTimestamp && !!f.dirty));
      assertDecompressedLimit(snapText, mode, f.name);
      snaps.push({
        parsed: true,
        key: f.key,
        kind: f.kind || f.role || f.key,
        name: f.name,
        relativePath: f.relativePath,
        text: snapText,
        mode: mode,
        revision: f.revision || 0
      });
    }
    return {
      snaps: snaps,
      capturedToken: capturedToken,
      capturedPassword: capturedPassword
    };
  };

  SlotSession.prototype.exportModifiedFiles = async function (options) {
    var collected = this._collectExportSnapshots(true, options);
    return await this._encodeSnapshots(
      collected.snaps,
      collected.capturedToken,
      collected.capturedPassword
    );
  };

  SlotSession.prototype.exportAllFiles = async function (options) {
    var collected = this._collectExportSnapshots(false, options);
    return await this._encodeSnapshots(
      collected.snaps,
      collected.capturedToken,
      collected.capturedPassword
    );
  };

  SlotSession.prototype.markSaved = function (savedEntries) {
    if (!Array.isArray(savedEntries) || !savedEntries.length || !this._loadToken) return 0;
    var preNonEmpty = 0;
    for (var p = 0; p < savedEntries.length; p++) {
      var pe = savedEntries[p];
      if (pe === null || pe === undefined) continue;
      if (typeof pe !== 'object' || typeof pe.loadToken !== 'string' || pe.loadToken !== this._loadToken) {
        return 0;
      }
      if (pe.bytes !== null && pe.bytes !== undefined) cloneBytes(pe.bytes);
      preNonEmpty++;
    }
    if (preNonEmpty === 0) return 0;

    var staged = [];
    for (var i = 0; i < savedEntries.length; i++) {
      var entry = savedEntries[i];
      if (!entry) continue;
      var f = null;
      if (entry.key && this.files[entry.key]) {
        f = this.files[entry.key];
      } else if (entry.kind && (this.files[entry.kind] || this._findFileEntry(entry.kind))) {
        f = this.files[entry.kind] || this._findFileEntry(entry.kind);
      } else {
        var keys = Object.keys(this.files);
        for (var j = 0; j < keys.length; j++) {
          var cand = this.files[keys[j]];
          if (!cand) continue;
          var nameMatch = (entry.name || entry.fileName) &&
            (cand.name === (entry.name || entry.fileName) || cand.fileName === (entry.name || entry.fileName));
          var pathMatch = entry.relativePath && cand.relativePath === entry.relativePath;
          if (pathMatch || nameMatch) {
            f = cand;
            break;
          }
        }
      }

      var targetMode = entry.mode || (f && f.mode) || 'aes-gzip';
      var sameRev = f ? (entry.revision === undefined || entry.revision === null || f.revision === entry.revision) : false;
      var savedText = typeof entry.text === 'string' ? entry.text : (f && !f.originalParseFailed && sameRev && f.parsed ? stringifyEs3Json(f.parsed) : null);
      if (typeof savedText === 'string') {
        assertDecompressedLimit(savedText, targetMode, entry.name || entry.fileName || (f && f.name) || entry.key || '');
      }
      if (!f) continue;
      staged.push({ entry: entry, f: f, sameRev: sameRev, savedText: savedText });
    }

    var matched = staged.length;
    for (var s = 0; s < staged.length; s++) {
      var stagedItem = staged[s];
      var entry2 = stagedItem.entry;
      var f2 = stagedItem.f;
      var sameRev2 = stagedItem.sameRev;
      var savedText2 = stagedItem.savedText;

      if (entry2.bytes !== null && entry2.bytes !== undefined) f2.originalBytes = cloneBytes(entry2.bytes);
      if (!f2.originalParseFailed && typeof savedText2 === 'string') {
        f2.originalText = savedText2;
      }
      if (sameRev2) {
        if (!f2.originalParseFailed && typeof savedText2 === 'string') {
          var synced = parseEs3Json(savedText2);
          f2.parsed = synced;
          f2.ast = synced;
        }
        if (f2.originalBytes) f2.bytes = cloneBytes(f2.originalBytes);
        f2.dirty = false;
      } else if (!f2.originalParseFailed && f2.parsed && typeof f2.originalText === 'string') {
        var curText = stringifyEs3Json(f2.parsed);
        f2.dirty = (curText !== stringifyEs3Json(parseEs3Json(f2.originalText)));
        if (f2.dirty && this.changeLog.length === 0) {
          this._log('divergedFromSavedBaseline', { key: f2.key || entry2.key || entry2.kind || '' });
        }
      }
    }
    if (matched > 0 && !this.hasUnsavedChanges()) {
      this.changeLog = [];
      this._undoStack = [];
    }
    return matched;
  };

  SlotSession.prototype.hasUnsavedChanges = function () {
    var keys = Object.keys(this.files || {});
    for (var i = 0; i < keys.length; i += 1) {
      var f = this.files[keys[i]];
      if (f && f.dirty === true) return true;
    }
    return false;
  };

  SlotSession.prototype._resetSingleFile = function (f) {
    if (!f) return false;
    if (f.originalParseFailed || f.originalText === null || f.originalText === undefined) {
      if (f.originalBytes) f.bytes = cloneBytes(f.originalBytes);
      f.parsed = null; f.ast = null; f.dirty = false; f.revision = (f.revision || 0) + 1;
      return false;
    }
    var parsed = parseEs3Json(f.originalText);
    f.parsed = parsed; f.ast = parsed;
    if (f.originalBytes) f.bytes = cloneBytes(f.originalBytes);
    f.dirty = false; f.revision = (f.revision || 0) + 1;
    return true;
  };

  SlotSession.prototype._syncPeerFiefOnReset = function (peerRole, propName) {
    var peer = this.files && this.files[peerRole];
    if (!peer || peer.originalParseFailed || typeof peer.originalText !== 'string' || !isObj(peer.parsed)) return;
    if ((this.ambiguousRoles && this.ambiguousRoles[peerRole]) || (this.brokenRoles && this.brokenRoles[peerRole])) return;
    var peerOrigRoot = parseEs3Json(peer.originalText);
    var peerOrigDv = this._resolveAST(peerOrigRoot);
    var peerCurDv = this._resolveAST(peer.parsed);
    if (!isObj(peerOrigDv) || !isObj(peerCurDv)) return;
    if (objHas(peerOrigDv, propName)) {
      var origEntry = peerOrigDv.index ? peerOrigDv.index.get(propName) : null;
      objSet(peerCurDv, propName, objGet(peerOrigDv, propName), origEntry ? !!origEntry.quoted : true);
    } else {
      objDelete(peerCurDv, propName);
    }
    var isDirty = (stringifyEs3Json(peer.parsed) !== stringifyEs3Json(peerOrigRoot));
    peer.dirty = isDirty;
    if (!isDirty) {
      peer.parsed = peerOrigRoot; peer.ast = peerOrigRoot;
      if (peer.originalBytes) peer.bytes = cloneBytes(peer.originalBytes);
    }
    peer.revision = (peer.revision || 0) + 1;
  };

  SlotSession.prototype.resetFile = function (fileKey) {
    var f = this.files[fileKey] || this._findFileEntry(fileKey);
    if (!f) return false;
    if (!this._resetSingleFile(f)) return false;
    if (f === this.files['game']) {
      this._syncPeerFiefOnReset('global', 'fiefSharedData');
    } else if (f === this.files['global']) {
      this._syncPeerFiefOnReset('game', 'privateFiefSharedData');
    }
    this._log('resetFile', { key: f.key || fileKey });
    return true;
  };

  SlotSession.prototype.resetAll = function () {
    var keys = Object.keys(this.files);
    for (var i = 0; i < keys.length; i++) {
      this._resetSingleFile(this.files[keys[i]]);
    }
    this.changeLog = [];
    this._undoStack = [];
    return true;
  };

  // ============================================================
  // Demo slot factory
  // ============================================================
  async function createDemoSlotFiles(catalog, password) {
    if (password === undefined) password = 'Meow';
    var cat = normalizeCatalog(catalog === undefined ? DefaultCatalog : catalog);

    function mkTimestamp() {
      return makeObj([
        ['__type', 'long', true],
        ['value', makeNum(1730652588), true]
      ]);
    }

    function mkSlot(className, valueNode) {
      var dataValue = makeObj([
        ['__type', 'WuLin.' + className + ',Assembly-CSharp', true],
        ['_ES3Ref', 'ref-' + className, true]
      ]);
      if (valueNode && valueNode.entries) {
        for (var i = 0; i < valueNode.entries.length; i++) {
          dataValue.entries.push(valueNode.entries[i]);
          dataValue.index.set(valueNode.entries[i].key, valueNode.entries[i]);
        }
      }
      return makeObj([
        ['Data', makeObj([
          ['__type', 'WuLin.SaveObjectBase,Assembly-CSharp', true],
          ['value', dataValue, true]
        ]), true],
        ['TimeStamp', mkTimestamp(), true]
      ]);
    }

    function mkItem(uid, stack, forgeLv, isNew) {
      var mod = null;
      if (forgeLv !== null) {
        mod = makeObj([
          ['forgeLevel', makeNum(forgeLv), true],
          ['extraAttr', makeObj([]), true]
        ]);
      }
      return makeObj([
        ['m_templeteId', makeNum(uid), true],
        ['m_stack', makeNum(stack), true],
        ['modifyData', mod, true],
        ['IsNew', isNew, true],
        ['IsForbidden', false, true]
      ]);
    }

    function mkTeamGroupDict() {
      return makeObj([
        ['-1', [makeNum(100401), makeNum(10005)], false],
        ['0', [makeNum(100401)], false]
      ]);
    }

    function mkFiefData() {
      return makeObj([
        ['__type', 'GameData.FiefData,Assembly-CSharp', true],
        ['value', makeObj([
          ['buildingLevelDict', makeObj([
            ['112', makeNum(3), false],
            ['104', makeNum(2), false],
            ['110', makeNum(2), false],
            ['113', makeNum(3), false],
            ['114', makeNum(2), false],
            ['102', makeNum(3), false],
            ['98', makeNum(2), false]
          ]), true]
        ]), true]
      ]);
    }

    function mkKungfu(list) {
      var out = [];
      for (var i = 0; i < list.length; i++) {
        out.push(makeObj([
          ['IsNew', false, true],
          ['m_templeteUid', makeNum(list[i][0]), true],
          ['m_level', makeNum(list[i][1]), true],
          ['m_exp', makeNum(100), true]
        ]));
      }
      return out;
    }

    function mkNums(list) {
      var out = [];
      for (var i = 0; i < list.length; i++) out.push(makeNum(list[i]));
      return out;
    }

    function mkTeamState(hp, ep) {
      return makeObj([
        ['isJoined', true, true],
        ['curHp', makeNum(hp), true],
        ['curEp', makeNum(ep), true]
      ]);
    }

    function mkOriginProps() {
      var o = makeObj([]);
      var bs = ['臂力', '体质', '敏捷', '悟性', '福缘'];
      for (var i = 0; i < bs.length; i++) objSet(o, bs[i], makeNum(12 + i), true);
      objSet(o, '生命', makeNum(3200), true);
      objSet(o, '内力', makeNum(1800), true);
      objSet(o, '实战能力', makeNum(120), true);
      objSet(o, '武学常识', makeNum(95), true);
      objSet(o, '冲穴点数', makeNum(12), true);
      objSet(o, '江湖历练', makeNum(8500), true);
      var es = ['仁德', '义气', '礼节', '智慧', '信用', '勇气'];
      for (var j = 0; j < es.length; j++) objSet(o, es[j], makeNum(50), true);
      return o;
    }

    function mkAdditionProps() {
      var o = makeObj([]);
      var ab = cat && cat.characterProps && cat.characterProps.abilities || [];
      for (var i = 0; i < ab.length; i++) {
        if (ab[i] && ab[i].key !== undefined) objSet(o, ab[i].key, makeNum(2), true);
      }
      return o;
    }

    function mkCharacter(uid, sur, given, title, lv, exp, ego, val, team, kg, traits, rels) {
      var relObj = makeObj([]);
      for (var i = 0; i < rels.length; i++) {
        objSet(relObj, String(rels[i][0]), makeNum(rels[i][1]), false);
      }
      return makeObj([
        ['m_templeteUid', makeNum(uid), true],
        ['m_surName', sur, true],
        ['m_givenName', given, true],
        ['m_overrideTitle', title, true],
        ['m_level', makeNum(lv), true],
        ['m_exp', makeNum(exp), true],
        ['m_egoState', makeNum(ego), true],
        ['m_valueState', makeNum(val), true],
        ['m_TeamMemberState', team, true],
        ['kungfuInstances', mkKungfu(kg), true],
        ['Traits', mkNums(traits), true],
        ['relationShip', relObj, true],
        ['m_originProps', mkOriginProps(), true],
        ['m_additionProps', mkAdditionProps(), true]
      ]);
    }

    var currenciesObj = makeObj([]);
    var currencyValues = [50000, 120, 850, 300, 0, 0, 0, 0, 0, 0];
    for (var ci = 0; ci < currencyValues.length; ci++) {
      objSet(currenciesObj, String(ci), makeNum(currencyValues[ci]), false);
    }

    var playerTeamRoot = makeObj([
      ['playerTeamInventory', makeObj([
        ['currencies', currenciesObj, true],
        ['contents', [
          mkItem(10164, 1, 5, false),
          mkItem(12061, 1, 3, false),
          mkItem(13066, 1, null, false),
          mkItem(14062, 12, null, true),
          mkItem(23301, 15, null, false),
          mkItem(23303, 8, null, false)
        ], true]
      ]), true],
      ['teamProps', makeObj([
        ['队伍体力', makeNum(80), true],
        ['队伍心情', makeNum(75), true]
      ]), true],
      ['playerTeam', [makeNum(100401), makeNum(10005)], true],
      ['teamGroupDict', mkTeamGroupDict(), true]
    ]);

    var c1 = mkCharacter(
      100401, '소', '하', '초출모려', 25, 12500, 50, 60,
      mkTeamState(3200, 1800), [[51601, 6], [40603, 5], [51606, 4]],
      [1054, 1060], [[10005, 85], [10001, 65]]
    );
    var c2 = mkCharacter(
      10005, '묘', '채접', '', 22, 8400, 40, 45,
      mkTeamState(1850, 1200), [[51601, 7]], [1020], [[100401, 85]]
    );
    var c3 = mkCharacter(
      10001, '장', '춘자', '', 45, 50000, 80, 85,
      null, [[51606, 9]], [1054], [[100401, 65]]
    );

    var charPropsRoot = makeObj([
      ['createdCharacter', makeObj([
        ['100401', c1, false],
        ['10005', c2, false],
        ['10001', c3, false]
      ]), true]
    ]);

    var factionsObj = makeObj([]);
    var factionData = [
      [3200, 60, true], [3100, 45, true], [3300, 30, true],
      [3800, 20, true], [4400, 50, true], [10, 15, false]
    ];
    for (var fi = 0; fi < factionData.length; fi++) {
      objSet(factionsObj, String(factionData[fi][0]), makeObj([
        ['templeteId', makeNum(factionData[fi][0]), true],
        ['playerFame', makeNum(factionData[fi][1]), true],
        ['IsDiscovered', factionData[fi][2], true]
      ]), false);
    }
    var factionsRoot = makeObj([
      ['factions', factionsObj, true]
    ]);

    var gameRoot = makeObj([
      ['privateFiefSharedData', mkFiefData(), true],
      ['teamGroupDict', mkTeamGroupDict(), true]
    ]);

    var timeRoot = makeObj([
      ['Year', makeNum(1), true],
      ['Month', makeNum(3), true],
      ['Day', makeNum(12), true],
      ['Dhour', makeNum(5), true],
      ['Quarter', makeNum(3), true],
      ['QuaterOfDay', makeNum('87.67666666666666666666666667'), true],
      ['simulatedTime', makeObj([
        ['ticks', makeNum('656099925099270000'), true]
      ]), true]
    ]);

    var pagodaRoot = makeObj([
      ['CurStage', makeNum(5), true],
      ['CurScore', makeNum(12000), true],
      ['HistoryBestStage', makeNum(9), true],
      ['HistoryBestScore', makeNum(34500), true]
    ]);

    var globalRoot = makeObj([
      ['ThirdPlatformId', makeNum('76561198000000000'), true],
      ['GlobalSaveVersion', makeNum(1), true],
      ['Data', makeObj([
        ['__type', 'WuLin.SaveObjectBase,Assembly-CSharp', true],
        ['value', makeObj([
          ['__type', 'WuLin.SaveObjectGameGlobal,Assembly-CSharp', true],
          ['_ES3Ref', 'ref-global', true],
          ['fiefSharedData', mkFiefData(), true]
        ]), true]
      ]), true],
      ['TimeStamp', mkTimestamp(), true]
    ]);

    var saveInfoRoot = makeObj([
      ['ThirdPlatformId', makeNum('76561198000000000'), true],
      ['Data', makeObj([
        ['__type', 'WuLin.SaveObjectBase,Assembly-CSharp', true],
        ['value', makeObj([
          ['__type', 'WuLin.SaveInfo,Assembly-CSharp', true],
          ['_ES3Ref', 'ref-saveinfo', true],
          ['ThirdPlatformId', makeNum('76561198000000000'), true],
          ['NoteStr', '데모 세이브 슬롯', true]
        ]), true]
      ]), true],
      ['TimeStamp', mkTimestamp(), true]
    ]);

    var files = [
      { name: 'SaveObjectPlayerTeam.save', relativePath: 'WuLin/SaveObjectPlayerTeam.save', root: mkSlot('SaveObjectPlayerTeam', playerTeamRoot) },
      { name: 'SaveObjectGameCharacter.save', relativePath: 'WuLin/SaveObjectGameCharacter.save', root: mkSlot('SaveObjectGameCharacter', charPropsRoot) },
      { name: 'SaveObjectFaction.save', relativePath: 'WuLin/SaveObjectFaction.save', root: mkSlot('SaveObjectFaction', factionsRoot) },
      { name: 'SaveObjectGame.save', relativePath: 'WuLin/SaveObjectGame.save', root: mkSlot('SaveObjectGame', gameRoot) },
      { name: 'SaveObjectGameTime.save', relativePath: 'WuLin/SaveObjectGameTime.save', root: mkSlot('SaveObjectGameTime', timeRoot) },
      { name: 'SaveObjectPagoda.save', relativePath: 'WuLin/SaveObjectPagoda.save', root: mkSlot('SaveObjectPagoda', pagodaRoot) },
      { name: 'SaveObjectGameGlobal.save', relativePath: 'WuLin/SaveObjectGameGlobal.save', root: globalRoot },
      { name: 'SaveInfo.save', relativePath: 'WuLin/SaveInfo.save', root: saveInfoRoot }
    ];

    var out = [];
    for (var fI = 0; fI < files.length; fI++) {
      var text = stringifyEs3Json(files[fI].root);
      var bytes = await C.encodeEs3Bytes(text, { mode: 'aes-gzip', password: password });
      out.push({
        name: files[fI].name,
        relativePath: files[fI].relativePath,
        bytes: bytes,
        text: text,
        mode: 'aes-gzip'
      });
    }
    return out;
  }

  function createSession(catalog) {
    return new SlotSession(catalog);
  }

  return {
    normalizeCatalog: normalizeCatalog,
    createSession: createSession,
    SlotSession: SlotSession,
    createDemoSlotFiles: createDemoSlotFiles,
    validateSafeInteger: validateSafeInteger
  };
});
