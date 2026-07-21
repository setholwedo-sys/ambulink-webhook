const express = require('express');
const app = express();

app.use(express.urlencoded({ extended: false }));

// ---------------------------------------------------------------------------
// FIX: Twilio's WhatsApp webhook has no browser-style cookie jar. Each inbound
// message is an independent HTTP request from Twilio's servers — a
// `Set-Cookie` header on your response is never sent back to you on the next
// message. The original code reset every session to "no session" on every
// single message, which would have made real dispatches stall or loop.
//
// Fix: keep session state server-side, keyed by the sender's WhatsApp number
// (req.body.From). In-memory Map works for a single-process demo; swap for
// Redis or a DB table in production so a server restart mid-emergency
// doesn't wipe active tickets.
// ---------------------------------------------------------------------------

const sessions = new Map(); // key: phone number (From), value: session object
const SESSION_TTL_MS = 60 * 60 * 1000; // 1 hour, mirrors old Max-Age=3600

function getSession(from) {
  const entry = sessions.get(from);
  if (!entry) return null;
  if (Date.now() - entry.updatedAt > SESSION_TTL_MS) {
    sessions.delete(from);
    return null;
  }
  return entry.data;
}

function saveSession(from, data) {
  sessions.set(from, { data, updatedAt: Date.now() });
}

// Optional: periodic sweep so memory doesn't grow unbounded over many days
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of sessions.entries()) {
    if (now - entry.updatedAt > SESSION_TTL_MS) sessions.delete(key);
  }
}, 10 * 60 * 1000).unref();

// First Aid Instructions for Immediate Life Support
const FIRST_AID_GUIDE = {
  '1': '🩸 *IMMEDIATE ACTION (BLEEDING/TRAUMA):*\n• Apply firm, direct pressure to the wound with a clean cloth.\n• Keep patient lying still. Do NOT move them if spinal injury is suspected.',
  '2': '🫁 *IMMEDIATE ACTION (BREATHING/CHEST PAIN):*\n• Sit patient upright in a comfortable position.\n• Loosen tight clothing around neck and chest.\n• Help them stay calm and take slow, deep breaths.',
  '3': '🧠 *IMMEDIATE ACTION (UNRESPONSIVE):*\n• Place patient in Recovery Position (on their left side).\n• Ensure mouth and airway are clear of fluids/vomit.\n• Do NOT give water or food.',
  '4': '🤰 *IMMEDIATE ACTION (PREGNANCY/LABOR):*\n• Keep mother lying on her left side to maximize blood flow.\n• Keep warm with blankets. Prepare clean towels.',
  '5': '⚠️ *IMMEDIATE ACTION:*\n• Keep patient calm, comfortable, and warm until paramedics arrive.'
};

app.post('/twilio-webhook', (req, res) => {
  const from = req.body.From;
  const body = req.body.Body ? req.body.Body.trim() : '';
  const latitude = req.body.Latitude;
  const longitude = req.body.Longitude;

  if (!from) {
    return sendResponse(res, `We couldn't identify your number. Please try again.`);
  }

  console.log(`📩 Message from ${from}: Body="${body}", Lat=${latitude}, Lon=${longitude}`);

  // 1. NEW LOCATION PIN RECEIVED ➔ Start New Session
  if (latitude && longitude) {
    const session = {
      step: 'AWAITING_PATIENT_TYPE',
      lat: latitude,
      lon: longitude,
      ticketId: 'AMB-' + Math.floor(1000 + Math.random() * 9000)
    };

    saveSession(from, session);

    const reply = `🚨 *AMBULINK EMERGENCY DISPATCH*\n\n` +
      `Ticket *#${session.ticketId}* logged.\n` +
      `Coordinates: ${latitude}, ${longitude}\n\n` +
      `Who needs emergency medical help?\n\n` +
      `1️⃣ Myself\n` +
      `2️⃣ Someone else`;

    return sendResponse(res, reply);
  }

  // Retrieve current active session from server-side store
  let session = getSession(from);

  // 2. NO SESSION & NO LOCATION ➔ Prompt for GPS Location Pin
  if (!session) {
    const reply = `🚨 *AMBULINK EMERGENCY DISPATCH*\n\n` +
      `We need your location to dispatch an ambulance!\n\n` +
      `Tap 📎 *Attachment* ➔ *Location* ➔ *Send Current Location*.`;
    return sendResponse(res, reply);
  }

  // 3. STEP 1 ➔ STEP 2: Handle Patient Type (1 or 2)
  if (session.step === 'AWAITING_PATIENT_TYPE') {
    if (['1', '2'].includes(body) || body.toLowerCase().includes('myself') || body.toLowerCase().includes('someone')) {
      session.patient = (body === '1' || body.toLowerCase().includes('myself')) ? 'Self' : 'Bystander/Other';
      session.step = 'AWAITING_CONDITION';

      saveSession(from, session);

      const reply = `Got it (Patient: *${session.patient}*).\n\n` +
        `What is the primary medical emergency?\n\n` +
        `1️⃣ 🩸 Accident / Severe Bleeding\n` +
        `2️⃣ 🫁 Breathing Difficulty / Chest Pain\n` +
        `3️⃣ 🧠 Unconscious / Unresponsive\n` +
        `4️⃣ 🤰 Pregnancy / Labor\n` +
        `5️⃣ ⚠️ Other Urgent Emergency`;

      return sendResponse(res, reply);
    } else {
      return sendResponse(res, `Please reply with *1* for Myself or *2* for Someone else.`);
    }
  }

  // 4. STEP 2 ➔ STEP 3: Handle Emergency Condition (1 - 5) & Dispatch
  if (session.step === 'AWAITING_CONDITION') {
    if (['1', '2', '3', '4', '5'].includes(body)) {
      const conditions = {
        '1': 'Accident / Severe Bleeding',
        '2': 'Breathing Difficulty / Chest Pain',
        '3': 'Unconscious / Unresponsive',
        '4': 'Pregnancy / Labor',
        '5': 'Other Urgent Emergency'
      };

      session.condition = conditions[body];
      session.step = 'DISPATCHED';

      saveSession(from, session);

      const navUrl = `https://www.google.com/maps/search/?api=1&query=${session.lat},${session.lon}`;
      const firstAidText = FIRST_AID_GUIDE[body];

      console.log(`\n🚑 ==========================================`);
      console.log(`🚨 DISPATCH TICKET #${session.ticketId}`);
      console.log(`📞 Caller: ${from}`);
      console.log(`👤 Patient: ${session.patient}`);
      console.log(`🩺 Medical Condition: ${session.condition}`);
      console.log(`📍 Google Maps Navigation: ${navUrl}`);
      console.log(`==========================================\n`);

      const reply = `✅ *AMBULANCE DISPATCHED!*\n\n` +
        `Ticket: *#${session.ticketId}*\n` +
        `Condition: *${session.condition}*\n` +
        `Status: Paramedics en route to your GPS location.\n\n` +
        `${firstAidText}\n\n` +
        `📞 *Need urgent human escalation?* Call our dispatch control line immediately if conditions worsen.`;

      return sendResponse(res, reply);
    } else {
      return sendResponse(res, `Please reply with a number from *1 to 5* to indicate the medical emergency.`);
    }
  }

  // 5. POST-DISPATCH FOLLOW UP
  if (session.step === 'DISPATCHED') {
    const reply = `🚑 Ambulance unit for Ticket *#${session.ticketId}* is currently moving to your location.\n\n` +
      `Keep this line open. To request a *new* ambulance, please send a new GPS location pin.`;
    return sendResponse(res, reply);
  }

  // Fallback: unknown step somehow reached
  return sendResponse(res, `Something went wrong. Please send your location again to restart.`);
});

// Helper: Send Twilio TwiML XML Response
function sendResponse(res, textMessage) {
  res.type('text/xml').send(`
    <Response>
      <Message>${textMessage}</Message>
    </Response>
  `);
}

module.exports = app;

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Ambulink Core Engine running on port ${PORT}`));
