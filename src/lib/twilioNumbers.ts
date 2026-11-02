/**
 * A consultant's own texting number, bought from Twilio on their behalf.
 *
 * Search by area code, buy one, point its incoming-text webhook at this API
 * (`/webhooks/twilio/inbound`), and add it to the account's Messaging Service
 * so it travels under the registered A2P 10DLC campaign (carriers filter US
 * long-code traffic that isn't registered). Each of these is a plain Twilio REST
 * call; no SDK, as with `sendSms`.
 *
 * Buying a number costs real money (about a dollar a month), so the route that
 * calls this allows one per counselor, asks for an explicit number the counselor
 * picked from a search, and is rate-limited. Nothing here takes a number the
 * caller didn't first see in a search result: `buyNumber` re-checks that Twilio
 * still offers it.
 */

import { env, twilioBase, twilioMessagingBase } from "../env.js";

const TIMEOUT_MS = 15_000;
const API = `${twilioBase}/2010-04-01`;

export type AvailableNumber = { phone: string; label: string; locality: string | null; region: string | null };

export class TwilioNumberError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export const numbersConfigured = (): boolean => Boolean(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.PUBLIC_API_URL);

function auth(): string {
  return `Basic ${Buffer.from(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`).toString("base64")}`;
}

async function twilio<T>(url: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      ...init,
      headers: { Authorization: auth(), Accept: "application/json", ...(init.headers ?? {}) },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new TwilioNumberError("The texting provider didn't answer. Try again in a moment.", 502);
  }
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (res.ok) return json as T;
  // Never pass the provider's raw message through: it can echo account details.
  if (res.status === 401 || res.status === 403) throw new TwilioNumberError("The texting provider rejected Meridies' credentials.", 502);
  if (res.status === 400 || res.status === 404) throw new TwilioNumberError("That number is no longer available. Search again.", 409);
  throw new TwilioNumberError("The texting provider couldn't do that right now.", 502);
}

/** US local numbers that can text, optionally in an area code. At most five. */
export async function searchNumbers(areaCode?: string): Promise<AvailableNumber[]> {
  const q = new URLSearchParams({ SmsEnabled: "true", PageSize: "5" });
  if (areaCode) q.set("AreaCode", areaCode);
  const j = await twilio<{ available_phone_numbers?: Array<Record<string, unknown>> }>(
    `${API}/Accounts/${env.TWILIO_ACCOUNT_SID}/AvailablePhoneNumbers/US/Local.json?${q}`
  );
  return (j.available_phone_numbers ?? [])
    .map((n) => ({
      phone: String(n.phone_number ?? ""),
      label: String(n.friendly_name ?? n.phone_number ?? ""),
      locality: typeof n.locality === "string" ? n.locality : null,
      region: typeof n.region === "string" ? n.region : null,
    }))
    .filter((n) => /^\+1[2-9]\d{9}$/.test(n.phone));
}

/**
 * Buy exactly `phone`, send its incoming texts to this API, and add it to the
 * Messaging Service when one is configured. Returns Twilio's id for the number.
 */
export async function buyNumber(phone: string): Promise<{ sid: string; phone: string }> {
  if (!/^\+1[2-9]\d{9}$/.test(phone)) throw new TwilioNumberError("That isn't a US number we can buy.", 400);
  const base = (env.PUBLIC_API_URL as string).replace(/\/+$/, "");
  const bought = await twilio<{ sid?: string; phone_number?: string }>(`${API}/Accounts/${env.TWILIO_ACCOUNT_SID}/IncomingPhoneNumbers.json`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      PhoneNumber: phone,
      SmsUrl: `${base}/webhooks/twilio/inbound`,
      SmsMethod: "POST",
      StatusCallback: `${base}/webhooks/twilio/status`,
      StatusCallbackMethod: "POST",
    }).toString(),
  });
  const sid = String(bought.sid ?? "");
  if (!/^PN[0-9a-fA-F]{32}$/.test(sid)) throw new TwilioNumberError("The texting provider didn't confirm the number.", 502);

  if (env.TWILIO_MESSAGING_SERVICE_SID) {
    // A number outside the registered campaign sends texts carriers filter, so
    // if it can't join the service, give it back rather than keep a dud.
    try {
      await twilio(`${twilioMessagingBase}/v1/Services/${env.TWILIO_MESSAGING_SERVICE_SID}/PhoneNumbers`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ PhoneNumberSid: sid }).toString(),
      });
    } catch (err) {
      await releaseNumber(sid).catch(() => undefined);
      throw err;
    }
  }
  return { sid, phone: String(bought.phone_number ?? phone) };
}

/** Give a number back to Twilio (stops its monthly charge). */
export async function releaseNumber(sid: string): Promise<void> {
  if (!/^PN[0-9a-fA-F]{32}$/.test(sid)) throw new TwilioNumberError("Not a number id.", 400);
  await fetch(`${API}/Accounts/${env.TWILIO_ACCOUNT_SID}/IncomingPhoneNumbers/${sid}.json`, {
    method: "DELETE",
    headers: { Authorization: auth() },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  }).then((r) => {
    if (!r.ok && r.status !== 404) throw new TwilioNumberError("The texting provider couldn't release the number.", 502);
  });
}
