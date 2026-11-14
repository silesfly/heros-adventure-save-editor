#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Hero's Adventure save editor — Section 1A: core codec primitives.

Pure-Python AES-128-CBC (FIPS-197) + PBKDF2-HMAC-SHA1 key derivation and
the 4-mode ES3 container codec (plain / gzip / aes-plain / aes-gzip).
No third-party packages are used anywhere in this file.
"""

import argparse
import errno
import gzip
import hashlib
import http.server
import io
import json
import os
import pathlib
import re
import stat
import struct
import subprocess
import sys
import time
import uuid
import zlib


# ---------------------------------------------------------------------------
# Pure Python AES-128 (FIPS-197).  State is kept column-major as in the spec:
# flat index = row + 4 * column, matching `src/es3-codec.js` byte-for-byte.
# ---------------------------------------------------------------------------
SBOX = bytes((
    0x63, 0x7c, 0x77, 0x7b, 0xf2, 0x6b, 0x6f, 0xc5, 0x30, 0x01, 0x67, 0x2b, 0xfe, 0xd7, 0xab, 0x76,
    0xca, 0x82, 0xc9, 0x7d, 0xfa, 0x59, 0x47, 0xf0, 0xad, 0xd4, 0xa2, 0xaf, 0x9c, 0xa4, 0x72, 0xc0,
    0xb7, 0xfd, 0x93, 0x26, 0x36, 0x3f, 0xf7, 0xcc, 0x34, 0xa5, 0xe5, 0xf1, 0x71, 0xd8, 0x31, 0x15,
    0x04, 0xc7, 0x23, 0xc3, 0x18, 0x96, 0x05, 0x9a, 0x07, 0x12, 0x80, 0xe2, 0xeb, 0x27, 0xb2, 0x75,
    0x09, 0x83, 0x2c, 0x1a, 0x1b, 0x6e, 0x5a, 0xa0, 0x52, 0x3b, 0xd6, 0xb3, 0x29, 0xe3, 0x2f, 0x84,
    0x53, 0xd1, 0x00, 0xed, 0x20, 0xfc, 0xb1, 0x5b, 0x6a, 0xcb, 0xbe, 0x39, 0x4a, 0x4c, 0x58, 0xcf,
    0xd0, 0xef, 0xaa, 0xfb, 0x43, 0x4d, 0x33, 0x85, 0x45, 0xf9, 0x02, 0x7f, 0x50, 0x3c, 0x9f, 0xa8,
    0x51, 0xa3, 0x40, 0x8f, 0x92, 0x9d, 0x38, 0xf5, 0xbc, 0xb6, 0xda, 0x21, 0x10, 0xff, 0xf3, 0xd2,
    0xcd, 0x0c, 0x13, 0xec, 0x5f, 0x97, 0x44, 0x17, 0xc4, 0xa7, 0x7e, 0x3d, 0x64, 0x5d, 0x19, 0x73,
    0x60, 0x81, 0x4f, 0xdc, 0x22, 0x2a, 0x90, 0x88, 0x46, 0xee, 0xb8, 0x14, 0xde, 0x5e, 0x0b, 0xdb,
    0xe0, 0x32, 0x3a, 0x0a, 0x49, 0x06, 0x24, 0x5c, 0xc2, 0xd3, 0xac, 0x62, 0x91, 0x95, 0xe4, 0x79,
    0xe7, 0xc8, 0x37, 0x6d, 0x8d, 0xd5, 0x4e, 0xa9, 0x6c, 0x56, 0xf4, 0xea, 0x65, 0x7a, 0xae, 0x08,
    0xba, 0x78, 0x25, 0x2e, 0x1c, 0xa6, 0xb4, 0xc6, 0xe8, 0xdd, 0x74, 0x1f, 0x4b, 0xbd, 0x8b, 0x8a,
    0x70, 0x3e, 0xb5, 0x66, 0x48, 0x03, 0xf6, 0x0e, 0x61, 0x35, 0x57, 0xb9, 0x86, 0xc1, 0x1d, 0x9e,
    0xe1, 0xf8, 0x98, 0x11, 0x69, 0xd9, 0x8e, 0x94, 0x9b, 0x1e, 0x87, 0xe9, 0xce, 0x55, 0x28, 0xdf,
    0x8c, 0xa1, 0x89, 0x0d, 0xbf, 0xe6, 0x42, 0x68, 0x41, 0x99, 0x2d, 0x0f, 0xb0, 0x54, 0xbb, 0x16,
))

INV_SBOX = bytes((
    0x52, 0x09, 0x6a, 0xd5, 0x30, 0x36, 0xa5, 0x38, 0xbf, 0x40, 0xa3, 0x9e, 0x81, 0xf3, 0xd7, 0xfb,
    0x7c, 0xe3, 0x39, 0x82, 0x9b, 0x2f, 0xff, 0x87, 0x34, 0x8e, 0x43, 0x44, 0xc4, 0xde, 0xe9, 0xcb,
    0x54, 0x7b, 0x94, 0x32, 0xa6, 0xc2, 0x23, 0x3d, 0xee, 0x4c, 0x95, 0x0b, 0x42, 0xfa, 0xc3, 0x4e,
    0x08, 0x2e, 0xa1, 0x66, 0x28, 0xd9, 0x24, 0xb2, 0x76, 0x5b, 0xa2, 0x49, 0x6d, 0x8b, 0xd1, 0x25,
    0x72, 0xf8, 0xf6, 0x64, 0x86, 0x68, 0x98, 0x16, 0xd4, 0xa4, 0x5c, 0xcc, 0x5d, 0x65, 0xb6, 0x92,
    0x6c, 0x70, 0x48, 0x50, 0xfd, 0xed, 0xb9, 0xda, 0x5e, 0x15, 0x46, 0x57, 0xa7, 0x8d, 0x9d, 0x84,
    0x90, 0xd8, 0xab, 0x00, 0x8c, 0xbc, 0xd3, 0x0a, 0xf7, 0xe4, 0x58, 0x05, 0xb8, 0xb3, 0x45, 0x06,
    0xd0, 0x2c, 0x1e, 0x8f, 0xca, 0x3f, 0x0f, 0x02, 0xc1, 0xaf, 0xbd, 0x03, 0x01, 0x13, 0x8a, 0x6b,
    0x3a, 0x91, 0x11, 0x41, 0x4f, 0x67, 0xdc, 0xea, 0x97, 0xf2, 0xcf, 0xce, 0xf0, 0xb4, 0xe6, 0x73,
    0x96, 0xac, 0x74, 0x22, 0xe7, 0xad, 0x35, 0x85, 0xe2, 0xf9, 0x37, 0xe8, 0x1c, 0x75, 0xdf, 0x6e,
    0x47, 0xf1, 0x1a, 0x71, 0x1d, 0x29, 0xc5, 0x89, 0x6f, 0xb7, 0x62, 0x0e, 0xaa, 0x18, 0xbe, 0x1b,
    0xfc, 0x56, 0x3e, 0x4b, 0xc6, 0xd2, 0x79, 0x20, 0x9a, 0xdb, 0xc0, 0xfe, 0x78, 0xcd, 0x5a, 0xf4,
    0x1f, 0xdd, 0xa8, 0x33, 0x88, 0x07, 0xc7, 0x31, 0xb1, 0x12, 0x10, 0x59, 0x27, 0x80, 0xec, 0x5f,
    0x60, 0x51, 0x7f, 0xa9, 0x19, 0xb5, 0x4a, 0x0d, 0x2d, 0xe5, 0x7a, 0x9f, 0x93, 0xc9, 0x9c, 0xef,
    0xa0, 0xe0, 0x3b, 0x4d, 0xae, 0x2a, 0xf5, 0xb0, 0xc8, 0xeb, 0xbb, 0x3c, 0x83, 0x53, 0x99, 0x61,
    0x17, 0x2b, 0x04, 0x7e, 0xba, 0x77, 0xd6, 0x26, 0xe1, 0x69, 0x14, 0x63, 0x55, 0x21, 0x0c, 0x7d,
))

RCON = (0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80, 0x1b, 0x36)


def xtime(a: int) -> int:
    """Multiply by x (=0x02) in GF(2^8) with the AES reduction polynomial."""
    a <<= 1
    if a & 0x100:
        a ^= 0x11B
    return a & 0xFF


def gmul(a: int, b: int) -> int:
    """Multiply two elements of GF(2^8)."""
    result = 0
    for _ in range(8):
        if b & 1:
            result ^= a
        b >>= 1
        a = xtime(a)
    return result


def aes_expand_key(key: bytes) -> bytes:
    """Expand a 16-byte AES-128 key into 176 bytes (11 round keys)."""
    if len(key) != 16:
        raise ValueError("AES-128 key must be exactly 16 bytes")
    expanded = bytearray(key)
    rcon_index = 0
    for _ in range(10):
        temp = list(expanded[-4:])
        # RotWord then SubWord
        temp = temp[1:] + temp[:1]
        temp = [SBOX[b] for b in temp]
        temp[0] ^= RCON[rcon_index]
        rcon_index += 1
        base = len(expanded) - 16
        for i in range(4):
            expanded.append(expanded[base + i] ^ temp[i])
        for i in range(4, 16):
            expanded.append(expanded[len(expanded) - 4] ^ expanded[len(expanded) - 16])
    return bytes(expanded)


def aes_encrypt_block(round_keys: bytes, block: bytes) -> bytes:
    """Encrypt a single 16-byte block (FIPS-197, column-major state)."""
    if len(block) != 16:
        raise ValueError("AES block must be exactly 16 bytes")
    s = [block[i] ^ round_keys[i] for i in range(16)]
    for rnd in range(1, 11):
        s = [SBOX[b] for b in s]
        s = [s[0], s[5], s[10], s[15],
             s[4], s[9], s[14], s[3],
             s[8], s[13], s[2], s[7],
             s[12], s[1], s[6], s[11]]
        if rnd != 10:
            ns = [0] * 16
            for c in range(4):
                a0, a1, a2, a3 = s[4 * c:4 * c + 4]
                ns[4 * c + 0] = gmul(a0, 2) ^ gmul(a1, 3) ^ a2 ^ a3
                ns[4 * c + 1] = a0 ^ gmul(a1, 2) ^ gmul(a2, 3) ^ a3
                ns[4 * c + 2] = a0 ^ a1 ^ gmul(a2, 2) ^ gmul(a3, 3)
                ns[4 * c + 3] = gmul(a0, 3) ^ a1 ^ a2 ^ gmul(a3, 2)
            s = ns
        off = 16 * rnd
        for i in range(16):
            s[i] ^= round_keys[off + i]
    return bytes(s)


def aes_decrypt_block(round_keys: bytes, block: bytes) -> bytes:
    """Decrypt a single 16-byte block (FIPS-197, column-major state)."""
    if len(block) != 16:
        raise ValueError("AES block must be exactly 16 bytes")
    s = [block[i] ^ round_keys[160 + i] for i in range(16)]
    for rnd in range(9, -1, -1):
        s = [s[0], s[13], s[10], s[7],
             s[4], s[1], s[14], s[11],
             s[8], s[5], s[2], s[15],
             s[12], s[9], s[6], s[3]]
        s = [INV_SBOX[b] for b in s]
        off = 16 * rnd
        for i in range(16):
            s[i] ^= round_keys[off + i]
        if rnd != 0:
            ns = [0] * 16
            for c in range(4):
                a0, a1, a2, a3 = s[4 * c:4 * c + 4]
                ns[4 * c + 0] = gmul(a0, 14) ^ gmul(a1, 11) ^ gmul(a2, 13) ^ gmul(a3, 9)
                ns[4 * c + 1] = gmul(a0, 9) ^ gmul(a1, 14) ^ gmul(a2, 11) ^ gmul(a3, 13)
                ns[4 * c + 2] = gmul(a0, 13) ^ gmul(a1, 9) ^ gmul(a2, 14) ^ gmul(a3, 11)
                ns[4 * c + 3] = gmul(a0, 11) ^ gmul(a1, 13) ^ gmul(a2, 9) ^ gmul(a3, 14)
            s = ns
    return bytes(s)


def aes_cbc_encrypt(plaintext: bytes, key: bytes, iv: bytes) -> bytes:
    """AES-128-CBC encrypt with PKCS#7 padding."""
    if len(key) != 16 or len(iv) != 16:
        raise ValueError("key and iv must be 16 bytes")
    pad = 16 - (len(plaintext) % 16)
    data = plaintext + bytes([pad]) * pad
    rk = aes_expand_key(key)
    prev = iv
    out = bytearray()
    for i in range(0, len(data), 16):
        block = bytes(data[i + j] ^ prev[j] for j in range(16))
        prev = aes_encrypt_block(rk, block)
        out.extend(prev)
    return bytes(out)


def aes_cbc_decrypt(ciphertext: bytes, key: bytes, iv: bytes) -> bytes:
    """AES-128-CBC decrypt and strict PKCS#7 unpadding."""
    if len(key) != 16 or len(iv) != 16:
        raise ValueError("key and iv must be 16 bytes")
    if len(ciphertext) == 0 or len(ciphertext) % 16 != 0:
        raise ValueError("ciphertext length must be a non-zero multiple of 16")
    rk = aes_expand_key(key)
    prev = iv
    out = bytearray()
    for i in range(0, len(ciphertext), 16):
        block = ciphertext[i:i + 16]
        dec = aes_decrypt_block(rk, block)
        out.extend(dec[j] ^ prev[j] for j in range(16))
        prev = block
    pad = out[-1]
    if pad < 1 or pad > 16 or out[-pad:] != bytes([pad]) * pad:
        raise ValueError("Invalid PKCS#7 padding")
    return bytes(out[:-pad])


# ---------------------------------------------------------------------------
# ES3 container: PBKDF2 key derivation and 4-mode pack / unpack.
# ---------------------------------------------------------------------------
def derive_es3_key(password: str, iv: bytes) -> bytes:
    """Derive the 16-byte AES key: PBKDF2-HMAC-SHA1(password, iv, 100 iters)."""
    return hashlib.pbkdf2_hmac("sha1", password.encode("utf-8"), iv, 100, 16)


def _sniff_json_prefix(blob: bytes) -> bool:
    """True if `blob` starts with optional UTF-8 BOM + whitespace + '{'."""
    body = blob[3:] if blob.startswith(b"\xef\xbb\xbf") else blob
    return body.lstrip(b" \t\r\n").startswith(b"{")


def _decode_utf8_json(blob: bytes) -> str:
    if blob.startswith(b"\xef\xbb\xbf"):
        blob = blob[3:]
    return blob.decode("utf-8")


def _decode_verified_es3_text(blob: bytes, mode: str) -> dict:
    text = blob.decode("utf-8", errors="strict")
    if text.startswith("\ufeff"):
        text = text[1:]
    parse_es3_json(text)
    return {"mode": mode, "text": text}


def _can_be_aes(blob: bytes) -> bool:
    return len(blob) >= 32 and (len(blob) % 16) == 0


MAX_DECOMPRESSED_BYTES = 64 * 1024 * 1024


class DecompressedSizeLimitError(ValueError):
    pass


def _gunzip_bounded(blob: bytes, max_bytes: int = None) -> bytes:
    limit = MAX_DECOMPRESSED_BYTES if max_bytes is None else max_bytes
    total, chunks = 0, []
    with gzip.GzipFile(fileobj=io.BytesIO(blob)) as gz:
        while True:
            chunk = gz.read(65536)
            if not chunk:
                break
            total += len(chunk)
            if total > limit:
                raise DecompressedSizeLimitError(f"세이브 압축 해제 크기가 허용 한도({limit} 바이트)를 초과했습니다.")
            chunks.append(chunk)
    return b"".join(chunks)


def decode_es3_bytes(data: bytes, password: str = "Meow") -> dict:
    """Detect and decode any of the 4 ES3 container modes."""
    if _sniff_json_prefix(data):
        try:
            return _decode_verified_es3_text(data, "plain")
        except (UnicodeDecodeError, ValueError) as exc:
            if not _can_be_aes(data):
                raise ValueError("암호가 일치하지 않거나 손상된 ES3 세이브 파일입니다.") from exc
    if data[:2] == b"\x1f\x8b":
        try:
            return _decode_verified_es3_text(_gunzip_bounded(data), "gzip")
        except DecompressedSizeLimitError:
            raise
        except (OSError, EOFError, zlib.error, UnicodeDecodeError, ValueError) as exc:
            if not _can_be_aes(data):
                raise ValueError("암호가 일치하지 않거나 손상된 ES3 세이브 파일입니다.") from exc
    if _can_be_aes(data):
        iv, body = data[:16], data[16:]
        try:
            plain = aes_cbc_decrypt(body, derive_es3_key(password, iv), iv)
        except ValueError as exc:
            raise ValueError("암호가 일치하지 않거나 손상된 ES3 세이브 파일입니다.") from exc
        if plain[:2] == b"\x1f\x8b":
            try:
                return _decode_verified_es3_text(_gunzip_bounded(plain), "aes-gzip")
            except DecompressedSizeLimitError:
                raise
            except (OSError, EOFError, zlib.error, UnicodeDecodeError, ValueError):
                pass
        if _sniff_json_prefix(plain):
            try:
                return _decode_verified_es3_text(plain, "aes-plain")
            except (UnicodeDecodeError, ValueError) as exc:
                raise ValueError("암호가 일치하지 않거나 손상된 ES3 세이브 파일입니다.") from exc
        raise ValueError("암호가 일치하지 않거나 손상된 ES3 세이브 파일입니다.")
    raise ValueError("Unrecognized ES3 container format")


def encode_es3_bytes(text: str, mode: str = "aes-gzip",
                     password: str = "Meow", iv: bytes = None) -> bytes:
    """Encode `text` into one of the 4 ES3 container modes."""
    payload = text.encode("utf-8")
    if mode == "plain":
        return payload
    if mode == "gzip":
        return gzip.compress(payload, mtime=0)
    if mode not in ("aes-plain", "aes-gzip"):
        raise ValueError("Unknown ES3 mode: %r" % (mode,))
    if iv is None:
        iv = os.urandom(16)
    if len(iv) != 16:
        raise ValueError("iv must be 16 bytes")
    body = gzip.compress(payload, mtime=0) if mode == "aes-gzip" else payload
    return iv + aes_cbc_encrypt(body, derive_es3_key(password, iv), iv)


_ES3_NUMBER_RE = re.compile(
    r'-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?'
)
_ES3_INT_RE = re.compile(r'^-?[0-9]+$')


class Es3Number:
    def __init__(self, raw):
        self.raw = str(raw)

    def __repr__(self):
        return "Es3Number(%r)" % self.raw

    def __eq__(self, other):
        return isinstance(other, Es3Number) and self.raw == other.raw

    def __hash__(self):
        return hash((Es3Number, self.raw))


class Es3Entry:
    def __init__(self, key, value, quoted=True):
        self.key = str(key)
        self.value = value
        self.quoted = bool(quoted)

    def __repr__(self):
        return "Es3Entry(%r, %r, quoted=%r)" % (self.key, self.value, self.quoted)


class Es3Object:
    def __init__(self, entries=None):
        self.entries = []
        self.index = {}
        if entries:
            for entry in entries:
                if isinstance(entry, Es3Entry):
                    self.entries.append(entry)
                    self.index[entry.key] = entry
                else:
                    key, value, quoted = entry
                    self.add(key, value, quoted)

    def add(self, key, value, quoted=True):
        entry = Es3Entry(key, value, quoted)
        self.entries.append(entry)
        self.index[entry.key] = entry
        return entry

    def __repr__(self):
        return "Es3Object(%r)" % (self.entries,)


def is_es3_obj(v):
    return isinstance(v, Es3Object)


def is_es3_num(v):
    return isinstance(v, Es3Number)


def make_obj(items=None):
    obj = Es3Object()
    if items is None:
        return obj
    for item in items:
        if len(item) == 3:
            key, value, quoted = item
        else:
            key, value = item
            quoted = True
        obj.add(key, value, quoted)
    return obj


def make_num(val):
    if isinstance(val, Es3Number):
        return val
    if isinstance(val, bool):
        raise ValueError("bool 값은 숫자로 사용할 수 없습니다.")
    if isinstance(val, int):
        return Es3Number(str(val))
    if isinstance(val, str):
        s = val.strip()
        if not s or _ES3_NUMBER_RE.fullmatch(s) is None:
            raise ValueError("올바른 숫자 문자열이 아닙니다: %r" % (val,))
        return Es3Number(val)
    raise ValueError("지원하지 않는 숫자 형식입니다: %r" % (val,))


def obj_get(obj, key, default=None):
    if not isinstance(obj, Es3Object):
        return default
    entry = obj.index.get(str(key))
    return default if entry is None else entry.value


def obj_has(obj, key):
    return isinstance(obj, Es3Object) and str(key) in obj.index


def obj_set(obj, key, value, quoted=None):
    key = str(key)
    entry = obj.index.get(key)
    if entry is not None:
        entry.value = value
        if quoted is not None:
            entry.quoted = bool(quoted)
        return entry
    entry = Es3Entry(key, value, True if quoted is None else bool(quoted))
    obj.entries.append(entry)
    obj.index[key] = entry
    return entry


def obj_del(obj, key):
    if not isinstance(obj, Es3Object):
        return False
    key = str(key)
    entry = obj.index.pop(key, None)
    if entry is None:
        return False
    obj.entries[:] = [e for e in obj.entries if e is not entry]
    return True


def num_to_int(v, default=0):
    if isinstance(v, bool):
        return default
    if isinstance(v, Es3Number):
        raw = v.raw.strip()
    elif isinstance(v, int):
        return v
    elif isinstance(v, str):
        raw = v.strip()
    else:
        return default
    m = re.match(r'^([+-]?[0-9]+)', raw)
    if not m:
        return default
    try:
        return int(m.group(1))
    except ValueError:
        return default


def num_to_str(v, default='0'):
    if isinstance(v, bool):
        return default
    if isinstance(v, Es3Number):
        return v.raw
    if isinstance(v, int):
        return str(v)
    if isinstance(v, str):
        return v
    return default


def es3_to_plain(node):
    if isinstance(node, Es3Object):
        result = {}
        for entry in node.entries:
            result[entry.key] = es3_to_plain(entry.value)
        return result
    if isinstance(node, Es3Number):
        raw = node.raw
        if _ES3_INT_RE.match(raw):
            try:
                return int(raw)
            except ValueError:
                return raw
        return raw
    if isinstance(node, list):
        return [es3_to_plain(v) for v in node]
    return node


def validate_safe_int(val, min_val, max_val, label='값'):
    if isinstance(val, bool):
        raise ValueError("%s이(가) 올바른 정수가 아닙니다." % label)
    s = str(val).strip()
    if _ES3_INT_RE.match(s) is None:
        raise ValueError("%s이(가) 올바른 정수가 아닙니다: %r" % (label, val))
    n = int(s)
    if n < min_val or n > max_val:
        raise ValueError(
            "%s이(가) 허용 범위를 벗어났습니다: %d (허용 %d..%d)"
            % (label, n, min_val, max_val)
        )
    return n


class _Es3Parser:
    def __init__(self, text):
        self.text = text
        self.pos = 0
        self.n = len(text)

    def parse(self):
        self._skip_ws()
        if self.pos >= self.n:
            raise ValueError("빈 ES3 JSON 입력입니다.")
        value = self._parse_value()
        self._skip_ws()
        if self.pos != self.n:
            raise ValueError("ES3 JSON 뒤에 잘못된 문자가 있습니다: %r" % self.text[self.pos:self.pos + 20])
        return value

    def _skip_ws(self):
        while self.pos < self.n and self.text[self.pos] in ' \t\r\n':
            self.pos += 1

    def _parse_value(self):
        self._skip_ws()
        if self.pos >= self.n:
            raise ValueError("ES3 JSON 값이 예상되었습니다.")
        ch = self.text[self.pos]
        if ch == '{':
            return self._parse_object()
        if ch == '[':
            return self._parse_array()
        if ch == '"':
            return self._parse_string()
        if ch == 't' and self.text.startswith('true', self.pos):
            self.pos += 4
            return True
        if ch == 'f' and self.text.startswith('false', self.pos):
            self.pos += 5
            return False
        if ch == 'n' and self.text.startswith('null', self.pos):
            self.pos += 4
            return None
        if ch in '-+0123456789.':
            end = self.pos
            while end < self.n and self.text[end] in '0123456789+-eE.':
                end += 1
            raw = self.text[self.pos:end]
            if _ES3_NUMBER_RE.fullmatch(raw) is None:
                raise ValueError("지원하지 않는 ES3 JSON 토큰입니다: %r" % (raw,))
            self.pos = end
            return Es3Number(raw)
        raise ValueError("지원하지 않는 ES3 JSON 토큰입니다: %r" % self.text[self.pos:self.pos + 20])

    def _parse_object(self):
        obj = Es3Object()
        self.pos += 1
        self._skip_ws()
        if self.pos < self.n and self.text[self.pos] == '}':
            self.pos += 1
            return obj
        while True:
            self._skip_ws()
            if self.pos >= self.n:
                raise ValueError("미종결 ES3 JSON 객체입니다.")
            if self.text[self.pos] == '"':
                key = self._parse_string()
                quoted = True
            else:
                key = self._parse_unquoted_key()
                quoted = False
            self._skip_ws()
            if self.pos >= self.n or self.text[self.pos] != ':':
                raise ValueError("ES3 JSON 객체 키 뒤에 ':'가 필요합니다.")
            self.pos += 1
            value = self._parse_value()
            obj.add(key, value, quoted)
            self._skip_ws()
            if self.pos >= self.n:
                raise ValueError("미종결 ES3 JSON 객체입니다.")
            ch = self.text[self.pos]
            if ch == ',':
                self.pos += 1
                self._skip_ws()
                if self.pos < self.n and self.text[self.pos] == '}':
                    raise ValueError("ES3 JSON 객체에 후행 쉼표가 있습니다.")
                continue
            if ch == '}':
                self.pos += 1
                return obj
            raise ValueError("ES3 JSON 객체에서 ',' 또는 '}'가 필요합니다.")

    def _parse_array(self):
        arr = []
        self.pos += 1
        self._skip_ws()
        if self.pos < self.n and self.text[self.pos] == ']':
            self.pos += 1
            return arr
        while True:
            arr.append(self._parse_value())
            self._skip_ws()
            if self.pos >= self.n:
                raise ValueError("미종결 ES3 JSON 배열입니다.")
            ch = self.text[self.pos]
            if ch == ',':
                self.pos += 1
                self._skip_ws()
                if self.pos < self.n and self.text[self.pos] == ']':
                    raise ValueError("ES3 JSON 배열에 후행 쉼표가 있습니다.")
                continue
            if ch == ']':
                self.pos += 1
                return arr
            raise ValueError("ES3 JSON 배열에서 ',' 또는 ']'가 필요합니다.")

    def _parse_unquoted_key(self):
        start = self.pos
        while self.pos < self.n:
            ch = self.text[self.pos]
            if ch in ' \t\r\n:,{}[]"':
                break
            self.pos += 1
        token = self.text[start:self.pos]
        if not token:
            raise ValueError("ES3 JSON 객체 키가 비어 있습니다.")
        if _ES3_NUMBER_RE.fullmatch(token) is None and re.match(r'^[A-Za-z_$][A-Za-z0-9_$]*$', token) is None:
            raise ValueError("올바르지 않은 ES3 JSON 객체 키입니다: %r" % token)
        return token

    def _parse_string(self):
        if self.text[self.pos] != '"':
            raise ValueError("문자열 시작 따옴표가 필요합니다.")
        self.pos += 1
        out = []
        while self.pos < self.n:
            ch = self.text[self.pos]
            self.pos += 1
            if ch == '"':
                return ''.join(out)
            if ch == '\\':
                if self.pos >= self.n:
                    raise ValueError("미종결 ES3 JSON 문자열 이스케이프입니다.")
                esc = self.text[self.pos]
                self.pos += 1
                if esc == '"':
                    out.append('"')
                elif esc == '\\':
                    out.append('\\')
                elif esc == '/':
                    out.append('/')
                elif esc == 'b':
                    out.append('\b')
                elif esc == 'f':
                    out.append('\f')
                elif esc == 'n':
                    out.append('\n')
                elif esc == 'r':
                    out.append('\r')
                elif esc == 't':
                    out.append('\t')
                elif esc == 'u':
                    out.append(self._parse_unicode_escape())
                else:
                    raise ValueError("올바르지 않은 ES3 JSON 이스케이프입니다: \\%s" % esc)
            else:
                if ord(ch) < 0x20:
                    raise ValueError("JSON 문자열에 이스케이프되지 않은 제어 문자가 포함되어 있습니다: U+%04X" % ord(ch))
                out.append(ch)
        raise ValueError("미종결 ES3 JSON 문자열입니다.")

    def _parse_unicode_escape(self):
        if self.pos + 4 > self.n:
            raise ValueError("잘린 유니코드 이스케이프입니다.")
        hexs = self.text[self.pos:self.pos + 4]
        if re.match(r'^[0-9A-Fa-f]{4}$', hexs) is None:
            raise ValueError("올바르지 않은 유니코드 이스케이프입니다: %r" % hexs)
        self.pos += 4
        code = int(hexs, 16)
        if 0xD800 <= code <= 0xDBFF and self.pos + 6 <= self.n and self.text.startswith('\\u', self.pos):
            low_hex = self.text[self.pos + 2:self.pos + 6]
            if re.match(r'^[0-9A-Fa-f]{4}$', low_hex):
                low = int(low_hex, 16)
                if 0xDC00 <= low <= 0xDFFF:
                    self.pos += 6
                    code = 0x10000 + ((code - 0xD800) << 10) + (low - 0xDC00)
        return chr(code)


def parse_es3_json(text):
    if not isinstance(text, str):
        raise ValueError("ES3 JSON 입력은 문자열이어야 합니다.")
    return _Es3Parser(text).parse()


def _es3_escape_string(s):
    out = ['"']
    for ch in s:
        o = ord(ch)
        if ch == '"':
            out.append('\\"')
        elif ch == '\\':
            out.append('\\\\')
        elif ch == '\b':
            out.append('\\b')
        elif ch == '\f':
            out.append('\\f')
        elif ch == '\n':
            out.append('\\n')
        elif ch == '\r':
            out.append('\\r')
        elif ch == '\t':
            out.append('\\t')
        elif o < 0x20 or (0xD800 <= o <= 0xDFFF):
            out.append('\\u%04x' % o)
        else:
            out.append(ch)
    out.append('"')
    return ''.join(out)


def stringify_es3_json(node):
    if node is None:
        return 'null'
    if node is True:
        return 'true'
    if node is False:
        return 'false'
    if isinstance(node, Es3Number):
        return node.raw
    if isinstance(node, int) and not isinstance(node, bool):
        return str(node)
    if isinstance(node, str):
        return _es3_escape_string(node)
    if isinstance(node, list):
        return '[' + ','.join(stringify_es3_json(v) for v in node) + ']'
    if isinstance(node, Es3Object):
        parts = []
        for entry in node.entries:
            key = _es3_escape_string(entry.key) if entry.quoted else entry.key
            parts.append(key + ':' + stringify_es3_json(entry.value))
        return '{' + ','.join(parts) + '}'
    raise ValueError("ES3 JSON으로 직렬화할 수 없는 값입니다: %r" % (node,))


def ensure_no_symlinks(path) -> pathlib.Path:
    if path is None:
        raise ValueError("경로가 지정되지 않았습니다.")
    raw_str = str(path)
    if not raw_str or not raw_str.strip():
        raise ValueError("경로가 비어 있습니다.")
    if raw_str.startswith(("\\\\?\\", "\\\\.\\", "//?/", "//./")):
        raise ValueError(f"Windows 장치 경로는 허용되지 않습니다: {raw_str}")
    if raw_str.startswith(("\\\\", "//")):
        raise ValueError(f"UNC 경로는 허용되지 않습니다: {raw_str}")
    abs_str = os.path.abspath(raw_str)
    if abs_str.startswith(("\\\\", "//")):
        raise ValueError(f"UNC 경로는 허용되지 않습니다: {abs_str}")
    reparse_set = set()
    reparse_env = os.environ.get("HASE_TEST_REPARSE_PATHS")
    if reparse_env:
        for token in reparse_env.split(os.pathsep):
            token = token.strip()
            if not token:
                continue
            reparse_set.add(os.path.normcase(os.path.abspath(token)))
    cur = pathlib.Path(abs_str)
    while True:
        if reparse_set and os.path.normcase(os.path.abspath(str(cur))) in reparse_set:
            raise ValueError(f"심볼릭 링크 또는 리파스 포인트 경로는 허용되지 않습니다: {cur}")
        try:
            st = os.lstat(str(cur))
        except FileNotFoundError:
            st = None
        except OSError as exc:
            raise ValueError(f"경로 상태를 확인할 수 없습니다: {cur}") from exc
        if os.path.islink(str(cur)):
            raise ValueError(f"심볼릭 링크 또는 리파스 포인트 경로는 허용되지 않습니다: {cur}")
        if st is not None:
            mode = getattr(st, "st_mode", 0)
            attrs = getattr(st, "st_file_attributes", 0)
            if stat.S_ISLNK(mode) or (attrs & 0x400) != 0:
                raise ValueError(f"심볼릭 링크 또는 리파스 포인트 경로는 허용되지 않습니다: {cur}")
        parent = cur.parent
        if parent == cur:
            break
        cur = parent
    return pathlib.Path(abs_str)


def _scan_proc_for_wulin(proc_root: str = "/proc") -> str:
    had_access_error = False
    is_live_proc = os.path.normpath(os.path.abspath(proc_root)) == "/proc"
    self_pid = os.getpid()

    def _exe_basename(tok: bytes) -> bytes:
        if not tok or tok.endswith((b"/", b"\\")):
            return b""
        return re.split(br"[/\\]+", tok)[-1].lower()

    def _is_wulin_launcher(bname: bytes) -> bool:
        if not bname:
            return False
        stem = bname[:-4] if bname.endswith(b".exe") else bname
        return (
            stem in {
                b"wine",
                b"wine64",
                b"wine32",
                b"wine-preloader",
                b"wine64-preloader",
                b"proton",
                b"reaper",
                b"steam-launch-wrapper",
                b"pressure-vessel-wrap",
                b"umu-run",
                b"box64",
                b"box86",
                b"fexinterpreter",
            }
            or bname.startswith((b"wine", b"proton"))
        )

    try:
        names = os.listdir(proc_root)
    except OSError:
        return "UNKNOWN"
    for name in names:
        if not name.isdigit():
            continue
        if is_live_proc and int(name) == self_pid:
            continue
        base = os.path.join(proc_root, name)
        try:
            with open(os.path.join(base, "comm"), "rb") as fh:
                comm_clean = fh.read().rstrip(b"\r\n\x00 ").lower()
                if comm_clean == b"wulin.exe":
                    return "RUNNING"
        except OSError as exc:
            if exc.errno not in (errno.ENOENT, errno.ESRCH):
                had_access_error = True
        try:
            with open(os.path.join(base, "cmdline"), "rb") as fh:
                tokens = [t for t in fh.read().split(b"\x00") if t]
                if tokens:
                    if _exe_basename(tokens[0]) == b"wulin.exe":
                        return "RUNNING"
                    for idx, tok in enumerate(tokens[:-1]):
                        if _is_wulin_launcher(_exe_basename(tok)) and any(
                            _exe_basename(later) == b"wulin.exe"
                            for later in tokens[idx + 1:]
                        ):
                            return "RUNNING"
        except OSError as exc:
            if exc.errno not in (errno.ENOENT, errno.ESRCH):
                had_access_error = True
    if had_access_error:
        return "UNKNOWN"
    return "NOT_RUNNING"


def _resolve_windows_tasklist():
    import ntpath
    try:
        import ctypes
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        buf = ctypes.create_unicode_buffer(32768)
        n = kernel32.GetSystemDirectoryW(buf, len(buf))
        if n and 0 < n < len(buf):
            sys_dir = buf.value
        else:
            sys_dir = None
    except Exception:
        sys_dir = None
    if not sys_dir:
        sys_dir = ntpath.join(os.environ.get("SystemRoot") or r"C:\Windows", "System32")
    exe = ntpath.join(sys_dir, "tasklist.exe")
    return exe if ntpath.isabs(exe) and os.path.isfile(exe) else None


def detect_wulin_running() -> str:
    if os.environ.get("HASE_SIMULATE_WULIN_RUNNING") == "1":
        return "RUNNING"
    if os.environ.get("HASE_SIMULATE_WULIN_UNKNOWN") == "1":
        return "UNKNOWN"
    if os.name == "nt":
        tasklist_exe = _resolve_windows_tasklist()
        if not tasklist_exe:
            return "UNKNOWN"
        try:
            r = subprocess.run(
                [tasklist_exe, "/FI", "IMAGENAME eq Wulin.exe", "/NH"],
                capture_output=True, timeout=5,
            )
        except (OSError, subprocess.SubprocessError, UnicodeError):
            return "UNKNOWN"
        if r.returncode != 0:
            return "UNKNOWN"
        out = r.stdout.encode("utf-8", errors="replace") if isinstance(r.stdout, str) else (r.stdout or b"")
        err = r.stderr.encode("utf-8", errors="replace") if isinstance(r.stderr, str) else (r.stderr or b"")
        raw = b"\n".join((out, err))
        if not raw.strip():
            return "UNKNOWN"
        low = raw.lower()
        if b"wulin.exe" in low or "wulin.exe".encode("utf-16le") in low:
            return "RUNNING"
        return "NOT_RUNNING"
    if os.path.isdir("/proc"):
        return _scan_proc_for_wulin("/proc")
    return "UNKNOWN"


def is_wulin_running() -> bool:
    state = detect_wulin_running()
    if state == "UNKNOWN":
        raise RuntimeError("Wulin.exe 실행 여부를 확인할 수 없습니다.")
    return state == "RUNNING"


def check_wulin_not_running(force: bool = False, ignore_running_game: bool = False) -> None:
    if force or ignore_running_game:
        return
    state = detect_wulin_running()
    if state == "RUNNING":
        raise RuntimeError(
            "대협입지전(Wulin.exe) 실행 중에는 세이브를 수정할 수 없습니다. "
            "게임을 종료하거나 --ignore-running-game(--force)을 지정하세요."
        )
    if state == "UNKNOWN":
        raise RuntimeError(
            "Wulin.exe 실행 여부를 확인할 수 없어 안전을 위해 저장을 중단합니다. "
            "게임을 종료했는지 확인하거나 --ignore-running-game을 지정하세요."
        )


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _safe_unlink(path) -> None:
    if path is None:
        return
    try:
        os.unlink(str(path))
    except OSError:
        pass


HASE_TEST_AFTER_ENSURE_HOOK = None
TEST_AFTER_ENSURE_HOOK = None


class PinnedDirectory:
    def __init__(self, target_parent, create: bool = False):
        self.raw_parent = pathlib.Path(target_parent)
        self.clean_parent = None
        self.create = bool(create)
        self._fd = None
        self._handle = None

    def __enter__(self):
        clean_parent = ensure_no_symlinks(self.raw_parent)
        hook = HASE_TEST_AFTER_ENSURE_HOOK or TEST_AFTER_ENSURE_HOOK
        if hook is not None:
            hook(clean_parent)
        self.clean_parent = pathlib.Path(clean_parent)
        if os.name != "nt":
            flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0)
            step_flags = flags | getattr(os, "O_NOFOLLOW", 0)
            fd = os.open("/", flags)
            try:
                if clean_parent.parts and clean_parent.parts[0] == os.sep:
                    parts = clean_parent.parts[1:]
                else:
                    parts = clean_parent.parts
                for part in parts:
                    try:
                        next_fd = os.open(part, step_flags, dir_fd=fd)
                    except FileNotFoundError:
                        if not self.create:
                            raise
                        try:
                            os.mkdir(part, 0o755, dir_fd=fd)
                        except FileExistsError:
                            pass
                        try:
                            next_fd = os.open(part, step_flags, dir_fd=fd)
                        except OSError as exc:
                            if exc.errno in (errno.ELOOP, errno.ENOTDIR):
                                raise ValueError(f"안전하지 않은 디렉터리 경로입니다: {clean_parent}")
                            raise
                    except OSError as exc:
                        if exc.errno in (errno.ELOOP, errno.ENOTDIR):
                            raise ValueError(f"안전하지 않은 디렉터리 경로입니다: {clean_parent}")
                        raise
                    if not stat.S_ISDIR(os.fstat(next_fd).st_mode):
                        os.close(next_fd)
                        raise ValueError(f"디렉터리가 아닙니다: {clean_parent}")
                    os.close(fd)
                    fd = next_fd
                self._fd = fd
            except BaseException:
                try:
                    os.close(fd)
                except OSError:
                    pass
                raise
        else:
            win_flags = 0x02200000
            if not self.create:
                kernel32, handle = self._win32_open_verified_handle(
                    clean_parent, 1, 3, win_flags, True
                )
                try:
                    ensure_no_symlinks(clean_parent)
                except BaseException:
                    kernel32.CloseHandle(handle)
                    raise
                self._handle = handle
            else:
                cur = pathlib.Path(clean_parent.anchor)
                kernel32, cur_handle = self._win32_open_verified_handle(
                    cur, 1, 3, win_flags, True
                )
                try:
                    for part in clean_parent.parts[1:]:
                        child = cur / part
                        try:
                            _, next_handle = self._win32_open_verified_handle(
                                child, 1, 3, win_flags, True
                            )
                        except FileNotFoundError:
                            try:
                                os.mkdir(str(child))
                            except FileExistsError:
                                pass
                            _, next_handle = self._win32_open_verified_handle(
                                child, 1, 3, win_flags, True
                            )
                        kernel32.CloseHandle(cur_handle)
                        cur_handle = next_handle
                        cur = child
                    ensure_no_symlinks(clean_parent)
                    self._handle = cur_handle
                except BaseException:
                    kernel32.CloseHandle(cur_handle)
                    raise
        return self

    @staticmethod
    def _win32_open_verified_handle(expected_path, desired_access, share_mode,
                                    flags_and_attrs, require_dir,
                                    creation_disposition=3):
        import ctypes
        from ctypes import wintypes

        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)

        class FILETIME(ctypes.Structure):
            _fields_ = [
                ("dwLowDateTime", wintypes.DWORD),
                ("dwHighDateTime", wintypes.DWORD),
            ]

        class BY_HANDLE_FILE_INFORMATION(ctypes.Structure):
            _fields_ = [
                ("dwFileAttributes", wintypes.DWORD),
                ("ftCreationTime", FILETIME),
                ("ftLastAccessTime", FILETIME),
                ("ftLastWriteTime", FILETIME),
                ("dwVolumeSerialNumber", wintypes.DWORD),
                ("nFileSizeHigh", wintypes.DWORD),
                ("nFileSizeLow", wintypes.DWORD),
                ("nNumberOfLinks", wintypes.DWORD),
                ("nFileIndexHigh", wintypes.DWORD),
                ("nFileIndexLow", wintypes.DWORD),
            ]

        create_file = kernel32.CreateFileW
        create_file.argtypes = [
            wintypes.LPCWSTR,
            wintypes.DWORD,
            wintypes.DWORD,
            wintypes.LPVOID,
            wintypes.DWORD,
            wintypes.DWORD,
            wintypes.HANDLE,
        ]
        create_file.restype = wintypes.HANDLE
        get_info = kernel32.GetFileInformationByHandle
        get_info.argtypes = [wintypes.HANDLE, ctypes.POINTER(BY_HANDLE_FILE_INFORMATION)]
        get_info.restype = wintypes.BOOL
        get_final_path = kernel32.GetFinalPathNameByHandleW
        get_final_path.argtypes = [wintypes.HANDLE, wintypes.LPWSTR, wintypes.DWORD, wintypes.DWORD]
        get_final_path.restype = wintypes.DWORD

        handle = create_file(
            str(expected_path), desired_access, share_mode, None, creation_disposition,
            flags_and_attrs, None
        )
        if handle == wintypes.HANDLE(-1).value:
            err = ctypes.get_last_error()
            if err in (2, 3):
                raise FileNotFoundError(f"경로를 찾을 수 없습니다: {expected_path}")
            if err == 5:
                try:
                    st = os.lstat(str(expected_path))
                except OSError:
                    pass
                else:
                    if (getattr(st, "st_file_attributes", 0) & 0x400) != 0 or stat.S_ISLNK(st.st_mode):
                        raise ValueError(f"심볼릭 링크 또는 재분석 지점입니다: {expected_path}")
                    if not require_dir and stat.S_ISDIR(st.st_mode):
                        raise IsADirectoryError(f"디렉터리입니다: {expected_path}")
            raise ctypes.WinError(err)

        info = BY_HANDLE_FILE_INFORMATION()
        if not get_info(handle, ctypes.byref(info)):
            err = ctypes.get_last_error()
            kernel32.CloseHandle(handle)
            raise ctypes.WinError(err)
        if (info.dwFileAttributes & 0x400) != 0:
            kernel32.CloseHandle(handle)
            raise ValueError(f"심볼릭 링크 또는 재분석 지점입니다: {expected_path}")
        if require_dir and (info.dwFileAttributes & 0x10) == 0:
            kernel32.CloseHandle(handle)
            raise ValueError(f"디렉터리가 아닙니다: {expected_path}")
        if not require_dir and (info.dwFileAttributes & 0x10) != 0:
            kernel32.CloseHandle(handle)
            raise IsADirectoryError(f"디렉터리입니다: {expected_path}")

        buf = ctypes.create_unicode_buffer(32768)
        n = get_final_path(handle, buf, len(buf), 0)
        if n == 0:
            err = ctypes.get_last_error()
            kernel32.CloseHandle(handle)
            raise ctypes.WinError(err)
        final_path = buf.value
        if final_path.startswith("\\\\?\\UNC\\"):
            final_path = "\\\\" + final_path[8:]
        elif final_path.startswith("\\\\?\\"):
            final_path = final_path[4:]
        if os.path.normcase(os.path.abspath(final_path)) != os.path.normcase(os.path.abspath(str(expected_path))):
            kernel32.CloseHandle(handle)
            raise ValueError(f"경로가 변경되었습니다: {expected_path}")
        return kernel32, handle

    def __exit__(self, exc_type, exc, tb):
        if os.name != "nt":
            if self._fd is not None:
                try:
                    os.close(self._fd)
                except OSError:
                    pass
                self._fd = None
        else:
            if self._handle is not None:
                try:
                    import ctypes
                    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
                    kernel32.CloseHandle(self._handle)
                except Exception:
                    pass
                self._handle = None
        return False

    def _full(self, name):
        return self.clean_parent / name

    def lstat_leaf(self, name):
        if os.name != "nt" and self._fd is not None:
            st = os.stat(name, dir_fd=self._fd, follow_symlinks=False)
        else:
            st = os.lstat(str(self._full(name)))
        if stat.S_ISLNK(st.st_mode) or (getattr(st, "st_file_attributes", 0) & 0x400) != 0:
            raise ValueError(f"심볼릭 링크 또는 재분석 지점입니다: {self._full(name)}")
        return st

    def exists_leaf(self, name) -> bool:
        try:
            self.lstat_leaf(name)
            return True
        except FileNotFoundError:
            return False

    def open_leaf(self, name, flags, mode=0o600) -> int:
        nofollow = getattr(os, "O_NOFOLLOW", 0)
        flags |= nofollow | getattr(os, "O_BINARY", 0)
        try:
            if os.name != "nt" and self._fd is not None:
                return os.open(name, flags, mode, dir_fd=self._fd)
            return os.open(str(self._full(name)), flags, mode)
        except OSError as exc:
            if nofollow and exc.errno in (
                errno.ELOOP,
                getattr(errno, "EFTYPE", -1),
                getattr(errno, "EMLINK", -1),
            ):
                raise ValueError(f"심볼릭 링크입니다: {self._full(name)}")
            raise

    def read_leaf_bytes(self, name) -> bytes:
        if os.name != "nt":
            import fcntl
            nonblock = getattr(os, "O_NONBLOCK", 0)
            fd = self.open_leaf(name, os.O_RDONLY | nonblock)
            try:
                st = os.fstat(fd)
                if stat.S_ISDIR(st.st_mode):
                    raise IsADirectoryError(f"디렉터리입니다: {self._full(name)}")
                if not stat.S_ISREG(st.st_mode):
                    raise ValueError(f"일반 파일이 아닙니다: {self._full(name)}")
                if nonblock:
                    fl = fcntl.fcntl(fd, fcntl.F_GETFL)
                    fcntl.fcntl(fd, fcntl.F_SETFL, fl & ~os.O_NONBLOCK)
                chunks = []
                while True:
                    chunk = os.read(fd, 1024 * 1024)
                    if not chunk:
                        break
                    chunks.append(chunk)
                return b"".join(chunks)
            finally:
                os.close(fd)
        import ctypes
        from ctypes import wintypes
        kernel32, handle = self._win32_open_verified_handle(
            self._full(name), 0x80000000, 1 | 2, 0x00200000, False
        )
        try:
            read_file = kernel32.ReadFile
            read_file.argtypes = [
                wintypes.HANDLE,
                ctypes.c_void_p,
                wintypes.DWORD,
                ctypes.POINTER(wintypes.DWORD),
                ctypes.c_void_p,
            ]
            read_file.restype = wintypes.BOOL
            chunks = []
            buf = ctypes.create_string_buffer(1024 * 1024)
            bytes_read = wintypes.DWORD()
            while True:
                if not read_file(handle, buf, len(buf), ctypes.byref(bytes_read), None):
                    err = ctypes.get_last_error()
                    raise ctypes.WinError(err)
                if bytes_read.value == 0:
                    break
                chunks.append(buf.raw[:bytes_read.value])
            return b"".join(chunks)
        finally:
            kernel32.CloseHandle(handle)

    def unlink_leaf(self, name):
        try:
            if os.name != "nt" and self._fd is not None:
                os.unlink(name, dir_fd=self._fd)
            else:
                os.unlink(str(self._full(name)))
        except FileNotFoundError:
            pass

    def replace_leaf(self, src_name, dst_name):
        if os.name != "nt" and self._fd is not None:
            os.replace(src_name, dst_name, src_dir_fd=self._fd, dst_dir_fd=self._fd)
        else:
            os.replace(str(self._full(src_name)), str(self._full(dst_name)))

    @staticmethod
    def _linux_renameat2_noreplace(dir_fd: int, src_name: str, dst_name: str) -> None:
        import ctypes
        libc = ctypes.CDLL(None, use_errno=True)
        try:
            renameat2 = libc.renameat2
        except AttributeError:
            raise OSError(errno.ENOSYS, "renameat2 is not available")
        renameat2.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
        renameat2.restype = ctypes.c_int
        rc = renameat2(dir_fd, os.fsencode(src_name), dir_fd, os.fsencode(dst_name), 1)
        if rc != 0:
            err = ctypes.get_errno()
            if err == errno.ENOSYS:
                raise OSError(err, os.strerror(err))
            if err == errno.EEXIST:
                raise FileExistsError(err, os.strerror(err), dst_name)
            raise OSError(err, os.strerror(err), dst_name)

    def publish_exclusive_leaf(self, src_name, dst_name) -> bool:
        if self.exists_leaf(dst_name):
            raise FileExistsError(f"대상 파일이 이미 존재합니다: {self._full(dst_name)}")
        if os.name == "nt":
            import ctypes
            from ctypes import wintypes
            kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
            move_file_ex = kernel32.MoveFileExW
            move_file_ex.argtypes = [wintypes.LPCWSTR, wintypes.LPCWSTR, wintypes.DWORD]
            move_file_ex.restype = wintypes.BOOL
            ok = move_file_ex(str(self._full(src_name)), str(self._full(dst_name)), 0)
            if not ok:
                err = ctypes.get_last_error()
                if err in (80, 183):
                    raise FileExistsError(f"대상 파일이 이미 존재합니다: {self._full(dst_name)}")
                raise ctypes.WinError(err)
            return False
        try:
            if self._fd is not None:
                os.link(src_name, dst_name, src_dir_fd=self._fd, dst_dir_fd=self._fd, follow_symlinks=False)
            else:
                os.link(str(self._full(src_name)), str(self._full(dst_name)), follow_symlinks=False)
            return True
        except FileExistsError:
            raise
        except OSError as link_err:
            if link_err.errno not in (errno.EPERM, errno.EOPNOTSUPP, getattr(errno, "ENOTSUP", errno.EOPNOTSUPP), errno.ENOSYS, errno.EXDEV):
                raise
            if sys.platform.startswith("linux") and self._fd is not None:
                try:
                    self._linux_renameat2_noreplace(self._fd, src_name, dst_name)
                    return False
                except FileExistsError:
                    raise
                except OSError as rn_err:
                    if rn_err.errno not in (errno.ENOSYS, errno.EINVAL, errno.EPERM, errno.EOPNOTSUPP, getattr(errno, "ENOTSUP", errno.EOPNOTSUPP), errno.EXDEV):
                        raise
            raise OSError(getattr(errno, "EOPNOTSUPP", errno.ENOSYS), f"파일시스템이 원자적 배타 게시(hardlink/RENAME_NOREPLACE)를 지원하지 않습니다: {self._full(dst_name)}")

    def link_exclusive_leaf(self, src_name, dst_name):
        if self.publish_exclusive_leaf(src_name, dst_name):
            self.unlink_leaf(src_name)

    def write_exclusive_leaf(self, name, data, writer_hook=None, before_publish=None):
        tmp_name = "%s.tmp-%d-%s" % (name, os.getpid(), uuid.uuid4().hex[:12])
        fd = None
        try:
            fd = self.open_leaf(tmp_name, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            if writer_hook is not None:
                writer_hook(fd, data)
            else:
                view = memoryview(data)
                written = 0
                while written < len(view):
                    written += os.write(fd, view[written:])
                os.fsync(fd)
            os.close(fd)
            fd = None
            tmp_bytes = self.read_leaf_bytes(tmp_name)
            if len(tmp_bytes) != len(data) or sha256_hex(tmp_bytes) != sha256_hex(data):
                raise IOError("임시 파일 무결성 검증에 실패했습니다: %s" % self._full(tmp_name))
            if before_publish is not None:
                before_publish()
            needs_unlink = self.publish_exclusive_leaf(tmp_name, name)
            tmp_cleanup = tmp_name
            tmp_name = None
            if needs_unlink:
                try:
                    self.unlink_leaf(tmp_cleanup)
                except OSError:
                    pass
        except BaseException:
            if fd is not None:
                try:
                    os.close(fd)
                except OSError:
                    pass
            if tmp_name is not None:
                try:
                    self.unlink_leaf(tmp_name)
                except OSError:
                    pass
            raise

    def acquire_leaf_lock(self, leaf_name):
        lock_name = ".hase-lock-%s" % leaf_name
        if os.name == "nt":
            import msvcrt
            kernel32, handle = self._win32_open_verified_handle(
                self._full(lock_name), 0xC0000000, 3, 0x00200080, False,
                creation_disposition=4
            )
            try:
                fd = msvcrt.open_osfhandle(
                    handle, os.O_RDWR | getattr(os, "O_BINARY", 0)
                )
            except BaseException:
                kernel32.CloseHandle(handle)
                raise
            try:
                os.lseek(fd, 0, os.SEEK_SET)
                msvcrt.locking(fd, msvcrt.LK_LOCK, 1)
            except BaseException:
                os.close(fd)
                raise

            def release():
                try:
                    os.lseek(fd, 0, os.SEEK_SET)
                    msvcrt.locking(fd, msvcrt.LK_UNLCK, 1)
                finally:
                    os.close(fd)
                    try:
                        self.unlink_leaf(lock_name)
                    except PermissionError:
                        pass

            return release
        import fcntl
        nonblock = getattr(os, "O_NONBLOCK", 0)

        def _open_lock_fd():
            fd = self.open_leaf(lock_name, os.O_RDWR | os.O_CREAT | nonblock, 0o600)
            try:
                st_init = os.fstat(fd)
                if stat.S_ISDIR(st_init.st_mode):
                    raise IsADirectoryError(f"디렉터리입니다: {self._full(lock_name)}")
                if not stat.S_ISREG(st_init.st_mode):
                    raise ValueError(f"잠금 경로가 일반 파일이 아닙니다: {self._full(lock_name)}")
                if nonblock:
                    fl = fcntl.fcntl(fd, fcntl.F_GETFL)
                    fcntl.fcntl(fd, fcntl.F_SETFL, fl & ~os.O_NONBLOCK)
            except BaseException:
                try:
                    os.close(fd)
                except OSError:
                    pass
                raise
            return fd

        fd = _open_lock_fd()
        try:
            while True:
                fcntl.flock(fd, fcntl.LOCK_EX)
                st_fd = os.fstat(fd)
                try:
                    st_path = self.lstat_leaf(lock_name)
                except FileNotFoundError:
                    fcntl.flock(fd, fcntl.LOCK_UN)
                    os.close(fd)
                    fd = _open_lock_fd()
                    continue
                if st_fd.st_ino == st_path.st_ino and st_fd.st_dev == st_path.st_dev:
                    break
                fcntl.flock(fd, fcntl.LOCK_UN)
                os.close(fd)
                fd = _open_lock_fd()

            def release():
                try:
                    self.unlink_leaf(lock_name)
                finally:
                    fcntl.flock(fd, fcntl.LOCK_UN)
                    os.close(fd)

            return release
        except BaseException:
            try:
                os.close(fd)
            except OSError:
                pass
            raise


def _write_exclusive_synced(path: pathlib.Path, data: bytes, writer_hook=None) -> None:
    path = pathlib.Path(path)
    with PinnedDirectory(path.parent) as pin:
        pin.write_exclusive_leaf(path.name, data, writer_hook=writer_hook)


def read_regular_file_pinned(path):
    p = ensure_no_symlinks(path)
    with PinnedDirectory(p.parent) as pin:
        return pin._full(p.name), pin.read_leaf_bytes(p.name)


def _assert_decompressed_limit(utf8_len: int, mode: str, label) -> None:
    if mode in ("gzip", "aes-gzip") and utf8_len > MAX_DECOMPRESSED_BYTES:
        raise DecompressedSizeLimitError(
            f"세이브 직렬화 크기({utf8_len} 바이트)가 허용 한도({MAX_DECOMPRESSED_BYTES} 바이트)를 초과했습니다: {label}"
        )


def atomic_write_save_batch(entries, force: bool = False, ignore_running_game: bool = False,
                            fault_injector=None, writer_hook=None,
                            rollback_fault_injector=None, rollback_writer_hook=None,
                            create_parent: bool = False) -> list:
    if not entries:
        return []
    check_wulin_not_running(force=force, ignore_running_game=ignore_running_game)
    stamp = time.strftime("%Y%m%d%H%M%S", time.gmtime())
    pid = os.getpid()
    prepared = []
    pins = {}
    locks = []
    seen_targets = set()
    try:
        for entry in entries:
            target = ensure_no_symlinks(entry["target_path"])
            target = pathlib.Path(target)
            target_key = os.path.normcase(str(target))
            if target_key in seen_targets:
                raise ValueError(f"중복된 대상 경로입니다: {target}")
            seen_targets.add(target_key)
            new_text = entry["new_text"]
            mode = entry.get("mode", "aes-gzip")
            password = entry.get("password", "Meow")
            expected_sha256 = entry.get("expected_sha256")
            expect_exists = entry.get("expect_exists")
            role = entry.get("role")
            _assert_decompressed_limit(len(new_text.encode("utf-8")), mode, target)
            encoded = encode_es3_bytes(new_text, mode=mode, password=password)
            decoded = decode_es3_bytes(encoded, password=password)
            if decoded.get("text") != new_text:
                raise ValueError(f"인코딩 왕복 검증 실패: {target}")
            prepared.append({
                "role": role,
                "target": target,
                "name": target.name,
                "parent": str(target.parent),
                "encoded": encoded,
                "sha256": sha256_hex(encoded),
                "expected_sha256": expected_sha256,
                "expect_exists": expect_exists,
                "existed": None,
                "orig_bytes": None,
                "orig_hash": None,
                "backup": None,
                "pending": None,
                "restored_ok": True,
                "committed_stat": None,
            })

        parent_map = {}
        for item in prepared:
            parent_map.setdefault(os.path.normcase(item["parent"]), item["parent"])
        for parent_key in sorted(set(os.path.normcase(item["parent"]) for item in prepared)):
            pin = PinnedDirectory(parent_map[parent_key], create=create_parent)
            pin.__enter__()
            pins[parent_key] = pin

        rollback_failed = False

        for item in sorted(prepared, key=lambda x: os.path.normcase(str(x["target"]))):
            pin = pins[os.path.normcase(item["parent"])]
            release = pin.acquire_leaf_lock(item["name"])
            locks.append(release)

        for item in prepared:
            pin = pins[os.path.normcase(item["parent"])]
            target = item["target"]
            name = item["name"]
            exists = pin.exists_leaf(name)
            existed = exists
            item["existed"] = existed
            if item["expect_exists"] is False and existed:
                raise FileExistsError(f"대상 파일이 이미 존재합니다: {target}")
            if item["expect_exists"] is True and not existed:
                raise ValueError(f"대상 파일이 존재하지 않습니다: {target}")
            if existed:
                orig_bytes = pin.read_leaf_bytes(name)
                orig_hash = sha256_hex(orig_bytes)
                if item["expected_sha256"] is not None and orig_hash != item["expected_sha256"]:
                    raise ValueError(f"세이브 파일이 로드 후 외부에서 수정되었습니다: {target}")
                item["orig_bytes"] = orig_bytes
                item["orig_hash"] = orig_hash
                backup_name = "%s.backup-%s-%d-%s.bak" % (name, stamp, pid, uuid.uuid4().hex[:8])
                pin.write_exclusive_leaf(backup_name, orig_bytes, writer_hook=writer_hook)
                item["backup"] = backup_name
            else:
                if item["expected_sha256"] is not None:
                    raise ValueError(f"세이브 파일이 로드 후 외부에서 삭제되었습니다: {target}")
            pending_name = "%s.pending-%d-%s.tmp" % (name, pid, uuid.uuid4().hex[:8])
            pin.write_exclusive_leaf(pending_name, item["encoded"], writer_hook=writer_hook)
            item["pending"] = pending_name

        replaced = []
        try:
            for idx, item in enumerate(prepared):
                pin = pins[os.path.normcase(item["parent"])]
                name = item["name"]
                target = item["target"]
                if fault_injector is not None:
                    fault_injector(idx, target)
                check_wulin_not_running(force=force, ignore_running_game=ignore_running_game)
                if item["existed"]:
                    if not pin.exists_leaf(name):
                        raise ValueError(f"세이브 파일이 로드 후 외부에서 삭제되었습니다: {target}")
                    if sha256_hex(pin.read_leaf_bytes(name)) != item["orig_hash"]:
                        raise ValueError(f"세이브 파일이 로드 후 외부에서 수정되었습니다: {target}")
                    pin.replace_leaf(item["pending"], name)
                    item["pending"] = None
                    item["restored_ok"] = False
                    replaced.append(idx)
                else:
                    if pin.exists_leaf(name):
                        raise FileExistsError(f"대상 파일이 이미 존재합니다: {target}")
                    needs_src_unlink = pin.publish_exclusive_leaf(item["pending"], name)
                    if not needs_src_unlink:
                        item["pending"] = None
                    item["restored_ok"] = False
                    replaced.append(idx)
                    if needs_src_unlink:
                        pin.unlink_leaf(item["pending"])
                        item["pending"] = None
                st_after = pin.lstat_leaf(name)
                item["committed_stat"] = (st_after.st_dev, st_after.st_ino)
        except BaseException as commit_err:
            rollback_errors = []
            for r_idx in reversed(replaced):
                rb = prepared[r_idx]
                pin = pins[os.path.normcase(rb["parent"])]
                name = rb["name"]
                def _verify_committed_target():
                    if not pin.exists_leaf(name):
                        raise IOError(f"커밋 후 대상 파일이 외부에서 삭제되어 롤백을 중단합니다: {rb['target']}")
                    cur_st = pin.lstat_leaf(name)
                    if os.name != "nt" and rb.get("committed_stat") and rb["committed_stat"][1] != 0:
                        if (cur_st.st_dev, cur_st.st_ino) != rb["committed_stat"]:
                            raise IOError(f"커밋 후 대상 파일이 외부에서 교체되어 롤백을 중단합니다: {rb['target']}")
                    if sha256_hex(pin.read_leaf_bytes(name)) != rb["sha256"]:
                        raise IOError(f"커밋 후 대상 파일이 외부에서 수정되어 롤백을 중단합니다: {rb['target']}")
                try:
                    if rollback_fault_injector is not None:
                        rollback_fault_injector(r_idx, rb["target"])
                    if rb["existed"]:
                        rb_tmp = "%s.rollback-%d-%s.tmp" % (name, pid, uuid.uuid4().hex[:8])
                        try:
                            pin.write_exclusive_leaf(rb_tmp, rb["orig_bytes"], writer_hook=rollback_writer_hook)
                            if sha256_hex(pin.read_leaf_bytes(rb_tmp)) != rb["orig_hash"]:
                                raise IOError(f"롤백 스테이징 검증 실패: {rb['target']}")
                            _verify_committed_target()
                            pin.replace_leaf(rb_tmp, name)
                        finally:
                            try:
                                pin.unlink_leaf(rb_tmp)
                            except OSError:
                                pass
                        if sha256_hex(pin.read_leaf_bytes(name)) != rb["orig_hash"]:
                            raise IOError(f"롤백 검증 실패: {rb['target']}")
                    else:
                        _verify_committed_target()
                        pin.unlink_leaf(name)
                        if pin.exists_leaf(name):
                            raise IOError(f"롤백 삭제 검증 실패: {rb['target']}")
                    rb["restored_ok"] = True
                except BaseException as rb_err:
                    rollback_errors.append({
                        "target": str(rb["target"]),
                        "backup": str(rb["target"].with_name(rb["backup"])) if rb["backup"] else "없음",
                        "error": str(rb_err),
                    })

            pending_cleanup_errors = []
            for item in prepared:
                if item["pending"] is not None:
                    pin = pins[os.path.normcase(item["parent"])]
                    try:
                        pin.unlink_leaf(item["pending"])
                        item["pending"] = None
                    except OSError as pend_err:
                        pending_cleanup_errors.append(
                            f"{item['target'].with_name(item['pending'])}: {pend_err}"
                        )

            if rollback_errors:
                rollback_failed = True
                details = "; ".join(
                    "%s (backup=%s): %s" % (e["target"], e["backup"], e["error"])
                    for e in rollback_errors
                )
                if pending_cleanup_errors:
                    details += "; 임시 파일 정리 실패: " + "; ".join(pending_cleanup_errors)
                raise IOError(
                    "세이브 커밋 실패: %s; 롤백 실패: %s" % (commit_err, details)
                ) from commit_err
            if pending_cleanup_errors:
                raise IOError(
                    "세이브 커밋 실패: %s; 임시 파일 정리 실패: %s"
                    % (commit_err, "; ".join(pending_cleanup_errors))
                ) from commit_err
            raise

        return [
            {
                "role": item["role"],
                "target": str(item["target"]),
                "backup": str(item["target"].with_name(item["backup"])) if item["backup"] is not None else None,
                "bytes_written": len(item["encoded"]),
                "sha256": item["sha256"],
                "raw_bytes": item["encoded"],
            }
            for item in prepared
        ]
    except BaseException:
        for item in prepared:
            parent_key = os.path.normcase(item["parent"])
            if item.get("pending") is not None and parent_key in pins:
                try:
                    pins[parent_key].unlink_leaf(item["pending"])
                except Exception:
                    pass
            if (
                item.get("backup") is not None
                and parent_key in pins
                and item.get("restored_ok", True) is True
                and not rollback_failed
            ):
                try:
                    pins[parent_key].unlink_leaf(item["backup"])
                except Exception:
                    pass
        raise
    finally:
        for release in reversed(locks):
            try:
                release()
            except Exception:
                pass
        for pin in pins.values():
            try:
                pin.__exit__(None, None, None)
            except Exception:
                pass


def atomic_write_save(target_path, new_text: str, mode: str = "aes-gzip",
                      password: str = "Meow", force: bool = False,
                      ignore_running_game: bool = False,
                      expected_sha256: str = None,
                      expect_exists=None, create_parent: bool = False) -> dict:
    result = atomic_write_save_batch(
        [{
            "target_path": target_path,
            "new_text": new_text,
            "mode": mode,
            "password": password,
            "expected_sha256": expected_sha256,
            "expect_exists": expect_exists,
        }],
        force=force,
        ignore_running_game=ignore_running_game,
        create_parent=create_parent,
    )[0]
    return {
        "target": result["target"],
        "backup": result["backup"],
        "bytes_written": result["bytes_written"],
        "sha256": result["sha256"],
    }


SCRIPT_DIR = pathlib.Path(__file__).resolve().parent


def load_catalog() -> dict:
    catalog = {
        "items": {},
        "kungfu": {},
        "factions": {},
        "characters": {},
        "currencies": list(range(10)),
        "fief_buildings": {u: {"uid": u, "maxLevel": 5} for u in (112, 104, 110, 113, 114, 102, 98)},
        "life_skill_keys": [
            '能力_采集_采矿', '能力_采集_伐木', '能力_采集_采药', '能力_采集_钓鱼', '能力_采集_捉虫',
            '能力_制造_兵器', '能力_制造_护甲', '能力_制造_饰品', '能力_制造_食物', '能力_制造_丹药',
            '能力_制造_合成', '能力_鉴定_字画', '能力_鉴定_书籍', '能力_鉴定_古董', '能力_鉴定_饰品',
            '能力_鉴定_丹药', '能力_市井_暗取', '能力_市井_点穴', '能力_市井_下毒', '能力_市井_机关',
            '能力_市井_突袭', '能力_生存_口才', '能力_生存_经商', '能力_生存_探索', '能力_生存_识图',
            '能力_生存_驯兽',
        ],
        "_loaded_ok": False,
    }

    catalog_path = SCRIPT_DIR / "src" / "catalog-data.js"
    if not catalog_path.is_file():
        return catalog

    try:
        text = catalog_path.read_text(encoding="utf-8")
        start = text.find("return {")
        end = text.rfind("};")
        if start < 0 or end < 0 or end <= start:
            return catalog
        raw = json.loads(text[start + len("return "):end + 1])
    except Exception:
        return catalog

    def _uid(v):
        try:
            return int(v)
        except (TypeError, ValueError):
            return None

    def _names(obj):
        if isinstance(obj, dict):
            return str(obj.get("ko", obj.get("name_ko", ""))), str(obj.get("zh", obj.get("name_zh", "")))
        if isinstance(obj, (list, tuple)):
            return (str(obj[1]) if len(obj) > 1 else ""), (str(obj[2]) if len(obj) > 2 else "")
        return "", ""

    items = {}
    for x in raw.get("items", []) if isinstance(raw.get("items", []), list) else []:
        try:
            if isinstance(x, (list, tuple)):
                i = int(x[0])
                items[i] = {"uid": i, "ko": str(x[1]), "zh": str(x[2]), "stackable": int(x[5])}
            elif isinstance(x, dict):
                i = _uid(x.get("uid", x.get("id")))
                if i is not None:
                    ko, zh = _names(x)
                    items[i] = {"uid": i, "ko": ko, "zh": zh, "stackable": int(x.get("stackable", 0))}
        except (TypeError, ValueError, IndexError):
            pass

    kungfu = {}
    for x in raw.get("kungfu", []) if isinstance(raw.get("kungfu", []), list) else []:
        try:
            if isinstance(x, (list, tuple)):
                i = int(x[0])
                kungfu[i] = {"uid": i, "ko": str(x[1]), "maxLevel": int(x[5])}
            elif isinstance(x, dict):
                i = _uid(x.get("uid", x.get("id")))
                if i is not None:
                    ko, _ = _names(x)
                    kungfu[i] = {"uid": i, "ko": ko, "maxLevel": int(x.get("maxLevel", x.get("max_level", x.get("max", 1))))}
        except (TypeError, ValueError, IndexError):
            pass

    def _parse_id_name_map(raw_collection):
        out = {}
        if isinstance(raw_collection, list):
            for x in raw_collection:
                try:
                    if isinstance(x, (list, tuple)):
                        i = int(x[0])
                        ko, zh = str(x[1]), str(x[2])
                    elif isinstance(x, dict):
                        i = _uid(x.get("uid", x.get("id")))
                        if i is None:
                            continue
                        ko, zh = _names(x)
                    else:
                        continue
                    out[i] = {"uid": i, "ko": ko, "zh": zh}
                except (TypeError, ValueError, IndexError):
                    pass
        elif isinstance(raw_collection, dict):
            for k, v in raw_collection.items():
                i = _uid(v.get("uid", k) if isinstance(v, dict) else k)
                if i is None:
                    continue
                if isinstance(v, dict):
                    ko, zh = _names(v)
                elif isinstance(v, (list, tuple)):
                    ko = str(v[0]) if len(v) > 0 else ""
                    zh = str(v[1]) if len(v) > 1 else ""
                else:
                    ko, zh = str(v), ""
                out[i] = {"uid": i, "ko": ko, "zh": zh}
        return out

    factions = _parse_id_name_map(raw.get("factions", []))
    characters = _parse_id_name_map(raw.get("characters", {}))

    catalog["items"] = items
    catalog["kungfu"] = kungfu
    catalog["factions"] = factions
    catalog["characters"] = characters
    for key in ("currencies", "fief_buildings", "life_skill_keys"):
        if raw.get(key) is not None:
            catalog[key] = raw[key]
    catalog["_loaded_ok"] = bool(items)
    return catalog


class SaveSlotEditor:
    ROLE_MARKERS = (
        ("WuLin.SaveObjectGameGlobal", "global"),
        ("WuLin.SaveObjectPlayerTeam", "playerTeam"),
        ("WuLin.SaveObjectGameCharacter", "characters"),
        ("WuLin.SaveObjectFaction", "factions"),
        ("WuLin.SaveObjectGameTime", "time"),
        ("WuLin.SaveObjectPagoda", "pagoda"),
        ("WuLin.SaveInfo", "saveInfo"),
        ("WuLin.SaveObjectGame", "game"),
    )

    CANONICAL_ROLE_FILENAMES = {
        "saveInfo": "saveinfo.save",
        "playerTeam": "saveobjectplayerteam.save",
        "characters": "saveobjectgamecharacter.save",
        "factions": "saveobjectfaction.save",
        "global": "saveobjectgameglobal.save",
        "time": "saveobjectgametime.save",
        "pagoda": "saveobjectpagoda.save",
        "game": "saveobjectgame.save",
    }
    CANONICAL_BASENAME_TO_ROLE = {v: k for k, v in CANONICAL_ROLE_FILENAMES.items()}

    def __init__(self, target_path, password="Meow", catalog=None):
        self.target_path = ensure_no_symlinks(target_path)
        if not self.target_path.exists():
            raise FileNotFoundError(f"세이브 경로가 존재하지 않습니다: {self.target_path}")
        self.password = password
        self.catalog = catalog if catalog is not None else load_catalog()
        self.files = {}
        self.ambiguous_roles = set()
        self.broken_roles = set()
        self._load_all()

    def _load_one(self, path):
        path, raw_bytes = read_regular_file_pinned(path)
        decoded = decode_es3_bytes(raw_bytes, self.password)
        parsed = parse_es3_json(decoded["text"])
        canon_role = self.CANONICAL_BASENAME_TO_ROLE.get(path.name.lower())
        if canon_role:
            role = canon_role
            type_mismatch = self._has_canonical_type_conflict(parsed, canon_role)
            if type_mismatch or not is_es3_obj(self._root_data(parsed)):
                self.broken_roles.add(canon_role)
        else:
            role = self._role_from_root(parsed, path.name) or ("unknown:" + path.name)
            type_mismatch = bool(role in self.CANONICAL_ROLE_FILENAMES and self._has_canonical_type_conflict(parsed, role))
        info = {"path": path, "role": role, "parsed": parsed, "mode": decoded.get("mode", "aes-gzip"),
                "dirty": False, "orig_bytes": raw_bytes, "loaded_sha256": sha256_hex(raw_bytes), "type_mismatch": type_mismatch}
        return info

    def _collect_dir_saves(self, directory, patterns):
        found = []
        if not directory.is_dir():
            return found
        for pattern in patterns:
            for path in sorted(directory.glob(pattern)):
                if not (path.is_file() or path.is_symlink()):
                    continue
                name = path.name.lower()
                if name.startswith(".hase-lock-"):
                    continue
                if name.endswith((".bak", ".tmp")) or ".pending-" in name or ".rollback-" in name or ".tmp-" in name:
                    continue
                found.append(path)
        return found

    def _candidate_paths(self):
        target = self.target_path
        if target.is_file():
            return [target]
        if not target.is_dir():
            return [target]
        candidates = []
        candidates.extend(self._collect_dir_saves(target, ("*.save", "*.es3")))
        global_dir = target / "Global"
        if global_dir.is_dir():
            candidates.extend(self._collect_dir_saves(global_dir, ("*.save",)))
        if not any(p.name.lower() == "saveobjectgameglobal.save" for p in candidates):
            fallback = target.parent / "Global" / "SaveObjectGameGlobal.save"
            if fallback.exists() or fallback.is_symlink():
                candidates.append(fallback)
        return candidates

    def _load_all(self):
        infos = []
        for path in self._candidate_paths():
            infos.append(self._load_one(path))
        if not self.target_path.is_dir():
            def _has_role(r):
                return any(i["role"] == r for i in infos)
            if _has_role("game") and not _has_role("global"):
                for sib in (self.target_path.parent / "Global" / "SaveObjectGameGlobal.save",
                            self.target_path.parent.parent / "Global" / "SaveObjectGameGlobal.save"):
                    if (sib.exists() or sib.is_symlink()) and sib != self.target_path:
                        infos.append(self._load_one(sib))
                        break

        grouped = {}
        for info in infos:
            role = info["role"]
            if role in self.CANONICAL_ROLE_FILENAMES:
                grouped.setdefault(role, []).append(info)
            else:
                key = role
                if key in self.files:
                    n = 1
                    while f"{role}#{n}" in self.files: n += 1
                    key = f"{role}#{n}"
                    info["role"] = key
                self.files[key] = info

        for role, entries in grouped.items():
            canon_name = self.CANONICAL_ROLE_FILENAMES[role]
            if len(entries) == 1:
                info = entries[0]
                info["role"] = role
                if info.get("type_mismatch") or not is_es3_obj(self._root_data(info["parsed"])):
                    self.broken_roles.add(role)
                self.files[role] = info
                continue
            canon = [i for i in entries if i["path"].name.lower() == canon_name]
            if len(canon) == 1:
                primary = canon[0]
                primary["role"] = role
                if primary.get("type_mismatch") or not is_es3_obj(self._root_data(primary["parsed"])):
                    self.broken_roles.add(role)
                self.files[role] = primary
                idx = 1
                for info in entries:
                    if info is primary:
                        continue
                    info["role"] = f"{role}#{idx}"
                    self.files[f"{role}#{idx}"] = info
                    idx += 1
            else:
                self.ambiguous_roles.add(role)
                for idx, info in enumerate(entries):
                    key = role if idx == 0 else f"{role}#{idx}"
                    info["role"] = key
                    self.files[key] = info

        if not self.files:
            raise FileNotFoundError("세이브 파일을 찾을 수 없습니다.")

    def _root_data(self, root):
        if not is_es3_obj(root):
            return None
        if obj_has(root, "Data"):
            data = obj_get(root, "Data")
            if not is_es3_obj(data) or not obj_has(data, "value"):
                return None
            value = obj_get(data, "value")
            return value if is_es3_obj(value) else None
        return root

    def _role_from_type_str(self, type_str):
        if not isinstance(type_str, str) or not type_str.strip():
            return None
        cls_name = type_str.split(",", 1)[0].strip()
        for marker, role in self.ROLE_MARKERS:
            if marker == cls_name:
                return role
        return None

    def _has_canonical_type_conflict(self, root, canon_role):
        if not is_es3_obj(root):
            return True
        def _valid_wrapper_type(t):
            return isinstance(t, str) and bool(t.strip()) and (
                t.split(",", 1)[0].strip() == "WuLin.SaveObjectBase" or
                self._role_from_type_str(t) == canon_role)
        def _valid_role_type(t):
            return isinstance(t, str) and bool(t.strip()) and self._role_from_type_str(t) == canon_role
        if obj_has(root, "Data"):
            if obj_has(root, "__type") and not _valid_wrapper_type(obj_get(root, "__type")):
                return True
            data = obj_get(root, "Data")
            if not is_es3_obj(data):
                return True
            if obj_has(data, "__type") and not _valid_wrapper_type(obj_get(data, "__type")):
                return True
            if not obj_has(data, "value") or not is_es3_obj(obj_get(data, "value")):
                return True
            val = obj_get(data, "value")
            if obj_has(val, "__type") and not _valid_role_type(obj_get(val, "__type")):
                return True
            return False
        return bool(obj_has(root, "__type") and not _valid_role_type(obj_get(root, "__type")))

    def _explicit_role_from_root(self, root):
        if not is_es3_obj(root):
            return None
        data = obj_get(root, "Data")
        val = obj_get(data, "value") if is_es3_obj(data) else None
        for type_str in (obj_get(val, "__type") if is_es3_obj(val) else None,
                         obj_get(data, "__type") if is_es3_obj(data) else None,
                         obj_get(root, "__type")):
            role = self._role_from_type_str(type_str)
            if role is not None:
                return role
        return None

    def _role_from_root(self, root, name=""):
        role = self._explicit_role_from_root(root)
        if role is not None:
            return role
        lname = str(name).lower()
        for needle, role in (("saveinf", "saveInfo"), ("playerteam", "playerTeam"),
                             ("gamecharacter", "characters"), ("faction", "factions"),
                             ("gameglobal", "global"), ("gametime", "time"),
                             ("pagoda", "pagoda"), ("saveobjectgame.", "game")):
            if needle in lname:
                return role
        return None

    def _file(self, role):
        if role in self.files:
            return self.files[role]
        if role == "characters" and "game" in self.files:
            return self.files["game"]
        return None

    def _value_of(self, role):
        info = self._file(role)
        if not info:
            return None
        return self._root_data(info["parsed"])

    def _player_team_value(self):
        return self._value_of("playerTeam")

    def _character_value(self):
        return self._value_of("characters")

    def _player_team_ids(self):
        value = self._player_team_value()
        if not is_es3_obj(value):
            return []
        members = obj_get(value, "playerTeam")
        if not isinstance(members, list):
            members = obj_get(value, "teamMembers")
        result = []
        if isinstance(members, list):
            for item in members:
                if is_es3_num(item):
                    result.append(num_to_int(item, 0))
                elif isinstance(item, int):
                    result.append(item)
        return result

    def _created_characters(self):
        value = self._character_value()
        if not is_es3_obj(value):
            return None
        created = obj_get(value, "createdCharacter")
        return created if is_es3_obj(created) else None

    def _protagonist_id(self):
        ids = self._player_team_ids()
        if ids:
            return ids[0]
        if "playerTeam" in self.ambiguous_roles or "playerTeam" in self.broken_roles:
            return None
        created = self._created_characters()
        if not is_es3_obj(created):
            return None
        matches = []
        for entry in created.entries:
            if is_es3_obj(entry.value) and num_to_int(obj_get(entry.value, "m_templeteUid"), 0) == 100401:
                matches.append(entry.key)
        if len(matches) != 1:
            return None
        key = matches[0]
        if isinstance(key, str) and key.lstrip("-").isdigit() and str(int(key)) == key:
            return int(key)
        return key

    def _get_character(self, instance_id=None):
        created = self._created_characters()
        if not is_es3_obj(created):
            return None
        cid = instance_id
        if cid is None:
            cid = self._protagonist_id()
        if cid is None:
            return None
        node = obj_get(created, str(cid))
        return node if is_es3_obj(node) else None

    def _assert_role_writable(self, role):
        if role in self.ambiguous_roles:
            raise ValueError(f"동일 역할({role})의 중복 세이브 파일이 모호하여 쓰기가 거부되었습니다.")
        if role == "characters" and "characters" not in self.files and "game" in self.files and "game" in self.ambiguous_roles:
            raise ValueError("동일 역할(game)의 중복 세이브 파일이 모호하여 캐릭터 쓰기가 거부되었습니다.")
        if role in self.broken_roles:
            raise ValueError(f"역할({role})의 정식 세이브 파일과 내부 타입이 충돌하거나 손상되어 쓰기가 거부되었습니다.")
        if role == "characters" and "characters" not in self.files and "game" in self.files and "game" in self.broken_roles:
            raise ValueError(f"역할({role})의 정식 세이브 파일과 내부 타입이 충돌하거나 손상되어 쓰기가 거부되었습니다.")

    def _require_character(self, instance_id=None):
        self._assert_role_writable("characters")
        created = self._created_characters()
        if not is_es3_obj(created):
            raise ValueError("캐릭터 저장 파일을 찾을 수 없습니다.")
        cid = instance_id
        if cid is None:
            self._assert_role_writable("playerTeam")
            cid = self._protagonist_id()
        if cid is None:
            raise ValueError("주인공을 식별할 수 없습니다. --char-uid/--hero-uid를 지정하세요.")
        node = obj_get(created, str(cid))
        if not is_es3_obj(node):
            raise ValueError(f"캐릭터를 찾을 수 없습니다: {cid}")
        return cid, node

    def _char_catalog_entry(self, node):
        uid = 0
        if is_es3_obj(node):
            uid = num_to_int(obj_get(node, "m_templeteUid"), 0)
        chars = self.catalog.get("characters", {}) if isinstance(self.catalog, dict) else {}
        return chars.get(uid, {})

    def _char_display_name(self, node):
        sur = obj_get(node, "m_surName", "") if is_es3_obj(node) else ""
        given = obj_get(node, "m_givenName", "") if is_es3_obj(node) else ""
        name = (str(sur or "") + str(given or "")).strip()
        if name:
            return name
        entry = self._char_catalog_entry(node)
        return entry.get("ko") or entry.get("zh") or ""

    def _validate_team_state_for_write(self, node):
        if not is_es3_obj(node):
            return
        if not obj_has(node, "m_TeamMemberState") or obj_get(node, "m_TeamMemberState") is None:
            return
        raw_state = obj_get(node, "m_TeamMemberState")
        if not is_es3_obj(raw_state):
            raise ValueError("m_TeamMemberState 객체 형식이 올바르지 않습니다.")
        if obj_has(raw_state, "value") and not is_es3_obj(obj_get(raw_state, "value")):
            raise ValueError("m_TeamMemberState.value 객체 형식이 올바르지 않습니다.")

    def _team_state(self, node, create=False):
        if not is_es3_obj(node):
            return None
        if not obj_has(node, "m_TeamMemberState") or obj_get(node, "m_TeamMemberState") is None:
            if not create:
                return None
            state = make_obj([
                ("isJoined", False, True),
                ("curHp", make_num(0), True),
                ("curEp", make_num(0), True),
            ])
            obj_set(node, "m_TeamMemberState", state)
            return state
        raw_state = obj_get(node, "m_TeamMemberState")
        if not is_es3_obj(raw_state):
            if create:
                raise ValueError("m_TeamMemberState 객체 형식이 올바르지 않습니다.")
            return None
        if obj_has(raw_state, "value"):
            inner = obj_get(raw_state, "value")
            if not is_es3_obj(inner):
                if create:
                    raise ValueError("m_TeamMemberState.value 객체 형식이 올바르지 않습니다.")
                return None
            return inner
        return raw_state

    def _find_prop_obj(self, node, kind, create=False):
        key = "m_additionProps" if kind == "addition" else "m_originProps"
        props = obj_get(node, key)
        if not is_es3_obj(props) and create:
            props = make_obj()
            obj_set(node, key, props)
        return props if is_es3_obj(props) else None

    def _mark_dirty(self, role):
        self._assert_role_writable(role)
        info = self._file(role)
        if info:
            info["dirty"] = True

    def inspect_summary(self):
        files = []
        for info in self.files.values():
            files.append({
                "path": str(info["path"]),
                "role": info["role"],
                "mode": info["mode"],
            })

        currencies = {}
        inventory_count = 0
        pv = self._player_team_value()
        if is_es3_obj(pv):
            inv = obj_get(pv, "playerTeamInventory")
            if is_es3_obj(inv):
                curr = obj_get(inv, "currencies")
                if is_es3_obj(curr):
                    for key in ("0", "1", "2", "3", "4", "5", "6", "7", "8", "9"):
                        if obj_has(curr, key):
                            currencies[key] = num_to_int(obj_get(curr, key), 0)
                contents = obj_get(inv, "contents")
                if isinstance(contents, list):
                    inventory_count = len(contents)

        protagonist = None
        pid = self._protagonist_id()
        node = self._get_character(pid)
        if is_es3_obj(node):
            state = self._team_state(node, False)
            origin = self._find_prop_obj(node, "origin", False)
            addition = self._find_prop_obj(node, "addition", False)
            origin_props = {}
            addition_props = {}
            if is_es3_obj(origin):
                for entry in origin.entries:
                    origin_props[entry.key] = num_to_int(entry.value, 0)
            if is_es3_obj(addition):
                for entry in addition.entries:
                    addition_props[entry.key] = num_to_int(entry.value, 0)
            kungfu = obj_get(node, "kungfuInstances")
            kungfu_count = len(kungfu) if isinstance(kungfu, list) else 0
            protagonist = {
                "instance_id": pid,
                "name": self._char_display_name(node),
                "level": num_to_int(obj_get(node, "m_level"), 1),
                "exp": num_to_int(obj_get(node, "m_exp"), 0),
                "cur_hp": num_to_int(obj_get(state, "curHp"), 0) if state else 0,
                "cur_ep": num_to_int(obj_get(state, "curEp"), 0) if state else 0,
                "kungfu_count": kungfu_count,
                "origin_props": origin_props,
                "addition_props": addition_props,
            }

        factions = []
        fv = self._value_of("factions")
        if is_es3_obj(fv):
            fobj = obj_get(fv, "factions")
            if is_es3_obj(fobj):
                fcat = self.catalog.get("factions", {}) if isinstance(self.catalog, dict) else {}
                for entry in fobj.entries:
                    node = entry.value if is_es3_obj(entry.value) else None
                    uid = num_to_int(obj_get(node, "templeteId"), 0) if node else 0
                    cat = fcat.get(uid, {})
                    factions.append({
                        "uid": entry.key,
                        "template_id": uid,
                        "name": cat.get("ko") or cat.get("zh") or str(uid),
                        "player_fame": num_to_int(obj_get(node, "playerFame"), 0) if node else 0,
                        "discovered": bool(obj_get(node, "IsDiscovered", False)) if node else False,
                    })

        fief_buildings = {}
        for role, key in (("global", "fiefSharedData"), ("game", "privateFiefSharedData")):
            _, bdict = self._ensure_fief_shared(role, key, False)
            if is_es3_obj(bdict):
                for entry in bdict.entries:
                    fief_buildings[entry.key] = num_to_int(entry.value, 0)

        pagoda = {}
        pv = self._value_of("pagoda")
        if is_es3_obj(pv):
            for key in ("CurStage", "CurScore", "HistoryBestStage", "HistoryBestScore"):
                pagoda[key] = num_to_int(obj_get(pv, key), 0)

        game_time = {}
        tv = self._value_of("time")
        if is_es3_obj(tv):
            for key in ("Year", "Month", "Day", "Dhour", "Quarter"):
                game_time[key] = num_to_int(obj_get(tv, key), 0)
            if obj_has(tv, "QuaterOfDay"):
                game_time["QuaterOfDay"] = num_to_str(obj_get(tv, "QuaterOfDay"), "0")
            sim = obj_get(tv, "simulatedTime")
            if is_es3_obj(sim) and obj_has(sim, "ticks"):
                game_time["ticks"] = num_to_str(obj_get(sim, "ticks"), "0")

        return {
            "files": files,
            "currencies": currencies,
            "inventory_count": inventory_count,
            "protagonist": protagonist,
            "factions": factions,
            "fief_buildings": fief_buildings,
            "pagoda": pagoda,
            "game_time": game_time,
        }

    def _require_player_team(self):
        self._assert_role_writable("playerTeam")
        pv = self._player_team_value()
        if not is_es3_obj(pv):
            raise ValueError("화폐 편집에 필요한 SaveObjectPlayerTeam.save 파일이 로드되지 않았습니다.")
        return pv

    def get_currency(self, cid):
        pv = self._player_team_value()
        if not is_es3_obj(pv):
            return 0
        inv = obj_get(pv, "playerTeamInventory")
        curr = obj_get(inv, "currencies") if is_es3_obj(inv) else None
        if not is_es3_obj(curr):
            return 0
        return num_to_int(obj_get(curr, str(cid)), 0)

    def set_currency(self, currency_id, value):
        cid = validate_safe_int(currency_id, 0, 9, "화폐 ID")
        max_val = 999999999 if cid == 0 else 99999999
        if isinstance(self.catalog, dict) and isinstance(self.catalog.get("currencies"), list):
            for entry in self.catalog["currencies"]:
                if isinstance(entry, dict) and entry.get("id") == cid and isinstance(entry.get("max"), int):
                    max_val = entry["max"]
                    break
        val = validate_safe_int(value, 0, max_val, "화폐")
        pv = self._require_player_team()
        inv = obj_get(pv, "playerTeamInventory")
        if not is_es3_obj(inv):
            inv = make_obj()
            obj_set(pv, "playerTeamInventory", inv)
        curr = obj_get(inv, "currencies")
        if not is_es3_obj(curr):
            curr = make_obj()
            obj_set(inv, "currencies", curr)
        obj_set(curr, str(cid), make_num(val), quoted=False)
        self._mark_dirty("playerTeam")

    def add_item(self, uid, count=1):
        uid = validate_safe_int(uid, 1, 2147483647, "UID")
        count = validate_safe_int(count, 1, 99999, "수량")
        pv = self._require_player_team()
        if not (isinstance(self.catalog, dict)
                and self.catalog.get("_loaded_ok", bool(self.catalog.get("items")))
                and isinstance(self.catalog.get("items"), dict)
                and len(self.catalog["items"]) > 0):
            raise ValueError("아이템 카탈로그를 불러오지 못해 아이템을 추가할 수 없습니다.")
        if uid not in self.catalog["items"]:
            raise ValueError(f"카탈로그에 존재하지 않는 아이템 UID입니다: {uid}")
        meta = self.catalog["items"][uid]
        stackable = bool(meta.get("stackable", 0))
        if not stackable and count > 20:
            raise ValueError(f"비스택 장비 아이템은 한 번에 최대 20개까지 추가할 수 있습니다: {count}")

        inv = obj_get(pv, "playerTeamInventory")
        if not is_es3_obj(inv):
            inv = make_obj()
            obj_set(pv, "playerTeamInventory", inv)
        contents = obj_get(inv, "contents")
        if not isinstance(contents, list):
            contents = []
            obj_set(inv, "contents", contents)

        def new_item(stack):
            return make_obj([
                ("m_templeteId", make_num(uid), True),
                ("m_stack", make_num(stack), True),
                ("modifyData", None, True),
                ("IsNew", True, True),
                ("IsForbidden", False, True),
            ])

        if stackable:
            remain = count
            for item in contents:
                if not is_es3_obj(item):
                    continue
                if num_to_int(obj_get(item, "m_templeteId"), -1) != uid:
                    continue
                if obj_get(item, "modifyData") is not None:
                    continue
                stack = num_to_int(obj_get(item, "m_stack"), 0)
                add = min(999999 - stack, remain)
                if add > 0:
                    obj_set(item, "m_stack", make_num(stack + add))
                    remain -= add
                if remain <= 0:
                    break
            while remain > 0:
                add = min(999999, remain)
                contents.append(new_item(add))
                remain -= add
        else:
            for _ in range(count):
                contents.append(new_item(1))
        self._mark_dirty("playerTeam")

    def set_char_basic(self, level=None, cur_hp=None, cur_ep=None, instance_id=None):
        if level is not None:
            level = validate_safe_int(level, 1, 999, "레벨")
        if cur_hp is not None:
            cur_hp = validate_safe_int(cur_hp, 0, 999999999, "HP")
        if cur_ep is not None:
            cur_ep = validate_safe_int(cur_ep, 0, 999999999, "EP")
        _, node = self._require_character(instance_id)
        state = None
        if cur_hp is not None or cur_ep is not None:
            state = self._team_state(node, True)
        if level is not None:
            obj_set(node, "m_level", make_num(level))
        if is_es3_obj(state):
            if cur_hp is not None:
                obj_set(state, "curHp", make_num(cur_hp))
            if cur_ep is not None:
                obj_set(state, "curEp", make_num(cur_ep))
        self._mark_dirty("characters")

    def set_char_prop(self, prop_spec, value, instance_id=None):
        val = validate_safe_int(value, -999999999, 999999999, "능력치")
        _, node = self._require_character(instance_id)
        if ":" in prop_spec:
            kind, key = prop_spec.split(":", 1)
            kind = kind.strip().lower()
            if kind not in ("origin", "addition"):
                raise ValueError(f"알 수 없는 능력치 종류입니다: {kind}")
            if not key.strip():
                raise ValueError("능력치 키가 비어 있습니다.")
            key = key.strip()
        else:
            key = prop_spec.strip()
            if not key:
                raise ValueError("능력치 키가 비어 있습니다.")
            kind = "addition" if key.startswith("能力_") else "origin"
        props = self._find_prop_obj(node, "addition" if kind == "addition" else "origin", True)
        if not is_es3_obj(props):
            raise ValueError("능력치 저장 노드를 찾을 수 없습니다.")
        obj_set(props, key, make_num(val), quoted=True)
        self._mark_dirty("characters")

    def max_kungfu(self, party=False, instance_id=None):
        self._assert_role_writable("characters")
        if not is_es3_obj(self._created_characters()):
            raise ValueError("캐릭터 저장 파일을 찾을 수 없습니다.")
        if party or instance_id is None:
            self._assert_role_writable("playerTeam")
        if party:
            ids = self._player_team_ids()
            if not ids and instance_id is not None:
                ids = [instance_id]
            if not ids:
                pid = self._protagonist_id()
                if pid is not None:
                    ids = [pid]
            if not ids:
                raise ValueError("파티원 목록을 식별할 수 없습니다.")
            nodes = [self._require_character(cid)[1] for cid in ids]
            if not nodes:
                raise ValueError("파티원 캐릭터 노드를 찾을 수 없습니다.")
        else:
            _, node = self._require_character(instance_id)
            nodes = [node]

        kcat = self.catalog.get("kungfu", {}) if isinstance(self.catalog, dict) else {}
        for node in nodes:
            arr = obj_get(node, "kungfuInstances")
            if not isinstance(arr, list):
                continue
            for inst in arr:
                if not is_es3_obj(inst):
                    continue
                uid = num_to_int(obj_get(inst, "m_templeteUid"), 0)
                meta = kcat.get(uid, {})
                max_level = int(meta.get("maxLevel", 10) or 10)
                max_level = max(1, min(15, max_level))
                old = num_to_int(obj_get(inst, "m_level"), 1)
                if old < max_level:
                    obj_set(inst, "m_level", make_num(max_level))
            self._mark_dirty("characters")

    def _validate_fief_shared_for_write(self, role, key):
        root_val = self._value_of(role)
        if not is_es3_obj(root_val):
            raise ValueError(f"{key} 상위 객체 형식이 올바르지 않습니다.")
        if not obj_has(root_val, key) or obj_get(root_val, key) is None:
            return
        shared = obj_get(root_val, key)
        if not is_es3_obj(shared):
            raise ValueError(f"{key} 객체 형식이 올바르지 않습니다.")
        if obj_has(shared, "value"):
            inner = obj_get(shared, "value")
            if not is_es3_obj(inner):
                raise ValueError(f"{key}.value 객체 형식이 올바르지 않습니다.")
            target_shared = inner
        else:
            target_shared = shared
        if obj_has(target_shared, "buildingLevelDict") and obj_get(target_shared, "buildingLevelDict") is not None:
            if not is_es3_obj(obj_get(target_shared, "buildingLevelDict")):
                raise ValueError(f"{key}.buildingLevelDict 객체 형식이 올바르지 않습니다.")

    def _ensure_fief_shared(self, role, key, create=False):
        value = self._value_of(role)
        if not is_es3_obj(value):
            return None, None

        if not create:
            shared = obj_get(value, key) if obj_has(value, key) else None
            if not is_es3_obj(shared):
                return value, None
            if obj_has(shared, "value"):
                inner = obj_get(shared, "value")
                if not is_es3_obj(inner):
                    return value, None
                shared = inner
            bdict = obj_get(shared, "buildingLevelDict") if obj_has(shared, "buildingLevelDict") else None
            return value, (bdict if is_es3_obj(bdict) else None)

        self._validate_fief_shared_for_write(role, key)

        shared = obj_get(value, key) if obj_has(value, key) else None
        if not is_es3_obj(shared):
            shared = make_obj()
            obj_set(value, key, shared)
        elif obj_has(shared, "value"):
            shared = obj_get(shared, "value")

        bdict = obj_get(shared, "buildingLevelDict") if obj_has(shared, "buildingLevelDict") else None
        if not is_es3_obj(bdict):
            bdict = make_obj()
            obj_set(shared, "buildingLevelDict", bdict)
        return value, bdict

    def set_fief_building(self, save_id, level):
        self._assert_role_writable("global")
        self._assert_role_writable("game")
        sid = validate_safe_int(save_id, 1, 2147483647, "건물 ID")
        level = validate_safe_int(level, 0, 5, "건물 레벨")
        if sid not in (112, 104, 110, 113, 114, 102, 98):
            raise ValueError(f"지원하지 않는 가원 건물 ID입니다: {sid}")
        if not ("game" in self.files and "global" in self.files and is_es3_obj(self._value_of("global")) and is_es3_obj(self._value_of("game"))):
            raise ValueError("가원 편집에는 SaveObjectGame.save와 SaveObjectGameGlobal.save가 모두 필요합니다.")

        self._validate_fief_shared_for_write("global", "fiefSharedData")
        self._validate_fief_shared_for_write("game", "privateFiefSharedData")

        value, bdict = self._ensure_fief_shared("global", "fiefSharedData", True)
        if is_es3_obj(bdict):
            obj_set(bdict, str(sid), make_num(level), quoted=False)
            self._mark_dirty("global")

        game_value, game_bdict = self._ensure_fief_shared("game", "privateFiefSharedData", True)
        if is_es3_obj(game_bdict):
            obj_set(game_bdict, str(sid), make_num(level), quoted=False)
            self._mark_dirty("game")

    def set_fief_all_max(self):
        for save_id in (112, 104, 110, 113, 114, 102, 98):
            self.set_fief_building(save_id, 5)

    def _raise_props(self, prop_obj, pairs):
        if not is_es3_obj(prop_obj):
            return
        for key, val in pairs:
            old = num_to_int(obj_get(prop_obj, key), 0)
            if old < val:
                obj_set(prop_obj, key, make_num(val), quoted=True)

    def apply_preset(self, preset_id, instance_id=None):
        if preset_id == "wealth_package":
            self._assert_role_writable("playerTeam")
            if self._file("characters") is not None:
                self._assert_role_writable("characters")
            node = None
            if instance_id is not None or is_es3_obj(self._created_characters()):
                _, node = self._require_character(instance_id)
            for cid, target in ((0, 99999999), (1, 99999), (2, 999999), (3, 999999)):
                self.set_currency(cid, max(self.get_currency(cid), target))
            if node is not None:
                origin = self._find_prop_obj(node, "origin", True)
                self._raise_props(origin, (("冲穴点数", 999), ("江湖历练", 999999)))
                self._mark_dirty("characters")
        elif preset_id == "hero_core_max":
            _, node = self._require_character(instance_id)
            origin = self._find_prop_obj(node, "origin", True)
            self._raise_props(origin, (
                ("臂力", 25), ("体质", 25), ("敏捷", 25), ("悟性", 25), ("福缘", 25),
                ("冲穴点数", 999), ("江湖历练", 999999), ("武学常识", 500), ("实战能力", 500),
            ))
            self._mark_dirty("characters")
        elif preset_id == "hero_all_life_skills":
            _, node = self._require_character(instance_id)
            addition = self._find_prop_obj(node, "addition", True)
            if is_es3_obj(addition):
                for key in self.catalog.get("life_skill_keys", []):
                    old = num_to_int(obj_get(addition, key), 0)
                    obj_set(addition, key, make_num(max(old, 5)), quoted=True)
            self._mark_dirty("characters")
        elif preset_id == "hero_virtue_max":
            _, node = self._require_character(instance_id)
            origin = self._find_prop_obj(node, "origin", True)
            if is_es3_obj(origin):
                for key in ("仁德", "义气", "礼节", "智慧", "信用", "勇气"):
                    obj_set(origin, key, make_num(100), quoted=True)
            self._mark_dirty("characters")
        elif preset_id == "party_kungfu_max":
            self._assert_role_writable("playerTeam")
            pre_ids = self._player_team_ids() or ([instance_id] if instance_id is not None else [])
            if not pre_ids:
                pid = self._protagonist_id()
                if pid is not None:
                    pre_ids = [pid]
            for cid in pre_ids:
                if cid is None:
                    continue
                self._validate_team_state_for_write(self._require_character(cid)[1])
            self.max_kungfu(party=True, instance_id=instance_id)
            ids = self._player_team_ids() or ([instance_id] if instance_id is not None else [self._protagonist_id()])
            for cid in ids:
                if cid is None:
                    continue
                node = self._get_character(cid)
                if not is_es3_obj(node):
                    continue
                origin = self._find_prop_obj(node, "origin", False)
                life = num_to_int(obj_get(origin, "生命"), 0) if is_es3_obj(origin) else 0
                inner = num_to_int(obj_get(origin, "内力"), 0) if is_es3_obj(origin) else 0
                state = self._team_state(node, True)
                if is_es3_obj(state):
                    old_hp = num_to_int(obj_get(state, "curHp"), 0)
                    old_ep = num_to_int(obj_get(state, "curEp"), 0)
                    obj_set(state, "curHp", make_num(max(old_hp, life, 9999)))
                    obj_set(state, "curEp", make_num(max(old_ep, inner, 9999)))
                self._mark_dirty("characters")
        elif preset_id == "fief_all_max":
            self.set_fief_all_max()
        else:
            raise ValueError(f"알 수 없는 프리셋입니다: {preset_id}")

    def save_modified(self, force=False, ignore_running_game=False, update_timestamp=False, fault_injector=None, rollback_fault_injector=None):
        dirty = [(role, info) for role, info in list(self.files.items()) if info.get("dirty")]
        if not dirty:
            return []
        for role, _ in dirty:
            self._assert_role_writable(role.split("#", 1)[0])
        saved_timestamps = []
        entries = []
        try:
            for role, info in dirty:
                parsed = info["parsed"]
                if update_timestamp:
                    ts = obj_get(parsed, "TimeStamp")
                    if is_es3_obj(ts) and obj_has(ts, "value"):
                        saved_timestamps.append((ts, obj_get(ts, "value")))
                        obj_set(ts, "value", make_num(int(time.time())))
                new_text = stringify_es3_json(parsed)
                target = ensure_no_symlinks(info["path"])
                entries.append({
                    "role": role,
                    "target_path": target,
                    "new_text": new_text,
                    "mode": info.get("mode", "aes-gzip"),
                    "password": self.password,
                    "expected_sha256": info.get("loaded_sha256"),
                    "expect_exists": True,
                })
            results = atomic_write_save_batch(
                entries,
                force=force,
                ignore_running_game=ignore_running_game,
                fault_injector=fault_injector,
                rollback_fault_injector=rollback_fault_injector,
            )
        except Exception:
            for ts, old_value in saved_timestamps:
                obj_set(ts, "value", old_value)
            raise

        out = []
        by_role = {}
        for res in results:
            by_role[res["role"]] = res
        for role, info in dirty:
            res = by_role.get(role)
            if res is None:
                continue
            info["dirty"] = False
            info["orig_bytes"] = res["raw_bytes"]
            info["loaded_sha256"] = res["sha256"]
            out.append((role, {
                "target": res["target"],
                "backup": res["backup"],
                "bytes_written": res["bytes_written"],
                "sha256": res["sha256"],
            }))
        return out



def _configure_stdio_utf8() -> None:
    for stream_name in ("stdout", "stderr"):
        stream = getattr(sys, stream_name, None)
        if (
            stream is not None
            and hasattr(stream, "reconfigure")
            and getattr(stream, "buffer", None) is not None
        ):
            try:
                stream.reconfigure(encoding="utf-8", errors="backslashreplace")
            except (AttributeError, OSError, ValueError):
                pass


def _safe_print(*args, file=None) -> None:
    target = sys.stdout if file is None else file
    try:
        print(*args, file=target)
    except UnicodeEncodeError:
        encoding = getattr(target, "encoding", None) or "utf-8"
        safe_args = [
            str(arg).encode(encoding, errors="backslashreplace").decode(encoding, errors="replace")
            for arg in args
        ]
        print(*safe_args, file=target)


def cmd_inspect(args) -> int:
    editor = SaveSlotEditor(args.path, password=args.password)
    s = editor.inspect_summary()
    if getattr(args, "json", False):
        _safe_print(json.dumps(s, ensure_ascii=False, indent=2))
        return 0

    _safe_print(f"Save: {args.path}")

    _safe_print("Files:")
    for f in s.get("files", []):
        _safe_print(f"  {f.get('role', '?')}: {f.get('path', '?')} [{f.get('mode', '?')}]")

    _safe_print("Currencies:")
    for cid, value in s.get("currencies", {}).items():
        _safe_print(f"  {cid}: {value}")

    _safe_print(f"Inventory count: {s.get('inventory_count', 0)}")

    p = s.get("protagonist")
    if p is None:
        _safe_print("Protagonist: None")
    else:
        _safe_print("Protagonist:")
        for key in ("instance_id", "name", "level", "exp", "cur_hp", "cur_ep", "kungfu_count", "origin_props", "addition_props"):
            if key in p:
                _safe_print(f"  {key}: {p[key]}")

    _safe_print("Factions:")
    for faction in s.get("factions", []):
        _safe_print(f"  {faction.get('uid')}: {faction.get('name')} "
                    f"(template={faction.get('template_id')}, "
                    f"fame={faction.get('player_fame')}, "
                    f"discovered={faction.get('discovered')})")

    _safe_print("Fief buildings:")
    for bid, level in s.get("fief_buildings", {}).items():
        _safe_print(f"  {bid}: {level}")

    _safe_print("Pagoda:")
    for key, value in s.get("pagoda", {}).items():
        _safe_print(f"  {key}: {value}")

    _safe_print("Game time:")
    for key, value in s.get("game_time", {}).items():
        _safe_print(f"  {key}: {value}")

    return 0


def _ensure_distinct_io_paths(inp: pathlib.Path, out: pathlib.Path) -> None:
    if os.path.normcase(str(inp)) == os.path.normcase(str(out)):
        raise ValueError("입력 파일과 출력 파일 경로가 동일할 수 없습니다.")
    if out.exists():
        if out.is_dir():
            raise IsADirectoryError(f"출력 경로가 디렉터리입니다: {out}")
        if os.path.samefile(str(inp), str(out)):
            raise ValueError("입력 파일과 출력 파일이 동일한 파일(하드링크 포함)을 가리킵니다.")


def _write_output_file_atomic(
    out,
    data: bytes,
    overwrite: bool = False,
    writer_hook=None,
    check_game: bool = False,
    force: bool = False,
    ignore_running_game: bool = False,
) -> None:
    out = ensure_no_symlinks(out)
    if out.exists():
        if out.is_dir():
            raise IsADirectoryError(f"출력 경로가 디렉터리입니다: {out}")
        if not overwrite:
            raise ValueError(f"출력 파일이 이미 존재합니다(--overwrite 필요): {out}")

    expect_exists = None if overwrite else False

    with PinnedDirectory(out.parent, create=True) as pin:
        release = pin.acquire_leaf_lock(out.name)
        try:
            existed = pin.exists_leaf(out.name)
            if existed and stat.S_ISDIR(pin.lstat_leaf(out.name).st_mode):
                raise IsADirectoryError(f"출력 경로가 디렉터리입니다: {out}")
            if expect_exists is False and existed:
                raise FileExistsError(f"출력 파일이 이미 존재합니다(--overwrite 필요): {out}")

            if existed:
                orig_bytes = pin.read_leaf_bytes(out.name)
                orig_hash = sha256_hex(orig_bytes)
                backup_name = "%s.backup-%s-%d-%s.bak" % (
                    out.name,
                    time.strftime("%Y%m%d%H%M%S", time.gmtime()),
                    os.getpid(),
                    uuid.uuid4().hex[:8],
                )
                pending_name = "%s.pending-%d-%s.tmp" % (
                    out.name,
                    os.getpid(),
                    uuid.uuid4().hex[:8],
                )
                def _cleanup_staged():
                    for name in (pending_name, backup_name):
                        try:
                            pin.unlink_leaf(name)
                        except OSError:
                            pass

                try:
                    pin.write_exclusive_leaf(backup_name, orig_bytes, writer_hook=writer_hook)
                    pin.write_exclusive_leaf(pending_name, data, writer_hook=writer_hook)
                    if check_game:
                        check_wulin_not_running(force=force, ignore_running_game=ignore_running_game)
                    if not pin.exists_leaf(out.name) or sha256_hex(pin.read_leaf_bytes(out.name)) != orig_hash:
                        raise ValueError(f"출력 파일이 쓰기 준비 중 외부에서 수정되었습니다: {out}")
                except BaseException:
                    _cleanup_staged()
                    raise
                try:
                    pin.replace_leaf(pending_name, out.name)
                except BaseException:
                    try:
                        pin.unlink_leaf(pending_name)
                    except OSError:
                        pass
                    raise
            else:
                if check_game:
                    check_wulin_not_running(force=force, ignore_running_game=ignore_running_game)
                pin.write_exclusive_leaf(
                    out.name, data, writer_hook=writer_hook,
                    before_publish=(lambda: check_wulin_not_running(force=force, ignore_running_game=ignore_running_game)) if check_game else None
                )
        finally:
            release()


def cmd_decrypt(args) -> int:
    inp = ensure_no_symlinks(args.input)
    out = ensure_no_symlinks(args.output)

    if not inp.exists():
        raise FileNotFoundError(f"입력 파일을 찾을 수 없습니다: {inp}")
    if inp.is_dir():
        raise IsADirectoryError(f"입력 경로가 디렉터리입니다: {inp}")
    if not inp.is_file():
        raise ValueError(f"일반 파일이 아닙니다: {inp}")
    _ensure_distinct_io_paths(inp, out)

    overwrite = bool(getattr(args, "overwrite", False))
    force_flag = bool(getattr(args, "force", False))
    ignore_flag = bool(getattr(args, "ignore_running_game", False))
    must_check_game = overwrite or out.exists() or out.suffix.lower() in (".save", ".es3")
    if must_check_game:
        check_wulin_not_running(force=force_flag, ignore_running_game=ignore_flag)

    inp, raw_inp = read_regular_file_pinned(inp)
    decoded = decode_es3_bytes(raw_inp, password=args.password)
    ast = parse_es3_json(decoded["text"])

    try:
        out_bytes = decoded["text"].encode("utf-8")
    except UnicodeEncodeError:
        out_bytes = stringify_es3_json(ast).encode("utf-8")

    _write_output_file_atomic(
        out,
        out_bytes,
        overwrite=overwrite,
        check_game=must_check_game,
        force=force_flag,
        ignore_running_game=ignore_flag,
    )
    _safe_print(f"복호화 완료: {out}")
    return 0


def cmd_encrypt(args) -> int:
    inp = ensure_no_symlinks(args.input)
    out = ensure_no_symlinks(args.output)

    if not inp.exists():
        raise FileNotFoundError(f"입력 파일을 찾을 수 없습니다: {inp}")
    if inp.is_dir():
        raise IsADirectoryError(f"입력 경로가 디렉터리입니다: {inp}")
    if not inp.is_file():
        raise ValueError(f"일반 파일이 아닙니다: {inp}")
    _ensure_distinct_io_paths(inp, out)

    if out.exists():
        if out.is_dir():
            raise IsADirectoryError(f"출력 경로가 디렉터리입니다: {out}")
        if not getattr(args, "overwrite", False):
            raise ValueError(f"출력 파일이 이미 존재합니다(--overwrite 필요): {out}")

    try:
        inp, raw_inp = read_regular_file_pinned(inp)
        _assert_decompressed_limit(
            len(raw_inp[3:] if raw_inp.startswith(b"\xef\xbb\xbf") else raw_inp),
            args.mode,
            inp,
        )
        raw_text = raw_inp.decode("utf-8", errors="strict")
    except UnicodeDecodeError as exc:
        raise ValueError(f"입력 JSON 파일을 UTF-8로 디코딩할 수 없습니다: {inp}") from exc

    if raw_text.startswith("\ufeff"):
        raw_text = raw_text[1:]

    ast = parse_es3_json(raw_text)
    canonical = stringify_es3_json(ast)
    _assert_decompressed_limit(len(canonical.encode("utf-8")), args.mode, out)

    atomic_write_save(
        out,
        canonical,
        mode=args.mode,
        password=args.password,
        force=bool(getattr(args, "force", False)),
        ignore_running_game=bool(getattr(args, "ignore_running_game", False)),
        expect_exists=(None if getattr(args, "overwrite", False) else False),
        create_parent=True,
    )
    _safe_print(f"암호화 완료: {out}")
    return 0


def cmd_edit(args) -> int:
    ignore_game = bool(getattr(args, "ignore_running_game", False))
    check_wulin_not_running(
        force=bool(getattr(args, "force", False)),
        ignore_running_game=ignore_game,
    )

    editor = SaveSlotEditor(args.path, password=args.password)

    char_uid = getattr(args, "char_uid", None)
    if char_uid is not None:
        char_uid = validate_safe_int(char_uid, 1, 2147483647, "캐릭터 UID")

    for preset_id in (getattr(args, "preset", None) or []):
        editor.apply_preset(preset_id, instance_id=char_uid)

    currency_args = (
        (0, "coin"),
        (1, "gold"),
        (2, "tribute"),
        (3, "pagoda_coin"),
    )
    for cid, attr_name in currency_args:
        value = getattr(args, attr_name, None)
        if value is not None:
            editor.set_currency(cid, value)

    for spec in (getattr(args, "add_item", None) or []):
        if ":" in spec:
            uid_text, count_text = spec.split(":", 1)
            uid = validate_safe_int(uid_text, 1, 2147483647, "UID")
            count = validate_safe_int(count_text, 1, 99999, "수량")
        else:
            uid = validate_safe_int(spec, 1, 2147483647, "UID")
            count = 1
        if uid is None or count is None:
            raise ValueError(f"invalid --add-item value: {spec!r}")
        editor.add_item(uid, count)

    if any(getattr(args, name, None) is not None
           for name in ("char_level", "cur_hp", "cur_ep")):
        editor.set_char_basic(
            level=getattr(args, "char_level", None),
            cur_hp=getattr(args, "cur_hp", None),
            cur_ep=getattr(args, "cur_ep", None),
            instance_id=char_uid,
        )

    for spec in (getattr(args, "set_prop", None) or []):
        if "=" not in spec:
            raise ValueError(f"--set-prop requires KEY=INT: {spec!r}")
        key, value_text = spec.split("=", 1)
        key = key.strip()
        if not key:
            raise ValueError(f"--set-prop requires non-empty KEY: {spec!r}")
        value = validate_safe_int(value_text, -999999999, 999999999, key)
        if value is None:
            raise ValueError(f"invalid --set-prop value: {spec!r}")
        editor.set_char_prop(key, value, instance_id=char_uid)

    if getattr(args, "max_kungfu", False):
        editor.max_kungfu(party=False, instance_id=char_uid)

    if getattr(args, "fief_max", False):
        editor.set_fief_all_max()

    for spec in (getattr(args, "fief", None) or []):
        if "=" in spec:
            sid_text, lvl_text = spec.split("=", 1)
        elif ":" in spec:
            sid_text, lvl_text = spec.split(":", 1)
        else:
            raise ValueError(f"--fief requires ID=LEVEL or ID:LEVEL: {spec!r}")
        sid = validate_safe_int(sid_text.strip(), 1, 2147483647, "가원 건물 ID")
        lvl = validate_safe_int(lvl_text.strip(), 0, 999999999, "가원 건물 레벨")
        if sid is None or lvl is None:
            raise ValueError(f"invalid --fief value: {spec!r}")
        editor.set_fief_building(sid, lvl)

    saved = editor.save_modified(
        force=bool(getattr(args, "force", False)),
        ignore_running_game=ignore_game,
        update_timestamp=args.update_timestamp,
    )
    if not saved:
        raise ValueError("수정된 세이브 파일이 없습니다. 편집 옵션과 대상 파일을 확인하세요.")
    for role, info in saved:
        _safe_print(
            f"Saved {role}: target={info.get('target')}, "
            f"backup={info.get('backup')}, "
            f"bytes={info.get('bytes_written')}, "
            f"sha256={info.get('sha256')}"
        )

    return 0


def create_http_server(host="127.0.0.1", port=8765, html_path=None):
    html_path = pathlib.Path(html_path) if html_path is not None else (
        SCRIPT_DIR / "dist" / "HerosAdventureSaveEditor-v1.0.html"
    )

    if not html_path.exists():
        raise FileNotFoundError(f"HTML 파일을 찾을 수 없습니다: {html_path}")

    html_bytes = html_path.read_bytes()

    class Handler(http.server.BaseHTTPRequestHandler):
        timeout = 5.0

        def _send_html(self, include_body=True):
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(html_bytes)))
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("X-Frame-Options", "DENY")
            self.end_headers()
            if include_body:
                self.wfile.write(html_bytes)

        def _send_not_found(self, include_body=True):
            body = b"Not Found"
            self.send_response(404)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("X-Frame-Options", "DENY")
            self.end_headers()
            if include_body:
                self.wfile.write(body)

        def _send_game_status(self, include_body=True):
            st = detect_wulin_running()
            payload = {
                "ok": True,
                "status": st,
                "running": (True if st == "RUNNING" else (False if st == "NOT_RUNNING" else None)),
                "canDirectWrite": (st == "NOT_RUNNING"),
            }
            body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("X-Frame-Options", "DENY")
            self.end_headers()
            if include_body:
                self.wfile.write(body)

        def do_GET(self):
            path = self.path.split("?", 1)[0].split("#", 1)[0]
            if path == "/api/game-status":
                self._send_game_status(include_body=True)
            elif path in ("/", "/index.html", "/HerosAdventureSaveEditor-v1.0.html"):
                self._send_html(include_body=True)
            else:
                self._send_not_found(include_body=True)

        def do_HEAD(self):
            path = self.path.split("?", 1)[0].split("#", 1)[0]
            if path == "/api/game-status":
                self._send_game_status(include_body=False)
            elif path in ("/", "/index.html", "/HerosAdventureSaveEditor-v1.0.html"):
                self._send_html(include_body=False)
            else:
                self._send_not_found(include_body=False)

        def log_message(self, fmt, *args):
            pass

    class _ThreadingHTTPServer(http.server.ThreadingHTTPServer):
        daemon_threads = True
        block_on_close = False

    return _ThreadingHTTPServer((host, port), Handler)


def cmd_serve(args) -> int:
    html_path = SCRIPT_DIR / "dist" / "HerosAdventureSaveEditor-v1.0.html"
    if not html_path.exists():
        _safe_print(f"오류: HTML 파일을 찾을 수 없습니다: {html_path}", file=sys.stderr)
        return 1

    server = create_http_server(args.host, args.port, html_path=html_path)
    _safe_print(f"웹서버 실행 중: http://{args.host}:{args.port}/")
    _safe_print("Ctrl+C 로 종료합니다.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        _safe_print("\n웹서버를 종료합니다.")
    finally:
        server.server_close()
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="heros_adventure_editor.py",
        description="Hero's Adventure 세이브 에디터",
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    p_inspect = subparsers.add_parser("inspect", help="세이브 정보 출력")
    p_inspect.add_argument("path", help="세이브 폴더 또는 .save 파일")
    p_inspect.add_argument("--password", default="Meow", help="ES3 암호")
    p_inspect.add_argument("--json", action="store_true", help="JSON으로 출력")
    p_inspect.set_defaults(func=cmd_inspect)

    p_decrypt = subparsers.add_parser("decrypt", help="세이브 복호화")
    p_decrypt.add_argument("input", help="입력 .save 파일")
    p_decrypt.add_argument("-o", "--output", required=True, help="출력 JSON 파일")
    p_decrypt.add_argument("--password", default="Meow", help="ES3 암호")
    p_decrypt.add_argument(
        "--overwrite",
        action="store_true",
        help="기존 출력 JSON 파일이 있으면 .bak 백업 후 덮어쓰기",
    )
    p_decrypt.add_argument(
        "--force",
        action="store_true",
        help="실행 중인 게임 확인을 건너뜁니다",
    )
    p_decrypt.add_argument(
        "--ignore-running-game",
        action="store_true",
        help="실행 중인 게임 검사를 무시합니다",
    )
    p_decrypt.set_defaults(func=cmd_decrypt)

    p_encrypt = subparsers.add_parser("encrypt", help="JSON을 세이브로 암호화")
    p_encrypt.add_argument("input", help="입력 JSON 파일")
    p_encrypt.add_argument("-o", "--output", required=True, help="출력 .save 파일")
    p_encrypt.add_argument("--password", default="Meow", help="ES3 암호")
    p_encrypt.add_argument(
        "--mode",
        choices=["aes-gzip", "aes-plain", "gzip", "plain"],
        default="aes-gzip",
        help="저장 모드",
    )
    p_encrypt.add_argument(
        "--force",
        action="store_true",
        help="실행 중인 Wulin.exe 보호 검사를 강제로 우회(주의, --ignore-running-game 호환 별칭)",
    )
    p_encrypt.add_argument(
        "--overwrite",
        action="store_true",
        help="기존 출력 세이브 파일이 있으면 .bak 백업 후 덮어쓰기",
    )
    p_encrypt.add_argument(
        "--ignore-running-game",
        action="store_true",
        help="실행 중인 Wulin.exe 보호 검사를 강제로 우회(주의)",
    )
    p_encrypt.set_defaults(func=cmd_encrypt)

    p_edit = subparsers.add_parser("edit", help="세이브 수정")
    p_edit.add_argument("path", help="세이브 폴더 또는 .save 파일")
    p_edit.add_argument("--password", default="Meow", help="ES3 암호")
    p_edit.add_argument(
        "--force",
        action="store_true",
        help="실행 중인 Wulin.exe 보호 검사를 강제로 우회(주의, --ignore-running-game 호환 별칭)",
    )
    p_edit.add_argument(
        "--ignore-running-game",
        action="store_true",
        help="실행 중인 Wulin.exe 보호 검사를 강제로 우회(주의)",
    )
    p_edit.add_argument("--update-timestamp", action="store_true", help="저장 시각 갱신")
    p_edit.add_argument(
        "--preset",
        action="append",
        choices=[
            "wealth_package",
            "hero_core_max",
            "hero_all_life_skills",
            "hero_virtue_max",
            "party_kungfu_max",
            "fief_all_max",
        ],
        help="프리셋 적용",
    )
    p_edit.add_argument("--coin", type=int, help="동전 수량")
    p_edit.add_argument("--gold", type=int, help="금원보 수량")
    p_edit.add_argument("--tribute", type=int, help="공헌도 수량")
    p_edit.add_argument("--pagoda-coin", type=int, help="통천탑화폐 수량")
    p_edit.add_argument("--add-item", action="append", help="아이템 추가 UID 또는 UID:COUNT")
    p_edit.add_argument("--char-level", type=int, help="주인공 레벨")
    p_edit.add_argument("--cur-hp", type=int, help="현재 HP")
    p_edit.add_argument("--cur-ep", type=int, help="현재 EP")
    p_edit.add_argument("--set-prop", action="append", help="능력치 설정 KEY=INT")
    p_edit.add_argument("--max-kungfu", action="store_true", help="주인공 무공 최대화")
    p_edit.add_argument("--fief-max", action="store_true", help="가원 건물 전체 최대화")
    p_edit.add_argument(
        "--char-uid",
        type=int,
        default=None,
        help="편집할 캐릭터 인스턴스 UID",
    )
    p_edit.add_argument(
        "--hero-uid",
        dest="char_uid",
        type=int,
        help="편집할 주인공 인스턴스 UID(--char-uid 별칭)",
    )
    p_edit.add_argument(
        "--fief",
        action="append",
        help="가원 건물 레벨 설정 ID=LEVEL 또는 ID:LEVEL",
    )
    p_edit.set_defaults(func=cmd_edit)

    p_serve = subparsers.add_parser("serve", help="로컬 웹 에디터 실행")
    p_serve.add_argument("--host", default="127.0.0.1", help="바인드 호스트")
    p_serve.add_argument("--port", type=int, default=8765, help="바인드 포트")
    p_serve.set_defaults(func=cmd_serve)

    return parser


def main(argv=None) -> int:
    _configure_stdio_utf8()
    parser = build_parser()
    args = parser.parse_args(argv)

    try:
        return args.func(args)
    except (ValueError, RuntimeError, OSError, FileNotFoundError) as exc:
        _safe_print(f"오류: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
