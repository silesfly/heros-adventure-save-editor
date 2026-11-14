using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using Microsoft.Win32.SafeHandles;

internal static class SaveStore {
    internal const int MaxSaveBytes = 32 * 1024 * 1024;

    private const uint FileAttributeDirectory = 0x10u;
    private const uint FileAttributeReparsePoint = 0x400u;

    internal static Action<string> TestAfterNoLinksHook = null;
    internal static Action<string> TestBeforePublishHook = null;
    internal static int TestReplaceBatchFailAtCommitIndex = -1;

    [StructLayout(LayoutKind.Sequential)]
    private struct FILETIME {
        public uint dwLowDateTime;
        public uint dwHighDateTime;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct BY_HANDLE_FILE_INFORMATION {
        public uint FileAttributes;
        public FILETIME CreationTime;
        public FILETIME LastAccessTime;
        public FILETIME LastWriteTime;
        public uint VolumeSerialNumber;
        public uint FileSizeHigh;
        public uint FileSizeLow;
        public uint NumberOfLinks;
        public uint FileIndexHigh;
        public uint FileIndexLow;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetFileInformationByHandle(
        SafeFileHandle hFile,
        out BY_HANDLE_FILE_INFORMATION lpFileInformation);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true, EntryPoint = "GetFinalPathNameByHandleW")]
    private static extern uint GetFinalPathNameByHandleW(
        SafeFileHandle hFile,
        StringBuilder lpszFilePath,
        uint cchFilePath,
        uint dwFlags);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafeFileHandle CreateFileW(
        string lpFileName,
        uint dwDesiredAccess,
        uint dwShareMode,
        IntPtr lpSecurityAttributes,
        uint dwCreationDisposition,
        uint dwFlagsAndAttributes,
        IntPtr hTemplateFile);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetFileInformationByHandle(
        SafeFileHandle hFile,
        int FileInformationClass,
        IntPtr lpFileInformation,
        uint dwBufferSize);

    private static void RenameByHandle(SafeFileHandle hFile, string fullPath, bool replaceIfExists) {
        byte[] nameBytes = Encoding.Unicode.GetBytes(fullPath);
        int rootOffset = IntPtr.Size;
        int lenOffset = IntPtr.Size * 2;
        int strOffset = lenOffset + 4;
        int total = strOffset + nameBytes.Length + 2;
        IntPtr buf = Marshal.AllocHGlobal(total);
        try {
            for (int i = 0; i < total; i++) Marshal.WriteByte(buf, i, 0);
            Marshal.WriteByte(buf, 0, replaceIfExists ? (byte)1 : (byte)0);
            Marshal.WriteIntPtr(buf, rootOffset, IntPtr.Zero);
            Marshal.WriteInt32(buf, lenOffset, nameBytes.Length);
            Marshal.Copy(nameBytes, 0, new IntPtr(buf.ToInt64() + strOffset), nameBytes.Length);
            if (!SetFileInformationByHandle(hFile, 3, buf, (uint)total)) {
                int winErr = Marshal.GetLastWin32Error();
                throw new IOException("새 파일 원자적 이동에 실패했습니다(" + winErr + "): " + fullPath);
            }
        } finally {
            Marshal.FreeHGlobal(buf);
        }
    }

    private static void RenameExclusiveByHandle(SafeFileHandle hFile, string fullPath) {
        RenameByHandle(hFile, fullPath, false);
    }

    internal sealed class BatchItem {
        public string Path;
        public string ExpectedHash;
        public byte[] Data;
    }

    private sealed class PreparedBatchEntry {
        public string FullPath;
        public string ExpectedHash;
        public byte[] Data;
        public byte[] Before;
        public FileStream Stream;
        public FileStream BackupStream;
        public string BackupPath;
    }

    internal static bool IsSaveExtension(string path) {
        if (String.IsNullOrEmpty(path)) return false;
        string ext = Path.GetExtension(path);
        return String.Equals(ext, ".save", StringComparison.OrdinalIgnoreCase) ||
               String.Equals(ext, ".es3", StringComparison.OrdinalIgnoreCase);
    }

    internal static string Hash(byte[] bytes) {
        if (bytes == null) throw new ArgumentNullException("bytes");
        using (SHA256 sha = SHA256.Create())
            return BitConverter.ToString(sha.ComputeHash(bytes)).Replace("-", "").ToLowerInvariant();
    }

    private static void NoLinksCore(string path) {
        if (String.IsNullOrEmpty(path))
            throw new IOException("경로가 비어 있습니다.");

        string p = Path.GetFullPath(path);
        if (p.StartsWith(@"\\", StringComparison.Ordinal))
            throw new IOException("로컬 디스크의 세이브 파일을 선택하세요.");

        while (!String.IsNullOrEmpty(p)) {
            if ((File.Exists(p) || Directory.Exists(p)) &&
                (File.GetAttributes(p) & FileAttributes.ReparsePoint) != 0)
                throw new IOException("링크 경로는 지원하지 않습니다: " + p);

            p = Path.GetDirectoryName(p);
        }
    }

    internal static void NoLinks(string path) {
        NoLinksCore(path);
        Action<string> hook = TestAfterNoLinksHook;
        if (hook != null) hook(path);
    }

    private static string NormalizeFullPathNoTrailingSlash(string p) {
        string full = Path.GetFullPath(p);
        string root = Path.GetPathRoot(full);
        if (root != null && full.Length > root.Length)
            full = full.TrimEnd('\\', '/');
        return full;
    }

    private static void VerifySafeHandle(SafeFileHandle handle, string expectedFullPath, bool requireDirectory) {
        if (handle == null || handle.IsInvalid || handle.IsClosed)
            throw new IOException("열린 파일 핸들이 유효하지 않습니다.");

        BY_HANDLE_FILE_INFORMATION info;
        if (!GetFileInformationByHandle(handle, out info))
            throw new IOException("파일 핸들 정보를 확인할 수 없습니다.");

        if ((info.FileAttributes & FileAttributeReparsePoint) != 0)
            throw new IOException("링크 경로는 지원하지 않습니다: " + expectedFullPath);

        if (requireDirectory && (info.FileAttributes & FileAttributeDirectory) == 0)
            throw new IOException("폴더 핸들이 아닙니다: " + expectedFullPath);

        StringBuilder sb = new StringBuilder(512);
        uint resultLength = GetFinalPathNameByHandleW(handle, sb, (uint)sb.Capacity, 0);

        if (resultLength >= sb.Capacity) {
            sb = new StringBuilder((int)resultLength + 1);
            resultLength = GetFinalPathNameByHandleW(handle, sb, (uint)sb.Capacity, 0);
        }

        if (resultLength == 0)
            throw new IOException("최종 파일 경로를 확인할 수 없습니다.");

        string result = sb.ToString();
        if (String.IsNullOrEmpty(result))
            throw new IOException("최종 파일 경로가 비어 있습니다.");
        if (result.StartsWith(@"\\?\UNC\", StringComparison.OrdinalIgnoreCase))
            throw new IOException("네트워크 경로는 지원하지 않습니다.");

        string finalPath = result;
        if (finalPath.StartsWith(@"\\?\", StringComparison.Ordinal))
            finalPath = finalPath.Substring(4);

        NoLinksCore(finalPath);

        if (!String.Equals(NormalizeFullPathNoTrailingSlash(finalPath), NormalizeFullPathNoTrailingSlash(expectedFullPath), StringComparison.OrdinalIgnoreCase))
            throw new IOException("열린 파일 경로가 예상 경로와 다릅니다: " + finalPath);
    }

    internal static void VerifyOpenedHandle(FileStream stream, string expectedFullPath) {
        if (stream == null)
            throw new IOException("파일 스트림이 비어 있습니다.");
        if (String.IsNullOrEmpty(expectedFullPath))
            throw new IOException("확인할 파일 경로가 비어 있습니다.");

        if (Environment.OSVersion.Platform != PlatformID.Win32NT)
            return;

        VerifySafeHandle(stream.SafeFileHandle, expectedFullPath, false);
    }

    internal static SafeFileHandle PinParentDirectory(string fullPath) {
        string parentDir = Path.GetDirectoryName(Path.GetFullPath(fullPath));
        if (String.IsNullOrEmpty(parentDir) || !Directory.Exists(parentDir))
            throw new IOException("상위 폴더를 찾을 수 없습니다: " + fullPath);

        NoLinksCore(parentDir);

        if (Environment.OSVersion.Platform != PlatformID.Win32NT)
            return null;

        SafeFileHandle handle = CreateFileW(parentDir, 1u, 3u, IntPtr.Zero, 3u, 0x02000000u, IntPtr.Zero);
        try {
            if (handle == null || handle.IsInvalid)
                throw new IOException("상위 폴더 핸들을 열 수 없습니다: " + parentDir);
            VerifySafeHandle(handle, parentDir, true);
            return handle;
        } catch {
            if (handle != null)
                handle.Dispose();
            throw;
        }
    }

    internal static byte[] Read(string path) {
        if (String.IsNullOrEmpty(path))
            throw new IOException("세이브 파일(.save/.es3)을 선택하세요.");

        string fullPath = Path.GetFullPath(path);
        NoLinks(fullPath);
        if (!IsSaveExtension(fullPath))
            throw new IOException("세이브 파일(.save/.es3)을 선택하세요.");

        using (FileStream stream = new FileStream(fullPath, FileMode.Open, FileAccess.Read, FileShare.Read)) {
            VerifyOpenedHandle(stream, fullPath);
            if (stream.Length <= 0 || stream.Length > MaxSaveBytes)
                throw new IOException("32 MiB 이하의 세이브 파일(.save/.es3)을 선택하세요.");
            return ReadFrom(stream, (int)stream.Length);
        }
    }

    internal static void WriteNew(string path, byte[] data, Action<Stream, byte[]> writer = null) {
        WriteAtomicNew(path, ".tmp-", data, writer);
    }

    internal sealed class PinnedRuntimeFile : IDisposable
    {
        private Stream fileLock;
        private SafeFileHandle dirPin;

        internal PinnedRuntimeFile(SafeFileHandle pin, Stream stream)
        {
            this.dirPin = pin;
            this.fileLock = stream;
        }

        public void Dispose()
        {
            try
            {
                if (this.fileLock != null)
                {
                    try { this.fileLock.Dispose(); }
                    catch { }
                    this.fileLock = null;
                }
            }
            finally
            {
                if (this.dirPin != null)
                {
                    try
                    {
                        if (!this.dirPin.IsInvalid && !this.dirPin.IsClosed)
                            this.dirPin.Dispose();
                    }
                    catch { }
                    this.dirPin = null;
                }
            }
        }
    }

    private static FileStream OpenVerifiedReadLockedRuntimeStream(string fullPath)
    {
        SafeFileHandle hLock = CreateFileW(fullPath, 0x80000000u, 1u, IntPtr.Zero, 3u, 0x00200000u, IntPtr.Zero);
        if (hLock == null || hLock.IsInvalid)
        {
            int winErr = Marshal.GetLastWin32Error();
            if (hLock != null) hLock.Dispose();
            throw new IOException("런타임 파일을 읽기 잠금으로 열지 못했습니다(" + winErr + "): " + fullPath);
        }

        try
        {
            VerifySafeHandle(hLock, fullPath, false);
            return new FileStream(hLock, FileAccess.Read);
        }
        catch
        {
            try { hLock.Dispose(); }
            catch { }
            throw;
        }
    }

    private static bool MatchesExpectedRuntimeBytes(Stream stream, byte[] expectedBytes)
    {
        if (stream == null || expectedBytes == null) return false;
        if (stream.Length != expectedBytes.Length) return false;
        stream.Position = 0;
        byte[] cur = ReadFrom(stream, (int)stream.Length);
        return String.Equals(Hash(cur), Hash(expectedBytes), StringComparison.OrdinalIgnoreCase);
    }

    internal static IDisposable EnsurePinnedRuntimeFile(string path, byte[] expectedBytes)
    {
        if (String.IsNullOrEmpty(path)) throw new IOException("런타임 파일 경로가 비어 있습니다.");
        if (expectedBytes == null || expectedBytes.Length <= 0 || expectedBytes.Length > MaxSaveBytes)
            throw new IOException("런타임 파일 크기가 올바르지 않습니다: " + path);

        string fullPath = Path.GetFullPath(path);
        NoLinks(fullPath);

        string tmp = fullPath + ".tmp-" + Guid.NewGuid().ToString("N");
        try
        {
            if (Environment.OSVersion.Platform == PlatformID.Win32NT)
            {
                SafeFileHandle dirPin = PinParentDirectory(fullPath);
                bool transferred = false;
                try
                {
                    if (File.Exists(fullPath))
                    {
                        FileStream exStream = null;
                        try
                        {
                            exStream = OpenVerifiedReadLockedRuntimeStream(fullPath);
                            if (MatchesExpectedRuntimeBytes(exStream, expectedBytes))
                            {
                                PinnedRuntimeFile pinned = new PinnedRuntimeFile(dirPin, exStream);
                                transferred = true;
                                dirPin = null;
                                exStream = null;
                                return pinned;
                            }
                        }
                        finally
                        {
                            if (exStream != null)
                            {
                                try { exStream.Dispose(); }
                                catch { }
                            }
                        }
                    }

                    NoLinksCore(tmp);
                    using (SafeFileHandle hTmp = CreateFileW(tmp, 0xC0010000u, 0u, IntPtr.Zero, 1u, 0x80u, IntPtr.Zero))
                    {
                        if (hTmp == null || hTmp.IsInvalid)
                        {
                            int winErr = Marshal.GetLastWin32Error();
                            if (hTmp != null) hTmp.Dispose();
                            throw new IOException("런타임 파일 생성에 실패했습니다(" + winErr + "): " + tmp);
                        }
                        VerifySafeHandle(hTmp, tmp, false);
                        using (FileStream stream = new FileStream(hTmp, FileAccess.ReadWrite))
                        {
                            WriteAndVerify(stream, expectedBytes);
                            Action<string> hook = TestBeforePublishHook;
                            if (hook != null) hook(fullPath);
                            bool replaceExisting = File.Exists(fullPath);
                            if (replaceExisting && (File.GetAttributes(fullPath) & FileAttributes.ReparsePoint) != 0)
                                throw new IOException("심볼릭 링크 또는 재분석 지점은 허용되지 않습니다: " + fullPath);
                            RenameByHandle(hTmp, fullPath, replaceExisting);
                        }
                    }

                    FileStream lockStream = OpenVerifiedReadLockedRuntimeStream(fullPath);
                    try
                    {
                        if (!MatchesExpectedRuntimeBytes(lockStream, expectedBytes))
                        {
                            try { lockStream.Dispose(); }
                            catch { }
                            lockStream = null;
                            throw new IOException("게시된 런타임 파일 검증에 실패했습니다: " + fullPath);
                        }

                        PinnedRuntimeFile pinned = new PinnedRuntimeFile(dirPin, lockStream);
                        transferred = true;
                        dirPin = null;
                        lockStream = null;
                        return pinned;
                    }
                    finally
                    {
                        if (lockStream != null)
                        {
                            try { lockStream.Dispose(); }
                            catch { }
                        }
                    }
                }
                finally
                {
                    if (!transferred && dirPin != null)
                    {
                        try
                        {
                            if (!dirPin.IsInvalid && !dirPin.IsClosed)
                                dirPin.Dispose();
                        }
                        catch { }
                    }
                }
            }
            else
            {
                if (File.Exists(fullPath))
                {
                    FileStream exStream = null;
                    try
                    {
                        exStream = new FileStream(fullPath, FileMode.Open, FileAccess.Read, FileShare.Read);
                        if (MatchesExpectedRuntimeBytes(exStream, expectedBytes))
                        {
                            PinnedRuntimeFile pinned = new PinnedRuntimeFile(null, exStream);
                            exStream = null;
                            return pinned;
                        }
                    }
                    finally
                    {
                        if (exStream != null)
                        {
                            try { exStream.Dispose(); }
                            catch { }
                        }
                    }
                }

                NoLinksCore(tmp);
                using (FileStream stream = new FileStream(tmp, FileMode.CreateNew, FileAccess.ReadWrite, FileShare.None))
                {
                    WriteAndVerify(stream, expectedBytes);
                }
                Action<string> hook = TestBeforePublishHook;
                if (hook != null) hook(fullPath);
                if (File.Exists(fullPath)) File.Delete(fullPath);
                File.Move(tmp, fullPath);

                FileStream lockStream = new FileStream(fullPath, FileMode.Open, FileAccess.Read, FileShare.Read);
                try
                {
                    if (!MatchesExpectedRuntimeBytes(lockStream, expectedBytes))
                    {
                        try { lockStream.Dispose(); }
                        catch { }
                        lockStream = null;
                        throw new IOException("게시된 런타임 파일 검증에 실패했습니다: " + fullPath);
                    }

                    PinnedRuntimeFile pinned = new PinnedRuntimeFile(null, lockStream);
                    lockStream = null;
                    return pinned;
                }
                finally
                {
                    if (lockStream != null)
                    {
                        try { lockStream.Dispose(); }
                        catch { }
                    }
                }
            }
        }
        catch (Exception ex)
        {
            try
            {
                if (File.Exists(tmp)) File.Delete(tmp);
            }
            catch { }
            if (ex is IOException) throw;
            throw new IOException("런타임 파일 고정에 실패했습니다: " + fullPath, ex);
        }
    }

    private static void WriteAtomicNew(string path, string tempInfix, byte[] data, Action<Stream, byte[]> writer) {
        if (String.IsNullOrEmpty(path))
            throw new IOException("경로가 비어 있습니다.");
        if (data == null || data.Length <= 0 || data.Length > MaxSaveBytes)
            throw new IOException("세이브 파일 데이터가 올바르지 않습니다.");

        string fullPath = Path.GetFullPath(path);
        NoLinks(fullPath);

        if (File.Exists(fullPath))
            throw new IOException("이미 파일이 존재합니다: " + fullPath);

        string tmp = fullPath + tempInfix + Guid.NewGuid().ToString("N");
        NoLinksCore(tmp);

        try {
            using (SafeFileHandle dirPin = PinParentDirectory(fullPath)) {
                if (Environment.OSVersion.Platform == PlatformID.Win32NT) {
                    using (SafeFileHandle hTmp = CreateFileW(tmp, 0xC0010000u, 0u, IntPtr.Zero, 1u, 0x80u, IntPtr.Zero)) {
                        if (hTmp == null || hTmp.IsInvalid) {
                            int openErr = Marshal.GetLastWin32Error();
                            throw new IOException("임시 파일을 생성할 수 없습니다(" + openErr + "): " + tmp);
                        }

                        VerifySafeHandle(hTmp, tmp, false);

                        using (FileStream stream = new FileStream(hTmp, FileAccess.ReadWrite)) {
                            if (writer == null) {
                                WriteAndVerify(stream, data);
                            } else {
                                writer(stream, data);
                                stream.Flush(true);

                                if (stream.Length != data.Length)
                                    throw new IOException("작성된 파일 크기가 올바르지 않습니다.");

                                stream.Position = 0;
                                byte[] verify = ReadFrom(stream, (int)stream.Length);
                                if (!String.Equals(Hash(verify), Hash(data), StringComparison.OrdinalIgnoreCase))
                                    throw new IOException("작성된 파일 해시가 올바르지 않습니다.");
                            }

                            Action<string> hook = TestBeforePublishHook;
                            if (hook != null)
                                hook(fullPath);

                            if (File.Exists(fullPath))
                                throw new IOException("이미 파일이 존재합니다: " + fullPath);

                            RenameExclusiveByHandle(hTmp, fullPath);
                        }
                    }
                } else {
                    using (FileStream stream = new FileStream(tmp, FileMode.CreateNew, FileAccess.ReadWrite, FileShare.None)) {
                        VerifyOpenedHandle(stream, tmp);

                        if (writer == null) {
                            WriteAndVerify(stream, data);
                        } else {
                            writer(stream, data);
                            stream.Flush(true);

                            if (stream.Length != data.Length)
                                throw new IOException("작성된 파일 크기가 올바르지 않습니다.");

                            stream.Position = 0;
                            byte[] verify = ReadFrom(stream, (int)stream.Length);
                            if (!String.Equals(Hash(verify), Hash(data), StringComparison.OrdinalIgnoreCase))
                                throw new IOException("작성된 파일 해시가 올바르지 않습니다.");
                        }
                    }

                    Action<string> hook = TestBeforePublishHook;
                    if (hook != null)
                        hook(fullPath);

                    if (File.Exists(fullPath))
                        throw new IOException("이미 파일이 존재합니다: " + fullPath);

                    File.Move(tmp, fullPath);
                }
            }
        } catch (Exception ex) {
            try {
                if (File.Exists(tmp))
                    File.Delete(tmp);
            } catch {
            }

            if (ex is IOException)
                throw;

            throw new IOException("새 파일 작성에 실패했습니다: " + fullPath, ex);
        }
    }

    internal static string CopyWithBackup(string source, string destination, string expectedHash, byte[] data, Action<Stream, byte[]> writer = null) {
        if (String.IsNullOrEmpty(source) || String.IsNullOrEmpty(destination))
            throw new IOException("새 복사본 경로를 선택하세요. 기존 파일은 덮어쓰지 않습니다.");

        source = Path.GetFullPath(source);
        destination = Path.GetFullPath(destination);
        NoLinks(source);
        NoLinks(destination);

        if (String.Equals(source, destination, StringComparison.OrdinalIgnoreCase) || File.Exists(destination))
            throw new IOException("새 복사본 경로를 선택하세요. 기존 파일은 덮어쓰지 않습니다.");

        if (!IsSaveExtension(destination))
            throw new IOException("새 세이브 파일(.save/.es3) 경로를 선택하세요.");

        if (data == null || data.Length <= 0 || data.Length > MaxSaveBytes)
            throw new IOException("32 MiB 이하의 세이브 파일(.save/.es3)을 선택하세요.");

        byte[] sourceBytes = Read(source);
        if (!String.Equals(Hash(sourceBytes), expectedHash, StringComparison.OrdinalIgnoreCase))
            throw new IOException("원본 세이브 파일이 변경되었습니다.");

        string backup = destination + ".original-" + Guid.NewGuid().ToString("N") + ".bak";
        WriteNew(backup, sourceBytes);
        try {
            WriteAtomicNew(destination, ".pending-", data, writer);
            return backup;
        } catch (Exception ex) {
            throw new IOException("복사본 저장에 실패했습니다. 원본 및 백업은 보존되었습니다: " + backup + " / " + ex.Message, ex);
        }
    }

    internal static string ReplaceWithBackup(string path, string expectedHash, byte[] data) {
        if (String.IsNullOrEmpty(path))
            throw new IOException("경로가 비어 있습니다.");

        List<string> backups = ReplaceBatch(
            new BatchItem[] {
                new BatchItem {
                    Path = path,
                    ExpectedHash = expectedHash,
                    Data = data
                }
            },
            null);

        return backups[0];
    }

    internal static List<string> ReplaceBatch(IList<BatchItem> items, Action<int, Stream> faultInjector = null) {
        if (items == null || items.Count <= 0)
            throw new IOException("교체할 파일 목록이 비어 있습니다.");

        List<PreparedBatchEntry> callerOrder = new List<PreparedBatchEntry>(items.Count);
        HashSet<string> seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        for (int i = 0; i < items.Count; i++) {
            BatchItem item = items[i];
            if (item == null)
                throw new IOException("파일 항목이 비어 있습니다.");
            if (String.IsNullOrEmpty(item.Path))
                throw new IOException("파일 경로가 비어 있습니다.");

            string fullPath = Path.GetFullPath(item.Path);
            if (!IsSaveExtension(fullPath))
                throw new IOException("세이브 파일 확장자가 아닙니다: " + fullPath);
            if (item.Data == null || item.Data.Length <= 0 || item.Data.Length > MaxSaveBytes)
                throw new IOException("세이브 파일 데이터가 올바르지 않습니다: " + fullPath);
            if (!seen.Add(fullPath))
                throw new IOException("중복된 파일 경로가 있습니다: " + fullPath);

            PreparedBatchEntry entry = new PreparedBatchEntry();
            entry.FullPath = fullPath;
            entry.ExpectedHash = item.ExpectedHash;
            entry.Data = item.Data;
            callerOrder.Add(entry);
        }

        List<PreparedBatchEntry> lockOrder = new List<PreparedBatchEntry>(callerOrder);
        lockOrder.Sort(CompareBatchEntries);

        List<string> createdBackups = new List<string>();
        string stamp = DateTime.UtcNow.ToString("yyyyMMddHHmmssfff");

        try {
            try {
                for (int i = 0; i < lockOrder.Count; i++) {
                    PreparedBatchEntry entry = lockOrder[i];

                    NoLinks(entry.FullPath);

                    entry.Stream = new FileStream(entry.FullPath, FileMode.Open, FileAccess.ReadWrite, FileShare.None);
                    VerifyOpenedHandle(entry.Stream, entry.FullPath);

                    if (entry.Stream.Length <= 0 || entry.Stream.Length > MaxSaveBytes)
                        throw new IOException("세이브 파일 크기가 올바르지 않습니다: " + entry.FullPath);

                    entry.Before = ReadFrom(entry.Stream, (int)entry.Stream.Length);

                    if (!String.Equals(Hash(entry.Before), entry.ExpectedHash, StringComparison.OrdinalIgnoreCase))
                        throw new IOException("파일 해시가 일치하지 않습니다: " + entry.FullPath);
                }

                for (int i = 0; i < callerOrder.Count; i++) {
                    PreparedBatchEntry entry = callerOrder[i];

                    string backupPath = entry.FullPath + ".backup-" + stamp + "-" + Guid.NewGuid().ToString("N") + ".bak";
                    WriteNew(backupPath, entry.Before);
                    entry.BackupPath = backupPath;
                    createdBackups.Add(backupPath);

                    entry.BackupStream = new FileStream(backupPath, FileMode.Open, FileAccess.Read, FileShare.Read);
                    VerifyOpenedHandle(entry.BackupStream, backupPath);

                    if (entry.BackupStream.Length <= 0 || entry.BackupStream.Length > MaxSaveBytes)
                        throw new IOException("백업 파일 크기가 올바르지 않습니다: " + backupPath);

                    byte[] verify = ReadFrom(entry.BackupStream, (int)entry.BackupStream.Length);
                    if (!String.Equals(Hash(verify), Hash(entry.Before), StringComparison.OrdinalIgnoreCase))
                        throw new IOException("백업 파일 해시가 일치하지 않습니다: " + backupPath);
                }
            } catch (Exception phaseOneError) {
                for (int i = 0; i < callerOrder.Count; i++) {
                    PreparedBatchEntry entry = callerOrder[i];
                    if (entry != null && entry.BackupStream != null) {
                        try {
                            entry.BackupStream.Dispose();
                        } catch {
                        }
                        entry.BackupStream = null;
                    }
                }

                for (int i = 0; i < createdBackups.Count; i++) {
                    try {
                        if (File.Exists(createdBackups[i]))
                            File.Delete(createdBackups[i]);
                    } catch {
                    }
                }

                if (phaseOneError is IOException)
                    throw;

                throw new IOException("다중 파일 저장 준비에 실패했습니다.", phaseOneError);
            }

            int currentIndex = -1;

            try {
                for (int i = 0; i < callerOrder.Count; i++) {
                    currentIndex = i;

                    if (faultInjector != null)
                        faultInjector(i, callerOrder[i].Stream);

                    if (TestReplaceBatchFailAtCommitIndex >= 0 && i == TestReplaceBatchFailAtCommitIndex)
                        throw new IOException("테스트용 배치 커밋 중간 실패");

                    WriteAndVerify(callerOrder[i].Stream, callerOrder[i].Data);
                }
            } catch (Exception writeError) {
                List<string> rollbackFailures = new List<string>();

                for (int j = currentIndex; j >= 0; j--) {
                    try {
                        WriteAndVerify(callerOrder[j].Stream, callerOrder[j].Before);
                    } catch (Exception restoreEx) {
                        rollbackFailures.Add(callerOrder[j].FullPath + ": " + restoreEx.Message);
                    }
                }

                StringBuilder message = new StringBuilder();
                message.Append("다중 파일 저장 중 쓰기 실패가 발생했습니다. ");
                if (rollbackFailures.Count == 0)
                    message.Append("자동 롤백에 성공했습니다.");
                else
                    message.Append("자동 롤백에 실패했습니다. ");

                message.Append(" 백업 파일: ");
                for (int i = 0; i < createdBackups.Count; i++) {
                    if (i > 0) message.Append(", ");
                    message.Append(createdBackups[i]);
                }

                if (rollbackFailures.Count > 0) {
                    message.Append(" 롤백 실패: ");
                    for (int i = 0; i < rollbackFailures.Count; i++) {
                        if (i > 0) message.Append("; ");
                        message.Append(rollbackFailures[i]);
                    }
                }

                message.Append(" 쓰기 오류: ");
                message.Append(writeError.Message);

                throw new IOException(message.ToString(), writeError);
            }

            List<string> backups = new List<string>(callerOrder.Count);
            for (int i = 0; i < callerOrder.Count; i++)
                backups.Add(callerOrder[i].BackupPath);
            return backups;
        } finally {
            for (int i = 0; i < lockOrder.Count; i++) {
                PreparedBatchEntry entry = lockOrder[i];
                FileStream stream = entry.Stream;
                if (stream != null) {
                    try {
                        stream.Dispose();
                    } catch {
                    }
                    entry.Stream = null;
                }
                FileStream backupStream = entry.BackupStream;
                if (backupStream != null) {
                    try {
                        backupStream.Dispose();
                    } catch {
                    }
                    entry.BackupStream = null;
                }
            }
        }
    }

    private static int CompareBatchEntries(PreparedBatchEntry a, PreparedBatchEntry b) {
        return StringComparer.OrdinalIgnoreCase.Compare(a.FullPath, b.FullPath);
    }

    internal static void UpdateOrRestore(Stream target, byte[] before, byte[] data, string backup) {
        if (target == null)
            throw new IOException("저장 대상이 없습니다. 백업: " + backup);
        if (before == null || before.Length <= 0 || before.Length > MaxSaveBytes)
            throw new IOException("32 MiB 이하의 세이브 파일(.save/.es3)을 선택하세요.");
        if (data == null || data.Length <= 0 || data.Length > MaxSaveBytes)
            throw new IOException("32 MiB 이하의 세이브 파일(.save/.es3)을 선택하세요.");

        try {
            WriteAndVerify(target, data);
        } catch (Exception writeError) {
            try {
                WriteAndVerify(target, before);
            } catch (Exception restoreError) {
                throw new IOException("저장 및 자동 원상복구에 실패했습니다. 게임을 열지 말고 백업을 복원하세요: " + backup + " / " + restoreError.Message, writeError);
            }
            throw new IOException("저장에 실패하여 원래 내용으로 복구했습니다. 백업: " + backup + " / " + writeError.Message, writeError);
        }
    }

    internal static void WriteAndVerify(Stream target, byte[] data) {
        if (target == null)
            throw new IOException("저장 대상이 없습니다.");
        if (data == null || data.Length <= 0 || data.Length > MaxSaveBytes)
            throw new IOException("32 MiB 이하의 세이브 파일(.save/.es3)을 선택하세요.");

        target.Position = 0;
        target.Write(data, 0, data.Length);
        target.SetLength(data.Length);
        FileStream fs = target as FileStream;
        if (fs != null)
            fs.Flush(true);
        else
            target.Flush();
        target.Position = 0;
        byte[] actual = ReadFrom(target, data.Length);
        if (!String.Equals(Hash(actual), Hash(data), StringComparison.OrdinalIgnoreCase))
            throw new IOException("세이브 파일 검증에 실패했습니다.");
    }

    private static byte[] ReadFrom(Stream stream, int length) {
        if (stream == null)
            throw new IOException("스트림이 비어 있습니다.");
        if (length < 0)
            throw new IOException("읽을 길이가 올바르지 않습니다.");

        byte[] buffer = new byte[length];
        int offset = 0;

        while (offset < length) {
            int read = stream.Read(buffer, offset, length - offset);
            if (read <= 0)
                throw new IOException("파일을 끝까지 읽을 수 없습니다.");

            offset += read;
        }

        return buffer;
    }
}
