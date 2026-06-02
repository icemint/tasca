import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useSearch } from "@tanstack/react-router";
import {
  getAuthMethods,
  initOAuth,
  localLogin,
  type OAuthProvider,
} from "@remote/shared/lib/api";
import { storeTokens } from "@remote/shared/lib/auth";
import { BrandLogo } from "@remote/shared/components/BrandLogo";
import {
  generateVerifier,
  generateChallenge,
  storeVerifier,
} from "@remote/shared/lib/pkce";
import { Input } from "@vibe/ui/components/Input";
import { Label } from "@vibe/ui/components/Label";

export default function LoginPage() {
  const { next } = useSearch({ from: "/account" });
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<OAuthProvider | "local" | null>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const {
    data: authMethods,
    error: authMethodsError,
    isError: isAuthMethodsError,
  } = useQuery({
    queryKey: ["remote-auth-methods"],
    queryFn: getAuthMethods,
    staleTime: 60_000,
  });

  const hasLocalAuth = authMethods?.local_auth_enabled ?? false;
  const oauthProviders = authMethods?.oauth_providers ?? [];
  const hasOAuthProviders = oauthProviders.length > 0;

  const handleLogin = async (provider: OAuthProvider) => {
    setPending(provider);
    setError(null);

    try {
      const verifier = generateVerifier();
      const challenge = await generateChallenge(verifier);
      await storeVerifier(verifier);

      const appBase =
        import.meta.env.VITE_APP_BASE_URL || window.location.origin;
      const callbackUrl = new URL("/account/complete", appBase);
      if (next) {
        callbackUrl.searchParams.set("next", next);
      }
      const returnTo = callbackUrl.toString();

      const { authorize_url } = await initOAuth(provider, returnTo, challenge);
      window.location.assign(authorize_url);
    } catch (e) {
      setError(e instanceof Error ? e.message : "OAuth init failed");
      setPending(null);
    }
  };

  const handleLocalLogin = async () => {
    setPending("local");
    setError(null);

    try {
      const { access_token, refresh_token } = await localLogin(
        email.trim(),
        password,
      );
      await storeTokens(access_token, refresh_token);
      window.location.replace(next || "/");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Local login failed");
      setPending(null);
    }
  };

  return (
    <div className="h-screen overflow-auto bg-bg">
      <div className="mx-auto flex min-h-full w-full max-w-md flex-col justify-center px-base py-double">
        <div className="space-y-double rounded-sm border border-line bg-surface p-double">
          <header className="space-y-double text-center">
            <div className="flex justify-center">
              <BrandLogo className="h-8 w-auto" />
            </div>
            <p className="text-sm text-fg-3">Sign in to continue</p>
          </header>

          {error && (
            <div
              role="alert"
              className="rounded-sm border border-red bg-surface p-base"
            >
              <p className="text-sm text-red">{error}</p>
            </div>
          )}

          {isAuthMethodsError && (
            <div
              role="alert"
              className="rounded-sm border border-red bg-surface p-base"
            >
              <p className="text-sm text-red">
                {authMethodsError instanceof Error
                  ? authMethodsError.message
                  : "Failed to load available sign-in methods."}
              </p>
            </div>
          )}

          <section className="space-y-3">
            {!isAuthMethodsError && hasLocalAuth && (
              <div className="space-y-3 rounded-sm border border-line p-base">
                <div className="space-y-2">
                  <Label htmlFor="self-host-email" className="text-fg-2">
                    Email
                  </Label>
                  <Input
                    id="self-host-email"
                    type="email"
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                    placeholder="Email"
                    autoComplete="username"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="self-host-password" className="text-fg-2">
                    Password
                  </Label>
                  <Input
                    id="self-host-password"
                    type="password"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    placeholder="Password"
                    autoComplete="current-password"
                  />
                </div>
                <button
                  type="button"
                  className="w-full rounded-sm bg-signal px-base py-half text-sm font-medium text-on-signal transition-colors hover:bg-signal-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal disabled:cursor-not-allowed disabled:opacity-50"
                  onClick={() => void handleLocalLogin()}
                  disabled={pending !== null || !email.trim() || !password}
                >
                  {pending === "local" ? "Signing in..." : "Sign in with email"}
                </button>
              </div>
            )}

            {!isAuthMethodsError && hasLocalAuth && hasOAuthProviders && (
              <div className="flex items-center gap-3 text-xs uppercase tracking-[0.12em] text-fg-3">
                <div className="h-px flex-1 bg-line" />
                <span>or continue with</span>
                <div className="h-px flex-1 bg-line" />
              </div>
            )}

            <div className="flex flex-col items-center gap-2">
              {!isAuthMethodsError &&
                hasOAuthProviders &&
                oauthProviders.includes("github") && (
                  <OAuthButton
                    provider="github"
                    label="Continue with GitHub"
                    onClick={() => void handleLogin("github")}
                    disabled={pending !== null}
                    loading={pending === "github"}
                  />
                )}
              {!isAuthMethodsError &&
                hasOAuthProviders &&
                oauthProviders.includes("google") && (
                  <OAuthButton
                    provider="google"
                    label="Continue with Google"
                    onClick={() => void handleLogin("google")}
                    disabled={pending !== null}
                    loading={pending === "google"}
                  />
                )}
            </div>
          </section>

          <p className="text-center text-sm text-fg-3">
            Need help getting started?{" "}
            <a
              href="https://www.tasca.dev/docs"
              target="_blank"
              rel="noopener noreferrer"
              className="rounded-sm text-fg-2 underline decoration-line underline-offset-4 transition-colors hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal"
            >
              Read the docs
            </a>
          </p>
        </div>
      </div>
    </div>
  );
}

function OAuthButton({
  provider,
  label,
  onClick,
  disabled,
  loading,
}: {
  provider: OAuthProvider;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  loading?: boolean;
}) {
  return (
    <button
      type="button"
      className="flex h-10 min-w-[280px] items-center justify-center rounded-sm border border-line bg-surface-2 px-3 text-sm font-medium text-fg transition-colors hover:border-signal hover:bg-surface-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal disabled:cursor-not-allowed disabled:opacity-50"
      onClick={onClick}
      disabled={disabled || loading}
      aria-busy={loading}
    >
      {loading
        ? `Opening ${provider === "github" ? "GitHub" : "Google"}...`
        : label}
    </button>
  );
}
