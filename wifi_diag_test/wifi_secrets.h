// このファイルは .gitignore 対象です(機密情報のためコミットされません)。
#pragma once

#define WIFI_SSID     "Pixel_5747"
#define WIFI_PASSWORD "q3dhfwv6jkf9vei"

// フリートハブ(web-controller のカスタムサーバー)のアドレス
// 注意: PCのWi-Fi IPはDHCPで変わることがあるため、接続できない場合はまず
// `Get-NetIPAddress -InterfaceAlias "Wi-Fi" -AddressFamily IPv4` で再確認すること。
#define FLEET_HUB_HOST "172.22.112.84" // 別PCでFleet Hubを起動(TCP 3000到達確認済み)
#define FLEET_HUB_PORT 3000
