"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  clampTo, editPoints, home, initialPlayback, nextEditPoint, pause, prevEditPoint, seek, setSpeed, step, toggle, toggleLoop,
  type PlaybackState,
} from "@/scene/playback";
import type { SceneMap } from "@/scene/types";
import type { PlaybackControls } from "@/app/(console)/scenes/editorTypes";

// Drives the pure playback state with requestAnimationFrame; pauses automatically when the tab is hidden (F6).
export function usePlayback(duration: number, map?: Pick<SceneMap, "tracks">): PlaybackControls {
  const [state, setState] = useState<PlaybackState>(initialPlayback);
  const durationRef = useRef(duration);
  durationRef.current = duration;
  const points = useMemo(() => (map ? editPoints(map, duration) : [0, ...(duration > 0 ? [duration] : [])]), [map, duration]);
  const pointsRef = useRef(points);
  pointsRef.current = points;

  useEffect(() => { setState((current) => clampTo(current, duration)); }, [duration]);

  useEffect(() => {
    const onVisibility = () => {
      if (document.hidden) setState((current) => pause(current));
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  useEffect(() => {
    if (!state.running) return;
    let frame = 0;
    let last = performance.now();
    const tick = (now: number) => {
      if (document.hidden) {
        setState((current) => pause(current));
        return;
      }
      const delta = now - last;
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
  const prevPoint = useCallback(() => setState((current) => seek(current, prevEditPoint(pointsRef.current, current.time), durationRef.current)), []);
  const nextPoint = useCallback(() => setState((current) => seek(current, nextEditPoint(pointsRef.current, current.time), durationRef.current)), []);
  const changeSpeed = useCallback((speed: number) => setState((current) => setSpeed(current, speed)), []);
  const loop = useCallback(() => setState((current) => toggleLoop(current)), []);

  return useMemo(() => ({
    time: state.time, running: state.running, looping: state.looping, speed: state.speed, duration,
    toggle: toggleRun, home: goHome, seek: seekTo, prevPoint, nextPoint, setSpeed: changeSpeed, toggleLoop: loop,
  }), [state, duration, toggleRun, goHome, seekTo, prevPoint, nextPoint, changeSpeed, loop]);
}
