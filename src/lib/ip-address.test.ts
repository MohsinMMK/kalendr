import { isIP } from "node:net";

import { describe, expect, it } from "vitest";

import { ipVersion } from "./ip-address";

describe("ipVersion", () => {
  const samples = [
    "1.2.3.4", "255.255.255.255", "0.0.0.0", "256.1.1.1", "01.2.3.4", "1.2.3", "1.2.3.4.5", "1.2.3.", "a.b.c.d", "",
    "::", "::1", "2001:db8::1", "2001:db8:0:0:0:0:0:1", "1:2:3:4:5:6:7:8", "1:2:3:4:5:6:7:8:9", "1:2:3:4:5:6:7::", "::1:2:3:4:5:6:7",
    "1::2::3", ":1", "1:", "::ffff:1.2.3.4", "::ffff:1.2.3.256", "1:2:3:4:5:6:1.2.3.4", "1:2:3:4:5:6:7:1.2.3.4", "fe80::1%eth0", "fe80::1%",
    "g::1", "12345::1", "[::1]", "1.2.3.4:80", ":::", "1:::2",
  ];
  it.each(samples)("agrees with node:net on %j", (value) => {
    expect(ipVersion(value)).toBe(isIP(value));
  });
});
