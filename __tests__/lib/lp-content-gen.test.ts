/**
 * @jest-environment node
 */
import { generateLandingPageContent, landingPageContentForEmailPrompt, NO_FINDINGS_RULE } from "@/lib/lp-content-gen";
import type { LeadResearch } from "@/lib/research";

const research: LeadResearch = {
  companyContext: "Acme is opening 40 new stores",
  observations: ["Acme's site lists 3 open marketing roles", "Acme launched a loyalty app in October"],
  likelyUseCase: "test store messaging",
  relevanceReason: "New stores need messaging that lands locally",
  assetAngle: "brand health brief",
};
const input = { name: "Jo Lee", jobTitle: "CMO", company: "Acme", industry: "Retail", research, productSummary: "Gather", senderName: "Mayank", socialProof: "", ctaUrl: "https://cal.test/x" };

const reply = (body: unknown) => ({ ok: true, json: async () => ({ content: [{ type: "text", text: JSON.stringify(body) }], usage: {} }) });

describe("landing page content", () => {
  const realFetch = global.fetch;
  let sent: { url: string; body: Record<string, unknown> }[] = [];
  afterEach(() => { global.fetch = realFetch; sent = []; });
  const answer = (body: unknown) => {
    global.fetch = jest.fn(async (url: string, init: { body: string }) => {
      sent.push({ url, body: JSON.parse(init.body) });
      return reply(body);
    }) as never;
  };

  it("asks for copy only, with no findings, through no MCP server", async () => {
    answer({ headline: "Jo, new stores need local messages", subheadline: "s", senderIntro: "i", ctaLabel: "Book a demo" });
    const page = await generateLandingPageContent(input, "key");
    expect(sent).toHaveLength(1);
    expect(sent[0].body.mcp_servers).toBeUndefined();
    const prompt = JSON.stringify(sent[0].body.messages);
    expect(prompt).toContain(NO_FINDINGS_RULE.slice(0, 60));
    expect(prompt).not.toMatch(/synthetic data tool|research findings for|assetFindings/);
    expect(page).toMatchObject({ version: 2, headline: "Jo, new stores need local messages", assetFindings: [], assetTitle: "", assetSummary: "", socialProof: "", ctaUrl: "https://cal.test/x" });
  });

  it("keeps nothing the model adds beyond its copy: findings, a brief or social proof", async () => {
    answer({
      headline: "h", subheadline: "s", senderIntro: "i", ctaLabel: "c",
      assetTitle: "Sample: brief", assetSummary: "made up", socialProof: "Companies cut insight time 10x.",
      assetFindings: [{ label: "Time saved", value: "~8 hrs/week", insight: "made up" }],
    });
    const page = await generateLandingPageContent(input, "key");
    expect(page.assetFindings).toEqual([]);
    expect([page.assetTitle, page.assetSummary, page.socialProof]).toEqual(["", "", ""]);
  });

  it("puts plain copy in place of model copy that states a number the research does not have", async () => {
    answer({ headline: "Acme could cut research time by 10x", subheadline: "Opening 40 new stores means new buyers", senderIntro: "i", ctaLabel: "c" });
    const page = await generateLandingPageContent(input, "key");
    expect(page.headline).toBe("A note for Acme");
    expect(page.subheadline).toBe("Opening 40 new stores means new buyers");
  });

  it("falls back to plain copy from the research, with no made-up stats, when the model fails", async () => {
    global.fetch = jest.fn(async () => { throw new Error("down"); }) as never;
    const page = await generateLandingPageContent(input, "key");
    expect(page.assetFindings).toEqual([]);
    expect(JSON.stringify(page)).not.toMatch(/8 hrs|10×|500\+ respondents|AI-powered research/);
    expect(page.headline).toBe("A note for Acme");
    expect(page.observations).toEqual(research.observations);
  });

  it("tells the email writer what is on the page, and to cite no finding or brief", () => {
    const text = landingPageContentForEmailPrompt({
      version: 2, headline: "h", subheadline: "s", senderIntro: "i", observations: ["o1"], assetType: "", assetTitle: "", assetSummary: "",
      assetFindings: [], socialProof: "", ctaLabel: "Book", ctaUrl: "https://cal.test/x",
    }, "https://growth.test/lp/t");
    expect(text).toContain(NO_FINDINGS_RULE);
    expect(text).not.toMatch(/Sample findings|Synthetic research asset|I put together/);
  });
});
