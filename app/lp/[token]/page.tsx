import { prisma } from "@/lib/prisma";
import { notFound } from "next/navigation";
import type { LandingPageContent } from "@/lib/lp-content-gen";

export const dynamic = "force-dynamic";

export default async function LandingPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  if (!token?.trim()) notFound();

  const lead = await prisma.lead.findFirst({
    where: { landingPageToken: token.trim() },
    select: {
      name: true,
      company: true,
      jobTitle: true,
      email: true,
      landingPageContentJson: true,
    },
  });

  if (!lead) notFound();

  const firstName = lead.name?.split(/\s+/)[0] || "there";

  let content: LandingPageContent | null = null;
  try {
    if (lead.landingPageContentJson) {
      content = JSON.parse(lead.landingPageContentJson) as LandingPageContent;
    }
  } catch { /* fall through */ }

  if (!content) {
    return (
      <div className="min-h-screen bg-[#0a0a0b] text-zinc-100 flex items-center justify-center p-6">
        <div className="max-w-xl text-center space-y-4">
          <h1 className="text-2xl font-semibold">Hi {firstName}{lead.company ? ` from ${lead.company}` : ""},</h1>
          <p className="text-zinc-400">This page was made just for you. Check your email for the full message.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#0a0a0b] text-zinc-100">
      <div className="h-px bg-gradient-to-r from-transparent via-emerald-500/40 to-transparent" />

      <div className="max-w-4xl mx-auto px-6 py-16 space-y-16">

        <header className="space-y-5">
          <div className="inline-flex items-center gap-2 rounded-full border border-zinc-800 bg-zinc-900/60 px-3 py-1 text-xs text-zinc-500">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />
            Made for {firstName}{lead.company ? ` · ${lead.company}` : ""}
          </div>
          <h1 className="text-3xl font-semibold leading-snug tracking-tight text-zinc-50">
            {content.headline}
          </h1>
          <p className="text-lg text-zinc-400 leading-relaxed">{content.subheadline}</p>
        </header>

        {content.senderIntro && (() => {
          const c = content as LandingPageContent & { noteHeader?: string; noteHeaderSize?: string; noteHeaderColor?: string };
          const hasOverride = c.noteHeaderSize || c.noteHeaderColor;
          return (
            <section className="rounded-xl border border-zinc-800/80 bg-zinc-900/40 p-6">
              <p
                className={hasOverride ? "font-semibold mb-3" : "text-xs font-semibold uppercase tracking-widest text-zinc-500 mb-3"}
                style={{ fontSize: c.noteHeaderSize, color: c.noteHeaderColor }}
              >
                {c.noteHeader || "A note before you read"}
              </p>
              <p className="text-zinc-300 leading-relaxed">{content.senderIntro}</p>
            </section>
          );
        })()}

        {content.observations.length > 0 && (
          <section className="space-y-4">
            <h2 className="text-xs font-semibold uppercase tracking-widest text-zinc-500">{(content as LandingPageContent & { observationsHeader?: string }).observationsHeader || "What we found"}</h2>
            <ul className="space-y-3">
              {content.observations.map((obs: string, i: number) => (
                <li key={i} className="flex gap-3 items-start">
                  <span className="mt-0.5 flex-shrink-0 h-5 w-5 rounded-full bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center">
                    <svg className="h-2.5 w-2.5 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                    </svg>
                  </span>
                  <p className="text-zinc-300 text-sm leading-relaxed">{obs}</p>
                </li>
              ))}
            </ul>
          </section>
        )}

        <section className="rounded-xl border border-zinc-800 bg-zinc-900/30 overflow-hidden">
          <div className="border-b border-zinc-800 px-6 py-4 flex items-start justify-between gap-4">
            <div className="space-y-1">
              <p className="text-xs font-medium uppercase tracking-widest text-emerald-500/80">{(content as LandingPageContent & { researchBriefLabel?: string }).researchBriefLabel || "Research brief"}</p>
              <h3 className="text-base font-semibold text-zinc-100">{content.assetTitle}</h3>
            </div>
            <span className="flex-shrink-0 rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1 text-xs text-zinc-500">
              {content.assetSource === "gather" ? "Sample" : "Illustrative example, not research"}
            </span>
          </div>

          {content.assetSummary && (
            <div className="px-6 pt-5 pb-2">
              <p className="text-sm text-zinc-400 leading-relaxed">{content.assetSummary}</p>
            </div>
          )}

          {content.assetFindings.length > 0 && (
            <div className="px-6 py-5 grid grid-cols-1 gap-4 sm:grid-cols-3">
              {content.assetFindings.map((f: { label: string; value: string; insight: string }, i: number) => (
                <div key={i} className="rounded-lg bg-zinc-800/50 border border-zinc-700/50 p-4 space-y-1">
                  <p className="text-xs text-zinc-500 uppercase tracking-wider font-medium">{f.label}</p>
                  <p className="text-2xl font-semibold text-zinc-100 tabular-nums">{f.value}</p>
                  <p className="text-xs text-zinc-500 leading-relaxed">{f.insight}</p>
                </div>
              ))}
            </div>
          )}

          {(content as LandingPageContent & { chartUrl?: string }).chartUrl && (
            <div className="px-6 pb-5">
              <img
                src={(content as LandingPageContent & { chartUrl?: string }).chartUrl}
                alt={content.assetTitle || "Research chart"}
                className="w-full rounded-lg border border-zinc-700/50"
              />
            </div>
          )}

          <div className="relative px-6 pb-6">
            <div className="rounded-lg bg-zinc-800/30 border border-zinc-700/30 p-4 select-none">
              <div className="space-y-2 blur-sm pointer-events-none">
                <div className="h-2 bg-zinc-700 rounded w-3/4" />
                <div className="h-2 bg-zinc-700 rounded w-1/2" />
                <div className="h-2 bg-zinc-700 rounded w-5/6" />
                <div className="h-2 bg-zinc-700 rounded w-2/3" />
              </div>
              <div className="absolute inset-0 flex items-center justify-center rounded-lg">
                {(() => {
                  const c = content as LandingPageContent & { previewLabel?: string; previewLinkUrl?: string };
                  const label = c.previewLabel || "Full brief available in demo";
                  return c.previewLinkUrl ? (
                    <a
                      href={c.previewLinkUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs text-zinc-300 bg-zinc-900/80 border border-zinc-700 rounded-full px-3 py-1 hover:text-white hover:border-zinc-500 transition-colors"
                    >
                      {label} →
                    </a>
                  ) : (
                    <p className="text-xs text-zinc-400 bg-zinc-900/80 border border-zinc-700 rounded-full px-3 py-1">{label}</p>
                  );
                })()}
              </div>
            </div>
          </div>
        </section>

        {content.socialProof && (
          <section className="border-l-2 border-emerald-500/30 pl-5">
            <p className="text-sm text-zinc-400 italic leading-relaxed">{content.socialProof}</p>
          </section>
        )}

        {content.ctaUrl && content.ctaUrl !== "#" && (
          <section className="text-center space-y-4 pb-8">
            <a
              href={content.ctaUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-8 py-3.5 text-base font-medium text-white hover:bg-emerald-500 transition-colors"
            >
              {content.ctaLabel || "Book a demo"}
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M17 8l4 4m0 0l-4 4m4-4H3" />
              </svg>
            </a>
            <p className="text-xs text-zinc-600">
              Made specifically for {firstName}{lead.company ? ` at ${lead.company}` : ""}.
            </p>
          </section>
        )}

      </div>

      <div className="h-px bg-gradient-to-r from-transparent via-zinc-800 to-transparent" />
      <div className="py-6 text-center">
        <p className="text-xs text-zinc-700">
          Personalized outreach powered by Gather ·{" "}
          <a href="https://gatherhq.com" className="hover:text-zinc-500 transition-colors">gatherhq.com</a>
        </p>
      </div>
    </div>
  );
}
