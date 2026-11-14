'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const Codec = require(path.join(ROOT, 'src', 'es3-codec.js'));
const Core = require(path.join(ROOT, 'src', 'editor-core.js'));
const RawCatalog = require(path.join(ROOT, 'src', 'catalog-data.js'));

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

function toHex(u8) {
  return Buffer.from(u8).toString('hex');
}

function fromHex(hex) {
  return Uint8Array.from(Buffer.from(hex, 'hex'));
}

function fromBuf(buf) {
  return Uint8Array.from(buf);
}

function fromUtf8(str) {
  return Codec.utf8Encode(str);
}

function pad(n) {
  return String(n).padStart(2, '0');
}

function aesIvBytes() {
  return Uint8Array.from(Array.from({ length: 16 }, (_, i) => i));
}

test('S1. sha1 matches known vectors and node crypto', () => {
  const vectors = [
    ['', 'da39a3ee5e6b4b0d3255bfef95601890afd80709'],
    ['abc', 'a9993e364706816aba3e25717850c26c9cd0d89d'],
    ['a'.repeat(1_000_000), '34aa973cd4c4daa4f61eeb2bdbad27316534016f']
  ];

  for (const [msg, expectedHex] of vectors) {
    const msgBytes = fromUtf8(msg);
    const got = Codec.sha1(msgBytes);
    assert.ok(got instanceof Uint8Array);
    assert.equal(got.length, 20);
    assert.equal(toHex(got), expectedHex);

    const nodeDigest = crypto.createHash('sha1').update(Buffer.from(msgBytes)).digest();
    assert.equal(toHex(got), nodeDigest.toString('hex'));
  }
});

test('S1. hmacSha1 matches RFC 2202 vectors and node crypto', () => {
  const vectors = [
    {
      key: Uint8Array.from({ length: 20 }, () => 0x0b),
      msg: 'Hi There',
      expected: 'b617318655057264e28bc0b6fb378c8ef146be00'
    },
    {
      key: fromUtf8('Jefe'),
      msg: 'what do ya want for nothing?',
      expected: 'effcdf6ae5eb2fa2d27416d5f184df9c259a7c79'
    },
    {
      key: Uint8Array.from({ length: 80 }, () => 0xaa),
      msg: 'Test Using Larger Than Block-Size Key - Hash Key First',
      expected: 'aa4ae5e15272d00e95705637ce8a3b55ed402112'
    }
  ];

  for (const v of vectors) {
    const msgBytes = fromUtf8(v.msg);
    const got = Codec.hmacSha1(v.key, msgBytes);
    assert.ok(got instanceof Uint8Array);
    assert.equal(got.length, 20);
    assert.equal(toHex(got), v.expected);

    const nodeHmac = crypto.createHmac('sha1', Buffer.from(v.key)).update(Buffer.from(msgBytes)).digest();
    assert.equal(toHex(got), nodeHmac.toString('hex'));
  }
});

test('S1. pbkdf2HmacSha1 matches node crypto for 16 and 32 byte outputs', () => {
  const password = fromUtf8('Meow');
  const salt = fromHex('000102030405060708090a0b0c0d0e0f');
  const iterations = 100;

  for (const dkLen of [16, 32]) {
    const got = Codec.pbkdf2HmacSha1(password, salt, iterations, dkLen);
    const expected = fromBuf(crypto.pbkdf2Sync(Buffer.from(password), Buffer.from(salt), iterations, dkLen, 'sha1'));

    assert.ok(got instanceof Uint8Array);
    assert.equal(got.length, dkLen);
    assert.deepEqual(Array.from(got), Array.from(expected));
  }
});

test('S1. aesCbcEncrypt matches FIPS-197 vector and node aes-128-cbc', () => {
  const key = fromHex('000102030405060708090a0b0c0d0e0f');
  const pt = fromHex('00112233445566778899aabbccddeeff');
  const iv = fromHex('00000000000000000000000000000000');

  const got = Codec.aesCbcEncrypt(pt, key, iv);
  assert.ok(got instanceof Uint8Array);
  assert.ok(got.length >= 16);
  assert.equal(toHex(got.subarray(0, 16)), '69c4e0d86a7b0430d8cdb78070b4c55a');

  const nodeCipher = crypto.createCipheriv('aes-128-cbc', Buffer.from(key), Buffer.from(iv));
  const expected = Buffer.concat([
    nodeCipher.update(Buffer.from(pt)),
    nodeCipher.final()
  ]);
  assert.equal(toHex(got), expected.toString('hex'));

  const roundTrip = Codec.aesCbcDecrypt(got, key, iv);
  assert.deepEqual(Array.from(roundTrip), Array.from(pt));
});

test('S1. aesCbcDecrypt rejects truncated ciphertext and invalid PKCS#7 padding', () => {
  const key = fromHex('000102030405060708090a0b0c0d0e0f');
  const iv = fromHex('00000000000000000000000000000000');
  const pt = fromUtf8('padding check');
  const ct = Codec.aesCbcEncrypt(pt, key, iv);

  assert.throws(() => {
    Codec.aesCbcDecrypt(ct.subarray(0, ct.length - 1), key, iv);
  });

  const tampered = Uint8Array.from(ct);
  tampered[tampered.length - 1] ^= 0x01;

  assert.throws(() => {
    Codec.aesCbcDecrypt(tampered, key, iv);
  });
});

test('S2. plain container round-trips including UTF-8 BOM text', async () => {
  const sampleText = '{"save":{"name":"대협입지전","value":123}}\n';
  const samples = [
    sampleText,
    '\uFEFF' + sampleText
  ];

  for (const text of samples) {
    const encoded = await Codec.encodeEs3Bytes(text, { mode: 'plain' });
    assert.ok(encoded instanceof Uint8Array);

    const decoded = await Codec.decodeEs3Bytes(encoded, '');
    assert.equal(decoded.mode, 'plain');
    assert.equal(decoded.text, sampleText);
  }
});

test('S2. gzip container round-trips text', async () => {
  const sampleText = JSON.stringify({
    save: {
      name: '대협입지전 大侠立志传',
      ticks: '656099925099270000',
      nested: [1, 2, 3]
    }
  });

  const encoded = await Codec.encodeEs3Bytes(sampleText, { mode: 'gzip' });
  assert.ok(encoded instanceof Uint8Array);

  const decoded = await Codec.decodeEs3Bytes(encoded, '');
  assert.equal(decoded.mode, 'gzip');
  assert.equal(decoded.text, sampleText);
});

test('S2. aes-plain container round-trips with correct password and rejects incorrect password', async () => {
  const sampleText = '{"secret":true,"label":"AES plain","n":42}';
  const password = 'CorrectPass';
  const iv = aesIvBytes();

  const encoded = await Codec.encodeEs3Bytes(sampleText, {
    mode: 'aes-plain',
    password,
    iv
  });
  assert.ok(encoded instanceof Uint8Array);

  const decoded = await Codec.decodeEs3Bytes(encoded, password);
  assert.equal(decoded.mode, 'aes-plain');
  assert.equal(decoded.text, sampleText);

  await assert.rejects(
    () => Codec.decodeEs3Bytes(encoded, 'WrongPass'),
    /.*/
  );
});

test('S2. aes-gzip container round-trips with correct password and detects truncated ciphertext', async () => {
  const sampleText = JSON.stringify({
    secret: true,
    label: 'AES gzip',
    items: ['가', '나', '다']
  });
  const password = 'CorrectPass';
  const iv = aesIvBytes();

  const encoded = await Codec.encodeEs3Bytes(sampleText, {
    mode: 'aes-gzip',
    password,
    iv
  });
  assert.ok(encoded instanceof Uint8Array);

  const decoded = await Codec.decodeEs3Bytes(encoded, password);
  assert.equal(decoded.mode, 'aes-gzip');
  assert.equal(decoded.text, sampleText);

  const truncated = encoded.subarray(0, encoded.length - 1);
  await assert.rejects(
    () => Codec.decodeEs3Bytes(truncated, password),
    /.*/
  );
});

test('S3. es3 JSON parser preserves unquoted integer keys and key order', () => {
  const text = '{0:123,-1:[100401],"name":"Saver","nested":{"2":"two","1":"one"}}';
  const node = Codec.parseEs3Json(text);

  assert.equal(Codec.isEs3Object(node), true);

  const rootEntries = node.entries || node.value || node;
  assert.ok(Array.isArray(rootEntries));
  assert.equal(rootEntries[0].key, '0');
  assert.equal(rootEntries[0].quoted, false);
  assert.equal(rootEntries[1].key, '-1');
  assert.equal(rootEntries[1].quoted, false);
  assert.equal(rootEntries[2].key, 'name');
  assert.equal(rootEntries[2].quoted, true);

  const nested = Codec.objGet(node, 'nested');
  assert.ok(nested);
  const nestedEntries = nested.entries || nested.value || nested;
  assert.ok(Array.isArray(nestedEntries));
  assert.equal(nestedEntries[0].key, '2');
  assert.equal(nestedEntries[1].key, '1');

  assert.equal(Codec.objGet(node, '0').raw, '123');
  assert.equal(Codec.objGet(node, 'name'), 'Saver');
});

test('S3. es3 number parser preserves int64 and decimal source text losslessly', () => {
  const truth = {
    ticks: '656099925099270000',
    QuaterOfDay: '87.67666666666666666666666667',
    ThirdPlatformId: '76561198000000000'
  };
  const text = `{ticks:${truth.ticks},QuaterOfDay:${truth.QuaterOfDay},ThirdPlatformId:${truth.ThirdPlatformId}}`;

  const node = Codec.parseEs3Json(text);
  const ticks = Codec.objGet(node, 'ticks');
  const quarter = Codec.objGet(node, 'QuaterOfDay');
  const third = Codec.objGet(node, 'ThirdPlatformId');

  assert.equal(Codec.isEs3Number(ticks), true);
  assert.equal(Codec.isEs3Number(quarter), true);
  assert.equal(Codec.isEs3Number(third), true);

  const roundTrip = Codec.stringifyEs3Json(node);
  assert.ok(roundTrip.includes(`ticks:${truth.ticks}`));
  assert.ok(roundTrip.includes(`QuaterOfDay:${truth.QuaterOfDay}`));
  assert.ok(roundTrip.includes(`ThirdPlatformId:${truth.ThirdPlatformId}`));

  const reparsed = Codec.parseEs3Json(roundTrip);
  assert.equal(String(Codec.objGet(reparsed, 'ticks')?.raw ?? Codec.objGet(reparsed, 'ticks')), truth.ticks);
  assert.equal(String(Codec.objGet(reparsed, 'QuaterOfDay')?.raw ?? Codec.objGet(reparsed, 'QuaterOfDay')), truth.QuaterOfDay);
  assert.equal(String(Codec.objGet(reparsed, 'ThirdPlatformId')?.raw ?? Codec.objGet(reparsed, 'ThirdPlatformId')), truth.ThirdPlatformId);
});

test('S3. es3 JSON parser preserves unicode escapes, control chars, and CJK text', () => {
  const text = '{"escaped":"\\uAC00","controls":"line1\\nline2\\ttab","cjk":"대협입지전 大侠立志传"}';
  const node = Codec.parseEs3Json(text);

  assert.equal(Codec.objGet(node, 'escaped'), '가');
  assert.equal(Codec.objGet(node, 'controls'), 'line1\nline2\ttab');
  assert.equal(Codec.objGet(node, 'cjk'), '대협입지전 大侠立志传');

  const roundTrip = Codec.stringifyEs3Json(node);
  const reparsed = Codec.parseEs3Json(roundTrip);

  assert.equal(Codec.objGet(reparsed, 'escaped'), '가');
  assert.equal(Codec.objGet(reparsed, 'controls'), 'line1\nline2\ttab');
  assert.equal(Codec.objGet(reparsed, 'cjk'), '대협입지전 大侠立志传');
});


async function makeLoadedSession() {
  const files = await Core.createDemoSlotFiles(RawCatalog, 'Meow');
  const session = Core.createSession(RawCatalog);
  await session.loadFiles(files, 'Meow');
  return session;
}

test('S4.1 catalog, demo slot load, currencies, and teamProps', async () => {
  const norm = Core.normalizeCatalog(RawCatalog);
  assert.equal(norm.__normalized, true);
  assert.ok(Array.isArray(norm.currencies));
  assert.ok(Array.isArray(norm.fiefBuildings));
  assert.ok(Array.isArray(norm.kungfuList));
  assert.ok(norm.characterProps.core && norm.characterProps.combat && norm.characterProps.weapons && norm.characterProps.moral);
  assert.equal(norm.characterProps.abilities.length, 26);

  const files = await Core.createDemoSlotFiles(RawCatalog, 'Meow');
  assert.equal(files.length, 8);
  assert.ok(files.every(f => f.mode === 'aes-gzip'));
  const session = Core.createSession(RawCatalog);
  const summary = await session.loadFiles(files, 'Meow');
  assert.equal(summary.fileCount, 8);
  assert.equal(summary.dirtyFileCount, 0);
  assert.equal(summary.protagonist.instanceId, '100401');
  assert.equal(summary.protagonist.level, 25);

  const currencies = session.getCurrencies();
  assert.ok(Array.isArray(currencies) && currencies.length > 0);
  session.setCurrency(0, 888888);
  assert.equal(session.getCurrencies()[0].value, 888888);
  const raw = session.getRawFileText('playerTeam');
  assert.ok(raw.includes('0:888888'));
  assert.ok(!raw.includes('"0:888888"'));

  assert.deepEqual(session.getTeamProps(), { '队伍体力': 80, '队伍心情': 75 });
  session.setTeamProp('队伍体力', 95);
  assert.equal(session.getTeamProps()['队伍体力'], 95);
});

test('S4.2 inventory stackable merge, non-stackable add, forgeLevel, and removal', async () => {
  const session = await makeLoadedSession();
  let items = session.getInventoryItems();
  assert.equal(items.length, 6);
  const i10164 = items.find(x => x.uid === '10164');
  const i13066 = items.find(x => x.uid === '13066');
  const i23301 = items.find(x => x.uid === '23301');
  assert.equal(i10164.stackable, 0);
  assert.equal(i10164.hasModifyData, true);
  assert.equal(i10164.forgeLevel, 5);
  assert.equal(i13066.hasModifyData, false);
  assert.equal(i23301.stackable, 1);
  assert.equal(i23301.count, 15);
  session.addInventoryItem(23301, 10);
  items = session.getInventoryItems();
  assert.equal(items.length, 6);
  assert.equal(items.find(x => x.uid === '23301').count, 25);
  session.addInventoryItem(10164, 2);
  items = session.getInventoryItems();
  assert.equal(items.length, 8);
  const added = items.filter(x => x.uid === '10164');
  assert.equal(added.length, 3);
  assert(added.every(x => x.count === 1));
  session.setInventoryItemStack(i23301.index, 99);
  items = session.getInventoryItems();
  assert.equal(items.find(x => x.uid === '23301').count, 99);
  session.setInventoryItemForgeLevel(i10164.index, 12);
  items = session.getInventoryItems();
  assert.equal(items.find(x => x.uid === '10164').forgeLevel, 12);
  assert.throws(() => session.setInventoryItemForgeLevel(i13066.index, 5));
  session.removeInventoryItem(0);
  assert.equal(session.getInventoryItems().length, 7);
});

test('S4.3 character basic, null m_TeamMemberState, 5 prop buckets, kungfu, traits, relations', async () => {
  const session = await makeLoadedSession();
  session.setCharacterBasic('100401', { m_level: 50, m_exp: 99999, m_egoState: 70, m_valueState: 80, m_surName: '대', m_givenName: '협', m_overrideTitle: '천하제일' });
  let d = session.getCharacterDetail('100401');
  for (const [k, v] of Object.entries({ m_level: 50, m_exp: 99999, m_egoState: 70, m_valueState: 80, m_surName: '대', m_givenName: '협', m_overrideTitle: '천하제일' })) assert.equal(d[k], v);
  session.setCharacterBasic('10001', { isJoined: true, curHp: 4500, curEp: 2600 });
  const t = session.getCharacterDetail('10001').m_TeamMemberState;
  assert.equal(t.isJoined, true);
  assert.equal(t.curHp, 4500);
  assert.equal(t.curEp, 2600);
  const cat = Core.normalizeCatalog(RawCatalog);
  const propVal = (props, k) => Array.isArray(props) ? (props.find(p => p.key === k) || {}).value : props[k];
  const ok = [cat.characterProps.core[0].key, cat.characterProps.combat[0].key, cat.characterProps.weapons[0].key, cat.characterProps.moral[0].key];
  ok.forEach(k => session.setCharacterProp('100401', 'origin', k, 77));
  const ak = cat.characterProps.abilities[0].key;
  session.setCharacterProp('100401', 'addition', ak, 5);
  d = session.getCharacterDetail('100401');
  ok.forEach(k => assert.equal(propVal(d.originProps, k), 77));
  assert.equal(propVal(d.additionProps, ak), 5);
  assert.throws(() => session.addCharacterKungfu('100401', 51601, 5));
  session.addCharacterKungfu('100401', 51602, 3);
  assert.equal(session.getCharacterDetail('100401').kungfuList[3].level, 3);
  session.setCharacterKungfuLevel('100401', 3, 8);
  assert.equal(session.getCharacterDetail('100401').kungfuList[3].level, 8);
  session.maxAllCharacterKungfu('100401');
  session.removeCharacterKungfu('100401', 3);
  assert.equal(session.getCharacterDetail('100401').kungfuList.length, 3);
  assert.equal(session.addCharacterTrait('100401', 1020), true);
  assert.equal(session.addCharacterTrait('100401', 1020), false);
  assert.equal(session.removeCharacterTrait('100401', 1020), true);
  d = session.getCharacterDetail('100401');
  assert.ok(d.relations.length > 0);
  assert.ok(d.relations.every(r => r.targetName && r.targetName.length > 0));
  session.setCharacterRelation('100401', 10005, 95);
  assert.ok(session.getCharacterDetail('100401').relations.some(r => r.relationValue === 95));
  session.maxAllCharacterRelations('100401', 100);
  assert.ok(session.getCharacterDetail('100401').relations.every(r => r.relationValue === 100));
});

test('S4.4 factions, fief global+game sync, pagoda, and gameTime lossless precision', async () => {
  const session = await makeLoadedSession();
  session.setFactionFame(10, 88, true);
  let fs = session.getFactions();
  let f = fs.find(x => x.templeteId === 10);
  assert.equal(f.playerFame, 88);
  assert.equal(f.IsDiscovered, true);
  session.setFactionFame(9999, 40);
  fs = session.getFactions();
  f = fs.find(x => x.templeteId === 9999);
  assert.equal(f.IsDiscovered, true);
  assert.equal(f.playerFame, 40);
  session.setFiefBuildingLevel(112, 5);
  assert.equal(session.getFiefBuildings().find(b => b.saveId === 112).level, 5);
  assert.equal(session.files.global.dirty, true);
  assert.equal(session.files.game.dirty, true);
  assert.ok(session.getRawFileText('global').includes('112:5'));
  assert.ok(session.getRawFileText('game').includes('112:5'));
  session.setPagoda({ CurStage: 15, CurScore: 50000, HistoryBestStage: 20, HistoryBestScore: 80000 });
  const p = session.getPagoda();
  assert.equal(p.CurStage, 15);
  assert.equal(p.CurScore, 50000);
  assert.equal(p.HistoryBestStage, 20);
  assert.equal(p.HistoryBestScore, 80000);
  session.setGameTime({ Year: 3, Month: 8, Day: 15, Dhour: 6, Quarter: 4 });
  const gt = session.getGameTime();
  assert.equal(gt.Year, 3);
  assert.equal(gt.Month, 8);
  assert.equal(gt.Day, 15);
  assert.equal(gt.Dhour, 6);
  assert.equal(gt.Quarter, 4);
  const rawTime = session.getRawFileText('time');
  assert.ok(rawTime.includes('656099925099270000'));
  assert.ok(rawTime.includes('87.67666666666666666666666667'));
});


test('S4.5 all 6 presets, validateSafeInteger, reset, and exportModifiedFiles', async () => {
  const session = await makeLoadedSession();
  session.setCurrency(0, 150000000);
  session.setCurrency(7, 42);
  session.setCurrency(8, 77);
  session.applyPreset('wealth_package');
  const cur = session.getCurrencies();
  assert.equal(cur.find(c => c.id === 0).value, 150000000);
  assert.equal(cur.find(c => c.id === 1).value, 99999);
  assert.equal(cur.find(c => c.id === 2).value, 999999);
  assert.equal(cur.find(c => c.id === 3).value, 999999);
  assert.equal(cur.find(c => c.id === 7).value, 42);
  assert.equal(cur.find(c => c.id === 8).value, 77);
  let detail = session.getCharacterDetail('100401');
  assert(detail.originProps['冲穴点数'] >= 999);
  assert(detail.originProps['江湖历练'] >= 999999);
  session.applyPreset('hero_core_max');
  session.applyPreset('hero_all_life_skills');
  detail = session.getCharacterDetail('100401');
  const abilityKeys = Object.keys(detail.additionProps).filter(k => k.startsWith('能力_'));
  assert.equal(abilityKeys.length, 26);
  assert(abilityKeys.every(k => detail.additionProps[k] >= 5));
  session.applyPreset('hero_virtue_max');
  session.applyPreset('party_kungfu_max');
  detail = session.getCharacterDetail('100401');
  assert(detail.kungfuList.every(k => k.level === k.maxLevel));
  session.applyPreset('fief_all_max');
  assert(session.getFiefBuildings().every(b => b.level === b.maxLevel));
  assert.doesNotThrow(() => Core.validateSafeInteger('42', -100, 100, 'x'));
  assert.doesNotThrow(() => Core.validateSafeInteger(-10, -100, 100, 'x'));
  assert.doesNotThrow(() => Core.validateSafeInteger(0, -100, 100, 'x'));
  for (const v of ['1.5', 1.5, '1e5', '', null]) assert.throws(() => Core.validateSafeInteger(v, -100, 100, 'x'));
  assert.throws(() => Core.validateSafeInteger(11, 0, 10, 'x'));
  const exported = await session.exportModifiedFiles({ updateTimestamp: true });
  const decoded = await Codec.decodeEs3Bytes(exported[0].bytes, 'Meow');
  assert.equal(decoded.text, exported[0].text);
  session.setFactionFame(10, 50);
  session.resetFile('factions');
  assert.equal(session.files.factions.dirty, false);
  session.resetAll();
  assert.equal(session.getSummary().dirtyFileCount, 0);
  assert.equal(session.getCurrencies().find(c => c.id === 0).value, 50000);
});


const uiSrc = fs.readFileSync(path.join(ROOT, 'src', 'editor-ui.js'), 'utf8');

function makeMockWebview(onPost) {
  const listeners = [];
  const posted = [];
  const emit = payload => {
    const event = payload && Object.prototype.hasOwnProperty.call(payload, 'data') ? payload : { data: payload };
    for (const fn of listeners.slice()) fn(event);
  };
  const state = { onPost };
  const webview = {
    addEventListener(type, fn) { if (type === 'message') listeners.push(fn); },
    removeEventListener(type, fn) {
      if (type !== 'message') return;
      const i = listeners.indexOf(fn);
      if (i >= 0) listeners.splice(i, 1);
    },
    postMessage(msg) {
      posted.push(msg);
      if (state.onPost) state.onPost(msg, emit);
    }
  };
  return { webview, posted, emit, state };
}

function makeMockEl(tag, id) {
  const el = {
    nodeType: 1,
    tagName: String(tag || 'div').toUpperCase(),
    id: id || '',
    hidden: id === 'btn-connect-dir' || id === 'native-toolbar',
    disabled: false,
    checked: false,
    value: '',
    textContent: '',
    style: {},
    dataset: {},
    children: [],
    listeners: {},
    classList: { add() {}, remove() {}, toggle() {} },
    setAttribute(k, v) { if (k === 'hidden') this.hidden = true; this[k] = String(v); },
    removeAttribute(k) { if (k === 'hidden') this.hidden = false; delete this[k]; },
    getAttribute(k) { return this[k] ?? null; },
    appendChild(c) {
      if (this.tagName === 'SELECT' && this.value === '' && c && c.value !== undefined) this.value = String(c.value);
      this.children.push(c);
      return c;
    },
    removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); return c; },
    get firstChild() { return this.children[0] || null; },
    querySelectorAll() { return []; },
    addEventListener(ev, fn) { (this.listeners[ev] ||= []).push(fn); },
    click() { (this.listeners.click || []).forEach(fn => fn.call(this, { currentTarget: this, target: this, preventDefault() {} })); },
    focus() {}
  };
  return el;
}

function createUiHarness(opts = {}) {
  const els = Object.create(null);
  const getEl = id => (els[id] ||= makeMockEl('div', id));
  ['btn-connect-dir', 'native-toolbar', 'status-bar', 'btn-reset-all'].forEach(getEl);
  const wv = opts.webview2 ? makeMockWebview(opts.onPost) : null;
  const document = {
    readyState: 'complete',
    body: makeMockEl('body', 'body'),
    getElementById: getEl,
    createElement: tag => makeMockEl(tag, ''),
    createTextNode: t => ({ nodeType: 3, textContent: String(t) }),
    querySelectorAll: () => [],
    addEventListener() {}
  };
  const sandbox = {
    document,
    addEventListener() {},
    HerosAdventureEs3Codec: Codec,
    HerosAdventureEditorCore: Core,
    HerosAdventureCatalog: RawCatalog,
    console,
    navigator: { clipboard: { writeText: async () => {} } },
    btoa: s => Buffer.from(s, 'binary').toString('base64'),
    atob: s => Buffer.from(s, 'base64').toString('binary'),
    Blob,
    URL: { createObjectURL: () => 'blob:mock', revokeObjectURL() {} },
    TextEncoder,
    TextDecoder,
    setTimeout,
    clearTimeout,
    Uint8Array,
    ArrayBuffer,
    DataView,
    Error,
    RangeError,
    SyntaxError,
    TypeError,
    Promise,
    Date,
    Math,
    Object,
    Array,
    Number,
    String,
    Boolean,
    JSON,
    RegExp,
    Map,
    Set
  };
  if (opts.showDirectoryPicker) sandbox.showDirectoryPicker = opts.showDirectoryPicker;
  if (opts.location) sandbox.location = opts.location;
  if (opts.fetch) sandbox.fetch = opts.fetch;
  if ('checkGameStatus' in opts) {
    if (opts.checkGameStatus !== undefined) sandbox.HerosAdventureCheckGameStatus = opts.checkGameStatus;
  } else if (opts.showDirectoryPicker && !opts.location) {
    sandbox.HerosAdventureCheckGameStatus = async () => 'NOT_RUNNING';
  }
  if (wv) sandbox.chrome = { webview: wv.webview };
  sandbox.global = sandbox;
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.runInNewContext(uiSrc, sandbox, { filename: 'editor-ui.js' });
  return {
    sandbox,
    global: sandbox,
    ui: sandbox.HerosAdventureUI,
    els,
    webview: wv ? wv.webview : null,
    posted: wv ? wv.posted : [],
    emitWebview: wv ? wv.emit : null,
    setOnPost: wv ? fn => { wv.state.onPost = fn; } : null
  };
}

function makeMockDir(initialEntriesOrMap, hooks = {}) {
  const files = Object.create(null);
  const dirs = new Set(hooks.dirs || []);
  if (Array.isArray(initialEntriesOrMap)) {
    for (const e of initialEntriesOrMap) files[e.name] = Uint8Array.from(e.bytes);
  } else {
    for (const [k, v] of Object.entries(initialEntriesOrMap || {})) files[k] = Uint8Array.from(v);
  }
  function makeHandle(name) {
    var handle = {
      kind: 'file',
      name,
      async getFile() {
        if (hooks.beforeGetFile) await hooks.beforeGetFile(name);
        const u8 = Uint8Array.from(files[name] || new Uint8Array(0));
        return {
          name,
          async arrayBuffer() { return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength); }
        };
      },
      async createWritable() {
        let buf = null;
        return {
          async write(d) {
            const u8 = d instanceof Uint8Array ? Uint8Array.from(d) : new Uint8Array(d);
            if (hooks.beforeWrite) await hooks.beforeWrite(name, u8);
            buf = u8;
          },
          async close() {
            if (buf !== null) files[name] = buf;
            if (hooks.afterClose) await hooks.afterClose(name, files[name]);
          },
          async abort() {
            buf = null;
            if (hooks.onAbort) await hooks.onAbort(name);
          }
        };
      }
    };
    if (hooks.enableMove) {
      handle.move = async function (newName) {
        if (hooks.beforeMove) await hooks.beforeMove(name, newName);
        files[newName] = files[name];
        delete files[name];
      };
    }
    return handle;
  }
  return {
    files,
    dirs,
    hooks,
    async *values() {
      for (const name of Object.keys(files).sort()) yield makeHandle(name);
      for (const name of Array.from(dirs).sort()) yield { kind: 'directory', name };
    },
    async getFileHandle(name, opts) {
      if (dirs.has(name)) {
        throw Object.assign(new Error('TypeMismatch: ' + name), { name: 'TypeMismatchError' });
      }
      if (!(name in files)) {
        if (!(opts && opts.create)) {
          throw Object.assign(new Error('NotFound: ' + name), { name: 'NotFoundError' });
        }
        files[name] = new Uint8Array(0);
      }
      return makeHandle(name);
    },
    async removeEntry(name) {
      if (hooks.beforeRemove) await hooks.beforeRemove(name);
      if (name in files) delete files[name];
      else if (dirs.has(name)) dirs.delete(name);
      else throw Object.assign(new Error('NotFound: ' + name), { name: 'NotFoundError' });
    }
  };
}

async function attachPrepopulatedDir(h, demoFiles, dir) {
  await h.ui.getSession().loadFiles(demoFiles, 'Meow');
  const st = h.ui.getState();
  st.dirHandle = dir;
  st.fileHandles = {};
  for await (const e of dir.values()) if (e.kind === 'file') st.fileHandles[e.name] = e;
  st.fileHashes = st.fileHashes || {};
  for (const f of demoFiles) st.fileHashes[f.name] = toHex(Codec.sha1(f.bytes));
  return st;
}

test('S4.6 editor-ui saveToConnectedDir blocks browser direct overwrite fail-closed', async () => {
  const demoFiles = await Core.createDemoSlotFiles(RawCatalog, 'Meow');
  let origWrites = 0;
  const dir = makeMockDir(demoFiles, { beforeWrite: () => { origWrites++; } });
  const h = createUiHarness({});
  const st = await attachPrepopulatedDir(h, demoFiles, dir);
  const s = h.ui.getSession();
  s.setCurrency(0, 99999);
  const list = await s.exportModifiedFiles({ updateTimestamp: false });
  await assert.rejects(() => h.ui.saveToConnectedDir(list), /직접 덮어쓰기가 차단/);
  assert.strictEqual(origWrites, 0);
  assert.strictEqual(h.global.hasUnsavedChanges(), true);
  st.busy = true;
  await assert.rejects(() => h.ui.saveToConnectedDir(list), /진행 중/);
  st.busy = false;
});

test('S5. dist single-file HTML bundle integrity', async () => {
  const html = fs.readFileSync(path.join(ROOT, 'dist', 'HerosAdventureSaveEditor-v1.0.html'), 'utf8');
  assert(html.length > 100000);
  assert(!/https?:\/\//i.test(html));
  const stripped = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '');
  assert(!/<[^>]+\bon[a-z]+\s*=/i.test(stripped));
  const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)];
  assert(scripts.length >= 4);
  scripts.forEach(([, code]) => new vm.Script(code));

  const norm = html.replace(/\r\n/g, '\n');
  for (const name of ['es3-codec.js', 'editor-core.js', 'editor-ui.js']) {
    const escaped = fs.readFileSync(path.join(ROOT, 'src', name), 'utf8')
      .replace(/\r\n/g, '\n')
      .replace(/<\/(script)/gi, '<\\/$1');
    assert(norm.includes(`<script>\n${escaped}\n</script>`), `${name} must be embedded verbatim`);
  }

  const ctx = {
    document: {
      readyState: 'complete',
      body: makeMockEl('body', 'body'),
      getElementById: id => makeMockEl('div', id),
      createElement: tag => makeMockEl(tag, ''),
      createTextNode: t => ({ nodeType: 3, textContent: String(t) }),
      querySelectorAll: () => [],
      addEventListener() {}
    },
    addEventListener() {},
    navigator: { clipboard: { writeText: async () => {} } },
    URL: { createObjectURL: () => 'blob:x', revokeObjectURL() {} },
    Blob,
    btoa: s => Buffer.from(s, 'binary').toString('base64'),
    atob: s => Buffer.from(s, 'base64').toString('binary'),
    CompressionStream,
    DecompressionStream,
    Response,
    TextEncoder,
    TextDecoder,
    setTimeout,
    clearTimeout,
    Uint8Array,
    ArrayBuffer,
    DataView,
    console
  };
  ctx.window = ctx;
  ctx.global = ctx;
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  scripts.forEach(([, code]) => vm.runInContext(code, ctx));

  const bCodec = ctx.HerosAdventureEs3Codec;
  const bCore = ctx.HerosAdventureEditorCore;
  const bCat = ctx.HerosAdventureCatalog;
  assert(bCodec && bCore && bCat);

  const bytes55 = Uint8Array.from({ length: 55 }, (_, i) => i);
  assert.strictEqual(toHex(bCodec.sha1(bytes55)), crypto.createHash('sha1').update(Buffer.from(bytes55)).digest('hex'));

  const precisionJson = '{"t":656099925099270000,"q":87.67666666666666666666666667}';
  assert.strictEqual(bCodec.stringifyEs3Json(bCodec.parseEs3Json(precisionJson)), precisionJson);

  for (const ch of ['\x00', '\n', '\x1f']) {
    assert.throws(() => bCodec.parseEs3Json('{"s":"' + ch + '"}'), /control character/i);
  }
  assert.strictEqual(bCodec.objGet(bCodec.parseEs3Json('{"s":"\\n\\t\\u0000"}'), 's'), '\n\t\0');

  const demoFiles = await bCore.createDemoSlotFiles(bCat, 'Meow');
  const bs = new bCore.SlotSession(bCat);
  await bs.loadFiles(demoFiles, 'Meow');
  const charNode = bs._charNodeByInstance('100401');
  const wrapper = bCodec.makeObj([['__type', 'TeamStateWrapper,Assembly', true], ['value', null, true]]);
  bCodec.objSet(charNode, 'm_TeamMemberState', wrapper, true);
  assert.strictEqual(bs.getCharacterDetail('100401').isJoined, false);
  bs.setCharacterBasic('100401', { isJoined: true, curHp: 777, curEp: 333 });
  assert.strictEqual(bCodec.objGet(wrapper, '__type'), 'TeamStateWrapper,Assembly');
  const inner = bCodec.objGet(wrapper, 'value');
  assert.strictEqual(bCodec.objGet(inner, 'isJoined'), true);
  assert.strictEqual(bCodec.objGet(inner, 'curHp').raw, '777');
  assert.strictEqual(bCodec.objGet(inner, 'curEp').raw, '333');
  bCodec.objSet(wrapper, 'value', null, true);
  bs.applyPreset('party_kungfu_max');
  assert(bCodec.objGet(wrapper, 'value'));
  assert.strictEqual(bCodec.objGet(wrapper, '__type'), 'TeamStateWrapper,Assembly');

  bs.setCurrency(0, 77777);
  const exp = await bs.exportModifiedFiles({ updateTimestamp: false });
  bs.resetFile('playerTeam');
  bs.markSaved(exp);
  assert.strictEqual(bs.files.playerTeam.dirty, true);
  assert.strictEqual(bs.hasUnsavedChanges(), true);
  assert(bs.changeLog.length > 0);
  bs.setCurrency(0, 88888);
  const exp2 = await bs.exportModifiedFiles({ updateTimestamp: false });
  bs.resetAll();
  bs.markSaved(exp2);
  assert.strictEqual(bs.files.playerTeam.dirty, true);
  assert.strictEqual(bs.hasUnsavedChanges(), true);
  assert(bs.changeLog.length > 0);
});

test('R1.1 [A5] sha1 padding block boundaries (55, 56, 63, 64, 119 bytes) match node crypto', () => {
  for (const len of [0, 1, 54, 55, 56, 57, 63, 64, 65, 118, 119, 120, 127, 128]) {
    const u8 = Uint8Array.from({ length: len }, (_, i) => (i * 37 + 13) & 0xff);
    const want = crypto.createHash('sha1').update(Buffer.from(u8)).digest('hex');
    assert.equal(toHex(Codec.sha1(u8)), want);
  }
});

test('R1.2 [A12][C7] strict UTF-8 rejection and 4-mode BOM stripping', async () => {
  const bad = [
    [0xff], [0xc2], [0xe2, 0x82], [0xc0, 0xaf],
    [0xe0, 0x80, 0xaf], [0xed, 0xa0, 0x80], [0xed, 0xbf, 0xbf],
    [0xf4, 0x90, 0x80, 0x80],
  ];
  for (const seq of bad) {
    const bytes = new Uint8Array(seq);
    assert.throws(() => Codec.utf8Decode(bytes), /Invalid UTF-8/);
    await assert.rejects(() => Codec.decodeEs3Bytes(bytes, 'Meow'), /Invalid UTF-8/);
    assert.throws(() => Codec.decodeEs3BytesSync(bytes, 'Meow'), /Invalid UTF-8/);
  }

  const savedTD = globalThis.TextDecoder;
  try {
    globalThis.TextDecoder = undefined;
    assert.throws(() => Codec.utf8Decode(new Uint8Array([0xff])), /Invalid UTF-8/);
    assert.throws(() => Codec.utf8Decode(new Uint8Array([0xed, 0xa0, 0x80])), /Invalid UTF-8/);
    assert.equal(Codec.utf8Decode(fromUtf8('대협😀')), '대협😀');
  } finally {
    globalThis.TextDecoder = savedTD;
  }

  const bomText = '\uFEFF{"bom":1,"ko":"협"}';
  const expected = '{"bom":1,"ko":"협"}';
  for (const mode of ['plain', 'gzip', 'aes-plain', 'aes-gzip']) {
    const enc = await Codec.encodeEs3Bytes(bomText, { mode, password: 'Meow' });
    const decs = [await Codec.decodeEs3Bytes(enc, 'Meow'), Codec.decodeEs3BytesSync(enc, 'Meow')];
    for (const dec of decs) {
      assert.equal(dec.text, expected);
      assert.equal(dec.hasBom, true);
      assert.equal(Codec.objGet(Codec.parseEs3Json(dec.text), 'ko'), '협');
    }
  }
});

test('R1.3 [A4] AES fallback when random IV collides with plain "{" or gzip 0x1F 0x8B', async () => {
  const ivs = [
    Uint8Array.from([0x7b, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]),
    Uint8Array.from([0x20, 0x0a, 0x7b, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]),
    Uint8Array.from([0x1f, 0x8b, 0x08, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]),
  ];
  const payload = '{"ivCollision":true,"v":12345}';
  for (const iv of ivs) {
    for (const mode of ['aes-plain', 'aes-gzip']) {
      const enc = await Codec.encodeEs3Bytes(payload, { mode, password: 'Meow', iv });
      const decs = [await Codec.decodeEs3Bytes(enc, 'Meow'), Codec.decodeEs3BytesSync(enc, 'Meow')];
      for (const dec of decs) {
        assert.deepEqual({ mode: dec.mode, text: dec.text }, { mode, text: payload });
      }
    }
  }
});

test('R1.4 [A6] parseEs3Json rejects truncated containers and malformed numbers with SyntaxError', () => {
  const invalid = [
    '{', '{"x":1', '{"x":1,', '[', '[1', '[1,', '{"n":1e+}',
    '{"n":1--2}', '{"n":01}', '{"n":.5}', '{"n":1.}', '{"n":+5}',
    '{"a":1} trailing',
  ];
  for (const bad of invalid) {
    assert.throws(() => Codec.parseEs3Json(bad), SyntaxError);
  }
  assert.doesNotThrow(() => Codec.parseEs3Json('{"x":1,"a":[2,3,],}'));
  const nums = Codec.parseEs3Json('{t:656099925099270000,q:87.67666666666666666666666667}');
  assert.equal(Codec.objGet(nums, 't').raw, '656099925099270000');
  assert.equal(Codec.objGet(nums, 'q').raw, '87.67666666666666666666666667');
});

test('R1.5 [A13] unpaired UTF-16 surrogates round-trip losslessly in keys and values', async () => {
  const key = 'k\ud800_\udfff_😀';
  const val = 'v\ud800mid\udfffend😀';
  const obj = Codec.makeObj([[key, val, true]]);
  const json = Codec.stringifyEs3Json(obj);
  assert.ok(json.includes('\\ud800') && json.includes('\\udfff') && !json.includes('\ufffd'));

  const units = s => Array.from({ length: s.length }, (_, i) => s.charCodeAt(i));
  for (const mode of ['plain', 'gzip', 'aes-plain', 'aes-gzip']) {
    const enc = await Codec.encodeEs3Bytes(json, { mode, password: 'Meow' });
    const dec = await Codec.decodeEs3Bytes(enc, 'Meow');
    const parsed = Codec.parseEs3Json(dec.text);
    assert.equal(parsed.entries.length, 1);
    const gotKey = parsed.entries[0].key;
    const gotVal = Codec.objGet(parsed, gotKey);
    assert.deepEqual(units(gotKey), units(key));
    assert.deepEqual(units(gotVal), units(val));
  }
});

test('R1.6 [A1] faction map key != templeteId preserved across setFactionFame and diplomacy_max', async () => {
  const s = await makeLoadedSession();
  const fMap = Codec.objGet(s._dataValue('factions'), 'factions');
  Codec.objDelete(fMap, '3200');
  Codec.objSet(fMap, '7', Codec.makeObj([
    ['templeteId', Codec.makeNum(3200), true],
    ['playerFame', Codec.makeNum(60), true],
    ['IsDiscovered', true, true]
  ]), false);
  s.setFactionFame(7, 85);
  const f7a = Codec.objGet(fMap, '7');
  assert.equal(Codec.objGet(f7a, 'templeteId').raw, '3200');
  assert.equal(Codec.objGet(f7a, 'playerFame').raw, '85');
  assert.equal(Codec.objGet(fMap, '3200'), undefined);
  s.setFactionFame(3200, 92);
  const f7b = Codec.objGet(fMap, '7');
  assert.equal(Codec.objGet(f7b, 'templeteId').raw, '3200');
  assert.equal(Codec.objGet(f7b, 'playerFame').raw, '92');
  assert.equal(Codec.objGet(fMap, '3200'), undefined);
  s.applyPreset('diplomacy_max');
  const { uid, templeteId, playerFame } = s.getFactions().find(f => f.uid === '7');
  assert.deepEqual({ uid, templeteId, playerFame }, { uid: '7', templeteId: 3200, playerFame: 100 });
});

test('R1.7 [A2] multi-field mutators validate atomically before any AST mutation', async () => {
  const s = await makeLoadedSession();
  const snap = role => ({ raw: s.getRawFileText(role), dirty: s.files[role].dirty, rev: s.files[role].revision, logs: s.changeLog.length });
  const cases = [
    ['characters', () => s.setCharacterBasic('100401', { m_level: 50, m_exp: 'invalid' })],
    ['characters', () => s.setCharacterKungfuLevel('100401', 0, 8, -1)],
    ['time', () => s.setGameTime({ Year: 3, Month: 13 })],
    ['pagoda', () => s.setPagoda({ CurStage: 8, CurScore: -1 })]
  ];
  for (const [role, fn] of cases) {
    const before = snap(role);
    assert.throws(fn);
    assert.deepEqual(snap(role), before);
  }
});

test('R1.8 [A3] setCharacterBasic preserves unedited legacy alias fields', async () => {
  const s = await makeLoadedSession();
  const cc = Codec.objGet(s._dataValue('characters'), 'createdCharacter');
  const cNode = Codec.makeObj([
    ['m_templeteUid', Codec.makeNum(10099), true], ['level', Codec.makeNum(30), true],
    ['exp', Codec.makeNum(500), true], ['egoState', Codec.makeNum(15), true],
    ['valueState', Codec.makeNum(20), true], ['curHp', Codec.makeNum(1200), true],
    ['curEp', Codec.makeNum(800), true], ['m_TeamMemberState', null, true]
  ]);
  Codec.objSet(cc, '10099', cNode, false);
  s.setCharacterBasic('10099', { m_surName: '대' });
  assert.equal(['level', 'exp', 'egoState', 'valueState', 'curHp', 'curEp'].every(k => Codec.objHas(cNode, k)), true);
  const { level, exp, egoState, valueState, curHp, curEp, m_surName } = s.getCharacterDetail('10099');
  assert.deepEqual({ level, exp, egoState, valueState, curHp, curEp, m_surName }, { level: 30, exp: 500, egoState: 15, valueState: 20, curHp: 1200, curEp: 800, m_surName: '대' });
  s.setCharacterBasic('10099', { curHp: 1500 });
  assert.equal(s.getCharacterDetail('10099').curHp, 1500);
  assert.equal(s.getCharacterDetail('10099').curEp, 800);
});

test('R1.9 [A7] setTeamProp enforces strict integer parsing and catalog/int32 bounds', async () => {
  const s = await makeLoadedSession();
  const before = s.getRawFileText('playerTeam');
  for (const v of ['', '   ', '1e100', 1.5, '1.5', true, null, NaN]) {
    assert.throws(() => s.setTeamProp('队伍心情', v));
  }
  assert.throws(() => s.setTeamProp('队伍心情', 101), RangeError);
  assert.throws(() => s.setTeamProp('队伍心情', -1), RangeError);
  assert.throws(() => s.setTeamProp('customKey', 3000000000), RangeError);
  assert.equal(s.getRawFileText('playerTeam'), before);
  assert.equal(s.files.playerTeam.dirty, false);
  assert.equal(s.files.playerTeam.revision, 0);
  assert.equal(s.setTeamProp('队伍心情', '100'), 100);
  assert.equal(s.setTeamProp('customKey', -2147483648), -2147483648);
});

test('R1.10 [A8] resetAll and resetFile safely handle mixed corrupted files', async () => {
  const demo = await Core.createDemoSlotFiles(RawCatalog, 'Meow');
  const badBin = { name: 'corrupt_bin.save', bytes: new Uint8Array([0xff, 0x00, 0xfe]) };
  const badJsonBytes = await Codec.encodeEs3Bytes('{broken', { mode: 'aes-plain', password: 'Meow' });
  const badJson = { name: 'corrupt_json.save', bytes: badJsonBytes };
  const s = Core.createSession(RawCatalog);
  await s.loadFiles([...demo, badBin, badJson], 'Meow');
  s.setCurrency(0, 77777);
  assert.equal(s.getSummary().dirtyFileCount, 1);
  assert.doesNotThrow(() => s.resetAll());
  assert.equal(s.getCurrencies()[0].value, 50000);
  assert.equal(s.getSummary().dirtyFileCount, 0);
  const bad = Object.values(s.files).filter(f => f.originalParseFailed);
  assert.equal(bad.length, 2);
  assert.deepEqual(bad.map(f => Array.from(f.originalBytes)), [Array.from(badBin.bytes), Array.from(badJson.bytes)]);
});

test('R1.11 [A9][A10] getFiefBuildings is pure read-only and setFiefBuildingLevel syncs empty/null privateFiefSharedData', async () => {
  const s = await makeLoadedSession();
  Codec.objSet(Codec.objGet(s._dataValue('global'), 'fiefSharedData'), 'value', Codec.makeObj([]), true);
  Codec.objSet(Codec.objGet(s._dataValue('game'), 'privateFiefSharedData'), 'value', Codec.makeObj([['buildingLevelDict', null, true]]), true);
  const gBefore = s.getRawFileText('global');
  const gmBefore = s.getRawFileText('game');
  s.getFiefBuildings();
  assert.equal(s.getRawFileText('global'), gBefore);
  assert.equal(s.getRawFileText('game'), gmBefore);
  s.setFiefBuildingLevel(112, 4);
  assert.equal(s.files.global.dirty, true);
  assert.equal(s.files.game.dirty, true);
  assert.equal(s.getRawFileText('game').includes('112:4'), true);
  Codec.objSet(Codec.objGet(s._dataValue('game'), 'privateFiefSharedData'), 'value', Codec.makeObj([]), true);
  s.files.game.dirty = false;
  s.applyPreset('fief_all_max');
  assert.equal(s.files.game.dirty, true);
  assert.equal(s.getRawFileText('game').includes('112:5'), true);
});

test('R1.12 [A11] omitted catalog fallback abilities match catalog and all_life_skills_max 26 keys', async () => {
  const demo = await Core.createDemoSlotFiles(RawCatalog, 'Meow');
  const s = Core.createSession({});
  await s.loadFiles(demo, 'Meow');
  const wantKeys = RawCatalog.characterProps.abilities.map(a => a.key);
  assert.deepEqual(s.catalog.characterProps.abilities.map(a => a.key), wantKeys);
  Codec.objSet(s._charNodeByInstance('100401'), 'm_additionProps', Codec.makeObj([]), true);
  s.applyPreset('all_life_skills_max');
  assert.deepEqual(Object.keys(s.getCharacterDetail('100401').additionProps), wantKeys);
});

test('R1.13 [G3][G4] non-destructive export timestamps, markSaved baseline advance, and async revision guard', async () => {
  const s = await makeLoadedSession();
  s.setCurrency(0, 90000);
  const mod = await s.exportModifiedFiles({ updateTimestamp: true });
  const all = await s.exportAllFiles({ updateTimestamp: true });
  assert.equal(s.getRawFileText('playerTeam').includes('1730652588'), true);
  assert.equal(!mod[0].text.includes('1730652588'), true);
  assert.equal(mod[0].revision, s.files.playerTeam.revision);
  assert.equal(all.find(e => e.name === 'SaveObjectPagoda.save').text.includes('1730652588'), true);
  s.markSaved(mod);
  assert.equal(s.files.playerTeam.dirty, false);
  assert.equal(s.changeLog.length, 0);
  assert.equal(s.getRawFileText('playerTeam'), mod[0].text);
  s.setCurrency(0, 11111);
  s.resetAll();
  assert.equal(s.getCurrencies()[0].value, 90000);
  s.setCurrency(0, 200000);
  const inflight = await s.exportModifiedFiles({ updateTimestamp: true });
  s.setCurrency(0, 300000);
  s.markSaved(inflight);
  assert.equal(s.files.playerTeam.dirty, true);
  assert.equal(s.getCurrencies()[0].value, 300000);
  s.resetAll();
  assert.equal(s.getCurrencies()[0].value, 200000);
});

test('R1.14 [G5] connect-dir button stays hidden across browser and WebView2', () => {
  for (const opts of [{ showDirectoryPicker: async () => makeMockDir({}) }, {}, { webview2: true, showDirectoryPicker: async () => makeMockDir({}) }, { location: { protocol: 'http:', hostname: '127.0.0.1' }, fetch: async () => ({ ok: true, json: async () => ({ status: 'NOT_RUNNING' }) }) }]) {
    const h = createUiHarness(opts);
    assert.strictEqual(h.els['btn-connect-dir'].hidden, true);
  }
});

test('R1.15 [B2] editor-ui commits directory/native opens only on full success', async () => {
  const demoFiles = await Core.createDemoSlotFiles(RawCatalog, 'Meow');
  const h = createUiHarness({});
  await h.ui.loadDemoSlot();
  const st = h.ui.getState();
  const saved = [st.session, st.dirHandle, st.fileHandles, st.fileHashes];
  await h.ui.readBrowserFileInputs([]);
  await h.ui.connectDirectoryPicker();
  assert.deepStrictEqual([st.session, st.dirHandle, st.fileHandles, st.fileHashes], saved);

  const demoB64 = demoFiles.map(f => ({ name: f.name, base64: Buffer.from(f.bytes).toString('base64') }));
  const replies = [
    { ok: true, session: 's1', files: demoB64 },
    { ok: true, session: 's2', files: [] },
    { ok: true, session: 's3', files: [{ name: 'bad.save', base64: 'AAAA' }] }
  ];
  const hv = createUiHarness({
    webview2: true,
    onPost(msg, emit) {
      if (msg.kind === 'confirm-session' || msg.kind === 'discard-pending-session') {
        setTimeout(() => emit({ id: msg.id, seq: msg.seq, ok: true, session: msg.session }), 0);
        return;
      }
      const reply = replies.shift();
      setTimeout(() => emit({ id: msg.id, seq: msg.seq, ...reply }), 0);
    }
  });
  await hv.ui.nativeOpenSlot();
  assert.strictEqual(hv.ui.getNativeSession(), 's1');
  const before = hv.ui.getSession();
  await hv.ui.nativeOpenSlot();
  assert.strictEqual(hv.ui.getNativeSession(), 's1');
  assert.strictEqual(hv.ui.getSession(), before);
  await hv.ui.nativeOpenSlot();
  assert.strictEqual(hv.ui.getNativeSession(), 's1');
  assert.strictEqual(hv.ui.getSession(), before);
});

test('R1.16 & R1.17 [B3][B5][B6] editor-ui blocks browser direct overwrite without backups or partial mutations', async () => {
  const demoFiles = await Core.createDemoSlotFiles(RawCatalog, 'Meow');
  let writes = 0;
  const dir = makeMockDir(demoFiles, { beforeWrite() { writes++; } });
  const h = createUiHarness({}); await attachPrepopulatedDir(h, demoFiles, dir); const s = h.ui.getSession();
  s.setCurrency(0, 88888); s.setFiefBuildingLevel(112, 5);
  const list = await s.exportModifiedFiles({ updateTimestamp: false });
  assert.ok(list.length >= 2);
  const n0 = list[0].name, before = dir.files[n0].slice();
  await assert.rejects(() => h.ui.saveToConnectedDir(list), /직접 덮어쓰기가 차단/);
  assert.equal(writes, 0);
  assert.ok(!Object.keys(dir.files).some(k => /\.(bak|tmp)$/.test(k)));
  assert.deepEqual(dir.files[n0], before);
  assert.equal(h.global.hasUnsavedChanges(), true);
});

test('R1.18 [B4][G3] editor-ui guards UI during export and preserves edits made in flight', async () => {
  const demoFiles = await Core.createDemoSlotFiles(RawCatalog, 'Meow');
  const demoB64 = demoFiles.map(f => ({ name: f.name, base64: Buffer.from(f.bytes).toString('base64') }));
  let release; let gate = new Promise(r => { release = r; });
  const hv = createUiHarness({ webview2: true, onPost(msg, emit) {
    if (msg.kind === 'open-slot') setTimeout(() => emit({ id: msg.id, seq: msg.seq, ok: true, session: 's1', files: demoB64 }), 0);
    else if (msg.kind === 'confirm-session') setTimeout(() => emit({ id: msg.id, seq: msg.seq, ok: true, session: msg.session }), 0);
    else if (msg.kind === 'save-files') gate.then(() => emit({ id: msg.id, seq: msg.seq, ok: true, session: 's2' }));
  }});
  await hv.ui.nativeOpenSlot();
  const s = hv.ui.getSession();
  s.setCurrency(0, 12345);
  const flow = hv.ui.exportFilesFlow(false);
  await new Promise(r => setTimeout(r, 10));
  assert.equal(hv.ui.isBusy(), true);
  assert.equal(hv.ui.guardNotBusy(), false);
  hv.els['btn-reset-all'].click();
  assert.equal(s.getCurrencies()[0].value, 12345);
  assert.ok(hv.els['status-bar'].textContent.includes('진행 중'));
  release(); await flow;
  assert.equal(hv.global.hasUnsavedChanges(), false);
  s.setCurrency(0, 999); s.resetAll();
  assert.equal(s.getCurrencies()[0].value, 12345);
  s.setCurrency(0, 54321);
  let release2; gate = new Promise(r => { release2 = r; });
  const flow2 = hv.ui.exportFilesFlow(false);
  await new Promise(r => setTimeout(r, 10));
  s.setCurrency(0, 65432);
  release2(); await flow2;
  assert.equal(hv.global.hasUnsavedChanges(), true);
  assert.equal(s.files.playerTeam.dirty, true);
  assert.equal(s.getCurrencies()[0].value, 65432);
  s.resetAll();
  assert.equal(s.getCurrencies()[0].value, 54321);
});

test('R1.19 [B7] editor-ui native save uses base64 and enforces payload/timeout limits', async () => {
  const demoFiles = await Core.createDemoSlotFiles(RawCatalog, 'Meow');
  const demoB64 = demoFiles.map(f => ({ name: f.name, base64: Buffer.from(f.bytes).toString('base64') }));
  const hv = createUiHarness({
    webview2: true,
    onPost(msg, emit) {
      if (msg.silentTimeoutProbe) return;
      if (msg.kind === 'open-slot') {
        setTimeout(() => emit({ id: msg.id, seq: msg.seq, ok: true, session: 's1', files: demoB64 }), 0);
      } else if (msg.kind === 'confirm-session' || msg.kind === 'discard-pending-session') {
        setTimeout(() => emit({ id: msg.id, seq: msg.seq, ok: true, session: msg.session }), 0);
      } else if (msg.kind === 'save-files') {
        setTimeout(() => emit({ id: msg.id, seq: msg.seq, ok: true, session: 's2' }), 0);
      }
    }
  });
  await hv.ui.nativeOpenSlot();
  const s = hv.ui.getSession();
  s.setCurrency(0, 77777);
  const postedBefore = hv.posted.length;
  await hv.ui.nativeSaveModified();
  const saveMsg = hv.posted.slice(postedBefore).find(m => m.kind === 'save-files');
  assert.ok(saveMsg);
  assert.ok(saveMsg.files[0].base64);
  assert.strictEqual('data' in saveMsg.files[0], false);

  const st = hv.ui.getState();
  const postedCount = hv.posted.length;
  await assert.rejects(
    () => hv.ui.sendNativeRequest({ kind: 'save-files', big: 'x'.repeat(90 * 1024 * 1024 + 32) }),
    /너무 큽니다/
  );
  assert.strictEqual(hv.posted.length, postedCount);
  assert.strictEqual(Object.keys(st.nativePending).length, 0);

  st.nativeTimeoutMs = 20;
  await assert.rejects(
    () => hv.ui.sendNativeRequest({ kind: 'save-files', silentTimeoutProbe: true }),
    /시간이 초과/
  );
  assert.strictEqual(Object.keys(st.nativePending).length, 0);
});

test('R2.B6 [R2-B6] confirmDiscardUnsaved blocks session replacement across all 4 open flows when declined', async () => {
  const demoFiles = await Core.createDemoSlotFiles(RawCatalog, 'Meow');
  const browserFiles = demoFiles.map(f => ({ name: f.name, arrayBuffer: async () => f.bytes.buffer.slice(f.bytes.byteOffset, f.bytes.byteOffset + f.bytes.byteLength) }));

  const checkBrowser = async (open) => {
    const h = createUiHarness({});
    await h.ui.loadDemoSlot();
    const s = h.ui.getSession(); s.setCurrency(0, 12345);
    const st = h.ui.getState();
    const before = { session: st.session, dirHandle: st.dirHandle, fileHandles: { ...st.fileHandles }, fileHashes: { ...st.fileHashes } };
    h.global.confirm = () => false;
    await open(h);
    assert.strictEqual(st.session, before.session);
    assert.strictEqual(st.dirHandle, before.dirHandle);
    assert.deepStrictEqual({ ...st.fileHandles }, { ...before.fileHandles });
    assert.deepStrictEqual({ ...st.fileHashes }, { ...before.fileHashes });
    h.global.confirm = () => true;
    await open(h);
    assert.notStrictEqual(st.session, before.session);
  };
  await checkBrowser(h => h.ui.readBrowserFileInputs(browserFiles));
  await checkBrowser(h => h.ui.loadDemoSlot());
  {
    const h = createUiHarness({});
    await h.ui.loadDemoSlot();
    const st = h.ui.getState(), beforeSession = st.session;
    h.global.confirm = () => true;
    await h.ui.connectDirectoryPicker();
    assert.strictEqual(st.session, beforeSession);
    assert.strictEqual(st.dirHandle, null);
  }

  const posts = [];
  let openSeq = 0;
  const hv = createUiHarness({
    webview2: true,
    onPost(msg, emit) {
      posts.push(msg);
      if (msg.kind === 'open-slot') {
        setTimeout(() => emit({ id: msg.id, seq: msg.seq, ok: true, session: 's' + (++openSeq), files: demoFiles.map(f => ({ name: f.name, base64: Buffer.from(f.bytes).toString('base64') })) }), 0);
      } else if (msg.kind === 'open-files') {
        setTimeout(() => emit({ id: msg.id, seq: msg.seq, ok: true, session: 's' + (++openSeq), files: demoFiles.map(f => ({ name: f.name, base64: Buffer.from(f.bytes).toString('base64') })) }), 0);
      } else if (msg.kind === 'confirm-session' || msg.kind === 'discard-pending-session') {
        setTimeout(() => emit({ id: msg.id, seq: msg.seq, ok: true, session: msg.session }), 0);
      }
    }
  });
  await hv.ui.nativeOpenSlot();
  const st = hv.ui.getState();
  hv.ui.getSession().setCurrency(0, 54321);
  const beforeNative = { session: st.session, nativeSession: st.nativeSession };
  hv.global.confirm = () => false;
  const postCount = posts.length;
  await hv.ui.nativeOpenSlot();
  await hv.ui.nativeOpenFiles();
  assert.strictEqual(st.session, beforeNative.session);
  assert.strictEqual(st.nativeSession, beforeNative.nativeSession);
  assert.strictEqual(posts.slice(postCount).filter(m => m.kind === 'open-slot' || m.kind === 'open-files').length, 0);
  hv.global.confirm = () => true;
  await hv.ui.nativeOpenSlot();
  assert.notStrictEqual(st.nativeSession, beforeNative.nativeSession);
});

test('R2.B1 [R2-B1] native two-phase open confirms valid session and discards pending on parse failure', async () => {
  const demoFiles = await Core.createDemoSlotFiles(RawCatalog, 'Meow');
  const demoB64 = demoFiles.map(f => ({ name: f.name, base64: Buffer.from(f.bytes).toString('base64') }));
  const posts = [];
  let holdConfirm = null;
  let notifyConfirm;
  const confirmReached = new Promise(r => { notifyConfirm = r; });
  const hv = createUiHarness({
    webview2: true,
    onPost(msg, emit) {
      posts.push(msg);
      if (msg.kind === 'open-slot') {
        if (posts.filter(m => m.kind === 'open-slot').length === 1) {
          setTimeout(() => emit({ id: msg.id, seq: msg.seq, ok: true, session: 's1', files: demoB64 }), 0);
        } else {
          setTimeout(() => emit({ id: msg.id, seq: msg.seq, ok: true, session: 's_bad', files: [{ name: 'SaveObjectTime.save', base64: 'AAAA' }] }), 0);
        }
      } else if (msg.kind === 'confirm-session') {
        holdConfirm = { msg, emit };
        notifyConfirm();
      } else if (msg.kind === 'discard-pending-session') {
        setTimeout(() => emit({ id: msg.id, seq: msg.seq, ok: true, session: msg.session }), 0);
      }
    }
  });

  const p = hv.ui.nativeOpenSlot();
  await confirmReached;
  assert.notStrictEqual(hv.ui.getNativeSession(), 's1');
  holdConfirm.emit({ id: holdConfirm.msg.id, seq: holdConfirm.msg.seq, ok: true, session: 's1' });
  await p;
  assert.strictEqual(hv.ui.getNativeSession(), 's1');
  const prevSession = hv.ui.getSession();

  await hv.ui.nativeOpenSlot();
  assert(posts.some(m => m.kind === 'discard-pending-session' && m.session === 's_bad'));
  assert.strictEqual(hv.ui.getNativeSession(), 's1');
  assert.strictEqual(hv.ui.getSession(), prevSession);
});

test('R2.B2 [R2-B2] native open has no timeout and save timeout reconciles via session-status or locks until late reply', async () => {
  const demoFiles = await Core.createDemoSlotFiles(RawCatalog, 'Meow');
  const demoB64 = demoFiles.map(f => ({ name: f.name, base64: Buffer.from(f.bytes).toString('base64') }));
  let saveMode = 'reconcile';
  let lastSaveMsg = null;
  const hv = createUiHarness({
    webview2: true,
    onPost(msg, emit) {
      if (msg.kind === 'open-slot') {
        setTimeout(() => emit({ id: msg.id, seq: msg.seq, ok: true, session: 's_timeout', files: demoB64 }), 35);
      } else if (msg.kind === 'confirm-session' || msg.kind === 'discard-pending-session') {
        setTimeout(() => emit({ id: msg.id, seq: msg.seq, ok: true, session: msg.session }), 0);
      } else if (msg.kind === 'save-files') {
        lastSaveMsg = msg;
      } else if (msg.kind === 'session-status') {
        if (saveMode === 'reconcile') {
          setTimeout(() => emit({ id: msg.id, seq: msg.seq, ok: true, working: false, activeSession: 's_rec', lastCompletedSaveId: lastSaveMsg.id, lastCompletedSaveSession: 's_rec' }), 0);
        } else {
          setTimeout(() => emit({ id: msg.id, seq: msg.seq, ok: true, working: true, activeSession: 's_rec' }), 0);
        }
      }
    }
  });

  const st = hv.ui.getState();
  st.nativeTimeoutMs = 15;
  await hv.ui.nativeOpenSlot();
  assert.strictEqual(hv.ui.getNativeSession(), 's_timeout');
  hv.ui.getSession().setCurrency(0, 11111);
  await hv.ui.nativeSaveModified();
  assert.strictEqual(hv.ui.getNativeSession(), 's_rec');
  assert.strictEqual(hv.global.hasUnsavedChanges(), false);
  assert.strictEqual(st.nativeUncertain, false);
  saveMode = 'uncertain';
  hv.ui.getSession().setCurrency(0, 22222);
  await hv.ui.nativeSaveModified();
  assert.strictEqual(st.nativeUncertain, true);
  assert.strictEqual(hv.ui.guardNotBusy(), false);
  hv.emitWebview({ id: lastSaveMsg.id, seq: lastSaveMsg.seq, ok: true, session: 's_late' });
  assert.strictEqual(st.nativeUncertain, false);
  assert.strictEqual(hv.ui.getNativeSession(), 's_late');
  assert.strictEqual(hv.global.hasUnsavedChanges(), false);
});

test('R3.A1 [R3-A1] markSaved rejects stale load-generation, cross-session, and tokenless exports without mutating slot B', async () => {
  const demoFiles = await Core.createDemoSlotFiles(RawCatalog, 'Meow');
  const s = Core.createSession(RawCatalog);
  await s.loadFiles(demoFiles, 'Meow');
  s.setCurrency(0, 22222);
  const expA = await s.exportModifiedFiles({ updateTimestamp: false });
  assert.strictEqual(expA[0].revision, 1);
  assert.strictEqual(typeof expA[0].loadToken, 'string');

  const tmp = Core.createSession(RawCatalog);
  await tmp.loadFiles(demoFiles, 'Meow');
  tmp.setCurrency(0, 70000);
  const slotB = await tmp.exportAllFiles({ updateTimestamp: false });
  await s.loadFiles(slotB, 'Meow');
  const origTextB = s.files.playerTeam.originalText;
  const origBytesB = Uint8Array.from(s.files.playerTeam.originalBytes);

  assert.strictEqual(s.files.playerTeam.revision, 0);
  assert.strictEqual(s.markSaved(expA), 0);
  assert.strictEqual(s.getCurrencies()[0].value, 70000);
  assert.strictEqual(s.hasUnsavedChanges(), false);
  assert.strictEqual(s.files.playerTeam.originalText, origTextB);
  assert.deepStrictEqual(Uint8Array.from(s.files.playerTeam.originalBytes), origBytesB);

  s.setCurrency(0, 80000);
  assert.strictEqual(s.files.playerTeam.revision, 1);
  assert.strictEqual(s.markSaved(expA), 0);
  assert.strictEqual(s.getCurrencies()[0].value, 80000);
  assert.strictEqual(s.hasUnsavedChanges(), true);
  s.resetAll();
  assert.strictEqual(s.getCurrencies()[0].value, 70000);

  const s2 = Core.createSession(RawCatalog);
  await s2.loadFiles(demoFiles, 'Meow');
  assert.strictEqual(s2.markSaved(expA), 0);
  assert.strictEqual(s2.markSaved([{ ...expA[0], loadToken: undefined }]), 0);
});

test('R3.A2 [R3-A2] createSession({}) fallback characterProps matches RawCatalog and supports setCharacterProp', async () => {
  const emptySess = Core.createSession({});
  assert.deepStrictEqual(emptySess.catalog.characterProps, RawCatalog.characterProps);
  await emptySess.loadFiles(await Core.createDemoSlotFiles(RawCatalog, 'Meow'), 'Meow');
  emptySess.setCharacterProp('100401', 'origin', '臂力', 25);
  assert.strictEqual(emptySess.getCharacterDetail('100401').originProps['臂力'], 25);
});

test('R3.B3 [R3-B3] confirm-session timeout reconciles via session-status or locks until late confirm reply', async () => {
  const demoFiles = await Core.createDemoSlotFiles(RawCatalog, 'Meow');
  const demoB64 = demoFiles.map(f => ({ name: f.name, base64: Buffer.from(f.bytes).toString('base64') }));
  let confirmMsg = null;
  let postedDiscard = null;
  let mode = 'reconcile';
  const hv = createUiHarness({
    webview2: true,
    onPost(msg, emit) {
      if (msg.kind === 'open-slot') {
        const session = mode === 'reconcile' ? 'sB' : mode === 'discard' ? 'sDrop' : 'sC';
        emit({ id: msg.id, seq: msg.seq, ok: true, session, files: demoB64 });
      } else if (msg.kind === 'confirm-session') {
        confirmMsg = msg;
      } else if (msg.kind === 'session-status') {
        if (mode === 'reconcile') emit({ id: msg.id, seq: msg.seq, ok: true, working: false, activeSession: 'sB', lastConfirmedSessionId: confirmMsg.id });
        else if (mode === 'discard') emit({ id: msg.id, seq: msg.seq, ok: true, working: false, activeSession: 'sB', pendingSession: 'sDrop' });
        else emit({ id: msg.id, seq: msg.seq, ok: true, working: true, activeSession: 'sB' });
      } else if (msg.kind === 'discard-pending-session') {
        postedDiscard = msg.session;
        emit({ id: msg.id, seq: msg.seq, ok: true });
      }
    }
  });
  const st = hv.ui.getState();
  st.nativeTimeoutMs = 15;
  await hv.ui.nativeOpenSlot();
  assert.strictEqual(hv.ui.getNativeSession(), 'sB');
  assert.strictEqual(st.nativeUncertain, false);

  mode = 'discard';
  await hv.ui.nativeOpenSlot();
  assert.strictEqual(hv.ui.getNativeSession(), 'sB');
  assert.strictEqual(st.nativeUncertain, false);
  assert.strictEqual(postedDiscard, 'sDrop');

  mode = 'uncertain';
  await hv.ui.nativeOpenSlot();
  assert.strictEqual(hv.ui.getNativeSession(), 'sB');
  assert.strictEqual(st.nativeUncertain, true);
  assert.strictEqual(hv.ui.guardNotBusy(), false);
  hv.emitWebview({ id: confirmMsg.id, seq: confirmMsg.seq, ok: true, session: 'sC' });
  assert.strictEqual(hv.ui.getNativeSession(), 'sC');
  assert.strictEqual(st.nativeUncertain, false);
});

test('R3.B5 [R3-B5] ensureBrowserGameNotRunning checks game status while direct folder write stays blocked', async () => {
  const demoFiles = await Core.createDemoSlotFiles(RawCatalog, 'Meow');
  const hA = createUiHarness({ checkGameStatus: undefined });
  assert.strictEqual(hA.els['btn-connect-dir'].hidden, true);
  await assert.rejects(() => hA.ui.ensureBrowserGameNotRunning(), /차단/);
  await hA.ui.connectDirectoryPicker();
  assert.strictEqual(hA.ui.getState().dirHandle, null);

  let gameState = 'NOT_RUNNING';
  const hB = createUiHarness({ checkGameStatus: async () => gameState });
  await hB.ui.ensureBrowserGameNotRunning();
  gameState = 'RUNNING';
  await assert.rejects(() => hB.ui.ensureBrowserGameNotRunning(), /Wulin\.exe/);

  let fetchMode = 'NOT_RUNNING';
  const hC = createUiHarness({
    location: { protocol: 'http:', hostname: '127.0.0.1' },
    fetch: async () => fetchMode === 'ERROR' ? { ok: false, status: 500 } : { ok: true, json: async () => ({ status: fetchMode }) }
  });
  assert.strictEqual(hC.els['btn-connect-dir'].hidden, true);
  await hC.ui.ensureBrowserGameNotRunning();
  await attachPrepopulatedDir(hC, demoFiles, makeMockDir(demoFiles));
  hC.ui.getSession().setCurrency(0, 66666);
  const listC = await hC.ui.getSession().exportModifiedFiles({ updateTimestamp: false });
  await assert.rejects(() => hC.ui.saveToConnectedDir(listC), /직접 덮어쓰기가 차단/);
  fetchMode = 'RUNNING';
  await assert.rejects(() => hC.ui.ensureBrowserGameNotRunning(), /Wulin\.exe/);
  fetchMode = 'ERROR';
  await assert.rejects(() => hC.ui.ensureBrowserGameNotRunning(), /차단/);
});

test('R4.A1 & R4.A2 [R4-A1][R4-A2] exportModifiedFiles/exportAllFiles capture synchronous loadToken and batch snapshot before await', async () => {
  const slotA = await Core.createDemoSlotFiles(RawCatalog, 'Meow');
  const slotB = await Core.createDemoSlotFiles(RawCatalog, 'Meow');
  const s = Core.createSession(RawCatalog);
  await s.loadFiles(slotA, 'Meow');
  s.setCurrency(0, 77777);
  const pendingMod = s.exportModifiedFiles({ updateTimestamp: false });
  const pendingAll = s.exportAllFiles({ updateTimestamp: false });
  await s.loadFiles(slotB, 'Meow');
  const [staleMod, staleAll] = await Promise.all([pendingMod, pendingAll]);

  assert.strictEqual(s.markSaved(staleMod), 0);
  assert.strictEqual(s.markSaved(staleAll), 0);
  assert.strictEqual(s.files.playerTeam.dirty, false);
  assert.notStrictEqual(s.getCurrencies()[0].value, 77777);

  s.setCurrency(0, 55555);
  assert.strictEqual(s.files.playerTeam.revision, 1);
  assert.strictEqual(staleMod[0].revision, 1);
  const origBytesBefore = Uint8Array.from(s.files.playerTeam.originalBytes);
  const origTextBefore = s.files.playerTeam.originalText;
  assert.strictEqual(s.markSaved(staleMod), 0);
  assert.strictEqual(s.markSaved(staleAll), 0);
  assert.strictEqual(s.files.playerTeam.dirty, true);
  assert.strictEqual(s.getCurrencies()[0].value, 55555);
  assert.deepStrictEqual(s.files.playerTeam.originalBytes, origBytesBefore);
  assert.strictEqual(s.files.playerTeam.originalText, origTextBefore);
  s.resetAll();
  assert.notStrictEqual(s.getCurrencies()[0].value, 77777);

  const s2 = Core.createSession(RawCatalog);
  await s2.loadFiles(slotA, 'Meow');
  s2.setFiefBuildingLevel(112, 4);
  const pSnap = s2.exportModifiedFiles({ updateTimestamp: false });
  s2.setFiefBuildingLevel(112, 5);
  const exported = await pSnap;
  assert.strictEqual(exported.length, 2);

  for (const e of exported) {
    const decoded = await Codec.decodeEs3Bytes(e.bytes, 'Meow');
    assert.strictEqual(decoded.text, e.text);
  }

  const verifyFiles = slotA.map(f => exported.find(x => x.name === f.name) || f);
  const verifySess = Core.createSession(RawCatalog);
  await verifySess.loadFiles(verifyFiles, 'Meow');
  assert.strictEqual(verifySess.getFiefBuildings().find(b => b.saveId === 112).level, 4);

  s2.markSaved(exported);
  assert.strictEqual(s2.files.game.dirty, true);
  assert.strictEqual(s2.files.global.dirty, true);
  assert.strictEqual(s2.getFiefBuildings().find(b => b.saveId === 112).level, 5);
  s2.resetAll();
  assert.strictEqual(s2.getFiefBuildings().find(b => b.saveId === 112).level, 4);
});

test('R5.A1 & R5.A2 [R5-A1][R5-A2] overlapping loadFiles commits atomically and manual utf8Encode replaces lone surrogates', async () => {
  const demoFiles = await Core.createDemoSlotFiles(RawCatalog, 'Meow');
  const prepA = Core.createSession(RawCatalog);
  await prepA.loadFiles(demoFiles, 'Meow');
  prepA.setCurrency(0, 44444);
  prepA.password = 'PassA';
  const expA = await prepA.exportAllFiles({ updateTimestamp: false });
  const prepB = Core.createSession(RawCatalog);
  await prepB.loadFiles(demoFiles, 'Meow');
  prepB.setCurrency(0, 99999);
  const slotB = await prepB.exportAllFiles({ updateTimestamp: false });
  const slotA1 = [{ name: 'corrupt_head.save', bytes: new Uint8Array([1, 2, 3, 4]) }, ...expA];
  const slotA2 = [...expA, { name: 'corrupt_tail.save', bytes: new Uint8Array([5, 6, 7]) }];
  const s = Core.createSession(RawCatalog);
  for (const candA of [slotA1, slotA2]) {
    const pA = s.loadFiles(candA, 'PassA');
    const pB = s.loadFiles(slotB, 'Meow');
    const [resA, resB] = await Promise.all([pA, pB]);
    assert.strictEqual(resA.superseded, true);
    assert.strictEqual(resB.fileCount, slotB.length);
    assert.strictEqual(s.password, 'Meow');
    assert.strictEqual(s.getCurrencies()[0].value, 99999);
    assert.ok(Object.keys(s.files).every(k => !k.includes('#2') && !k.includes('corrupt')));
    assert.ok(Object.values(s.files).every(f => f.loadToken === s._loadToken));
  }
  const codecSrc = fs.readFileSync(path.join(ROOT, 'src', 'es3-codec.js'), 'utf8');
  const mod = { exports: {} };
  vm.runInNewContext(codecSrc, { module: mod, exports: mod.exports, Uint8Array, ArrayBuffer, DataView, Math, Number, String, Object, Array, Error, TypeError, RangeError, SyntaxError });
  const manual = mod.exports;
  const fatalTd = new TextDecoder('utf-8', { fatal: true });
  assert.deepStrictEqual(Array.from(manual.utf8Encode('\uD800')), [0xEF, 0xBF, 0xBD]);
  assert.deepStrictEqual(Array.from(manual.utf8Encode('abc\uDBFF')).slice(-3), [0xEF, 0xBF, 0xBD]);
  assert.deepStrictEqual(Array.from(manual.utf8Encode('\uDC00')), [0xEF, 0xBF, 0xBD]);
  for (const [inp, expected] of [['\uD800', '\uFFFD'], ['abc\uDBFF', 'abc\uFFFD'], ['A\uD800B', 'A\uFFFDB'], ['\uDC00', '\uFFFD'], ['\uD83D\uDE00', '\uD83D\uDE00']]) {
    assert.strictEqual(manual.utf8Decode(manual.utf8Encode(inp)), expected);
    assert.strictEqual(fatalTd.decode(manual.utf8Encode(inp)), expected);
  }
});

test('R6.A1 & R6.A2 [R6-A1][R6-A2] malformed Data wrappers rejected without AST mutation and currencyFallback matches catalog', async () => {
  const malformed = [
    '{"Data":{"__type":"WuLin.SaveObjectBase,Assembly-CSharp","value":null}}',
    '{"Data":{"__type":"WuLin.SaveObjectBase,Assembly-CSharp","value":[]}}',
    '{"Data":{"__type":"WuLin.SaveObjectBase,Assembly-CSharp"}}',
    '{"Data":null}'
  ];
  for (const rawJson of malformed) {
    const s = Core.createSession(RawCatalog);
    const files = [{ name: 'SaveObjectPlayerTeam.save', bytes: await Codec.encodeEs3Bytes(rawJson, { mode: 'plain' }) }];
    await s.loadFiles(files);
    const entry = Object.values(s.files)[0];
    assert.throws(() => s.setCurrency(0, 100));
    assert.strictEqual(Codec.stringifyEs3Json(entry.parsed), rawJson);
    assert.strictEqual(entry.dirty, false);
    assert.strictEqual(entry.revision, 0);
    assert.strictEqual(s.changeLog.length, 0);
  }
  const unwrapped = '{"__type":"WuLin.SaveObjectPlayerTeam","playerTeamInventory":{}}';
  const s2 = Core.createSession(RawCatalog);
  await s2.loadFiles([{ name: 'SaveObjectPlayerTeam.save', bytes: await Codec.encodeEs3Bytes(unwrapped, { mode: 'plain' }) }]);
  s2.setCurrency(0, 100);
  assert.strictEqual(s2.getCurrencies()[0].value, 100);

  const fb = Core.createSession({});
  const full = Core.createSession(RawCatalog);
  const demoFiles = await Core.createDemoSlotFiles(RawCatalog, 'Meow');
  await fb.loadFiles(demoFiles);
  await full.loadFiles(demoFiles);
  assert.strictEqual(fb.catalog.currencies.length, 10);
  for (let i = 0; i < 10; i++) {
    assert.strictEqual(fb.catalog.currencies[i].id, RawCatalog.currencies[i].id);
    assert.strictEqual(fb.catalog.currencies[i].key, RawCatalog.currencies[i].key);
    assert.strictEqual(fb.catalog.currencies[i].ko, RawCatalog.currencies[i].ko);
    assert.strictEqual(fb.catalog.currencies[i].zh, RawCatalog.currencies[i].zh);
    assert.strictEqual(fb.catalog.currencies[i].max, RawCatalog.currencies[i].max);
  }
  assert.strictEqual(fb.catalog.fiefBuildings.find(b => b.saveId === 110).zh, '药膳坊');
  assert.strictEqual(fb.catalog.fiefBuildings.find(b => b.saveId === 114).zh, '悟道碑');
  assert.throws(() => fb.setCurrency(1, 100000000));
  assert.throws(() => full.setCurrency(1, 100000000));
  fb.setCurrency(1, 99999999);
});

test('R7.A1 & R7.C1 [R7-A1][R7-C1] fief Data wrapper pre-validation and canonical filename / ambiguity guards', async () => {
  const demoFiles = await Core.createDemoSlotFiles(RawCatalog, 'Meow');
  const r7CloneFiles = files => files.map(f => ({ name: f.name, bytes: Uint8Array.from(f.bytes) }));
  const r7Replace = (files, name, bytes) => files.map(f => f.name === name ? { name, bytes } : { name: f.name, bytes: Uint8Array.from(f.bytes) });
  const r7AssertStable = (s, keys) => {
    for (const key of keys) {
      const f = s.files[key];
      assert.strictEqual(Codec.stringifyEs3Json(f.parsed), f._r7Before);
      assert.strictEqual(f.dirty, false);
      assert.strictEqual(f.revision, 0);
    }
    assert.strictEqual(s.changeLog.length, 0);
  };
  const r7Capture = (s, keys) => keys.forEach(key => { s.files[key]._r7Before = Codec.stringifyEs3Json(s.files[key].parsed); });
  for (const badGlobal of ['{"Data":{"value":null}}', '{"Data":null}', '{"Data":{"value":[]}}']) {
    const files = r7Replace(demoFiles, 'SaveObjectGameGlobal.save', await Codec.encodeEs3Bytes(badGlobal, { mode: 'plain' }));
    const s = Core.createSession(RawCatalog);
    await s.loadFiles(files, 'Meow');
    r7Capture(s, ['global', 'game']);
    assert.throws(() => s.setFiefBuildingLevel(112, 5));
    r7AssertStable(s, ['global', 'game']);
  }
  for (const badGame of ['{"Data":{"value":null}}', '{"Data":null}']) {
    const files = r7Replace(demoFiles, 'SaveObjectGame.save', await Codec.encodeEs3Bytes(badGame, { mode: 'plain' }));
    const s = Core.createSession(RawCatalog);
    await s.loadFiles(files, 'Meow');
    r7Capture(s, ['global', 'game']);
    assert.throws(() => s.setFiefBuildingLevel(112, 5));
    r7AssertStable(s, ['global', 'game']);
  }
  const gameFile = demoFiles.find(f => f.name === 'SaveObjectGame.save');
  const dupFiles = [{ name: '000-copy.save', bytes: Uint8Array.from(gameFile.bytes) }, ...r7CloneFiles(demoFiles)];
  const sd = Core.createSession(RawCatalog);
  await sd.loadFiles(dupFiles, 'Meow');
  assert.strictEqual(sd.files.game.name, 'SaveObjectGame.save');
  assert.ok(!sd.ambiguousRoles.game);
  sd.setFiefBuildingLevel(112, 5);
  const outDup = await sd.exportModifiedFiles({ updateTimestamp: false });
  assert.ok(outDup.some(f => f.name === 'SaveObjectGameGlobal.save'));
  assert.ok(outDup.some(f => f.name === 'SaveObjectGame.save'));
  assert.ok(!outDup.some(f => f.name === '000-copy.save'));
  assert.strictEqual(sd.files['game#2'].dirty, false);

  const ambFiles = demoFiles.filter(f => f.name !== 'SaveObjectGame.save').concat([
    { name: '000-a.save', bytes: Uint8Array.from(gameFile.bytes) },
    { name: '001-b.save', bytes: Uint8Array.from(gameFile.bytes) }
  ]);
  const sa = Core.createSession(RawCatalog);
  await sa.loadFiles(ambFiles, 'Meow');
  assert.strictEqual(sa.ambiguousRoles.game, true);
  assert.throws(() => sa.setFiefBuildingLevel(112, 5));
  for (const f of Object.values(sa.files)) {
    assert.strictEqual(f.dirty, false);
    assert.strictEqual(f.revision, 0);
  }
});

test('R7.A2 [R7-A2] resetFile synchronizes peer fief data while preserving unrelated peer edits', async () => {
  const demoFiles = await Core.createDemoSlotFiles(RawCatalog, 'Meow');
  const r7CloneFiles2 = files => files.map(f => ({ name: f.name, bytes: Uint8Array.from(f.bytes) }));
  const s = Core.createSession(RawCatalog);
  await s.loadFiles(r7CloneFiles2(demoFiles), 'Meow');
  s.setFiefBuildingLevel(112, 5);
  assert.strictEqual(s.resetFile('game'), true);
  assert.strictEqual(s.files.game.dirty, false);
  assert.strictEqual(s.files.global.dirty, false);
  assert.strictEqual(s.getFiefBuildings().find(b => b.saveId === 112).level, 3);
  s.setFiefBuildingLevel(112, 5);
  assert.strictEqual(s.resetFile('global'), true);
  assert.strictEqual(s.files.game.dirty, false);
  assert.strictEqual(s.files.global.dirty, false);
  assert.strictEqual(s.getFiefBuildings().find(b => b.saveId === 112).level, 3);

  for (const [peerRole, resetRole] of [['game', 'global'], ['global', 'game']]) {
    const sp = Core.createSession(RawCatalog);
    await sp.loadFiles(r7CloneFiles2(demoFiles), 'Meow');
    Codec.objSet(sp._dataValue(peerRole), 'r7PeerNote', 'kept', true);
    sp._markDirty(peerRole);
    sp.setFiefBuildingLevel(112, 5);
    assert.strictEqual(sp.resetFile(resetRole), true);
    assert.strictEqual(sp.files[resetRole].dirty, false);
    assert.strictEqual(sp.files[peerRole].dirty, true);
    assert.strictEqual(Codec.objGet(sp._dataValue(peerRole), 'r7PeerNote'), 'kept');
    const exported = await sp.exportModifiedFiles({ updateTimestamp: false });
    const merged = demoFiles.map(f => {
      const e = exported.find(x => x.name === f.name);
      return e ? { name: e.name, bytes: e.bytes } : { name: f.name, bytes: Uint8Array.from(f.bytes) };
    });
    const ver = Core.createSession(RawCatalog);
    await ver.loadFiles(merged, 'Meow');
    assert.strictEqual(Codec.objGet(ver._dataValue(peerRole), 'r7PeerNote'), 'kept');
    assert.strictEqual(ver.getFiefBuildings().find(b => b.saveId === 112).level, 3);
    for (const role of ['game', 'global']) {
      const txt = ver.getRawFileText(role);
      assert.ok(txt.includes('112:3'));
      assert.ok(!txt.includes('112:5'));
    }
  }
});

test('R7.B1 [R7-B1] late save-files and confirm-session replies stay settled when session-status fails or times out', async () => {
  const demoFiles = await Core.createDemoSlotFiles(RawCatalog, 'Meow');
  const r7B64Files = demoFiles.map(f => ({ name: f.name, base64: Buffer.from(f.bytes).toString('base64') }));
  const hv = createUiHarness({ webview2: true });
  const st = hv.ui.getState();
  st.nativeTimeoutMs = 15;
  let heldSave = null;
  let heldConfirm = null;
  let phase = 'initial';
  hv.setOnPost((msg, emit) => {
    if (msg.kind === 'open-slot' && phase === 'initial') {
      emit({ id: msg.id, seq: msg.seq, ok: true, session: 's_init', files: r7B64Files });
    } else if (msg.kind === 'confirm-session' && phase === 'initial') {
      emit({ id: msg.id, seq: msg.seq, ok: true, session: msg.session });
    } else if (msg.kind === 'save-files' && phase === 'save1') {
      heldSave = msg;
    } else if (msg.kind === 'session-status' && phase === 'save1') {
      if (heldSave) emit({ id: heldSave.id, seq: heldSave.seq, ok: true, session: 's_saved' });
      phase = 'afterSave1';
    } else if (msg.kind === 'open-slot' && phase === 'open2') {
      emit({ id: msg.id, seq: msg.seq, ok: true, session: 's_open2', files: r7B64Files });
    } else if (msg.kind === 'confirm-session' && phase === 'open2') {
      heldConfirm = msg;
    } else if (msg.kind === 'session-status' && phase === 'open2') {
      if (heldConfirm) emit({ id: heldConfirm.id, seq: heldConfirm.seq, ok: true, session: 's_open2' });
      emit({ id: msg.id, seq: msg.seq, ok: false, error: 'status boom' });
      phase = 'afterOpen2';
    } else if (msg.kind === 'save-files' && phase === 'save2') {
      emit({ id: msg.id, seq: msg.seq, ok: true, session: 's_after' });
      phase = 'done';
    }
  });
  phase = 'initial';
  await hv.ui.nativeOpenSlot();
  phase = 'save1';
  hv.ui.getSession().setCurrency(0, 41234);
  await hv.ui.nativeSaveModified();
  assert.strictEqual(hv.ui.getState().nativeUncertain, false);
  assert.strictEqual(hv.ui.getNativeSession(), 's_saved');
  assert.strictEqual(hv.global.hasUnsavedChanges(), false);
  assert.notStrictEqual(hv.els['status-bar'].style.color, 'var(--danger)');
  assert.strictEqual(hv.ui.guardNotBusy(), true);

  phase = 'open2';
  await hv.ui.nativeOpenSlot();
  assert.strictEqual(hv.ui.getState().nativeUncertain, false);
  assert.strictEqual(hv.ui.getNativeSession(), 's_open2');
  assert.notStrictEqual(hv.els['status-bar'].style.color, 'var(--danger)');
  phase = 'save2';
  hv.ui.getSession().setCurrency(0, 45678);
  await hv.ui.nativeSaveModified();
  assert.strictEqual(hv.ui.getNativeSession(), 's_after');
  assert.strictEqual(hv.global.hasUnsavedChanges(), false);
});

test('R7.B2 [R7-B2] character prop, kungfu, trait, and relation UI mutations immediately sync summary and dirty badges', async () => {
  const r7NodeText = n => !n ? '' : (n.nodeType === 3 ? n.textContent : (n.textContent || '') + (n.children || []).map(r7NodeText).join(''));
  const h = createUiHarness({});
  await h.ui.loadDemoSlot();
  assert.strictEqual(h.els['dirty-badge'].textContent, '수정 0파일 · 변경 0건');
  assert.strictEqual(h.els['changelog-list'].children.length, 0);
  const check = () => {
    const sum = h.ui.getSession().getSummary();
    assert.strictEqual(h.els['dirty-badge'].textContent, '수정 ' + sum.dirtyFileCount + '파일 · 변경 ' + sum.changeLog.length + '건');
    assert.strictEqual(h.els['changelog-list'].children.length, sum.changeLog.length);
    assert.ok(r7NodeText(h.els['loaded-files-tbody']).includes('수정됨'));
  };
  const pr = h.els['char-props-tbody'].children[0];
  pr.children[2].children[0].value = '33';
  pr.children[5].children[0].click();
  check();
  const kr = h.els['char-kungfu-tbody'].children[0];
  kr.children[2].children[0].value = '9';
  kr.children[3].children[0].click();
  check();
  h.els['char-traits-list'].children[0].children[2].click();
  check();
  const rr = h.els['char-relations-tbody'].children[0];
  rr.children[2].children[0].value = '92';
  rr.children[3].children[0].click();
  check();
  assert.strictEqual(h.ui.getSession().getSummary().changeLog.length, 5);
});

test('R8.A1 & R8.C1 [R8-A1][R8-C1] damaged canonical files block copy fallback and fief desync; ambiguous playerTeam blocks auto-target presets', async () => {
  const demoFiles = await Core.createDemoSlotFiles(RawCatalog, 'Meow');
  const byName = (name) => demoFiles.find((f) => f.name === name);
  const gameFile = byName('SaveObjectGame.save');
  const globalFile = byName('SaveObjectGameGlobal.save');
  const copyName = '000-copy.save';
  const corruptions = [
    new Uint8Array([0xff, 0x00, 0xfe]),
    await Codec.encodeEs3Bytes('{broken_json', { mode: 'aes-plain', password: 'Meow' }),
  ];

  const assertPeerClean = (entry, serializedBefore) => {
    assert.strictEqual(entry.dirty, false);
    assert.strictEqual(entry.revision, 0);
    assert.strictEqual(Codec.stringifyEs3Json(entry.parsed), serializedBefore);
  };

  for (const corrupt of corruptions) {
    const sA = Core.createSession(RawCatalog);
    await sA.loadFiles([
      { name: copyName, bytes: Uint8Array.from(gameFile.bytes) },
      { name: 'SaveObjectGame.save', bytes: Uint8Array.from(corrupt) },
      { name: 'SaveObjectGameGlobal.save', bytes: Uint8Array.from(globalFile.bytes) },
    ], 'Meow');
    assert.strictEqual(sA.brokenRoles.game, true);
    assert.strictEqual(sA.files.game.name, 'SaveObjectGame.save');
    assert.strictEqual(sA.files['game#2'].name, copyName);
    const copyBefore = Codec.stringifyEs3Json(sA.files['game#2'].parsed);
    const globalBefore = Codec.stringifyEs3Json(sA.files.global.parsed);
    assert.throws(() => sA.setFiefBuildingLevel(112, 5));
    for (const key of ['game#2', 'game', 'global']) {
      assert.strictEqual(sA.files[key].dirty, false);
      assert.strictEqual(sA.files[key].revision, 0);
    }
    assert.strictEqual(Codec.stringifyEs3Json(sA.files['game#2'].parsed), copyBefore);
    assert.strictEqual(Codec.stringifyEs3Json(sA.files.global.parsed), globalBefore);
    assert.strictEqual(sA.changeLog.length, 0);
    assert.strictEqual((await sA.exportModifiedFiles({ updateTimestamp: false })).length, 0);

    const peerScenarios = [
      {
        files: [
          { name: 'SaveObjectGame.save', bytes: Uint8Array.from(corrupt) },
          { name: 'SaveObjectGameGlobal.save', bytes: Uint8Array.from(globalFile.bytes) },
        ],
        peerKey: 'global',
      },
      {
        files: [
          { name: 'SaveObjectGame.save', bytes: Uint8Array.from(gameFile.bytes) },
          { name: 'SaveObjectGameGlobal.save', bytes: Uint8Array.from(corrupt) },
        ],
        peerKey: 'game',
      },
    ];
    for (const scenario of peerScenarios) {
      const sPeer = Core.createSession(RawCatalog);
      await sPeer.loadFiles(scenario.files, 'Meow');
      const peerTextBefore = Codec.stringifyEs3Json(sPeer.files[scenario.peerKey].parsed);
      assert.throws(() => sPeer.setFiefBuildingLevel(112, 5));
      assertPeerClean(sPeer.files[scenario.peerKey], peerTextBefore);
      assert.strictEqual(sPeer.changeLog.length, 0);
    }
  }

  const teamFiles = [
    { name: '000-teamA.save', bytes: await Codec.encodeEs3Bytes(JSON.stringify({ Data: { value: { __type: 'WuLin.SaveObjectPlayerTeam,Assembly-CSharp', playerTeam: [100401] } } }), { mode: 'plain', password: 'Meow' }) },
    { name: '001-teamB.save', bytes: await Codec.encodeEs3Bytes(JSON.stringify({ Data: { value: { __type: 'WuLin.SaveObjectPlayerTeam,Assembly-CSharp', playerTeam: [10005] } } }), { mode: 'plain', password: 'Meow' }) },
    { name: 'SaveObjectGameCharacter.save', bytes: Uint8Array.from(byName('SaveObjectGameCharacter.save').bytes) },
  ];
  const sC = Core.createSession(RawCatalog);
  await sC.loadFiles(teamFiles, 'Meow');
  assert.strictEqual(sC.ambiguousRoles.playerTeam, true);
  const charsBefore = Codec.stringifyEs3Json(sC.files.characters.parsed);
  for (const presetId of ['hero_core_max', 'party_kungfu_max', 'wealth_package']) {
    assert.throws(() => sC.applyPreset(presetId));
    assert.strictEqual(sC.files.characters.dirty, false);
    assert.strictEqual(sC.files.characters.revision, 0);
    assert.strictEqual(Codec.stringifyEs3Json(sC.files.characters.parsed), charsBefore);
  }
  sC.setCharacterBasic('100401', { m_level: 50 });
  assert.strictEqual(sC.getCharacterDetail('100401').level, 50);
});

test('R8.A2 [R8-A2] pretty-printed originalText preserves clean peer dirty=false on resetFile and markSaved', async () => {
  const demoFiles = await Core.createDemoSlotFiles(RawCatalog, 'Meow');
  const pick = (name) => demoFiles.find((f) => f.name === name);
  const pretty = (rawText) => '{\n  ' + rawText.slice(1, -1) + '\n}\n';
  const gameName = 'SaveObjectGame.save';
  const globalName = 'SaveObjectGameGlobal.save';
  const modeList = ['plain', 'aes-gzip'];

  for (const mode of modeList) {
    const gameDecoded = Codec.decodeEs3BytesSync(pick(gameName).bytes, 'Meow');
    const globalDecoded = Codec.decodeEs3BytesSync(pick(globalName).bytes, 'Meow');
    const gamePrettyBytes = await Codec.encodeEs3Bytes(pretty(gameDecoded.text), { mode, password: 'Meow' });
    const globalPrettyBytes = await Codec.encodeEs3Bytes(pretty(globalDecoded.text), { mode, password: 'Meow' });
    const prettyFiles = [
      { name: gameName, bytes: gamePrettyBytes },
      { name: globalName, bytes: globalPrettyBytes },
    ];

    const s = Core.createSession(RawCatalog);
    await s.loadFiles(prettyFiles, 'Meow');
    assert.notStrictEqual(s.files.global.originalText, Codec.stringifyEs3Json(s.files.global.parsed));
    s.setFiefBuildingLevel(112, 5);
    assert.strictEqual(s.resetFile('game'), true);
    for (const peerKey of ['game', 'global']) {
      assert.strictEqual(s.files[peerKey].dirty, false);
    }
    assert.strictEqual(s.getFiefBuildings().find((b) => b.saveId === 112).level, 3);
    assert.strictEqual((await s.exportModifiedFiles({ updateTimestamp: false })).length, 0);

    s.setFiefBuildingLevel(112, 5);
    assert.strictEqual(s.resetFile('global'), true);
    for (const peerKey of ['game', 'global']) {
      assert.strictEqual(s.files[peerKey].dirty, false);
    }
    assert.strictEqual(s.getFiefBuildings().find((b) => b.saveId === 112).level, 3);
    assert.strictEqual((await s.exportModifiedFiles({ updateTimestamp: false })).length, 0);

    Codec.objSet(s._dataValue('global'), 'r8Note', 'keep', true);
    s._markDirty('global');
    s.setFiefBuildingLevel(112, 5);
    s.resetFile('game');
    assert.strictEqual(s.files.global.dirty, true);
    assert.strictEqual(Codec.objGet(s._dataValue('global'), 'r8Note'), 'keep');
    assert.strictEqual(s.getFiefBuildings().find((b) => b.saveId === 112).level, 3);

    const sMark = Core.createSession(RawCatalog);
    await sMark.loadFiles(prettyFiles, 'Meow');
    const snap0 = [{
      key: 'global',
      name: globalName,
      bytes: Uint8Array.from(sMark.files.global.originalBytes),
      text: sMark.files.global.originalText,
      revision: 0,
      loadToken: sMark._loadToken,
    }];
    sMark.setFiefBuildingLevel(112, 5);
    sMark.setFiefBuildingLevel(112, 3);
    assert.strictEqual(sMark.files.global.revision, 2);
    sMark.markSaved(snap0);
    assert.strictEqual(sMark.files.global.dirty, false);
  }
});

test('R8.B1 [R8-B1] live FileList cleared synchronously on input.value="" still loads all files and relativePaths', async () => {
  const demoFiles = await Core.createDemoSlotFiles(RawCatalog, 'Meow');
  const picked = ['SaveObjectPlayerTeam.save', 'SaveObjectGameCharacter.save', 'SaveObjectGameGlobal.save'].map((name) => demoFiles.find((f) => f.name === name));
  const h = createUiHarness({});
  const waitUntilIdle = async () => {
    while (h.ui.isBusy()) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  };
  const makeLiveList = (inputEl, relativePaths) => {
    const live = {
      length: picked.length,
      item(index) { return this[index] || null; },
    };
    picked.forEach((file, index) => {
      const bytes = Uint8Array.from(file.bytes);
      live[index] = {
        name: file.name,
        webkitRelativePath: relativePaths ? relativePaths[index] : '',
        arrayBuffer: async () => {
          await Promise.resolve();
          return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
        },
      };
    });
    inputEl.files = live;
    Object.defineProperty(inputEl, 'value', {
      configurable: true,
      get() { return 'live'; },
      set(value) {
        if (value === '') {
          picked.forEach((_, index) => { delete live[index]; });
          live.length = 0;
        }
      },
    });
    return live;
  };

  const cases = [
    { inputKey: 'file-input', relativePaths: null },
    { inputKey: 'folder-input', relativePaths: ['Save0/SaveObjectPlayerTeam.save', 'Save0/SaveObjectGameCharacter.save', 'Global/SaveObjectGameGlobal.save'] },
  ];
  for (const entry of cases) {
    const inputEl = h.els[entry.inputKey];
    const live = makeLiveList(inputEl, entry.relativePaths);
    const changeListener = inputEl.listeners.change[0];
    changeListener({ target: inputEl, currentTarget: inputEl });
    assert.strictEqual(live.length, 0);
    assert.strictEqual('0' in live, false);
    await waitUntilIdle();
    const loadedList = Object.values(h.ui.getSession().files);
    assert.strictEqual(loadedList.length, 3);
    for (let index = 0; index < picked.length; index += 1) {
      const loadedFile = loadedList.find((f) => f.name === picked[index].name);
      assert.ok(loadedFile);
      if (entry.relativePaths) {
        assert.strictEqual(loadedFile.relativePath, entry.relativePaths[index]);
      }
    }
  }
});

test('R9.A1 [R9-A1] canonical filename vs explicit __type mismatch pins canonical role as broken and blocks fief desync', async () => {
  const demoFiles = await Core.createDemoSlotFiles(RawCatalog, 'Meow');
  const validGlobal = demoFiles.find((f) => f.name === 'SaveObjectGameGlobal.save').bytes;
  const mismatchedGame = await Codec.encodeEs3Bytes(JSON.stringify({ Data: { value: { __type: 'WuLin.SaveObjectGameGlobal,Assembly-CSharp', privateFiefSharedData: { buildingLevelDict: { 112: 3 } } } } }), { mode: 'aes-gzip', password: 'Meow' });
  const s = Core.createSession(RawCatalog);
  await s.loadFiles([{ name: 'SaveObjectGameGlobal.save', bytes: validGlobal }, { name: 'SaveObjectGame.save', bytes: mismatchedGame }], 'Meow');
  assert.deepStrictEqual({ globalName: s.files.global.name, global2: s.files['global#2'], gameName: s.files.game.name, brokenGame: s.brokenRoles.game, hasTypeMismatch: Boolean(s.files.game.typeMismatchError) }, { globalName: 'SaveObjectGameGlobal.save', global2: undefined, gameName: 'SaveObjectGame.save', brokenGame: true, hasTypeMismatch: true });
  const globalAstBefore = Codec.stringifyEs3Json(s.files.global.parsed);
  const gameAstBefore = Codec.stringifyEs3Json(s.files.game.parsed);
  assert.throws(() => s.setFiefBuildingLevel(112, 5));
  assert.deepStrictEqual({ globalDirty: s.files.global.dirty, gameDirty: s.files.game.dirty, globalRevision: s.files.global.revision, gameRevision: s.files.game.revision, globalAst: Codec.stringifyEs3Json(s.files.global.parsed), gameAst: Codec.stringifyEs3Json(s.files.game.parsed), changeLogLength: s.changeLog.length }, { globalDirty: false, gameDirty: false, globalRevision: 0, gameRevision: 0, globalAst: globalAstBefore, gameAst: gameAstBefore, changeLogLength: 0 });
});

test('R9.A2 [R9-A2] Node Buffer inputs to loadFiles, exportAllFiles, and markSaved are isolated from caller in-place mutations', async () => {
  const demoFiles = await Core.createDemoSlotFiles(RawCatalog, 'Meow');
  const ptBytes = demoFiles.find((f) => f.name === 'SaveObjectPlayerTeam.save').bytes;
  const validBuf = Buffer.from(ptBytes);
  const corruptBuf = Buffer.from([0xde, 0xad, 0xbe, 0xef, 0x01, 0x02]);
  const origValidHex = toHex(validBuf);
  const origCorruptHex = toHex(corruptBuf);
  const s = Core.createSession(RawCatalog);
  await s.loadFiles([{ name: 'SaveObjectPlayerTeam.save', bytes: validBuf }, { name: 'SaveObjectPagoda.save', bytes: corruptBuf }], 'Meow');
  validBuf[0] ^= 0xff;
  corruptBuf[0] ^= 0xff;
  assert.deepStrictEqual({ playerTeamOriginal: toHex(s.files.playerTeam.originalBytes), playerTeamBytes: toHex(s.files.playerTeam.bytes), pagodaOriginal: toHex(s.files.pagoda.originalBytes), pagodaBytes: toHex(s.files.pagoda.bytes) }, { playerTeamOriginal: origValidHex, playerTeamBytes: origValidHex, pagodaOriginal: origCorruptHex, pagodaBytes: origCorruptHex });
  const exported = await s.exportAllFiles({ updateTimestamp: false });
  const exportedPagoda = exported.find((f) => f.name === 'SaveObjectPagoda.save');
  const exportedHex = toHex(exportedPagoda.bytes);
  exportedPagoda.bytes[0] ^= 0xff;
  assert.deepStrictEqual({ exportedHex, pagodaBytes: toHex(s.files.pagoda.bytes) }, { exportedHex: origCorruptHex, pagodaBytes: origCorruptHex });
  const savedBuf = Buffer.from(s.files.playerTeam.originalBytes);
  s.markSaved([{ key: 'playerTeam', name: 'SaveObjectPlayerTeam.save', bytes: savedBuf, text: s.files.playerTeam.originalText, revision: s.files.playerTeam.revision, loadToken: s._loadToken }]);
  savedBuf[0] ^= 0xff;
  assert.deepStrictEqual({ playerTeamOriginal: toHex(s.files.playerTeam.originalBytes), playerTeamBytes: toHex(s.files.playerTeam.bytes) }, { playerTeamOriginal: origValidHex, playerTeamBytes: origValidHex });
});

test('R9.A3 [R9-A3] applyPreset rolls back atomically on partial failure while preserving prior session edits and changeLog', async () => {
  const demoFiles = await Core.createDemoSlotFiles(RawCatalog, 'Meow');
  const s = Core.createSession(RawCatalog);
  await s.loadFiles(demoFiles, 'Meow');
  s.setCurrency(0, 12345);
  assert.deepStrictEqual({ playerTeamDirty: s.files.playerTeam.dirty, changeLogLength: s.changeLog.length }, { playerTeamDirty: true, changeLogLength: 1 });
  const charsAstBefore = Codec.stringifyEs3Json(s.files.characters.parsed);
  const pBefore = s.getCharacterDetail('100401');
  Codec.objSet(s._dataValue('playerTeam'), 'playerTeam', [Codec.makeNum(100401), Codec.makeNum(999999)], true);
  assert.throws(() => s.applyPreset('party_kungfu_max'));
  const pAfter = s.getCharacterDetail('100401');
  assert.deepStrictEqual({ kungfu: pAfter.kungfuList, curHp: pAfter.curHp, curEp: pAfter.curEp }, { kungfu: pBefore.kungfuList, curHp: pBefore.curHp, curEp: pBefore.curEp });
  assert.deepStrictEqual({ charactersDirty: s.files.characters.dirty, charactersRevision: s.files.characters.revision, charactersAst: Codec.stringifyEs3Json(s.files.characters.parsed), currency: s.getCurrencies().find((c) => c.id === 0).value, playerTeamDirty: s.files.playerTeam.dirty, changeLogLength: s.changeLog.length }, { charactersDirty: false, charactersRevision: 0, charactersAst: charsAstBefore, currency: 12345, playerTeamDirty: true, changeLogLength: 1 });
});

test('R10.A1 [R10-A1] cloneBytes isolates ArrayBuffer and DataView inputs across loadFiles, markSaved, resetAll, and exportAllFiles', async () => {
  const demoFiles = await Core.createDemoSlotFiles(RawCatalog, 'Meow');
  const ptBytes = demoFiles.find((f) => f.name === 'SaveObjectPlayerTeam.save').bytes;
  const rawAb = new ArrayBuffer(ptBytes.length); new Uint8Array(rawAb).set(ptBytes);
  const corruptBase = new ArrayBuffer(10); new Uint8Array(corruptBase, 2, 6).set([0xca, 0xfe, 0xba, 0xbe, 0x11, 0x22]);
  const corruptDv = new DataView(corruptBase, 2, 6);
  const origValidHex = toHex(new Uint8Array(rawAb)), origCorruptHex = 'cafebabe1122';
  const s = Core.createSession(RawCatalog);
  await s.loadFiles([{ name: 'SaveObjectPlayerTeam.save', bytes: rawAb }, { name: 'SaveObjectPagoda.save', bytes: corruptDv }], 'Meow');
  new Uint8Array(rawAb)[0] ^= 0xff; new Uint8Array(corruptBase)[2] ^= 0xff;
  s.resetFile('playerTeam'); s.resetAll();
  const exp1 = await s.exportAllFiles({ updateTimestamp: false });
  assert.deepStrictEqual({ ptOrig: toHex(s.files.playerTeam.originalBytes), ptBytes: toHex(s.files.playerTeam.bytes), pgOrig: toHex(s.files.pagoda.originalBytes), pgBytes: toHex(s.files.pagoda.bytes), pgExport: toHex(exp1.find((f) => f.name === 'SaveObjectPagoda.save').bytes) }, { ptOrig: origValidHex, ptBytes: origValidHex, pgOrig: origCorruptHex, pgBytes: origCorruptHex, pgExport: origCorruptHex });
  const markAb = new ArrayBuffer(ptBytes.length); new Uint8Array(markAb).set(ptBytes);
  s.markSaved([{ key: 'playerTeam', name: 'SaveObjectPlayerTeam.save', bytes: markAb, text: s.files.playerTeam.originalText, revision: s.files.playerTeam.revision, loadToken: s._loadToken }]);
  new Uint8Array(markAb)[0] ^= 0xff; s.resetAll();
  assert.deepStrictEqual({ orig: toHex(s.files.playerTeam.originalBytes), bytes: toHex(s.files.playerTeam.bytes) }, { orig: origValidHex, bytes: origValidHex });
  assert.throws(() => s.markSaved([{ key: 'playerTeam', bytes: 'bad', loadToken: s._loadToken }]), TypeError);
});

test('R10.A2 [R10-A2] applyPreset party_kungfu_max mid-execution failure after mutating first party member restores exact pre-preset snapshot', async () => {
  const demoFiles = await Core.createDemoSlotFiles(RawCatalog, 'Meow'), s = Core.createSession(RawCatalog);
  await s.loadFiles(demoFiles, 'Meow');
  const cc = Codec.objGet(s._dataValue('characters'), 'createdCharacter');
  Codec.objSet(Codec.objGet(Codec.objGet(cc, '100401'), 'kungfuInstances')[0], 'm_level', Codec.makeNum(1), true);
  Codec.objSet(Codec.objGet(Codec.objGet(cc, '10005'), 'kungfuInstances')[0], 'm_level', Codec.makeNum(16), true);
  s.setCurrency(0, 12345);
  const charsAst = Codec.stringifyEs3Json(s.files.characters.parsed), charsBytes = toHex(s.files.characters.bytes), ptAst = Codec.stringifyEs3Json(s.files.playerTeam.parsed), ptBytes = toHex(s.files.playerTeam.bytes), pBefore = s.getCharacterDetail('100401');
  assert.throws(() => s.applyPreset('party_kungfu_max'));
  const d = s.getCharacterDetail('100401');
  assert.deepStrictEqual({ level: d.kungfuList[0].level, hp: d.curHp, ep: d.curEp, charsDirty: s.files.characters.dirty, charsRev: s.files.characters.revision, charsAst: Codec.stringifyEs3Json(s.files.characters.parsed), charsBytes: toHex(s.files.characters.bytes), ptDirty: s.files.playerTeam.dirty, ptRev: s.files.playerTeam.revision, ptAst: Codec.stringifyEs3Json(s.files.playerTeam.parsed), ptBytes: toHex(s.files.playerTeam.bytes), coin: s.getCurrencies().find((c) => c.id === 0).value, logLen: s.changeLog.length }, { level: 1, hp: pBefore.curHp, ep: pBefore.curEp, charsDirty: false, charsRev: 0, charsAst, charsBytes, ptDirty: true, ptRev: 1, ptAst, ptBytes, coin: 12345, logLen: 1 });
});

test('R10.C2 [R10-C2] canonical filename rejects unrecognized explicit __type while allowing SaveObjectBase wrapper with omitted inner __type', async () => {
  for (const json of ['{"Data":{"value":{"__type":"Other.SaveObject,Assembly-CSharp"}}}', '{"Data":{"__type":"WuLin.SaveObjectBase,Assembly-CSharp","value":{"__type":"Other.SaveObject,Assembly-CSharp"}}}', '{"__type":"WuLin.SaveObjectGameUnknown,Assembly-CSharp"}']) {
    const s = Core.createSession(RawCatalog);
    await s.loadFiles([{ name: 'SaveObjectPlayerTeam.save', bytes: await Codec.encodeEs3Bytes(json, { mode: 'plain' }) }], 'Meow');
    assert.deepStrictEqual({ broken: s.brokenRoles.playerTeam, mismatch: Boolean(s.files.playerTeam.typeMismatchError) }, { broken: true, mismatch: true });
    assert.throws(() => s.setCurrency(0, 100)); assert.strictEqual(s.files.playerTeam.dirty, false);
  }
  const s = Core.createSession(RawCatalog);
  await s.loadFiles([{ name: 'SaveObjectPlayerTeam.save', bytes: await Codec.encodeEs3Bytes('{"Data":{"__type":"WuLin.SaveObjectBase,Assembly-CSharp","value":{}}}', { mode: 'plain' }) }], 'Meow');
  s.setCurrency(0, 100);
  assert.deepStrictEqual({ broken: Boolean(s.brokenRoles.playerTeam), coin: s.getCurrencies().find((c) => c.id === 0).value }, { broken: false, coin: 100 });
});

test('R11.A1 [R11-A1][R11-C1] canonical role pinning and non-canonical __type validation prevent role hijack and desync', async () => {
  const demoFiles = await Core.createDemoSlotFiles(RawCatalog, 'Meow');
  const globalFile = demoFiles.find(f => f.name === 'SaveObjectGameGlobal.save');
  const ptFile = demoFiles.find(f => f.name === 'SaveObjectPlayerTeam.save');
  const mk = async (files) => { const s = Core.createSession(RawCatalog); await s.loadFiles(files, 'Meow'); return s; };

  for (const badGameJson of ['{"__type":"WuLin.SaveObjectGameGlobal,Assembly-CSharp","Data":null}', '{"Data":{"__type":"WuLin.SaveObjectGameGlobal,Assembly-CSharp","value":null}}', '{"Data":{"value":123}}']) {
    const s = await mk([globalFile, { name: 'SaveObjectGame.save', bytes: await Codec.encodeEs3Bytes(badGameJson, { mode: 'plain' }) }]);
    assert.strictEqual(s.files.game.name, 'SaveObjectGame.save');
    assert.ok(!s.files['global#2']);
    assert.strictEqual(s.brokenRoles.game, true);
    assert.throws(() => s.setFiefBuildingLevel(112, 5));
    assert.strictEqual(s.files.global.dirty, false);
  }

  const badNonCanon = { name: '000-playerteam.save', bytes: await Codec.encodeEs3Bytes('{"Data":{"__type":"WuLin.SaveObjectPlayerTeam,Assembly-CSharp","value":{"__type":"Other.SaveObject,Assembly-CSharp"}}}', { mode: 'plain' }) };
  let s = await mk([badNonCanon]);
  assert.strictEqual(s.brokenRoles.playerTeam, true);
  assert.throws(() => s.setCurrency(0, 100));
  assert.strictEqual(s.files.playerTeam.dirty, false);

  s = await mk([badNonCanon, ptFile]);
  assert.ok(!s.brokenRoles.playerTeam);
  s.setCurrency(0, 100);
  assert.strictEqual(s.getCurrencies()[0].value, 100);
  assert.strictEqual(s.files.playerTeam.name, 'SaveObjectPlayerTeam.save');
  assert.strictEqual(s.files['playerTeam#2'].dirty, false);
});

test('R11.A2 [R11-A2] bounded GZip decompression aborts oversized payloads across sync, async, stream, and session load', async () => {
  const prev = Codec.getMaxDecompressedBytes();
  Codec.setMaxDecompressedBytes(2048);
  try {
    const big = JSON.stringify({ Data: { value: { pad: 'A'.repeat(16384) } } });
    const gz = await Codec.encodeEs3Bytes(big, { mode: 'gzip' });
    const aesGz = await Codec.encodeEs3Bytes(big, { mode: 'aes-gzip', password: 'Meow' });
    const pred = e => e && e.code === 'ES3_DECOMPRESS_LIMIT';
    await assert.rejects(() => Codec.decodeEs3Bytes(gz), pred);
    await assert.rejects(() => Codec.decodeEs3Bytes(aesGz, 'Meow'), pred);
    await assert.rejects(() => Codec.gzipDecompress(gz, { forceStream: true }), pred);
    await assert.rejects(() => Core.createSession(RawCatalog).loadFiles([{ name: 'SaveObjectPlayerTeam.save', bytes: aesGz }], 'Meow'), pred);
    assert.throws(() => Codec.decodeEs3BytesSync(gz), pred);
    assert.throws(() => Codec.decodeEs3BytesSync(aesGz, 'Meow'), pred);
    const ok = '{"Data":{"value":{"ok":1}}}';
    const okAes = await Codec.encodeEs3Bytes(ok, { mode: 'aes-gzip', password: 'Meow' });
    assert.equal((await Codec.decodeEs3Bytes(okAes, 'Meow')).text, ok);
  } finally { Codec.setMaxDecompressedBytes(prev); }
});

test('R11.B1 [R11-B1] browser direct overwrite is blocked fail-closed even with external race after getFile while download works', async () => {
  const demoFiles = await Core.createDemoSlotFiles(RawCatalog, 'Meow');
  const fetch = async () => ({ ok: true, json: async () => ({ status: 'NOT_RUNNING' }) });
  for (const o of [{ location: { protocol: 'http:', hostname: '127.0.0.1' }, fetch }, { location: { protocol: 'file:', hostname: '' } }, { webview2: true }]) assert.equal(createUiHarness(o).els['btn-connect-dir'].hidden, true);
  let pickerCalls = 0;
  const h2 = createUiHarness({ showDirectoryPicker: async () => { pickerCalls++; } });
  await h2.ui.loadDemoSlot(); const s2 = h2.ui.getSession(); s2.setCurrency(0, 55555); await h2.ui.connectDirectoryPicker();
  assert.equal(pickerCalls, 0); assert.equal(h2.ui.getSession(), s2); assert.equal(s2.getCurrencies()[0].value, 55555); assert.match(h2.els['status-bar'].textContent, /\.exe/);
  const dir = makeMockDir(demoFiles); const h3 = createUiHarness({}); const st = await attachPrepopulatedDir(h3, demoFiles, dir);
  let extMutated = false, writableCalls = 0; const extBytes = new Uint8Array([7, 7, 7, 7]);
  const fh = st.fileHandles['SaveObjectPlayerTeam.save']; const origGetFile = fh.getFile.bind(fh);
  fh.getFile = async () => { const f = await origGetFile(); extMutated = true; dir.files['SaveObjectPlayerTeam.save'] = extBytes; return f; };
  for (const x of Object.values(st.fileHandles)) { const ow = x.createWritable.bind(x); x.createWritable = async (...a) => { writableCalls++; return ow(...a); }; }
  const s3 = h3.ui.getSession(); s3.setCurrency(0, 88888); const list = await s3.exportModifiedFiles({ updateTimestamp: false });
  await assert.rejects(() => h3.ui.saveToConnectedDir(list), /\.exe|다운로드/); await h3.ui.exportFilesFlow(false);
  assert.match(h3.els['status-bar'].textContent, /내보내기 실패[\s\S]*\.exe/); assert.equal(extMutated, true); assert.equal(writableCalls, 0);
  assert.deepEqual(dir.files['SaveObjectPlayerTeam.save'], extBytes); assert.equal(h3.global.hasUnsavedChanges(), true);
  const blobs = []; const h4 = createUiHarness({}); h4.global.URL.createObjectURL = b => { blobs.push(b); return 'blob:dl'; };
  await h4.ui.loadDemoSlot(); h4.ui.getSession().setCurrency(0, 42424); await h4.ui.exportFilesFlow(false); assert.equal(blobs.length, 1);
  const s4 = Core.createSession(RawCatalog); await s4.loadFiles([{ name: 'SaveObjectPlayerTeam.save', bytes: new Uint8Array(await blobs[0].arrayBuffer()) }], 'Meow');
  assert.equal(s4.getCurrencies()[0].value, 42424);
});

test('R12.A1 [R12-A1] deterministic protagonist resolution ignores companions and blocks missing-protagonist presets', async () => {
  const cStr = JSON.stringify({ m_templeteUid: 10005, m_TeamMemberState: { isJoined: true, curHp: 500, curEp: 300 }, m_originProps: { '臂力': 8 } });
  const pStr = JSON.stringify({ m_templeteUid: 100401, m_TeamMemberState: { isJoined: false, curHp: 100, curEp: 100 }, m_originProps: { '臂力': 5 } });
  const mkJson = (c) => '{"Data":{"value":{"__type":"WuLin.SaveObjectGameCharacter,Assembly-CSharp","createdCharacter":' + (c ? '{"20001":' + cStr + ',"90001":' + pStr + '}' : '{"90001":' + pStr + ',"20001":' + cStr + '}') + '}}}';
  for (const compFirst of [true, false]) {
    const s = Core.createSession(RawCatalog);
    await s.loadFiles([{ name: 'SaveObjectGameCharacter.save', bytes: await Codec.encodeEs3Bytes(mkJson(compFirst), { mode: 'plain' }) }], 'Meow');
    assert.equal(s.getSummary().protagonist.instanceId, '90001'); assert.equal(s.getCharacterDetail('90001').isProtagonist, true);
    assert.equal(s.listCharacters({ filter: 'all' })[0].instanceId, '90001'); s.applyPreset('hero_core_max');
    assert.equal(s.getCharacterDetail('90001').originProps['臂力'], 25); assert.equal(s.getCharacterDetail('20001').originProps['臂力'], 8);
  }
  const charText = '{"Data":{"value":{"__type":"WuLin.SaveObjectGameCharacter,Assembly-CSharp","createdCharacter":{"20001":' + JSON.stringify({ m_templeteUid: 10005, m_TeamMemberState: { isJoined: true, curHp: 100, curEp: 100 }, m_originProps: {} }) + ',"20002":' + JSON.stringify({ m_templeteUid: 10006, m_TeamMemberState: { isJoined: true, curHp: 100, curEp: 100 }, m_originProps: {} }) + '}}}}';
  const facText = '{"Data":{"value":{"factions":{"1":{"templeteId":1,"playerFame":10,"IsDiscovered":true}}}}}';
  const s2 = Core.createSession(RawCatalog);
  await s2.loadFiles([{ name: 'SaveObjectGameCharacter.save', bytes: await Codec.encodeEs3Bytes(charText, { mode: 'plain' }) }, { name: 'SaveObjectFactions.save', bytes: await Codec.encodeEs3Bytes(facText, { mode: 'plain' }) }], 'Meow');
  assert.equal(s2.getSummary().protagonist, null);
  for (const id of ['hero_core_max', 'hero_virtue_max', 'all_life_skills_max', 'party_kungfu_max', 'diplomacy_max']) { assert.throws(() => s2.applyPreset(id)); assert.equal(s2.files.characters.dirty, false); assert.equal(s2.files.factions.dirty, false); }
  const s3 = await makeLoadedSession();
  Codec.objSet(Codec.objGet(s3._dataValue('game'), 'privateFiefSharedData'), 'value', [], true);
  assert.throws(() => s3.setFiefBuildingLevel(112, 5)); assert.equal(s3.files.global.dirty, false);
});

test('R12.A2 [R12-A2] export and markSaved enforce getMaxDecompressedBytes on gzip and aes-gzip payloads', async () => {
  const prev = Codec.getMaxDecompressedBytes(); Codec.setMaxDecompressedBytes(2048);
  try {
    const text = '{"Data":{"value":{"__type":"WuLin.SaveObjectGameCharacter,Assembly-CSharp","createdCharacter":{"90001":' + JSON.stringify({ m_templeteUid: 100401, m_TeamMemberState: { isJoined: false, curHp: 100, curEp: 100 }, m_originProps: {} }) + '}}}}';
    const s = Core.createSession(RawCatalog);
    await s.loadFiles([{ name: 'SaveObjectGameCharacter.save', bytes: await Codec.encodeEs3Bytes(text, { mode: 'aes-gzip', password: 'Meow' }) }], 'Meow');
    const origBytes = Array.from(s.files.characters.originalBytes);
    s.setCharacterBasic('90001', { overrideTitle: '가'.repeat(900) });
    await assert.rejects(() => s.exportModifiedFiles(), e => e && e.code === 'ES3_DECOMPRESS_LIMIT');
    await assert.rejects(() => s.exportAllFiles(), e => e && e.code === 'ES3_DECOMPRESS_LIMIT');
    assert.throws(() => s.markSaved([{ loadToken: s._loadToken, key: 'characters', text: s.getRawFileText('characters'), mode: 'aes-gzip' }]), e => e && e.code === 'ES3_DECOMPRESS_LIMIT');
    assert.throws(() => s.markSaved([{ loadToken: s._loadToken, key: 'characters' }]), e => e && e.code === 'ES3_DECOMPRESS_LIMIT');
    assert.equal(s.files.characters.dirty, true); assert.deepEqual(Array.from(s.files.characters.originalBytes), origBytes);
  } finally { Codec.setMaxDecompressedBytes(prev); }
});

async function runAll() {
  let passed = 0, failed = 0;
  for (const t of tests) {
    try {
      await (typeof t === 'function' ? t() : (t.fn || t.test || t.run)());
      passed++;
      console.log(`[PASS] ${t.name}`);
    } catch (err) {
      failed++;
      console.log(`[FAIL] ${t.name}: ${err.message}`);
    }
  }
  console.log(`Passed ${passed}/${tests.length}`);
  if (failed > 0) process.exit(1);
}
runAll();
