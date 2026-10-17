import assert from "node:assert/strict";
import { test } from "node:test";
import { pickerConfigProblem } from "../../src/lib/oauth.js";

test("each missing Picker setting is named", () => {
  assert.match(pickerConfigProblem({}) ?? "", /GOOGLE_CLIENT_ID/);
  assert.match(pickerConfigProblem({ clientId: "cid" }) ?? "", /GOOGLE_PICKER_API_KEY/);
  assert.match(pickerConfigProblem({ clientId: "cid", apiKey: "key" }) ?? "", /GOOGLE_PROJECT_NUMBER/);
  assert.equal(pickerConfigProblem({ clientId: "cid", apiKey: "key", projectNumber: "356256797701" }), null);
});
