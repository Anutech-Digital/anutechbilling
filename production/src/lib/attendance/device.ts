/**
 * Soft device token — a random id persisted in localStorage, sent with self
 * check-in so the server can flag punches from an unrecognised device for the
 * owner to review. Deliberately "soft": clearable, so it's a deterrent + audit
 * signal, never a hard lock (honest — a browser can't do real device binding).
 */
export function getDeviceToken(): string {
  if (typeof window === "undefined") return "";
  try {
    let t = localStorage.getItem("ros_att_device");
    if (!t) {
      t = (crypto.randomUUID?.() ?? String(Math.abs(Date.now() ^ (Math.random() * 1e9)))) as string;
      localStorage.setItem("ros_att_device", t);
    }
    return t;
  } catch {
    return "";
  }
}
