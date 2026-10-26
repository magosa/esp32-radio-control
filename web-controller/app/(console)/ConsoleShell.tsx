"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Bluetooth, Bot, Gamepad2, Settings2, Square, Wifi, WifiOff } from "lucide-react";
import { FleetSocketProvider, useFleetSocket } from "@/hooks/useFleetSocket";
import { useFleetAppearance } from "@/hooks/useFleetAppearance";
import styles from "./console.module.css";

const NAV = [
  { href: "/control", label: "制御", title: "フリート管理", Icon: Gamepad2 },
  { href: "/robots", label: "ロボット", title: "ロボット構成", Icon: Bot },
  { href: "/settings", label: "表示設定", title: "表示設定", Icon: Settings2 },
  { href: "/direct/bluetooth", label: "Bluetooth", title: "Bluetooth", Icon: Bluetooth },
] as const;

function ConsoleFrame({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const { status, emergencyStop } = useFleetSocket();
  const { appearance, theme, style } = useFleetAppearance();
  const connected = status === "connected";
  const connectionLabel = { connected: "ハブ接続中", connecting: "ハブ接続中…",
    disconnected: "ハブ未接続", error: "ハブ接続エラー" }[status];
  const current = NAV.find((item) => pathname === item.href || pathname.startsWith(`${item.href}/`));

  return <main className={styles.fleet} data-theme={theme} data-motion={appearance.motion ? "on" : "off"} style={style}>
    <header className={styles.header}>
      <div className={styles.brand}><h1>{current?.title ?? "フリート管理"}</h1>
        <span className={styles.connection} role="status">
          {connected ? <Wifi aria-hidden="true" /> : <WifiOff aria-hidden="true" />}{connectionLabel}
        </span>
      </div>
      <nav className={styles.headerActions} aria-label="フリートナビゲーション">
        {NAV.map(({ href, label, Icon }) => <Link key={href} href={href} className={styles.secondary}
          aria-label={label} title={label} aria-current={current?.href === href ? "page" : undefined}>
          <Icon aria-hidden="true" /><span>{label}</span>
        </Link>)}
        <button className={styles.emergency} onClick={emergencyStop} disabled={!connected}>
          <Square aria-hidden="true" />全台停止
        </button>
      </nav>
    </header>
    {children}
  </main>;
}

export function ConsoleShell({ children }: { children: ReactNode }) {
  return <FleetSocketProvider><ConsoleFrame>{children}</ConsoleFrame></FleetSocketProvider>;
}
