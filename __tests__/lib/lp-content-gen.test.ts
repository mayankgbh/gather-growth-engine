/**
 * @jest-environment node
 */
import { buildFallback, normaliseLandingPageContent, generateLandingPageContent } from "@/lib/lp-content-gen";

jest.mock("@/lib/anthropic", () => ({ callAnthropic: jest.fn() }));
const { callAnthropic } = require("@/lib/anthropic");

const input = {
  name: "Dana Lee",
  jobTitle: "VP Marketing",
  company: "Acme",
  industry: "SaaS",
  research: {
    companyContext: "Acme is hiring researchers",
    observations: ["Hiring researchers"],
    likelyUseCase: "brand tracking",
    relevanceReason: "They run a lot of surveys",
    assetAngle: "brand health brief",
  },
  productSummary: "AI research",
  senderName: "Sam",
  socialProof: "",
  ctaUrl: "https://example.com/demo",
};

describe("lp-content-gen", () => {
  const realFetch = global.fetch;
  beforeEach(() => jest.clearAllMocks());
  afterEach(() => { global.fetch = realFetch; });

  it("fallback has no made-up findings and is labeled illustrative", () => {
    const content = buildFallback(input as any);
    expect(content.assetFindings).toEqual([]);
    expect(content.assetSource).toBe("illustrative");
  });

  it("normalise keeps assetSource and defaults to illustrative", () => {
    expect(normaliseLandingPageContent({ assetSource: "gather" }, "").assetSource).toBe("gather");
    expect(normaliseLandingPageContent({}, "").assetSource).toBe("illustrative");
    expect(normaliseLandingPageContent({ assetSource: "made-up" as any }, "").assetSource).toBe("illustrative");
  });

  it("skips the MCP call without a Gather key and labels LLM findings illustrative", async () => {
    global.fetch = jest.fn();
    (callAnthropic as jest.Mock).mockResolvedValue({
      text: JSON.stringify({ headline: "Hi", assetFindings: [{ label: "x", value: "42%", insight: "y" }], assetSource: "gather" }),
    });
    const content = await generateLandingPageContent(input as any, "sk-ant-test");
    expect(global.fetch).not.toHaveBeenCalled();
    expect(content.assetSource).toBe("illustrative");
  });

  it("sends the Gather key to the MCP server and warns instead of swallowing a failure", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 400, text: async () => "bad mcp" });
    (callAnthropic as jest.Mock).mockResolvedValue({ text: "not json" });
    const content = await generateLandingPageContent(input as any, "sk-ant-test", "gk_test");
    const body = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body);
    expect(body.mcp_servers[0]).toMatchObject({ url: "https://synthetic.gatherhq.com/api/v1/mcp", authorization_token: "gk_test" });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("400"));
    expect(content.assetSource).toBe("illustrative");
    warn.mockRestore();
  });
});
