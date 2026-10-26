import { readFile } from "node:fs/promises";
import path from "node:path";

// 約11MBのOpenCV.jsは測位ページが明示開始したときだけ読み込む。バンドルせずnode_modulesから配信する。
const OPENCV_PATH = path.join(process.cwd(), "node_modules", "@techstark", "opencv-js", "dist", "opencv.js");

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const data = await readFile(OPENCV_PATH);
    return new Response(new Uint8Array(data), {
      headers: { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "public, max-age=86400" },
    });
  } catch {
    return new Response("OpenCV.js is not installed", { status: 404 });
  }
}
