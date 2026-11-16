/**
 * @jest-environment node
 */
import { MADE_UP_PROOF, shownContent, unsupportedNumber } from "@/lib/lp-display";

// A page stored before November 16, 2026, as the old generator wrote it.
const stored = {
  headline: "How Acme could cut research time by 10x",
  subheadline: "This sample brief shows how shoppers see Acme",
  senderIntro: "I noticed Acme is opening new stores.",
  observations: ["Acme's site lists 3 open marketing roles"],
  assetType: "brand_health_brief", assetTitle: "Sample: brand health brief for Acme", assetSummary: "made up",
  assetFindings: [{ label: "Time saved", value: "~8 hrs/week", insight: "made up" }],
  socialProof: MADE_UP_PROOF, ctaLabel: "Book a demo", ctaUrl: "https://cal.test/x",
};
const who = { firstName: "Jo", company: "Acme" };

describe("what a landing page shows", () => {
  it("never shows the findings, the brief or the made-up proof line of a page stored before they were taken out", () => {
    const { content, showBrief } = shownContent(stored, who);
    expect(content.assetFindings).toEqual([]);
    expect(showBrief).toBe(false);
    expect(content.socialProof).toBe("");
    expect(content.observations).toEqual(stored.observations);
  });

  it("puts plain copy in place of old copy that states a made-up number or talks about the brief", () => {
    const { content } = shownContent(stored, who);
    expect([content.headline, content.subheadline, content.senderIntro]).toEqual(["A note for Acme", "", "I noticed Acme is opening new stores."]);
    const intro = shownContent({ ...stored, senderIntro: "I noticed Acme is hiring, so I put together a quick brief." }, who);
    expect(intro.content.senderIntro).toBe("");
    const noCompany = shownContent(stored, { firstName: "Jo", company: null });
    expect(noCompany.content.headline).toBe("A note for Jo");
  });

  it("keeps old copy whose numbers come from the lead research", () => {
    const { content } = shownContent({ ...stored, headline: "Acme has 3 open marketing roles" }, who);
    expect(content.headline).toBe("Acme has 3 open marketing roles");
  });

  it("keeps the brief box and copy of a page made by hand with a real chart or brief link, still without findings", () => {
    const chart = shownContent({ ...stored, chartUrl: "https://img.test/c.png" }, who);
    expect(chart).toMatchObject({ showBrief: true, content: { headline: stored.headline, assetFindings: [] } });
    expect(shownContent({ ...stored, previewLinkUrl: "https://reports.test/r" }, who)).toMatchObject({ showBrief: true, content: { assetFindings: [] } });
  });

  it("leaves the copy of a page written without findings as it is", () => {
    const current = { ...stored, version: 2, headline: "Opening 40 stores this year", subheadline: "Your research team is growing", socialProof: "Trusted by teams at Example Co." };
    const { content, showBrief } = shownContent(current, who);
    expect([content.headline, content.subheadline, content.socialProof]).toEqual(["Opening 40 stores this year", "Your research team is growing", "Trusted by teams at Example Co."]);
    expect([showBrief, content.assetFindings]).toEqual([false, []]);
  });

  it("knows a number the source does not have", () => {
    expect(unsupportedNumber("cut research time by 10x", "")).toBe(true);
    expect(unsupportedNumber("a 34% lift", "Acme grew 12% last year")).toBe(true);
    expect(unsupportedNumber("1,200 respondents", "")).toBe(true);
    expect(unsupportedNumber("founded in 2010, growing 10x", "founded in 2010")).toBe(true);
    expect(unsupportedNumber("Acme's 40 new stores", "Acme is opening 40 new stores")).toBe(false);
    expect(unsupportedNumber("Acme is opening new stores", "")).toBe(false);
    expect(unsupportedNumber(null, "")).toBe(false);
  });
});
