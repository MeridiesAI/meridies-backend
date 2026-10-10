// The in-process limiter counts a signed-in caller on their own: one account
// spending its 300 requests a minute must not lock out the rest of the office.
import { check, user, call } from "./harness.mjs";

const noisy = await user("limit-noisy");
const quiet = await user("limit-quiet");

let refused = 0;
for (let batch = 0; batch < 7; batch++) {
  const results = await Promise.all(Array.from({ length: 50 }, () => call(noisy.token, "GET", "/auth/me")));
  refused += results.filter((r) => r.status === 429).length;
}
check("one account is cut off after its own 300 requests in a minute", refused >= 40 && refused <= 60, `refused ${refused} of 350`);
const other = await call(quiet.token, "GET", "/auth/me");
check("another account at the same address is not affected", other.status === 200, `status ${other.status}`);
