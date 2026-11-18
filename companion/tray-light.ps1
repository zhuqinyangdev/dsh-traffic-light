param(
    [string]$BaseUrl = 'http://127.0.0.1:3080/api/traffic-light/state',
    [int]$RefreshMs = 1000
)

# Windows notification-area (tray) lamp for DeepSeek Harness sessions.
# Three stacked dots: red (waiting for you / failed), yellow (running), green (finished,
# unread). A dot is only drawn when its count is above zero, so "nothing to do" leaves a
# single dim dot. Runs as its own process, so closing the always-on-top card keeps the icon.

$ErrorActionPreference = 'Stop'

$createdNew = $false
$script:mutex = New-Object System.Threading.Mutex($true, 'Local\dsh-traffic-light-tray', [ref]$createdNew)
if (-not $createdNew) {
    # Another tray lamp already owns the notification area.
    exit 0
}

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

Add-Type -Namespace TLTray -Name Win -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
[DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool DestroyIcon(IntPtr hIcon);
'@

$script:stateUrl = $BaseUrl
$script:readUrl = ($BaseUrl -replace '/state$', '/read')
$script:desktopUrl = ($BaseUrl -replace '/state$', '/desktop')
$script:focusUrl = ($BaseUrl -replace '/state$', '/focus')
$script:focusAckUrl = ($BaseUrl -replace '/state$', '/focus/ack')
$script:waitingList = @()
$script:failures = 0
$script:iconSig = ''
$script:stopping = $false

function Invoke-State {
    $req = [System.Net.WebRequest]::Create($script:stateUrl)
    $req.Timeout = 1200
    $req.Proxy = $null
    $resp = $req.GetResponse()
    try {
        $stream = $resp.GetResponseStream()
        $reader = New-Object System.IO.StreamReader($stream, [System.Text.Encoding]::UTF8)
        try {
            return (ConvertFrom-Json $reader.ReadToEnd())
        } finally {
            $reader.Dispose()
        }
    } finally {
        $resp.Dispose()
    }
}

function Invoke-Post($url, $payload) {
    $json = $payload | ConvertTo-Json -Compress
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
    $req = [System.Net.WebRequest]::Create($url)
    $req.Method = 'POST'
    $req.ContentType = 'application/json; charset=utf-8'
    $req.Timeout = 1500
    $req.Proxy = $null
    $req.ContentLength = $bytes.Length
    $stream = $req.GetRequestStream()
    try {
        $stream.Write($bytes, 0, $bytes.Length)
    } finally {
        $stream.Dispose()
    }
    $resp = $req.GetResponse()
    $resp.Dispose()
}

# Draw the lamp icon: only the dots whose count is non-zero. One dot fills the icon, so a
# single active state stays readable at 16x16 in the tray.
function New-LampIcon([int]$red, [int]$yellow, [int]$green) {
    $bmp = New-Object System.Drawing.Bitmap 32, 32
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.Clear([System.Drawing.Color]::Transparent)

    $dots = @()
    if ($red -gt 0) { $dots += ,@(248, 81, 73) }
    if ($yellow -gt 0) { $dots += ,@(210, 153, 34) }
    if ($green -gt 0) { $dots += ,@(63, 185, 80) }
    if ($dots.Count -eq 0) { $dots += ,@(110, 118, 129) }

    $n = $dots.Count
    if ($n -eq 1) {
        $radius = 9.5
        $ys = @(16.0)
    } elseif ($n -eq 2) {
        $radius = 6.2
        $ys = @(9.2, 22.8)
    } else {
        $radius = 4.6
        $ys = @(6.8, 16.0, 25.2)
    }

    for ($i = 0; $i -lt $n; $i++) {
        $rgb = $dots[$i]
        $color = [System.Drawing.Color]::FromArgb(255, [int]$rgb[0], [int]$rgb[1], [int]$rgb[2])
        $brush = New-Object System.Drawing.SolidBrush($color)
        $y = [double]$ys[$i]
        $g.FillEllipse($brush, [float](16 - $radius), [float]($y - $radius), [float](2 * $radius), [float](2 * $radius))
        $brush.Dispose()
    }

    $g.Dispose()
    $hicon = $bmp.GetHicon()
    $bmp.Dispose()
    return [System.Drawing.Icon]::FromHandle($hicon)
}

function Open-Card {
    try {
        Invoke-Post $script:desktopUrl @{ action = 'open' } | Out-Null
    } catch {
        # host may be busy restarting
    }
}

function Invoke-Focus([string]$sessionId) {
    if (-not $sessionId) { return $false }
    try {
        Invoke-Post $script:focusUrl @{ sessionId = $sessionId } | Out-Null
        return $true
    } catch {
        return $false
    }
}

# Bring the app forward and land on the session that is waiting for the user, so the
# question / approval card that was closed is on screen again.
function Jump-ToWaiting([string]$sessionId) {
    if ($sessionId) { [void](Invoke-Focus $sessionId) }
    Open-Harness
}

function Update-WaitingMenu {
    $sub = $script:miWaiting.DropDownItems
    $sub.Clear()
    if ($script:waitingList.Count -eq 0) {
        $none = $sub.Add('暂无待处理')
        $none.Enabled = $false
        return
    }
    foreach ($item in $script:waitingList) {
        $label = [string]$item.label
        if (-not $label) { $label = [string]$item.id }
        if ($item.reason) { $label = $label + '  ·  ' + [string]$item.reason }
        if ($label.Length -gt 60) { $label = $label.Substring(0, 60) + '…' }
        $mi = $sub.Add($label)
        $mi.Tag = [string]$item.id
        $mi.add_Click({
            param($sender, $eventArgs)
            Jump-ToWaiting ([string]$sender.Tag)
        })
    }
}

function Open-Harness {    try {
        $proc = Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue |
            Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero } |
            Select-Object -First 1
        if (-not $proc) { return }
        $hwnd = $proc.MainWindowHandle
        if ([TLTray.Win]::IsIconic($hwnd)) {
            [void][TLTray.Win]::ShowWindow($hwnd, 9)
        }
        try {
            $shell = New-Object -ComObject WScript.Shell
            if ($shell.AppActivate($proc.Id)) { return }
        } catch {
            # fall through to the plain Win32 call
        }
        [void][TLTray.Win]::SetForegroundWindow($hwnd)
    } catch {
        # nothing to focus
    }
}

[System.Windows.Forms.Application]::EnableVisualStyles()

$script:tray = New-Object System.Windows.Forms.NotifyIcon
$script:tray.Icon = New-LampIcon 0 0 0
$script:tray.Text = '会话红绿灯  正在连接…'
$script:tray.Visible = $true

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$miWaiting = $menu.Items.Add('跳到等待中的会话')
$miCard = $menu.Items.Add('显示桌面小窗')
$miOpen = $menu.Items.Add('打开 Harness')
$miRead = $menu.Items.Add('全部已读')
[void]$menu.Items.Add('-')
$miQuit = $menu.Items.Add('退出托盘灯')
$script:miWaiting = $miWaiting
$script:tray.ContextMenuStrip = $menu

$menu.add_Opening({ Update-WaitingMenu })

$miCard.add_Click({ Open-Card })

$miOpen.add_Click({ Open-Harness })

$miRead.add_Click({
    try {
        Invoke-Post $script:readUrl @{ all = $true } | Out-Null
    } catch {
        # ignore
    }
})

$script:tray.add_MouseClick({
    param($sender, $eventArgs)
    if ($eventArgs.Button -eq [System.Windows.Forms.MouseButtons]::Left) {
        # 1) if the always-on-top card was closed, bring it back
        try {
            $data = Invoke-State
            $desktop = $data.desktop
            if ($desktop -and -not $desktop.running -and $desktop.supported -ne $false) {
                Open-Card
            }
        } catch {
            # state not reachable; still try to raise the app
        }
        # 2) if something is waiting for the user, land on it so the card shows again
        if ($script:waitingList.Count -gt 0) {
            Jump-ToWaiting ([string]$script:waitingList[0].id)
        } else {
            Open-Harness
        }
    }
})

function Stop-Tray {
    if ($script:stopping) { return }
    $script:stopping = $true
    try { $script:timer.Stop() } catch { }
    try {
        $script:tray.Visible = $false
        $script:tray.Dispose()
    } catch { }
    try { [System.Windows.Forms.Application]::Exit() } catch { }
}

$miQuit.add_Click({ Stop-Tray })

$script:timer = New-Object System.Windows.Forms.Timer
$script:timer.Interval = [Math]::Max(500, $RefreshMs)
$script:timer.add_Tick({
    if ($script:stopping) { return }

    try {
        $data = Invoke-State
        $script:failures = 0
    } catch {
        # The host is gone (or restarting): three misses in a row and the lamp disappears.
        $script:failures = $script:failures + 1
        if ($script:failures -ge 3) { Stop-Tray }
        return
    }

    $summary = $data.summary
    if (-not $summary) { return }
    $waiting = [int]$summary.waiting
    $errorCount = [int]$summary.error
    $anomaly = [int]$summary.anomaly
    $running = [int]$summary.running
    $unread = [int]$summary.unread

    # Sessions blocked on the user, oldest first - what a left click jumps to.
    $list = @()
    foreach ($item in @($data.sessions)) {
        if (-not $item) { continue }
        $w = $item.waiting
        if (-not ($item.state -eq 'waiting' -or $w)) { continue }
        $kind = ''
        if ($w) { $kind = [string]$w.kind }
        $reason = '需要您确认'
        if ($kind -eq 'approval') { $reason = '等待批准' }
        elseif ($kind -eq 'plan') { $reason = '计划待批准' }
        $since = 0.0
        if ($w -and $w.since) { $since = [double]$w.since }
        $list += [pscustomobject]@{
            id = [string]$item.id
            label = [string]$item.label
            reason = $reason
            since = $since
        }
    }
    $script:waitingList = @($list | Sort-Object -Property since)

    $sig = '{0}{1}{2}' -f ([int]($waiting + $errorCount + $anomaly -gt 0)), ([int]($running -gt 0)), ([int]($unread -gt 0))
    if ($sig -ne $script:iconSig) {
        $old = $script:tray.Icon
        $script:tray.Icon = New-LampIcon ($waiting + $errorCount + $anomaly) $running $unread
        $script:iconSig = $sig
        if ($old) { try { $old.Dispose() } catch { } }
    }

    $parts = @()
    if ($waiting -gt 0) { $parts += ('待确认 ' + $waiting) }
    if ($errorCount -gt 0) { $parts += ('出错 ' + $errorCount) }
    if ($anomaly -gt 0) { $parts += ('异常 ' + $anomaly) }
    if ($running -gt 0) { $parts += ('运行 ' + $running) }
    if ($unread -gt 0) { $parts += ('完成 ' + $unread) }
    if ($parts.Count -eq 0) {
        $text = '会话红绿灯  全部空闲'
    } else {
        $text = '会话红绿灯  ' + ($parts -join ' · ')
    }
    if ($text.Length -gt 63) { $text = $text.Substring(0, 63) }
    $script:tray.Text = $text
})

$script:timer.Start()
$null = $script:timer
[System.Windows.Forms.Application]::Run()
