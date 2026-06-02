function base64UrlEncode(array: Uint8Array): string {
  const base64 = btoa(String.fromCharCode(...array));
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, "0");
  }
  return out;
}

export function generateVerifier(): string {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return base64UrlEncode(array);
}

export async function generateChallenge(verifier: string): Promise<string> {
  const data = new TextEncoder().encode(verifier);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return bytesToHex(new Uint8Array(hash));
}

import {
  putOAuthVerifier,
  getOAuthVerifier,
  delOAuthVerifier,
} from "@remote/shared/lib/auth";

const VERIFIER_KEY = "oauth_verifier";
const INVITATION_TOKEN_KEY = "invitation_token";

/**
 * Persist the PKCE verifier to BOTH sessionStorage (fast, sync) and IndexedDB
 * (durable across a reload mid-flow). Awaiting the IndexedDB write guarantees
 * the verifier is committed before the caller redirects to the OAuth provider.
 */
export async function storeVerifier(verifier: string): Promise<void> {
  sessionStorage.setItem(VERIFIER_KEY, verifier);
  await putOAuthVerifier(verifier);
}

/** Read the verifier, preferring sessionStorage and falling back to IndexedDB. */
export async function retrieveVerifier(): Promise<string | null> {
  const fromSession = sessionStorage.getItem(VERIFIER_KEY);
  if (fromSession) {
    return fromSession;
  }
  return getOAuthVerifier();
}

export async function clearVerifier(): Promise<void> {
  sessionStorage.removeItem(VERIFIER_KEY);
  await delOAuthVerifier();
}

export function storeInvitationToken(token: string): void {
  sessionStorage.setItem(INVITATION_TOKEN_KEY, token);
}

export function retrieveInvitationToken(): string | null {
  return sessionStorage.getItem(INVITATION_TOKEN_KEY);
}

export function clearInvitationToken(): void {
  sessionStorage.removeItem(INVITATION_TOKEN_KEY);
}
