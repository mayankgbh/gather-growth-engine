import { renderManagedEmailContent } from "@/lib/managed-outreach/email-content";

const footer = {
  businessPostalAddress: "100 Example Street, Example City, CA 90000", postalAddressApproved: true,
  unsubscribeText: "To stop these emails, reply ‘no thanks’ and I won’t follow up.", replyOptOutEnabled: true,
};

describe("managed email footer", () => {
  it("keeps all required footer text in the plain copy and the small readable HTML footer", () => {
    const result = renderManagedEmailContent("Hi Alex,\n\nHere is the idea.\nMayank", footer);
    expect(result.body).toBe(`Hi Alex,\n\nHere is the idea.\nMayank\n\n${footer.unsubscribeText}\n${footer.businessPostalAddress}`);
    expect(result.html).toContain("font-size:12px;line-height:18px;color:#595959");
    expect(result.html).toContain(`${footer.unsubscribeText}<br/>${footer.businessPostalAddress}`);
    expect(result.html).not.toMatch(/display:none|visibility:hidden|opacity:0|font-size:0/);
  });

  it("renders saved copy and footer as text rather than executable or hidden HTML", () => {
    const copy = '<a href="https://example.com">research & evidence</a>\n<script>alert(1)</script>';
    const result = renderManagedEmailContent(copy, { ...footer, unsubscribeText: 'Reply stop. <img src="x" onerror="alert(1)">' });
    expect(result.body).toContain(copy);
    expect(result.html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(result.html).toContain("&lt;img src=&quot;x&quot; onerror=&quot;alert(1)&quot;&gt;");
    expect(result.html).not.toMatch(/<script|<img|<a /);
  });

  it("refuses to render an unapproved address or missing opt-out", () => {
    expect(() => renderManagedEmailContent("Hello", { ...footer, postalAddressApproved: false })).toThrow(/approved/);
    expect(() => renderManagedEmailContent("Hello", { ...footer, unsubscribeText: "" })).toThrow(/opt-out/);
  });
});
