using System;
using System.IO;
using System.Text;
using System.Linq;
using System.Diagnostics;
using System.Reflection;
using System.Runtime.CompilerServices;
using System.Security.Cryptography;
using System.Collections;
using System.Collections.Generic;
using System.Threading.Tasks;
using System.Windows.Forms;
using System.Drawing;
using System.Web.Script.Serialization;
using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

[assembly: AssemblyTitle("Hero's Adventure Save Editor")]
[assembly: AssemblyProduct("Hero's Adventure Save Editor")]
[assembly: AssemblyVersion("1.0.0.0")]
[assembly: AssemblyFileVersion("1.0.0.0")]

internal static class Program
{
    internal static string RuntimeFolder;
    internal static int ExitCode;
    internal static string TestRoot;
    internal static bool TestRootOwned;

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    internal static extern IntPtr LoadLibraryW(string lpFileName);

    internal static readonly JavaScriptSerializer Json =
        new JavaScriptSerializer { MaxJsonLength = 134217728, RecursionLimit = 32 };

    internal static byte[] Resource(string name)
    {
        Assembly assembly = Assembly.GetExecutingAssembly();
        Stream stream = assembly.GetManifestResourceStream(name);
        if (stream == null)
        {
            throw new IOException("Missing embedded resource: " + name);
        }

        try
        {
            using (MemoryStream memory = new MemoryStream())
            {
                stream.CopyTo(memory);
                return memory.ToArray();
            }
        }
        finally
        {
            stream.Dispose();
        }
    }

    internal static string GetDefaultWulinSaveDir()
    {
        string userProfile = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        string candidate = Path.Combine(userProfile, "AppData", "LocalLow", "DefaultCompany", "Wulin");

        if (Directory.Exists(candidate))
        {
            return candidate;
        }

        string current = candidate;
        while (!String.IsNullOrEmpty(current))
        {
            DirectoryInfo parent = Directory.GetParent(current);
            if (parent == null)
            {
                break;
            }

            current = parent.FullName;
            if (Directory.Exists(current))
            {
                return current;
            }
        }

        return userProfile;
    }

    static Assembly Resolve(object sender, ResolveEventArgs e)
    {
        AssemblyName requested = new AssemblyName(e.Name);
        string name = requested.Name;
        byte[] bytes = null;

        if (String.Equals(name, "Microsoft.Web.WebView2.Core", StringComparison.Ordinal))
        {
            bytes = Resource("Microsoft.Web.WebView2.Core.dll");
        }
        else if (String.Equals(name, "Microsoft.Web.WebView2.WinForms", StringComparison.Ordinal))
        {
            bytes = Resource("Microsoft.Web.WebView2.WinForms.dll");
        }

        return bytes == null ? null : Assembly.Load(bytes);
    }

    [STAThread]
    static void Main(string[] args)
    {
        try
        {
            AppDomain.CurrentDomain.AssemblyResolve += new ResolveEventHandler(Resolve);

            if (args.Length == 0)
            {
                string localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
                RuntimeFolder = Path.Combine(localAppData, "HerosAdventureSaveEditor", "runtime-1.0.0");
                SaveStore.NoLinks(RuntimeFolder);

                if (!Directory.Exists(RuntimeFolder))
                {
                    Directory.CreateDirectory(RuntimeFolder);
                }
            }
            else if (args.Length == 2 && String.Equals(args[0], "--self-test", StringComparison.Ordinal))
            {
                TestRoot = Path.GetFullPath(args[1]);
                if (Directory.Exists(TestRoot) || File.Exists(TestRoot))
                {
                    throw new IOException("검증 폴더는 새 경로여야 합니다.");
                }
                SaveStore.NoLinks(TestRoot);
                Directory.CreateDirectory(TestRoot);
                TestRootOwned = true;
                RuntimeFolder = TestRoot;
            }
            else
            {
                throw new ArgumentException("지원하지 않는 실행 인수입니다.");
            }

            string loaderPath = Path.Combine(RuntimeFolder, "WebView2Loader.dll");
            byte[] loaderBytes = Resource("WebView2Loader.dll");
            using (IDisposable loaderPin = SaveStore.EnsurePinnedRuntimeFile(loaderPath, loaderBytes))
            {
                if (Environment.OSVersion.Platform == PlatformID.Win32NT)
                {
                    IntPtr hMod = LoadLibraryW(loaderPath);
                    if (hMod == IntPtr.Zero)
                    {
                        int winErr = Marshal.GetLastWin32Error();
                        throw new IOException("WebView2Loader.dll 로드에 실패했습니다(" + winErr + "): " + loaderPath, new Win32Exception(winErr));
                    }
                }

                Run();
            }
        }
        catch (Exception ex)
        {
            ExitCode = 1;
            if (TestRoot != null)
            {
                try
                {
                    if (TestRootOwned && !File.Exists(Path.Combine(TestRoot, "failure.txt")))
                    {
                        SaveStore.WriteNew(Path.Combine(TestRoot, "failure.txt"), Encoding.UTF8.GetBytes(ex.ToString()));
                    }
                }
                catch
                {
                }
            }
            else
            {
                MessageBox.Show("편집기를 시작하지 못했습니다.\n" + ex.Message, "대협입지전 세이브 에디터");
            }
        }
        Environment.ExitCode = ExitCode;
    }

    [MethodImpl(MethodImplOptions.NoInlining)]
    static void Run()
    {
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        CoreWebView2Environment.SetLoaderDllFolderPath(RuntimeFolder);
        Application.Run(new EditorForm());
    }
}

internal sealed class EditorForm : Form
{
    private readonly WebView2 web = new WebView2();
    private bool closingAllowed;
    private string lastFolder = Program.GetDefaultWulinSaveDir();
    private string activeSession = null;
    private readonly Dictionary<string, string> activePathsByKey = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
    private readonly Dictionary<string, string> activeHashesByPath = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
    private bool working = false;
    private bool initialLoaded = false;
    private bool selfTestStarted = false;
    private string pendingSession = null;
    private string pendingFolder = null;
    private Dictionary<string, string> pendingPathsByKey = null;
    private Dictionary<string, string> pendingHashesByPath = null;
    private string lastCompletedSaveId = null;
    private string lastCompletedSaveSession = null;
    private List<string> lastCompletedSaveBackups = null;
    private string lastConfirmedSessionId = null;
    private string lastConfirmedSession = null;

    public EditorForm()
    {
        Text = "대협입지전 (Hero's Adventure) 세이브 에디터 v1.0 · 자동 백업 저장";
        ClientSize = new Size(1360, 900);
        MinimumSize = new Size(960, 680);
        StartPosition = FormStartPosition.CenterScreen;
        web.Dock = DockStyle.Fill;
        Controls.Add(web);
        Shown += EditorForm_Shown;
        FormClosing += EditorForm_FormClosing;
        if (Program.TestRoot != null)
        {
            WindowState = FormWindowState.Minimized;
            ShowInTaskbar = false;
        }
        FormClosed += delegate { web.Dispose(); };
    }

    private async void EditorForm_Shown(object sender, EventArgs e)
    {
        await Initialize();
    }

    private async Task Initialize()
    {
        try
        {
            string profile = Path.Combine(Program.RuntimeFolder, "Profile");
            SaveStore.NoLinks(profile);
            CoreWebView2Environment env = await CoreWebView2Environment.CreateAsync(null, profile, new CoreWebView2EnvironmentOptions("--disable-background-networking"));
            await web.EnsureCoreWebView2Async(env);

            CoreWebView2Settings settings = web.CoreWebView2.Settings;
            settings.AreDevToolsEnabled = false;
            settings.AreDefaultContextMenusEnabled = false;
            settings.AreBrowserAcceleratorKeysEnabled = false;
            settings.IsPasswordAutosaveEnabled = false;
            settings.IsGeneralAutofillEnabled = false;
            settings.AreHostObjectsAllowed = false;

            web.CoreWebView2.NewWindowRequested += delegate(object s, CoreWebView2NewWindowRequestedEventArgs e)
            {
                e.Handled = true;
            };
            web.CoreWebView2.PermissionRequested += delegate(object s, CoreWebView2PermissionRequestedEventArgs e)
            {
                e.State = CoreWebView2PermissionState.Deny;
            };

            bool firstNavigation = true;
            web.CoreWebView2.NavigationStarting += delegate(object s, CoreWebView2NavigationStartingEventArgs e)
            {
                if (firstNavigation && (e.Uri == "about:blank" || e.Uri.StartsWith("data:text/html", StringComparison.OrdinalIgnoreCase)))
                {
                    firstNavigation = false;
                    return;
                }
                e.Cancel = true;
            };

            web.CoreWebView2.AddWebResourceRequestedFilter("*", CoreWebView2WebResourceContext.All);
            web.CoreWebView2.WebResourceRequested += delegate(object s, CoreWebView2WebResourceRequestedEventArgs e)
            {
                string uri = e.Request.Uri;
                if (uri.StartsWith("http:", StringComparison.OrdinalIgnoreCase) || uri.StartsWith("https:", StringComparison.OrdinalIgnoreCase))
                {
                    e.Response = env.CreateWebResourceResponse(new MemoryStream(new byte[0]), 403, "Offline", "");
                }
            };

            web.CoreWebView2.WebMessageReceived += delegate(object s, CoreWebView2WebMessageReceivedEventArgs e)
            {
                string raw = e.WebMessageAsJson;
                if (e.Source == "about:blank" && raw != null)
                {
                    if (raw.Length > 96 * 1024 * 1024)
                    {
                        string errId = null;
                        object errSeq = null;
                        try
                        {
                            ExtractOversizeEnvelope(raw, out errId, out errSeq);
                        }
                        catch
                        {
                            errId = null;
                            errSeq = null;
                        }

                        Dictionary<string, object> errDict = new Dictionary<string, object>();
                        errDict["ok"] = false;
                        errDict["error"] = "전송 데이터가 허용 한도를 초과했습니다.";
                        BeginInvoke(new Action(delegate { Reply(errId, errSeq, errDict); }));
                    }
                    else
                    {
                        BeginInvoke(new Action(delegate { HandleRequest(raw); }));
                    }
                }
            };

            web.CoreWebView2.NavigationCompleted += delegate(object s, CoreWebView2NavigationCompletedEventArgs e)
            {
                if (initialLoaded) return;
                if (!e.IsSuccess)
                {
                    Fail(new IOException("화면 로드 실패: " + e.WebErrorStatus));
                    return;
                }
                initialLoaded = true;
                if (Program.TestRoot != null && !selfTestStarted)
                {
                    selfTestStarted = true;
                    BeginInvoke(new Action(async delegate { await SelfTest(); }));
                }
            };

            web.CoreWebView2.NavigateToString(Encoding.UTF8.GetString(Program.Resource("editor.html")));
        }
        catch (Exception ex)
        {
            Fail(ex);
        }
    }

    private void Fail(Exception ex)
    {
        Program.ExitCode = 1;
        if (Program.TestRoot != null)
        {
            try
            {
                string path = Path.Combine(Program.TestRoot, "failure.txt");
                if (Program.TestRootOwned && !File.Exists(path))
                {
                    SaveStore.WriteNew(path, Encoding.UTF8.GetBytes(ex.ToString()));
                }
            }
            catch
            {
            }
        }
        else
        {
            MessageBox.Show(this, ex.Message, "오류", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
        closingAllowed = true;
        Close();
    }

    private async void EditorForm_FormClosing(object sender, FormClosingEventArgs e)
    {
        if (closingAllowed || web.CoreWebView2 == null)
            return;

        e.Cancel = true;
        if (working) return;
        try
        {
            string result = await web.CoreWebView2.ExecuteScriptAsync("typeof window.hasUnsavedChanges === 'function' && window.hasUnsavedChanges()");
            if (result == "true")
            {
                if (MessageBox.Show(this, "저장하지 않은 변경 사항이 있습니다. 종료할까요?", "종료 확인", MessageBoxButtons.YesNo, MessageBoxIcon.Warning) != DialogResult.Yes)
                    return;
            }
            closingAllowed = true;
            Close();
        }
        catch
        {
            closingAllowed = true;
            Close();
        }
    }

    private void Reply(string id, object seq, Dictionary<string, object> result)
    {
        result["id"] = id;
        if (seq != null)
            result["seq"] = seq;
        web.CoreWebView2.PostWebMessageAsJson(Program.Json.Serialize(result));
    }

    private static string GetString(IDictionary<string, object> obj, string key)
    {
        object value;
        if (obj != null && obj.TryGetValue(key, out value) && value != null)
            return Convert.ToString(value);
        return null;
    }

    private static IDictionary<string, object> AsDictionary(object value)
    {
        IDictionary<string, object> dict = value as IDictionary<string, object>;
        if (dict != null)
            return dict;

        IDictionary<string, object> raw = value as IDictionary<string, object>;
        if (raw != null)
        {
            Dictionary<string, object> copy = new Dictionary<string, object>(StringComparer.OrdinalIgnoreCase);
            foreach (KeyValuePair<string, object> pair in raw)
                copy[pair.Key] = pair.Value;
            return copy;
        }
        return null;
    }

    private static string ExtractJsonStringField(string head, string quotedKey)
    {
        if (head == null || quotedKey == null)
            return null;

        int keyIndex = head.IndexOf(quotedKey, StringComparison.Ordinal);
        if (keyIndex < 0)
            return null;

        int pos = keyIndex + quotedKey.Length;
        while (pos < head.Length && Char.IsWhiteSpace(head[pos]))
            pos++;
        if (pos >= head.Length || head[pos] != ':')
            return null;
        pos++;
        while (pos < head.Length && Char.IsWhiteSpace(head[pos]))
            pos++;
        if (pos >= head.Length || head[pos] != '"')
            return null;
        pos++;

        StringBuilder sb = new StringBuilder();
        while (pos < head.Length)
        {
            char c = head[pos++];
            if (c == '"')
                return sb.ToString();
            if (c == '\\')
            {
                if (pos >= head.Length)
                    return null;
                char e = head[pos++];
                if (e == '"') sb.Append('"');
                else if (e == '\\') sb.Append('\\');
                else if (e == '/') sb.Append('/');
                else if (e == 'b') sb.Append('\b');
                else if (e == 'f') sb.Append('\f');
                else if (e == 'n') sb.Append('\n');
                else if (e == 'r') sb.Append('\r');
                else if (e == 't') sb.Append('\t');
                else if (e == 'u')
                {
                    if (pos + 4 > head.Length)
                        return null;
                    int value = 0;
                    for (int i = 0; i < 4; i++)
                    {
                        char h = head[pos++];
                        int digit;
                        if (h >= '0' && h <= '9') digit = h - '0';
                        else if (h >= 'a' && h <= 'f') digit = h - 'a' + 10;
                        else if (h >= 'A' && h <= 'F') digit = h - 'A' + 10;
                        else return null;
                        value = (value << 4) | digit;
                    }
                    sb.Append((char)value);
                }
                else
                {
                    sb.Append(e);
                }
            }
            else
            {
                sb.Append(c);
            }
        }
        return null;
    }

    private static void ExtractOversizeEnvelope(string raw, out string id, out object seq)
    {
        id = null;
        seq = null;
        if (raw == null)
            raw = String.Empty;

        string head = raw.Substring(0, Math.Min(raw.Length, 1024));
        id = ExtractJsonStringField(head, "\"id\"");

        string seqText = ExtractJsonStringField(head, "\"seq\"");
        if (seqText != null)
        {
            long parsed;
            if (Int64.TryParse(seqText, out parsed))
                seq = parsed;
            else
                seq = seqText;
            return;
        }

        int keyIndex = head.IndexOf("\"seq\"", StringComparison.Ordinal);
        if (keyIndex < 0)
            return;

        int pos = keyIndex + "\"seq\"".Length;
        while (pos < head.Length && Char.IsWhiteSpace(head[pos]))
            pos++;
        if (pos >= head.Length || head[pos] != ':')
            return;
        pos++;
        while (pos < head.Length && Char.IsWhiteSpace(head[pos]))
            pos++;

        int start = pos;
        if (pos < head.Length && head[pos] == '-')
            pos++;
        int digitStart = pos;
        while (pos < head.Length && head[pos] >= '0' && head[pos] <= '9')
            pos++;
        if (pos == digitStart)
            return;

        string numStr = head.Substring(start, pos - start);
        long num;
        if (Int64.TryParse(numStr, out num))
            seq = num;
    }

    private static Dictionary<string, object> BuildLoadedFileEntry(string name, string relativePath, byte[] bytes)
    {
        Dictionary<string, object> entry = new Dictionary<string, object>();
        entry["name"] = name;
        entry["relativePath"] = relativePath;
        entry["base64"] = Convert.ToBase64String(bytes == null ? new byte[0] : bytes);
        return entry;
    }

    private void StagePendingSession(string folder, string session, Dictionary<string, string> nextPaths, Dictionary<string, string> nextHashes)
    {
        pendingFolder = folder;
        pendingSession = session;
        pendingPathsByKey = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        if (nextPaths != null)
        {
            foreach (KeyValuePair<string, string> pair in nextPaths)
                pendingPathsByKey[pair.Key] = pair.Value;
        }
        pendingHashesByPath = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        if (nextHashes != null)
        {
            foreach (KeyValuePair<string, string> pair in nextHashes)
                pendingHashesByPath[pair.Key] = pair.Value;
        }
    }

    private void ClearPendingSession()
    {
        pendingSession = null;
        pendingFolder = null;
        pendingPathsByKey = null;
        pendingHashesByPath = null;
    }

    private void CommitActiveSession(string folder, string session, Dictionary<string, string> nextPaths, Dictionary<string, string> nextHashes)
    {
        activePathsByKey.Clear();
        if (nextPaths != null)
        {
            foreach (KeyValuePair<string, string> pair in nextPaths)
                activePathsByKey[pair.Key] = pair.Value;
        }

        activeHashesByPath.Clear();
        if (nextHashes != null)
        {
            foreach (KeyValuePair<string, string> pair in nextHashes)
                activeHashesByPath[pair.Key] = pair.Value;
        }

        activeSession = session;
        if (!String.IsNullOrEmpty(folder))
            lastFolder = folder;
    }

    private void HandleRequest(string raw)
    {
        string id = null;
        object seq = null;
        bool acquired = false;
        try
        {
            IDictionary<string, object> root = AsDictionary(Program.Json.DeserializeObject(raw));
            if (root == null)
                throw new IOException("잘못된 요청입니다.");

            id = GetString(root, "id");
            object seqValue;
            if (root.TryGetValue("seq", out seqValue))
                seq = seqValue;

            string kind = GetString(root, "kind");
            if (kind == "session-status")
            {
                Dictionary<string, object> status = new Dictionary<string, object>();
                status["ok"] = true;
                status["working"] = working;
                status["activeSession"] = activeSession;
                status["pendingSession"] = pendingSession;
                status["lastConfirmedSessionId"] = lastConfirmedSessionId;
                status["lastConfirmedSession"] = lastConfirmedSession;
                status["lastCompletedSaveId"] = lastCompletedSaveId;
                status["lastCompletedSaveSession"] = lastCompletedSaveSession;
                status["lastCompletedSaveBackups"] = lastCompletedSaveBackups;
                Reply(id, seq, status);
                return;
            }

            if (working)
                throw new IOException("다른 파일 작업이 진행 중입니다.");
            working = true;
            acquired = true;

            if (kind == "open-slot")
            {
                string folder;
                if (Program.TestRoot != null)
                {
                    folder = Path.Combine(Program.TestRoot, "Save0");
                }
                else
                {
                    using (FolderBrowserDialog dialog = new FolderBrowserDialog())
                    {
                        dialog.Description = "게임을 종료한 뒤 대협입지전 세이브 슬롯 폴더를 선택하세요";
                        dialog.SelectedPath = lastFolder;
                        dialog.ShowNewFolderButton = false;
                        if (dialog.ShowDialog(this) != DialogResult.OK)
                        {
                            Dictionary<string, object> cancelled = new Dictionary<string, object>();
                            cancelled["ok"] = true;
                            cancelled["cancelled"] = true;
                            Reply(id, seq, cancelled);
                            return;
                        }

                        folder = dialog.SelectedPath;
                    }
                }

                folder = Path.GetFullPath(folder);
                SaveStore.NoLinks(folder);

                string[] paths = Directory.GetFiles(folder);
                List<string> saves = new List<string>();
                for (int i = 0; i < paths.Length; i++)
                {
                    if (SaveStore.IsSaveExtension(paths[i]))
                        saves.Add(paths[i]);
                }
                saves.Sort(StringComparer.OrdinalIgnoreCase);
                if (saves.Count == 0)
                    throw new IOException("선택한 폴더에 세이브 파일(.save/.es3)이 없습니다.");

                Dictionary<string, string> nextPaths = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
                Dictionary<string, string> nextHashes = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
                List<Dictionary<string, object>> files = new List<Dictionary<string, object>>();
                bool hasGlobal = false;
                for (int i = 0; i < saves.Count; i++)
                {
                    string fullPath = Path.GetFullPath(saves[i]);
                    string name = Path.GetFileName(fullPath);
                    byte[] bytes = SaveStore.Read(fullPath);
                    files.Add(BuildLoadedFileEntry(name, name, bytes));
                    nextPaths[name] = fullPath;
                    nextHashes[fullPath] = SaveStore.Hash(bytes);
                    if (String.Equals(name, "SaveObjectGameGlobal.save", StringComparison.OrdinalIgnoreCase))
                        hasGlobal = true;
                }

                if (!hasGlobal)
                {
                    List<string> globalCandidates = new List<string>();
                    globalCandidates.Add(Path.Combine(folder, "Global", "SaveObjectGameGlobal.save"));
                    DirectoryInfo parent = Directory.GetParent(folder);
                    if (parent != null)
                        globalCandidates.Add(Path.Combine(parent.FullName, "Global", "SaveObjectGameGlobal.save"));

                    for (int ci = 0; ci < globalCandidates.Count; ci++)
                    {
                        string candidate = globalCandidates[ci];
                        if (!File.Exists(candidate))
                            continue;
                        try
                        {
                            string gFull = Path.GetFullPath(candidate);
                            SaveStore.NoLinks(gFull);
                            byte[] gBytes = SaveStore.Read(gFull);
                            files.Add(BuildLoadedFileEntry("SaveObjectGameGlobal.save", "Global/SaveObjectGameGlobal.save", gBytes));
                            nextPaths["Global/SaveObjectGameGlobal.save"] = gFull;
                            nextPaths["SaveObjectGameGlobal.save"] = gFull;
                            nextHashes[gFull] = SaveStore.Hash(gBytes);
                            break;
                        }
                        catch (IOException)
                        {
                        }
                    }
                }

                string session = Guid.NewGuid().ToString("N");
                StagePendingSession(folder, session, nextPaths, nextHashes);
                Dictionary<string, object> result = new Dictionary<string, object>();
                result["ok"] = true;
                result["session"] = session;
                result["folder"] = folder;
                result["files"] = files;
                Reply(id, seq, result);
                return;
            }

            if (kind == "open-files")
            {
                using (OpenFileDialog dialog = new OpenFileDialog())
                {
                    dialog.Title = "게임을 종료한 뒤 대협입지전 세이브 파일(.save/.es3)을 선택하세요";
                    dialog.Filter = "대협입지전 세이브 (*.save;*.es3)|*.save;*.es3";
                    dialog.Multiselect = true;
                    dialog.CheckFileExists = true;
                    dialog.InitialDirectory = lastFolder;
                    if (dialog.ShowDialog(this) != DialogResult.OK)
                    {
                        Dictionary<string, object> cancelled = new Dictionary<string, object>();
                        cancelled["ok"] = true;
                        cancelled["cancelled"] = true;
                        Reply(id, seq, cancelled);
                        return;
                    }

                    Dictionary<string, string> nextPaths = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
                    Dictionary<string, string> nextHashes = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
                    List<Dictionary<string, object>> files = new List<Dictionary<string, object>>();
                    for (int i = 0; i < dialog.FileNames.Length; i++)
                    {
                        string path = Path.GetFullPath(dialog.FileNames[i]);
                        string name = Path.GetFileName(path);
                        if (nextPaths.ContainsKey(name))
                            throw new IOException("같은 이름의 세이브 파일을 두 번 선택할 수 없습니다: " + name);

                        byte[] bytes = SaveStore.Read(path);
                        files.Add(BuildLoadedFileEntry(name, name, bytes));
                        nextPaths[name] = path;
                        nextHashes[path] = SaveStore.Hash(bytes);
                    }

                    if (files.Count == 0)
                        throw new IOException("선택한 세이브 파일이 없습니다.");

                    string folder = Path.GetDirectoryName(Path.GetFullPath(dialog.FileNames[0]));
                    string session = Guid.NewGuid().ToString("N");
                    StagePendingSession(folder, session, nextPaths, nextHashes);
                    Dictionary<string, object> result = new Dictionary<string, object>();
                    result["ok"] = true;
                    result["session"] = session;
                    result["files"] = files;
                    Reply(id, seq, result);
                    return;
                }
            }

            if (kind == "confirm-session")
            {
                string reqSession = GetString(root, "session");
                if (String.IsNullOrEmpty(reqSession) || pendingSession == null || !String.Equals(reqSession, pendingSession, StringComparison.Ordinal))
                    throw new IOException("확정할 세션이 없습니다.");

                CommitActiveSession(pendingFolder, pendingSession, pendingPathsByKey, pendingHashesByPath);
                ClearPendingSession();

                lastConfirmedSessionId = id;
                lastConfirmedSession = activeSession;

                Dictionary<string, object> result = new Dictionary<string, object>();
                result["ok"] = true;
                result["session"] = activeSession;
                Reply(id, seq, result);
                return;
            }

            if (kind == "discard-pending-session")
            {
                string reqSession = GetString(root, "session");
                if (pendingSession != null && (String.IsNullOrEmpty(reqSession) || String.Equals(reqSession, pendingSession, StringComparison.Ordinal)))
                    ClearPendingSession();

                Dictionary<string, object> result = new Dictionary<string, object>();
                result["ok"] = true;
                result["session"] = activeSession;
                Reply(id, seq, result);
                return;
            }

            if (kind == "save-files")
            {
                if (Program.TestRoot == null && Process.GetProcessesByName("Wulin").Length > 0)
                    throw new IOException("대협입지전(Wulin.exe)이 실행 중입니다. 게임을 종료한 뒤 저장하세요.");

                string session = GetString(root, "session");
                if (activeSession == null || session != activeSession)
                    throw new IOException("열었던 세이브 세션이 변경되었습니다. 슬롯을 다시 열어 주세요.");

                object filesValue;
                if (!root.TryGetValue("files", out filesValue))
                    throw new IOException("저장할 파일 목록이 없습니다.");
                IEnumerable files = filesValue as IEnumerable;
                if (files == null)
                    throw new IOException("저장할 파일 목록 형식이 잘못되었습니다.");

                List<SaveStore.BatchItem> batchItems = new List<SaveStore.BatchItem>();
                HashSet<string> seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                foreach (object fileValue in files)
                {
                    IDictionary<string, object> file = AsDictionary(fileValue);
                    if (file == null)
                        throw new IOException("저장할 파일 형식이 잘못되었습니다.");

                    string key = GetString(file, "relativePath");
                    if (String.IsNullOrEmpty(key))
                        key = GetString(file, "name");
                    string targetPath;
                    if (String.IsNullOrEmpty(key) || !activePathsByKey.TryGetValue(key, out targetPath))
                        throw new IOException("열려 있지 않은 세이브 파일입니다: " + key);

                    if (!seen.Add(targetPath))
                        continue;

                    string base64 = GetString(file, "base64");
                    if (String.IsNullOrEmpty(base64))
                        base64 = GetString(file, "data");
                    if (String.IsNullOrEmpty(base64))
                        throw new IOException("저장할 데이터가 없습니다: " + key);

                    byte[] bytes = Convert.FromBase64String(base64);
                    string oldHash;
                    if (!activeHashesByPath.TryGetValue(targetPath, out oldHash))
                        throw new IOException("세이브 파일 해시 정보가 없습니다: " + key);

                    SaveStore.BatchItem item = new SaveStore.BatchItem();
                    item.Path = targetPath;
                    item.ExpectedHash = oldHash;
                    item.Data = bytes;
                    batchItems.Add(item);
                }

                List<string> backups = SaveStore.ReplaceBatch(batchItems, null);
                for (int i = 0; i < batchItems.Count; i++)
                    activeHashesByPath[batchItems[i].Path] = SaveStore.Hash(batchItems[i].Data);
                activeSession = Guid.NewGuid().ToString("N");

                lastCompletedSaveId = id;
                lastCompletedSaveSession = activeSession;
                lastCompletedSaveBackups = backups;

                Dictionary<string, object> result = new Dictionary<string, object>();
                result["ok"] = true;
                result["session"] = activeSession;
                result["backups"] = backups;
                Reply(id, seq, result);
                return;
            }

            throw new IOException("알 수 없는 요청입니다: " + kind);
        }
        catch (Exception ex)
        {
            Dictionary<string, object> result = new Dictionary<string, object>();
            result["ok"] = false;
            result["error"] = ex.Message;
            Reply(id, seq, result);
        }
        finally
        {
            if (acquired)
                working = false;
        }
    }

    private async Task Until(string expression)
    {
        for (int i = 0; i < 200; i++)
        {
            string result = await web.CoreWebView2.ExecuteScriptAsync(expression);
            if (result == "true") return;
            await Task.Delay(100);
        }
        throw new IOException("검증 시간 초과: " + expression);
    }

    private async Task SelfTest()
    {
        try
        {
            await Until("typeof window.HerosAdventureEditorCore === 'object' && typeof window.HerosAdventureUI === 'object' && document.getElementById('btn-native-open-slot') !== null");

            string seedScript =
                "(function(){window.__seedDone=false;window.__seedError=null;window.__seedFiles=null;" +
                "window.HerosAdventureEditorCore.createDemoSlotFiles(window.HerosAdventureCatalog,'Meow').then(function(files){" +
                "window.__seedFiles=files.map(function(f){" +
                "var b='';var bytes=f.bytes;for(var i=0;i<bytes.length;i++){b+=String.fromCharCode(bytes[i]);}" +
                "return {name:f.name,base64:btoa(b)};});window.__seedDone=true;}).catch(function(e){window.__seedError=String(e);window.__seedDone=true;});})();";
            await web.CoreWebView2.ExecuteScriptAsync(seedScript);
            await Until("window.__seedDone === true");
            string seedError = Program.Json.Deserialize<string>(await web.CoreWebView2.ExecuteScriptAsync("window.__seedError"));
            if (seedError != null) throw new IOException(seedError);

            string filesJson = Program.Json.Deserialize<string>(await web.CoreWebView2.ExecuteScriptAsync("JSON.stringify(window.__seedFiles)"));
            object[] seedFiles = Program.Json.Deserialize<object[]>(filesJson);
            string save0 = Path.Combine(Program.TestRoot, "Save0");
            string global = Path.Combine(Program.TestRoot, "Global");
            Directory.CreateDirectory(save0);
            Directory.CreateDirectory(global);

            byte[] playerTeamOriginal = null;
            byte[] globalOriginal = null;
            byte[] timeOriginal = null;
            for (int i = 0; i < seedFiles.Length; i++)
            {
                IDictionary<string, object> sf = AsDictionary(seedFiles[i]);
                string name = GetString(sf, "name");
                byte[] data = Convert.FromBase64String(GetString(sf, "base64"));
                string target = name == "SaveObjectGameGlobal.save" ? Path.Combine(global, name) : Path.Combine(save0, name);
                SaveStore.WriteNew(target, data);
                if (name == "SaveObjectPlayerTeam.save") playerTeamOriginal = data;
                if (name == "SaveObjectGameGlobal.save") globalOriginal = data;
                if (name == "SaveObjectGameTime.save") timeOriginal = data;
            }
            string playerTeamHash = SaveStore.Hash(playerTeamOriginal);
            string globalHash = SaveStore.Hash(globalOriginal);
            string timeHash = SaveStore.Hash(timeOriginal);

            await web.CoreWebView2.ExecuteScriptAsync("document.getElementById('btn-native-open-slot').click();");
            await Until("!window.HerosAdventureUI.isBusy() && window.HerosAdventureUI.getNativeSession() !== null && window.HerosAdventureUI.getSession().getSummary().fileCount === 8 && document.querySelectorAll('#loaded-files-tbody tr').length === 8");

            await web.CoreWebView2.ExecuteScriptAsync("document.querySelector('[data-preset=\"wealth_package\"]').click();");
            await web.CoreWebView2.ExecuteScriptAsync("document.querySelector('[data-preset=\"fief_all_max\"]').click();");
            await Until("window.hasUnsavedChanges() === true && window.HerosAdventureUI.getSession().getSummary().dirtyFileCount >= 4");

            await web.CoreWebView2.ExecuteScriptAsync("window.__prevSession = window.HerosAdventureUI.getNativeSession();");
            await web.CoreWebView2.ExecuteScriptAsync("document.getElementById('btn-native-save').click();");
            await Until("!window.HerosAdventureUI.isBusy() && window.hasUnsavedChanges() === false && window.HerosAdventureUI.getNativeSession() !== window.__prevSession");

            string[] playerTeamBaks = Directory.GetFiles(save0, "SaveObjectPlayerTeam.save.backup-*.bak");
            string[] globalBaks = Directory.GetFiles(global, "SaveObjectGameGlobal.save.backup-*.bak");
            string[] timeBaks = Directory.GetFiles(save0, "SaveObjectGameTime.save.backup-*.bak");
            if (playerTeamBaks.Length != 1 || SaveStore.Hash(File.ReadAllBytes(playerTeamBaks[0])) != playerTeamHash) throw new IOException("playerTeamBackupVerified failed");
            if (globalBaks.Length != 1 || SaveStore.Hash(File.ReadAllBytes(globalBaks[0])) != globalHash) throw new IOException("globalBackupVerified failed");
            if (timeBaks.Length != 0 || SaveStore.Hash(File.ReadAllBytes(Path.Combine(save0, "SaveObjectGameTime.save"))) != timeHash) throw new IOException("time unchanged failed");

            await web.CoreWebView2.ExecuteScriptAsync("window.__prevSession = window.HerosAdventureUI.getNativeSession();");
            await web.CoreWebView2.ExecuteScriptAsync("document.getElementById('btn-native-open-slot').click();");
            await Until("!window.HerosAdventureUI.isBusy() && window.HerosAdventureUI.getNativeSession() !== window.__prevSession && window.HerosAdventureUI.getSession().getSummary().fileCount === 8");

            string verifyScript =
                "(function(){var s=window.HerosAdventureUI.getSession();var c=s.getCurrencies();var f=s.getFiefBuildings();var t=s.getRawFileText('time');" +
                "var coin=false;for(var i=0;i<c.length;i++){if(c[i].id===0&&c[i].value===99999999)coin=true;}" +
                "var fief=f.length===7;for(var j=0;j<f.length;j++){if(f[j].level!==5)fief=false;}" +
                "return (coin&&fief&&t.indexOf('656099925099270000')>=0&&t.indexOf('87.67666666666666666666666667')>=0)?'OK':'FAIL';})();";
            string verify = Program.Json.Deserialize<string>(await web.CoreWebView2.ExecuteScriptAsync(verifyScript));
            if (verify != "OK") throw new IOException("reload verification failed");

            string gameFile = Path.Combine(save0, "SaveObjectGame.save");
            string teamFile = Path.Combine(save0, "SaveObjectPlayerTeam.save");
            string globalFile = Path.Combine(global, "SaveObjectGameGlobal.save");
            byte[] gameBefore = File.ReadAllBytes(gameFile);
            byte[] teamBefore = File.ReadAllBytes(teamFile);
            byte[] globalBefore = File.ReadAllBytes(globalFile);
            int gameBaksBefore = Directory.GetFiles(save0, "SaveObjectGame.save.backup-*.bak").Length;

            await web.CoreWebView2.ExecuteScriptAsync(
                "window.HerosAdventureUI.getSession().setCurrency(0, 77777777);" +
                "window.HerosAdventureUI.getSession().setFiefBuildingLevel(112, 3);");
            await Until("window.hasUnsavedChanges() === true && window.HerosAdventureUI.getSession().getSummary().dirtyFileCount >= 3");

            try
            {
                byte[] badGlobal = (byte[])globalBefore.Clone();
                badGlobal[badGlobal.Length - 1] ^= 0xFF;
                File.WriteAllBytes(globalFile, badGlobal);

                await web.CoreWebView2.ExecuteScriptAsync("window.__prevSession = window.HerosAdventureUI.getNativeSession();");
                await web.CoreWebView2.ExecuteScriptAsync("document.getElementById('btn-native-save').click();");
                await Until("!window.HerosAdventureUI.isBusy()");

                string verifyPrewriteScript =
                    "(function(){return (window.hasUnsavedChanges() === true && " +
                    "window.HerosAdventureUI.getNativeSession() === window.__prevSession) ? 'OK' : 'FAIL';})();";
                string verifyPrewrite = Program.Json.Deserialize<string>(await web.CoreWebView2.ExecuteScriptAsync(verifyPrewriteScript));
                if (verifyPrewrite != "OK")
                    throw new IOException("prewrite conflict verification failed");
                if (!File.ReadAllBytes(gameFile).SequenceEqual(gameBefore))
                    throw new IOException("prewrite conflict game file mismatch");
                if (!File.ReadAllBytes(teamFile).SequenceEqual(teamBefore))
                    throw new IOException("prewrite conflict team file mismatch");
                if (Directory.GetFiles(save0, "SaveObjectGame.save.backup-*.bak").Length != gameBaksBefore)
                    throw new IOException("prewrite conflict backup count mismatch");
            }
            finally
            {
                File.WriteAllBytes(globalFile, globalBefore);
            }

            try
            {
                SaveStore.TestReplaceBatchFailAtCommitIndex = 1;
                await web.CoreWebView2.ExecuteScriptAsync("window.__prevSession = window.HerosAdventureUI.getNativeSession();");
                await web.CoreWebView2.ExecuteScriptAsync("document.getElementById('btn-native-save').click();");
                await Until("!window.HerosAdventureUI.isBusy()");

                string verifyRollback = Program.Json.Deserialize<string>(await web.CoreWebView2.ExecuteScriptAsync(
                    "(function(){return (window.hasUnsavedChanges()&&window.HerosAdventureUI.getNativeSession()===window.__prevSession)?'OK':'FAIL';})()"));
                if (verifyRollback != "OK")
                    throw new IOException("batch rollback verification failed");
                if (!File.ReadAllBytes(gameFile).SequenceEqual(gameBefore))
                    throw new IOException("batch rollback game file mismatch");
                if (!File.ReadAllBytes(teamFile).SequenceEqual(teamBefore))
                    throw new IOException("batch rollback team file mismatch");
                if (!File.ReadAllBytes(globalFile).SequenceEqual(globalBefore))
                    throw new IOException("batch rollback global file mismatch");
            }
            finally
            {
                SaveStore.TestReplaceBatchFailAtCommitIndex = -1;
            }

            var receipt = new Dictionary<string, object>();
            receipt["status"] = "PASS";
            receipt["filesLoaded"] = 8;
            receipt["coinAfterReload"] = 99999999;
            receipt["fiefAllLevel5"] = true;
            receipt["timePrecisionPreserved"] = true;
            receipt["playerTeamBackupVerified"] = true;
            receipt["globalBackupVerified"] = true;
            receipt["prewriteConflictVerified"] = true;
            receipt["batchRollbackVerified"] = true;
            receipt["htmlHash"] = SaveStore.Hash(Program.Resource("editor.html"));
            byte[] receiptBytes = Encoding.UTF8.GetBytes(Program.Json.Serialize(receipt));
            SaveStore.WriteNew(Path.Combine(Program.TestRoot, "receipt.json"), receiptBytes);
            closingAllowed = true;
            Close();
        }
        catch (Exception ex)
        {
            Fail(ex);
        }
    }
}
