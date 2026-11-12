/** LinkedIn Ads OAuth tokens are encrypted before entering ad_accounts.access_token. */
import { decryptSecret, encryptSecret, isEncrypted, isVaultConfigured } from "@/lib/crypto/vault";

export const sealLinkedInAdsToken = (token: string) => isEncrypted(token) ? token : encryptSecret(token);
export const openLinkedInAdsToken = (token: string | null | undefined) => decryptSecret(token);
export const resealLinkedInAdsTokenIfPlain = (token: string | null | undefined) =>
  token && !isEncrypted(token) && isVaultConfigured() ? { access_token: encryptSecret(token) } : {};
