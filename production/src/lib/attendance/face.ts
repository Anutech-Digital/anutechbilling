/**
 * Face-verification provider seam — server-only (Phase 4).
 *
 * Compares an enrolled reference face against a live check-in selfie. Pluggable
 * + vendor-agnostic so we never lock into one biometric service and add no
 * heavy SDK:
 *
 *   • stub  (default) — no external call. Returns match:null → the caller adds a
 *     'face_review' flag so the owner eyeballs it in the review queue. Zero cost.
 *   • http            — POSTs both images (base64) to ATTENDANCE_FACE_URL and
 *     expects { score: 0..1 }. Point this at ANY certified face-match service
 *     (AWS Rekognition proxy, Azure Face, a specialist, or self-hosted). Match =
 *     score >= ATTENDANCE_FACE_THRESHOLD (default 0.85).
 *
 * Honest by design: real anti-spoof / liveness assurance lives in the certified
 * provider you point at — never claimed here.
 */
export type FaceResult = {
  provider: "stub" | "http";
  score: number | null;      // 0..1 similarity, or null when not scored
  match: boolean | null;     // true/false, or null when the provider can't decide
  error?: string;
};

export function faceProvider(): "stub" | "http" {
  return process.env.ATTENDANCE_FACE_URL ? "http" : "stub";
}

export function faceThreshold(): number {
  const t = Number(process.env.ATTENDANCE_FACE_THRESHOLD);
  return Number.isFinite(t) && t > 0 && t <= 1 ? t : 0.85;
}

export async function compareFaces(refB64: string, probeB64: string): Promise<FaceResult> {
  const url = process.env.ATTENDANCE_FACE_URL;
  if (!url) return { provider: "stub", score: null, match: null };

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(process.env.ATTENDANCE_FACE_KEY ? { authorization: `Bearer ${process.env.ATTENDANCE_FACE_KEY}` } : {}),
      },
      body: JSON.stringify({ reference: refB64, probe: probeB64 }),
    });
    if (!res.ok) return { provider: "http", score: null, match: null, error: `provider ${res.status}` };
    const j = (await res.json().catch(() => ({}))) as { score?: number };
    const score = typeof j.score === "number" ? j.score : null;
    return { provider: "http", score, match: score === null ? null : score >= faceThreshold() };
  } catch (e) {
    return { provider: "http", score: null, match: null, error: (e as Error).message };
  }
}
