using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;

class SaveStoreTests {
    static int total, passed;
    static void Assert(bool c, string m) { total++; if (!c) throw new Exception(m); passed++; }
    static void Reject(Action a, string m) { try { a(); } catch (IOException) { Assert(true, m); return; } catch (UnauthorizedAccessException) { Assert(true, m); return; } Assert(false, m); }
    static void Same(byte[] a, byte[] b, string m) { Assert(a.SequenceEqual(b), m); }
    static byte[] B(params byte[] x) { return x; }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool MoveFileExW(string lpExistingFileName, string lpNewFileName, uint dwFlags);

    class FaultStream : MemoryStream {
        public int FailWrites;
        public FaultStream(byte[] initial) : base() {
            base.Write(initial, 0, initial.Length);
            Position = 0;
        }
        public override void Write(byte[] buffer, int offset, int count) {
            if (FailWrites > 0) {
                FailWrites--;
                if (count > 0) base.Write(buffer, offset, 1);
                throw new IOException("fault");
            }
            base.Write(buffer, offset, count);
        }
    }

    static int Main(string[] args) {
        try {
            if (args.Length != 1) throw new Exception("Usage: SaveStoreTests.exe <new_folder>");
            string root = Path.GetFullPath(args[0]);
            if (Directory.Exists(root)) throw new Exception("Target folder already exists: " + root);
            Directory.CreateDirectory(root);

            string save = Path.Combine(root, "a.save");
            string es3 = Path.Combine(root, "b.ES3");
            string json = Path.Combine(root, "c.json");
            string txt = Path.Combine(root, "d.txt");
            string bak = Path.Combine(root, "e.bak");
            byte[] data = B(1, 2, 3, 4, 5);
            string hash = SaveStore.Hash(data);

            // 1) 확장자 허용/거부
            Assert(SaveStore.MaxSaveBytes == 32 * 1024 * 1024, "max bytes");
            Assert(SaveStore.IsSaveExtension(save) && SaveStore.IsSaveExtension(es3), "save/es3 extensions allowed");
            Assert(!SaveStore.IsSaveExtension(json) && !SaveStore.IsSaveExtension(txt) && !SaveStore.IsSaveExtension(bak), "other extensions rejected");

            // 3) WriteNew 생성·해시 검증 및 기존 파일 덮어쓰기 거부
            SaveStore.WriteNew(save, data);
            Same(SaveStore.Read(save), data, "write/read save");
            Assert(SaveStore.Hash(SaveStore.Read(save)) == hash, "sha256 hash matches");
            SaveStore.WriteNew(es3, data);
            Same(SaveStore.Read(es3), data, "write/read es3");
            File.WriteAllBytes(txt, data);
            Reject(delegate { SaveStore.Read(json); }, "read rejects json");
            Reject(delegate { SaveStore.Read(txt); }, "read rejects txt");
            Reject(delegate { SaveStore.Read(bak); }, "read rejects bak");
            Reject(delegate { SaveStore.ReplaceWithBackup(txt, hash, data); }, "replace rejects txt");
            Reject(delegate { SaveStore.CopyWithBackup(save, Path.Combine(root, "copy.txt"), hash, data, null); }, "copy rejects txt");
            Reject(delegate { SaveStore.WriteNew(save, data); }, "writenew rejects overwrite");

            // 2) UNC 경로 거부, 빈 파일/32MiB 초과 거부
            Reject(delegate { SaveStore.NoLinks(@"\\server\share\slot.save"); }, "unc path rejected");
            Reject(delegate { SaveStore.WriteNew(Path.Combine(root, "empty.save"), new byte[0]); }, "empty write rejected");
            File.WriteAllBytes(Path.Combine(root, "zero.save"), new byte[0]);
            Reject(delegate { SaveStore.Read(Path.Combine(root, "zero.save")); }, "zero-byte read rejected");
            byte[] tooBig = new byte[SaveStore.MaxSaveBytes + 1];
            Reject(delegate { SaveStore.WriteNew(Path.Combine(root, "big.save"), tooBig); }, "32MiB+ write rejected");
            Reject(delegate { SaveStore.ReplaceWithBackup(save, hash, tooBig); }, "32MiB+ replace rejected");
            Reject(delegate { SaveStore.CopyWithBackup(save, Path.Combine(root, "bigcopy.save"), hash, tooBig, null); }, "32MiB+ copy rejected");

            string bigRead = Path.Combine(root, "bigread.save");
            using (FileStream bigReadStream = new FileStream(bigRead, FileMode.CreateNew, FileAccess.Write, FileShare.None)) {
                bigReadStream.SetLength((long)SaveStore.MaxSaveBytes + 1);
            }
            Reject(delegate { SaveStore.Read(bigRead); }, "32MiB+ read rejected");

            // 4) ReplaceWithBackup: .backup-*.bak 생성, 해시 불일치 거부/보존, UpdateOrRestore 롤백
            string rep = Path.Combine(root, "rep.save");
            byte[] first = B(10, 11, 12), second = B(20, 21, 22, 23);
            SaveStore.WriteNew(rep, first);
            string b1 = SaveStore.ReplaceWithBackup(rep, SaveStore.Hash(first), second);
            Same(SaveStore.Read(rep), second, "replace updates slot");
            Assert(b1.IndexOf(".backup-", StringComparison.OrdinalIgnoreCase) >= 0 && b1.EndsWith(".bak", StringComparison.OrdinalIgnoreCase), "backup naming");
            Same(File.ReadAllBytes(b1), first, "backup preserves original bytes");
            string b2 = SaveStore.ReplaceWithBackup(rep, SaveStore.Hash(second), first);
            Assert(b2 != b1 && File.ReadAllBytes(b2).SequenceEqual(second) && File.ReadAllBytes(b1).SequenceEqual(first), "both backups preserved");
            Reject(delegate { SaveStore.ReplaceWithBackup(rep, "0000", second); }, "hash mismatch rejected");
            Same(SaveStore.Read(rep), first, "slot preserved on hash mismatch");

            string locked = Path.Combine(root, "locked.save");
            SaveStore.WriteNew(locked, first);
            using (FileStream fs = new FileStream(locked, FileMode.Open, FileAccess.ReadWrite, FileShare.None)) {
                Reject(delegate { SaveStore.ReplaceWithBackup(locked, SaveStore.Hash(first), second); }, "locked file rejected");
            }
            Same(SaveStore.Read(locked), first, "locked file preserved");

            byte[] before = B(30, 31, 32), after = B(40, 41, 42, 43);
            using (FaultStream temp = new FaultStream(before)) {
                temp.FailWrites = 1;
                Reject(delegate { SaveStore.UpdateOrRestore(temp, before, after, "manual.bak"); }, "transient fault reported");
                Same(temp.ToArray(), before, "transient fault rolled back");
            }
            using (FaultStream perm = new FaultStream(before)) {
                perm.FailWrites = int.MaxValue;
                try {
                    SaveStore.UpdateOrRestore(perm, before, after, "manual.bak");
                    Assert(false, "permanent fault must throw");
                } catch (IOException ex) {
                    Assert(ex.Message.Contains("manual.bak") && ex.Message.Contains("자동 원상복구에 실패"), "permanent fault reports backup");
                }
            }

            // 5) CopyWithBackup: 동일 경로/기존 파일 거부, 실패 시 .pending-* 정리 및 재시도 성공
            string src = Path.Combine(root, "src.save");
            string dst = Path.Combine(root, "dst.save");
            SaveStore.WriteNew(src, first);
            string origBak = SaveStore.CopyWithBackup(src, dst, SaveStore.Hash(first), second, null);
            Same(SaveStore.Read(src), first, "copy preserves source");
            Same(SaveStore.Read(dst), second, "copy writes destination");
            Same(File.ReadAllBytes(origBak), first, "copy original backup matches source");
            Reject(delegate { SaveStore.CopyWithBackup(src, src, SaveStore.Hash(first), second, null); }, "copy rejects same path");
            Reject(delegate { SaveStore.CopyWithBackup(src, dst, SaveStore.Hash(first), second, null); }, "copy rejects existing file");

            string failDst = Path.Combine(root, "fail.save");
            Reject(delegate {
                SaveStore.CopyWithBackup(src, failDst, SaveStore.Hash(first), second, delegate(Stream s, byte[] b) {
                    s.Write(b, 0, 1);
                    throw new IOException("injected copy failure");
                });
            }, "copy writer fault rejected");
            Assert(!File.Exists(failDst), "failed copy creates no destination");
            Assert(Directory.GetFiles(root, "*.pending-*").Length == 0, "failed copy cleans pending files");
            string retryBak = SaveStore.CopyWithBackup(src, failDst, SaveStore.Hash(first), second, null);
            Same(SaveStore.Read(failDst), second, "retry copy succeeds");
            Same(File.ReadAllBytes(retryBak), first, "retry backup matches source");

            // 6) [B8] WriteNew 부분 쓰기 예외 시 .bak 및 .tmp-* 미잔존
            string b8 = Path.Combine(root, "b8.bak");
            Reject(delegate { SaveStore.WriteNew(b8, B(1, 1), delegate(Stream s, byte[] d) { s.WriteByte(9); throw new IOException("b8 partial"); }); }, "[B8] partial write rejected");
            Assert(!File.Exists(b8), "[B8] failed write leaves no file");
            Assert(Directory.GetFiles(root, "*.tmp-*").Length == 0, "[B8] failed write leaves no temp file");

            // 7) [B9] TestAfterNoLinksHook 직후 junction 교체 시 VerifyOpenedHandle 차단
            if (Environment.OSVersion.Platform == PlatformID.Win32NT) {
                string jReal = Path.Combine(root, "jreal");
                string jEvil = Path.Combine(root, "jevil");
                int swapSeq = 0;
                Directory.CreateDirectory(jReal);
                Directory.CreateDirectory(jEvil);
                File.WriteAllBytes(Path.Combine(jReal, "v.save"), B(3, 3, 3));
                File.WriteAllBytes(Path.Combine(jEvil, "v.save"), B(3, 3, 3));
                Action<string> swapHook = delegate(string p) {
                    if (p.StartsWith(jReal, StringComparison.OrdinalIgnoreCase)) {
                        SaveStore.TestAfterNoLinksHook = null;
                        Directory.Move(jReal, jReal + "_orig" + (++swapSeq));
                        Process.Start(new ProcessStartInfo("cmd.exe", "/c mklink /J \"" + jReal + "\" \"" + jEvil + "\"") { CreateNoWindow = true, UseShellExecute = false }).WaitForExit();
                    }
                };
                try {
                    SaveStore.TestAfterNoLinksHook = swapHook;
                    Reject(delegate { SaveStore.Read(Path.Combine(jReal, "v.save")); }, "[B9] read junction swap rejected");
                    Directory.Delete(jReal, false);
                    Directory.CreateDirectory(jReal);
                    File.WriteAllBytes(Path.Combine(jReal, "v.save"), B(3, 3, 3));
                    SaveStore.TestAfterNoLinksHook = swapHook;
                    Reject(delegate { SaveStore.ReplaceWithBackup(Path.Combine(jReal, "v.save"), SaveStore.Hash(B(3, 3, 3)), B(4, 4, 4)); }, "[B9] replace junction swap rejected");
                    Same(File.ReadAllBytes(Path.Combine(jEvil, "v.save")), B(3, 3, 3), "[B9] evil target untouched");
                } finally {
                    SaveStore.TestAfterNoLinksHook = null;
                    if (Directory.Exists(jReal) && ((new DirectoryInfo(jReal).Attributes & FileAttributes.ReparsePoint) != 0)) Directory.Delete(jReal, false);
                }
            }

            // 8) [B3]/[G1] ReplaceBatch 해시 불일치 및 2번째 파일 쓰기 실패 시 전 파일 원상복구
            string b3a = Path.Combine(root, "b3a.save");
            string b3b = Path.Combine(root, "b3b.save");
            SaveStore.WriteNew(b3a, B(1, 1, 1));
            SaveStore.WriteNew(b3b, B(2, 2, 2));
            List<SaveStore.BatchItem> b3bad = new List<SaveStore.BatchItem>();
            b3bad.Add(new SaveStore.BatchItem { Path = b3a, ExpectedHash = SaveStore.Hash(B(1, 1, 1)), Data = B(7, 7, 7) });
            b3bad.Add(new SaveStore.BatchItem { Path = b3b, ExpectedHash = "0000", Data = B(8, 8, 8) });
            Reject(delegate { SaveStore.ReplaceBatch(b3bad, null); }, "[B3] batch hash mismatch rejected");
            Same(File.ReadAllBytes(b3a), B(1, 1, 1), "[B3] first file unchanged after hash mismatch");
            Same(File.ReadAllBytes(b3b), B(2, 2, 2), "[B3] second file unchanged after hash mismatch");
            Assert(Directory.GetFiles(root, "b3*.backup-*.bak").Length == 0, "[B3] no backups after hash mismatch");
            List<SaveStore.BatchItem> b3fault = new List<SaveStore.BatchItem>();
            b3fault.Add(new SaveStore.BatchItem { Path = b3a, ExpectedHash = SaveStore.Hash(B(1, 1, 1)), Data = B(7, 7, 7) });
            b3fault.Add(new SaveStore.BatchItem { Path = b3b, ExpectedHash = SaveStore.Hash(B(2, 2, 2)), Data = B(8, 8, 8) });
            Reject(delegate { SaveStore.ReplaceBatch(b3fault, delegate(int idx, Stream s) { if (idx == 1) { s.Position = 0; s.WriteByte(99); throw new IOException("fault2"); } }); }, "[B3] batch fault rejected");
            Same(File.ReadAllBytes(b3a), B(1, 1, 1), "[B3] first file rolled back after fault");
            Same(File.ReadAllBytes(b3b), B(2, 2, 2), "[B3] second file rolled back after fault");
            Assert(Directory.GetFiles(root, "b3a.save.backup-*.bak").Length == 1, "[B3] first backup exists after fault");
            Assert(Directory.GetFiles(root, "b3b.save.backup-*.bak").Length == 1, "[B3] second backup exists after fault");
            List<SaveStore.BatchItem> b3good = new List<SaveStore.BatchItem>();
            b3good.Add(new SaveStore.BatchItem { Path = b3a, ExpectedHash = SaveStore.Hash(B(1, 1, 1)), Data = B(7, 7, 7) });
            b3good.Add(new SaveStore.BatchItem { Path = b3b, ExpectedHash = SaveStore.Hash(B(2, 2, 2)), Data = B(8, 8, 8) });
            IList<string> b3backs = SaveStore.ReplaceBatch(b3good, null);
            Assert(b3backs.Count == 2, "[G1] batch returns two backups");
            Same(File.ReadAllBytes(b3a), B(7, 7, 7), "[G1] first file replaced");
            Same(File.ReadAllBytes(b3b), B(8, 8, 8), "[G1] second file replaced");

            // 9) [R2-B5] PinParentDirectory & TestBeforePublishHook & TestReplaceBatchFailAtCommitIndex
            if (Environment.OSVersion.Platform == PlatformID.Win32NT) {
                string pinDir = Path.Combine(root, "pin-" + Guid.NewGuid().ToString("N"));
                Directory.CreateDirectory(pinDir);
                string pinFile = Path.Combine(pinDir, "pin.save");
                bool pinBlocked = false;

                try {
                    SaveStore.TestBeforePublishHook = delegate(string p) {
                        try {
                            Directory.Move(pinDir, pinDir + "_moved");
                        } catch (IOException) {
                            pinBlocked = true;
                        } catch (UnauthorizedAccessException) {
                            pinBlocked = true;
                        }
                    };

                    SaveStore.WriteNew(pinFile, B(5, 6, 7));
                    Assert(pinBlocked, "[R2-B5] parent directory pin blocks move");
                    Same(File.ReadAllBytes(pinFile), B(5, 6, 7), "[R2-B5] pinned write succeeded");
                } finally {
                    SaveStore.TestBeforePublishHook = null;
                }

                string abortDir = Path.Combine(root, "abort-" + Guid.NewGuid().ToString("N"));
                Directory.CreateDirectory(abortDir);
                string abortFile = Path.Combine(abortDir, "abort.save");

                try {
                    SaveStore.TestBeforePublishHook = delegate(string p) {
                        throw new IOException("abort publish");
                    };

                    Reject(delegate { SaveStore.WriteNew(abortFile, B(1, 2, 3)); }, "[R2-B5] hook abort rejects write");
                    Assert(!File.Exists(abortFile), "[R2-B5] aborted file not published");
                    Assert(Directory.GetFiles(abortDir, "*.tmp-*").Length == 0, "[R2-B5] aborted temp cleaned");
                } finally {
                    SaveStore.TestBeforePublishHook = null;
                }

                string tamperDir = Path.Combine(root, "tamper-" + Guid.NewGuid().ToString("N"));
                Directory.CreateDirectory(tamperDir);
                string srcA = Path.Combine(tamperDir, "srcA.save");
                string dstA = Path.Combine(tamperDir, "dstA.save");
                File.WriteAllBytes(srcA, B(1, 2, 3));

                try {
                    SaveStore.TestBeforePublishHook = delegate(string p) {
                        if (!String.Equals(p, dstA, StringComparison.OrdinalIgnoreCase))
                            return;

                        string[] pend = Directory.GetFiles(tamperDir, "*.pending-*");
                        Assert(pend.Length == 1, "[R3-B4] pending file exists during hook");
                        File.WriteAllBytes(pend[0], B(9, 9, 9));
                    };

                    Reject(delegate { SaveStore.CopyWithBackup(srcA, dstA, SaveStore.Hash(B(1, 2, 3)), B(4, 5, 6)); }, "[R3-B4] tampering locked pending file aborts CopyWithBackup");
                    Assert(!File.Exists(dstA), "[R3-B4] tampered destination not published");
                    Assert(Directory.GetFiles(tamperDir, "*.pending-*").Length == 0, "[R3-B4] no pending residue after aborted tamper");
                } finally {
                    SaveStore.TestBeforePublishHook = null;
                }

                string srcB = Path.Combine(tamperDir, "srcB.save");
                string dstB = Path.Combine(tamperDir, "dstB.save");
                File.WriteAllBytes(srcB, B(1, 2, 3));
                bool tamperBlocked = false;

                try {
                    SaveStore.TestBeforePublishHook = delegate(string p) {
                        if (!String.Equals(p, dstB, StringComparison.OrdinalIgnoreCase))
                            return;

                        string[] pend = Directory.GetFiles(tamperDir, "*.pending-*");
                        Assert(pend.Length == 1, "[R3-B4] pending file exists for untampered publish");
                        try {
                            File.WriteAllBytes(pend[0], B(9, 9, 9));
                        } catch (IOException) {
                            tamperBlocked = true;
                        }
                    };

                    string copyBak = SaveStore.CopyWithBackup(srcB, dstB, SaveStore.Hash(B(1, 2, 3)), B(7, 8, 9));
                    Assert(tamperBlocked, "[R3-B4] FILE_SHARE_NONE blocked external pending overwrite");
                    Assert(File.Exists(copyBak), "[R3-B4] original backup created");
                    Same(File.ReadAllBytes(dstB), B(7, 8, 9), "[R3-B4] destination published exact verified bytes untampered");
                    Assert(Directory.GetFiles(tamperDir, "*.pending-*").Length == 0, "[R3-B4] no pending residue after publish");
                } finally {
                    SaveStore.TestBeforePublishHook = null;
                }
            }

            try {
                SaveStore.TestReplaceBatchFailAtCommitIndex = 1;
                List<SaveStore.BatchItem> failBatch = new List<SaveStore.BatchItem>();
                SaveStore.BatchItem failA = new SaveStore.BatchItem();
                failA.Path = b3a;
                failA.ExpectedHash = SaveStore.Hash(B(7, 7, 7));
                failA.Data = B(9, 9, 9);
                failBatch.Add(failA);
                SaveStore.BatchItem failB = new SaveStore.BatchItem();
                failB.Path = b3b;
                failB.ExpectedHash = SaveStore.Hash(B(8, 8, 8));
                failB.Data = B(6, 6, 6);
                failBatch.Add(failB);

                Reject(delegate { SaveStore.ReplaceBatch(failBatch, null); }, "[R2-B5] batch fails at commit index");
                Same(File.ReadAllBytes(b3a), B(7, 7, 7), "[R2-B5] first file restored");
                Same(File.ReadAllBytes(b3b), B(8, 8, 8), "[R2-B5] second file restored");
            } finally {
                SaveStore.TestReplaceBatchFailAtCommitIndex = -1;
            }

            if (Environment.OSVersion.Platform == PlatformID.Win32NT)
            {
                string bakLockDir = Path.Combine(root, "bakLockDir");
                Directory.CreateDirectory(bakLockDir);
                string f1 = Path.Combine(bakLockDir, "f1.save");
                string f2 = Path.Combine(bakLockDir, "f2.save");
                File.WriteAllBytes(f1, B(1, 2, 3));
                File.WriteAllBytes(f2, B(4, 5, 6));
                List<SaveStore.BatchItem> batch1 = new List<SaveStore.BatchItem>();
                batch1.Add(new SaveStore.BatchItem { Path = f1, ExpectedHash = SaveStore.Hash(B(1, 2, 3)), Data = B(7, 7, 7) });
                batch1.Add(new SaveStore.BatchItem { Path = f2, ExpectedHash = SaveStore.Hash(B(4, 5, 6)), Data = B(8, 8, 8) });
                Reject(delegate { SaveStore.ReplaceBatch(batch1, delegate(int idx, Stream s) { if (idx == 0) { string[] baks = Directory.GetFiles(bakLockDir, "*.bak"); File.WriteAllBytes(baks[0], B(9, 9, 9)); } }); }, "[R4-B1] overwriting locked backup throws IOException");
                Same(File.ReadAllBytes(f1), B(1, 2, 3), "[R4-B1] first target preserved after locked backup failure");
                Same(File.ReadAllBytes(f2), B(4, 5, 6), "[R4-B1] second target preserved after locked backup failure");

                string bakLockDir2 = Path.Combine(root, "bakLockDir2");
                Directory.CreateDirectory(bakLockDir2);
                string f3 = Path.Combine(bakLockDir2, "f1.save");
                string f4 = Path.Combine(bakLockDir2, "f2.save");
                File.WriteAllBytes(f3, B(1, 2, 3));
                File.WriteAllBytes(f4, B(4, 5, 6));
                List<SaveStore.BatchItem> batch2 = new List<SaveStore.BatchItem>();
                batch2.Add(new SaveStore.BatchItem { Path = f3, ExpectedHash = SaveStore.Hash(B(1, 2, 3)), Data = B(7, 7, 7) });
                batch2.Add(new SaveStore.BatchItem { Path = f4, ExpectedHash = SaveStore.Hash(B(4, 5, 6)), Data = B(8, 8, 8) });
                bool bakProtected = false;
                IList<string> okBacks = SaveStore.ReplaceBatch(batch2, delegate(int idx, Stream s) { if (idx == 0) { try { File.WriteAllBytes(Directory.GetFiles(bakLockDir2, "*.bak")[0], B(9, 9, 9)); } catch (IOException) { bakProtected = true; } } });
                Assert(bakProtected, "[R4-B1] backup remains protected during successful replace");
                Assert(okBacks.Count == 2, "[R4-B1] both backups returned");
                Assert(SaveStore.Hash(File.ReadAllBytes(okBacks[0])) == SaveStore.Hash(B(1, 2, 3)), "[R4-B1] returned backup matches original");
                Same(File.ReadAllBytes(f3), B(7, 7, 7), "[R4-B1] committed target updated");
            }

            string rtDir = Path.Combine(root, "rtDir");
            Directory.CreateDirectory(rtDir);
            string dllPath = Path.Combine(rtDir, "WebView2Loader.dll");
            string evilTmp = Path.Combine(rtDir, "evil.dll");
            File.WriteAllBytes(evilTmp, B(66, 77));

            Action<string> checkLocked = delegate(string tag)
            {
                Same(File.ReadAllBytes(dllPath), B(10, 20, 30, 40), tag + " read allowed");

                if (Environment.OSVersion.Platform == PlatformID.Win32NT)
                {
                    Reject(delegate { using (new FileStream(dllPath, FileMode.Open, FileAccess.Write, FileShare.ReadWrite)) { } }, tag + " write blocked");
                    Reject(delegate { File.Delete(dllPath); }, tag + " delete blocked");
                    Reject(delegate { File.Copy(evilTmp, dllPath, true); }, tag + " overwrite copy blocked");
                    Assert(!MoveFileExW(evilTmp, dllPath, 1u), tag + " MoveFileExW replace blocked");
                    Reject(delegate { Directory.Move(rtDir, rtDir + "_moved"); }, tag + " parent dir pin blocks rename");
                }
            };

            using (IDisposable g1 = SaveStore.EnsurePinnedRuntimeFile(dllPath, B(10, 20, 30, 40)))
            {
                checkLocked("[R6-B2 fresh]");
            }

            using (IDisposable g2 = SaveStore.EnsurePinnedRuntimeFile(dllPath, B(10, 20, 30, 40)))
            {
                checkLocked("[R6-B2 existing]");
            }

            File.WriteAllBytes(dllPath, B(99, 99));
            using (IDisposable g3 = SaveStore.EnsurePinnedRuntimeFile(dllPath, B(10, 20, 30, 40)))
            {
                Same(File.ReadAllBytes(dllPath), B(10, 20, 30, 40), "[R4-B3] runtime file repaired");
            }
            Assert(Directory.GetFiles(rtDir, "*.tmp-*").Length == 0, "[R4-B3] no temp runtime files remain");
            File.Delete(dllPath);
            Assert(!File.Exists(dllPath), "[R6-B2] delete succeeds after Dispose");

            if (Environment.OSVersion.Platform == PlatformID.Win32NT)
            {
                string rtReal = Path.Combine(root, "rtReal");
                string rtEvil = Path.Combine(root, "rtEvil");
                Directory.CreateDirectory(rtReal);
                Directory.CreateDirectory(rtEvil);
                File.WriteAllBytes(Path.Combine(rtEvil, "WebView2Loader.dll"), B(7, 7));
                try
                {
                    SaveStore.TestAfterNoLinksHook = delegate(string p)
                    {
                        if (p.StartsWith(rtReal, StringComparison.OrdinalIgnoreCase))
                        {
                            SaveStore.TestAfterNoLinksHook = null;
                            Directory.Move(rtReal, rtReal + "_orig");
                            ProcessStartInfo psi = new ProcessStartInfo("cmd.exe", "/c mklink /J \"" + rtReal + "\" \"" + rtEvil + "\"");
                            psi.CreateNoWindow = true;
                            psi.UseShellExecute = false;
                            Process.Start(psi).WaitForExit();
                        }
                    };
                    Reject(delegate { SaveStore.EnsurePinnedRuntimeFile(Path.Combine(rtReal, "WebView2Loader.dll"), B(10, 20, 30, 40)); }, "[R4-B3] junction swap rejected");
                }
                finally
                {
                    SaveStore.TestAfterNoLinksHook = null;
                }
                Same(File.ReadAllBytes(Path.Combine(rtEvil, "WebView2Loader.dll")), B(7, 7), "[R4-B3] decoy runtime untouched");
            }

            Console.WriteLine("PASS " + passed + "/" + total);
            Environment.ExitCode = 0;
            return 0;
        } catch (Exception ex) {
            Console.Error.WriteLine("FAIL: " + ex.Message);
            Environment.ExitCode = 1;
            return 1;
        }
    }
}
