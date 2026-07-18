"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const OAUTH_ERRORS: Record<string, string> = {
  google_unconfigured: "Google Sign-In isn't set up on the server yet.",
  google_denied: "Google sign-in was cancelled.",
  google_unverified:
    "Your Google account's email isn't verified, so we can't sign you in.",
  google_failed: "Google sign-in failed. Please try again.",
};

export default function AuthForm({ mode }: { mode: "login" | "register" }) {
  const router = useRouter();
  const params = useSearchParams();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [touched, setTouched] = useState(false);
  const [googleEnabled, setGoogleEnabled] = useState(false);

  const isRegister = mode === "register";
  const nextParam = params.get("next") || "/dashboard";

  // Show the Google button only when the server has it configured.
  useEffect(() => {
    fetch("/api/auth/google/status")
      .then((r) => (r.ok ? r.json() : { configured: false }))
      .then((d) => setGoogleEnabled(!!d.configured))
      .catch(() => {});
  }, []);

  // Surface an error bounced back from the OAuth callback (?error=...).
  useEffect(() => {
    const err = params.get("error");
    if (err && OAUTH_ERRORS[err]) setError(OAUTH_ERRORS[err]);
  }, [params]);

  // Lightweight client-side validation so users get instant feedback
  // instead of a round-trip for obvious mistakes.
  const emailOk = EMAIL_RE.test(email.trim());
  const passwordOk = isRegister ? password.length >= 6 : password.length > 0;
  const nameOk = isRegister ? name.trim().length > 0 : true;
  const formValid = emailOk && passwordOk && nameOk;

  const emailError =
    touched && email && !emailOk ? "Enter a valid email address." : null;
  const passwordError =
    touched && isRegister && password && password.length < 6
      ? "Password must be at least 6 characters."
      : null;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setTouched(true);
    if (!formValid) return;
    setError(null);
    setLoading(true);
    try {
      const res = await fetch(`/api/auth/${mode}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          isRegister
            ? {
                name: name.trim(),
                email: email.trim().toLowerCase(),
                password,
              }
            : { email: email.trim().toLowerCase(), password }
        ),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Something went wrong.");
        return;
      }
      const next = params.get("next") || "/dashboard";
      router.replace(next);
      router.refresh();
    } catch {
      setError("Network error. Is the server running?");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-[#e8e8f8] via-[#f5f5f5] to-[#e3e3f6] px-4 py-8">
      <div className="w-full max-w-md bg-white rounded-2xl shadow-xl p-6 sm:p-8 border border-teams-line">
        <div className="mb-6">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/logo.svg"
            alt="Race Innovations"
            className="h-14 sm:h-16 w-auto object-contain mb-4"
          />
          <h1 className="text-xl font-semibold text-teams-dark leading-tight">
            {isRegister ? "Create your account" : "Welcome back"}
          </h1>
          <p className="text-sm text-teams-gray">
            {isRegister ? "Sign up to start meeting" : "Sign in to start meeting"}
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4" noValidate>
          {isRegister && (
            <Field
              label="Full name"
              type="text"
              value={name}
              onChange={setName}
              placeholder="Ada Lovelace"
              autoComplete="name"
              autoFocus
            />
          )}
          <Field
            label="Email"
            type="email"
            value={email}
            onChange={setEmail}
            placeholder="you@example.com"
            autoComplete="email"
            autoFocus={!isRegister}
            inputMode="email"
            error={emailError}
          />
          <PasswordField
            label="Password"
            value={password}
            onChange={setPassword}
            placeholder="••••••••"
            autoComplete={isRegister ? "new-password" : "current-password"}
            error={passwordError}
            hint={
              isRegister ? "Use at least 6 characters." : undefined
            }
          />

          {!isRegister && (
            <div className="flex justify-end -mt-1">
              <Link
                href="/forgot"
                className="text-sm text-teams-purple font-medium hover:underline"
              >
                Forgot password?
              </Link>
            </div>
          )}

          {error && (
            <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-md px-3 py-2">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full bg-teams-purple hover:bg-teams-purpleDark disabled:opacity-60 text-white font-medium rounded-md py-2.5 transition-colors flex items-center justify-center gap-2"
          >
            {loading && <Spinner />}
            {loading
              ? "Please wait…"
              : isRegister
              ? "Create account"
              : "Sign in"}
          </button>
        </form>

        {googleEnabled && (
          <>
            <div className="flex items-center gap-3 my-5">
              <div className="h-px flex-1 bg-teams-line" />
              <span className="text-xs text-teams-gray">or</span>
              <div className="h-px flex-1 bg-teams-line" />
            </div>
            <a
              href={`/api/auth/google?next=${encodeURIComponent(nextParam)}`}
              className="w-full flex items-center justify-center gap-2.5 border border-teams-line hover:bg-teams-bg rounded-md py-2.5 font-medium text-teams-dark transition-colors"
            >
              <GoogleG />
              {isRegister ? "Sign up with Google" : "Continue with Google"}
            </a>
          </>
        )}

        <p className="text-sm text-teams-gray text-center mt-6">
          {isRegister ? (
            <>
              Already have an account?{" "}
              <Link href="/login" className="text-teams-purple font-medium">
                Sign in
              </Link>
            </>
          ) : (
            <>
              New here?{" "}
              <Link href="/register" className="text-teams-purple font-medium">
                Create an account
              </Link>
            </>
          )}
        </p>
      </div>
    </div>
  );
}

function Field({
  label,
  type,
  value,
  onChange,
  placeholder,
  autoComplete,
  autoFocus,
  inputMode,
  error,
}: {
  label: string;
  type: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  autoComplete?: string;
  autoFocus?: boolean;
  inputMode?: "email" | "text";
  error?: string | null;
}) {
  return (
    <label className="block">
      <span className="text-sm font-medium text-teams-dark">{label}</span>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        autoComplete={autoComplete}
        autoFocus={autoFocus}
        inputMode={inputMode}
        className={`mt-1 w-full rounded-md border px-3 py-2 outline-none focus:ring-1 ${
          error
            ? "border-red-300 focus:border-red-400 focus:ring-red-400"
            : "border-teams-line focus:border-teams-purple focus:ring-teams-purple"
        }`}
      />
      {error && <span className="text-xs text-red-600 mt-1 block">{error}</span>}
    </label>
  );
}

export function PasswordField({
  label,
  value,
  onChange,
  placeholder,
  autoComplete,
  error,
  hint,
  autoFocus,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  autoComplete?: string;
  error?: string | null;
  hint?: string;
  autoFocus?: boolean;
}) {
  const [show, setShow] = useState(false);
  return (
    <label className="block">
      <span className="text-sm font-medium text-teams-dark">{label}</span>
      <div className="relative mt-1">
        <input
          type={show ? "text" : "password"}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          autoComplete={autoComplete}
          autoFocus={autoFocus}
          className={`w-full rounded-md border px-3 py-2 pr-11 outline-none focus:ring-1 ${
            error
              ? "border-red-300 focus:border-red-400 focus:ring-red-400"
              : "border-teams-line focus:border-teams-purple focus:ring-teams-purple"
          }`}
        />
        <button
          type="button"
          onClick={() => setShow((s) => !s)}
          tabIndex={-1}
          aria-label={show ? "Hide password" : "Show password"}
          title={show ? "Hide password" : "Show password"}
          className="absolute inset-y-0 right-0 px-3 flex items-center text-teams-gray hover:text-teams-dark"
        >
          {show ? <EyeOffIcon /> : <EyeIcon />}
        </button>
      </div>
      {error ? (
        <span className="text-xs text-red-600 mt-1 block">{error}</span>
      ) : hint ? (
        <span className="text-xs text-teams-gray mt-1 block">{hint}</span>
      ) : null}
    </label>
  );
}

function GoogleG() {
  return (
    <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
      <path
        fill="#4285F4"
        d="M45.12 24.5c0-1.56-.14-3.06-.4-4.5H24v8.51h11.84c-.51 2.75-2.06 5.08-4.39 6.64v5.52h7.11c4.16-3.83 6.56-9.47 6.56-16.17z"
      />
      <path
        fill="#34A853"
        d="M24 46c5.94 0 10.92-1.97 14.56-5.33l-7.11-5.52c-1.97 1.32-4.49 2.1-7.45 2.1-5.73 0-10.58-3.87-12.31-9.07H4.34v5.7A21.99 21.99 0 0 0 24 46z"
      />
      <path
        fill="#FBBC05"
        d="M11.69 28.18A13.2 13.2 0 0 1 11 24c0-1.45.25-2.86.69-4.18v-5.7H4.34A21.99 21.99 0 0 0 2 24c0 3.55.85 6.91 2.34 9.88l7.35-5.7z"
      />
      <path
        fill="#EA4335"
        d="M24 10.75c3.23 0 6.13 1.11 8.41 3.29l6.31-6.31C34.91 4.18 29.93 2 24 2 15.4 2 7.96 6.94 4.34 14.12l7.35 5.7c1.73-5.2 6.58-9.07 12.31-9.07z"
      />
    </svg>
  );
}

function Spinner() {
  return (
    <svg
      className="animate-spin h-4 w-4 text-white"
      viewBox="0 0 24 24"
      fill="none"
    >
      <circle
        className="opacity-25"
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        strokeWidth="4"
      />
      <path
        className="opacity-75"
        fill="currentColor"
        d="M4 12a8 8 0 0 1 8-8V0C5.4 0 0 5.4 0 12h4z"
      />
    </svg>
  );
}

function EyeIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
      <path
        d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"
        stroke="currentColor"
        strokeWidth="1.8"
      />
      <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="1.8" />
    </svg>
  );
}

function EyeOffIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
      <path
        d="M1 1l22 22M9.9 4.24A9.1 9.1 0 0 1 12 4c6.5 0 10 7 10 7a13.2 13.2 0 0 1-2.4 3.2M6.1 6.1A13.3 13.3 0 0 0 2 11s3.5 7 10 7a9 9 0 0 0 4.9-1.4M9.9 9.9a3 3 0 0 0 4.2 4.2"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}
