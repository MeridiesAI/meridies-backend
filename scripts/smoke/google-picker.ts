/**
 * By-hand check (scripts/smoke/google-picker.md, step 3). Localhost only unless SMOKE_ALLOW_REMOTE=1.
 *   npx tsx --env-file=.env scripts/smoke/google-picker.ts <documentId> [<unpickedFileId>]
 * Reads the document's external_file_id with its owner's stored grant (metadata only), then, if
 * given, a file id that was never picked, which must answer 404.
 */
import { env } from "../../src/env.js";
import { getRemoteFile } from "../../src/lib/suiteApi.js";
import { serviceClient } from "../../src/lib/supabase.js";

const [documentId, unpicked] = process.argv.slice(2);
if (!documentId) throw new Error("usage: google-picker.ts <documentId> [<unpickedFileId>]");
if (!/127\.0\.0\.1|localhost/.test(env.SUPABASE_URL) && process.env.SMOKE_ALLOW_REMOTE !== "1") {
  throw new Error("Refusing a non-local database without SMOKE_ALLOW_REMOTE=1");
}
const log = { warn: (o: object, m: string) => console.warn(m, o) };
const db = serviceClient();
if (!db) throw new Error("SUPABASE_SERVICE_ROLE_KEY is required");
const { data: doc } = await db.from("documents").select("owner_id, external_file_id").eq("id", documentId).single();
const file = await getRemoteFile(String(doc!.owner_id), "google", String(doc!.external_file_id), null, log);
console.log("picked file readable:", file.name, file.mimeType);
if (unpicked) {
  try {
    await getRemoteFile(String(doc!.owner_id), "google", unpicked, null, log);
    console.log("UNEXPECTED: an unpicked file was readable. setAppId or the scope is wrong.");
    process.exitCode = 1;
  } catch (err) {
    console.log("unpicked file refused as expected:", (err as Error).message);
  }
}
