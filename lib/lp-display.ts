import type { LandingPageContent } from "@/lib/lp-content-gen";

/**
 * What a landing page shows of its stored content.
 *
 * Pages stored before November 16, 2026 (no `version`) were written with made-up
 * research: findings, a sample brief, and copy told to promise results ("cut research
 * time by 10x") and to say what the brief showed. On those pages the findings and the
 * brief are never shown, and a headline, subheadline or note that talks about research
 * or states a number the lead research does not have falls back to plain copy.
 *
 * The one exception is a page someone made by hand with a real chart or a link to a
 * real brief: it keeps its brief box and its copy, but no findings grid either.
 */

/** The default line the old generator gave the model when a workspace had no social proof. */
export const MADE_UP_PROOF = "Companies using AI-powered research have cut insight time from weeks to hours.";

/** Numbers in copy: 10 in "10x", 34 in "34%", 1,200 in "1,200 respondents". */
const NUMBER = /\d(?:[\d,.]*\d)?/g;

/** True when the copy states a number the source text does not have, so the model made it up. */
export function unsupportedNumber(text: string | null | undefined, source: string): boolean {
  if (!text) return false;
  const known = new Set(source.match(NUMBER) ?? []);
  return (text.match(NUMBER) ?? []).some((n) => !known.has(n));
}

/** Copy about research. On a page stored before November 16, 2026 it is about the made-up brief. */
const ABOUT_RESEARCH = /\b(?:brief|report|research|stud(?:y|ies)|survey\w*|findings?|data|respondents?|interview\w*|insights?|sample)\b/i;

export type Shown = {
  content: LandingPageContent;
  /** The research brief box: only a page made by hand with a real chart or a link to the brief. */
  showBrief: boolean;
};

type Stored = LandingPageContent & { version?: number; chartUrl?: string; previewLinkUrl?: string };

export function shownContent(stored: Stored, who: { firstName: string; company: string | null }): Shown {
  const observations = Array.isArray(stored.observations) ? stored.observations : [];
  const showBrief = Boolean(stored.chartUrl || stored.previewLinkUrl);
  const checked = stored.version !== 2 && !showBrief;
  const known = observations.join("\n");
  const plain = (text: string, fallback: string) =>
    checked && text && (ABOUT_RESEARCH.test(text) || unsupportedNumber(text, known)) ? fallback : text;
  const content: LandingPageContent = {
    ...stored,
    headline: plain(stored.headline, `A note for ${who.company ?? who.firstName}`),
    subheadline: plain(stored.subheadline, ""),
    senderIntro: plain(stored.senderIntro, ""),
    observations,
    assetFindings: [],
    socialProof: stored.socialProof === MADE_UP_PROOF ? "" : stored.socialProof,
  };
  return { content, showBrief };
}
