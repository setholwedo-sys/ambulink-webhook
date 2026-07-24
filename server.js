import { GoogleGenAI } from '@google/genai';
import { Redis } from '@upstash/redis';
import twilio from 'twilio';

// Let this function run longer than the 10s Hobby-plan default,
// since a Gemini call + Redis round trip can occasionally exceed it.
// (Needs a Vercel plan that supports >10s function duration.)
export const maxDuration = 30;

// Initialize Upstash Redis client (reads UPSTASH_REDIS_REST_URL /
// UPSTASH_REDIS_REST_TOKEN from environment variables automatically)
const redis = Redis.fromEnv();

// Initialize the Gemini client once per cold start.
// GEMINI_API_KEY is picked up automatically from env, but we pass it
// explicitly so a misconfigured env fails fast and visibly.
const genAI = process.env.GEMINI_API_KEY
  ? new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY })
  : null;

const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

const FIRST_AID_SYSTEM_INSTRUCTION = `
You are Ambulink Emergency AI.
CRITICAL RULE: BREVITY SAVES LIVES. Keep responses ultra-short, action-focused, and UNDER 50 WORDS TOTAL.

GUARDRAILS:
1. First-aid ONLY (bleeding, CPR, burns, choking, fractures, bites, unconsciousness).
2. Start with: "🚨 Follow these immediate steps:"
3. Maximum 3 short bullet points.
4. Use BOLD action verbs (e.g., **PRESS hard**, **TILT head**).
5. NO pleasantries, intro filler, or medical chatter.
`;

const partnerHospitals = [
  {
    hospital_id: 'hosp_kawolo_ug_01',
    name: 'Kawolo General Hospital',
    location: { district: 'Buikwe', town: 'Lugazi', coordinates: { latitude: 0.368050, longitude: 32.945553 } },
    dispatch_status: 'AVAILABLE'
  },
  {
    hospital_id: 'hosp_jinja_ug_02',
    name: 'Jinja Regional Referral Hospital',
    location: { district: 'Jinja', town: 'Jinja City', coordinates: { latitude: 0.428300, longitude: 33.203600 } },
    dispatch_status: 'AVAILABLE'
  }
];

function calculateDistance(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * (Math.PI / 180);
  const dLon = (lon2 - lon1) * (Math.PI / 180);
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(lat1 * (Math.PI / 180)) * Math.cos(lat2 * (Math.PI / 180)) *
            Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return R * (2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}

function safeXml(text) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Message><![CDATA[${text}]]></Message>
</Response>`;
}

function xmlResponse(text, status = 200) {
  return new Response(safeXml(text), {
    headers: { 'Content-Type': 'text/xml' },
    status
  });
}

// Verifies the request actually came from Twilio, using the signature
// Twilio attaches to every webhook call. Without this, anyone who finds
// the URL can fabricate location/emergency data and trigger fake dispatches.
function isValidTwilioRequest(req, params) {
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!authToken) {
    // Fail closed: if we can't verify, don't trust the request.
    console.error('TWILIO_AUTH_TOKEN not set — rejecting webhook request.');
    return false;
  }

  const signature = req.headers.get('x-twilio-signature');
  if (!signature) return false;

  // Vercel sits behind a proxy, so reconstruct the public URL Twilio
  // actually signed against rather than trusting req.url directly.
  const proto = req.headers.get('x-forwarded-proto') || 'https';
  const host = req.headers.get('x-forwarded-host') || req.headers.get('host');
  const url = `${proto}://${host}${new URL(req.url).pathname}`;

  return twilio.validateRequest(authToken, signature, url, params);
}

export async function POST(req) {
  try {
    const formData = await req.formData();
    const params = Object.fromEntries(formData.entries());

    if (!isValidTwilioRequest(req, params)) {
      return new Response('Forbidden', { status: 403 });
    }

    const userPhone = formData.get('From') || 'unknown';
    const rawBody = formData.get('Body')?.toString() || '';
    const incomingMsg = rawBody.trim().toLowerCase();
    const userLat = parseFloat(formData.get('Latitude'));
    const userLon = parseFloat(formData.get('Longitude'));

    const resetKeywords = ['0', 'menu', 'reset', 'cancel', 'start', 'help', 'hi', 'hello', 'emergency', 'ambulink'];
    const sessionKey = `session:${userPhone}`;

    if (resetKeywords.includes(incomingMsg)) {
      await redis.del(sessionKey);
      return xmlResponse(
        `🚨 *AMBULINK EMERGENCY*\n\n📍 Send your **Location Pin** for ambulance.\n\n🩹 Reply with injury (e.g. "bleeding").`
      );
    }

    // STEP 1: Location Received
    if (!isNaN(userLat) && !isNaN(userLon)) {
      const ticketId = `AMB-${Math.floor(1000 + Math.random() * 9000)}`;

      let nearest = partnerHospitals[0];
      let shortestDist = Infinity;

      partnerHospitals.forEach(h => {
        if (h.dispatch_status === 'AVAILABLE') {
          const dist = calculateDistance(userLat, userLon, h.location.coordinates.latitude, h.location.coordinates.longitude);
          if (dist < shortestDist) {
            shortestDist = dist;
            nearest = h;
          }
        }
      });

      const distKm = shortestDist.toFixed(1);
      const etaMins = Math.ceil(parseFloat(distKm) * 2) || 8;

      const sessionData = {
        state: 'AWAITING_PATIENT_TYPE',
        ticketId,
        lat: userLat.toFixed(6),
        lon: userLon.toFixed(6),
        hospitalName: nearest.name,
        distanceKm: distKm,
        etaMins
      };

      // 30-minute session expiry
      await redis.set(sessionKey, sessionData, { ex: 1800 });

      const reply = `🚨 *AMBULINK EMERGENCY DISPATCH*\n\nTicket *#${ticketId}* logged.\n🏥 **${nearest.name}**\n📏 **${distKm} km** | ⏱️ **ETA ~ ${etaMins} mins**\n\nWho needs help?\n1️⃣ Myself\n2️⃣ Someone else`;

      return xmlResponse(reply);
    }

    const session = await redis.get(sessionKey);

    // STEP 2: Patient Type
    if (session && session.state === 'AWAITING_PATIENT_TYPE') {
      const patient = (incomingMsg === '1' || incomingMsg.includes('myself')) ? 'Self' : 'Other';
      session.patient = patient;
      session.state = 'AWAITING_EMERGENCY_TYPE';

      await redis.set(sessionKey, session, { ex: 1800 });

      return xmlResponse(
        `Patient: *${patient}*\n\nWhat is the emergency?\n1️⃣ 🩸 Severe Bleeding\n2️⃣ 🫁 Breathing Difficulty\n3️⃣ 🧠 Unconscious\n4️⃣ 🤰 Pregnancy\n5️⃣ Other`
      );
    }

    // STEP 3: Emergency Type + Dispatch
    if (session && session.state === 'AWAITING_EMERGENCY_TYPE') {
      const actions = {
        '1': '• **PRESS hard** on wound with clean cloth.\n• Elevate injury.\n• Keep still.',
        '2': '• Sit upright.\n• Loosen tight clothes.\n• Ensure fresh air.',
        '3': '• Recovery position (side).\n• Clear airway.',
        '4': '• Left side position.\n• Keep warm and calm.'
      };

      const action = actions[incomingMsg] || '• Keep calm and warm.\n• Monitor breathing.';

      session.state = 'DISPATCHED';
      await redis.set(sessionKey, session, { ex: 1800 });

      return xmlResponse(
        `⚠️ *IMMEDIATE ACTION:*\n${action}\n\n🚑 Dispatching from **${session.hospitalName}** (${session.distanceKm} km, ETA ~ ${session.etaMins} mins).\n\nReply 0 for menu.`
      );
    }

    // STEP 4: Dispatch Update
    if (session && session.state === 'DISPATCHED') {
      return xmlResponse(
        `🚑 Ambulance from **${session.hospitalName}** is en route (ETA ~ ${session.etaMins} mins).\n\nKeep line open. Send new location to restart.`
      );
    }

    // FALLBACK: Gemini AI first aid
    if (!genAI) {
      return xmlResponse('🚨 Configuration error. Send location pin.');
    }

    try {
      const result = await genAI.models.generateContent({
        model: GEMINI_MODEL,
        contents: rawBody,
        config: {
          systemInstruction: FIRST_AID_SYSTEM_INSTRUCTION
        }
      });

      const aiReply = result.text?.trim();

      if (!aiReply) {
        // Empty response usually means the safety filters blocked it.
        return xmlResponse(
          '🚨 Unable to process that message.\n\n📍 Send Location Pin for ambulance.\nReply 0 for menu.'
        );
      }

      return xmlResponse(`${aiReply}\n\n📍 Send Location Pin for ambulance.\nReply 0 for menu.`);
    } catch (aiError) {
      console.error('Gemini error:', aiError);
      return xmlResponse('🚨 Send Location Pin for ambulance, or reply with your injury.');
    }
  } catch (error) {
    console.error('Webhook Error:', error);
    // Twilio expects 200 even on internal errors, or it will retry
    // the webhook and can duplicate dispatches.
    return xmlResponse('🚨 Service busy. Try sending location pin.', 200);
  }
}

export function GET() {
  return new Response('Ambulink Emergency Webhook is live on Vercel.');
}
