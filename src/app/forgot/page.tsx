"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { PasswordField } from "@/components/AuthForm";

export default function ForgotPage() {
  const router = useRouter();
  const [stage, setStage] = useState<"email" | "code">("email");
  const [email, setEmail] = useState("");
  const [pin, setPin] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [devPin, setDevPin] = useState<string | null>(null);

  async function sendCode(e?: React.FormEvent) {
    e?.preventDefault();
    setError(null);
    setInfo(null);
    setLoading(true);
    try {
      const res = await fetch("/api/auth/forgot", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim().toLowerCase() }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Something went wrong.");
        return;
      }
      setStage("code");
      setDevPin(data.devPin || null);
      setInfo(
        `If an account exists for ${email}, we've sent a 4-digit code. It expires in 10 minutes.`
      );
    } catch {
      setError("Network error. Is the server running?");
    } finally {
      setLoading(false);
    }
  }

  const tooShort = password.length > 0 && password.length < 6;
  const mismatch = confirm.length > 0 && confirm !== password;
  const canReset =
    /^\d{4}$/.test(pin) && password.length >= 6 && password === confirm;

  async function resetPassword(e: React.FormEvent) {
    e.preventDefault();
    if (!canReset) return;
    setError(null);
    setLoading(true);
    try {
      const res = await fetch("/api/auth/reset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: email.trim().toLowerCase(),
          pin,
          password,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Could not reset password.");
        return;
      }
      // Auto-logged in by the API — go to the dashboard.
      router.replace("/dashboard");
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
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/logo.svg"
          alt="Race Innovations"
          className="h-14 sm:h-16 w-auto object-contain mb-4"
        />
        <h1 className="text-xl font-semibold text-teams-dark">
          Reset your password
        </h1>

        {stage === "email" ? (
          <>
            <p className="text-sm text-teams-gray mt-1">
              Enter your account email and we&apos;ll send you a 4-digit code.
            </p>
            <form onSubmit={sendCode} className="mt-5 space-y-4" noValidate>
              <label className="block">
                <span className="text-sm font-medium text-teams-dark">Email</span>
                <input
                  type="email"
                  inputMode="email"
                  autoFocus
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                  autoComplete="email"
                  className="mt-1 w-full rounded-md border border-teams-line px-3 py-2 outline-none focus:border-teams-purple focus:ring-1 focus:ring-teams-purple"
                />
              </label>
              {error && <ErrorBox>{error}</ErrorBox>}
              <button
                type="submit"
                disabled={loading || !email.trim()}
                className="w-full bg-teams-purple hover:bg-teams-purpleDark disabled:opacity-60 text-white font-medium rounded-md py-2.5 transition-colors"
              >
                {loading ? "Sending…" : "Send code"}
              </button>
            </form>
          </>
        ) : (
          <>
            {info && (
              <p className="text-sm text-teams-gray mt-2">{info}</p>
            )}
            {devPin && (
              <div className="mt-3 text-sm bg-amber-50 border border-amber-200 rounded-md px-3 py-2 text-amber-800">
                Dev mode (no email configured): your code is{" "}
                <strong className="tracking-widest">{devPin}</strong>
              </div>
            )}
            <form onSubmit={resetPassword} className="mt-5 space-y-4" noValidate>
              <label className="block">
                <span className="text-sm font-medium text-teams-dark">
                  4-digit code
                </span>
                <input
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  autoFocus
                  maxLength={4}
                  value={pin}
                  onChange={(e) =>
                    setPin(e.target.value.replace(/\D/g, "").slice(0, 4))
                  }
                  placeholder="1234"
                  className="mt-1 w-full rounded-md border border-teams-line px-3 py-2 text-center text-2xl tracking-[0.6em] font-semibold outline-none focus:border-teams-purple focus:ring-1 focus:ring-teams-purple"
                />
              </label>
              <PasswordField
                label="New password"
                value={password}
                onChange={setPassword}
                placeholder="••••••••"
                autoComplete="new-password"
                error={tooShort ? "At least 6 characters." : null}
                hint="Use at least 6 characters."
              />
              <PasswordField
                label="Confirm password"
                value={confirm}
                onChange={setConfirm}
                placeholder="••••••••"
                autoComplete="new-password"
                error={mismatch ? "Passwords don't match." : null}
              />
              {error && <ErrorBox>{error}</ErrorBox>}
              <button
                type="submit"
                disabled={loading || !canReset}
                className="w-full bg-teams-purple hover:bg-teams-purpleDark disabled:opacity-60 text-white font-medium rounded-md py-2.5 transition-colors"
              >
                {loading ? "Saving…" : "Reset password"}
              </button>
            </form>
            <div className="flex items-center justify-between mt-4 text-sm">
              <button
                onClick={() => sendCode()}
                disabled={loading}
                className="text-teams-purple font-medium hover:underline disabled:opacity-60"
              >
                Resend code
              </button>
              <button
                onClick={() => {
                  setStage("email");
                  setPin("");
                  setError(null);
                }}
                className="text-teams-gray hover:underline"
              >
                Use a different email
              </button>
            </div>
          </>
        )}

        <p className="text-sm text-teams-gray text-center mt-6">
          Remembered it?{" "}
          <Link href="/login" className="text-teams-purple font-medium">
            Sign in
          </Link>
        </p>
      </div>
    </div>
  );
}

function ErrorBox({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-md px-3 py-2">
      {children}
    </div>
  );
}
