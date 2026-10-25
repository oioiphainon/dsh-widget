#requires -Version 5.1
<#
    FatFishDesktop.ps1 - desktop mascot widget for the fat fish plugin.

    A frameless, per-pixel-transparent, always-on-top window that shows the
    progress of the most recently active DSH session. It reads a small JSON
    snapshot written by the DSH Host half (index.js) and keeps running after the
    DSH window (or the whole app) is closed, so the fish stays on the desktop.

    The script is ASCII-only on purpose: every visible string lives in
    strings.json next to this file, so Windows PowerShell 5.1 and PowerShell 7
    both parse it correctly regardless of code page.

    Dev flags:
      -SelfTest <dir>   render preview PNGs (collapsed/expanded, light/dark) then exit
      -ExitAfterMs <n>  quit after n milliseconds
      -StatePath        override the snapshot path
      -DataDir          override the config/pid directory
#>
param(
    [string]$StatePath = '',
    [string]$DataDir = '',
    [string]$AssetPath = '',
    [string]$TextPath = '',
    [string]$SelfTest = '',
    [int]$ExitAfterMs = 0,
    [int]$HideAfterMs = 0,
    [string]$AutostartTest = ''
)

$ErrorActionPreference = 'Stop'
$script:Running = $true

Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms

# --------------------------------------------------------------------- DPI ---
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class FatFishDpi {
    [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] public static extern uint GetDpiForSystem();
    [DllImport("user32.dll")] public static extern int GetSystemMetrics(int index);
    [DllImport("user32.dll")] public static extern IntPtr GetThreadDpiAwarenessContext();
    [DllImport("user32.dll")] public static extern int GetAwarenessFromDpiAwarenessContext(IntPtr ctx);
    public static bool Enable() {
        try { if (SetProcessDpiAwarenessContext(new IntPtr(-4))) return true; } catch { }
        try { if (SetProcessDPIAware()) return true; } catch { }
        return false;
    }
    public static string Describe() {
        return string.Format("awareness={0} metrics={1}x{2} dpi={3}", GetAwarenessFromDpiAwarenessContext(GetThreadDpiAwarenessContext()), GetSystemMetrics(0), GetSystemMetrics(1), GetDpiForSystem());
    }
}
'@
$script:DpiOk = [FatFishDpi]::Enable()
if ($env:FATFISH_DEBUG) { try { Add-Content -LiteralPath (Join-Path $env:TEMP 'fatfish-boot.log') -Value ('enable=' + $script:DpiOk + ' ' + [FatFishDpi]::Describe()) } catch { } }

$layeredSrc = @'
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Windows.Forms;

namespace FatFishDesktop {
  public class LayeredForm : Form {
    const int WS_EX_LAYERED = 0x80000;
    const int WS_EX_TOPMOST = 0x8;
    const int WS_EX_TOOLWINDOW = 0x80;
    protected override CreateParams CreateParams {
      get {
        CreateParams cp = base.CreateParams;
        cp.ExStyle |= WS_EX_LAYERED | WS_EX_TOPMOST | WS_EX_TOOLWINDOW;
        return cp;
      }
    }
    public LayeredForm() {
      FormBorderStyle = FormBorderStyle.None;
      ShowInTaskbar = false;
      StartPosition = FormStartPosition.Manual;
      TopMost = true;
      SetStyle(ControlStyles.Opaque, true);
      SetStyle(ControlStyles.UserPaint, true);
      SetStyle(ControlStyles.OptimizedDoubleBuffer, true);
      SetStyle(ControlStyles.AllPaintingInWmPaint, true);
      DoubleBuffered = true;
    }
    /// <summary>Content is supplied exclusively by UpdateLayeredWindow.</summary>
    protected override void OnPaintBackground(PaintEventArgs e) { }
    /// <summary>Content is supplied exclusively by UpdateLayeredWindow.</summary>
    protected override void OnPaint(PaintEventArgs e) { }
    /// <summary>Move in one atomic SetWindowPos call (Left+Top in one step).</summary>
    public void MoveTo(int x, int y) {
      SetWindowPos(Handle, HWND_TOPMOST, x, y, 0, 0, SWP_NOSIZE | SWP_NOACTIVATE | SWP_NOOWNERZORDER);
    }
    /// <summary>Move and resize in one atomic SetWindowPos call.</summary>
    public void MoveResize(int x, int y, int w, int h) {
      SetWindowPos(Handle, HWND_TOPMOST, x, y, w, h, SWP_NOACTIVATE | SWP_NOOWNERZORDER);
    }
    public void Render(Bitmap canvas) {
      if (canvas == null) return;
      IntPtr screenDc = GetDC(IntPtr.Zero);
      IntPtr memDc = CreateCompatibleDC(screenDc);
      IntPtr hBitmap = IntPtr.Zero;
      IntPtr oldBitmap = IntPtr.Zero;
      try {
        IntPtr bits;
        hBitmap = CreateDib(memDc, canvas.Width, canvas.Height, out bits);
        oldBitmap = SelectObject(memDc, hBitmap);
        BitmapData data = canvas.LockBits(new Rectangle(0, 0, canvas.Width, canvas.Height), ImageLockMode.ReadOnly, PixelFormat.Format32bppPArgb);
        try {
          CopyMemory(bits, data.Scan0, (UIntPtr)(canvas.Width * canvas.Height * 4));
        } finally {
          canvas.UnlockBits(data);
        }
        SIZE size = new SIZE();
        size.cx = canvas.Width;
        size.cy = canvas.Height;
        POINT src = new POINT();
        src.x = 0;
        src.y = 0;
        BLENDFUNCTION blend = new BLENDFUNCTION();
        blend.BlendOp = 0;
        blend.BlendFlags = 0;
        blend.SourceConstantAlpha = 255;
        blend.AlphaFormat = 1;
        // pptDst = IntPtr.Zero keeps the current position: dragging owns the
        // window position (MoveTo), rendering only replaces the pixels. Doing
        // both here made the two move paths race and the fish flicker.
        UpdateLayeredWindowContent(Handle, screenDc, IntPtr.Zero, ref size, memDc, ref src, 0, ref blend, 2);
      } finally {
        if (hBitmap != IntPtr.Zero) {
          SelectObject(memDc, oldBitmap);
          DeleteObject(hBitmap);
        }
        DeleteDC(memDc);
        ReleaseDC(IntPtr.Zero, screenDc);
      }
    }
    static IntPtr CreateDib(IntPtr hdc, int width, int height, out IntPtr bits) {
      BITMAPINFO bmi = new BITMAPINFO();
      bmi.bmiHeader.biSize = 40;
      bmi.bmiHeader.biWidth = width;
      bmi.bmiHeader.biHeight = -height;
      bmi.bmiHeader.biPlanes = 1;
      bmi.bmiHeader.biBitCount = 32;
      bmi.bmiHeader.biCompression = 0;
      bmi.bmiHeader.biSizeImage = width * height * 4;
      return CreateDIBSection(hdc, ref bmi, 0, out bits, IntPtr.Zero, 0);
    }
    [StructLayout(LayoutKind.Sequential)] public struct SIZE { public int cx; public int cy; }
    [StructLayout(LayoutKind.Sequential)] public struct POINT { public int x; public int y; }
    [StructLayout(LayoutKind.Sequential)] public struct BLENDFUNCTION { public byte BlendOp; public byte BlendFlags; public byte SourceConstantAlpha; public byte AlphaFormat; }
    [StructLayout(LayoutKind.Sequential)] public struct BITMAPINFOHEADER {
      public int biSize; public int biWidth; public int biHeight; public short biPlanes; public short biBitCount;
      public int biCompression; public int biSizeImage; public int biXPelsPerMeter; public int biYPelsPerMeter;
      public int biClrUsed; public int biClrImportant;
    }
    [StructLayout(LayoutKind.Sequential)] public struct BITMAPINFO { public BITMAPINFOHEADER bmiHeader; public int bmiColors; }
    [DllImport("user32.dll")] static extern IntPtr GetDC(IntPtr hWnd);
    [DllImport("user32.dll")] static extern int ReleaseDC(IntPtr hWnd, IntPtr hDC);
    // Content-only update: pptDst = IntPtr.Zero keeps the window where it is.
    [DllImport("user32.dll", EntryPoint = "UpdateLayeredWindow")] static extern bool UpdateLayeredWindowContent(IntPtr hwnd, IntPtr hdcDst, IntPtr pptDst, ref SIZE psize, IntPtr hdcSrc, ref POINT pptSrc, int crKey, ref BLENDFUNCTION pblend, int dwFlags);
    [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int x, int y, int cx, int cy, int flags);
    static readonly IntPtr HWND_TOPMOST = new IntPtr(-1);
    const int SWP_NOSIZE = 0x1;
    const int SWP_NOACTIVATE = 0x10;
    const int SWP_NOOWNERZORDER = 0x200;
    [DllImport("gdi32.dll")] static extern IntPtr CreateCompatibleDC(IntPtr hdc);
    [DllImport("gdi32.dll")] static extern bool DeleteDC(IntPtr hdc);
    [DllImport("gdi32.dll")] static extern IntPtr SelectObject(IntPtr hdc, IntPtr hgdiobj);
    [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr hObject);
    [DllImport("gdi32.dll", EntryPoint = "CreateDIBSection")] static extern IntPtr CreateDIBSection(IntPtr hdc, ref BITMAPINFO pbmi, uint usage, out IntPtr bits, IntPtr hSection, uint offset);
    [DllImport("kernel32.dll")] static extern void CopyMemory(IntPtr dest, IntPtr src, UIntPtr count);
  }

  /// <summary>Bring the DSH window forward so the user can answer an approval.</summary>
  public static class HostFocus {
    delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc callback, IntPtr lParam);
    [DllImport("user32.dll")] static extern int GetWindowText(IntPtr hWnd, System.Text.StringBuilder text, int maxCount);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hWnd, int command);
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    /// <summary>Find the window whose title ends with the app name and raise it.</summary>
    public static bool Focus() {
      IntPtr found = IntPtr.Zero;
      EnumWindows(delegate(IntPtr hWnd, IntPtr lParam) {
        if (!IsWindowVisible(hWnd)) return true;
        System.Text.StringBuilder sb = new System.Text.StringBuilder(512);
        GetWindowText(hWnd, sb, 512);
        string title = sb.ToString();
        if (title.EndsWith("DeepSeek Harness", StringComparison.Ordinal)) {
          found = hWnd;
          return false;
        }
        return true;
      }, IntPtr.Zero);
      if (found == IntPtr.Zero) return false;
      if (IsIconic(found)) ShowWindow(found, 9);
      if (GetForegroundWindow() == found) return true;
      ShowWindow(found, 9);
      return SetForegroundWindow(found);
    }
  }
}
'@
Add-Type -TypeDefinition $layeredSrc -ReferencedAssemblies System.Drawing, System.Windows.Forms

# ------------------------------------------------------------------ paths ---
$script:Root = $PSScriptRoot
if (-not $script:Root) { $script:Root = Split-Path -Parent $MyInvocation.MyCommand.Path }
if (-not $TextPath) { $TextPath = Join-Path $script:Root 'strings.json' }
if (-not $AssetPath) { $AssetPath = Join-Path $script:Root 'fish.png' }
if (-not $DataDir) { $DataDir = Join-Path $env:LOCALAPPDATA 'dsh-fat-fish' }
if (-not $StatePath) { $StatePath = Join-Path $DataDir 'state.json' }
$script:ConfigPath = Join-Path $DataDir 'widget.json'
$script:PidPath = Join-Path $DataDir 'widget.pid'
$script:ShowPath = Join-Path $DataDir 'show-request'
$script:DataDir = $DataDir

# ----------------------------------------------------------------- strings ---
$script:S = ConvertFrom-Json ([System.IO.File]::ReadAllText($TextPath, [System.Text.Encoding]::UTF8))
$script:Fish = [System.Drawing.Image]::FromFile($AssetPath)
$script:Sep = [string]$script:S.labels.sep
if (-not $script:Sep) { $script:Sep = ' / ' }

# -------------------------------------------------------------- single app ---
$script:Mutex = New-Object System.Threading.Mutex($false, 'Local\DshFatFishDesktopWidget')
if (-not $SelfTest -and -not $AutostartTest) {
    if (-not $script:Mutex.WaitOne(0)) {
        # Another fish is already alive - it may be hidden (right-click -> hide).
        # Leave a request file instead of silently doing nothing, so launching the
        # widget again (desktop\launch-widget.vbs) brings the hidden fish back.
        try {
            if (-not (Test-Path -LiteralPath $script:DataDir)) { New-Item -ItemType Directory -Path $script:DataDir -Force | Out-Null }
            [System.IO.File]::WriteAllText($script:ShowPath, '1')
        } catch { }
        exit 0
    }
}

foreach ($dir in @($DataDir, (Split-Path -Parent $StatePath))) {
    if ($dir) {
        try { if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null } } catch { }
    }
}
try { [System.IO.File]::WriteAllText($script:PidPath, [string]$PID) } catch { }

# -------------------------------------------------------------------- dpi ---
$script:Dpi = 1.0
try {
    $probe = [System.Drawing.Graphics]::FromHwnd([IntPtr]::Zero)
    $script:Dpi = [double]$probe.DpiX / 96.0
    $probe.Dispose()
} catch { $script:Dpi = 1.0 }
if ($env:FATFISH_DEBUG) { try { Add-Content -LiteralPath (Join-Path $env:TEMP 'fatfish-boot.log') -Value ('graphics dpi=' + $script:Dpi) } catch { } }
if ($script:Dpi -lt 0.75) { $script:Dpi = 0.75 }
if ($script:Dpi -gt 3.0) { $script:Dpi = 3.0 }
# One knob for "make the whole widget a bit bigger": geometry goes through U()
# (which folds this in) and the fonts below multiply by it, so the card, the
# fish and the text all grow together instead of the text staying tiny.
$script:UiScale = 1.12
$script:Dpi = $script:Dpi * $script:UiScale
function U([double]$px) { return [int][Math]::Round($px * $script:Dpi) }

$script:C = @{
    text      = [System.Drawing.Color]::FromArgb(255, 26, 38, 56)
    muted     = [System.Drawing.Color]::FromArgb(255, 108, 126, 152)
    faint     = [System.Drawing.Color]::FromArgb(255, 152, 167, 187)
    brand     = [System.Drawing.Color]::FromArgb(255, 70, 130, 238)
    success   = [System.Drawing.Color]::FromArgb(255, 44, 170, 118)
    error     = [System.Drawing.Color]::FromArgb(255, 212, 78, 78)
    idle      = [System.Drawing.Color]::FromArgb(255, 146, 160, 180)
    card      = [System.Drawing.Color]::FromArgb(250, 255, 255, 255)
    cardEdge  = [System.Drawing.Color]::FromArgb(255, 197, 214, 238)
    barTrack  = [System.Drawing.Color]::FromArgb(255, 223, 233, 246)
    disc      = [System.Drawing.Color]::FromArgb(246, 255, 255, 255)
    discEdge  = [System.Drawing.Color]::FromArgb(255, 206, 221, 241)
    shadow    = [System.Drawing.Color]::FromArgb(22, 30, 60, 110)
    divider   = [System.Drawing.Color]::FromArgb(255, 236, 242, 250)
    warn      = [System.Drawing.Color]::FromArgb(255, 214, 138, 30)
    warnSoft  = [System.Drawing.Color]::FromArgb(255, 255, 248, 235)
    warnEdge  = [System.Drawing.Color]::FromArgb(255, 240, 196, 128)
    warnDeep  = [System.Drawing.Color]::FromArgb(255, 163, 96, 10)
}

# Font sizes are points at 96 dpi, so the bitmap canvas ignores $script:Dpi for
# text; multiply by the same UiScale the geometry uses to keep proportions.
$script:F = @{}
$script:F.status = New-Object System.Drawing.Font('Microsoft YaHei UI', [single](11 * $script:UiScale), [System.Drawing.FontStyle]::Bold)
$script:F.title = New-Object System.Drawing.Font('Microsoft YaHei UI', [single](9.5 * $script:UiScale), [System.Drawing.FontStyle]::Bold)
$script:F.body = New-Object System.Drawing.Font('Microsoft YaHei UI', [single](9 * $script:UiScale))
$script:F.small = New-Object System.Drawing.Font('Microsoft YaHei UI', [single](8 * $script:UiScale))
$script:F.tiny = New-Object System.Drawing.Font('Microsoft YaHei UI', [single](7.5 * $script:UiScale))
$script:F.pct = New-Object System.Drawing.Font('Microsoft YaHei UI', [single](15 * $script:UiScale), [System.Drawing.FontStyle]::Bold)

# ------------------------------------------------------------------ state ---
$script:BaseWidth = 310
$script:WinW = U($script:BaseWidth)
$script:WinH = 0
$script:Expanded = $false
$script:ScaleIndex = 1
$script:ScaleFactors = @(0.86, 1.0, 1.16)
$script:KeepAfterExit = $true
$script:SawFresh = $false
$script:Hidden = $false
$script:State = $null
$script:LastStateRaw = ''
$script:LastPoll = 0
$script:LastFrame = 0
$script:StartTicks = [Environment]::TickCount
$script:DoneUntil = 0
$script:PrevPhase = $null
$script:Drag = $null
$script:Dragging = $false
$script:NeedsRender = $false
$script:PendingSave = $false
$script:FishRect = [System.Drawing.Rectangle]::new(0, 0, 1, 1)
$script:BubbleRect = [System.Drawing.Rectangle]::new(0, 0, 1, 1)
$script:AlertHit = [System.Drawing.Rectangle]::new(0, 0, 1, 1)
$script:Approvals = @()
$script:AlertIds = @()
$script:AlertOn = $false
$script:AlertSound = $true
$script:ApprovalSeen = ''
$script:ApprovalToastUntil = 0
$script:ApprovalToast = ''
$script:ApprovalToastTool = ''
$script:ApprovalToastTone = 'idle'
$script:StatusInfo = @{ phase = 'idle'; status = ''; sub = ''; percent = $null; animate = $false; tone = 'idle'; alert = $false; toast = $false; approval = $null; approvalCount = 0 }
$script:DefX = 40
$script:DefY = 120

function Get-MascotSize { return [int]([Math]::Round(112 * $script:ScaleFactors[$script:ScaleIndex] * $script:Dpi)) }

function Limit-Point([int]$x, [int]$y) {
    # A saved position can end up outside the desktop: monitor unplugged,
    # resolution changed, or a drag parked the card on a corner. Keep at least
    # 60 px of the card reachable, otherwise the fish is invisible with no way
    # to right-click it back (that is how it "disappears").
    $vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
    $keep = [int](60 * $script:Dpi)
    $w = [int]$script:WinW
    if ($w -le 0) { $w = $keep * 4 }
    $loX = [int]($vs.Left - $w + $keep)
    $hiX = [int]($vs.Right - $keep)
    if ($hiX -lt $loX) { $hiX = $loX }
    $loY = [int]$vs.Top
    $hiY = [int]($vs.Bottom - $keep)
    if ($hiY -lt $loY) { $hiY = $loY }
    return @([int][Math]::Max($loX, [Math]::Min($hiX, $x)), [int][Math]::Max($loY, [Math]::Min($hiY, $y)))
}

function Get-DefaultPos {
    $wa = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
    $m = Get-MascotSize
    $script:DefX = [int](($wa.Right - $script:WinW) - (16 * $script:Dpi))
    $script:DefY = [int](($wa.Bottom - ($m * 1.6)) - (28 * $script:Dpi))
}

function Read-Config {
    $script:Expanded = $false
    $script:ScaleIndex = 1
    $script:AlertSound = $true
    $script:KeepAfterExit = $true
    Get-DefaultPos
    if (Test-Path -LiteralPath $script:ConfigPath) {
        try {
            $cfg = ConvertFrom-Json ([System.IO.File]::ReadAllText($script:ConfigPath, [System.Text.Encoding]::UTF8))
            if ($cfg.x -ne $null) { $script:DefX = [int]$cfg.x }
            if ($cfg.y -ne $null) { $script:DefY = [int]$cfg.y }
            if ($cfg.expanded -ne $null) { $script:Expanded = [bool]$cfg.expanded }
            if ($cfg.scale -ne $null) { $script:ScaleIndex = [Math]::Max(0, [Math]::Min(2, [int]$cfg.scale)) }
            if ($cfg.alertSound -ne $null) { $script:AlertSound = [bool]$cfg.alertSound }
            if ($cfg.keepAfterExit -ne $null) { $script:KeepAfterExit = [bool]$cfg.keepAfterExit }
        } catch { }
    }
    $pt = Limit-Point ([int]$script:DefX) ([int]$script:DefY)
    $script:DefX = [int]$pt[0]
    $script:DefY = [int]$pt[1]
}

function Save-Config {
    try {
        # Never persist an off-screen position: it would come back as an
        # invisible fish on the next start.
        $pt = Limit-Point ([int]$script:Form.Left) ([int]$script:Form.Top)
        $obj = [ordered]@{
            x             = [int]$pt[0]
            y             = [int]$pt[1]
            expanded      = $script:Expanded
            scale         = $script:ScaleIndex
            alertSound    = $script:AlertSound
            keepAfterExit = $script:KeepAfterExit
        }
        $tmp = $script:ConfigPath + '.tmp'
        [System.IO.File]::WriteAllText($tmp, ($obj | ConvertTo-Json -Compress), (New-Object System.Text.UTF8Encoding($false)))
        if (Test-Path -LiteralPath $script:ConfigPath) { Remove-Item -LiteralPath $script:ConfigPath -Force }
        Move-Item -LiteralPath $tmp -Destination $script:ConfigPath -Force
    } catch { }
}

# ------------------------------------------------------------- login start ---
# The user can opt into starting the fish at login from the right-click menu.
# The Startup shortcut itself is the source of truth (widget.json is not
# consulted for this), so a manually deleted shortcut also clears the tick.

function Get-StartupLinkPath {
    $startup = [Environment]::GetFolderPath('Startup')
    if (-not $startup) { $startup = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup' }
    return (Join-Path $startup 'FatFishDesktop.lnk')
}

function Test-Autostart {
    try { return (Test-Path -LiteralPath (Get-StartupLinkPath)) } catch { return $false }
}

function Set-Autostart([bool]$on) {
    $link = Get-StartupLinkPath
    if (-not $on) {
        try { if (Test-Path -LiteralPath $link) { Remove-Item -LiteralPath $link -Force } } catch { }
        return
    }
    $vbs = Join-Path $PSScriptRoot 'launch-widget.vbs'
    if (-not (Test-Path -LiteralPath $vbs)) { return }
    $wscript = Join-Path $env:SystemRoot 'System32\wscript.exe'
    $shell = $null
    try {
        $shell = New-Object -ComObject WScript.Shell
        $shortcut = $shell.CreateShortcut($link)
        $shortcut.TargetPath = $wscript
        $shortcut.Arguments = '"' + $vbs + '"'
        $shortcut.WorkingDirectory = $PSScriptRoot
        $shortcut.Description = 'FatFishDesktop'
        $shortcut.WindowStyle = 7
        $shortcut.Save()
    } catch { } finally {
        if ($shell -ne $null) { try { [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($shell) } catch { } }
    }
}

if ($AutostartTest -ne '') {
    # Dev flag: `-AutostartTest query|on|off` toggles the Startup shortcut from a
    # console and exits, so the shortcut logic is testable without the GUI.
    switch ($AutostartTest.ToLowerInvariant()) {
        'on' { Set-Autostart $true }
        'off' { Set-Autostart $false }
        default { }
    }
    if (Test-Autostart) { Write-Output 'autostart=on' } else { Write-Output 'autostart=off' }
    exit 0
}

function Read-StateRaw {
    # Share read/write/delete: the Host atomically replaces the snapshot, and a
    # reader that opened it exclusively would make that rename fail.
    $share = [System.IO.FileShare]::ReadWrite -bor [System.IO.FileShare]::Delete
    $stream = [System.IO.FileStream]::new($script:StatePath, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, $share)
    try {
        $reader = [System.IO.StreamReader]::new($stream, [System.Text.Encoding]::UTF8)
        try {
            return $reader.ReadToEnd()
        } finally {
            $reader.Dispose()
        }
    } finally {
        $stream.Dispose()
    }
}

function Set-ApprovalToast($decided) {
    if ($decided -eq $null -or -not $decided.id) { return }
    $outcome = [string]$decided.outcome
    $label = [string]$script:S.status.approvalUnavailable
    $tone = 'idle'
    if ($outcome -eq 'allowed-once') { $label = [string]$script:S.status.approvalAllowed; $tone = 'done' }
    elseif ($outcome -eq 'rejected') { $label = [string]$script:S.status.approvalRejected; $tone = 'error' }
    elseif ($outcome -eq 'cancelled') { $label = [string]$script:S.status.approvalCancelled }
    $script:ApprovalToast = $label
    $script:ApprovalToastTone = $tone
    $script:ApprovalToastTool = Get-ToolLabel ([string]$decided.toolName)
    $script:ApprovalToastUntil = [Environment]::TickCount + 6000
    $script:NeedsRender = $true
}

function Poll-State {
    $raw = $null
    for ($i = 0; $i -lt 3; $i++) {
        try {
            if (-not (Test-Path -LiteralPath $script:StatePath)) { $script:State = $null; $script:LastStateRaw = ''; return }
            $raw = Read-StateRaw
            break
        } catch {
            Start-Sleep -Milliseconds 15
        }
    }
    if ($raw -eq $null -or $raw -eq '') { return }
    if ($raw -eq $script:LastStateRaw) { return }
    try { $parsed = ConvertFrom-Json $raw } catch { return }
    $script:LastStateRaw = $raw
    $script:State = $parsed
    $phase = $null
    if ($script:State.sessions -and $script:State.sessions.Count -gt 0) { $phase = [string]$script:State.sessions[0].phase }
    if ($script:PrevPhase -ne $null -and $phase -eq 'done' -and $script:PrevPhase -ne 'done') {
        $script:DoneUntil = [Environment]::TickCount + 6500
    }
    $script:PrevPhase = $phase

    # Pending approvals drive the alert popup; a new id means a fresh question.
    $list = @()
    try { if ($script:State.approvals -ne $null) { $list = @($script:State.approvals) } } catch { $list = @() }
    $script:Approvals = $list
    $script:AlertOn = ($list.Count -gt 0)
    $ids = @()
    foreach ($a in $list) {
        $id = [string]$a.id
        if ($id) { $ids += $id }
    }
    $fresh = $false
    foreach ($id in $ids) {
        if (-not ($script:AlertIds -contains $id)) { $fresh = $true }
    }
    # A hidden fish stays quiet: no alert sound while it is out of the way.
    if ($fresh -and $script:AlertSound -and -not $script:Hidden) {
        try { [System.Media.SystemSounds]::Exclamation.Play() } catch { }
    }
    if (($ids -join ',') -ne ($script:AlertIds -join ',')) { $script:NeedsRender = $true }
    $script:AlertIds = $ids

    # A fresh verdict (allowed / rejected / cancelled) flashes for a few seconds so the
    # user sees what happened to the request they just answered in DSH.
    $decided = $script:State.lastApproval
    if ($decided -ne $null -and $decided.id) {
        $key = ([string]$decided.id) + '@' + ([string]$decided.at)
        if ($key -ne $script:ApprovalSeen) {
            $first = ($script:ApprovalSeen -eq '')
            $age = [double]::MaxValue
            if ($decided.at -ne $null) { $age = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - [double]$decided.at }
            # Do not replay an old verdict when the widget starts up.
            if (-not $first -and $age -lt 10000) { Set-ApprovalToast $decided }
            $script:ApprovalSeen = $key
        }
    }
}

# ---------------------------------------------------------------- drawing ---
function New-Brush($color) { return New-Object System.Drawing.SolidBrush($color) }
function New-Pen($color, [double]$width) { return New-Object System.Drawing.Pen($color, [single]$width) }

function Draw-RoundRect($g, [single]$x, [single]$y, [single]$w, [single]$h, [single]$r, $fill, $stroke) {
    if ($w -le 0 -or $h -le 0) { return }
    if ($r * 2 -gt $w) { $r = $w / 2 }
    if ($r * 2 -gt $h) { $r = $h / 2 }
    $d = $r * 2
    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $path.AddArc($x, $y, $d, $d, 180, 90)
    $path.AddArc($x + $w - $d, $y, $d, $d, 270, 90)
    $path.AddArc($x + $w - $d, $y + $h - $d, $d, $d, 0, 90)
    $path.AddArc($x, $y + $h - $d, $d, $d, 90, 90)
    $path.CloseFigure()
    if ($fill -ne $null) {
        $brush = New-Brush $fill
        $g.FillPath($brush, $path)
        $brush.Dispose()
    }
    if ($stroke -ne $null) {
        $pen = New-Pen $stroke (1.0 * $script:Dpi)
        $g.DrawPath($pen, $path)
        $pen.Dispose()
    }
    $path.Dispose()
}

function Draw-Text($g, [string]$text, $font, $color, [single]$x, [single]$y, [single]$w, [single]$h, [string]$align) {
    if ([string]::IsNullOrEmpty($text)) { return }
    $brush = New-Brush $color
    $fmt = New-Object System.Drawing.StringFormat
    $fmt.Trimming = [System.Drawing.StringTrimming]::EllipsisCharacter
    $fmt.FormatFlags = [System.Drawing.StringFormatFlags]::NoWrap
    $fmt.LineAlignment = [System.Drawing.StringAlignment]::Center
    if ($align -eq 'right') { $fmt.Alignment = [System.Drawing.StringAlignment]::Far }
    elseif ($align -eq 'center') { $fmt.Alignment = [System.Drawing.StringAlignment]::Center }
    else { $fmt.Alignment = [System.Drawing.StringAlignment]::Near }
    $rect = [System.Drawing.RectangleF]::new($x, $y, [Math]::Max(1, $w), [Math]::Max(1, $h))
    $g.DrawString($text, $font, $brush, $rect, $fmt)
    $fmt.Dispose()
    $brush.Dispose()
}

function Draw-Bar($g, [single]$x, [single]$y, [single]$w, [single]$h, $percent, [bool]$animate) {
    Draw-RoundRect $g $x $y $w $h ($h / 2) $script:C.barTrack $null
    if ($percent -ne $null) {
        $pw = [single]($w * ([double]$percent / 100.0))
        if ($pw -ge 1) { Draw-RoundRect $g $x $y $pw $h ($h / 2) $script:C.brand $null }
        return
    }
    if (-not $animate) { return }
    $phase = ([Environment]::TickCount - $script:StartTicks) % 1600
    $t = [double]$phase / 1600.0
    $seg = [single]($w * 0.34)
    $left = [single]($x - $seg + ($w + $seg) * $t)
    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $path.AddArc($x, $y, $h, $h, 180, 90)
    $path.AddArc($x + $w - $h, $y, $h, $h, 270, 90)
    $path.AddArc($x + $w - $h, $y, $h, $h, 0, 90)
    $path.AddArc($x, $y, $h, $h, 90, 90)
    $path.CloseFigure()
    $g.SetClip($path)
    $brush = New-Brush $script:C.brand
    $g.FillRectangle($brush, $left, $y, $seg, $h)
    $brush.Dispose()
    $g.ResetClip()
    $path.Dispose()
}

function Get-ToolLabel([string]$name) {
    if ([string]::IsNullOrEmpty($name)) { return '' }
    $prop = $script:S.toolZh.PSObject.Properties[$name]
    if ($prop -ne $null -and $prop.Value) { return [string]$prop.Value }
    return $name
}

function Format-Duration($ms) {
    if ($ms -eq $null) { return '' }
    $total = [int]([double]$ms / 1000.0)
    if ($total -lt 0) { $total = 0 }
    $h = [int][Math]::Floor($total / 3600)
    $m = [int][Math]::Floor(($total % 3600) / 60)
    $s = [int]($total % 60)
    if ($h -gt 0) { return ('{0}:{1:00}:{2:00}' -f $h, $m, $s) }
    return ('{0:00}:{1:00}' -f $m, $s)
}

function Get-Active {
    if ($script:State -eq $null) { return $null }
    if ($script:State.sessions -eq $null) { return $null }
    if (@($script:State.sessions).Count -eq 0) { return $null }
    return @($script:State.sessions)[0]
}

function Get-ToneColor([string]$tone) {
    switch ($tone) {
        'done' { return $script:C.success }
        'error' { return $script:C.error }
        'brand' { return $script:C.brand }
        'warn' { return $script:C.warnDeep }
        default { return $script:C.idle }
    }
}

function Get-StatsLine($active) {
    if ($active -eq $null) { return '' }
    $stats = @()
    if ($active.turn -ne $null -and [int]$active.turn -gt 0) { $stats += [string]::Format([string]$script:S.labels.round, $active.turn) }
    if ($active.step -ne $null -and [int]$active.step -gt 0) { $stats += [string]::Format([string]$script:S.labels.step, $active.step) }
    if ($active.counts -ne $null -and $active.counts.tools -ne $null) { $stats += [string]::Format([string]$script:S.labels.tools, $active.counts.tools) }
    $elapsed = $null
    if ($active.running -and $active.turnStartedAt -ne $null) {
        $elapsed = [double]([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - [double]$active.turnStartedAt)
    } elseif ($active.elapsedMs -ne $null) {
        $elapsed = [double]$active.elapsedMs
    } elseif ($active.turnStartedAt -ne $null -and $active.lastEventAt -ne $null) {
        $elapsed = [double]$active.lastEventAt - [double]$active.turnStartedAt
    }
    if ($elapsed -ne $null -and $elapsed -ge 0) { $stats += [string]::Format([string]$script:S.labels.elapsed, (Format-Duration $elapsed)) }
    return ($stats -join $script:Sep)
}

function Get-StateAge {
    if ($script:State -eq $null -or $script:State.writtenAt -eq $null) { return [double]::MaxValue }
    return [double]([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - [double]$script:State.writtenAt)
}

function Get-StatusInfo {
    $age = Get-StateAge
    $active = Get-Active
    $info = @{ phase = 'idle'; status = ''; sub = ''; stats = ''; percent = $null; animate = $false; tone = 'idle'; doneFlash = $false; alert = $false; toast = $false; approval = $null; approvalCount = 0 }
    $info.doneFlash = ([Environment]::TickCount -lt $script:DoneUntil)
    if ($active -eq $null -and $script:State -eq $null) {
        $info.status = [string]$script:S.status.waiting
        $info.sub = [string]$script:S.labels.noTask
        return $info
    }
    if ($age -gt 7000) {
        $info.status = [string]$script:S.status.offline
        $info.sub = [string]$script:S.labels.offlineSub
        return $info
    }

    # Pending approvals win over everything else: the agent is blocked until the
    # user answers in DSH, so the fish shows an alert card (and can raise DSH).
    if ($script:AlertOn -and $script:Approvals.Count -gt 0) {
        $first = $script:Approvals[0]
        $info.alert = $true
        $info.phase = 'approval'
        $info.status = [string]$script:S.status.approval
        $info.tone = 'warn'
        $info.animate = $true
        $info.approval = $first
        $info.approvalCount = $script:Approvals.Count
        $detail = [string]$first.reason
        if (-not $detail) { $detail = [string]$first.target }
        $line = (Get-ToolLabel ([string]$first.toolName))
        if ($detail) { $line = $line + $script:Sep + $detail }
        if ($script:Approvals.Count -gt 1) {
            $line = $line + $script:Sep + [string]::Format([string]$script:S.labels.approvalMore, ($script:Approvals.Count - 1))
        }
        $info.sub = $line
        $info.stats = Get-StatsLine $active
        return $info
    }

    # Short-lived confirmation after the user answered an approval request.
    if ([Environment]::TickCount -lt $script:ApprovalToastUntil) {
        $info.toast = $true
        $info.phase = 'done'
        $info.status = $script:ApprovalToast
        $info.tone = $script:ApprovalToastTone
        $info.sub = $script:ApprovalToastTool
        $info.stats = Get-StatsLine $active
        return $info
    }

    if ($active -eq $null) {
        $info.status = [string]$script:S.status.idle
        $info.sub = [string]$script:S.labels.waitingSub
        return $info
    }
    $phase = [string]$active.phase
    if ($phase -eq '') { $phase = 'idle' }
    # "done" is a moment, not a mode: once the turn has been quiet for a while,
    # fall back to idle instead of parking on the finished turn (that stale
    # badge is what made a new task look like it had not been picked up yet).
    if ($phase -eq 'done' -and $active.running -ne $true) {
        $quiet = [double]::MaxValue
        if ($active.lastEventAt -ne $null) {
            $quiet = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - [double]$active.lastEventAt
        }
        if ($quiet -gt 10000) { $phase = 'idle' }
    }
    $info.phase = $phase
    if ($info.doneFlash) {
        $info.status = [string]$script:S.labels.doneToast
        $info.tone = 'done'
    } elseif ($phase -eq 'tool' -and $active.currentTool -ne $null -and $active.currentTool.name) {
        $info.status = ([string]$script:S.status.tool) + $script:Sep + (Get-ToolLabel ([string]$active.currentTool.name))
        $info.tone = 'brand'
    } else {
        $prop = $script:S.status.PSObject.Properties[$phase]
        if ($prop -ne $null) { $info.status = [string]$prop.Value } else { $info.status = [string]$script:S.status.idle }
        if ($phase -eq 'done') { $info.tone = 'done' }
        elseif ($phase -eq 'error') { $info.tone = 'error' }
        elseif ($phase -eq 'thinking' -or $phase -eq 'streaming' -or $phase -eq 'queued') { $info.tone = 'brand' }
    }
    $tp = $active.todoProgress
    if ($tp -ne $null -and $tp.total -ne $null -and [int]$tp.total -gt 0) {
        $info.percent = [Math]::Round(100.0 * [double]$tp.done / [double]$tp.total, 0)
    }
    $info.animate = [bool]$active.running
    $info.stats = Get-StatsLine $active
    $info.sub = $info.stats
    return $info
}

function Draw-Fish($g, [single]$x, [single]$y, [single]$size) {
    $t = ([Environment]::TickCount - $script:StartTicks) / 1000.0
    if ($script:StatusInfo.animate) { $bob = [Math]::Sin($t * 2.6) * (2.2 * $script:Dpi) }
    else { $bob = [Math]::Sin($t * 1.1) * (1.0 * $script:Dpi) }
    $y2 = [single]($y + $bob)
    $info = $script:StatusInfo

    # The mascot PNG is transparent, so the fish hangs directly on the desktop
    # (no backing disc). Status is shown with a small badge instead of a ring.
    $pad = [single]($size * 0.02)
    $fw = [single]($size - ($pad * 2))
    $fh = [single]($size - ($pad * 2))
    $rect = [System.Drawing.RectangleF]::new([single]($x + $pad), [single]($y2 + $pad), $fw, $fh)
    $g.DrawImage($script:Fish, $rect)

    $badge = [single](22 * $script:Dpi)
    $bx = [single]($x + $size - $badge * 0.62)
    $by = [single]($y2 - $badge * 0.30)

    if ($info.alert) {
        $discBrush = New-Brush $script:C.warn
        $g.FillEllipse($discBrush, $bx, $by, $badge, $badge)
        $discBrush.Dispose()
        $badgePen = New-Pen ([System.Drawing.Color]::White) (1.4 * $script:Dpi)
        $g.DrawEllipse($badgePen, $bx, $by, $badge, $badge)
        $badgePen.Dispose()
        Draw-Text $g '!' $script:F.status ([System.Drawing.Color]::White) $bx ($by - (1 * $script:Dpi)) $badge ($badge + (3 * $script:Dpi)) 'center'
    } elseif ($info.toast) {
        # Short verdict flash: check / cross / dash badge, no halo.
        $tone = Get-ToneColor ([string]$info.tone)
        $discBrush = New-Brush $tone
        $g.FillEllipse($discBrush, $bx, $by, $badge, $badge)
        $discBrush.Dispose()
        $badgePen = New-Pen ([System.Drawing.Color]::White) (1.4 * $script:Dpi)
        $g.DrawEllipse($badgePen, $bx, $by, $badge, $badge)
        $badgePen.Dispose()
        $markPen = New-Pen ([System.Drawing.Color]::White) (2.0 * $script:Dpi)
        $markPen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
        $markPen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
        if ([string]$info.tone -eq 'done') {
            $g.DrawLine($markPen, [single]($bx + $badge * 0.28), [single]($by + $badge * 0.52), [single]($bx + $badge * 0.44), [single]($by + $badge * 0.70))
            $g.DrawLine($markPen, [single]($bx + $badge * 0.44), [single]($by + $badge * 0.70), [single]($bx + $badge * 0.74), [single]($by + $badge * 0.32))
        } elseif ([string]$info.tone -eq 'error') {
            $g.DrawLine($markPen, [single]($bx + $badge * 0.30), [single]($by + $badge * 0.30), [single]($bx + $badge * 0.70), [single]($by + $badge * 0.70))
            $g.DrawLine($markPen, [single]($bx + $badge * 0.70), [single]($by + $badge * 0.30), [single]($bx + $badge * 0.30), [single]($by + $badge * 0.70))
        } else {
            $g.DrawLine($markPen, [single]($bx + $badge * 0.30), [single]($by + $badge * 0.50), [single]($bx + $badge * 0.70), [single]($by + $badge * 0.50))
        }
        $markPen.Dispose()
    }
}

function Draw-Bubble($g) {
    $x = [single](4 * $script:Dpi)
    $y = [single](6 * $script:Dpi)
    $w = [single]($script:WinW - (8 * $script:Dpi))
    $h = [single](66 * $script:Dpi)
    $cardFill = $script:C.card
    $cardEdge = $script:C.cardEdge
    $titleColor = $script:C.text
    if ($script:StatusInfo.alert) {
        $cardFill = $script:C.warnSoft
        $cardEdge = $script:C.warnEdge
        $titleColor = $script:C.warnDeep
    }
    $script:BubbleRect = [System.Drawing.Rectangle]::new([int]$x, [int]$y, [int]$w, [int]$h)
    Draw-RoundRect $g $x $y $w $h (11 * $script:Dpi) $cardFill $cardEdge
    $tail = [single](9 * $script:Dpi)
    $tx = [single]($x + $w - (46 * $script:Dpi))
    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $path.AddPolygon(@(
            ([System.Drawing.PointF]::new($tx, $y + $h - 1)),
            ([System.Drawing.PointF]::new($tx + $tail, $y + $h - 1)),
            ([System.Drawing.PointF]::new($tx + $tail + 3, $y + $h + $tail * 0.9))
        ))
    $brush = New-Brush $cardFill
    $g.FillPath($brush, $path)
    $brush.Dispose()
    $path.Dispose()
    $info = $script:StatusInfo
    if ($info.toast) { $titleColor = Get-ToneColor ([string]$info.tone) }
    Draw-Text $g ([string]$info.status) $script:F.status $titleColor ($x + 12 * $script:Dpi) ($y + 4 * $script:Dpi) ($w - 24 * $script:Dpi) (22 * $script:Dpi) 'left'
    Draw-Text $g ([string]$info.sub) $script:F.small $script:C.muted ($x + 12 * $script:Dpi) ($y + 26 * $script:Dpi) ($w - 24 * $script:Dpi) (16 * $script:Dpi) 'left'
    if ($script:StatusInfo.alert) {
        Draw-Text $g ([string]$script:S.labels.approvalHint) $script:F.tiny $script:C.warnDeep ($x + 12 * $script:Dpi) ($y + 45 * $script:Dpi) ($w - 24 * $script:Dpi) (14 * $script:Dpi) 'left'
    } else {
        Draw-Bar $g ($x + 12 * $script:Dpi) ($y + $h - (20 * $script:Dpi)) ($w - 24 * $script:Dpi) (5 * $script:Dpi) $info.percent $info.animate
    }
}

# ------------------------------------------------------------------- rows ---
function Get-PanelRows {
    $active = Get-Active
    $info = $script:StatusInfo
    $sep = $script:Sep
    $rows = New-Object System.Collections.ArrayList
    $title = [string]$script:S.labels.title
    if ($active -ne $null -and $active.title) { $title = [string]$active.title }
    [void]$rows.Add(@{ kind = 'header'; h = U(32); text = $title; status = $info.status; tone = $info.tone })

    if ($script:StatusInfo.alert -and $script:Approvals.Count -gt 0) {
        $first = $script:Approvals[0]
        $detail = [string]$first.reason
        if (-not $detail) { $detail = [string]$first.target }
        $line = (Get-ToolLabel ([string]$first.toolName))
        if ($detail) { $line = $line + $sep + $detail }
        $more = ''
        if ($script:Approvals.Count -gt 1) {
            $more = [string]::Format([string]$script:S.labels.approvalMore, ($script:Approvals.Count - 1))
        }
        [void]$rows.Add(@{
                kind  = 'alert'
                h     = U(52)
                title = [string]$script:S.labels.approvalSection
                text  = $line
                more  = $more
                hint  = [string]$script:S.labels.approvalHint
            })
    }

    if (-not $script:StatusInfo.alert) {
        $pctText = '--'
        $subText = [string]$script:S.labels.progress
        if ($info.percent -ne $null) {
            $pctText = ([string][int]$info.percent) + '%'
            $tp = $active.todoProgress
            if ($tp -ne $null) { $subText = [string]::Format([string]$script:S.labels.todoCount, $tp.done, $tp.total) }
        } elseif ($info.animate) { $pctText = '...' }
        [void]$rows.Add(@{ kind = 'progress'; h = U(52); percent = $info.percent; pct = $pctText; subText = $subText; subLine = $info.sub; animate = $info.animate })
    } elseif ($info.stats) {
        # While blocked on an approval the progress bar has nothing to say; keep
        # the turn/step/elapsed line visible instead of an empty "..." bar.
        [void]$rows.Add(@{ kind = 'note'; h = U(18); text = $info.stats })
    }

    if ($active -ne $null -and $active.currentTool -ne $null -and $active.currentTool.name) {
        $label = [string]$script:S.labels.current + ': ' + (Get-ToolLabel ([string]$active.currentTool.name))
        $target = [string]$active.currentTool.target
        if ($target) { $label = $label + $sep + $target }
        [void]$rows.Add(@{ kind = 'current'; h = U(20); text = $label })
    }

    if ($active -ne $null -and $active.goal -ne $null) {
        $rounds = ''
        if ($active.goal.maxGoalRounds -ne $null -and [int]$active.goal.maxGoalRounds -gt 0) {
            $rounds = ('{0}/{1}' -f [int]$active.goal.roundsStarted, [int]$active.goal.maxGoalRounds)
        }
        [void]$rows.Add(@{ kind = 'goal'; h = U(38); label = [string]$script:S.labels.goal; text = [string]$active.goal.objective; rounds = $rounds })
    }

    $todos = @()
    if ($active -ne $null -and $active.todos -ne $null) { $todos = @($active.todos) }
    [void]$rows.Add(@{ kind = 'section'; h = U(22); text = [string]$script:S.labels.todo })
    if ($todos.Count -eq 0) {
        [void]$rows.Add(@{ kind = 'note'; h = U(18); text = [string]$script:S.labels.noTodo })
    } else {
        $shown = [Math]::Min(6, $todos.Count)
        for ($i = 0; $i -lt $shown; $i++) {
            $todo = $todos[$i]
            [void]$rows.Add(@{ kind = 'todo'; h = U(17); text = [string]$todo.content; status = [string]$todo.status })
        }
        if ($todos.Count -gt $shown) {
            [void]$rows.Add(@{ kind = 'note'; h = U(16); text = [string]::Format([string]$script:S.labels.more, ($todos.Count - $shown)) })
        }
    }

    $jobs = @()
    if ($active -ne $null -and $active.jobs -ne $null) { $jobs = @($active.jobs) }
    if ($jobs.Count -gt 0) {
        [void]$rows.Add(@{ kind = 'section'; h = U(22); text = [string]$script:S.labels.jobs })
        $shownJobs = [Math]::Min(3, $jobs.Count)
        for ($i = 0; $i -lt $shownJobs; $i++) {
            $job = $jobs[$i]
            $status = [string]$job.status
            $statusKey = 'jobStopped'
            $tone = 'idle'
            if ($status -eq 'running' -or $status -eq 'stopping') { $statusKey = 'jobRunning'; $tone = 'brand' }
            elseif ($status -eq 'completed') { $statusKey = 'jobDone'; $tone = 'done' }
            elseif ($status -eq 'failed') { $statusKey = 'jobFailed'; $tone = 'error' }
            $prop = $script:S.labels.PSObject.Properties[$statusKey]
            $statusText = $status
            if ($prop -ne $null) { $statusText = [string]$prop.Value }
            $label = [string]$job.label
            if (-not $label) { $label = [string]$job.id }
            [void]$rows.Add(@{ kind = 'job'; h = U(17); label = $label; status = $statusText; tone = $tone })
        }
    }

    $team = @()
    if ($active -ne $null -and $active.teamTasks -ne $null) { $team = @($active.teamTasks) }
    if ($team.Count -gt 0) {
        [void]$rows.Add(@{ kind = 'section'; h = U(22); text = [string]$script:S.labels.team })
        $shownTeam = [Math]::Min(3, $team.Count)
        for ($i = 0; $i -lt $shownTeam; $i++) {
            $task = $team[$i]
            [void]$rows.Add(@{ kind = 'team'; h = U(17); text = [string]$task.subject; status = [string]$task.status })
        }
    }

    $others = 0
    if ($script:State -ne $null -and $script:State.sessions -ne $null) {
        $all = @($script:State.sessions)
        for ($i = 1; $i -lt $all.Count; $i++) {
            if ($all[$i].running) { $others = $others + 1 }
        }
    }
    if ($others -gt 0) {
        [void]$rows.Add(@{ kind = 'note'; h = U(18); text = [string]::Format([string]$script:S.labels.others, $others) })
    }
    return $rows
}

function Render-Rows($g, $rows) {
    $padX = [single](12 * $script:Dpi)
    $inner = [single]($script:WinW - ($padX * 2))
    $y = [single](8 * $script:Dpi)
    $i = 0
    foreach ($row in $rows) {
        switch ($row.kind) {
            'header' {
                $pillW = [single](U(96))
                $pillH = [single](U(18))
                Draw-Text $g ([string]$row.text) $script:F.title $script:C.text $padX $y ($inner - $pillW - (10 * $script:Dpi)) (U(26)) 'left'
                $tone = Get-ToneColor ([string]$row.tone)
                $pillX = [single]($padX + $inner - $pillW)
                $pillY = [single]($y + (U(4)))
                Draw-RoundRect $g $pillX $pillY $pillW $pillH ($pillH / 2) ([System.Drawing.Color]::FromArgb(28, $tone.R, $tone.G, $tone.B)) $null
                Draw-Text $g ([string]$row.status) $script:F.tiny $tone $pillX $pillY $pillW $pillH 'center'
            }
            'progress' {
                Draw-Text $g ([string]$row.pct) $script:F.pct $script:C.text $padX $y (64 * $script:Dpi) (24 * $script:Dpi) 'left'
                Draw-Text $g ([string]$row.subText) $script:F.small $script:C.muted ($padX + (60 * $script:Dpi)) $y ($inner - (60 * $script:Dpi)) (24 * $script:Dpi) 'left'
                Draw-Bar $g $padX ([single]($y + (28 * $script:Dpi))) $inner (5 * $script:Dpi) $row.percent ([bool]$row.animate)
                if ($row.subLine) {
                    Draw-Text $g ([string]$row.subLine) $script:F.tiny $script:C.faint $padX ([single]($y + (36 * $script:Dpi))) $inner (12 * $script:Dpi) 'left'
                }
            }
            'alert' {
                $boxH = [single](U(46))
                Draw-RoundRect $g $padX $y $inner $boxH (8 * $script:Dpi) $script:C.warnSoft $script:C.warnEdge
                Draw-Text $g ([string]$row.title) $script:F.tiny $script:C.warnDeep ($padX + (8 * $script:Dpi)) ([single]($y + (3 * $script:Dpi))) ($inner - (16 * $script:Dpi)) (U(15)) 'left'
                Draw-Text $g ([string]$row.text) $script:F.small $script:C.text ($padX + (8 * $script:Dpi)) ([single]($y + (U(19)))) ($inner - (16 * $script:Dpi)) (U(16)) 'left'
                $hint = [string]$row.hint
                if ($row.more) { $hint = $hint + $script:Sep + [string]$row.more }
                Draw-Text $g $hint $script:F.tiny $script:C.warnDeep ($padX + (8 * $script:Dpi)) ([single]($y + (U(35)))) ($inner - (16 * $script:Dpi)) (U(12)) 'left'
                $script:AlertHit = [System.Drawing.Rectangle]::new([int]$padX, [int]$y, [int]$inner, [int]$boxH)
            }
            'current' {
                $dot = New-Brush $script:C.brand
                $g.FillEllipse($dot, $padX, [single]($y + (8 * $script:Dpi)), [single](6 * $script:Dpi), [single](6 * $script:Dpi))
                $dot.Dispose()
                Draw-Text $g ([string]$row.text) $script:F.small $script:C.muted ($padX + (12 * $script:Dpi)) $y ($inner - (12 * $script:Dpi)) (18 * $script:Dpi) 'left'
            }
            'goal' {
                Draw-Text $g ([string]$row.label) $script:F.tiny $script:C.faint $padX $y ($inner - (46 * $script:Dpi)) (14 * $script:Dpi) 'left'
                if ($row.rounds) { Draw-Text $g ([string]$row.rounds) $script:F.tiny $script:C.faint ($padX + $inner - (44 * $script:Dpi)) $y (44 * $script:Dpi) (14 * $script:Dpi) 'right' }
                Draw-Text $g ([string]$row.text) $script:F.small $script:C.muted $padX ([single]($y + (15 * $script:Dpi))) $inner (18 * $script:Dpi) 'left'
            }
            'section' {
                Draw-Text $g ([string]$row.text) $script:F.tiny $script:C.faint $padX ([single]($y + (U(4)))) $inner (U(16)) 'left'
            }
            'note' {
                Draw-Text $g ([string]$row.text) $script:F.tiny $script:C.faint $padX $y $inner (16 * $script:Dpi) 'left'
            }
            'todo' {
                $cy = [single]($y + (8 * $script:Dpi))
                $r = [single](4.0 * $script:Dpi)
                $cx = [single]($padX + 1)
                $color = $script:C.muted
                if ($row.status -eq 'completed') {
                    $dot = New-Brush $script:C.success
                    $g.FillEllipse($dot, $cx, [single]($cy - $r), [single]($r * 2), [single]($r * 2))
                    $dot.Dispose()
                    $pen = New-Pen ([System.Drawing.Color]::White) (1.6 * $script:Dpi)
                    $g.DrawLines($pen, @(
                            ([System.Drawing.PointF]::new([single]($cx + $r * 0.5), [single]($cy + $r * 0.1))),
                            ([System.Drawing.PointF]::new([single]($cx + $r * 0.95), [single]($cy + $r * 0.55))),
                            ([System.Drawing.PointF]::new([single]($cx + $r * 1.65), [single]($cy - $r * 0.5)))
                        ))
                    $pen.Dispose()
                    $color = $script:C.faint
                } elseif ($row.status -eq 'in_progress') {
                    $dot = New-Brush $script:C.brand
                    $g.FillEllipse($dot, $cx, [single]($cy - $r), [single]($r * 2), [single]($r * 2))
                    $dot.Dispose()
                    $color = $script:C.text
                } else {
                    $pen = New-Pen $script:C.idle (1.4 * $script:Dpi)
                    $g.DrawEllipse($pen, $cx, [single]($cy - $r), [single]($r * 2), [single]($r * 2))
                    $pen.Dispose()
                }
                Draw-Text $g ([string]$row.text) $script:F.small $color ($padX + (14 * $script:Dpi)) $y ($inner - (14 * $script:Dpi)) (16 * $script:Dpi) 'left'
            }
            'job' {
                Draw-Text $g ([string]$row.label) $script:F.small $script:C.muted $padX $y ($inner - (56 * $script:Dpi)) (16 * $script:Dpi) 'left'
                $tone = Get-ToneColor ([string]$row.tone)
                Draw-Text $g ([string]$row.status) $script:F.tiny $tone ($padX + $inner - (54 * $script:Dpi)) $y (54 * $script:Dpi) (16 * $script:Dpi) 'right'
            }
            'team' {
                $color = $script:C.muted
                $mark = '-'
                if ($row.status -eq 'completed') { $color = $script:C.faint; $mark = 'x' }
                elseif ($row.status -eq 'in_progress') { $color = $script:C.text; $mark = '>' }
                $boxColor = $script:C.faint
                $pen = New-Pen $boxColor (1.2 * $script:Dpi)
                $box = [single](6 * $script:Dpi)
                $bx = [single]($padX + 1)
                $by = [single]($y + (7 * $script:Dpi))
                $g.DrawRectangle($pen, $bx, $by, $box, $box)
                $pen.Dispose()
                Draw-Text $g ([string]$row.text) $script:F.small $color ($padX + (12 * $script:Dpi)) $y ($inner - (12 * $script:Dpi)) (16 * $script:Dpi) 'left'
            }
        }
        $y = [single]($y + $row.h)
    }
    return $y
}

function Render-Frame {
    $info = $script:StatusInfo
    $m = Get-MascotSize
    $padBottom = [single](8 * $script:Dpi)
    $rows = $null
    $script:AlertHit = [System.Drawing.Rectangle]::new(0, 0, 1, 1)
    if ($script:Expanded) { $rows = Get-PanelRows } else { $rows = @() }

    if ($script:Expanded) {
        $panelH = [single](10 * $script:Dpi)
        foreach ($row in $rows) { $panelH = [single]($panelH + $row.h) }
        $panelH = [single]($panelH + (10 * $script:Dpi))
        $fishTop = [single]($panelH + (6 * $script:Dpi))
    } else {
        $bubbleTop = [single](6 * $script:Dpi)
        $bubbleH = [single](66 * $script:Dpi)
        $fishTop = [single]($bubbleTop + $bubbleH + (10 * $script:Dpi))
    }
    $targetH = [int]($fishTop + $m + $padBottom)

    if ($targetH -ne $script:WinH) {
        $script:WinH = [int]$targetH
        # Keep the whole card on the desktop; expanding near the top must not push
        # the panel off-screen, expanding near the bottom grows upwards. Use the
        # virtual screen (all monitors), not just the primary one.
        $wa = [System.Windows.Forms.SystemInformation]::VirtualScreen
        $nx = [int][Math]::Max($wa.Left, [Math]::Min($wa.Right - $script:WinW, $script:Form.Left))
        $ny = [int][Math]::Max($wa.Top, [Math]::Min($wa.Bottom - $script:WinH, $script:Form.Top))
        if ($wa.Bottom - $script:WinH -lt $wa.Top) { $ny = [int]$wa.Top }
        # size + position together: a separate Size then Left/Top produces two
        # WM_WINDOWPOSCHANGED rounds and a visible flash when the card grows.
        $script:Form.MoveResize($nx, $ny, [int]$script:WinW, [int]$script:WinH)
    }
    if ($script:PendingSave) { $script:PendingSave = $false; Save-Config }

    if ($script:Canvas -eq $null -or $script:Canvas.Width -ne $script:WinW -or $script:Canvas.Height -ne $script:WinH) {
        if ($script:Canvas -ne $null) { $script:G.Dispose(); $script:Canvas.Dispose() }
        $script:Canvas = [System.Drawing.Bitmap]::new([int]$script:WinW, [int]$script:WinH, [System.Drawing.Imaging.PixelFormat]::Format32bppPArgb)
        $script:G = [System.Drawing.Graphics]::FromImage($script:Canvas)
    }
    $g = $script:G
    $g.Clear([System.Drawing.Color]::Transparent)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality

    if ($script:Expanded) {
        $panelH = [single](10 * $script:Dpi)
        foreach ($row in $rows) { $panelH = [single]($panelH + $row.h) }
        $panelH = [single]($panelH + (10 * $script:Dpi))
        Draw-RoundRect $g 0 0 $script:WinW $panelH (14 * $script:Dpi) $script:C.card $script:C.cardEdge
        [void](Render-Rows $g $rows)
    } else {
        Draw-Bubble $g
    }

    $fishX = [single]($script:WinW - $m - (12 * $script:Dpi))
    Draw-Fish $g $fishX $fishTop $m
    $script:FishRect = [System.Drawing.Rectangle]::new([int]$fishX, [int]$fishTop, [int]$m, [int]$m)
    $script:Form.Render($script:Canvas)
}

# -------------------------------------------------------------------- menu ---
$script:Form = New-Object FatFishDesktop.LayeredForm
$script:Form.Text = 'FatFishDesktop'
Read-Config
$script:Form.Location = [System.Drawing.Point]::new([int]$script:DefX, [int]$script:DefY)
$script:WinH = 0
$initH = [int](Get-MascotSize) + [int](96 * $script:Dpi)
$script:Form.Size = [System.Drawing.Size]::new([int]$script:WinW, [int]$initH)
$script:WinH = $script:Form.Size.Height

$script:Menu = New-Object System.Windows.Forms.ContextMenuStrip
$script:Menu.ShowImageMargin = $false
$script:Menu.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', [single](9 * $script:UiScale))
$script:MiExpand = $script:Menu.Items.Add('')
$script:MiSize = New-Object System.Windows.Forms.ToolStripMenuItem
$script:MiSmall = New-Object System.Windows.Forms.ToolStripMenuItem
$script:MiMedium = New-Object System.Windows.Forms.ToolStripMenuItem
$script:MiLarge = New-Object System.Windows.Forms.ToolStripMenuItem
[void]$script:MiSize.DropDownItems.Add($script:MiSmall)
[void]$script:MiSize.DropDownItems.Add($script:MiMedium)
[void]$script:MiSize.DropDownItems.Add($script:MiLarge)
[void]$script:Menu.Items.Add($script:MiSize)
$script:MiSound = New-Object System.Windows.Forms.ToolStripMenuItem
[void]$script:Menu.Items.Add($script:MiSound)
$script:MiAutostart = New-Object System.Windows.Forms.ToolStripMenuItem
[void]$script:Menu.Items.Add($script:MiAutostart)
$script:MiKeep = New-Object System.Windows.Forms.ToolStripMenuItem
[void]$script:Menu.Items.Add($script:MiKeep)
$script:MiHide = New-Object System.Windows.Forms.ToolStripMenuItem
[void]$script:Menu.Items.Add($script:MiHide)
$script:MiReset = $script:Menu.Items.Add('')
[void]$script:Menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
$script:MiQuit = $script:Menu.Items.Add('')

function Update-MenuText {
    if ($script:Expanded) { $script:MiExpand.Text = [string]$script:S.labels.collapse } else { $script:MiExpand.Text = [string]$script:S.labels.expand }
    $script:MiSize.Text = [string]$script:S.labels.size
    $script:MiSmall.Text = [string]$script:S.labels.sizeSmall
    $script:MiMedium.Text = [string]$script:S.labels.sizeMedium
    $script:MiLarge.Text = [string]$script:S.labels.sizeLarge
    $script:MiSmall.Checked = ($script:ScaleIndex -eq 0)
    $script:MiMedium.Checked = ($script:ScaleIndex -eq 1)
    $script:MiLarge.Checked = ($script:ScaleIndex -eq 2)
    $script:MiSound.Text = [string]$script:S.labels.alertSound
    $script:MiSound.Checked = [bool]$script:AlertSound
    $script:MiAutostart.Text = [string]$script:S.labels.autostart
    $script:MiAutostart.Checked = (Test-Autostart)
    $script:MiKeep.Text = [string]$script:S.labels.keepRunning
    $script:MiKeep.Checked = [bool]$script:KeepAfterExit
    $script:MiHide.Text = [string]$script:S.labels.hide
    $script:MiReset.Text = [string]$script:S.labels.reset
    $script:MiQuit.Text = [string]$script:S.labels.quit
}

function Set-Expanded([bool]$value) {
    $script:Expanded = $value
    $script:PendingSave = $true
}

function Hide-Widget {
    # Runtime-only: the fish goes out of the way, but the process stays alive and
    # keeps polling, so the next launch request brings it straight back. Hiding is
    # deliberately not persisted - a hidden fish at the next login would look dead.
    $script:Hidden = $true
    try { $script:Form.Hide() } catch { }
}

function Show-Widget {
    if (-not $script:Hidden) { return }
    $script:Hidden = $false
    try {
        $script:Form.Show()
        $script:Form.TopMost = $true
    } catch { }
    $script:NeedsRender = $true
}

Update-MenuText
$script:Menu.Add_Opening({ param($s, $e) Update-MenuText })
$script:MiExpand.Add_Click({ param($s, $e) Set-Expanded (-not $script:Expanded) })
$script:MiSmall.Add_Click({ param($s, $e) $script:ScaleIndex = 0; Save-Config })
$script:MiMedium.Add_Click({ param($s, $e) $script:ScaleIndex = 1; Save-Config })
$script:MiLarge.Add_Click({ param($s, $e) $script:ScaleIndex = 2; Save-Config })
$script:MiSound.Add_Click({
        param($s, $e)
        $script:AlertSound = -not $script:AlertSound
        Save-Config
        if ($script:AlertSound) { try { [System.Media.SystemSounds]::Asterisk.Play() } catch { } }
    })
$script:MiAutostart.Add_Click({
        param($s, $e)
        # Re-read the shortcut every time: it is the source of truth, so toggling
        # never drifts from what Windows will actually do at the next login.
        Set-Autostart (-not (Test-Autostart))
        $script:NeedsRender = $true
    })
$script:MiKeep.Add_Click({
        param($s, $e)
        $script:KeepAfterExit = -not $script:KeepAfterExit
        Save-Config
    })
$script:MiHide.Add_Click({ param($s, $e) Hide-Widget })
$script:MiReset.Add_Click({
        param($s, $e)
        Get-DefaultPos
        $script:Form.Left = [int]$script:DefX
        $script:Form.Top = [int]$script:DefY
        Save-Config
    })
$script:MiQuit.Add_Click({ param($s, $e) $script:Running = $false })

# ------------------------------------------------------------------ events ---
function Write-DragLog([string]$text) {
    if (-not $env:FATFISH_DEBUG) { return }
    try { Add-Content -LiteralPath (Join-Path $env:TEMP 'fatfish-drag.log') -Value (([Environment]::TickCount).ToString() + ' ' + $text) } catch { }
}

$script:Form.Add_MouseDown({
        param($s, $e)
        if ($e.Button -eq [System.Windows.Forms.MouseButtons]::Left) {
            # Anchor the drag in *screen* coordinates: client coordinates shift
            # as the window moves, which made the delta self-cancelling (the
            # card crawled at half speed and jittered on every event).
            $screenPos = [System.Windows.Forms.Cursor]::Position
            $script:Drag = @{ sx = $screenPos.X; sy = $screenPos.Y; wx = $script:Form.Left; wy = $script:Form.Top; moved = $false }
            $script:Dragging = $false
            $script:Form.Capture = $true
            Write-DragLog ('down screen=' + $screenPos.X + ',' + $screenPos.Y + ' form=' + $script:Form.Left + ',' + $script:Form.Top + ' client=' + $e.X + ',' + $e.Y)
        } elseif ($e.Button -eq [System.Windows.Forms.MouseButtons]::Right) {
            $script:Menu.Show([System.Windows.Forms.Cursor]::Position)
        }
    })
$script:Form.Add_MouseMove({
        param($s, $e)
        if ($script:Drag -eq $null) { return }
        $screenPos = [System.Windows.Forms.Cursor]::Position
        $dx = $screenPos.X - $script:Drag.sx
        $dy = $screenPos.Y - $script:Drag.sy
        Write-DragLog ('move screen=' + $screenPos.X + ',' + $screenPos.Y + ' d=' + $dx + ',' + $dy + ' client=' + $e.X + ',' + $e.Y)
        if (-not $script:Drag.moved -and ([Math]::Abs($dx) + [Math]::Abs($dy)) -lt (4 * $script:Dpi)) { return }
        $script:Drag.moved = $true
        $newX = [int]($script:Drag.wx + $dx)
        $newY = [int]($script:Drag.wy + $dy)
        $va = [System.Windows.Forms.SystemInformation]::VirtualScreen
        $newX = [int][Math]::Max($va.Left - $script:WinW + 60, [Math]::Min($va.Right - 60, $newX))
        $newY = [int][Math]::Max($va.Top, [Math]::Min($va.Bottom - 60, $newY))
        if ($newX -eq $script:Form.Left -and $newY -eq $script:Form.Top) { return }
        # One atomic move per mouse event. Moving Left and Top separately (and
        # letting the render loop reposition the window too) is what made the
        # fish flicker while dragging.
        $script:Dragging = $true
        $script:Form.MoveTo($newX, $newY)
    })
$script:Form.Add_MouseUp({
        param($s, $e)
        if ($e.Button -ne [System.Windows.Forms.MouseButtons]::Left) { return }
        if ($script:Drag -eq $null) { return }
        $moved = $script:Drag.moved
        $script:Drag = $null
        $script:Form.Capture = $false
        $script:Dragging = $false
        Write-DragLog ('up moved=' + $moved + ' form=' + $script:Form.Left + ',' + $script:Form.Top)
        if ($moved) {
            Save-Config
        } else {
            $pt = [System.Drawing.Point]::new([int]$e.X, [int]$e.Y)
            if ($script:StatusInfo.alert -and ($script:AlertHit.Contains($pt) -or $script:BubbleRect.Contains($pt))) {
                # The alert card is the popup: clicking it raises DSH so the
                # approval can be answered without hunting for the window.
                try { [void][FatFishDesktop.HostFocus]::Focus() } catch { }
            } elseif ($script:FishRect.Contains($pt)) {
                Set-Expanded (-not $script:Expanded)
            }
        }
        $script:NeedsRender = $true
    })

# --------------------------------------------------------------- self test ---
function Save-Composite($canvas, [string]$path, [System.Drawing.Color]$bg) {
    $out = [System.Drawing.Bitmap]::new([int]$canvas.Width, [int]$canvas.Height, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($out)
    $brush = New-Brush $bg
    $g.FillRectangle($brush, 0, 0, $out.Width, $out.Height)
    $brush.Dispose()
    $g.DrawImageUnscaled($canvas, 0, 0)
    $g.Dispose()
    $out.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
    $out.Dispose()
}

if ($SelfTest) {
    if (-not (Test-Path -LiteralPath $SelfTest)) { New-Item -ItemType Directory -Path $SelfTest -Force | Out-Null }
    Poll-State
    # Preview-only: render the allowed/rejected flash even though a real run would
    # only show it when the snapshot changes after startup.
    if ($script:State -ne $null -and $script:State.lastApproval -ne $null) { Set-ApprovalToast $script:State.lastApproval }
    $script:StatusInfo = Get-StatusInfo
    $script:Expanded = $false
    Render-Frame
    Save-Composite $script:Canvas (Join-Path $SelfTest 'collapsed-light.png') ([System.Drawing.Color]::FromArgb(255, 238, 242, 248))
    Save-Composite $script:Canvas (Join-Path $SelfTest 'collapsed-dark.png') ([System.Drawing.Color]::FromArgb(255, 32, 39, 51))
    $script:Expanded = $true
    $script:StatusInfo = Get-StatusInfo
    Render-Frame
    Save-Composite $script:Canvas (Join-Path $SelfTest 'expanded-light.png') ([System.Drawing.Color]::FromArgb(255, 238, 242, 248))
    Save-Composite $script:Canvas (Join-Path $SelfTest 'expanded-dark.png') ([System.Drawing.Color]::FromArgb(255, 32, 39, 51))
    $script:Fish.Dispose()
    exit 0
}

# -------------------------------------------------------------------- loop ---
$script:StatusInfo = Get-StatusInfo
if (-not $script:Hidden) {
    $script:Form.Show()
    Render-Frame
}
$exitAt = 0
if ($ExitAfterMs -gt 0) { $exitAt = [Environment]::TickCount + $ExitAfterMs }
$hideAt = 0
if ($HideAfterMs -gt 0) { $hideAt = [Environment]::TickCount + $HideAfterMs }

while ($script:Running) {
    [System.Windows.Forms.Application]::DoEvents()
    $nowTick = [Environment]::TickCount
    if (($nowTick - $script:LastPoll) -ge 100) {
        Poll-State
        $script:LastPoll = $nowTick
        $script:StatusInfo = Get-StatusInfo
        # A second launcher (desktop\launch-widget.vbs, or the Host relaunching
        # the widget) drops a request file when it cannot take the mutex; that is
        # how a hidden fish is asked to come back.
        try {
            if (Test-Path -LiteralPath $script:ShowPath) {
                Remove-Item -LiteralPath $script:ShowPath -Force
                Show-Widget
            }
        } catch { }
        # Honour the "keep the fish after DSH quits" choice, but only once this
        # run has actually seen a live Host: a widget started at login (autostart)
        # must wait for DSH instead of quitting on a stale snapshot.
        $stateAge = Get-StateAge
        if ($stateAge -lt 7000) { $script:SawFresh = $true }
        if (-not $script:KeepAfterExit -and $script:SawFresh -and $stateAge -gt 30000) {
            $script:Running = $false
        }
    }
    $frameInterval = 55
    if (-not $script:StatusInfo.animate) { $frameInterval = 120 }
    if ($script:Hidden) {
        # Hidden: nothing to paint, just keep the event loop and the poll alive.
        $script:LastFrame = $nowTick
    } elseif ($script:Dragging) {
        # While the user drags, moving the window is the only thing that should
        # touch it: no re-render, no resize, no re-layer.
        $script:LastFrame = $nowTick
    } elseif (($nowTick - $script:LastFrame) -ge $frameInterval -or $script:NeedsRender) {
        $script:StatusInfo = Get-StatusInfo
        Render-Frame
        $script:NeedsRender = $false
        $script:LastFrame = $nowTick
    }
    if ($hideAt -gt 0 -and $nowTick -ge $hideAt) { $hideAt = 0; Hide-Widget }
    if ($exitAt -gt 0 -and $nowTick -ge $exitAt) { $script:Running = $false }
    Start-Sleep -Milliseconds 12
}

try { $script:Form.Close() } catch { }
try { $script:Mutex.ReleaseMutex() } catch { }
try { if (Test-Path -LiteralPath $script:PidPath) { Remove-Item -LiteralPath $script:PidPath -Force } } catch { }
