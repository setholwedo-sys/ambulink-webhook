const express = require('express');
const app = express();

app.use(express.urlencoded({ extended: false }));

// In-memory session store (tracks user progress by phone number)
const sessions = {};

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

  console.log(`📩 Message from ${from}: Body="${body}", Lat=${latitude}, Lon=${longitude}`);

  // Initialize or reset session if new location is received
  if (latitude && longitude) {
    sessions[from] = {
      step: 'AWAITING_PATIENT_TYPE',
      lat: latitude,
      lon: longitude,
      ticketId: 'AMB-' + Math.floor(1000 + Math.random() * 9000)
    };

    const reply = `🚨 *AMBULINK EMERGENCY DISPATCH*\n\n` +
      `Ticket *#${sessions[from].ticketId}* logged.\n` +
      `Coordinates: ${latitude}, ${longitude}\n\n` +
      `Who needs emergency medical help?\n\n` +
      `1️⃣ Myself\n` +
      `2️⃣ Someone else`;

    return sendResponse(res, reply);
  }

  // Retrieve current active session
  const userSession = sessions[from];

  // FALLBACK: If user texts without sending location first
  if (!userSession) {
    const reply = `🚨 *AMBULINK EMERGENCY DISPATCH*\n\n` +
      `We need your location to dispatch an ambulance!\n\n` +
      `Tap 📎 *Attachment* ➔ *Location* ➔ *Send Current Location*.`;
    return sendResponse(res, reply);
  }

  // STEP 1 ➔ STEP 2: Handle Patient Type (1 or 2)
  if (userSession.step === 'AWAITING_PATIENT_TYPE') {
    if (['1', '2'].includes(body) || body.toLowerCase().includes('myself') || body.toLowerCase().includes('someone')) {
      userSession.patient = (body === '1' || body.toLowerCase().includes('myself')) ? 'Self' : 'Bystander/Other';
      userSession.step = 'AWAITING_CONDITION'; // Advance state

      const reply = `Got it (Patient: *${userSession.patient}*).\n\n` +
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

  // STEP 2 ➔ STEP 3: Handle Emergency Condition (1 - 5) & Dispatch
  if (userSession.step === 'AWAITING_CONDITION') {
    if (['1', '2', '3', '4', '5'].includes(body)) {
      const conditions = {
        '1': 'Accident / Severe Bleeding',
        '2': 'Breathing Difficulty / Chest Pain',
        '3': 'Unconscious / Unresponsive',
        '4': 'Pregnancy / Labor',
        '5': 'Other Urgent Emergency'
      };

      userSession.condition = conditions[body];
      userSession.step = 'DISPATCHED';

      const navUrl = `https://www.google.com/maps/search/?api=1&query=${userSession.lat},${userSession.lon}`;
      const firstAidText = FIRST_AID_GUIDE[body];

      // Dispatcher Console Output
      console.log(`\n🚑 ==========================================`);
      console.log(`🚨 DISPATCH TICKET #${userSession.ticketId}`);
      console.log(`📞 Caller: ${from}`);
      console.log(`👤 Patient: ${userSession.patient}`);
      console.log(`🩺 Medical Condition: ${userSession.condition}`);
      console.log(`📍 Google Maps Link: ${navUrl}`);
      console.log(`==========================================\n`);

      const reply = `✅ *AMBULANCE DISPATCHED!*\n\n` +
        `Ticket: *#${userSession.ticketId}*\n` +
        `Condition: *${userSession.condition}*\n` +
        `Status: Paramedics en route to your GPS location.\n\n` +
        `${firstAidText}\n\n` +
        `📞 *Need urgent human escalation?* Call our dispatch control line immediately if conditions worsen.`;

      return sendResponse(res, reply);
    } else {
      return sendResponse(res, `Please reply with a number from *1 to 5* to indicate the medical emergency.`);
    }
  }

  // STEP 3 COMPLETE: Follow-up messages after dispatch
  if (userSession.step === 'DISPATCHED') {
    const reply = `🚑 Ambulance unit for Ticket *#${userSession.ticketId}* is currently moving to your location.\n\n` +
      `Keep this line open. If you need to request a *new* ambulance, please send a new GPS location pin.`;
    return sendResponse(res, reply);
  }
});

// Helper function to send Twilio TwiML response
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
