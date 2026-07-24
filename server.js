import express from 'express';
import { GoogleGenAI } from '@google/genai';
import { Redis } from '@upstash/redis';
import twilio from 'twilio';

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const redis = Redis.fromEnv();
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
4. Use BOLD action verbs.
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

function xmlResponse(text) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Message><![CDATA[${text}]]></Message>
</Response>`;
}

app.get('/', (req, res) => {
  res.send('Ambulink Emergency Webhook is live on Vercel.');
});

app.post('/api/webhook', async (req, res) => {
  try {
    const params = req.body;
    const userPhone = params.From || 'unknown';
    const rawBody = params.Body?.toString() || '';
    const incomingMsg = rawBody.trim().toLowerCase();
    const userLat = parseFloat(params.Latitude);
    const userLon = parseFloat(params.Longitude);

    const resetKeywords = ['0', 'menu', 'reset', 'cancel', 'start', 'help', 'hi', 'hello', 'emergency', 'ambulink'];
    const sessionKey = `session:${userPhone}`;

    if (resetKeywords.includes(incomingMsg)) {
      await redis.del(sessionKey);
      return res.type('text/xml').send(xmlResponse(`🚨 *AMBULINK EMERGENCY*\n\n📍 Send your **Location Pin** for ambulance.\n\n🩹 Reply with injury (e.g. "bleeding").`));
    }

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

      await redis.set(sessionKey, sessionData, { ex: 1800 });
      const reply = `🚨 *AMBULINK EMERGENCY DISPATCH*\n\nTicket *#${ticketId}* logged.\n🏥 **${nearest.name}**\n📏 **${distKm} km** | ⏱️ **ETA ~ ${etaMins} mins**\n\nWho needs help?\n1️⃣ Myself\n2️⃣ Someone else`;
      return res.type('text/xml').send(xmlResponse(reply));
    }

    const session = await redis.get(sessionKey);

    if (session && session.state === 'AWAITING_PATIENT_TYPE') {
      const patient = (incomingMsg === '1' || incomingMsg.includes('myself')) ? 'Self' : 'Other';
      session.patient = patient;
      session.state = 'AWAITING_EMERGENCY_TYPE';
      await redis.set(sessionKey, session, { ex: 1800 });
      return res.type('text/xml').send(xmlResponse(`Patient: *${patient}*\n\nWhat is the emergency?\n1️⃣ 🩸 Severe Bleeding\n2️⃣ 🫁 Breathing Difficulty\n3️⃣ 🧠 Unconscious\n4️⃣ 🤰 Pregnancy\n5️⃣ Other`));
    }

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
      return res.type('text/xml').send(xmlResponse(`⚠️ *IMMEDIATE ACTION:*\n${action}\n\n🚑 Dispatching from **${session.hospitalName}** (${session.distanceKm} km, ETA ~ ${session.etaMins} mins).\n\nReply 0 for menu.`));
    }

    if (session && session.state === 'DISPATCHED') {
      return res.type('text/xml').send(xmlResponse(`🚑 Ambulance from **${session.hospitalName}** is en route (ETA ~ ${session.etaMins} mins).\n\nKeep line open. Send new location to restart.`));
    }

    if (!genAI) {
      return res.type('text/xml').send(xmlResponse('🚨 Configuration error. Send location pin.'));
    }

    const result = await genAI.models.generateContent({
      model: GEMINI_MODEL,
      contents: rawBody,
      config: { systemInstruction: FIRST_AID_SYSTEM_INSTRUCTION }
    });

    const aiReply = result.text?.trim();
    if (!aiReply) {
      return res.type('text/xml').send(xmlResponse('🚨 Unable to process that message.\n\n📍 Send Location Pin for ambulance.\nReply 0 for menu.'));
    }

    return res.type('text/xml').send(xmlResponse(`${aiReply}\n\n📍 Send Location Pin for ambulance.\nReply 0 for menu.`));
  } catch (error) {
    console.error('Webhook Error:', error);
    return res.type('text/xml').send(xmlResponse('🚨 Service busy. Try sending location pin.'));
  }
});

export default app;
