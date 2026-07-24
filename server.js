const express = require('express');
const { GoogleGenAI } = require('@google/genai');

const app = express();
const PORT = process.env.PORT || 3000;

// Initialize Gemini Client
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || '' });

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

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

app.post('/api/v1/dispatch', (req, res) => {
  const { incident_id, location, emergency_type } = req.body;
  if (!location || typeof location.latitude !== 'number' || typeof location.longitude !== 'number') {
    return res.status(400).json({ success: false, message: "Valid location coordinates required." });
  }

  const available = partnerHospitals.filter(h => 
    h.dispatch_status === "AVAILABLE" && 
    h.location?.coordinates?.latitude !== undefined
  );

  if (available.length === 0) {
    return res.status(503).json({ success: false, message: "No available partner hospitals." });
  }

  let nearest = null;
  let shortestDist = Infinity;

  available.forEach(hospital => {
    const dist = calculateDistance(
      location.latitude,
      location.longitude,
      hospital.location.coordinates.latitude,
      hospital.location.coordinates.longitude
    );
    if (dist < shortestDist) {
      shortestDist = dist;
      nearest = hospital;
    }
  });

  res.status(200).json({
    success: true,
    message: "Emergency dispatch assigned",
    data: {
      dispatch_id: `disp_${Date.now()}`,
      incident_id: incident_id || `inc_${Math.floor(Math.random() * 10000)}`,
      emergency_type: emergency_type || "General Emergency",
      status: "DISPATCHED",
      timestamp: new Date().toISOString(),
      assigned_hospital: {
        hospital_id: nearest.hospital_id,
        name: nearest.name,
        town: nearest.location.town
      },
      distance_km: parseFloat(shortestDist.toFixed(2)),
      estimated_eta_minutes: Math.ceil(shortestDist * 2)
    }
  });
});

app.post('/api/v1/first-aid', async (req, res) => {
  const { query, incident_id } = req.body;

  if (!query) {
    return res.status(400).json({ success: false, message: "Query required." });
  }

  if (!process.env.GEMINI_API_KEY) {
    return res.status(500).json({ success: false, message: "GEMINI_API_KEY missing." });
  }

  try {
    const prompt = `${FIRST_AID_SYSTEM_INSTRUCTION}\n\nUSER EMERGENCY QUERY: "${query}"`;
    const response = await ai.models.generateContent({ model: 'gemini-2.5-flash', contents: prompt });

    res.status(200).json({
      success: true,
      incident_id: incident_id || null,
      first_aid_guidance: response.text,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({ success: false, message: "Failed to generate first-aid response." });
  }
});

// --- HARDENED WHATSAPP DISPATCH & TRIAGE WEBHOOK ---

app.post('/webhook', async (req, res) => {
  const rawBody = req.body.Body || '';
  const incomingMsg = rawBody.trim().toLowerCase();
  const userLat = req.body.Latitude;
  const userLon = req.body.Longitude;

  // Keyword Categories
  const resetKeywords = ['0', 'menu', 'reset', 'cancel', 'back', 'start', 'help', 'hi', 'hello', 'hey', 'emergency', 'ambulink', 'sos'];
  const locationHelpKeywords = ['location', 'pin', 'gps', 'map', 'send location', 'where'];

  // 1. DISPATCH: User sent a Location Pin via WhatsApp
  if (userLat && userLon) {
    const lat = parseFloat(userLat);
    const lon = parseFloat(userLon);

    const available = partnerHospitals.filter(h => 
      h.dispatch_status === "AVAILABLE" && 
      h.location?.coordinates?.latitude !== undefined
    );

    if (available.length === 0) {
      return safeXmlResponse(res, "🚨 *NO HOSPITALS AVAILABLE*\nPlease contact national emergency services immediately.");
    }

    let nearest = null;
    let shortestDist = Infinity;

    available.forEach(hospital => {
      const dist = calculateDistance(lat, lon, hospital.location.coordinates.latitude, hospital.location.coordinates.longitude);
      if (dist < shortestDist) {
        shortestDist = dist;
        nearest = hospital;
      }
    });

    const eta = Math.ceil(shortestDist * 2);
    const replyText = `🚨 *AMBULANCE DISPATCHED!*\n\n` +
                      `🏥 **${nearest.name}**\n` +
                      `📍 **${shortestDist.toFixed(1)} km** away | ⏱️ **ETA: ~${eta} mins**\n\n` +
                      `Stay calm. Reply with injury for First Aid advice.\n` +
                      `📌 *Reply 0 for Main Menu.*`;

    return safeXmlResponse(res, replyText);
  }

  // 2. LOCATION INSTRUCTIONS: User typed keywords asking how to send location
  if (locationHelpKeywords.some(keyword => incomingMsg.includes(keyword))) {
    const replyText = `📍 *HOW TO SHARE LOCATION FOR AMBULANCE:*\n\n` +
                      `1. Tap the **📎 Attachment** icon (or **+** on iPhone) in WhatsApp.\n` +
                      `2. Select **Location**.\n` +
                      `3. Tap **Send Your Current Location**.\n\n` +
                      `📌 *Reply 0 for Main Menu.*`;
    return safeXmlResponse(res, replyText);
  }

  // 3. MENU / RESET: Greeting or Navigational Reset Commands
  if (incomingMsg === '' || resetKeywords.includes(incomingMsg)) {
    const replyText = `🚨 *AMBULINK EMERGENCY*\n\n` +
                      `📍 **Need Ambulance?**\n` +
                      `Send your **Location Pin** (tap 📎 icon -> Location).\n\n` +
                      `🩹 **Need First Aid?**\n` +
                      `Reply with injury (e.g., *"bleeding"*, *"burn"*, *"choking"*).`;
    return safeXmlResponse(res, replyText);
  }

  // 4. FIRST AID AI: Process Query via Gemini AI
  try {
    const prompt = `${FIRST_AID_SYSTEM_INSTRUCTION}\n\nUSER EMERGENCY QUERY: "${rawBody}"`;
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: prompt
    });

    const replyText = `${response.text}\n\n-------------------\n📍 **Need Ambulance?** Send **Location Pin** (📎).\n📌 *Reply 0 for Main Menu.*`;
    return safeXmlResponse(res, replyText);
  } catch (error) {
    console.error("WhatsApp AI Webhook Error:", error);
    const replyText = "🚨 Emergency registered.\n\n📍 Send **Location Pin** (📎) for an ambulance.\n📌 *Reply 0 for Main Menu.*";
    return safeXmlResponse(res, replyText);
  }
});

// Root check
app.get('/', (req, res) => {
  res.send('Ambulink Webhook API with First-Aid AI is running...');
});

// Server listener
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

module.exports = app;
