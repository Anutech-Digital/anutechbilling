/**
 * R-1137: sign-in / password-reset / sign-up errors from Supabase Auth, as §24 copy
 * (what happened · why · what to do next). The login and forgot-password pages used to
 * toast `error.message` as-is — fine for "Invalid login credentials", but a database or
 * gateway failure showed its raw text to a customer. Known cases get their own sentence;
 * anything else gets a fixed one, and the raw text goes to the console for support.
 */
import { describeError } from "./toast-error";

export type AuthFlow = "sign-in" | "reset" | "sign-up";

export interface AuthErrorCopy {
  message: string;
  description: string;
  /** The button the page should offer. */
  next: "forgot-password" | "retry" | "sign-in";
}

function rawOf(err: unknown): string {
  if (typeof err === "string") return err;
  const m = (err as { message?: unknown } | null)?.message;
  return typeof m === "string" ? m : "";
}

const FAILED: Record<AuthFlow, string> = {
  "sign-in": "Could not sign you in.",
  reset: "Could not send the reset link.",
  "sign-up": "Could not create your account.",
};

export function describeAuthError(err: unknown, flow: AuthFlow): AuthErrorCopy {
  const raw = rawOf(err);

  if (/invalid login credentials|invalid_credentials|invalid email or password/i.test(raw)) {
    return {
      message: "Email or password is wrong.",
      description: "Check both and try again. If you signed up with Google, use Continue with Google — or set a password with Forgot password.",
      next: "forgot-password",
    };
  }
  if (/rate limit|too many|only request this after|over_email_send_rate_limit/i.test(raw)) {
    return {
      message: "Too many tries for now.",
      description: "For your account's safety we paused this. Wait a minute, then try again.",
      next: "retry",
    };
  }
  if (/user already registered|already been registered/i.test(raw)) {
    return {
      message: "This email already has an account.",
      description: "Sign in instead — or use Forgot password if you don't remember it.",
      next: "sign-in",
    };
  }

  // Network / session problems already have plain copy in the shared mapper.
  const d = describeError(err);
  if (d.translated && raw && /network|session/i.test(d.message)) {
    return { message: d.message, description: d.description ?? "Try again in a minute.", next: "retry" };
  }

  // eslint-disable-next-line no-console
  if (raw) console.error(`[auth:${flow}]`, raw, err);
  return {
    message: FAILED[flow],
    description: "Nothing changed on your account. Please try again in a minute — if it keeps failing, contact your account manager.",
    next: "retry",
  };
}
