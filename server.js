const express = require('express');
const app = express();

app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const GOOGLE_SHEET_WEBHOOK_URL = 'https://script.google.com/macros/s/YOUR_APPS_SCRIPT_ID_HERE/exec';

// Simulated OpenAI Whisper Transcription Helper
async function transcribeAudio(audioUrl) {
  try {
    console.log(`🎙️ Processing voice note from: ${audioUrl}`);
    return "[Voice Note Received - Play Audio in Dispatch Sheet]"; 
  } catch (err) {
    console.error("Audio Transcription Error:", err);
    return "[Voice note attached]";
  }
}

// Sync updates to Google Sheets
async function syncToGoogleSheet(ticketData) {
  if (!GOOGLE_SHEET_WEBHOOK_URL || GOOGLE_SHEET_WEBHOOK_URL.includes('YOUR_APPS_SCRIPT_ID_HERE')) return;
  try {
    await fetch(GOOGLE_SHEET_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(ticketData),
      redirect: 'follow'
    });
  } catch (err) {
    console.error('❌ Sync Error:', err.message);
  }
}

// In-Memory Session Storage
const sessions = new Map();

// Automatic cleanup: Delete inactive sessions older than 6 hours
setInterval(() => {
  const now = Date.now();
  const SIX_HOURS = 6 * 60 * 60 * 1000;
  for (const [key, session] of sessions.entries()) {
    if (session.lastUpdated && (now - session.lastUpdated > SIX_HOURS)) {
      sessions.delete(key);
    }
  }
}, 60 * 60 * 1000);

app.post('/twilio-webhook', async (req, res) => {
  const from = req.body.From;
  const body = req.body.Body ? req.body.Body.trim() : '';
  const latitude = req.body.Latitude;
  const longitude = req.body.Longitude;
  
  const mediaUrl = req.body.MediaUrl0;
  const mediaType = req.body.MediaContentType0;
  const isAudio = mediaUrl && mediaType && mediaType.startsWith('audio/');

  if (!from) return sendResponse(res, `Couldn't identify sender.`);

  let session = sessions.get(from);

  // GLOBAL COMMAND: RESET / START
  if (body.toLowerCase() === 'reset' || body.toLowerCase() === 'start') {
    if (session) {
      session.status = 'RESET';
      syncToGoogleSheet(session);
      sessions.delete(from);
    }
    return sendResponse(res, `🔄 *AMBULINK DISPATCH RESET*\n\nSend a GPS location pin (📎 Attachment ➔ Location) to start a new emergency request.`);
  }

  // 1. NEW GPS LOCATION PIN
  if (latitude && longitude) {
    const mapsLink = `https://www.google.com/maps?q=${latitude},${longitude}`;

    // Updating remote patient location pin
    if (session && session.step === 'AWAITING_REMOTE_LOCATION') {
      session.lat = latitude;
      session.lon = longitude;
      session.mapsLink = mapsLink;
      session.notes += ` | Patient GPS Pin Updated: ${mapsLink}`;
      session.step = 'AWAITING_CONDITION';
      session.lastUpdated = Date.now();
      
      sessions.set(from, session);
      syncToGoogleSheet(session);

      return sendResponse(res,
        `📍 *PATIENT LOCATION SAVED!*\n\n` +
        `What is the primary medical emergency?\n\n` +
        `1️⃣ 🩸 Accident / Severe Bleeding\n` +
        `2️⃣ 🫁 Breathing Difficulty / Chest Pain\n` +
        `3️⃣ 🧠 Unconscious / Unresponsive\n` +
        `4️⃣ 🤰 Pregnancy / Labor\n` +
        `5️⃣ ⚠️ Other Urgent Emergency`
      );
    }

    // Start fresh ticket
    session = {
      from,
      step: 'AWAITING_PATIENT_TYPE',
      lat: latitude,
      lon: longitude,
      mapsLink: mapsLink,
      ticketId: 'AMB-' + Math.floor(1000 + Math.random() * 9000),
      status: 'AWAITING_INFO',
      timestamp: new Date().toLocaleString('en-UG', { timeZone: 'Africa/Kampala' }),
      lastUpdated: Date.now(),
      audioUrl: '',
      notes: ''
    };

    sessions.set(from, session);
    syncToGoogleSheet(session);

    return sendResponse(res, 
      `🚨 *AMBULINK EMERGENCY DISPATCH*\n\n` +
      `Ticket *#${session.ticketId}* logged.\n` +
      `Who needs emergency medical help?\n\n` +
      `1️⃣ Myself\n2️⃣ Someone else`
    );
  }

  if (!session) {
    return sendResponse(res, `🚨 *AMBULINK EMERGENCY DISPATCH*\n\nPlease tap 📎 *Attachment* ➔ *Location* to send your GPS coordinates.`);
  }

  // Update activity timestamp
  session.lastUpdated = Date.now();

  const conditions = {
    '1': 'Accident / Severe Bleeding',
    '2': 'Breathing Difficulty / Chest Pain',
    '3': 'Unconscious / Unresponsive',
    '4': 'Pregnancy / Labor',
    '5': 'Other Urgent Emergency'
  };

  // 2. STEP 1: PATIENT TYPE
  if (session.step === 'AWAITING_PATIENT_TYPE') {
    if (body === '1' || body.toLowerCase().includes('myself')) {
      session.patient = 'Self';
      session.step = 'AWAITING_CONDITION';
      sessions.set(from, session);

      return sendResponse(res, 
        `Got it (Patient: *Self*).\n\n` +
        `What is the primary medical emergency?\n\n` +
        `1️⃣ 🩸 Accident / Severe Bleeding\n` +
        `2️⃣ 🫁 Breathing Difficulty / Chest Pain\n` +
        `3️⃣ 🧠 Unconscious / Unresponsive\n` +
        `4️⃣ 🤰 Pregnancy / Labor\n` +
        `5️⃣ ⚠️ Other Urgent Emergency\n\n` +
        `*(Or send a quick Voice Note)*`
      );
    } 
    
    if (body === '2' || body.toLowerCase().includes('someone')) {
      session.patient = 'Bystander/Other';
      session.step = 'AWAITING_SAME_LOCATION_CHECK';
      sessions.set(from, session);

      return sendResponse(res, 
        `Are you currently at the **same location** as the patient?\n\n` +
        `1️⃣ Yes, I am with the patient\n` +
        `2️⃣ No, patient is somewhere else`
      );
    }
  }

  // 3. STEP 1b: LOCATION CHECK
  if (session.step === 'AWAITING_SAME_LOCATION_CHECK') {
    if (body === '1' || body.toLowerCase().includes('yes')) {
      session.step = 'AWAITING_CONDITION';
      sessions.set(from, session);

      return sendResponse(res, 
        `Got it. What is the primary medical emergency?\n\n` +
        `1️⃣ 🩸 Accident / Severe Bleeding\n` +
        `2️⃣ 🫁 Breathing Difficulty / Chest Pain\n` +
        `3️⃣ 🧠 Unconscious / Unresponsive\n` +
        `4️⃣ 🤰 Pregnancy / Labor\n` +
        `5️⃣ ⚠️ Other Urgent Emergency`
      );
    }

    if (body === '2' || body.toLowerCase().includes('no')) {
      session.step = 'AWAITING_REMOTE_LOCATION';
      sessions.set(from, session);

      return sendResponse(res, 
        `📍 *PATIENT LOCATION NEEDED*\n\n` +
        `Please **type the patient's full address or landmark** (e.g., *"Lugazi town, behind Shell petrol station"*),\n\n` +
        `OR drop a pin for the **patient's location** using 📎 *Attachment* ➔ *Location*.`
      );
    }
  }

  // 4. STEP 1c: CAPTURE REMOTE ADDRESS
  if (session.step === 'AWAITING_REMOTE_LOCATION') {
    if (body) {
      session.notes += ` | Patient Address: ${body}`;
      session.step = 'AWAITING_CONDITION';
      sessions.set(from, session);
      syncToGoogleSheet(session);

      return sendResponse(res, 
        `Address saved: *"${body}"*\n\n` +
        `What is the primary medical emergency?\n\n` +
        `1️⃣ 🩸 Accident / Severe Bleeding\n` +
        `2️⃣ 🫁 Breathing Difficulty / Chest Pain\n` +
        `3️⃣ 🧠 Unconscious / Unresponsive\n` +
        `4️⃣ 🤰 Pregnancy / Labor\n` +
        `5️⃣ ⚠️ Other Urgent Emergency`
      );
    }
  }

  // 5. STEP 2: CONDITION & DISPATCH
  if (session.step === 'AWAITING_CONDITION') {
    if (conditions[body] || isAudio) {
      if (isAudio) {
        session.audioUrl = mediaUrl;
        session.condition = "Voice Note Provided";
        session.notes += ` | Voice Note: ${await transcribeAudio(mediaUrl)}`;
      } else {
        session.condition = conditions[body];
      }

      session.step = 'DISPATCHED';
      session.status = 'DISPATCHED';
      sessions.set(from, session);

      syncToGoogleSheet(session);

      return sendResponse(res, 
        `✅ *AMBULANCE DISPATCHED!*\n\n` +
        `Ticket: *#${session.ticketId}*\n` +
        `Condition: *${session.condition}*\n\n` +
        `📍 Paramedics en route to the location provided.\n\n` +
        `💡 Reply *1-5* to update condition, send a *Voice Note*, or reply *CANCEL*.`
      );
    }
  }

  // 6. TICKET ALREADY DISPATCHED ➔ Handle Updates
  if (session.step === 'DISPATCHED') {
    if (conditions[body]) {
      const oldCondition = session.condition;
      session.condition = conditions[body];
      session.notes += ` | Corrected from [${oldCondition}] to [${session.condition}]`;
      
      sessions.set(from, session);
      syncToGoogleSheet(session);

      return sendResponse(res, 
        `🔄 *TICKET UPDATED!*\n\n` +
        `Ticket: *#${session.ticketId}*\n` +
        `Updated Condition: *${session.condition}*\n\n` +
        `Dispatch control room and paramedics have been notified.`
      );
    }

    if (isAudio) {
      session.audioUrl = mediaUrl;
      const transcript = await transcribeAudio(mediaUrl);
      session.notes += ` | Voice Note: ${transcript}`;
      
      sessions.set(from, session);
      syncToGoogleSheet(session);

      return sendResponse(res, 
        `🎙️ *VOICE NOTE RECEIVED*\n\n` +
        `Audio recording attached to Ticket *#${session.ticketId}* and forwarded directly to the responding unit.`
      );
    }

    if (body.toLowerCase() === 'cancel') {
      session.status = 'CANCELLED';
      syncToGoogleSheet(session);
      sessions.delete(from);

      return sendResponse(res, `🛑 Ticket *#${session.ticketId}* has been CANCELLED. Send a new location pin if you still need help.`);
    }

    if (body) {
      session.notes += ` | Note: ${body}`;
      sessions.set(from, session);
      syncToGoogleSheet(session);

      return sendResponse(res, 
        `📝 *NOTE ADDED TO TICKET #${session.ticketId}*\n\n` +
        `"${body}"\n\n` +
        `Paramedics en route. Reply *1-5* to update condition, or reply *CANCEL*.`
      );
    }
  }

  return sendResponse(res, `⚠️ Option not recognized. Reply with **1 to 5**, send a **Voice Note**, or type **RESET** to start over.`);
});

function sendResponse(res, textMessage) {
  res.type('text/xml').send(`
    <Response>
      <Message>${textMessage}</Message>
    </Response>
  `);
}

module.exports = app;
