const express = require('express');
const app = express();

app.use(express.urlencoded({ extended: false }));

app.post('/twilio-webhook', (req, res) => {
  const from = req.body.From;
  const latitude = req.body.Latitude;
  const longitude = req.body.Longitude;

  console.log(`📩 INCOMING MESSAGE FROM: ${from}`);

  if (latitude && longitude) {
    console.log(`🚨 AMBULINK EMERGENCY GPS RECEIVED!`);
    console.log(`📍 Latitude: ${latitude}, Longitude: ${longitude}`);

    res.type('text/xml').send(`
      <Response>
        <Message>🚨 Ambulink Emergency Received! Coordinates logged (${latitude}, ${longitude}). Searching for nearest ambulance...</Message>
      </Response>
    `);
  } else {
    res.type('text/xml').send(`
      <Response>
        <Message>🚨 Ambulink Dispatch: Please share your location using the 📎 Attachment icon -> Location -> Send Current Location.</Message>
      </Response>
    `);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Ambulink running on port ${PORT}`));
