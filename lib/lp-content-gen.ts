/**
 * Landing page content generator.
 *
 * Writes the copy of a personalized landing page for each lead from what the lead
 * research found (company context and observations). The page is generated ONCE at
 * sequence-gen time and stored in Lead.landingPageContentJson.
 *
 * It states no research findings. Until November 16, 2026 it asked a model for
 * "synthetic research findings" through a Gather MCP address that was the docs page,
 * so the call always failed and the findings were made up (with hard-coded stats as
 * the last fallback). A page shows research only from a real Gather report.
 *
 * The same content is fed back into the email prompt so emails reference
 * what is actually on the page — not a generic "check out this link."
 */

import type { LeadResearch } from "@/lib/research";
import { callAnthropic } from "@/lib/anthropic";
import { unsupportedNumber } from "@/lib/lp-display";

/** Kept for pages stored before November 16, 2026; new pages have none and none are shown. */
export interface SyntheticFinding {
  label: string;
  value: string;
  insight: string;
}

export interface LandingPageContent {
  /** 2: written without findings (November 16, 2026 on); absent on pages stored before. */
  version?: number;
  headline: string;
  subheadline: string;
  senderIntro: string;              // "I noticed X about [Company] — wanted to share this before reaching out"
  observations: string[];           // same as research.observations, shown as bullet insights
  /** No longer written (always empty on new pages); pages stored before November 16, 2026 may have them, and they are not shown. */
  assetType: string;
  assetTitle: string;
  assetSummary: string;
  assetFindings: SyntheticFinding[];
  socialProof: string;              // the workspace's own social proof, never written by the model
  ctaLabel: string;
  ctaUrl: string;
}

interface ContentGenInput {
  name: string | null;
  jobTitle: string | null;
  company: string | null;
  industry: string | null;
  research: LeadResearch;
  productSummary: string;
  senderName: string;
  socialProof: string;
  ctaUrl: string;
}

/** What the model is told never to write: the page has no research behind it. */
export const NO_FINDINGS_RULE =
  "Do not state any statistic, percentage, number of respondents, survey, study, research finding or result, and do not say you made a report or brief for them: none exists. Write only from the prospect details and research insights above.";

/** Writes the page's copy from the lead research; no findings. */
export async function generateLandingPageContent(
  input: ContentGenInput,
  anthropicKey: string
): Promise<LandingPageContent> {
  const { name, jobTitle, company, industry, research, productSummary, senderName, ctaUrl } = input;
  const firstName = name?.split(/\s+/)[0] || "there";

  const prompt = `You are writing the copy for a personalized landing page for a sales prospect.

PROSPECT:
- Name: ${name ?? "unknown"}
- Title: ${jobTitle ?? "unknown"}
- Company: ${company ?? "unknown"}
- Industry: ${industry ?? "unknown"}

RESEARCH INSIGHTS:
- Company context: ${research.companyContext}
- Observations: ${research.observations.join("; ")}
- Most likely use case: ${research.likelyUseCase}
- Why this product matters to them: ${research.relevanceReason}

PRODUCT BEING SOLD:
${productSummary}

SENDER:
${senderName}

${NO_FINDINGS_RULE}

Return a JSON object with EXACTLY these keys — no markdown, no preamble:
{
  "headline": "A specific, compelling headline for ${firstName} at ${company ?? "their company"} about their situation and what the product could do for them",
  "subheadline": "1–2 sentences: specific context about their situation",
  "senderIntro": "1–2 sentences written as ${senderName}: what prompted reaching out, referencing a specific observation about ${company ?? "the company"} — conversational, not salesy",
  "ctaLabel": "Short CTA button label (e.g. 'Book a 20-min demo', 'See how it works', 'Get a live walkthrough')"
}`;

  try {
    const { text } = await callAnthropic(anthropicKey, prompt, { model: "claude-haiku-4-5", maxTokens: 800 });
    const clean = text.replace(/```json|```/g, "").trim();
    const lastJson = extractLastJson(clean);
    if (lastJson) return normaliseLandingPageContent(JSON.parse(lastJson), input);
  } catch {
    // Fall through to the plain page.
  }
  return buildFallback(input);
}

/** Extract the last {...} block from a string (handles preamble/postamble). */
function extractLastJson(text: string): string | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return null;
  return text.slice(start, end + 1);
}

/**
 * The model's copy, with what the page shows from elsewhere: the lead research, the workspace's
 * social proof and the campaign's link. Nothing the model adds beyond its four keys is kept, and
 * copy that states a number the inputs do not have (a made-up stat) is replaced by plain copy.
 */
export function normaliseLandingPageContent(parsed: Partial<LandingPageContent>, input: ContentGenInput): LandingPageContent {
  const fallback = buildFallback(input);
  const { research } = input;
  const source = [
    input.name, input.jobTitle, input.company, input.industry,
    research.companyContext, ...research.observations, research.likelyUseCase, research.relevanceReason,
    input.productSummary, input.socialProof,
  ].filter(Boolean).join("\n");
  const text = (v: unknown) => (typeof v === "string" && v.trim() && !unsupportedNumber(v, source) ? v.trim() : null);
  return {
    ...fallback,
    headline: text(parsed.headline) ?? fallback.headline,
    subheadline: text(parsed.subheadline) ?? fallback.subheadline,
    senderIntro: text(parsed.senderIntro) ?? fallback.senderIntro,
    ctaLabel: text(parsed.ctaLabel) ?? fallback.ctaLabel,
  };
}

/** The page from the lead research alone, with no findings and no brief. */
export function buildFallback(input: ContentGenInput): LandingPageContent {
  const { name, company, research, ctaUrl } = input;
  const firstName = name?.split(/\s+/)[0] || "there";
  return {
    version: 2,
    headline: `A note for ${company ?? firstName}`,
    subheadline: research.relevanceReason,
    senderIntro: `I noticed ${research.companyContext} and wanted to share something relevant before reaching out.`,
    observations: research.observations,
    assetType: "",
    assetTitle: "",
    assetSummary: "",
    assetFindings: [],
    socialProof: input.socialProof || "",
    ctaLabel: "Book a 20-min demo",
    ctaUrl: ctaUrl || "#",
  };
}

/** Produce a plain-text summary of landing page content for use in email prompts. */
export function landingPageContentForEmailPrompt(content: LandingPageContent, lpUrl: string): string {
  return `\n\nPersonalized landing page: ${lpUrl}

What's on the page (reference these specifically in the emails — do NOT just say "here's a link"):
- Headline: "${content.headline}"
- The page opens with: "${content.senderIntro}"
- Key observations about their situation: ${content.observations.slice(0, 2).join("; ")}
- Page ends with CTA: "${content.ctaLabel}"

Write at least one email that SPECIFICALLY references what's on the page. ${NO_FINDINGS_RULE}`;
}
