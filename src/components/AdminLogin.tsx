"use client";

import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { BrandLogo } from "@/components/Logo";

/**
 * The administrator sign-in.
 *
 * Kept visually apart from the ordinary one on purpose — dark rather than the
 * app's light card. Someone who lands here from a bookmark should be able to
 * see at a glance that this is not the door they usually come through, and an
 * administrator should be able to see that it is.
 */
export default function AdminLogin() {
  const router = useRouter();
  const params = useSearchParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [show, setShow] = useState(false);
  const [error, setError] = useState<string | null>(
    params.get("reason") === "notadmin"
      ? "That account isn't an administrator. Sign in with one below."
      : null
  );
  const [loading, setLoading] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/admin-login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim(), password }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(body.error || "Could not sign in.");
        return;
      }
      // replace, not push: the back button should not land on a sign-in form
      // that is now signed in. refresh so the layout picks up the new session.
      router.replace("/admin");
      router.refresh();
    } catch {
      setError("Could not reach the server.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-dvh flex items-center justify-center bg-teams-darker px-4 py-8">
      <div className="w-full max-w-sm">
        <div className="flex justify-center mb-6">
          <BrandLogo
            slot="logoPrimary"
            className="h-6 w-auto max-w-[60vw] object-contain"
            plateClassName="flex items-center"
          />
        </div>

        <div className="bg-teams-dark border border-white/10 rounded-2xl shadow-2xl p-6 sm:p-7">
          <h1 className="text-lg font-semibold text-white">
            Administrator sign-in
          </h1>
          <p className="text-sm text-gray-400 mt-1">
            This page is for managing the deployment. Everyday use is through
            the normal sign-in.
          </p>

          {error && (
            <div
              role="alert"
              className="mt-4 text-sm text-red-200 bg-red-500/15 border border-red-500/40 rounded-md px-3 py-2"
            >
              {error}
            </div>
          )}

          <form onSubmit={submit} className="mt-5 space-y-4" noValidate>
            <label className="block">
              <span className="block text-xs font-medium text-gray-300 mb-1">
                Email
              </span>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="username"
                autoFocus
                className="w-full text-sm bg-white/5 border border-white/15 text-white rounded-md px-3 py-2 placeholder:text-gray-500 focus:outline-none focus:ring-2 focus:ring-teams-purple/60"
                placeholder="admin@example.com"
              />
            </label>

            <label className="block">
              <span className="block text-xs font-medium text-gray-300 mb-1">
                Password
              </span>
              <span className="relative block">
                <input
                  type={show ? "text" : "password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="current-password"
                  className="w-full text-sm bg-white/5 border border-white/15 text-white rounded-md px-3 py-2 pr-16 focus:outline-none focus:ring-2 focus:ring-teams-purple/60"
                />
                <button
                  type="button"
                  onClick={() => setShow((s) => !s)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-gray-400 hover:text-white px-1"
                >
                  {show ? "Hide" : "Show"}
                </button>
              </span>
            </label>

            <button
              type="submit"
              disabled={loading || !email.trim() || !password}
              className="w-full bg-teams-purple hover:bg-teams-purpleDark text-white text-sm font-medium rounded-md py-2.5 transition disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {loading ? "Signing in…" : "Sign in"}
            </button>
          </form>
        </div>

        <div className="text-center mt-5">
          <Link
            href="/dashboard"
            className="text-sm text-gray-400 hover:text-white transition"
          >
            ← Back to the app
          </Link>
        </div>
      </div>
    </div>
  );
}
