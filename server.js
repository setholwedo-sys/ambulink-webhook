const express = require('express');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// In-Memory Session Storage (Tracks user state per phone number)
const userSessions = {};

// FIRST-AID SYSTEM INSTRUCTION
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

// Haversine distance formula (in km)
function calculateDistance(lat1, lon1, lat2, lon2) {
  if ([lat1, lon1, lat2, lon2].some(v => typeof v !== 'number' || isNaN(v))) return Infinity;
  const R = 6371; // Earth radius in km
  const dLat = (lat2 - lat1) * (Math.PI / 180);
  const dLon = (lon2 - lon1) * (Math.PI / 180);
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(lat1 * (Math.PI / 180)) * Math.cos(lat2 * (Math.PI / 180)) *
            Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return R * (2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}

// Partner Hospitals Database
let partnerHospitals = [
  {
    hospital_id: "hosp_kawolo_ug_01",
    name: "Kawolo General Hospital",
    location: { district: "Buikwe", town: "Lugazi", coordinates: { latitude: 0.368050, longitude: 32.945553 } },
    dispatch_status: "AVAILABLE"
  },
  {
    hospital_id: "hosp_jinja_ug_02",
    name: "Jinja Regional Referral Hospital",
    location: { district: "Jinja", town: "Jinja City", coordinates: { latitude: 0.428300, longitude: 33.203600 } },
    dispatch_status: "AVAILABLE"
  }
];

// Helper to wrap response in TwiML XML format for WhatsApp
function safeXmlResponse(res, messageText) {
  const cleanText = messageText.replace(/]]>/g, ']]&gt;');
  res.type('text/xml');
  return res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Message><![CDATA[${cleanText}]]></Message>
</Response>`);
}

// REST Endpoints
app.get('/api/v1/hospitals', (req, res) => res.json({ success: true, data: partnerHospitals }));

// Multi-step WhatsApp Dispatch & AI Webhook
app.post('/webhook', async (req, res) => {
  const userPhone = req.body.From || 'unknown';
  const rawBody = req.body.Body || '';
  const incomingMsg = rawBody.trim().toLowerCase();
  const userLat = req.body.Latitude;
  const userLon = req.body.Longitude;

  const resetKeywords = ['0', 'menu', 'reset', 'cancel', 'start', 'help', 'hi', 'hello', 'emergency', 'ambulink'];

  // Global Navigation: Reset Session
  if (resetKeywords.includes(incomingMsg)) {
    delete userSessions[userPhone];
    return safeXmlResponse(res, `🚨 *AMBULINK EMERGENCY*\n\n📍 **Need Ambulance?**\nSend your **Location Pin** (tap 📎 icon -> Location).\n\n🩹 **Need First Aid?**\nReply with injury (e.g., *"bleeding"*).`);
  }

  // STEP 1: User sends Location Pin -> Calculate Nearest Hospital, Distance (km) & ETA
  if (userLat && userLon) {
    const lat = parseFloat(userLat);
    const lon = parseFloat(userLon);
    const ticketId = `AMB-${Math.floor(1000 + Math.random() * 9000)}`;

    // Find nearest available hospital
    const available = partnerHospitals.filter(h => h.dispatch_status === "AVAILABLE" && h.location?.coordinates?.latitude);
    let nearest = available[0] || partnerHospitals[0];
    let shortestDist = Infinity;

    available.forEach(hospital => {
      const dist = calculateDistance(lat, lon, hospital.location.coordinates.latitude, hospital.location.coordinates.longitude);
      if (dist < shortestDist) {
        shortestDist = dist;
        nearest = hospital;
      }
    });

    const distKm = shortestDist !== Infinity ? shortestDist.toFixed(1) : "1.5";
    const etaMins = Math.ceil(parseFloat(distKm) * 2) || 5;

    // Save calculation into user's session state
    userSessions[userPhone] = {
      state: 'AWAITING_PATIENT_TYPE',
      ticketId: ticketId,
      lat: lat.toFixed(6),
      lon: lon.toFixed(6),
      hospitalName: nearest.name,
      distanceKm: distKm,
      etaMins: etaMins
    };

    const replyText = `🚨 *AMBULINK EMERGENCY DISPATCH*\n\n` +
                      `Ticket *#${ticketId}* logged.\n` +
                      `📍 Coordinates: ${lat.toFixed(6)}, ${lon.toFixed(6)}\n` +
                      `🏥 **${nearest.name}**\n` +
                      `📏 **${distKm} km away** | ⏱️ **ETA: ~${etaMins} mins**\n\n` +
                      `Who needs emergency medical help?\n\n` +
                      `1️⃣ Myself\n` +
                      `2️⃣ Someone else`;

    return safeXmlResponse(res, replyText);
  }

  const session = userSessions[userPhone];

  // STEP 2: Handle Patient Selection
  if (session && session.state === 'AWAITING_PATIENT_TYPE') {
    if (incomingMsg === '1' || incomingMsg === '2' || incomingMsg.includes('myself') || incomingMsg.includes('someone')) {
      session.patient = (incomingMsg === '1' || incomingMsg.includes('myself')) ? 'Self' : 'Bystander/Other';
      session.state = 'AWAITING_EMERGENCY_TYPE';
      
      const replyText = `Got it (Patient: *${session.patient}*).\n\n` +
                        `What is the primary medical emergency?\n\n` +
                        `1️⃣ 🩸 Accident / Severe Bleeding\n` +
                        `2️⃣ 🫁 Breathing Difficulty / Chest Pain\n` +
                        `3️⃣ 🧠 Unconscious / Unresponsive\n` +
                        `4️⃣ 🤰 Pregnancy / Labor\n` +
                        `5️⃣ ⚠️ Other Urgent Emergency`;

      return safeXmlResponse(res, replyText);
    }
  }

  // STEP 3: Handle Emergency Category & Dispatch Action
  if (session && session.state === 'AWAITING_EMERGENCY_TYPE') {
    const actions = {
      '1': "• Apply direct, hard pressure to the wound with a clean cloth.\n• Keep patient still and elevate injury above heart if possible.",
      '2': "• Sit patient upright in a comfortable position.\n• Loosen tight clothing around neck and chest; ensure fresh airflow.",
      '3': "• Roll patient onto their side in recovery position.\n• Keep airway clear and monitor breathing continuously.",
      '4': "• Keep patient lying on her left side in a quiet, warm area.\n• Prepare clean towels and remain calm."
    };

    session.state = 'DISPATCHED';
    const action = actions[incomingMsg] || "• Keep patient calm, comfortable, and warm until paramedics arrive.";

    const replyText = `⚠️ *IMMEDIATE ACTION:*\n${action}\n\n` +
                      `🚑 Dispatching from **${session.hospitalName}** (*${session.distanceKm} km away*, ETA **~${session.etaMins} mins**).\n\n` +
                      `📞 *Need urgent human escalation?* Call our dispatch control line immediately if conditions worsen.`;

    return safeXmlResponse(res, replyText);
  }

  // STEP 4: Active Dispatch Status Message
  if (session && session.state === 'DISPATCHED') {
    const replyText = `🚑 Ambulance unit from **${session.hospitalName}** (*${session.distanceKm} km away*) for Ticket *#${session.ticketId}* is currently moving to your location (ETA ~${session.etaMins} mins).\n\n` +
                      `Keep this line open. To request a new ambulance, please send a new GPS location pin.`;

    return safeXmlResponse(res, replyText);
  }

  // STEP 5: First-Aid AI Fallback for Free Text
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return safeXmlResponse(res, "🚨 *CONFIG ERROR:* GEMINI_API_KEY missing in Vercel settings.\n\n📍 Send **Location Pin** (📎) for an ambulance.");
  }

  try {
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ 
      model: "gemini-1.5-flash",
      systemInstruction: FIRST_AID_SYSTEM_INSTRUCTION 
    });

    const result = await model.generateContent(rawBody);
    return safeXmlResponse(res, `${result.response.text()}\n\n-------------------\n📍 **Need Ambulance?** Send **Location Pin** (📎).\n📌 *Reply 0 for Main Menu.*`);
  } catch (error) {
    console.error("WhatsApp AI Error:", error);
    return safeXmlResponse(res, `🚨 *AI Error:* ${error.message || 'Unable to generate response.'}\n\n📍 Send **Location Pin** (📎) for an ambulance.`);
  }
});

app.get('/', (req, res) => res.send('Ambulink API is running...'));
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
module.exports = app;
