import type { ReactNode } from "react";
import { FleetSocketProvider } from "@/hooks/useFleetSocket";

// No console chrome: this page is shown full screen on the surface the robots drive on.
export default function ExhibitLayout({ children }: { children: ReactNode }) {
  return <FleetSocketProvider>{children}</FleetSocketProvider>;
}
