param(
    [string]$BaseUrl = 'http://127.0.0.1:3080/api/traffic-light/state',
    [int]$RefreshMs = 1000,
    [double]$Opacity = 1,
    [int]$Width = 300
)

$ErrorActionPreference = 'Stop'

# Single instance: a second launch exits quietly.
$createdNew = $false
$mutex = New-Object System.Threading.Mutex($true, 'Local\dsh-traffic-light-companion', [ref]$createdNew)
if (-not $createdNew) { exit 0 }

Add-Type -AssemblyName PresentationFramework
Add-Type -AssemblyName PresentationCore
Add-Type -AssemblyName WindowsBase

$uri = [uri]$BaseUrl
$root = $uri.GetLeftPart([System.UriPartial]::Authority)
$stateUrl = $BaseUrl.TrimEnd('/')
$readUrl = "$stateUrl/read"
$focusUrl = "$stateUrl/focus"

$PALETTE = @{
    'green'     = '#3FB950'
    'yellow'    = '#D29922'
    'red'       = '#F85149'
    'red-blink' = '#F85149'
    'grey'      = '#6E7681'
}

$script:failures = 0
$script:blinkDots = @()
$script:anchored = $true
$script:stopping = $false
$script:ready = $false
$script:rowMetas = @{}
$script:lastSig = $null
# per-row controls that the title-width splitter has to resize in place
$script:rowLabels = @{}
$script:rowCols = @{}
$script:rowSpacers = @{}
$script:labelDrag = $null
# transparency is applied to the card background only, so text and lamps stay fully opaque
$script:opacity = 1.0
$script:BASE_ALPHA = 0xF2
$script:BORDER_ALPHA = 0x33
$script:borderBrush = $null

# --- win32 helpers: WPF's Left/Top is unreliable before the window settles ---
Add-Type -Namespace TL -Name Win -MemberDefinition @'
[DllImport("user32.dll", SetLastError = true)]
public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
'@
$SWP_NOSIZE = 0x0001
$SWP_NOZORDER = 0x0002
$SWP_NOACTIVATE = 0x0010

function Get-WinScale {
    try {
        $src = [System.Windows.PresentationSource]::FromVisual($win)
        if ($src) { return $src.CompositionTarget.TransformToDevice.M11 }
    } catch { }
    return 1.0
}

function Set-WinPos([double]$left, [double]$top) {
    try {
        $handle = (New-Object System.Windows.Interop.WindowInteropHelper($win)).Handle
        if ($handle -eq [IntPtr]::Zero) { return }
        $scale = Get-WinScale
        $x = [int][Math]::Round($left * $scale)
        $y = [int][Math]::Round($top * $scale)
        [TL.Win]::SetWindowPos($handle, [IntPtr]::Zero, $x, $y, 0, 0, ($SWP_NOSIZE -bor $SWP_NOZORDER -bor $SWP_NOACTIVATE)) | Out-Null
    } catch { }
}

# --- remembered window state (position + opacity) -------------------------
$stateDir = Join-Path $env:LOCALAPPDATA 'dsh-traffic-light'
$stateFile = Join-Path $stateDir 'companion.json'
$script:ui = @{ left = $null; top = $null; opacity = $null; anchored = $null; width = $null; height = $null; labelWidth = $null }
$script:saveTimer = $null

function Load-UiState {
    try {
        if (-not (Test-Path $stateFile)) { return }
        $raw = Get-Content -Raw -Encoding UTF8 $stateFile
        if (-not $raw) { return }
        $saved = $raw | ConvertFrom-Json
        if ($null -ne $saved.left -and $null -ne $saved.top) {
            $script:ui.left = [double]$saved.left
            $script:ui.top = [double]$saved.top
        }
        if ($null -ne $saved.opacity) { $script:ui.opacity = [double]$saved.opacity }
        if ($null -ne $saved.anchored) { $script:ui.anchored = [bool]$saved.anchored }
        if ($null -ne $saved.width -and $null -ne $saved.height) {
            $script:ui.width = [double]$saved.width
            $script:ui.height = [double]$saved.height
        }
        if ($null -ne $saved.labelWidth) { $script:ui.labelWidth = [double]$saved.labelWidth }
    } catch { }
}

function Save-UiState {
    try {
        if (-not (Test-Path $stateDir)) { New-Item -ItemType Directory -Path $stateDir -Force | Out-Null }
        $payload = @{
            left     = [double]$win.Left
            top      = [double]$win.Top
            opacity  = [double]$script:opacity
            anchored = [bool]$script:anchored
            width    = if ($win.SizeToContent -eq 'Manual') { [double]$win.Width } else { $null }
            height   = if ($win.SizeToContent -eq 'Manual') { [double]$win.Height } else { $null }
            labelWidth = $script:ui.labelWidth
        } | ConvertTo-Json -Compress
        [System.IO.File]::WriteAllText($stateFile, $payload, (New-Object System.Text.UTF8Encoding($false)))
    } catch { }
}

function Queue-SaveUiState {
    if ($null -eq $script:saveTimer) {
        $script:saveTimer = New-Object System.Windows.Threading.DispatcherTimer
        $script:saveTimer.Interval = [TimeSpan]::FromMilliseconds(600)
        $script:saveTimer.Add_Tick({
            $script:saveTimer.Stop()
            Save-UiState
        })
    }
    $script:saveTimer.Stop()
    $script:saveTimer.Start()
}


function Invoke-State {
    $req = [System.Net.WebRequest]::Create($stateUrl)
    $req.Timeout = 900
    $req.Proxy = $null
    $resp = $req.GetResponse()
    try {
        $reader = New-Object System.IO.StreamReader($resp.GetResponseStream(), [System.Text.Encoding]::UTF8)
        $text = $reader.ReadToEnd()
        $reader.Close()
    }
    finally { $resp.Close() }
    return $text | ConvertFrom-Json
}

function Invoke-Post($url, $payload) {
    $json = $payload | ConvertTo-Json -Compress
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
    $req = [System.Net.WebRequest]::Create($url)
    $req.Method = 'POST'
    $req.ContentType = 'application/json; charset=utf-8'
    $req.Timeout = 900
    $req.Proxy = $null
    $req.ContentLength = $bytes.Length
    $stream = $req.GetRequestStream()
    $stream.Write($bytes, 0, $bytes.Length)
    $stream.Close()
    $resp = $req.GetResponse()
    $resp.Close()
}

function Flash-Card($text) {
    # Short-lived feedback so a click visibly registers: the actual session switch happens
    # inside the Harness window, which the Host brings to the front.
    if ($null -eq $card) { return }
    $card.BorderBrush = New-Object System.Windows.Media.SolidColorBrush ([System.Windows.Media.ColorConverter]::ConvertFromString('#66D29922'))
    $script:flashTimer.Stop()
    $script:flashTimer.Start()
}

function Focus-Session($id) {
    if (-not $id) { return }
    try {
        Invoke-Post $focusUrl @{ sessionId = $id } | Out-Null
        Flash-Card '已切换'
    } catch {
        Flash-Card '打开失败'
    }
}

function Format-Age($ms) {
    if ($null -eq $ms) { return '' }
    # mirror the app's own Turn clock: 时长  <60s -> N秒, <60m -> N分N秒, else N小时N分
    $s = [math]::Max(0, [int]([double]$ms / 1000))
    if ($s -lt 60) { return "${s}秒" }
    $m = [int]($s / 60)
    if ($m -lt 60) { return ('{0}分{1}秒' -f $m, ($s % 60)) }
    return ('{0}小时{1}分' -f [int]($m / 60), ($m % 60))
}

# meta text + colour for one row, shared by the first paint and in-place updates
function Get-RowMeta($item, $data) {
    if ($item.waiting) {
        # a pending question is the one thing that really blocks the work: name it
        if ([string]$item.waiting.kind -eq 'question') { return @{ text = '需要您确认'; color = '#F85149' } }
        if ([string]$item.waiting.kind -eq 'approval') { return @{ text = '等待批准'; color = '#F85149' } }
        return @{ text = ('已等 ' + (Format-Age ([double]$data.now - [double]$item.waiting.since))); color = '#F85149' }
    }
    if ($item.state -eq 'error') { return @{ text = '出错'; color = '#F85149' } }
    if ($item.state -eq 'running') { return @{ text = ('用时 ' + (Format-Age $item.elapsedMs)); color = '#D29922' } }
    if ($item.state -eq 'done') { return @{ text = ''; color = '#8B949E' } }
    if ($item.endedReason) { return @{ text = [string]$item.endedReason; color = '#8B949E' } }
    return @{ text = ''; color = '#8B949E' }
}

# the title column is star-sized until the user drags the splitter; afterwards it is a
# fixed number of DIPs, which is what actually decides where the ellipsis sits
function Apply-LabelWidth {
    foreach ($key in @($script:rowLabels.Keys)) {
        $lbl = $script:rowLabels[$key]
        $col = $script:rowCols[$key]
        $spacer = $script:rowSpacers[$key]
        if ($null -eq $lbl -or $null -eq $col) { continue }
        if ($null -ne $script:ui.labelWidth) {
            $w = [double]$script:ui.labelWidth
            $col.Width = [System.Windows.GridLength]::new($w)
            $lbl.MaxWidth = $w
            # keep the text clear of the splitter hairline
            $lbl.Margin = New-Object System.Windows.Thickness(0, 0, 7, 0)
            if ($null -ne $spacer) { $spacer.Width = [System.Windows.GridLength]::new(1, [System.Windows.GridUnitType]::Star) }
        } else {
            $col.Width = [System.Windows.GridLength]::new(1, [System.Windows.GridUnitType]::Star)
            $lbl.MaxWidth = [double]::PositiveInfinity
            $lbl.Margin = New-Object System.Windows.Thickness(0)
            if ($null -ne $spacer) { $spacer.Width = [System.Windows.GridLength]::new(0) }
        }
    }
}

function Set-LabelWidth([double]$px) {
    # clamp against the card itself so the meta column never gets pushed out
    $available = 120.0
    if ($null -ne $card -and $card.ActualWidth -gt 0) { $available = [Math]::Max(80.0, $card.ActualWidth - 110.0) }
    $script:ui.labelWidth = [Math]::Round([Math]::Min([Math]::Max(48.0, $px), $available))
    Apply-LabelWidth
}

# ------------------------------------------------------------------ window

$win = New-Object System.Windows.Window
$win.WindowStyle = 'None'
$win.AllowsTransparency = $true
$win.Background = 'Transparent'
$win.Topmost = $true
$win.ShowInTaskbar = $false
$win.ResizeMode = 'CanResize'
$win.Title = '会话红绿灯'
$win.WindowStartupLocation = 'Manual'
$win.Width = $Width
$win.SizeToContent = 'Height'
$win.FontFamily = 'Microsoft YaHei UI'
# The window itself stays fully opaque: transparency belongs to the card background so the
# text and the lamps never fade (Window.Opacity would fade everything).
$win.Opacity = 1

Load-UiState
if ($null -ne $script:ui.opacity) {
    $script:opacity = [Math]::Max(0.3, [Math]::Min(1.0, [double]$script:ui.opacity))
} elseif ($Opacity -gt 0) {
    $script:opacity = [Math]::Max(0.3, [Math]::Min(1.0, [double]$Opacity))
}
if ($null -ne $script:ui.width -and $null -ne $script:ui.height) {
    $win.SizeToContent = 'Manual'
    $win.Width = [double]$script:ui.width
    $win.Height = [double]$script:ui.height
}
if ($null -ne $script:ui.anchored -and -not $script:ui.anchored) { $script:anchored = $false }
if (-not $script:anchored -and $null -ne $script:ui.left -and $null -ne $script:ui.top) {
    # restore before the window is first shown, so the initial placement never overwrites it
    $win.Left = [double]$script:ui.left
    $win.Top = [double]$script:ui.top
}

$card = New-Object System.Windows.Controls.Border
$card.CornerRadius = New-Object System.Windows.CornerRadius(12)
$card.Background = New-Object System.Windows.Media.SolidColorBrush ([System.Windows.Media.ColorConverter]::ConvertFromString('#F214161B'))
$card.BorderBrush = New-Object System.Windows.Media.SolidColorBrush ([System.Windows.Media.ColorConverter]::ConvertFromString('#33FFFFFF'))
$card.BorderThickness = New-Object System.Windows.Thickness(1)
$card.Padding = New-Object System.Windows.Thickness(10, 8, 10, 8)
$win.Content = $card

function Set-CardOpacity([double]$level) {
    $script:opacity = [Math]::Max(0.3, [Math]::Min(1.0, $level))
    $a = [int][Math]::Round($script:BASE_ALPHA * $script:opacity)
    $b = [int][Math]::Round($script:BORDER_ALPHA * $script:opacity)
    $card.Background = New-Object System.Windows.Media.SolidColorBrush ([System.Windows.Media.ColorConverter]::ConvertFromString(('#{0:X2}14161B' -f $a)))
    $script:borderBrush = New-Object System.Windows.Media.SolidColorBrush ([System.Windows.Media.ColorConverter]::ConvertFromString(('#{0:X2}FFFFFF' -f $b)))
    $card.BorderBrush = $script:borderBrush
}

Set-CardOpacity $script:opacity

$stack = New-Object System.Windows.Controls.Grid
$stackRow0 = New-Object System.Windows.Controls.RowDefinition
$stackRow0.Height = [System.Windows.GridLength]::Auto
$stackRow1 = New-Object System.Windows.Controls.RowDefinition
$stackRow1.Height = [System.Windows.GridLength]::Auto
# filler row: absorbs the extra space when the user gave the window an explicit size, so the
# resize grip really sits in the window's bottom-right corner
$stackRow2 = New-Object System.Windows.Controls.RowDefinition
$stackRow2.Height = [System.Windows.GridLength]::new(1, [System.Windows.GridUnitType]::Star)
$stack.RowDefinitions.Add($stackRow0)
$stack.RowDefinitions.Add($stackRow1)
$stack.RowDefinitions.Add($stackRow2)
$card.Child = $stack

$head = New-Object System.Windows.Controls.Grid
$head.Margin = New-Object System.Windows.Thickness(0, 0, 0, 4)
$head.ColumnDefinitions.Add((New-Object System.Windows.Controls.ColumnDefinition))
$headCol2 = New-Object System.Windows.Controls.ColumnDefinition
$headCol2.Width = [System.Windows.GridLength]::Auto
$head.ColumnDefinitions.Add($headCol2)

$headText = New-Object System.Windows.Controls.TextBlock
$headText.Text = '会话红绿灯'
$headText.FontSize = 11
$headText.FontWeight = 'SemiBold'
$headText.Foreground = New-Object System.Windows.Media.SolidColorBrush ([System.Windows.Media.ColorConverter]::ConvertFromString('#E6EDF3'))
$headText.VerticalAlignment = 'Center'
$head.Children.Add($headText) | Out-Null

$headCount = New-Object System.Windows.Controls.TextBlock
$headCount.FontSize = 10
$headCount.Foreground = New-Object System.Windows.Media.SolidColorBrush ([System.Windows.Media.ColorConverter]::ConvertFromString('#8B949E'))
$headCount.VerticalAlignment = 'Center'
$headCount.HorizontalAlignment = 'Right'
[System.Windows.Controls.Grid]::SetColumn($headCount, 1)
$head.Children.Add($headCount) | Out-Null

[System.Windows.Controls.Grid]::SetRow($head, 0)
$stack.Children.Add($head) | Out-Null

$scroll = New-Object System.Windows.Controls.ScrollViewer
$scroll.VerticalScrollBarVisibility = 'Auto'
$scroll.HorizontalScrollBarVisibility = 'Disabled'
$scroll.Margin = New-Object System.Windows.Thickness(0)
$scroll.MaxHeight = [Math]::Max(120, [int]([System.Windows.SystemParameters]::WorkArea.Height * 0.7))
[System.Windows.Controls.Grid]::SetRow($scroll, 1)

$rows = New-Object System.Windows.Controls.StackPanel
$scroll.Content = $rows
$stack.Children.Add($scroll) | Out-Null

# Resize grip in the bottom-right corner (the window frame is borderless). A plain Border is
# used instead of a Thumb: a Thumb needs a control template, and its drag events did not
# reach a layered (AllowsTransparency) window reliably.
$grip = New-Object System.Windows.Controls.Border
$grip.Width = 16
$grip.Height = 16
$grip.HorizontalAlignment = 'Right'
$grip.VerticalAlignment = 'Bottom'
$grip.Cursor = 'SizeNWSE'
$grip.Background = New-Object System.Windows.Media.SolidColorBrush ([System.Windows.Media.ColorConverter]::ConvertFromString('#01FFFFFF'))
$grip.CornerRadius = New-Object System.Windows.CornerRadius(4)
$grip.ToolTip = '拖动改变大小'
# 1/255 alpha instead of fully transparent: layered windows do not hit-test transparent pixels
$grip.Add_MouseEnter({ param($s, $e) $s.Background = New-Object System.Windows.Media.SolidColorBrush ([System.Windows.Media.ColorConverter]::ConvertFromString('#33FFFFFF')) })
$grip.Add_MouseLeave({ param($s, $e) $s.Background = New-Object System.Windows.Media.SolidColorBrush ([System.Windows.Media.ColorConverter]::ConvertFromString('#01FFFFFF')) })
[System.Windows.Controls.Grid]::SetRowSpan($grip, 3)
$script:dragGrip = $null
$grip.Add_MouseLeftButtonDown({
    param($s, $e)
    $script:dragGrip = @{
        x      = [System.Windows.Input.Mouse]::GetPosition($win).X
        y      = [System.Windows.Input.Mouse]::GetPosition($win).Y
        width  = [Math]::Max(160, $win.ActualWidth)
        height = [Math]::Max(50, $win.ActualHeight)
    }
    $win.SizeToContent = 'Manual'
    [void]$s.CaptureMouse()
    $e.Handled = $true
})
$grip.Add_MouseMove({
    param($s, $e)
    if ($null -eq $script:dragGrip) { return }
    $pos = [System.Windows.Input.Mouse]::GetPosition($win)
    $dx = $pos.X - $script:dragGrip.x
    $dy = $pos.Y - $script:dragGrip.y
    $win.Width = [Math]::Max(160, $script:dragGrip.width + $dx)
    $win.Height = [Math]::Max(50, $script:dragGrip.height + $dy)
    $e.Handled = $true
})
$grip.Add_MouseLeftButtonUp({
    param($s, $e)
    if ($null -eq $script:dragGrip) { return }
    $script:dragGrip = $null
    try { [void]$s.ReleaseMouseCapture() } catch { }
    Queue-SaveUiState
    if ($script:anchored) {
        [void]$win.Dispatcher.BeginInvoke([System.Windows.Threading.DispatcherPriority]::Loaded, [System.Action]{ Anchor-Window })
    }
    $e.Handled = $true
})
$stack.Children.Add($grip) | Out-Null

function Anchor-Window {
    if (-not $script:anchored) { return }
    $wa = [System.Windows.SystemParameters]::WorkArea
    $w = if ($win.SizeToContent -eq 'Manual' -and $win.Width -gt 0) { $win.Width } elseif ($win.ActualWidth -gt 0) { $win.ActualWidth } else { $Width }
    $h = if ($win.SizeToContent -eq 'Manual' -and $win.Height -gt 0) { $win.Height } elseif ($win.ActualHeight -gt 0) { $win.ActualHeight } else { 80 }
    $left = $wa.Right - $w - 16
    $top = $wa.Bottom - $h - 16
    if ($left -lt $wa.Left) { $left = $wa.Left }
    if ($top -lt $wa.Top) { $top = $wa.Top }
    $win.Left = $left
    $win.Top = $top
}

# drag by the header (position is only un-anchored when it actually moved)
$head.Cursor = 'SizeAll'
$head.Add_MouseLeftButtonDown({
    param($s, $e)
    $beforeLeft = $win.Left
    $beforeTop = $win.Top
    try { $win.DragMove() } catch { }
    if ([math]::Abs($win.Left - $beforeLeft) -gt 1 -or [math]::Abs($win.Top - $beforeTop) -gt 1) {
        $script:anchored = $false
        Queue-SaveUiState
    }
})

$menu = New-Object System.Windows.Controls.ContextMenu
$miOpen = New-Object System.Windows.Controls.MenuItem
$miOpen.Header = '打开 Harness'
$miOpen.Add_Click({ try { Start-Process $root } catch { } })
$menu.Items.Add($miOpen) | Out-Null

$miRead = New-Object System.Windows.Controls.MenuItem
$miRead.Header = '全部已读'
$miRead.Add_Click({ try { Invoke-Post $readUrl @{ all = $true } } catch { } })
$menu.Items.Add($miRead) | Out-Null

$miReanchor = New-Object System.Windows.Controls.MenuItem
$miReanchor.Header = '回到右下角'
$miReanchor.Add_Click({
    $script:anchored = $true
    Anchor-Window
    Queue-SaveUiState
})
$menu.Items.Add($miReanchor) | Out-Null

# drop the dragged size and let the card shrink back to its content again
$miAutoSize = New-Object System.Windows.Controls.MenuItem
$miAutoSize.Header = '恢复自适应大小'
$miAutoSize.Add_Click({
    $win.SizeToContent = 'Height'
    $win.Width = $Width
    $script:ui.width = $null
    $script:ui.height = $null
    $scroll.MaxHeight = [Math]::Max(120, [int]([System.Windows.SystemParameters]::WorkArea.Height * 0.7))
    Queue-SaveUiState
    if ($script:anchored) { Anchor-Window }
})
$menu.Items.Add($miAutoSize) | Out-Null

$miLabelAuto = New-Object System.Windows.Controls.MenuItem
$miLabelAuto.Header = '标题宽度自适应'
$miLabelAuto.Add_Click({
    $script:ui.labelWidth = $null
    Apply-LabelWidth
    Queue-SaveUiState
})
$menu.Items.Add($miLabelAuto) | Out-Null

$miOpacity = New-Object System.Windows.Controls.MenuItem
$miOpacity.Header = '不透明度'
foreach ($level in @(1.0, 0.9, 0.8, 0.7, 0.6, 0.5)) {
    $opt = New-Object System.Windows.Controls.MenuItem
    $opt.Header = ('{0}%' -f [int]($level * 100))
    $opt.Tag = $level
    $opt.Add_Click({
        param($s, $e)
        Set-CardOpacity ([double]$s.Tag)
        Queue-SaveUiState
    })
    $miOpacity.Items.Add($opt) | Out-Null
}
$menu.Items.Add($miOpacity) | Out-Null

$miQuit = New-Object System.Windows.Controls.MenuItem
$miQuit.Header = '退出'
$miQuit.Add_Click({
    $script:stopping = $true
    $win.Close()
})
$menu.Items.Add($miQuit) | Out-Null

$card.ContextMenu = $menu

$script:flashTimer = New-Object System.Windows.Threading.DispatcherTimer
$script:flashTimer.Interval = [TimeSpan]::FromMilliseconds(1100)
$script:flashTimer.Add_Tick({
    $script:flashTimer.Stop()
    if ($null -ne $card) {
        $card.BorderBrush = $script:borderBrush
    }
})

function Render($data) {
    $sessions = @($data.sessions)
    $visible = @($sessions | Where-Object { $_.color -ne 'grey' -or $_.unread })

    $summary = $data.summary
    $idle = 0
    if ($null -ne $summary.idle) { $idle = [int]$summary.idle }
    $bits = @()
    if ($summary.waiting -gt 0) { $bits += "待 $($summary.waiting)" }
    if ($summary.error -gt 0) { $bits += "错 $($summary.error)" }
    if ($summary.running -gt 0) { $bits += "跑 $($summary.running)" }
    if ($summary.unread -gt 0) { $bits += "新 $($summary.unread)" }
    if ($idle -gt 0) { $bits += "空闲 $idle" }
    if ($bits.Count -eq 0) { $headCount.Text = '全部空闲' } else { $headCount.Text = ($bits -join ' · ') }

    $max = [int]$data.maxLights
    if ($max -le 0) { $max = 6 }
    $shown = @($visible | Select-Object -First $max)

    # Rebuilding the rows every second kills hover tooltips, so only rebuild when the
    # row *structure* changes; otherwise just refresh the meta text in place.
    $sig = (@($shown | ForEach-Object {
        "$($_.id)|$($_.color)|$($_.unread)|$($_.state)|$($_.label)|$($_.children)"
    }) -join ';') + "|max=$max|n=$($shown.Count)"
    if ($sig -eq $script:lastSig -and $script:rowMetas.Count -eq $shown.Count) {
        foreach ($item in $shown) {
            $mb = $script:rowMetas[[string]$item.id]
            if ($null -ne $mb) {
                $m = Get-RowMeta $item $data
                if ($mb.Text -ne $m.text) { $mb.Text = $m.text }
                if ($mb.Tag -ne $m.color) {
                    $mb.Foreground = New-Object System.Windows.Media.SolidColorBrush ([System.Windows.Media.ColorConverter]::ConvertFromString($m.color))
                    $mb.Tag = $m.color
                }
            }
        }
        return
    }

    $script:lastSig = $sig
    $script:rowMetas = @{}
    $script:rowLabels = @{}
    $script:rowCols = @{}
    $script:rowSpacers = @{}
    $script:blinkDots = @()
    $rows.Children.Clear()

    foreach ($item in $shown) {
        $row = New-Object System.Windows.Controls.Border
        $row.CornerRadius = New-Object System.Windows.CornerRadius(6)
        $row.Background = 'Transparent'
        $row.Padding = New-Object System.Windows.Thickness(2, 2, 2, 2)
        $row.Cursor = 'Hand'
        $row.Tag = $item.id
        $row.ToolTip = ("{0}`n{1}" -f $item.title, $item.cwd)
        [System.Windows.Controls.ToolTipService]::SetInitialShowDelay($row, 250)
        [System.Windows.Controls.ToolTipService]::SetShowDuration($row, 60000)
        [System.Windows.Controls.ToolTipService]::SetBetweenShowDelay($row, 0)
        $row.Add_MouseLeftButtonUp({ param($s, $e) Focus-Session $s.Tag })
        $row.Add_MouseEnter({ param($s, $e) $s.Background = '#1FFFFFFF' })
        $row.Add_MouseLeave({ param($s, $e) $s.Background = 'Transparent' })

        $grid = New-Object System.Windows.Controls.Grid
        $gridCol1 = New-Object System.Windows.Controls.ColumnDefinition
        $grid.ColumnDefinitions.Add($gridCol1)
        # filler that only exists while the title column is pinned to a fixed width
        $gridSpacer = New-Object System.Windows.Controls.ColumnDefinition
        $gridSpacer.Width = [System.Windows.GridLength]::new(0)
        $grid.ColumnDefinitions.Add($gridSpacer)
        $gridCol3 = New-Object System.Windows.Controls.ColumnDefinition
        $gridCol3.Width = [System.Windows.GridLength]::Auto
        $grid.ColumnDefinitions.Add($gridCol3)

        $label = New-Object System.Windows.Controls.TextBlock
        $label.Text = [string]$item.label
        $label.FontSize = 11
        $label.TextTrimming = 'CharacterEllipsis'
        $label.VerticalAlignment = 'Center'
        if ($item.unread) { $label.FontWeight = 'SemiBold' }
        $label.Foreground = New-Object System.Windows.Media.SolidColorBrush ([System.Windows.Media.ColorConverter]::ConvertFromString('#E6EDF3'))
        $label.ToolTip = ("{0}`n工作区：{1}" -f $item.title, $(if ($item.workspace) { $item.workspace } else { '（未关联）' }))
        [System.Windows.Controls.ToolTipService]::SetInitialShowDelay($label, 250)
        [System.Windows.Controls.ToolTipService]::SetShowDuration($label, 60000)
        [System.Windows.Controls.ToolTipService]::SetBetweenShowDelay($label, 0)
        [System.Windows.Controls.Grid]::SetColumn($label, 0)
        $grid.Children.Add($label) | Out-Null
        $script:rowLabels[[string]$item.id] = $label
        $script:rowCols[[string]$item.id] = $gridCol1
        $script:rowSpacers[[string]$item.id] = $gridSpacer

        # title-width splitter: drag the hairline at the end of the name to trade space
        # between the title and the meta column
        $split = New-Object System.Windows.Controls.Border
        $split.Width = 6
        $split.HorizontalAlignment = 'Right'
        $split.Margin = New-Object System.Windows.Thickness(0, 1, -3, 1)
        $split.CornerRadius = New-Object System.Windows.CornerRadius(2)
        $split.Background = New-Object System.Windows.Media.SolidColorBrush ([System.Windows.Media.ColorConverter]::ConvertFromString('#01FFFFFF'))
        $split.Cursor = 'SizeWE'
        $split.Tag = [string]$item.id
        $split.ToolTip = '拖动调整标题宽度（双击恢复自适应）'
        $split.Add_MouseEnter({ param($s, $e) $s.Background = New-Object System.Windows.Media.SolidColorBrush ([System.Windows.Media.ColorConverter]::ConvertFromString('#44FFFFFF')) })
        $split.Add_MouseLeave({ param($s, $e) if ($null -eq $script:labelDrag) { $s.Background = New-Object System.Windows.Media.SolidColorBrush ([System.Windows.Media.ColorConverter]::ConvertFromString('#01FFFFFF')) } })
        $split.Add_MouseLeftButtonDown({
            param($s, $e)
            if ($e.ClickCount -ge 2) {
                $script:ui.labelWidth = $null
                Apply-LabelWidth
                Queue-SaveUiState
                $e.Handled = $true
                return
            }
            $own = $script:rowLabels[[string]$s.Tag]
            $start = $(if ($null -ne $script:ui.labelWidth) { [double]$script:ui.labelWidth } elseif ($null -ne $own) { [double]$own.ActualWidth } else { 120.0 })
            $s.CaptureMouse() | Out-Null
            $script:labelDrag = @{ startX = $e.GetPosition($win).X; start = $start }
            $s.Background = New-Object System.Windows.Media.SolidColorBrush ([System.Windows.Media.ColorConverter]::ConvertFromString('#66FFFFFF'))
            $e.Handled = $true
        })
        $split.Add_MouseMove({
            param($s, $e)
            if ($null -eq $script:labelDrag) { return }
            Set-LabelWidth ($script:labelDrag.start + ($e.GetPosition($win).X - $script:labelDrag.startX))
            $e.Handled = $true
        })
        $split.Add_MouseLeftButtonUp({
            param($s, $e)
            if ($null -eq $script:labelDrag) { return }
            $s.ReleaseMouseCapture()
            $script:labelDrag = $null
            $s.Background = New-Object System.Windows.Media.SolidColorBrush ([System.Windows.Media.ColorConverter]::ConvertFromString('#44FFFFFF'))
            Queue-SaveUiState
            $e.Handled = $true
        })
        $split.Add_MouseRightButtonUp({ })
        [System.Windows.Controls.Grid]::SetColumn($split, 0)
        $grid.Children.Add($split) | Out-Null

        $computed = Get-RowMeta $item $data
        $meta = $computed.text
        $metaColor = $computed.color

        $right = New-Object System.Windows.Controls.StackPanel
        $right.Orientation = 'Horizontal'
        $right.VerticalAlignment = 'Center'
        $right.Margin = New-Object System.Windows.Thickness(8, 0, 0, 0)
        [System.Windows.Controls.Grid]::SetColumn($right, 2)

        $metaBlock = New-Object System.Windows.Controls.TextBlock
        $metaBlock.Text = $meta
        $metaBlock.FontSize = 10
        $metaBlock.VerticalAlignment = 'Center'
        $metaBlock.Tag = $metaColor
        $metaBlock.Foreground = New-Object System.Windows.Media.SolidColorBrush ([System.Windows.Media.ColorConverter]::ConvertFromString($metaColor))
        $right.Children.Add($metaBlock) | Out-Null
        $script:rowMetas[[string]$item.id] = $metaBlock

        $lamp = New-Object System.Windows.Shapes.Ellipse
        $lamp.Width = 12
        $lamp.Height = 12
        $lamp.VerticalAlignment = 'Center'
        $lamp.Margin = New-Object System.Windows.Thickness(6, 0, 0, 0)
        $lamp.Fill = New-Object System.Windows.Media.SolidColorBrush ([System.Windows.Media.ColorConverter]::ConvertFromString($PALETTE[[string]$item.color]))
        $right.Children.Add($lamp) | Out-Null
        if ($item.color -eq 'red-blink' -or ($item.color -eq 'green' -and $item.unread)) { $script:blinkDots += $lamp }

        $grid.Children.Add($right) | Out-Null

        $row.Child = $grid
        $rows.Children.Add($row) | Out-Null
    }

    if ($shown.Count -eq 0) {
        $empty = New-Object System.Windows.Controls.TextBlock
        $empty.Text = '全部空闲'
        $empty.FontSize = 10
        $empty.Margin = New-Object System.Windows.Thickness(2, 1, 0, 0)
        $empty.Foreground = New-Object System.Windows.Media.SolidColorBrush ([System.Windows.Media.ColorConverter]::ConvertFromString('#6E7681'))
        $rows.Children.Add($empty) | Out-Null
    }

    # rows were just rebuilt, so re-apply the remembered title width to the new controls
    Apply-LabelWidth

    if ($script:anchored) {
        [void]$win.Dispatcher.BeginInvoke([System.Windows.Threading.DispatcherPriority]::Loaded, [System.Action]{ Anchor-Window })
    }
}

$tick = New-Object System.Windows.Threading.DispatcherTimer
$tick.Interval = [TimeSpan]::FromMilliseconds([math]::Max(300, $RefreshMs))
$tick.Add_Tick({
    if ($script:stopping) { return }
    try {
        $data = Invoke-State
        $script:failures = 0
        Render $data
    } catch {
        $script:failures++
        if ($script:failures -ge 3) {
            # host gone: stop polling and disappear
            $script:stopping = $true
            $tick.Stop()
            $blink.Stop()
            $win.Close()
        }
    }
})

$blink = New-Object System.Windows.Threading.DispatcherTimer
$blink.Interval = [TimeSpan]::FromMilliseconds(700)
$blink.Add_Tick({
    foreach ($bulb in $script:blinkDots) {
        if ($bulb.Opacity -gt 0.5) { $bulb.Opacity = 0.25 } else { $bulb.Opacity = 1.0 }
    }
})

$win.Add_ContentRendered({
    if ($script:anchored) {
        Anchor-Window
    } elseif ($null -ne $script:ui.left -and $null -ne $script:ui.top) {
        $vLeft = [System.Windows.SystemParameters]::VirtualScreenLeft
        $vTop = [System.Windows.SystemParameters]::VirtualScreenTop
        $vRight = $vLeft + [System.Windows.SystemParameters]::VirtualScreenWidth
        $vBottom = $vTop + [System.Windows.SystemParameters]::VirtualScreenHeight
        $w = if ($win.SizeToContent -eq 'Manual' -and $win.Width -gt 0) { $win.Width } elseif ($win.ActualWidth -gt 0) { $win.ActualWidth } else { $Width }
        $h = if ($win.SizeToContent -eq 'Manual' -and $win.Height -gt 0) { $win.Height } elseif ($win.ActualHeight -gt 0) { $win.ActualHeight } else { 60 }
        $left = [Math]::Max($vLeft, [Math]::Min([double]$script:ui.left, $vRight - $w))
        $top = [Math]::Max($vTop, [Math]::Min([double]$script:ui.top, $vBottom - $h))
        $win.Left = $left
        $win.Top = $top
        Set-WinPos $left $top
        # WPF may re-place the window while SizeToContent settles; re-assert briefly.
        $script:restoreLeft = $left
        $script:restoreTop = $top
        foreach ($delay in 280, 900, 1800) {
            $tm = New-Object System.Windows.Threading.DispatcherTimer
            $tm.Interval = [TimeSpan]::FromMilliseconds($delay)
            $tm.Add_Tick({
                param($s, $e)
                $s.Stop()
                if (-not $script:anchored) { Set-WinPos $script:restoreLeft $script:restoreTop }
            })
            $tm.Start()
        }
    }
    $tick.Start()
    $blink.Start()
    # only start remembering moves once the initial placement has settled
    $readyTimer = New-Object System.Windows.Threading.DispatcherTimer
    $readyTimer.Interval = [TimeSpan]::FromMilliseconds(2000)
    $readyTimer.Add_Tick({
        param($s, $e)
        $s.Stop()
        $script:ready = $true
    })
    $readyTimer.Start()
    try {
        $data = Invoke-State
        Render $data
    } catch { }
})

# remember wherever the user leaves it
$win.Add_LocationChanged({
    if (-not $script:ready) { return }
    if ($script:anchored) { return }
    Queue-SaveUiState
})

# When the user picked an explicit size, keep the row list inside the remaining space so the
# ScrollViewer shows a scrollbar instead of clipping rows.
$win.Add_SizeChanged({
    if ($win.SizeToContent -ne 'Manual') { return }
    $limit = [Math]::Max(40, $win.ActualHeight - 64)
    if ([Math]::Abs($scroll.MaxHeight - $limit) -gt 1) { $scroll.MaxHeight = $limit }
})

$win.Add_Closed({
    $script:stopping = $true
    try { $tick.Stop() } catch { }
    try { $blink.Stop() } catch { }
})

[void]$win.ShowDialog()
try { $mutex.ReleaseMutex() } catch { }
try { $mutex.Dispose() } catch { }
