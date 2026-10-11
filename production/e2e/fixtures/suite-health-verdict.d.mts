export function authSignalVars(roles?: readonly string[]): string[];
export function suiteHealthVerdict(input: {
  env?: Record<string, string | undefined>;
  hasEnvFile: boolean;
  isCI: boolean;
}): { status: "pass" | "skip" | "fail"; missing: string[]; reason: string };
