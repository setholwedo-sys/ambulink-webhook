const express = require('express');
const { GoogleGenAI } = require('@google/genai');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// In-Memory Session Storage (Tracks user flow per WhatsApp phone number)
const userSessions = {};

// STRICT ULTRA-SHORT EMERGENCY FIRST-AID PROMPT
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

// Safe Haversine distance formula
function calculateDistance(lat1, lon1, lat2, lon2) {
  if ([lat1, lon1, lat2, lon2].some(v => typeof v !== 'number' || isNaN(v))) {
    return Infinity;
  }
  const R = 6371; // Earth radius in km
  const dLat = (lat2 - lat1) * (Math.PI / 180);
  const dLon = (lon2 - lon1) * (Math.PI / 180);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * (Math.PI / 180)) *
      Math.cos(lat2 * (Math.PI / 180)) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

// Initial partner hospitals
let partnerHospitals = [
  {
    hospital_id: "hosp_kawolo_ug_01",
    name: "Kawolo General Hospital",
    facility_type: "Public General Hospital",
    category: "Trauma & Emergency Center",
    location: {
      district: "Buikwe",
      town: "Lugazi",
      address: "Kampala-Jinja Highway",
      coordinates: { latitude: 0.368050, longitude: 32.945553 }
    },
    emergency_services: { trauma_unit: true, icu_capable: true, operating_theaters: true, ambulance_station: true },
    dispatch_status: "AVAILABLE"
  },
  {
    hospital_id: "hosp_jinja_ug_02",
    name: "Jinja Regional Referral Hospital",
    facility_type: "Regional Referral Hospital",
    category: "Major Referral & Trauma Center",
    location: {
      district: "Jinja",
      town: "Jinja City",
      address: "Nalufenya Road",
      coordinates: { latitude: 0.428300, longitude: 33.203600 }
    },
    emergency_services: { trauma_unit: true, icu_capable: true, operating_theaters: true, ambulance_station: true },
    dispatch_status: "AVAILABLE"
  }
];

// Helper to escape XML characters safely for TwiML
function safeXmlResponse(res, messageText) {
  const cleanText = messageText.replace(/]]>/g, ']]&gt;');
  res.type('text/xml');
  return res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Message><![CDATA[${cleanText}]]></Message>
</Response>`);
}

// --- REST API ENDPOINTS ---

app.get('/api/v1/hospitals', (req, res) => {
  res.status(200).json({ success: true, count: partnerHospitals.length, data: partnerHospitals });
});

app.get('/api/v1/hospitals/:id', (req, res) => {
  const hospital = partnerHospitals.find(h => h.hospital_id === req.params.id);
  if (!hospital) return res.status(404).json({ success: false, message: "Hospital not found" });
  res.status(200).json({ success: true, data: hospital });
});

app.post('/api/v1/hospitals', (req, res) => {
  const newHospital = req.body;
  if (!newHospital.hospital_id || !newHospital.name) {
    return res.status(400).json({ success: false, message: "hospital_id and name required." });
  }
  partnerHospitals.push(newHospital);
  res.status(201).json({ success: true, message: "Hospital registered", data: newHospital });
});

app.post('/api/v1/first-aid', async (req, res) => {
  const { query, incident_id } = req.body;

  if (!query) {
    return res.status(400).json({ success: false, message: "Query required." });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  const modelName = process.env.GEMINI_MODEL || 'gemini-2.0-flash';

  if (!apiKey) {
    return res.status(500).json({ success: false, message: "GEMINI_API_KEY environment variable missing on server." });
  }

  try {
    const ai = new GoogleGenAI({ apiKey });
    const prompt = `${FIRST_AID_SYSTEM_INSTRUCTION}\n\nUSER EMERGENCY QUERY: "${query}"`;
    const response = await ai.models.generateContent({ model: modelName, contents: prompt });

    res.status(200).json({
      success: true,
      incident_id: incident_id || null,
      first_aid_guidance: response.text,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error("REST AI Error:", error);
    res.status(500).json({ success: false, message: "Failed to generate first-aid response." });
  }
});

// --- MULTI-STEP WHATSAPP DISPATCH & TRIAGE WEBHOOK ---

app.post('/webhook', async (req, res) => {
  const userPhone = req.body.From || 'unknown';
  const rawBody = req.body.Body || '';
  const incomingMsg = rawBody.trim().toLowerCase();
  const userLat = req.body.Latitude;
  const userLon = req.body.Longitude;

  const resetKeywords = ['0', 'menu', 'reset', 'cancel', 'back', 'start', 'help', 'hi', 'hello', 'hey', 'emergency', 'ambulink'];

  // Global Navigation: Reset Session
  if (resetKeywords.includes(incomingMsg)) {
    delete userSessions[userPhone];
    const replyText = `🚨 *AMBULINK EMERGENCY*\n\n` +
                      `📍 **Need Ambulance?**\n` +
                      `Send your **Location Pin** (tap 📎 icon -> Location).\n\n` +
                      `🩹 **Need First Aid?**\n` +
                      `Reply with injury (e.g., *"bleeding"*, *"burn"*, *"choking"*).`;
    return safeXmlResponse(res, replyText);
  }

  // STEP 1: User sends Location Pin -> Log Ticket & Ask Patient Type
  if (userLat && userLon) {
    const ticketId = `AMB-${Math.floor(1000 + Math.random() * 9000)}`;
    const lat = parseFloat(userLat).toFixed(8);
    const lon = parseFloat(userLon).toFixed(8);

    userSessions[userPhone] = {
      state: 'AWAITING_PATIENT_TYPE',
      ticketId: ticketId,
      lat: lat,
      lon: lon
    };

    const replyText = `🚨 *AMBULINK EMERGENCY DISPATCH*\n\n` +
                      `Ticket #${ticketId} logged.\n` +
                      `Coordinates: ${lat}, ${lon}\n\n` +
                      `Who needs emergency medical help?\n\n` +
                      `1️⃣ Myself\n` +
                      `2️⃣ Someone else`;

    return safeXmlResponse(res, replyText);
  }

  // Check active state for user
  const session = userSessions[userPhone];

  // STEP 2: Handle Patient Selection (1 or 2)
  if (session && session.state === 'AWAITING_PATIENT_TYPE') {
    let patientLabel = '';
    if (incomingMsg === '1' || incomingMsg.includes('myself')) {
      patientLabel = 'Self';
    } else if (incomingMsg === '2' || incomingMsg.includes('someone')) {
      patientLabel = 'Bystander/Other';
    } else {
      return safeXmlResponse(res, `Please select a valid option:\n\n1️⃣ Myself\n2️⃣ Someone else`);
    }

    session.patient = patientLabel;
    session.state = 'AWAITING_EMERGENCY_TYPE';

    const replyText = `Got it (Patient: *${patientLabel}*).\n\n` +
                      `What is the primary medical emergency?\n\n` +
                      `1️⃣ 🩸 Accident / Severe Bleeding\n` +
                      `2️⃣ 🫁 Breathing Difficulty / Chest Pain\n` +
                      `3️⃣ 🧠 Unconscious / Unresponsive\n` +
                      `4️⃣ 🤰 Pregnancy / Labor\n` +
                      `5️⃣ ⚠️ Other Urgent Emergency`;

    return safeXmlResponse(res, replyText);
  }

  // STEP 3: Handle Medical Emergency Selection (1 to 5)
  if (session && session.state === 'AWAITING_EMERGENCY_TYPE') {
    let immediateAction = "";

    switch (incomingMsg) {
      case '1':
        immediateAction = "• Apply direct, hard pressure to the wound with a clean cloth.\n• Keep patient still and elevate injured area above heart if possible.";
        break;
      case '2':
        immediateAction = "• Sit patient upright in a comfortable position.\n• Loosen tight clothing around neck and chest; ensure fresh airflow.";
        break;
      case '3':
        immediateAction = "• Roll patient onto their side in recovery position.\n• Keep airway clear and monitor breathing continuously.";
        break;
      case '4':
        immediateAction = "• Keep patient lying on her left side in a quiet, warm area.\n• Prepare clean towels and remain calm.";
        break;
      case '5':
      default:
        immediateAction = "• Keep patient calm, comfortable, and warm until paramedics arrive.";
        break;
    }

    session.state = 'DISPATCHED';

    const replyText = `⚠️ *IMMEDIATE ACTION:*\n` +
                      `${immediateAction}\n\n` +
                      `📞 *Need urgent human escalation?* Call our dispatch control line immediately if conditions worsen.`;

    return safeXmlResponse(res, replyText);
  }

  // STEP 4: Active Dispatch Status Message
  if (session && session.state === 'DISPATCHED') {
    const replyText = `🚑 Ambulance unit for Ticket *#${session.ticketId}* is currently moving to your location.\n\n` +
                      `Keep this line open. To request a new ambulance, please send a new GPS location pin.`;

    return safeXmlResponse(res, replyText);
  }

  // STEP 5: AI First Aid Fallback for free text input
  const apiKey = process.env.GEMINI_API_KEY;
  const modelName = process.env.GEMINI_MODEL || 'gemini-2.0-flash';

  if (!apiKey) {
    const replyText = "🚨 *CONFIG ERROR:* GEMINI_API_KEY is missing in Vercel settings.\n\n📍 Send **Location Pin** (📎) for an ambulance.";
    return safeXmlResponse(res, replyText);
  }

  try {
    const ai = new GoogleGenAI({ apiKey });
    const prompt = `${FIRST_AID_SYSTEM_INSTRUCTION}\n\nUSER EMERGENCY QUERY: "${rawBody}"`;
    const response = await ai.models.generateContent({
      model: modelName,
      contents: prompt
    });

    const replyText = `${response.text}\n\n-------------------\n📍 **Need Ambulance?** Send **Location Pin** (📎).\n📌 *Reply 0 for Main Menu.*`;
    return safeXmlResponse(res, replyText);
  } catch (error) {
    console.error("WhatsApp AI Webhook Error:", error);
    const replyText = `🚨 *AI Error:* ${error.message || 'Unable to generate response.'}\n\n📍 Send **Location Pin** (📎) for an ambulance.\n📌 *Reply 0 for Main Menu.*`;
    return safeXmlResponse(res, replyText);
  }
});

// Root check
app.get('/', (req, res) => {
  res.send('Ambulink Multi-Step Dispatch & First-Aid API is running...');
});

// Server listener
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

module.exports = app;
