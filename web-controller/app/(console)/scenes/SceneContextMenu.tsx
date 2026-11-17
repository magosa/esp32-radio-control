"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { SceneContextRequest } from "./editorTypes";
import styles from "./scenes.module.css";

export function SceneContextMenu({ request, name, locked, onSequence, onDelete, onClose }: {
  request: SceneContextRequest;
  name: string;
  locked: boolean;
  onSequence(): void;
  onDelete(): void;
  onClose(): void;
}) {
  const menu = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ x: request.x, y: request.y });
  useLayoutEffect(() => {
    const node = menu.current;
    if (!node) return;
    const previous = document.activeElement;
    const box = node.getBoundingClientRect();
    setPosition({
      x: Math.max(8, Math.min(request.x, window.innerWidth - box.width - 8)),
      y: Math.max(8, Math.min(request.y, window.innerHeight - box.height - 8)),
    });
    node.focus();
    node.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
    const outside = (event: PointerEvent) => { if (event.target instanceof Node && !node.contains(event.target)) onClose(); };
    window.addEventListener("pointerdown", outside, true);
    window.addEventListener("resize", onClose);
    window.addEventListener("scroll", onClose, true);
    return () => {
      window.removeEventListener("pointerdown", outside, true);
      window.removeEventListener("resize", onClose);
      window.removeEventListener("scroll", onClose, true);
      if (node.contains(document.activeElement) && previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true });
    };
  }, [request, onClose]);
  const content = <div ref={menu} className={styles.contextMenu} role="menu" aria-label={`${name} の操作`} tabIndex={-1}
    style={{ left: position.x, top: position.y }} onContextMenu={(event) => event.preventDefault()}
    onKeyDown={(event) => {
      event.stopPropagation();
      if (event.key === "Escape" || event.key === "Tab") { onClose(); return; }
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"));
      if (buttons.length === 0) return;
      const index = buttons.findIndex((button) => button === document.activeElement);
      const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1
        : (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
      buttons[next]?.focus();
    }}>
    <strong>{name}{locked ? "（固定中）" : ""}</strong>
    <button type="button" role="menuitem" disabled={locked} onClick={onSequence}>シーケンス一括設定</button>
    <button type="button" role="menuitem" disabled={locked} onClick={onDelete}>削除</button>
  </div>;
  return document.fullscreenElement ? createPortal(content, document.fullscreenElement) : content;
}
