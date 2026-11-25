import { describe, expect, it } from "vitest";

import { emailDomainOf, emailDomainRecordName, emailDomainRecordValue, hashDomainToken, judgeEmailDomain } from "./email-domain-rules";

describe("company email domain rules", () => {
  const hash = hashDomainToken("secret-token");

  it("verifies only a record that carries this domain's token", () => {
    expect(judgeEmailDomain([emailDomainRecordValue("secret-token")], hash).kind).toBe("verified");
    expect(judgeEmailDomain(["v=spf1 -all", ` ${emailDomainRecordValue("secret-token")} `], hash).kind).toBe("verified");
    expect(judgeEmailDomain([emailDomainRecordValue("someone-elses")], hash)).toMatchObject({ kind: "missing", note: expect.stringContaining("isn't the one") });
    expect(judgeEmailDomain([], hash)).toMatchObject({ kind: "missing" });
  });

  it("treats a failed lookup as an outage, not a refusal", () => {
    expect(judgeEmailDomain(null, hash).kind).toBe("lookup_failed");
  });

  it("names the record and reads the domain of an address", () => {
    expect(emailDomainRecordName("clinic.com")).toBe("_kalendr-verify.clinic.com");
    expect(emailDomainOf("Nurse@Clinic.COM")).toBe("clinic.com");
    expect(emailDomainOf("no-at-sign")).toBeNull();
    expect(emailDomainOf("trailing@")).toBeNull();
  });
});
