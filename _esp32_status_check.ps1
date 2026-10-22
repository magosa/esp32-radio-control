$port = New-Object System.IO.Ports.SerialPort COM5,115200,None,8,One
$port.DtrEnable = $false
$port.RtsEnable = $false
$port.ReadTimeout = 3000
$port.Open()
Start-Sleep -Milliseconds 200
$port.RtsEnable = $true
Start-Sleep -Milliseconds 100
$port.RtsEnable = $false

$sb = New-Object System.Text.StringBuilder
$deadline = (Get-Date).AddSeconds(15)
while ((Get-Date) -lt $deadline) {
    try {
        $line = $port.ReadLine()
        [void]$sb.AppendLine($line)
    } catch [System.TimeoutException] {
        continue
    }
}
$port.Close()
$sb.ToString() | Out-File -FilePath "_esp32_status.txt" -Encoding utf8
