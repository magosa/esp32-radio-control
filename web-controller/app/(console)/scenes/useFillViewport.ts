"use client";

import { useLayoutEffect, useState, type RefObject } from "react";

const BOTTOM_GAP_PX = 34;

// Height that makes the element end at the bottom of the window, so the workbench fits one screen and the cards scroll inside.
export function useFillViewport(ref: RefObject<HTMLElement>): number | undefined {
  const [height, setHeight] = useState<number | undefined>(undefined);
  useLayoutEffect(() => {
    const update = () => {
      const top = ref.current?.getBoundingClientRect().top;
      if (top === undefined) return;
      const scrolled = window.scrollY;
      setHeight(Math.round(window.innerHeight - (top + scrolled) - BOTTOM_GAP_PX));
    };
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, [ref]);
  return height;
}
