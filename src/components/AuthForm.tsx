"use client";

import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";

export default function AuthForm({ mode }: { mode: "login" | "register" }) {
  const router = useRouter();
  const params = useSearchParams();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const isRegister = mode === "register";

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await fetch(`/api/auth/${mode}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          isRegister ? { name, email, password } : { email, password }
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
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-[#e8e8f8] via-[#f5f5f5] to-[#e3e3f6] px-4">
      <div className="w-full max-w-md bg-white rounded-2xl shadow-xl p-8 border border-teams-line">
        <div className="mb-6">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/logo.svg"
            alt="Race Innovations"
            className="h-16 w-auto object-contain mb-4"
          />
          <h1 className="text-xl font-semibold text-teams-dark leading-tight">
            {isRegister ? "Create your account" : "Welcome back"}
          </h1>
          <p className="text-sm text-teams-gray">
            {isRegister ? "Sign up to start meeting" : "Sign in to start meeting"}
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          {isRegister && (
            <Field
              label="Full name"
              type="text"
              value={name}
              onChange={setName}
              placeholder="Ada Lovelace"
              autoComplete="name"
              required
            />
          )}
          <Field
            label="Email"
            type="email"
            value={email}
            onChange={setEmail}
            placeholder="you@example.com"
            autoComplete="email"
            required
          />
          <Field
            label="Password"
            type="password"
            value={password}
            onChange={setPassword}
            placeholder="••••••••"
            autoComplete={isRegister ? "new-password" : "current-password"}
            required
          />

          {error && (
            <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-md px-3 py-2">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full bg-teams-purple hover:bg-teams-purpleDark disabled:opacity-60 text-white font-medium rounded-md py-2.5 transition-colors"
          >
            {loading
              ? "Please wait…"
              : isRegister
              ? "Create account"
              : "Sign in"}
          </button>
        </form>

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
  required,
}: {
  label: string;
  type: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  autoComplete?: string;
  required?: boolean;
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
        required={required}
        className="mt-1 w-full rounded-md border border-teams-line px-3 py-2 outline-none focus:border-teams-purple focus:ring-1 focus:ring-teams-purple"
      />
    </label>
  );
}
