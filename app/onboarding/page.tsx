"use client";

import Link from "next/link";
import { useSession } from "next-auth/react";
import { useRouter } from "next/navigation";
import { useState, useEffect } from "react";
import { useAuthGuard } from "@/hooks/useAuthGuard";
import { APP_DISPLAY_NAME } from "@/lib/app-config";

export default function OnboardingPage() {
  const { ready, loading: guardLoading, session } = useAuthGuard();
  const router = useRouter();
  const [domain, setDomain] = useState("");
  const [senderName, setSenderName] = useState("");
  const [similarCompanies, setSimilarCompanies] = useState("");
  const [referralPhrase, setReferralPhrase] = useState("");
  const [anthropicKey, setAnthropicKey] = useState("");
  const [instantlyKey, setInstantlyKey] = useState("");
  const [lumaApiKey, setLumaApiKey] = useState("");
  const [runwayApiKey, setRunwayApiKey] = useState("");
  const [gatherApiKey, setGatherApiKey] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [existingData, setExistingData] = useState<any>(null);

  useEffect(() => {
    if (session?.user?.id) {
      fetch("/api/onboarding")
        .then((res) => res.json())
        .then((data) => {
          if (data.workspace) {
            setExistingData(data.workspace);
            setDomain(data.workspace.domain || "");
            setSenderName(data.workspace.senderName || "");
            if (data.workspace.socialProofJson) {
              try {
                const sp = JSON.parse(data.workspace.socialProofJson);
                setSimilarCompanies(sp.similarCompanies || "");
                setReferralPhrase(sp.referralPhrase || "");
              } catch {
                //
              }
            }
          }
        })
        .catch(console.error);
    }
  }, [session]);

  if (guardLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <p className="text-zinc-400">Loading...</p>
      </div>
    );
  }

  if (!session) {
    router.push("/login");
    return null;
  }

  if (!ready) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <p className="text-zinc-400">Loading...</p>
      </div>
    );
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      const res = await fetch("/api/onboarding", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          domain,
          senderName: senderName.trim() || null,
          similarCompanies: similarCompanies.trim() || null,
          referralPhrase: referralPhrase.trim() || null,
          anthropicKey,
          instantlyKey,
          lumaApiKey,
          runwayApiKey,
          gatherApiKey,
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.error || "Something went wrong");
        setLoading(false);
        return;
      }

      router.push("/dashboard");
      router.refresh();
    } catch (err) {
      setError("Something went wrong. Please try again.");
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen">
      <header className="border-b border-zinc-800 px-6 py-4">
        <div className="mx-auto flex max-w-6xl items-center justify-between">
          <Link href="/dashboard" className="text-lg font-semibold">
            {APP_DISPLAY_NAME}
          </Link>
          <Link href="/dashboard" className="text-zinc-400 hover:text-zinc-100">
            &lt;- Dashboard
          </Link>
        </div>
      </header>

      <main className="mx-auto max-w-2xl px-6 py-12">
        <h1 className="text-2xl font-semibold">Settings</h1>
        <p className="mt-2 text-zinc-400">
          Enter your domain to get started. You can add API keys now or later — we&apos;ll take you to the dashboard either way.
        </p>
        <p className="mt-1 text-sm text-zinc-500">
          Need keys? Both are free. We&apos;ll show you exactly where to get them (about 2 minutes).
        </p>

        {existingData && (
          <div className="mt-4 rounded-md bg-emerald-900/20 border border-emerald-800 px-4 py-3 text-sm text-emerald-300">
            You already have onboarding data saved. Update it below or continue to dashboard.
          </div>
        )}

        <form className="mt-10 space-y-8" onSubmit={handleSubmit}>
          {error && (
            <div className="rounded-md bg-red-900/20 border border-red-800 px-4 py-3 text-sm text-red-300">
              {error}
            </div>
          )}

          <div>
            <label htmlFor="sender_name" className="block text-sm font-medium text-zinc-300">
              Sender name (for email sign-off)
            </label>
            <input
              id="sender_name"
              name="sender_name"
              type="text"
              placeholder="e.g. John Smith, Gather"
              value={senderName}
              onChange={(e) => setSenderName(e.target.value)}
              className="mt-2 w-full rounded-md border border-zinc-700 bg-zinc-900 px-4 py-3 text-zinc-100 placeholder-zinc-500 focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
            />
            <p className="mt-1 text-xs text-zinc-500">
              How to sign off cold emails. Never use the recipient&apos;s name here — only yours or your team&apos;s.
            </p>
          </div>

          <div>
            <label htmlFor="domain" className="block text-sm font-medium text-zinc-300">
              Your domain
            </label>
            <input
              id="domain"
              name="domain"
              type="text"
              required
              placeholder="acme.com"
              value={domain}
              onChange={(e) => setDomain(e.target.value)}
              className="mt-2 w-full rounded-md border border-zinc-700 bg-zinc-900 px-4 py-3 text-zinc-100 placeholder-zinc-500 focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
            />
            <p className="mt-1 text-xs text-zinc-500">
              We'll crawl the home page of this domain to understand your product.
            </p>
          </div>

          <div>
            <label htmlFor="similar_companies" className="block text-sm font-medium text-zinc-300">
              Social proof — similar companies
            </label>
            <input
              id="similar_companies"
              name="similar_companies"
              type="text"
              placeholder="e.g. Acme, Beta Corp, Gamma Inc"
              value={similarCompanies}
              onChange={(e) => setSimilarCompanies(e.target.value)}
              className="mt-2 w-full rounded-md border border-zinc-700 bg-zinc-900 px-4 py-3 text-zinc-100 placeholder-zinc-500 focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
            />
            <p className="mt-1 text-xs text-zinc-500">
              Companies like yours we&apos;ve helped. AI will weave these into emails (e.g. &quot;Companies like Acme and Beta use us for...&quot;).
            </p>
          </div>
          <div>
            <label htmlFor="referral_phrase" className="block text-sm font-medium text-zinc-300">
              Social proof — referral phrase
            </label>
            <input
              id="referral_phrase"
              name="referral_phrase"
              type="text"
              placeholder="e.g. John from [Company] suggested I reach out"
              value={referralPhrase}
              onChange={(e) => setReferralPhrase(e.target.value)}
              className="mt-2 w-full rounded-md border border-zinc-700 bg-zinc-900 px-4 py-3 text-zinc-100 placeholder-zinc-500 focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
            />
            <p className="mt-1 text-xs text-zinc-500">
              Template for referral intros. Use [Company] as placeholder. AI will use when relevant.
            </p>
          </div>

          <div className="space-y-4">
            <h2 className="text-sm font-medium text-zinc-300">API keys (optional for now)</h2>
            <p className="text-xs text-zinc-500">
              Add these when you&apos;re ready to crawl, generate playbooks, and send campaigns. Encrypted and used only for your account.
            </p>
            <div>
              <label htmlFor="anthropic_key" className="block text-sm text-zinc-400">
                Anthropic API key
              </label>
              <p className="mt-0.5 text-xs text-zinc-500">
                <a
                  href="https://console.anthropic.com/settings/keys"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-emerald-500 hover:text-emerald-400"
                >
                  Get your key at console.anthropic.com →
                </a>
              </p>
              <input
                id="anthropic_key"
                name="anthropic_key"
                type="password"
                placeholder="sk-ant-..."
                value={anthropicKey}
                onChange={(e) => setAnthropicKey(e.target.value)}
                className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-900 px-4 py-3 text-zinc-100 placeholder-zinc-500 focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
              />
            </div>
            <div>
              <label htmlFor="instantly_key" className="block text-sm text-zinc-400">
                Instantly API key
              </label>
              <p className="mt-0.5 text-xs text-zinc-500">
                <a
                  href="https://app.instantly.ai/app/settings/integrations"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-emerald-500 hover:text-emerald-400"
                >
                  Get your key in Instantly → Settings → Integrations → API Keys →
                </a>
              </p>
              <input
                id="instantly_key"
                name="instantly_key"
                type="password"
                placeholder="Paste your Instantly API key"
                value={instantlyKey}
                onChange={(e) => setInstantlyKey(e.target.value)}
                className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-900 px-4 py-3 text-zinc-100 placeholder-zinc-500 focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
              />
            </div>
            <div>
              <label htmlFor="gather_key" className="block text-sm text-zinc-400">
                Gather API key
              </label>
              <p className="mt-0.5 text-xs text-zinc-500">
                Optional. Landing page findings come from Gather research; without a key they are labeled illustrative.{" "}
                <a
                  href="https://www.gatherhq.com/docs/quickstart"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-emerald-500 hover:text-emerald-400"
                >
                  Get a key →
                </a>
              </p>
              <input
                id="gather_key"
                name="gather_key"
                type="password"
                placeholder={existingData?.hasGatherKey ? "•••••••• (leave blank to keep)" : "gk_..."}
                value={gatherApiKey}
                onChange={(e) => setGatherApiKey(e.target.value)}
                className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-900 px-4 py-3 text-zinc-100 placeholder-zinc-500 focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
              />
            </div>
            <p className="text-xs text-zinc-500 mt-4">
              Optional: Add a video API key to enable AI-generated personalized videos in campaigns (coming soon).
            </p>
            <div>
              <label htmlFor="luma_key" className="block text-sm text-zinc-400">
                Luma Dream Machine API key
              </label>
              <p className="mt-0.5 text-xs text-zinc-500">
                <a
                  href="https://lumalabs.ai/dream-machine/api"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-emerald-500 hover:text-emerald-400"
                >
                  Get your key at lumalabs.ai →
                </a>
              </p>
              <input
                id="luma_key"
                name="luma_key"
                type="password"
                placeholder={existingData?.hasLumaKey ? "•••••••• (leave blank to keep)" : "Optional"}
                value={lumaApiKey}
                onChange={(e) => setLumaApiKey(e.target.value)}
                className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-900 px-4 py-3 text-zinc-100 placeholder-zinc-500 focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
              />
            </div>
            <div>
              <label htmlFor="runway_key" className="block text-sm text-zinc-400">
                Runway API key
              </label>
              <p className="mt-0.5 text-xs text-zinc-500">
                <a
                  href="https://docs.runwayml.com/docs/api-get-started"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-emerald-500 hover:text-emerald-400"
                >
                  Get your key at runwayml.com →
                </a>
              </p>
              <input
                id="runway_key"
                name="runway_key"
                type="password"
                placeholder={existingData?.hasRunwayKey ? "•••••••• (leave blank to keep)" : "Optional"}
                value={runwayApiKey}
                onChange={(e) => setRunwayApiKey(e.target.value)}
                className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-900 px-4 py-3 text-zinc-100 placeholder-zinc-500 focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
              />
            </div>
          </div>

          <button
            type="submit"
            disabled={loading}
            className="w-full rounded-md bg-emerald-600 py-3 font-medium text-white hover:bg-emerald-500 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {loading ? "Saving..." : existingData ? "Update and continue" : "Save and continue"}
          </button>
        </form>
      </main>
    </div>
  );
}
