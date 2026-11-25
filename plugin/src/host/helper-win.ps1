# helper-win.ps1 -- Windows-side "watch the game + take a screenshot" helper.
# ASCII ONLY. Do not put non-ASCII text in this file: Windows PowerShell 5.1 reads
# a BOM-less .ps1 with the OEM code page, and non-ASCII bytes corrupt the script.
# Chinese window titles travel back as JSON data, never as source.
#
# Invoked by the host half with -File (never with -Command, which mangles comments):
#   powershell -NoProfile -NonInteractive -STA -File helper-win.ps1 -Mode detect [-Out <json>]
#   powershell -NoProfile -NonInteractive -STA -File helper-win.ps1 -Mode capture -Out <png> [-Hwnd 0]
#
# detect writes exactly one JSON object to -Out (UTF-8, no BOM) or, without -Out, to stdout
# as UTF-8. The file form is what the host half uses: it keeps Chinese window titles intact
# regardless of the console code page.
#   {"available":true,"hwnd":...,"pid":...,"process":"...","title":"...","class":"...",
#    "minimized":false,"fullscreen":true,"rect":{"x":0,"y":0,"w":1920,"h":1080}}
#   or {"available":false,"error":"..."}
# capture writes the PNG and prints nothing; a non-zero exit means failure.

param(
  [Parameter(Mandatory = $true)][ValidateSet('detect', 'capture')][string]$Mode,
  [string]$Out = '',
  [long]$Hwnd = 0,
  [string]$Monitor = 'all'
)

$ErrorActionPreference = 'Stop'
$utf8 = New-Object System.Text.UTF8Encoding($false)
try { [Console]::OutputEncoding = $utf8 } catch { }

$script:Source = @'
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Text;

public static class DshGamePetWin
{
    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    private static extern int GetWindowTextLength(IntPtr hWnd);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetClassName(IntPtr hWnd, StringBuilder text, int count);

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

    [DllImport("user32.dll")]
    private static extern bool IsIconic(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);

    [DllImport("user32.dll")]
    private static extern IntPtr MonitorFromWindow(IntPtr hWnd, uint flags);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern bool GetMonitorInfo(IntPtr monitor, ref MONITORINFO info);

    [DllImport("user32.dll")]
    private static extern bool EnumDisplayMonitors(IntPtr hdc, IntPtr clip, MonitorEnumProc callback, IntPtr data);

    private delegate bool MonitorEnumProc(IntPtr monitor, IntPtr hdc, ref RECT rect, IntPtr data);

    [DllImport("user32.dll")]
    private static extern IntPtr SetThreadDpiAwarenessContext(IntPtr dpiContext);

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

    [StructLayout(LayoutKind.Sequential)]
    public struct MONITORINFO
    {
        public int cbSize;
        public RECT rcMonitor;
        public RECT rcWork;
        public uint dwFlags;
    }

    private static readonly IntPtr PerMonitorV2 = new IntPtr(-4);
    private static readonly IntPtr PerMonitorV1 = new IntPtr(-3);

    private static IntPtr TrySetContext(IntPtr context)
    {
        try { return SetThreadDpiAwarenessContext(context); }
        catch (EntryPointNotFoundException) { return IntPtr.Zero; }
        catch (DllNotFoundException) { return IntPtr.Zero; }
    }

    private static IntPtr EnterPerMonitorContext()
    {
        IntPtr previous = TrySetContext(PerMonitorV2);
        if (previous == IntPtr.Zero) previous = TrySetContext(PerMonitorV1);
        if (previous == IntPtr.Zero)
        {
            throw new InvalidOperationException("could not enter a per-monitor DPI awareness context");
        }
        return previous;
    }

    private static void RestoreContext(IntPtr previous)
    {
        try { SetThreadDpiAwarenessContext(previous); } catch { }
    }

    public static string Foreground()
    {
        IntPtr previous = EnterPerMonitorContext();
        try
        {
            IntPtr hwnd = GetForegroundWindow();
            if (hwnd == IntPtr.Zero) return null;

            int length = GetWindowTextLength(hwnd);
            StringBuilder title = new StringBuilder(length + 2);
            GetWindowText(hwnd, title, title.Capacity);

            StringBuilder cls = new StringBuilder(256);
            GetClassName(hwnd, cls, cls.Capacity);

            uint pid = 0;
            GetWindowThreadProcessId(hwnd, out pid);

            RECT rect;
            bool hasRect = GetWindowRect(hwnd, out rect);

            bool fullscreen = false;
            IntPtr monitor = MonitorFromWindow(hwnd, 2);
            if (monitor != IntPtr.Zero)
            {
                MONITORINFO info = new MONITORINFO();
                info.cbSize = Marshal.SizeOf(typeof(MONITORINFO));
                if (GetMonitorInfo(monitor, ref info))
                {
                    fullscreen = hasRect
                        && rect.Left <= info.rcMonitor.Left && rect.Top <= info.rcMonitor.Top
                        && rect.Right >= info.rcMonitor.Right && rect.Bottom >= info.rcMonitor.Bottom;
                }
            }

            return string.Join("\t", new string[] {
                hwnd.ToInt64().ToString(),
                pid.ToString(),
                IsIconic(hwnd) ? "1" : "0",
                fullscreen ? "1" : "0",
                hasRect ? rect.Left.ToString() : "0",
                hasRect ? rect.Top.ToString() : "0",
                hasRect ? (rect.Right - rect.Left).ToString() : "0",
                hasRect ? (rect.Bottom - rect.Top).ToString() : "0",
                cls.ToString(),
                title.ToString()
            });
        }
        finally { RestoreContext(previous); }
    }

    private static List<MONITORINFO> AllMonitors()
    {
        List<MONITORINFO> list = new List<MONITORINFO>();
        EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, delegate (IntPtr hMonitor, IntPtr hdc, ref RECT rect, IntPtr data)
        {
            MONITORINFO info = new MONITORINFO();
            info.cbSize = Marshal.SizeOf(typeof(MONITORINFO));
            if (GetMonitorInfo(hMonitor, ref info)) list.Add(info);
            return true;
        }, IntPtr.Zero);
        return list;
    }

    // target: all | primary | secondary | 1-based index. Anything else falls back to the
    // whole virtual screen (old behaviour, keeps backwards compatibility).
    private static Rectangle MonitorBounds(string target)
    {
        string want = (target ?? "all").Trim().ToLowerInvariant();
        if (want == "all" || want.Length == 0)
        {
            return System.Windows.Forms.SystemInformation.VirtualScreen;
        }
        List<MONITORINFO> monitors = AllMonitors();
        MONITORINFO chosen = new MONITORINFO();
        bool found = false;
        if (want == "primary")
        {
            foreach (MONITORINFO m in monitors)
            {
                if ((m.dwFlags & 1) != 0) { chosen = m; found = true; break; }
            }
        }
        else if (want == "secondary")
        {
            foreach (MONITORINFO m in monitors)
            {
                if ((m.dwFlags & 1) == 0) { chosen = m; found = true; break; }
            }
        }
        else
        {
            int index = 0;
            if (int.TryParse(want, out index) && index >= 1 && index <= monitors.Count)
            {
                chosen = monitors[index - 1];
                found = true;
            }
        }
        if (!found)
        {
            return System.Windows.Forms.SystemInformation.VirtualScreen;
        }
        RECT r = chosen.rcMonitor;
        return Rectangle.FromLTRB(r.Left, r.Top, r.Right, r.Bottom);
    }

    public static void Capture(string outputPath, long hwndValue, string monitor)
    {
        IntPtr previous = EnterPerMonitorContext();
        try
        {
            Rectangle bounds;
            if (hwndValue != 0)
            {
                RECT rect;
                if (!GetWindowRect(new IntPtr(hwndValue), out rect))
                {
                    throw new InvalidOperationException("GetWindowRect failed for hwnd " + hwndValue);
                }
                bounds = Rectangle.FromLTRB(rect.Left, rect.Top, rect.Right, rect.Bottom);
            }
            else
            {
                bounds = MonitorBounds(monitor);
            }
            if (bounds.Width <= 0 || bounds.Height <= 0)
            {
                throw new InvalidOperationException("the capture region has no drawable area");
            }
            using (var bitmap = new Bitmap(bounds.Width, bounds.Height))
            using (var graphics = Graphics.FromImage(bitmap))
            {
                graphics.CopyFromScreen(bounds.X, bounds.Y, 0, 0, bounds.Size);
                bitmap.Save(outputPath, System.Drawing.Imaging.ImageFormat.Png);
            }
        }
        finally { RestoreContext(previous); }
    }
}
'@

Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type -TypeDefinition $script:Source -ReferencedAssemblies 'System.Windows.Forms.dll', 'System.Drawing.dll' -ErrorAction Stop

if ($Mode -eq 'capture') {
  if (-not $Out) { throw 'capture requires -Out <png path>' }
  [DshGamePetWin]::Capture($Out, $Hwnd, $Monitor)
  exit 0
}

$line = [DshGamePetWin]::Foreground()
if (-not $line) {
  $payload = '{"available":false,"error":"no foreground window"}'
}
else {
  $parts = $line -split "\t"
  $procId = [int]$parts[1]
  $procName = ''
  try { $procName = (Get-Process -Id $procId -ErrorAction Stop).ProcessName } catch { $procName = '' }
  $obj = [ordered]@{
    available  = $true
    hwnd       = [int64]$parts[0]
    pid        = $procId
    process    = $procName
    minimized  = ($parts[2] -eq '1')
    fullscreen = ($parts[3] -eq '1')
    rect       = [ordered]@{ x = [int]$parts[4]; y = [int]$parts[5]; w = [int]$parts[6]; h = [int]$parts[7] }
    class      = $parts[8]
    title      = $parts[9]
  }
  $payload = $obj | ConvertTo-Json -Compress -Depth 4
}

if ($Out) {
  [System.IO.File]::WriteAllText($Out, $payload, $utf8)
  exit 0
}
Write-Output $payload
