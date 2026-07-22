const express = require('express');
const { GoogleGenAI } = require('@google/genai');

const app = express();
const PORT = process.env.PORT || 3000;

// Initialize Gemini Client (uses GEMINI_API_KEY environment variable if present)
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || '' });

// Middleware
app.use(express.json());

// System prompt enforcing strict first-aid guardrails
const FIRST_AID_SYSTEM_INSTRUCTION = `
You are the Ambulink Emergency First Aid Assistant.
Your ONLY function is to provide immediate, life-saving, evidence-based first aid guidance while emergency medical personnel are en route.

STRICT GUARDRAILS:
1. ONLY answer questions directly related to immediate first aid (e.g., severe bleeding, CPR, burns, choking, fractures, snakebites, unconsciousness).
2. REFUSE any non-first-aid medical requests, medication prescriptions, or general medical diagnoses.
3. Provide concise, bulleted, step-by-step instructions (maximum 4 steps).
4. ALWAYS start your response with a clear disclaimer: "🚨 Emergency dispatch notified. Follow these immediate steps while help is on the way:"
5. If the situation indicates severe emergency (no breathing, severe hemorrhage, cardiac arrest), emphasize calling emergency services immediately.
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

// --- ROUTES ---

// GET: All hospitals
app.get('/api/v1/hospitals', (req, res) => {
  res.status(200).json({ success: true, count: partnerHospitals.length, data: partnerHospitals });
});

// GET: Single hospital
app.get('/api/v1/hospitals/:id', (req, res) => {
  const hospital = partnerHospitals.find(h => h.hospital_id === req.params.id);
  if (!hospital) return res.status(404).json({ success: false, message: "Hospital not found" });
  res.status(200).json({ success: true, data: hospital });
});

// POST: Register hospital
app.post('/api/v1/hospitals', (req, res) => {
  const newHospital = req.body;
  if (!newHospital.hospital_id || !newHospital.name) {
    return res.status(400).json({ success: false, message: "hospital_id and name are required." });
  }
  partnerHospitals.push(newHospital);
  res.status(201).json({ success: true, message: "Hospital registered", data: newHospital });
});

// POST: Ambulance Dispatch
app.post('/api/v1/dispatch', (req, res) => {
  const { incident_id, location, emergency_type } = req.body;
  if (!location || location.latitude === undefined || location.longitude === undefined) {
    return res.status(400).json({ success: false, message: "Location coordinates required." });
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

// POST: AI First-Aid Guidance Endpoint
app.post('/api/v1/first-aid', async (req, res) => {
  const { query, incident_id } = req.body;

  if (!query) {
    return res.status(400).json({
      success: false,
      message: "Please provide a query describing the emergency or injury."
    });
  }

  if (!process.env.GEMINI_API_KEY) {
    return res.status(500).json({
      success: false,
      message: "GEMINI_API_KEY environment variable is missing on the server."
    });
  }

  try {
    const prompt = `${FIRST_AID_SYSTEM_INSTRUCTION}\n\nUSER EMERGENCY QUERY: "${query}"`;

    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: prompt
    });

    res.status(200).json({
      success: true,
      incident_id: incident_id || null,
      first_aid_guidance: response.text,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error("AI First-Aid Endpoint Error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to generate first-aid response. Please follow standard emergency protocol."
    });
  }
});

// Root check
app.get('/', (req, res) => {
  res.send('Ambulink Webhook API with First-Aid AI is running...');
});

// Start server locally
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

// Export app for serverless platforms like Vercel
module.exports = app;
