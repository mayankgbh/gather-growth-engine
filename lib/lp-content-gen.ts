/**
 * Landing page content generator.
 *
 * Calls Claude (Sonnet) with the Gather synthetic data MCP to produce a rich,
 * personalized landing page for each lead. The page is generated ONCE at
 * sequence-gen time and stored in Lead.landingPageContentJson.
 *
 * The same content is fed back into the email prompt so emails reference
 * what is actually on the page — not a generic "check out this link."
 */

import type { LeadResearch } from "@/lib/research";

export interface SyntheticFinding {
  label: string;    // metric name, e.g. "Brand awareness lift"
  value: string;    // e.g. "34%"
  insight: string;  // 1-sentence interpretation
}

export interface LandingPageContent {
  headline: string;
  subheadline: string;
  senderIntro: string;              // "I noticed X about [Company] — wanted to share this before reaching out"
  observations: string[];           // same as research.observations, shown as bullet insights
  assetType: string;                // e.g. "brand_health_brief"
  assetTitle: string;               // e.g. "Sample: AI-powered brand health brief for Acme"
  assetSummary: string;             // 2–3 sentences framing what the brief covers
  assetFindings: SyntheticFinding[];
  assetSource: "gather" | "illustrative"; // "illustrative" = written by the LLM, not Gather research
  socialProof: string;              // 1–2 sentences of relevant proof
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

const SYNTHETIC_MCP_URL = "https://synthetic.gatherhq.com/api/v1/mcp";
const ANTHROPIC_API = "https://api.anthropic.com/v1/messages";

/** 
 * Calls Claude with the Gather synthetic MCP to generate a research asset,
 * then wraps it in a full LandingPageContent structure.
 */
export async function generateLandingPageContent(
  input: ContentGenInput,
  anthropicKey: string,
  gatherKey?: string | null
): Promise<LandingPageContent> {
  const { name, jobTitle, company, industry, research, productSummary, senderName, socialProof, ctaUrl } = input;
  const firstName = name?.split(/\s+/)[0] || "there";

  const prompt = `You are building a personalized landing page for a sales prospect. Use the Gather synthetic data tool to generate realistic research findings that would be relevant to this person's role and situation.

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
- Asset angle: ${research.assetAngle}

PRODUCT BEING SOLD:
${productSummary}

SENDER:
${senderName}

Use the synthetic data tool to generate 3–4 realistic research findings for a "${research.assetAngle}" relevant to ${company ?? "their company"} in the ${industry ?? "their"} industry. Make the findings specific, credible, and directly relevant to the prospect's role (${jobTitle ?? "their role"}).

Then return a JSON object with EXACTLY these keys — no markdown, no preamble:
{
  "headline": "A specific, compelling headline for ${firstName} at ${company ?? "their company"} — what insight or outcome awaits them (e.g. 'How [Company] could cut research time by 10x')",
  "subheadline": "1–2 sentences: specific context about their situation and what this page shows them",
  "senderIntro": "1–2 sentences written as ${senderName}: what prompted reaching out, referencing a specific observation about ${company ?? "the company"} — conversational, not salesy",
  "observations": ${JSON.stringify(research.observations)},
  "assetType": "slug for asset type, e.g. brand_health_brief or competitive_snapshot",
  "assetTitle": "Title of the synthetic research asset — include company name",
  "assetSummary": "2–3 sentences framing what this asset shows and why it matters for their role",
  "assetFindings": [
    { "label": "metric name", "value": "number or %", "insight": "1-sentence interpretation" },
    { "label": "...", "value": "...", "insight": "..." },
    { "label": "...", "value": "...", "insight": "..." }
  ],
  "socialProof": "${socialProof || "Companies using AI-powered research have cut insight time from weeks to hours."}",
  "ctaLabel": "Short CTA button label (e.g. 'Book a 20-min demo', 'See how it works', 'Get a live walkthrough')",
  "ctaUrl": "${ctaUrl}"
}`;

  // Try with synthetic MCP first (Sonnet for tool use). The server needs a Gather key; skip without one.
  if (gatherKey) try {
    const res = await fetch(ANTHROPIC_API, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": anthropicKey,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "mcp-client-2025-04-04",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-5",
        max_tokens: 1500,
        mcp_servers: [
          {
            type: "url",
            url: SYNTHETIC_MCP_URL,
            name: "gather-synthetic",
            authorization_token: gatherKey,
          },
        ],
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (res.ok) {
      const data = await res.json();
      // Only label the asset "gather" when a Gather tool call actually returned a result
      const usedGather = (data.content ?? []).some((b: { type: string; is_error?: boolean }) => b.type === "mcp_tool_result" && !b.is_error);
      // Extract the final text block (after any MCP tool use)
      const textBlocks = (data.content ?? []).filter((b: { type: string }) => b.type === "text");
      const rawText = textBlocks.map((b: { text: string }) => b.text).join("").trim();
      if (rawText) {
        const clean = rawText.replace(/```json|```/g, "").trim();
        const lastJson = extractLastJson(clean);
        if (lastJson) {
          return normaliseLandingPageContent({ ...JSON.parse(lastJson), assetSource: usedGather ? "gather" : "illustrative" }, ctaUrl);
        }
      }
    } else {
      console.warn(`Gather MCP call failed: ${res.status} - ${await res.text().catch(() => "")}`);
    }
  } catch (err) {
    console.warn("Gather MCP call failed:", err instanceof Error ? err.message : err);
  }

  // Fallback: Claude without MCP (Haiku, cheaper, still generates synthetic data inline)
  const { callAnthropic } = await import("@/lib/anthropic");
  const fallbackPrompt = prompt + "\n\nIMPORTANT: You don't have tool access. Generate the synthetic findings yourself — make them realistic and specific to their industry and role. Return ONLY the JSON object.";
  const { text } = await callAnthropic(anthropicKey, fallbackPrompt, {
    model: "claude-haiku-4-5",
    maxTokens: 1500,
  });
  const clean = text.replace(/```json|```/g, "").trim();
  const lastJson = extractLastJson(clean);
  if (lastJson) {
    return normaliseLandingPageContent({ ...JSON.parse(lastJson), assetSource: "illustrative" }, ctaUrl);
  }

  // Hard fallback: minimal valid content
  return buildFallback(input);
}

/** Extract the last {...} block from a string (handles preamble/postamble). */
function extractLastJson(text: string): string | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return null;
  return text.slice(start, end + 1);
}

export function normaliseLandingPageContent(parsed: Partial<LandingPageContent>, ctaUrl: string): LandingPageContent {
  return {
    headline: parsed.headline ?? "A research brief, just for you",
    subheadline: parsed.subheadline ?? "",
    senderIntro: parsed.senderIntro ?? "",
    observations: Array.isArray(parsed.observations) ? parsed.observations : [],
    assetType: parsed.assetType ?? "research_brief",
    assetTitle: parsed.assetTitle ?? "Sample research brief",
    assetSummary: parsed.assetSummary ?? "",
    assetFindings: Array.isArray(parsed.assetFindings) ? parsed.assetFindings.slice(0, 4) : [],
    assetSource: parsed.assetSource === "gather" ? "gather" : "illustrative",
    socialProof: parsed.socialProof ?? "",
    ctaLabel: parsed.ctaLabel ?? "Book a demo",
    ctaUrl: ctaUrl || parsed.ctaUrl || "#",
  };
}

export function buildFallback(input: ContentGenInput): LandingPageContent {
  const { name, company, research, ctaUrl } = input;
  const firstName = name?.split(/\s+/)[0] || "there";
  return {
    headline: `A quick ${research.assetAngle} for ${company ?? firstName}`,
    subheadline: research.relevanceReason,
    senderIntro: `I noticed ${research.companyContext} and wanted to share something relevant before reaching out.`,
    observations: research.observations,
    assetType: "research_brief",
    assetTitle: `Sample: ${research.assetAngle} for ${company ?? "your company"}`,
    assetSummary: `Based on what we know about ${company ?? "your company"}'s situation, here's what AI-powered research could surface.`,
    assetFindings: [],
    assetSource: "illustrative",
    socialProof: input.socialProof || "",
    ctaLabel: "Book a 20-min demo",
    ctaUrl: ctaUrl || "#",
  };
}

/** Produce a plain-text summary of landing page content for use in email prompts. */
export function landingPageContentForEmailPrompt(content: LandingPageContent, lpUrl: string): string {
  const findingsSummary = content.assetFindings
    .slice(0, 3)
    .map((f) => `${f.label}: ${f.value} — ${f.insight}`)
    .join("; ");

  return `\n\nPersonalized landing page: ${lpUrl}

What's on the page (reference these specifically in the emails — do NOT just say "here's a link"):
- Headline: "${content.headline}"
- The page opens with: "${content.senderIntro}"
- Key observations about their situation: ${content.observations.slice(0, 2).join("; ")}
- Synthetic research asset: "${content.assetTitle}" — ${content.assetSummary}
- Sample findings in the asset: ${findingsSummary}
- Page ends with CTA: "${content.ctaLabel}"

Write at least one email that SPECIFICALLY references what's on the page — e.g. "I put together ${content.assetTitle}" or "the brief I made covers [specific finding]". Make it feel like you built something FOR them, not just dropped a link.`;
}
