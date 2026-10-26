// node-localizer の detector.js をTS化。配布版 opencv-js の型定義にはArUcoが無いため、使うAPIだけを宣言する。
import type { Point } from "./geometry";

interface CvMat {
  data: Uint8ClampedArray | Uint8Array;
  data32S: Int32Array;
  data32F: Float32Array;
  delete(): void;
}
interface CvMatVector {
  get(index: number): CvMat;
  delete(): void;
}
interface CvDeletable { delete(): void }
interface CvArucoDetector extends CvDeletable {
  detectMarkers(image: CvMat, corners: CvMatVector, ids: CvMat, rejected: CvMatVector): void;
}
interface CvDetectorParameters extends CvDeletable {
  cornerRefinementMethod: number;
  cornerRefinementWinSize: number;
  cornerRefinementMaxIterations: number;
  cornerRefinementMinAccuracy: number;
}

export interface OpenCv {
  Mat: new () => CvMat;
  MatVector: new () => CvMatVector;
  DICT_4X4_50: number;
  CORNER_REFINE_SUBPIX: number;
  COLOR_RGBA2GRAY: number;
  getPredefinedDictionary(id: number): CvDeletable;
  aruco_DetectorParameters: new () => CvDetectorParameters;
  aruco_RefineParameters: new (minRepDistance: number, errorCorrectionRate: number, checkAllOrders: boolean) => CvDeletable;
  aruco_ArucoDetector: new (dictionary: CvDeletable, parameters: CvDetectorParameters, refine: CvDeletable) => CvArucoDetector;
  matFromImageData(image: ImageDataLike): CvMat;
  cvtColor(source: CvMat, destination: CvMat, code: number): void;
}

export interface ImageDataLike {
  width: number;
  height: number;
  data: Uint8ClampedArray | Uint8Array;
}

export interface RawDetection {
  id: number;
  corners: Point[];
}

export interface Detector {
  detect(image: ImageDataLike): RawDetection[];
  delete(): void;
}

type CvModule = Partial<OpenCv> & { then?: (resolve: (cv: OpenCv) => void, reject: (reason: unknown) => void) => void;
  onRuntimeInitialized?: () => void; onAbort?: (reason: unknown) => void };

export function initializeOpenCv(module: CvModule | null | undefined, timeoutMs = 30000): Promise<{ cv: OpenCv }> {
  return new Promise((resolve, reject) => {
    if (!module) { reject(new Error("OpenCV.jsの読み込みに失敗しました。ページを再読み込みしてください。")); return; }
    const timer = setTimeout(() => reject(new Error("OpenCV.jsの初期化がタイムアウトしました。")), timeoutMs);
    const ready = (cv: OpenCv) => { clearTimeout(timer); resolve({ cv }); };
    const failed = (reason: unknown) => { clearTimeout(timer); reject(new Error(`OpenCV.jsの初期化に失敗しました：${reason instanceof Error ? reason.message : reason}`)); };
    if (module.Mat) ready(module as OpenCv);
    else if (typeof module.then === "function") module.then(ready, failed);
    else module.onRuntimeInitialized = () => ready(module as OpenCv);
    module.onAbort = failed;
  });
}

export function createDetector(cv: OpenCv): Detector {
  const dictionary = cv.getPredefinedDictionary(cv.DICT_4X4_50);
  const parameters = new cv.aruco_DetectorParameters();
  const refine = new cv.aruco_RefineParameters(10, 3, true);
  // Python版と同じSUBPIX条件に揃え、画像内で小さい紙マーカーの四隅を精緻化する。
  parameters.cornerRefinementMethod = cv.CORNER_REFINE_SUBPIX;
  parameters.cornerRefinementWinSize = 5;
  parameters.cornerRefinementMaxIterations = 50;
  parameters.cornerRefinementMinAccuracy = 0.01;
  let detector: CvArucoDetector;
  try { detector = new cv.aruco_ArucoDetector(dictionary, parameters, refine); }
  finally { dictionary.delete(); parameters.delete(); refine.delete(); }
  return {
    detect(image) {
      const source = cv.matFromImageData(image);
      const gray = new cv.Mat(), corners = new cv.MatVector(), ids = new cv.Mat();
      const rejected = new cv.MatVector();
      try {
        cv.cvtColor(source, gray, cv.COLOR_RGBA2GRAY);
        detector.detectMarkers(gray, corners, ids, rejected);
        return Array.from(ids.data32S, (id, i) => {
          const points = corners.get(i);
          try {
            return { id, corners: Array.from({ length: 4 }, (_, j): Point => [points.data32F[j * 2], points.data32F[j * 2 + 1]]) };
          } finally { points.delete(); }
        });
      } finally {
        source.delete(); gray.delete(); corners.delete(); ids.delete(); rejected.delete();
      }
    },
    delete() { detector.delete(); },
  };
}
