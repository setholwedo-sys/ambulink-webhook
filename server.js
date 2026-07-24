const express = require('express');
const { GoogleGenAI } = require('@google/genai');

const app = express();
const PORT = process.env.PORT || 3000;

// Initialize Gemini Client
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || '' });

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// STRICT ULTRA-SHORT EMERGENCY PROMPT
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

// Helper: Haversine distance formula
function calculateDistance(lat1, lon1, lat2, lon2) {
  const R = 6371;
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

// Partner hospitals
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

// --- API ROUTES ---

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
  if (!location || location.latitude === undefined || location.longitude === undefined) {
    return res.status(400).json({ success: false, message: "Location required." });
  }

  const available = partnerHospitals.filter(h => h.dispatch_status === "AVAILABLE");
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

// --- ULTRA-SHORT EMERGENCY WHATSAPP WEBHOOK ---

app.post('/webhook', async (req, res) => {
  const incomingMsg = (req.body.Body || '').trim().toLowerCase();
  const userLat = req.body.Latitude;
  const userLon = req.body.Longitude;
  let replyText = '';

  // 1. DISPATCH: User sent a Location Pin
  if (userLat && userLon) {
    const lat = parseFloat(userLat);
    const lon = parseFloat(userLon);
    const available = partnerHospitals.filter(h => h.dispatch_status === "AVAILABLE");

    if (available.length === 0) {
      replyText = "🚨 *NO HOSPITALS AVAILABLE*\nCall national emergency line immediately.";
    } else {
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
      replyText = `🚨 *AMBULANCE DISPATCHED!*\n\n` +
                  `🏥 **${nearest.name}**\n` +
                  `📍 **${shortestDist.toFixed(1)} km** away | ⏱️ **ETA: ~${eta} mins**\n\n` +
                  `Stay calm. Reply with injury for First Aid instructions.`;
    }
  } 
  // 2. SHORT TRIAGE: Greeting / General text
  else if (
    incomingMsg === '' || 
    ['hi', 'hello', 'hey', 'start', 'help', 'menu', 'emergency', 'ambulink'].includes(incomingMsg)
  ) {
    replyText = `🚨 *AMBULINK EMERGENCY*\n\n` +
                `📍 **Need Ambulance?**\n` +
                `Send your **Location Pin** (📎 icon).\n\n` +
                `🩹 **Need First Aid?**\n` +
                `Reply with injury (e.g., *"bleeding"*, *"burn"*, *"choking"*).`;
  } 
  // 3. RAPID FIRST AID: Gemini response
  else {
    try {
      const prompt = `${FIRST_AID_SYSTEM_INSTRUCTION}\n\nUSER EMERGENCY QUERY: "${req.body.Body}"`;
      const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: prompt
      });
      
      replyText = `${response.text}\n\n-------------------\n📍 *Need Ambulance?* Send **Location Pin** (📎).`;
    } catch (error) {
      console.error("WhatsApp AI Webhook Error:", error);
      replyText = "🚨 Emergency registered.\n\n📍 Send your **Location Pin** (📎) for an ambulance.";
    }
  }

  // Send TwiML XML
  res.type('text/xml');
  res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Message><![CDATA[${replyText}]]></Message>
</Response>`);
});

app.get('/', (req, res) => {
  res.send('Ambulink Webhook API with First-Aid AI is running...');
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

module.exports = app;
