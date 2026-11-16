param([string]$ProcessName = 'DeepSeek Harness')

# Bring the Harness window to the foreground so a click on the traffic-light card
# actually shows the session that was just selected. Runs once and exits.

$ErrorActionPreference = 'SilentlyContinue'

Add-Type -Namespace TLFocus -Name Win -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
[DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
[DllImport("user32.dll")] public static extern void SwitchToThisWindow(IntPtr h, bool alt);
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
[DllImport("user32.dll")] public static extern bool AttachThreadInput(uint attach, uint attachTo, bool on);
[DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
[DllImport("user32.dll")] public static extern void keybd_event(byte key, byte scan, uint flags, UIntPtr extra);
'@

$proc = Get-Process -Name $ProcessName -ErrorAction SilentlyContinue |
    Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero } |
    Select-Object -First 1
if (-not $proc) { Write-Output 'focused=no-window'; exit 0 }

$hwnd = $proc.MainWindowHandle

# Restore first: an iconic window cannot be activated reliably.
if ([TLFocus.Win]::IsIconic($hwnd)) { [void][TLFocus.Win]::ShowWindow($hwnd, 9) }

$done = $false
for ($attempt = 0; $attempt -lt 3 -and -not $done; $attempt++) {
    switch ($attempt) {
        0 {
            # Alt+Tab semantics; works from a background process in most cases.
            [TLFocus.Win]::SwitchToThisWindow($hwnd, $true)
        }
        1 {
            # Attach to the foreground thread so SetForegroundWindow is allowed.
            $foreground = [TLFocus.Win]::GetForegroundWindow()
            $target = [uint32]0
            $fgThread = [TLFocus.Win]::GetWindowThreadProcessId($foreground, [ref]$target)
            $self = [TLFocus.Win]::GetCurrentThreadId()
            if ($fgThread -ne 0 -and $fgThread -ne $self) {
                [void][TLFocus.Win]::AttachThreadInput($self, $fgThread, $true)
                [void][TLFocus.Win]::BringWindowToTop($hwnd)
                [void][TLFocus.Win]::SetForegroundWindow($hwnd)
                [void][TLFocus.Win]::AttachThreadInput($self, $fgThread, $false)
            } else {
                [void][TLFocus.Win]::SetForegroundWindow($hwnd)
            }
        }
        default {
            # Foreground lock fallback: a synthetic Alt release clears the lock.
            [TLFocus.Win]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero)
            [TLFocus.Win]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
            try {
                $shell = New-Object -ComObject WScript.Shell
                $shell.AppActivate($proc.Id) | Out-Null
            } catch {
                [void][TLFocus.Win]::SetForegroundWindow($hwnd)
            }
        }
    }
    Start-Sleep -Milliseconds 250
    $done = ([TLFocus.Win]::GetForegroundWindow() -eq $hwnd)
}

if ($done) { Write-Output 'focused=1' } else { Write-Output 'focused=0' }
exit 0
