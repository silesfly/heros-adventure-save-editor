// FILE: src/es3-codec.js
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.HerosAdventureEs3Codec = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // ============================================================
  // Byte utilities
  // ============================================================
  function toU8(v) {
    if (v instanceof Uint8Array) return v;
    if (v instanceof ArrayBuffer) return new Uint8Array(v);
    if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
    if (Array.isArray(v)) return new Uint8Array(v);
    throw new TypeError('Expected Uint8Array/ArrayBuffer/Array');
  }
  function concatU8(a, b) {
    var out = new Uint8Array(a.length + b.length);
    out.set(a, 0);
    out.set(b, a.length);
    return out;
  }
  function utf8Encode(str) {
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(str);
    // Fallback: manual UTF-8
    var out = [];
    for (var i = 0; i < str.length; i++) {
      var c = str.charCodeAt(i);
      if (c < 0x80) out.push(c);
      else if (c < 0x800) { out.push(0xC0 | (c >> 6), 0x80 | (c & 0x3F)); }
      else if (c >= 0xD800 && c <= 0xDBFF) {
        if (i + 1 < str.length) {
          var c2 = str.charCodeAt(i + 1);
          if (c2 >= 0xDC00 && c2 <= 0xDFFF) {
            var cp = 0x10000 + ((c - 0xD800) << 10) + (c2 - 0xDC00);
            out.push(0xF0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3F), 0x80 | ((cp >> 6) & 0x3F), 0x80 | (cp & 0x3F));
            i++;
            continue;
          }
        }
        out.push(0xEF, 0xBF, 0xBD);
      } else if (c >= 0xDC00 && c <= 0xDFFF) out.push(0xEF, 0xBF, 0xBD);
      else out.push(0xE0 | (c >> 12), 0x80 | ((c >> 6) & 0x3F), 0x80 | (c & 0x3F));
    }
    return new Uint8Array(out);
  }
  function utf8Decode(bytes) {
    bytes = toU8(bytes);
    if (typeof TextDecoder !== 'undefined') {
      try {
        return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
      } catch (e) {
        throw new Error('Invalid UTF-8 byte sequence');
      }
    }
    var s = '';
    for (var i = 0; i < bytes.length; i++) {
      var b0 = bytes[i];
      if (b0 < 0x80) {
        s += String.fromCharCode(b0);
        continue;
      }
      if (b0 >= 0x80 && b0 <= 0xC1) throw new Error('Invalid UTF-8 byte sequence');
      if (b0 >= 0xF5) throw new Error('Invalid UTF-8 byte sequence');
      if (b0 >= 0xC2 && b0 <= 0xDF) {
        if (i + 1 >= bytes.length) throw new Error('Invalid UTF-8 byte sequence');
        var b1 = bytes[++i];
        if ((b1 & 0xC0) !== 0x80) throw new Error('Invalid UTF-8 byte sequence');
        s += String.fromCharCode(((b0 & 0x1F) << 6) | (b1 & 0x3F));
        continue;
      }
      if (b0 >= 0xE0 && b0 <= 0xEF) {
        if (i + 2 >= bytes.length) throw new Error('Invalid UTF-8 byte sequence');
        var c1 = bytes[++i];
        var c2 = bytes[++i];
        if ((c1 & 0xC0) !== 0x80 || (c2 & 0xC0) !== 0x80) {
          throw new Error('Invalid UTF-8 byte sequence');
        }
        if (b0 === 0xE0 && c1 < 0xA0) throw new Error('Invalid UTF-8 byte sequence');
        if (b0 === 0xED && c1 >= 0xA0) throw new Error('Invalid UTF-8 byte sequence');
        s += String.fromCharCode(((b0 & 0x0F) << 12) | ((c1 & 0x3F) << 6) | (c2 & 0x3F));
        continue;
      }
      if (b0 >= 0xF0 && b0 <= 0xF4) {
        if (i + 3 >= bytes.length) throw new Error('Invalid UTF-8 byte sequence');
        var d1 = bytes[++i];
        var d2 = bytes[++i];
        var d3 = bytes[++i];
        if ((d1 & 0xC0) !== 0x80 || (d2 & 0xC0) !== 0x80 || (d3 & 0xC0) !== 0x80) {
          throw new Error('Invalid UTF-8 byte sequence');
        }
        if (b0 === 0xF0 && d1 < 0x90) throw new Error('Invalid UTF-8 byte sequence');
        if (b0 === 0xF4 && d1 > 0x8F) throw new Error('Invalid UTF-8 byte sequence');
        var cp = ((b0 & 0x07) << 18) | ((d1 & 0x3F) << 12) | ((d2 & 0x3F) << 6) | (d3 & 0x3F);
        if (cp > 0x10FFFF) throw new Error('Invalid UTF-8 byte sequence');
        cp -= 0x10000;
        s += String.fromCharCode(0xD800 + (cp >> 10), 0xDC00 + (cp & 0x3FF));
        continue;
      }
      throw new Error('Invalid UTF-8 byte sequence');
    }
    return s;
  }

  // ============================================================
  // SHA-1
  // ============================================================
  function sha1(input) {
    var bytes = toU8(input);
    var ml = bytes.length;
    const blockCount = ((ml + 8) >>> 6) + 1;
    const wordCount = blockCount << 4;
    const totalLen = wordCount << 2;
    var buf = new Uint8Array(totalLen);
    buf.set(bytes);
    buf[ml] = 0x80;
    var dv = new DataView(buf.buffer);
    var bitLen = ml * 8;
    var hi = Math.floor(bitLen / 0x100000000);
    var lo = bitLen >>> 0;
    dv.setUint32(totalLen - 8, hi, false);
    dv.setUint32(totalLen - 4, lo, false);

    var h0 = 0x67452301, h1 = 0xEFCDAB89, h2 = 0x98BADCFE, h3 = 0x10325476, h4 = 0xC3D2E1F0;
    var w = new Uint32Array(80);
    for (var i = 0; i < totalLen; i += 64) {
      var j;
      for (j = 0; j < 16; j++) {
        w[j] = (buf[i + j * 4] << 24) | (buf[i + j * 4 + 1] << 16) | (buf[i + j * 4 + 2] << 8) | buf[i + j * 4 + 3];
      }
      for (j = 16; j < 80; j++) {
        var x = w[j - 3] ^ w[j - 8] ^ w[j - 14] ^ w[j - 16];
        w[j] = ((x << 1) | (x >>> 31)) >>> 0;
      }
      var a = h0, b = h1, c = h2, d = h3, e = h4;
      for (j = 0; j < 80; j++) {
        var f, k;
        if (j < 20) { f = (b & c) | ((~b) & d); k = 0x5A827999; }
        else if (j < 40) { f = b ^ c ^ d; k = 0x6ED9EBA1; }
        else if (j < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8F1BBCDC; }
        else { f = b ^ c ^ d; k = 0xCA62C1D6; }
        var temp = ((((a << 5) | (a >>> 27)) >>> 0) + (f >>> 0) + e + k + w[j]) >>> 0;
        e = d; d = c; c = ((b << 30) | (b >>> 2)) >>> 0; b = a; a = temp;
      }
      h0 = (h0 + a) >>> 0;
      h1 = (h1 + b) >>> 0;
      h2 = (h2 + c) >>> 0;
      h3 = (h3 + d) >>> 0;
      h4 = (h4 + e) >>> 0;
    }
    var out = new Uint8Array(20);
    var odv = new DataView(out.buffer);
    odv.setUint32(0, h0, false);
    odv.setUint32(4, h1, false);
    odv.setUint32(8, h2, false);
    odv.setUint32(12, h3, false);
    odv.setUint32(16, h4, false);
    return out;
  }

  // ============================================================
  // HMAC-SHA1
  // ============================================================
  function hmacSha1(keyBytes, msgBytes) {
    var key = toU8(keyBytes);
    var msg = toU8(msgBytes);
    var blockSize = 64;
    if (key.length > blockSize) key = sha1(key);
    var padded = new Uint8Array(blockSize);
    padded.set(key);
    var oKeyPad = new Uint8Array(blockSize);
    var iKeyPad = new Uint8Array(blockSize);
    for (var i = 0; i < blockSize; i++) {
      oKeyPad[i] = padded[i] ^ 0x5C;
      iKeyPad[i] = padded[i] ^ 0x36;
    }
    var inner = new Uint8Array(blockSize + msg.length);
    inner.set(iKeyPad, 0);
    inner.set(msg, blockSize);
    var innerHash = sha1(inner);
    var outer = new Uint8Array(blockSize + innerHash.length);
    outer.set(oKeyPad, 0);
    outer.set(innerHash, blockSize);
    return sha1(outer);
  }

  // ============================================================
  // PBKDF2-HMAC-SHA1
  // ============================================================
  function pbkdf2HmacSha1(passwordBytes, saltBytes, iterations, dkLen) {
    var pw = toU8(passwordBytes);
    var salt = toU8(saltBytes);
    var hLen = 20;
    var blocks = Math.ceil(dkLen / hLen);
    var out = new Uint8Array(blocks * hLen);
    for (var bi = 1; bi <= blocks; bi++) {
      var msg = new Uint8Array(salt.length + 4);
      msg.set(salt, 0);
      msg[salt.length] = (bi >>> 24) & 0xFF;
      msg[salt.length + 1] = (bi >>> 16) & 0xFF;
      msg[salt.length + 2] = (bi >>> 8) & 0xFF;
      msg[salt.length + 3] = bi & 0xFF;
      var u = hmacSha1(pw, msg);
      var t = new Uint8Array(u);
      for (var it = 1; it < iterations; it++) {
        u = hmacSha1(pw, u);
        for (var k = 0; k < hLen; k++) t[k] ^= u[k];
      }
      out.set(t, (bi - 1) * hLen);
    }
    return out.slice(0, dkLen);
  }

  // ============================================================
  // AES-128 (encrypt + decrypt), CBC mode
  // ============================================================
  var SBOX = new Uint8Array(256);
  var INV_SBOX = new Uint8Array(256);
  (function buildSBox() {
    // Generate S-box via multiplicative inverse in GF(2^8) + affine transformation
    var p = 1, q = 1;
    // Standard way: use known generation
    var sbox = [
      0x63,0x7c,0x77,0x7b,0xf2,0x6b,0x6f,0xc5,0x30,0x01,0x67,0x2b,0xfe,0xd7,0xab,0x76,
      0xca,0x82,0xc9,0x7d,0xfa,0x59,0x47,0xf0,0xad,0xd4,0xa2,0xaf,0x9c,0xa4,0x72,0xc0,
      0xb7,0xfd,0x93,0x26,0x36,0x3f,0xf7,0xcc,0x34,0xa5,0xe5,0xf1,0x71,0xd8,0x31,0x15,
      0x04,0xc7,0x23,0xc3,0x18,0x96,0x05,0x9a,0x07,0x12,0x80,0xe2,0xeb,0x27,0xb2,0x75,
      0x09,0x83,0x2c,0x1a,0x1b,0x6e,0x5a,0xa0,0x52,0x3b,0xd6,0xb3,0x29,0xe3,0x2f,0x84,
      0x53,0xd1,0x00,0xed,0x20,0xfc,0xb1,0x5b,0x6a,0xcb,0xbe,0x39,0x4a,0x4c,0x58,0xcf,
      0xd0,0xef,0xaa,0xfb,0x43,0x4d,0x33,0x85,0x45,0xf9,0x02,0x7f,0x50,0x3c,0x9f,0xa8,
      0x51,0xa3,0x40,0x8f,0x92,0x9d,0x38,0xf5,0xbc,0xb6,0xda,0x21,0x10,0xff,0xf3,0xd2,
      0xcd,0x0c,0x13,0xec,0x5f,0x97,0x44,0x17,0xc4,0xa7,0x7e,0x3d,0x64,0x5d,0x19,0x73,
      0x60,0x81,0x4f,0xdc,0x22,0x2a,0x90,0x88,0x46,0xee,0xb8,0x14,0xde,0x5e,0x0b,0xdb,
      0xe0,0x32,0x3a,0x0a,0x49,0x06,0x24,0x5c,0xc2,0xd3,0xac,0x62,0x91,0x95,0xe4,0x79,
      0xe7,0xc8,0x37,0x6d,0x8d,0xd5,0x4e,0xa9,0x6c,0x56,0xf4,0xea,0x65,0x7a,0xae,0x08,
      0xba,0x78,0x25,0x2e,0x1c,0xa6,0xb4,0xc6,0xe8,0xdd,0x74,0x1f,0x4b,0xbd,0x8b,0x8a,
      0x70,0x3e,0xb5,0x66,0x48,0x03,0xf6,0x0e,0x61,0x35,0x57,0xb9,0x86,0xc1,0x1d,0x9e,
      0xe1,0xf8,0x98,0x11,0x69,0xd9,0x8e,0x94,0x9b,0x1e,0x87,0xe9,0xce,0x55,0x28,0xdf,
      0x8c,0xa1,0x89,0x0d,0xbf,0xe6,0x42,0x68,0x41,0x99,0x2d,0x0f,0xb0,0x54,0xbb,0x16
    ];
    for (var i = 0; i < 256; i++) SBOX[i] = sbox[i];
    for (var i2 = 0; i2 < 256; i2++) INV_SBOX[SBOX[i2]] = i2;
  })();

  function xtime(a) {
    a <<= 1;
    if (a & 0x100) a ^= 0x11b;
    return a & 0xFF;
  }
  function gmul(a, b) {
    var p = 0;
    while (b) {
      if (b & 1) p ^= a;
      a = xtime(a);
      b >>>= 1;
    }
    return p & 0xFF;
  }

  function aesExpandKey(key) {
    // key: Uint8Array(16) -> Uint8Array(176)
    var w = new Uint8Array(176);
    for (var i = 0; i < 16; i++) w[i] = key[i];
    var rcon = 1;
    for (var i = 16; i < 176; i += 4) {
      var t0 = w[i - 4], t1 = w[i - 3], t2 = w[i - 2], t3 = w[i - 1];
      if (i % 16 === 0) {
        var tmp = t0;
        t0 = SBOX[t1] ^ rcon;
        t1 = SBOX[t2];
        t2 = SBOX[t3];
        t3 = SBOX[tmp];
        rcon = xtime(rcon);
      }
      w[i] = w[i - 16] ^ t0;
      w[i + 1] = w[i - 15] ^ t1;
      w[i + 2] = w[i - 14] ^ t2;
      w[i + 3] = w[i - 13] ^ t3;
    }
    return w;
  }

  function aesEncryptBlock(roundKeys, block) {
    // block: Uint8Array(16), returns Uint8Array(16)
    var state = new Uint8Array(16);
    var i;
    for (i = 0; i < 16; i++) state[i] = block[i] ^ roundKeys[i];
    for (var round = 1; round <= 10; round++) {
      // SubBytes + ShiftRows
      var s = new Uint8Array(16);
      // AES state is column-major: state[0..3]=col0, etc.
      // Row 0: indices 0,4,8,12; Row 1: 1,5,9,13; Row 2: 2,6,10,14; Row 3: 3,7,11,15
      for (var c = 0; c < 4; c++) {
        for (var r = 0; r < 4; r++) {
          s[c * 4 + r] = SBOX[state[((c + r) % 4) * 4 + r]];
        }
      }
      // MixColumns (skip on round 10)
      if (round !== 10) {
        for (var col = 0; col < 4; col++) {
          var a0 = s[col * 4], a1 = s[col * 4 + 1], a2 = s[col * 4 + 2], a3 = s[col * 4 + 3];
          s[col * 4] = gmul(a0, 2) ^ gmul(a1, 3) ^ a2 ^ a3;
          s[col * 4 + 1] = a0 ^ gmul(a1, 2) ^ gmul(a2, 3) ^ a3;
          s[col * 4 + 2] = a0 ^ a1 ^ gmul(a2, 2) ^ gmul(a3, 3);
          s[col * 4 + 3] = gmul(a0, 3) ^ a1 ^ a2 ^ gmul(a3, 2);
        }
      }
      // AddRoundKey
      for (i = 0; i < 16; i++) state[i] = s[i] ^ roundKeys[round * 16 + i];
    }
    return state;
  }

  function aesDecryptBlock(roundKeys, block) {
    var state = new Uint8Array(16);
    for (var i = 0; i < 16; i++) state[i] = block[i] ^ roundKeys[160 + i];
    for (var round = 9; round >= 0; round--) {
      // InvShiftRows + InvSubBytes
      var s = new Uint8Array(16);
      for (var c = 0; c < 4; c++) {
        for (var r = 0; r < 4; r++) {
          s[((c + r) % 4) * 4 + r] = INV_SBOX[state[c * 4 + r]];
        }
      }
      // AddRoundKey
      for (var i2 = 0; i2 < 16; i2++) s[i2] ^= roundKeys[round * 16 + i2];
      // InvMixColumns
      if (round !== 0) {
        var t = new Uint8Array(16);
        for (var col = 0; col < 4; col++) {
          var a0 = s[col * 4], a1 = s[col * 4 + 1], a2 = s[col * 4 + 2], a3 = s[col * 4 + 3];
          t[col * 4] = gmul(a0, 14) ^ gmul(a1, 11) ^ gmul(a2, 13) ^ gmul(a3, 9);
          t[col * 4 + 1] = gmul(a0, 9) ^ gmul(a1, 14) ^ gmul(a2, 11) ^ gmul(a3, 13);
          t[col * 4 + 2] = gmul(a0, 13) ^ gmul(a1, 9) ^ gmul(a2, 14) ^ gmul(a3, 11);
          t[col * 4 + 3] = gmul(a0, 11) ^ gmul(a1, 13) ^ gmul(a2, 9) ^ gmul(a3, 14);
        }
        state = t;
      } else {
        state = s;
      }
    }
    return state;
  }

  function aesCbcEncrypt(plaintext, keyBytes, ivBytes) {
    var key = toU8(keyBytes);
    var iv = toU8(ivBytes);
    var pt = toU8(plaintext);
    if (key.length !== 16) throw new Error('AES-128 key must be 16 bytes');
    if (iv.length !== 16) throw new Error('IV must be 16 bytes');
    // PKCS#7 pad
    var padLen = 16 - (pt.length % 16);
    if (padLen === 0) padLen = 16;
    var padded = new Uint8Array(pt.length + padLen);
    padded.set(pt);
    for (var i = 0; i < padLen; i++) padded[pt.length + i] = padLen;
    var roundKeys = aesExpandKey(key);
    var out = new Uint8Array(padded.length);
    var prev = iv;
    for (var off = 0; off < padded.length; off += 16) {
      var blk = new Uint8Array(16);
      for (var j = 0; j < 16; j++) blk[j] = padded[off + j] ^ prev[j];
      var enc = aesEncryptBlock(roundKeys, blk);
      out.set(enc, off);
      prev = enc;
    }
    return out;
  }

  function aesCbcDecrypt(ciphertext, keyBytes, ivBytes) {
    var key = toU8(keyBytes);
    var iv = toU8(ivBytes);
    var ct = toU8(ciphertext);
    if (key.length !== 16) throw new Error('AES-128 key must be 16 bytes');
    if (iv.length !== 16) throw new Error('IV must be 16 bytes');
    if (ct.length === 0 || ct.length % 16 !== 0) throw new Error('Ciphertext length must be a non-zero multiple of 16');
    var roundKeys = aesExpandKey(key);
    var out = new Uint8Array(ct.length);
    var prev = iv;
    for (var off = 0; off < ct.length; off += 16) {
      var blk = ct.subarray(off, off + 16);
      var dec = aesDecryptBlock(roundKeys, blk);
      for (var j = 0; j < 16; j++) out[off + j] = dec[j] ^ prev[j];
      prev = blk;
    }
    // Validate PKCS#7
    var pad = out[out.length - 1];
    if (pad < 1 || pad > 16) throw new Error('invalid PKCS#7 padding');
    for (var k = 1; k <= pad; k++) {
      if (out[out.length - k] !== pad) throw new Error('invalid PKCS#7 padding');
    }
    return out.slice(0, out.length - pad);
  }

  // ============================================================
  // GZip via Node zlib or browser CompressionStream
  // ============================================================
  var MAX_DECOMPRESSED_BYTES = 64 * 1024 * 1024;
  var maxDecompressedBytes = MAX_DECOMPRESSED_BYTES;
  function getMaxDecompressedBytes() { return maxDecompressedBytes; }
  function setMaxDecompressedBytes(limit) { if (typeof limit !== 'number' || !isFinite(limit) || limit < 1 || Math.floor(limit) !== limit) throw new RangeError('유효하지 않은 압축 해제 한도입니다.'); maxDecompressedBytes = limit; return maxDecompressedBytes; }
  function makeDecompressLimitError(limit) { var err = new Error('세이브 압축 해제 크기가 허용 한도(' + limit + ' 바이트)를 초과했습니다.'); err.code = 'ES3_DECOMPRESS_LIMIT'; return err; }
  function isNode() { return typeof process !== 'undefined' && process.versions && process.versions.node; }
  function nodeZlib() { return require('zlib'); }
  async function gzipCompress(bytes) {
    if (isNode()) return new Uint8Array(nodeZlib().gzipSync(Buffer.from(bytes)));
    if (typeof CompressionStream === 'undefined') throw new Error('CompressionStream unavailable');
    var ab = await new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer();
    return new Uint8Array(ab);
  }
  function gunzipSyncU8(b, maxBytes) {
    var limit = (typeof maxBytes === 'number' && maxBytes > 0) ? maxBytes : maxDecompressedBytes;
    try {
      var out = new Uint8Array(nodeZlib().gunzipSync(Buffer.from(b), { maxOutputLength: limit }));
      if (out.byteLength > limit) throw makeDecompressLimitError(limit);
      return out;
    } catch (e) {
      if (e && (e.code === 'ERR_BUFFER_TOO_LARGE' || e instanceof RangeError)) throw makeDecompressLimitError(limit);
      throw e;
    }
  }
  async function gzipDecompress(bytes, opts) {
    var limit = (opts && opts.maxBytes > 0) ? opts.maxBytes : maxDecompressedBytes;
    if (isNode() && !(opts && opts.forceStream)) return gunzipSyncU8(bytes, limit);
    if (typeof DecompressionStream === 'undefined') throw new Error('DecompressionStream unavailable');
    var stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    var reader = stream.getReader(), chunks = [], total = 0;
    for (;;) {
      var r = await reader.read();
      if (r.done) break;
      var chunk = new Uint8Array(r.value);
      total += chunk.byteLength;
      if (total > limit) {
        try { await reader.cancel(); } catch (_) {}
        throw makeDecompressLimitError(limit);
      }
      chunks.push(chunk);
    }
    var out = new Uint8Array(total), off = 0;
    for (var i = 0; i < chunks.length; i++) { out.set(chunks[i], off); off += chunks[i].byteLength; }
    return out;
  }

  function randomBytes16() {
    var out = new Uint8Array(16);
    if (typeof globalThis !== 'undefined' && globalThis.crypto && globalThis.crypto.getRandomValues) {
      globalThis.crypto.getRandomValues(out);
    } else if (isNode()) {
      var c = require('crypto');
      var rb = c.randomBytes(16);
      out.set(rb);
    } else {
      for (var i = 0; i < 16; i++) out[i] = Math.floor(Math.random() * 256);
    }
    return out;
  }

  // ============================================================
  // ES3 Extended JSON AST
  // ============================================================
  function isEs3Object(v) {
    return !!(v && typeof v === 'object' && v.__es3Object === true && Array.isArray(v.entries));
  }
  function isEs3Number(v) {
    return !!(v && typeof v === 'object' && v.__es3Number === true && typeof v.raw === 'string');
  }

  var NUM_RE = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/;
  // More permissive ES3 numeric: allow leading integers like 000 as well
  var NUM_RE_LOOSE = /^-?[0-9]+(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/;

  function isNumStart(ch) {
    return ch === '-' || (ch >= '0' && ch <= '9');
  }
  function isIdStart(ch) {
    // ES3 emits unquoted integer keys and potentially identifier-like keys
    if (ch >= '0' && ch <= '9') return true;
    if (ch === '-') return true;
    if ((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch === '_' || ch === '$') return true;
    return false;
  }
  function isIdPart(ch) {
    return isIdStart(ch) || (ch >= '0' && ch <= '9') || ch === '.';
  }
  function isWhitespace(ch) {
    return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';
  }

  function parseEs3Json(text) {
    if (typeof text !== 'string') throw new TypeError('parseEs3Json expects a string');
    var pos = 0;
    var len = text.length;

    function skipWs() {
      while (pos < len && isWhitespace(text.charAt(pos))) {
        pos++;
      }
    }
    function peek() { return text[pos]; }
    function error(msg) {
      throw new SyntaxError('ES3 JSON parse error at position ' + pos + ': ' + msg);
    }

    function parseValue() {
      skipWs();
      if (pos >= len) error('unexpected end of input');
      var ch = text[pos];
      if (ch === '{') return parseObject();
      if (ch === '[') return parseArray();
      if (ch === '"') return parseString();
      if (ch === 't' || ch === 'f' || ch === 'n') return parseLiteral();
      if (isNumStart(ch)) return parseNumber();
      error('unexpected token');
    }

    function parseLiteral() {
      if (text.substr(pos, 4) === 'true') { pos += 4; return true; }
      if (text.substr(pos, 5) === 'false') { pos += 5; return false; }
      if (text.substr(pos, 4) === 'null') { pos += 4; return null; }
      error('invalid literal');
    }

    function parseNumber() {
      var start = pos;
      while (pos < len) {
        var c = text[pos];
        if ((c >= '0' && c <= '9') || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
            c === '_' || c === '.' || c === '+' || c === '-') {
          pos++;
        } else break;
      }
      var raw = text.slice(start, pos);
      if (!raw || !/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(raw)) {
        error('invalid number: ' + raw);
      }
      return { __es3Number: true, raw: raw };
    }

    function parseString() {
      // assumes current char is '"'
      pos++; // consume opening quote
      var result = '';
      while (pos < len) {
        var c = text[pos++];
        if (c === '"') return result;
        if (c === '\\') {
          if (pos >= len) error('unterminated escape');
          var e = text[pos++];
          switch (e) {
            case '"': result += '"'; break;
            case '\\': result += '\\'; break;
            case '/': result += '/'; break;
            case 'b': result += '\b'; break;
            case 'f': result += '\f'; break;
            case 'n': result += '\n'; break;
            case 'r': result += '\r'; break;
            case 't': result += '\t'; break;
            case 'u': {
              var hex = text.substr(pos, 4);
              if (!/^[0-9A-Fa-f]{4}$/.test(hex)) error('invalid unicode escape');
              result += String.fromCharCode(parseInt(hex, 16));
              pos += 4;
              break;
            }
            default: error('invalid escape: \\' + e);
          }
        } else {
          if (c.charCodeAt(0) < 0x20) error('unescaped control character in string');
          result += c;
        }
      }
      error('unterminated string');
    }

    function parseObject() {
      pos++; // {
      var entries = [];
      var index = new Map();
      skipWs();
      if (text[pos] === '}') { pos++; return { __es3Object: true, entries: entries, index: index }; }
      while (true) {
        if (pos >= len) error('unexpected end of input');
        skipWs();
        var ch = text[pos];
        var key, quoted;
        if (ch === '"') { key = parseString(); quoted = true; }
        else {
          var start = pos;
          while (pos < len) {
            var cc = text[pos];
            if (cc === ':' || cc === ',' || cc === '}' || cc === ']' || cc === '[' ||
                cc === '{' || cc === '"' || isWhitespace(cc)) break;
            pos++;
          }
          key = text.slice(start, pos);
          if (!key) error('empty object key');
          if (!/^(?:-?(?:0|[1-9]\d*)|[A-Za-z_$][A-Za-z0-9_$]*)$/.test(key)) {
            error('invalid object key: ' + key);
          }
          quoted = false;
        }
        skipWs();
        if (text[pos] !== ':') error('expected ":"');
        pos++;
        var value = parseValue();
        var entry = { key: key, quoted: quoted, value: value };
        entries.push(entry);
        index.set(key, entry);
        skipWs();
        if (text[pos] === ',') {
          pos++;
          skipWs();
          if (text[pos] === '}') { pos++; break; }
          if (pos >= len) error('unexpected end of input');
          continue;
        }
        if (text[pos] === '}') { pos++; break; }
        error('expected "," or "}"');
      }
      return { __es3Object: true, entries: entries, index: index };
    }

    function parseArray() {
      pos++; // [
      var arr = [];
      skipWs();
      if (text[pos] === ']') { pos++; return arr; }
      while (true) {
        if (pos >= len) error('unexpected end of input');
        var v = parseValue();
        arr.push(v);
        skipWs();
        if (text[pos] === ',') {
          pos++;
          skipWs();
          if (text[pos] === ']') { pos++; break; }
          if (pos >= len) error('unexpected end of input');
          continue;
        }
        if (text[pos] === ']') { pos++; break; }
        error('expected "," or "]"');
      }
      return arr;
    }

    var result = parseValue();
    skipWs();
    if (pos < len) error('trailing content');
    return result;
  }

  function serializeString(s) {
    var out = '"';
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      if (c >= 0xD800 && c <= 0xDBFF) {
        var c2 = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
        if (c2 >= 0xDC00 && c2 <= 0xDFFF) {
          out += s[i] + s[i + 1];
          i++;
          continue;
        }
      }
      switch (c) {
        case 0x22: out += '\\"'; break;
        case 0x5C: out += '\\\\'; break;
        case 0x08: out += '\\b'; break;
        case 0x0C: out += '\\f'; break;
        case 0x0A: out += '\\n'; break;
        case 0x0D: out += '\\r'; break;
        case 0x09: out += '\\t'; break;
        default:
          if (c < 0x20 || (c >= 0xD800 && c <= 0xDFFF)) {
            var h = c.toString(16);
            while (h.length < 4) h = '0' + h;
            out += '\\u' + h;
          } else {
            out += s[i];
          }
      }
    }
    return out + '"';
  }

  function stringifyEs3Json(node) {
    if (node === null) return 'null';
    if (node === true) return 'true';
    if (node === false) return 'false';
    if (typeof node === 'string') return serializeString(node);
    if (typeof node === 'number') return String(node);
    if (isEs3Number(node)) return node.raw;
    if (Array.isArray(node)) {
      var parts = [];
      for (var i = 0; i < node.length; i++) parts.push(stringifyEs3Json(node[i]));
      return '[' + parts.join(',') + ']';
    }
    if (isEs3Object(node)) {
      var buf = '{';
      for (var j = 0; j < node.entries.length; j++) {
        if (j > 0) buf += ',';
        var e = node.entries[j];
        if (e.quoted) buf += serializeString(e.key);
        else buf += String(e.key);
        buf += ':';
        buf += stringifyEs3Json(e.value);
      }
      return buf + '}';
    }
    // Fallback
    throw new TypeError('stringifyEs3Json: unsupported node at top level');
  }

  // ============================================================
  // AST helpers
  // ============================================================
  function makeObj(entriesArray) {
    var entries = [];
    var index = new Map();
    if (entriesArray) {
      for (var i = 0; i < entriesArray.length; i++) {
        var it = entriesArray[i];
        var key = String(it[0]);
        var value = it[1];
        var quoted = it.length > 2 ? !!it[2] : true;
        var entry = { key: key, quoted: quoted, value: value };
        entries.push(entry);
        index.set(key, entry);
      }
    }
    return { __es3Object: true, entries: entries, index: index };
  }
  function makeNum(numOrRawString) {
    if (typeof numOrRawString === 'object' && numOrRawString && numOrRawString.__es3Number) {
      return { __es3Number: true, raw: String(numOrRawString.raw) };
    }
    if (typeof numOrRawString === 'string') {
      return { __es3Number: true, raw: numOrRawString };
    }
    if (typeof numOrRawString !== 'number' || !isFinite(numOrRawString)) {
      throw new TypeError('makeNum expects a number or numeric string');
    }
    return { __es3Number: true, raw: String(numOrRawString) };
  }
  function numToFloat(v, fallback) {
    if (fallback === undefined) fallback = 0;
    if (isEs3Number(v)) {
      var f = parseFloat(v.raw);
      return isFinite(f) ? f : fallback;
    }
    if (typeof v === 'number') return isFinite(v) ? v : fallback;
    if (typeof v === 'string') {
      var f2 = parseFloat(v);
      return isFinite(f2) ? f2 : fallback;
    }
    return fallback;
  }
  function numToIntString(v) {
    if (isEs3Number(v)) {
      var raw = v.raw;
      // For integer-looking raw, return directly; otherwise truncate via BigInt when possible
      if (/^-?[0-9]+$/.test(raw)) return raw;
      // Try parse to Number and trunc
      var f = parseFloat(raw);
      if (!isFinite(f)) return '0';
      return String(Math.trunc(f));
    }
    if (typeof v === 'number') {
      if (!isFinite(v)) return '0';
      return String(Math.trunc(v));
    }
    if (typeof v === 'string') {
      if (/^-?[0-9]+$/.test(v)) return v;
      var f2 = parseFloat(v);
      if (!isFinite(f2)) return '0';
      return String(Math.trunc(f2));
    }
    return '0';
  }
  function objGet(obj, key) {
    if (!isEs3Object(obj)) return undefined;
    var e = obj.index.get(String(key));
    return e ? e.value : undefined;
  }
  function objHas(obj, key) {
    if (!isEs3Object(obj)) return false;
    return obj.index.has(String(key));
  }
  function objSet(obj, key, value, quoted) {
    if (!isEs3Object(obj)) throw new TypeError('objSet requires an ES3 object');
    var ks = String(key);
    var existing = obj.index.get(ks);
    if (existing) {
      existing.value = value;
      if (quoted !== undefined) existing.quoted = !!quoted;
      return existing.value;
    }
    var q = quoted === undefined ? true : !!quoted;
    var entry = { key: ks, quoted: q, value: value };
    obj.entries.push(entry);
    obj.index.set(ks, entry);
    return value;
  }
  function objDelete(obj, key) {
    if (!isEs3Object(obj)) return false;
    var ks = String(key);
    var e = obj.index.get(ks);
    if (!e) return false;
    obj.index.delete(ks);
    var idx = obj.entries.indexOf(e);
    if (idx >= 0) obj.entries.splice(idx, 1);
    return true;
  }
  function objEntries(obj) {
    if (!isEs3Object(obj)) return [];
    return obj.entries.map(function (e) { return [e.key, e.value, e.quoted]; });
  }

  function es3ToPlainJs(node) {
    if (node === null || node === true || node === false) return node;
    if (typeof node === 'string') return node;
    if (isEs3Number(node)) {
      var f = parseFloat(node.raw);
      // Preserve precision via string fallback for very large ints
      if (/^-?[0-9]+$/.test(node.raw) && String(f) !== node.raw) return node.raw;
      return f;
    }
    if (Array.isArray(node)) return node.map(es3ToPlainJs);
    if (isEs3Object(node)) {
      var o = {};
      for (var i = 0; i < node.entries.length; i++) {
        var e = node.entries[i];
        o[e.key] = es3ToPlainJs(e.value);
      }
      return o;
    }
    return node;
  }

  function plainJsToEs3(val) {
    if (val === null || val === true || val === false) return val;
    if (typeof val === 'string') return val;
    if (typeof val === 'number') return makeNum(val);
    if (Array.isArray(val)) return val.map(plainJsToEs3);
    if (val && typeof val === 'object') {
      var entriesArr = [];
      var keys = Object.keys(val);
      for (var i = 0; i < keys.length; i++) {
        entriesArr.push([keys[i], plainJsToEs3(val[keys[i]]), true]);
      }
      return makeObj(entriesArr);
    }
    return null;
  }

  // ============================================================
  // Container encode/decode
  // ============================================================
  function startsWith(bytes, prefix) {
    if (bytes.length < prefix.length) return false;
    for (var i = 0; i < prefix.length; i++) if (bytes[i] !== prefix[i]) return false;
    return true;
  }
  function isPlainTextStart(bytes) {
    if (bytes.length === 0) return false;
    var i = 0;
    if (bytes.length >= 3 && bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) i = 3;
    while (i < bytes.length) {
      var b = bytes[i];
      if (b === 0x20 || b === 0x09 || b === 0x0A || b === 0x0D) { i++; continue; }
      return b === 0x7B;
    }
    return false;
  }
  function stripBomText(s) {
    if (s.length > 0 && s.charCodeAt(0) === 0xFEFF) {
      return { text: s.slice(1), hasBom: true };
    }
    return { text: s, hasBom: false };
  }
  function canBeAes(bytes) {
    return bytes.length >= 32 && bytes.length % 16 === 0;
  }
  function decodeVerifiedText(textBytes, origBytes, mode, checkJson) {
    var s = utf8Decode(textBytes);
    var bom = stripBomText(s);
    if (checkJson) parseEs3Json(bom.text);
    return { mode: mode, text: bom.text, hasBom: bom.hasBom, bytes: origBytes };
  }

  function stepPlainCandidate(bytes) {
    if (!isPlainTextStart(bytes)) return null;
    try {
      return decodeVerifiedText(bytes, bytes, 'plain', true);
    } catch (e) {
      if (!canBeAes(bytes)) throw e;
      return null;
    }
  }

  function finishDecodeGzipSync(bytes) {
    return decodeVerifiedText(gunzipSyncU8(bytes), bytes, 'gzip', true);
  }

  function decryptAesInner(bytes, password) {
    var iv = bytes.subarray(0, 16);
    var ct = bytes.subarray(16);
    var key = pbkdf2HmacSha1(utf8Encode(password), iv, 100, 16);
    try {
      return aesCbcDecrypt(ct, key, iv);
    } catch (e) {
      throw new Error('암호가 일치하지 않거나 손상된 ES3 세이브 파일입니다.');
    }
  }

  function finishDecodeAesPlain(inner, bytes) {
    var result = decodeVerifiedText(inner, bytes, 'aes-plain', false);
    if (result.text.replace(/^\s+/, '')[0] !== '{') {
      throw new Error('암호가 일치하지 않거나 손상된 ES3 세이브 파일입니다.');
    }
    return result;
  }

  async function decryptAesPayload(bytes, password) {
    var inner = decryptAesInner(bytes, password);
    if (startsWith(inner, [0x1f, 0x8b])) {
      try {
        return decodeVerifiedText(await gzipDecompress(inner), bytes, 'aes-gzip', true);
      } catch (e) {
        if (e && e.code === 'ES3_DECOMPRESS_LIMIT') throw e;
      }
    }
    return finishDecodeAesPlain(inner, bytes);
  }

  function decryptAesPayloadSync(bytes, password) {
    var inner = decryptAesInner(bytes, password);
    if (startsWith(inner, [0x1f, 0x8b])) {
      try {
        return decodeVerifiedText(gunzipSyncU8(inner), bytes, 'aes-gzip', true);
      } catch (e) {
        if (e && e.code === 'ES3_DECOMPRESS_LIMIT') throw e;
      }
    }
    return finishDecodeAesPlain(inner, bytes);
  }

  async function decodeEs3Bytes(uint8Array, password) {
    if (password === undefined) password = 'Meow';
    var bytes = toU8(uint8Array);

    var plain = stepPlainCandidate(bytes);
    if (plain) return plain;

    if (startsWith(bytes, [0x1f, 0x8b])) {
      try {
        return decodeVerifiedText(await gzipDecompress(bytes), bytes, 'gzip', true);
      } catch (e) {
        if (e && e.code === 'ES3_DECOMPRESS_LIMIT') throw e;
        if (!canBeAes(bytes)) throw e;
      }
    }

    if (canBeAes(bytes)) {
      return await decryptAesPayload(bytes, password);
    }

    if (!canBeAes(bytes)) utf8Decode(bytes);
    throw new Error('암호가 일치하지 않거나 손상된 ES3 세이브 파일입니다.');
  }

  function decodeEs3BytesSync(uint8Array, password) {
    if (!isNode()) throw new Error('decodeEs3BytesSync requires Node.js');
    if (password === undefined) password = 'Meow';

    var bytes = toU8(uint8Array);
    var plain = stepPlainCandidate(bytes);
    if (plain) return plain;

    if (startsWith(bytes, [0x1f, 0x8b])) {
      try {
        return finishDecodeGzipSync(bytes);
      } catch (e) {
        if (e && e.code === 'ES3_DECOMPRESS_LIMIT') throw e;
        if (!canBeAes(bytes)) throw e;
      }
    }

    if (canBeAes(bytes)) return decryptAesPayloadSync(bytes, password);

    if (!canBeAes(bytes)) utf8Decode(bytes);
    throw new Error('암호가 일치하지 않거나 손상된 ES3 세이브 파일입니다.');
  }

  async function encodeEs3Bytes(text, options) {
    options = options || {};
    var mode = options.mode || 'aes-gzip';
    var password = options.password === undefined ? 'Meow' : options.password;
    var iv = options.iv ? toU8(options.iv) : null;
    var textBytes = utf8Encode(text);

    if (mode === 'plain') return textBytes;
    if (mode === 'gzip') return await gzipCompress(textBytes);
    // AES modes
    var padded = mode === 'aes-gzip' ? await gzipCompress(textBytes) : textBytes;
    if (!iv || iv.length !== 16) iv = randomBytes16();
    var key = pbkdf2HmacSha1(utf8Encode(password), iv, 100, 16);
    var ct = aesCbcEncrypt(padded, key, iv);
    return concatU8(iv, ct);
  }

  return {
    // Exposed crypto primitives (mostly for tests)
    sha1: sha1,
    hmacSha1: hmacSha1,
    pbkdf2HmacSha1: pbkdf2HmacSha1,
    aesCbcEncrypt: aesCbcEncrypt,
    aesCbcDecrypt: aesCbcDecrypt,
    gzipCompress: gzipCompress,
    gzipDecompress: gzipDecompress,
    utf8Encode: utf8Encode,
    utf8Decode: utf8Decode,
    // Container
    MAX_DECOMPRESSED_BYTES: MAX_DECOMPRESSED_BYTES,
    getMaxDecompressedBytes: getMaxDecompressedBytes,
    setMaxDecompressedBytes: setMaxDecompressedBytes,
    decodeEs3Bytes: decodeEs3Bytes,
    decodeEs3BytesSync: decodeEs3BytesSync,
    encodeEs3Bytes: encodeEs3Bytes,
    // AST
    parseEs3Json: parseEs3Json,
    stringifyEs3Json: stringifyEs3Json,
    isEs3Object: isEs3Object,
    isEs3Number: isEs3Number,
    makeObj: makeObj,
    makeNum: makeNum,
    numToFloat: numToFloat,
    numToIntString: numToIntString,
    objGet: objGet,
    objHas: objHas,
    objSet: objSet,
    objDelete: objDelete,
    objEntries: objEntries,
    es3ToPlainJs: es3ToPlainJs,
    plainJsToEs3: plainJsToEs3
  };
});
