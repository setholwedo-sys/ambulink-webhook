const express = require('express');
const app = express();

app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const GOOGLE_SHEET_WEBHOOK_URL = 'https://script.google.com/macros/s/YOUR_APPS_SCRIPT_ID_HERE/exec';

// Simulated OpenAI Whisper Transcription Helper
async function transcribeAudio(audioUrl) {
  try {
    // In production, fetch audioUrl and send to OpenAI Whisper API
    // const transcript = await openai.audio.transcriptions.create({ file: audioStream, model: 'whisper-1' });
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

const sessions = new Map();

app.post('/twilio-webhook', async (req, res) => {
  const from = req.body.From;
  const body = req.body.Body ? req.body.Body.trim() : '';
  const latitude = req.body.Latitude;
  const longitude = req.body.Longitude;
  
  // Twilio Audio Parameters
  const mediaUrl = req.body.MediaUrl0;
  const mediaType = req.body.MediaContentType0;
  const isAudio = mediaUrl && mediaType && mediaType.startsWith('audio/');

  if (!from) return sendResponse(res, `Couldn't identify sender.`);

  // 1. NEW GPS LOCATION PIN ➔ Starts or Resets Ticket
  if (latitude && longitude) {
    const session = {
      from,
      step: 'AWAITING_PATIENT_TYPE',
      lat: latitude,
      lon: longitude,
      ticketId: 'AMB-' + Math.floor(1000 + Math.random() * 9000),
      status: 'AWAITING_INFO',
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

  let session = sessions.get(from);

  if (!session) {
    return sendResponse(res, `🚨 *AMBULINK EMERGENCY DISPATCH*\n\nPlease tap 📎 *Attachment* ➔ *Location* to send your GPS coordinates.`);
  }

  // Define Medical Condition Mapping
  const conditions = {
    '1': 'Accident / Severe Bleeding',
    '2': 'Breathing Difficulty / Chest Pain',
    '3': 'Unconscious / Unresponsive',
    '4': 'Pregnancy / Labor',
    '5': 'Other Urgent Emergency'
  };

  // 2. TICKET ALREADY DISPATCHED ➔ Handle Corrections, Audio, & Updates
  if (session.step === 'DISPATCHED') {
    
    // A. Handle Condition Correction (e.g. sent '3' by mistake, now sends '4')
    if (conditions[body]) {
      const oldCondition = session.condition;
      session.condition = conditions[body];
      session.notes += ` | Corrected from [${oldCondition}] to [${session.condition}]`;
      
      sessions.set(from, session);
      syncToGoogleSheet(session); // Pushes update to Google Sheet instantly

      return sendResponse(res, 
        `🔄 *TICKET UPDATED!*\n\n` +
        `Ticket: *#${session.ticketId}*\n` +
        `Updated Condition: *${session.condition}*\n\n` +
        `Dispatch control room and paramedics have been notified of this correction.`
      );
    }

    // B. Handle Audio Voice Notes
    if (isAudio) {
      session.audioUrl = mediaUrl;
      const transcript = await transcribeAudio(mediaUrl);
      session.notes += ` | Voice Note: ${transcript}`;
      
      sessions.set(from, session);
      syncToGoogleSheet(session); // Pushes Audio URL + Transcript to Google Sheet

      return sendResponse(res, 
        `🎙️ *VOICE NOTE RECEIVED*\n\n` +
        `Audio recording attached to Ticket *#${session.ticketId}* and forwarded directly to the responding unit.`
      );
    }

    // C. Handle Cancellation
    if (body.toLowerCase() === 'cancel') {
      session.status = 'CANCELLED';
      syncToGoogleSheet(session);
      sessions.delete(from);

      return sendResponse(res, `🛑 Ticket *#${session.ticketId}* has been CANCELLED. Send a new location pin if you still need help.`);
    }

    // D. General Text Message Update
    if (body) {
      session.notes += ` | Note: ${body}`;
      sessions.set(from, session);
      syncToGoogleSheet(session);

      return sendResponse(res, 
        `📝 *NOTE ADDED TO TICKET #${session.ticketId}*\n\n` +
        `"${body}"\n\n` +
        `Paramedics en route. To correct medical condition, reply with 1-5. To cancel, reply *CANCEL*.`
      );
    }
  }

  // 3. STEP 1: PATIENT TYPE
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
        `*(Or send a quick Voice Note describing the situation)*`
      );
    }
  }

  // 4. STEP 2: CONDITION & INITIAL DISPATCH
  if (session.step === 'AWAITING_CONDITION') {
    if (conditions[body] || isAudio) {
      if (isAudio) {
        session.audioUrl = mediaUrl;
        session.condition = "Voice Note Provided";
        session.notes = await transcribeAudio(mediaUrl);
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
        `📍 Paramedics en route to your location.\n\n` +
        `💡 *Made a mistake?* Reply *1 to 5* to correct the condition, send a *Voice Note*, or reply *CANCEL*.`
      );
    }
  }

  return sendResponse(res, `Please reply with a valid option (1-5), send a Voice Note, or send a new GPS location.`);
});

function sendResponse(res, textMessage) {
  res.type('text/xml').send(`
    <Response>
      <Message>${textMessage}</Message>
    </Response>
  `);
}

module.exports = app;
