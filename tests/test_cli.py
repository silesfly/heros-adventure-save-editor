import hashlib
import io
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
import heros_adventure_editor as cli
import unittest.mock


_ORIG_DETECT_WULIN = cli.detect_wulin_running
def _real_wulin_detection(): return unittest.mock.patch.object(cli, "detect_wulin_running", side_effect=_ORIG_DETECT_WULIN)
def _norm_abs(p): return os.path.normcase(os.path.abspath(str(p)))


def _isolated_detect_wulin():
    if os.environ.get("HASE_SIMULATE_WULIN_RUNNING") == "1":
        return "RUNNING"
    if os.environ.get("HASE_SIMULATE_WULIN_UNKNOWN") == "1":
        return "UNKNOWN"
    return "NOT_RUNNING"


class _IsolatedWulinTestCase(unittest.TestCase):
    def setUp(self):
        super().setUp()
        p = unittest.mock.patch.object(
            cli, "detect_wulin_running", side_effect=_isolated_detect_wulin
        )
        p.start()
        self.addCleanup(p.stop)


class TestPythonCodecAndGuards(_IsolatedWulinTestCase):
    def test_aes_vectors_and_strict_padding(self):
        key = bytes.fromhex("000102030405060708090a0b0c0d0e0f")
        pt = bytes.fromhex("00112233445566778899aabbccddeeff")
        iv = bytes(16)
        ct = cli.aes_cbc_encrypt(pt, key, iv)
        self.assertEqual(ct.hex()[:32], "69c4e0d86a7b0430d8cdb78070b4c55a")
        self.assertEqual(cli.aes_cbc_decrypt(ct, key, iv), pt)
        with self.assertRaises(ValueError):
            cli.aes_cbc_decrypt(ct[:-1], key, iv)
        bad = bytearray(cli.aes_cbc_encrypt(b"hello", key, iv))
        bad[-1] ^= 1
        with self.assertRaises(ValueError):
            cli.aes_cbc_decrypt(bytes(bad), key, iv)

    def test_es3_container_four_modes_and_errors(self):
        text = '{"hello":"소하","line":2}'
        for mode in ("plain", "gzip", "aes-plain", "aes-gzip"):
            data = cli.encode_es3_bytes(text, mode=mode)
            self.assertEqual(cli.decode_es3_bytes(data), {"mode": mode, "text": text})
        aes = cli.encode_es3_bytes(text, mode="aes-gzip", password="Meow")
        with self.assertRaises(ValueError):
            cli.decode_es3_bytes(aes, password="Wrong")
        bad = bytearray(aes)
        bad[len(bad) // 2] ^= 0xFF
        with self.assertRaises(ValueError):
            cli.decode_es3_bytes(bytes(bad))

    def test_es3_ast_unquoted_negative_keys_and_precision(self):
        s = '{0:123,-1:[100401],ticks:656099925099270000,QuaterOfDay:87.67666666666666666666666667,ThirdPlatformId:76561198000000000,"name":"소하"}'
        node = cli.parse_es3_json(s)
        self.assertEqual(cli.stringify_es3_json(node), s)
        self.assertEqual(cli.obj_get(node, "name"), "소하")

    def test_symlink_target_and_parent_blocked(self):
        with tempfile.TemporaryDirectory() as td:
            root = pathlib.Path(td)
            real_dir = root / "real"
            real_dir.mkdir()
            real_file = real_dir / "save.json"
            real_file.write_text("old", encoding="utf-8")

            try:
                link_file = root / "link.json"
                os.symlink(real_file, link_file)
                with self.assertRaises(ValueError):
                    cli.ensure_no_symlinks(link_file)
                with self.assertRaises(ValueError):
                    cli.atomic_write_save(link_file, "new", mode="plain", force=True)

                link_dir = root / "linkdir"
                os.symlink(real_dir, link_dir, target_is_directory=True)
                target = link_dir / "new.json"
                with self.assertRaises(ValueError):
                    cli.ensure_no_symlinks(target)
                with self.assertRaises(ValueError):
                    cli.atomic_write_save(target, "new", mode="plain", force=True)
            except OSError as exc:
                if getattr(exc, "winerror", None) != 1314:
                    raise

            for bad_p in (
                "\\\\server\\share\\Save0\\SaveObjectGame.save",
                "//server/share/Save0",
                "\\\\?\\C:\\Save0",
                "\\\\.\\PhysicalDrive0",
            ):
                with self.assertRaises(ValueError):
                    cli.ensure_no_symlinks(bad_p)

            import types
            from unittest import mock

            real_lstat = os.lstat
            fake_lstat = lambda path_arg, *args, **kwargs: (
                types.SimpleNamespace(st_mode=0o040755, st_file_attributes=0x400)
                if str(path_arg) == str(real_dir)
                else real_lstat(path_arg, *args, **kwargs)
            )
            with mock.patch("os.lstat", side_effect=fake_lstat):
                with self.assertRaises(ValueError):
                    cli.ensure_no_symlinks(real_dir / "save.json")

    def test_wulin_running_guard_and_atomic_backup(self):
        old = os.environ.get("HASE_SIMULATE_WULIN_RUNNING")
        os.environ["HASE_SIMULATE_WULIN_RUNNING"] = "1"
        try:
            with tempfile.TemporaryDirectory() as td:
                root = pathlib.Path(td)
                target = root / "save.json"
                original = b'{"old":1}'
                target.write_bytes(original)
                with self.assertRaises(RuntimeError):
                    cli.atomic_write_save(target, '{"ok":1}', mode="plain", force=False)
                self.assertEqual(target.read_bytes(), original)
                cli.atomic_write_save(target, '{"ok":1}', mode="plain", force=True)
                backups = [p for p in root.iterdir() if ".backup-" in p.name and p.name.endswith(".bak")]
                self.assertTrue(backups)
                self.assertEqual(hashlib.sha256(backups[0].read_bytes()).digest(), hashlib.sha256(original).digest())
        finally:
            if old is None:
                os.environ.pop("HASE_SIMULATE_WULIN_RUNNING", None)
            else:
                os.environ["HASE_SIMULATE_WULIN_RUNNING"] = old

    def test_local_http_server_headers(self):
        with _running_http_server() as base:
            with urllib.request.urlopen(base + "/") as resp:
                self.assertEqual(resp.status, 200)
                self.assertEqual(resp.headers.get("Content-Type"), "text/html; charset=utf-8")
                self.assertEqual(resp.headers.get("X-Content-Type-Options"), "nosniff")
                self.assertEqual(resp.headers.get("X-Frame-Options"), "DENY")
            with self.assertRaises(urllib.error.HTTPError) as cm:
                urllib.request.urlopen(base + "/missing")
            try:
                self.assertEqual(cm.exception.code, 404)
            finally:
                cm.exception.close()


import contextlib
import unittest.mock
from pathlib import Path


@contextlib.contextmanager
def _running_http_server():
    srv = cli.create_http_server("127.0.0.1", 0)
    thread = threading.Thread(target=srv.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{srv.server_address[1]}"
    finally:
        srv.shutdown()
        srv.server_close()
        thread.join(timeout=2)

NODE_MAKE = r'''(async () => {
  const fs = require('fs'), path = require('path');
  const Core = require('./src/editor-core.js');
  const RawCatalog = require('./src/catalog-data.js');
  const files = await Core.createDemoSlotFiles(RawCatalog, 'Meow');
  for (const f of files) {
    const dir = f.name === 'SaveObjectGameGlobal.save' ? process.argv[1] : process.argv[2];
    fs.writeFileSync(path.join(dir, f.name), Buffer.from(f.bytes));
  }
})().catch(e => { console.error(e); process.exit(1); });
'''
NODE_CHECK = r'''(async () => {
  const fs = require('fs'), path = require('path');
  const Core = require('./src/editor-core.js');
  const RawCatalog = require('./src/catalog-data.js');
  const s = Core.createSession(RawCatalog);
  await s.loadFiles(process.argv.slice(1).map(p => ({ name: path.basename(p), bytes: fs.readFileSync(p) })), 'Meow');
  console.log(JSON.stringify({
    currencies: s.getCurrencies(),
    inventory: s.getInventoryItems(),
    protagonist: s.getCharacterDetail('100401'),
    fief: s.getFiefBuildings(),
    playerTeam: s.getRawFileText('playerTeam'),
    time: s.getRawFileText('time')
  }));
})().catch(e => { console.error(e); process.exit(1); });
'''

def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()

def run_node(script, *args):
    subprocess.run(["node", "-e", script, *map(str, args)], cwd=ROOT, check=True, capture_output=True, text=True, encoding="utf-8", env={**os.environ, "PYTHONIOENCODING": "utf-8"})

def node_check(paths):
    p = subprocess.run(["node", "-e", NODE_CHECK, *map(str, paths)], cwd=ROOT, check=True, capture_output=True, text=True, encoding="utf-8", env={**os.environ, "PYTHONIOENCODING": "utf-8"})
    return json.loads(p.stdout)

class TestCrossLanguageAndCli(_IsolatedWulinTestCase):
    def test_node_python_bidirectional_slot_roundtrip_and_cli(self):
        with tempfile.TemporaryDirectory() as td:
            base = Path(td)
            global_dir = base / "Global"
            slot_dir = base / "slot"
            global_dir.mkdir()
            slot_dir.mkdir()
            run_node(NODE_MAKE, global_dir, slot_dir)
            orig_files = list(global_dir.glob("*.save")) + list(slot_dir.glob("*.save"))
            self.assertEqual(len(orig_files), 8)
            orig_hashes = {p.name: sha(p) for p in orig_files}
            buf = io.StringIO()
            with contextlib.redirect_stdout(buf):
                self.assertEqual(cli.main(["inspect", str(slot_dir), "--json"]), 0)
            data = json.loads(buf.getvalue())
            self.assertTrue(data is not None)
            self.assertEqual(data["currencies"]["0"], 50000)
            self.assertEqual(data["inventory_count"], 6)
            self.assertEqual(data["protagonist"]["instance_id"], 100401)
            self.assertEqual(data["protagonist"]["level"], 25)
            time_path = slot_dir / "SaveObjectGameTime.save"
            pagoda_path = slot_dir / "SaveObjectPagoda.save"
            self.assertEqual(cli.main(["decrypt", str(time_path), "-o", str(base / "time.json")]), 0)
            self.assertEqual(cli.main(["encrypt", str(base / "time.json"), "-o", str(base / "time_rt.save"), "--mode", "aes-gzip"]), 0)
            decoded = cli.decode_es3_bytes((base / "time_rt.save").read_bytes())["text"]
            self.assertIn("656099925099270000", decoded)
            self.assertIn("87.67666666666666666666666667", decoded)
            before_baks = {p.name for p in slot_dir.glob("*.bak")}
            with _sim_wulin_running():
                self.assertEqual(cli.main(["edit", str(slot_dir), "--coin", "777"]), 1)
            self.assertEqual({p.name for p in slot_dir.glob("*.bak")}, before_baks)
            self.assertEqual(cli.main(["edit", str(slot_dir), "--preset", "wealth_package", "--preset", "hero_all_life_skills", "--preset", "fief_all_max", "--coin", "123456789", "--add-item", "23301:10", "--add-item", "10164:2", "--char-level", "50", "--cur-hp", "8888", "--set-prop", "臂力=30", "--max-kungfu", "--update-timestamp"]), 0)
            def backups_of(p):
                return list(p.parent.glob(p.name + ".backup-*.bak"))
            modified = []
            for p in orig_files:
                baks = backups_of(p)
                if baks:
                    modified.append((p, baks[0]))
            self.assertEqual(len(modified), 4)
            for p, bak in modified:
                self.assertEqual(sha(bak), orig_hashes[p.name])
            for p in (time_path, pagoda_path):
                self.assertEqual(backups_of(p), [])
                self.assertEqual(sha(p), orig_hashes[p.name])
            got = node_check(orig_files)
            curr = {str(x["id"]): x["value"] for x in got["currencies"]}
            self.assertEqual(curr["0"], 123456789)
            self.assertEqual(curr.get("7", 0), 0)
            self.assertEqual(curr.get("8", 0), 0)
            inv = {}
            for x in got["inventory"]:
                inv.setdefault(x["uid"], []).append(x["count"])
            self.assertEqual(inv["23301"], [25])
            self.assertEqual(len(inv["10164"]), 3)
            pro = got["protagonist"]
            self.assertEqual(pro["m_level"], 50)
            self.assertEqual(pro["curHp"], 8888)
            self.assertEqual(pro["originProps"]["臂力"], 30)
            self.assertEqual(len([k for k in pro["originProps"] if k.startswith("能力_")]) + len([k for k in pro["additionProps"] if k.startswith("能力_")]), 26)
            self.assertTrue(all(k["level"] == k["maxLevel"] for k in pro["kungfuList"]))
            self.assertTrue(all(x["level"] == 5 for x in got["fief"]))
            self.assertIn("-1:[100401,10005]", got["playerTeam"])
            self.assertIn("0:123456789", got["playerTeam"])
            self.assertIn("656099925099270000", got["time"])
            self.assertIn("87.67666666666666666666666667", got["time"])


def _sim_wulin_running():
    return unittest.mock.patch.dict(os.environ, {"HASE_SIMULATE_WULIN_RUNNING": "1"})


def _run_cli(*argv):
    out_buf = io.StringIO()
    err_buf = io.StringIO()
    with contextlib.redirect_stdout(out_buf), contextlib.redirect_stderr(err_buf):
        rc = cli.main(list(argv))
    return rc, out_buf.getvalue(), err_buf.getvalue()


def _make_demo_slot(base):
    global_dir = Path(base) / "Global"
    slot_dir = Path(base) / "slot"
    for d in (global_dir, slot_dir):
        d.mkdir(parents=True, exist_ok=True)
    run_node(NODE_MAKE, global_dir, slot_dir)
    return global_dir, slot_dir


class TestRound1Batch2BRegressions(_IsolatedWulinTestCase):
    def test_codec_iv_collision_bom_strict_json_and_surrogates(self):
        text = '{"iv_test":1,"ko":"협객"}'
        samples = [
            (b"{" + b"\x11" * 15, mode)
            for mode in ("aes-gzip", "aes-plain")
        ] + [
            (b"\xef\xbb\xbf{" + b"\x22" * 12, mode)
            for mode in ("aes-gzip", "aes-plain")
        ] + [
            (b"\x1f\x8b" + b"\x33" * 14, mode)
            for mode in ("aes-gzip", "aes-plain")
        ] + [
            ("\ufeff" + text, mode)
            for mode in ("plain", "gzip", "aes-plain", "aes-gzip")
        ]

        for payload, mode in samples:
            if isinstance(payload, bytes):
                blob = cli.encode_es3_bytes(text, mode=mode, iv=payload)
            else:
                blob = cli.encode_es3_bytes(payload, mode=mode)
            self.assertEqual(cli.decode_es3_bytes(blob), {"mode": mode, "text": text})

        for bad in (
            "{",
            "[1,",
            "1e+",
            "1--2",
            '{"n":01}',
            '{"n":.5}',
            '{"n":1.}',
            '{"n":+5}',
        ):
            with self.assertRaises(ValueError):
                cli.parse_es3_json(bad)

        with self.assertRaises(ValueError):
            cli.decode_es3_bytes(b'{"s":"\xed\xa0\x80"}')

        lone = '{"lone":"\\ud800","emoji":"😀"}'
        ast = cli.parse_es3_json(lone)
        rt = cli.decode_es3_bytes(
            cli.encode_es3_bytes(cli.stringify_es3_json(ast), mode="aes-gzip")
        )
        rt_ast = cli.parse_es3_json(rt["text"])
        self.assertEqual(ord(cli.obj_get(rt_ast, "lone")), 0xD800)
        self.assertEqual(ord(cli.obj_get(rt_ast, "emoji")), 0x1F600)

        with tempfile.TemporaryDirectory() as td:
            in_s = Path(td) / "lone-in.save"
            mid_j = Path(td) / "lone-mid.json"
            out_s = Path(td) / "lone-out.save"
            in_s.write_bytes(cli.encode_es3_bytes(lone, mode="aes-gzip"))

            rc, _, _ = _run_cli("decrypt", str(in_s), "-o", str(mid_j))
            self.assertEqual(rc, 0)
            rc, _, _ = _run_cli("encrypt", str(mid_j), "-o", str(out_s))
            self.assertEqual(rc, 0)

            out_ast = cli.parse_es3_json(
                cli.decode_es3_bytes(out_s.read_bytes())["text"]
            )
            self.assertEqual(cli.obj_get(out_ast, "lone"), "\ud800")

    def test_fail_closed_process_check_and_partial_bak_cleanup(self):
        cases = (
            (True, subprocess.TimeoutExpired(cmd="tasklist", timeout=5)),
            (False, unittest.mock.Mock(returncode=1, stdout="ERR", stderr="")),
            (False, unittest.mock.Mock(returncode=0, stdout="  \n", stderr="")),
        )
        with _real_wulin_detection():
            for is_err, payload in cases:
                run_kwargs = (
                    {"side_effect": payload}
                    if is_err
                    else {"return_value": payload}
                )
                with unittest.mock.patch.object(cli.os, "name", "nt"):
                    with unittest.mock.patch("subprocess.run", **run_kwargs):
                        with self.assertRaises(RuntimeError):
                            cli.check_wulin_not_running()
                        self.assertIsNone(
                            cli.check_wulin_not_running(ignore_running_game=True)
                        )

            with unittest.mock.patch.object(cli.os, "name", "posix"):
                with unittest.mock.patch("os.path.isdir", return_value=True):
                    with unittest.mock.patch(
                        "os.listdir", side_effect=PermissionError("denied")
                    ):
                        with self.assertRaises(RuntimeError):
                            cli.check_wulin_not_running()

        def partial_fail(fd, data):
            os.write(fd, data[:3])
            raise OSError("disk full")

        with tempfile.TemporaryDirectory() as td:
            target = Path(td) / "x.save.bak"
            with self.assertRaises(OSError):
                cli._write_exclusive_synced(
                    target,
                    b'{"a":1}',
                    writer_hook=partial_fail,
                )
            self.assertEqual(list(Path(td).iterdir()), [])

    def test_batch_rollback_conflict_and_cli_safety(self):
        with tempfile.TemporaryDirectory() as td:
            base = Path(td)
            global_dir, slot_dir = _make_demo_slot(base)

            rc, out, _ = _run_cli("inspect", str(slot_dir), "--json")
            self.assertEqual(rc, 0)
            summary = json.loads(out)
            self.assertEqual(
                summary["game_time"]["QuaterOfDay"],
                "87.67666666666666666666666667",
            )
            self.assertEqual(
                summary["game_time"]["ticks"],
                "656099925099270000",
            )

            g_sha = sha(global_dir / "SaveObjectGameGlobal.save")
            gm_sha = sha(slot_dir / "SaveObjectGame.save")

            ed = cli.SaveSlotEditor(slot_dir)
            ed.set_fief_all_max()
            with self.assertRaises(OSError):
                ed.save_modified(
                    fault_injector=lambda idx, _t: (_ for _ in ()).throw(OSError("boom")) if idx == 1 else None
                )

            self.assertEqual(
                sha(global_dir / "SaveObjectGameGlobal.save"),
                g_sha,
            )
            self.assertEqual(
                sha(slot_dir / "SaveObjectGame.save"),
                gm_sha,
            )
            self.assertEqual(list(base.rglob("*.pending-*")), [])
            self.assertEqual(list(base.rglob("*.rollback-*")), [])

            ed2 = cli.SaveSlotEditor(slot_dir)
            ed2.set_currency(0, 88888)
            team_path = slot_dir / "SaveObjectPlayerTeam.save"
            orig_team = team_path.read_bytes()
            cli.atomic_write_save(
                team_path,
                '{"Data":{"value":{"__type":"WuLin.SaveObjectPlayerTeam"}}}',
                force=True,
            )
            ext_sha = sha(team_path)
            with self.assertRaises(ValueError):
                ed2.save_modified()
            self.assertEqual(sha(team_path), ext_sha)
            team_path.write_bytes(orig_team)

            with self.assertRaises(ValueError):
                cli.SaveSlotEditor(
                    slot_dir,
                    catalog={"items": {}, "_loaded_ok": False},
                ).add_item(23301, 1)

            isolated = base / "iso"
            isolated.mkdir()
            char_iso = isolated / "SaveObjectGameCharacter.save"
            char_iso.write_bytes(
                (slot_dir / "SaveObjectGameCharacter.save").read_bytes()
            )
            ambig_iso = isolated / "ambig_char.save"
            ambig_iso.write_text(
                '{"Data":{"value":{"__type":"WuLin.SaveObjectGameCharacter,Assembly-CSharp","createdCharacter":{"100401":{"m_templeteUid":100401,"m_level":10},"90002":{"m_templeteUid":100401,"m_level":10}}}}}',
                encoding="utf-8",
            )
            src_save = slot_dir / "SaveObjectGameTime.save"
            hl_save = base / "hl.save"
            os.link(src_save, hl_save)
            out_json = base / "work" / "out.json"
            enc_out = base / "work" / "enc.save"

            cases = (
                (("edit", str(slot_dir), "--add-item", "99999999:1"), 1),
                (("edit", str(slot_dir), "--add-item", "10164:21"), 1),
                (("edit", str(char_iso), "--char-level", "77"), 0),
                (("edit", str(ambig_iso), "--char-level", "77"), 1),
                (
                    (
                        "edit",
                        str(ambig_iso),
                        "--hero-uid",
                        "100401",
                        "--char-level",
                        "77",
                    ),
                    0,
                ),
                (("edit", str(src_save), "--coin", "500"), 1),
                (("edit", str(slot_dir)), 1),
                (
                    (
                        "edit",
                        str(slot_dir / "SaveObjectGame.save"),
                        "--fief",
                        "112=4",
                    ),
                    0,
                ),
                (("decrypt", str(src_save), "-o", str(src_save)), 1),
                (
                    (
                        "decrypt",
                        str(src_save),
                        "-o",
                        str(hl_save),
                        "--overwrite",
                    ),
                    1,
                ),
                (("decrypt", str(src_save), "-o", str(out_json)), 0),
                (("decrypt", str(src_save), "-o", str(out_json)), 1),
                (
                    (
                        "decrypt",
                        str(src_save),
                        "-o",
                        str(out_json),
                        "--overwrite",
                    ),
                    0,
                ),
                (
                    (
                        "encrypt",
                        str(out_json),
                        "-o",
                        str(out_json),
                        "--overwrite",
                    ),
                    1,
                ),
                (("encrypt", str(out_json), "-o", str(enc_out)), 0),
                (
                    (
                        "encrypt",
                        str(out_json),
                        "-o",
                        str(enc_out),
                        "--force",
                    ),
                    1,
                ),
            )
            for argv, expected_rc in cases:
                rc, _, _ = _run_cli(*argv)
                self.assertEqual(rc, expected_rc)

            self.assertNotEqual(
                list(out_json.parent.glob("out.json.backup-*.bak")),
                [],
            )
            self.assertEqual(
                cli.SaveSlotEditor(
                    global_dir / "SaveObjectGameGlobal.save"
                ).inspect_summary()["fief_buildings"]["112"],
                4,
            )

            with _sim_wulin_running():
                running_cases = (
                    (
                        (
                            "encrypt",
                            str(out_json),
                            "-o",
                            str(enc_out),
                            "--overwrite",
                        ),
                        1,
                    ),
                    (
                        (
                            "encrypt",
                            str(out_json),
                            "-o",
                            str(enc_out),
                            "--overwrite",
                            "--ignore-running-game",
                        ),
                        0,
                    ),
                )
                for argv, expected_rc in running_cases:
                    rc, _, _ = _run_cli(*argv)
                    self.assertEqual(rc, expected_rc)

            gitignore_text = (ROOT / ".gitignore").read_text(encoding="utf-8")
            self.assertIn("work/", gitignore_text)

            build_py = (ROOT / "build.py").read_text(encoding="utf-8")
            self.assertIn("sys.version_info < (3, 8)", build_py)
            self.assertNotIn("write_text(out_html", build_py)

            readme_text = (ROOT / "README.md").read_text(encoding="utf-8")
            self.assertIn("./work/player_team.json", readme_text)


class TestRound2Regressions(_IsolatedWulinTestCase):
    def test_r2_c1_c2_staging_conflict_exclusive_encrypt_and_pinned_dir(self):
        import errno
        with tempfile.TemporaryDirectory() as td:
            base = Path(td)
            global_dir, slot_dir = _make_demo_slot(base)
            game_path = slot_dir / "SaveObjectGame.save"
            global_path = global_dir / "SaveObjectGameGlobal.save"
            ed = cli.SaveSlotEditor(slot_dir)
            ed.set_fief_all_max()
            orig_hashes = {p: sha(p) for p in (global_path, game_path)}
            ext_bytes = cli.encode_es3_bytes('{"Data":{"value":{"__type":"WuLin.SaveObjectGame"}}}', mode="plain")
            mutated_target = None
            def fault_injector(idx, target):
                nonlocal mutated_target
                if idx == 1:
                    mutated_target = Path(target)
                    mutated_target.write_bytes(ext_bytes)
            with self.assertRaises(ValueError):
                ed.save_modified(fault_injector=fault_injector)
            self.assertIsNotNone(mutated_target)
            self.assertEqual(mutated_target.read_bytes(), ext_bytes)
            other_path = global_path if mutated_target == game_path else game_path
            self.assertEqual(sha(other_path), orig_hashes[other_path])
            src_json = base / "in.json"
            src_json.write_text('{"a":1}', encoding="utf-8")
            race_out = base / "race_sub" / "out.save"
            prev_hook = getattr(cli, "HASE_TEST_AFTER_ENSURE_HOOK", None)
            def hook(clean_parent):
                if Path(clean_parent) == race_out.parent:
                    race_out.parent.mkdir(parents=True, exist_ok=True)
                    race_out.write_bytes(b"RACE_WINNER")
            cli.HASE_TEST_AFTER_ENSURE_HOOK = hook
            try:
                rc, _, _ = _run_cli("encrypt", str(src_json), "-o", str(race_out))
                self.assertEqual(rc, 1)
                self.assertEqual(race_out.read_bytes(), b"RACE_WINNER")
            finally:
                cli.HASE_TEST_AFTER_ENSURE_HOOK = prev_hook

    def test_r2_c2_pinned_dir_parent_symlink_swap(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = pathlib.Path(tmp)
            probe = base / "probe"
            try:
                os.symlink(base, probe)
            except OSError as exc:
                if getattr(exc, "winerror", None) == 1314:
                    self.skipTest("Windows symlink privilege unavailable (1314)")
                raise
            prev_hook = cli.HASE_TEST_AFTER_ENSURE_HOOK
            real_dir = base / "pin_real"
            decoy_dir = base / "pin_decoy"
            real_dir.mkdir()
            decoy_dir.mkdir()
            victim = decoy_dir / "out.save"
            victim.write_bytes(b"UNTOUCHED")
            def pin_hook(clean_parent):
                if pathlib.Path(clean_parent) == real_dir:
                    cli.HASE_TEST_AFTER_ENSURE_HOOK = None
                    if real_dir.exists():
                        real_dir.rename(base / "pin_moved")
                    os.symlink(decoy_dir, real_dir)
            cli.HASE_TEST_AFTER_ENSURE_HOOK = pin_hook
            try:
                with self.assertRaises(ValueError):
                    cli.atomic_write_save(real_dir / "out.save", '{"k":1}', force=True, expect_exists=False)
                self.assertEqual(victim.read_bytes(), b"UNTOUCHED")
            finally:
                cli.HASE_TEST_AFTER_ENSURE_HOOK = prev_hook

    def test_r2_c3_c4_isolated_rollback_and_dual_fief_requirement(self):
        import shutil
        with tempfile.TemporaryDirectory() as td:
            base = Path(td)
            global_dir, slot_dir = _make_demo_slot(base)
            ed = cli.SaveSlotEditor(slot_dir)
            ed.set_currency(0, 777777)
            ed.set_fief_all_max()
            before = {info["path"]: info["path"].read_bytes() for info in ed.files.values() if info.get("dirty")}
            seen_order = []
            def fault_injector(idx, target):
                seen_order.append(Path(target))
                if idx == 2:
                    raise OSError("commit_idx2_fail")
            def rollback_fault_injector(r_idx, target):
                if r_idx == 1:
                    raise OSError("rb_idx1_fail")
            with self.assertRaises(OSError) as cm:
                ed.save_modified(fault_injector=fault_injector, rollback_fault_injector=rollback_fault_injector)
            msg = str(cm.exception)
            self.assertIn("commit_idx2_fail", msg)
            self.assertIn("rb_idx1_fail", msg)
            self.assertIn(str(seen_order[1]), msg)
            self.assertIn(".bak", msg)
            self.assertEqual(seen_order[0].read_bytes(), before[seen_order[0]])
            baks = list(seen_order[1].parent.glob(seen_order[1].name + "*.bak")) + list(seen_order[1].parent.glob("*.bak"))
            self.assertTrue(any(p.read_bytes() == before[seen_order[1]] for p in baks))
            seen_order[1].write_bytes(before[seen_order[1]])
            iso_game_dir = base / "iso_root" / "only_game"
            iso_game_dir.mkdir(parents=True)
            shutil.copy2(slot_dir / "SaveObjectGame.save", iso_game_dir / "SaveObjectGame.save")
            with self.assertRaises(ValueError):
                cli.SaveSlotEditor(iso_game_dir / "SaveObjectGame.save").set_fief_building(112, 5)
            with self.assertRaises(ValueError):
                cli.SaveSlotEditor(global_dir / "SaveObjectGameGlobal.save").set_fief_building(112, 5)
            self.assertEqual(_run_cli("edit", str(iso_game_dir / "SaveObjectGame.save"), "--fief-max")[0], 1)
            self.assertEqual(_run_cli("edit", str(global_dir / "SaveObjectGameGlobal.save"), "--preset", "fief_all_max")[0], 1)
            self.assertEqual(_run_cli("edit", str(slot_dir / "SaveObjectGame.save"), "--fief", "112=5")[0], 0)

    def test_r2_c5_c6_c7_proc_fail_closed_decrypt_guard_and_utf8(self):
        import errno
        with tempfile.TemporaryDirectory() as td:
            base = Path(td)
            global_dir, slot_dir = _make_demo_slot(base)
            proc_root = base / "proc"
            for d in ("self", "101", "102"):
                (proc_root / d).mkdir(parents=True, exist_ok=True)
            (proc_root / "101" / "comm").write_text("bash\n", encoding="utf-8")
            (proc_root / "101" / "cmdline").write_bytes(b"bash\x00")
            self.assertEqual(cli._scan_proc_for_wulin(str(proc_root)), "NOT_RUNNING")
            real_open = open
            def deny_open(path, *a, **k):
                if str(path).endswith(os.path.join("102", "comm")):
                    raise PermissionError(errno.EACCES, "denied")
                return real_open(path, *a, **k)
            with unittest.mock.patch("builtins.open", side_effect=deny_open):
                self.assertEqual(cli._scan_proc_for_wulin(str(proc_root)), "UNKNOWN")
            with unittest.mock.patch.object(cli, "detect_wulin_running", return_value="UNKNOWN"):
                with self.assertRaises(RuntimeError):
                    cli.check_wulin_not_running()
                cli.check_wulin_not_running(force=True)
            (proc_root / "103").mkdir()
            (proc_root / "103" / "cmdline").write_bytes(b"/games/Wulin.exe\x00")
            self.assertEqual(cli._scan_proc_for_wulin(str(proc_root)), "RUNNING")
            time_save = slot_dir / "SaveObjectGameTime.save"
            out_j = base / "dec.json"
            out_s = base / "dec.save"
            with _sim_wulin_running():
                self.assertEqual(_run_cli("decrypt", str(time_save), "-o", str(out_j))[0], 0)
                self.assertEqual(_run_cli("decrypt", str(time_save), "-o", str(out_j), "--overwrite")[0], 1)
                self.assertEqual(_run_cli("decrypt", str(time_save), "-o", str(out_j), "--overwrite", "--ignore-running-game")[0], 0)
                self.assertEqual(_run_cli("decrypt", str(time_save), "-o", str(out_j), "--overwrite", "--force")[0], 0)
                self.assertEqual(_run_cli("decrypt", str(time_save), "-o", str(out_s))[0], 1)
            p = subprocess.run([sys.executable, str(ROOT / "heros_adventure_editor.py"), "inspect", str(slot_dir), "--json"], cwd=ROOT, check=True, capture_output=True, text=True, encoding="utf-8", env={**os.environ, "PYTHONIOENCODING": "utf-8"})
            self.assertEqual(json.loads(p.stdout)["protagonist"]["instance_id"], 100401)
            import ast
            tree = ast.parse((ROOT / "tests" / "test_cli.py").read_text(encoding="utf-8"))
            for node in ast.walk(tree):
                if isinstance(node, ast.Call) and getattr(node.func, "attr", None) == "run" and getattr(node.func.value, "id", None) == "subprocess":
                    if any(kw.arg == "text" and isinstance(kw.value, ast.Constant) and kw.value.value is True for kw in node.keywords):
                        self.assertTrue(any(kw.arg == "encoding" and isinstance(kw.value, ast.Constant) and kw.value.value == "utf-8" for kw in node.keywords))


def _probe_renameat2_supported(dir_path):
    if not sys.platform.startswith("linux"):
        return False
    try:
        with cli.PinnedDirectory(dir_path) as pin:
            if pin._fd is None:
                return False
            src_name = f".probe-rn2-{os.getpid()}-src"
            dst_name = f".probe-rn2-{os.getpid()}-dst"
            try:
                fd = pin.open_leaf(src_name, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                os.close(fd)
                pin._linux_renameat2_noreplace(pin._fd, src_name, dst_name)
                return True
            finally:
                for name in (src_name, dst_name):
                    try:
                        pin.unlink_leaf(name)
                    except OSError:
                        pass
    except OSError:
        return False


class TestRound3Regressions(_IsolatedWulinTestCase):
    def test_r3_b5_game_status_http_endpoint(self):
        import unittest.mock
        with _running_http_server() as base:
            cases = [
                ({"detect_wulin_running": "NOT_RUNNING"}, {"status": "NOT_RUNNING", "running": False, "canDirectWrite": True, "ok": True}),
                ({"HASE_SIMULATE_WULIN_RUNNING": "1"}, {"status": "RUNNING", "running": True, "canDirectWrite": False, "ok": True}),
                ({"HASE_SIMULATE_WULIN_UNKNOWN": "1"}, {"status": "UNKNOWN", "running": None, "canDirectWrite": False, "ok": True}),
            ]
            def check_status(expected):
                url = base + "/api/game-status"
                with urllib.request.urlopen(url) as r:
                    self.assertEqual(r.headers["Cache-Control"], "no-store")
                    self.assertEqual(r.headers["X-Content-Type-Options"], "nosniff")
                    self.assertEqual(r.headers["X-Frame-Options"], "DENY")
                    self.assertEqual(json.loads(r.read().decode("utf-8")), expected)
            with unittest.mock.patch.object(cli, "detect_wulin_running", return_value="NOT_RUNNING"):
                for patch_kw, expected in cases[:1]:
                    check_status(expected)
            for env_kw, expected in cases[1:]:
                with unittest.mock.patch.dict(os.environ, env_kw, clear=False):
                    check_status(expected)

    def test_r3_c1_c2_c3_rollback_safety_pending_order_and_link_fallback(self):
        import errno
        import unittest.mock
        with tempfile.TemporaryDirectory() as tmp:
            base = pathlib.Path(tmp)
            comp = base / "comp.save"
            with self.assertRaises(FileExistsError):
                cli.atomic_write_save_batch([{"target_path": comp, "new_text": '{"a":1}', "mode": "plain", "expect_exists": False}], force=True, fault_injector=lambda i, t: pathlib.Path(t).write_bytes(b"COMPETING"))
            self.assertEqual(comp.read_bytes(), b"COMPETING")
            comp2 = base / "comp2.save"
            real_publish = cli.PinnedDirectory.publish_exclusive_leaf

            def bad_link(self, src, dst_name=None, *a, **k):
                if dst_name == "comp2.save":
                    comp2.write_bytes(b"COMPETING2")
                    raise FileExistsError("exists")
                return real_publish(self, src, dst_name, *a, **k)

            with unittest.mock.patch.object(cli.PinnedDirectory, "publish_exclusive_leaf", bad_link):
                with self.assertRaises(FileExistsError):
                    cli.atomic_write_save(comp2, '{"b":1}', mode="plain", force=True, expect_exists=False)
            self.assertEqual(comp2.read_bytes(), b"COMPETING2")
            g1, s1 = _make_demo_slot(base / "s1")
            ed = cli.SaveSlotEditor(s1)
            ed.set_fief_all_max()
            seen, orig0 = [], None
            def fi(idx, target):
                nonlocal orig0
                seen.append(pathlib.Path(target))
                if idx == 0:
                    orig0 = seen[0].read_bytes()
                if idx == 1:
                    seen[0].write_bytes(b"EXT_MODIFIED")
                    raise OSError("idx1_fail")
            with self.assertRaises(OSError) as cm:
                ed.save_modified(fault_injector=fi)
            msg = str(cm.exception)
            for part in ("idx1_fail", "롤백 실패", ".bak"):
                self.assertIn(part, msg)
            self.assertEqual(seen[0].read_bytes(), b"EXT_MODIFIED")
            baks = list(seen[0].parent.glob("*.bak"))
            self.assertTrue(any(b.read_bytes() == orig0 for b in baks))
            g2, s2 = _make_demo_slot(base / "s2")
            ed2 = cli.SaveSlotEditor(s2)
            ed2.set_fief_all_max()
            before = {info["path"]: info["path"].read_bytes() for info in ed2.files.values() if info.get("dirty")}
            orig_unlink = cli.PinnedDirectory.unlink_leaf
            def locked_unlink(self_pd, name):
                name_str = str(name)
                if ".pending-" in name_str and name_str.endswith(".tmp"):
                    raise PermissionError(errno.EACCES, "pend_locked")
                return orig_unlink(self_pd, name)
            seen2 = []
            def fi2(idx, target):
                seen2.append(pathlib.Path(target))
                if idx == 1:
                    raise OSError("idx1_boom")
            try:
                with unittest.mock.patch.object(cli.PinnedDirectory, "unlink_leaf", locked_unlink):
                    with self.assertRaises(OSError) as cm2:
                        ed2.save_modified(fault_injector=fi2)
                msg2 = str(cm2.exception)
                self.assertIn("idx1_boom", msg2)
                self.assertIn("임시 파일 정리 실패", msg2)
                self.assertEqual(seen2[0].read_bytes(), before[seen2[0]])
            finally:
                for p in base.rglob("*.pending-*"):
                    cli._safe_unlink(p)
            if os.name != "nt":
                rn2_ok = _probe_renameat2_supported(base)
                fb_ok = base / "fb_ok.save"
                fb_race = base / "fb_race.save"
                write_fb = lambda p, txt: cli.atomic_write_save(p, txt, mode="plain", force=True, expect_exists=False)
                with unittest.mock.patch("os.link", side_effect=PermissionError(errno.EPERM, "no link")):
                    if rn2_ok:
                        write_fb(fb_ok, '{"k":1}')
                        self.assertEqual(cli.decode_es3_bytes(fb_ok.read_bytes())["text"], '{"k":1}')
                    else:
                        with self.assertRaises(OSError) as cm_fb:
                            write_fb(fb_ok, '{"k":1}')
                        self.assertEqual(cm_fb.exception.errno, errno.EOPNOTSUPP)
                        self.assertFalse(fb_ok.exists())
                def race_link(*a, **k):
                    fb_race.write_bytes(b"RACE")
                    raise PermissionError(errno.EPERM, "no link")
                expected_race_exc = FileExistsError if rn2_ok else (FileExistsError, OSError)
                with unittest.mock.patch("os.link", side_effect=race_link):
                    with self.assertRaises(expected_race_exc):
                        write_fb(fb_race, '{"k":2}')
                self.assertEqual(fb_race.read_bytes(), b"RACE")

    def test_r3_c4_c6_pinned_nofollow_reads_isolated_symlink(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = pathlib.Path(tmp)
            (base / "decoy").write_bytes(b'{"d":1}')
            (base / "decoy2").write_bytes(b'{"d":2}')
            (base / "decoy3").write_bytes(b'{"d":3}')
            try:
                os.symlink(base, base / "probe")
            except OSError as exc:
                if getattr(exc, "winerror", None) == 1314:
                    self.skipTest("Windows symlink privilege unavailable (1314)")
                raise
            g, slot_dir = _make_demo_slot(base / "slot")
            prev = cli.HASE_TEST_AFTER_ENSURE_HOOK
            try:
                def leaf_hook(clean_parent):
                    if pathlib.Path(clean_parent) == slot_dir:
                        cli.HASE_TEST_AFTER_ENSURE_HOOK = None
                        (slot_dir / "SaveObjectGameTime.save").unlink()
                        os.symlink(base / "decoy", slot_dir / "SaveObjectGameTime.save")
                cli.HASE_TEST_AFTER_ENSURE_HOOK = leaf_hook
                self.assertEqual(
                    _run_cli("decrypt", str(slot_dir / "SaveObjectGameTime.save"), "-o", str(base / "dec.json"))[0],
                    1,
                )

                enc_dir = base / "enc_src"
                enc_dir.mkdir()
                inp = enc_dir / "in.json"
                inp.write_text('{"k":1}', encoding="utf-8")

                def enc_hook(clean_parent):
                    if pathlib.Path(clean_parent) == enc_dir:
                        cli.HASE_TEST_AFTER_ENSURE_HOOK = None
                        inp.unlink()
                        os.symlink(base / "decoy2", inp)

                cli.HASE_TEST_AFTER_ENSURE_HOOK = enc_hook
                self.assertEqual(_run_cli("encrypt", str(inp), "-o", str(base / "enc.save"))[0], 1)
            finally:
                cli.HASE_TEST_AFTER_ENSURE_HOOK = prev

            link_slot = base / "link_slot"
            link_slot.mkdir()
            os.symlink(base / "decoy3", link_slot / "SaveObjectGameTime.save")
            with self.assertRaises(ValueError):
                cli.SaveSlotEditor(link_slot)

    def test_r3_c5_c7_cp1252_stdio_and_control_char_rejection(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = pathlib.Path(tmp)
            g, slot_dir = _make_demo_slot(base / "slot")
            cmds = [
                ("inspect", str(slot_dir), "--json"),
                ("inspect", str(slot_dir)),
                ("edit", str(slot_dir), "--coin", "12345", "--ignore-running-game"),
            ]
            for argv in cmds:
                subprocess.run(
                    [sys.executable, str(ROOT / "heros_adventure_editor.py"), *argv],
                    cwd=ROOT,
                    env={**os.environ, "PYTHONIOENCODING": "cp1252", "PYTHONUTF8": "0"},
                    check=True,
                    capture_output=True,
                    text=True,
                    encoding="utf-8",
                )
            cli._safe_print(
                "한글 大侠",
                file=io.TextIOWrapper(io.BytesIO(), encoding="cp1252", errors="strict"),
            )
            for raw in (
                b'{"k":"a\nb"}',
                b'{"k":"a\tb"}',
                b'{"k":"a\x00b"}',
                b'{"k":"a\x1fb"}',
            ):
                with self.assertRaises(ValueError):
                    cli.decode_es3_bytes(raw)
            bad_save = base / "bad.save"
            bad_save.write_bytes(b'{"k":"a\nb"}')
            self.assertEqual(_run_cli("decrypt", str(bad_save), "-o", str(base / "o.json"))[0], 1)
            self.assertEqual(
                cli.decode_es3_bytes(b'{"k":"a\\nb\\t\\u0000"}')["text"],
                '{"k":"a\\nb\\t\\u0000"}',
            )


import errno


class TestRound4Regressions(_IsolatedWulinTestCase):
    def test_r4_c1_post_publish_metadata_or_cleanup_failure_rolls_back(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = pathlib.Path(tmp)
            ex = base / "ex.save"
            cli.atomic_write_save(ex, '{"v":1}', mode="plain", force=True, expect_exists=False)
            orig_bytes = ex.read_bytes()
            real_lstat = cli.PinnedDirectory.lstat_leaf
            state = {"raised": False}

            def lstat_hook(self_pd, name):
                if name == "ex.save" and ex.read_bytes() != orig_bytes and not state["raised"]:
                    state["raised"] = True
                    raise PermissionError(errno.EACCES, "post-publish lstat fail")
                return real_lstat(self_pd, name)

            with unittest.mock.patch.object(cli.PinnedDirectory, "lstat_leaf", lstat_hook):
                with self.assertRaises(PermissionError):
                    cli.atomic_write_save(ex, '{"v":2}', mode="plain", force=True)
            self.assertEqual(ex.read_bytes(), orig_bytes)

            if os.name != "nt":
                nw = base / "nw.save"
                real_unlink = cli.PinnedDirectory.unlink_leaf
                state2 = {"raised": False}

                def unlink_hook(self_pd, name):
                    if ".pending-" in str(name) and nw.exists() and not state2["raised"]:
                        state2["raised"] = True
                        raise PermissionError(errno.EACCES, "pending unlink fail")
                    return real_unlink(self_pd, name)

                try:
                    with unittest.mock.patch.object(cli.PinnedDirectory, "unlink_leaf", unlink_hook):
                        with self.assertRaises((PermissionError, OSError)):
                            cli.atomic_write_save(
                                nw, '{"v":3}', mode="plain", force=True, expect_exists=False
                            )
                    self.assertFalse(nw.exists())
                finally:
                    for p in base.glob("*.pending-*"):
                        cli._safe_unlink(p)

    def test_r4_c2_exclusive_publish_atomic_only_no_copy_fallback(self):
        if os.name == "nt":
            self.skipTest("POSIX-only exclusive publish semantics")
        with tempfile.TemporaryDirectory() as tmp:
            tmp_dir = pathlib.Path(tmp)
            with cli.PinnedDirectory(tmp) as pin:
                pin.write_exclusive_leaf("src.tmp", b'{"a":1}')
                no_link = PermissionError(errno.EPERM, "no link")

                def link_race(*args, **kwargs):
                    pathlib.Path(tmp, "dst2.save").write_bytes(b"EXT")
                    raise no_link

                for dst_name, link_fx in (("dst1.save", no_link), ("dst2.save", link_race)):
                    with unittest.mock.patch.object(os, "link", side_effect=link_fx), \
                         unittest.mock.patch.object(
                             cli.PinnedDirectory, "_linux_renameat2_noreplace",
                             side_effect=OSError(errno.ENOSYS, "no renameat2")):
                        with self.assertRaises(OSError) as cm:
                            pin.publish_exclusive_leaf("src.tmp", dst_name)
                        self.assertEqual(cm.exception.errno, errno.EOPNOTSUPP)
                        if dst_name == "dst1.save":
                            self.assertFalse((tmp_dir / "dst1.save").exists())
                        else:
                            self.assertEqual((tmp_dir / "dst2.save").read_bytes(), b"EXT")

                if sys.platform.startswith("linux"):
                    rn2_ok = _probe_renameat2_supported(tmp_dir)
                    dst3 = tmp_dir / "dst3.save"
                    po = unittest.mock.patch.object
                    with po(os, "link", side_effect=no_link):
                        if rn2_ok:
                            self.assertFalse(pin.publish_exclusive_leaf("src.tmp", "dst3.save"))
                            before_race_bytes = dst3.read_bytes()
                            pin.write_exclusive_leaf("src2.tmp", b'{"b":2}')
                            with self.assertRaises(FileExistsError):
                                pin.publish_exclusive_leaf("src2.tmp", "dst3.save")
                            after_race_bytes = dst3.read_bytes()
                            self.assertEqual(
                                (before_race_bytes, after_race_bytes),
                                (b'{"a":1}', b'{"a":1}')
                            )
                        else:
                            with self.assertRaises(OSError) as cm_rn2:
                                pin.publish_exclusive_leaf("src.tmp", "dst3.save")
                            self.assertTrue(cm_rn2.exception.errno == errno.EOPNOTSUPP)
                            self.assertFalse(dst3.exists())

    def test_r4_c3_commit_time_wulin_recheck_blocks_and_rolls_back(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = pathlib.Path(tmp)
            f0 = base / "f0.save"
            f1 = base / "f1.save"
            cli.atomic_write_save(f0, '{"x":1}', mode="plain", force=True, expect_exists=False)
            cli.atomic_write_save(f1, '{"x":1}', mode="plain", force=True, expect_exists=False)
            b0 = f0.read_bytes()
            b1 = f1.read_bytes()

            for bad_state in ("RUNNING", "UNKNOWN"):
                for trigger_idx in (0, 1):
                    state = {"v": "NOT_RUNNING"}

                    def detect(_state=state):
                        return _state["v"]

                    def inject(idx, _t, _state=state, _bad=bad_state, _idx=trigger_idx):
                        if idx == _idx:
                            _state["v"] = _bad

                    with unittest.mock.patch.object(cli, "detect_wulin_running", side_effect=detect):
                        with self.assertRaises(RuntimeError):
                            cli.atomic_write_save_batch([
                                {"target_path": f0, "new_text": '{"x":9}', "mode": "plain"},
                                {"target_path": f1, "new_text": '{"x":9}', "mode": "plain"},
                            ], fault_injector=inject)
                    self.assertEqual(f0.read_bytes(), b0)
                    self.assertEqual(f1.read_bytes(), b1)

            out_save = base / "out.save"
            cli.atomic_write_save(
                out_save, '{"x":1}', mode="plain", force=True, expect_exists=False
            )
            state = {"v": "NOT_RUNNING"}

            def hook(fd, data, _state=state):
                os.write(fd, data)
                os.fsync(fd)
                _state["v"] = "RUNNING"

            with unittest.mock.patch.object(
                cli, "detect_wulin_running", side_effect=lambda: state["v"]
            ):
                with self.assertRaises(RuntimeError):
                    cli._write_output_file_atomic(
                        out_save, b'{"x":2}', overwrite=True, check_game=True, writer_hook=hook
                    )
            self.assertEqual(out_save.read_bytes(), b'{"x":1}')
            self.assertEqual(len(list(base.glob("*.bak")) + list(base.glob("*.pending-*"))), 0)

    def test_r4_c4_windows_binary_tasklist_non_utf8_safe(self):
        import json
        import urllib.request

        def run_with(data):
            return subprocess.CompletedProcess(args=[], returncode=0, stdout=data, stderr=b"")

        cases = [
            (b"\xc1\xa4\xba\xb8: No tasks are running\r\n", "NOT_RUNNING"),
            (b"\xc1\xa4\xba\xb8: Wulin.exe                    1234 Console\r\n", "RUNNING"),
            ("Wulin.exe   1234".encode("utf-16le"), "RUNNING"),
            (b"   \r\n", "UNKNOWN"),
        ]

        with unittest.mock.patch.multiple(cli.os, name="nt"), \
                unittest.mock.patch.object(cli, "_resolve_windows_tasklist", return_value=r"C:\Windows\System32\tasklist.exe"), \
                _real_wulin_detection():
            for patch_kw, expected in [
                *[
                    ({"return_value": run_with(data)}, expected)
                    for data, expected in cases
                ],
                ({"side_effect": OSError("boom")}, "UNKNOWN"),
            ]:
                with self.subTest(patch_kw=patch_kw, expected=expected):
                    with unittest.mock.patch.object(cli.subprocess, "run", **patch_kw):
                        self.assertEqual(cli.detect_wulin_running(), expected)

            with unittest.mock.patch.object(
                cli.subprocess,
                "run",
                return_value=run_with(b"\xc1\xa4\xba\xb8: No tasks are running\r\n"),
            ):
                with _running_http_server() as base_url:
                    with urllib.request.urlopen(base_url + "/api/game-status") as resp:
                        self.assertEqual(resp.getcode(), 200)
                        parsed = json.loads(resp.read().decode("utf-8"))
                    self.assertEqual(parsed["status"], "NOT_RUNNING")


class TestRound5Regressions(_IsolatedWulinTestCase):
    def test_r5_c1_new_decrypt_output_rechecks_wulin_after_staging(self):
        po = unittest.mock.patch.object
        with tempfile.TemporaryDirectory() as tmp:
            for bad_state in ("RUNNING", "UNKNOWN"):
                out_path = pathlib.Path(tmp) / f"new_{bad_state.lower()}.save"
                cur = {"v": "NOT_RUNNING"}
                def hook(fd, payload):
                    os.write(fd, payload)
                    os.fsync(fd)
                    cur["v"] = bad_state
                with po(cli, "detect_wulin_running", side_effect=lambda: cur["v"]):
                    with self.assertRaises(RuntimeError):
                        cli._write_output_file_atomic(out_path, b'{"r5":1}', overwrite=False, check_game=True, writer_hook=hook)
                    self.assertFalse(out_path.exists())
                    self.assertEqual(list(pathlib.Path(tmp).glob("*.tmp-*")), [])

    def test_r5_c2_leaf_lock_rejects_dangling_symlink(self):
        po = unittest.mock.patch.object
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)
            outside = root / "outside"
            outside.mkdir()
            hijack = outside / "hijacked.lock"
            _, slot_dir = _make_demo_slot(root / "saves")
            try:
                (slot_dir / ".hase-lock-SaveObjectPlayerTeam.save").symlink_to(hijack)
            except OSError as exc:
                if getattr(exc, "winerror", None) == 1314:
                    self.skipTest("symlink privilege required")
                raise
            with cli.PinnedDirectory(slot_dir) as pin:
                with self.assertRaises(ValueError):
                    pin.acquire_leaf_lock("SaveObjectPlayerTeam.save")
            ed = cli.SaveSlotEditor(slot_dir)
            ed.set_currency(0, 77777)
            with self.assertRaises(ValueError):
                ed.save_modified(force=True)
            self.assertFalse(hijack.exists())

            nt_dir = root / "nt_slot"
            nt_dir.mkdir()
            pin_nt = cli.PinnedDirectory.__new__(cli.PinnedDirectory)
            pin_nt.clean_parent = nt_dir
            seen = []
            def fake_open(*a, **kw):
                seen.append((a, kw))
                raise ValueError("reparse")
            import types
            with unittest.mock.patch.dict(sys.modules, {"msvcrt": types.SimpleNamespace()}), po(cli.os, "name", "nt"), po(pin_nt, "_win32_open_verified_handle", side_effect=fake_open):
                with self.assertRaises(ValueError):
                    pin_nt.acquire_leaf_lock("SaveObjectPlayerTeam.save")
            self.assertEqual(seen, [((nt_dir / ".hase-lock-SaveObjectPlayerTeam.save", 0xC0000000, 3, 0x00200080, False), {"creation_disposition": 4})])

    def test_r5_c3_windows_tasklist_uses_system32_absolute_path(self):
        import ctypes
        import types
        po = unittest.mock.patch.object
        with tempfile.TemporaryDirectory() as tmp:
            (pathlib.Path(tmp) / "tasklist.exe").write_bytes(b"CWD_FAKE")
            sys32_exe = r"C:\Windows\System32\tasklist.exe"
            alt_exe = r"D:\WinNT\System32\tasklist.exe"
            class FakeK32:
                def __init__(self, val):
                    self.val = val
                def GetSystemDirectoryW(self, buf, size):
                    if self.val:
                        buf.value = self.val
                        return len(self.val)
                    return 0
            with _real_wulin_detection(), po(cli.os, "name", "nt"):
                with po(ctypes, "WinDLL", return_value=FakeK32(r"C:\Windows\System32"), create=True), \
                     po(cli.os.path, "isfile", side_effect=lambda p: p == sys32_exe), \
                     po(cli.subprocess, "run", return_value=subprocess.CompletedProcess(args=[], returncode=0, stdout=b"Wulin.exe  999\r\n", stderr=b"")) as m_run:
                    self.assertEqual(cli.detect_wulin_running(), "RUNNING")
                    self.assertEqual(m_run.call_args[0][0], [sys32_exe, "/FI", "IMAGENAME eq Wulin.exe", "/NH"])
                for env_root, isfile_fn, expected_path in [
                    (r"D:\WinNT", lambda p: p == alt_exe, alt_exe),
                    (".", lambda p: True, None),
                ]:
                    with po(ctypes, "WinDLL", return_value=FakeK32(""), create=True), \
                         unittest.mock.patch.dict(cli.os.environ, {"SystemRoot": env_root}, clear=False), \
                         po(cli.os.path, "isfile", side_effect=isfile_fn):
                        self.assertEqual(cli._resolve_windows_tasklist(), expected_path)
                with po(cli, "_resolve_windows_tasklist", return_value=None), po(cli.subprocess, "run") as m_never:
                    self.assertEqual(cli.detect_wulin_running(), "UNKNOWN")
                    self.assertEqual(m_never.call_count, 0)


class TestRound6Regressions(_IsolatedWulinTestCase):
    def test_r6_c1_pinned_mkdir_blocks_ancestor_symlink_swap(self):
        import argparse
        with tempfile.TemporaryDirectory() as td:
            base = pathlib.Path(td)
            in_save = base / "in.save"
            in_json = base / "in.json"
            in_save.write_bytes(cli.encode_es3_bytes('{"k":1}', mode="plain"))
            in_json.write_text('{"k":2}', encoding="utf-8")
            self.assertEqual(cli.main(["decrypt", str(in_save), "-o", str(base / "ok1/new/deep/out.json"), "--force"]), 0)
            self.assertEqual(cli.main(["encrypt", str(in_json), "-o", str(base / "ok2/new/deep/out.save"), "--mode", "plain", "--force"]), 0)
            probe = base / "sym_probe"
            try:
                os.symlink(base, probe)
            except OSError as exc:
                if getattr(exc, "winerror", None) == 1314:
                    return
                raise
            probe.unlink()
            for tag, fn, src_p, leaf in (
                ("dec", cli.cmd_decrypt, in_save, "out.json"),
                ("enc", cli.cmd_encrypt, in_json, "out.save"),
            ):
                swap_base = base / f"sw_{tag}" / "base"
                ext_dir = base / f"ext_{tag}"
                swap_base.mkdir(parents=True)
                ext_dir.mkdir()
                target_parent = swap_base / "new/deep"
                fired = 0

                def hook(_p, swap_base=swap_base, ext_dir=ext_dir, target_parent=target_parent):
                    nonlocal fired
                    if _norm_abs(_p) != _norm_abs(target_parent):
                        return
                    cli.HASE_TEST_AFTER_ENSURE_HOOK = None
                    fired += 1
                    swap_base.rmdir()
                    os.symlink(ext_dir, swap_base)

                cli.HASE_TEST_AFTER_ENSURE_HOOK = hook
                try:
                    ns = argparse.Namespace(
                        input=str(src_p),
                        output=str(swap_base / "new/deep" / leaf),
                        password="Meow",
                        mode="plain",
                        overwrite=False,
                        force=True,
                        ignore_running_game=True,
                    )
                    with self.assertRaises(ValueError):
                        fn(ns)
                    self.assertEqual(fired, 1)
                    self.assertFalse((ext_dir / "new").exists())
                    self.assertEqual(list(ext_dir.iterdir()), [])
                finally:
                    cli.HASE_TEST_AFTER_ENSURE_HOOK = None

    def test_r6_c2_proc_wulin_detection_and_r6_a1_a2_guards(self):
        with tempfile.TemporaryDirectory() as td:
            base = pathlib.Path(td)
            cases = (
                ([(101, b"python3\n", b"python3\x00heros_adventure_editor.py\x00edit\x00/tmp/Wulin.exe-backups/Save0\x00"), (102, b"bash\n", b"bash\x00-c\x00ls /tmp/Wulin.exe/Save0\x00"), (103, b"cat\n", b"cat\x00/mnt/Wulin.exe/\x00")], "NOT_RUNNING"),
                ([(201, b"wine64-preload\n", b"wine64\x00Z:\\Steam\\steamapps\\common\\Hero's Adventure\\Wulin.exe\x00-screen-fullscreen\x00")], "RUNNING"),
                ([(202, b"python3\n", b"python3\x00/steam/Proton 9.0/proton\x00waitforexitandrun\x00Z:\\Games\\Wulin.exe\x00")], "RUNNING"),
                ([(203, b"Wulin.exe\n", b"/games/Wulin.exe\x00")], "RUNNING"),
            )
            for entries, expected in cases:
                proc_root = base / f"proc_{entries[0][0]}"
                for pid, comm, cmdline in entries:
                    d = proc_root / str(pid)
                    d.mkdir(parents=True)
                    (d / "comm").write_bytes(comm)
                    (d / "cmdline").write_bytes(cmdline)
                self.assertEqual(cli._scan_proc_for_wulin(str(proc_root)), expected)
            wulin_dir = base / "Wulin.exe-backups"
            _, slot_dir = _make_demo_slot(wulin_dir)
            if _ORIG_DETECT_WULIN() == "NOT_RUNNING":
                res = subprocess.run(
                    [sys.executable, str(ROOT / "heros_adventure_editor.py"), "edit", str(slot_dir), "--coin", "54321"],
                    cwd=ROOT, capture_output=True, text=True, encoding="utf-8",
                )
                self.assertEqual(res.returncode, 0, res.stderr)
            for i, bad in enumerate((
                '{"Data":{"__type":"WuLin.SaveObjectBase,Assembly-CSharp","value":null}}',
                '{"Data":{"__type":"WuLin.SaveObjectBase,Assembly-CSharp","value":[]}}',
                '{"Data":{"__type":"WuLin.SaveObjectBase,Assembly-CSharp"}}',
                '{"Data":null}',
            )):
                bad_dir = base / f"bad_{i}"
                bad_dir.mkdir()
                (bad_dir / "SaveObjectPlayerTeam.save").write_bytes(cli.encode_es3_bytes(bad, mode="plain"))
                ed_bad = cli.SaveSlotEditor(bad_dir)
                with self.assertRaises(ValueError):
                    ed_bad.set_currency(0, 100)
            ed_ok = cli.SaveSlotEditor(slot_dir)
            with self.assertRaises(ValueError):
                ed_ok.set_currency(1, 100000000)
            ed_ok.set_currency(1, 99999999)
            self.assertEqual(ed_ok.get_currency(1), 99999999)

    def test_r6_c3_missing_libc_renameat2_refuses_cleanly(self):
        if not sys.platform.startswith("linux"):
            return
        import ctypes
        import errno
        import types
        import unittest.mock
        with tempfile.TemporaryDirectory() as td:
            base = pathlib.Path(td)
            po = unittest.mock.patch.object
            with cli.PinnedDirectory(base) as pin:
                pin.write_exclusive_leaf("src.tmp", b'{"x":1}')
                with po(ctypes, "CDLL", return_value=types.SimpleNamespace()), po(os, "link", side_effect=PermissionError(errno.EPERM, "no link")):
                    with self.assertRaises(OSError) as cm:
                        pin.publish_exclusive_leaf("src.tmp", "no_rn2.save")
                    self.assertTrue(cm.exception.errno == errno.EOPNOTSUPP)
                    self.assertFalse((base / "no_rn2.save").exists())


class TestRound7Regressions(_IsolatedWulinTestCase):
    def test_r7_c1_canonical_role_priority_and_duplicate_ambiguity_guard(self):
        import shutil

        with tempfile.TemporaryDirectory() as td:
            base = pathlib.Path(td)
            g1, s1 = _make_demo_slot(base / "c1_ok")
            shutil.copy2(s1 / "SaveObjectGame.save", s1 / "000-copy.save")
            shutil.copy2(g1 / "SaveObjectGameGlobal.save", s1 / "000-global-copy.save")
            copy_before = (s1 / "000-copy.save").read_bytes()
            global_copy_before = (s1 / "000-global-copy.save").read_bytes()
            rc, _, err = _run_cli("edit", str(s1), "--fief", "112=5")
            self.assertEqual(rc, 0, err)
            self.assertEqual((s1 / "000-copy.save").read_bytes(), copy_before)
            self.assertEqual((s1 / "000-global-copy.save").read_bytes(), global_copy_before)
            self.assertIn("112:5", cli.decode_es3_bytes((s1 / "SaveObjectGame.save").read_bytes())["text"])
            self.assertIn("112:5", cli.decode_es3_bytes((g1 / "SaveObjectGameGlobal.save").read_bytes())["text"])

            g2, s2 = _make_demo_slot(base / "c1_amb")
            shutil.copy2(s2 / "SaveObjectGame.save", s2 / "000-a.save")
            shutil.copy2(s2 / "SaveObjectGame.save", s2 / "001-b.save")
            (s2 / "SaveObjectGame.save").unlink()
            a_before = (s2 / "000-a.save").read_bytes()
            b_before = (s2 / "001-b.save").read_bytes()
            global_before = (g2 / "SaveObjectGameGlobal.save").read_bytes()
            with self.assertRaises(ValueError):
                cli.SaveSlotEditor(s2).set_fief_building(112, 5)
            self.assertNotEqual(_run_cli("edit", str(s2), "--fief", "112=5")[0], 0)
            self.assertEqual((s2 / "000-a.save").read_bytes(), a_before)
            self.assertEqual((s2 / "001-b.save").read_bytes(), b_before)
            self.assertEqual((g2 / "SaveObjectGameGlobal.save").read_bytes(), global_before)
            self.assertEqual(list(base.joinpath("c1_amb").rglob("*.bak")), [])

    def test_r7_c2_posix_fifo_nonblocking_rejection(self):
        if not hasattr(os, "mkfifo"):
            self.skipTest("mkfifo unavailable")
        import stat
        import time
        with tempfile.TemporaryDirectory() as td:
            base = pathlib.Path(td)
            def check_under_1s(fn):
                t0 = time.monotonic()
                res = fn()
                self.assertLess(time.monotonic() - t0, 1.0)
                return res

            def assert_fast_val_err(fn):
                check_under_1s(lambda: self.assertRaises(ValueError, fn))

            def assert_fast_cli_fail(*argv):
                self.assertNotEqual(check_under_1s(lambda: _run_cli(*argv))[0], 0)

            fifo_slot = base / "fifo_ed"
            fifo_slot.mkdir()
            os.mkfifo(fifo_slot / "SaveObjectGameTime.save")
            assert_fast_val_err(lambda: cli.SaveSlotEditor(fifo_slot / "SaveObjectGameTime.save"))

            g, slot = _make_demo_slot(base / "fifo_slot")
            src = slot / "SaveObjectGameTime.save"

            fifo_out = base / "fifo_out.json"
            os.mkfifo(fifo_out)
            assert_fast_cli_fail("decrypt", str(src), "-o", str(fifo_out), "--overwrite")
            self.assertTrue(stat.S_ISFIFO(os.lstat(fifo_out).st_mode))

            fifo_in = base / "fifo_in.save"
            os.mkfifo(fifo_in)
            def read_fifo():
                with cli.PinnedDirectory(base) as p:
                    p.read_leaf_bytes("fifo_in.save")
            assert_fast_val_err(read_fifo)
            assert_fast_cli_fail("decrypt", str(fifo_in), "-o", str(base / "never.json"))
            assert_fast_cli_fail("encrypt", str(fifo_in), "-o", str(base / "never.save"))

            swap_dir = base / "swap_in"
            swap_dir.mkdir()
            swap_in = swap_dir / "in.save"
            swap_in.write_bytes(src.read_bytes())
            def hook(_p):
                if _norm_abs(_p) == _norm_abs(swap_dir):
                    cli.HASE_TEST_AFTER_ENSURE_HOOK = None
                    swap_in.unlink()
                    os.mkfifo(swap_in)
            cli.HASE_TEST_AFTER_ENSURE_HOOK = hook
            try:
                assert_fast_cli_fail("decrypt", str(swap_in), "-o", str(base / "swap_out.json"))
                self.assertFalse((base / "swap_out.json").exists())
            finally:
                cli.HASE_TEST_AFTER_ENSURE_HOOK = None

            os.mkfifo(slot / ".hase-lock-SaveObjectPlayerTeam.save")
            with cli.PinnedDirectory(slot) as pin:
                assert_fast_val_err(lambda: pin.acquire_leaf_lock("SaveObjectPlayerTeam.save"))

    def test_r7_c3_missing_proc_fail_closed_yet_synthetic_tests_isolated(self):
        with tempfile.TemporaryDirectory() as td:
            base = pathlib.Path(td)
            po = unittest.mock.patch.object
            real_isdir = cli.os.path.isdir
            no_proc = lambda p: False if str(p) == "/proc" else real_isdir(p)
            with po(cli.os.path, "isdir", side_effect=no_proc), po(cli.subprocess, "run", side_effect=OSError("no tasklist")):
                with unittest.mock.patch.multiple(cli.os, name="posix"), _real_wulin_detection():
                    self.assertEqual(cli.detect_wulin_running(), "UNKNOWN")
                    with self.assertRaises(RuntimeError):
                        cli.check_wulin_not_running()

                self.assertEqual(_ORIG_DETECT_WULIN(), "UNKNOWN")
                cli.atomic_write_save(base / "syn.save", '{"ok":1}', mode="plain", expect_exists=False)
                self.assertEqual(_run_cli("decrypt", str(base / "syn.save"), "-o", str(base / "syn.json"))[0], 0)
                self.assertEqual(_run_cli("encrypt", str(base / "syn.json"), "-o", str(base / "syn2.save"), "--mode", "plain")[0], 0)


class TestRound8Regressions(_IsolatedWulinTestCase):
    def test_r8_c1_ambiguous_player_team_blocks_auto_target_yet_allows_explicit_char_uid(self):
        with tempfile.TemporaryDirectory() as td:
            slot = pathlib.Path(td) / "slot"
            slot.mkdir()
            payloads = [
                (
                    "000-teamA.save",
                    {
                        "Data": {
                            "value": {
                                "__type": "WuLin.SaveObjectPlayerTeam,Assembly-CSharp",
                                "playerTeam": [101],
                            }
                        }
                    },
                ),
                (
                    "001-teamB.save",
                    {
                        "Data": {
                            "value": {
                                "__type": "WuLin.SaveObjectPlayerTeam,Assembly-CSharp",
                                "playerTeam": [102],
                            }
                        }
                    },
                ),
                (
                    "SaveObjectGameCharacter.save",
                    {
                        "Data": {
                            "value": {
                                "__type": "WuLin.SaveObjectGameCharacter,Assembly-CSharp",
                                "createdCharacter": {
                                    "101": {
                                        "m_level": 10,
                                        "kungfuInstances": [
                                            {"m_templeteUid": 1001, "m_level": 1}
                                        ],
                                        "m_originProps": {},
                                    },
                                    "102": {
                                        "m_level": 20,
                                        "kungfuInstances": [
                                            {"m_templeteUid": 1001, "m_level": 1}
                                        ],
                                        "m_originProps": {},
                                    },
                                },
                            }
                        }
                    },
                ),
            ]
            for filename, payload in payloads:
                (slot / filename).write_bytes(
                    cli.encode_es3_bytes(json.dumps(payload), password="Meow")
                )
            snap = lambda: {
                p.name: p.read_bytes() for p in sorted(slot.glob("*.save"))
            }
            before = snap()
            bad_argvs = [
                ("edit", str(slot), "--char-level", "50"),
                ("edit", str(slot), "--max-kungfu"),
                ("edit", str(slot), "--preset", "party_kungfu_max"),
                ("edit", str(slot), "--preset", "hero_core_max"),
            ]
            for argv in bad_argvs:
                self.assertNotEqual(_run_cli(*argv)[0], 0)
                self.assertEqual(snap(), before)
            ed = cli.SaveSlotEditor(slot)
            calls = [
                lambda: ed.set_char_basic(level=50),
                lambda: ed.max_kungfu(),
                lambda: ed.apply_preset("party_kungfu_max"),
                lambda: ed.apply_preset("hero_core_max"),
            ]
            for call in calls:
                with self.assertRaises(ValueError):
                    call()
                self.assertFalse(ed.files["characters"]["dirty"])
            self.assertEqual(
                _run_cli(
                    "edit", str(slot), "--char-uid", "102", "--char-level", "50"
                )[0],
                0,
            )
            for team_name in ("000-teamA.save", "001-teamB.save"):
                self.assertEqual(
                    (slot / team_name).read_bytes(), before[team_name]
                )
            chars = json.loads(
                cli.decode_es3_bytes(
                    (slot / "SaveObjectGameCharacter.save").read_bytes(),
                    password="Meow",
                )["text"]
            )["Data"]["value"]["createdCharacter"]
            self.assertEqual(
                (chars["101"]["m_level"], chars["102"]["m_level"]), (10, 50)
            )

    def test_r8_c2_build_exe_quotes_comma_paths_via_utf8_bom_rsp_file(self):
        import importlib.util, shutil

        with tempfile.TemporaryDirectory() as td:
            proj = pathlib.Path(td) / "dir,with,comma"
            sdk = pathlib.Path(td) / "sdk,with,comma"
            proj.mkdir(parents=True)
            sdk.mkdir(parents=True)
            shutil.copy2(ROOT / "build.py", proj / "build.py")
            shutil.copytree(ROOT / "src", proj / "src")
            for name in (
                "Microsoft.Web.WebView2.Core.dll",
                "Microsoft.Web.WebView2.WinForms.dll",
                "WebView2Loader.dll",
                "LICENSE.txt",
            ):
                (sdk / name).write_text("dummy", encoding="utf-8")
            spec = importlib.util.spec_from_file_location(
                "round8_build_mod", proj / "build.py"
            )
            mod = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(mod)
            captured = {}

            def fake_run(cmd, **kw):
                self.assertEqual(len(cmd), 2)
                self.assertTrue(cmd[1].startswith("@"))
                rsp_path = pathlib.Path(cmd[1][1:])
                captured["rsp_path"] = rsp_path
                captured["raw"] = rsp_path.read_bytes()
                return unittest.mock.Mock(
                    returncode=0, stdout=b"", stderr=b""
                )

            old_argv = sys.argv
            try:
                sys.argv = [
                    str(proj / "build.py"),
                    "--exe",
                    "--webview2",
                    str(sdk),
                ]
                with unittest.mock.patch.object(
                    mod.subprocess, "run", side_effect=fake_run
                ):
                    mod.main()
            finally:
                sys.argv = old_argv

            self.assertTrue(captured["raw"].startswith(b"\xef\xbb\xbf"))
            rsp_text = captured["raw"].decode("utf-8-sig")
            proj_res = proj.resolve()
            sdk_res = sdk.resolve()
            expected_lines = [
                f'/out:"{proj_res / "dist" / "HerosAdventureSaveEditor-v1.0.exe"}"',
                f'/reference:"{sdk_res / "Microsoft.Web.WebView2.Core.dll"}"',
                f'/resource:"{proj_res / "dist" / "HerosAdventureSaveEditor-v1.0.html"}",editor.html',
                f'"{proj_res / "src" / "SaveEditor.cs"}"',
            ]
            for expected in expected_lines:
                self.assertIn(expected, rsp_text.splitlines())
            self.assertFalse(captured["rsp_path"].exists())
            self.assertEqual(list((proj_res / "dist").glob("*.rsp")), [])


class TestRound9Regressions(_IsolatedWulinTestCase):
    def _write_save(self, path, payload):
        path.write_bytes(cli.encode_es3_bytes(json.dumps(payload), "aes-gzip", "Meow"))

    def test_r9_a1_canonical_filename_vs_explicit_type_mismatch_blocks_fief_desync(self):
        with tempfile.TemporaryDirectory() as td:
            slot = pathlib.Path(td)
            self._write_save(slot / "SaveObjectGameGlobal.save", {
                "Data": {"value": {
                    "__type": "WuLin.SaveObjectGameGlobal,Assembly-CSharp",
                    "fiefSharedData": {"buildingLevelDict": {"112": 3}},
                }}
            })
            self._write_save(slot / "SaveObjectGame.save", {
                "Data": {"value": {
                    "__type": "WuLin.SaveObjectGameGlobal,Assembly-CSharp",
                    "privateFiefSharedData": {"buildingLevelDict": {"112": 3}},
                }}
            })
            before = {p.name: p.read_bytes() for p in sorted(slot.glob("*.save"))}
            ed = cli.SaveSlotEditor(slot)
            self.assertEqual((
                "game" in ed.broken_roles,
                "global#1" in ed.files,
                ed.files["global"]["path"].name,
                ed.files["game"]["path"].name,
            ), (True, False, "SaveObjectGameGlobal.save", "SaveObjectGame.save"))
            with self.assertRaises(ValueError):
                ed.set_fief_building(112, 5)
            self.assertEqual((ed.files["global"]["dirty"], ed.files["game"]["dirty"]), (False, False))
            self.assertNotEqual(_run_cli("edit", str(slot), "--fief", "112:5")[0], 0)
            self.assertEqual({p.name: p.read_bytes() for p in sorted(slot.glob("*.save"))}, before)

    def test_r9_c1_set_char_basic_without_hp_ep_does_not_synthesize_team_member_state(self):
        with tempfile.TemporaryDirectory() as td:
            slot = pathlib.Path(td)
            payload = {
                "Data": {"value": {
                    "__type": "WuLin.SaveObjectGameCharacter,Assembly-CSharp",
                    "createdCharacter": {
                        "102": {"m_level": 10},
                        "103": {"m_level": 12, "m_TeamMemberState": None},
                    },
                }}
            }
            self._write_save(slot / "SaveObjectGameCharacter.save", payload)
            for uid, lv in (("102", "50"), ("103", "60")):
                self.assertEqual(_run_cli("edit", str(slot), "--char-uid", uid, "--char-level", lv)[0], 0)
            raw = (slot / "SaveObjectGameCharacter.save").read_bytes()
            decoded = json.loads(cli.decode_es3_bytes(raw, password="Meow")["text"])
            chars = decoded["Data"]["value"]["createdCharacter"]
            self.assertEqual((
                chars["102"]["m_level"],
                "m_TeamMemberState" in chars["102"],
                chars["103"]["m_level"],
                "m_TeamMemberState" in chars["103"],
                chars["103"]["m_TeamMemberState"],
            ), (50, False, 60, True, None))

    def test_r9_c2_write_output_file_atomic_runs_game_check_before_final_sha256_verification(self):
        from unittest import mock
        with tempfile.TemporaryDirectory() as td:
            out = pathlib.Path(td) / "out.json"
            out.write_bytes(b'{"initial":1}')
            def mutate_during_check():
                out.write_bytes(b'{"external":999}')
                return "NOT_RUNNING"
            with mock.patch.object(cli, "detect_wulin_running", side_effect=mutate_during_check):
                with self.assertRaises(ValueError):
                    cli._write_output_file_atomic(out, b'{"editor":2}', overwrite=True, check_game=True)
            self.assertEqual((
                out.read_bytes(),
                list(pathlib.Path(td).glob("*.pending*")) + list(pathlib.Path(td).glob("*.bak")),
            ), (b'{"external":999}', []))


class TestRound10Regressions(_IsolatedWulinTestCase):
    def _put_plain(self, path, raw_json):
        path.write_bytes(cli.encode_es3_bytes(raw_json, "plain"))

    def test_r10_c1_batch_rollback_stages_tmp_before_rechecking_target_for_external_edit_or_delete(self):
        for action in ("modify", "delete"):
            with tempfile.TemporaryDirectory() as td:
                d = pathlib.Path(td) / action
                d.mkdir()
                f0, f1, f2 = d / "s0.save", d / "s1.save", d / "s2.save"
                self._put_plain(f0, '{"v":10}')
                self._put_plain(f1, '{"v":20}')
                self._put_plain(f2, '{"v":30}')
                b0, b1, b2 = f0.read_bytes(), f1.read_bytes(), f2.read_bytes()
                entries = [
                    {"target_path": p, "new_text": f'{{"v":{i + 100}}}', "mode": "plain"}
                    for i, p in enumerate((f0, f1, f2))
                ]

                def fault_injector(idx, target):
                    if idx == 2:
                        raise OSError("commit_fail_idx2")

                seen = {"n": 0}

                def rb_hook(fd, payload):
                    os.write(fd, payload)
                    os.fsync(fd)
                    seen["n"] += 1
                    if seen["n"] == 1:
                        if action == "modify":
                            f1.write_bytes(b'{"external":777}')
                        else:
                            f1.unlink()

                with self.assertRaises(OSError) as cm:
                    cli.atomic_write_save_batch(
                        entries,
                        ignore_running_game=True,
                        fault_injector=fault_injector,
                        rollback_writer_hook=rb_hook,
                    )

                msg = str(cm.exception)
                f1_state = f1.read_bytes() if action == "modify" else f1.exists()
                self.assertEqual(
                    (
                        str(f1) in msg,
                        ".bak" in msg,
                        f1_state,
                        any(p.read_bytes() == b1 for p in d.glob("s1.save.backup-*.bak")),
                        f0.read_bytes(),
                        f2.read_bytes(),
                        list(d.glob("*.rollback-*"))
                        + list(d.glob("*.pending-*"))
                        + list(d.glob("*.tmp-*")),
                    ),
                    (
                        True,
                        True,
                        b'{"external":777}' if action == "modify" else False,
                        True,
                        b0,
                        b2,
                        [],
                    ),
                )

    def test_r10_c2_canonical_filename_rejects_unrecognized_explicit_type_yet_allows_saveobjectbase_omitted_inner_type(self):
        with tempfile.TemporaryDirectory() as td:
            results = []
            for idx, bad_json in enumerate(
                (
                    '{"Data":{"value":{"__type":"Other.SaveObject,Assembly-CSharp"}}}',
                    '{"Data":{"__type":"WuLin.SaveObjectBase,Assembly-CSharp","value":{"__type":"Other.SaveObject,Assembly-CSharp"}}}',
                    '{"__type":"WuLin.SaveObjectGameUnknown,Assembly-CSharp"}',
                )
            ):
                slot = pathlib.Path(td) / f"bad_{idx}"
                slot.mkdir()
                pt = slot / "SaveObjectPlayerTeam.save"
                self._put_plain(pt, bad_json)
                orig = pt.read_bytes()
                ed = cli.SaveSlotEditor(slot)
                with self.assertRaises(ValueError):
                    ed.set_currency(0, 100)
                rc = _run_cli("edit", str(slot), "--coin", "100")[0]
                results.append(
                    (
                        "playerTeam" in ed.broken_roles,
                        ed.files["playerTeam"]["type_mismatch"] is True,
                        rc != 0,
                        pt.read_bytes() == orig,
                        list(slot.glob("*.bak")) == [],
                    )
                )

            ok_slot = pathlib.Path(td) / "ok"
            ok_slot.mkdir()
            self._put_plain(
                ok_slot / "SaveObjectPlayerTeam.save",
                '{"Data":{"__type":"WuLin.SaveObjectBase,Assembly-CSharp","value":{}}}',
            )
            rc = _run_cli("edit", str(ok_slot), "--coin", "100")[0]
            cur = cli.SaveSlotEditor(ok_slot).get_currency(0)
            results.append((rc == 0, cur == 100))
            self.assertEqual(results, [(True, True, True, True, True)] * 3 + [(True, True)])


class TestRound11Regressions(_IsolatedWulinTestCase):
    def test_r11_a2_bounded_gunzip_rejects_oversized_gzip_and_aes_gzip(self):
        with unittest.mock.patch.object(cli, "MAX_DECOMPRESSED_BYTES", 2048), tempfile.TemporaryDirectory() as td:
            big = json.dumps({"Data": {"value": {"pad": "A" * 16384}}})
            gz = cli.encode_es3_bytes(big, mode="gzip")
            aes_gz = cli.encode_es3_bytes(big, mode="aes-gzip", password="Meow")
            for data in (gz, aes_gz):
                with self.assertRaises(cli.DecompressedSizeLimitError):
                    cli.decode_es3_bytes(data, "Meow")
            p = pathlib.Path(td) / "SaveObjectPlayerTeam.save"
            p.write_bytes(aes_gz)
            with self.assertRaises(cli.DecompressedSizeLimitError):
                cli.SaveSlotEditor(p)
            small = '{"Data":{"value":{"ok":1}}}'
            self.assertEqual(
                cli.decode_es3_bytes(cli.encode_es3_bytes(small, mode="aes-gzip", password="Meow"), "Meow"),
                {"mode": "aes-gzip", "text": small},
            )

    def test_r11_c1_canonical_pinning_and_noncanonical_type_validation(self):
        bad_pt_json = '{"Data":{"__type":"WuLin.SaveObjectPlayerTeam,Assembly-CSharp","value":{"__type":"Other.SaveObject,Assembly-CSharp"}}}'
        with tempfile.TemporaryDirectory() as td:
            base = pathlib.Path(td)
            solo = base / "solo" / "000-playerteam.save"
            solo.parent.mkdir(parents=True)
            solo.write_text(bad_pt_json, encoding="utf-8")
            solo_before = solo.read_bytes()
            self.assertIn("playerTeam", cli.SaveSlotEditor(solo).broken_roles)
            self.assertNotEqual(_run_cli("edit", str(solo), "--coin", "100")[0], 0)
            self.assertEqual(solo.read_bytes(), solo_before)

            fief_dir = base / "fief"
            fief_dir.mkdir()
            gg = fief_dir / "SaveObjectGameGlobal.save"
            game = fief_dir / "SaveObjectGame.save"
            gg.write_text('{"Data":{"value":{"__type":"WuLin.SaveObjectGameGlobal,Assembly-CSharp","fiefSharedData":{"buildingLevelDict":{"112":3}}}}}', encoding="utf-8")
            game.write_text('{"__type":"WuLin.SaveObjectGameGlobal,Assembly-CSharp","Data":null}', encoding="utf-8")
            gg_before, game_before = gg.read_bytes(), game.read_bytes()
            ed = cli.SaveSlotEditor(fief_dir)
            self.assertIn("game", ed.broken_roles)
            self.assertNotIn("global#1", ed.files)
            self.assertEqual(ed.files["game"]["path"].name, "SaveObjectGame.save")
            self.assertNotEqual(_run_cli("edit", str(fief_dir), "--fief", "112:5")[0], 0)
            self.assertEqual((gg.read_bytes(), game.read_bytes()), (gg_before, game_before))

            mix_dir = base / "mix"
            mix_dir.mkdir()
            valid_pt = mix_dir / "SaveObjectPlayerTeam.save"
            bad_pt = mix_dir / "000-playerteam.save"
            valid_pt.write_text('{"Data":{"value":{"__type":"WuLin.SaveObjectPlayerTeam,Assembly-CSharp"}}}', encoding="utf-8")
            bad_pt.write_text(bad_pt_json, encoding="utf-8")
            bad_before = bad_pt.read_bytes()
            self.assertEqual(_run_cli("edit", str(mix_dir), "--coin", "100")[0], 0)
            self.assertEqual(cli.SaveSlotEditor(valid_pt).get_currency(0), 100)
            self.assertEqual(bad_pt.read_bytes(), bad_before)

    def test_r11_c2_threading_http_server_serves_concurrently_while_idle_socket_open(self):
        import socket, time
        with tempfile.TemporaryDirectory() as td:
            html_file = pathlib.Path(td) / "index.html"; html_file.write_text("<html>ok</html>", encoding="utf-8")
            srv = cli.create_http_server("127.0.0.1", 0, html_path=html_file); port = srv.server_address[1]
            t = threading.Thread(name="r11-http", target=srv.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True); t.start()
            idle = socket.create_connection(("127.0.0.1", port), timeout=2.0)
            try:
                http_dt = 0.0
                for ep in ("/", "/api/game-status"):
                    start = time.monotonic()
                    with urllib.request.urlopen(f"http://127.0.0.1:{port}{ep}", timeout=2.0) as r:
                        if ep == "/": self.assertEqual((r.status, r.read()), (200, b"<html>ok</html>"))
                        else: self.assertEqual(r.status, 200); self.assertIs(json.load(r)["ok"], True)
                    http_dt = max(http_dt, time.monotonic() - start)
                start = time.monotonic(); srv.shutdown(); srv.server_close(); t.join(timeout=2.0)
                stop_dt = time.monotonic() - start
                self.assertFalse(t.is_alive()); self.assertLess(max(http_dt, stop_dt), 2.0)
            finally:
                idle.close(); srv.server_close()

    def test_r11_c3_gitignore_and_collect_dir_saves_exclude_temp_and_lock_artifacts(self):
        import shutil
        with tempfile.TemporaryDirectory() as d:
            gi_text = (ROOT / ".gitignore").read_text(encoding="utf-8")
            pathlib.Path(d, ".gitignore").write_text(gi_text, encoding="utf-8")
            gi_lines = [ln.strip() for ln in gi_text.splitlines()]
            for pat in ("*.bak", "*.tmp", "*.tmp-*", "*.pending-*", "*.rollback-*", ".hase-lock-*", "*.rsp", "*.save", "*.es3"):
                self.assertIn(pat, gi_lines)
            if shutil.which("git"):
                subprocess.run(["git", "init", "-q"], cwd=d, check=True)
                for expected, files in (
                    (0, (
                        "Save0/SaveObjectPlayerTeam.save",
                        "Save0/SaveObjectPlayerTeam.save.backup-20261114185746-74556-45e26f6d.bak",
                        "Save0/SaveObjectPlayerTeam.save.backup-20261114185746-74556-45e26f6d.bak.tmp-74556-abcdef123456",
                        "Save0/SaveObjectPlayerTeam.save.pending-74556-45e26f6d.tmp",
                        "Save0/SaveObjectPlayerTeam.save.pending-74556-45e26f6d.tmp.tmp-74556-abcdef123456",
                        "Save0/SaveObjectPlayerTeam.save.rollback-74556-45e26f6d.tmp",
                        "out.json.tmp-74556-abcdef123456",
                        ".hase-lock-out.json",
                    )),
                    (1, ("heros_adventure_editor.py", "dist/HerosAdventureSaveEditor-v1.0.html")),
                ):
                    for rel in files:
                        self.assertEqual(subprocess.run(["git", "check-ignore", "--quiet", rel], cwd=d).returncode, expected, rel)
            slot_sub = pathlib.Path(d) / "slot"
            slot_sub.mkdir()
            (slot_sub / "SaveObjectPlayerTeam.save").write_text("{}", encoding="utf-8")
            (slot_sub / "SaveObjectPlayerTeam.save.tmp-99-abc.save").write_text("{}", encoding="utf-8")
            self.assertEqual(list(cli.SaveSlotEditor(slot_sub).files.keys()), ["playerTeam"])

    def test_r11_c4_write_output_file_atomic_cleans_staged_files_on_final_verify_error(self):
        with tempfile.TemporaryDirectory() as td:
            d1 = pathlib.Path(td) / "sym"; d1.mkdir()
            out = d1 / "out.json"; out.write_bytes(b'{"initial":1}')
            other = d1 / "other.json"; other.write_bytes(b'{"other":9}')
            try:
                probe = d1 / "p"; probe.symlink_to(other); probe.unlink(); supported = True
            except (OSError, NotImplementedError):
                supported = False
            if supported:
                def side(*_a, **_kw):
                    out.unlink(); out.symlink_to(other); return "NOT_RUNNING"
                with unittest.mock.patch.object(cli, "detect_wulin_running", side_effect=side):
                    with self.assertRaises(ValueError):
                        cli._write_output_file_atomic(out, b'{"new":2}', overwrite=True, check_game=True)
                self.assertTrue(out.is_symlink())
                self.assertEqual(other.read_bytes(), b'{"other":9}')
                self.assertEqual(list(d1.glob("*.pending*")) + list(d1.glob("*.bak")) + list(d1.glob("*.tmp*")), [])
            d2 = pathlib.Path(td) / "perm"; d2.mkdir()
            out2 = d2 / "out.json"; out2.write_bytes(b'{"initial":1}')
            orig_read = cli.PinnedDirectory.read_leaf_bytes; out_reads = 0
            def read_leaf(pin_self, name):
                nonlocal out_reads
                if name == "out.json":
                    out_reads += 1
                    if out_reads == 2: raise PermissionError("locked")
                return orig_read(pin_self, name)
            with unittest.mock.patch.object(cli.PinnedDirectory, "read_leaf_bytes", read_leaf):
                with self.assertRaises(PermissionError):
                    cli._write_output_file_atomic(out2, b'{"new":2}', overwrite=True, check_game=True)
            self.assertEqual(out_reads, 2)
            self.assertEqual(out2.read_bytes(), b'{"initial":1}')
            self.assertEqual(list(d2.glob("*.pending*")) + list(d2.glob("*.bak")) + list(d2.glob("*.tmp*")), [])


class TestRound12Regressions(_IsolatedWulinTestCase):
    @staticmethod
    def put(p, obj):
        p.write_text(json.dumps(obj), encoding="utf-8")

    def test_r12_c1_nested_non_object_value_wrappers_rejected_atomically(self):
        with tempfile.TemporaryDirectory() as td:
            root = pathlib.Path(td)
            cli_checks = []
            for idx, (gv, pv) in enumerate(((None, {"buildingLevelDict": {"112": 3}}), ({"buildingLevelDict": {"112": 3}}, None), ([], {"buildingLevelDict": {"112": 3}}), ({"buildingLevelDict": {"112": 3}}, "bad"))):
                slot = root / f"fief_{idx}"; slot.mkdir()
                gp = slot / "SaveObjectGameGlobal.save"; mp = slot / "SaveObjectGame.save"
                self.put(gp, {"Data": {"value": {"__type": "WuLin.SaveObjectGameGlobal,Assembly-CSharp", "fiefSharedData": {"value": gv}}}})
                self.put(mp, {"Data": {"value": {"__type": "WuLin.SaveObjectGame,Assembly-CSharp", "privateFiefSharedData": {"value": pv}}}})
                ed = cli.SaveSlotEditor(slot)
                with self.assertRaises(ValueError): ed.set_fief_building(112, 5)
                self.assertFalse(any(ed.files[r]["dirty"] for r in ("global", "game")))
                cli_checks.append((slot, (gp, mp), ("edit", str(slot), "--fief", "112:5")))
            for idx, tms in enumerate(({"value": None}, {"value": []}, {"value": "bad"})):
                cslot = root / f"char_{idx}"; cslot.mkdir()
                cp = cslot / "SaveObjectGameCharacter.save"; tp = cslot / "SaveObjectPlayerTeam.save"
                self.put(cp, {"Data": {"value": {"__type": "WuLin.SaveObjectGameCharacter,Assembly-CSharp", "createdCharacter": {"102": {"m_level": 10, "m_TeamMemberState": tms, "kungfuInstances": [{"m_templeteUid": 1, "m_level": 1}]}}}}})
                self.put(tp, {"Data": {"value": {"__type": "WuLin.SaveObjectPlayerTeam,Assembly-CSharp", "playerTeam": [102]}}})
                ed = cli.SaveSlotEditor(cslot)
                with self.assertRaises(ValueError): ed.set_char_basic(level=50, cur_hp=999, instance_id=102)
                with self.assertRaises(ValueError): ed.apply_preset("party_kungfu_max")
                node = ed._get_character(102)
                self.assertEqual((ed.files["characters"]["dirty"], cli.num_to_int(cli.obj_get(node, "m_level"), 0), cli.num_to_int(cli.obj_get(cli.obj_get(node, "kungfuInstances")[0], "m_level"), 0)), (False, 10, 1))
                cli_checks.append((cslot, (cp, tp), ("edit", str(cslot), "--char-uid", "102", "--char-level", "50", "--cur-hp", "999")))
            for slot_dir, paths, cmd in cli_checks:
                before = [p.read_bytes() for p in paths]
                self.assertEqual(_run_cli(*cmd)[0], 1)
                self.assertEqual([p.read_bytes() for p in paths], before)
                self.assertEqual(list(slot_dir.glob("*.bak")), [])

    def test_r12_a2_oversized_serialized_payload_rejected_before_disk_write(self):
        with unittest.mock.patch.dict(cli.__dict__, {"MAX_DECOMPRESSED_BYTES": 2048}), tempfile.TemporaryDirectory() as td:
            root = pathlib.Path(td); gp = root / "SaveObjectGame.save"
            gp.write_bytes(cli.encode_es3_bytes('{"Data":{"value":{"ok":1}}}', mode="aes-gzip", password="Meow")); before = gp.read_bytes()
            big = json.dumps({"Data": {"value": {"pad": "가" * 900}}})
            with self.assertRaises(cli.DecompressedSizeLimitError): cli.atomic_write_save(gp, big, mode="aes-gzip")
            self.assertEqual((gp.read_bytes(), list(root.glob("*.bak")), list(root.glob("*.tmp"))), (before, [], []))
            in_json = root / "in.json"; out_save = root / "out.save"; in_json.write_text(big, encoding="utf-8")
            self.assertEqual((_run_cli("encrypt", str(in_json), "-o", str(out_save), "--mode", "aes-gzip")[0], out_save.exists()), (1, False))


class TestRound13Regressions(_IsolatedWulinTestCase):
    def setUp(self):
        super().setUp()
        td = tempfile.TemporaryDirectory()
        self.addCleanup(td.cleanup)
        self.slot = pathlib.Path(td.name) / "slot"
        self.slot.mkdir()

    def _slot_cli(self, *args):
        return _run_cli(args[0], str(self.slot), *args[1:])

    def _inspect_protagonist(self):
        rc, out, _ = self._slot_cli("inspect", "--json")
        self.assertEqual(rc, 0)
        return json.loads(out)["protagonist"]

    def _save(self, chars):
        doc = {"Data": {"value": {"__type": "WuLin.SaveObjectGameCharacter,Assembly-CSharp", "createdCharacter": chars}}}
        (self.slot / "SaveObjectGameCharacter.save").write_bytes(
            cli.encode_es3_bytes(json.dumps(doc), mode="aes-gzip", password="Meow"))
        (self.slot / "SaveObjectPlayerTeam.save").unlink(missing_ok=True)

    def _load(self):
        return json.loads(cli.decode_es3_bytes(
            (self.slot / "SaveObjectGameCharacter.save").read_bytes(), password="Meow")["text"])["Data"]["value"]["createdCharacter"]

    def test_party_kungfu_max_uses_unique_100401(self):
        self._save({
            "10005": {"m_templeteUid": 10005, "m_level": 10, "m_TeamMemberState": {"isJoined": True}},
            "90001": {"m_templeteUid": 100401, "m_level": 12, "kungfuInstances": [{"m_templeteUid": 1, "m_level": 1}]},
        })
        self.assertEqual(self._inspect_protagonist()["instance_id"], 90001)
        self.assertEqual(self._slot_cli("edit", "--char-level", "50", "--preset", "party_kungfu_max")[0], 0)
        chars = self._load()
        self.assertEqual(chars["90001"]["m_level"], 50)
        self.assertEqual(chars["90001"]["kungfuInstances"][0]["m_level"], 10)
        self.assertEqual(chars["10005"]["m_level"], 10)

    def test_missing_or_ambiguous_100401_is_untouched(self):
        for chars in (
            {"10005": {"m_templeteUid": 10005, "m_level": 10, "m_TeamMemberState": {"isJoined": True}}},
            {"90001": {"m_templeteUid": 100401, "m_level": 10}, "90002": {"m_templeteUid": 100401, "m_level": 10}},
        ):
            with self.subTest(chars=chars):
                self._save(chars)
                path = self.slot / "SaveObjectGameCharacter.save"
                before = path.read_bytes()
                self.assertIsNone(self._inspect_protagonist())
                for bad in (("--char-level", "50"), ("--preset", "party_kungfu_max")):
                    self.assertEqual(self._slot_cli("edit", *bad)[0], 1)
                self.assertEqual(path.read_bytes(), before)
                self.assertFalse(list(self.slot.glob("*.bak")) or list(self.slot.glob("*.tmp")))


if __name__ == "__main__":
    unittest.main()
