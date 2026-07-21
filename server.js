const express = require('express');
const app = express();

app.use(express.urlencoded({ extended: false }));

app.post('/twilio-webhook', (req, res) => {
  const from = req.body.From;
  const body = req.body.Body ? req.body.Body.trim() : '';
  const latitude = req.body.Latitude;
  const longitude = req.body.Longitude;

  console.log(`📩 INCOMING MESSAGE FROM: ${from}`);
  console.log(`Payload -> Body: "${body}", Lat: ${latitude}, Lon: ${longitude}`);

  let message = '';

  // STEP 1: GPS Location Pin Received
  if (latitude && longitude) {
    console.log(`🚨 GPS RECEIVED: ${latitude}, ${longitude}`);
    message = `🚨 *AMBULINK EMERGENCY ACKNOWLEDGED!*\n\nCoordinates logged (${latitude}, ${longitude}). Searching for nearest ambulance...\n\nTo help paramedics prepare, *who needs help?*\n\n1️⃣ Myself\n2️⃣ Someone else`;
  } 
  // STEP 2: Triage - Who needs help?
  else if (['1', '2'].includes(body) || body.toLowerCase() === 'myself' || body.toLowerCase() === 'someone else') {
    const patientType = (body === '1' || body.toLowerCase() === 'myself') ? 'Self' : 'Someone else';
    console.log(`📋 Patient logged: ${patientType}`);
    
    message = `Got it (Patient: *${patientType}*).\n\nWhat is the primary medical emergency?\n\n1️⃣ 🩸 Accident / Severe Bleeding\n2️⃣ 🫁 Breathing Difficulty / Chest Pain\n3️⃣ 🧠 Unconscious / Unresponsive\n4️⃣ 🤰 Pregnancy / Labor\n5️⃣ ⚠️ Other Urgent Issue`;
  }
  // STEP 3: Triage - Emergency Condition Category
  else if (['1', '2', '3', '4', '5'].includes(body)) {
    const conditions = {
      '1': 'Accident / Severe Bleeding',
      '2': 'Breathing Difficulty / Chest Pain',
      '3': 'Unconscious / Unresponsive',
      '4': 'Pregnancy / Labor',
      '5': 'Other Urgent Issue'
    };
    const selectedCondition = conditions[body];
    console.log(`📋 Condition logged: ${selectedCondition}`);

    message = `🚨 *TRIAGE COMPLETE*\n\nCondition Logged: *${selectedCondition}*\n\nMedical crew & ER team have been updated. Stay calm and keep your phone line open!`;
  }
  // DEFAULT: Fallback if no location sent yet
  else {
    message = `🚨 *Ambulink Emergency Dispatch*\n\nPlease tap the 📎 *Attachment icon* -> *Location* -> *Send Current Location* to request an ambulance.`;
  }

  res.type('text/xml').send(`
    <Response>
      <Message>${message}</Message>
    </Response>
  `);
});

module.exports = app;

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Ambulink running on port ${PORT}`));
