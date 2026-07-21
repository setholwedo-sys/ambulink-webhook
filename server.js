const express = require('express');
const OpenAI = require('openai');
const app = express();

app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// ===========================================================================
// CONFIGURATION (Paste your keys directly here - No .env file needed!)
// ===========================================================================
const OPENAI_API_KEY = 'YOUR_OPENAI_API_KEY_HERE'; // Replace with your sk-proj-... key
const GOOGLE_SHEET_WEBHOOK_URL = 'https://script.google.com/macros/s/YOUR_APPS_SCRIPT_ID_HERE/exec';

// Initialize OpenAI Client
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// ===========================================================================
// AI FIRST AID HELPER
// ===========================================================================
async function getAIFirstAidAdvice(userQuery, condition = '') {
  // Fallback if OpenAI key is not set
  if (!OPENAI_API_KEY || OPENAI_API_KEY.includes('YOUR_OPENAI_API_KEY_HERE')) {
    return "• Apply direct pressure if bleeding.\n• Keep patient calm, warm, and lying still until paramedics arrive.";
  }

  try {
    const prompt = condition 
      ? `Provide 3 short, bulleted emergency first-aid steps for: "${condition}". User notes: "${userQuery}".`
      : `User question: "${userQuery}". Provide short, immediate first-aid or health advice.`;

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: `You are an emergency medical and first-aid AI assistant for Ambulink. 
          - Provide practical, concise, bulleted first-aid steps.
          - Keep answers brief and easy to read on a mobile screen during an emergency.
          - Reassure the user and advise them to remain calm.`
        },
        { role: 'user', content: prompt }
      ]
    });

    return completion.choices[0].message.content;
  } catch (err) {
    console.error('❌ AI First Aid Error:', err.message);
    return "• Keep the patient calm, warm, and lying still until paramedics arrive.";
  }
}

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

const sessions = new Map();

// ===========================================================================
// MAIN TWILIO WEBHOOK ROUTE
// ===========================================================================
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

  // 2. NO SESSION & NO LOCATION ➔ Answer First Aid Question via AI or Request Location
  if (!session) {
    if (body) {
      const aiAdvice = await getAIFirstAidAdvice(body);
      return sendResponse(res, 
        `🩹 *AMBULINK FIRST AID ASSISTANT*\n\n` +
        `${aiAdvice}\n\n` +
        `🚨 *Need an ambulance?* Tap 📎 *Attachment* ➔ *Location* to send your GPS coordinates.`
      );
    }
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

  // 3. TICKET ALREADY DISPATCHED ➔ Handle AI Questions, Corrections, & Voice Notes
  if (session.step === 'DISPATCHED') {
    
    // A. Handle Condition Correction (e.g., sent '3' by mistake, now sends '4')
    if (conditions[body]) {
      const oldCondition = session.condition;
      session.condition = conditions[body];
      session.notes += ` | Corrected from [${oldCondition}] to [${session.condition}]`;
      
      sessions.set(from, session);
      syncToGoogleSheet(session);

      const aiFirstAid = await getAIFirstAidAdvice('', session.condition);

      return sendResponse(res, 
        `🔄 *TICKET UPDATED!*\n\n` +
        `Ticket: *#${session.ticketId}*\n` +
        `Updated Condition: *${session.condition}*\n\n` +
        `🩺 *IMMEDIATE FIRST AID:*\n${aiFirstAid}\n\n` +
        `Dispatch control room and paramedics have been notified.`
      );
    }

    // B. Handle Audio Voice Notes
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

    // C. Handle Cancellation
    if (body.toLowerCase() === 'cancel') {
      session.status = 'CANCELLED';
      syncToGoogleSheet(session);
      sessions.delete(from);

      return sendResponse(res, `🛑 Ticket *#${session.ticketId}* has been CANCELLED. Send a new location pin if you still need help.`);
    }

    // D. General Text Message ➔ Generate AI First Aid Advice & Save Note
    if (body) {
      const aiFirstAid = await getAIFirstAidAdvice(body, session.condition);
      session.notes += ` | User asked: "${body}"`;
      sessions.set(from, session);
      syncToGoogleSheet(session);

      return sendResponse(res, 
        `🩺 *FIRST AID ADVICE (Ticket #${session.ticketId})*\n\n` +
        `${aiFirstAid}\n\n` +
        `📍 *Paramedics are en route.* To update condition reply *1-5*, or reply *CANCEL*.`
      );
    }
  }

  // 4. STEP 1: PATIENT TYPE
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
        `*(Or type any first aid question)*`
      );
    }
  }

  // 5. STEP 2: CONDITION & DISPATCH WITH AI FIRST AID
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

      // Generate instant AI First Aid Advice for selected condition
      const aiAdvice = await getAIFirstAidAdvice(body, session.condition);

      return sendResponse(res, 
        `✅ *AMBULANCE DISPATCHED!*\n\n` +
        `Ticket: *#${session.ticketId}*\n` +
        `Condition: *${session.condition}*\n` +
        `Status: Paramedics en route.\n\n` +
        `🩺 *IMMEDIATE ACTION GUIDANCE:*\n${aiAdvice}\n\n` +
        `💡 Reply with any medical question, reply *1-5* to correct condition, or reply *CANCEL*.`
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Ambulink AI Core Engine running on port ${PORT}`));
