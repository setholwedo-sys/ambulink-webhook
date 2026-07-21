require('dotenv').config();
const express = require('express');
const twilio = require('twilio');
const OpenAI = require('openai');
const fs = require('fs');
const path = require('path');
const os = require('os');

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// Initialize Clients
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Session Store (Key: phone number, Value: session data)
const sessions = new Map();

// Medical Conditions Map
const CONDITIONS = {
  '1': 'Accident / Severe Bleeding',
  '2': 'Breathing Difficulty / Chest Pain',
  '3': 'Unconscious / Unresponsive',
  '4': 'Pregnancy / Labor',
  '5': 'Other Urgent Emergency'
};

// ===========================================================================
// HELPER FUNCTIONS
// ===========================================================================

/**
 * Transcribe Twilio WhatsApp Voice Notes using OpenAI Whisper API
 */
async function transcribeAudio(mediaUrl) {
  const tempFilePath = path.join(os.tmpdir(), `voice_${Date.now()}.ogg`);
  try {
    const authHeader = 'Basic ' + Buffer.from(`${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`).toString('base64');
    const response = await fetch(mediaUrl, { headers: { 'Authorization': authHeader } });

    if (!response.ok) throw new Error(`Twilio download failed (${response.status})`);

    const buffer = Buffer.from(await response.arrayBuffer());
    fs.writeFileSync(tempFilePath, buffer);

    const transcription = await openai.audio.transcriptions.create({
      file: fs.createReadStream(tempFilePath),
      model: 'whisper-1',
      prompt: 'Medical emergency dispatch audio recording'
    });

    return transcription.text;
  } catch (err) {
    console.error('❌ Whisper Transcription Error:', err.message);
    return '[Audio received - Transcription unavailable]';
  } finally {
    if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);
  }
}

/**
 * Sync active ticket status to Google Sheets Live Dispatch Board
 */
async function syncToGoogleSheet(ticketData) {
  const webhookUrl = process.env.GOOGLE_SHEET_WEBHOOK_URL;
  if (!webhookUrl || webhookUrl.includes('YOUR_APPS_SCRIPT_ID')) return;

  try {
    await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(ticketData),
      redirect: 'follow'
    });
    console.log(`📊 Ticket #${ticketData.ticketId} synced to Google Sheets.`);
  } catch (err) {
    console.error('❌ Google Sheet Sync Error:', err.message);
  }
}

/**
 * Trigger an Automated Voice Robocall to the Duty Paramedic via Twilio Voice API
 */
async function triggerParamedicRobocall(ticketId, condition, lat, lon) {
  const paramedicPhone = process.env.DUTY_PARAMEDIC_PHONE;
  if (!paramedicPhone) return;

  try {
    const mapsUrl = `https://www.google.com/maps/search/?api=1&query=${lat},${lon}`;
    
    await twilioClient.calls.create({
      twiml: `<Response>
                <Say voice="alice" loop="2">
                  Emergency Alert from Ambulink. High priority Ticket number ${ticketId.replace('-', ' ')}. 
                  Medical condition: ${condition}. 
                  Check your dispatch dashboard for GPS coordinates immediately.
                </Say>
              </Response>`,
      to: paramedicPhone,
      from: process.env.TWILIO_WHATSAPP_NUMBER.replace('whatsapp:', '')
    });
    console.log(`📞 Robocall dispatched to paramedic at ${paramedicPhone} for Ticket #${ticketId}`);
  } catch (err) {
    console.error('❌ Twilio Voice Call Error:', err.message);
  }
}

/**
 * Alert Emergency Contact (Relative) via SMS/WhatsApp
 */
async function alertEmergencyContact(contactPhone, patientPhone, ticketId, lat, lon) {
  try {
    const mapsUrl = `https://www.google.com/maps/search/?api=1&query=${lat},${lon}`;
    const formattedPhone = contactPhone.startsWith('+') ? contactPhone : `+${contactPhone.replace(/\D/g, '')}`;

    await twilioClient.messages.create({
      body: `🚨 *AMBULINK EMERGENCY NOTICE*\n\n` +
            `Your relative (${patientPhone}) requested emergency dispatch.\n` +
            `Ticket: *#${ticketId}*\n` +
            `Live GPS Map: ${mapsUrl}\n\n` +
            `Paramedics are en route.`,
      from: process.env.TWILIO_WHATSAPP_NUMBER,
      to: formattedPhone.includes('whatsapp:') ? formattedPhone : `whatsapp:${formattedPhone}`
    });
    console.log(`📲 Emergency contact ${formattedPhone} alerted for Ticket #${ticketId}`);
    return true;
  } catch (err) {
    console.error('❌ Emergency Contact Alert Error:', err.message);
    return false;
  }
}

/**
 * Send TwiML XML Response helper
 */
function sendResponse(res, messageText) {
  const twiml = new twilio.twiml.MessagingResponse();
  twiml.message(messageText);
  res.type('text/xml').send(twiml.toString());
}

// ===========================================================================
// MAIN WEBHOOK ROUTE
// ===========================================================================

app.post('/twilio-webhook', async (req, res) => {
  const from = req.body.From;
  const body = req.body.Body ? req.body.Body.trim() : '';
  const latitude = req.body.Latitude;
  const longitude = req.body.Longitude;

  const mediaUrl = req.body.MediaUrl0;
  const mediaType = req.body.MediaContentType0;
  const isAudio = mediaUrl && mediaType && mediaType.startsWith('audio/');

  if (!from) return sendResponse(res, `Couldn't identify sender line.`);

  // 1. NEW GPS LOCATION RECEIVED ➔ Initialize Ticket
  if (latitude && longitude) {
    const session = {
      from,
      step: 'AWAITING_PATIENT_TYPE',
      lat: latitude,
      lon: longitude,
      ticketId: 'AMB-' + Math.floor(1000 + Math.random() * 9000),
      status: 'AWAITING_INFO',
      patient: '',
      condition: '',
      notes: '',
      emergencyContact: ''
    };

    sessions.set(from, session);
    syncToGoogleSheet(session);

    return sendResponse(res,
      `🚨 *AMBULINK EMERGENCY DISPATCH*\n\n` +
      `Ticket *#${session.ticketId}* logged.\n\n` +
      `Who needs emergency medical help?\n\n` +
      `1️⃣ Myself\n` +
      `2️⃣ Someone else`
    );
  }

  let session = sessions.get(from);

  if (!session) {
    return sendResponse(res, `🚨 *AMBULINK EMERGENCY DISPATCH*\n\nPlease tap 📎 *Attachment* ➔ *Location* to send your GPS coordinates.`);
  }

  // 2. DISPATCHED STATE (Post-dispatch updates, Voice Notes, Emergency Contacts)
  if (session.step === 'DISPATCHED' || session.step === 'AWAITING_EMERGENCY_CONTACT') {

    // A. Cancel Ticket
    if (body.toLowerCase() === 'cancel') {
      session.status = 'CANCELLED';
      syncToGoogleSheet(session);
      sessions.delete(from);
      return sendResponse(res, `🛑 Ticket *#${session.ticketId}* has been CANCELLED.`);
    }

    // B. Condition Correction (1 to 5)
    if (CONDITIONS[body]) {
      const oldCondition = session.condition;
      session.condition = CONDITIONS[body];
      session.notes += ` | Corrected from [${oldCondition}] to [${session.condition}]`;
      
      syncToGoogleSheet(session);

      return sendResponse(res,
        `🔄 *CONDITION UPDATED*\n\n` +
        `Ticket: *#${session.ticketId}*\n` +
        `Updated Medical Status: *${session.condition}*\n\n` +
        `Control center and responding paramedics have been alerted to this change.`
      );
    }

    // C. Process Audio / Voice Notes via Whisper API
    if (isAudio) {
      const transcript = await transcribeAudio(mediaUrl);
      session.notes += ` | Voice Note: "${transcript}"`;
      
      syncToGoogleSheet(session);

      return sendResponse(res,
        `🎙️ *VOICE NOTE RECEIVED*\n\n` +
        `*Transcript:* "${transcript}"\n\n` +
        `Audio attached to Ticket *#${session.ticketId}* and forwarded directly to responders.`
      );
    }

    // D. Process Emergency Contact Phone Number Input
    if (session.step === 'AWAITING_EMERGENCY_CONTACT') {
      const success = await alertEmergencyContact(body, from, session.ticketId, session.lat, session.lon);
      session.step = 'DISPATCHED';
      
      if (success) {
        session.emergencyContact = body;
        syncToGoogleSheet(session);
        return sendResponse(res, `✅ *EMERGENCY CONTACT NOTIFIED*\n\nWe sent an automated alert and live GPS map to *${body}*.`);
      } else {
        return sendResponse(res, `⚠️ Could not reach that number. Reply with a valid international number (e.g., +256...) or reply *SKIP*.`);
      }
    }

    // E. General Text Note Appended
    if (body) {
      session.notes += ` | Note: ${body}`;
      syncToGoogleSheet(session);

      return sendResponse(res,
        `📝 *NOTE ADDED TO TICKET #${session.ticketId}*\n\n` +
        `"${body}"\n\n` +
        `To notify a relative, reply with their phone number. To cancel, reply *CANCEL*.`
      );
    }
  }

  // 3. STEP 1: PATIENT TYPE SELECTION
  if (session.step === 'AWAITING_PATIENT_TYPE') {
    if (['1', '2'].includes(body) || body.toLowerCase().includes('myself') || body.toLowerCase().includes('someone')) {
      session.patient = (body === '1' || body.toLowerCase().includes('myself')) ? 'Self' : 'Bystander/Other';
      session.step = 'AWAITING_CONDITION';
      sessions.set(from, session);

      return sendResponse(res,
        `Got it (Patient: *${session.patient}*).\n\n` +
        `What is the primary medical emergency?\n\n` +
        `1️⃣ 🩸 Accident / Severe Bleeding\n` +
        `2️⃣ 🫁 Breathing Difficulty / Chest Pain\n` +
        `3️⃣ 🧠 Unconscious / Unresponsive\n` +
        `4️⃣ 🤰 Pregnancy / Labor\n` +
        `5️⃣ ⚠️ Other Urgent Emergency\n\n` +
        `*(Or send a quick Voice Note)*`
      );
    }
  }

  // 4. STEP 2: CONDITION & DISPATCH TRIGGER
  if (session.step === 'AWAITING_CONDITION') {
    if (CONDITIONS[body] || isAudio) {
      if (isAudio) {
        session.condition = "Voice Note Provided";
        session.notes = await transcribeAudio(mediaUrl);
      } else {
        session.condition = CONDITIONS[body];
      }

      session.step = 'AWAITING_EMERGENCY_CONTACT';
      session.status = 'DISPATCHED';
      sessions.set(from, session);

      // Sync to Google Sheets
      syncToGoogleSheet(session);

      // Trigger Automated Paramedic Robocall for critical emergencies
      triggerParamedicRobocall(session.ticketId, session.condition, session.lat, session.lon);

      return sendResponse(res,
        `✅ *AMBULANCE DISPATCHED!*\n\n` +
        `Ticket: *#${session.ticketId}*\n` +
        `Condition: *${session.condition}*\n` +
        `Status: Paramedics en route to your location.\n\n` +
        `📲 *Alert a relative:* Reply with their phone number (e.g., +256700000000) so we can send them live GPS tracking.\n\n` +
        `*(Reply 1-5 to correct condition, send a Voice Note, or reply CANCEL)*`
      );
    }
  }

  return sendResponse(res, `Please select a valid option (1-5), send a Voice Note, or send a new GPS location pin.`);
});

// Start Server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Ambulink Core Engine active on port ${PORT}`));
