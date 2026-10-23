param(
    [Parameter(Mandatory = $true)]
    [string]$Port,
    [switch]$ResetDevice,
    [ValidateRange(1, 300)]
    [int]$DurationSeconds = 15,
    [string]$OutputPath = (Join-Path $PSScriptRoot '../_esp32_status.txt')
)

$serialPort = New-Object System.IO.Ports.SerialPort $Port,115200,None,8,One
$serialPort.DtrEnable = $false
$serialPort.RtsEnable = $false
$serialPort.ReadTimeout = 1000
$buffer = New-Object System.Text.StringBuilder
try {
    $serialPort.Open()
    if ($ResetDevice) {
        Start-Sleep -Milliseconds 200
        $serialPort.RtsEnable = $true
        Start-Sleep -Milliseconds 100
        $serialPort.RtsEnable = $false
    }
    $deadline = (Get-Date).AddSeconds($DurationSeconds)
    while ((Get-Date) -lt $deadline) {
        try {
            [void]$buffer.AppendLine($serialPort.ReadLine())
        } catch [System.TimeoutException] {
            continue
        }
    }
} finally {
    if ($serialPort.IsOpen) { $serialPort.Close() }
    $serialPort.Dispose()
}
$buffer.ToString() | Out-File -FilePath $OutputPath -Encoding utf8
Write-Output "Serial log written to $OutputPath"
