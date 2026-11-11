"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { clampTo, home, initialPlayback, seek, setSpeed, step, toggle, toggleLoop, type PlaybackState } from "@/scene/playback";
import type { PlaybackControls } from "@/app/(console)/scenes/editorTypes";

// Drives the pure playback state with requestAnimationFrame; nothing advances while the tab is hidden.
export function usePlayback(duration: number): PlaybackControls {
  const [state, setState] = useState<PlaybackState>(initialPlayback);
  const durationRef = useRef(duration);
  durationRef.current = duration;

  useEffect(() => { setState((current) => clampTo(current, duration)); }, [duration]);

  useEffect(() => {
    if (!state.running) return;
    let frame = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const delta = document.hidden ? 0 : now - last;
      last = now;
      setState((current) => step(current, delta, durationRef.current));
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [state.running]);

  const toggleRun = useCallback(() => setState((current) => toggle(current, durationRef.current)), []);
  const goHome = useCallback(() => setState((current) => home(current)), []);
  const seekTo = useCallback((time: number) => setState((current) => seek(current, time, durationRef.current)), []);
  const changeSpeed = useCallback((speed: number) => setState((current) => setSpeed(current, speed)), []);
  const loop = useCallback(() => setState((current) => toggleLoop(current)), []);

  return useMemo(() => ({
    time: state.time, running: state.running, looping: state.looping, speed: state.speed, duration,
    toggle: toggleRun, home: goHome, seek: seekTo, setSpeed: changeSpeed, toggleLoop: loop,
  }), [state, duration, toggleRun, goHome, seekTo, changeSpeed, loop]);
}
