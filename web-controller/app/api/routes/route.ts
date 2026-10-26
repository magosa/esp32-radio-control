import { NextResponse } from "next/server";
import { listAvailableRoutes } from "@/fleet/routeEngine";

export async function GET() {
  return NextResponse.json({ routes: listAvailableRoutes() });
}
