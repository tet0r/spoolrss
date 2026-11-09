// SpoolRSS for Windows: a tray icon that runs the SpoolRSS server from the folder it sits in.
//
// The folder is portable: SpoolRSS.exe, settings.txt, app\ (node.exe and the server) and data\
// (the database and log). Nothing is installed. From the tray menu SpoolRSS can start with
// Windows (a sign-in entry for this user) or run as a Windows service, which starts at boot
// before anyone signs in. It updates itself when asked from SpoolRSS's update banner.
//
// Built with the C# compiler that comes with Windows (.NET Framework 4), so it is C# 5:
// no string interpolation or ?. here. See build.mjs.

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.IO.Compression;
using System.Net;
using System.Net.Sockets;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Security.Principal;
using System.ServiceProcess;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;

static class Paths
{
    public static readonly string Exe = Assembly.GetExecutingAssembly().Location;
    public static readonly string Root = Path.GetDirectoryName(Exe);
    public static readonly string App = Path.Combine(Root, "app");
    public static readonly string Data = Path.Combine(Root, "data");
    public static readonly string Settings = Path.Combine(Root, "settings.txt");
    public static readonly string Log = Path.Combine(Data, "spoolrss.log");
    // Written by the server (src/updates.js): a newer version exists / the user asked to install it.
    public static readonly string UpdateAvailable = Path.Combine(Data, "update-available.txt");
    public static readonly string UpdateRequest = Path.Combine(Data, "update-request.txt");
    public static readonly string UpdateWork = Path.Combine(Data, "update");

    public static string Version()
    {
        try { return File.ReadAllText(Path.Combine(App, "VERSION")).Trim(); } catch (Exception) { return "?"; }
    }
}

static class Settings
{
    const string Defaults =
        "# SpoolRSS settings. The tray icon's Settings changes the common ones. After editing this file,\r\n" +
        "# choose Restart from the tray icon.\r\n" +
        "\r\n" +
        "# 127.0.0.1 keeps SpoolRSS on this computer. Use 0.0.0.0 to let other devices on your network,\r\n" +
        "# like a phone app, reach it; then also set a password below.\r\n" +
        "HOST=127.0.0.1\r\n" +
        "PORT=8080\r\n" +
        "\r\n" +
        "# Remove the # to use these. The README lists every setting.\r\n" +
        "# SPOOLRSS_PASSWORD=\r\n" +
        "# SPOOLRSS_REFRESH_MINUTES=15\r\n" +
        "# SPOOLRSS_RETENTION_DAYS=90\r\n";

    // Only SpoolRSS's own settings reach the server. Anything else (NODE_OPTIONS, for one) could
    // make node.exe run other code, which matters most when SpoolRSS runs as a service.
    static bool Allowed(string key)
    {
        return Regex.IsMatch(key, "^(HOST|PORT|UPDATE_CHECK|(SPOOLRSS|FEEDSTER)_[A-Z0-9_]+)$")
            && key != "SPOOLRSS_DATA" && key != "SPOOLRSS_INSTALL";
    }

    public static Dictionary<string, string> Load()
    {
        if (!File.Exists(Paths.Settings))
        {
            try { File.WriteAllText(Paths.Settings, Defaults); } catch (Exception) { }
        }
        var values = new Dictionary<string, string>();
        values["HOST"] = "127.0.0.1";
        values["PORT"] = "8080";
        try
        {
            foreach (var raw in File.ReadAllLines(Paths.Settings))
            {
                var line = raw.Trim();
                int eq = line.IndexOf('=');
                if (line.Length == 0 || line.StartsWith("#") || eq < 1) continue;
                var key = line.Substring(0, eq).Trim().ToUpperInvariant();
                if (Allowed(key)) values[key] = line.Substring(eq + 1).Trim();
                else Server.Write("settings.txt: ignored " + key + ", which isn't a SpoolRSS setting");
            }
        }
        catch (Exception) { }
        return values;
    }

    public static int Port()
    {
        int port;
        return int.TryParse(Load()["PORT"], out port) && port > 0 && port < 65536 ? port : 8080;
    }

    public static string Url() { return "http://localhost:" + Port() + "/"; }

    /// <summary>
    /// settings.txt with these values set, keeping its comments and other lines. A value that is
    /// already there (or commented out, as in the defaults) is replaced in place; an empty value
    /// comments the line out again.
    /// </summary>
    public static string With(Dictionary<string, string> changes)
    {
        Load(); // creates the file with its defaults if it's missing
        var lines = new List<string>();
        try { lines.AddRange(File.ReadAllLines(Paths.Settings)); } catch (Exception) { }
        var done = new HashSet<string>();
        var result = new List<string>();
        foreach (var raw in lines)
        {
            var line = raw.Trim().TrimStart('#').Trim();
            int eq = line.IndexOf('=');
            string key = eq > 0 ? line.Substring(0, eq).Trim().ToUpperInvariant() : null;
            if (key == null || !changes.ContainsKey(key)) { result.Add(raw); continue; }
            if (done.Contains(key)) continue; // one line per setting
            done.Add(key);
            result.Add(Line(key, changes[key]));
        }
        foreach (var pair in changes)
            if (!done.Contains(pair.Key)) result.Add(Line(pair.Key, pair.Value));
        return string.Join("\r\n", result) + "\r\n";
    }

    static string Line(string key, string value)
    {
        value = (value ?? "").Replace("\r", "").Replace("\n", "").Trim();
        return value.Length == 0 ? "# " + key + "=" : key + "=" + value;
    }
}

/// <summary>The tray menu's Settings window: the few settings people change, written to settings.txt.</summary>
class SettingsForm : Form
{
    readonly NumericUpDown port = new NumericUpDown();
    readonly CheckBox network = new CheckBox();
    readonly TextBox password = new TextBox();
    readonly NumericUpDown refresh = new NumericUpDown();
    readonly NumericUpDown retention = new NumericUpDown();
    readonly CheckBox updates = new CheckBox();
    readonly Label warning = new Label();

    public Dictionary<string, string> Values { get; private set; }

    public SettingsForm()
    {
        var current = Settings.Load();
        Text = "SpoolRSS settings";
        Icon = AppIcon.Small();
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false;
        MinimizeBox = false;
        StartPosition = FormStartPosition.CenterScreen;
        AutoScaleMode = AutoScaleMode.Dpi;
        AutoSize = true;
        AutoSizeMode = AutoSizeMode.GrowAndShrink;
        Font = SystemFonts.MessageBoxFont;
        Padding = new Padding(12);

        var grid = new TableLayoutPanel { ColumnCount = 2, AutoSize = true, Dock = DockStyle.Fill };
        grid.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
        grid.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));

        port.Minimum = 1; port.Maximum = 65535; port.Width = 90;
        port.Value = Number(current, "PORT", 8080, 1, 65535);
        Row(grid, "Port", port, null);

        network.Text = "Let other devices on my network connect (for phone apps)";
        network.AutoSize = true;
        string host;
        network.Checked = current.TryGetValue("HOST", out host) && host != "127.0.0.1" && host != "localhost" && host != "::1";
        Row(grid, "", network, null);

        password.UseSystemPasswordChar = true; password.Width = 220;
        string pw;
        password.Text = current.TryGetValue("SPOOLRSS_PASSWORD", out pw) ? pw : "";
        Row(grid, "Password", password, "Empty: no sign-in");

        refresh.Minimum = 0; refresh.Maximum = 1440; refresh.Width = 90;
        refresh.Value = Number(current, "SPOOLRSS_REFRESH_MINUTES", 15, 0, 1440);
        Row(grid, "Check feeds every", refresh, "minutes (0: only when you refresh)");

        retention.Minimum = 0; retention.Maximum = 36500; retention.Width = 90;
        retention.Value = Number(current, "SPOOLRSS_RETENTION_DAYS", 90, 0, 36500);
        Row(grid, "Keep read articles for", retention, "days (0: forever)");

        updates.Text = "Tell me when a new version is out";
        updates.AutoSize = true;
        string check;
        updates.Checked = !current.TryGetValue("UPDATE_CHECK", out check) || check.ToLowerInvariant() == "true" || check == "1" || check.ToLowerInvariant() == "yes";
        Row(grid, "", updates, null);

        warning.AutoSize = true;
        warning.MaximumSize = new Size(420, 0);
        warning.ForeColor = Color.Firebrick;
        warning.Text = "Anyone on your network can then use SpoolRSS. Set a password.";
        grid.Controls.Add(warning, 1, grid.RowCount);
        grid.RowCount++;
        network.CheckedChanged += delegate { UpdateWarning(); };
        password.TextChanged += delegate { UpdateWarning(); };
        UpdateWarning();

        var more = new LinkLabel { Text = "More settings in settings.txt", AutoSize = true, Margin = new Padding(3, 10, 3, 3) };
        more.LinkClicked += delegate { try { Process.Start(new ProcessStartInfo("notepad.exe", "\"" + Paths.Settings + "\"")); } catch (Exception) { } };
        grid.Controls.Add(more, 1, grid.RowCount);
        grid.RowCount++;

        var buttons = new FlowLayoutPanel { FlowDirection = FlowDirection.RightToLeft, AutoSize = true, Dock = DockStyle.Fill, Margin = new Padding(0, 12, 0, 0) };
        var save = new Button { Text = "Save and restart", AutoSize = true, DialogResult = DialogResult.OK };
        var cancel = new Button { Text = "Cancel", AutoSize = true, DialogResult = DialogResult.Cancel };
        buttons.Controls.Add(cancel);
        buttons.Controls.Add(save);
        grid.Controls.Add(buttons, 0, grid.RowCount);
        grid.SetColumnSpan(buttons, 2);
        grid.RowCount++;

        AcceptButton = save;
        CancelButton = cancel;
        Controls.Add(grid);
        FormClosing += delegate(object s, FormClosingEventArgs e)
        {
            if (DialogResult != DialogResult.OK) return;
            Values = new Dictionary<string, string>();
            Values["PORT"] = ((int)port.Value).ToString();
            Values["HOST"] = network.Checked ? "0.0.0.0" : "127.0.0.1";
            Values["SPOOLRSS_PASSWORD"] = password.Text;
            Values["SPOOLRSS_REFRESH_MINUTES"] = ((int)refresh.Value).ToString();
            Values["SPOOLRSS_RETENTION_DAYS"] = ((int)retention.Value).ToString();
            Values["UPDATE_CHECK"] = updates.Checked ? "true" : "false";
        };
    }

    void UpdateWarning() { warning.Visible = network.Checked && password.Text.Length == 0; }

    static decimal Number(Dictionary<string, string> values, string key, int fallback, int min, int max)
    {
        string text;
        int n;
        if (!values.TryGetValue(key, out text) || !int.TryParse(text, out n)) n = fallback;
        return Math.Max(min, Math.Min(max, n));
    }

    static void Row(TableLayoutPanel grid, string label, Control control, string note)
    {
        int row = grid.RowCount++;
        grid.Controls.Add(new Label { Text = label, AutoSize = true, Anchor = AnchorStyles.Left, Margin = new Padding(3, 7, 10, 3) }, 0, row);
        if (note == null)
        {
            control.Margin = new Padding(3, 5, 3, 3);
            grid.Controls.Add(control, 1, row);
            return;
        }
        var line = new FlowLayoutPanel { AutoSize = true, WrapContents = false, Margin = new Padding(0) };
        control.Margin = new Padding(3, 4, 6, 3);
        line.Controls.Add(control);
        line.Controls.Add(new Label { Text = note, AutoSize = true, ForeColor = SystemColors.GrayText, Margin = new Padding(0, 7, 3, 3) });
        grid.Controls.Add(line, 1, row);
    }
}

/// <summary>Kills node.exe when this process ends, however it ends.</summary>
static class Job
{
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll")]
    static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref ExtendedLimits info, int length);
    [DllImport("kernel32.dll")]
    static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    [StructLayout(LayoutKind.Sequential)]
    struct BasicLimits
    {
        public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
        public int LimitFlags;
        public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
        public int ActiveProcessLimit;
        public UIntPtr Affinity;
        public int PriorityClass, SchedulingClass;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct IoCounters { public ulong a, b, c, d, e, f; }
    [StructLayout(LayoutKind.Sequential)]
    struct ExtendedLimits
    {
        public BasicLimits Basic;
        public IoCounters Io;
        public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
    }

    static IntPtr handle = IntPtr.Zero;

    public static void Add(Process process)
    {
        try
        {
            if (handle == IntPtr.Zero)
            {
                handle = CreateJobObject(IntPtr.Zero, null);
                var info = new ExtendedLimits();
                info.Basic.LimitFlags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
                SetInformationJobObject(handle, 9, ref info, Marshal.SizeOf(typeof(ExtendedLimits)));
            }
            AssignProcessToJobObject(handle, process.Handle);
        }
        catch (Exception) { }
    }
}

/// <summary>Runs the SpoolRSS server (node.exe) and restarts it if it stops unexpectedly.</summary>
class Server
{
    readonly object gate = new object();
    Process process;
    bool stopping;
    DateTime started;
    int quickExits;
    string lastError;

    /// <summary>Raised (on a worker thread) when the server keeps stopping right after starting.</summary>
    public event Action<string> Failed;

    public bool Running { get { lock (gate) return process != null; } }

    public void Start()
    {
        lock (gate) { if (process != null) return; stopping = false; quickExits = 0; Launch(); }
    }

    public void Stop()
    {
        Process p;
        lock (gate) { stopping = true; p = process; process = null; }
        if (p == null) return;
        try { if (!p.HasExited) { p.Kill(); p.WaitForExit(10000); } } catch (Exception) { }
        Write("SpoolRSS stopped");
    }

    void Launch()
    {
        Directory.CreateDirectory(Paths.Data);
        RotateLog();
        var psi = new ProcessStartInfo(Path.Combine(Paths.App, "node.exe"),
            "\"" + Path.Combine(Paths.App, "src", "server.js") + "\"");
        psi.UseShellExecute = false;
        psi.CreateNoWindow = true;
        psi.WorkingDirectory = Paths.App;
        psi.RedirectStandardOutput = true;
        psi.RedirectStandardError = true;
        psi.StandardOutputEncoding = Encoding.UTF8;
        psi.StandardErrorEncoding = Encoding.UTF8;
        // Nothing from this account's environment changes what node.exe loads.
        foreach (var name in new[] { "NODE_OPTIONS", "NODE_PATH", "NODE_EXTRA_CA_CERTS", "NODE_TLS_REJECT_UNAUTHORIZED", "NODE_REPL_EXTERNAL_MODULE" })
            psi.EnvironmentVariables.Remove(name);
        foreach (var pair in Settings.Load()) psi.EnvironmentVariables[pair.Key] = pair.Value;
        psi.EnvironmentVariables["SPOOLRSS_DATA"] = Paths.Data;
        psi.EnvironmentVariables["SPOOLRSS_INSTALL"] = "windows";

        var p = new Process();
        p.StartInfo = psi;
        p.EnableRaisingEvents = true;
        p.OutputDataReceived += delegate(object s, DataReceivedEventArgs e) { if (e.Data != null) Write(e.Data); };
        p.ErrorDataReceived += delegate(object s, DataReceivedEventArgs e)
        {
            if (e.Data == null) return;
            if (e.Data.Contains("EADDRINUSE")) lastError = "Port " + Settings.Port() + " is already used by another program. Change PORT in settings.txt.";
            Write(e.Data);
        };
        p.Exited += delegate { OnExit(p); };
        lastError = null;
        started = DateTime.Now;
        try
        {
            p.Start();
        }
        catch (Exception ex)
        {
            Write("Could not start " + psi.FileName + ": " + ex.Message);
            Fail("SpoolRSS could not start: " + ex.Message);
            return;
        }
        Job.Add(p);
        p.BeginOutputReadLine();
        p.BeginErrorReadLine();
        process = p;
    }

    void OnExit(Process p)
    {
        lock (gate)
        {
            if (stopping || p != process) return;
            Write("SpoolRSS exited with code " + p.ExitCode);
            quickExits = DateTime.Now - started < TimeSpan.FromSeconds(30) ? quickExits + 1 : 0;
            if (quickExits >= 3 || lastError != null)
            {
                process = null;
                Fail(lastError ?? "SpoolRSS keeps stopping. Its log is in data\\spoolrss.log.");
                return;
            }
        }
        Thread.Sleep(2000);
        lock (gate)
        {
            if (stopping || p != process) return;
            process = null;
            Launch();
        }
    }

    void Fail(string message)
    {
        var handler = Failed;
        if (handler != null) ThreadPool.QueueUserWorkItem(delegate { handler(message); });
    }

    public bool WaitUntilListening(int seconds)
    {
        int port = Settings.Port();
        var until = DateTime.Now.AddSeconds(seconds);
        while (DateTime.Now < until)
        {
            try { using (var c = new TcpClient()) { c.Connect("127.0.0.1", port); return true; } }
            catch (Exception) { Thread.Sleep(250); }
        }
        return false;
    }

    static readonly object logGate = new object();

    public static void Write(string line)
    {
        lock (logGate)
        {
            try
            {
                Directory.CreateDirectory(Paths.Data);
                File.AppendAllText(Paths.Log, DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + "  " + line + "\r\n");
            }
            catch (Exception) { }
        }
    }

    static void RotateLog()
    {
        lock (logGate)
        {
            try
            {
                var info = new FileInfo(Paths.Log);
                if (!info.Exists || info.Length < 2 * 1024 * 1024) return;
                var old = Paths.Log + ".1";
                if (File.Exists(old)) File.Delete(old);
                File.Move(Paths.Log, old);
            }
            catch (Exception) { }
        }
    }
}

/// <summary>
/// Installs a release from GitHub over this folder: downloads SpoolRSS-windows.zip and its
/// checksum over HTTPS from this project's releases only, checks it, then swaps app\ and
/// SpoolRSS.exe. data\ and settings.txt are left alone. Whoever runs the server does this:
/// the tray icon, or the service.
/// </summary>
static class Updater
{
    const string Repo = "tet0r/spoolrss";
    const string Asset = "SpoolRSS-windows.zip";

    /// <summary>The version SpoolRSS asked to install, if it is a plain version number.</summary>
    public static string Requested()
    {
        try
        {
            if (!File.Exists(Paths.UpdateRequest)) return null;
            var version = File.ReadAllText(Paths.UpdateRequest).Trim();
            // Only newer versions: nothing can ask for an older release with known problems.
            if (Regex.IsMatch(version, @"^\d{1,4}\.\d{1,4}\.\d{1,4}$") && Newer(version, Paths.Version())) return version;
            Server.Write("Ignored a request to install version " + version);
            File.Delete(Paths.UpdateRequest);
        }
        catch (Exception) { }
        return null;
    }

    static bool Newer(string a, string b)
    {
        Version x, y;
        return System.Version.TryParse(a, out x) && (!System.Version.TryParse(b, out y) || x > y);
    }

    public static string Available()
    {
        try
        {
            if (!File.Exists(Paths.UpdateAvailable)) return null;
            var version = File.ReadAllText(Paths.UpdateAvailable).Trim();
            return Regex.IsMatch(version, @"^\d{1,4}\.\d{1,4}\.\d{1,4}$") ? version : null;
        }
        catch (Exception) { return null; }
    }

    static void Done()
    {
        try { File.Delete(Paths.UpdateRequest); } catch (Exception) { }
        try { File.Delete(Paths.UpdateAvailable); } catch (Exception) { }
    }

    static bool TrustedHost(Uri uri)
    {
#if TEST_UPDATES
        if (uri.Host == "127.0.0.1") return true; // test builds only (build.mjs --test)
#endif
        if (uri.Scheme != Uri.UriSchemeHttps) return false;
        var host = uri.Host.ToLowerInvariant();
        return host == "github.com" || host.EndsWith(".githubusercontent.com");
    }

    static byte[] Download(string url)
    {
        // Each redirect is followed by hand, so every hop has to be GitHub over HTTPS.
        var uri = new Uri(url);
        for (int hop = 0; hop < 5; hop++)
        {
            if (!TrustedHost(uri)) throw new Exception("refusing to download from " + uri.Host);
            var request = (HttpWebRequest)WebRequest.Create(uri);
            request.AllowAutoRedirect = false;
            request.UserAgent = "SpoolRSS/" + Paths.Version() + " (Windows updater)";
            request.Timeout = 60000;
            request.ReadWriteTimeout = 60000;
            HttpWebResponse response;
            try { response = (HttpWebResponse)request.GetResponse(); }
            catch (WebException ex)
            {
                var r = ex.Response as HttpWebResponse;
                if (r == null) throw;
                response = r;
            }
            using (response)
            {
                int status = (int)response.StatusCode;
                if (status >= 300 && status < 400 && response.Headers["Location"] != null)
                {
                    uri = new Uri(uri, response.Headers["Location"]);
                    continue;
                }
                if (status != 200) throw new Exception("HTTP " + status + " for " + uri.AbsolutePath);
                using (var body = response.GetResponseStream())
                using (var memory = new MemoryStream())
                {
                    var buffer = new byte[81920];
                    int read;
                    while ((read = body.Read(buffer, 0, buffer.Length)) > 0)
                    {
                        memory.Write(buffer, 0, read);
                        if (memory.Length > 300L * 1024 * 1024) throw new Exception("download too large");
                    }
                    return memory.ToArray();
                }
            }
        }
        throw new Exception("too many redirects");
    }

    /// <summary>
    /// Installs the version. Returns true when the new files are in place and this exe should
    /// restart; false when nothing changed (the server is running again). Stops the server.
    /// </summary>
    public static bool Install(string version, Server server)
    {
        Server.Write("Updating to " + version);
        string newRoot;
        try
        {
            ServicePointManager.SecurityProtocol |= (SecurityProtocolType)3072; // TLS 1.2
            var base_ = "https://github.com/" + Repo + "/releases/download/v" + version + "/";
#if TEST_UPDATES
            if (Environment.GetEnvironmentVariable("SPOOLRSS_TEST_UPDATES") != null)
                base_ = Environment.GetEnvironmentVariable("SPOOLRSS_TEST_UPDATES") + "v" + version + "/";
#endif
            var zip = Download(base_ + Asset);
            var sums = Encoding.ASCII.GetString(Download(base_ + Asset + ".sha256"));
            var expected = sums.Trim().Split(new[] { ' ', '\t', '*' }, StringSplitOptions.RemoveEmptyEntries)[0].ToLowerInvariant();
            string actual;
            using (var sha = SHA256.Create()) actual = BitConverter.ToString(sha.ComputeHash(zip)).Replace("-", "").ToLowerInvariant();
            if (actual != expected) throw new Exception("the download doesn't match its checksum");

            var workDir = Long(Paths.UpdateWork);
            if (Directory.Exists(workDir)) Directory.Delete(workDir, true);
            Directory.CreateDirectory(workDir);
            var work = workDir + Path.DirectorySeparatorChar;
            using (var archive = new ZipArchive(new MemoryStream(zip)))
            {
                foreach (var entry in archive.Entries)
                {
                    // \\?\ paths are used exactly as given: no / to \ and no resolving "..", so check by hand.
                    var name = entry.FullName.Replace('/', '\\');
                    if (name.Length == 0 || name.StartsWith("\\") || name.Contains(":") || Array.IndexOf(name.Split('\\'), "..") >= 0)
                        throw new Exception("bad path in the download: " + entry.FullName);
                    var target = work + name;
                    if (name.EndsWith("\\")) { Directory.CreateDirectory(target); continue; }
                    Directory.CreateDirectory(Path.GetDirectoryName(target));
                    entry.ExtractToFile(target, true);
                }
            }
            newRoot = Path.Combine(workDir, "SpoolRSS");
            var newVersion = File.ReadAllText(Path.Combine(newRoot, "app", "VERSION")).Trim();
            if (newVersion != version || !File.Exists(Path.Combine(newRoot, "SpoolRSS.exe")) || !File.Exists(Path.Combine(newRoot, "app", "node.exe")))
                throw new Exception("the download isn't SpoolRSS " + version);
        }
        catch (Exception ex)
        {
            Server.Write("Update failed: " + ex);
            Done();
            try { if (Directory.Exists(Long(Paths.UpdateWork))) Directory.Delete(Long(Paths.UpdateWork), true); } catch (Exception) { }
            return false;
        }

        // From here SpoolRSS is briefly stopped. The request is cleared first, so a failure can't loop.
        Done();
        server.Stop();
        var app = Long(Paths.App);
        var oldApp = Long(Paths.App + ".old");
        var oldExe = Paths.Exe + ".old";
        try
        {
            if (Directory.Exists(oldApp)) Directory.Delete(oldApp, true);
            if (File.Exists(oldExe)) File.Delete(oldExe);
            Directory.Move(app, oldApp);
            Directory.Move(Path.Combine(newRoot, "app"), app);
            File.Move(Paths.Exe, oldExe); // a running exe can be renamed, not overwritten
            File.Copy(Path.Combine(newRoot, "SpoolRSS.exe"), Paths.Exe);
            File.Copy(Path.Combine(newRoot, "SpoolRSS.exe.config"), Paths.Exe + ".config", true);
            try { File.Copy(Path.Combine(newRoot, "README.txt"), Path.Combine(Paths.Root, "README.txt"), true); } catch (Exception) { }
        }
        catch (Exception ex)
        {
            Server.Write("Update failed while replacing files, putting the old ones back: " + ex.Message);
            try
            {
                if (Directory.Exists(oldApp))
                {
                    if (Directory.Exists(app)) Directory.Delete(app, true);
                    Directory.Move(oldApp, app);
                }
                if (File.Exists(oldExe))
                {
                    if (File.Exists(Paths.Exe)) File.Delete(Paths.Exe);
                    File.Move(oldExe, Paths.Exe);
                }
            }
            catch (Exception ex2) { Server.Write("Couldn't put the old files back: " + ex2.Message); }
            server.Start();
            return false;
        }
        try { Directory.Delete(Long(Paths.UpdateWork), true); } catch (Exception) { }
        try { Directory.Delete(oldApp, true); } catch (Exception) { }
        Server.Write("Updated to " + version + "; restarting");
        return true;
    }

    /// <summary>
    /// The same path in its \\?\ form, which isn't limited to 260 characters: node_modules nests
    /// deeply, and the SpoolRSS folder itself may be deep.
    /// </summary>
    static string Long(string path)
    {
        var full = Path.GetFullPath(path);
        if (full.StartsWith(@"\\?\")) return full;
        return full.StartsWith(@"\\") ? @"\\?\UNC\" + full.Substring(2) : @"\\?\" + full;
    }

    /// <summary>Leftovers of the last update: the old exe can only be deleted once it has exited.</summary>
    public static void CleanUp()
    {
        try { if (File.Exists(Paths.Exe + ".old")) File.Delete(Paths.Exe + ".old"); } catch (Exception) { }
        try { if (Directory.Exists(Long(Paths.App + ".old"))) Directory.Delete(Long(Paths.App + ".old"), true); } catch (Exception) { }
    }
}

/// <summary>Starting with Windows, as a sign-in entry for the current user (no administrator needed).</summary>
static class Autostart
{
    const string Key = @"Software\Microsoft\Windows\CurrentVersion\Run";
    const string Name = "SpoolRSS";
    static string Command() { return "\"" + Paths.Exe + "\" --tray"; }

    static string Current()
    {
        using (var key = Registry.CurrentUser.OpenSubKey(Key))
            return key == null ? null : key.GetValue(Name) as string;
    }

    public static bool Enabled { get { return Current() != null; } }

    public static void Set(bool on)
    {
        using (var key = Registry.CurrentUser.CreateSubKey(Key))
        {
            if (on) key.SetValue(Name, Command());
            else key.DeleteValue(Name, false);
        }
    }

    /// <summary>Keeps the entry pointing here when the folder was moved.</summary>
    public static void Repair()
    {
        try { if (Enabled && Current() != Command()) Set(true); } catch (Exception) { }
    }
}

/// <summary>The SpoolRSS Windows service, which runs this exe with --service as LocalService.</summary>
static class Service
{
    public const string Name = "SpoolRSS";

    static ServiceController Find()
    {
        foreach (var s in ServiceController.GetServices())
            if (string.Equals(s.ServiceName, Name, StringComparison.OrdinalIgnoreCase)) return s;
        return null;
    }

    public static bool Installed { get { return Find() != null; } }

    public static bool Running
    {
        get
        {
            var s = Find();
            if (s == null) return false;
            var status = s.Status;
            return status == ServiceControllerStatus.Running || status == ServiceControllerStatus.StartPending;
        }
    }

    static int Run(string exe, string arguments)
    {
        var psi = new ProcessStartInfo(Path.Combine(Environment.SystemDirectory, exe), arguments);
        psi.UseShellExecute = false;
        psi.CreateNoWindow = true;
        psi.RedirectStandardOutput = true;
        using (var p = Process.Start(psi))
        {
            var output = p.StandardOutput.ReadToEnd();
            p.WaitForExit();
            if (p.ExitCode != 0) Server.Write(exe + " " + arguments + ": " + output.Trim());
            return p.ExitCode;
        }
    }

    // The service's own identity (NT SERVICE\SpoolRSS), which the folder grants changes to.
    const string ServiceAccount = @"NT SERVICE\SpoolRSS";

    // A service starts without anyone signed in, so its files must not be changeable by ordinary
    // programs: otherwise anything running as this user could edit SpoolRSS's code and have it run
    // as the service. While SpoolRSS is a service, its folder belongs to Administrators, only the
    // service itself can change it (to update), and the user who set it up can read it. Removing
    // the service gives the folder back.
    static int Lock(string userSid)
    {
        if (!Plain()) return 3;
        int code = Run("icacls.exe", "\"" + Paths.Root + "\" /setowner *S-1-5-32-544 /T /C /Q");
        if (code != 0) return code;
        code = Run("icacls.exe", "\"" + Paths.Root + "\" /inheritance:r /grant:r *S-1-5-18:(OI)(CI)F *S-1-5-32-544:(OI)(CI)F \"" + ServiceAccount + ":(OI)(CI)M\" *" + userSid + ":(OI)(CI)RX /C /Q");
        if (code != 0) return code;
        if (Directory.GetFileSystemEntries(Paths.Root).Length > 0)
            code = Run("icacls.exe", "\"" + Path.Combine(Paths.Root, "*") + "\" /reset /T /C /Q");
        // Checked again now that nobody else can add anything.
        return code != 0 ? code : Plain() ? 0 : 3;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool GetFileInformationByHandle(Microsoft.Win32.SafeHandles.SafeFileHandle file, out FileInfoByHandle info);
    [StructLayout(LayoutKind.Sequential)]
    struct FileInfoByHandle
    {
        public uint Attributes;
        public System.Runtime.InteropServices.ComTypes.FILETIME Created, Accessed, Written;
        public uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
    }

    /// <summary>
    /// True when nothing in the folder is a link (junction, symbolic link or hard link). A link
    /// planted beforehand could otherwise make the service, or this elevated setup, change files
    /// elsewhere: the service writes its log and database in data\.
    /// </summary>
    static bool Plain()
    {
        var pending = new Stack<string>();
        pending.Push(Paths.Root);
        while (pending.Count > 0)
        {
            var dir = pending.Pop();
            if ((File.GetAttributes(dir) & FileAttributes.ReparsePoint) != 0) { Server.Write("Not a plain folder: " + dir); return false; }
            foreach (var sub in Directory.GetDirectories(dir)) pending.Push(sub);
            foreach (var file in Directory.GetFiles(dir))
            {
                if ((File.GetAttributes(file) & FileAttributes.ReparsePoint) != 0) { Server.Write("Not a plain file: " + file); return false; }
                using (var stream = new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
                {
                    FileInfoByHandle info;
                    if (!GetFileInformationByHandle(stream.SafeFileHandle, out info) || info.Links != 1) { Server.Write("Not a plain file: " + file); return false; }
                }
            }
        }
        return true;
    }

    static void Unlock(string userSid)
    {
        Run("icacls.exe", "\"" + Paths.Root + "\" /setowner *" + userSid + " /T /C /Q");
        Run("icacls.exe", "\"" + Paths.Root + "\" /reset /T /C /Q");
        // With inheritance back, the user's own access comes from the parent folder again; add it
        // directly too, in case the parent doesn't give it (a folder at the root of a drive).
        Run("icacls.exe", "\"" + Paths.Root + "\" /grant *" + userSid + ":(OI)(CI)F /C /Q");
    }

    // These two run elevated, in a separate SpoolRSS.exe started with "runas", given the SID of
    // the user whose tray icon asked (it may differ from the administrator who approved it).
    public static int Install(string userSid)
    {
        if (!Regex.IsMatch(userSid ?? "", @"^S-1-5-21(-\d+){4}$")) return 2;
        // LocalService: a low-rights account, not LocalSystem. Feeds are fetched and parsed from
        // the internet, so a flaw there must not hand over the computer. Its privileges are cut to
        // the one it needs, which drops SeImpersonatePrivilege (a known route to LocalSystem).
        int code = Run("sc.exe", "create " + Name + " binPath= \"\\\"" + Paths.Exe + "\\\" --service\" start= auto DisplayName= \"SpoolRSS\" obj= \"NT AUTHORITY\\LocalService\"");
        if (code != 0) return code;
        bool ok = Run("sc.exe", "sidtype " + Name + " unrestricted") == 0
            && Run("sc.exe", "privs " + Name + " SeChangeNotifyPrivilege") == 0;
        if (ok) code = Lock(userSid);
        if (!ok || code != 0)
        {
            Run("sc.exe", "delete " + Name);
            Unlock(userSid);
            return code != 0 ? code : 4;
        }
        Run("sc.exe", "description " + Name + " \"SpoolRSS feed reader, from " + Paths.Root + "\"");
        // Restarts after a crash, and after an update (the service exits to load the new exe).
        Run("sc.exe", "failure " + Name + " reset= 86400 actions= restart/5000/restart/5000/restart/60000");
        return Run("sc.exe", "start " + Name);
    }

    public static int Remove(string userSid)
    {
        if (!Regex.IsMatch(userSid ?? "", @"^S-1-5-21(-\d+){4}$")) return 2;
        var s = Find();
        if (s != null)
        {
            try
            {
                if (s.Status != ServiceControllerStatus.Stopped)
                {
                    s.Stop();
                    s.WaitForStatus(ServiceControllerStatus.Stopped, TimeSpan.FromSeconds(30));
                }
            }
            catch (Exception) { }
            int code = Run("sc.exe", "delete " + Name);
            if (code != 0) return code;
        }
        Unlock(userSid);
        return 0;
    }

    /// <summary>Restarts the service (elevated), for example to load new settings.</summary>
    public static int Restart()
    {
        var s = Find();
        if (s == null) return 0;
        try
        {
            if (s.Status != ServiceControllerStatus.Stopped)
            {
                s.Stop();
                s.WaitForStatus(ServiceControllerStatus.Stopped, TimeSpan.FromSeconds(30));
            }
            s.Start();
            s.WaitForStatus(ServiceControllerStatus.Running, TimeSpan.FromSeconds(30));
            return 0;
        }
        catch (Exception ex)
        {
            Server.Write("Couldn't restart the service: " + ex.Message);
            return 1;
        }
    }

    /// <summary>
    /// Saves settings the tray icon prepared into settings.txt (elevated: while SpoolRSS is a service
    /// only administrators can change its folder), then restarts the service. The server still only
    /// takes SpoolRSS's own settings from the file.
    /// </summary>
    public static int ApplySettings(string file)
    {
        try
        {
            if (file == null || !File.Exists(file) || new FileInfo(file).Length > 64 * 1024) return 2;
            File.WriteAllText(Paths.Settings, File.ReadAllText(file));
            try { File.Delete(file); } catch (Exception) { }
        }
        catch (Exception ex)
        {
            Server.Write("Couldn't save the settings: " + ex.Message);
            return 1;
        }
        return Restart();
    }

    /// <summary>Runs this exe elevated; Windows asks for administrator permission.</summary>
    public static bool RunElevated(string argument)
    {
        try
        {
            var psi = new ProcessStartInfo(Paths.Exe, argument + " " + WindowsIdentity.GetCurrent().User.Value);
            psi.UseShellExecute = true;
            psi.Verb = "runas";
            using (var p = Process.Start(psi))
            {
                p.WaitForExit();
                return p.ExitCode == 0;
            }
        }
        catch (System.ComponentModel.Win32Exception)
        {
            return false; // the permission prompt was declined
        }
    }
}

class SpoolService : ServiceBase
{
    readonly Server server = new Server();
    System.Threading.Timer timer;
    int busy;

    public SpoolService()
    {
        ServiceName = Service.Name;
        server.Failed += delegate(string message) { Server.Write(message); Stop(); };
    }

    protected override void OnStart(string[] args)
    {
        Updater.CleanUp();
        server.Start();
        timer = new System.Threading.Timer(delegate { CheckForRequest(); }, null, 2000, 2000);
    }

    void CheckForRequest()
    {
        if (Interlocked.Exchange(ref busy, 1) == 1) return;
        try
        {
            var version = Updater.Requested();
            if (version == null) return;
            if (Updater.Install(version, server))
            {
                // Exiting without being stopped makes Windows restart the service (see Service.Install),
                // now with the new SpoolRSS.exe.
                Environment.Exit(1);
            }
        }
        finally { Interlocked.Exchange(ref busy, 0); }
    }

    protected override void OnStop()
    {
        if (timer != null) timer.Dispose();
        server.Stop();
    }
}

class Tray : ApplicationContext
{
    readonly NotifyIcon icon = new NotifyIcon();
    readonly Server server = new Server();
    readonly SynchronizationContext ui;
    readonly ToolStripMenuItem autostartItem, serviceItem, updateItem;
    readonly System.Windows.Forms.Timer timer = new System.Windows.Forms.Timer();
    string notifiedUpdate;
    bool updating;

    public Tray(bool quiet, bool updated)
    {
        ui = SynchronizationContext.Current ?? new WindowsFormsSynchronizationContext();
        server.Failed += delegate(string message)
        {
            ui.Post(delegate { Notify(message, ToolTipIcon.Error); }, null);
        };

        var menu = new ContextMenuStrip();
        var open = new ToolStripMenuItem("Open SpoolRSS", null, delegate { Open(); });
        open.Font = new Font(open.Font, FontStyle.Bold);
        updateItem = new ToolStripMenuItem("Update SpoolRSS…", null, delegate { Open(); });
        autostartItem = new ToolStripMenuItem("Start with Windows", null, delegate { ToggleAutostart(); });
        serviceItem = new ToolStripMenuItem("Run as a Windows service", null, delegate { ToggleService(); });
        menu.Items.Add(open);
        menu.Items.Add(updateItem);
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add(new ToolStripMenuItem("Settings…", null, delegate { ShowSettings(); }));
        menu.Items.Add(autostartItem);
        menu.Items.Add(serviceItem);
        menu.Items.Add(new ToolStripMenuItem("Open the SpoolRSS folder", null, delegate { Shell(Paths.Root); }));
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add(new ToolStripMenuItem("Restart", null, delegate { Restart(null); }));
        menu.Items.Add(new ToolStripMenuItem("Exit", null, delegate { Quit(); }));
        menu.Opening += delegate { UpdateMenu(); };

        icon.Icon = AppIcon.Small();
        icon.ContextMenuStrip = menu;
        icon.MouseClick += delegate(object s, MouseEventArgs e) { if (e.Button == MouseButtons.Left) Open(); };
        icon.BalloonTipClicked += delegate { Open(); };
        icon.Visible = true;
        UpdateMenu();
        Autostart.Repair();
        Updater.CleanUp();

        bool firstRun = !File.Exists(Path.Combine(Paths.Data, "spoolrss.db"));
        if (Service.Installed)
        {
            if (!Service.Running) Notify("The SpoolRSS service isn't running. Start it from Services, or turn off \"Run as a Windows service\".", ToolTipIcon.Warning);
        }
        else
        {
            server.Start();
        }
        if (updated) Notify("SpoolRSS was updated to version " + Paths.Version() + ".", ToolTipIcon.Info);
        else if (firstRun) OpenWhenReady();
        else if (!quiet) Notify("SpoolRSS is running. Click its tray icon to open it.", ToolTipIcon.Info);
        notifiedUpdate = updated ? Paths.Version() : null;

        timer.Interval = 2000;
        timer.Tick += delegate { Tick(); };
        timer.Start();
    }

    void Tick()
    {
        if (updating) return;
        var available = Updater.Available();
        if (available != null && available != notifiedUpdate)
        {
            notifiedUpdate = available;
            Notify("SpoolRSS " + available + " is available. Click to open SpoolRSS and update.", ToolTipIcon.Info);
        }
        // When SpoolRSS runs as a service, the service installs updates itself.
        if (Service.Installed || !server.Running) return;
        var requested = Updater.Requested();
        if (requested == null) return;
        updating = true;
        ThreadPool.QueueUserWorkItem(delegate
        {
            bool restart = Updater.Install(requested, server);
            ui.Post(delegate
            {
                if (restart)
                {
                    try
                    {
                        Process.Start(new ProcessStartInfo(Paths.Exe, "--tray --updated") { UseShellExecute = false });
                        Quit();
                        return;
                    }
                    catch (Exception ex) { Server.Write("Couldn't restart after the update: " + ex.Message); server.Start(); }
                }
                else Notify("The update didn't finish, so SpoolRSS is still on version " + Paths.Version() + ". Its log is in data\\spoolrss.log.", ToolTipIcon.Warning);
                updating = false;
            }, null);
        });
    }

    void UpdateMenu()
    {
        bool service = Service.Installed;
        autostartItem.Checked = Autostart.Enabled;
        serviceItem.Checked = service;
        var available = Updater.Available();
        updateItem.Visible = available != null;
        if (available != null) updateItem.Text = "Update to version " + available + "…";
        icon.Text = service ? "SpoolRSS (Windows service)" : "SpoolRSS " + Paths.Version();
    }

    void Open()
    {
        if (!Service.Installed && !server.Running && !updating) server.Start();
        Shell(Settings.Url());
    }

    void OpenWhenReady()
    {
        ThreadPool.QueueUserWorkItem(delegate
        {
            if (server.WaitUntilListening(30) || Service.Installed) ui.Post(delegate { Shell(Settings.Url()); }, null);
        });
    }

    void ToggleAutostart()
    {
        try { Autostart.Set(!Autostart.Enabled); }
        catch (Exception ex) { Notify("Couldn't change that: " + ex.Message, ToolTipIcon.Error); }
        UpdateMenu();
    }

    void ToggleService()
    {
        if (updating) return;
        if (Service.Installed)
        {
            if (!Confirm("Stop running SpoolRSS as a Windows service?\n\nSpoolRSS will then run only while this tray icon does, and the SpoolRSS folder becomes yours to change again. Windows asks for administrator permission next."))
                return;
            if (Service.RunElevated("--remove-service"))
            {
                server.Start();
                Notify("SpoolRSS no longer runs as a service. It runs from this tray icon now.", ToolTipIcon.Info);
            }
            else Notify("The service wasn't removed.", ToolTipIcon.Warning);
        }
        else
        {
            if (!Confirm("Run SpoolRSS as a Windows service?\n\nIt then starts when Windows starts, even before anyone signs in, and keeps running when you exit this tray icon.\n\nFor safety, only administrators can change the SpoolRSS folder while it's a service (so Settings and Restart ask for administrator permission, and the folder should stay where it is). Turning this off gives the folder back.\n\nWindows asks for administrator permission next."))
                return;
            server.Stop();
            if (Service.RunElevated("--install-service"))
            {
                Notify("SpoolRSS now runs as a Windows service.", ToolTipIcon.Info);
            }
            else
            {
                // A half-made service would keep the tray from running SpoolRSS.
                if (Service.Installed && !Service.Running) Service.RunElevated("--remove-service");
                if (!Service.Installed) server.Start();
                Notify("SpoolRSS wasn't set up as a service. Its log is in data\\spoolrss.log.", ToolTipIcon.Warning);
            }
        }
        UpdateMenu();
    }

    SettingsForm settingsForm;

    void ShowSettings()
    {
        if (settingsForm != null) { settingsForm.Activate(); return; }
        using (settingsForm = new SettingsForm())
        {
            var result = settingsForm.ShowDialog();
            var values = settingsForm.Values;
            settingsForm = null;
            if (result != DialogResult.OK || values == null) return;
            var text = Settings.With(values);
            if (Service.Installed)
            {
                // The folder is administrators' while SpoolRSS is a service: save through an elevated copy.
                var file = Path.Combine(Path.GetTempPath(), "spoolrss-settings-" + Guid.NewGuid().ToString("N") + ".txt");
                File.WriteAllText(file, text);
                bool ok = Service.RunElevated("--apply-settings \"" + file + "\"");
                try { File.Delete(file); } catch (Exception) { }
                if (ok) Notify("Settings saved. SpoolRSS restarted at " + Settings.Url(), ToolTipIcon.Info);
                else Notify("The settings weren't saved.", ToolTipIcon.Warning);
                return;
            }
            try { File.WriteAllText(Paths.Settings, text); }
            catch (Exception ex) { Notify("Couldn't save the settings: " + ex.Message, ToolTipIcon.Error); return; }
            Restart("Settings saved. SpoolRSS restarted at " + Settings.Url());
        }
    }

    /// <summary>Restarts the server (or, when SpoolRSS is a service, the service).</summary>
    void Restart(string message)
    {
        if (updating) return;
        if (Service.Installed)
        {
            if (Service.RunElevated("--restart-service")) Notify(message ?? "SpoolRSS restarted.", ToolTipIcon.Info);
            else Notify("SpoolRSS wasn't restarted.", ToolTipIcon.Warning);
            return;
        }
        server.Stop();
        server.Start();
        Notify(message ?? "SpoolRSS restarted.", ToolTipIcon.Info);
    }

    static bool Confirm(string text)
    {
        return MessageBox.Show(text, "SpoolRSS", MessageBoxButtons.OKCancel, MessageBoxIcon.Question) == DialogResult.OK;
    }

    void Notify(string text, ToolTipIcon kind)
    {
        icon.ShowBalloonTip(8000, "SpoolRSS", text, kind);
    }

    static void Shell(string target)
    {
        try { Process.Start(new ProcessStartInfo(target) { UseShellExecute = true }); }
        catch (Exception ex) { Server.Write("Couldn't open " + target + ": " + ex.Message); }
    }

    void Quit()
    {
        timer.Stop();
        icon.Visible = false;
        server.Stop();
        ExitThread();
    }
}

static class AppIcon
{
    public static Icon Small()
    {
        using (var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream("spoolrss.ico"))
            return new Icon(stream, SystemInformation.SmallIconSize);
    }
}

static class Program
{
    [STAThread]
    static int Main(string[] args)
    {
        string mode = args.Length > 0 ? args[0].ToLowerInvariant() : "";
        string arg = args.Length > 1 ? args[1] : null;
        if (mode == "--service")
        {
            ServiceBase.Run(new SpoolService());
            return 0;
        }
        if (mode == "--install-service") return Service.Install(arg);
        if (mode == "--remove-service") return Service.Remove(arg);
        if (mode == "--restart-service") return Service.Restart();
        if (mode == "--apply-settings") return Service.ApplySettings(arg);

        bool updated = Array.IndexOf(args, "--updated") >= 0;
        // One tray icon per SpoolRSS folder; starting it again just opens SpoolRSS.
        string id;
        using (var sha = SHA256.Create())
            id = BitConverter.ToString(sha.ComputeHash(Encoding.UTF8.GetBytes(Paths.Root.ToLowerInvariant()))).Replace("-", "").Substring(0, 32);
        using (var mutex = new Mutex(false, "Local\\SpoolRSS-" + id))
        {
            bool owned;
            // Right after an update, the old tray icon is still closing.
            try { owned = mutex.WaitOne(updated ? 20000 : 0); }
            catch (AbandonedMutexException) { owned = true; }
            if (!owned)
            {
                if (mode != "--tray") Process.Start(new ProcessStartInfo(Settings.Url()) { UseShellExecute = true });
                return 0;
            }
            if (!File.Exists(Path.Combine(Paths.App, "node.exe")))
            {
                MessageBox.Show("SpoolRSS.exe needs the app folder next to it. Unzip the whole SpoolRSS folder and run SpoolRSS.exe from there.",
                    "SpoolRSS", MessageBoxButtons.OK, MessageBoxIcon.Error);
                return 1;
            }
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new Tray(mode == "--tray", updated));
            mutex.ReleaseMutex();
        }
        return 0;
    }
}
