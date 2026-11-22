// ScreenPower.exe — 一键黑屏 / 定时亮屏 / 夜间防休眠守护
// 编译: csc.exe /nologo /target:winexe /platform:anycpu /optimize+ /r:System.Windows.Forms.dll /r:System.Drawing.dll /r:System.Management.dll ScreenPower.cs
//
// 命令:
//   off  [--until HH:mm]   黑屏（屏幕断电 + 亮度归零 + 防休眠守护），可选到点自动亮屏
//   on                     亮屏恢复（点亮显示器、恢复亮度与休眠设置、停止守护）
//   guard                  守护进程（由 off 拉起 / 计划任务启动）
//   sleep-guard            仅防休眠守护（不黑屏）
//   status [--quiet]       查看当前状态
//
// 状态与日志目录: C:\ProgramData\ScreenPower （可用环境变量 SCREENPOWER_HOME 覆盖，便于测试）
//
// 设计要点:
//   * 黑屏 = 显示器真正断电 (WM_SYSCOMMAND/SC_MONITORPOWER) + DDC/CI 亮度归零 + 内置面板亮度归零
//   * 黑屏期间电脑不休眠: 关闭电源计划中的自动睡眠/休眠, 并由守护进程 SetThreadExecutionState 持续持有
//   * 到点恢复: 守护进程检测到 --until 时间到达后自动点亮屏幕、恢复亮度、还原电源设置并退出
//   * 手动恢复: 任何时候按 Ctrl+Alt+F12 立即亮屏

using System;
using System.Collections.Generic;
using System.Drawing;
using System.Globalization;
using System.IO;
using System.Management;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Forms;

namespace ScreenPower
{
    internal static class N
    {
        internal const int HWND_BROADCAST = 0xFFFF;
        internal const uint WM_SYSCOMMAND = 0x0112;
        internal const int SC_MONITORPOWER = 0xF170;
        internal const int SC_OFF = 2;      // wParam = 2  -> 关闭显示器
        internal const int SC_ON = -1;      // wParam = -1 -> 打开显示器

        // SetThreadExecutionState
        internal const uint ES_CONTINUOUS = 0x80000000;
        internal const uint ES_SYSTEM_REQUIRED = 0x00000001;
        internal const uint ES_DISPLAY_REQUIRED = 0x00000002;
        internal const uint ES_AWAYMODE_REQUIRED = 0x00000040;

        internal const uint MOUSEEVENTF_MOVE = 0x0001;

        // ---- SendInput (模拟按键) ----
        internal const uint INPUT_KEYBOARD = 1;
        internal const uint KEYEVENTF_KEYUP = 0x0002;
        internal const ushort VK_SHIFT = 0x10;
        internal static readonly int SIZE_INPUT = Marshal.SizeOf(typeof(INPUT));

        [StructLayout(LayoutKind.Sequential)]
        internal struct INPUT
        {
            public uint type;
            public INPUTUNION u;
        }

        [StructLayout(LayoutKind.Explicit)]
        internal struct INPUTUNION
        {
            [FieldOffset(0)] public KEYBDINPUT ki;
            [FieldOffset(0)] public MOUSEINPUT mi;
        }

        [StructLayout(LayoutKind.Sequential)]
        internal struct KEYBDINPUT
        {
            public ushort wVk;
            public ushort wScan;
            public uint dwFlags;
            public uint time;
            public IntPtr dwExtraInfo;
        }

        [StructLayout(LayoutKind.Sequential)]
        internal struct MOUSEINPUT
        {
            public int dx;
            public int dy;
            public uint mouseData;
            public uint dwFlags;
            public uint time;
            public IntPtr dwExtraInfo;
        }

        [DllImport("user32.dll", SetLastError = true)]
        internal static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);

        internal static INPUT MakeKeyInput(ushort vk, bool keyUp)
        {
            var inp = new INPUT();
            inp.type = INPUT_KEYBOARD;
            inp.u.ki.wVk = vk;
            inp.u.ki.wScan = 0;
            inp.u.ki.dwFlags = keyUp ? KEYEVENTF_KEYUP : 0;
            inp.u.ki.time = 0;
            inp.u.ki.dwExtraInfo = IntPtr.Zero;
            return inp;
        }

        [DllImport("user32.dll", SetLastError = true)]
        internal static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam,
            uint fuFlags, uint uTimeout, out IntPtr lpdwResult);

        [DllImport("kernel32.dll", SetLastError = true)]
        internal static extern uint SetThreadExecutionState(uint esFlags);

        [DllImport("user32.dll", SetLastError = true)]
        internal static extern bool SetCursorPos(int X, int Y);

        [DllImport("user32.dll", SetLastError = true)]
        internal static extern bool GetCursorPos(out POINT lpPoint);

        [DllImport("user32.dll", SetLastError = true)]
        internal static extern void mouse_event(uint dwFlags, int dx, int dy, uint dwData, IntPtr dwExtraInfo);

        [DllImport("user32.dll")]
        internal static extern bool EnumDisplayMonitors(IntPtr hdc, IntPtr lprcClip, MonitorEnumProc lpfnEnum, IntPtr dwData);
        internal delegate bool MonitorEnumProc(IntPtr hMonitor, IntPtr hdc, IntPtr lprcMonitor, IntPtr lParam);

        [DllImport("dxva2.dll", SetLastError = true)]
        internal static extern bool GetNumberOfPhysicalMonitorsFromHMONITOR(IntPtr hMonitor, out uint dwNumberOfPhysicalMonitors);

        [DllImport("dxva2.dll", SetLastError = true)]
        internal static extern bool GetPhysicalMonitorsFromHMONITOR(IntPtr hMonitor, uint dwPhysicalMonitorArraySize,
            [Out] PHYSICAL_MONITOR[] pPhysicalMonitorArray);

        [DllImport("dxva2.dll", SetLastError = true)]
        internal static extern bool SetVCPFeature(IntPtr hPhysicalMonitor, byte bCode, uint dwValue);

        [DllImport("dxva2.dll", SetLastError = true)]
        internal static extern bool GetVCPFeatureAndVCPFeatureReply(IntPtr hPhysicalMonitor, byte bCode,
            out uint pvType, out uint pvCurrentValue, out uint pvMaximumValue);

        [DllImport("user32.dll", SetLastError = true)]
        internal static extern bool RegisterHotKey(IntPtr hWnd, int id, uint fsModifiers, uint vk);

        [DllImport("user32.dll", SetLastError = true)]
        internal static extern bool UnregisterHotKey(IntPtr hWnd, int id);

        // ---- 低级键盘/鼠标钩子: 用于检测"任意按键即可亮屏" ----
        internal delegate IntPtr HookProc(int nCode, IntPtr wParam, IntPtr lParam);

        [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        internal static extern IntPtr SetWindowsHookEx(int idHook, HookProc lpfn, IntPtr hMod, uint dwThreadId);

        [DllImport("user32.dll", SetLastError = true)]
        internal static extern bool UnhookWindowsHookEx(IntPtr hhk);

        [DllImport("user32.dll", SetLastError = true)]
        internal static extern IntPtr CallNextHookEx(IntPtr hhk, int nCode, IntPtr wParam, IntPtr lParam);

        [DllImport("user32.dll", SetLastError = true)]
        internal static extern IntPtr GetMessage(out MSG lpMsg, IntPtr hWnd, uint wMsgFilterMin, uint wMsgFilterMax);

        [DllImport("user32.dll", SetLastError = true)]
        internal static extern bool TranslateMessage(ref MSG lpMsg);

        [DllImport("user32.dll", SetLastError = true)]
        internal static extern IntPtr DispatchMessage(ref MSG lpMsg);

        [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        internal static extern IntPtr GetModuleHandle(string lpModuleName);

        internal const int WH_KEYBOARD_LL = 13;
        internal const int WH_MOUSE_LL = 14;
        internal const int WM_KEYDOWN = 0x0100;
        internal const int WM_KEYUP = 0x0101;
        internal const int WM_SYSKEYDOWN = 0x0104;
        internal const int WM_SYSKEYUP = 0x0105;
        internal const int WM_MOUSEMOVE = 0x0200;
        internal const int WM_LBUTTONDOWN = 0x0201;
        internal const int WM_RBUTTONDOWN = 0x0204;
        internal const int WM_MBUTTONDOWN = 0x0207;

        [StructLayout(LayoutKind.Sequential)]
        internal struct MSG
        {
            public IntPtr hwnd;
            public uint message;
            public IntPtr wParam;
            public IntPtr lParam;
            public uint time;
            public int pt_x;
            public int pt_y;
        }

        [StructLayout(LayoutKind.Sequential)]
        internal struct KBDLLHOOKSTRUCT
        {
            public uint vkCode;
            public uint scanCode;
            public uint flags;
            public uint time;
            public IntPtr dwExtraInfo;
        }

        [StructLayout(LayoutKind.Sequential)]
        internal struct POINT { public int X; public int Y; }

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        internal struct PHYSICAL_MONITOR
        {
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)]
            public string szPhysicalMonitorDescription;
            public IntPtr hPhysicalMonitor;
            [MarshalAs(UnmanagedType.Bool)]
            public bool bPhysicalMonitorExists;
            public byte CapabilityFlags;
        }
    }

    internal static class Log
    {
        private static readonly object Sync = new object();
        internal static string File = Path.Combine(AppDir.Dir, "screenpower.log");

        internal static void Write(string fmt, params object[] args)
        {
            string msg;
            try { msg = string.Format(CultureInfo.InvariantCulture, fmt, args); }
            catch { msg = fmt; }
            string line = string.Format(CultureInfo.InvariantCulture, "[{0:yyyy-MM-dd HH:mm:ss}] {1}",
                DateTime.Now, msg);
            try
            {
                lock (Sync)
                {
                    Directory.CreateDirectory(AppDir.Dir);
                    System.IO.File.AppendAllText(Log.File, line + Environment.NewLine, Encoding.UTF8);
                }
            }
            catch { }
            System.Diagnostics.Debug.WriteLine(line);
        }
    }

    internal static class AppDir
    {
        internal static readonly string Dir = Environment.GetEnvironmentVariable("SCREENPOWER_HOME")
            ?? Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData),
                "ScreenPower");
        internal static string StateFile { get { return Path.Combine(Dir, "state.txt"); } }
        internal static string WakeFlag { get { return Path.Combine(Dir, "wake.flag"); } }
        internal static string PidFile { get { return Path.Combine(Dir, "guard.pid"); } }
    }

    internal sealed class State
    {
        /// <summary>跨进程写 state.txt 的互斥锁文件句柄 (off 与 guard 是两个进程)</summary>
        private static readonly object StateSync = new object();

        internal string Mode = "off";           // off (黑屏中) | scheduled (定时黑屏) | manual (已恢复/空闲)
        internal string Until = "";           // HH:mm
        internal DateTime UntilTime = DateTime.MinValue;
        internal bool HasUntil = false;
        internal int SavedInternalBrightness = -1;
        internal bool SavedPowerCfg = false;
        internal string SavedStandbyAc = "";  // 十六进制, 如 0x00000a8c
        internal string SavedStandbyDc = "";
        internal string SavedHibernateAc = "";
        internal string SavedHibernateDc = "";
        internal string SavedScheme = "";     // 记录当时生效的电源方案 GUID

        internal void Save()
        {
            try
            {
                Directory.CreateDirectory(AppDir.Dir);
                var sb = new StringBuilder();
                sb.AppendLine("Mode=" + Mode);
                sb.AppendLine("Until=" + Until);
                sb.AppendLine("HasUntil=" + (HasUntil ? "1" : "0"));
                sb.AppendLine("SavedInternalBrightness=" + SavedInternalBrightness);
                sb.AppendLine("SavedPowerCfg=" + (SavedPowerCfg ? "1" : "0"));
                sb.AppendLine("SavedStandbyAc=" + SavedStandbyAc);
                sb.AppendLine("SavedStandbyDc=" + SavedStandbyDc);
                sb.AppendLine("SavedHibernateAc=" + SavedHibernateAc);
                sb.AppendLine("SavedHibernateDc=" + SavedHibernateDc);
                sb.AppendLine("SavedScheme=" + SavedScheme);

                // 原子写 + 互斥: off 与 guard 是两个独立进程, 会并发写同一个文件。
                // 直接 File.WriteAllText 会产生"写了一半被对方截断"的竞态,
                // 导致 SavedStandbyAc 等字段丢失, 恢复时无法还原原电源设置。
                string tmp = AppDir.StateFile + ".tmp";
                lock (StateSync)
                {
                    File.WriteAllText(tmp, sb.ToString(), Encoding.UTF8);
                    if (File.Exists(AppDir.StateFile)) File.Delete(AppDir.StateFile);
                    File.Move(tmp, AppDir.StateFile);
                }
            }
            catch (Exception ex) { Log.Write("state save failed: " + ex.Message); }
        }

        internal static State Load()
        {
            var s = new State();
            try
            {
                lock (StateSync)
                {
                    if (!File.Exists(AppDir.StateFile)) return s;
                    foreach (var line in File.ReadAllLines(AppDir.StateFile, Encoding.UTF8))
                    {
                        int i = line.IndexOf('=');
                        if (i <= 0) continue;
                        string k = line.Substring(0, i).Trim();
                        string v = line.Substring(i + 1).Trim();
                        switch (k)
                        {
                            case "Mode": s.Mode = v; break;
                            case "Until": s.Until = v; break;
                            case "HasUntil": s.HasUntil = (v == "1"); break;
                            case "SavedInternalBrightness":
                                int b; if (int.TryParse(v, out b)) s.SavedInternalBrightness = b; break;
                            case "SavedPowerCfg": s.SavedPowerCfg = (v == "1"); break;
                            case "SavedStandbyAc": s.SavedStandbyAc = v; break;
                            case "SavedStandbyDc": s.SavedStandbyDc = v; break;
                            case "SavedHibernateAc": s.SavedHibernateAc = v; break;
                            case "SavedHibernateDc": s.SavedHibernateDc = v; break;
                            case "SavedScheme": s.SavedScheme = v; break;
                        }
                    }
                }
                if (s.HasUntil && !string.IsNullOrEmpty(s.Until))
                {
                    DateTime parsed;
                    if (DateTime.TryParseExact(s.Until, "HH:mm", CultureInfo.InvariantCulture,
                            DateTimeStyles.None, out parsed))
                    {
                        DateTime t = DateTime.Today.Add(parsed.TimeOfDay);
                        if (t <= DateTime.Now) t = t.AddDays(1);
                        s.UntilTime = t;
                    }
                }
            }
            catch { }
            return s;
        }
    }

    internal static class Power
    {
        internal const string SubSleep = "238c9fa8-0aad-41ed-83f4-97be242c8f20";       // 睡眠
        internal const string StandbyIdle = "29f6c1db-86da-48c5-9fdb-f2b67b1f44da";  // 在此时间后睡眠
        internal const string HibernateIdle = "9d7815a6-7ee4-497e-8888-515a05f02364"; // 在此时间后休眠
        internal const string SubVideo = "7516b95f-f776-4464-8c53-06167f40cc99";       // 视频设置
        internal const string VideoIdle = "3c0bc021-c8a8-4e07-a973-6b14cbcb2b7e";       // 在此时间后关闭显示器

        private static string _scheme;

        /// <summary>当前生效的电源方案 GUID</summary>
        internal static string ActiveScheme()
        {
            if (!string.IsNullOrEmpty(_scheme)) return _scheme;
            try
            {
                string outp = RunCapture("powercfg.exe /getactivescheme");
                Match m = Regex.Match(outp ?? "",
                    @"([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})");
                if (m.Success) { _scheme = m.Groups[1].Value; return _scheme; }
            }
            catch (Exception ex) { Log.Write("getactivescheme failed: " + ex.Message); }
            return "";
        }

        /// <summary>
        /// 读取某个电源设置索引。ac=true 取交流, false 取直流。返回十六进制字符串或 ""。
        /// powercfg 的输出编码随区域设置而变 (GBK 或 UTF-8), 标签措辞随语言而变,
        /// 因此解析只依赖 ASCII 的 0x 索引值: 输出末尾两个 0x 依次是 AC、DC。
        /// </summary>
        internal static string Query(string sub, string setting, bool ac)
        {
            try
            {
                string scheme = ActiveScheme();
                if (string.IsNullOrEmpty(scheme)) return "";
                string outp = RunCapture("powercfg.exe /query " + scheme + " " + sub + " " + setting);
                if (string.IsNullOrEmpty(outp)) return "";

                var idx = new List<string>();
                foreach (Match m in Regex.Matches(outp, @"0x[0-9a-fA-F]{8}"))
                    idx.Add(m.Value.ToLowerInvariant());

                if (idx.Count >= 2)
                {
                    string acv = idx[idx.Count - 2];
                    string dcv = idx[idx.Count - 1];
                    string val = ac ? acv : dcv;
                    long v;
                    if (long.TryParse(val.Substring(2), NumberStyles.HexNumber, CultureInfo.InvariantCulture, out v)
                        && v >= 0 && v <= 0xffffffffL)
                        return val;
                }

                // 回退: 用中文/英文标签定位
                string label = ac ? @"当前交流电源设置索引|Current AC Power Setting Index"
                                  : @"当前直流电源设置索引|Current DC Power Setting Index";
                Match mm = Regex.Match(outp, label + @"\s*[:：]\s*(0x[0-9a-fA-F]+)");
                if (mm.Success) return mm.Groups[1].Value.ToLowerInvariant();
            }
            catch (Exception ex) { Log.Write("powercfg query failed: " + ex.Message); }
            return "";
        }

        /// <summary>设置某个电源设置的交流(AC)索引。AC 与 DC 是独立索引, 需分别设置。</summary>
        internal static void SetAc(string sub, string setting, string decimalValue)
        {
            string scheme = ActiveScheme();
            if (string.IsNullOrEmpty(scheme)) { Log.Write("powercfg set skipped: no active scheme"); return; }
            RunCapture("powercfg.exe /setacvalueindex " + scheme + " " + sub + " " + setting + " " + decimalValue);
            RunCapture("powercfg.exe /setactive " + scheme);
            Log.Write("powercfg setac " + sub + "/" + setting + " = " + decimalValue);
        }

        /// <summary>设置某个电源设置的直流(DC)索引。</summary>
        internal static void SetDc(string sub, string setting, string decimalValue)
        {
            string scheme = ActiveScheme();
            if (string.IsNullOrEmpty(scheme)) { Log.Write("powercfg set skipped: no active scheme"); return; }
            RunCapture("powercfg.exe /setdcvalueindex " + scheme + " " + sub + " " + setting + " " + decimalValue);
            RunCapture("powercfg.exe /setactive " + scheme);
            Log.Write("powercfg setdc " + sub + "/" + setting + " = " + decimalValue);
        }

        /// <summary>同时设置交流与直流索引 (值相同时使用)。</summary>
        internal static void Set(string sub, string setting, string decimalValue)
        {
            try
            {
                string scheme = ActiveScheme();
                if (string.IsNullOrEmpty(scheme)) { Log.Write("powercfg set skipped: no active scheme"); return; }
                RunCapture("powercfg.exe /setacvalueindex " + scheme + " " + sub + " " + setting + " " + decimalValue);
                RunCapture("powercfg.exe /setdcvalueindex " + scheme + " " + sub + " " + setting + " " + decimalValue);
                RunCapture("powercfg.exe /setactive " + scheme);
                Log.Write("powercfg set " + sub + "/" + setting + " = " + decimalValue);
            }
            catch (Exception ex) { Log.Write("powercfg set failed: " + ex.Message); }
        }

        internal static string RunCapture(string cmdline)
        {
            try
            {
                var psi = new System.Diagnostics.ProcessStartInfo("cmd.exe", "/c " + cmdline);
                psi.UseShellExecute = false;
                psi.CreateNoWindow = true;
                psi.RedirectStandardOutput = true;
                psi.RedirectStandardError = true;
                using (var p = System.Diagnostics.Process.Start(psi))
                {
                    string raw = p.StandardOutput.ReadToEnd();
                    p.StandardError.ReadToEnd();
                    p.WaitForExit(15000);
                    return DecodePowerCfg(raw);
                }
            }
            catch (Exception ex) { Log.Write("run failed [" + cmdline + "]: " + ex.Message); return ""; }
        }

        /// <summary>
        /// powercfg 输出编码随区域设置而变 (中文版常见 GBK/CP936, 部分环境为 UTF-8)。
        /// 这里按字节尝试 UTF-8 与 GBK 严格解码, 取没有替换字符的那一种。
        /// </summary>
        private static string DecodePowerCfg(string raw)
        {
            if (string.IsNullOrEmpty(raw)) return raw ?? "";
            byte[] bytes;
            try { bytes = Encoding.GetEncoding(1252).GetBytes(raw); }
            catch { return raw; }

            string utf8 = null, gbk = null;
            try { utf8 = new UTF8Encoding(false, true).GetString(bytes); }
            catch { }
            try { gbk = Encoding.GetEncoding(936).GetString(bytes); }
            catch { }

            if (utf8 != null && utf8.IndexOf('\uFFFD') < 0) return utf8;
            if (gbk != null && gbk.IndexOf('\uFFFD') < 0) return gbk;
            if (utf8 != null) return utf8;
            if (gbk != null) return gbk;
            return raw;
        }

        internal static void Run(string cmdline) { RunCapture(cmdline); }

        /// <summary>保存并禁用自动睡眠/休眠，保证黑屏期间电脑仍在正常工作</summary>
        internal static void DisableSleep(State st)
        {
            st.SavedScheme = ActiveScheme();
            st.SavedStandbyAc = Query(SubSleep, StandbyIdle, true);
            st.SavedStandbyDc = Query(SubSleep, StandbyIdle, false);
            st.SavedHibernateAc = Query(SubSleep, HibernateIdle, true);
            st.SavedHibernateDc = Query(SubSleep, HibernateIdle, false);
            st.SavedPowerCfg = true;
            st.Save();
            // 0 = 永不
            Set(SubSleep, StandbyIdle, "0");
            Set(SubSleep, HibernateIdle, "0");
            Log.Write("sleep/hibernate disabled (standbyAc was " + st.SavedStandbyAc +
                      ", standbyDc was " + st.SavedStandbyDc + ")");
        }

        internal static void RestoreSleep(State st)
        {
            if (!st.SavedPowerCfg) { Log.Write("no saved power cfg, skip restore"); return; }
            // AC 与 DC 是独立索引, 必须分别还原, 否则后写的会覆盖先写的
            if (!string.IsNullOrEmpty(st.SavedStandbyAc))
                SetAc(SubSleep, StandbyIdle, HexToDec(st.SavedStandbyAc));
            if (!string.IsNullOrEmpty(st.SavedStandbyDc))
                SetDc(SubSleep, StandbyIdle, HexToDec(st.SavedStandbyDc));
            if (!string.IsNullOrEmpty(st.SavedHibernateAc))
                SetAc(SubSleep, HibernateIdle, HexToDec(st.SavedHibernateAc));
            if (!string.IsNullOrEmpty(st.SavedHibernateDc))
                SetDc(SubSleep, HibernateIdle, HexToDec(st.SavedHibernateDc));
            st.SavedPowerCfg = false;
            st.Save();
            Log.Write("sleep/hibernate restored");
        }

        internal static string HexToDec(string hex)
        {
            try
            {
                string h = hex.StartsWith("0x", StringComparison.OrdinalIgnoreCase) ? hex.Substring(2) : hex;
                if (h.Length == 0) return "0";
                long v = Convert.ToInt64(h, 16);
                return v.ToString(CultureInfo.InvariantCulture);
            }
            catch { return "0"; }
        }
    }

    internal static class Mon
    {
        internal static List<IntPtr> EnumerateHMonitors()
        {
            var list = new List<IntPtr>();
            try
            {
                N.EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero,
                    delegate (IntPtr h, IntPtr hdc, IntPtr rect, IntPtr d) { list.Add(h); return true; },
                    IntPtr.Zero);
            }
            catch { }
            return list;
        }

        internal static int DdcSet(IntPtr hPhysical, byte code, uint value)
        {
            try { return N.SetVCPFeature(hPhysical, code, value) ? 0 : Marshal.GetLastWin32Error(); }
            catch { return -1; }
        }

        internal static uint? DdcGet(IntPtr hPhysical, byte code)
        {
            try
            {
                uint type, cur, max;
                if (N.GetVCPFeatureAndVCPFeatureReply(hPhysical, code, out type, out cur, out max)) return cur;
            }
            catch { }
            return null;
        }

        /// <summary>
        /// 取得某个 HMONITOR 下真实存在的物理显示器。
        /// 注意: GetPhysicalMonitorsFromHMONITOR 必须传入实际数量, 否则返回 ERROR_MORE_DATA。
        /// </summary>
        private static List<N.PHYSICAL_MONITOR> GetPhysicals(IntPtr hMonitor)
        {
            var result = new List<N.PHYSICAL_MONITOR>();
            try
            {
                uint count = 0;
                if (!N.GetNumberOfPhysicalMonitorsFromHMONITOR(hMonitor, out count)) return result;
                if (count == 0) return result;
                var arr = new N.PHYSICAL_MONITOR[count];
                if (!N.GetPhysicalMonitorsFromHMONITOR(hMonitor, count, arr)) return result;
                for (int i = 0; i < arr.Length; i++)
                    if (arr[i].bPhysicalMonitorExists) result.Add(arr[i]);
            }
            catch (Exception ex) { Log.Write("GetPhysicals error: " + ex.Message); }
            return result;
        }

        /// <summary>通过 DDC/CI 控制物理显示器: brightness=0 熄灭背光, power=4 进入待机</summary>
        internal static int DdcOff()
        {
            int affected = 0;
            foreach (var h in EnumerateHMonitors())
            {
                var phys = GetPhysicals(h);
                if (phys.Count == 0) continue;
                foreach (var p in phys)
                {
                    string desc = p.szPhysicalMonitorDescription ?? "";
                    int e1 = DdcSet(p.hPhysicalMonitor, 0x10, 0);   // 亮度 = 0
                    int e2 = DdcSet(p.hPhysicalMonitor, 0xD6, 4);   // 电源 = Off/Standby
                    if (e1 == 0 || e2 == 0) affected++;
                    Log.Write("DDC off monitor '" + desc + "' brightnessErr=" + e1 + " powerErr=" + e2);
                }
            }
            return affected;
        }

        internal static int DdcOn()
        {
            int affected = 0;
            foreach (var h in EnumerateHMonitors())
            {
                var phys = GetPhysicals(h);
                if (phys.Count == 0) continue;
                foreach (var p in phys)
                {
                    string desc = p.szPhysicalMonitorDescription ?? "";
                    uint? maxBright = DdcGet(p.hPhysicalMonitor, 0x10);
                    uint target = 100;
                    if (maxBright.HasValue && maxBright.Value > 0 && maxBright.Value <= 100) target = maxBright.Value;
                    int e1 = DdcSet(p.hPhysicalMonitor, 0x10, target);
                    int e2 = DdcSet(p.hPhysicalMonitor, 0xD6, 1);   // 电源 = On
                    if (e1 == 0 || e2 == 0) affected++;
                    Log.Write("DDC on monitor '" + desc + "' brightnessErr=" + e1 + " powerErr=" + e2);
                }
            }
            return affected;
        }

        internal static int? GetInternalBrightness()
        {
            try
            {
                using (var search = new ManagementObjectSearcher("root\\WMI", "SELECT CurrentBrightness FROM WmiMonitorBrightness"))
                using (var results = search.Get())
                {
                    foreach (ManagementObject mo in results)
                        return Convert.ToInt32(mo["CurrentBrightness"], CultureInfo.InvariantCulture);
                }
            }
            catch { }
            return null;
        }

        /// <summary>设置内置面板亮度。失败不抛异常（部分驱动不支持 WMI 写亮度）。</summary>
        internal static bool SetInternalBrightness(int level)
        {
            try
            {
                bool any = false;
                using (var search = new ManagementObjectSearcher("root\\WMI", "SELECT CurrentBrightness FROM WmiMonitorBrightness"))
                using (var results = search.Get())
                {
                    foreach (ManagementObject mo in results)
                    {
                        mo.Get();
                        mo.Properties["CurrentBrightness"].Value = level;
                        mo.Put();
                        any = true;
                    }
                }
                if (!any) Log.Write("WMI brightness: no WmiMonitorBrightness instance");
                else Log.Write("WMI brightness set to " + level);
                return any;
            }
            catch (Exception ex)
            {
                Log.Write("WMI brightness set failed (ignored): " + ex.Message);
                return false;
            }
        }

        internal static bool ScScreenOff()
        {
            try
            {
                IntPtr res;
                N.SendMessageTimeout((IntPtr)N.HWND_BROADCAST, N.WM_SYSCOMMAND, (IntPtr)N.SC_OFF, IntPtr.Zero, 2, 2000, out res);
                Log.Write("WM_SYSCOMMAND SCREEN_OFF sent (result=" + res + ")");
                return res != IntPtr.Zero;
            }
            catch (Exception ex) { Log.Write("SCREEN_OFF failed: " + ex.Message); return false; }
        }

        internal static bool ScScreenOn()
        {
            try
            {
                IntPtr res;
                N.SendMessageTimeout((IntPtr)N.HWND_BROADCAST, N.WM_SYSCOMMAND, (IntPtr)N.SC_ON, IntPtr.Zero, 2, 2000, out res);
                Log.Write("WM_SYSCOMMAND SCREEN_ON sent (result=" + res + ")");
                return res != IntPtr.Zero;
            }
            catch (Exception ex) { Log.Write("SCREEN_ON failed: " + ex.Message); return false; }
        }

        /// <summary>
        /// 强制点亮显示器 —— 黑屏后唤醒的主路径。
        /// 依次尝试多种方式, 因为不同面板/驱动支持程度不同:
        ///   1) SC_MONITORPOWER/ON 广播 (Windows 官方方式, 对内屏最有效)
        ///   2) ES_DISPLAY_REQUIRED 请求显示保持
        ///   3) DDC/CI VCP 0xD6=1 (电源 ON)
        ///   4) 亮度恢复 (WMI)
        ///   5) 鼠标轻微抖动 + 键盘轻触 (模拟输入, 促使驱动重新点亮)
        /// </summary>
        internal static void ForceScreenOn(int savedBrightness)
        {
            try { N.SetThreadExecutionState(N.ES_CONTINUOUS | N.ES_DISPLAY_REQUIRED | N.ES_SYSTEM_REQUIRED); } catch { }
            try
            {
                IntPtr r1;
                N.SendMessageTimeout((IntPtr)N.HWND_BROADCAST, N.WM_SYSCOMMAND, (IntPtr)N.SC_ON, IntPtr.Zero, 2, 3000, out r1);
                Log.Write("wake: SCREEN_ON broadcast (result=" + r1 + ")");
            }
            catch { }
            try { DdcOn(); } catch { }
            int target = savedBrightness > 0 ? savedBrightness : 100;
            try { SetInternalBrightness(target); } catch { }
            for (int i = 0; i < 3; i++)
            {
                try { Jiggle(); } catch { }
                Thread.Sleep(250);
            }
            // 模拟一次真实按键 (Shift 轻触): 部分面板在收到键盘输入后才会重新点亮
            try { SendShiftTap(); } catch { }
            // 再发一次 SCREEN_ON: 某些驱动在第一次广播后才进入可唤醒状态
            try
            {
                IntPtr r2;
                N.SendMessageTimeout((IntPtr)N.HWND_BROADCAST, N.WM_SYSCOMMAND, (IntPtr)N.SC_ON, IntPtr.Zero, 2, 3000, out r2);
                Log.Write("wake: SCREEN_ON broadcast #2 (result=" + r2 + ")");
            }
            catch { }
            try { DdcOn(); } catch { }
            try { SetInternalBrightness(target); } catch { }
        }

        internal static void Jiggle()
        {
            try
            {
                N.POINT p;
                if (N.GetCursorPos(out p))
                {
                    N.SetCursorPos(p.X + 1, p.Y);
                    Thread.Sleep(60);
                    N.SetCursorPos(p.X, p.Y);
                }
                N.mouse_event(N.MOUSEEVENTF_MOVE, 1, 0, 0, IntPtr.Zero);
            }
            catch { }
        }

        /// <summary>模拟一次 Shift 轻触 (按下+松开)。用于促使驱动重新点亮面板。</summary>
        internal static void SendShiftTap()
        {
            try
            {
                N.SendInput(1, new N.INPUT[] { N.MakeKeyInput(N.VK_SHIFT, false) }, N.SIZE_INPUT);
                Thread.Sleep(60);
                N.SendInput(1, new N.INPUT[] { N.MakeKeyInput(N.VK_SHIFT, true) }, N.SIZE_INPUT);
                Log.Write("wake: sent shift tap");
            }
            catch (Exception ex) { Log.Write("shift tap failed: " + ex.Message); }
        }
    }

    /// <summary>全屏黑色覆盖层: 显示器未被真正断电时的视觉兜底 (点击穿透、不抢焦点)</summary>
    internal sealed class BlackOverlay : Form
    {
        internal BlackOverlay()
        {
            FormBorderStyle = FormBorderStyle.None;
            ShowInTaskbar = false;
            TopMost = true;
            StartPosition = FormStartPosition.Manual;
            BackColor = Color.Black;
            SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer, true);
        }

        protected override bool ShowWithoutActivation { get { return true; } }

        protected override CreateParams CreateParams
        {
            get
            {
                var cp = base.CreateParams;
                cp.ExStyle |= 0x08000000 /* WS_EX_NOACTIVATE */ | 0x00000020 /* WS_EX_TRANSPARENT */;
                return cp;
            }
        }

        protected override void OnShown(EventArgs e)
        {
            base.OnShown(e);
            CoverAll();
        }

        internal void CoverAll()
        {
            try
            {
                var vs = SystemInformation.VirtualScreen;
                SetBounds(vs.Left, vs.Top, vs.Width, vs.Height);
                TopMost = true;
            }
            catch { }
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            using (var b = new SolidBrush(Color.Black))
                e.Graphics.FillRectangle(b, ClientRectangle);
        }
    }

    /// <summary>隐藏的消息载体窗: 注册全局热键用 (不显示、不抢焦点)</summary>
    internal sealed class HotkeyWindow : Form
    {
        internal HotkeyWindow()
        {
            FormBorderStyle = FormBorderStyle.None;
            ShowInTaskbar = false;
            Opacity = 0;
            StartPosition = FormStartPosition.Manual;
            Location = new Point(-32000, -32000);
            Size = new Size(1, 1);
        }

        protected override bool ShowWithoutActivation { get { return true; } }

        protected override CreateParams CreateParams
        {
            get
            {
                var cp = base.CreateParams;
                cp.ExStyle |= 0x08000000 /* WS_EX_NOACTIVATE */ | 0x00000020 /* WS_EX_TRANSPARENT */;
                return cp;
            }
        }
    }

    /// <summary>
    /// 全局低级键盘/鼠标钩子: 检测"任意按键或鼠标动作"。
    ///
    /// 为什么需要它:
    ///   SC_MONITORPOWER/OFF 会真正让内屏背光断电, 一旦断电, 键盘/鼠标事件
    ///   根本不会被系统转发给面板 —— 也就是说"按任意键"在硬件层面唤不醒它。
    ///   唯一的办法是: 先由本进程捕获按键事件, 再主动发出 SC_MONITORPOWER/ON
    ///   (或 DDC 电源指令) 把面板重新点亮。
    /// </summary>
    internal sealed class AnyKeyWatcher : IDisposable
    {
        private IntPtr _kbHook = IntPtr.Zero;
        private IntPtr _mouseHook = IntPtr.Zero;
        private readonly Action _onInput;
        private readonly N.HookProc _kbProc;
        private readonly N.HookProc _mouseProc;
        private int _armed;   // 1 = 钩子已就绪
        private DateTime _armedAt;  // 装钩子的时刻, 用于启动宽限期
        private int _graceMs;       // 宽限期时长: 这段时间内的输入一律忽略

        internal AnyKeyWatcher(Action onInput, int graceMs)
        {
            _onInput = onInput;
            _graceMs = graceMs < 0 ? 0 : graceMs;
            _kbProc = KeyboardCallback;
            _mouseProc = MouseCallback;
        }

        /// <summary>安装钩子。必须在有消息循环的线程上调用。</summary>
        internal void Install()
        {
            IntPtr mod = N.GetModuleHandle(null);
            _kbHook = N.SetWindowsHookEx(N.WH_KEYBOARD_LL, _kbProc, mod, 0);
            if (_kbHook == IntPtr.Zero)
                Log.Write("SetWindowsHookEx(KEYBOARD_LL) failed err=" + Marshal.GetLastWin32Error());
            _mouseHook = N.SetWindowsHookEx(N.WH_MOUSE_LL, _mouseProc, mod, 0);
            if (_mouseHook == IntPtr.Zero)
                Log.Write("SetWindowsHookEx(MOUSE_LL) failed err=" + Marshal.GetLastWin32Error());
            _armed = 1;
            _armedAt = DateTime.Now;
            Log.Write("any-key watcher installed (kb=" + (_kbHook != IntPtr.Zero) + ", mouse=" + (_mouseHook != IntPtr.Zero) + ", grace=" + _graceMs + "ms)");
        }

        /// <summary>是否还在启动宽限期内(此期间的输入是"发起黑屏的那一下", 不能当成唤醒)。</summary>
        private bool InGracePeriod()
        {
            if (_graceMs <= 0) return false;
            return (DateTime.Now - _armedAt).TotalMilliseconds < _graceMs;
        }

        public void Dispose()
        {
            try { if (_kbHook != IntPtr.Zero) N.UnhookWindowsHookEx(_kbHook); } catch { }
            try { if (_mouseHook != IntPtr.Zero) N.UnhookWindowsHookEx(_mouseHook); } catch { }
            _kbHook = IntPtr.Zero;
            _mouseHook = IntPtr.Zero;
            _armed = 0;
        }

        private IntPtr KeyboardCallback(int nCode, IntPtr wParam, IntPtr lParam)
        {
            try
            {
                if (nCode >= 0 && _armed != 0)
                {
                    int msg = (int)wParam;
                    // 只认"按下", 松开事件不重复触发
                    if (msg == N.WM_KEYDOWN || msg == N.WM_SYSKEYDOWN)
                    {
                        uint vk = 0;
                        try
                        {
                            var k = (N.KBDLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(N.KBDLLHOOKSTRUCT));
                            vk = k.vkCode;
                        }
                        catch { }
                        // 宽限期内忽略: 这是"发起黑屏"的那一下输入, 不是用户想唤醒
                        if (InGracePeriod())
                        {
                            Log.Write("key pressed (vk=0x" + vk.ToString("X2") + ") ignored (startup grace period)");
                            return N.CallNextHookEx(_kbHook, nCode, wParam, lParam);
                        }
                        Log.Write("key pressed (vk=0x" + vk.ToString("X2") + ") -> waking screen");
                        Fire();
                    }
                }
            }
            catch { }
            return N.CallNextHookEx(_kbHook, nCode, wParam, lParam);
        }

        private IntPtr MouseCallback(int nCode, IntPtr wParam, IntPtr lParam)
        {
            try
            {
                if (nCode >= 0 && _armed != 0)
                {
                    int msg = (int)wParam;
                    if (msg == N.WM_LBUTTONDOWN || msg == N.WM_RBUTTONDOWN || msg == N.WM_MBUTTONDOWN)
                    {
                        // 宽限期内忽略: 这是"发起黑屏"的那一下点击, 不是用户想唤醒
                        if (InGracePeriod())
                        {
                            Log.Write("mouse clicked ignored (startup grace period)");
                            return N.CallNextHookEx(_mouseHook, nCode, wParam, lParam);
                        }
                        Log.Write("mouse clicked -> waking screen");
                        Fire();
                    }
                }
            }
            catch { }
            return N.CallNextHookEx(_mouseHook, nCode, wParam, lParam);
        }

        private void Fire()
        {
            // 断开钩子, 避免唤醒过程中的按键被反复捕获
            _armed = 0;
            try { _onInput(); } catch (Exception ex) { Log.Write("wake-on-input handler error: " + ex.Message); }
        }
    }

    internal static class Program
    {
        private const int HotkeyId = 0x5C1;

        [STAThread]
        internal static int Main(string[] args)
        {
            try
            {
                string cmd = args.Length > 0 ? args[0].ToLowerInvariant() : "help";
                switch (cmd)
                {
                    case "off": return CmdOff(args);
                    case "on": return CmdOn(args);
                    case "guard": return CmdGuard(args);
                    case "status": return CmdStatus(args);
                    case "sleep-guard": return CmdSleepGuard(args);
                    case "help":
                    case "--help":
                    case "-h":
                    case "/?": return CmdHelp();
                    default:
                        Log.Write("unknown command: " + cmd);
                        return CmdHelp();
                }
            }
            catch (Exception ex)
            {
                Log.Write("FATAL: " + ex);
                return 1;
            }
        }

        private static int CmdHelp()
        {
            string h =
                "ScreenPower.exe — 一键黑屏 / 定时亮屏\n\n" +
                "  off [--until HH:mm]   黑屏；--until 指定到点自动亮屏时间(如 07:00)\n" +
                "  on                   立即亮屏恢复\n" +
                "  guard                守护进程(自动拉起)\n" +
                "  sleep-guard          仅防休眠(不黑屏)\n" +
                "  status [--quiet]     查看状态\n\n" +
                "黑屏期间按 Ctrl+Alt+F12 立即亮屏。";
            Log.Write(h);
            try
            {
                MessageBox.Show(h, "ScreenPower", MessageBoxButtons.OK, MessageBoxIcon.Information);
            }
            catch { }
            return 0;
        }

        // ---------------- off ----------------
        private static int CmdOff(string[] args)
        {
            try { Directory.CreateDirectory(AppDir.Dir); } catch { }

            string until = null;
            for (int i = 1; i < args.Length; i++)
            {
                if (string.Equals(args[i], "--until", StringComparison.OrdinalIgnoreCase) && i + 1 < args.Length)
                {
                    until = args[i + 1];
                    i++;
                }
            }

            var st = new State();
            st.Mode = until == null ? "off" : "scheduled";
            st.Until = until ?? "";
            if (until != null)
            {
                DateTime parsed;
                if (DateTime.TryParseExact(until, "HH:mm", CultureInfo.InvariantCulture, DateTimeStyles.None, out parsed))
                {
                    DateTime t = DateTime.Today.Add(parsed.TimeOfDay);
                    if (t <= DateTime.Now) t = t.AddDays(1);
                    st.UntilTime = t;
                    st.HasUntil = true;
                }
                else
                {
                    Log.Write("bad --until value: " + until);
                    return 2;
                }
            }

            // 保存当前亮度, 便于恢复
            int? b = Mon.GetInternalBrightness();
            if (b.HasValue) st.SavedInternalBrightness = b.Value;

            // 解除旧的唤醒标记
            try { if (File.Exists(AppDir.WakeFlag)) File.Delete(AppDir.WakeFlag); } catch { }

            st.Save();
            Log.Write("=== OFF === mode=" + st.Mode + " until=" +
                      (st.HasUntil ? st.UntilTime.ToString("yyyy-MM-dd HH:mm") : "-"));

            // 1) 禁用自动睡眠/休眠, 保证电脑继续正常工作
            //    注意: DisableSleep 内部会保存原值并写盘, 必须先于启动 guard,
            //    否则 guard 可能在 off 写盘前就读取到旧状态 (saved 值为空 -> 无法还原)
            Power.DisableSleep(st);

            // 2) 熄灭屏幕 (DDC/CI -> WM_SYSCOMMAND -> 内置面板亮度)
            int ddc = Mon.DdcOff();
            Mon.ScScreenOff();
            Thread.Sleep(200);
            Mon.SetInternalBrightness(0);

            // 3) 再写一次状态, 确保磁盘上的内容是最终态
            st.Save();

            // 4) 拉起守护进程 (通过计划任务, 保证运行在交互式会话中)
            StartGuard();

            // 5) 等待守护进程接管, 确保"任意按键可亮屏"的钩子已经就位,
            //    否则用户在极短时间内按键会落空 (面板已断电, 无人能唤醒它)
            WaitForGuardReady(6000);

            Log.Write("=== OFF done (ddc monitors=" + ddc + ") ===");
            return 0;
        }

        /// <summary>等待守护进程写好 pid 文件, 确认钩子/覆盖层已经就位。</summary>
        private static void WaitForGuardReady(int timeoutMs)
        {
            try
            {
                DateTime deadline = DateTime.Now.AddMilliseconds(timeoutMs);
                while (DateTime.Now < deadline)
                {
                    if (File.Exists(AppDir.PidFile)) { Log.Write("guard ready"); return; }
                    Thread.Sleep(200);
                }
                Log.Write("guard ready: timeout after " + timeoutMs + "ms (continue anyway)");
            }
            catch (Exception ex) { Log.Write("WaitForGuardReady error: " + ex.Message); }
        }

        private static void StartGuard()
        {
            try
            {
                var psi = new System.Diagnostics.ProcessStartInfo("schtasks.exe", "/run /tn \"ScreenPower-Guard\"");
                psi.UseShellExecute = false;
                psi.CreateNoWindow = true;
                psi.RedirectStandardOutput = true;
                psi.RedirectStandardError = true;
                using (var p = System.Diagnostics.Process.Start(psi))
                {
                    string o = p.StandardOutput.ReadToEnd();
                    string e = p.StandardError.ReadToEnd();
                    p.WaitForExit(10000);
                    Log.Write("guard task launch: " + ((o ?? "") + (e ?? "")).Trim());
                }
            }
            catch (Exception ex)
            {
                Log.Write("guard task launch failed: " + ex.Message + " -> fallback: direct start");
                try
                {
                    string exe = System.Reflection.Assembly.GetExecutingAssembly().Location;
                    var psi = new System.Diagnostics.ProcessStartInfo(exe, "guard");
                    psi.UseShellExecute = true;
                    psi.WindowStyle = System.Diagnostics.ProcessWindowStyle.Hidden;
                    System.Diagnostics.Process.Start(psi);
                }
                catch (Exception ex2) { Log.Write("fallback guard start failed: " + ex2.Message); }
            }
        }

        // ---------------- on ----------------
        private static int CmdOn(string[] args)
        {
            Log.Write("=== ON ===");
            var st = State.Load();

            // 1) 通知并终止守护进程 (覆盖层随之消失)
            try { File.WriteAllText(AppDir.WakeFlag, DateTime.Now.ToString("O")); } catch { }
            KillGuard(4000);

            // 2) 点亮显示器
            RestoreScreen(st);

            // 3) 恢复休眠设置
            Power.RestoreSleep(st);

            // 4) 释放防休眠请求
            try { N.SetThreadExecutionState(N.ES_CONTINUOUS); } catch { }

            try { if (File.Exists(AppDir.WakeFlag)) File.Delete(AppDir.WakeFlag); } catch { }
            st.Mode = "manual";
            st.HasUntil = false;
            st.Until = "";
            st.UntilTime = DateTime.MinValue;
            try { st.Save(); } catch { }
            Log.Write("=== ON done ===");
            return 0;
        }

        /// <summary>点亮屏幕并恢复亮度。可被 on / guard 复用。</summary>
        internal static void RestoreScreen(State st)
        {
            try { N.SetThreadExecutionState(N.ES_CONTINUOUS | N.ES_DISPLAY_REQUIRED | N.ES_SYSTEM_REQUIRED); }
            catch { }

            Mon.ForceScreenOn(st.SavedInternalBrightness);
            try { N.SetThreadExecutionState(N.ES_CONTINUOUS); } catch { }
        }

        private static void KillGuard(int waitMs)
        {
            int pid = 0;
            try
            {
                if (File.Exists(AppDir.PidFile))
                {
                    int.TryParse(File.ReadAllText(AppDir.PidFile).Trim(), out pid);
                }
            }
            catch { }
            if (pid <= 0) return;
            var deadline = DateTime.Now.AddMilliseconds(waitMs);
            while (DateTime.Now < deadline)
            {
                try
                {
                    var p = System.Diagnostics.Process.GetProcessById(pid);
                    if (p.HasExited) break;
                }
                catch { break; }
                Thread.Sleep(200);
            }
            try
            {
                var p = System.Diagnostics.Process.GetProcessById(pid);
                if (!p.HasExited) { p.Kill(); Log.Write("guard process killed pid=" + pid); }
            }
            catch { }
            try { if (File.Exists(AppDir.PidFile)) File.Delete(AppDir.PidFile); } catch { }
        }

        // ---------------- guard ----------------
        private static int CmdGuard(string[] args)
        {
            Log.Write("=== GUARD started pid=" + System.Diagnostics.Process.GetCurrentProcess().Id + " ===");

            var st = State.Load();
            Log.Write("guard state: mode=" + st.Mode + " until=" + st.Until + " hasUntil=" + st.HasUntil);

            // 宽限期: 守护进程是被"发起黑屏的那一下点击"拉起来的,
            // 这段时间内的键盘/鼠标输入必须忽略, 否则用户永远看不到黑屏。
            int graceMs = ParseGrace(args);

            // 先构造上下文(安装钩子/覆盖层), 再写 pid 文件 ——
            // 这样 off 命令看到 pid 文件时, 钩子必然已经就位, 不会出现"按了键没反应"的窗口
            var ctx = new GuardContext(st, false, graceMs);

            // 主线程: 消息循环 + 覆盖层 + 全局热键
            Application.Run(ctx);

            // 释放防休眠
            try { N.SetThreadExecutionState(N.ES_CONTINUOUS); } catch { }
            try { if (File.Exists(AppDir.PidFile)) File.Delete(AppDir.PidFile); } catch { }
            Log.Write("=== GUARD exited ===");
            return 0;
        }

        /// <summary>解析 --grace &lt;毫秒&gt; 参数, 缺省 3000ms。</summary>
        private static int ParseGrace(string[] args)
        {
            for (int i = 1; i < args.Length - 1; i++)
            {
                if (string.Equals(args[i], "--grace", StringComparison.OrdinalIgnoreCase))
                {
                    int ms;
                    if (int.TryParse(args[i + 1], out ms) && ms >= 0 && ms <= 60000) return ms;
                    Log.Write("bad --grace value: " + args[i + 1]);
                    return 3000;
                }
            }
            return 3000;
        }

        // ---------------- sleep-guard ----------------
        private static int CmdSleepGuard(string[] args)
        {
            Log.Write("=== SLEEP-GUARD started pid=" + System.Diagnostics.Process.GetCurrentProcess().Id + " ===");
            var ctx = new GuardContext(State.Load(), true);
            Application.Run(ctx);
            try { N.SetThreadExecutionState(N.ES_CONTINUOUS); } catch { }
            try { if (File.Exists(AppDir.PidFile)) File.Delete(AppDir.PidFile); } catch { }
            return 0;
        }

        // ---------------- status ----------------
        private static int CmdStatus(string[] args)
        {
            bool quiet = false;
            for (int i = 1; i < args.Length; i++)
                if (string.Equals(args[i], "--quiet", StringComparison.OrdinalIgnoreCase))
                    quiet = true;

            var st = State.Load();
            int pid = 0;
            bool guardRunning = false;
            try
            {
                if (File.Exists(AppDir.PidFile))
                {
                    int.TryParse(File.ReadAllText(AppDir.PidFile).Trim(), out pid);
                    if (pid > 0)
                    {
                        var p = System.Diagnostics.Process.GetProcessById(pid);
                        guardRunning = !p.HasExited;
                    }
                }
            }
            catch { }

            var sb = new StringBuilder();
            sb.AppendLine("ScreenPower 状态");
            sb.AppendLine("  模式      : " + st.Mode);
            sb.AppendLine("  自动亮屏  : " + (st.HasUntil ? st.UntilTime.ToString("yyyy-MM-dd HH:mm") : "未设置 (手动恢复)"));
            sb.AppendLine("  守护进程  : " + (guardRunning ? "运行中 (pid=" + pid + ")" : "未运行"));
            sb.AppendLine("  唤醒标记  : " + (File.Exists(AppDir.WakeFlag) ? "存在" : "无"));
            sb.AppendLine("  电源方案  : " + (Power.ActiveScheme()));
            sb.AppendLine("  睡眠(AC)  : " + (Power.Query(Power.SubSleep, Power.StandbyIdle, true) + "  (0 = 永不)"));
            sb.AppendLine("  睡眠(DC)  : " + (Power.Query(Power.SubSleep, Power.StandbyIdle, false) + "  (0 = 永不)"));
            sb.AppendLine("  状态文件  : " + AppDir.StateFile);
            sb.AppendLine("  日志文件  : " + Log.File);
            Log.Write("STATUS:\n" + sb.ToString());

            if (!quiet)
            {
                try { MessageBox.Show(sb.ToString(), "ScreenPower", MessageBoxButtons.OK, MessageBoxIcon.Information); }
                catch { }
            }
            return 0;
        }
    }

    /// <summary>守护上下文: 承载覆盖层窗口 + 热键 + 消息循环</summary>
    internal sealed class GuardContext : ApplicationContext
    {
        internal const int HotkeyId = 0x5C1;
        internal const uint MOD_CONTROL = 0x0001;
        internal const uint MOD_ALT = 0x0002;
        internal const uint MOD_NOREPEAT = 0x4000;
        internal const uint VK_F12 = 0x7B;

        private readonly BlackOverlay _overlay;
        private readonly HotkeyWindow _hotkeyWin;
        private readonly System.Windows.Forms.Timer _timer;
        private readonly System.Windows.Forms.Timer _topTimer;
        private readonly State _state;
        private readonly bool _noOverlay;
        private bool _screenOffActive = false;
        private AnyKeyWatcher _keyWatcher;
        private int _graceMs = 3000;

        internal GuardContext(State state) : this(state, false) { }

        internal GuardContext(State state, bool noOverlay) : this(state, noOverlay, 3000) { }

        internal GuardContext(State state, bool noOverlay, int graceMs)
        {
            _state = state;
            _noOverlay = noOverlay;
            _graceMs = graceMs < 0 ? 0 : graceMs;

            if (!noOverlay)
            {
                _overlay = new BlackOverlay();
                _hotkeyWin = null;
                // 注意: 覆盖层在这里**不 Show**。
                // 原因: 守护进程是被"发起黑屏的那一下点击"启动的, 如果立刻显示黑色覆盖层,
                // 用户的鼠标还压在那颗按钮上, 就会看到界面闪一下黑, 然后马上又被"唤醒"逻辑关掉。
                // 真正的黑屏由 OnTick 在宽限期结束后统一开启。
            }
            else
            {
                _overlay = null;
                _hotkeyWin = new HotkeyWindow();
                _hotkeyWin.Show();
            }

            // 热键: Ctrl+Alt+F12 立即唤醒
            try
            {
                IntPtr hwnd = _overlay != null ? _overlay.Handle : _hotkeyWin.Handle;
                if (!N.RegisterHotKey(hwnd, HotkeyId, MOD_CONTROL | MOD_ALT | MOD_NOREPEAT, VK_F12))
                    Log.Write("RegisterHotKey Ctrl+Alt+F12 failed");
                else
                    Log.Write("hotkey Ctrl+Alt+F12 registered");
            }
            catch (Exception ex) { Log.Write("hotkey error: " + ex.Message); }

            _timer = new System.Windows.Forms.Timer();
            _timer.Interval = 2000;
            _timer.Tick += OnTick;
            _timer.Start();

            _topTimer = new System.Windows.Forms.Timer();
            _topTimer.Interval = 3000;
            _topTimer.Tick += delegate { try { if (_overlay != null && _screenOffActive) _overlay.CoverAll(); } catch { } };
            _topTimer.Start();

            // 任意按键/鼠标点击 -> 立即亮屏
            // 面板断电后键盘事件不会被系统转发, 必须靠低级钩子捕获后主动发 SCREEN_ON
            if (!noOverlay)
            {
                try
                {
                    // 宽限期 = 发起黑屏的那一下输入的时间窗, 这段时间内的输入不算"唤醒"
                    _keyWatcher = new AnyKeyWatcher(delegate { WakeOnInput(); }, _graceMs);
                    _keyWatcher.Install();
                }
                catch (Exception ex) { Log.Write("any-key watcher install failed: " + ex.Message); }
            }

            // 最后写 pid 文件: 此刻钩子与覆盖层都已就位,
            // off 命令一旦看到它, 就说明"任意键可亮屏"已经生效
            try { File.WriteAllText(AppDir.PidFile, System.Diagnostics.Process.GetCurrentProcess().Id.ToString()); }
            catch { }
        }

        /// <summary>收到任意按键/鼠标点击: 点亮屏幕并退出守护模式(恢复亮度与电源设置)。</summary>
        private void WakeOnInput()
        {
            try
            {
                Log.Write("wake-on-input: turning screen back on");
                RestoreAndExit();
            }
            catch (Exception ex) { Log.Write("wake-on-input error: " + ex.Message); }
        }

        private void OnTick(object sender, EventArgs e)
        {
            try
            {
                // 1) 防止系统进入睡眠/待机
                try { N.SetThreadExecutionState(N.ES_CONTINUOUS | N.ES_SYSTEM_REQUIRED); } catch { }

                // 2) 唤醒标记 -> 退出
                if (File.Exists(AppDir.WakeFlag))
                {
                    Log.Write("wake flag detected -> restoring screen");
                    RestoreAndExit();
                    return;
                }

                // 3) 到点自动亮屏
                if (_state.HasUntil && _state.UntilTime != DateTime.MinValue && DateTime.Now >= _state.UntilTime)
                {
                    Log.Write("reached scheduled time " + _state.Until + " -> restoring screen");
                    RestoreAndExit();
                    return;
                }

                // 4) 真正进入黑屏
                //    本机实测: DDC/CI 写(err=31)、WMI 写亮度(状态无效)、WM_SYSCOMMAND 广播(result=0)
                //    三条硬件路径全部失效 —— 面板根本不会真的断电。
                //    所以视觉上的黑屏必须由全屏黑色覆盖层承担, 覆盖层持续存在直到被唤醒。
                if (!_noOverlay && !_screenOffActive && IsBlackoutActive())
                {
                    Log.Write("entering blackout: showing fullscreen overlay");
                    try
                    {
                        if (_overlay != null)
                        {
                            if (!_overlay.Visible) _overlay.Show();
                            _overlay.CoverAll();
                        }
                    }
                    catch (Exception ex) { Log.Write("overlay show failed: " + ex.Message); }
                    _screenOffActive = true;

                    // 硬件路径照样尝试一次(某些机器上 DDC 是有效的)
                    Mon.ScScreenOff();
                    Mon.SetInternalBrightness(0);
                    Mon.DdcOff();
                }
                // 5) 黑屏期间维持状态: 覆盖层可能被其它窗口顶掉, 定期压回最前
                else if (!_noOverlay && _screenOffActive)
                {
                    try { if (_overlay != null) _overlay.CoverAll(); } catch { }
                }
            }
            catch (Exception ex) { Log.Write("guard tick error: " + ex.Message); }
        }

        /// <summary>
        /// 当前是否处于"黑屏模式"。
        /// 判定依据: 状态文件中的 Mode 为 scheduled/manual-off, 或者 State.Mode 为 off。
        /// 只有真正进入了黑屏模式, 守护进程才允许再次关闭屏幕。
        /// </summary>
        private bool IsBlackoutActive()
        {
            if (_screenOffActive) return true;
            try
            {
                var cur = State.Load();
                string mode = (cur.Mode ?? "").Trim().ToLowerInvariant();
                if (mode == "off" || mode == "scheduled" || mode == "manual-off" || mode == "manualoff")
                    return true;
                // 定时黑屏由 --until 触发, Mode=scheduled
                if (cur.HasUntil && cur.UntilTime != DateTime.MinValue && DateTime.Now < cur.UntilTime)
                    return true;
            }
            catch { }
            return false;
        }

        private void RestoreAndExit()
        {
            try { _timer.Stop(); _topTimer.Stop(); } catch { }
            try { if (_keyWatcher != null) _keyWatcher.Dispose(); } catch { }
            try
            {
                if (_overlay != null)
                {
                    _overlay.Hide();
                    _overlay.Close();
                }
            }
            catch { }

            var st = State.Load();
            Program.RestoreScreen(st);
            Power.RestoreSleep(st);
            try { N.SetThreadExecutionState(N.ES_CONTINUOUS); } catch { }
            try { if (File.Exists(AppDir.WakeFlag)) File.Delete(AppDir.WakeFlag); } catch { }
            st.Mode = "manual";
            st.HasUntil = false;
            st.Until = "";
            st.UntilTime = DateTime.MinValue;
            try { st.Save(); } catch { }
            Log.Write("screen restored, exiting guard");
            ExitThread();
        }
    }
}
