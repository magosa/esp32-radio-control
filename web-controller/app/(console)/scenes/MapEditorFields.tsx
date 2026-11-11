"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import styles from "./mapEditor.module.css";

interface TextCommitProps {
  label: string;
  value: string;
  // Changes whenever the session changes, so a rejected edit snaps back to the real value.
  syncKey: number;
  onCommit(text: string): void;
  disabled?: boolean;
}

// Commits on blur or Enter so that typing does not fill the undo history.
export function TextCommit({ label, value, syncKey, onCommit, disabled }: TextCommitProps) {
  const [text, setText] = useState(value);
  const editing = useRef(false);
  useEffect(() => { if (!editing.current) setText(value); }, [value, syncKey]);
  const finish = () => {
    editing.current = false;
    if (text !== value) onCommit(text); else setText(value);
  };
  return <label className={styles.field}>
    <span>{label}</span>
    <input type="text" value={text} disabled={disabled}
      onFocus={() => { editing.current = true; }}
      onChange={(event) => setText(event.target.value)}
      onBlur={finish}
      onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }} />
  </label>;
}

interface SelectFieldProps<T extends string | number> {
  label: string;
  value: T;
  options: readonly { value: T; label: string }[];
  onChange(value: T): void;
  disabled?: boolean;
}

export function SelectField<T extends string | number>({ label, value, options, onChange, disabled }: SelectFieldProps<T>) {
  return <label className={styles.field}>
    <span>{label}</span>
    <select value={String(value)} disabled={disabled}
      onChange={(event) => {
        const picked = options.find((option) => String(option.value) === event.target.value);
        if (picked) onChange(picked.value);
      }}>
      {options.map((option) => <option key={String(option.value)} value={String(option.value)}>{option.label}</option>)}
    </select>
  </label>;
}

interface ColorFieldProps {
  label: string;
  value: string;
  onCommit(color: string): void;
  disabled?: boolean;
}

// The native change event fires once the picker closes; React's onChange would fire on every drag.
export function ColorField({ label, value, onCommit, disabled }: ColorFieldProps) {
  const ref = useRef<HTMLInputElement>(null);
  const callback = useRef(onCommit);
  callback.current = onCommit;
  useEffect(() => {
    const input = ref.current;
    if (!input) return;
    input.value = value;
    const listener = () => callback.current(input.value);
    input.addEventListener("change", listener);
    return () => input.removeEventListener("change", listener);
  }, [value]);
  return <label className={styles.field}>
    <span>{label}</span>
    <input ref={ref} type="color" defaultValue={value} disabled={disabled} />
  </label>;
}

export function ToggleButton({ pressed, onClick, children, disabled }:
{ pressed: boolean; onClick(): void; children: ReactNode; disabled?: boolean }) {
  return <button type="button" className={styles.toggle} aria-pressed={pressed} disabled={disabled} onClick={onClick}>{children}</button>;
}

export function Group({ label, children }: { label: string; children: ReactNode }) {
  const id = useId();
  return <div role="group" aria-labelledby={id} className={styles.group}>
    <span id={id} className={styles.groupLabel}>{label}</span>
    <div className={styles.groupBody}>{children}</div>
  </div>;
}
