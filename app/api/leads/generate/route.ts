import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { decrypt } from "@/lib/encryption";
import { callAnthropic } from "@/lib/anthropic";
import { getAggregatedMemory } from "@/lib/performance-memory";
import { parsePlaybook } from "@/lib/playbook";
import { scrapeForContext } from "@/lib/scrape";
import { generateLeadResearch } from "@/lib/research";
import { generateLandingPageContent, landingPageContentForEmailPrompt } from "@/lib/lp-content-gen";
import { randomUUID } from "crypto";

// Allow up to 60s so a few Anthropic calls can finish (Vercel Pro; Hobby may still cap at 10s)
export const maxDuration = 60;

export async function POST(request: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json();
    const {
      batchId,
      offset: offsetParam,
      limit: limitParam,
      campaignId: campaignIdParam,
      useFastModel: useFastModelParam,
      useWebScraping: useWebScrapingParam,
      useLandingPage: useLandingPageParam,
      useVideo: useVideoParam,
    } = body as { batchId: string; offset?: number; limit?: number; campaignId?: string; useFastModel?: boolean; useWebScraping?: boolean; useLandingPage?: boolean; useVideo?: boolean };
    const useWebScraping = useWebScrapingParam === true;
    const useLandingPage = useLandingPageParam === true;
    const useVideo = useVideoParam === true;

    if (!batchId) {
      return NextResponse.json({ error: "batchId is required" }, { status: 400 });
    }
    const offset = Math.max(0, Number(offsetParam) || 0);
    // Haiku + parallel: each lead ~1–2s. 10 parallel ≈ 10–15s total per chunk.
    const CHUNK_SIZE = 10;
    const limit = Math.min(CHUNK_SIZE, Math.max(1, Number(limitParam) || CHUNK_SIZE));

    const workspace = await prisma.workspace.findUnique({
      where: { userId: session.user.id },
      select: { id: true, anthropicKey: true, gatherApiKey: true, anthropicModel: true, productSummary: true, icp: true, proofPointsJson: true, socialProofJson: true, playbookJson: true, senderName: true },
    });

    if (!workspace?.anthropicKey) {
      return NextResponse.json({ error: "Anthropic API key not configured." }, { status: 400 });
    }

    // When campaignId provided, use campaign's playbook/icp/proofPoints for this campaign flow
    let campaignPlaybook: string | null = null;
    let campaignIcp: string | null = null;
    let campaignProofPoints: string | null = null;
    let campaignCtaUrl: string | null = null;
    if (campaignIdParam) {
      const camp = await prisma.campaign.findFirst({
        where: { id: campaignIdParam, workspaceId: workspace.id },
        select: { playbookJson: true, icp: true, proofPointsJson: true, ctaUrl: true },
      });
      if (camp) {
        campaignPlaybook = camp.playbookJson;
        campaignIcp = camp.icp;
        campaignProofPoints = camp.proofPointsJson;
        campaignCtaUrl = camp.ctaUrl;
      }
    }

    const batch = await prisma.leadBatch.findFirst({
      where: { id: batchId, workspaceId: workspace.id },
      select: { id: true },
    });
    if (!batch) {
      return NextResponse.json({ error: "Batch not found" }, { status: 404 });
    }

    const needsWorkWhere = {
      leadBatchId: batchId,
      OR: [
        { stepsJson: null },
        { stepsJson: "" },
        { stepsJson: "[]" },
      ],
    };

    const [total, chunk] = await Promise.all([
      prisma.lead.count({ where: needsWorkWhere }),
      prisma.lead.findMany({
        where: needsWorkWhere,
        select: { id: true, email: true, name: true, jobTitle: true, company: true, website: true, industry: true, persona: true, vertical: true, videoUrl: true, landingPageToken: true },
        orderBy: { id: "asc" },
        skip: offset,
        take: limit,
      }),
    ]);
    if (chunk.length === 0) {
      return NextResponse.json({ done: 0, total, message: total === 0 ? "No leads to personalize." : "No leads in range." });
    }

    const playbookSource = campaignPlaybook ?? workspace.playbookJson;
    const parsed = parsePlaybook(playbookSource);
    if (!parsed) {
      return NextResponse.json({ error: "Invalid playbook. Define guidelines first." }, { status: 400 });
    }

    const { numSteps, guidelines, legacySteps } = parsed;
    const stepKeys = Array.from({ length: numSteps }, (_, i) => `step${i + 1}`).join(", ");
    const stepExample = Array.from({ length: numSteps }, (_, i) => `"step${i + 1}": {"subject": "...", "body": "..."}`).join(", ");

    const structureBlock = guidelines?.context
      ? `\n\nCampaign context & guidelines (use to shape every email — tone, angles, product framing, any URLs or research notes provided):\n${guidelines.context}`
      : guidelines?.structure
        ? `\nPlaybook structure (follow this flow, but write completely custom content for this lead):\n${guidelines.structure}\nTone: ${guidelines.tone}`
        : legacySteps?.length
          ? `\nRough flow (adapt freely, write custom content): ${legacySteps.map((s, i) => `Step ${i + 1}: ${(s.subject || "").slice(0, 50)}`).join(" → ")}`
          : "";

    const anthropicKey = decrypt(workspace.anthropicKey);
    const gatherKey = workspace.gatherApiKey ? decrypt(workspace.gatherApiKey) : null;
    const useFastModel = useFastModelParam !== false;
    const model = useFastModel ? "claude-haiku-4-5" : (workspace.anthropicModel ?? "claude-haiku-4-5");
    const productSummary = workspace.productSummary ?? "";
    const icp = (campaignIcp ?? workspace.icp) ?? "";

    const proofPointsJsonSource = campaignProofPoints ?? workspace.proofPointsJson;
    let proofPointsText = "";
    if (proofPointsJsonSource) {
      try {
        const arr = JSON.parse(proofPointsJsonSource) as Array<{ title?: string; text: string }>;
        if (Array.isArray(arr) && arr.length > 0) {
          proofPointsText = "\nProof points (weave in where relevant): " + arr.map((p) => (p.title ? `${p.title}: ${p.text}` : p.text)).join("; ");
        }
      } catch {
        proofPointsText = "";
      }
    }

    let socialProofText = "";
    if (workspace.socialProofJson) {
      try {
        const sp = JSON.parse(workspace.socialProofJson) as { similarCompanies?: string; referralPhrase?: string };
        const parts: string[] = [];
        if (sp.similarCompanies?.trim()) parts.push(`Similar companies using us: ${sp.similarCompanies.trim()}`);
        if (sp.referralPhrase?.trim()) parts.push(`Referral phrase (use when relevant): "${sp.referralPhrase.trim()}"`);
        if (parts.length > 0) socialProofText = "\nSocial proof (weave in naturally): " + parts.join(". ");
      } catch {
        socialProofText = "";
      }
    }

    let memory: Awaited<ReturnType<typeof getAggregatedMemory>> | null = null;
    try {
      memory = await getAggregatedMemory(workspace.id);
    } catch {
      memory = null;
    }

    const baseUrl = process.env.NEXTAUTH_URL || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "");

    const processLead = async (lead: (typeof chunk)[0]) => {
      let companyContextBlock = "";
      let companyContextRaw: string | null = null;
      if (useWebScraping && lead.website?.trim()) {
        const scraped = await scrapeForContext(lead.website.trim());
        if (scraped) {
          companyContextRaw = scraped;
          companyContextBlock = `\n\nCompany website context (use to personalize — recent news, products, tone):\n${scraped}`;
        }
      } else if (useLandingPage && lead.website?.trim()) {
        // Always scrape for LP research even if useWebScraping is off
        const scraped = await scrapeForContext(lead.website.trim());
        if (scraped) companyContextRaw = scraped;
      }

      let videoBlock = "";
      if (useVideo && lead.videoUrl?.trim()) {
        videoBlock = `\n\nInclude this personalized video link in at least one email: ${lead.videoUrl}. Write a compelling reason for them to watch (e.g. "I recorded a quick video for you" or "Here's a 5-second clip I made for [Company]").`;
      }

      let landingPageBlock = "";
      let landingPageToken: string | null = null;
      if (useLandingPage && baseUrl) {
        landingPageToken = lead.landingPageToken ?? randomUUID();
        const lpUrl = `${baseUrl.replace(/\/$/, "")}/lp/${landingPageToken}`;

        // 1. Research phase — synthesize insights from lead data + scraped content
        const research = await generateLeadResearch(
          {
            name: lead.name,
            jobTitle: lead.jobTitle,
            company: lead.company,
            industry: lead.industry,
            website: lead.website,
            websiteText: companyContextRaw ?? null,
            productSummary,
            icp,
          },
          anthropicKey,
          model
        );

        // 2. Landing page content gen — calls Claude + synthetic MCP
        const senderNameStr = workspace.senderName?.trim() || "The team";
        const socialProofStr = (() => {
          try {
            if (!workspace.socialProofJson) return "";
            const sp = JSON.parse(workspace.socialProofJson) as { similarCompanies?: string; referralPhrase?: string };
            return [sp.similarCompanies, sp.referralPhrase].filter(Boolean).join(". ");
          } catch { return ""; }
        })();
        const lpContent = await generateLandingPageContent(
          {
            name: lead.name,
            jobTitle: lead.jobTitle,
            company: lead.company,
            industry: lead.industry,
            research,
            productSummary,
            senderName: senderNameStr,
            socialProof: socialProofStr,
            ctaUrl: campaignCtaUrl ?? "",
          },
          anthropicKey,
          gatherKey
        );

        // 3. Build rich email block that references actual page content
        landingPageBlock = landingPageContentForEmailPrompt(lpContent, lpUrl);

        // Store content on lead for page rendering
        const lpContentJson = JSON.stringify(lpContent);
        await prisma.lead.update({
          where: { id: lead.id },
          data: {
            landingPageToken,
            landingPageContentJson: lpContentJson,
          },
        });
      }

      let strategyBlock = "";
      if (memory && (lead.persona || lead.vertical)) {
        const parts: string[] = [];
        const instructions: string[] = [];
        if (lead.persona && memory.byPersona[lead.persona]) {
          const p = memory.byPersona[lead.persona];
          const openRate = p.open_rate_pct_avg ?? 0;
          parts.push(`Persona "${lead.persona}": open rate ${openRate}%, click rate ${p.click_rate_pct_avg ?? "?"}%, ${p.positive_reply_count ?? 0} positive replies`);
          if (openRate > 0 && openRate < 15) {
            instructions.push(`For "${lead.persona}" (low ${openRate}% open rate): write SHORTER subject lines (under 50 chars), use curiosity hooks or questions.`);
          } else if (openRate >= 25) {
            instructions.push(`For "${lead.persona}" (strong ${openRate}% open rate): keep similar subject style that worked.`);
          }
        }
        if (lead.vertical && memory.byVertical[lead.vertical]) {
          const v = memory.byVertical[lead.vertical];
          const posReplies = v.positive_reply_count ?? 0;
          parts.push(`Vertical "${lead.vertical}": open rate ${v.open_rate_pct_avg ?? "?"}%, ${posReplies} positive replies`);
          if (posReplies > 0) {
            instructions.push(`Vertical "${lead.vertical}" converts — emphasize value and proof that resonate with this segment.`);
          }
        }
        if (parts.length > 0) {
          strategyBlock = "\n\nPerformance data for this segment: " + parts.join("; ");
          if (instructions.length > 0) {
            strategyBlock += "\n\nAPPLY these learnings: " + instructions.join(" ");
          } else {
            strategyBlock += "\n\nUse this to tailor tone, subject lines, and emphasis.";
          }
        }
      }

      const prompt = `You are writing a HYPER-PERSONALIZED cold outreach sequence for ONE specific lead. Write COMPLETELY custom emails for this person — not templates. Each email should feel like it was written specifically for them based on their role, company, industry, and how your product helps people like them.

Product summary: ${productSummary}
ICP: ${icp}${proofPointsText}${socialProofText}${structureBlock}${strategyBlock}

THIS LEAD:
- Email: ${lead.email}
- Name: ${lead.name ?? "unknown"}
- Job title: ${lead.jobTitle ?? "unknown"}
- Company: ${lead.company ?? "unknown"}
- Industry: ${lead.industry ?? "unknown"}${lead.website ? `\n- Company website: ${lead.website}` : ""}${lead.persona || lead.vertical ? `\n- Persona: ${lead.persona ?? ""}\n- Vertical: ${lead.vertical ?? ""}` : ""}${companyContextBlock}

SUBJECT LINES: Write HIGHLY PERSONALIZED subject lines for each email. Use their name, company, or a contextual hook (e.g. "Quick question about [Company]'s growth", "Re: ${(lead.name ?? "").split(/\s+/)[0] || "you"} at ${lead.company ?? "your company"}"). Avoid generic subjects like "Quick question" or "Following up".

Write ${numSteps} emails. JSON keys: ${stepKeys}. Use their real name, company, and context throughout. Do NOT use placeholders like {{firstName}} — write "Hey, ${(lead.name ?? "there").split(/\s+/)[0] || "there"}," etc. Tailor each email to their specific situation. Make it feel 1:1.${socialProofText ? " Weave in social proof (similar companies, referral) where it fits naturally." : ""}${videoBlock}${landingPageBlock}

CRITICAL: Sign off as the SENDER, never as the recipient. Use their name only in the greeting (e.g. "Hey Bo,"). For the signature, use: ${workspace.senderName?.trim() ? workspace.senderName.trim() : "Best, [Your name] or The team at [Company]"}. Never use the recipient's name in the sign-off.

Respond with ONLY a valid JSON object with keys ${stepKeys}. Each step: { "subject": "...", "body": "..." }. Example: {${stepExample}}`;

      let usage = { input_tokens: 0, output_tokens: 0 };
      try {
        const { text: raw, usage: u } = await callAnthropic(anthropicKey, prompt, { maxTokens: 4000, model });
        if (u) usage = u;
        let jsonStr = raw.trim();
        const codeBlock = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
        if (codeBlock) jsonStr = codeBlock[1].trim();
        const parsed = JSON.parse(jsonStr) as Record<string, { subject?: string; body?: string }>;

        const stepsArray = Array.from({ length: numSteps }, (_, i) => {
          const key = `step${i + 1}`;
          const step = parsed[key];
          const s = typeof step === "object" && step ? step : {};
          return {
            subject: (s.subject ?? "").trim(),
            body: (s.body ?? "").trim(),
          };
        });

        // Validate — if step1 subject is empty, throw so catch block retries rather than saving garbage
        if (!stepsArray[0]?.subject?.trim()) {
          throw new Error(`Claude returned empty step1 subject. Raw: ${raw.slice(0, 300)}`);
        }

        const update: Record<string, string | null> = {
          stepsJson: JSON.stringify(stepsArray),
        };
        update.step1Subject = stepsArray[0].subject || null;
        update.step1Body = stepsArray[0].body || null;
        if (stepsArray[1]) {
          update.step2Subject = stepsArray[1].subject || null;
          update.step2Body = stepsArray[1].body || null;
        }
        if (stepsArray[2]) {
          update.step3Subject = stepsArray[2].subject || null;
          update.step3Body = stepsArray[2].body || null;
        }

        await prisma.lead.update({
          where: { id: lead.id },
          data: update,
        });
        return { leadId: lead.id, usage };
      } catch (err) {
        console.error(`Lead ${lead.id} personalize error:`, err instanceof Error ? err.message : err);
        return { leadId: lead.id, usage };
      }
    };

    // Process with limited concurrency to avoid exhausting DB connection pool
    // Claude API calls can be parallel but DB writes need to be controlled
    const CONCURRENCY = 5;
    const results: Array<{ leadId: string; usage: { input_tokens: number; output_tokens: number } }> = [];
    for (let i = 0; i < chunk.length; i += CONCURRENCY) {
      const batch = chunk.slice(i, i + CONCURRENCY);
      const batchResults = await Promise.all(batch.map(processLead));
      results.push(...batchResults);
    }
    const leadIds = results.map((r) => r.leadId);
    const usageTotal = results.reduce(
      (acc, r) => ({
        input_tokens: acc.input_tokens + r.usage.input_tokens,
        output_tokens: acc.output_tokens + r.usage.output_tokens,
      }),
      { input_tokens: 0, output_tokens: 0 }
    );

    return NextResponse.json({
      done: chunk.length,
      total,
      leadIds,
      usage: usageTotal.input_tokens > 0 || usageTotal.output_tokens > 0 ? usageTotal : undefined,
      message: `Personalized ${chunk.length} lead(s), ${numSteps} steps each.`,
    });
  } catch (error: any) {
    console.error("Leads generate error:", error);
    return NextResponse.json(
      { error: error?.message ?? "Internal server error" },
      { status: 500 }
    );
  }
}
